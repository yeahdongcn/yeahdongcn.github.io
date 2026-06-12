'use strict';
// ============ Procedural WebAudio: SFX + synthwave loop ============
const SFX = {
  ctx: null, master: null, sfxBus: null, musBus: null, delay: null,
  noiseBuf: null, engineOsc: null, engineGain: null, engineLp: null,
  muted: false, inited: false,
  stationIdx: 0, stations: null, // radio (assigned below)

  init() {
    if (this.inited) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      const c = this.ctx;
      this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.6;
      this.master.connect(c.destination);
      this.sfxBus = c.createGain(); this.sfxBus.gain.value = 0.9; this.sfxBus.connect(this.master);
      this.musBus = c.createGain(); this.musBus.gain.value = 0.34; this.musBus.connect(this.master);
      // echo bus for arps
      this.delay = c.createDelay(0.6); this.delay.delayTime.value = 0.29;
      const fb = c.createGain(); fb.gain.value = 0.32;
      this.delay.connect(fb); fb.connect(this.delay); this.delay.connect(this.musBus);
      // shared noise buffer
      const len = c.sampleRate | 0;
      this.noiseBuf = c.createBuffer(1, len, c.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      // engine drone (driving)
      this.engineOsc = c.createOscillator(); this.engineOsc.type = 'sawtooth'; this.engineOsc.frequency.value = 50;
      this.engineLp = c.createBiquadFilter(); this.engineLp.type = 'lowpass'; this.engineLp.frequency.value = 420;
      this.engineGain = c.createGain(); this.engineGain.gain.value = 0;
      this.engineOsc.connect(this.engineLp); this.engineLp.connect(this.engineGain); this.engineGain.connect(this.sfxBus);
      this.engineOsc.start();
      this._startMusic();
      this.inited = true;
    } catch (e) { /* no audio available */ }
  },

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.6;
    try { localStorage.setItem('ncpx_mute', this.muted ? '1' : '0'); } catch (e) {}
    return this.muted;
  },

  // ---- radio API ----
  stationName() { return this.stationIdx < 0 ? 'OFF' : this.stations[this.stationIdx].name; },
  setStation(i) {
    this.stationIdx = i;
    try { localStorage.setItem('ncpx_radio', String(i)); } catch (e) {}
  },
  cycleStation() {
    this.setStation(this.stationIdx + 1 >= this.stations.length ? -1 : this.stationIdx + 1);
    return this.stationName();
  },

  // ---- voice helpers ----
  tone(o) { // {type,f0,f1,t,dur,vol,lp}
    if (!this.ctx) return;
    const c = this.ctx, t = o.t || c.currentTime;
    const osc = c.createOscillator(); osc.type = o.type || 'square';
    osc.frequency.setValueAtTime(o.f0, t);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + o.dur);
    const g = c.createGain();
    g.gain.setValueAtTime(o.vol || 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + o.dur);
    let node = osc;
    if (o.lp) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; node.connect(f); node = f; }
    node.connect(g); g.connect(o.bus || this.sfxBus);
    osc.start(t); osc.stop(t + o.dur + 0.02);
  },

  noise(o) { // {t,dur,vol,type,f0,f1,q}
    if (!this.ctx) return;
    const c = this.ctx, t = o.t || c.currentTime;
    const src = c.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.f0 || 1000, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(Math.max(20, o.f1), t + o.dur);
    f.Q.value = o.q || 0.9;
    const g = c.createGain();
    g.gain.setValueAtTime(o.vol || 0.2, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + o.dur);
    src.connect(f); f.connect(g); g.connect(o.bus || this.sfxBus);
    src.start(t); src.stop(t + o.dur + 0.02);
  },

  // ---- game sfx ----
  shoot(cls) {
    if (!this.ctx) return;
    switch (cls) {
      case 'shotgun':
        this.noise({ dur: 0.22, vol: 0.5, type: 'lowpass', f0: 900, f1: 200 });
        this.tone({ type: 'sine', f0: 110, f1: 40, dur: 0.18, vol: 0.4 }); break;
      case 'sniper':
        this.noise({ dur: 0.3, vol: 0.4, f0: 2200, f1: 300 });
        this.tone({ type: 'square', f0: 1400, f1: 160, dur: 0.16, vol: 0.18 }); break;
      case 'launcher':
        this.tone({ type: 'sine', f0: 140, f1: 50, dur: 0.3, vol: 0.5 });
        this.noise({ dur: 0.2, vol: 0.3, type: 'lowpass', f0: 600, f1: 100 }); break;
      case 'smg': case 'lmg':
        this.noise({ dur: 0.06, vol: 0.22, f0: 1600, f1: 700 });
        this.tone({ type: 'square', f0: 500, f1: 140, dur: 0.05, vol: 0.12 }); break;
      case 'blade': case 'mantis': case 'wire':
        this.noise({ dur: 0.12, vol: 0.18, f0: 700, f1: 2400 }); break;
      case 'blunt': case 'gorilla':
        this.noise({ dur: 0.1, vol: 0.2, type: 'lowpass', f0: 500, f1: 150 }); break;
      default: // pistol/revolver/rifle
        this.noise({ dur: 0.09, vol: 0.3, f0: 1300, f1: 400 });
        this.tone({ type: 'square', f0: 240, f1: 80, dur: 0.07, vol: 0.16 });
    }
  },
  hit()      { this.noise({ dur: 0.05, vol: 0.16, f0: 900, f1: 300 }); },
  crit()     { this.tone({ type: 'square', f0: 880, f1: 220, dur: 0.08, vol: 0.14 }); },
  hurt()     { this.tone({ type: 'square', f0: 130, f1: 60, dur: 0.16, vol: 0.3 }); this.noise({ dur: 0.1, vol: 0.2, type: 'lowpass', f0: 500 }); },
  squish()   { this.tone({ type: 'sine', f0: 160, f1: 40, dur: 0.18, vol: 0.45 }); this.noise({ dur: 0.16, vol: 0.3, type: 'lowpass', f0: 700, f1: 120 }); this.noise({ dur: 0.07, vol: 0.18, f0: 2400, f1: 600 }); },
  kill()     { this.tone({ type: 'square', f0: 320, f1: 50, dur: 0.18, vol: 0.2 }); },
  coin()     { this.tone({ type: 'square', f0: 1320, dur: 0.05, vol: 0.1 }); this.tone({ type: 'square', f0: 1760, t: this.ctx ? this.ctx.currentTime + 0.06 : 0, dur: 0.09, vol: 0.1 }); },
  buy()      { [660, 880, 1320].forEach((f, i) => this.tone({ type: 'square', f0: f, t: this.ctx ? this.ctx.currentTime + i * 0.07 : 0, dur: 0.08, vol: 0.12 })); },
  deny()     { this.tone({ type: 'square', f0: 110, dur: 0.18, vol: 0.2 }); },
  ui()       { this.tone({ type: 'square', f0: 700, dur: 0.03, vol: 0.06 }); },
  reload()   { this.noise({ dur: 0.04, vol: 0.18, f0: 2500 }); this.noise({ t: this.ctx ? this.ctx.currentTime + 0.13 : 0, dur: 0.05, vol: 0.2, f0: 1800 }); },
  dash()     { this.noise({ dur: 0.16, vol: 0.14, type: 'highpass', f0: 900, f1: 3000 }); },
  spot()     { this.tone({ type: 'square', f0: 520, f1: 1040, dur: 0.12, vol: 0.12 }); },
  drink()    { this.tone({ type: 'square', f0: 300, f1: 700, dur: 0.18, vol: 0.12 }); },
  heal()     { [520, 660, 780].forEach((f, i) => this.tone({ type: 'sine', f0: f, t: this.ctx ? this.ctx.currentTime + i * 0.06 : 0, dur: 0.12, vol: 0.1 })); },
  levelup()  { [440, 554, 659, 880].forEach((f, i) => this.tone({ type: 'square', f0: f, t: this.ctx ? this.ctx.currentTime + i * 0.09 : 0, dur: 0.14, vol: 0.14 })); },
  install()  { this.noise({ dur: 0.12, vol: 0.25, type: 'lowpass', f0: 400, f1: 120 }); this.tone({ type: 'square', f0: 220, f1: 880, t: this.ctx ? this.ctx.currentTime + 0.12 : 0, dur: 0.2, vol: 0.12 }); },
  sande(on)  { this.tone({ type: 'sawtooth', f0: on ? 200 : 1800, f1: on ? 1800 : 200, dur: 0.4, vol: 0.16, lp: 2400 }); },
  camo()     { this.tone({ type: 'sine', f0: 1200, f1: 300, dur: 0.3, vol: 0.12 }); },
  psycho()   { this.tone({ type: 'sawtooth', f0: 80, f1: 55, dur: 1.2, vol: 0.3, lp: 300 }); this.tone({ type: 'sawtooth', f0: 85, f1: 57, dur: 1.2, vol: 0.3, lp: 300 }); },
  thunder()  { this.noise({ dur: 1.6, vol: 0.3, type: 'lowpass', f0: 400, f1: 60 }); },
  explode()  { this.noise({ dur: 0.8, vol: 0.5, type: 'lowpass', f0: 900, f1: 60 }); this.tone({ type: 'sine', f0: 90, f1: 30, dur: 0.6, vol: 0.5 }); },
  msg()      { this.tone({ type: 'square', f0: 880, dur: 0.04, vol: 0.05 }); },

  engine(on, spd) { // spd 0..1
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engineGain.gain.linearRampToValueAtTime(on ? 0.05 + 0.05 * spd : 0, t + 0.1);
    this.engineOsc.frequency.linearRampToValueAtTime(45 + spd * 120 + Math.sin(t * 7) * 4, t + 0.08);
  },

  // ---- radio: station-driven 64-step MIDI-style sequencer ----
  _startMusic() {
    const c = this.ctx;
    const hz = m => 440 * Math.pow(2, (m - 69) / 12);
    let step = 0, next = c.currentTime + 0.1;
    const sched = () => {
      if (!this.ctx) return;
      while (next < c.currentTime + 0.15) {
        const st = this.stationIdx >= 0 ? this.stations[this.stationIdx] : null;
        const STEP = 60 / (st ? st.bpm : 100) / 4; // 16th notes
        if (st) {
          const bar = (step >> 4) % 4, s16 = step % 16, root = st.roots[bar];
          // drums
          if (st.kick.includes(s16)) this.tone({ type: 'sine', f0: 120, f1: 38, t: next, dur: 0.18, vol: 0.5, bus: this.musBus });
          if (st.snare.includes(s16)) this.noise({ t: next, dur: 0.12, vol: 0.15, f0: 1100, q: 0.6, bus: this.musBus });
          if (step % st.hat === 0) this.noise({ t: next, dur: 0.03, vol: s16 % 4 === 2 ? 0.055 : 0.03, type: 'highpass', f0: 6500, bus: this.musBus });
          // bass styles
          const oct = (s16 === 6 || s16 === 14) ? 12 : 0;
          if (st.bass === 'roll' && step % 2 === 0)
            this.tone({ type: st.wv.bass, f0: hz(root + oct), t: next, dur: 0.22, vol: 0.2, lp: 320, bus: this.musBus });
          else if (st.bass === 'half' && (s16 === 0 || s16 === 10))
            this.tone({ type: st.wv.bass, f0: hz(root), t: next, dur: 0.5, vol: 0.24, lp: 260, bus: this.musBus });
          else if (st.bass === 'funk' && [0, 3, 6, 10, 12, 14].includes(s16))
            this.tone({ type: st.wv.bass, f0: hz(root + oct), t: next, dur: 0.14, vol: 0.2, lp: 380, bus: this.musBus });
          else if (st.bass === 'pump')
            this.tone({ type: st.wv.bass, f0: hz(root), t: next, dur: 0.1, vol: step % 2 ? 0.1 : 0.22, lp: 340, bus: this.musBus });
          // arp w/ echo
          if (st.arp && step % 2 === 1) {
            const g = c.createGain(); g.gain.value = 1; g.connect(this.delay);
            this.tone({ type: st.wv.arp, f0: hz(root + 12 + st.arp[(step >> 1) % st.arp.length]), t: next, dur: 0.09, vol: 0.045, bus: g });
          }
          // lead melody (dry voice + echo send)
          if (st.lead) {
            const n = st.lead[step % 64];
            if (n != null) {
              this.tone({ type: st.wv.lead, f0: hz(root + 24 + n), t: next, dur: STEP * 1.8, vol: 0.07, bus: this.musBus });
              const g = c.createGain(); g.gain.value = 0.5; g.connect(this.delay);
              this.tone({ type: st.wv.lead, f0: hz(root + 24 + n), t: next, dur: 0.09, vol: 0.05, bus: g });
            }
          }
          // pad at bar start
          if (st.pad && s16 === 0) {
            for (const iv of st.pad) {
              this.tone({ type: st.wv.pad, f0: hz(root + 24 + iv), t: next, dur: STEP * 15, vol: 0.022, lp: 900, bus: this.musBus });
              this.tone({ type: st.wv.pad, f0: hz(root + 24 + iv) * 1.005, t: next, dur: STEP * 15, vol: 0.022, lp: 900, bus: this.musBus });
            }
          }
        }
        next += STEP; step = (step + 1) % 64;
      }
    };
    setInterval(sched, 40);
  },
};

// melody helper: sparse [step, semitoneOffset] pairs → 64-step lane
function _mel(pairs) {
  const a = new Array(64).fill(null);
  for (const [s, n] of pairs) a[s] = n;
  return a;
}

// Five stations + OFF. Offsets are semitones above each bar's root (kept inside
// the scale/pentatonic of the track so bar changes re-harmonize the lead).
const RADIO_STATIONS = [
  { name: 'RITUAL FM', bpm: 96, roots: [33, 33, 29, 31], kick: [0, 10], snare: [8], hat: 2, bass: 'roll',
    arp: [12, 15, 19, 24, 19, 15], pad: [0, 3, 7], wv: { bass: 'sawtooth', arp: 'square', lead: 'square', pad: 'sawtooth' },
    lead: _mel([[0, 12], [4, 15], [6, 17], [8, 19], [12, 17], [16, 24], [20, 22], [24, 19], [28, 15], [32, 12], [38, 15], [40, 17], [44, 19], [48, 22], [52, 19], [56, 17], [58, 15], [60, 12]]) },
  { name: 'NIGHT FM', bpm: 78, roots: [36, 36, 32, 34], kick: [0], snare: [8], hat: 4, bass: 'half',
    arp: null, pad: [0, 3, 7], wv: { bass: 'triangle', arp: 'triangle', lead: 'triangle', pad: 'sawtooth' },
    lead: _mel([[0, 19], [8, 15], [14, 12], [16, 17], [24, 15], [32, 12], [40, 15], [44, 17], [48, 10], [56, 12]]) },
  { name: 'BODY HEAT RADIO', bpm: 118, roots: [29, 29, 34, 36], kick: [0, 4, 8, 12], snare: [4, 12], hat: 1, bass: 'funk',
    arp: [12, 16, 19, 24, 19, 16], pad: null, wv: { bass: 'square', arp: 'square', lead: 'square', pad: 'sawtooth' },
    lead: _mel([[0, 16], [2, 16], [6, 19], [10, 21], [16, 16], [22, 14], [28, 12], [32, 16], [34, 16], [38, 19], [42, 21], [44, 24], [48, 21], [52, 19], [54, 16], [60, 14]]) },
  { name: 'PACIFIC DREAMS', bpm: 100, roots: [31, 31, 36, 38], kick: [0, 10], snare: [8], hat: 2, bass: 'roll',
    arp: [12, 15, 19, 22, 19, 15], pad: [0, 3, 7, 10], wv: { bass: 'triangle', arp: 'triangle', lead: 'triangle', pad: 'sawtooth' },
    lead: _mel([[0, 15], [6, 17], [8, 19], [16, 22], [22, 19], [24, 17], [32, 15], [40, 14], [44, 12], [48, 15], [56, 19]]) },
  { name: 'SAMIZDAT RADIO', bpm: 132, roots: [28, 28, 26, 28], kick: [0, 4, 8, 12], snare: [4, 12], hat: 1, bass: 'pump',
    arp: [12, 13, 19, 24], pad: null, wv: { bass: 'sawtooth', arp: 'sawtooth', lead: 'square', pad: 'sawtooth' },
    lead: _mel([[0, 12], [3, 13], [6, 12], [8, 15], [11, 13], [14, 12], [16, 19], [19, 17], [22, 15], [24, 13], [28, 12], [32, 12], [35, 13], [38, 12], [40, 15], [44, 19], [48, 13], [52, 12], [56, 24], [60, 19]]) },
];
SFX.stations = RADIO_STATIONS;
try { SFX.muted = localStorage.getItem('ncpx_mute') === '1'; } catch (e) {}
try {
  const r = parseInt(localStorage.getItem('ncpx_radio'), 10);
  if (!isNaN(r)) SFX.stationIdx = Math.max(-1, Math.min(RADIO_STATIONS.length - 1, r));
} catch (e) {}
