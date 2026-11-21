'use strict';
// ============================================================================
// NEON TURF — audio.js : NT.Audio  (presentation: every effect + the music synthesized with WebAudio)
//
//   NT.Audio.init()                 main.js, once at boot: gesture listeners + bus subscriptions
//   NT.Audio.unlock()               create / resume the AudioContext (first user gesture; idempotent)
//   NT.Audio.frame(dt)              main.js, every frame: music scheduling, layer mix, stats
//   NT.Audio.setVolumes()           re-read NT.Game.settings {sfx, music, mute} (also on the 'settings' event)
//   NT.Audio.play(name, x?, y?, p?) fire one sound by family name; with x/y it is a world sound
//   NT.Audio.preview(name, opts?)   -> Promise<{name, peak, rms, dur}>  offline render (OfflineAudioContext)
//   NT.Audio.previewAll()           -> Promise<[...]>  every main family + one bar of each music layer
//   NT.Audio.stress(n)              -> Promise<{peak, rms}>  n weapon voices at once through the real sfx chain
//   NT.Audio.stats                  instrumentation (voices per family, drops, layer gains, context state)
//   NT.Audio.FAMILIES               family table (gap, max, priority, volume, bus)
//
// GRAPH: voices -> [pan] -> sfx bus (settings.sfx) -> compressor -> master (mute) -> limiter -> out
//                 ui voices -> ui bus (settings.sfx) ----------------^
//          music layers calm / tension / battle -> mix -> music bus (settings.music) -^
//
// Sounds are chosen ONLY from generic data: weapon proj / warhead / heal / cd / burst / splash / fx hint,
// the shooter's armor / layer / move type, event types and kinds. No faction, unit or building ids.
// Every recipe and sequencer step takes (ctx, dest, t, params) so the offline previews run the real code.
// ============================================================================
(function () {
  const A = NT.Audio = {};
  const MAX_VOICES = 24;
  const LOOKAHEAD = 0.22;                 // s of music scheduled ahead of the context clock
  let ac = null, bus = null, mus = null, wantRunning = false;
  const voices = [];                       // live sfx / ui voices {fam, end, pri, g, p}
  const lastAt = {};                       // family -> context time of its last start
  const famLive = {};                      // family -> live voice count (rebuilt on prune)
  const stats = A.stats = { state: 'none', time: 0, started: {}, dropped: {}, stolen: 0, muted: 0,
    voices: 0, peakVoices: 0, totalStarted: 0, totalDropped: 0, musicNodes: 0, gains: {}, music: {} };

  function G() { return NT.Game; }
  function settings() { return (G() && G().settings) || { sfx: 0.8, music: 0.5, mute: false }; }
  function live() { return !!ac && ac.state === 'running'; }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // --------------------------------------------------------------------------
  // Building blocks (context-agnostic)
  // --------------------------------------------------------------------------
  const NOISE = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function noiseBuf(c) {
    let b = NOISE.get(c);
    if (!b) {
      b = c.createBuffer(1, (c.sampleRate * 1.5) | 0, c.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      NOISE.set(c, b);
    }
    return b;
  }
  // gain node with attack a -> peak v -> exponential decay over d
  function envGain(c, dest, t, v, a, d) {
    const g = c.createGain(), p = g.gain;
    p.setValueAtTime(0.0001, t);
    p.linearRampToValueAtTime(v, t + a);
    p.exponentialRampToValueAtTime(0.0005, t + a + d);
    g.connect(dest);
    return g;
  }
  function filter(c, dest, type, f, q) {
    const fl = c.createBiquadFilter();
    fl.type = type; fl.frequency.value = f; fl.Q.value = q === undefined ? 0.8 : q;
    fl.connect(dest);
    return fl;
  }
  // o: {w, f, f2, g (glide s), d, a, v, lp|bp|hp, q, det}
  function tone(c, dest, t, o) {
    const a = o.a || 0.003, g = envGain(c, dest, t, o.v, a, o.d);
    const out = o.lp ? filter(c, g, 'lowpass', o.lp, o.q) : o.bp ? filter(c, g, 'bandpass', o.bp, o.q) : o.hp ? filter(c, g, 'highpass', o.hp, o.q) : g;
    const s = c.createOscillator();
    s.type = o.w || 'sine';
    s.frequency.setValueAtTime(o.f, t);
    if (o.f2) s.frequency.exponentialRampToValueAtTime(o.f2, t + (o.g || a + o.d));
    if (o.det) s.detune.value = o.det;
    s.connect(out); s.start(t); s.stop(t + a + o.d + 0.03);
    return a + o.d;
  }
  // o: {ft, f, f2, g, q, d, a, v}
  function burst(c, dest, t, o) {
    const a = o.a || 0.002, g = envGain(c, dest, t, o.v, a, o.d);
    const fl = c.createBiquadFilter();
    fl.type = o.ft || 'bandpass'; fl.Q.value = o.q === undefined ? 1 : o.q;
    fl.frequency.setValueAtTime(o.f, t);
    if (o.f2) fl.frequency.exponentialRampToValueAtTime(o.f2, t + (o.g || a + o.d));
    fl.connect(g);
    const s = c.createBufferSource();
    s.buffer = noiseBuf(c); s.loop = true;
    s.connect(fl); s.start(t, Math.random() * 1.2); s.stop(t + a + o.d + 0.03);
    return a + o.d;
  }
  function notes(c, dest, t, list, o) {                     // list of [offset s, midi]; o = tone opts
    let end = 0;
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      end = Math.max(end, n[0] + tone(c, dest, t + n[0], Object.assign({}, o, { f: hz(n[1]), v: (n[2] || 1) * o.v })));
    }
    return end;
  }

  // --------------------------------------------------------------------------
  // Recipes: (c, out, t, p) -> duration s. p = {r: 0..1 variation, s: 0..1 size, d: seconds}
  // Levels are set so a single voice peaks well under 1.0 before the bus chain.
  // --------------------------------------------------------------------------
  function k(p) { return 0.94 + 0.12 * (p.r === undefined ? Math.random() : p.r); }
  function explosion(c, o, t, s, kk) {
    const sub = 110 - 70 * s, len = 0.25 + 0.9 * s;
    tone(c, o, t, { f: sub * kk, f2: 28 + 12 * (1 - s), d: len * 0.8, v: 0.45 + 0.2 * s, a: 0.004 });
    burst(c, o, t, { ft: 'lowpass', f: 2600 - 1300 * s, f2: 140 + 200 * (1 - s), d: len, v: 0.45 + 0.12 * s, q: 0.7 });
    burst(c, o, t, { ft: 'highpass', f: 2500, d: 0.05, v: 0.25 });
    if (s > 0.4) {
      const n = Math.round(3 + 6 * s);
      for (let i = 0; i < n; i++) burst(c, o, t + rnd(0.12, len), { ft: 'bandpass', f: rnd(1800, 4200), q: 3, d: rnd(0.02, 0.05), v: rnd(0.05, 0.14) });
    }
    return len + 0.1;
  }
  const R = {
    // ---- weapons ----
    rifle: function (c, o, t, p) {
      const kk = k(p);
      burst(c, o, t, { f: 2300 * kk, q: 1.1, d: 0.06, v: 0.6 });
      tone(c, o, t, { f: 190 * kk, f2: 60, d: 0.06, v: 0.4 });
      burst(c, o, t + 0.01, { ft: 'lowpass', f: 1000, d: 0.16, v: 0.14 });
      return 0.2;
    },
    mg: function (c, o, t, p) {
      const kk = k(p), n = p.n || 3;
      for (let i = 0; i < n; i++) {
        const ti = t + i * 0.062;
        burst(c, o, ti, { f: 1500 * kk * (1 - i * 0.04), q: 1.4, d: 0.04, v: 0.5 });
        tone(c, o, ti, { w: 'triangle', f: 120 * kk, f2: 50, d: 0.04, v: 0.3 });
      }
      return n * 0.062 + 0.06;
    },
    twang: function (c, o, t, p) {                            // a travelling bolt / thrown metal
      const kk = k(p);
      burst(c, o, t, { f: 1000, f2: 3200, q: 1.5, d: 0.12, v: 0.3, a: 0.01 });
      tone(c, o, t, { w: 'triangle', f: 540 * kk, f2: 470 * kk, d: 0.32, v: 0.3 });
      tone(c, o, t, { w: 'sine', f: 1090 * kk, d: 0.18, v: 0.1 });
      return 0.36;
    },
    rocket: function (c, o, t, p) {
      const kk = k(p);
      burst(c, o, t, { ft: 'lowpass', f: 700, d: 0.07, v: 0.45 });
      burst(c, o, t + 0.01, { f: 450 * kk, f2: 2600 * kk, q: 2.2, d: 0.42, v: 0.5, a: 0.03 });
      tone(c, o, t, { w: 'sawtooth', f: 95 * kk, f2: 70, d: 0.38, v: 0.22, lp: 320 });
      return 0.48;
    },
    cannon: function (c, o, t, p) {
      const s = p.s === undefined ? 0.5 : p.s, kk = k(p) * (1.15 - 0.3 * s);
      tone(c, o, t, { f: 100 * kk, f2: 36, d: 0.3 + 0.15 * s, v: 0.75 });
      burst(c, o, t, { ft: 'lowpass', f: 1500 * kk, f2: 260, d: 0.3 + 0.1 * s, v: 0.55, q: 0.6 });
      burst(c, o, t, { ft: 'highpass', f: 3000, d: 0.03, v: 0.3 });
      return 0.5;
    },
    mortar: function (c, o, t, p) {
      const kk = k(p);
      tone(c, o, t, { f: 270 * kk, f2: 120, d: 0.12, v: 0.4 });
      tone(c, o, t, { f: 72 * kk, f2: 44, d: 0.26, v: 0.6 });
      burst(c, o, t, { f: 420, q: 1.2, d: 0.16, v: 0.35 });
      return 0.32;
    },
    throw: function (c, o, t, p) {                            // hurled by hand: a swish
      const kk = k(p);
      burst(c, o, t, { f: 650 * kk, f2: 1900 * kk, q: 1.1, d: 0.2, v: 0.45, a: 0.05 });
      tone(c, o, t, { w: 'sawtooth', f: 150 * kk, f2: 105, d: 0.1, v: 0.12, lp: 600 });
      return 0.27;
    },
    melee: function (c, o, t, p) {
      const kk = k(p);
      if (p.s > 0.5) {                                        // heavy blunt hit
        burst(c, o, t, { ft: 'lowpass', f: 1300, f2: 260, d: 0.16, v: 0.6 });
        tone(c, o, t, { f: 110 * kk, f2: 42, d: 0.18, v: 0.65 });
        tone(c, o, t, { w: 'square', f: 310 * kk, d: 0.07, v: 0.08, bp: 1400, q: 3 });
        return 0.25;
      }
      burst(c, o, t, { f: 900, f2: 2400, q: 0.8, d: 0.06, v: 0.2, a: 0.02 });
      burst(c, o, t + 0.04, { ft: 'lowpass', f: 1900, f2: 400, d: 0.07, v: 0.55 });
      tone(c, o, t + 0.04, { f: 150 * kk, f2: 60, d: 0.08, v: 0.5 });
      return 0.16;
    },
    hiss: function (c, o, t, p) {                             // pressurised liquid
      burst(c, o, t, { ft: 'highpass', f: 2600 * k(p), d: 0.3, v: 0.3, a: 0.03, q: 0.5 });
      burst(c, o, t, { f: 900, q: 0.8, d: 0.28, v: 0.14, a: 0.03 });
      return 0.34;
    },
    flame: function (c, o, t, p) {
      burst(c, o, t, { ft: 'lowpass', f: 700 * k(p), d: 0.34, v: 0.45, a: 0.05, q: 0.6 });
      for (let i = 0; i < 4; i++) burst(c, o, t + rnd(0.02, 0.3), { ft: 'highpass', f: 3500, d: 0.012, v: rnd(0.06, 0.14) });
      return 0.4;
    },
    zap: function (c, o, t, p) {
      tone(c, o, t, { w: 'sawtooth', f: 1900 * k(p), f2: 280, d: 0.12, v: 0.22, lp: 3200 });
      tone(c, o, t, { w: 'square', f: 95, d: 0.08, v: 0.06, lp: 800 });
      return 0.15;
    },
    heal: function (c, o, t, p) {
      const base = [76, 79, 83, 86][(p.r * 4) | 0] || 79;
      tone(c, o, t, { f: hz(base), f2: hz(base) * 1.01, d: 0.42, v: 0.22 });
      tone(c, o, t + 0.04, { f: hz(base + 7), d: 0.3, v: 0.12 });
      tone(c, o, t + 0.08, { f: hz(base + 12), d: 0.2, v: 0.06 });
      return 0.5;
    },
    // ---- impacts ----
    hit: function (c, o, t, p) {
      burst(c, o, t, { f: 3000 * k(p), q: 3, d: 0.03, v: 0.35 });
      tone(c, o, t, { w: 'triangle', f: 900 * k(p), f2: 500, d: 0.03, v: 0.06 });
      return 0.05;
    },
    boomS: function (c, o, t, p) { return explosion(c, o, t, 0.12 + 0.25 * (p.s || 0), k(p)); },
    boomM: function (c, o, t, p) { return explosion(c, o, t, 0.4 + 0.25 * (p.s || 0), k(p)); },
    boomL: function (c, o, t, p) { return explosion(c, o, t, 0.75 + 0.25 * (p.s || 0), k(p)); },
    // ---- deaths ----
    bodyfall: function (c, o, t, p) {
      const kk = k(p);
      tone(c, o, t, { w: 'triangle', f: 420 * kk, f2: 260, d: 0.09, v: 0.1, lp: 1200 });
      tone(c, o, t + 0.07, { f: 115 * kk, f2: 55, d: 0.12, v: 0.45 });
      burst(c, o, t + 0.08, { ft: 'lowpass', f: 650, d: 0.16, v: 0.3 });
      return 0.28;
    },
    creature: function (c, o, t, p) {
      const kk = k(p);
      tone(c, o, t, { w: 'sawtooth', f: 260 * kk, f2: 105, d: 0.34, v: 0.24, bp: 700, q: 3 });
      tone(c, o, t, { w: 'sawtooth', f: 263 * kk, f2: 104, d: 0.34, v: 0.14, lp: 500 });
      tone(c, o, t + 0.25, { f: 90 * kk, f2: 45, d: 0.18, v: 0.55 });
      burst(c, o, t + 0.26, { ft: 'lowpass', f: 500, d: 0.2, v: 0.3 });
      return 0.48;
    },
    wreck: function (c, o, t, p) {
      const kk = k(p), s = p.s === undefined ? 0.5 : p.s;
      const d = explosion(c, o, t, 0.35 + 0.35 * s, kk);
      tone(c, o, t + 0.05, { w: 'square', f: 230 * kk, f2: 170, d: 0.12, v: 0.08, bp: 1100, q: 4 });
      tone(c, o, t + 0.3, { w: 'square', f: 360 * kk, d: 0.08, v: 0.05, bp: 1800, q: 5 });
      return Math.max(d, 0.45);
    },
    airdeath: function (c, o, t, p) {
      const kk = k(p);
      tone(c, o, t, { w: 'sawtooth', f: 950 * kk, f2: 190, d: 0.45, v: 0.12, lp: 2400 });
      return 0.32 + explosion(c, o, t + 0.32, 0.3, kk);
    },
    collapse: function (c, o, t, p) {
      const kk = k(p), s = p.s === undefined ? 0.6 : p.s;
      explosion(c, o, t, 0.6 + 0.3 * s, kk);
      burst(c, o, t + 0.05, { ft: 'lowpass', f: 240, d: 1.6 + s, v: 0.4, a: 0.15, q: 0.5 });
      explosion(c, o, t + 0.35, 0.35, kk * 1.1);
      explosion(c, o, t + 0.75, 0.25, kk * 0.95);
      for (let i = 0; i < 10; i++) burst(c, o, t + rnd(0.2, 1.7), { f: rnd(700, 2600), q: 2, d: rnd(0.03, 0.08), v: rnd(0.05, 0.12) });
      return 1.9 + s;
    },
    // ---- base + economy ----
    placed: function (c, o, t, p) {
      const kk = k(p);
      tone(c, o, t, { f: 85 * kk, f2: 48, d: 0.26, v: 0.6 });
      burst(c, o, t, { ft: 'lowpass', f: 520, d: 0.3, v: 0.32 });
      tone(c, o, t + 0.02, { w: 'square', f: 520 * kk, d: 0.08, v: 0.08, bp: 1500, q: 4 });
      tone(c, o, t + 0.14, { w: 'square', f: 700 * kk, d: 0.1, v: 0.07, bp: 1900, q: 4 });
      return 0.42;
    },
    sold: function (c, o, t, p) {
      burst(c, o, t, { ft: 'lowpass', f: 600, d: 0.4, v: 0.3, a: 0.05 });
      notes(c, o, t + 0.05, [[0, 93], [0.07, 98], [0.14, 100]], { d: 0.12, v: 0.12 });
      return 0.48;
    },
    clink: function (c, o, t, p) {
      tone(c, o, t, { f: 2637 * k(p), d: 0.12, v: 0.16 });
      tone(c, o, t + 0.035, { f: 3951 * k(p), d: 0.08, v: 0.08 });
      return 0.17;
    },
    coin: function (c, o, t) { tone(c, o, t, { f: 1760, d: 0.1, v: 0.1 }); tone(c, o, t + 0.05, { f: 2637, d: 0.08, v: 0.06 }); return 0.14; },
    captured: function (c, o, t) { return notes(c, o, t, [[0, 62], [0.09, 69], [0.18, 74]], { w: 'square', d: 0.16, v: 0.1, lp: 1800 }); },
    rank: function (c, o, t) { return notes(c, o, t, [[0, 88], [0.06, 91], [0.12, 95], [0.18, 100, 0.7]], { w: 'triangle', d: 0.16, v: 0.13 }); },
    surge: function (c, o, t, p) {
      tone(c, o, t, { w: 'sawtooth', f: 150 * k(p), f2: 620, d: 0.45, v: 0.15, lp: 1600, q: 4, a: 0.05 });
      burst(c, o, t, { f: 500, f2: 3200, q: 2, d: 0.4, v: 0.18, a: 0.08 });
      return 0.52;
    },
    leap: function (c, o, t, p) {
      burst(c, o, t, { f: 380, f2: 1700, q: 1.2, d: 0.22, v: 0.32, a: 0.04 });
      tone(c, o, t + 0.22, { f: 125 * k(p), f2: 48, d: 0.15, v: 0.55 });
      burst(c, o, t + 0.22, { ft: 'lowpass', f: 600, d: 0.16, v: 0.3 });
      return 0.42;
    },
    deploy: function (c, o, t, p) {
      burst(c, o, t, { ft: 'highpass', f: 1600, d: 0.36, v: 0.16, a: 0.05 });
      tone(c, o, t + 0.34, { f: 95 * k(p), f2: 58, d: 0.16, v: 0.5 });
      tone(c, o, t + 0.34, { w: 'square', f: 400, d: 0.06, v: 0.06, bp: 1300, q: 4 });
      return 0.55;
    },
    board: function (c, o, t) { tone(c, o, t, { f: 140, f2: 80, d: 0.1, v: 0.4 }); burst(c, o, t, { f: 1200, q: 2, d: 0.04, v: 0.15 }); return 0.14; },
    repair: function (c, o, t) {
      for (let i = 0; i < 4; i++) burst(c, o, t + i * 0.055, { f: 2600 + i * 120, q: 5, d: 0.025, v: 0.9 });
      return 0.26;
    },
    siren: function (c, o, t, p) {                            // rising wail for the whole telegraph
      const d = NT.clamp(p.d || 3, 0.8, 9), g = c.createGain(), gp = g.gain;
      gp.setValueAtTime(0.0001, t); gp.linearRampToValueAtTime(0.22, t + 0.15);
      gp.setValueAtTime(0.22, t + d - 0.2); gp.linearRampToValueAtTime(0.0001, t + d);
      g.connect(o);
      const lp = filter(c, g, 'lowpass', 2000, 1.2);
      for (let j = 0; j < 2; j++) {
        const s = c.createOscillator(), period = 0.55;
        s.type = j ? 'square' : 'sawtooth'; s.detune.value = j ? 9 : 0;
        const f = s.frequency;
        f.setValueAtTime(380, t);
        for (let x = 0; x < d; x += period) {
          const rise = 1 + 0.6 * x / d;
          f.linearRampToValueAtTime(600 * rise, t + x + period * 0.7);
          f.linearRampToValueAtTime(400 * rise, t + x + period);
        }
        if (j) { const gj = c.createGain(); gj.gain.value = 0.35; gj.connect(lp); s.connect(gj); } else s.connect(lp);
        s.start(t); s.stop(t + d + 0.05);
      }
      return d;
    },
    power: function (c, o, t, p) {
      tone(c, o, t, { f: 62, f2: 30, d: 0.8, v: 0.7, a: 0.02 });
      burst(c, o, t, { f: 300, f2: 1300, q: 1, d: 0.6, v: 0.3, a: 0.05 });
      tone(c, o, t + 0.05, { f: 1200, f2: 2400, d: 0.55, v: 0.07 });
      return 0.88;
    },
    // ---- interface ----
    click: function (c, o, t) { tone(c, o, t, { w: 'square', f: 1800, d: 0.018, v: 0.07, lp: 4200 }); return 0.03; },
    select: function (c, o, t, p) {
      const m = p.m || 0;                                     // 0 = foot, 1 = vehicle, 2 = structure
      const f = [900, 640, 470][m];
      tone(c, o, t, { w: 'triangle', f: f, f2: f * 1.22, d: 0.05, v: 0.15 });
      if (m) tone(c, o, t + 0.035, { w: 'triangle', f: f * 1.5, d: 0.05, v: 0.08 });
      return 0.1;
    },
    ackMove: function (c, o, t) { return notes(c, o, t, [[0, 79], [0.05, 86]], { w: 'triangle', d: 0.055, v: 0.14 }); },
    ackAttack: function (c, o, t) {
      tone(c, o, t, { w: 'square', f: 330, f2: 210, d: 0.07, v: 0.12, lp: 1800 });
      tone(c, o, t + 0.06, { w: 'square', f: 165, d: 0.07, v: 0.1, lp: 1200 });
      burst(c, o, t, { f: 2400, q: 3, d: 0.02, v: 0.12 });
      return 0.15;
    },
    ackBuild: function (c, o, t) { return notes(c, o, t, [[0, 72], [0.045, 79]], { w: 'triangle', d: 0.06, v: 0.13 }); },
    ackCancel: function (c, o, t) { return notes(c, o, t, [[0, 79], [0.045, 72]], { w: 'triangle', d: 0.06, v: 0.12 }); },
    arm: function (c, o, t) { tone(c, o, t, { f: 440, f2: 700, d: 0.1, v: 0.1, a: 0.01 }); return 0.12; },
    error: function (c, o, t) {
      for (let i = 0; i < 2; i++) {
        tone(c, o, t + i * 0.12, { w: 'square', f: 110, d: 0.09, v: 0.13, lp: 900 });
        tone(c, o, t + i * 0.12, { w: 'square', f: 117, d: 0.09, v: 0.1, lp: 900 });
      }
      return 0.24;
    },
    tReady: function (c, o, t) { return notes(c, o, t, [[0, 74], [0.11, 81], [0.22, 86], [0.22, 77, 0.5]], { w: 'triangle', d: 0.34, v: 0.15 }); },
    tUnit: function (c, o, t) { return notes(c, o, t, [[0, 77], [0.08, 84]], { w: 'triangle', d: 0.18, v: 0.17 }); },
    tFunds: function (c, o, t) { return notes(c, o, t, [[0, 69], [0.13, 62]], { w: 'square', d: 0.12, v: 0.1, lp: 1400 }); },
    tLowPow: function (c, o, t) {
      tone(c, o, t, { w: 'sawtooth', f: 620, f2: 140, d: 0.5, v: 0.13, lp: 1500 });
      notes(c, o, t + 0.1, [[0, 62], [0.14, 62]], { w: 'square', d: 0.08, v: 0.07, lp: 1200 });
      return 0.6;
    },
    tPowOk: function (c, o, t) { tone(c, o, t, { w: 'sawtooth', f: 140, f2: 620, d: 0.42, v: 0.11, lp: 1500 }); return 0.45; },
    tAlert: function (c, o, t) {
      for (let i = 0; i < 4; i++) tone(c, o, t + i * 0.15, { w: 'square', f: i & 1 ? 554 : 740, d: 0.13, v: 0.2, bp: 1100, q: 1.2, a: 0.01 });
      return 0.62;
    },
    tPowReady: function (c, o, t) {
      notes(c, o, t, [[0, 81], [0.07, 85], [0.14, 88], [0.21, 93]], { d: 0.6, v: 0.11 });
      tone(c, o, t, { w: 'triangle', f: hz(57), d: 0.8, v: 0.12, a: 0.05 });
      return 0.9;
    },
    tCapture: function (c, o, t) { return notes(c, o, t, [[0, 69], [0.09, 74], [0.18, 78], [0.27, 81]], { w: 'triangle', d: 0.2, v: 0.13 }); },
    tLost: function (c, o, t) { return notes(c, o, t, [[0, 74], [0.12, 70], [0.24, 65]], { w: 'square', d: 0.16, v: 0.09, lp: 1300 }); },
    victory: function (c, o, t) {
      const ch = [[0, [58, 62, 65]], [0.55, [60, 64, 67]], [1.1, [62, 66, 69, 74]]];
      for (let i = 0; i < ch.length; i++) for (let j = 0; j < ch[i][1].length; j++)
        padNote(c, o, t + ch[i][0], hz(ch[i][1][j]), i === 2 ? 1.6 : 0.5, 0.05, 1400);
      notes(c, o, t + 1.1, [[0, 86], [0.1, 90], [0.2, 93], [0.3, 98]], { w: 'triangle', d: 0.5, v: 0.12 });
      tone(c, o, t + 1.1, { f: hz(38), d: 1.6, v: 0.4, a: 0.02 });
      return 2.9;
    },
    defeat: function (c, o, t) {
      notes(c, o, t, [[0, 74], [0.42, 72], [0.84, 70], [1.26, 69]], { w: 'triangle', d: 0.45, v: 0.13 });
      for (const m of [50, 53, 57]) padNote(c, o, t, hz(m), 2.2, 0.05, 700);
      tone(c, o, t + 1.26, { f: hz(33), f2: hz(26), d: 1.5, v: 0.45, a: 0.05 });
      return 2.9;
    },
  };

  // --------------------------------------------------------------------------
  // Families: [min gap s, max concurrent, priority, volume, bus]
  // --------------------------------------------------------------------------
  const FAM = A.FAMILIES = {};
  function fam(names, gap, max, pri, vol, b) { names.split(' ').forEach(function (n) { FAM[n] = { gap: gap, max: max, pri: pri, vol: vol, bus: b || 'sfx' }; }); }
  fam('rifle', 0.035, 4, 1, 0.55); fam('mg', 0.05, 3, 1, 0.5); fam('twang', 0.07, 3, 2, 0.55);
  fam('rocket', 0.07, 3, 2, 0.6); fam('cannon', 0.06, 3, 3, 0.8); fam('mortar', 0.09, 2, 3, 0.7);
  fam('throw', 0.07, 3, 1, 0.5); fam('melee', 0.045, 4, 1, 0.6); fam('hiss', 0.12, 2, 1, 0.45);
  fam('flame', 0.12, 2, 1, 0.5); fam('zap', 0.06, 3, 1, 0.45); fam('heal', 0.15, 2, 1, 0.45);
  fam('hit', 0.05, 3, 0, 0.3); fam('boomS', 0.05, 4, 3, 0.6); fam('boomM', 0.08, 3, 4, 0.75); fam('boomL', 0.14, 2, 5, 0.85);
  fam('bodyfall', 0.06, 3, 2, 0.6); fam('creature', 0.1, 2, 2, 0.6); fam('wreck', 0.1, 3, 4, 0.8);
  fam('airdeath', 0.15, 2, 4, 0.75); fam('collapse', 0.35, 2, 6, 0.85);
  fam('placed', 0.2, 2, 4, 0.75); fam('sold', 0.3, 1, 3, 0.6); fam('clink', 0.12, 2, 1, 0.4); fam('coin', 1.5, 1, 0, 0.3);
  fam('captured', 0.5, 1, 4, 0.6); fam('rank', 0.4, 1, 3, 0.55); fam('surge', 0.2, 2, 3, 0.55);
  fam('leap', 0.15, 2, 3, 0.6); fam('deploy', 0.2, 2, 2, 0.5); fam('board', 0.15, 2, 1, 0.4); fam('repair', 0.5, 1, 1, 0.35);
  fam('siren', 0.5, 2, 6, 0.55); fam('power', 0.5, 2, 6, 0.9);
  fam('click', 0.03, 2, 7, 0.7, 'ui'); fam('select', 0.06, 1, 7, 0.8, 'ui');
  fam('ackMove ackAttack ackBuild ackCancel', 0.07, 1, 7, 0.8, 'ui'); fam('arm', 0.1, 1, 7, 0.7, 'ui');
  fam('error', 0.25, 1, 8, 0.8, 'ui'); fam('tReady tUnit tPowOk tCapture tLost', 0.5, 1, 8, 0.8, 'ui');
  fam('tFunds', 4, 1, 8, 0.8, 'ui'); fam('tLowPow', 2, 1, 8, 0.8, 'ui'); fam('tAlert', 10, 1, 9, 0.85, 'ui');
  fam('tPowReady', 1, 1, 8, 0.8, 'ui'); fam('victory defeat', 2, 1, 10, 0.9, 'ui');

  // --------------------------------------------------------------------------
  // Graph + settings
  // --------------------------------------------------------------------------
  function sfxChain(c, out) {
    const b = {};
    b.limiter = c.createDynamicsCompressor();
    b.limiter.threshold.value = -2; b.limiter.knee.value = 0; b.limiter.ratio.value = 20;
    b.limiter.attack.value = 0.001; b.limiter.release.value = 0.12;
    b.master = c.createGain(); b.master.connect(b.limiter); b.limiter.connect(out);
    b.sfx = c.createGain(); b.ui = c.createGain(); b.music = c.createGain();
    b.comp = c.createDynamicsCompressor();
    b.comp.threshold.value = -20; b.comp.knee.value = 10; b.comp.ratio.value = 5;
    b.comp.attack.value = 0.003; b.comp.release.value = 0.25;
    b.trim = c.createGain(); b.trim.gain.value = 0.7;          // offsets the compressor's makeup gain
    b.sfx.connect(b.comp); b.comp.connect(b.trim); b.trim.connect(b.master);
    b.ui.connect(b.master); b.music.connect(b.master);
    return b;
  }
  A.unlock = function () {
    wantRunning = true;
    try {
      if (!ac) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        ac = new Ctx({ latencyHint: 'interactive' });
        bus = sfxChain(ac, ac.destination);
        mus = musicChain(ac, bus.music);
        A.setVolumes();
        stats.state = ac.state;
      }
      if (ac.state === 'suspended' && !document.hidden) ac.resume();
    } catch (e) { /* fail soft */ }
  };
  function curve(v) { v = NT.clamp(+v || 0, 0, 1); return v * v; }
  function setGain(p, v, t, tc) {                           // linear ramps reach exactly 0
    if (p._target === v) return;
    p.cancelScheduledValues(t); p.setValueAtTime(p.value, t);
    p.linearRampToValueAtTime(v, t + (tc || 0.04));
    p._target = v;
  }
  A.setVolumes = function () {
    if (!ac) return;
    const s = settings(), t = ac.currentTime;
    setGain(bus.master.gain, s.mute ? 0 : 1, t);
    setGain(bus.sfx.gain, curve(s.sfx), t);
    setGain(bus.ui.gain, curve(s.sfx), t);
    setGain(bus.music.gain, curve(s.music), t);
  };

  // --------------------------------------------------------------------------
  // Voices
  // --------------------------------------------------------------------------
  function prune(t) {
    let j = 0;
    for (const f in famLive) famLive[f] = 0;
    for (let i = 0; i < voices.length; i++) {
      const v = voices[i];
      if (v.end > t) { voices[j++] = v; famLive[v.fam] = (famLive[v.fam] || 0) + 1; }
      else release(v);
    }
    voices.length = j;
  }
  function release(v) { try { v.g.disconnect(); if (v.p) v.p.disconnect(); } catch (e) { /* already gone */ } }
  function drop(name) { stats.dropped[name] = (stats.dropped[name] || 0) + 1; stats.totalDropped++; return false; }
  function steal(pri, t) {
    let w = -1;
    for (let i = 0; i < voices.length; i++) if (voices[i].pri < pri && (w < 0 || voices[i].pri < voices[w].pri || (voices[i].pri === voices[w].pri && voices[i].t0 < voices[w].t0))) w = i;
    if (w < 0) return false;
    const v = voices[w];
    v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(v.g.gain.value, t); v.g.gain.linearRampToValueAtTime(0, t + 0.02);
    famLive[v.fam]--;
    voices.splice(w, 1);
    setTimeout(function () { release(v); }, 80);
    stats.stolen++;
    return true;
  }
  // gain 0..1 (distance), pan -1..1; p = recipe params
  function voice(name, gain, pan, p) {
    const f = FAM[name], rec = R[name];
    if (!f || !rec || !live()) return false;
    const s = settings();
    if (s.mute || (f.bus === 'sfx' || f.bus === 'ui' ? !(s.sfx > 0) : false)) { stats.muted++; return false; }
    const t = ac.currentTime;
    if (t - (lastAt[name] === undefined ? -99 : lastAt[name]) < f.gap) return drop(name);
    prune(t);
    if ((famLive[name] || 0) >= f.max) return drop(name);
    if (voices.length >= MAX_VOICES && !steal(f.pri, t)) return drop(name);
    const g = ac.createGain();
    g.gain.value = NT.clamp(gain * f.vol, 0, 1.2);
    let pn = null;
    if (pan && ac.createStereoPanner) { pn = ac.createStereoPanner(); pn.pan.value = NT.clamp(pan, -1, 1); g.connect(pn); pn.connect(bus[f.bus]); }
    else g.connect(bus[f.bus]);
    p = p || {};
    if (p.r === undefined) p.r = Math.random();
    let d = 0.3;
    try { d = rec(ac, g, t + 0.005, p); } catch (e) { release({ g: g, p: pn }); return false; }
    voices.push({ fam: name, end: t + d + 0.08, pri: f.pri, g: g, p: pn, t0: t });
    famLive[name] = (famLive[name] || 0) + 1;
    lastAt[name] = t;
    stats.started[name] = (stats.started[name] || 0) + 1; stats.totalStarted++;
    if (voices.length > stats.peakVoices) stats.peakVoices = voices.length;
    return true;
  }
  // Camera-relative loudness + pan from the screen position (zoom included).
  function spatial(x, y) {
    const g = G(), c = g.cam, v = g.view;
    const hw = Math.max(240, v.w / 2), hh = Math.max(180, v.h / 2);
    const nx = (x - c.x) * c.zoom / hw, ny = (y - c.y) * c.zoom / hh;
    const d2 = (nx * nx + ny * ny) * 0.6;
    const zk = NT.clamp(0.5 + 0.5 * c.zoom, 0.65, 1.2);
    return { gain: zk / (1 + 1.6 * d2), pan: NT.clamp(nx * 0.7, -0.85, 0.85) };
  }
  function heard(x, y, margin) {
    const Rn = NT.Render;
    if (!Rn || !Rn.visibleAt) return true;
    return Rn.visibleAt(x, y) && (!Rn.onScreen || Rn.onScreen(x, y, margin === undefined ? 140 : margin));
  }
  function atWorld(name, x, y, p, minGain) {
    if (!name || !live() || !heard(x, y)) return false;
    const sp = spatial(x, y), gain = Math.max(sp.gain, minGain || 0);
    if (gain < 0.03) return drop(name);
    return voice(name, gain, sp.pan, p);
  }
  function ui(name, p) { return live() ? voice(name, 1, 0, p) : false; }
  A.play = function (name, x, y, p) { return x === undefined ? ui(name, p) : atWorld(name, x, y, p); };

  // --------------------------------------------------------------------------
  // Generic sound choice
  // --------------------------------------------------------------------------
  const FX_HINT = { water: 'hiss', acid: 'flame', heal: 'heal', harpoon: 'twang' };   // optional refinements; unknown hints fall through
  function handHeld(e) { return !!e && (e.def.armor === 'infantry' || (e.def.move && e.def.move.type === 'foot')); }
  function shotSound(ev, e, w) {
    if (w && w.heal) return 'heal';
    if (w && w.fx && FX_HINT[w.fx]) return FX_HINT[w.fx];
    const wh = ev.warhead;
    switch (ev.proj) {
      case 'melee': return 'melee';
      case 'flame': return wh === 'shock' ? 'hiss' : 'flame';
      case 'beam': return 'zap';
      case 'rocket': return 'rocket';
      case 'shell': return 'cannon';
      case 'lob': return handHeld(e) ? 'throw' : 'mortar';
      case 'instant': return w && w.consume ? null : 'rifle';
      default:
        if (wh === 'ap' || wh === 'smash') return 'twang';     // a slow armour-piercing bolt, not a bullet
        if (wh === 'he') return 'mortar';
        if (wh === 'fire') return 'flame';
        if (wh === 'shock') return 'zap';
        return w && (w.cd <= 8 || (w.burst || 1) > 1) ? 'mg' : 'rifle';
    }
  }
  function impactSound(ev) {
    const pj = ev.proj;
    if (pj === 'melee' || pj === 'flame' || pj === 'beam') return null;   // the fire sound already covers it
    const s = ev.splash || 0;
    if (s >= 40) return 'boomL';
    if (s >= 20) return 'boomM';
    if (s > 0 || pj === 'rocket' || pj === 'shell' || pj === 'lob') return 'boomS';
    return ev.hit ? 'hit' : null;
  }
  function deathSound(ev) {
    if (ev.kind === 'building') return 'collapse';
    const def = NT.DEFS[ev.def];
    if (!def) return 'bodyfall';
    if (def.layer === 'air') return 'airdeath';
    if (def.move && def.move.type === 'beast') return 'creature';
    if (def.armor === 'infantry') return 'bodyfall';
    return 'wreck';
  }
  function selectKind(e) { return !e ? 0 : e.kind === 'building' ? 2 : e.def.armor === 'infantry' ? 0 : 1; }

  // --------------------------------------------------------------------------
  // Combat heat (drives the music layers)
  // --------------------------------------------------------------------------
  let heat = 0;
  function mine(owner) { const g = G(); return g.me >= 0 && owner === g.me; }
  function addHeat(v) { heat = Math.min(40, heat + v); }

  // --------------------------------------------------------------------------
  // Event wiring
  // --------------------------------------------------------------------------
  function wd() { return G() && G().world; }
  function onFire(ev) {
    const w = wd();
    if (!w || !live()) return;
    const e = w.byId.get(ev.id), wp = e ? e.def.weapons[ev.wi] : null;
    if (G().me < 0) { if (heard(ev.x, ev.y, 0)) addHeat(0.25); }
    else if (e && mine(e.owner)) addHeat(0.3);
    else { const tg = ev.target && w.byId.get(ev.target); if (tg && mine(tg.owner)) addHeat(0.45); }
    const name = shotSound(ev, e, wp);
    if (!name) return;
    const p = { s: wp ? NT.clamp(wp.dmg / 150, 0, 1) : 0.5 };
    if (name === 'melee') p.s = ev.warhead === 'smash' || (e && e.def.body === 'large') ? 1 : 0;
    if (name === 'mg' && wp && (wp.burst || 1) > 1) p.n = 1;
    if (!heard(ev.x, ev.y)) { if (heard(ev.tx, ev.ty)) atWorld(name, ev.tx, ev.ty, p); return; }
    atWorld(name, ev.x, ev.y, p);
  }
  function onImpact(ev) {
    if (!live()) return;
    const name = impactSound(ev);
    if (name) atWorld(name, ev.x, ev.y, { s: NT.clamp((ev.splash || 0) / 64, 0, 1) });
  }
  function onDeath(ev) {
    const w = wd();
    if (!w || !live()) return;
    const killer = ev.by && w.byId.get(ev.by);
    if (mine(ev.owner) || (killer && mine(killer.owner))) addHeat(2);
    const name = deathSound(ev), def = NT.DEFS[ev.def];
    const s = ev.kind === 'building' ? NT.clamp((ev.w * ev.h) / 9, 0, 1) : def && def.armor === 'heavy' ? 1 : 0.4;
    atWorld(name, ev.x, ev.y, { s: s });
    if (ev.kind === 'building' && mine(ev.owner)) ui('tLost');
  }
  function alertSeen(ev) {
    const g = G(), w = wd(), p = w && w.players[ev.owner];
    return g.me < 0 || (p && p.team === g.team()) || !NT.Render || NT.Render.visibleAt(ev.x, ev.y);
  }
  const lastAlert = {};
  function throttled(key, sec) {
    const t = ac ? ac.currentTime : 0;
    if (lastAlert[key] !== undefined && t - lastAlert[key] < sec) return true;
    lastAlert[key] = t; return false;
  }
  const SIM = {
    fire: onFire, impact: onImpact, death: onDeath,
    hurt: function (ev) {
      if (!mine(ev.owner)) return;
      addHeat(1);
      const e = wd().byId.get(ev.id);
      if (!e) return;
      if ((e.kind === 'building' || (e.def.traits && e.def.traits.harvester)) && !throttled('atk', 12)) ui('tAlert');
    },
    placed: function (ev) { const e = wd().byId.get(ev.id); atWorld('placed', e ? e.x : ev.x, e ? e.y : ev.y, { s: e ? NT.clamp(e.w * e.h / 9, 0, 1) : 0.5 }); },
    produced: function (ev) { if (mine(ev.owner) && wd().tick > 2) ui('tUnit'); },
    sold: function (ev) { atWorld('sold', ev.x, ev.y); },
    dump: function (ev) { if (mine(ev.owner)) atWorld('clink', ev.x, ev.y); },
    income: function (ev) { if (mine(ev.owner)) atWorld('coin', ev.x, ev.y); },
    captured: function (ev) {
      if (mine(ev.to)) ui('tCapture');
      else if (mine(ev.from)) ui('tLost');
      else atWorld('captured', ev.x, ev.y);
    },
    rank: function (ev) { const e = wd().byId.get(ev.id); if (e) atWorld('rank', e.x, e.y); },
    ability: function (ev) { atWorld(ev.ability === 'leap' ? 'leap' : 'surge', ev.x, ev.y); },
    deploy: function (ev) { const e = wd().byId.get(ev.id); if (e) atWorld('deploy', e.x, e.y); },
    board: function (ev) { const e = wd().byId.get(ev.carrier); if (e) atWorld('board', e.x, e.y); },
    unboard: function (ev) { atWorld('board', ev.x, ev.y); },
    repair: function (ev) { const e = wd().byId.get(ev.id); if (ev.on && mine(ev.owner) && e) atWorld('repair', e.x, e.y, null, 0.4); },
    strike_warn: function (ev) {
      if (!alertSeen(ev)) return;
      const w = wd(), hostile = G().me >= 0 && NT.isEnemy && NT.isEnemy(w, G().me, ev.owner);
      if (hostile) addHeat(6);
      const sp = spatial(ev.x, ev.y);
      voice('siren', Math.max(sp.gain, hostile ? 0.7 : 0.3), sp.pan, { d: (ev.delay || 40) * NT.DT });
    },
    power_used: function (ev) { if (alertSeen(ev) && (!NT.Render || NT.Render.onScreen(ev.x, ev.y, 400))) { const sp = spatial(ev.x, ev.y); voice('power', Math.max(sp.gain, 0.35), sp.pan); } },
    ready: function (ev) { if (mine(ev.owner)) ui('tReady'); },
    nofunds: function (ev) { if (mine(ev.owner)) ui('tFunds'); },
    lowpower: function (ev) { if (mine(ev.owner)) ui(ev.on ? 'tLowPow' : 'tPowOk'); },
    power_ready: function (ev) { if (mine(ev.owner)) ui('tPowReady'); },
    denied: function (ev) { if (mine(ev.owner)) ui('error'); },
  };
  function onSim(ev) {
    const h = SIM[ev.t];
    if (h && live() && wd()) { try { h(ev); } catch (e) { stats.errors = (stats.errors || 0) + 1; stats.lastError = String(e && e.message); } }
  }

  let prevSel = [];
  function onSelect(ids) {
    const fresh = ids.filter(function (id) { return prevSel.indexOf(id) < 0; });
    prevSel = ids.slice();
    if (!fresh.length || !live()) return;
    const w = wd(), e = w && w.byId.get(fresh[0]);
    ui('select', { m: selectKind(e) });
  }
  const ACK = { move: 'ackMove', harvest: 'ackMove', return: 'ackMove', enter: 'ackMove', unload: 'ackMove', rally: 'ackMove',
    attack: 'ackAttack', amove: 'ackAttack', produce: 'ackBuild', place: 'ackBuild', primary: 'ackBuild', repair: 'ackBuild',
    deploy: 'ackBuild', stance: 'ackBuild', ability: 'ackAttack', power: 'ackAttack', cancel: 'ackCancel', sell: 'ackCancel',
    stop: 'ackCancel', surrender: 'ackCancel' };
  function onCmd(c) { if (c && live()) ui(ACK[c.type] || 'click'); }

  // --------------------------------------------------------------------------
  // Music: an original procedural sequencer (16 steps per bar) with three layers
  // --------------------------------------------------------------------------
  const CH = { m: [0, 3, 7, 10], m9: [0, 3, 7, 10, 14], M: [0, 4, 7, 11], M7: [0, 4, 7, 11, 14], six: [0, 4, 7, 9], dom: [0, 4, 7, 10, 13] };
  const MOODS = {
    game: { bpm: 100, root: 50, prog: [[0, 'm'], [0, 'm'], [-4, 'M'], [-4, 'M'], [-7, 'm'], [1, 'M'], [0, 'm'], [-5, 'dom']],
      bell: [0, 3, 7, 10, 14], bellIdx: [0, 2, 1, 3, 2], pad: 850, swing: 0 },
    menu: { bpm: 70, root: 50, prog: [[0, 'm9'], [-4, 'M7'], [3, 'M7'], [-2, 'six']],
      bell: [0, 6, 11], bellIdx: [4, 2, 3], pad: 650, swing: 0 },
  };
  function padNote(c, dest, t, f, d, v, lp) {
    const g = c.createGain(), gp = g.gain, att = Math.min(0.8, d * 0.3);
    gp.setValueAtTime(0.0001, t); gp.linearRampToValueAtTime(v, t + att);
    gp.setValueAtTime(v, t + d); gp.linearRampToValueAtTime(0.0001, t + d + 0.7);
    g.connect(dest);
    const fl = filter(c, g, 'lowpass', lp || 850, 0.7);
    for (let j = -1; j <= 1; j += 2) {
      const s = c.createOscillator();
      s.type = 'sawtooth'; s.frequency.value = f; s.detune.value = j * 9;
      s.connect(fl); s.start(t); s.stop(t + d + 0.75);
    }
  }
  function musicChain(c, out) {
    const m = { mix: c.createGain(), calm: c.createGain(), tens: c.createGain(), batt: c.createGain() };
    m.mix.gain.value = 0.55; m.mix.connect(out);
    m.calm.connect(m.mix); m.tens.connect(m.mix); m.batt.connect(m.mix);
    m.calm.gain.value = 1; m.tens.gain.value = 0; m.batt.gain.value = 0;
    m.echo = c.createDelay(1.5); m.fb = c.createGain(); m.wet = c.createGain(); m.send = c.createGain();
    const lp = filter(c, m.fb, 'lowpass', 2400, 0.5);
    m.fb.gain.value = 0.32; m.wet.gain.value = 0.35;
    m.send.connect(m.echo); m.echo.connect(lp); m.fb.connect(m.echo); m.echo.connect(m.wet); m.wet.connect(m.mix);
    m.echo.delayTime.value = 0.45;
    return m;
  }
  // One sequencer step. d = destinations {calm, tens, batt, send?}; on = which layers to play.
  function step(c, d, mood, n, t, sd, on) {
    const M = MOODS[mood], bar = Math.floor(n / 16) % M.prog.length, s = n % 16, ch = M.prog[bar];
    const root = M.root + ch[0], tones = CH[ch[1]], menu = mood === 'menu';
    let made = 0;
    if (on.calm && d.calm) {
      if (s === 0) { for (let i = 0; i < 4; i++) padNote(c, d.calm, t, hz(root + 12 + tones[i]), 16 * sd, menu ? 0.05 : 0.045, M.pad); made += 8; }
      if (s === 0 || (!menu && s === 8)) { tone(c, d.calm, t, { f: hz(root - 12), d: (menu ? 14 : 7) * sd, v: 0.28, a: 0.03 }); made++; }
      const bi = M.bell.indexOf(s);
      if (bi >= 0 && (menu || (bar & 1) === 0 || bi % 2 === 0)) {
        const m = root + 24 + tones[M.bellIdx[bi] % tones.length];
        tone(c, d.calm, t, { w: 'triangle', f: hz(m), d: menu ? 1.4 : 0.8, v: 0.07 });
        if (d.send) tone(c, d.send, t, { w: 'triangle', f: hz(m), d: menu ? 1.4 : 0.8, v: 0.07 });
        made += 2;
      }
    }
    if (on.tens && d.tens) {
      const oct = [0, 0, 12, 0, 0, 12, 0, 7, 0, 0, 12, 0, 0, 12, 7, 0][s];
      tone(c, d.tens, t, { w: 'sawtooth', f: hz(root - 12 + oct), d: sd * 0.85, v: s % 4 === 0 ? 0.16 : 0.11, lp: s % 4 === 0 ? 900 : 520, q: 4 });
      made++;
      if (s % 4 === 2) { burst(c, d.tens, t, { ft: 'highpass', f: 7000, d: 0.04, v: 0.09, q: 0.7 }); made++; }
      if (s === 4 || s === 12) { burst(c, d.tens, t, { f: 1700, q: 2, d: 0.05, v: 0.12 }); made++; }
    }
    if (on.batt && d.batt) {
      if (s % 4 === 0) { tone(c, d.batt, t, { f: 150, f2: 42, d: 0.24, v: 0.55, g: 0.12 }); made++; }
      if (s === 14 && (bar & 1)) { tone(c, d.batt, t, { f: 140, f2: 42, d: 0.2, v: 0.35, g: 0.1 }); made++; }
      if (s === 4 || s === 12) { burst(c, d.batt, t, { f: 1800, q: 0.9, d: 0.17, v: 0.32 }); tone(c, d.batt, t, { w: 'triangle', f: 210, f2: 160, d: 0.08, v: 0.18 }); made += 2; }
      if (s % 2 === 0 || bar === M.prog.length - 1) {
        const arp = [0, 1, 2, 3, 2, 1, 3, 2][(s >> 1) % 8], m = root + 12 + tones[arp % tones.length] + (s >= 8 ? 12 : 0);
        tone(c, d.batt, t, { w: 'square', f: hz(m), d: sd * 0.7, v: 0.05, lp: 2200 });
        if (d.send) tone(c, d.send, t, { w: 'square', f: hz(m), d: sd * 0.7, v: 0.03, lp: 2200 });
        made += 2;
      }
      if (bar === M.prog.length - 1 && s >= 12) { tone(c, d.batt, t, { f: [210, 175, 145, 120][s - 12], f2: 70, d: 0.18, v: 0.4 }); made++; }
      if (bar === 0 && s === 0) { burst(c, d.batt, t, { ft: 'highpass', f: 5000, d: 1.1, v: 0.12, q: 0.5 }); made++; }
    }
    return made;
  }
  const seq = { mood: null, n: 0, next: 0, sd: 0.15 };
  const tgt = { calm: 1, tens: 0, batt: 0 };
  function sd(mood) { return 60 / MOODS[mood].bpm / 4; }
  function setMood(mood) {
    if (seq.mood === mood) return;
    seq.mood = mood; seq.n = 0; seq.sd = sd(mood);
    if (!ac) return;
    const t = ac.currentTime;
    seq.next = t + 0.08;
    mus.echo.delayTime.setValueAtTime(seq.sd * 3, t);
    const p = mus.mix.gain;
    p.cancelScheduledValues(t); p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(0.55, t + 1.5);
  }
  function layerTargets() {
    const g = G();
    if (!g || g.state === 'menu' || g.state === 'boot' || !g.world) return [1, 0, 0];
    if (g.state === 'over') return [0.7, 0, 0];
    const q = function (v) { return Math.round(NT.clamp(v, 0, 1) * 4) / 4; };
    return [1, q((heat - 1) / 4), q((heat - 8) / 8)];
  }
  function mixLayers() {
    const t = ac.currentTime, v = layerTargets(), L = [mus.calm, mus.tens, mus.batt];
    for (let i = 0; i < 3; i++) {
      const p = L[i].gain;
      if (p._target === v[i]) continue;
      const up = v[i] > p.value;
      p.cancelScheduledValues(t); p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(v[i], t + (up ? 1.5 : 4));
      p._target = v[i];
    }
    tgt.calm = v[0]; tgt.tens = v[1]; tgt.batt = v[2];
  }
  function schedule() {
    if (!live() || !seq.mood || settings().mute || !(settings().music > 0)) {
      if (ac && seq.next < ac.currentTime) seq.next = ac.currentTime + 0.05;
      return;
    }
    const now = ac.currentTime;
    if (seq.next < now - 0.03) seq.next = now + 0.03;      // stalled (hidden tab, long frame): resync, never burst
    const on = { calm: mus.calm.gain.value > 0.003 || tgt.calm > 0, tens: mus.tens.gain.value > 0.003 || tgt.tens > 0, batt: mus.batt.gain.value > 0.003 || tgt.batt > 0 };
    const d = { calm: mus.calm, tens: mus.tens, batt: mus.batt, send: mus.send };
    while (seq.next < now + LOOKAHEAD) {
      stats.musicNodes += step(ac, d, seq.mood, seq.n, seq.next, seq.sd, on);
      seq.n++; seq.next += seq.sd;
    }
  }

  // --------------------------------------------------------------------------
  // Offline previews (instrumentation; you cannot listen in a headless browser)
  // --------------------------------------------------------------------------
  function measure(buf) {
    let peak = 0, sum = 0, n = 0;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; sum += d[i] * d[i]; n++; }
    }
    return { peak: +peak.toFixed(4), rms: +Math.sqrt(sum / Math.max(1, n)).toFixed(4) };
  }
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  // opts: {chain: true -> through the real sfx bus chain at full volume, p: recipe params}
  A.preview = function (name, opts) {
    opts = opts || {};
    if (!OAC) return Promise.resolve({ name: name, error: 'no OfflineAudioContext' });
    const sr = 44100;
    if (name.indexOf('music:') === 0) {
      const layer = name.slice(6), mood = layer === 'menu' ? 'menu' : 'game', sdm = sd(mood), bars = opts.bars || 1;
      const dur = 16 * bars * sdm + 1.2, c = new OAC(2, Math.ceil(sr * dur), sr);
      const out = c.createGain(); out.gain.value = 0.55; out.connect(c.destination);   // = the live music mix level
      const d = { calm: out, tens: out, batt: out, send: null };
      const on = layer === 'menu' || layer === 'calm' ? { calm: 1 } : layer === 'tension' ? { tens: 1 } : layer === 'battle' ? { batt: 1 } : { calm: 1, tens: 1, batt: 1 };
      for (let i = 0; i < 16 * bars; i++) step(c, d, mood, (opts.bar || 0) * 16 + i, 0.02 + i * sdm, sdm, on);
      return c.startRendering().then(function (b) { return Object.assign({ name: name, dur: +dur.toFixed(2) }, measure(b)); });
    }
    const f = FAM[name], rec = R[name];
    if (!rec) return Promise.resolve({ name: name, error: 'unknown sound' });
    const p = Object.assign({ r: 0.5, s: 0.6, d: 2 }, opts.p || {});
    const dur = 3.5, c = new OAC(2, sr * dur, sr);
    let dest = c.destination;
    if (opts.chain) { const b = sfxChain(c, c.destination); b.sfx.gain.value = b.ui.gain.value = 1; dest = b[f.bus]; }
    const g = c.createGain(); g.gain.value = f.vol; g.connect(dest);
    const len = rec(c, g, 0.02, p);
    return c.startRendering().then(function (b) { return Object.assign({ name: name, len: +len.toFixed(2) }, measure(b)); });
  };
  A.PREVIEW_SET = ['rifle', 'mg', 'rocket', 'cannon', 'mortar', 'twang', 'boomS', 'boomL', 'melee', 'hiss', 'heal', 'placed', 'collapse',
    'tUnit', 'tAlert', 'error', 'siren', 'victory', 'defeat', 'music:calm', 'music:tension', 'music:battle', 'music:menu', 'music:all'];
  A.previewAll = function (opts) {
    const out = [];
    return A.PREVIEW_SET.reduce(function (pr, n) { return pr.then(function () { return A.preview(n, opts).then(function (r) { out.push(r); }); }); }, Promise.resolve())
      .then(function () { return out; });
  };
  // Worst case: n loud voices in the same instant through the real sfx chain at full volume.
  A.stress = function (n) {
    if (!OAC) return Promise.resolve(null);
    const sr = 44100, c = new OAC(2, sr * 2.5, sr), b = sfxChain(c, c.destination);
    b.sfx.gain.value = 1;
    const pool = ['rifle', 'mg', 'cannon', 'rocket', 'boomL', 'boomM', 'wreck', 'melee'];
    for (let i = 0; i < (n || MAX_VOICES); i++) {
      const name = pool[i % pool.length], g = c.createGain();
      g.gain.value = FAM[name].vol; g.connect(b.sfx);
      R[name](c, g, 0.02 + (i % 4) * 0.004, { r: Math.random(), s: 1 });
    }
    return c.startRendering().then(function (buf) { return Object.assign({ voices: n || MAX_VOICES }, measure(buf)); });
  };

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------
  A.init = function () {
    const un = function (e) {
      A.unlock();
      if (e.type === 'pointerdown' && e.target && e.target.closest && e.target.closest('button, [role="button"], .nt-btn, input, select, label')) ui('click');
    };
    window.addEventListener('pointerdown', un, true);
    window.addEventListener('keydown', un, true);
    window.addEventListener('touchend', un, true);
    document.addEventListener('visibilitychange', function () {
      if (!ac) return;
      try { if (document.hidden) ac.suspend(); else if (wantRunning) ac.resume(); } catch (e) { /* fail soft */ }
    });
    NT.on('settings', function () { A.setVolumes(); });
    NT.on('sim', onSim);
    NT.on('ui:select', onSelect);
    NT.on('ui:cmd', onCmd);
    NT.on('ui:error', function () { ui('error'); });
    NT.on('ui:mode', function (m) { if (m && m.type !== 'normal') ui('arm'); });
    NT.on('game:start', function () { heat = 0; prevSel = []; });
    NT.on('game:stop', function () { heat = 0; prevSel = []; });
    NT.on('game:over', function (r) {
      if (!live()) return;
      ui(r && (r.won || r.me < 0) ? 'victory' : 'defeat');
      const t = ac.currentTime, p = mus.mix.gain;
      p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(0.12, t + 0.3);
      p.setValueAtTime(0.12, t + 3); p.linearRampToValueAtTime(0.55, t + 6);
    });
  };

  let statT = 0;
  A.frame = function (dt) {
    stats.state = ac ? ac.state : 'none';
    if (!ac) return;
    if (wantRunning && ac.state === 'suspended' && !document.hidden) { try { ac.resume(); } catch (e) { /* retry next frame */ } }
    heat *= Math.exp(-(dt || 0) / 6);
    const g = G();
    setMood(g && g.world && g.state !== 'menu' ? 'game' : 'menu');
    if (live()) { mixLayers(); schedule(); }
    statT += dt || 0;
    if (statT < 0.1) return;
    statT = 0;
    prune(ac.currentTime);
    const s = stats;
    s.time = +ac.currentTime.toFixed(3); s.voices = voices.length;
    s.gains = { master: bus.master.gain.value, masterTarget: bus.master.gain._target, sfx: bus.sfx.gain.value, sfxTarget: bus.sfx.gain._target,
      ui: bus.ui.gain.value, music: bus.music.gain.value, musicTarget: bus.music.gain._target, compReduction: +bus.comp.reduction.toFixed(2) };
    s.music = { mood: seq.mood, heat: +heat.toFixed(2), calm: +mus.calm.gain.value.toFixed(3), tension: +mus.tens.gain.value.toFixed(3),
      battle: +mus.batt.gain.value.toFixed(3), target: [tgt.calm, tgt.tens, tgt.batt], step: seq.n, mix: +mus.mix.gain.value.toFixed(3) };
  };
})();
