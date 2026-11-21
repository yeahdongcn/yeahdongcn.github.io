'use strict';
// ============================================================================
// NEON TURF — fx.js : particles, projectile looks, decals, order markers  (presentation; Canvas 2D)
//
//   NT.FX.marker(wx, wy, kind)      order feedback: 'move' | 'attack' | 'amove' | 'rally' | 'harvest' | 'capture' | 'deny'
//   NT.FX.text(wx, wy, str, col)    a floating label (income, refunds)
//   NT.FX.explode(wx, wy, radiusPx, warhead)      the stock explosion, for anyone who needs one
//   NT.FX.count()                   live particles
// Called by render.js, in frame order:
//   NT.FX.frame(dt, simNow)                         advance (sim clock: frozen while paused, faster at speed 2)
//   NT.FX.drawDecals(ctx, view)                     scorch, craters, stains, wreck marks on the ground
//   NT.FX.drawWorld(ctx, view, world)               projectiles + smoke / dust / debris / droplets
//   NT.FX.drawGlow(ctx, view, world)                ADDITIVE: tracers, fire, sparks, flashes, shock rings, beams
//   NT.FX.drawOverlay(ctx, view, uk)                strike warnings, order markers, floating text (above the fog)
//   NT.FX.burning(x, y, bounds, hpFrac, seed)       a damaged structure that should smoke this frame
//   NT.FX.smolder(x, y)                             a burning unit
//
// Everything is driven by simulation events (sim:fire, sim:impact, sim:death, ...) and looks are chosen from
// GENERIC weapon data only: `proj`, `warhead`, `splash`, plus the free-form `fx` hint (unknown hints fall back to
// the look of the `proj`). No faction / unit / building id appears here.
//
// GOTCHAS
//   - Ages run on the SIM clock, so a paused frame shows its effects frozen and a boot-time fast-forward leaves
//     only what is still alive. Order markers are interface feedback and use the wall clock.
//   - Nothing is emitted where the local viewer cannot see (NT.Render.visibleAt) or far off screen.
//   - Particles are pooled and capped (MAXP); when the pool is full new ones are dropped, never allocated.
// ============================================================================
(function () {
  const TILE = NT.TILE, TAU = Math.PI * 2, DT = NT.DT;
  const FX = NT.FX = {};
  const MAXP = 700, MAXD = 150;
  const PUFF = 0, GLOW = 1, SPARK = 2, DEBRIS = 3, RING = 4, LINE = 5, BEAM = 6, ARC = 7;
  const GLINT = '#c4f6ee', GOLD = '#ffd95a', HOT = '#ffd9a0', FIRE = '#ff9a3c', EMBER = '#ff5a2a';
  const SMOKE = '#1b1e27', ASH = '#5d6472', DUST = '#7d7667', WATER = '#bfe9ff', WHITE = '#ffffff';
  const TINT = { water: '#9fe4ff', acid: '#a6ff5a', heal: '#7dffb0', fire: FIRE, shock: '#9fe4ff' };
  const WARHEAD_COL = { small: '#ffe9a8', ap: '#ffd27a', he: '#ffb45a', fire: FIRE, melee: '#f4f6ff', smash: '#f4f6ff', shock: '#9fe4ff' };
  const FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

  const P = [], pool = [];                 // live particles / free list
  const decals = [];                       // ring buffer
  let decalI = 0;
  const markers = [], texts = [], warns = [], timers = [];
  const pdata = new WeakMap();             // projectile -> render-side extras (muzzle offset, trail)
  const styles = new WeakMap();            // weapon def -> projectile look
  let now = 0, dtS = 0, frameTick = -99, sweepTick = -1;

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function world() { return NT.Game && NT.Game.world; }
  function simT() { const w = world(); return w ? w.tick * DT : 0; }
  function see(x, y, margin) {
    const R = NT.Render;
    return !R || !R.visibleAt || (R.visibleAt(x, y) && R.onScreen(x, y, margin === undefined ? 160 : margin));
  }
  function live() { const w = world(); return !!w && w.tick - frameTick <= 3; }      // frames are being drawn right now
  function shake(a) { if (live() && NT.Render && NT.Render.shake) NT.Render.shake(a); }
  function teamCol(owner) { const w = world(), p = w && w.players[owner]; return p ? p.color : '#8d97ad'; }

  // --------------------------------------------------------------------------
  // Sprites (baked once per colour)
  // --------------------------------------------------------------------------
  const sprites = new Map();
  function rgb(c) { const n = parseInt(c.slice(1, 7), 16); return (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255); }
  function dot(col) {
    let c = sprites.get(col);
    if (c) return c;
    c = mk(48, 48);
    const x = c.getContext('2d'), g = x.createRadialGradient(24, 24, 0, 24, 24, 24), v = rgb(col);
    g.addColorStop(0, 'rgba(' + v + ',1)'); g.addColorStop(0.28, 'rgba(' + v + ',0.62)');
    g.addColorStop(0.62, 'rgba(' + v + ',0.17)'); g.addColorStop(1, 'rgba(' + v + ',0)');
    x.fillStyle = g; x.fillRect(0, 0, 48, 48);
    sprites.set(col, c);
    return c;
  }
  function puff(col, variant) {
    const key = col + '|' + variant;
    let c = sprites.get(key);
    if (c) return c;
    c = mk(64, 64);
    const x = c.getContext('2d'), v = rgb(col), r = new NT.Rng(977 + variant * 131);
    for (let i = 0; i < 7; i++) {
      const a = r.next() * TAU, d = i ? 6 + r.next() * 9 : 0, cx = 32 + Math.cos(a) * d, cy = 32 + Math.sin(a) * d, rad = 11 + r.next() * 6;
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, 'rgba(' + v + ',0.5)'); g.addColorStop(0.6, 'rgba(' + v + ',0.24)'); g.addColorStop(1, 'rgba(' + v + ',0)');
      x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    }
    sprites.set(key, c);
    return c;
  }
  function anyPuff(col) { return puff(col, (Math.random() * 3) | 0); }
  // ground marks: 0-3 scorch, 4-5 soft stain, 6-7 wet patch
  function decalSprite(kind) {
    const key = 'decal' + kind;
    let c = sprites.get(key);
    if (c) return c;
    c = mk(96, 96);
    const x = c.getContext('2d'), r = new NT.Rng(4242 + kind * 77);
    const blob = function (cx, cy, rad, col, a) {
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
      g.addColorStop(0, 'rgba(' + col + ',' + a + ')'); g.addColorStop(0.55, 'rgba(' + col + ',' + a * 0.6 + ')'); g.addColorStop(1, 'rgba(' + col + ',0)');
      x.fillStyle = g; x.fillRect(cx - rad, cy - rad, 2 * rad, 2 * rad);
    };
    if (kind < 4) {
      blob(48, 48, 34, '5,5,8', 0.62);
      for (let i = 0; i < 9; i++) { const a = r.next() * TAU, d = 12 + r.next() * 20; blob(48 + Math.cos(a) * d, 48 + Math.sin(a) * d, 7 + r.next() * 10, '5,5,8', 0.4); }
      blob(48 + r.next() * 8 - 4, 48 + r.next() * 8 - 4, 13, '58,40,30', 0.3);       // baked, faintly warm centre
      x.strokeStyle = 'rgba(4,4,6,0.3)'; x.lineWidth = 1.6; x.lineCap = 'round';
      for (let i = 0; i < 7; i++) {                        // short blast streaks
        const a = r.next() * TAU, d0 = 18 + r.next() * 8, d1 = d0 + 5 + r.next() * 9;
        x.beginPath(); x.moveTo(48 + Math.cos(a) * d0, 48 + Math.sin(a) * d0); x.lineTo(48 + Math.cos(a) * d1, 48 + Math.sin(a) * d1); x.stroke();
      }
      for (let i = 0; i < 16; i++) {                       // ash flecks
        const a = r.next() * TAU, d = r.next() * 30;
        x.fillStyle = 'rgba(130,132,140,' + (0.1 + r.next() * 0.2) + ')';
        x.fillRect(48 + Math.cos(a) * d, 48 + Math.sin(a) * d, 1 + r.next() * 1.6, 1 + r.next() * 1.6);
      }
    } else if (kind < 6) {
      blob(48, 48, 30, '6,6,10', 0.6);
      for (let i = 0; i < 5; i++) { const a = r.next() * TAU, d = 12 + r.next() * 16; blob(48 + Math.cos(a) * d, 48 + Math.sin(a) * d, 6 + r.next() * 8, '6,6,10', 0.45); }
    } else {
      blob(48, 48, 38, '4,8,16', 0.5);
      for (let i = 0; i < 6; i++) { const a = r.next() * TAU, d = 14 + r.next() * 18; blob(48 + Math.cos(a) * d, 48 + Math.sin(a) * d, 8 + r.next() * 9, '4,8,16', 0.42); }
      x.strokeStyle = 'rgba(150,200,255,0.16)'; x.lineWidth = 1;
      x.beginPath(); x.ellipse(44, 44, 20, 13, 0.5, 3.4, 5.2); x.stroke();
    }
    sprites.set(key, c);
    return c;
  }

  // --------------------------------------------------------------------------
  // Pool
  // --------------------------------------------------------------------------
  function blank() {
    return { kind: 0, layer: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, x2: 0, y2: 0, r0: 0, r1: 0, a: 1, w: 1, rot: 0,
      drag: 0, col: WHITE, spr: null, born: 0, life: 1 };
  }
  function sweep() {
    const t = simT();
    let j = 0;
    for (let i = 0; i < P.length; i++) { const p = P[i]; if (t - p.born < p.life) P[j++] = p; else pool.push(p); }
    P.length = j;
  }
  function alloc(kind, layer, x, y, life) {
    if (P.length >= MAXP) {
      const w = world(), tick = w ? w.tick : 0;
      if (tick !== sweepTick) { sweepTick = tick; sweep(); }
      if (P.length >= MAXP) return null;
    }
    const p = pool.pop() || blank();
    p.kind = kind; p.layer = layer; p.x = x; p.y = y; p.z = 0; p.vx = p.vy = p.vz = 0; p.drag = 0; p.rot = 0; p.a = 1; p.w = 1;
    p.born = simT(); p.life = life; p.spr = null;
    P.push(p);
    return p;
  }
  function load() { return P.length > 520 ? 0.4 : P.length > 360 ? 0.7 : 1; }       // thin the big effects out under pressure
  FX.count = function () { return P.length; };

  // --- emitters ----------------------------------------------------------------
  function smoke(x, y, r0, r1, life, a, col, vx, vy) {
    const p = alloc(PUFF, 0, x, y, life);
    if (!p) return;
    p.spr = anyPuff(col || SMOKE); p.r0 = r0; p.r1 = r1; p.a = a;
    p.vx = (vx || 0) + rnd(2, 9); p.vy = (vy || 0) - rnd(5, 14); p.drag = 1.2;
  }
  function glow(x, y, r0, r1, life, a, col, vx, vy) {
    const p = alloc(GLOW, 1, x, y, life);
    if (!p) return null;
    p.spr = dot(col); p.r0 = r0; p.r1 = r1; p.a = a; p.vx = vx || 0; p.vy = vy || 0; p.drag = 2.5;
    return p;
  }
  function sparks(x, y, n, speed, col, life, dir, spread) {
    for (let i = 0; i < n; i++) {
      const p = alloc(SPARK, 1, x, y, (life || 0.3) * rnd(0.6, 1.2));
      if (!p) return;
      const a = dir === undefined ? Math.random() * TAU : dir + (Math.random() - 0.5) * (spread || 1), v = speed * rnd(0.35, 1);
      p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v; p.drag = 4.5; p.col = col; p.w = rnd(0.8, 1.6);
    }
  }
  function debris(x, y, n, speed, col) {
    for (let i = 0; i < n; i++) {
      const p = alloc(DEBRIS, 0, x, y, rnd(0.7, 1.3));
      if (!p) return;
      const a = Math.random() * TAU, v = speed * rnd(0.3, 1);
      p.vx = Math.cos(a) * v; p.vy = Math.sin(a) * v; p.vz = rnd(60, 150); p.z = 2; p.drag = 1.2;
      p.col = col || '#3a3f4c'; p.w = rnd(1.4, 3.2); p.rot = Math.random() * TAU;
    }
  }
  function ring(x, y, r0, r1, life, col, a, lw, layer) {
    const p = alloc(RING, layer === undefined ? 1 : layer, x, y, life);
    if (!p) return;
    p.r0 = r0; p.r1 = r1; p.col = col; p.a = a; p.w = lw || 2;
  }
  function line(kind, x, y, x2, y2, life, col, w, a) {
    const p = alloc(kind, 1, x, y, life);
    if (!p) return;
    p.x2 = x2; p.y2 = y2; p.col = col; p.w = w; p.a = a === undefined ? 1 : a;
  }
  function decal(x, y, r, kind, a, life, col) {
    const d = decals[decalI] || (decals[decalI] = {});
    decalI = (decalI + 1) % MAXD;
    d.x = x; d.y = y; d.r = r; d.spr = decalSprite(kind); d.a = a; d.born = simT(); d.life = life || 90; d.col = col || null;
    d.seed = (Math.random() * 1e6) | 0;
  }
  function later(delay, fn) { if (timers.length < 80) timers.push({ at: simT() + delay, fn: fn }); }

  // --------------------------------------------------------------------------
  // Stock effects
  // --------------------------------------------------------------------------
  // s = blast radius in px (a splash of one cell = 32)
  function explode(x, y, s, warhead, quiet) {
    const q = load(), wet = warhead === 'shock', hot = warhead === 'fire', col = wet ? TINT.water : HOT;
    glow(x, y, s * 0.7, s * 2.3, 0.2, 0.85, col);
    glow(x, y, s * 0.3, s * 0.9, 0.1, 1, WHITE);
    ring(x, y, s * 0.25, s * 1.4, 0.22, col, 0.32, 1.6);
    if (wet) {
      for (let i = 0, n = Math.round(6 * q); i < n; i++) smoke(x + rnd(-s, s) * 0.4, y + rnd(-s, s) * 0.4, 2, s * 0.35, rnd(0.3, 0.6), 0.5, WATER, rnd(-30, 30), rnd(-30, 10));
      sparks(x, y, Math.round(8 * q), s * 5, TINT.water, 0.3);
      decal(x, y, s * 0.9, 6 + ((Math.random() * 2) | 0), 0.7, 40);
      return;
    }
    for (let i = 0, n = Math.round(NT.clamp(s / 6, 4, 10) * q); i < n; i++) {
      const a = Math.random() * TAU, d = Math.random() * s * 0.35, v = s * rnd(0.6, 2);
      glow(x + Math.cos(a) * d, y + Math.sin(a) * d, s * 0.2, s * rnd(0.4, 0.62), rnd(0.22, 0.42), 0.9, i & 1 ? FIRE : EMBER, Math.cos(a) * v, Math.sin(a) * v - 10);
    }
    for (let i = 0, n = Math.round(NT.clamp(s / 9, 3, 7) * q); i < n; i++) {
      smoke(x + rnd(-s, s) * 0.35, y + rnd(-s, s) * 0.3, s * 0.25, s * rnd(0.6, 0.95), rnd(0.9, 1.7), 0.55, i & 1 ? SMOKE : ASH, rnd(-14, 14), rnd(-10, 6));
    }
    sparks(x, y, Math.round(NT.clamp(s / 3.5, 5, 14) * q), s * 7, hot ? FIRE : '#ffe2a0', 0.38);
    if (!quiet) debris(x, y, Math.round(NT.clamp(s / 10, 2, 5) * q), s * 3.2);
    decal(x, y, s * rnd(0.85, 1.1), (Math.random() * 4) | 0, 0.75, 110);
    if (hot) for (let i = 0; i < 3; i++) later(rnd(0.15, 0.9), function () { glow(x + rnd(-s, s) * 0.5, y + rnd(-s, s) * 0.4, 3, s * 0.3, 0.45, 0.8, FIRE, 0, -18); });
    if (!quiet) shake(Math.min(7, s / 9));
  }
  FX.explode = function (x, y, radiusPx, warhead) { if (see(x, y)) explode(x, y, radiusPx || 24, warhead || 'he'); };

  function dustBurst(x, y, n, r) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      smoke(x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5, 2, rnd(5, 9), rnd(0.4, 0.8), 0.4, DUST, Math.cos(a) * 26, Math.sin(a) * 26 + 8);
    }
  }
  function sparkle(x, y, col, n) {
    for (let i = 0; i < n; i++) glow(x + rnd(-9, 9), y + rnd(-7, 7), 1.5, rnd(3, 5), rnd(0.35, 0.7), 0.95, col, rnd(-8, 8), rnd(-34, -14));
  }

  // --------------------------------------------------------------------------
  // Weapons: fire
  // --------------------------------------------------------------------------
  const MST = { facing: 0, aim: 0 }, MZ = [0, 0];
  function muzzleOf(e, wi) {
    if (!e || !NT.Art || !NT.Art.muzzle) { MZ[0] = MZ[1] = 0; return MZ; }
    MST.facing = e.facing; MST.aim = e.aim;
    const m = NT.Art.muzzle(e.def, MST, wi);
    MZ[0] = m[0]; MZ[1] = m[1];
    return MZ;
  }
  function stream(x, y, tx, ty, w) {                      // hoses, flamers, sprayers: particles that fly the whole way
    const fxk = w && w.fx, tint = TINT[fxk] || (w && w.warhead === 'shock' ? TINT.shock : null), dx = tx - x, dy = ty - y;
    const liquid = !!tint && fxk !== 'fire';
    for (let i = 0; i < 3; i++) {
      const life = rnd(0.2, 0.3), jx = rnd(-7, 7), jy = rnd(-7, 7), f = i / 3 * 0.25;
      if (liquid) {
        const p = alloc(PUFF, 0, x + dx * f, y + dy * f, life);
        if (!p) return;
        p.spr = anyPuff(fxk === 'water' || !fxk ? WATER : tint); p.r0 = 2; p.r1 = rnd(5, 8); p.a = 0.6;
        p.vx = (dx * (1 - f) + jx) / life; p.vy = (dy * (1 - f) + jy) / life; p.drag = 0;
        if (i === 0) { const g = glow(x + dx * f, y + dy * f, 3, 7, life, 0.3, tint, (dx + jx) / life, (dy + jy) / life); if (g) g.drag = 0; }
      } else {
        const g = glow(x + dx * f, y + dy * f, 3, rnd(8, 12), life, 0.85, i & 1 ? FIRE : '#ffcf6a', (dx * (1 - f) + jx) / life, (dy * (1 - f) + jy) / life);
        if (g) g.drag = 0;
      }
    }
  }
  NT.on('sim:fire', function (ev) {
    const wd = world();
    if (!wd || (!see(ev.x, ev.y) && !see(ev.tx, ev.ty))) return;
    const e = wd.byId.get(ev.id), w = e ? e.def.weapons[ev.wi] : null, fxk = w && w.fx;
    const mz = muzzleOf(e, ev.wi), x = ev.x + mz[0], y = ev.y + mz[1], ang = Math.atan2(ev.ty - y, ev.tx - x);
    if (w && w.heal) {
      line(BEAM, x, y, ev.tx, ev.ty, 0.3, TINT.heal, 3, 0.8);
      sparkle(ev.tx, ev.ty, TINT.heal, 2);
      return;
    }
    switch (ev.proj) {
      case 'instant':
        if (w && w.consume) return;                         // the shooter IS the shot: the impact tells the story
        line(LINE, x, y, ev.tx, ev.ty, 0.09, '#fff1b8', 1.3, 0.9);
        glow(x, y, 4, 9, 0.07, 0.8, '#ffd98a');
        break;
      case 'beam':
        line(BEAM, x, y, ev.tx, ev.ty, 0.2, TINT[fxk] || WARHEAD_COL[ev.warhead] || WHITE, 2.4, 0.9);
        break;
      case 'flame': stream(x, y, ev.tx, ev.ty, w || ev); break;
      case 'melee': {
        const d = Math.min(26, Math.max(10, NT.dist(ev.x, ev.y, ev.tx, ev.ty))), heavy = ev.warhead === 'smash';
        const p = alloc(ARC, 1, ev.x, ev.y, heavy ? 0.2 : 0.14);
        if (p) { p.r0 = d; p.rot = Math.atan2(ev.ty - ev.y, ev.tx - ev.x); p.w = heavy ? 4 : 2.4; p.col = WHITE; p.a = 0.85; p.x2 = Math.random() < 0.5 ? 1 : -1; }
        break;
      }
      case 'shell':
        glow(x, y, 8, 22, 0.12, 0.9, HOT);
        sparks(x, y, 4, 190, '#ffe2a0', 0.2, ang, 0.5);
        smoke(x + Math.cos(ang) * 5, y + Math.sin(ang) * 5, 3, 9, 0.7, 0.4, ASH, Math.cos(ang) * 22, Math.sin(ang) * 22);
        break;
      case 'rocket':
        glow(x, y, 5, 13, 0.12, 0.85, '#ffb45a');
        smoke(x - Math.cos(ang) * 6, y - Math.sin(ang) * 6, 3, 9, 0.6, 0.45, ASH, -Math.cos(ang) * 30, -Math.sin(ang) * 30);
        break;
      case 'lob':
        if (!fxk) { glow(x, y, 4, 11, 0.1, 0.7, '#ffb45a'); smoke(x, y, 2, 7, 0.5, 0.35, ASH); }
        break;
      default:
        if (!fxk) glow(x, y, 4, 9, 0.07, 0.75, '#ffd98a');
    }
  });

  // --------------------------------------------------------------------------
  // Weapons: impact
  // --------------------------------------------------------------------------
  NT.on('sim:impact', function (ev) {
    if (!see(ev.x, ev.y)) return;
    const x = ev.x, y = ev.y, s = ev.splash, col = WARHEAD_COL[ev.warhead] || '#ffe9a8';
    if (ev.proj === 'flame') {
      if (ev.warhead === 'shock') {
        ring(x, y, 3, Math.max(12, s * 0.6), 0.3, WATER, 0.3, 1.4, 0);
        for (let i = 0; i < 2; i++) smoke(x + rnd(-6, 6), y + rnd(-6, 6), 1.5, 5, 0.3, 0.5, WATER, rnd(-40, 40), rnd(-40, 20));
        if (Math.random() < 0.12) decal(x, y, rnd(14, 22), 6 + ((Math.random() * 2) | 0), 0.55, 30);
      } else {
        glow(x + rnd(-5, 5), y + rnd(-5, 5), 4, rnd(9, 14), 0.3, 0.8, FIRE, 0, -14);
        if (Math.random() < 0.4) smoke(x, y, 3, 9, 0.8, 0.35, SMOKE);
        if (Math.random() < 0.1) decal(x, y, rnd(12, 18), (Math.random() * 4) | 0, 0.5, 60);
      }
    } else if (ev.proj === 'beam') {
      glow(x, y, 3, 8, 0.15, 0.7, col);
    } else if (ev.proj === 'melee') {
      sparks(x, y, ev.warhead === 'smash' ? 5 : 3, 110, WHITE, 0.16);
      if (ev.warhead === 'smash') { dustBurst(x, y, 3, 8); shake(1.2); }
    } else if (s > 0) explode(x, y, s, ev.warhead);
    else if (ev.hit) {
      sparks(x, y, 3, 130, col, 0.2);
      glow(x, y, 2, 7, 0.09, 0.75, col);
    } else {
      smoke(x, y, 1.5, 5, 0.35, 0.4, DUST);
      sparks(x, y, 1, 90, col, 0.15);
    }
  });

  // --------------------------------------------------------------------------
  // Life and death
  // --------------------------------------------------------------------------
  function wreckage(x, y, r, col) { decal(x, y, r, (Math.random() * 4) | 0, 0.8, 140, col); }
  function collapse(ev) {
    const w = ev.w * TILE, h = ev.h * TILE, x = ev.x, y = ev.y, n = NT.clamp(Math.round(ev.w * ev.h * 0.7), 2, 6), col = teamCol(ev.owner);
    explode(x, y, Math.min(w, h) * 0.45, 'he');
    for (let i = 0; i < n; i++) {
      later(0.08 + i * 0.11 + Math.random() * 0.05, function () { explode(x + rnd(-w, w) * 0.4, y + rnd(-h, h) * 0.4 - 6, rnd(16, 26), 'he', i > 1); });
    }
    for (let i = 0, m = Math.round((ev.w + ev.h) * 2.5 * load()); i < m; i++) {
      const a = i / m * TAU;
      smoke(x + Math.cos(a) * w * 0.5, y + Math.sin(a) * h * 0.5, 5, rnd(12, 20), rnd(0.9, 1.6), 0.5, DUST, Math.cos(a) * 46, Math.sin(a) * 46 + 10);
    }
    ring(x, y, Math.min(w, h) * 0.3, Math.max(w, h) * 1.1, 0.45, HOT, 0.5, 3);
    debris(x, y, 6, 150, '#4a505e'); debris(x, y, 4, 130, col);
    wreckage(x, y, Math.max(w, h) * 0.62, col);
    for (let i = 0; i < 8; i++) later(0.5 + i * 0.3, function () { smoke(x + rnd(-w, w) * 0.3, y + rnd(-h, h) * 0.3, 6, rnd(14, 22), rnd(1.4, 2.2), 0.45, SMOKE); });
    shake(7);
  }
  NT.on('sim:death', function (ev) {
    if (!see(ev.x, ev.y)) return;
    const def = NT.DEFS[ev.def], x = ev.x, y = ev.y, col = teamCol(ev.owner);
    if (ev.kind === 'building') { collapse(ev); return; }
    if (!def) return;
    const r = def.radius || 8;
    if (def.layer === 'air') {
      explode(x, y, r * 1.5, 'he', true);
      debris(x, y, 4, 110, col);
      for (let i = 0; i < 3; i++) later(0.1 + i * 0.12, function () { smoke(x + rnd(-8, 8), y + rnd(-4, 10), 3, 10, 0.9, 0.4, SMOKE); });
    } else if (def.armor === 'infantry' || def.is.organic || def.is.beast) {
      dustBurst(x, y, 3, r);
      debris(x, y, 2, 60, col);
      sparks(x, y, 3, 80, col, 0.22);
      decal(x, y, r * 1.5, 4 + ((Math.random() * 2) | 0), 0.6, 70);
    } else {
      explode(x, y, r * 1.7, 'he', true);
      debris(x, y, 3, 120, '#4a505e'); debris(x, y, 3, 110, col);
      wreckage(x, y, r * 1.9, col);
      for (let i = 0; i < 5; i++) later(0.25 + i * 0.28, function () { smoke(x + rnd(-5, 5), y + rnd(-5, 5), 4, rnd(10, 15), rnd(1.1, 1.8), 0.45, SMOKE); });
      shake(def.armor === 'heavy' ? 4 : 2.5);
    }
  });

  NT.on('sim:produced', function (ev) {
    if (!world() || world().tick < 2 || !see(ev.x, ev.y)) return;
    ring(ev.x, ev.y, 4, 18, 0.35, teamCol(ev.owner), 0.6, 1.6);
    dustBurst(ev.x, ev.y, 2, 6);
  });
  NT.on('sim:placed', function (ev) {
    const wd = world(), e = wd && wd.byId.get(ev.id);
    if (!e || !see(e.x, e.y)) return;
    const w = e.w * TILE, h = e.h * TILE, n = Math.round((e.w + e.h) * 2.2);
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU, c = Math.cos(a), s = Math.sin(a), k = 0.5 / Math.max(Math.abs(c), Math.abs(s));
      smoke(e.x + c * w * k, e.y + s * h * k, 3, rnd(8, 13), rnd(0.5, 0.9), 0.45, DUST, c * 34, s * 34 + 10);
    }
    ring(e.x, e.y, Math.max(w, h) * 0.5, Math.max(w, h) * 0.95, 0.4, teamCol(ev.owner), 0.6, 2);
    shake(1.5);
  });
  NT.on('sim:sold', function (ev) {
    if (!see(ev.x, ev.y)) return;
    dustBurst(ev.x, ev.y, 8, 26);
    if (ev.refund > 0 && mine(ev.owner)) { FX.text(ev.x, ev.y - 8, '+' + Math.round(ev.refund), GLINT); sparkle(ev.x, ev.y, GLINT, 4); }
  });
  function mine(owner) { const G = NT.Game; return G.me < 0 || owner === G.me; }
  NT.on('sim:dump', function (ev) {
    if (!see(ev.x, ev.y) || !mine(ev.owner)) return;
    FX.text(ev.x, ev.y - 12, '+' + Math.round(ev.amount), GLINT);
    sparkle(ev.x, ev.y, GLINT, 5);
  });
  NT.on('sim:income', function (ev) {
    if (!see(ev.x, ev.y) || !mine(ev.owner)) return;
    FX.text(ev.x, ev.y - 14, '+' + Math.round(ev.amount), GLINT, 0.85);
    sparkle(ev.x, ev.y - 6, GLINT, 2);
  });
  NT.on('sim:captured', function (ev) {
    if (!see(ev.x, ev.y)) return;
    const col = teamCol(ev.to);
    ring(ev.x, ev.y, 10, 76, 0.6, col, 0.8, 3);
    later(0.15, function () { ring(ev.x, ev.y, 10, 60, 0.5, col, 0.6, 2); });
    sparks(ev.x, ev.y, 12, 210, col, 0.5);
    glow(ev.x, ev.y, 20, 60, 0.4, 0.5, col);
  });
  NT.on('sim:ability', function (ev) {
    const wd = world(), e = wd && wd.byId.get(ev.id), col = teamCol(ev.owner);
    if (!see(ev.x, ev.y)) return;
    if (ev.ability === 'leap') {
      // the leaper may already stand at its landing spot: streak from wherever it is not
      const ox = e ? (NT.dist(e.px, e.py, ev.x, ev.y) > NT.dist(e.x, e.y, ev.x, ev.y) ? e.px : e.x) : ev.x;
      const oy = e ? (NT.dist(e.px, e.py, ev.x, ev.y) > NT.dist(e.x, e.y, ev.x, ev.y) ? e.py : e.y) : ev.y;
      if (NT.dist(ox, oy, ev.x, ev.y) > 12) line(BEAM, ox, oy, ev.x, ev.y, 0.28, col, 4, 0.55);
      dustBurst(ev.x, ev.y, 5, 10); dustBurst(ox, oy, 3, 6);
      ring(ev.x, ev.y, 4, 22, 0.25, WHITE, 0.5, 1.6);
    } else {
      ring(ev.x, ev.y, 5, 28, 0.4, col, 0.85, 2.2);
      sparks(ev.x, ev.y - 4, 6, 120, col, 0.4, -Math.PI / 2, 1.1);
      glow(ev.x, ev.y, 8, 24, 0.3, 0.5, col);
    }
  });
  NT.on('sim:rank', function (ev) {
    const wd = world(), e = wd && wd.byId.get(ev.id);
    if (!e || !see(e.x, e.y)) return;
    ring(e.x, e.y, 4, 24, 0.5, GOLD, 0.9, 2);
    sparks(e.x, e.y - 4, 5, 110, GOLD, 0.45, -Math.PI / 2, 1.2);
    FX.text(e.x, e.y - 14, ev.rank > 1 ? '▲▲' : '▲', GOLD, 0.8);
  });
  NT.on('sim:hurt', function (ev) {
    const wd = world(), e = wd && wd.byId.get(ev.id);
    if (!e || e.kind !== 'building' || !see(ev.x, ev.y)) return;
    debris(ev.x + rnd(-e.w, e.w) * TILE * 0.3, ev.y + rnd(-e.h, e.h) * TILE * 0.3, 2, 70, '#4a505e');
  });
  // strike warnings and power flashes are alerts: the caster's side always sees them, everyone else only in sight
  function alertSeen(ev) {
    const G = NT.Game, wd = world(), p = wd && wd.players[ev.owner];
    return G.me < 0 || (p && p.team === G.team()) || !NT.Render || NT.Render.visibleAt(ev.x, ev.y);
  }
  NT.on('sim:strike_warn', function (ev) {
    if (!alertSeen(ev) || warns.length > 16) return;
    warns.push({ x: ev.x, y: ev.y, r: ev.radius || 48, t0: simT(), until: simT() + (ev.delay || 20) * DT, col: teamCol(ev.owner) });
  });
  NT.on('sim:power_used', function (ev) {
    if (!alertSeen(ev) || !see(ev.x, ev.y, 400)) return;
    const col = teamCol(ev.owner);
    ring(ev.x, ev.y, 8, 90, 0.6, col, 0.8, 3);
    later(0.12, function () { ring(ev.x, ev.y, 8, 120, 0.7, col, 0.5, 2); });
    glow(ev.x, ev.y, 20, 80, 0.45, 0.55, col);
  });

  FX.burning = function (x, y, b, hp, seed) {
    if (hp >= 0.5 || Math.random() > dtS * (hp < 0.25 ? 16 : 8)) return;
    const k = (Math.random() * 3) | 0, h = NT.hash32(seed, k);
    const fx = x + ((h & 255) / 255 - 0.5) * b.w * 0.6, fy = y + ((h >> 8 & 255) / 255 - 0.5) * b.h * 0.5 - b.up * 0.5;
    smoke(fx, fy - 4, 4, rnd(11, 17), rnd(1.1, 1.9), 0.5, SMOKE, 4, -8);
    if (hp < 0.33 || k === 0) glow(fx + rnd(-3, 3), fy, 3, rnd(7, 11), rnd(0.3, 0.5), 0.9, Math.random() < 0.5 ? FIRE : EMBER, 0, -22);
  };
  FX.smolder = function (x, y) {
    if (Math.random() > dtS * 9) return;
    glow(x + rnd(-4, 4), y + rnd(-4, 2), 2, rnd(5, 8), 0.35, 0.85, FIRE, 0, -20);
    if (Math.random() < 0.4) smoke(x, y - 4, 2, 8, 0.8, 0.35, SMOKE);
  };

  // --------------------------------------------------------------------------
  // Interface feedback
  // --------------------------------------------------------------------------
  FX.marker = function (wx, wy, kind) {
    if (markers.length > 24) markers.shift();
    markers.push({ x: wx, y: wy, kind: kind || 'move', t0: NT.Game.now });
  };
  FX.text = function (wx, wy, str, col, scale) {
    if (texts.length > 40) texts.shift();
    texts.push({ x: wx, y: wy, str: String(str), col: col || WHITE, t0: simT(), k: scale || 1 });
  };

  function reset() {
    while (P.length) pool.push(P.pop());
    decals.length = 0; decalI = 0;
    markers.length = texts.length = warns.length = timers.length = 0;
    now = 0; frameTick = -99; sweepTick = -1;
  }
  NT.on('game:start', reset);
  NT.on('game:stop', reset);

  // --------------------------------------------------------------------------
  // Update
  // --------------------------------------------------------------------------
  FX.frame = function (dt, simNow) {
    const wd = world();
    if (!wd) return;
    dtS = NT.clamp(simNow - now, 0, 0.1);
    now = simNow; frameTick = wd.tick;
    if (timers.length) {
      let j = 0;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t.at > now) timers[j++] = t;
        else if (now - t.at < 0.5) t.fn();                   // stale timers (fast-forward) are dropped, not replayed
      }
      timers.length = j;
    }
    let j = 0;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (now - p.born >= p.life) { pool.push(p); continue; }
      if (dtS > 0) {
        p.x += p.vx * dtS; p.y += p.vy * dtS;
        if (p.drag) { const k = Math.max(0, 1 - p.drag * dtS); p.vx *= k; p.vy *= k; }
        if (p.kind === DEBRIS) {
          p.z += p.vz * dtS; p.vz -= 420 * dtS;
          if (p.z < 0) { p.z = 0; p.vz = p.vz < -60 ? -p.vz * 0.35 : 0; p.vx *= 0.4; p.vy *= 0.4; }
        }
      }
      P[j++] = p;
    }
    P.length = j;
  };

  // --------------------------------------------------------------------------
  // Projectiles
  // --------------------------------------------------------------------------
  function styleOf(w) {
    let s = styles.get(w);
    if (s) return s;
    const fxk = w.fx || '';
    s = { k: w.proj, tint: TINT[fxk] || null, big: w.splashPx > 40 || w.dmg >= 90 };
    if (w.proj === 'bullet') s.k = fxk ? 'rod' : 'tracer';                 // hinted bullets are thrown / launched solids
    else if (w.proj === 'lob') s.k = fxk === 'brick' ? 'block' : fxk === 'cylinder' ? 'canister' : 'bomb';
    else if (w.proj !== 'rocket' && w.proj !== 'shell') s.k = 'tracer';
    styles.set(w, s);
    return s;
  }
  function extras(wd, p) {
    let d = pdata.get(p);
    if (d) return d;
    const src = wd.byId.get(p.src), mz = muzzleOf(src, src ? Math.max(0, src.def.weapons.indexOf(p.w)) : 0);
    d = { ox: src ? mz[0] : 0, oy: src ? mz[1] : 0, lx: p.sx + (src ? mz[0] : 0), ly: p.sy + (src ? mz[1] : 0), seed: Math.random() * TAU };
    pdata.set(p, d);
    return d;
  }
  // screen-ready state of one projectile -> Q
  const Q = { x: 0, y: 0, h: 0, ang: 0, f: 0, d: null, s: null };
  function locate(wd, p, alpha, view) {
    let x = p.px + (p.x - p.px) * alpha, y = p.py + (p.y - p.py) * alpha;
    if (x < view.x0 - 80 || x > view.x1 + 80 || y < view.y0 - 120 || y > view.y1 + 80) return false;
    if (NT.Render && !NT.Render.visibleAt(x, y)) return false;
    const d = extras(wd, p), s = styleOf(p.w), f = NT.clamp((wd.tick + alpha - 1 - p.born) / Math.max(1, p.eta - p.born), 0, 1);
    x += d.ox * (1 - f); y += d.oy * (1 - f);
    Q.ang = Math.atan2(p.ty - p.sy - d.oy * (1 - f), p.tx - p.sx - d.ox * (1 - f));
    if (p.w.homing && (p.x !== p.px || p.y !== p.py)) Q.ang = Math.atan2(p.y - p.py, p.x - p.px);
    Q.h = p.w.proj === 'lob' ? Math.sin(Math.PI * f) * NT.clamp(NT.dist(p.sx, p.sy, p.tx, p.ty) * 0.32, 14, 80) : 0;
    Q.x = x; Q.y = y; Q.f = f; Q.d = d; Q.s = s;
    return true;
  }
  function drawProjectiles(ctx, view, wd) {
    const ps = wd.projectiles, alpha = NT.Game.alpha;
    if (!ps.length) return;
    ctx.lineCap = 'round';
    // tracers: one path, one stroke
    let n = 0;
    ctx.beginPath();
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.w.proj !== 'bullet' || p.w.fx || !locate(wd, p, alpha, view)) continue;
      const c = Math.cos(Q.ang), s = Math.sin(Q.ang);
      ctx.moveTo(Q.x, Q.y); ctx.lineTo(Q.x - c * 9, Q.y - s * 9); n++;
    }
    if (n) { ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff6d0'; ctx.stroke(); }
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if ((p.w.proj === 'bullet' && !p.w.fx) || !locate(wd, p, alpha, view)) continue;
      const x = Q.x, y = Q.y, c = Math.cos(Q.ang), s = Math.sin(Q.ang), k = Q.s.k, d = Q.d;
      if (k === 'rod') {
        ctx.beginPath(); ctx.moveTo(x + c * 3, y + s * 3); ctx.lineTo(x - c * 11, y - s * 11);
        ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(8,9,14,0.9)'; ctx.stroke();
        ctx.lineWidth = 1.6; ctx.strokeStyle = '#c3cbd8'; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + c * 3, y + s * 3); ctx.lineTo(x + c * 0.5, y + s * 0.5);
        ctx.lineWidth = 2; ctx.strokeStyle = '#ffb45a'; ctx.stroke();
      } else if (k === 'rocket') {
        ctx.beginPath(); ctx.moveTo(x + c * 4, y + s * 4); ctx.lineTo(x - c * 4, y - s * 4);
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(8,9,14,0.9)'; ctx.stroke();
        ctx.lineWidth = 2.4; ctx.strokeStyle = '#dfe4ee'; ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x + c * 4, y + s * 4); ctx.lineTo(x + c * 2, y + s * 2);
        ctx.strokeStyle = '#ff4d5e'; ctx.stroke();
        if (dtS > 0 && NT.dist(d.lx, d.ly, x, y) > 7) {
          d.lx = x; d.ly = y;
          const q = alloc(PUFF, 0, x - c * 6, y - s * 6, rnd(0.45, 0.75));
          if (q) { q.spr = anyPuff(ASH); q.r0 = 2; q.r1 = rnd(5, 8); q.a = 0.4; q.vx = -c * 14 + rnd(-6, 6); q.vy = -s * 14 + rnd(-8, 2); q.drag = 1.5; }
        }
      } else if (k === 'shell') {
        ctx.beginPath(); ctx.moveTo(x + c * 3, y + s * 3); ctx.lineTo(x - c * 3, y - s * 3);
        ctx.lineWidth = 3.6; ctx.strokeStyle = '#11131a'; ctx.stroke();
        ctx.lineWidth = 2; ctx.strokeStyle = '#8f98aa'; ctx.stroke();
      } else {                                              // lobbed: ground shadow + the object at fake height
        const h = Q.h, sc = 1 + h / 110, spin = d.seed + Q.f * (k === 'canister' ? 9 : 14);
        ctx.globalAlpha = 0.34 - Math.min(0.18, h / 300);
        ctx.fillStyle = '#020306';
        ctx.beginPath(); ctx.ellipse(x + h * 0.25, y + h * 0.2, 3.4 * sc, 2.2 * sc, 0, 0, TAU); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.translate(x, y - h); ctx.rotate(spin); ctx.scale(sc, sc);
        if (k === 'block') {
          ctx.fillStyle = '#0a0b10'; ctx.fillRect(-3.8, -3, 7.6, 6);
          ctx.fillStyle = '#9aa0ac'; ctx.fillRect(-3, -2.2, 6, 4.4);
          ctx.fillStyle = '#c9ced8'; ctx.fillRect(-3, -2.2, 6, 1.3);
          ctx.fillStyle = '#5b606c'; ctx.fillRect(-1.6, -0.3, 1.2, 1.6); ctx.fillRect(0.6, -0.3, 1.2, 1.6);
        } else if (k === 'canister') {
          ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(-3.5, 0); ctx.lineTo(3.5, 0);
          ctx.lineWidth = 6.4; ctx.strokeStyle = '#0a0b10'; ctx.stroke();
          ctx.lineWidth = 4.6; ctx.strokeStyle = '#d0603a'; ctx.stroke();
          ctx.fillStyle = '#f2d9c0'; ctx.fillRect(-1, -2.3, 1.6, 4.6);
          ctx.fillStyle = '#8b94a5'; ctx.fillRect(5, -1, 2, 2);
          ctx.beginPath(); ctx.moveTo(-6, 0); ctx.lineTo(-11, 2.5 * Math.sin(spin * 3)); ctx.lineWidth = 1; ctx.strokeStyle = '#8b94a5'; ctx.stroke();
        } else {
          ctx.beginPath(); ctx.arc(0, 0, 3.1, 0, TAU); ctx.fillStyle = '#0a0b10'; ctx.fill();
          ctx.beginPath(); ctx.arc(0, 0, 2.3, 0, TAU); ctx.fillStyle = Q.s.tint || '#59606e'; ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(-1.4, -1.5, 1.3, 1.1);
        }
        ctx.scale(1 / sc, 1 / sc); ctx.rotate(-spin); ctx.translate(-x, -(y - h));
      }
    }
    ctx.lineCap = 'butt';
  }
  function glowProjectiles(ctx, view, wd) {
    const ps = wd.projectiles, alpha = NT.Game.alpha;
    if (!ps.length) return;
    let n = 0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i], w = p.w;
      if (w.fx || (w.proj !== 'bullet' && w.proj !== 'shell') || !locate(wd, p, alpha, view)) continue;
      const c = Math.cos(Q.ang), s = Math.sin(Q.ang), len = w.proj === 'shell' ? 20 : 15;
      ctx.moveTo(Q.x, Q.y); ctx.lineTo(Q.x - c * len, Q.y - s * len); n++;
    }
    if (n) { ctx.globalAlpha = 0.5; ctx.lineWidth = 3.4; ctx.strokeStyle = '#ffab45'; ctx.stroke(); ctx.globalAlpha = 1; }
    const fl = dot('#ffb45a');
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i], w = p.w;
      if ((w.proj !== 'rocket' && w.proj !== 'lob') || !locate(wd, p, alpha, view)) continue;
      const c = Math.cos(Q.ang), s = Math.sin(Q.ang);
      if (w.proj === 'rocket') {
        const r = 7 + Math.random() * 3;
        ctx.drawImage(fl, Q.x - c * 6 - r, Q.y - s * 6 - r, 2 * r, 2 * r);
      } else if (Q.s.k === 'bomb') ctx.drawImage(fl, Q.x - 4, Q.y - Q.h - 4, 8, 8);
    }
    ctx.lineCap = 'butt';
  }

  // --------------------------------------------------------------------------
  // Draw
  // --------------------------------------------------------------------------
  function drawParticles(ctx, view, layer) {
    const x0 = view.x0 - 60, x1 = view.x1 + 60, y0 = view.y0 - 60, y1 = view.y1 + 60;
    for (let i = 0; i < P.length; i++) {
      const p = P[i];
      if (p.layer !== layer || p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      const k = (now - p.born) / p.life;
      if (k < 0 || k >= 1) continue;
      switch (p.kind) {
        case PUFF: {
          const r = p.r0 + (p.r1 - p.r0) * (1 - (1 - k) * (1 - k));
          ctx.globalAlpha = p.a * (k < 0.12 ? k / 0.12 : (1 - k) / 0.88);
          ctx.drawImage(p.spr, p.x - r, p.y - r, 2 * r, 2 * r);
          break;
        }
        case GLOW: {
          const r = p.r0 + (p.r1 - p.r0) * (1 - (1 - k) * (1 - k));
          ctx.globalAlpha = p.a * (1 - k) * (1 - k * 0.5);
          ctx.drawImage(p.spr, p.x - r, p.y - r, 2 * r, 2 * r);
          break;
        }
        case SPARK:
          ctx.globalAlpha = 1 - k;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.045, p.y - p.vy * 0.045);
          ctx.lineWidth = p.w; ctx.strokeStyle = p.col; ctx.stroke();
          break;
        case DEBRIS: {
          const a = k > 0.7 ? (1 - k) / 0.3 : 1;
          ctx.globalAlpha = 0.3 * a; ctx.fillStyle = '#020306'; ctx.fillRect(p.x - p.w / 2 + p.z * 0.2, p.y - p.w / 2 + p.z * 0.16, p.w, p.w);
          ctx.globalAlpha = a; ctx.fillStyle = p.col; ctx.fillRect(p.x - p.w / 2, p.y - p.z - p.w / 2, p.w, p.w * 0.8);
          break;
        }
        case RING:
          ctx.globalAlpha = p.a * (1 - k);
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r0 + (p.r1 - p.r0) * (1 - (1 - k) * (1 - k)), 0, TAU);
          ctx.lineWidth = p.w * (1 - k * 0.6); ctx.strokeStyle = p.col; ctx.stroke();
          break;
        case LINE:
          ctx.globalAlpha = p.a * (1 - k);
          ctx.beginPath(); ctx.moveTo(p.x + (p.x2 - p.x) * k * 0.6, p.y + (p.y2 - p.y) * k * 0.6); ctx.lineTo(p.x2, p.y2);
          ctx.lineWidth = p.w; ctx.strokeStyle = p.col; ctx.stroke();
          break;
        case BEAM: {
          const a = p.a * (1 - k);
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x2, p.y2);
          ctx.globalAlpha = a * 0.35; ctx.lineWidth = p.w * 2.6; ctx.strokeStyle = p.col; ctx.stroke();
          ctx.globalAlpha = a; ctx.lineWidth = p.w * 0.8; ctx.stroke();
          ctx.globalAlpha = a * 0.8; ctx.lineWidth = Math.max(0.6, p.w * 0.3); ctx.strokeStyle = WHITE; ctx.stroke();
          break;
        }
        case ARC: {
          const sweep = 1.9, a0 = p.rot - p.x2 * sweep / 2 + p.x2 * sweep * k * 0.8, a1 = a0 + p.x2 * sweep * 0.45;
          ctx.globalAlpha = p.a * (1 - k);
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r0, Math.min(a0, a1), Math.max(a0, a1));
          ctx.lineWidth = p.w * (1 - k * 0.5); ctx.strokeStyle = p.col; ctx.stroke();
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  FX.drawDecals = function (ctx, view) {
    for (let i = 0; i < decals.length; i++) {
      const d = decals[i], age = now - d.born;
      if (age >= d.life || age < 0 || d.x + d.r < view.x0 || d.x - d.r > view.x1 || d.y + d.r < view.y0 || d.y - d.r > view.y1) continue;
      const fade = age > d.life * 0.7 ? (d.life - age) / (d.life * 0.3) : 1;
      ctx.globalAlpha = d.a * fade;
      ctx.drawImage(d.spr, d.x - d.r, d.y - d.r, 2 * d.r, 2 * d.r);
      if (d.col) {                                          // scraps of the owner's colours in the wreck
        ctx.globalAlpha = 0.55 * fade; ctx.fillStyle = d.col;
        for (let k = 0; k < 4; k++) {
          const h = NT.hash32(d.seed, k), a = (h & 1023) / 1023 * TAU, r = d.r * (0.15 + (h >> 10 & 255) / 255 * 0.4);
          ctx.fillRect(d.x + Math.cos(a) * r, d.y + Math.sin(a) * r * 0.8, 2 + (h >> 18 & 3), 1.5 + (h >> 20 & 1));
        }
      }
    }
    ctx.globalAlpha = 1;
  };
  FX.drawWorld = function (ctx, view, wd) {
    drawProjectiles(ctx, view, wd);
    drawParticles(ctx, view, 0);
  };
  FX.drawGlow = function (ctx, view, wd) {
    glowProjectiles(ctx, view, wd);
    ctx.lineCap = 'round';
    drawParticles(ctx, view, 1);
    ctx.lineCap = 'butt';
  };

  // overlay ---------------------------------------------------------------------
  const MARK = { move: '#7dffb0', attack: '#ff4d5e', amove: '#ffb21e', rally: '#f2f6ff', harvest: GLINT, capture: '#f2f6ff', deny: '#ff4d5e' };
  function stroke2(ctx, col, lw) {
    ctx.lineWidth = lw + 1.8; ctx.strokeStyle = 'rgba(4,5,10,0.75)'; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke();
  }
  function chevrons(ctx, x, y, r, s, n, rot) {              // n chevrons pointing at the centre
    for (let i = 0; i < n; i++) {
      const a = rot + i / n * TAU, c = Math.cos(a), sn = Math.sin(a), px = -sn, py = c;
      ctx.moveTo(x + c * (r + s) + px * s, y + sn * (r + s) + py * s);
      ctx.lineTo(x + c * r, y + sn * r);
      ctx.lineTo(x + c * (r + s) - px * s, y + sn * (r + s) - py * s);
    }
  }
  function drawMarker(ctx, m, k, uk) {
    const col = MARK[m.kind] || MARK.move, e = 1 - (1 - k) * (1 - k), x = m.x, y = m.y;
    ctx.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.beginPath();
    switch (m.kind) {
      case 'attack': case 'amove': {
        const r = (17 - 9 * e) * uk;
        ctx.arc(x, y, r, 0, TAU);
        for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + (m.kind === 'amove' ? Math.PI / 4 : 0), c = Math.cos(a), s = Math.sin(a); ctx.moveTo(x + c * (r - 3 * uk), y + s * (r - 3 * uk)); ctx.lineTo(x + c * (r + 5 * uk), y + s * (r + 5 * uk)); }
        if (m.kind === 'amove') chevrons(ctx, x, y, r + 8 * uk, 3 * uk, 4, 0);
        break;
      }
      case 'harvest': {
        const r = (15 - 7 * e) * uk;
        ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.75, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r * 0.75, y); ctx.closePath();
        ctx.moveTo(x - r * 0.75, y); ctx.lineTo(x + r * 0.75, y);
        break;
      }
      case 'capture': {
        const r = (18 - 8 * e) * uk, l = 5 * uk;
        for (let i = 0; i < 4; i++) {
          const sx = i & 1 ? 1 : -1, sy = i & 2 ? 1 : -1;
          ctx.moveTo(x + sx * r, y + sy * (r - l)); ctx.lineTo(x + sx * r, y + sy * r); ctx.lineTo(x + sx * (r - l), y + sy * r);
        }
        break;
      }
      case 'deny': {
        const r = 8 * uk, j = Math.sin(k * 40) * (1 - k) * 3 * uk;
        ctx.moveTo(x - r + j, y - r); ctx.lineTo(x + r + j, y + r); ctx.moveTo(x + r + j, y - r); ctx.lineTo(x - r + j, y + r);
        break;
      }
      case 'rally': {
        const hgt = 16 * uk * Math.min(1, k * 5);
        ctx.moveTo(x, y); ctx.lineTo(x, y - hgt); ctx.lineTo(x + 9 * uk, y - hgt + 3.5 * uk); ctx.lineTo(x, y - hgt + 7 * uk);
        ctx.moveTo(x + 6 * uk * (1 + e), y); ctx.ellipse(x, y, 6 * uk * (1 + e), 3 * uk * (1 + e), 0, 0, TAU);
        break;
      }
      default: {
        chevrons(ctx, x, y, (13 - 9 * e) * uk, 4 * uk, 4, Math.PI / 4);
        ctx.moveTo(x + 1.6 * uk, y); ctx.arc(x, y, 1.6 * uk, 0, TAU);
      }
    }
    stroke2(ctx, col, 1.7 * uk);
    ctx.globalAlpha = 1;
  }
  FX.drawOverlay = function (ctx, view, uk) {
    const wall = NT.Game.now;
    // strike warnings: pulsing ring, hazard ticks, countdown
    let j = 0;
    for (let i = 0; i < warns.length; i++) {
      const w = warns[i];
      if (now >= w.until + 0.4 || now < w.t0 - 1) continue;
      warns[j++] = w;
      const left = Math.max(0, w.until - now), pulse = 0.5 + 0.5 * Math.sin(wall * (left < 1 ? 22 : 11)), grow = Math.min(1, (now - w.t0) / 0.25);
      const r = w.r * grow;
      ctx.globalAlpha = 0.1 + 0.08 * pulse; ctx.fillStyle = w.col;
      ctx.beginPath(); ctx.arc(w.x, w.y, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = 0.55 + 0.45 * pulse;
      ctx.beginPath(); ctx.arc(w.x, w.y, r, 0, TAU);
      stroke2(ctx, w.col, 2.2 * uk);
      ctx.setLineDash([3 * uk, 7 * uk]); ctx.lineDashOffset = wall * 30;
      ctx.beginPath(); ctx.arc(w.x, w.y, r + 6 * uk, 0, TAU); ctx.lineWidth = 1.4 * uk; ctx.strokeStyle = WHITE; ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); chevrons(ctx, w.x, w.y, r * (0.35 + 0.25 * ((wall * 1.5) % 1)), 5 * uk, 4, Math.PI / 4);
      ctx.lineWidth = 1.6 * uk; ctx.strokeStyle = w.col; ctx.stroke();
      if (left > 0) {
        ctx.globalAlpha = 1;
        ctx.font = '700 ' + Math.round(15 * uk) + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5 * uk; ctx.strokeStyle = 'rgba(4,5,10,0.85)'; ctx.lineJoin = 'round';
        const s = left.toFixed(1);
        ctx.strokeText(s, w.x, w.y); ctx.fillStyle = WHITE; ctx.fillText(s, w.x, w.y);
      }
      ctx.globalAlpha = 1;
    }
    warns.length = j;
    // order markers (wall clock)
    j = 0;
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i], k = (wall - m.t0) / 0.55;
      if (k >= 1 || k < 0) continue;
      markers[j++] = m;
      drawMarker(ctx, m, k, uk);
    }
    markers.length = j;
    // floating text
    j = 0;
    if (texts.length) { ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round'; }
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i], k = (now - t.t0) / 1.2;
      if (k >= 1 || k < 0) continue;
      texts[j++] = t;
      const y = t.y - 20 * uk * (1 - (1 - k) * (1 - k));
      ctx.globalAlpha = k < 0.7 ? 1 : (1 - k) / 0.3;
      ctx.font = '700 ' + Math.round(12 * uk * t.k) + 'px ' + FONT;
      ctx.lineWidth = 3 * uk; ctx.strokeStyle = 'rgba(4,5,10,0.85)'; ctx.strokeText(t.str, t.x, y);
      ctx.fillStyle = t.col; ctx.fillText(t.str, t.x, y);
    }
    texts.length = j;
    ctx.globalAlpha = 1; ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
  };
})();
