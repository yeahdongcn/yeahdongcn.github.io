'use strict';
// NEON TURF — curfew.art.js (presentation: the Curfew Company's hand-drawn art; needs js/art.js).
// Shape language: RECTILINEAR — boxes, chamfers, chevrons, stencil stripes, straight barrels. Olive drab,
// concrete, canvas, gunmetal under warm sodium light; civic vehicles pressed into service. Every defence
// keeps an oil-drum fire. Team colour: shoulder pads, cab roofs, body stripes, roof bands, flags.
// palette.hazard sits next to the default team amber: it only ever appears as thin black-striped bands.
(function () {
  const A = NT.Art, P = A.P, PI = Math.PI, TAU = PI * 2;
  const SODIUM = '#ffe2b0', FLAME = '#ff8a2a', FLAME_HI = '#ffe39a', BRASS = '#cfa957', CHALK = '#e8e4d6';
  const TIN = '#7f8996', ASH = '#2a2e36', TWEED = '#6b5b45', NOFLASH = false;

  // ---- shared helpers ---------------------------------------------------------------------------------
  function hg(b) { const sw = 5.6 + 3.2 * b, td = 2.6 + 1.5 * b; return { sw: sw, td: td, SY: sw - td * 0.8 }; }   // mirrors the humanoid rig
  function slab(g, x, y, w, h, col) { g.rect(x, y, w, h, col || '#22272f', { lit: 0, bevel: -0.5, r: 1.2, ol: 'rgba(0,0,0,0.5)', lw: 0.5 }); }
  function stencil(g, x, y, w, h, col, seed) { g.scribble(x, y, w, h, col || 'rgba(232,228,214,0.55)', { seed: seed || 5, lw: 0.8, rows: Math.max(1, Math.round(h / 2.2)) }); }

  // BRACED mark: crisp team chevrons on the ground around the unit (main pass only: never shadow / glow)
  function brace(g, s, r, n, k) {
    if (!g.vis()) return;
    const c = g.ctx;
    n = n || 6; k = k || 2.1;
    c.save(); c.lineCap = 'butt'; c.lineJoin = 'miter'; c.beginPath();
    for (let i = 0; i < n; i++) {
      const a = i * TAU / n, co = Math.cos(a), si = Math.sin(a);
      c.moveTo(co * r - si * k, si * r + co * k); c.lineTo(co * (r + k), si * (r + k)); c.lineTo(co * r + si * k, si * r - co * k);
    }
    c.strokeStyle = 'rgba(4,5,10,0.8)'; c.lineWidth = k + 0.5; c.stroke();
    c.strokeStyle = s.team; c.lineWidth = k * 0.6; c.stroke();
    c.restore();
  }

  // tyres whose tread lines scroll with s.walk
  function wheels(g, xs, gauge, l, w, ph) {
    g.wheels(xs, gauge, { l: l, w: w, col: '#2a2d35' });
    if (!g.vis()) return;
    const c = g.ctx;
    c.strokeStyle = 'rgba(170,178,196,0.35)'; c.lineWidth = 0.6; c.lineCap = 'butt'; c.beginPath();
    for (let i = 0; i < xs.length; i++) for (let sd = -1; sd <= 1; sd += 2) for (let k = 0; k < 3; k++) {
      const X = xs[i] - l / 2 + 0.6 + (((k + (ph || 0) * 3) % 3) / 3) * (l - 1.2), Y = sd * gauge / 2;
      c.moveTo(X, Y - w / 2 + 0.5); c.lineTo(X, Y + w / 2 - 0.5);
    }
    c.stroke();
  }
  function headlamps(g, x, hw) { g.lamp(x, -hw + 2.2, '#fff1c9', { r: 0.7, reach: 4, a: 0.5 }); g.lamp(x, hw - 2.2, '#fff1c9', { r: 0.7, reach: 4, a: 0.5 }); }
  // forward-control cab (garbage truck, fire engine): glass at the very front, team roof behind it
  function cabFwd(g, s, x0, x1, hw, col) {
    g.rect(x0, -hw, x1 - x0, 2 * hw, col, { r: 1.6, lit: 0.14 });
    g.rect(x0 + 0.9, -hw + 1.1, x1 - x0 - 4.6, 2 * hw - 2.2, s.team, { r: 1.1, lit: 0.18, lw: 0.5 });
    g.windshield(x1 - 3.2, -hw + 1.2, 2.4, 2 * hw - 2.4, { r: 0.8 });
    headlamps(g, x1 - 0.4, hw);
  }
  // pickup cab: bonnet in front of the glass, team roof
  function cabPickup(g, s, x0, x1, hw, col) {
    const L = x1 - x0, xb = x0 + L * 0.48;
    g.rect(xb - 1, -hw + 0.6, x1 - xb + 1, 2 * hw - 1.2, A.shade(col, -0.06), { r: 1.6, lit: 0.12 });
    g.panels(xb + 1, -hw + 2, x1 - xb - 2, 2 * hw - 4, 1, 2, 'rgba(0,0,0,0.25)', 0.5);
    g.rect(x0, -hw, xb - x0, 2 * hw, col, { r: 1.4, lit: 0.12 });
    g.rect(x0 + 0.8, -hw + 1, xb - x0 - 3.4, 2 * hw - 2, s.team, { r: 1, lit: 0.18, lw: 0.5 });
    g.windshield(xb - 2.6, -hw + 1.2, 2.2, 2 * hw - 2.4, { r: 0.7 });
    headlamps(g, x1 - 0.5, hw);
  }
  function glintHeap(g, s, x, y, rx, ry) {
    const gl = s.pal.glint;
    const p = g.blob([x - rx, y, x - rx * 0.7, y - ry * 1.05, x + rx * 0.2, y - ry * 1.1, x + rx, y - ry * 0.4, x + rx * 0.9, y + ry, x - rx * 0.3, y + ry * 1.05], gl, { lit: 0.3, lw: 0.5 });
    if (g.vis()) for (let i = 0; i < 5; i++) {
      const a = i * 1.7, d = 0.25 + (i % 3) * 0.2;
      g.rect(x + Math.cos(a) * rx * d - 0.7, y + Math.sin(a) * ry * d - 0.7, 1.4, 1.4, i % 2 ? '#ffffff' : A.shade(gl, -0.25), A.FLAT);
    }
    g.glow(p, gl, { r: 2, a: 0.45 });
  }
  // live twinkles inside a rect (full loads, sorted crates)
  function sparkle(g, x, y, w, h, t, sd, n) {
    for (let i = 0; i < n; i++) {
      const k = Math.floor(t * 5 + i * 0.37 + sd), u = A.hash01(k, i * 7 + 1), v = A.hash01(k, i * 7 + 2), f = (t * 5 + i * 0.37 + sd) % 1;
      const a = Math.sin(f * PI);
      g.puff(x + u * w, y + v * h, 1.2 + a * 1.4, '#ffffff', 0.9 * a);
    }
  }
  // oil drum with embers; the flame itself is live (drumFlame / drumLight)
  function fireDrum(g, x, y, col) {
    g.drum(x, y, 2.5, col || '#5a4a3a', 4.5);
    g.circle(x, y - 4.5, 1.6, '#3a1608', { lit: 0, bevel: -0.6, ol: false });
    g.lamp(x, y - 4.5, FLAME, { r: 0.8, reach: 7, a: 0.55 });
    g.pool(x, y + 1, 11, 7, FLAME, 0.22);
  }
  function drumFlame(g, x, y, t, sd) {
    const f = 0.75 + 0.25 * Math.sin(t * 17 + sd) * Math.sin(t * 6.1 + sd * 2);
    g.puff(x, y - 0.6, 2.6 * f + 0.4, FLAME, 0.85);
    g.puff(x + Math.sin(t * 5 + sd) * 0.6, y - 1.8 * f, 1.5 * f, FLAME_HI, 0.95);
  }
  function drumLight(g, x, y, t, sd) { g.puff(x, y, 9 + 1.6 * Math.sin(t * 13 + sd), '#ff9a3a', 0.32 + 0.12 * Math.sin(t * 21 + sd * 3)); }
  function sparks(g, x, y, t, col) {
    const k = Math.floor(t * 14);
    if (A.hash01(k, 3) < 0.45) return;
    for (let i = 0; i < 4; i++) {
      const a = A.hash01(k, i) * TAU, d = 1.5 + A.hash01(k, i + 9) * 4;
      g.line(x, y, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7, col, 0.6);
    }
    g.puff(x, y, 3, '#ffffff', 0.9);
  }
  function ngon(cx, cy, r, n, rot) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (rot || 0) + i * TAU / n; pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    return pts;
  }
  // team chevron painted flat on a surface, pointing along +x
  function teamChevron(g, s, x, y, w, h) {
    const t = Math.min(w, h) * 0.34;
    g.poly([x, y - h / 2, x + t, y - h / 2, x + w, y, x + t, y + h / 2, x, y + h / 2, x + w - t, y], s.team, { lit: 0.12, bevel: 0.5, lw: 0.45 });
  }

  NT.Art.define('curfew', {
    // ======================================================================== BUILDINGS
    // ---- Ward Command: requisitioned fire station — three bay doors, hose tower, map-table tarp on the roof
    command: {
      height: 52,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 20, pal = s.pal;
        slab(g, 2, 50, W - 4, H - 52, '#2a2f38');
        for (let i = 0; i < 3; i++) g.chevrons(14 + i * 26, 76, 8, 10, A.alpha(CHALK, 0.35), 1, 1.4);
        const r = g.box(5, 14, W - 10, 44, h, { roof: '#4a4f57', wall: '#6a5a4c', lip: 2.2, deck: '#3d4249' });
        // south wall: three engine bays, old maroon frames, roller shutters in the owner's colour
        g.panels(r.wall.x, r.wall.y, r.wall.w, r.wall.h, 1, 4, 'rgba(0,0,0,0.18)', 0.4);
        for (let i = 0; i < 3; i++) g.door(11 + i * 26, r.wall.y + 4.5, 22, h - 4.5, { lit: SODIUM, shut: [0.5, 0.75, 0.3][i], slats: A.shade(s.team, -0.2), frame: A.shade(pal.engine, -0.55) });
        for (let i = 0; i < 4; i++) g.lamp(9 + i * 26, r.wall.y + 2.6, SODIUM, { r: 0.8, reach: 6, a: 0.6 });
        // roof: team band, map table under a canvas tarp, antenna, hose tower
        g.rect(r.x + 3, r.y + r.d - 9.5, r.w - 6, 6.5, s.team, { r: 0.6, lit: 0.12, bevel: 0.5, lw: 0.5 });
        g.chevrons(r.x + 8, r.y + r.d - 8.5, 14, 4.5, s.teamInk, 3, 1.1);
        g.chevrons(r.x + r.w - 24, r.y + r.d - 8.5, 14, 4.5, s.teamInk, 3, 1.1);
        g.rect(r.x + 3, r.y + 3, 6.5, r.d - 13, s.team, { r: 0.6, lit: 0.12, bevel: 0.5, lw: 0.5 });
        g.at(h, function () {
          g.box(22, 21, 34, 18, 2, { roof: '#5d564a' });
          g.tarp(21, 17, 36, 20, pal.canvas, { seed: 9, folds: 2 });
          if (g.vis()) {
            g.lines([25, 22, 33, 25, 41, 21, 52, 26], 'rgba(60,50,35,0.7)', 0.7);
            g.lines([27, 31, 37, 29, 49, 33], 'rgba(60,50,35,0.7)', 0.7);
            g.circle(33, 25, 1, s.team, A.FLAT); g.circle(49, 33, 1, s.team, A.FLAT); g.circle(41, 21, 1, '#20242d', A.FLAT);
          }
          g.ac(60, 36, 8, 6);
          g.vent(12, 30, 6, 8, { v: true, step: 1.5 });
          g.rect(24, 40, 30, 4, '#1a2230', { lit: 0, bevel: -0.8, r: 0.4 });
          g.windows(25, 40.5, 28, 3, { cols: 6, rows: 1, lit: 0.5, col: SODIUM, seed: 21, gap: 1 });
          g.mast(62, 24, 20, { bars: 3, barW: 7, tip: '#ff6a3a' });
          const tw = g.box(70, 16, 16, 16, 26, { roof: '#5a4c42', wall: '#6e5a4a', lip: 1.2 });
          g.windows(tw.wall.x + 4, tw.wall.y + 4, 8, 14, { cols: 1, rows: 3, lit: 0.7, col: SODIUM, seed: 3, gap: 1.6 });
          g.rect(tw.x + 2.2, tw.y + 2.2, tw.w - 4.4, tw.d - 4.4, s.team, { r: 0.6, lit: 0.14, lw: 0.5 });
          g.at(26, function () {
            g.cyl(78, 24, 3, 3, '#7c8698', { cap: '#20242d' });
            g.at(3, function () { g.lamp(78, 24, '#fff2cc', { r: 1.4, reach: 10, a: 0.7 }); });
          });
        });
        g.sandbags([5, H - 22, 5, H - 6, 22, H - 6], { rows: 2, col: pal.canvas });
        g.cyl(30, H - 10, 1.6, 4, A.shade(pal.engine, -0.3), { top: A.shade(pal.engine, -0.1) });   // the old street hydrant
        g.flag(10, H - 10, 28, s.team, { len: 11, drop: 7, wave: 0.3 });
        g.hazard(W - 30, H - 9, 24, 2.4, { a: pal.hazard, step: 2.4 });
        fireDrum(g, W - 8, H - 12);
        g.drum(W - 14, H - 7, 2.4, pal.drab, 4.5);
      },
      anim: function (g, s) { drumFlame(g, s.W - 8, s.H - 16.5, s.t, s.seed); },
      lights: function (g, s) {
        drumLight(g, s.W - 8, s.H - 15, s.t, s.seed);
        if (!s.powered) return;
        const a = s.t * 0.7 + s.seed, x = 78, y = 24 - 49;
        for (let i = 1; i <= 3; i++) g.puff(x + Math.cos(a) * i * 7, y + Math.sin(a) * i * 5, 3 + i * 1.6, '#fff2cc', 0.22 - i * 0.04);
      },
    },

    // ---- Genny Shed: tin roof, two diesel generators on the pad, exhaust stacks, drums, cables
    genny: {
      height: 32,
      base: function (g, s) {
        const W = s.W, H = s.H, pal = s.pal;
        slab(g, 3, 24, W - 6, H - 27, '#2a2f37');
        g.gable(4, 6, W - 8, 22, 10, 4, { roof: TIN, wall: '#4e5560', ribs: 2.4 });
        const yT = 6 - 10, yR = 6 + 11 - 10 - 4, yE = 6 + 22 - 10;
        for (const X of [12, W - 22]) { g.rect(X, yT + 0.9, 10, yR - yT - 0.9, A.shade(s.team, 0.08), A.FLAT); g.rect(X, yR, 10, yE - yR - 0.9, A.shade(s.team, -0.18), A.FLAT); }
        g.door(W / 2 - 6, yE + 2, 12, 7, { lit: SODIUM, shut: 0.3 });
        for (let k = 0; k < 2; k++) {
          const x = k ? 34 : 7, y = 36, gb = g.box(x, y, 22, 14, 8, { roof: pal.drab, wall: pal.drabDark });
          g.vent(gb.x + 2, gb.y + 2, 8, gb.d - 4, { v: true, step: 1.6 });
          g.rect(gb.x + 11.5, gb.y + 2, 8.5, gb.d - 4, s.team, { r: 0.6, lit: 0.14, lw: 0.5 });
          g.vent(gb.wall.x + 2, gb.wall.y + 2, 9, gb.wall.h - 3.6, { step: 1.5 });
          g.led(gb.wall.x + 16, gb.wall.y + 4, '#ffb347', 0.75);
          g.at(8, function () { g.stack(x + 4, y + 3, 2.1, 13, '#6a7384'); });
        }
        if (g.vis()) {
          g.pipe([18, 50, 18, 55, 32, 57, 45, 55, 45, 50], 1, '#1c1f26');
          g.pipe([30, 28, 30, 33, 22, 36], 1, '#1c1f26');
        }
        g.drum(W - 7, 28, 2.6, pal.drab, 5); g.drum(W - 7, 34, 2.6, '#8a4b2a', 5); g.drum(W - 12, 31, 2.6, pal.drab, 5);
        g.hazard(6, H - 6, 18, 2.2, { a: pal.hazard, step: 2.2 });
      },
      anim: function (g, s) {
        for (let k = 0; k < 2; k++) {
          const x = (k ? 38 : 11), y = 39 - 21, t = s.t * (s.powered ? 1.4 : 0.4) + k * 0.5 + s.seed;
          for (let i = 0; i < 2; i++) { const p = (t + i * 0.5) % 1; g.puff(x + p * 3 + Math.sin(t * 7 + i) * 0.8, y - p * 10, 1.6 + p * 3, '#c9d0dc', 0.22 * (1 - p)); }
        }
      },
    },

    // ---- Drill Hall: community gym, parade square painted on the roof, sandbag rim, banners, floodlight
    drillhall: {
      height: 34,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 14, pal = s.pal;
        slab(g, 2, 44, W - 4, H - 46, '#262b33');
        const r = g.box(5, 9, W - 10, 36, h, { roof: '#55604a', wall: '#5e5446', lip: 1.8, deck: '#4c5842' });
        // court / parade lines
        if (g.vis()) {
          const c = g.ctx, x = r.x + 6, y = r.y + 5, w = r.w - 12, d = r.d - 10;
          c.strokeStyle = 'rgba(232,228,214,0.6)'; c.lineWidth = 0.8;
          c.strokeRect(x, y, w, d); c.beginPath(); c.moveTo(x + w / 2, y); c.lineTo(x + w / 2, y + d); c.stroke();
          c.beginPath(); c.arc(x + w / 2, y + d / 2, 5.5, 0, TAU); c.stroke();
          c.strokeRect(x, y + d / 2 - 6, 9, 12); c.strokeRect(x + w - 9, y + d / 2 - 6, 9, 12);
        }
        for (const q of [[r.x + 3, r.y + 3], [r.x + r.w - 9, r.y + 3], [r.x + 3, r.y + r.d - 9], [r.x + r.w - 9, r.y + r.d - 9]]) g.rect(q[0], q[1], 6, 6, s.team, { r: 0.6, lit: 0.14, lw: 0.5 });
        g.rect(r.x + r.w / 2 - 12, r.y + r.d / 2 - 2.5, 24, 5, s.team, { r: 0.6, lit: 0.12, bevel: 0.5, lw: 0.5 });
        g.windows(r.wall.x + 4, r.wall.y + 2.5, 30, 3.4, { cols: 5, rows: 1, lit: 0.8, col: SODIUM, seed: 7, gap: 1.6 });
        g.windows(r.wall.x + r.wall.w - 34, r.wall.y + 2.5, 30, 3.4, { cols: 5, rows: 1, lit: 0.8, col: SODIUM, seed: 9, gap: 1.6 });
        g.door(W / 2 - 7, r.wall.y + 4.5, 14, h - 4.5, { lit: SODIUM });
        g.banner(W / 2 - 15, r.wall.y + 1.5, 5.5, 11, s.team, { mark: 'star' });
        g.banner(W / 2 + 9.5, r.wall.y + 1.5, 5.5, 11, s.team, { mark: 'star' });
        g.sandbags([5, H - 6, W / 2 - 10, H - 6], { rows: 2, col: pal.canvas });
        g.sandbags([W / 2 + 10, H - 6, W - 5, H - 6], { rows: 2, col: pal.canvas });
        g.mast(W - 6, 49, 26, { w: 1.3, col: '#8b96aa' });
        g.at(26, function () { g.rect(W - 10, 47, 8, 3.2, '#3a404c', { r: 0.6, lw: 0.4 }); g.lamp(W - 8, 48.6, SODIUM, { r: 1, reach: 12 }); g.lamp(W - 4, 48.6, SODIUM, { r: 1, reach: 12 }); });
        g.pool(W - 22, H - 12, 20, 9, SODIUM, 0.3);
      },
      lights: function (g, s) { if (s.active && s.powered) g.puff(s.W / 2, s.H - 14, 14, SODIUM, 0.2 + 0.1 * Math.sin(s.t * 6)); },
    },

    // ---- Quartermaster Yard: fenced car park, weigh-scale, sorted Glint crates, office hut, boom gate
    qmyard: {
      height: 26,
      base: function (g, s) {
        const W = s.W, H = s.H, pal = s.pal;
        slab(g, 2, 4, W - 4, H - 6, '#1f242c');
        if (g.vis()) for (let i = 0; i < 4; i++) g.line(40 + i * 12, 6, 40 + i * 12, 16, 'rgba(232,228,214,0.25)', 0.7, { cap: 'butt' });
        // weigh scale
        g.rect(36, 22, 34, 22, '#4a515c', { r: 0.8, lit: 0.12, bevel: 0.8 });
        g.panels(36, 22, 34, 22, 4, 2, 'rgba(0,0,0,0.3)', 0.5);
        g.hazard(36, 22, 34, 2, { a: pal.hazard, step: 2 }); g.hazard(36, 42, 34, 2, { a: pal.hazard, step: 2 });
        teamChevron(g, s, 46, 33, 14, 12);
        // office hut
        const hut = g.box(5, 10, 24, 18, 11, { roof: '#5a5f68', wall: '#6a5a4c', lip: 1.2 });
        g.rect(hut.x + 2.2, hut.y + 2.2, hut.w - 4.4, hut.d - 4.4, s.team, { r: 0.6, lit: 0.14, lw: 0.5 });
        g.windows(hut.wall.x + 3, hut.wall.y + 3, 9, 4, { cols: 2, rows: 1, lit: 1, col: SODIUM, gap: 1 });
        g.door(hut.wall.x + 15, hut.wall.y + 3, 5, 8, { lit: SODIUM });
        // sorted crates, Glint showing under the lids
        for (let j = 0; j < 2; j++) for (let i = 0; i < 3; i++) {
          const x = 74 + i * 6.5, y = 14 + j * 13, cr = g.crate(x, y, 5.6, 8, 4, pal.drab, { nx: 1, ny: 2 });
          g.rect(cr.x + 1, cr.y + 1, 3.6, 2.6, pal.glint, { r: 0.4, lit: 0.2, lw: 0.3 });
          g.glow(P.rect(cr.x + 1, cr.y + 1, 3.6, 2.6), pal.glint, { r: 2, a: 0.5 });
        }
        g.crate(8, 34, 9, 7, 5, pal.canvas, { strap: s.team }); g.crate(8, 45, 9, 7, 5, pal.canvas, { strap: s.team });
        // fence with a gap for the gate at the south
        g.fence([3, H - 4, 3, 4, W - 3, 4, W - 3, H - 4, W - 30, H - 4], { h: 6 });
        g.fence([3, H - 4, 40, H - 4], { h: 6 });
        // boom gate
        g.box(41, H - 10, 5, 5, 7, { roof: '#59616f' });
        g.at(6, function () {
          const arm = P.rect(45, H - 8.6, 25, 2.4);
          g.solid(arm, '#e8e4d6', { lit: 0.1, lw: 0.5 });
          g.stripes(arm, [null, s.team], 3, 0);
        });
        g.lamp(44, H - 15.5, '#ff6a3a', { r: 0.8, reach: 5 });
      },
      anim: function (g, s) { sparkle(g, 74, 8, 20, 22, s.t, s.seed % 7, 3); },
    },

    // ---- Motor Pool: bus depot — skylit roof, two roller doors, welding sparks, tyre stacks
    motorpool: {
      height: 36,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 20, pal = s.pal;
        slab(g, 2, 56, W - 4, H - 58, '#262b33');
        for (const X of [14, 54]) { g.rect(X, 66, 28, 26, '#20252d', { lit: 0, bevel: -0.4, r: 0.6 }); g.chevrons(X + 9, 76, 10, 8, A.alpha(CHALK, 0.3), 2, 1.3); }
        const r = g.box(4, 12, W - 8, 48, h, { roof: '#4b5260', wall: '#5a5348', lip: 2, deck: '#424956' });
        for (let k = 0; k < 3; k++) {
          const y = r.y + 5 + k * 13;
          g.rect(r.x + 5, y, r.w * 0.62, 6, '#1a2230', { lit: 0, bevel: -0.8, r: 0.5 });
          g.windows(r.x + 6, y + 1, r.w * 0.62 - 2, 4, { cols: 8, rows: 1, lit: 0.55, col: ['#9fd8ff', SODIUM], seed: 11 + k, gap: 1 });
        }
        g.rect(r.x + r.w * 0.7, r.y + 3, r.w * 0.26, r.d - 6, s.team, { r: 0.8, lit: 0.14, bevel: 0.5, lw: 0.5 });
        g.chevrons(r.x + r.w * 0.76, r.y + r.d / 2 - 6, r.w * 0.14, 12, s.teamInk, 2, 1.6);
        g.door(14, r.wall.y + 4, 28, h - 4, { lit: SODIUM, shut: 0.35, slats: '#6a717e' });
        g.door(54, r.wall.y + 4, 28, h - 4, { lit: SODIUM, shut: 0.75, slats: '#6a717e' });
        g.hazard(10, r.wall.y + 4, 2.4, h - 4, { a: pal.hazard, step: 2 }); g.hazard(45.8, r.wall.y + 4, 2.4, h - 4, { a: pal.hazard, step: 2 });
        g.hazard(84, r.wall.y + 4, 2.4, h - 4, { a: pal.hazard, step: 2 });
        g.rect(r.wall.x, r.wall.y + 0.6, r.wall.w, 2.2, s.team, A.FLAT);
        g.at(h, function () { g.stack(W - 14, 22, 3, 8, '#5d6676'); g.ac(W - 30, 18, 9, 6); });
        for (const q of [[W - 9, 66], [W - 9, 75]]) { g.tyre(q[0], q[1], 3.6); g.at(2.4, function () { g.tyre(q[0], q[1], 3.6); }); g.at(4.8, function () { g.tyre(q[0], q[1], 3.6); }); }
        g.tyre(6, 84, 3.4); g.at(2.4, function () { g.tyre(6, 84, 3.4); });
        g.drum(8, 70, 2.5, pal.drab, 4.5);
        g.pool(28, 64, 16, 7, SODIUM, 0.3);
      },
      anim: function (g, s) { sparks(g, 22 + 10 * A.hash01(Math.floor(s.t * 0.5) + s.seed, 1), 70, s.t + s.seed, '#d6ecff'); },
      lights: function (g, s) { if (A.hash01(Math.floor((s.t + s.seed) * 14), 3) > 0.45) g.puff(27, 70, 12, '#bfe0ff', 0.45); },
    },

    // ---- Signal Loft: rooftop pigeon loft (slatted cage), antennas, a small dish, a blinking lamp
    loft: {
      height: 44,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 16, pal = s.pal;
        slab(g, 3, 40, W - 6, H - 43, '#262b33');
        const r = g.box(6, 14, W - 12, 30, h, { roof: '#4a4f58', wall: '#6d5446', lip: 1.4 });
        g.windows(r.wall.x + 10, r.wall.y + 3, r.wall.w - 22, 4, { cols: 3, rows: 1, lit: 0.7, col: SODIUM, seed: 4 });
        g.door(r.wall.x + r.wall.w - 10, r.wall.y + 5, 6, h - 5, { lit: SODIUM });
        g.at(h, function () {
          const cg = g.box(10, 17, 26, 16, 8, { roof: s.team, wall: '#6e5a40' });
          g.stripes(P.rect(cg.x, cg.y, cg.w, cg.d), [null, 'rgba(0,0,0,0.28)'], 2.2, PI / 2);
          g.mesh(P.rect(cg.wall.x + 1, cg.wall.y + 1, cg.wall.w - 2, cg.wall.h - 2), { step: 1.6, col: 'rgba(220,210,180,0.5)', ang: PI / 2, cross: false });
          g.mast(42, 20, 22, { bars: 3, barW: 6, w: 1 });
          g.mast(50, 34, 16, { bars: 2, barW: 5, w: 1 });
          g.mast(12, 36, 12, { w: 0.9 });
          g.cyl(46, 28, 2.2, 3, '#6b7384');
          g.rect(10, 33.5, 26, 2, '#8a7a5a', { lit: 0.1, lw: 0.4 });                          // landing board
          for (const q of [[14, 34.4], [21, 34.6], [31, 34.3]]) g.ellipse(q[0], q[1], 1.3, 0.9, '#c9ccd4', { lit: 0.2, lw: 0.35 });
          g.ac(22, 38, 8, 4);
        });
        g.at(h + 22, function () { g.lamp(42, 20, '#ff5a3a', { r: 1, reach: 6 }); });
        g.crate(W - 16, H - 14, 8, 6, 4, pal.drab, { strap: s.team });
        g.sandbags([8, H - 8, 28, H - 8], { rows: 2, col: pal.canvas });
        g.banner(r.wall.x + 2.5, r.wall.y + 1.2, 5, 9, s.team, { mark: 'dish' });
      },
      anim: function (g, s) {
        for (let i = 0; i < 2; i++) {
          const a = s.t * 0.9 + i * PI + s.seed, x = 26 + Math.cos(a) * 14, y = -12 + Math.sin(a) * 6, f = Math.sin(s.t * 12 + i) * 1.2;
          g.lines([x - 2, y - f, x, y, x + 2, y - f], '#d8dbe2', 0.7);
        }
        g.dish(46, 28 - 16 - 5, 5, { ang: s.powered ? s.t * 1.4 + s.seed : 0.8, col: '#b6bfcc' });
        if (s.powered && Math.sin(s.t * 4 + s.seed) > 0.4) g.circle(42, 20 - 38, 1.1, '#ffd0c0');
      },
      lights: function (g, s) { if (s.powered && Math.sin(s.t * 4 + s.seed) > 0.4) g.puff(42, 20 - 38, 6, '#ff5a3a', 0.7); },
    },

    // ---- Surplus Arsenal: low concrete garage, camo net, stencilled crates, hazard-striped ramp
    arsenal: {
      height: 24,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 10, pal = s.pal;
        slab(g, 2, 4, W - 4, H - 6, '#22272e');
        const r = g.box(5, 10, 60, 34, h, { roof: '#7a8089', wall: '#585e68', lip: 1.4, deck: '#6c727c' });
        g.rect(r.x + 3, r.y + 3, r.w - 6, 5, s.team, { r: 0.4, lit: 0.12, lw: 0.4 });
        g.rect(r.x + 3, r.y + r.d - 8, r.w - 6, 5, s.team, { r: 0.4, lit: 0.12, lw: 0.4 });
        stencil(g, r.x + 10, r.y + 11, 26, 6, 'rgba(30,32,38,0.6)', 13);
        // camo net over half the roof
        g.at(h, function () {
          const net = g.blob([28, 20, 46, 17.5, 64, 20, 67, 28, 58, 36, 40, 36.5, 27, 34, 25, 27], pal.drab, { lit: 0.1, lw: 0.5 });
          if (g.vis()) {
            const c = g.ctx; c.save(); c.clip(net);
            for (let i = 0; i < 9; i++) { c.fillStyle = i % 3 ? pal.drabDark : pal.canvas; c.beginPath(); c.ellipse(28 + s.rnd() * 36, 19 + s.rnd() * 16, 3 + s.rnd() * 3, 2 + s.rnd() * 2, s.rnd() * PI, 0, TAU); c.fill(); }
            c.restore();
            g.mesh(net, { step: 2, col: 'rgba(10,12,8,0.35)' });
          }
        });
        g.door(r.wall.x + 8, r.wall.y + 2.5, 22, h - 2.5, { lit: '#7fb6c8', shut: 0.2 });
        // ramp down to the door
        g.rect(r.wall.x + 7, r.wall.y + h, 24, 13, '#2b3038', { lit: 0, bevel: -0.6, r: 0.4 });
        g.hazard(r.wall.x + 5, r.wall.y + h, 2.2, 13, { a: pal.hazard, step: 2 }); g.hazard(r.wall.x + 31, r.wall.y + h, 2.2, 13, { a: pal.hazard, step: 2 });
        g.chevrons(r.wall.x + 16, r.wall.y + h + 9, 6, -6, A.alpha(CHALK, 0.4), 1, 1.2);
        // stencilled crates in the yard
        for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
          const cr = g.crate(70 + i * 8, 10 + j * 12, 7, 9, 5 + (i + j) % 2 * 2, pal.drab, { nx: 1, ny: 1 });
          g.rect(cr.x + 0.8, cr.y + cr.d * 0.4, cr.w - 1.6, 1.6, s.team, A.FLAT);
          stencil(g, cr.x + 1.2, cr.y + 1, cr.w - 2.4, 2, 'rgba(232,228,214,0.6)', 3 + i + j);
        }
        g.crate(72, 38, 16, 8, 4, pal.steel, { nx: 3, strap: s.team });
        g.lamp(r.wall.x + 4, r.wall.y + 2, SODIUM, { r: 0.8, reach: 7 });
      },
    },

    // ---- Curfew Siren: water tower on legs, air-raid horn on top, team ring, rotating beacon
    siren: {
      height: 78,
      base: function (g, s) {
        const W = s.W, H = s.H, cx = W / 2, cy = 62, pal = s.pal, z = 34, R = 17, th = 16;
        slab(g, 4, 24, W - 8, H - 27, '#262b33');
        // pump house + control hut, cable to the tower, sandbag arc, fuel
        const ph = g.box(7, 66, 18, 14, 9, { roof: '#5a5f68', wall: '#5e5446', lip: 1 });
        g.rect(ph.x + 2, ph.y + 2, ph.w - 4, ph.d - 4, s.team, { r: 0.5, lit: 0.14, lw: 0.4 });
        g.door(ph.wall.x + 6, ph.wall.y + 2.5, 6, 6.5, { lit: SODIUM });
        g.led(ph.wall.x + 15, ph.wall.y + 3, '#ffb347', 0.7);
        if (g.vis()) g.pipe([25, 76, 34, 76, cx - 14, cy + 12], 0.9, '#1c1f26');
        g.sandbags([W - 34, H - 7, W - 8, H - 7, W - 8, H - 26], { rows: 2, col: pal.canvas });
        g.hazard(cx - 18, H - 8, 22, 2.4, { a: pal.hazard, step: 2.4 });
        const legs = [[cx - 14, cy - 12], [cx + 14, cy - 12], [cx - 14, cy + 12], [cx + 14, cy + 12]];
        for (const q of legs) g.rect(q[0] - 2.2, q[1] - 1.6, 4.4, 3.2, '#5a5f68', { r: 0.4, lit: 0.1, lw: 0.4 });
        for (let i = 0; i < 2; i++) g.mast(legs[i][0], legs[i][1], z, { w: 1.8, col: '#7d8696' });
        if (g.vis()) {
          g.line(cx - 14, cy - 12 - 6, cx + 14, cy - 12 - z + 6, '#59616f', 0.8);
          g.line(cx - 14, cy + 12 - 4, cx + 14, cy + 12 - z + 6, '#59616f', 0.8);
          g.line(cx + 14, cy + 12 - 4, cx - 14, cy + 12 - z + 6, '#59616f', 0.8);
        }
        g.at(z, function () {
          g.cyl(cx, cy, R, th, '#7a8090', { wall: '#666d7b', bands: 1 });
          // painted team ring round the tank
          const p = new Path2D(), h0 = th * 0.3, h1 = th * 0.66;
          p.moveTo(cx - R, cy - h1); p.lineTo(cx - R, cy - h0); p.arc(cx, cy - h0, R, PI, 0, true); p.lineTo(cx + R, cy - h1); p.arc(cx, cy - h1, R, 0, PI, false); p.closePath();
          p.bb = [cx - R, cy - h1 - R, 2 * R, R * 2];
          g.solid(p, s.team, { lit: 0, bevel: 0, lw: 0.4 });
          g.at(th, function () {
            g.solid(P.ring(cx, cy, R - 4, R - 0.6), s.team, { lit: 0.14, lw: 0.5 });
            g.circle(cx, cy, R - 4, '#8a909e', { lit: 0.2, bevel: 0.6 });
            g.rect(cx - R + 1, cy - 1, 4, 2, '#3a404c', A.FLAT);
            // the air-raid horn: a motor drum with two big flared trumpets
            g.at(2, function () {
              g.cyl(cx, cy, 4.6, 5, '#5d6472', { cap: '#3a404c' });
              g.at(4, function () {
                for (let k = -1; k <= 1; k += 2) {
                  g.poly([cx + k * 2.5, cy - 2.6, cx + k * 11, cy - 3.6, cx + k * 17, cy - 8, cx + k * 17, cy + 8, cx + k * 11, cy + 3.6, cx + k * 2.5, cy + 2.6], '#a7afbc', { lit: 0.22, lw: 0.6 });
                  g.ellipse(cx + k * 16.3, cy, 1.6, 7, '#12151b', { lit: 0, bevel: -0.6, lw: 0.4 });
                  g.rect(cx + k * 7 - 0.8, cy - 3.3, 1.6, 6.6, s.team, { r: 0.3, lit: 0.1, lw: 0.3 });
                }
                g.circle(cx, cy, 2.6, '#3a404c', { lit: 0.2, lw: 0.5 });
              });
            });
          });
        });
        for (let i = 2; i < 4; i++) g.mast(legs[i][0], legs[i][1], z, { w: 1.8, col: '#7d8696' });
        if (g.vis()) for (let k = 0; k < 6; k++) g.line(cx + 16, cy + 10 - k * 5.5, cx + 16, cy + 7 - k * 5.5, '#aab4c6', 0.6);
        fireDrum(g, W - 14, 40);
        g.drum(W - 9, 46, 2.4, pal.drab, 4.5);
      },
      anim: function (g, s) {
        drumFlame(g, s.W - 14, 35.5, s.t, s.seed);
        const cx = s.W / 2, cy = 62 - 34 - 16 - 2 - 9, a = s.t * 3 + s.seed;
        g.circle(cx, cy, 1.7, s.powered ? '#ffe2a8' : '#5a5040');
        if (s.powered) g.line(cx, cy, cx + Math.cos(a) * 10, cy + Math.sin(a) * 7, 'rgba(255,214,140,0.45)', 2.2);
      },
      lights: function (g, s) {
        drumLight(g, s.W - 14, 37, s.t, s.seed);
        if (!s.powered) return;
        const cx = s.W / 2, cy = 62 - 34 - 16 - 2 - 9, a = s.t * 3 + s.seed;
        g.puff(cx, cy, 6, '#ffb347', 0.75);
        for (let i = 1; i <= 3; i++) g.puff(cx + Math.cos(a) * i * 7, cy + Math.sin(a) * i * 5, 2.5 + i * 1.8, '#ffb347', 0.42 - i * 0.09);
      },
    },

    // ---- Sandbag Nest: sandbag ring, heavy MG on a pintle, oil-drum fire
    nest: {
      height: 12,
      pivot: [16, 12.5], muzzle: [[14, 0]], recoil: 1,
      base: function (g, s) {
        const cx = 16, cy = 16.5;
        g.circle(cx, cy, 11.5, '#20242c', { lit: 0, bevel: -0.8, ol: false });
        const ring = ngon(cx, cy, 11.6, 10, PI * 0.15);
        g.sandbags(ring.concat(ring[0], ring[1]), { rows: 2, bag: 5, col: s.pal.canvas });
        g.at(4.4, function () { g.solid(P.ring(cx, cy, 9.6, 13.4, PI * 0.62, PI * 1.38), s.team, { lit: 0.14, lw: 0.5 }); });
        g.cyl(cx, cy - 1, 2, 4, '#4a505c');
        fireDrum(g, 4, 6, '#5a4a3a');
      },
      top: function (g, s) {
        g.rect(-7, -5.4, 5, 4.2, s.pal.drab, { r: 0.6, lw: 0.5 });                         // ammo box
        g.barrel(2, 0, 12, 1.8, '#6c7484', { brake: true });
        g.rect(5, -1.6, 5, 3.2, '#3e4450', { r: 0.4, lw: 0.4 });                            // cooling jacket
        if (g.vis()) for (let i = 0; i < 3; i++) g.circle(6 + i * 1.6, 0, 0.45, '#11141a', A.FLAT);
        g.rect(-4, -2.4, 7.5, 4.8, '#4f5664', { r: 0.8, lit: 0.16, lw: 0.6 });
        g.rect(2, -6, 2.8, 12, s.team, { r: 0.6, lit: 0.16, lw: 0.5 });                  // gun shield
        g.capsule(-4, 0, -7.5, 0, 0.9, '#2a2e36', { lw: 0.4 });
      },
      anim: function (g, s) { drumFlame(g, 4, 1.5, s.t, s.seed); },
      lights: function (g, s) { drumLight(g, 4, 3, s.t, s.seed); },
    },

    // ---- Dug-In Gun: concrete apron, a tank turret sunk to its ring, hazard chevrons, ammo locker
    duggun: {
      height: 18,
      pivot: [32, 27], muzzle: [[29, 0]], recoil: 2.2,
      base: function (g, s) {
        const W = s.W, H = s.H, cx = 32, cy = 31, pal = s.pal;
        g.prism(ngon(cx, cy, 27, 8, PI / 8), 4, '#7a7f88', { wall: '#545962' });
        g.at(4, function () {
          for (let i = 0; i < 8; i++) {
            const a = i * TAU / 8 + PI / 8 + PI / 8;
            g.push(cx + Math.cos(a) * 21.5, cy + Math.sin(a) * 21.5, a);
            g.rect(-1.4, -3, 2.8, 6, '#1b1d22', A.FLAT); g.chevrons(-1.2, -2.6, 2.6, 5.2, pal.hazard, 1, 1.1);
            g.pop();
          }
          g.circle(cx, cy, 13.5, '#16191f', { lit: 0, bevel: -1 });
          g.solid(P.ring(cx, cy, 11.5, 14.5), s.team, { lit: 0.14, lw: 0.5 });
          if (g.vis()) for (let i = 0; i < 12; i++) { const a = i * TAU / 12; g.circle(cx + Math.cos(a) * 13, cy + Math.sin(a) * 13, 0.45, 'rgba(0,0,0,0.5)', A.FLAT); }
        });
        const lk = g.box(4, H - 16, 12, 9, 7, { roof: pal.steel, wall: '#363c47' });
        g.rect(lk.x + 1, lk.y + 1, lk.w - 2, 2.4, s.team, A.FLAT);
        g.led(lk.wall.x + 9, lk.wall.y + 3, '#7dff9a', 0.6);
        fireDrum(g, W - 8, H - 9);
      },
      top: function (g, s) {
        g.barrel(7, 0, 22, 3, '#8a93a4', { brake: true, sleeve: 5 });
        g.rect(15, -2.1, 3.6, 4.2, '#59606e', { r: 0.8, lw: 0.5 });                       // bore evacuator
        g.poly([-10, -7.5, 3, -9, 10, -4, 10, 4, 3, 9, -10, 7.5, -12, 3.5, -12, -3.5], s.pal.drab, { r: 1.4, lit: 0.18 });
        g.rect(-7.5, -5.5, 9.5, 11, s.team, { r: 1, lit: 0.16, lw: 0.5 });
        g.hatch(-4, -2.6, 2.4, s.pal.drabDark);
        g.rect(4.5, -6.5, 3, 2.4, '#20242d', { r: 0.4, lw: 0.3 });
      },
      anim: function (g, s) { drumFlame(g, s.W - 8, s.H - 13.5, s.t, s.seed); },
      lights: function (g, s) { drumLight(g, s.W - 8, s.H - 12, s.t, s.seed); },
    },

    // ======================================================================== UNITS
    // ---- Requisition Rig: boxy garbage truck, cab forward, open hopper that fills with Glint, folded claw
    rig: {
      frames: 3,
      body: function (g, s) {
        const pal = s.pal, k = s.cargo;
        wheels(g, [11, -3.5, -11], 16.4, 6, 3.4, s.walk);
        g.rect(-16, -6, 32, 12, ASH, { r: 1, lit: 0 });
        // hopper
        g.rect(-17, -9, 22, 18, pal.drab, { r: 1.2, lit: 0.14 });
        g.rect(-15, -6.6, 17.5, 13.2, '#12151b', { lit: 0, bevel: -1, r: 0.8, lw: 0.5 });
        if (k > 0) glintHeap(g, s, -6.2, 0, 7.6 * (0.45 + 0.55 * k), 5.6 * (0.45 + 0.55 * k));
        g.rect(-16.6, -8.8, 21, 2.2, s.team, { r: 0.5, lit: 0.12, lw: 0.45 });
        g.rect(-16.6, 6.6, 21, 2.2, s.team, { r: 0.5, lit: 0.12, lw: 0.45 });
        g.hazard(-17.6, -7, 1.6, 14, { a: pal.hazard, step: 1.8 });
        cabFwd(g, s, 5.6, 17, 8.4, pal.drab);
        g.exhaust(4.8, -9.6);
        // folded crane: slewing ring behind the cab, boom laid back over the hopper, claw hanging at the tail
        g.rect(-11.5, 3.2, 15.5, 2.8, '#9aa3b2', { r: 0.8, lit: 0.22, lw: 0.6 });
        g.circle(3, 4.6, 2.9, pal.steel, { lit: 0.16, lw: 0.55 });
        g.circle(3, 4.6, 1.1, '#20242d', A.FLAT);
        g.poly([-11, 1.2, -15.6, 0.4, -17.4, 2.4, -17.4, 6.8, -15.6, 8.8, -11, 8], '#c4ccd8', { r: 0.6, lit: 0.22, lw: 0.6 });
        if (g.vis()) { g.line(-11.4, 4.6, -17.2, 4.6, '#2a2e36', 0.7); g.line(-15.6, 0.6, -15.6, 8.6, 'rgba(0,0,0,0.3)', 0.5); }
      },
      anim: function (g, s) { if (s.cargo >= 0.84) sparkle(g, -14, -5.5, 15, 11, s.t, s.seed % 5, 3); },
    },

    // ---- Picket: slim neighbour, helmet, team armband + shoulders, straight service rifle
    picket: {
      frames: 6, kick: 0.9, muzzle: [A.rigs.humanoidMuzzle({ build: 0.25, weapon: 'rifle' })],
      body: function (g, s) {
        const pal = s.pal, q = hg(0.25);
        if (s.deployed) brace(g, s, 8.6, 4, 1.6);
        g.humanoid({ build: 0.25, cloth: pal.drab, sleeve: pal.drab, pad: s.team, head: 'helmet', headCol: A.shade(pal.drab, 0.12), stripe: s.team,
          chest: pal.canvas, pack: A.shade(pal.canvas, -0.2), boot: '#2c2a26', weapon: 'rifle', wcol: '#5a4a3a', walk: s.walk, moving: s.moving });
        g.capsule(0.9, q.SY - 0.6, 2.1, q.SY - 1.6, 1.25, s.team, { lit: 0.12, lw: 0.4 });            // armband on the trigger arm
      },
    },

    // ---- Stovepipe: grey-haired vet, a FAT rocket tube on the shoulder, pack
    stovepipe: {
      frames: 6, kick: 1.2,
      muzzle: [[12.2, 4.27]],
      body: function (g, s) {
        const pal = s.pal, q = hg(0.4), gy = q.sw * 0.62;
        if (s.deployed) brace(g, s, 9.2, 4, 1.6);
        g.humanoid({ build: 0.4, cloth: pal.drab, sleeve: pal.drabDark, pad: s.team, head: 'bare', hair: '#c4c6cc', skin: '#c08d6a',
          pack: pal.canvas, chest: pal.drabDark, boot: '#2c2a26', weapon: 'launcher', wcol: pal.drab, walk: s.walk, moving: s.moving });
        g.rect(-8.5, gy - 2.6, 19.5, 5.2, A.shade(pal.drab, 0.1), { r: 1.2, lit: 0.2, lw: 0.6 });
        g.rect(-10, gy - 3.3, 3, 6.6, '#3c4250', { r: 0.8, lw: 0.5 });                            // flared breech
        g.rect(9.6, gy - 3, 2.4, 6, '#59606e', { r: 0.6, lw: 0.5 });                              // muzzle ring
        g.rect(1.2, gy - 2.6, 2.6, 5.2, s.team, { lit: 0.12, bevel: 0.5, lw: 0.4 });
        g.circle(q.td + 3.4, gy - 3.4, 1.4, '#c08d6a', { lw: 0.45 });
      },
    },

    // ---- Groundskeeper: flat cap, a big ring of keys, a white first-aid satchel with a team cross, toolbox
    groundskeeper: {
      frames: 6, flash: NOFLASH, muzzle: [A.rigs.humanoidMuzzle({ build: 0.35, weapon: 'kit' })],
      body: function (g, s) {
        const q = hg(0.35);
        g.humanoid({ build: 0.35, cloth: TWEED, sleeve: TWEED, pad: s.team, head: 'cap', headCol: '#5c5446', skin: '#c9966f',
          pack: '#5a6474', boot: '#2c2a26', weapon: 'kit', kitCol: '#eef1f4', cross: s.team, walk: s.walk, moving: s.moving });
        const kx = -1.2, ky = -q.sw - 1.4;
        if (g.vis()) {
          g.stroke(P.circle(kx, ky, 2.3), '#1a1b1f', 1.6); g.stroke(P.circle(kx, ky, 2.3), BRASS, 0.9);
          for (let i = 0; i < 5; i++) { const a = PI * 0.15 + i * 0.5; g.line(kx + Math.cos(a) * 2.3, ky + Math.sin(a) * 2.3, kx + Math.cos(a) * 4.4, ky + Math.sin(a) * 4.4, i % 2 ? '#c9ced8' : BRASS, 0.9); }
        }
      },
    },

    // ---- Streetsweeper: pickup, roll bar, whip antenna, quad-MG mount in the bed
    sweeper: {
      frames: 3, pivot: [-6, 0], muzzle: [[10.5, 0]], recoil: 1,
      body: function (g, s) {
        const pal = s.pal;
        wheels(g, [8.5, -7.5], 13.4, 5.4, 3.2, s.walk);
        g.rect(-13.5, -6.6, 15, 13.2, pal.drab, { r: 1.2, lit: 0.12 });
        g.rect(-12.2, -5.2, 12.4, 10.4, '#1a1d23', { lit: 0, bevel: -0.9, r: 0.6, lw: 0.5 });
        g.rect(-13.2, -6.4, 14.4, 1.7, s.team, { r: 0.4, lit: 0.1, lw: 0.4 }); g.rect(-13.2, 4.7, 14.4, 1.7, s.team, { r: 0.4, lit: 0.1, lw: 0.4 });
        cabPickup(g, s, 1, 13.5, 6.6, pal.drab);
        g.rect(-0.4, -7.2, 1.8, 14.4, '#4a505c', { r: 0.6, lit: 0.18, lw: 0.5 });             // roll bar
        g.lamp(0.5, -4, SODIUM, { r: 0.6, reach: 3, a: 0.5 }); g.lamp(0.5, 4, SODIUM, { r: 0.6, reach: 3, a: 0.5 });
        if (g.vis()) { g.line(-12.5, -5.6, -21, -8.6, '#141619', 0.9); g.line(-12.5, -5.6, -21, -8.6, '#9aa3b5', 0.5); }
        g.circle(-12.5, -5.6, 0.9, '#2a2e36', { lw: 0.3 });
      },
      top: function (g, s) {
        for (let i = 0; i < 4; i++) g.barrel(2.5, -3.3 + i * 2.2, 8.5, 1.3, '#aeb7c6');
        g.rect(-3, -5.4, 6, 10.8, '#3a404c', { r: 1, lit: 0.16, lw: 0.55 });
        g.rect(-1, -6.2, 2.2, 12.4, s.team, { r: 0.5, lit: 0.16, lw: 0.45 });
        g.circle(-3.6, 0, 1.6, '#2a2e36', { lw: 0.4 });
      },
    },

    // ---- Hydrant: long fire engine — ladder rack on the roof, water cannon, hose reel, team side stripes
    hydrant: {
      frames: 3, pivot: [6, 2.6], muzzle: [[11, 0]], recoil: 0.4, flash: NOFLASH,
      body: function (g, s) {
        const pal = s.pal, red = A.shade(pal.engine, -0.4);
        wheels(g, [12, -6, -12.5], 14.2, 6, 3.3, s.walk);
        g.rect(-18, -7.2, 28.5, 14.4, pal.drab, { r: 1, lit: 0.14 });
        g.panels(-18, -7.2, 28.5, 14.4, 4, 1, 'rgba(0,0,0,0.25)', 0.5);
        for (let i = 0; i < 3; i++) g.rect(-15 + i * 7.2, -7.3, 1.2, 14.6, red, A.FLAT);          // the red engine between the plates
        g.rect(-17.6, -7, 27.8, 2.1, s.team, { r: 0.4, lit: 0.1, lw: 0.4 });
        g.rect(-17.6, 4.9, 27.8, 2.1, s.team, { r: 0.4, lit: 0.1, lw: 0.4 });
        cabFwd(g, s, 10.5, 18, 7.4, pal.drab);
        g.rect(17.4, -5.5, 1.3, 11, red, { r: 0.4, lw: 0.4 });
        // ladder rack
        if (g.vis()) {
          g.line(-17, -3.4, 9, -3.4, '#c3cad6', 1); g.line(-17, -0.4, 9, -0.4, '#c3cad6', 1);
          for (let X = -16; X <= 8; X += 2.4) g.line(X, -3.4, X, -0.4, '#9aa3b5', 0.6);
        }
        g.circle(-14, 3.6, 2.4, red, { lit: 0.14, lw: 0.5 });
        g.circle(-14, 3.6, 1, '#20242d', A.FLAT);
      },
      top: function (g, s) {
        g.circle(0, 0, 2.6, '#5d6472', { lit: 0.16, lw: 0.5 });
        g.poly([1, -1.4, 9.5, -0.8, 9.5, 0.8, 1, 1.4], BRASS, { lit: 0.25, lw: 0.5 });
        g.rect(9.2, -1.3, 1.6, 2.6, '#8a6a30', { r: 0.4, lw: 0.4 });
        g.rect(-2.4, -1.2, 2.4, 2.4, s.team, { r: 0.4, lit: 0.12, lw: 0.4 });
      },
    },

    // ---- Doorman: compact old tank — octagonal hull, round turret, long barrel, stowage, team chevron
    doorman: {
      frames: 3, pivot: [-1, 0], muzzle: [[20, 0]], recoil: 1.8,
      body: function (g, s) {
        const pal = s.pal;
        if (s.deployed) brace(g, s, 16.5);
        g.tracks(28, 15.5, 5.2, s.walk, { col: '#2e3139' });
        g.poly([-12.5, -6, -9.5, -8.8, 9.5, -8.8, 13, -5.4, 13, 5.4, 9.5, 8.8, -9.5, 8.8, -12.5, 6], pal.drab, { lit: 0.16 });
        g.rect(9.2, -5.4, 2.4, 10.8, s.team, { r: 0.4, lit: 0.12, lw: 0.45 });
        for (const y of [-7.2, 1.6]) { g.rect(-13.2, y, 4.4, 5.6, pal.canvas, { r: 0.6, lit: 0.16, lw: 0.5 }); g.panels(-13.2, y, 4.4, 5.6, 1, 2, 'rgba(0,0,0,0.3)', 0.5); }
        g.vent(-8.5, -3, 3.4, 6, { v: true, step: 1.3 });
        g.rect(-12.6, -8.6, 25, 1.6, s.team, { r: 0.3, lit: 0.1, lw: 0.35 });
        g.rect(-12.6, 7, 25, 1.6, s.team, { r: 0.3, lit: 0.1, lw: 0.35 });
      },
      top: function (g, s) {
        const pal = s.pal;
        g.barrel(5, 0, 15, 2.4, '#8a93a4', { sleeve: 3 });
        g.rect(11.5, -1.6, 2.6, 3.2, '#59606e', { r: 0.8, lw: 0.45 });
        g.circle(0, 0, 6.8, A.shade(pal.drab, 0.08), { lit: 0.2 });
        teamChevron(g, s, -4.6, 0, 7.4, 8.6);
        g.hatch(-3, -4.2, 1.6, pal.drabDark);
      },
    },

    // ---- Mailman: flatbed with a fat mortar tube on a baseplate, ammo racks; braced: outriggers down
    mailman: {
      frames: 3, kick: 0.6, muzzle: [[0.5, 0]],
      body: function (g, s) {
        const pal = s.pal, dep = s.deployed;
        if (dep) {
          brace(g, s, 16.5);
          for (const X of [8, -11]) for (let sd = -1; sd <= 1; sd += 2) {
            g.rect(X - 0.8, sd > 0 ? 6 : -10.4, 1.6, 4.4, '#59616f', { lit: 0.1, lw: 0.4 });
            g.rect(X - 2, sd * 10.4 - 1.3, 4, 2.6, pal.steel, { r: 0.5, lit: 0.14, lw: 0.45 });
          }
        }
        wheels(g, [10, -3.5, -10.5], 14, 5.6, 3.3, s.walk);
        g.rect(-15.5, -7, 18, 14, '#4c535f', { r: 0.8, lit: 0.12 });
        g.panels(-15.5, -7, 18, 14, 3, 1, 'rgba(0,0,0,0.3)', 0.5);
        for (let sd = -1; sd <= 1; sd += 2) {
          g.rect(-15, sd > 0 ? 3.8 : -6.6, 8.6, 2.8, pal.drabDark, { r: 0.4, lw: 0.4 });
          if (g.vis()) for (let i = 0; i < 5; i++) g.circle(-14 + i * 1.7, sd * 5.2, 0.65, BRASS, A.FLAT);
        }
        g.rect(-15.5, -7, 1.6, 14, s.team, { lit: 0.12, lw: 0.4 });
        g.rect(-15.3, -7, 17.6, 1.5, s.team, { r: 0.3, lit: 0.1, lw: 0.35 }); g.rect(-15.3, 5.5, 17.6, 1.5, s.team, { r: 0.3, lit: 0.1, lw: 0.35 });
        cabPickup(g, s, 2.5, 15.5, 7, pal.drab);
        g.rect(-14, -4.2, 9.5, 8.4, '#5a606c', { r: 1, lit: 0.18, lw: 0.6 });                  // baseplate
        if (g.vis()) { g.line(-3.5, -3, -5, -6.4, '#8a93a4', 1); g.line(-3.5, 3, -5, 6.4, '#8a93a4', 1); }
        g.rect(-13, -3.3, 12.5, 6.6, '#8d96a6', { r: 2, lit: 0.28, lw: 0.6 });                // the fat tube, raised
        g.rect(-8.5, -3.3, 1.8, 6.6, s.team, { lit: 0.1, bevel: 0.4, lw: 0.35 });
        g.circle(0, 0, 3.5, '#5d6472', { lit: 0.2, lw: 0.55 });
        g.circle(0, 0, 2.3, '#0b0c10', { lit: 0, bevel: -0.6, ol: false });
      },
    },

    // ---- Pigeon: small quad racing drone, X frame, four rotor blurs, a charge strapped under it, tail light
    pigeon: {
      frames: 3, fps: 24, height: 22, flash: NOFLASH, muzzle: [[3, 0]],
      body: function (g, s) {
        const c = g.ctx, R = 4.2, sp = s.walk * PI;
        g.rect(-6, -3.4, 10, 6.8, s.pal.drab, { r: 0.8, lit: 0.12, lw: 0.5 });              // the charge
        g.hazard(-5.4, -3.4, 1.8, 6.8, { a: s.pal.hazard, step: 1.6 });
        if (g.vis()) { g.line(-1, -3.4, 2.5, -1.2, '#d84a3a', 0.5); g.line(-1, 3.4, 2.5, 1.2, '#3a7ad8', 0.5); }
        for (let i = 0; i < 4; i++) {
          const a = PI / 4 + i * PI / 2, hx = Math.cos(a) * 7.4, hy = Math.sin(a) * 7.4;
          g.line(0, 0, hx, hy, '#15181f', 2.6, { cap: 'butt' }); g.line(0, 0, hx, hy, '#5d6472', 1.4, { cap: 'butt' });
        }
        for (let i = 0; i < 4; i++) {
          const a = PI / 4 + i * PI / 2, hx = Math.cos(a) * 7.4, hy = Math.sin(a) * 7.4, b = sp + i * 0.9;
          g.circle(hx, hy, R, '#bcd4ff', { alpha: 0.2, lit: 0, bevel: 0, ol: '#eaf2ff', lw: 0.3, outer: false });
          if (g.vis()) { c.strokeStyle = 'rgba(236,243,255,0.6)'; c.lineWidth = 0.8; c.beginPath(); c.moveTo(hx - Math.cos(b) * R * 0.9, hy - Math.sin(b) * R * 0.9); c.lineTo(hx + Math.cos(b) * R * 0.9, hy + Math.sin(b) * R * 0.9); c.stroke(); }
          g.circle(hx, hy, 1.3, s.team, { lit: 0.1, lw: 0.4 });
        }
        g.rect(-3, -2.2, 7.5, 4.4, s.team, { r: 1.2, lit: 0.2, lw: 0.5 });
        g.rect(3, -1.2, 2, 2.4, '#1a2230', { r: 0.6, lw: 0.4 });
        g.led(-4.2, 0, '#ff4040', 0.6);
      },
    },

    // ---- Monument: BIG memorial tank — wide tracks, angular turret, patina panels, team paint, plinth plate
    monument: {
      frames: 3, pivot: [1, 0], muzzle: [[27, 0]], recoil: 2.4,
      body: function (g, s) {
        const pal = s.pal, BRONZE = '#5e6040', PATINA = '#71907c';
        if (s.deployed) brace(g, s, 23);
        g.tracks(40, 21, 6.4, s.walk, { col: '#2e3139' });
        g.hull(37, 22, BRONZE, { nose: 4, tail: 2.5, nw: 0.74, lit: 0.16 });
        for (const q of [[5, -9.6, 8, 3.6], [-6, 6, 8, 3.6]]) g.rect(q[0], q[1], q[2], q[3], PATINA, { r: 0.8, lit: 0.1, bevel: 0.4, lw: 0.35 });
        for (let sd = -1; sd <= 1; sd += 2) for (let i = 0; i < 2; i++) g.capsule(-6 + i * 8, sd * 7.4, -2 + i * 8, sd * 10.2, 1.1, s.team, { lit: 0.1, lw: 0.4 });
        g.rect(15.5, -6.5, 2.2, 13, s.team, { r: 0.4, lit: 0.12, lw: 0.45 });
        // broken plinth plate on the rear deck
        g.poly([-18.4, -7.5, -10, -7.5, -11.2, -3, -9.6, 0.6, -11.6, 4.2, -10.4, 7.5, -18.4, 7.5], '#9ba0a8', { lit: 0.14, lw: 0.55 });
        stencil(g, -17.2, -4.5, 5, 9, 'rgba(40,42,48,0.65)', 21);
        if (g.vis()) for (const q of [[-17.6, -6.6], [-17.6, 6.6], [-11, -6.6], [-11.2, 6.6]]) g.circle(q[0], q[1], 0.6, '#2a2e36', A.FLAT);
        g.vent(-8.5, -4, 3.5, 8, { v: true, step: 1.3 });
      },
      top: function (g, s) {
        const BRONZE = '#62664a', PATINA = '#71907c';
        g.barrel(8, 0, 19, 3.8, '#858d9c', { brake: true, sleeve: 5 });
        g.barrel(8, 4.2, 4, 1.2, '#4a505c');
        g.poly([-10, -7.4, 3.5, -8.6, 9.5, -4.6, 9.5, 4.6, 3.5, 8.6, -10, 7.4, -12, 3.6, -12, -3.6], BRONZE, { r: 1, lit: 0.2 });
        g.rect(0, -7.6, 6, 3.4, PATINA, { r: 0.8, lit: 0.1, lw: 0.35 }); g.rect(-8.5, 3.4, 5.5, 3.4, PATINA, { r: 0.8, lit: 0.1, lw: 0.35 });
        g.capsule(-9, -5.6, 2, 6.2, 1.5, s.team, { lit: 0.12, lw: 0.4 });
        g.capsule(-4, -6.6, 6, 3.8, 1.3, s.team, { lit: 0.12, lw: 0.4 });
        g.hatch(-6, -2.5, 2.6, '#4c503a');
        g.circle(3, 3.5, 1.6, '#3c4030', { lw: 0.4 });
      },
    },
  });
})();
