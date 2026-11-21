'use strict';
// NEON TURF — curfew.art.js (presentation: the Curfew Company's hand-drawn art; needs js/art.js).
// Shape language: RECTILINEAR — boxes, chamfers, chevrons, stencil stripes, straight barrels. Olive drab,
// concrete, canvas, gunmetal under warm sodium light; civic vehicles pressed into service. Every defence
// keeps an oil-drum fire. Team colour: shoulder ends + one mark on the hat / prop (infantry), cab roofs, body
// stripes, roof bands, flags. SIGNATURE: the night watch carries torches — every Picket throws a short warm beam
// ahead of his rifle (live), so Curfew ground is a constellation of warm lights: drum fires, torches, embers.
// palette.hazard sits next to the default team amber: it only ever appears as thin black-striped bands.
(function () {
  const A = NT.Art, P = A.P, PI = Math.PI, TAU = PI * 2;
  const SODIUM = '#ffe2b0', FLAME = '#ff8a2a', FLAME_HI = '#ffe39a', BRASS = '#cfa957', CHALK = '#e8e4d6';
  const TIN = '#7f8996', ASH = '#2a2e36', VERDI = '#6fae96', NOFLASH = false;

  // ---- shared helpers ---------------------------------------------------------------------------------
  function slab(g, x, y, w, h, col) { g.rect(x, y, w, h, col || '#22272f', { lit: 0, bevel: -0.5, r: 1.2, ol: 'rgba(0,0,0,0.5)', lw: 0.5 }); }
  function stencil(g, x, y, w, h, col, seed) { g.scribble(x, y, w, h, col || 'rgba(232,228,214,0.55)', { seed: seed || 5, lw: 0.8, rows: Math.max(1, Math.round(h / 2.2)) }); }

  // BRACED mark: not drawn here. The renderer puts a ring of chevrons in the owner's colour under every braced
  // unit of any gang (render.js drawRings); art only adds what is physical (outriggers down, tripods).

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

  // ---- infantry, drawn locally: few LARGE masses (a pale tin hat, a squared shoulder block with team ends, one
  // exaggerated prop). The kit's humanoid is too slight for the Company at 1x. All figures face +x.
  const HELM = '#cfc7ad', HELM_HI = '#e9e3cd', BOOT = '#51483a', SKIN = '#c9966f', WOOD = '#9c7040', LENS = '#fff3cf', BEAM = '#ffcf85', GLARE = '#ffe6b4';
  function gait(s) { return s.moving ? Math.sin(s.walk * TAU) : 0; }
  function boots(g, sn, reach, fy, col) {
    g.ellipse(1 + sn * reach, -fy, 2.4, 1.8, col, { lit: 0.1, bevel: 0.6, lw: 0.5 });
    g.ellipse(1 - sn * reach, fy, 2.4, 1.8, col, { lit: 0.1, bevel: 0.6, lw: 0.5 });
  }
  // standing: two boots that stride; braced (kneel): rear shin flat on the ground, front knee up
  function legs(g, sn, kneel, cloth) {
    if (!kneel) { boots(g, sn, 3.3, 3, BOOT); return; }
    g.capsule(-2, 3.4, -6.4, 3.8, 1.6, cloth, { lw: 0.5 });
    g.ellipse(-7.4, 3.8, 2.1, 1.7, BOOT, { lit: 0.1, bevel: 0.6, lw: 0.5 });
    g.capsule(0, -3, 4.8, -3.8, 2, cloth, { lit: 0.1, lw: 0.5 });
    g.ellipse(5.9, -3.8, 2.5, 1.9, BOOT, { lit: 0.1, bevel: 0.6, lw: 0.5 });
  }
  // squared shoulder block (x0 .. x0 + d, +-hw) whose two ends are the owner's colour
  function shoulders(g, s, x0, d, hw, cloth, pad) {
    g.rect(x0, -hw, d, 2 * hw, cloth, { r: 1.7, lit: 0.16 });
    g.rect(x0, -hw, d, pad, s.team, { r: 1.5, lit: 0.2, lw: 0.3 });
    g.rect(x0, hw - pad, d, pad, s.team, { r: 1.5, lit: 0.2, lw: 0.3 });
  }
  function arm(g, x0, y0, x1, y1, r, sleeve, hand) {
    g.capsule(x0, y0, x1, y1, r, sleeve, { r1: r * 0.85, lit: 0.1, lw: 0.5 });
    g.circle(x1, y1, r * 0.82, hand || SKIN, { lit: 0.1, bevel: 0.6, lw: 0.4 });
  }
  // the warden's tin hat from above: wide pale brim, dome, a bold band in the owner's colour running fore and aft
  function tinHat(g, s, x, y, r) {
    g.circle(x, y, r, HELM, { lit: 0.22, lw: 0.6 });
    g.circle(x, y, r * 0.64, HELM_HI, { lit: 0.2, bevel: 0.7, ol: 'rgba(60,54,40,0.45)', lw: 0.25 });
    g.rect(x - r + 0.5, y - 1.15, 2 * r - 1, 2.3, s.team, { lit: 0.12, bevel: 0, ol: 'rgba(52,44,28,0.6)', lw: 0.3, r: 0.9 });
  }
  // THE COMPANY'S SIGNATURE — the night watch carries torches: a short warm cone thrown ahead of the lens.
  // The beam is painted in anim() (normal blending: it TINTS what it falls on, so a packed squad never burns out
  // to white the way stacked additive light does); only the small lens glare goes to the additive lights() pass.
  // k scales the brightness; ang swings the beam.
  function torchBeam(g, x, y, ang, k) {
    const c = Math.cos(ang), n = Math.sin(ang);
    g.puff(x + c * 5.5, y + n * 5.5, 4.6, BEAM, 0.4 * k);
    g.puff(x + c * 12, y + n * 12, 6.8, BEAM, 0.36 * k);
    g.puff(x + c * 19.5, y + n * 19.5, 9, BEAM, 0.26 * k);
  }
  function torchGlare(g, x, y, ang, k) { g.puff(x + Math.cos(ang) * 1.5, y + Math.sin(ang) * 1.5, 2.2, GLARE, 0.6 * k); }
  // the watch sweeps its beam while standing; it steadies on a shot and on the march
  function picketSweep(s) { return s.moving ? 0 : Math.sin(s.t * 0.8 + s.seed * 1.7) * 0.3 * (1 - s.fire); }
  // how bright a hand torch burns right now: surges under a boost, sputters when soaked / slowed
  function torchK(s) { return s.boost ? 1.3 : s.hinder ? (Math.sin(s.t * 23 + s.seed) > 0 ? 0.75 : 0.3) : 1; }

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
      height: 38,
      base: function (g, s) {
        const W = s.W, H = s.H, pal = s.pal;
        slab(g, 3, 24, W - 6, H - 27, '#2a2f37');
        g.gable(4, 6, W - 8, 22, 10, 4, { roof: TIN, wall: '#4e5560' });
        const yT = 6 - 10, yR = 6 + 11 - 10 - 4, yE = 6 + 22 - 10;
        for (const X of [12, W - 22]) { g.rect(X, yT + 0.9, 10, yR - yT - 0.9, A.shade(s.team, 0.08), A.FLAT); g.rect(X, yR, 10, yE - yR - 0.9, A.shade(s.team, -0.18), A.FLAT); }
        if (g.vis()) {                                                                     // corrugated tin: every rib has a lit and a shaded flank
          const c = g.ctx;
          c.fillStyle = 'rgba(0,0,0,0.16)'; c.fillRect(4.6, yR, W - 9.2, yE - yR - 0.6);              // the south pitch falls away from the light
          c.fillStyle = 'rgba(150,84,44,0.35)'; c.fillRect(31, yR + 3, 7.2, yE - yR - 3.6); c.fillRect(7.6, yT + 1, 2.4, 5);   // rust runs
          c.lineCap = 'butt'; c.lineWidth = 0.9;
          c.strokeStyle = 'rgba(255,255,255,0.26)'; c.beginPath();
          for (let X = 5.4; X < W - 5; X += 2.4) { c.moveTo(X, yT + 0.7); c.lineTo(X, yE - 0.5); }
          c.stroke();
          c.strokeStyle = 'rgba(0,0,0,0.34)'; c.beginPath();
          for (let X = 6.5; X < W - 5; X += 2.4) { c.moveTo(X, yT + 0.7); c.lineTo(X, yE - 0.5); }
          c.stroke();
          c.fillStyle = 'rgba(0,0,0,0.5)';                                                       // scalloped eave shadow on the wall
          for (let X = 4.6; X < W - 5.6; X += 2.4) c.fillRect(X, yE - 0.2, 1.3, 1.5);
        }
        g.rect(4.4, yR - 1.1, W - 8.8, 2.2, A.shade(TIN, 0.32), { r: 0.8, lit: 0.1, bevel: 0.8, lw: 0.35 });   // ridge cap
        g.door(W / 2 - 6, yE + 2, 12, 7, { lit: SODIUM, shut: 0.3 });
        for (let k = 0; k < 2; k++) {
          const x = k ? 34 : 7, y = 36, gb = g.box(x, y, 22, 14, 8, { roof: pal.drab, wall: pal.drabDark });
          g.vent(gb.x + 2, gb.y + 2, 8, gb.d - 4, { v: true, step: 1.6 });
          g.rect(gb.x + 11.5, gb.y + 2, 8.5, gb.d - 4, s.team, { r: 0.6, lit: 0.14, lw: 0.5 });
          g.vent(gb.wall.x + 2, gb.wall.y + 2, 9, gb.wall.h - 3.6, { step: 1.5 });
          g.led(gb.wall.x + 16, gb.wall.y + 4, '#ffb347', 0.75);
          g.at(8, function () {                                                             // tall exhaust stack with a rain cap
            g.stack(x + 4, y + 3, 2.5, 25, '#7a8394');
            g.at(8, function () { g.cyl(x + 4, y + 3, 2.9, 1.2, '#565e6c'); });
            g.at(17, function () { g.cyl(x + 4, y + 3, 2.9, 1.2, '#565e6c'); });
            g.at(26.5, function () { g.ellipse(x + 5.4, y + 3, 3.2, 2.5, '#9aa3b2', { lit: 0.2, lw: 0.5 }); });
          });
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
          const x = (k ? 38 : 11), y = 39 - 35, t = s.t * (s.powered ? 1.4 : 0.4) + k * 0.5 + s.seed;
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
          const x = 73.2 + i * 7, y = 14 + j * 13, cr = g.crate(x, y, 6.4, 8.6, 4, pal.drab, { nx: 1, ny: 1 });
          g.rect(cr.x + 0.7, cr.y + 0.7, 5, 7.2, '#0e1319', { lit: 0, bevel: -0.8, r: 0.5, lw: 0.3 });      // open bin ...
          const gp = g.rect(cr.x + 1, cr.y + 1, 4.4, 6.6, pal.glint, { r: 1.2, lit: 0.3, lw: 0.3 });       // ... heaped with Glint
          if (g.vis()) for (let n = 0; n < 4; n++) g.rect(cr.x + 1.3 + ((n * 7 + i * 3 + j) % 5) * 0.7, cr.y + 1.4 + n * 1.5, 1.3, 1.3, n % 2 ? '#ffffff' : A.shade(pal.glint, -0.28), A.FLAT);
          g.glow(gp, pal.glint, { r: 2.6, a: 0.7 });
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
      anim: function (g, s) { sparkle(g, 74, 9, 20, 22, s.t, s.seed % 7, 5); },
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

    // ---- Picket: the night watch. Tin warden hat with a team band, squared team shoulders, a service rifle with
    // a torch taped under the barrel (the beam is live: lights()). Braced = down on one knee.
    picket: {
      frames: 6, kick: 0.9, muzzle: [[13.8, 3.6]],
      body: function (g, s) {
        const pal = s.pal, sn = gait(s), dep = s.deployed, rc = -s.fire * 1.3, gy = 3.6;
        const lean = dep ? 0.4 : s.moving ? 0.18 + sn * 0.12 : 0.26, bx = dep ? -0.8 : 0, hw = 8, sy = hw - 2;
        legs(g, sn, dep, pal.drabDark);
        g.push(bx, 0, lean);
        g.rect(-5.8, -3.2, 3.6, 6.4, A.shade(pal.canvas, -0.22), { r: 1, lit: 0.12, lw: 0.5 });   // haversack
        shoulders(g, s, -3.3, 6.3, hw, pal.drab, 4.6);
        g.pop();
        const co = Math.cos(lean), si = Math.sin(lean);
        g.push(rc, 0);
        g.rect(3.6, gy + 0.7, 4.6, 2.7, '#737b8a', { r: 0.9, lit: 0.18, lw: 0.55 });         // the torch, taped beside the fore-end
        g.rect(7.4, gy + 0.9, 1.3, 2.3, LENS, A.FLAT);
        g.rect(7.6, gy - 0.9, 6, 1.8, '#a3acbb', { r: 0.4, lit: 0.16, lw: 0.6 });            // barrel
        g.rect(-3, gy - 1.5, 11.2, 3, WOOD, { r: 0.8, lit: 0.18, lw: 0.6 });                 // stock + wooden fore-end
        g.pop();
        arm(g, bx - sy * si, sy * co, 0.8 + rc, gy + 0.6, 1.6, pal.drab);                     // trigger hand
        arm(g, bx + sy * si, -sy * co, 5.6 + rc, gy - 0.9, 1.6, pal.drab);                    // left hand out on the fore-end
        tinHat(g, s, bx + (dep ? 1.6 : 0.4), dep ? 0 : -0.3, 3.9);
      },
      anim: function (g, s) { torchBeam(g, 9, 5.7, picketSweep(s), torchK(s)); },
      lights: function (g, s) { torchGlare(g, 9, 5.7, picketSweep(s), torchK(s)); },
    },

    // ---- Stovepipe: the old soldier. Khaki coat, grey hair gone thin on top, a FAT rocket tube on the right
    // shoulder, a pack with three spare rounds standing in it. Braced = kneeling. Firing: live backblast.
    stovepipe: {
      frames: 6, kick: 1.2, muzzle: [[12.6, 4.8]],
      body: function (g, s) {
        const pal = s.pal, sn = gait(s), dep = s.deployed, rc = -s.fire * 0.9, gy = 4.8, hw = 8.2, sy = hw - 2;
        const lean = dep ? 0.22 : s.moving ? sn * 0.12 : 0.1, bx = dep ? -0.8 : 0, coat = A.mix(pal.drab, pal.canvas, 0.5);
        legs(g, sn, dep, A.shade(coat, -0.3));
        g.push(bx, 0, lean);
        g.rect(-8, -6.2, 5.4, 9.8, s.team, { r: 1.2, lit: 0.16, lw: 0.55 });                    // pack under a team flap
        for (let i = 0; i < 3; i++) {                                                          // spare rounds, nose up
          g.circle(-5.3, -4.1 + i * 2.8, 1.35, '#d3d8e0', { lit: 0.25, lw: 0.4 });
          g.circle(-5.3, -4.1 + i * 2.8, 0.55, ASH, A.FLAT);
        }
        shoulders(g, s, -3.2, 6.2, hw, coat, 4.5);
        g.pop();
        const co = Math.cos(lean), si = Math.sin(lean);
        arm(g, bx + sy * si, -sy * co, 5.8 + rc, gy - 2.9, 1.6, coat);                        // left hand steadies the front
        // head tucked against the tube: grey hair, thin on top
        g.circle(bx + 0.6, -1.4, 3.4, '#d3d6dc', { lit: 0.2, lw: 0.6 });
        g.circle(bx + 0.2, -1.4, 1.6, SKIN, { lit: 0.1, bevel: 0.4, ol: false });
        g.push(rc, 0);
        g.rect(-9.6, gy - 2.7, 21, 5.4, A.shade(pal.drab, 0.14), { r: 1.2, lit: 0.22, lw: 0.65 });   // THE TUBE
        g.rect(-11.4, gy - 3.4, 3.2, 6.8, '#59606e', { r: 0.9, lit: 0.14, lw: 0.55 });            // flared breech
        g.rect(10.2, gy - 3.1, 2.4, 6.2, '#737b8a', { r: 0.7, lit: 0.14, lw: 0.55 });             // muzzle ring
        g.rect(2.6, gy - 2.7, 3.6, 5.4, s.team, { lit: 0.14, bevel: 0.5, lw: 0.3 });
        g.rect(-5, gy - 2.7, 1.5, 5.4, 'rgba(0,0,0,0.28)', A.FLAT);
        g.pop();
        g.circle(0.6 + rc, gy + 2.9, 1.3, SKIN, { lit: 0.1, bevel: 0.6, lw: 0.4 });              // trigger hand under the tube
      },
      anim: function (g, s) {                                                              // backblast smoke rolling out behind
        if (s.fire > 0.02) { const f = s.fire; g.puff(-15 - (1 - f) * 8, 4.8, 3.5 + (1 - f) * 6, '#d6dae2', 0.55 * f); }
      },
      lights: function (g, s) {                                                            // ... and its flare
        if (s.fire > 0.02) { const f = s.fire; g.puff(-12.5, 4.8, 2.5 + 3 * f, FLAME_HI, f); g.puff(-17, 4.8, 4 + 4 * f, FLAME, 0.8 * f); }
      },
    },

    // ---- Groundskeeper: the caretaker. Flat cap with a peak, long tweed coat with tails, a big brass ring of keys in
    // the left hand, a white first-aid satchel on the right hip with a bold cross in the owner's colour. Unarmed.
    groundskeeper: {
      frames: 6, flash: NOFLASH, muzzle: [[8.6, 4.2]],
      body: function (g, s) {
        const sn = gait(s), f = s.fire, hw = 7.4, coat = '#8a7658', cap = '#a8997c';
        boots(g, sn, 3.3, 2.9, BOOT);
        g.push(0, 0, sn * 0.1);
        g.poly([-8.2, -4.2 + sn * 0.8, -3, -hw, 2.9, -hw, 2.9, hw, -3, hw, -8.2, 4.2 + sn * 0.8], coat, { r: 1.6, lit: 0.16 });   // long coat, tails behind
        if (g.vis()) g.line(-8, sn * 0.8, -3.4, 0, 'rgba(0,0,0,0.35)', 0.7);                    // the vent between the tails
        if (g.vis()) g.line(-2.2, -5.4, 2.4, 5.6, '#e9e5d8', 1.2, { cap: 'butt' });             // satchel strap across the back
        g.pop();
        // first-aid satchel on the right hip
        g.rect(0.6, 4.6, 6.6, 6.2, '#f1efe6', { r: 1, lit: 0.1, lw: 0.6 });
        if (g.vis()) {
          g.rect(2.7, 5, 2.5, 5.4, 'rgba(30,32,40,0.5)', A.FLAT); g.rect(1.2, 6.45, 5.5, 2.5, 'rgba(30,32,40,0.5)', A.FLAT);
          g.rect(3, 5.3, 1.9, 4.8, s.team, A.FLAT); g.rect(1.5, 6.75, 4.9, 1.9, s.team, A.FLAT);
        }
        arm(g, 0.2, 5.4, 4 + sn * 1.6 + f * 4, 4.4 - f * 0.4, 1.55, coat);                      // right hand: reaches out to patch up
        // key ring in the left hand, swinging
        const hx = 4.4 - sn * 1.6, hy = -7, kx = hx + 2.2, ky = hy - 1.6 + sn * 0.5;
        arm(g, 0.2, -5.4, hx, hy, 1.55, coat);
        if (g.vis()) {
          g.stroke(P.circle(kx, ky, 2.5), '#1a1b1f', 2); g.stroke(P.circle(kx, ky, 2.5), BRASS, 1.1);
          for (let i = 0; i < 4; i++) {
            const a = -0.5 + i * 0.55 + sn * 0.3, c = Math.cos(a), n = Math.sin(a);
            g.line(kx + c * 2.5, ky + n * 2.5, kx + c * 5.2, ky + n * 5.2, '#1a1b1f', 1.9);
            g.line(kx + c * 2.5, ky + n * 2.5, kx + c * 5.2, ky + n * 5.2, i % 2 ? '#d9dee6' : BRASS, 1.1);
          }
        }
        g.push(0, 0, sn * 0.1);                                                              // team epaulettes over the arm roots
        g.rect(-3.3, -hw - 0.3, 6.2, 4.6, s.team, { r: 1.5, lit: 0.2, lw: 0.45 });
        g.rect(-3.3, hw - 4.3, 6.2, 4.6, s.team, { r: 1.5, lit: 0.2, lw: 0.45 });
        g.pop();
        // flat cap: wide soft crown in eight panels, a dark peak forward, a button on top
        g.rect(1.8, -2.9, 3.8, 5.8, A.shade(cap, -0.42), { r: 1.8, lit: 0.1, lw: 0.55 });
        g.ellipse(-0.1, 0, 3.6, 4.1, cap, { lit: 0.22, lw: 0.6 });
        if (g.vis()) {
          for (let i = 0; i < 4; i++) { const a = i * PI / 4 + 0.2; g.line(-0.1 - Math.cos(a) * 3.2, -Math.sin(a) * 3.7, -0.1 + Math.cos(a) * 3.2, Math.sin(a) * 3.7, 'rgba(40,34,24,0.3)', 0.5, { cap: 'butt' }); }
          g.circle(-0.1, 0, 0.9, A.shade(cap, -0.4), A.FLAT);
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
        if (g.vis()) { g.line(-12.5, -5.6, -18.4, -7.8, '#141619', 1.5); g.line(-12.5, -5.6, -18.4, -7.8, '#c3cad6', 0.8); }   // whip antenna ...
        g.poly([-18.6, -7.9, -22.4, -7.2, -19.6, -10.6], s.team, { lit: 0.1, bevel: 0, lw: 0.45 });   // ... flying a team pennant
        g.circle(-12.5, -5.6, 1.1, '#59616f', { lw: 0.35 });
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
      frames: 3, pivot: [6, 2.6], muzzle: [[11.6, 0]], recoil: 0.4, flash: NOFLASH,
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
        g.rect(-4.4, -3.4, 1.8, 6.8, s.team, { r: 0.7, lit: 0.14, lw: 0.45 });                    // the monitor's handle bar
        g.rect(-3.4, -0.8, 3, 1.6, '#59606e', A.FLAT);
        g.poly([0.5, -1.9, 7.6, -1.5, 7.6, 1.5, 0.5, 1.9], '#aab3c2', { lit: 0.22, lw: 0.55 });   // water cannon barrel
        g.poly([7.2, -1.7, 11.4, -2.6, 11.4, 2.6, 7.2, 1.7], BRASS, { lit: 0.25, lw: 0.55 });     // flared brass nozzle
        g.rect(10.6, -1.5, 1, 3, '#3a2c14', A.FLAT);
        g.circle(0, 0, 3, '#5d6472', { lit: 0.18, lw: 0.55 });                                // swivel
        g.circle(0, 0, 1.4, BRASS, { lit: 0.2, lw: 0.35 });
      },
    },

    // ---- Doorman: compact old tank — octagonal hull, round turret, long barrel, stowage, team chevron
    doorman: {
      frames: 3, pivot: [-1, 0], muzzle: [[20, 0]], recoil: 1.8,
      body: function (g, s) {
        const pal = s.pal;
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

    // ---- Mailman: mortar flatbed. DRIVING: slim truck, the fat tube lashed flat along the bed, sides up (team rails).
    // SET UP (s.deployed): four outriggers splayed, the drop-sides folded out flat (wide team panels), the tube
    // raised on its baseplate so you look straight down the bore.
    mailman: {
      frames: 3, kick: 0.6, muzzle: [[-3.6, 0]],
      body: function (g, s) {
        const pal = s.pal, dep = s.deployed, TUBE = '#9da6b5';
        if (dep) {
          for (const X of [0.4, -13.2]) for (let sd = -1; sd <= 1; sd += 2) {
            g.rect(X - 1, sd > 0 ? 6 : -13, 2, 7, '#7d8696', { lit: 0.1, lw: 0.45 });
            g.rect(X - 2.6, sd * 13.4 - 1.7, 5.2, 3.4, '#aab3c2', { r: 0.6, lit: 0.18, lw: 0.5 });
          }
        }
        wheels(g, [10, -3.5, -10.5], 14, 5.6, 3.3, s.walk);
        g.rect(-15.5, -7, 18, 14, '#4c535f', { r: 0.8, lit: 0.12 });
        g.panels(-15.5, -7, 18, 14, 3, 1, 'rgba(0,0,0,0.3)', 0.5);
        for (let sd = -1; sd <= 1; sd += 2) {
          if (dep) {                                                                       // drop-side folded out flat
            g.rect(-13.4, sd > 0 ? 6.6 : -10.4, 11.4, 3.8, s.team, { r: 0.5, lit: 0.14, lw: 0.5 });
            if (g.vis()) g.line(-13.2, sd * 7, -2.2, sd * 7, 'rgba(0,0,0,0.4)', 0.6, { cap: 'butt' });
          } else g.rect(-15.3, sd > 0 ? 4.6 : -7, 17.6, 2.4, s.team, { r: 0.3, lit: 0.1, lw: 0.4 });
        }
        g.rect(-15.6, -7, 2.2, 14, s.team, { r: 0.3, lit: 0.12, lw: 0.4 });                      // tail board
        cabPickup(g, s, 2.5, 15.5, 7, pal.drab);
        g.rect(10.6, -5.6, 2.6, 11.2, s.team, { r: 0.4, lit: 0.12, lw: 0.4 });                    // bonnet band
        if (dep) {
          for (let sd = -1; sd <= 1; sd += 2) {                                               // rounds laid out by the tail
            g.rect(-13, sd * 4.6 - 1.5, 4.6, 3, pal.canvas, { r: 0.4, lit: 0.1, lw: 0.4 });
            if (g.vis()) for (let i = 0; i < 3; i++) g.circle(-12 + i * 1.4, sd * 4.6, 0.6, BRASS, A.FLAT);
          }
          g.poly(ngon(-7.6, 0, 4.8, 8, PI / 8), '#5a606c', { lit: 0.18, lw: 0.6 });               // baseplate
          if (g.vis()) { g.line(-3.6, 0, -0.4, -3.8, '#c3cad6', 1); g.line(-3.6, 0, -0.4, 3.8, '#c3cad6', 1); }   // bipod
          g.capsule(-7.8, 0, -4, 0, 3.2, TUBE, { lit: 0.25, lw: 0.6 });                        // the tube, raised
          g.rect(-7.6, -3.2, 1.7, 6.4, s.team, { lit: 0.1, bevel: 0.4, lw: 0.3 });
          g.circle(-3.6, 0, 3.5, '#c3cad6', { lit: 0.2, lw: 0.55 });                           // muzzle, bore up
          g.circle(-3.6, 0, 2.2, '#0b0c10', { lit: 0, bevel: -0.6, ol: false });
        } else {
          g.rect(-0.6, -3.8, 2.6, 7.6, '#5a606c', { r: 0.6, lit: 0.16, lw: 0.5 });                // baseplate, folded behind the cab
          g.rect(-14.4, -2.8, 14.4, 5.6, TUBE, { r: 2.2, lit: 0.26, lw: 0.6 });                // the tube, lashed flat
          g.rect(-14.8, -3.1, 2, 6.2, '#5d6472', { r: 0.6, lw: 0.45 });                         // muzzle cap
          g.rect(-9.8, -2.8, 2.2, 5.6, s.team, { lit: 0.1, bevel: 0.4, lw: 0.3 });
          if (g.vis()) { g.rect(-5.4, -2.8, 1, 5.6, 'rgba(0,0,0,0.3)', A.FLAT); g.rect(-3.2, -2.8, 1, 5.6, 'rgba(0,0,0,0.3)', A.FLAT); }
        }
      },
    },

    // ---- Pigeon: a one-way racing drone. What you see is the CHARGE: a fat hazard-striped cylinder slung fore and
    // aft with a contact fuse on its nose; a small team hub, four big rotor blurs, a team tail plate. Live: a blinking
    // red tail light and a faint warm running light (a flight of them is a swarm of embers).
    pigeon: {
      frames: 3, fps: 24, height: 22, flash: NOFLASH, muzzle: [[11, 0]],
      body: function (g, s) {
        const c = g.ctx, R = 5.1, MX = 6.6, MY = 8.9, sp = s.walk * PI;
        for (let i = 0; i < 4; i++) {                                                        // H frame: the rotors stand clear of the charge
          const hx = i < 2 ? MX : -MX, hy = i % 2 ? MY : -MY;
          g.line(hx * 0.3, 0, hx, hy, '#15181f', 3, { cap: 'butt' }); g.line(hx * 0.3, 0, hx, hy, '#7d8696', 1.6, { cap: 'butt' });
        }
        g.rect(-12.2, -4.2, 2.6, 8.4, s.team, { r: 0.6, lit: 0.14, lw: 0.5 });                  // tail plate
        const ch = g.rect(-10.4, -3.6, 20.8, 7.2, s.pal.hazard, { r: 3.4, lit: 0.14, lw: 0.65 });   // THE CHARGE
        g.stripes(ch, [null, '#1b1d22'], 2.6, 0.5);
        g.rect(9.8, -1.6, 3, 3.2, '#cfd4dc', { r: 0.6, lit: 0.2, lw: 0.5 });                    // contact fuse
        for (let i = 0; i < 4; i++) {
          const hx = i < 2 ? MX : -MX, hy = i % 2 ? MY : -MY, b = sp + i * 0.9;
          g.circle(hx, hy, R, '#cfe0ff', { alpha: 0.3, lit: 0, bevel: 0, ol: '#eef4ff', lw: 0.35, outer: false });
          if (g.vis()) { c.strokeStyle = 'rgba(240,246,255,0.7)'; c.lineWidth = 1; c.lineCap = 'round'; c.beginPath(); c.moveTo(hx - Math.cos(b) * R * 0.9, hy - Math.sin(b) * R * 0.9); c.lineTo(hx + Math.cos(b) * R * 0.9, hy + Math.sin(b) * R * 0.9); c.stroke(); }
          g.circle(hx, hy, 1.9, s.team, { lit: 0.14, lw: 0.45 });
        }
        g.rect(-2.8, -4.4, 5.6, 8.8, s.team, { r: 1.3, lit: 0.2, lw: 0.6 });                    // hub strapped over the charge
        g.rect(0.4, -1.4, 1.9, 2.8, '#1a2230', { r: 0.6, lw: 0.35 });                           // camera
        g.circle(-12.6, 0, 1, '#7a1f1c', { lit: 0, bevel: 0, lw: 0.35 });                       // tail lamp (lit live)
      },
      lights: function (g, s) {
        g.puff(8.5, 0, 7.5, BEAM, 0.26);                                                   // warm running light under the nose
        if ((s.t * 1.9 + s.seed * 0.37) % 1 < 0.4) { g.puff(-12.6, 0, 5, '#ff3626', 0.95); g.puff(-12.6, 0, 1.6, '#ffd0c8', 1); }
      },
    },

    // ---- Monument: BIG memorial tank — wide tracks, angular turret, statue BRONZE (brown, with only thin verdigris
    // runs in the seams), fresh team paint slashed across it, the broken plinth slab still bolted to the rear deck
    monument: {
      frames: 3, pivot: [1, 0], muzzle: [[27, 0]], recoil: 2.4,
      body: function (g, s) {
        const pal = s.pal, BRONZE = '#7d5c38';
        g.tracks(40, 21, 6.4, s.walk, { col: '#2e3139' });
        g.hull(37, 22, BRONZE, { nose: 4, tail: 2.5, nw: 0.74, lit: 0.18 });
        if (g.vis()) {                                                                     // verdigris weeping from the seams
          for (const q of [[6, -10, 9, -7.2], [10.5, -10, 12, -8], [-4, 10, -1.5, 7.4], [2, 10, 3, 8.2], [13, 5, 15, 7.5]]) g.line(q[0], q[1], q[2], q[3], VERDI, 0.8);
          g.line(4, -8.6, 13, -8.6, 'rgba(0,0,0,0.3)', 0.5); g.line(-8, 8.6, 6, 8.6, 'rgba(0,0,0,0.3)', 0.5);
        }
        for (let sd = -1; sd <= 1; sd += 2) for (let i = 0; i < 2; i++) g.capsule(-6 + i * 8, sd * 7.2, -1.6 + i * 8, sd * 10.4, 1.3, s.team, { lit: 0.1, lw: 0.4 });
        g.rect(15.3, -6.6, 2.6, 13.2, s.team, { r: 0.4, lit: 0.12, lw: 0.45 });
        // broken plinth plate on the rear deck
        g.poly([-18.4, -7.5, -10, -7.5, -11.2, -3, -9.6, 0.6, -11.6, 4.2, -10.4, 7.5, -18.4, 7.5], pal.concrete, { lit: 0.14, lw: 0.55 });
        stencil(g, -17.2, -4.5, 5, 9, 'rgba(40,42,48,0.65)', 21);
        if (g.vis()) for (const q of [[-17.6, -6.6], [-17.6, 6.6], [-11, -6.6], [-11.2, 6.6]]) g.circle(q[0], q[1], 0.6, '#2a2e36', A.FLAT);
        g.vent(-8.5, -4, 3.5, 8, { v: true, step: 1.3 });
      },
      top: function (g, s) {
        const BRONZE = '#8a673f';
        g.barrel(8, 0, 19, 3.8, '#8c7a60', { brake: true, sleeve: 5 });
        g.barrel(8, 4.2, 4, 1.2, '#4a505c');
        g.poly([-10, -7.4, 3.5, -8.6, 9.5, -4.6, 9.5, 4.6, 3.5, 8.6, -10, 7.4, -12, 3.6, -12, -3.6], BRONZE, { r: 1, lit: 0.22 });
        if (g.vis()) {
          for (const q of [[1, -8, 3.5, -5.6], [5.5, -7, 6.6, -5], [-8, 7, -6.5, 4.6], [7.5, 3.4, 8.8, 5]]) g.line(q[0], q[1], q[2], q[3], VERDI, 0.8);
          g.lines([-9.6, -4.8, 2.6, -6.2, 7, -3], 'rgba(255,225,170,0.22)', 0.6);                    // polished edge, catching the light
        }
        g.capsule(-9, -5.6, 2, 6.2, 1.6, s.team, { lit: 0.12, lw: 0.4 });
        g.capsule(-4, -6.6, 6, 3.8, 1.4, s.team, { lit: 0.12, lw: 0.4 });
        g.hatch(-6, -2.5, 2.6, '#6a4e30');
        g.circle(3, 3.5, 1.6, '#5a4228', { lw: 0.4 });
      },
    },
  });
})();
