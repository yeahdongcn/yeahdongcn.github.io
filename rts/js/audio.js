'use strict';
// ============================================================================
// NEON TURF — audio.js : NT.Audio  (presentation: every effect + the music synthesized with WebAudio)
//
//   NT.Audio.init()                 main.js, once at boot: gesture listeners + bus subscriptions
//   NT.Audio.unlock()               create / resume the AudioContext (first user gesture; idempotent)
//   NT.Audio.frame(dt)              main.js, every frame: music scheduling, layer mix, stats
//   NT.Audio.setVolumes()           re-read NT.Game.settings {sfx, music, mute} (also on the 'settings' event)
//   NT.Audio.play(name, x?, y?, p?) fire one sound by family name; with x/y it is a world sound
//   NT.Audio.preview(name, opts?)   -> Promise<{name, peak, rms, ...}>  offline render (OfflineAudioContext) of one sound, or of
//                                   'music:<menu|calm|tension|battle|mid|all>' {hint, bars, bar, only: role, notes: true -> note log}
//   NT.Audio.previewAll()           -> Promise<[...]>  every main family + one bar of each music layer
//   NT.Audio.mixdown(opts)          -> Promise<{peak, rms}>  score + timed sounds through the whole chain (ducking included)
//   NT.Audio.stress(n)              -> Promise<{peak, rms}>  n weapon voices at once through the real sfx chain
//   NT.Audio.stats                  instrumentation (voices per family, drops, layer gains, the score's voice, context state)
//   NT.Audio.FAMILIES               family table (gap, max, priority, volume, bus, duck)   NT.Audio.LEVELS  the score's mix table
//
// GRAPH: voices -> [pan] -> sfx bus (settings.sfx) -> compressor -> master (mute) -> limiter -> trim -> out
//                 ui voices -> ui bus (settings.sfx) ----------------^
//          score layers calm / tension / battle -> shelf -> mix -> duck -> music bus (settings.music) -^
//        Earcons and stingers (ui bus) pull the duck gain down while they sound, so the score never masks an alert.
//
// Sounds are chosen ONLY from generic data: weapon proj / warhead / heal / cd / burst / splash / fx hint, the shooter's
// armor / layer / move type, a power's kind and strike numbers, a building's role, event types. No faction, unit,
// building or power ids. Every recipe and the score take (ctx, dest, t, ...) so the offline previews run the real code.
//
// THE SCORE
//   One motif is the game (THEME below): D . A G F | E . C D in D minor — up a fifth, down by step, under the tonic,
//   home. The menu states it plainly (bell, then a glassy lead, pads, rain) in the city's voice; a match plays it in
//   the LOCAL PLAYER's gang voice over a 32-bar form A A' B A'' of 2-bar phrases:
//     calm     the bell carries the theme in fragments (head / tail / sequence / augmented over 4 bars); in B the
//              gang's call sounds from far off
//     tension  the gang's bass riff and light kit; its lead answers the bell with the theme INVERTED; in B its answer
//     battle   the gang's full kit and riff, chord stabs, the theme HAMMERED in 8ths by the lead; in B call and answer
//   Odd passes vary (octaves, an inverted statement, a bare A', a two-bar breakdown), so a section repeats exactly only
//   after 64 bars. Layers follow combat heat; tension's rhythm section cross-fades into the battle one.
//
// MUSIC_HINTS — the optional `music` block of a faction file (rules.js keeps it as written; everything here is optional,
// each field falls back on its own to the default city voice; menu and spectators always get the city voice):
//   bpm: 50..180          key: midi note of the tonic in the bass register (36..60)         swing: 0..0.4 of a 16th
//   scale: [7 semitone offsets]                 e.g. [0, 2, 3, 5, 7, 8, 10] aeolian, [0, 2, 3, 5, 7, 9, 10] dorian
//   chords: { a: [...], b: [...] }             the chord root of each bar of the A / B sections, as a scale degree
//   voices: { lead, call, answer: 'bell'|'glass'|'brass'|'bugle'|'chant'|'mob',  bass: 'sub'|'pulse'|'drive',
//             air: 'rain'|'wail'|'crowd'|'none' }
//   call, answer: [[step, degree, steps], ...] the gang's own two-bar phrases (steps 0..31 in 16ths; degree 0 = the
//                                               tonic, 7 = the tonic above, negative = below)
//   riff: { tension, battle }                  one-bar bass riffs [[step, SEMITONES above the bar's chord root, steps]]
//   kit: { tension, battle, fill }             { kick|stomp|snare|rim|clap|tom|hat: '16 chars' or a list alternating by bar }
//                                               X accent, x hit, o ghost, r roll (snare), 1-4 tom high -> low, . rest;
//                                               `fill` replaces the battle kit on the last bar of every 8
//   stab: '16 chars' or a list                 where the lead instrument punches the bar's chord (battle, A sections)
//
// EARCONS (ui bus, local player only) — one gesture each, told apart by rhythm, direction and register:
//   construction complete  tReady     knock, knock, then a fourth rings up           3 onsets, mid
//   unit ready             tUnit      two taps on one note, then up a fourth         3 quick onsets, bright (acks are 2 notes)
//   base under attack      tAlert     three hoarse blasts that sag                   even rhythm, rough, mid
//   low power / restored   tLowPow    one long wind-down / tPowOk: wind-up and hold  continuous glide
//   insufficient funds     tFunds     a coin, then the bottom of an empty tin        high tick -> low thud
//   support power ready    tPowReady  the theme's rising fifth, swelling             1.2 s, slow attack, shimmer
//   hostile strike         tIncoming  three falling whistles closing in              the only one above 1 kHz throughout
//   turf captured / lost   tCapture   three bells up + a thump / tLost: three bells down, the last one sour
//   structure lost         tGone      one cracked low toll and rubble
//   enemy superweapon      tSuper     two low horns a tritone apart over a pulse     2.2 s, the lowest and slowest
//   refused                error      one flat buzz
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
  // gain that rises to v over `up` s, holds, and falls over `down` s
  function swellGain(c, dest, t, v, up, hold, down) {
    const g = c.createGain(), p = g.gain;
    p.value = 0; p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(v, t + up);
    p.setValueAtTime(v, t + up + hold); p.linearRampToValueAtTime(0, t + up + hold + down);
    g.connect(dest);
    return g;
  }
  function oscTo(c, dest, type, f, t, end, det) {
    const s = c.createOscillator();
    s.type = type; s.frequency.value = f; if (det) s.detune.value = det;
    s.connect(dest); s.start(t); s.stop(end);
    return s;
  }
  function noiseTo(c, dest, t, end) {
    const s = c.createBufferSource();
    s.buffer = noiseBuf(c); s.loop = true; s.connect(dest); s.start(t, Math.random() * 1.2); s.stop(end);
    return s;
  }
  function fmBell(c, o, t, f, v, tc) {                      // one struck bell (the same recipe as the score's bell)
    const g = c.createGain(), mg = c.createGain(), end = t + tc * 7;
    g.gain.value = 0; g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(v, t + 0.004); g.gain.setTargetAtTime(0, t + 0.004, tc);
    mg.gain.setValueAtTime(f * 1.5, t); mg.gain.setTargetAtTime(f * 0.04, t, tc * 0.45);
    g.connect(o); mg.connect(oscTo(c, g, 'sine', f, t, end).frequency); oscTo(c, mg, 'sine', f * 3.51, t, end);
    return tc * 5;
  }
  // a crowd: noise through two wandering formants. o: {d, v, f1: [from, to], f2: [from, to], up: rise s}
  function crowd(c, dest, t, o) {
    const g = swellGain(c, dest, t, o.v, o.up, 0.05, o.d - o.up - 0.05), end = t + o.d + 0.05;
    const a = filter(c, g, 'bandpass', o.f1[0], 1.6), b = filter(c, gainTo(c, 0.7, g), 'bandpass', o.f2[0], 2.2);
    a.frequency.setValueAtTime(o.f1[0], t); a.frequency.linearRampToValueAtTime(o.f1[1], t + o.d);
    b.frequency.setValueAtTime(o.f2[0], t); b.frequency.linearRampToValueAtTime(o.f2[1], t + o.d);
    noiseTo(c, a, t, end).connect(b);
    return o.d;
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
    rocket: function (c, o, t, p) {                           // ignition cough, then a roar that climbs away, then crackle
      const kk = k(p);
      tone(c, o, t, { f: 150 * kk, f2: 55, d: 0.09, v: 0.5 });
      burst(c, o, t, { ft: 'lowpass', f: 900, d: 0.06, v: 0.4 });
      burst(c, o, t + 0.03, { f: 320 * kk, f2: 2100 * kk, q: 1.6, d: 0.5, v: 0.5, a: 0.05 });
      tone(c, o, t + 0.03, { w: 'sawtooth', f: 78 * kk, f2: 120, d: 0.45, v: 0.25, lp: 380, a: 0.03 });
      for (let i = 0; i < 4; i++) burst(c, o, t + rnd(0.25, 0.6), { ft: 'highpass', f: 3800, d: 0.012, v: rnd(0.05, 0.1) });
      return 0.65;
    },
    cannon: function (c, o, t, p) {                           // crack, a chest-deep report, a barrel that rings on the big ones
      const s = p.s === undefined ? 0.5 : p.s, kk = k(p) * (1.15 - 0.3 * s);
      burst(c, o, t, { ft: 'highpass', f: 3600, d: 0.02, v: 0.35 });
      tone(c, o, t, { f: 105 * kk, f2: 30, d: 0.36 + 0.2 * s, v: 0.75, g: 0.22 });
      burst(c, o, t, { ft: 'lowpass', f: 1900 * kk, f2: 200, d: 0.3 + 0.15 * s, v: 0.5, q: 0.6 });
      burst(c, o, t + 0.05, { ft: 'lowpass', f: 170, d: 0.5 + 0.3 * s, v: 0.3, a: 0.04 });
      if (s > 0.45) tone(c, o, t + 0.01, { w: 'square', f: 196 * kk, d: 0.3, v: 0.07, bp: 880, q: 7 });
      return 0.6 + 0.3 * s;
    },
    mortar: function (c, o, t, p) {                           // a hollow tube: thoonk, and the puff of the charge
      const kk = k(p);
      burst(c, o, t, { f: 235 * kk, q: 9, d: 0.2, v: 1.1 });
      tone(c, o, t, { f: 210 * kk, f2: 96, d: 0.14, v: 0.45, g: 0.07 });
      tone(c, o, t, { f: 66 * kk, f2: 40, d: 0.26, v: 0.55 });
      burst(c, o, t + 0.02, { ft: 'lowpass', f: 900, f2: 300, d: 0.14, v: 0.22, a: 0.02 });
      return 0.34;
    },
    throw: function (c, o, t, p) {                            // hurled by hand: a swish
      const kk = k(p);
      burst(c, o, t, { f: 650 * kk, f2: 1900 * kk, q: 1.1, d: 0.2, v: 0.45, a: 0.05 });
      tone(c, o, t, { w: 'sawtooth', f: 150 * kk, f2: 105, d: 0.1, v: 0.12, lp: 600 });
      return 0.27;
    },
    melee: function (c, o, t, p) {
      const kk = k(p);
      if (p.s > 0.5) {                                        // heavy: the wind-up, the thud, something giving way
        burst(c, o, t, { f: 300, f2: 900, q: 1, d: 0.07, v: 0.2, a: 0.04 });
        tone(c, o, t + 0.06, { f: 96 * kk, f2: 36, d: 0.24, v: 0.7, g: 0.12 });
        burst(c, o, t + 0.06, { ft: 'lowpass', f: 1500, f2: 220, d: 0.2, v: 0.55 });
        burst(c, o, t + 0.07, { f: 1700 * kk, q: 4, d: 0.035, v: 0.25 });
        tone(c, o, t + 0.07, { w: 'square', f: 290 * kk, d: 0.12, v: 0.07, bp: 1300, q: 5 });
        return 0.34;
      }
      burst(c, o, t, { f: 900, f2: 2600, q: 0.9, d: 0.05, v: 0.22, a: 0.025 });          // the swing
      burst(c, o, t + 0.04, { ft: 'lowpass', f: 2200, f2: 380, d: 0.08, v: 0.55 });      // the smack
      tone(c, o, t + 0.04, { f: 175 * kk, f2: 62, d: 0.1, v: 0.55, g: 0.06 });
      burst(c, o, t + 0.045, { f: 2500 * kk, q: 5, d: 0.02, v: 0.2 });                   // knuckle
      return 0.18;
    },
    hiss: function (c, o, t, p) {                             // a fire hose: the valve bites, water with weight behind it
      const kk = k(p);
      burst(c, o, t, { ft: 'highpass', f: 3000 * kk, d: 0.05, v: 0.3, q: 0.5 });
      burst(c, o, t, { f: 1500 * kk, f2: 1100, q: 0.7, d: 0.32, v: 0.55, a: 0.03 });
      burst(c, o, t, { ft: 'lowpass', f: 300, d: 0.34, v: 0.4, a: 0.04 });
      burst(c, o, t + 0.02, { ft: 'highpass', f: 5200, d: 0.3, v: 0.12, a: 0.04, q: 0.5 });
      return 0.38;
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
    // ---- abilities ----
    surge: function (c, o, t, p) {                            // rush coming up: a growl that tightens, breath, a snap
      const kk = k(p), d = 0.55, g = swellGain(c, o, t, 0.5, d * 0.85, 0.02, 0.1), bp = filter(c, g, 'bandpass', 260, 2.5);
      bp.frequency.setValueAtTime(260, t); bp.frequency.exponentialRampToValueAtTime(1500, t + d);
      for (let j = 0; j < 2; j++) {                            // two saws drift apart: the beat between them is the growl
        const s = oscTo(c, bp, 'sawtooth', 72 * kk, t, t + d + 0.15);
        s.frequency.setValueAtTime(72 * kk * (j ? 1.07 : 1), t); s.frequency.exponentialRampToValueAtTime((j ? 215 : 172) * kk, t + d);
      }
      burst(c, o, t, { f: 500, f2: 2600, q: 1.6, d: d, v: 0.16, a: d * 0.8 });
      burst(c, o, t + d, { ft: 'highpass', f: 2800, d: 0.04, v: 0.3 });
      tone(c, o, t + d, { f: 150, f2: 60, d: 0.1, v: 0.35 });
      return d + 0.15;
    },
    leap: function (c, o, t, p) {                             // a yowl off the ground, air, and the landing
      const kk = k(p);
      tone(c, o, t, { w: 'sawtooth', f: 330 * kk, f2: 760 * kk, g: 0.14, d: 0.16, v: 0.16, bp: 1250, q: 4, a: 0.01 });
      burst(c, o, t, { f: 380, f2: 1700, q: 1.2, d: 0.22, v: 0.3, a: 0.04 });
      tone(c, o, t + 0.24, { f: 125 * kk, f2: 48, d: 0.15, v: 0.55 });
      burst(c, o, t + 0.24, { ft: 'lowpass', f: 600, d: 0.16, v: 0.3 });
      return 0.44;
    },
    ability: function (c, o, t, p) {                          // any other ability: a neutral rising sweep
      tone(c, o, t, { w: 'sawtooth', f: 150 * k(p), f2: 620, d: 0.45, v: 0.15, lp: 1600, q: 4, a: 0.05 });
      burst(c, o, t, { f: 500, f2: 3200, q: 2, d: 0.4, v: 0.18, a: 0.08 });
      return 0.52;
    },
    deploy: function (c, o, t, p) {                           // legs down: ratchet, hydraulics, lock
      for (let i = 0; i < 4; i++) burst(c, o, t + 0.05 * i * (1 + i * 0.25), { f: 2100 - i * 150, q: 6, d: 0.02, v: 0.5 });
      burst(c, o, t + 0.1, { ft: 'highpass', f: 1600, d: 0.34, v: 0.16, a: 0.05 });
      tone(c, o, t + 0.44, { f: 95 * k(p), f2: 58, d: 0.16, v: 0.5 });
      tone(c, o, t + 0.44, { w: 'square', f: 400, d: 0.06, v: 0.07, bp: 1300, q: 4 });
      return 0.64;
    },
    undeploy: function (c, o, t, p) {                         // the same machine in reverse: unlock, hydraulics, quick ratchet
      tone(c, o, t, { w: 'square', f: 400, d: 0.06, v: 0.07, bp: 1300, q: 4 });
      tone(c, o, t, { f: 70 * k(p), f2: 100, d: 0.1, v: 0.35 });
      burst(c, o, t + 0.04, { ft: 'highpass', f: 1600, f2: 3200, d: 0.26, v: 0.14, a: 0.03 });
      for (let i = 0; i < 3; i++) burst(c, o, t + 0.3 + 0.04 * i, { f: 1700 + i * 200, q: 6, d: 0.018, v: 0.45 });
      return 0.46;
    },
    brace: function (c, o, t, p) {                            // kit settling: two clacks and a planted boot
      burst(c, o, t, { f: 1900 * k(p), q: 5, d: 0.018, v: 0.5 });
      burst(c, o, t + 0.07, { f: 1500 * k(p), q: 5, d: 0.02, v: 0.4 });
      tone(c, o, t + 0.08, { f: 120, f2: 66, d: 0.07, v: 0.3 });
      return 0.18;
    },
    board: function (c, o, t) { tone(c, o, t, { f: 140, f2: 80, d: 0.1, v: 0.4 }); burst(c, o, t, { f: 1200, q: 2, d: 0.04, v: 0.15 }); return 0.14; },
    repair: function (c, o, t) {
      for (let i = 0; i < 4; i++) burst(c, o, t + i * 0.055, { f: 2600 + i * 120, q: 5, d: 0.025, v: 0.9 });
      return 0.26;
    },
    // ---- support powers ----
    // A strike: the siren winds up through the whole warning, then the shells come down. p = {d: warning s, n: shells, over: s}
    airraid: function (c, o, t, p) {
      const d = NT.clamp(p.d || 3, 0.8, 9), over = NT.clamp(p.over || 0, 0, 8), n = Math.min(12, p.n || 0);
      const g = c.createGain(), gp = g.gain, lp = filter(c, g, 'lowpass', 1900, 1.2);
      gp.value = 0; gp.setValueAtTime(0.0001, t); gp.linearRampToValueAtTime(0.2, t + 0.3);
      gp.setValueAtTime(0.2, t + d - 0.1); gp.linearRampToValueAtTime(0, t + d + 0.8);
      g.connect(o);
      for (let j = 0; j < 2; j++) {                            // a hand-cranked rotor: up, sag, up again, each turn higher
        const s = oscTo(c, j ? gainTo(c, 0.35, lp) : lp, j ? 'square' : 'sawtooth', 220, t, t + d + 0.85, j ? 9 : 0), f = s.frequency;
        f.setValueAtTime(220, t);
        for (let x = 0; x < d; x += 1.6) {
          const top = 430 + 170 * Math.min(1, (x + 1.6) / d);
          f.linearRampToValueAtTime(top, t + Math.min(d, x + 1.1)); f.linearRampToValueAtTime(top * 0.86, t + Math.min(d, x + 1.6));
        }
        f.linearRampToValueAtTime(180, t + d + 0.8);
      }
      for (let i = 0; i < n; i++) {                            // each shell whistles down to its own impact
        const at = t + d + (n > 1 ? i * over / (n - 1) : 0), f0 = rnd(2300, 2900);
        tone(c, o, Math.max(t, at - 0.55), { w: 'triangle', f: f0, f2: f0 * 0.38, g: 0.55, d: 0.55, v: 0.1, a: 0.3 });
      }
      return d + Math.max(0.85, n ? over + 0.1 : 0);
    },
    // A spawn: the warning is the grates rattling, then the slam of the gate and what comes out. p = {d: warning s}
    gates: function (c, o, t, p) {
      const d = NT.clamp(p.d || 2, 0.4, 6), n = Math.round(d * 11), g = c.createGain(), gp = g.gain;
      gp.value = 0; g.connect(o);
      const a = filter(c, g, 'bandpass', 2500, 11), b = filter(c, gainTo(c, 0.8, g), 'bandpass', 1650, 9);
      noiseTo(c, a, t, t + d + 0.1).connect(b);
      for (let i = 0; i < n; i++) {                            // shaken iron, more frantic towards the end
        const ti = t + d * Math.pow((i + rnd(0, 0.6)) / n, 0.7);
        gp.setValueAtTime(0.0001, ti); gp.linearRampToValueAtTime(rnd(0.5, 1.1) * (0.5 + 0.5 * i / n), ti + 0.003); gp.setTargetAtTime(0, ti + 0.003, 0.012);
      }
      tone(c, o, t + d, { f: 105, f2: 42, d: 0.3, v: 0.7 });                                 // the gate hits its stop
      burst(c, o, t + d, { ft: 'lowpass', f: 1400, f2: 250, d: 0.25, v: 0.5 });
      tone(c, o, t + d, { w: 'square', f: 233, d: 0.45, v: 0.09, bp: 1160, q: 8 });
      tone(c, o, t + d, { w: 'square', f: 331, d: 0.35, v: 0.07, bp: 1990, q: 8 });
      tone(c, o, t + d + 0.08, { w: 'sawtooth', f: 190, f2: 95, d: 0.3, v: 0.2, bp: 750, q: 3, a: 0.03 });   // and something snarls
      return d + 0.55;
    },
    // A buff: the house gets to its feet.
    cheer: function (c, o, t, p) {
      crowd(c, o, t, { d: 2.6, v: 0.55, up: 0.9, f1: [520, 900], f2: [1050, 1750] });
      burst(c, o, t, { ft: 'lowpass', f: 260, d: 1.6, v: 0.3, a: 0.6 });
      for (let i = 0; i < 5; i++) tone(c, o, t + 0.5 + i * 0.19, { f: 100, f2: 48, d: 0.1, v: 0.22 + 0.05 * i });   // feet on the boards
      return 2.7;
    },
    // A reveal: someone on the block finds the right frequency.
    sweep: function (c, o, t, p) {
      const g = swellGain(c, o, t, 1.1, 0.08, 0.6, 0.25), bp = filter(c, g, 'bandpass', 500, 9), f = bp.frequency;
      f.setValueAtTime(500, t); f.exponentialRampToValueAtTime(3100, t + 0.45); f.exponentialRampToValueAtTime(1300, t + 0.9);
      noiseTo(c, bp, t, t + 1);
      const w = oscTo(c, swellGain(c, o, t, 0.08, 0.1, 0.55, 0.2), 'sine', 2600, t, t + 0.95).frequency;
      w.setValueAtTime(2600, t); w.exponentialRampToValueAtTime(700, t + 0.5); w.exponentialRampToValueAtTime(1560, t + 0.85);
      tone(c, o, t + 0.95, { f: 1560, d: 0.07, v: 0.14 }); tone(c, o, t + 1.08, { f: 1560, d: 0.12, v: 0.14 });
      return 1.25;
    },
    power: function (c, o, t, p) {                            // any other power: a deep whoomp
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
    error: function (c, o, t) {                               // refused: one flat buzz
      tone(c, o, t, { w: 'square', f: 110, d: 0.13, v: 0.14, lp: 900 });
      tone(c, o, t, { w: 'square', f: 117, d: 0.13, v: 0.11, lp: 900 });
      return 0.16;
    },
    // ---- earcons: one gesture each, told apart by rhythm, direction and register (see the table in the header) ----
    tReady: function (c, o, t) {                              // construction complete: knock, knock, and a fourth rings up
      for (let i = 0; i < 2; i++) { burst(c, o, t + i * 0.11, { f: 520, q: 6, d: 0.05, v: 0.9 }); tone(c, o, t + i * 0.11, { f: 190, f2: 120, d: 0.05, v: 0.25 }); }
      tone(c, o, t + 0.25, { w: 'triangle', f: hz(74), d: 0.5, v: 0.16 });
      tone(c, o, t + 0.25, { w: 'triangle', f: hz(79), d: 0.5, v: 0.14 });
      tone(c, o, t + 0.25, { f: hz(86), d: 0.3, v: 0.05 });
      return 0.8;
    },
    tUnit: function (c, o, t) {                               // unit ready: two taps on one note and up a fourth: ta-ta-TAA
      for (let i = 0; i < 2; i++) tone(c, o, t + i * 0.075, { w: 'square', f: hz(76), d: 0.04, v: 0.1, lp: 3000 });
      tone(c, o, t + 0.15, { w: 'square', f: hz(81), d: 0.17, v: 0.11, lp: 3400 });
      tone(c, o, t + 0.15, { w: 'triangle', f: hz(69), d: 0.17, v: 0.08 });
      return 0.34;
    },
    tFunds: function (c, o, t) {                              // insufficient funds: a coin, and the bottom of an empty tin
      tone(c, o, t, { f: 2637, d: 0.09, v: 0.14 }); tone(c, o, t + 0.02, { f: 3951, d: 0.06, v: 0.08 });
      tone(c, o, t + 0.16, { f: 150, f2: 86, d: 0.14, v: 0.4 });
      burst(c, o, t + 0.16, { ft: 'lowpass', f: 500, d: 0.08, v: 0.25 });
      return 0.34;
    },
    tLowPow: function (c, o, t) {                             // low power: everything winds down
      tone(c, o, t, { w: 'sawtooth', f: 520, f2: 100, g: 0.75, d: 0.75, v: 0.14, lp: 1300, a: 0.01 });
      tone(c, o, t, { w: 'square', f: 260, f2: 50, g: 0.75, d: 0.75, v: 0.07, lp: 700, a: 0.01 });
      return 0.85;
    },
    tPowOk: function (c, o, t) {                              // power back: it winds up and holds
      tone(c, o, t, { w: 'sawtooth', f: 110, f2: 440, g: 0.32, d: 0.5, v: 0.12, lp: 1500, a: 0.02 });
      tone(c, o, t + 0.3, { w: 'triangle', f: 660, d: 0.3, v: 0.08 });
      return 0.62;
    },
    tAlert: function (c, o, t) {                              // base under attack: three hoarse blasts that sag
      for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++)
        tone(c, o, t + i * 0.25, { w: 'sawtooth', f: 466, f2: 392, g: 0.17, d: 0.18, v: 0.14, lp: 1700, q: 2, a: 0.008, det: j * 100 });
      return 0.76;
    },
    tIncoming: function (c, o, t) {                           // hostile strike: three falling whistles, closing in
      [0, 0.2, 0.36].forEach(function (dt) {
        tone(c, o, t + dt, { w: 'triangle', f: 2350, f2: 1050, g: 0.14, d: 0.14, v: 0.22, a: 0.006 });
        tone(c, o, t + dt, { w: 'square', f: 2350, f2: 1050, g: 0.14, d: 0.14, v: 0.04, a: 0.006, lp: 5000 });
      });
      return 0.56;
    },
    tPowReady: function (c, o, t) {                           // support power ready: the theme's opening fifth, swelling, shimmering
      [[0, 74, 0.3, 0.12], [0.3, 81, 0.45, 0.16]].forEach(function (n) {
        const g = swellGain(c, o, t + n[0], n[3], n[2], 0.02, 0.4), end = t + n[0] + n[2] + 0.5;
        oscTo(c, g, 'triangle', hz(n[1]), t + n[0], end); oscTo(c, g, 'sine', hz(n[1]) + 11, t + n[0], end);
      });
      oscTo(c, swellGain(c, o, t, 0.1, 0.5, 0.2, 0.4), 'triangle', hz(50), t, t + 1.15);
      return 1.2;
    },
    tCapture: function (c, o, t) {                            // turf captured: three bells climbing, and the flag goes in
      fmBell(c, o, t, hz(74), 0.14, 0.2); fmBell(c, o, t + 0.13, hz(81), 0.14, 0.2); fmBell(c, o, t + 0.26, hz(86), 0.17, 0.35);
      tone(c, o, t + 0.26, { f: 115, f2: 66, d: 0.18, v: 0.35 });
      return 1;
    },
    tLost: function (c, o, t) {                               // turf lost: the same bells coming down, and the last one is wrong
      fmBell(c, o, t, hz(86), 0.14, 0.2); fmBell(c, o, t + 0.13, hz(81), 0.14, 0.2); fmBell(c, o, t + 0.26, hz(75), 0.17, 0.4);
      return 1;
    },
    tGone: function (c, o, t) {                               // structure lost: one cracked toll and falling masonry
      fmBell(c, o, t, hz(57), 0.2, 0.45); fmBell(c, o, t, hz(57) * 1.035, 0.14, 0.45);
      burst(c, o, t + 0.05, { ft: 'lowpass', f: 700, f2: 180, d: 0.7, v: 0.3, a: 0.05 });
      return 1.1;
    },
    tSuper: function (c, o, t) {                              // enemy superweapon: two low horns a tritone apart, and a pulse
      const lp = filter(c, o, 'lowpass', 240, 1.5), f = lp.frequency;
      f.setValueAtTime(240, t); f.linearRampToValueAtTime(1000, t + 1.3); f.linearRampToValueAtTime(400, t + 2.1);
      const g = swellGain(c, lp, t, 0.15, 0.9, 0.5, 0.7), g2 = swellGain(c, lp, t + 0.7, 0.13, 0.5, 0.35, 0.55);
      oscTo(c, g, 'sawtooth', hz(38), t, t + 2.2, -6); oscTo(c, g, 'sawtooth', hz(50), t, t + 2.2, 6);
      oscTo(c, g2, 'sawtooth', hz(56), t + 0.7, t + 2.2);
      tone(c, o, t, { f: 62, f2: 34, d: 0.4, v: 0.36 }); tone(c, o, t + 0.7, { f: 62, f2: 34, d: 0.4, v: 0.36 });
      return 2.2;
    },
  };

  // --------------------------------------------------------------------------
  // Families: [min gap s, max concurrent, priority, volume, bus]
  // --------------------------------------------------------------------------
  const FAM = A.FAMILIES = {};
  // duck = how far the score is pulled down while the sound plays (ui sounds only)
  function fam(names, gap, max, pri, vol, b, duck) { names.split(' ').forEach(function (n) { FAM[n] = { gap: gap, max: max, pri: pri, vol: vol, bus: b || 'sfx', duck: duck || 0 }; }); }
  fam('rifle', 0.035, 4, 1, 0.55); fam('mg', 0.05, 3, 1, 0.5); fam('twang', 0.07, 3, 2, 0.55);
  fam('rocket', 0.07, 3, 2, 0.6); fam('cannon', 0.06, 3, 3, 0.8); fam('mortar', 0.09, 2, 3, 0.7);
  fam('throw', 0.07, 3, 1, 0.5); fam('melee', 0.045, 4, 1, 0.6); fam('hiss', 0.12, 2, 1, 0.45);
  fam('flame', 0.12, 2, 1, 0.5); fam('zap', 0.06, 3, 1, 0.45); fam('heal', 0.15, 2, 1, 0.45);
  fam('hit', 0.05, 3, 0, 0.3); fam('boomS', 0.05, 4, 3, 0.6); fam('boomM', 0.08, 3, 4, 0.75); fam('boomL', 0.14, 2, 5, 0.85);
  fam('bodyfall', 0.06, 3, 2, 0.6); fam('creature', 0.1, 2, 2, 0.6); fam('wreck', 0.1, 3, 4, 0.8);
  fam('airdeath', 0.15, 2, 4, 0.75); fam('collapse', 0.35, 2, 6, 0.85);
  fam('placed', 0.2, 2, 4, 0.75); fam('sold', 0.3, 1, 3, 0.6); fam('clink', 0.12, 2, 1, 0.4); fam('coin', 1.5, 1, 0, 0.3);
  fam('captured', 0.5, 1, 4, 0.6); fam('rank', 0.4, 1, 3, 0.55); fam('surge ability', 0.2, 2, 3, 0.6);
  fam('leap', 0.15, 2, 3, 0.6); fam('deploy undeploy', 0.2, 2, 2, 0.5); fam('brace', 0.6, 1, 0, 0.3);
  fam('board', 0.15, 2, 1, 0.4); fam('repair', 0.5, 1, 1, 0.35);
  fam('airraid', 0.5, 2, 6, 0.6); fam('gates', 0.5, 2, 6, 0.6); fam('cheer', 0.5, 1, 6, 0.6); fam('sweep', 0.5, 1, 5, 0.55); fam('power', 0.5, 2, 6, 0.9);
  fam('click', 0.03, 2, 7, 0.7, 'ui'); fam('select', 0.06, 1, 7, 0.8, 'ui');
  fam('ackMove ackAttack ackBuild ackCancel', 0.07, 1, 7, 0.8, 'ui'); fam('arm', 0.1, 1, 7, 0.7, 'ui');
  fam('error', 0.25, 1, 8, 0.8, 'ui'); fam('tReady tUnit tPowOk tCapture tLost tGone', 0.5, 1, 8, 0.8, 'ui', 0.5);
  fam('tFunds', 4, 1, 8, 0.8, 'ui', 0.5); fam('tLowPow', 2, 1, 8, 0.8, 'ui', 0.5); fam('tPowReady', 1, 1, 8, 0.8, 'ui', 0.5);
  fam('tAlert', 10, 1, 9, 0.85, 'ui', 0.35); fam('tIncoming', 1, 1, 9, 0.85, 'ui', 0.35); fam('tSuper', 5, 1, 9, 0.9, 'ui', 0.3);
  fam('victory defeat', 2, 1, 10, 0.8, 'ui', 0.15);

  // --------------------------------------------------------------------------
  // Graph + settings
  // --------------------------------------------------------------------------
  function sfxChain(c, out) {
    const b = {};
    b.limiter = c.createDynamicsCompressor();
    b.limiter.threshold.value = -2; b.limiter.knee.value = 0; b.limiter.ratio.value = 20;
    b.limiter.attack.value = 0.001; b.limiter.release.value = 0.12;
    b.master = c.createGain(); b.master.connect(b.limiter);
    b.out = c.createGain(); b.out.gain.value = 0.92; b.limiter.connect(b.out); b.out.connect(out);   // headroom for what the limiter's 1 ms attack lets through
    b.sfx = c.createGain(); b.ui = c.createGain(); b.music = c.createGain();
    b.comp = c.createDynamicsCompressor();
    b.comp.threshold.value = -20; b.comp.knee.value = 10; b.comp.ratio.value = 5;
    b.comp.attack.value = 0.003; b.comp.release.value = 0.25;
    b.trim = c.createGain(); b.trim.gain.value = 0.7;          // offsets the compressor's makeup gain
    b.sfx.connect(b.comp); b.comp.connect(b.trim); b.trim.connect(b.master);
    b.ui.connect(b.master); b.music.connect(b.master);
    b.duck = c.createGain(); b.duck.connect(b.music);            // the score ducks under earcons and stingers
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
  // Pull the score down to `depth` for `hold` seconds, then let it back up. A deeper duck in force is never raised.
  const ducked = { depth: 1, until: 0 };
  function duck(depth, hold) {
    if (!ac) return;
    const t = ac.currentTime, p = bus.duck.gain;
    if (t < ducked.until) { depth = Math.min(depth, ducked.depth); hold = Math.max(hold, ducked.until - t); }
    ducked.depth = depth; ducked.until = t + hold;
    p.cancelScheduledValues(t); duckCurve(p, t, p.value, depth, hold);
  }
  function duckCurve(p, t, from, depth, hold) {
    p.setValueAtTime(from, t); p.linearRampToValueAtTime(depth, t + 0.05);
    p.setValueAtTime(depth, t + 0.05 + hold); p.linearRampToValueAtTime(1, t + 0.05 + hold + 0.6);
  }

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
    if (f.duck) duck(f.duck, d);
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
    if (ev.kind === 'building' && mine(ev.owner)) ui('tGone');
  }
  function alertSeen(ev) {
    const g = G(), w = wd(), p = w && w.players[ev.owner];
    return g.me < 0 || (p && p.team === g.team()) || !NT.Render || NT.Render.visibleAt(ev.x, ev.y);
  }
  const POWER_SOUND = { strike: null, spawn: null, buff: 'cheer', reveal: 'sweep' };   // null: the telegraph already is the sound
  function hostile(owner) { const g = G(), w = wd(); return !!w && g.me >= 0 && !!NT.isEnemy && NT.isEnemy(w, g.me, owner); }
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
    placed: function (ev) {
      const e = wd().byId.get(ev.id), d = NT.DEFS[ev.def];
      atWorld('placed', e ? e.x : ev.x, e ? e.y : ev.y, { s: e ? NT.clamp(e.w * e.h / 9, 0, 1) : 0.5 });
      if (d && d.role === 'super' && hostile(ev.owner)) ui('tSuper');   // fog never hides a superweapon (fog.js)
    },
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
    ability: function (ev) { atWorld(R[ev.ability] && FAM[ev.ability] && FAM[ev.ability].bus === 'sfx' ? ev.ability : 'ability', ev.x, ev.y); },
    deploy: function (ev) { const e = wd().byId.get(ev.id); if (e) atWorld(ev.on ? 'deploy' : 'undeploy', e.x, e.y); },
    board: function (ev) { const e = wd().byId.get(ev.carrier); if (e) atWorld('board', e.x, e.y); },
    unboard: function (ev) { atWorld('board', ev.x, ev.y); },
    repair: function (ev) { const e = wd().byId.get(ev.id); if (ev.on && mine(ev.owner) && e) atWorld('repair', e.x, e.y, null, 0.4); },
    strike_warn: function (ev) {                             // a telegraph: a strike's siren + shell train, or a spawn's rattling gates
      const pd = NT.POWERS[ev.power], spawn = !!pd && pd.kind === 'spawn', bad = hostile(ev.owner);
      if (bad) addHeat(6);
      if (bad && !spawn) ui('tIncoming');                     // the HUD warns of every hostile strike, seen or not
      if (!alertSeen(ev)) return;
      const sp = spatial(ev.x, ev.y), a = pd && pd.strike, d = (ev.delay || 40) * NT.DT;
      voice(spawn ? 'gates' : 'airraid', Math.max(sp.gain, bad ? 0.7 : 0.3), sp.pan, { d: d, n: a ? a.shells : 0, over: a ? (a.overT || 0) * NT.DT : 0 });
    },
    power_used: function (ev) {
      const pd = NT.POWERS[ev.power], name = POWER_SOUND[pd ? pd.kind : ''];
      if (name === null || !alertSeen(ev) || (NT.Render && !NT.Render.onScreen(ev.x, ev.y, 400))) return;
      const sp = spatial(ev.x, ev.y);
      voice(name || 'power', Math.max(sp.gain, 0.35), sp.pan);
    },
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
  // Music I — the score's data: the THEME, the default city voice, reading a gang's MUSIC_HINTS
  // --------------------------------------------------------------------------
  // The NEON TURF motif, [step, scale degree, steps] on a two-bar grid of 16ths: 1 . 5 4 3 | 2 . 7, 1 —
  // a fifth up, a sigh down, under the tonic and home. It never touches the 6th, so it survives any minor mode.
  const THEME = [[0, 0, 6], [6, 4, 2], [8, 3, 4], [12, 2, 4], [16, 1, 6], [22, -1, 2], [24, 0, 8]];
  const MENU_BPM = 66, MIX = 0.45;
  const CITY = {                            // the city's own voice: menu, spectators, any gang without a hint
    bpm: 100, key: 50, scale: [0, 2, 3, 5, 7, 8, 10], swing: 0,
    chords: { a: [0, 6, 5, 4, 0, 6, 3, 4], b: [5, 5, 2, 2, 3, 3, 4, 4] },
    voices: { lead: 'glass', call: 'glass', answer: 'bell', bass: 'pulse', air: 'rain' },
    call: [[0, 7, 2], [2, 4, 2], [4, 2, 6], [10, 4, 2], [12, 6, 4], [16, 7, 2], [18, 4, 2], [20, 2, 6], [26, 1, 2], [28, 0, 4]],
    answer: [[0, 0, 4], [6, 2, 2], [8, 4, 8], [16, 3, 4], [22, 1, 2], [24, 0, 8]],
    riff: {
      tension: [[0, 0, 2], [3, 0, 1], [6, 12, 2], [8, 0, 2], [11, 0, 1], [14, 7, 2]],
      battle: [[0, 0, 1], [2, 0, 1], [3, 12, 1], [4, 0, 1], [6, 0, 1], [7, 7, 1], [8, 0, 1], [10, 0, 1], [11, 12, 1], [12, 0, 1], [14, 10, 1], [15, 12, 1]],
    },
    kit: {
      tension: { hat: '..x...x...x...x.', rim: ['....x.......x...', '....x.......x.o.'] },
      battle: { kick: 'X...x...X...x...', snare: ['....X.......X...', '....X.......X.oo'], hat: 'x.o.x.o.x.o.x.o.' },
      fill: { kick: 'X...x...x...x...', snare: '....X...x.x.xxXX', tom: '..........1.2.34' },
    },
    stab: ['X..x......x.....', 'X..x..x.........'],
  };
  const LINES = { bell: 12, glass: 12, brass: 0, bugle: 0, chant: -12, mob: -12 };   // melodic instrument -> register (semitones)
  const BASSES = { sub: 1, pulse: 1, drive: 1 };
  const AIRS = { rain: 1, wail: 1, crowd: 1, none: 1 };
  const KIT = { kick: 1, stomp: 1, snare: 1, rim: 1, clap: 1, tom: 1, hat: 1 };
  function fin(v) { return typeof v === 'number' && isFinite(v); }
  function numOr(v, lo, hi, d) { return fin(v) ? NT.clamp(v, lo, hi) : d; }
  function pickOr(v, set, d) { return typeof v === 'string' && set[v] !== undefined ? v : d; }
  function phraseOr(p, d, steps) {
    if (!Array.isArray(p) || !p.length) return d;
    for (const n of p) if (!Array.isArray(n) || !fin(n[0]) || !fin(n[1]) || !fin(n[2]) || n[0] < 0 || n[0] >= steps || n[2] <= 0) return d;
    return p.map(function (n) { return [n[0], NT.clamp(Math.round(n[1]), -28, 28), Math.min(n[2], 64)]; }).sort(function (a, b) { return a[0] - b[0]; });
  }
  function patsOr(p, d) {                                   // one 16-step pattern or a list of them -> list
    const l = typeof p === 'string' ? [p] : p;
    if (!Array.isArray(l) || !l.length) return d;
    for (const s of l) if (typeof s !== 'string' || s.length !== 16) return d;
    return l;
  }
  function kitOr(k, d) {
    const out = {};
    if (k && typeof k === 'object') for (const part in k) { const p = KIT[part] ? patsOr(k[part], null) : null; if (p) out[part] = p; }
    return Object.keys(out).length ? out : d;
  }
  function build(h) {                                       // hint -> voice; every field falls back on its own
    const D = CITY, hc = h.chords || {}, hv = h.voices || {}, hr = h.riff || {}, hk = h.kit || {};
    const degs = function (l, d, lo, hi) { return Array.isArray(l) && l.length && l.every(fin) ? l.map(function (x) { return NT.clamp(Math.round(x), lo, hi); }) : d; };
    return {
      bpm: numOr(h.bpm, 50, 180, D.bpm), key: Math.round(numOr(h.key, 36, 60, D.key)), swing: numOr(h.swing, 0, 0.4, D.swing),
      scale: h.scale && h.scale.length >= 5 ? degs(h.scale, D.scale, -12, 24) : D.scale,
      chords: { a: degs(hc.a, D.chords.a, -14, 14), b: degs(hc.b, D.chords.b, -14, 14) },
      voices: { lead: pickOr(hv.lead, LINES, D.voices.lead), call: pickOr(hv.call, LINES, D.voices.call), answer: pickOr(hv.answer, LINES, D.voices.answer),
        bass: pickOr(hv.bass, BASSES, D.voices.bass), air: pickOr(hv.air, AIRS, D.voices.air) },
      call: phraseOr(h.call, D.call, 32), answer: phraseOr(h.answer, D.answer, 32),
      riff: { tension: phraseOr(hr.tension, D.riff.tension, 16), battle: phraseOr(hr.battle, D.riff.battle, 16) },
      kit: { tension: kitOr(hk.tension, D.kit.tension), battle: kitOr(hk.battle, D.kit.battle), fill: kitOr(hk.fill, D.kit.fill) },
      stab: patsOr(h.stab, D.stab),
    };
  }
  const BUILT = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  let cityV = null;
  function voiceOf(h) {
    if (!h || typeof h !== 'object') return cityV || (cityV = build(CITY));
    let V = BUILT.get(h);
    if (!V) BUILT.set(h, V = build(h));
    return V;
  }
  function stepDur(bpm) { return 60 / bpm / 4; }
  function fold(m, lo) { while (m < lo) m += 12; while (m >= lo + 12) m -= 12; return m; }
  function degMidi(V, d) { const n = V.scale.length, o = Math.floor(d / n); return V.key + 12 * o + V.scale[d - o * n]; }
  function h01(a, b) { let x = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0; x = Math.imul(x ^ (x >>> 13), 1274126177); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }

  // --------------------------------------------------------------------------
  // Music II — instruments. Every part is a few long-lived nodes driven by automation: one oscillator pair
  // sings a whole phrase, one noise source plays a bar of snare. Cheap to create, cheap to run.
  // Automation rule: every envelope starts with setValueAtTime, so a new note cleanly cuts the previous tail.
  // --------------------------------------------------------------------------
  function gainTo(c, v, dest) { const g = c.createGain(); g.gain.value = v; g.connect(dest); return g; }
  function echoIn(c, out, dt, wet) {                        // dry to out + a darkening feedback delay
    const inp = c.createGain(), d = c.createDelay(1.5), w = gainTo(c, wet, out), fb = c.createGain();
    d.delayTime.value = Math.min(1.4, dt); fb.gain.value = 0.34;
    inp.connect(out); inp.connect(d); d.connect(w); d.connect(filter(c, fb, 'lowpass', 2200, 0.5)); fb.connect(d);
    return inp;
  }
  const VOWEL = { a: [760, 1220], e: [540, 1780], o: [470, 840], u: [340, 720] };
  function formants(c, out, seqv, q) {                       // a throat: three band-passes; the vowel moves per note
    const inp = c.createGain(), sum = filter(c, out, 'lowpass', 3000, 0.5), F = [];
    [[1, q], [0.7, q * 1.4], [0.18, 6]].forEach(function (d, i) {
      const f = filter(c, gainTo(c, d[0], sum), 'bandpass', i < 2 ? VOWEL[seqv[0]][i] : 2600, d[1]);
      inp.connect(f); F.push(f);
    });
    return { in: inp, note: function (n, i) { const v = VOWEL[seqv[i % seqv.length]]; F[0].frequency.setValueAtTime(v[0], n.t); F[1].frequency.setValueAtTime(v[1], n.t); } };
  }
  let driveC = null;
  function driveCurve() {
    if (!driveC) { driveC = new Float32Array(1024); for (let i = 0; i < 1024; i++) { const x = i / 511.5 - 1; driveC[i] = Math.tanh(5 * x) / Math.tanh(5); } }
    return driveC;
  }
  // per (layer, role) instrument bus: (c, out, m) -> {in, note?(n, i), vib?}; m = {sd, srcs} collects free-running sources
  const BUS = {
    bell: function (c, out, m) { return { in: filter(c, echoIn(c, out, m.sd * 3, 0.35), 'lowpass', 4500, 0.5) }; },
    glass: function (c, out, m) { return { in: filter(c, echoIn(c, out, m.sd * 3, 0.3), 'lowpass', 2400, 0.6) }; },
    brass: function (c, out) {
      const lp = filter(c, out, 'lowpass', 900, 1.2);
      return { in: lp, note: function (n) { const f = lp.frequency; f.setValueAtTime(480, n.t); f.linearRampToValueAtTime(950 + 800 * n.v, n.t + 0.05); f.setTargetAtTime(800, n.t + 0.05, 0.14); } };
    },
    bugle: function (c, out, m) {                           // one horn, far down the street: nasal peak, slow vibrato, long echo
      const lp = filter(c, echoIn(c, out, m.sd * 6, 0.45), 'lowpass', 2300, 0.7), pk = filter(c, lp, 'peaking', 1150, 1.4), hp = filter(c, pk, 'highpass', 300, 0.7);
      pk.gain.value = 7;
      const lfo = c.createOscillator(), dep = c.createGain();
      lfo.frequency.value = 5.3; dep.gain.value = 9; lfo.connect(dep); lfo.start(0); m.srcs.push(lfo);
      return { in: hp, vib: dep };
    },
    chant: function (c, out) { return formants(c, out, ['e', 'e', 'o', 'a'], 5); },
    mob: function (c, out) { return formants(c, out, ['o', 'a'], 3.5); },
    sub: function (c, out) { return { in: out }; },
    pulse: function (c, out) { return { in: filter(c, out, 'lowpass', 380, 1.2) }; },
    drive: function (c, out) {
      const ws = c.createWaveShaper();
      ws.curve = driveCurve(); ws.connect(filter(c, gainTo(c, 0.13, out), 'lowpass', 900, 1.8));
      return { in: ws };
    },
  };
  // osc: [type, detune cents, frequency ratio]; a attack, sus sustain level, r release (s), v level; perc = decay time constant
  const SHAPE = {
    bell: { osc: [['sine', 0, 1], ['sine', 0, 3.51]], a: 0.004, sus: 0.25, r: 0.2, v: 0.07 },   // block chords only; lines use bellLine
    glass: { osc: [['triangle', -6, 1], ['triangle', 6, 1]], a: 0.05, sus: 0.7, r: 0.12, v: 0.12 },
    brass: { osc: [['sawtooth', -7, 1], ['sawtooth', 7, 1]], a: 0.03, sus: 0.75, r: 0.06, v: 0.17 },
    bugle: { osc: [['sawtooth', 0, 1]], a: 0.025, sus: 0.85, r: 0.07, v: 0.1 },
    chant: { osc: [['sawtooth', -16, 1], ['sawtooth', 13, 1]], a: 0.02, sus: 0.8, r: 0.05, v: 0.5, scoop: 0.92 },
    mob: { osc: [['sawtooth', -24, 1], ['sawtooth', 21, 1], ['sawtooth', 3, 1]], a: 0.03, sus: 0.85, r: 0.06, v: 0.3, scoop: 0.9 },
    sub: { osc: [['sine', 0, 1], ['triangle', 0, 2]], a: 0.03, sus: 0.8, r: 0.12, v: 0.1 },
    pulse: { osc: [['square', 0, 1]], a: 0.006, sus: 0.6, r: 0.04, v: 0.15 },
    drive: { osc: [['sawtooth', 0, 1], ['square', 0, 0.5]], a: 0.005, sus: 0.8, r: 0.03, v: 0.35 },
  };
  // One monophonic line. notes: [{t, f, d, v, n}] ascending in t; n = re-strikes within the note (a hammered note).
  // ratios (optional) turns the line into block chords: one oscillator per ratio.
  function line(c, B, inst, notes, lvl, ratios) {
    if (!notes.length) return 0;
    const I = SHAPE[inst], g = c.createGain(), p = g.gain, last = notes[notes.length - 1];
    const defs = ratios ? ratios.map(function (r, i) { return [I.osc[0][0], (i - 1) * 6, r]; }) : I.osc;
    p.value = 0; g.connect(B.in);
    const oscs = defs.map(function (o) {
      const s = c.createOscillator();
      s.type = o[0]; s.detune.value = o[1]; s.frequency.value = notes[0].f * o[2];
      if (B.vib) B.vib.connect(s.detune);
      s.connect(g); s.start(Math.max(0, notes[0].t - 0.01)); s.stop(last.t + last.d + 0.5);
      return s;
    });
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i], gap = i + 1 < notes.length ? notes[i + 1].t - n.t : n.d + 0.4, d = Math.max(0.03, Math.min(n.d, gap - 0.004));
      for (let j = 0; j < oscs.length; j++) {
        const fp = oscs[j].frequency, f = n.f * defs[j][2];
        if (I.scoop) { fp.setValueAtTime(f * I.scoop, n.t); fp.exponentialRampToValueAtTime(f, n.t + 0.045); } else fp.setValueAtTime(f, n.t);
      }
      const k = n.n || 1, each = d / k, a = Math.min(I.a, each * 0.3);
      for (let s = 0; s < k; s++) {
        const ts = n.t + s * each, v = n.v * lvl * I.v * (s ? 0.8 : 1);
        p.setValueAtTime(0.0001, ts); p.linearRampToValueAtTime(v, ts + a);
        p.setTargetAtTime(v * I.sus, ts + a, 0.08);
        p.setTargetAtTime(0, Math.max(ts + a + 0.004, ts + each - I.r), I.r / 3);
      }
      if (B.note) B.note(n, i);
    }
    return oscs.length + 1;
  }
  // FM bell; two alternating voices so each note rings through the next one.
  function bellLine(c, B, notes, lvl) {
    let made = 0;
    for (let k = 0; k < 2; k++) {
      const mine = notes.filter(function (n, i) { return (i & 1) === k; });
      if (!mine.length) continue;
      const car = c.createOscillator(), mod = c.createOscillator(), mg = c.createGain(), g = c.createGain(), end = mine[mine.length - 1].t + 3;
      mg.gain.value = 0; g.gain.value = 0;
      mod.connect(mg); mg.connect(car.frequency); car.connect(g); g.connect(B.in);
      for (const n of mine) {
        car.frequency.setValueAtTime(n.f, n.t); mod.frequency.setValueAtTime(n.f * 3.51, n.t);
        mg.gain.setValueAtTime(n.f * 1.5, n.t); mg.gain.setTargetAtTime(n.f * 0.04, n.t, 0.22);
        g.gain.setValueAtTime(0.0001, n.t); g.gain.linearRampToValueAtTime(n.v * lvl * 0.1, n.t + 0.004); g.gain.setTargetAtTime(0, n.t + 0.004, 0.5);
      }
      const t0 = Math.max(0, mine[0].t - 0.01);
      car.start(t0); mod.start(t0); car.stop(end); mod.stop(end);
      made += 4;
    }
    return made;
  }
  function pad(c, dest, freqs, t, d, v) {
    const g = c.createGain(), p = g.gain, att = Math.min(0.9, d * 0.3);
    p.value = 0; p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(v, t + att);
    p.setValueAtTime(v, t + d); p.linearRampToValueAtTime(0, t + d + 0.7);
    g.connect(dest);
    for (const f of freqs) for (let j = -1; j <= 1; j += 2) {
      const s = c.createOscillator();
      s.type = 'sawtooth'; s.frequency.value = f; s.detune.value = j * 9;
      s.connect(g); s.start(Math.max(0, t)); s.stop(t + d + 0.75);
    }
    return freqs.length * 2 + 1;
  }
  // hits: [{t, v, tc}] ascending -> one noise source for all of them
  function noiseHits(c, dest, hits, lvl) {
    const s = c.createBufferSource(), g = c.createGain(), p = g.gain, last = hits[hits.length - 1];
    s.buffer = noiseBuf(c); s.loop = true; p.value = 0; s.connect(g); g.connect(dest);
    for (const h of hits) { p.setValueAtTime(0.0001, h.t); p.linearRampToValueAtTime(h.v * lvl, h.t + 0.002); p.setTargetAtTime(0, h.t + 0.002, h.tc); }
    s.start(Math.max(0, hits[0].t - 0.005), (hits[0].t * 7.31) % 1.2); s.stop(last.t + last.tc * 8 + 0.05);
    return 2;
  }
  // hits: [{t, v, f, f2}] ascending -> one oscillator; gl = pitch glide s, tc = decay time constant
  function toneHits(c, dest, hits, type, gl, tc, lvl) {
    const s = c.createOscillator(), g = c.createGain(), p = g.gain, fp = s.frequency, last = hits[hits.length - 1];
    s.type = type; p.value = 0; fp.value = hits[0].f; s.connect(g); g.connect(dest);
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i], gap = i + 1 < hits.length ? hits[i + 1].t - h.t : 9;
      fp.setValueAtTime(h.f, h.t); fp.exponentialRampToValueAtTime(h.f2, h.t + Math.min(gl, gap - 0.004));
      p.setValueAtTime(0.0001, h.t); p.linearRampToValueAtTime(h.v * lvl, h.t + 0.003); p.setTargetAtTime(0, h.t + 0.003, tc);
    }
    s.start(Math.max(0, hits[0].t - 0.005)); s.stop(last.t + tc * 8 + 0.05);
    return 2;
  }
  // Pattern characters: X accent, x hit, o ghost, r roll (two quick strokes), 1-4 tom pitch (high -> low), . rest
  const VEL = { X: 1, x: 0.7, o: 0.32, r: 0.5, 1: 0.85, 2: 0.85, 3: 0.85, 4: 0.9 };
  const TOM = { 1: 196, 2: 147, 3: 110, 4: 82 };
  function hitsOf(pat, T) {
    const out = [];
    for (let i = 0; i < 16; i++) { const v = VEL[pat[i]]; if (v) out.push({ t: T(i), v: v, ch: pat[i] }); }
    return out;
  }
  function withF(hits, f, f2) { return hits.map(function (h) { const b = TOM[h.ch] || f; return { t: h.t, v: h.v, f: b, f2: TOM[h.ch] ? b * 0.7 : f2 }; }); }
  function withTc(hits, tc, tcAcc) { return hits.map(function (h) { return { t: h.t, v: h.v, tc: h.ch === 'X' ? tcAcc || tc : tc }; }); }
  function kitBus(m, layer) {
    if (m.kit[layer]) return m.kit[layer];
    const c = m.c, out = m[layer];
    return (m.kit[layer] = { out: out, snare: filter(c, out, 'bandpass', 1900, 0.8), rim: filter(c, out, 'bandpass', 2300, 5),
      clap: filter(c, out, 'bandpass', 1250, 1.4), hat: filter(c, out, 'highpass', 7200, 0.7), thud: filter(c, out, 'lowpass', 420, 0.7) });
  }
  function drums(m, layer, part, hits, lvl) {
    if (!hits.length) return 0;
    const c = m.c, K = kitBus(m, layer), sd = m.sd;
    switch (part) {
      case 'kick': return toneHits(c, K.out, withF(hits, 150, 44), 'sine', 0.1, 0.07, 0.5 * lvl);
      case 'stomp': return toneHits(c, K.out, withF(hits, 104, 40), 'sine', 0.08, 0.06, 0.46 * lvl) + noiseHits(c, K.thud, withTc(hits, 0.03, 0.045), 0.4 * lvl);
      case 'tom': return toneHits(c, K.out, withF(hits, 130, 91), 'sine', 0.14, 0.075, 0.36 * lvl);
      case 'rim': return noiseHits(c, K.rim, withTc(hits, 0.012), 1.5 * lvl);
      case 'hat': return noiseHits(c, K.hat, withTc(hits, 0.014, 0.03), 0.2 * lvl);
      case 'clap': {
        const fl = [];
        for (const h of hits) { for (let j = 0; j < 3; j++) fl.push({ t: h.t + j * 0.012, v: h.v * 0.7, tc: 0.005 }); fl.push({ t: h.t + 0.036, v: h.v, tc: 0.05 }); }
        return noiseHits(c, K.clap, fl, 0.75 * lvl);
      }
      case 'snare': {
        const st = [], body = [];
        for (const h of hits) {
          if (h.ch === 'r') { st.push({ t: h.t, v: 0.45, tc: 0.018 }, { t: h.t + sd / 2, v: 0.4, tc: 0.018 }); continue; }
          st.push({ t: h.t, v: h.v, tc: h.ch === 'o' ? 0.02 : h.ch === 'X' ? 0.06 : 0.045 });
          if (h.ch !== 'o') body.push({ t: h.t, v: h.v, f: 215, f2: 160 });
        }
        return noiseHits(c, K.snare, st, 0.55 * lvl) + (body.length ? toneHits(c, K.out, body, 'triangle', 0.05, 0.03, 0.2 * lvl) : 0);
      }
    }
    return 0;
  }
  function wail(c, dest, t, d, f0, f1, v) {                  // a slow distant rise and fall
    const s = c.createOscillator(), g = c.createGain(), p = g.gain, fp = s.frequency;
    s.type = 'triangle'; p.value = 0; g.connect(filter(c, dest, 'lowpass', 900, 0.7)); s.connect(g);
    fp.setValueAtTime(f0, t); fp.linearRampToValueAtTime(f1, t + d * 0.42); fp.setValueAtTime(f1, t + d * 0.52); fp.linearRampToValueAtTime(f0 * 0.94, t + d);
    p.setValueAtTime(0.0001, t); p.linearRampToValueAtTime(v, t + d * 0.3); p.setValueAtTime(v, t + d * 0.6); p.linearRampToValueAtTime(0, t + d);
    s.start(Math.max(0, t)); s.stop(t + d + 0.05);
    return 3;
  }
  function loopNoise(m, dest) {
    const s = m.c.createBufferSource();
    s.buffer = noiseBuf(m.c); s.loop = true; s.connect(dest); s.start(0); m.srcs.push(s);
    return s;
  }
  // layers calm / tens / batt -> tone (a gentle high shelf against long-session fatigue) -> mix -> out
  function musicChain(c, out, V, menu) {
    const m = { c: c, V: V, menu: !!menu, sd: stepDur(menu ? MENU_BPM : V.bpm), bus: {}, kit: {}, srcs: [], only: null };
    m.mix = gainTo(c, MIX, out);
    m.tone = filter(c, m.mix, 'highshelf', 3200); m.tone.gain.value = -3;
    m.calm = gainTo(c, 1, m.tone); m.tens = gainTo(c, 0, m.tone); m.batt = gainTo(c, 0, m.tone);
    m.tensR = gainTo(c, 1, m.tens);                          // tension's rhythm section: cross-fades into the battle layer's
    m.pad = filter(c, m.calm, 'lowpass', menu ? 700 : 850, 0.7);
    const air = V.voices.air;
    if (air === 'rain') loopNoise(m, filter(c, gainTo(c, 0.034, m.calm), 'highpass', 4200, 0.5));
    else if (air === 'crowd') {                             // the same crowd murmurs in the calm and roars in the battle
      m.murmur = filter(c, gainTo(c, 0.045, m.calm), 'bandpass', 700, 0.9);
      m.roarG = gainTo(c, 0, m.batt); m.roar = filter(c, m.roarG, 'bandpass', 1000, 0.8);
      loopNoise(m, m.murmur).connect(m.roar);
    }
    return m;
  }
  function busOf(m, layer, role, inst) {
    const key = layer + ':' + role;
    return m.bus[key] || (m.bus[key] = BUS[inst](m.c, m[layer], m));
  }

  // --------------------------------------------------------------------------
  // Music III — the arrangement. 32 bars: A A' B A''; 8-bar sections of four 2-bar phrases; odd passes vary.
  // A cell is [role, source, how]: role bell | lead | call | answer; source the THEME or the gang's call / answer;
  // how {from, to: note slice, shift: degrees, inv: mirror about the tonic, aug: double length, ham: hammered 8ths,
  //      alt: extra shift on odd passes, altInv: inverted on odd passes, yield: silent while the battle layer plays}.
  // --------------------------------------------------------------------------
  const HEAD = { to: 4 }, TAIL = { from: 4 }, HAM = { ham: 1 }, PLAIN = {}, FAR = { yield: 1 }, INV = { inv: 1, yield: 1 };
  const PLAN = {
    menu: [
      [['bell', 'theme', PLAIN], null, ['lead', 'theme', PLAIN], ['bell', 'theme', { from: 4, shift: 7 }]],
      [['lead', 'theme', { inv: 1 }], null, ['bell', 'theme', { aug: 1 }], null],
    ],
    calm: [
      [['bell', 'theme', HEAD], null, ['bell', 'theme', TAIL], null],
      [['bell', 'theme', { alt: 7 }], null, ['bell', 'theme', { to: 4, shift: 2 }], null],
      [['call', 'call', FAR], ['bell', 'theme', TAIL], ['call', 'call', FAR], null],
      [['bell', 'theme', { aug: 1 }], null, null, ['bell', 'theme', TAIL]],
    ],
    tens: [
      [null, ['lead', 'theme', { inv: 1, to: 4, yield: 1 }], null, ['lead', 'theme', { inv: 1, from: 4, yield: 1 }]],
      [null, ['lead', 'theme', INV], null, null],
      [null, ['answer', 'answer', FAR], null, ['answer', 'answer', FAR]],
      [null, null, ['lead', 'theme', INV], null],
    ],
    batt: [
      [['lead', 'theme', HAM], null, ['lead', 'theme', { ham: 1, alt: 7 }], null],
      [['lead', 'theme', HAM], ['answer', 'answer', PLAIN], ['lead', 'theme', { ham: 1, to: 4, shift: 2 }], ['answer', 'answer', PLAIN]],
      [['call', 'call', PLAIN], ['answer', 'answer', PLAIN], ['call', 'call', PLAIN], ['answer', 'answer', PLAIN]],
      [['lead', 'theme', { ham: 1, altInv: 1 }], ['call', 'call', PLAIN], ['lead', 'theme', HAM], ['answer', 'answer', PLAIN]],
    ],
  };
  const LVL = { bell: 1, lead: 1, call: 1, answer: 1, far: 0.5, pad: 0.045, sub: 1, riffT: 0.8, riffB: 1, kitT: 0.8, kitB: 1, stab: 1.3 };
  const HEAVY = { kick: 1, stomp: 1, tom: 1 };
  A.LEVELS = LVL;                           // the score's mix table (instrumentation: solo a part offline)
  // Schedule bar n of the score at t0 on chain m. on = {calm, tens, tensR, batt, hot: the battle layer is audible};
  // log (optional) collects every note.
  function bar(m, n, t0, on, log) {
    const c = m.c, V = m.V, sd = m.sd, sw = V.swing, form = m.menu ? 16 : 32, solo = m.only;
    const T = function (i) { return t0 + (i + (i & 1 ? sw : 0)) * sd; };
    const b8 = n % 8, sec = Math.floor(n % form / 8), q = b8 >> 1, odd = Math.floor(n / form) & 1;
    const isB = m.menu ? sec === 1 : sec === 2, prog = isB ? V.chords.b : V.chords.a;
    const deg = Math.round(prog[b8 % prog.length]), root = degMidi(V, deg), low = fold(root, V.key - 17);
    let made = 0;
    const sing = function (layer, cell) {
      if (!cell || (b8 & 1) || (solo && solo !== cell[0]) || (cell[2].yield && on.hot)) return;
      const o = cell[2], role = cell[0], inst = role === 'bell' ? 'bell' : V.voices[role];
      const src = cell[1] === 'call' ? V.call : cell[1] === 'answer' ? V.answer : THEME;
      const k = o.aug ? 2 : 1, inv = o.inv || (o.altInv && odd) ? -1 : 1, up = (o.shift || 0) + (o.alt && odd ? o.alt : 0), notes = [];
      for (const x of src.slice(o.from || 0, o.to || src.length)) {
        const mm = degMidi(V, inv * Math.round(x[1]) + up) + 12 + LINES[inst];
        notes.push({ t: T(x[0] * k), f: hz(mm), d: x[2] * k * sd * (o.ham ? 1 : 0.92), v: 1, n: o.ham ? Math.max(1, Math.round(x[2] * k / 2)) : 1, m: mm });
      }
      if (log) for (const x of notes) log.push({ t: x.t, m: x.m, d: x.d, n: x.n, part: role, inst: inst, layer: layer });
      const B = busOf(m, layer, role, inst), lvl = LVL[role] * (o === FAR ? LVL.far : 1);
      made += inst === 'bell' ? bellLine(c, B, notes, lvl) : line(c, B, inst, notes, lvl);
    };
    const bass = function (layer, riff, lvl) {
      const notes = riff.map(function (x) { return { t: T(x[0]), f: hz(low + x[1]), d: x[2] * sd * 0.9, v: 1 }; });
      if (log) for (const x of riff) log.push({ t: T(x[0]), m: low + x[1], d: x[2] * sd * 0.9, part: 'bass', layer: layer });
      made += line(c, busOf(m, layer, 'bass', V.voices.bass), V.voices.bass, notes, lvl);
    };
    const kit = function (layer, K, lvl, light) {
      for (const part in K) {
        if (light && HEAVY[part]) continue;
        const hits = hitsOf(K[part][n % K[part].length], T);
        if (log) for (const h of hits) log.push({ t: h.t, part: part, v: h.v, layer: layer });
        made += drums(m, layer, part, hits, lvl);
      }
    };
    if (on.calm) {
      if (!solo) {
        if (m.menu || !(odd && sec === 1)) {                  // odd passes leave A' bare: bass and bell only
          const ch = (m.menu ? [0, 2, 4, 6] : [0, 2, 4]).map(function (k) { return fold(degMidi(V, deg + k), V.key + 5); });
          if (log) for (const x of ch) log.push({ t: t0, m: x, d: 16 * sd, part: 'pad', layer: 'calm' });
          made += pad(c, m.pad, ch.map(hz), t0, 16 * sd, LVL.pad);
        }
        const sub = (m.menu ? [0] : [0, 8]).map(function (s) { return { t: T(s), f: hz(low), d: (m.menu ? 14 : 7) * sd, v: 1 }; });
        if (log) for (const x of sub) log.push({ t: x.t, m: low, d: x.d, part: 'sub', layer: 'calm' });
        made += line(c, busOf(m, 'calm', 'sub', 'sub'), 'sub', sub, LVL.sub);
        if (V.voices.air === 'rain') {                        // a few drops on the glass
          const drops = [];
          for (let i = 0; i < 3; i++) { const f = 1700 + 2200 * h01(n, i); drops.push({ t: t0 + (i + h01(n, i + 9)) * 16 * sd / 3, v: 0.4 + 0.6 * h01(i, n), f: f, f2: f * 0.82 }); }
          made += toneHits(c, m.calm, drops, 'sine', 0.05, 0.03, 0.035);
        } else if (m.murmur) m.murmur.frequency.setTargetAtTime(520 + 520 * h01(n, 7), t0, 16 * sd / 3);
      }
      sing('calm', PLAN[m.menu ? 'menu' : 'calm'][sec][q]);
    }
    if (on.tens) {
      if (on.tensR && !solo) { kit('tensR', V.kit.tension, LVL.kitT); bass('tensR', V.riff.tension, LVL.riffT); }
      sing('tens', PLAN.tens[sec][q]);
      if (V.voices.air === 'wail' && b8 === 2 && !solo) made += wail(c, m.tens, t0, 32 * sd, hz(degMidi(V, 4)), hz(degMidi(V, 7)), 0.05);
    }
    if (on.batt) {
      const brk = odd && sec === 1 && b8 < 2;                // odd passes open A' with a two-bar breakdown
      if (!solo) {
        kit('batt', b8 === 7 ? V.kit.fill : V.kit.battle, LVL.kitB, brk);
        if (b8 === 0 && !brk) made += noiseHits(c, kitBus(m, 'batt').hat, [{ t: t0, v: 1, tc: 0.35 }], 0.16);
        if (!brk) bass('batt', V.riff.battle, LVL.riffB);
        if (!isB && !brk) {
          const inst = V.voices.lead, base = fold(root, V.key - 5), tones = [base, base + degMidi(V, deg + 4) - root, base + degMidi(V, deg + 2) - root + 12];
          const hits = hitsOf(V.stab[n % V.stab.length], T).map(function (h) { return { t: h.t, f: hz(base), d: sd * (h.ch === 'X' ? 2.4 : 1.5), v: h.v }; });
          if (log) for (const h of hits) for (const x of tones) log.push({ t: h.t, m: x, d: h.d, part: 'stab', layer: 'batt' });
          made += line(c, busOf(m, 'batt', 'stab', inst), inst, hits, LVL.stab, tones.map(function (x) { return Math.pow(2, (x - base) / 12); }));
        }
        if (m.roar) {
          m.roar.frequency.setTargetAtTime(850 + 600 * h01(n, 3), t0, 16 * sd / 3);
          if (b8 === 7) m.roarG.gain.setTargetAtTime(0.2, t0, 16 * sd / 2.5);       // the crowd rises into the fill
          else m.roarG.gain.setTargetAtTime(0.07, t0 + (b8 ? 0 : 2 * sd), 16 * sd / 4);
        }
      }
      sing('batt', PLAN.batt[sec][q]);
    }
    return made;
  }

  // --------------------------------------------------------------------------
  // Stingers — victory and defeat in the gang's own voice: its call instrument, its lead, its drums
  // --------------------------------------------------------------------------
  function combo(c, o, V) { return { c: c, V: V, sd: stepDur(V.bpm), bus: {}, kit: {}, srcs: [], out: o }; }
  function melody(c, m, o, inst, list, lvl) { return inst === 'bell' ? bellLine(c, BUS.bell(c, o, m), list, lvl) : line(c, BUS[inst](c, o, m), inst, list, lvl); }
  function heavyOf(V) { return V.kit.battle.stomp ? 'stomp' : 'kick'; }
  // Victory: the back half of the gang's fill, then the theme's opening fifth carried on up to the octave over a MAJOR chord.
  R.victory = function (c, o, t, p) {
    const V = p.voice || voiceOf(null), m = combo(c, o, V), sd = m.sd, v = V.voices, t1 = t + 8 * sd, land = t1 + 4 * sd;
    for (const part in V.kit.fill) drums(m, 'out', part, hitsOf(V.kit.fill[part][0], function (i) { return t + (i - 8) * sd; }).filter(function (h) { return h.t > t - 0.001; }), 0.5);
    const base = fold(V.key + 12 + LINES[v.call], 52);
    melody(c, m, o, v.call, [[0, 0, 2], [2, 4, 2], [4, 7, 8]].map(function (x) { return { t: t1 + x[0] * sd, f: hz(base + degMidi(V, x[1]) - V.key), d: x[2] * sd, v: 1 }; }), 1.15);
    line(c, BUS[v.lead](c, o, m), v.lead, [{ t: land, f: hz(V.key), d: 8 * sd, v: 1 }], 0.65, [1, Math.pow(2, 7 / 12), Math.pow(2, 16 / 12)]);
    line(c, BUS.sub(c, o, m), 'sub', [{ t: land, f: hz(V.key - 12), d: 8 * sd, v: 1 }], 1.2);
    drums(m, 'out', heavyOf(V), [{ t: land, v: 1, ch: 'X' }], 0.55);
    noiseHits(c, kitBus(m, 'out').hat, [{ t: land, v: 1, tc: 0.4 }], 0.2);
    if (v.air === 'crowd') crowd(c, o, t1 + 2 * sd, { d: 2.6, v: 0.3, up: 0.5, f1: [600, 950], f2: [1200, 1800] });
    const end = land + 8 * sd + 1.8;                       // room for the call's echo
    for (const s of m.srcs) s.stop(end + 0.5);
    return end - t;
  };
  // Defeat: the call voice alone walks down from the tonic to the fifth and stops there (semitones: dark in any mode),
  // over a drone that sags and a slowing heartbeat on the gang's heaviest drum.
  R.defeat = function (c, o, t, p) {
    const V = p.voice || voiceOf(null), m = combo(c, o, V), sd = NT.clamp(m.sd * 1.4, 0.16, 0.19), v = V.voices, top = fold(V.key + 24 + LINES[v.call], 64);
    melody(c, m, o, v.call, [[0, 0, 4], [4, -2, 4], [8, -4, 4], [12, -5, 9]].map(function (x) { return { t: t + x[0] * sd, f: hz(top + x[1]), d: x[2] * sd * 0.95, v: 1 }; }), 1.3);
    tone(c, o, t, { f: hz(V.key - 12), f2: hz(V.key - 13), g: 21 * sd, d: 21 * sd, v: 0.26, a: 0.3 });
    tone(c, o, t, { w: 'triangle', f: hz(V.key), f2: hz(V.key - 1), g: 21 * sd, d: 21 * sd, v: 0.1, a: 0.3 });
    drums(m, 'out', heavyOf(V), [0, 6, 16].map(function (i) { return { t: t + i * sd, v: 0.8, ch: 'x' }; }), 0.8);
    if (v.air === 'crowd') crowd(c, o, t + 2 * sd, { d: 2.8, v: 0.22, up: 0.4, f1: [800, 420], f2: [1500, 800] });   // the house groans
    const end = t + 21 * sd + 1.8;
    for (const s of m.srcs) s.stop(end + 0.5);
    return end - t;
  };

  // --------------------------------------------------------------------------
  // Music IV — the live sequencer: one bar at a time, layers follow combat heat
  // --------------------------------------------------------------------------
  const seq = { key: null, bar: 0, next: 0 };
  const tgt = { calm: 1, tens: 0, batt: 0 };
  function retire(m, t) {
    const p = m.mix.gain;
    p.cancelScheduledValues(t); p.setValueAtTime(p.value, t); p.linearRampToValueAtTime(0, t + 0.35);
    setTimeout(function () { try { m.srcs.forEach(function (s) { s.stop(); }); m.mix.disconnect(); } catch (e) { /* already gone */ } }, 600);
  }
  // The score follows the screen: the menu states the theme in the city's voice; a match plays the local gang's voice.
  function setScore(menu, hint) {
    const key = menu ? 'menu' : hint || 'city';
    if (seq.key === key && mus) return;
    seq.key = key; seq.bar = 0;
    if (!ac) return;
    const t = ac.currentTime;
    if (mus) retire(mus, t);
    mus = musicChain(ac, bus.duck, voiceOf(menu ? null : hint), menu);
    mus.mix.gain.setValueAtTime(0.0001, t); mus.mix.gain.linearRampToValueAtTime(MIX, t + 1.2);
    seq.next = t + 0.12;
  }
  function layerTargets() {
    const g = G();
    if (!g || g.state === 'menu' || g.state === 'boot' || !g.world) return [1, 0, 0];
    if (g.state === 'over') return [0.7, 0, 0];
    const q = function (v) { return Math.round(NT.clamp(v, 0, 1) * 4) / 4; };
    return [1, q((heat - 1) / 4), q((heat - 8) / 8)];
  }
  function mixLayers() {
    const t = ac.currentTime, v = layerTargets(), L = [mus.calm, mus.tens, mus.batt, mus.tensR];
    v.push(1 - v[2]);
    for (let i = 0; i < 4; i++) {
      const p = L[i].gain;
      if (p._target === v[i]) continue;
      const fast = i === 3 ? v[i] < p.value : v[i] > p.value;   // in with the fight in 1.5 s, out in 4
      p.cancelScheduledValues(t); p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(v[i], t + (fast ? 1.5 : 4));
      p._target = v[i];
    }
    if (v[2] > 0 && tgt.batt === 0) engage(t);
    tgt.calm = v[0]; tgt.tens = v[1]; tgt.batt = v[2];
  }
  // The fight is on: the gang's heaviest drum says so on the next 16th, without waiting for the battle layer's bar.
  let engagedAt = -99;
  function engage(now) {
    const s = settings(), sd = mus.sd;
    if (now - engagedAt < 20 || s.mute || !(s.music > 0)) return;
    engagedAt = now;
    let t = seq.next;
    while (t - sd > now + 0.04) t -= sd;
    stats.musicNodes += drums(mus, 'tone', heavyOf(mus.V), [{ t: t, v: 1, ch: 'X' }, { t: t + 2 * sd, v: 0.7, ch: 'x' }, { t: t + 3 * sd, v: 1, ch: 'X' }], 0.7)
      + noiseHits(ac, kitBus(mus, 'tone').hat, [{ t: t + 3 * sd, v: 1, tc: 0.3 }], 0.14);
  }
  // A layer is scheduled while it is audible, fading, or "armed" (heat near its threshold) so it enters on the bar.
  function layersOn() {
    const playing = G() && G().state === 'playing';
    const hot = mus.batt.gain.value > 0.003 || tgt.batt > 0;
    return { calm: true, tens: mus.tens.gain.value > 0.003 || tgt.tens > 0 || (playing && heat > 0.4),
      batt: hot || (playing && heat > 5), hot: hot, tensR: mus.tensR.gain.value > 0.003 || tgt.batt < 1 };
  }
  function schedule() {
    const s = settings();
    if (!live() || !mus || s.mute || !(s.music > 0)) {
      if (ac && seq.next < ac.currentTime) seq.next = ac.currentTime + 0.05;
      return;
    }
    const now = ac.currentTime;
    if (seq.next < now - 0.03) seq.next = now + 0.03;      // stalled (hidden tab, long frame): resync, never burst
    while (seq.next < now + LOOKAHEAD) {
      try { stats.musicNodes += bar(mus, seq.bar, seq.next, layersOn(), null); }
      catch (e) { stats.errors = (stats.errors || 0) + 1; stats.lastError = String(e && e.message); }
      seq.bar++; seq.next += 16 * mus.sd;
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
  const SOLO = { menu: { calm: 1 }, calm: { calm: 1 }, tension: { tens: 1, tensR: 1 }, battle: { batt: 1 },
    mid: { calm: 1, tens: 1, tensR: 1 }, all: { calm: 1, tens: 1, batt: 1, hot: 1 } };
  // Render bars of the score into context c -> the chain (layer gains set as `layer` says). o: {hint, bars, bar, only, notes}
  function scoreInto(c, out, layer, o, t) {
    const menu = layer === 'menu', m = musicChain(c, out, voiceOf(menu ? null : o.hint), menu), on = SOLO[layer] || SOLO.all;
    m.calm.gain.value = on.calm ? 1 : 0; m.tens.gain.value = on.tens ? 1 : 0; m.batt.gain.value = on.batt ? 1 : 0; m.tensR.gain.value = on.tensR ? 1 : 0;
    m.only = o.only || null; m.made = 0; m.log = o.notes ? [] : null;
    for (let i = 0; i < (o.bars || 1); i++) m.made += bar(m, (o.bar || 0) + i, t + i * 16 * m.sd, on, m.log);
    return m;
  }
  // opts: {chain: true -> through the real sfx bus chain at full volume, p: recipe params, hint: MUSIC_HINTS (stingers), dur: buffer s}
  // music:<menu|calm|tension|battle|mid|all> takes {hint: MUSIC_HINTS, bars, bar: first bar, only: role, notes: true}
  A.preview = function (name, opts) {
    opts = opts || {};
    if (!OAC) return Promise.resolve({ name: name, error: 'no OfflineAudioContext' });
    const sr = 44100;
    if (name.indexOf('music:') === 0) {
      const layer = name.slice(6), V = voiceOf(layer === 'menu' ? null : opts.hint), bars = opts.bars || 1;
      const dur = 16 * bars * stepDur(layer === 'menu' ? MENU_BPM : V.bpm) + 1.5, c = new OAC(2, Math.ceil(sr * dur), sr);
      const m = scoreInto(c, c.destination, layer, opts, 0.05);
      return c.startRendering().then(function (b) {
        return Object.assign({ name: name, dur: +dur.toFixed(2), bars: bars, step: +m.sd.toFixed(4), nodes: m.made, notes: m.log }, measure(b));
      });
    }
    const f = FAM[name], rec = R[name];
    if (!rec) return Promise.resolve({ name: name, error: 'unknown sound' });
    const p = Object.assign({ r: 0.5, s: 0.6, d: 2 }, opts.p || {});
    if (opts.hint !== undefined) p.voice = voiceOf(opts.hint);
    const dur = opts.dur || 3.5, c = new OAC(2, Math.ceil(sr * dur), sr);
    let dest = c.destination;
    if (opts.chain) { const b = sfxChain(c, c.destination); b.sfx.gain.value = b.ui.gain.value = 1; dest = b[f.bus]; }
    const g = c.createGain(); g.gain.value = f.vol; g.connect(dest);
    const len = rec(c, g, 0.02, p);
    return c.startRendering().then(function (b) { return Object.assign({ name: name, len: +len.toFixed(2) }, measure(b)); });
  };
  A.PREVIEW_SET = ['rifle', 'mg', 'rocket', 'cannon', 'mortar', 'twang', 'boomS', 'boomL', 'melee', 'hiss', 'heal', 'placed', 'collapse',
    'surge', 'leap', 'deploy', 'brace', 'airraid', 'gates', 'cheer', 'sweep', 'tReady', 'tUnit', 'tFunds', 'tLowPow', 'tAlert', 'tIncoming',
    'tPowReady', 'tCapture', 'tLost', 'tGone', 'tSuper', 'error', 'victory', 'defeat',
    'music:calm', 'music:tension', 'music:battle', 'music:menu', 'music:all'];
  A.previewAll = function (opts) {
    const out = [];
    return A.PREVIEW_SET.reduce(function (pr, n) { return pr.then(function () { return A.preview(n, opts).then(function (r) { out.push(r); }); }); }, Promise.resolve())
      .then(function () { return out; });
  };
  // The whole mix offline: the score plus timed sounds through the real chain, sliders at o.sfx / o.music (default: both at max).
  // o: {layer ('none' = no score), hint, bars, bar, events: [{name, at, p, mute}], voices: n loud voices at voicesAt (0.5 s)}; ui sounds duck the score.
  A.mixdown = function (o) {
    o = o || {};
    if (!OAC) return Promise.resolve(null);
    const sr = 44100, V = voiceOf(o.hint), dur = 16 * (o.bars || 4) * stepDur(V.bpm) + 1.5;
    const c = new OAC(2, Math.ceil(sr * dur), sr), b = sfxChain(c, c.destination);
    b.sfx.gain.value = b.ui.gain.value = curve(o.sfx === undefined ? 1 : o.sfx); b.music.gain.value = curve(o.music === undefined ? 1 : o.music);
    if (o.layer !== 'none') scoreInto(c, b.duck, o.layer || 'all', o, 0.05);
    const ev = (o.events || []).slice(), pool = ['rifle', 'mg', 'cannon', 'rocket', 'boomL', 'boomM', 'wreck', 'melee'];
    for (let i = 0; i < (o.voices || 0); i++) ev.push({ name: pool[i % pool.length], at: (o.voicesAt || 0.5) + (i % 4) * 0.004, p: { s: 1 } });
    for (const e of ev) {
      const f = FAM[e.name], g = c.createGain();
      g.gain.value = e.mute ? 0 : f.vol; g.connect(b[f.bus]);
      const d = R[e.name](c, g, e.at, Object.assign({ r: 0.5, s: 0.6, d: 2, voice: V }, e.p || {}));
      if (f.duck) duckCurve(b.duck.gain, e.at, 1, f.duck, d);
    }
    return c.startRendering().then(function (buf) { return Object.assign({ dur: +dur.toFixed(2) }, measure(buf)); });
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
      const g = G(), w = g.world, me = g.player ? g.player() : null;
      let hint = me && me.faction ? me.faction.music : null;   // spectators hear the winner's voice
      if (!me && w && r) for (const pl of w.players) if (pl.team === r.winner && pl.faction) { hint = pl.faction.music; break; }
      ui(r && (r.won || r.me < 0) ? 'victory' : 'defeat', { voice: voiceOf(hint) });
    });
  };

  // There is no sim event for the brace trait: watch the local player's units and click once when a line digs in.
  const braced = new Set();
  function pollBrace() {
    const g = G(), w = g && g.world;
    if (!w || g.me < 0 || g.state !== 'playing') { braced.clear(); return; }
    let fresh = null, n = 0;
    for (const e of w.ents) {
      if (e.owner !== g.me || !e.braced) continue;
      n++;
      if (!braced.has(e.id)) { braced.add(e.id); if (!fresh || !heard(fresh.x, fresh.y)) fresh = e; }
    }
    if (n < braced.size) for (const id of Array.from(braced)) { const e = w.byId.get(id); if (!e || !e.braced) braced.delete(id); }
    if (fresh) atWorld('brace', fresh.x, fresh.y);
  }

  let statT = 0;
  A.frame = function (dt) {
    stats.state = ac ? ac.state : 'none';
    if (!ac) return;
    if (wantRunning && ac.state === 'suspended' && !document.hidden) { try { ac.resume(); } catch (e) { /* retry next frame */ } }
    heat *= Math.exp(-(dt || 0) / 6);
    const g = G();
    const inGame = !!(g && g.world && g.state !== 'menu'), me = inGame && g.player ? g.player() : null;
    setScore(!inGame, me && me.faction ? me.faction.music : null);
    if (live() && mus) { mixLayers(); schedule(); }
    statT += dt || 0;
    if (statT < 0.1) return;
    statT = 0;
    prune(ac.currentTime);
    if (live()) pollBrace();
    const s = stats;
    s.time = +ac.currentTime.toFixed(3); s.voices = voices.length;
    s.gains = { master: bus.master.gain.value, masterTarget: bus.master.gain._target, sfx: bus.sfx.gain.value, sfxTarget: bus.sfx.gain._target,
      ui: bus.ui.gain.value, music: bus.music.gain.value, musicTarget: bus.music.gain._target, compReduction: +bus.comp.reduction.toFixed(2) };
    if (!mus) return;
    const V = mus.V;
    s.music = { mood: mus.menu ? 'menu' : 'game', heat: +heat.toFixed(2), calm: +mus.calm.gain.value.toFixed(3), tension: +mus.tens.gain.value.toFixed(3),
      battle: +mus.batt.gain.value.toFixed(3), target: [tgt.calm, tgt.tens, tgt.batt], bar: seq.bar, mix: +mus.mix.gain.value.toFixed(3),
      duck: +bus.duck.gain.value.toFixed(3), bpm: mus.menu ? MENU_BPM : V.bpm, key: V.key, lead: V.voices.lead, air: V.voices.air };
  };
})();
