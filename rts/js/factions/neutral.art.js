'use strict';
// NEON TURF — art for the neutral turf structures (presentation; needs js/art.js).
// The street businesses gangs fight over. Shared language so ownership reads at a glance on all of them:
// a painted ROOF BAND, an AWNING / canopy and a BANNER in the owner's colour plus the sign's neon trim —
// grey while nobody holds the block. Fixed hues stay thin and sit between the player colours.
(function () {
  const A = NT.Art, P = A.P, PI = Math.PI;
  const WARM = '#ffe2b0', PAPER = '#ff8a4c', MINT = '#3df0a8', VOLT = '#8fb8ff', ICE = '#d9f4ff', CREAM = '#e9e2cf';

  function slab(g, x, y, w, h, col) { g.rect(x, y, w, h, col || '#1b202a', { lit: 0, bevel: -0.5, r: 1.5, ol: 'rgba(0,0,0,0.5)', lw: 0.5 }); }
  function band(g, s, x, y, w, d) { g.rect(x, y, w, d, s.team, { lit: 0.12, bevel: 0.5, lw: 0.5, r: 0.5 }); }
  function trim(g, s, b) { g.neon(P.rect(b.x + 0.9, b.y + 0.9, b.w - 1.8, b.h - 1.8, 1), s.team, { w: 0.9, r: 2.6 }); }
  function cross(cx, cy, r, t) {
    return P.poly([cx - t, cy - r, cx + t, cy - r, cx + t, cy - t, cx + r, cy - t, cx + r, cy + t, cx + t, cy + t,
      cx + t, cy + r, cx - t, cy + r, cx - t, cy + t, cx - r, cy + t, cx - r, cy - t, cx - t, cy - t]);
  }
  function sparks(g, x, y, t, col) {
    const k = Math.floor(t * 14), on = A.hash01(k, 3) > 0.45;
    if (!on) return;
    for (let i = 0; i < 4; i++) {
      const a = A.hash01(k, i) * PI * 2, d = 1.5 + A.hash01(k, i + 9) * 4;
      g.line(x, y, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7, col, 0.6);
    }
    g.puff(x, y, 3.2, '#ffffff', 0.9);
  }

  NT.Art.define('neutral', {
    // ---- Noodle Bar: low kitchen, long awning over a counter with stools, steaming stock pot on the roof
    noodlebar: {
      height: 30,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 13;
        slab(g, 2, 40, W - 4, H - 42);
        const r = g.box(5, 8, W - 10, 35, h, { roof: '#333a47', wall: '#5a4038', lip: 2 });
        g.windows(r.wall.x + 4, r.wall.y + 1.5, r.wall.w - 8, 3.5, { cols: 7, rows: 1, lit: 1, col: WARM, a: 0.4 });
        band(g, s, r.x + 3.5, r.y + 3.5, r.w - 7, 4.5);
        g.at(h, function () {
          g.ac(9, 21, 8, 6);
          g.pipe([20, 24, 34, 24, 34, 17], 1.8, '#7b8496');
          g.cyl(W - 17, 24, 6, 5, '#8792a6', { cap: '#e6c078', bands: 1 });
          const b = g.billboard(9, 41, 30, 9, { lift: 1.5 });
          g.glyph('bowl', b.x + 2.2, b.y + 1.3, 7, 6.4, PAPER, { w: 1 });
          g.scribble(b.x + 11.5, b.y + 2.4, b.w - 14, 4.4, WARM, { seed: 3, lw: 0.9, rows: 2 });
          trim(g, s, b);
        });
        g.box(9, 45, W - 18, 4, 3, { roof: '#8a6a48', wall: '#4a3626' });
        for (let i = 0; i < 5; i++) g.cyl(13 + i * 9.5, 57, 2.3, 2, '#c7a67a', { wall: '#3a2f28' });
        g.pool(W / 2, 52, 26, 9, WARM, 0.3);
        g.awning(5, 43, W - 10, 9, { z: 7, slope: 2.5, cols: [s.team, s.team, CREAM], step: 3.4 });
        for (let i = 0; i < 6; i++) g.lamp(8.5 + i * 9.4, 46.6, PAPER, { r: 1.3, reach: 5.5, a: 0.7 });
      },
      anim: function (g, s) { A.steam(g, s.W - 17, 6, s.t + s.seed * 0.37, '#e6edf6', 4, 17); },
    },

    // ---- Pawn Shop: brick strongbox, barred windows, painted shutter, caged skylight, three brass balls
    pawnshop: {
      height: 34,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 17;
        slab(g, 2, 44, W - 4, H - 46);
        const r = g.box(6, 10, W - 12, 37, h, { roof: '#3b3f4b', wall: '#6a4238', lip: 2.4 });
        g.panels(r.wall.x, r.wall.y, r.wall.w, r.wall.h, 1, 6, 'rgba(0,0,0,0.22)', 0.4);
        for (let k = 0; k < 2; k++) {
          const wx = k ? W - 21 : 10;
          g.windows(wx, r.wall.y + 4, 11, 7, { cols: 1, rows: 1, lit: 1, col: WARM, a: 0.35 });
          g.mesh(P.rect(wx, r.wall.y + 4, 11, 7), { step: 2.2, ang: 0, cross: false, col: '#15181f', lw: 0.8 });
        }
        g.door(W / 2 - 5.5, r.wall.y + 5, 11, h - 5, { lit: WARM, shut: 0.6, slats: s.teamLo });
        const sk = g.rect(r.x + 6, r.y + 6, 17, 12, '#141a24', { lit: 0, bevel: -1, r: 0.8 });
        g.mesh(sk, { step: 3, ang: 0, col: 'rgba(160,172,196,0.6)', lw: 0.6 });
        band(g, s, r.x + 4, r.y + r.d - 9.5, r.w - 8, 5);
        g.at(h, function () {
          g.ac(W - 23, 20, 9, 6);
          const b = g.billboard(8, 45, 27, 10, { lift: 2 });
          g.glyph('gem', b.x + 2.2, b.y + 1.6, 7, 6.8, ICE, { w: 1 });
          g.scribble(b.x + 11.5, b.y + 2.6, b.w - 14, 4.8, WARM, { seed: 11, lw: 0.9, rows: 2 });
          trim(g, s, b);
        });
        g.crate(8, 53, 9, 7, 5, '#7a5638', { strap: '#3a2f28' });
        const safe = g.box(20, 54, 8, 6, 6, { roof: '#59616f', wall: '#3a414e' });
        g.circle(safe.wall.x + 4, safe.wall.y + 3, 1.5, '#aab4c6', { lit: 0.2, lw: 0.4 });
        g.box(W - 21, 54, 10, 5, 4, { roof: '#2a2e38' });
        g.screen(W - 20, 51.5, 8, 3.6, '#8fd6ff', { a: 0.5, blur: 2 });
        g.at(h, function () { g.flag(W - 11, 43, 13, s.team, { len: 9, drop: 6 }); });
        g.at(11, function () {
          g.line(W - 9, 47.5, W - 4.5, 47.5, '#20242d', 1.2);
          for (const q of [[W - 6.2, 46.2], [W - 8.2, 49.6], [W - 4.2, 49.6]]) g.circle(q[0], q[1], 1.9, '#d4a94a', { lit: 0.3, lw: 0.5 });
        });
      },
    },

    // ---- Night Market: no roof at all — rows of striped stall canopies, bulbs strung from a centre mast
    nightmarket: {
      height: 26,
      base: function (g, s) {
        const W = s.W, H = s.H, cx = W / 2, cy = 47;
        slab(g, 2, 3, W - 4, H - 5, '#1c212b');
        if (g.vis()) for (let i = 1; i < 6; i++) g.line(4 + i * 15, 36, 4 + i * 15, 56, 'rgba(233,226,207,0.1)', 0.8, { cap: 'butt' });
        g.pool(cx, 48, 42, 30, WARM, 0.2);
        const ST = [[6, 9, 26, 15, CREAM, 1], [35, 7, 26, 15, '#4a5364', 2], [64, 9, 26, 15, CREAM, 3],
          [6, 60, 26, 15, '#4a5364', 4], [64, 60, 26, 15, CREAM, 5]];
        const goods = ['#e0863c', '#8fbf4a', '#d8d2c0', '#c8563c', '#6fb7c9'];
        for (const t of ST) {
          const tb = g.box(t[0] + 2, t[1] + t[3] - 3, t[2] - 4, 6, 4, { roof: '#6f5a44', wall: '#3d3026' });
          for (let i = 0; i < 5; i++) g.circle(tb.x + 2.4 + i * (tb.w - 4.8) / 4, tb.y + 3, 1.5, goods[(i + t[5]) % 5], { lit: 0.2, lw: 0.35 });
        }
        const cart = g.box(39, 66, 18, 10, 5, { roof: '#7b8496', wall: '#474e5c' });
        g.at(5, function () { g.cyl(44.5, 71, 3.2, 3, '#aab4c6', { cap: '#e6c078' }); g.cyl(52, 71, 2.4, 3, '#aab4c6', { cap: '#d9d2c0' }); });
        g.umbrella(48, 68, 9.5, { z: 13, cols: [s.team, CREAM] });
        for (const t of ST) g.awning(t[0], t[1], t[2], t[3], { z: 9, slope: 1.5, cols: [s.team, t[4]], step: 4.4, posts: true });
        for (const q of [[4, 5], [W - 4, 5], [4, H - 6], [W - 4, H - 6]]) g.mast(q[0], q[1], 13, { w: 1, col: '#8b96aa' });
        g.mast(cx, cy, 24, { w: 1.5, col: '#9aa3b5', tip: WARM });
        g.string([4, 5, 13, cx, cy, 24, W - 4, 5, 13], { n: 7, col: WARM, sag: 2.5, r: 1.1, wire: 'rgba(150,160,180,0.35)' });
        g.string([4, H - 6, 13, cx, cy, 24, W - 4, H - 6, 13], { n: 7, col: WARM, sag: 2.5, r: 1.1, wire: 'rgba(150,160,180,0.35)' });
        g.string([5, 45, 9, W - 5, 45, 9], { n: 14, flags: true, cols: [s.team, CREAM], sag: 1.4, wire: 'rgba(150,160,180,0.35)' });
      },
      anim: function (g, s) { A.steam(g, 51, 47, s.t + s.seed * 0.21, '#dfe6f0', 3, 13); },
    },

    // ---- Corner Bar: chamfered corner entrance, roof terrace with parasols, kegs on the pavement
    cornerbar: {
      height: 34,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 15, x0 = 5, y0 = 8, x1 = W - 5, y1 = 47, ch = 16;
        slab(g, 2, 42, W - 4, H - 44);
        g.prism([x0, y0, x1, y0, x1, y1 - ch, x1 - ch, y1, x0, y1], h, '#3b3544', { wall: '#55395a' });
        g.windows(x0 + 4, y1 - h + 4, 24, 6, { cols: 3, rows: 1, lit: 1, col: ['#ffcf8a', '#ffb98a'], gap: 1.6, a: 0.45 });
        const dA = [x1 - ch * 0.78, y1 - ch * 0.22], dB = [x1 - ch * 0.26, y1 - ch * 0.74];
        const door = g.poly([dA[0], dA[1] - 11, dB[0], dB[1] - 11, dB[0], dB[1], dA[0], dA[1]], '#ffcf8a', { lit: 0, bevel: 0, ol: '#0a0b10', lw: 0.8 });
        g.glow(door, '#ffcf8a', { r: 2.6, a: 0.55 });
        g.pool(x1 - 3, y1 + 1, 13, 8, '#ffcf8a', 0.32);
        g.at(h, function () {
          const dk = g.rect(x0 + 3, y0 + 3, x1 - x0 - 6, 21, '#54402f', { lit: 0.06, bevel: -0.7, r: 0.8 });
          g.panels(x0 + 3, y0 + 3, x1 - x0 - 6, 21, 9, 1, 'rgba(0,0,0,0.25)', 0.4);
          band(g, s, x0 + 3, y0 + 27, x1 - x0 - ch - 4, 4.5);
          g.cyl(15, 16, 2.6, 2, '#d9d2c0'); g.cyl(41, 16, 2.6, 2, '#d9d2c0');
          g.umbrella(15, 17, 8, { z: 7, cols: [s.team, CREAM] });
          g.umbrella(41, 17, 8, { z: 7, cols: [s.team, CREAM] });
          const b = g.billboard(x0 + 3, y1 - 1, 24, 10, { lift: 2 });
          g.glyph('glass', b.x + 2.4, b.y + 1.6, 6.6, 6.8, '#ff9ad0', { w: 1 });
          g.scribble(b.x + 11, b.y + 2.6, b.w - 13.5, 4.8, WARM, { seed: 23, lw: 0.9, rows: 2 });
          trim(g, s, b);
        });
        g.drum(9, 55, 3.3, '#8a6a48', 5); g.drum(16.5, 56.5, 3.3, '#7a5a3c', 5); g.drum(12.6, 51.5, 3.3, '#8a6a48', 5);
        g.banner(33, y1 - h + 2.5, 5.5, 10, s.team, { mark: 'mug' });
      },
    },

    // ---- Substation: an open fenced yard — two finned transformers, a pylon, a control hut, arcs
    substation: {
      height: 32,
      base: function (g, s) {
        const W = s.W, H = s.H;
        slab(g, 3, 5, W - 6, H - 8, '#2b313c');
        g.hazard(4.5, H - 7.5, W - 9, 2.4, { step: 2.6 });
        g.fence([4, 7, W - 4, 7], { h: 6 });
        const hut = g.box(7, 11, 18, 13, 9, { roof: '#474e5c', wall: '#39404e', lip: 1.4 });
        band(g, s, hut.x + 2.4, hut.y + 2.4, hut.w - 4.8, 4);
        g.door(hut.wall.x + 6, hut.wall.y + 2, 6, 7, { lit: VOLT });
        g.mast(W - 9, 15, 26, { w: 1.6, bars: 3, barW: 10, tip: '#ff5a36' });
        for (let k = 0; k < 2; k++) {
          const tx = k ? 35 : 9, ty = k ? 33 : 33, tf = g.box(tx, ty, 20, 14, 9, { roof: '#5f6878', wall: '#3d4452' });
          g.vent(tf.wall.x + 1.5, tf.wall.y + 1.6, tf.wall.w - 3, tf.wall.h - 3.2, { v: true, step: 1.7 });
          g.rect(tf.x + 1.6, tf.y + 1.6, tf.w - 3.2, tf.d - 3.2, s.team, { r: 1, lit: 0.14, lw: 0.5 });
          g.at(9, function () { for (let i = 0; i < 3; i++) g.cyl(tx + 5 + i * 5, ty + 4, 1.6, 5, '#c9b8a0', { top: '#e6dccb', wall: '#8a7c68' }); });
        }
        g.at(15, function () { g.pipe([12, 37, W - 9, 37, W - 9, 15], 1.1, '#aab4c6'); });
        g.poly([W - 15, H - 12, W - 10.5, H - 20, W - 6, H - 12], '#ffc91f', { r: 0.6, lit: 0.1, lw: 0.6 });
        if (g.vis()) g.stroke(A.glyphPath('bolt', W - 12.6, H - 18, 4.2, 5.4), '#15171c', 0.8);
        g.fence([4, 7, 4, H - 6, W - 4, H - 6, W - 4, 7], { h: 6 });
        g.banner(27, H - 12.5, 6, 6.5, s.team, { tail: 1.4 });
        g.led(hut.wall.x + 3, hut.wall.y + 3, VOLT, 0.7);
      },
      anim: function (g, s) {
        const k = Math.floor(s.t * 9 + s.seed), on = A.hash01(k, 7) > 0.72, tx = A.hash01(k, 2) > 0.5 ? 35 : 9;
        if (!on) return;
        const pts = [tx + 5, 25];
        for (let i = 1; i <= 4; i++) pts.push(tx + 5 + i * 2.5, 25 + (A.hash01(k, i + 20) - 0.5) * 3.4);
        g.lines(pts, '#eaf2ff', 0.7);
      },
      lights: function (g, s) {
        const k = Math.floor(s.t * 9 + s.seed), on = A.hash01(k, 7) > 0.72, tx = A.hash01(k, 2) > 0.5 ? 35 : 9;
        for (let i = 0; i < 2; i++) g.puff((i ? 35 : 9) + 10, 24, 9, VOLT, 0.1 + 0.05 * Math.sin(s.t * 3 + i * 2));
        if (on) g.puff(tx + 10, 25, 9, VOLT, 0.7);
      },
    },

    // ---- Back-Alley Clinic: the only pale roof on the street, a lit mint cross on a white pad
    clinic: {
      height: 32,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 15;
        slab(g, 2, 42, W - 4, H - 44);
        const r = g.box(5, 9, W - 10, 37, h, { roof: '#8d99a7', wall: '#6f7b8a', lip: 2.2, deck: '#a3afbc' });
        g.panels(r.wall.x, r.wall.y, r.wall.w, r.wall.h, 9, 3, 'rgba(0,0,0,0.13)', 0.4);
        g.windows(r.wall.x + 4, r.wall.y + 3.5, 25, 5, { cols: 4, rows: 1, lit: 0.8, col: ICE, seed: 5, a: 0.4 });
        g.door(W - 24, r.wall.y + 4, 12, h - 4, { lit: ICE, frame: '#c9d2dd' });
        const cx = r.x + r.w / 2, cy = r.y + r.d / 2 + 1;
        g.rect(cx - 11.5, cy - 11.5, 23, 23, '#eef2f6', { r: 2.4, lit: 0.06, bevel: 0.6 });
        const cr = g.solid(cross(cx, cy, 8.4, 2.9), MINT, { lit: 0.08, bevel: 0.4, ol: '#0d5a40', lw: 0.6 });
        g.glow(cr, MINT, { r: 4, a: 0.75 });
        band(g, s, r.x + 3.2, r.y + 3.2, 11, r.d - 6.4); band(g, s, r.x + r.w - 14.2, r.y + 3.2, 11, r.d - 6.4);
        g.at(h, function () { g.cyl(W - 12.5, 14, 3.6, 6, '#b9c2ce', { bands: 1, cap: '#99a3b1' }); });
        for (let i = 0; i < 3; i++) g.cyl(9 + i * 4.8, 50, 1.9, 7, '#e3e9f0', { top: '#2f9f78', wall: '#aeb8c4' });
        const bed = g.box(25, 54, 15, 6, 3, { roof: '#eef2f6', wall: '#59616f' });
        g.rect(bed.x + 1, bed.y + 1, 3.6, 4, '#bcd0e0', { r: 0.8, lit: 0.1, lw: 0.3 });
        g.pool(W - 18, 52, 12, 7, ICE, 0.3);
        g.awning(W - 27, 46, 18, 8, { z: 9, slope: 2, cols: [s.team, '#eef2f6'], step: 3 });
      },
      lights: function (g, s) {
        const k = 0.16 + 0.1 * Math.sin(s.t * 1.7 + s.seed) + (Math.sin(s.t * 23 + s.seed) > 0.96 ? -0.14 : 0);
        g.puff(s.W / 2, 13, 17, MINT, Math.max(0, k));
      },
    },

    // ---- Chop Garage: tin shed with two bays, a car in the owner's paint up on the yard lift, tyres, sparks
    chopgarage: {
      height: 30,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 12, rise = 5, yT = 9 - h, yR = 9 + 18 - h - rise, yE = 9 + 36 - h;
        slab(g, 2, 6, W - 4, H - 8, '#1d222c');
        if (g.vis()) { g.puff(76, 50, 9, '#07080b', 0.5); g.puff(22, 56, 7, '#07080b', 0.4); }
        g.gable(4, 9, 58, 36, h, rise, { roof: '#59626f', wall: '#3e4553', ribs: 4 });
        for (const X of [10, 46]) { g.rect(X, yT + 0.9, 8, yR - yT - 0.9, A.shade(s.team, 0.1), A.FLAT); g.rect(X, yR, 8, yE - yR - 0.9, A.shade(s.team, -0.16), A.FLAT); }
        g.door(8, yE + 2, 21, h - 2, { lit: WARM, shut: 0.12 });
        g.door(37, yE + 2, 21, h - 2, { lit: WARM, shut: 0.78, slats: '#6a7382' });
        g.hazard(31, yE + 1.5, 4, h - 1.5, { step: 2 });
        g.at(h + rise, function () {
          const b = g.billboard(19, 27, 26, 9, { lift: 1 });
          g.glyph('wrench', b.x + 2.2, b.y + 1.3, 6, 6.4, '#ffd9a0', { w: 1 });
          g.glyph('gear', b.x + 10, b.y + 1.3, 6.4, 6.4, '#ffd9a0', { w: 0.8 });
          g.scribble(b.x + 18, b.y + 2.6, b.w - 20, 4, WARM, { seed: 31, lw: 0.9, rows: 2 });
          trim(g, s, b);
        });
        const lx = 79, ly = 27;
        g.rect(lx - 9, ly - 15, 18, 30, '#272c36', { lit: 0, bevel: -0.6, r: 1 });
        g.hazard(lx - 9, ly + 13, 18, 2, { step: 2 });
        for (const q of [[-8, -12], [8, -12]]) g.mast(lx + q[0], ly + q[1], 10, { w: 1.7, col: '#9aa3b5' });
        g.at(6, function () {
          g.rect(lx - 7, ly - 13, 3, 26, '#59616f', { lit: 0.1, lw: 0.4 }); g.rect(lx + 4, ly - 13, 3, 26, '#59616f', { lit: 0.1, lw: 0.4 });
          g.at(1.5, function () { g.car(lx, ly, 27, 13.5, s.team, { rot: -PI / 2, stripe: s.teamInk }); });
        });
        for (const q of [[-8, 12], [8, 12]]) g.mast(lx + q[0], ly + q[1], 10, { w: 1.7, col: '#9aa3b5' });
        g.tyre(68, 53, 3.4); g.tyre(74, 55.5, 3.4); g.at(2.5, function () { g.tyre(71, 53.6, 3.4); });
        g.drum(88, 54, 3, '#3f6f8f', 5); g.drum(84, 57.5, 2.8, '#8a4b2a', 5);
        g.crate(40, 52, 8, 6, 4, '#a3342f', { nx: 3 });
        g.pool(18, 50, 15, 8, WARM, 0.34);
        g.banner(W - 9, 8, 5.5, 9, s.team, { mark: 'wrench' });
      },
      anim: function (g, s) { sparks(g, 14 + 6 * A.hash01(Math.floor(s.t * 0.4) + s.seed, 1), 43, s.t + s.seed, '#cfe6ff'); },
      lights: function (g, s) { if (A.hash01(Math.floor((s.t + s.seed) * 14), 3) > 0.45) g.puff(17, 44, 12, '#bcdcff', 0.5); },
    },

    // ---- Ad Tower: one cell of footprint, a hijacked billboard screen high on a lattice mast
    adtower: {
      height: 46,
      base: function (g, s) {
        const W = s.W, H = s.H;
        slab(g, 3, 8, W - 6, H - 10, '#272d38');
        g.box(8, 15, 16, 11, 4, { roof: '#6a7486', wall: '#454d5c' });
        const cab = g.box(23, 19, 6, 6, 7, { roof: '#6b7384', wall: '#444b59' });
        g.led(cab.wall.x + 3, cab.wall.y + 2.4, MINT, 0.6);
        g.at(4, function () {
          g.mast(12.5, 21, 31, { w: 1.3 }); g.mast(19.5, 21, 31, { w: 1.3 });
          if (g.vis()) for (let i = 0; i < 4; i++) g.line(12.5, 19 - i * 5, 19.5, 16.5 - i * 5, '#59637a', 0.7);
          const b = g.billboard(-4, 22, 40, 17, { lift: 21, legs: 0, face: '#0a0e15', frame: '#3a4252' });
          g.screen(b.x + 2, b.y + 2, b.w - 4, b.h - 4, '#16202e', { a: 0.3, scan: false });
          g.glyph('eye', b.x + 4, b.y + 3.6, 12, 9.8, s.team, { w: 1.3, r: 3.4 });
          g.scribble(b.x + 19, b.y + 4.6, b.w - 23, 7.6, WARM, { seed: 41, lw: 1, rows: 3 });
          trim(g, s, b);
          band(g, s, b.x + 2, b.y + b.h, b.w - 4, 2.6);
          g.rect(b.x - 1, b.y - 2.2, 4.4, 2.6, '#6b7384', { r: 0.5, lw: 0.4 }); g.rect(b.x + b.w - 3.4, b.y - 2.2, 4.4, 2.6, '#6b7384', { r: 0.5, lw: 0.4 });
        });
      },
      anim: function (g, s) {
        const y = -18 + ((s.t * 7 + s.seed) % 11.6);
        g.rect(-2, y, 36, 1.3, '#ffffff', { alpha: 0.1 });
        if (Math.sin(s.t * 5 + s.seed) > 0) g.circle(16, -21, 1, '#ff5a36');
      },
      lights: function (g, s) {
        g.puff(16, -13, 21, s.team, 0.12 + 0.05 * Math.sin(s.t * 2.1 + s.seed));
        if (Math.sin(s.t * 5 + s.seed) > 0) g.puff(16, -21, 5, '#ff5a36', 0.7);
      },
    },
  });
})();
