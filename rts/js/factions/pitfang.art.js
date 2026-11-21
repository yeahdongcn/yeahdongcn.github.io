'use strict';
// NEON TURF — art for PITFANG / 獠牙帮 (presentation; needs js/art.js).
// A prize-fight circuit that outgrew its basements. Shape language: ORGANIC — ovals, wedges, teeth, rings and
// octagons at odd angles, no clean right angles. Materials: oxblood hide, bone, bruise purple, rust, ragged tarp,
// chain-link. Team colour lives on wraps, tarps, painted rings and ropes, banners and collars. The rush lime
// (palette.rush) is a STATE CUE only: it appears in live lights() when a body is enraged (and on the Cookhouse
// serum vats, which the brief asks for) — never baked into a sprite.
// Gotchas: s.t is 0 in cached functions, so breathing / crows / fans / orbiting cylinders live in anim();
// fire = 1 is the widest pose of every unit (the measure pass sizes sprites from it).
(function () {
  const A = NT.Art, P = A.P, PI = Math.PI, TAU = PI * 2;
  const TAPE = '#f1ece0', STEEL = '#8d98ab', IRON = '#5d6573', CHAIN = '#a3acbb', GOLD = '#e8d27c', BRASS = '#c99a46';
  const CANVAS = '#a8987a', LAMP = '#fff1d0', WARM = '#ffd9a0', VAPOR = '#dfe6ef', CLAW = '#f6f1e4', REBAR = '#9a5634';

  // ------------------------------------------------------------------ helpers
  function swing(s) { return s.moving ? Math.sin(s.walk * TAU) : 0; }
  function ngon(cx, cy, r, n, rot) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (rot || 0) + i * TAU / n; pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    return pts;
  }
  function enraged(s) { const e = s.def.traits.enrage; return !!e && s.hp < e.below; }
  function slab(g, x, y, w, h, col) { g.rect(x, y, w, h, col || '#201c22', { lit: 0, bevel: -0.5, r: 3, ol: 'rgba(0,0,0,0.5)', lw: 0.5 }); }
  // three parallel claw gouges in concrete
  function scores(g, x, y, ang, len) {
    if (!g.vis()) return;
    const c = Math.cos(ang), s = Math.sin(ang), L = len || 7;
    for (let i = -1; i <= 1; i++) {
      const ox = -s * i * 1.6, oy = c * i * 1.6;
      g.line(x + ox, y + oy, x + ox + c * L, y + oy + s * L, 'rgba(0,0,0,0.55)', 0.8);
      g.line(x + ox + 0.5, y + oy + 0.5, x + ox + c * L + 0.5, y + oy + s * L + 0.5, 'rgba(255,240,225,0.12)', 0.5);
    }
  }
  function hairCap(g, hx, hr, col) {
    const p = new Path2D();
    p.arc(hx, 0, hr, PI * 0.42, PI * 1.58); p.closePath(); p.bb = [hx - hr, -hr, hr, 2 * hr];
    g.solid(p, col, { lit: 0.12, bevel: 0.6, ol: false });
  }
  // claw-arc slashes in front of an attacker (live overlay; fades with the recoil)
  function slash(g, s, x, r) {
    if (s.fire < 0.08) return;
    const c = g.ctx, a = c.globalAlpha;
    c.globalAlpha = a * Math.min(1, s.fire * 1.4);
    for (let i = -1; i <= 1; i++) {
      const p = new Path2D();
      p.arc(x - r, i * r * 0.42, r, -0.62, 0.62);
      g.stroke(p, CLAW, 0.9 - Math.abs(i) * 0.25);
    }
    c.globalAlpha = a;
  }
  // a single breath of vapour at the nose of an idle body (the "breathing" of the organic language)
  function breath(g, s, x, y, k) {
    if (s.moving) return;
    const p = (s.t * 0.55 + (s.seed % 7) * 0.13) % 1;
    if (p > 0.55) return;
    g.puff(x + p * 6 * (k || 1), y, (1.4 + p * 4) * (k || 1), VAPOR, 0.22 * (1 - p / 0.55));
  }
  // rebar: rust rod with ribs and a sharpened bright tip, along (x0, y0) -> (x1, y1)
  function rebar(g, x0, y0, x1, y1, w) {
    g.line(x0, y0, x1, y1, '#2a150e', w + 0.9, { cap: 'butt' });
    g.line(x0, y0, x1, y1, REBAR, w, { cap: 'butt' });
    const L = Math.hypot(x1 - x0, y1 - y0), ux = (x1 - x0) / L, uy = (y1 - y0) / L;
    g.poly([x1, y1 - w * 0.6, x1 + ux * 3.2, y1 + uy * 3.2, x1, y1 + w * 0.6], '#d9dee8', { lw: 0.35, lit: 0.2, bevel: 0 });
    if (!g.vis()) return;
    g.line(x0, y0 - w * 0.22, x1, y1 - w * 0.22, 'rgba(255,200,160,0.45)', w * 0.32, { cap: 'butt' });
    for (let t = 2; t < L - 1; t += 2.4) g.line(x0 + ux * t, y0 + uy * t - w * 0.5, x0 + ux * t + 0.4, y0 + uy * t + w * 0.5, 'rgba(0,0,0,0.35)', 0.4);
  }
  // the gang mark: two curved fangs hanging from a gum line
  function fangs(g, cx, cy, r, col) {
    g.poly([cx - r, cy - r * 0.62, cx + r, cy - r * 0.62, cx + r * 0.86, cy - r * 0.28, cx - r * 0.86, cy - r * 0.28], col, { r: r * 0.2, lit: 0, bevel: 0, lw: 0.4 });
    for (let k = -1; k <= 1; k += 2) g.poly([cx + k * r * 0.72, cy - r * 0.4, cx + k * r * 0.12, cy - r * 0.4, cx + k * r * 0.3, cy + r * 0.9], col, { r: r * 0.08, lit: 0, bevel: 0, lw: 0.4 });
  }
  // beaded chain between two points
  function chain(g, x0, y0, x1, y1, col) {
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.round(L / 1.6));
    g.line(x0, y0, x1, y1, '#20232b', 1.3);
    if (!g.vis()) return;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      g.ctx.fillStyle = i % 2 ? col || CHAIN : A.shade(col || CHAIN, -0.3);
      g.ctx.fillRect(x0 + (x1 - x0) * t - 0.5, y0 + (y1 - y0) * t - 0.5, 1, 1);
    }
  }

  // Top-down person facing +x. Organic: oval torso, round shoulders. Props go between torso and arms (prop) or
  // over the hands (over); under() is drawn before the torso (coat tails, capes, quivers).
  // o: { k, sw half shoulder span, td torso half depth, cloth, pad, sleeve, boot, feet, stride, ar arm radius,
  //      hr head radius, arms: [[side, hx, hy, fistR, fistCol, taped]], under, torso, prop, over, head(hx, hr) }
  function fig(g, s, o) {
    const sw = o.sw, td = o.td, sn = swing(s), st = s.moving ? (o.stride || 2.2) : 0, fy = o.feet || sw * 0.42;
    const boot = o.boot || '#3a2f35', skin = s.pal.skin, sleeve = o.sleeve || skin, ar = o.ar || 1.4, hr = o.hr || 2.8;
    g.push(0, 0, 0, o.k || 1);
    g.ellipse(0.9 + sn * st, -fy, 2.2, 1.5, boot, { lit: 0.08, bevel: 0.6, lw: 0.5 });
    g.ellipse(0.9 - sn * st, fy, 2.2, 1.5, boot, { lit: 0.08, bevel: 0.6, lw: 0.5 });
    g.push(0, 0, sn * 0.08);
    if (o.under) o.under(sn);
    g.ellipse(-0.3, 0, td, sw, o.cloth, { lit: 0.16 });
    if (o.torso) o.torso(sn);
    if (o.pad) for (let k = -1; k <= 1; k += 2) g.ellipse(-0.6, k * (sw - 1.9), td * 0.82, o.padR || 2.1, o.pad, { lit: 0.2, lw: 0.5 });
    if (o.prop) o.prop(sn);
    const arms = o.arms || [[-1, 2.2 - sn * 2.4, -(sw + 0.4), ar, skin], [1, 2.2 + sn * 2.4, sw + 0.4, ar, skin]];
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i], hx = a[1], hy = a[2], fr = a[3] || ar;
      g.capsule(0.2, a[0] * (sw - 1.4), hx, hy, ar, sleeve, { r1: ar * 0.85, lit: 0.1, lw: 0.55 });
      g.circle(hx, hy, fr, a[4] || skin, { lit: 0.16, bevel: 0.6, lw: 0.5 });
      if (a[5] && g.vis()) { g.line(hx - fr * 0.25, hy - fr * 0.85, hx - fr * 0.25, hy + fr * 0.85, 'rgba(80,66,58,0.55)', 0.45); g.line(hx + fr * 0.4, hy - fr * 0.7, hx + fr * 0.4, hy + fr * 0.7, 'rgba(80,66,58,0.4)', 0.4); }
    }
    if (o.over) o.over(sn);
    if (o.head) o.head(0.5, hr); else { g.circle(0.5, 0, hr, skin, { lit: 0.24 }); hairCap(g, 0.5, hr, '#2a1f22'); }
    g.pop(); g.pop();
  }

  // a leg of a beast: capsule hip -> paw with a hoof / paw blob
  function leg(g, x0, y0, x1, y1, w, col, foot) {
    g.capsule(x0, y0, x1, y1, w, col, { r1: w * 0.8, lit: 0.08, bevel: 0.6, lw: 0.55 });
    g.ellipse(x1, y1, w * 1.05, w * 0.9, foot || A.shade(col, -0.35), { lit: 0.1, lw: 0.45 });
  }
  // the lean chained fighting dog (Chain Post top): teardrop body with legs, facing +x from the stake
  function leanDog(g, s, lunge) {
    const fur = '#6b5a52', dk = A.shade(fur, -0.3), x = lunge ? 2 : 0;
    g.push(x, 0);
    const fx = lunge ? 3.4 : 1.6;
    leg(g, 9.5, -1.8, 10.5 + fx, -4.2, 0.95, dk); leg(g, 9.5, 1.8, 10.5 + fx, 4.2, 0.95, dk);
    leg(g, 3.4, -1.7, 2.2 - (lunge ? 1.6 : 0), -4.3, 0.95, dk); leg(g, 3.4, 1.7, 2.2 - (lunge ? 1.6 : 0), 4.3, 0.95, dk);
    g.capsule(2.4, 0, -1.4, lunge ? 0.6 : -1.2, 0.7, dk, { r1: 0.4, lw: 0.4 });
    g.blob([1.6, 0, 2.6, -2.4, 7, -3.2, 10.6, -2.6, 12, 0, 10.6, 2.6, 7, 3.2, 2.6, 2.4], fur, { lit: 0.18 });
    if (g.vis()) for (let i = 0; i < 3; i++) g.line(5.2 + i * 1.5, -2.1, 5.6 + i * 1.5, 2.1, 'rgba(233,226,207,0.35)', 0.45);
    g.rect(4.4, -1.5, 3.2, 3, s.team, { r: 1, lit: 0.14, lw: 0.4 });           // harness pad
    g.rect(10.2, -2.2, 1.4, 4.4, s.team, { r: 0.6, lit: 0.12, lw: 0.4 });       // collar
    for (let k = -1; k <= 1; k += 2) g.poly([12.2, k * 1.6, 11, k * 3.4, 13.2, k * 2.2], dk, { lw: 0.35, lit: 0.1 });
    g.capsule(12.2, 0, 15.6, 0, 1.9, A.shade(fur, 0.08), { r1: 1.1, lit: 0.18 });
    g.circle(16.2, 0, 0.6, '#1b1416', A.FLAT);
    if (lunge) for (let k = -1; k <= 1; k += 2) g.poly([15, k * 0.6, 16.8, k * 1.4, 15.4, k * 1.4], s.pal.bone, { lw: 0.3, lit: 0, bevel: 0 });
    g.pop();
  }

  NT.Art.define('pitfang', {
    // ======================================================================= BUILDINGS
    // ---- Broken Cage (HQ): octagonal fight cage, bars bent outward, team ring on the canvas, floodlights, trophies
    cage: {
      height: 40,
      base: function (g, s) {
        const W = s.W, H = s.H, cx = 48, cy = 50, R = 35, h = 13, z = 3;
        slab(g, 1, 3, W - 2, H - 5, '#231e24');
        scores(g, 8, 84, -0.5); scores(g, 82, 92, 0.3, 6); scores(g, 86, 30, 1.9, 6);
        const oct = ngon(cx, cy, R, 8, PI / 8);
        g.prism(oct, z, '#4a3a42', { wall: '#2c2128' });
        g.at(z, function () {
          g.poly(ngon(cx, cy, R - 2.4, 8, PI / 8), CANVAS, { lit: 0.08, bevel: -0.4 });
          if (g.vis()) { g.puff(cx - 14, cy + 9, 7, '#5a3a32', 0.35); g.puff(cx + 12, cy - 13, 5, '#5a3a32', 0.3); }
          g.solid(P.ring(cx, cy, 17, 26.5), s.team, { lit: 0.1, bevel: 0.4, lw: 0.4 });
          g.circle(cx, cy, 8, s.team, { lit: 0.14, bevel: 0.4, lw: 0.4 });
          fangs(g, cx, cy, 5.4, s.teamInk);
        });
        // cage: each side bulges outward at the top, as if something big hit it from inside
        const bend = [2, 5, 1.5, 3, 6, 2, 1, 4];
        const top = [];
        for (let i = 0; i < 8; i++) {
          const ax = oct[2 * i], ay = oct[2 * i + 1], dx = ax - cx, dy = ay - cy, d = Math.hypot(dx, dy), b = bend[i];
          top.push(ax + dx / d * b, ay + dy / d * b - h - z);
        }
        if (g.mode === 'shadow') g.fence(oct.concat(oct[0], oct[1]), { h: h + z });
        else if (g.vis()) {
          const c = g.ctx;
          for (let pass = 0; pass < 2; pass++) for (let i = 0; i < 8; i++) {
            const j = (i + 1) % 8, south = (oct[2 * i + 1] + oct[2 * j + 1]) / 2 > cy;
            if (south !== !!pass) continue;
            const mx = (top[2 * i] + top[2 * j]) / 2, my = (top[2 * i + 1] + top[2 * j + 1]) / 2, ddx = mx - cx, ddy = my + h + z - cy, dd = Math.hypot(ddx, ddy);
            const bx = mx + ddx / dd * bend[(i + 3) % 8] * 0.7, by = my + ddy / dd * bend[(i + 3) % 8] * 0.7;
            const pts = [oct[2 * i], oct[2 * i + 1] - z, oct[2 * j], oct[2 * j + 1] - z, top[2 * j], top[2 * j + 1], bx, by, top[2 * i], top[2 * i + 1]];
            const p = P.poly(pts);
            c.fillStyle = 'rgba(150,160,185,0.10)'; c.fill(p);
            g.mesh(p, { step: 2.4, col: 'rgba(190,198,216,0.32)', lw: 0.45 });
            g.lines([top[2 * i], top[2 * i + 1], bx, by, top[2 * j], top[2 * j + 1]], A.shade(s.team, -0.2), 1.8);
            g.lines([top[2 * i], top[2 * i + 1], bx, by, top[2 * j], top[2 * j + 1]], s.team, 1.1);
          }
          for (let i = 0; i < 8; i++) {
            g.line(oct[2 * i], oct[2 * i + 1] - z, top[2 * i], top[2 * i + 1], '#15171d', 2);
            g.line(oct[2 * i], oct[2 * i + 1] - z, top[2 * i], top[2 * i + 1], STEEL, 1.1);
            g.circle(top[2 * i], top[2 * i + 1], 1.3, s.teamHi, { lit: 0.2, lw: 0.4 });
          }
        }
        // trophy poles behind the cage
        for (const q of [[26, 9], [70, 8]]) {
          g.mast(q[0], q[1], 19, { w: 1.1, col: '#9aa3b5' });
          g.at(15, function () {
            g.line(q[0] - 5, q[1], q[0] + 5, q[1], '#2a2e38', 1.2);
            g.circle(q[0] - 3.4, q[1] + 2, 1.6, s.pal.bone, { lit: 0.25, lw: 0.4 });
            g.rect(q[0] + 1.6, q[1] + 0.6, 2.6, 4.4, GOLD, { r: 0.8, lit: 0.25, lw: 0.4 });
          });
        }
        // ticket booth with a team awning in the south-east corner
        const bt = g.box(76, 80, 16, 11, 8, { roof: '#3d3138', wall: '#2a2026' });
        g.windows(bt.wall.x + 3, bt.wall.y + 2, 9, 3, { cols: 2, rows: 1, lit: 1, col: WARM, a: 0.4 });
        g.awning(74, 89, 20, 4, { z: 7, slope: 1.5, cols: [s.team, s.teamDk], step: 3 });
        // floodlights on the three other corners, heads aimed at the canvas
        for (const q of [[6, 8, 0.8], [90, 8, 2.35], [6, 91, -0.8]]) {
          g.mast(q[0], q[1], 30, { w: 1.4, col: '#8b96aa' });
          g.at(30, function () {
            g.push(q[0], q[1], q[2]);
            g.rect(-1.6, -3.6, 3.2, 7.2, '#2c313c', { r: 0.8, lw: 0.5 });
            for (let k = -1; k <= 1; k++) g.lamp(1.4, k * 2.3, LAMP, { r: 0.85, reach: 7 });
            g.pop();
          });
        }
        g.pool(cx, cy, 30, 26, LAMP, 0.16);
        g.banner(37, H - 11, 6, 9, s.team, { mark: 'fang' }); g.banner(53, H - 11, 6, 9, s.team, { mark: 'fang' });
      },
      lights: function (g, s) {
        if (!s.powered) return;
        g.puff(48, 50, 30, LAMP, 0.07 + 0.02 * Math.sin(s.t * 1.3 + s.seed));
      },
    },

    // ---- Meat Locker (power): refrigerated container, compressor fan (anim), frost vents, hook rail, feed crate
    locker: {
      height: 22,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 13;
        slab(g, 2, 4, W - 4, H - 6);
        const r = g.box(5, 13, 38, 24, h, { roof: '#b8b2a2', wall: '#8a8576' });
        g.panels(r.x, r.y, r.w, r.d, 9, 1, 'rgba(0,0,0,0.18)', 0.5);
        g.panels(r.wall.x, r.wall.y, r.wall.w, r.wall.h, 12, 1, 'rgba(0,0,0,0.25)', 0.5);
        g.rect(r.x + 4, r.y + 3, r.w - 8, 8.5, s.team, { r: 1.5, lit: 0.12, bevel: 0.4, lw: 0.4 });
        g.rect(r.x + 4, r.y + 13.5, r.w - 8, 3, s.team, { r: 1, lit: 0.12, bevel: 0.4, lw: 0.4 });
        if (g.vis()) { g.puff(r.x + 30, r.y + 18, 5, s.pal.rust, 0.35); g.puff(r.wall.x + 8, r.wall.y + 9, 3, s.pal.rust, 0.4); }
        g.rect(r.wall.x + 2, r.wall.y + 3, 6, 6, s.team, { r: 0.6, lit: 0.1, lw: 0.4 });
        for (let i = 0; i < 2; i++) g.vent(r.wall.x + 14 + i * 9, r.wall.y + 4, 6, 4, { step: 1.3, slat: 'rgba(200,235,255,0.55)' });
        const cp = g.box(44, 14, 15, 21, 11, { roof: '#59616f', wall: '#3a414e' });
        g.circle(cp.x + 7.5, cp.y + 8, 5.6, '#14171d', { lit: 0, bevel: -0.9, lw: 0.6 });
        g.vent(cp.x + 2, cp.y + 15.5, 11, 4, { step: 1.2 });
        g.led(cp.wall.x + 12, cp.wall.y + 3, '#9fe7ff', 0.6);
        // hook rail with hanging carcasses on the south side
        for (const X of [8, 38]) g.mast(X, 52, 11, { w: 1, col: '#8b96aa' });
        g.at(11, function () { g.line(8, 52, 38, 52, '#2a2e38', 1.4); });
        for (let i = 0; i < 4; i++) {
          const X = 12.5 + i * 7;
          g.at(10, function () { g.line(X, 52, X, 53.6, '#c3ccdb', 0.6); });
          g.at(3, function () {
            g.ellipse(X, 52, 2.2, 3.2, A.shade(s.pal.meat, -0.38), { lit: 0.18, lw: 0.4 });
            g.rect(X - 0.6, 48.6, 1.2, 2, s.pal.bone, { r: 0.5, lit: 0.1, lw: 0.3, bevel: 0 });
          });
        }
        g.crate(46, 47, 11, 9, 5, '#7a5638', { nx: 2, strap: '#3a2f28' });
        g.at(5, function () { for (let i = 0; i < 4; i++) g.circle(48.5 + (i % 2) * 5, 47.5 + (i >> 1) * 3.5, 1.4, '#c9b27a', { lit: 0.2, lw: 0.3 }); });
      },
      anim: function (g, s) {
        const t = s.t + s.seed * 0.7, a = s.powered ? t * 9 : 0;
        for (let k = 0; k < 3; k++) {
          const b = a + k * TAU / 3;
          g.line(51.5, 11, 51.5 + Math.cos(b) * 5, 11 + Math.sin(b) * 5, '#8d98ab', 1.4);
        }
        if (!s.powered) return;
        const p = (t * 0.4) % 1;
        g.puff(26 + p * 5, 30 - p * 6, 2 + p * 4, '#e6f6ff', 0.3 * (1 - p));
      },
    },

    // ---- Sweatbox (infantry): cage gym — chain-link walls, rusted plates, bag frame under a half-open team tarp
    sweatbox: {
      height: 26,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 13;
        slab(g, 2, 3, W - 4, H - 5, '#1c191e');
        g.rect(6, 9, W - 12, H - 16, '#2b2529', { lit: 0, bevel: -0.5, r: 1 });
        if (g.vis()) for (let i = 1; i < 5; i++) g.line(6 + i * 10.4, 9, 6 + i * 10.4, H - 7, 'rgba(0,0,0,0.25)', 0.6);
        // weights: plates + barbell on a rack, a bench
        g.rect(10, 38, 4, 12, '#5d4a3e', { r: 1, lw: 0.4 });
        g.line(30, 44, 50, 44, '#aab4c6', 1);
        for (const X of [31, 49]) g.circle(X, 44, 3.4, s.pal.rust, { lit: 0.2, lw: 0.5 });
        for (const q of [[13, 24], [17, 27], [12, 29.5]]) { g.circle(q[0], q[1], 2.6, A.shade(s.pal.rust, -0.15), { lit: 0.2, lw: 0.45 }); g.circle(q[0], q[1], 0.8, '#1a1416', A.FLAT); }
        // punching-bag frame
        g.mast(37, 22, 12, { w: 1, col: '#7b8496' }); g.mast(49, 22, 12, { w: 1, col: '#7b8496' });
        g.at(12, function () { g.line(37, 22, 49, 22, '#59616f', 1.2); });
        g.at(5, function () { g.cyl(43, 23, 2.6, 6, '#7a2f36', { bands: 1, top: '#8c3a40' }); });
        // corner pads in team colour on the four posts, chain-link walls
        g.fence([4, 6, W - 4, 6], { h: h });
        g.at(h, function () { g.tarp(4, 4, 30, 25, A.shade(s.team, -0.12), { seed: 5, folds: 2 }); g.tarp(32, 5, 28, 12, A.shade(s.team, -0.25), { seed: 9, folds: 1 }); });
        g.fence([4, 6, 4, H - 6, W - 4, H - 6, W - 4, 6], { h: h });
        for (const q of [[4, 6], [W - 4, 6], [4, H - 6], [W - 4, H - 6]]) g.cyl(q[0], q[1], 2.4, h + 1, s.team, { top: s.teamHi, wall: s.teamLo, bands: 2 });
        g.door(26, H - 6 - 9, 12, 8.5, { lit: WARM, frame: '#3a3036' });
        g.rect(9, H - 6 - 9, 11, 6, '#141619', { lit: 0, bevel: 0.4, lw: 0.5 });
        g.scribble(10, H - 14.4, 9, 4.6, 'rgba(240,236,224,0.7)', { seed: 4, lw: 0.6, rows: 3 });
        g.banner(W - 15, H - 15, 5, 8, s.team, { mark: 'fang' });
      },
    },

    // ---- Weigh-In (dropoff): platform scale with a dial, feed trough, glint sacks, the fence's stall with an awning
    weighin: {
      height: 26,
      base: function (g, s) {
        const W = s.W, H = s.H;
        slab(g, 2, 3, W - 4, H - 5);
        const pl = g.box(6, 14, 46, 32, 2.5, { roof: '#59616f', wall: '#2e333d' });
        g.mesh(P.rect(pl.x + 2, pl.y + 2, pl.w - 4, pl.d - 4), { step: 2.6, col: 'rgba(200,210,230,0.18)', lw: 0.5 });
        g.stripes(P.rect(pl.x, pl.y, pl.w, 2.2), [s.team, '#16181d'], 2.6, 0.8);
        g.stripes(P.rect(pl.x, pl.y + pl.d - 2.2, pl.w, 2.2), [s.team, '#16181d'], 2.6, 0.8);
        // the dial on its post at the north edge of the platform
        g.mast(29, 13, 14, { w: 1.6, col: '#7b8496' });
        g.at(14, function () {
          g.circle(29, 9, 6.4, '#2a2e38', { lit: 0.12, lw: 0.6 });
          g.circle(29, 9, 5.2, s.pal.bone, { lit: 0.1, bevel: -0.4, lw: 0.4 });
          if (g.vis()) for (let i = 0; i < 10; i++) { const a = PI * 0.8 + i * PI * 1.4 / 9; g.line(29 + Math.cos(a) * 4, 9 + Math.sin(a) * 4, 29 + Math.cos(a) * 4.8, 9 + Math.sin(a) * 4.8, '#2a2e38', 0.5); }
          g.line(29, 9, 32, 6.4, '#c3263c', 0.8);
          g.circle(29, 9, 0.9, '#2a2e38', A.FLAT);
        });
        // feed trough
        g.tank(8, 54, 30, 54, 3.2, '#6b5a45', { bands: 2 });
        g.at(3, function () { g.rect(9, 52.6, 20, 2.4, '#3a3024', { r: 1, lit: 0, bevel: -0.6, lw: 0.3 }); });
        // glint sacks
        for (const q of [[40, 54, 0], [46, 56, 1], [43, 50, 2]]) {
          g.blob([q[0] - 3.4, q[1] + 2, q[0] - 3, q[1] - 2.6, q[0], q[1] - 3.6, q[0] + 3.2, q[1] - 2.4, q[0] + 3.4, q[1] + 2.2], CANVAS, { lit: 0.2 });
          g.circle(q[0], q[1] - 1, 1.5, s.pal.glint, { lit: 0.3, lw: 0.3 });
        }
        g.glow(P.circle(43, 52, 6), s.pal.glint, { r: 3, a: 0.35 });
        // the fence's stall
        const st = g.box(60, 10, 30, 24, 12, { roof: '#3d3138', wall: '#2a2026', lip: 1.5 });
        g.ac(st.x + 18, st.y + 6, 7, 5);
        g.windows(st.wall.x + 3, st.wall.y + 3, st.wall.w - 6, 4, { cols: 3, rows: 1, lit: 0.8, col: WARM, a: 0.4 });
        g.box(60, 40, 30, 6, 4, { roof: '#6b5a45', wall: '#3d3026' });
        g.at(4, function () { g.rect(66, 34.5, 5, 3.6, s.pal.bone, { r: 0.4, lw: 0.3 }); g.circle(80, 36, 1.6, GOLD, { lit: 0.3, lw: 0.3 }); });
        g.awning(58, 34, 34, 10, { z: 10, slope: 2, cols: [s.team, s.teamDk], step: 3.4, posts: true });
        g.string([4, 4, 9, 50, 6, 11, 92, 6, 13], { n: 9, flags: true, cols: [s.team, s.pal.bone], sag: 1.6, wire: 'rgba(150,160,180,0.35)' });
        for (let i = 0; i < 3; i++) g.lamp(64 + i * 11, 47.5, WARM, { r: 1, reach: 6, a: 0.6 });
      },
      anim: function (g, s) {
        const k = Math.floor(s.t * 3 + s.seed), i = k % 3, q = [[40, 52], [46, 54], [43, 48]][i];
        if (A.hash01(k, 5) > 0.5) g.puff(q[0], q[1] - 2, 1.8, '#ffffff', 0.7);
      },
    },

    // ---- Beast Pens (heavy): rows of reinforced stalls under a ragged team tarp, drip lines, south gate
    pens: {
      height: 30,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 10, z = 21;
        slab(g, 1, 3, W - 2, H - 5, '#211d22');
        scores(g, 10, 88, -0.4); scores(g, 64, 90, 0.2, 6); scores(g, 84, 86, -1.1, 5);
        const r = g.box(5, 16, W - 10, 62, h, { roof: '#3a3238', wall: '#4d4249' });
        // stall dividers and gate on the south wall
        if (g.vis()) for (let i = 1; i < 6; i++) g.line(r.x + i * r.w / 6, r.y + 2, r.x + i * r.w / 6, r.y + r.d - 2, '#1d181c', 1.6);
        for (let i = 0; i < 6; i++) {
          if (i === 2 || i === 3) continue;
          const X = r.wall.x + 2 + i * r.w / 6;
          g.rect(X, r.wall.y + 2, r.w / 6 - 4, 6, '#0d0c10', { lit: 0, bevel: -0.5, lw: 0.4 });
          g.mesh(P.rect(X, r.wall.y + 2, r.w / 6 - 4, 6), { step: 1.6, ang: 0, cross: false, col: '#8a94a8', lw: 0.6 });
        }
        g.door(W / 2 - 11, r.wall.y + 1.5, 22, h - 1.5, { frame: '#3a3036', shut: 0 });
        g.mesh(P.rect(W / 2 - 11, r.wall.y + 1.5, 22, h - 1.5), { step: 2, ang: 0, cross: false, col: s.teamHi, lw: 0.8 });
        g.line(W / 2, r.wall.y + 1.5, W / 2, r.wall.y + h, s.team, 1.2);
        // scaffold posts and the ragged tarp
        for (const X of [6, 48, 90]) for (const Y of [12, 74]) g.mast(X, Y, z, { w: 1.1, col: '#8b96aa' });
        // a horned animal in a stall, seen through the gaps
        g.at(h, function () {
          g.ellipse(46, 45, 6, 4, '#5a2e32', { lit: 0.2, lw: 0.5 });
          for (let k = -1; k <= 1; k += 2) g.capsule(51, 45 + k * 2, 52.6, 45 + k * 5, 0.8, s.pal.bone, { r1: 0.4, lw: 0.35 });
          g.circle(51.4, 45, 2.2, '#6a3a3c', { lit: 0.2, lw: 0.4 });
        });
        g.at(z, function () {
          const tp = function (x, y, w, d, rot, col, sd) { g.push(x + w / 2, y + d / 2, rot); g.tarp(-w / 2, -d / 2, w, d, col, { seed: sd, folds: 2 }); g.pop(); };
          tp(3, 9, 42, 33, -0.05, s.team, 11); tp(47, 7, 45, 36, 0.04, A.shade(s.team, -0.14), 17);
          tp(4, 46, 36, 28, 0.06, A.shade(s.team, -0.26), 23); tp(56, 47, 36, 26, -0.035, A.shade(s.team, -0.08), 29);
          tp(64, 52, 16, 12, 0.2, s.pal.tarp, 3);
          g.poly([45, 9, 49, 8, 47.5, 14], A.shade(s.team, 0.25), { lit: 0.1, lw: 0.4 });
          g.poly([40, 72, 44, 74, 39, 76], A.shade(s.team, 0.15), { lit: 0.1, lw: 0.4 });
          g.blob([20, 22, 26, 19, 29, 25, 24, 29, 19, 27], '#0f0d11', { lit: 0, bevel: -0.6, lw: 0.4 });
          if (g.vis()) {
            for (const q of [[6, 12, 4, 10], [48, 12, 47, 8], [90, 12, 91, 8], [6, 74, 5, 73], [48, 74, 40, 73], [90, 74, 91, 72]]) g.line(q[0], q[1], q[2], q[3], 'rgba(220,210,190,0.6)', 0.5);
            g.line(2, 44, 94, 44, '#6a6450', 1);
          }
        });
        g.pool(W / 2, r.wall.y + h + 4, 16, 6, WARM, 0.25);
        g.lamp(W / 2 - 14, r.wall.y + 2, WARM, { r: 1.1, reach: 8 }); g.lamp(W / 2 + 14, r.wall.y + 2, WARM, { r: 1.1, reach: 8 });
        g.drum(10, 88, 3.2, '#5a6b74', 5); g.drum(16, 90, 3, s.pal.rust, 5);
        g.tank(70, 87, 90, 87, 2.6, '#6b5a45', { bands: 1 });
      },
      anim: function (g, s) {
        for (let k = 0; k < 3; k++) {
          const p = (s.t * 0.9 + k * 0.37 + s.seed * 0.13) % 1, X = [12, 47, 86][k], Y = 76 - 20 + p * 20;
          g.rect(X, Y, 0.7, 1.6, '#9fc4dd', { alpha: 0.7 * (1 - p) });
        }
      },
    },

    // ---- Crow's Nest (radar): scaffold tower, crow loft on top, perches, crows circling, lookout lamp
    crowsnest: {
      height: 40,
      base: function (g, s) {
        const W = s.W, H = s.H, z = 26;
        slab(g, 3, 5, W - 6, H - 8);
        const L = [[17, 22], [47, 22], [17, 52], [47, 52]];
        for (let i = 0; i < 2; i++) g.mast(L[i][0], L[i][1], z, { w: 1.4, col: '#8b96aa' });
        if (g.vis()) for (let lv = 1; lv <= 3; lv++) {
          const dz = lv * z / 4;
          g.line(17, 52 - dz, 47, 52 - dz, '#6b7488', 0.8);
          g.line(17, 52 - dz, 47, 52 - dz - z / 4, '#59637a', 0.6);
        }
        g.crate(23, 46, 8, 6, 4, '#7a5638'); g.drum(40, 50, 2.6, s.pal.rust, 4);
        for (let i = 2; i < 4; i++) g.mast(L[i][0], L[i][1], z, { w: 1.4, col: '#8b96aa' });
        g.at(z, function () {
          g.rect(13, 18, 38, 38, '#6a5a48', { r: 1.5, lit: 0.12 });
          g.panels(13, 18, 38, 38, 1, 8, 'rgba(0,0,0,0.3)', 0.5);
          const lf = g.box(19, 22, 26, 20, 7, { roof: '#5a4a3c', wall: '#4a3c30' });
          g.mesh(P.rect(lf.wall.x + 1, lf.wall.y + 1, lf.wall.w - 2, lf.wall.h - 2), { step: 1.6, ang: PI / 2, cross: false, col: 'rgba(20,16,14,0.7)', lw: 0.7 });
          g.gable(19, 22, 26, 20, 7, 4, { roof: s.team, wall: '#4a3c30', ribs: 3 });
          g.mast(14, 54, 7, { w: 0.9, col: '#aab4c6' }); g.mast(50, 54, 7, { w: 0.9, col: '#aab4c6' });
          g.at(7, function () { g.line(10, 54, 18, 54, '#8a6a48', 1); g.line(46, 54, 54, 54, '#8a6a48', 1); });
          g.flag(48, 20, 14, s.team, { len: 8, drop: 5 });
          g.lamp(15, 20, LAMP, { r: 1.3, reach: 10 });
        });
        g.banner(26, 40, 6, 10, s.team, { mark: 'eye' });
      },
      anim: function (g, s) {
        const t = s.t * 0.9 + s.seed;
        for (let k = 0; k < 3; k++) {
          const a = t * (k % 2 ? -0.8 : 0.7) + k * 2.1, R = 13 + k * 4, x = 32 + Math.cos(a) * R, y = -8 + Math.sin(a) * R * 0.55 - k * 3;
          const d = a + (k % 2 ? -PI / 2 : PI / 2), f = 1.6 + Math.sin(s.t * 9 + k) * 0.8, c = Math.cos(d), sn = Math.sin(d);
          g.poly([x + c * 1.6, y + sn * 1.6, x - sn * 3 * f / 2 - c, y + c * 3 * f / 2 - sn, x - c * 0.4, y - sn * 0.4, x + sn * 3 * f / 2 - c, y - c * 3 * f / 2 - sn], '#262430', { ol: '#9a9cac', lw: 0.35 });
        }
      },
      lights: function (g, s) {
        if (!s.powered) return;
        g.puff(15, -6, 12, LAMP, 0.18 + 0.06 * Math.sin(s.t * 2 + s.seed));
      },
    },

    // ---- Cookhouse (tech): noodle-kitchen roof, steaming pots and serum vats, extractor hoods, team awning
    cookhouse: {
      height: 30,
      base: function (g, s) {
        const W = s.W, H = s.H, h = 12;
        slab(g, 2, 4, W - 4, H - 6);
        const r = g.box(5, 8, W - 10, 36, h, { roof: '#3a3438', wall: '#5a4038', lip: 2 });
        g.windows(r.wall.x + 4, r.wall.y + 2.5, 30, 4, { cols: 4, rows: 1, lit: 1, col: WARM, a: 0.45 });
        g.door(W - 30, r.wall.y + 2.5, 10, h - 2.5, { lit: WARM });
        g.at(h, function () {
          g.rect(9, 9, 12, 30, s.team, { r: 1.4, lit: 0.12, bevel: 0.4, lw: 0.4 });
          for (const q of [[30, 18, 6.2], [46, 18, 6.2]]) { g.cyl(q[0], q[1], q[2], 5, '#9aa3b5', { bands: 1 }); g.circle(q[0], q[1] - 5, q[2] - 1.4, '#3a2a20', { lit: 0, bevel: -0.8, ol: false }); g.circle(q[0] - 1, q[1] - 6, q[2] - 3, '#c9a066', { lit: 0, bevel: 0, ol: false, alpha: 0.6 }); }
          for (const q of [[64, 16], [76, 16]]) { g.cyl(q[0], q[1], 4.6, 9, '#4a5a52', { bands: 2, wall: '#2e3a34' }); g.circle(q[0], q[1] - 9, 3.2, '#1a2a1c', { lit: 0, bevel: -0.8, ol: false }); }
          g.pipe([64, 7, 70, 4, 76, 7], 1.2, '#7b8496');
          const hd = g.box(28, 30, 28, 8, 3, { roof: '#6b7384', wall: '#474e5c' });
          g.vent(hd.x + 2, hd.y + 2, hd.w - 4, 4, { step: 1.3 });
          g.stack(84, 34, 2.2, 8, '#6b7384');
        });
        const b = g.billboard(12, 46, 22, 8, { lift: 2 });
        g.glyph('bowl', b.x + 2, b.y + 1.2, 6, 5.6, WARM, { w: 0.9 });
        g.scribble(b.x + 10, b.y + 2.2, b.w - 12, 3.6, '#ffe2b0', { seed: 13, lw: 0.8, rows: 2 });
        g.awning(40, 44, 34, 8, { z: 8, slope: 2, cols: [s.team, s.teamDk], step: 3.6 });
        for (let i = 0; i < 4; i++) g.lamp(43 + i * 9.4, 47, '#ffb45a', { r: 1.2, reach: 6, a: 0.7 });
        g.crate(80, 50, 9, 7, 5, '#7a5638');
        g.drum(10, 55, 3, s.pal.rust, 5);
      },
      anim: function (g, s) {
        const t = s.t + s.seed * 0.37;
        A.steam(g, 30, 1, t, '#e6edf6', 3, 16); A.steam(g, 46, 1, t + 0.5, '#e6edf6', 3, 16);
      },
      lights: function (g, s) {
        if (!s.powered) return;
        const k = 0.35 + 0.1 * Math.sin(s.t * 2.3 + s.seed);
        g.puff(64, 7, 6, s.pal.rush, k); g.puff(76, 7, 6, s.pal.rush, k * 0.9);
      },
    },

    // ---- Prize Pit (super): boxing ring with team ropes inside a round pit of terraced seats, four stadium lights
    prizepit: {
      height: 42,
      base: function (g, s) {
        const W = s.W, H = s.H, cx = 48, cy = 50;
        slab(g, 1, 3, W - 2, H - 5, '#1e1a20');
        const rings = [[45, '#4a4248'], [39, '#3c353b'], [33, '#312b31'], [27, '#262126']];
        for (let i = 0; i < rings.length; i++) {
          g.circle(cx, cy, rings[i][0], rings[i][1], { lit: 0.06, bevel: i ? -0.6 : 0.4, lw: 0.6 });
          if (g.vis() && i < 3) {
            const R = rings[i][0] - 3, n = Math.round(R * 1.6);
            for (let k = 0; k < n; k++) {
              if (A.hash01(k, i * 7 + 3) < 0.35) continue;
              const a = k * TAU / n, x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R, hh = A.hash01(k, i);
              g.ctx.fillStyle = hh > 0.85 ? s.teamHi : hh > 0.5 ? '#c9a07c' : hh > 0.25 ? '#6e5c58' : '#8a7a70';
              g.ctx.beginPath(); g.ctx.arc(x, y, 1.05, 0, TAU); g.ctx.fill();
            }
          }
        }
        // team sections of seats
        for (let k = 0; k < 4; k++) g.solid(P.ring(cx, cy, 33.5, 44.5, k * PI / 2 + PI / 4 - 0.22, k * PI / 2 + PI / 4 + 0.22), s.team, { lit: 0.08, bevel: 0.3, lw: 0.4 });
        // the ring: apron, canvas, posts, ropes
        const rg = g.box(cx - 17, cy - 15, 34, 34, 5, { roof: '#d7cdb2', wall: s.teamLo });
        g.rect(rg.x + 2.5, rg.y + 2.5, rg.w - 5, rg.d - 5, CANVAS, { lit: 0.06, bevel: -0.3, r: 0.5 });
        if (g.vis()) g.stroke(A.glyphPath('crown', cx - 6, cy - 6 - 5, 12, 10), s.team, 1.3);
        const px = [rg.x + 1.5, rg.x + rg.w - 1.5], py = [rg.y + 1.5, rg.y + rg.d - 1.5];
        for (let lv = 1; lv <= 3; lv++) g.at(lv * 2, function () {
          g.lines([px[0], py[0], px[1], py[0], px[1], py[1], px[0], py[1]], A.shade(s.team, -0.4), 1.4, { close: true });
          g.lines([px[0], py[0], px[1], py[0], px[1], py[1], px[0], py[1]], s.team, 0.8, { close: true });
        });
        for (const X of px) for (const Y of py) g.cyl(X, Y, 1.5, 7, '#c3ccdb', { top: s.teamHi });
        // stadium lights on the corners
        for (const q of [[5, 6, 0.8], [91, 6, 2.35], [5, 92, -0.8], [91, 92, -2.35]]) {
          g.mast(q[0], q[1], 34, { w: 1.6, col: '#8b96aa' });
          g.at(34, function () {
            g.push(q[0], q[1], q[2]);
            g.rect(-2.4, -4.2, 4.6, 8.4, '#262b35', { r: 0.8, lw: 0.5 });
            for (let k = 0; k < 4; k++) g.lamp(0.8, -3 + k * 2, LAMP, { r: 0.75, reach: 6 });
            g.pop();
          });
        }
        g.pool(cx, cy, 26, 24, LAMP, 0.28);
        g.banner(cx - 4, 2, 8, 9, s.team, { mark: 'crown' });
      },
      lights: function (g, s) {
        if (!s.powered) return;
        g.puff(48, 48, 22, LAMP, 0.1 + 0.03 * Math.sin(s.t * 1.7 + s.seed));
        if (s.active) g.puff(48, 48, 14, s.team, 0.12 + 0.08 * Math.sin(s.t * 6));
      },
    },

    // ---- Chain Post (defence): a stake, a worn circle painted at the chain's reach, a lean dog on the chain (top)
    chainpost: {
      height: 10, pivot: [16, 16], recoil: -0.6, muzzle: [[15.4, 0]], flash: false,
      base: function (g, s) {
        g.circle(16, 16, 15.6, '#2a2420', { lit: 0, bevel: -0.4, lw: 0.5 });
        g.circle(16, 16, 12, '#3a2f28', { lit: 0, bevel: -0.5, ol: false });
        g.solid(P.ring(16, 16, 13.2, 15.2), s.team, { lit: 0.1, bevel: 0.3, lw: 0.35 });
        if (g.vis()) { g.puff(9, 21, 2.2, s.pal.bone, 0.5); g.line(21, 9, 24, 8, s.pal.bone, 0.9); g.line(8, 10, 10, 11.5, s.pal.bone, 0.8); }
        g.cyl(16, 16, 1.7, 6, '#7b8496', { top: '#aab4c6', bands: 1 });
        g.at(6, function () { g.solid(P.ring(16, 16, 1.4, 2.4), CHAIN, { lit: 0.2, lw: 0.3 }); });
      },
      top: function (g, s) {
        const f = s.fire > 0.5;
        chain(g, 0, 0, f ? 5.6 : 4.2, 0, CHAIN);
        g.push(1.2, 0, 0, 0.8);
        leanDog(g, s, f);
        g.pop();
      },
      anim: function (g, s) { if (s.fire < 0.08) return; g.push(16, 16, s.aim); slash(g, s, 15, 4); g.pop(); },
      lights: function (g, s) {
        if (!enraged(s)) return;
        const a = s.aim, k = 0.5 + 0.3 * Math.sin(s.t * 12);
        g.puff(16 + Math.cos(a) * 12, 16 + Math.sin(a) * 12, 2.6, s.pal.rush, k);
      },
    },

    // ---- Brick Perch (defence): scaffold platform, a bruiser with a cinder block (top), a pile of blocks
    perch: {
      height: 24, pivot: [17, 7], muzzle: [[6, 0]], flash: false, recoil: 0,
      base: function (g, s) {
        const z = 12;
        slab(g, 2, 3, 28, 27);
        for (const q of [[5, 9], [27, 9]]) g.mast(q[0], q[1], z, { w: 1.2, col: '#8b96aa' });
        g.box(8, 22, 6, 5, 3, { roof: '#8a8f99' }); g.box(15, 24, 5, 4, 3, { roof: '#7d838e' });
        for (const q of [[5, 27], [27, 27]]) g.mast(q[0], q[1], z, { w: 1.2, col: '#8b96aa' });
        if (g.vis()) { g.line(5, 27 - 2, 27, 27 - 10, '#59637a', 0.7); g.line(5, 27 - 10, 27, 27 - 2, '#59637a', 0.7); }
        g.at(z, function () {
          g.rect(3, 7, 26, 22, '#6a5a48', { r: 1, lit: 0.12 });
          g.panels(3, 7, 26, 22, 1, 5, 'rgba(0,0,0,0.3)', 0.5);
          g.box(4, 9, 5, 4, 2.5, { roof: '#8f949e' }); g.box(4, 14, 5, 4, 2.5, { roof: '#848a95' }); g.at(2.5, function () { g.box(4.5, 11, 5, 4, 2.5, { roof: '#9aa0aa' }); });
        });
        g.banner(6, 17, 20, 7, s.team, { tail: 1.6 });
      },
      top: function (g, s) {
        const f = s.fire;
        fig(g, s, {
          sw: 5.6, td: 2.8, cloth: s.team, ar: 1.6, hr: 2.7,
          arms: f ? [[-1, 6, -2.2, 1.6], [1, 6, 2.2, 1.6]] : [[-1, 2.6, -2.4, 1.6], [1, 2.6, 2.4, 1.6]],
          over: function () { if (!f) { g.rect(1.6, -2.6, 4.2, 5.2, '#9aa0aa', { r: 0.4, lit: 0.2, lw: 0.5 }); g.rect(2.6, -1.6, 1.2, 1.2, '#4a4e57', A.FLAT); g.rect(2.6, 0.4, 1.2, 1.2, '#4a4e57', A.FLAT); } },
        });
      },
    },

    // ---- Rebar Ballista (defence): leaf-spring bow on a turntable (top), rebar bolt loaded, crank handle
    ballista: {
      height: 14, pivot: [16, 14], muzzle: [[16, 0]], flash: false, recoil: 2,
      base: function (g, s) {
        slab(g, 2, 3, 28, 27);
        g.cyl(16, 16, 12, 2, '#59616f', { wall: '#2e333d' });
        g.at(2, function () {
          g.solid(P.ring(16, 16, 9.4, 11.6), s.team, { lit: 0.1, bevel: 0.3, lw: 0.35 });
          if (g.vis()) for (let i = 0; i < 8; i++) { const a = i * TAU / 8; g.ctx.fillStyle = '#20242c'; g.ctx.fillRect(16 + Math.cos(a) * 10.5 - 0.5, 16 + Math.sin(a) * 10.5 - 0.5, 1, 1); }
        });
        g.box(3, 22, 5, 6, 4, { roof: '#7a5638' });
      },
      top: function (g, s) {
        const f = s.fire, sx = f ? 2.5 : -4.5;
        g.rect(-8, -2, 16, 4, '#6a5440', { r: 1.2, lit: 0.16, lw: 0.55 });
        g.rect(-3, -2.4, 4, 4.8, s.team, { r: 0.8, lit: 0.14, lw: 0.45 });
        // crank
        g.circle(-6, 3.6, 2.2, IRON, { lit: 0.2, lw: 0.45 });
        g.line(-6, 3.6, -7.8, 6.4, '#aab4c6', 0.9); g.circle(-7.8, 6.4, 0.8, s.pal.bone, { lit: 0.1, lw: 0.3 });
        // leaf-spring bow: three stacked arcs
        for (let k = 0; k < 3; k++) {
          const p = new Path2D(), R = 13 - k * 1.1;
          p.arc(3 + k * 0.6 - R + 4.5, 0, R, -0.95 + k * 0.12, 0.95 - k * 0.12);
          g.stroke(p, '#15171d', 2.1); g.stroke(p, k ? '#7b8496' : '#aab4c6', 1.2);
        }
        for (let k = -1; k <= 1; k += 2) g.circle(-0.6, k * 10.6, 1.3, s.team, { lit: 0.2, lw: 0.4 });
        g.lines([-0.6, -10.6, sx, 0, -0.6, 10.6], '#d9dee8', 0.5);
        if (!f) rebar(g, -5, 0, 13, 0, 1.2);
      },
    },

    // ======================================================================= UNITS
    // ---- Gorge Hog: car-sized boar, bristle ridge, tusks, pannier cages on both flanks filling with Glint
    hog: {
      frames: 6, height: 3.2, flash: false, muzzle: [[16.4, 0]],
      body: function (g, s) {
        const ph = s.walk * TAU, mv = s.moving, cg = s.cargo, hide = '#7a665c', dk = A.shade(hide, -0.4);
        g.push(0, 0, 0, 0.9);
        for (let i = 0; i < 4; i++) {
          const front = i < 2, side = i % 2 ? 1 : -1, sw = mv ? Math.sin(ph + ((front ? side > 0 : side < 0) ? PI : 0)) * 2.4 : 0, bx = front ? 7 : -9;
          leg(g, bx, side * 6, bx + sw, side * 9.8, 1.7, dk, '#241c1e');
        }
        if (g.vis()) { const p = new Path2D(); p.arc(-16.6, 0, 1.5, -0.5, PI * 1.4); g.stroke(p, dk, 1); }
        g.blob([-17, 0, -16, -8.6, -6, -10.2, 4, -9.8, 10.5, -7, 12.5, 0, 10.5, 7, 4, 9.8, -6, 10.2, -16, 8.6], hide, { lit: 0.22 });
        // bristle mane along the spine
        const br = [];
        for (let i = 0; i <= 12; i++) br.push(-13 + i * 1.9, i % 2 ? -2.6 : -0.8);
        for (let i = 12; i >= 0; i--) br.push(-13 + i * 1.9, i % 2 ? 2.6 : 0.8);
        g.poly(br, '#3a2c2c', { lit: 0.12, lw: 0.4 });
        // panniers: chain-link cages on the flanks, team frames, Glint heaped by cargo
        for (let k = -1; k <= 1; k += 2) {
          const y0 = k < 0 ? -13.6 : 6.8, p = P.rect(-10.5, y0, 13.5, 6.8, 2.8);
          g.solid(p, '#17141a', { lit: 0, bevel: -0.5, lw: 0.5 });
          const n = Math.round(cg * 6);
          for (let i = 0; i < n; i++) {
            const X = -8.8 + (i % 3) * 4.1, Y = y0 + 1.4 + ((i < 3) === (k < 0) ? 3.1 : 0);
            g.poly([X, Y, X + 1.9, Y - 0.6, X + 2.9, Y + 0.9, X + 1.4, Y + 2.2, X - 0.2, Y + 1.4], s.pal.glint, { lit: 0.3, lw: 0.35 });
          }
          g.mesh(p, { step: 1.8, col: 'rgba(200,208,224,0.4)', lw: 0.4 });
          g.stroke(p, s.teamDk, 2); g.stroke(p, s.team, 1.2);
        }
        g.rect(-6.6, -7.4, 2.6, 14.8, s.team, { r: 0.8, lit: 0.12, bevel: 0.4, lw: 0.4 });
        g.rect(-0.6, -7.8, 2.6, 15.6, s.team, { r: 0.8, lit: 0.12, bevel: 0.4, lw: 0.4 });
        // head: floppy ears, wedge head, snout disc, big tusks
        for (let k = -1; k <= 1; k += 2) g.ellipse(10.2, k * 5, 2.8, 1.6, dk, { rot: k * 0.75, lw: 0.4, lit: 0.1 });
        g.capsule(9.6, 0, 15.8, 0, 5.3, A.shade(hide, 0.06), { r1: 3.8, lit: 0.22 });
        g.ellipse(18, 0, 1.9, 3, '#9a8478', { lw: 0.45, lit: 0.12 });
        if (g.vis()) { g.ctx.fillStyle = '#2a1e1e'; g.ctx.fillRect(18.2, -1.5, 0.9, 0.9); g.ctx.fillRect(18.2, 0.6, 0.9, 0.9); }
        for (let k = -1; k <= 1; k += 2) g.capsule(16, k * 2.8, 19.4, k * 6, 1.35, s.pal.bone, { r1: 0.45, lw: 0.45, lit: 0.22 });
        g.circle(13, -2.8, 0.6, '#120c0e', A.FLAT); g.circle(13, 2.8, 0.6, '#120c0e', A.FLAT);
        g.pop();
      },
      anim: function (g, s) {
        breath(g, s, 18, 0, 0.8);
        if (s.cargo < 0.99) return;
        const k = Math.floor(s.t * 6 + s.seed), X = (-7.5 + (k % 3) * 4.1) * 0.9, Y = (k % 2 ? 1 : -1) * 9.2;
        g.puff(X, Y, 2.4, '#ffffff', 0.8);
        g.line(X, Y - 2, X, Y + 2, '#e8fffb', 0.5); g.line(X - 2, Y, X + 2, Y, '#e8fffb', 0.5);
      },
    },

    // ---- Scrapper: wiry recruit in a team singlet, white-taped fists forward
    scrapper: {
      frames: 6, kick: -1.4, flash: false, muzzle: [[9, 3]],
      body: function (g, s) {
        const sn = swing(s), f = s.fire;
        fig(g, s, {
          k: 1.12, sw: 5.4, td: 3, cloth: s.team, pad: s.teamHi, ar: 1.25, hr: 2.4,
          torso: function () { g.ellipse(-1.6, 0, 1.2, 3.2, s.teamDk, { lit: 0, bevel: 0, ol: false, alpha: 0.5 }); },
          arms: [[-1, 4 - sn * 1.6, -3.2, 1.8, TAPE, true], [1, 4 + sn * 1.6 + f * 4.4, 3.1 - f * 1.5, 1.8, TAPE, true]],
          head: function (hx, hr) { g.circle(hx, 0, hr, s.pal.skin, { lit: 0.24 }); hairCap(g, hx, hr, '#231a1c'); },
        });
      },
      anim: function (g, s) { slash(g, s, 9.5, 4); },
    },

    // ---- Skewer: cocked back with ONE long rebar, quiver of rods on the back, team hood
    skewer: {
      frames: 6, flash: false, muzzle: [[17, 4.2]],
      body: function (g, s) {
        const sn = swing(s), f = s.fire, sk = s.pal.skin;
        fig(g, s, {
          sw: 5, td: 2.6, cloth: A.mix(s.pal.bruise, s.pal.hide, 0.35), pad: s.team, ar: 1.2, hr: 2.7,
          under: function () {
            for (let i = 0; i < 4; i++) g.line(-3.4, -2.4 + i * 0.9, -9.2 - (i % 2) * 0.8, -5.4 + i * 1.3, i % 2 ? '#b0683e' : REBAR, 0.9);
            g.rect(-6, -3.6, 3.6, 4.8, s.pal.tarp, { r: 1.3, lit: 0.12, lw: 0.5 });
          },
          prop: function () { if (!f) rebar(g, -11.5, 4.6, 16.5, 3.9, 1.25); },
          arms: f ? [[-1, 3.6, -3.8, 1.2, sk], [1, 7 - f * 1.4, 3.4, 1.25, sk]] : [[-1, 4.8 + sn * 0.6, -3.4, 1.2, sk], [1, -3, 4.6, 1.3, sk]],
          head: function (hx, hr) {
            g.poly([hx - 1, -1, hx - 5.6, -2.4, hx - 5, 0.2, hx - 1, 1], s.teamLo, { lw: 0.4, lit: 0.1 });
            g.circle(hx, 0, hr + 0.2, s.team, { lit: 0.22 });
            g.ellipse(hx + hr * 0.55, 0, hr * 0.42, hr * 0.62, sk, { lit: 0.1, lw: 0.35, bevel: 0.4 });
          },
        });
      },
    },

    // ---- Strongarm: broad collector in a long coat and wide hat, team scarf, cash bag, brass knuckles
    strongarm: {
      frames: 6, kick: -1, flash: false, muzzle: [[10, 3.4]],
      body: function (g, s) {
        const sn = swing(s), f = s.fire, sk = s.pal.skin, coat = '#4e3c46', cd = A.shade(coat, -0.18);
        fig(g, s, {
          sw: 6.2, td: 3.2, cloth: coat, sleeve: coat, ar: 1.5, hr: 2.8, feet: 2.4,
          under: function (w) {
            g.poly([-0.5, -5.8, -9.6 + w * 0.7, -6.8, -11, -2.2, -11, 2.2, -9.6 - w * 0.7, 6.8, -0.5, 5.8], cd, { r: 1.6, lit: 0.12 });
            g.poly([-9.6 + w * 0.7, -6.8, -11, -2.2, -11, 2.2, -9.6 - w * 0.7, 6.8, -10.6 - w * 0.7, 5.6, -12, 0, -10.6 + w * 0.7, -5.6], s.team, { r: 1, lit: 0.1, lw: 0.4 });
            g.poly([-1, -2, -8.6, -3.4 + w, -9.4, -1.2 + w, -1, 0.4], s.team, { r: 0.6, lit: 0.14, lw: 0.4 });
            g.poly([-1, 0.4, -7.6, 1.6 + w, -8.2, 3.6 + w, -1, 2.2], s.teamHi, { r: 0.6, lit: 0.14, lw: 0.4 });
          },
          torso: function () { g.solid(P.ring(0.5, 0, 3.2, 5, PI * 0.45, PI * 1.55), s.team, { lit: 0.14, lw: 0.4 }); },
          prop: function () {
            g.blob([1.2, -6.8, 2.6, -10.4, 5.6, -10.6, 6.6, -7.4, 5, -5.4, 2.4, -5.4], '#b9a77e', { lit: 0.22 });
            g.circle(4.2, -8.2, 1.2, GOLD, { lit: 0.3, lw: 0.3 });
          },
          arms: [[-1, 3.6 - sn * 0.6, -6.2, 1.4, sk], [1, 5 + sn * 1.2 + f * 3.8, 3.2 - f * 0.8, 1.6, sk]],
          over: function () { const X = 5 + sn * 1.2 + f * 3.8, Y = 3.2 - f * 0.8; g.rect(X + 0.5, Y - 1.6, 1.1, 3.2, BRASS, { r: 0.5, lit: 0.3, lw: 0.35 }); },
          head: function (hx) {
            g.circle(hx, 0, 4.4, '#2e2630', { lit: 0.2, lw: 0.5 });
            g.solid(P.ring(hx, 0, 2.7, 3.4), '#1c171e', { lit: 0, bevel: 0, lw: 0.3 });
            g.circle(hx, 0, 2.7, s.team, { lit: 0.22, lw: 0.4 });
            if (g.vis()) g.line(hx - 1.6, 0, hx + 1.6, 0, s.teamDk, 0.6);
          },
        });
      },
      anim: function (g, s) { slash(g, s, 10, 4.5); },
    },

    // ---- Can Opener: a giant with a huge breaching bar held two-handed across the body
    canopener: {
      frames: 6, kick: -1.2, flash: false, muzzle: [[17, 3]],
      body: function (g, s) {
        const sn = swing(s), f = s.fire, sk = A.shade(s.pal.skin, -0.14);
        const b = f > 0.5 ? [-4, 5, 19.5, 2.2] : f > 0 ? [-7, 10.5, 12, -7.5] : [-7, -10, 14, 8];
        const at = function (t) { return [b[0] + (b[2] - b[0]) * t, b[1] + (b[3] - b[1]) * t]; }, h1 = at(0.4), h2 = at(0.62);
        fig(g, s, {
          sw: 9.4, td: 4.6, cloth: s.teamLo, sleeve: sk, pad: s.team, padR: 3, ar: 2.5, hr: 3.1, feet: 4.6, stride: 2.6, boot: '#2e262a',
          torso: function () {
            g.line(-3.6, -7.6, 3, 7, '#2a1e22', 1.8); g.line(-3.6, 7.6, 3, -7, '#2a1e22', 1.8);
            g.circle(-0.3, 0, 1.6, BRASS, { lit: 0.3, lw: 0.4 });
          },
          prop: function () {
            const a = Math.atan2(b[3] - b[1], b[2] - b[0]);
            g.capsule(b[0], b[1], b[2], b[3], 1.35, '#7d8796', { lit: 0.25, lw: 0.6 });
            g.push(b[2], b[3], a);
            g.poly([-1, -1.4, 2.6, -2.6, 3.8, -1.2, 1.6, 0, 3.8, 1.2, 2.6, 2.6, -1, 1.4], '#9aa4b4', { r: 0.4, lit: 0.25, lw: 0.5 });
            g.pop();
            g.rect(b[0] + (b[2] - b[0]) * 0.12 - 1.2, b[1] + (b[3] - b[1]) * 0.12 - 1.6, 2.4, 3.2, s.team, { r: 0.6, lw: 0.35 });
          },
          arms: [[-1, h1[0], h1[1], 2.3, sk], [1, h2[0], h2[1], 2.3, sk]],
          head: function (hx, hr) {
            g.circle(hx, 0, hr, sk, { lit: 0.26 });
            if (g.vis()) { g.line(hx - 1.4, -1.8, hx + 0.8, -0.6, 'rgba(60,30,30,0.6)', 0.5); }
          },
        });
      },
      anim: function (g, s) { slash(g, s, 15, 7); },
      lights: function (g, s) {
        if (!enraged(s)) return;
        const k = 0.45 + 0.25 * Math.sin(s.t * 10 + s.seed);
        g.puff(2.6, 0, 4.2, s.pal.rush, k); g.puff(0, 0, 11, s.pal.rush, k * 0.18);
      },
    },

    // ---- Hammer Thrower: heavy athlete, wide stance, a team-painted gas cylinder on a chain (orbits when thrown)
    thrower: {
      frames: 6, flash: false, muzzle: [[14, 0]],
      body: function (g, s) {
        const f = s.fire;
        fig(g, s, {
          sw: 8.2, td: 4, cloth: '#3e3540', sleeve: s.pal.skin, ar: 2.1, hr: 3, feet: 9.6, stride: 1.2,
          torso: function () { g.rect(-3.6, -7.2, 7, 2.2, s.team, { r: 1, lit: 0.1, lw: 0.35 }); g.rect(-3.6, 5, 7, 2.2, s.team, { r: 1, lit: 0.1, lw: 0.35 }); },
          prop: function () {
            if (f) { chain(g, 6.4, 0, 9.5, 0); return; }
            chain(g, 6.4, 0, 9.6, 4.4);
            g.push(13, 6, 0.35);
            g.capsule(-3.6, 0, 3.6, 0, 2.4, s.team, { lit: 0.28, lw: 0.55 });
            g.rect(-1.2, -2.4, 1.3, 4.8, s.teamDk, A.FLAT);
            g.circle(-4.4, 0, 1.2, '#c3ccdb', { lit: 0.25, lw: 0.4 });
            g.pop();
          },
          arms: [[-1, 6.2, -1.1, 1.9], [1, 6.2, 1.1, 1.9]],
          head: function (hx, hr) {
            g.circle(hx, 0, hr, s.pal.skin, { lit: 0.24 });
            g.solid(P.ring(hx, 0, hr - 0.9, hr + 0.15), s.team, { lit: 0.1, lw: 0.3 });
            hairCap(g, hx, hr - 0.9, '#2a1f22');
          },
        });
      },
      anim: function (g, s) {
        if (s.fire < 0.05) return;
        const a = s.fire * TAU * 1.3 - 0.4, R = 11, x = 4 + Math.cos(a) * R, y = Math.sin(a) * R, c = g.ctx, ga = c.globalAlpha;
        const p = new Path2D();
        p.arc(4, 0, R, a - 1.6, a); c.globalAlpha = ga * 0.35; g.stroke(p, CLAW, 2.2); c.globalAlpha = ga;
        g.line(6.2, 0, x, y, CHAIN, 0.9);
        g.capsule(x - Math.cos(a + PI / 2) * 3.4, y - Math.sin(a + PI / 2) * 3.4, x + Math.cos(a + PI / 2) * 3.4, y + Math.sin(a + PI / 2) * 3.4, 2.3, s.team, { ol: '#1a1418', lw: 0.6 });
      },
    },

    // ---- Pit Champion: big belted hero — gold title belt over the shoulder, spiked team mane collar, cape scraps
    champion: {
      frames: 6, kick: -1.2, flash: false, muzzle: [[12, 4]],
      body: function (g, s) {
        const sn = swing(s), f = s.fire, sk = s.pal.skin;
        fig(g, s, {
          k: 1.06, sw: 9, td: 4.2, cloth: '#5a2c3a', sleeve: sk, ar: 2.3, hr: 3, feet: 4.2, stride: 2.4,
          under: function (w) {
            g.poly([-1, -7.5, -8 + w * 0.5, -8.2, -10, -6, -12.4, -6.6, -11.2, -3, -13.4, -1, -11.6, 1.2, -13, 4.4, -10.6, 5.2, -9.4 - w * 0.5, 8, -1, 7.5], A.shade(s.pal.tarp, -0.12), { r: 0.6, lit: 0.14 });
          },
          torso: function () {
            g.line(3.4, -7.6, -3.6, 7.6, '#7a5a22', 3.4); g.line(3.4, -7.6, -3.6, 7.6, GOLD, 2.4);
            g.ellipse(2.3, -5.6, 2.4, 3.2, GOLD, { lit: 0.3, lw: 0.5, rot: 0.2 });
            g.circle(2.3, -5.6, 1, s.pal.bone, { lit: 0.3, lw: 0.3 });
          },
          arms: [[-1, 4.6 - sn * 1.6, -7.4, 2.2, s.pal.bone], [1, 4.6 + sn * 1.6 + f * 4.6, 7.2 - f * 2.2, 2.2, s.pal.bone]],
          head: function (hx, hr) {
            const sp = [];
            for (let i = 0; i < 22; i++) { const a = i * TAU / 22, r = i % 2 ? 4.6 : 6.6; sp.push(hx + Math.cos(a) * r, Math.sin(a) * r); }
            g.poly(sp, s.team, { lit: 0.2, lw: 0.5 });
            g.circle(hx, 0, 4.4, s.teamLo, { lit: 0.1, lw: 0.4 });
            g.solid(P.ring(hx, 0, 4.6, 6.8, PI * 0.62, PI * 1.38), GOLD, { lit: 0.3, lw: 0.5 });
            g.ellipse(hx - 5.8, 0, 2, 3, '#f6e6a8', { lit: 0.3, lw: 0.5 });
            g.circle(hx - 5.8, 0, 0.9, s.pal.bone, { lit: 0.2, lw: 0.3 });
            g.circle(hx, 0, hr, sk, { lit: 0.26 });
            hairCap(g, hx, hr, '#1e1618');
          },
        });
      },
      anim: function (g, s) { slash(g, s, 14, 6.5); },
    },

    // ---- Alley Cat: long low engineered jaguar — teardrop body, long tail, moving shoulder blades, team collar
    alleycat: {
      frames: 6, height: 2.6, flash: false, muzzle: [[16, 0]],
      body: function (g, s) {
        const f = s.fire, mv = s.moving, ph = s.walk * TAU, pounce = f > 0.5, crouch = f > 0 && !pounce;
        const fur = '#8a7258', dk = A.shade(fur, -0.4), spot = '#2e2428', st = pounce ? 1.16 : crouch ? 0.9 : 1;
        g.push(0, 0, 0, st, 1);
        for (let i = 0; i < 4; i++) {
          const front = i < 2, side = i % 2 ? 1 : -1, p = ph + ((front ? side > 0 : side < 0) ? PI : 0), sw = mv ? Math.sin(p) * 3.4 : 0;
          const bx = front ? 4.6 : -6, by = side * 3.2;
          let px = front ? 7 + sw : -7.6 + sw, py = side * 5.8;
          if (pounce) { px = front ? 12.6 : -12.6; py = side * (front ? 4.2 : 3.2); }
          else if (crouch) { px = front ? 6.2 : -5.6; py = side * 6.2; }
          leg(g, bx, by, px, py, 1.4, dk, '#3a3034');
          if (pounce && front && g.vis()) for (let k = -1; k <= 1; k++) g.line(px + 0.9, py + k * 0.7, px + 2.4, py + k * 1.1, s.pal.bone, 0.5);
        }
        const tw = mv ? Math.sin(ph) : 0.6;
        g.capsule(-8.4, 0, -13.6, tw * 2.8, 1.65, fur, { r1: 1.4, lit: 0.12, lw: 0.5 });
        g.capsule(-13.6, tw * 2.8, -18.6, -tw * 1.2 + 1.8, 1.4, fur, { r1: 1.2, lit: 0.12, lw: 0.5 });
        g.capsule(-18.6, -tw * 1.2 + 1.8, -21.6, -tw * 2.8 + 4, 1.2, spot, { r1: 1.1, lit: 0.12, lw: 0.5 });
        g.blob([-10, 0, -9.6, -4.4, -4, -4.6, 1.6, -6.6, 7, -6.2, 9.6, 0, 7, 6.2, 1.6, 6.6, -4, 4.6, -9.6, 4.4], fur, { lit: 0.22 });
        if (g.vis()) for (const q of [[-7.4, -2.4], [-4.6, 2.6], [-7.8, 2.2], [0.6, -3.2], [1.2, 3.4], [-1.4, 0.2]]) { const p = new Path2D(); p.arc(q[0], q[1], 1.1, 0.4, TAU - 0.5); g.stroke(p, spot, 0.75); }
        const sb = mv ? Math.sin(ph) * 1.2 : 0;
        g.ellipse(4.4 + sb, -3, 2.2, 1.4, A.shade(fur, 0.16), { lit: 0.12, bevel: 0.5, lw: 0.35 });
        g.ellipse(4.4 - sb, 3, 2.2, 1.4, A.shade(fur, 0.16), { lit: 0.12, bevel: 0.5, lw: 0.35 });
        g.rect(-5.4, -4.4, 5.2, 8.8, s.team, { r: 2, lit: 0.14, lw: 0.4 });
        g.line(-0.4, -4.4, 6.6, -4.8, s.teamLo, 0.9); g.line(-0.4, 4.4, 6.6, 4.8, s.teamLo, 0.9);
        g.rect(7, -4.6, 2.2, 9.2, s.team, { r: 1, lit: 0.12, lw: 0.4 });
        g.pop();
        const hx = 11.2 * st;
        for (let k = -1; k <= 1; k += 2) g.poly([hx - 1.6, k * 2.2, hx - 2.8, k * 5.8, hx + 0.8, k * 3.9], crouch ? dk : A.shade(fur, -0.12), { r: 0.3, lw: 0.45, lit: 0.1 });
        g.ellipse(hx, 0, 3.8, 4.4, A.shade(fur, 0.06), { lit: 0.24 });
        g.ellipse(hx + 3, 0, 1.6, 2.2, A.shade(fur, 0.34), { lit: 0.1, lw: 0.35 });
        g.circle(hx + 4.4, 0, 0.55, '#1a1214', A.FLAT);
      },
      anim: function (g, s) { slash(g, s, 16, 4.5); breath(g, s, 15.8, 0, 0.6); },
    },

    // ---- Wrecking Bull: massive wedge — huge shoulders, crescent metal-capped horns, nose ring, team harness
    bull: {
      frames: 6, height: 3.6, kick: -2.2, flash: false, muzzle: [[17.4, 0]],
      body: function (g, s) {
        const f = s.fire, mv = s.moving, ph = s.walk * TAU, hide = '#6e3236', dk = A.shade(hide, -0.4), hx = f ? 2 : 0;
        g.push(0, 0, 0, 0.86);
        for (let i = 0; i < 4; i++) {
          const front = i < 2, side = i % 2 ? 1 : -1, sw = mv ? Math.sin(ph + ((front ? side > 0 : side < 0) ? PI : 0)) * 2.6 : 0;
          if (front) leg(g, 4, side * 8.5, 5.5 + sw, side * 11.8, 2.2, dk, '#1e1618');
          else leg(g, -10, side * 4, -11.5 + sw, side * 7, 1.8, dk, '#1e1618');
        }
        const tw = mv ? Math.sin(ph) * 1.6 : 0;
        g.capsule(-14, 0, -18.4, tw, 0.6, dk, { lw: 0.4 });
        g.ellipse(-19, tw, 1.3, 1, '#1e1618', { lw: 0.3 });
        const body = [-16, 0, -15, -5.4, -7, -7, 0, -12.2, 7, -12.6, 11, -6.4, 11, 6.4, 7, 12.6, 0, 12.2, -7, 7, -15, 5.4];
        g.blob(body, hide, { lit: 0.24 });
        g.ellipse(2.8, 0, 6.6, 8.6, A.shade(hide, 0.12), { lit: 0.14, bevel: 0.4, ol: false });
        // harness: shoulder band + girth strap + spine strap, all team
        g.poly([-1.8, -9.8, 2, -11.2, 2, 11.2, -1.8, 9.8], s.team, { r: 0.8, lit: 0.12, bevel: 0.4, lw: 0.45 });
        g.poly([-9.6, -5.8, -7.4, -6.6, -7.4, 6.6, -9.6, 5.8], s.team, { r: 0.6, lit: 0.12, bevel: 0.4, lw: 0.4 });
        g.line(-8.6, 0, 0, 0, s.teamLo, 1.3);
        g.circle(0.1, 0, 1.5, STEEL, { lit: 0.25, lw: 0.35 });
        // head with crescent horns (metal-capped), nose ring
        g.push(hx, 0);
        for (let k = -1; k <= 1; k += 2) {
          g.poly([11.6, k * 3.2, 9.4, k * 7.4, 10.4, k * 11.4, 14.2, k * 13.6, 18.6, k * 13.2, 21, k * 11.6, 17.8, k * 11.6, 14.8, k * 10.8, 12.9, k * 8.4, 13.6, k * 4.4], s.pal.bone, { r: 0.8, lit: 0.24, lw: 0.5 });
          g.poly([17.4, k * 13.3, 18.6, k * 13.2, 21, k * 11.6, 17.8, k * 11.6, 17.2, k * 11.8], STEEL, { r: 0.3, lit: 0.3, lw: 0.4 });
        }
        g.capsule(10.4, 0, 16, 0, 5, A.shade(hide, 0.06), { r1: 3.9, lit: 0.24 });
        g.ellipse(17.2, 0, 2, 3.2, '#8e6c64', { lw: 0.4, lit: 0.1 });
        g.solid(P.ring(19.4, 0, 0.9, 1.8), BRASS, { lit: 0.3, lw: 0.35 });
        g.circle(13.6, -3, 0.65, '#120c0e', A.FLAT); g.circle(13.6, 3, 0.65, '#120c0e', A.FLAT);
        g.pop(); g.pop();
      },
      anim: function (g, s) { breath(g, s, 16.8, -1.2, 0.8); },
      lights: function (g, s) {
        if (!enraged(s)) return;
        const k = 0.5 + 0.3 * Math.sin(s.t * 11 + s.seed);
        g.puff(11.9, -2.6, 2.4, s.pal.rush, k); g.puff(11.9, 2.6, 2.4, s.pal.rush, k);
        g.puff(17.2, 0, 4, s.pal.rush, k * 0.25);
      },
    },

    // ---- Butcherbird: condor-sized shrike — wide swept crescent wings, team wing bands, black mask, hooked beak
    butcherbird: {
      frames: 8, fps: 6, height: 20, flash: false, muzzle: [[13, 0]],
      anim: function (g, s) { slash(g, s, 15, 4); },
      body: function (g, s) {
        const fl = Math.cos(s.walk * TAU), S = 20.5 * (0.84 + 0.16 * fl), w = (1 - fl) * 1.8, back = '#6e6872', dk = A.shade(back, -0.34);
        for (let k = -1; k <= 1; k += 2) {
          const y = function (t) { return k * S * t; };
          g.poly([3, k * 1.8, 5.8, y(0.24), 5.2, y(0.5), 2 - w * 0.4, y(0.74), -3 - w, y(0.94), -8.4 - w * 1.4, y(1),
            -8.8 - w * 1.3, y(0.93), -7.2 - w * 1.1, y(0.88), -9 - w, y(0.82), -7.4 - w * 0.9, y(0.77), -8.8 - w * 0.8, y(0.7), -6.8 - w * 0.6, y(0.66),
            -7.6, y(0.56), -8.2, y(0.42), -7.4, y(0.3), -8.4, y(0.18), -7.6, k * 2], back, { r: 0.5, lit: 0.2 });
          if (g.vis()) for (let i = 0; i < 5; i++) { const t = 0.2 + i * 0.13; g.line(1.4 - i * 0.9, y(t), -6.6 - i * 0.3, y(t + 0.05), 'rgba(0,0,0,0.28)', 0.5); }
          g.poly([4.4, y(0.26), 3.8, y(0.5), 1 - w * 0.4, y(0.72), -3.4 - w, y(0.9), -2.8 - w, y(0.78), 0 - w * 0.4, y(0.62), 1.4, y(0.46), 1.6, y(0.26)], s.team, { r: 0.4, lit: 0.16, lw: 0.4 });
          g.poly([-8.4 - w * 1.4, y(1), -8.8 - w * 1.3, y(0.93), -7.2 - w * 1.1, y(0.88), -9 - w, y(0.82), -7.4 - w * 0.9, y(0.77), -5.8 - w, y(0.86)], dk, { r: 0.3, lit: 0.1, lw: 0.3 });
          g.poly([2.2, k * 2, 4.6, y(0.22), -1.6, y(0.26), -4, k * 2.2], s.teamLo, { r: 0.5, lit: 0.12, lw: 0.35 });
        }
        g.poly([-6, -2, -12.6, -4.4, -14, -1.4, -13.4, 1.4, -12.6, 4.4, -6, 2], dk, { r: 0.6, lit: 0.12, lw: 0.5 });
        g.poly([-11.8, -4.2, -12.6, -4.4, -14, -1.4, -13.4, 1.4, -12.6, 4.4, -11.8, 4.2, -12.4, 0], s.pal.bone, { r: 0.4, lit: 0.1, lw: 0.35 });
        g.ellipse(-0.6, 0, 7.4, 3.2, '#8e8894', { lit: 0.22 });
        g.circle(6.6, 0, 2.8, s.pal.bone, { lit: 0.22, lw: 0.5 });
        g.rect(5.5, -2.7, 2.2, 5.4, '#15121a', { r: 0.8, lit: 0, bevel: 0, lw: 0.3 });
        g.poly([8.6, -1.2, 11.6, -0.6, 12.4, 0.8, 11.1, 0.5, 8.6, 1.2], '#3a3640', { r: 0.3, lit: 0.2, lw: 0.4 });
      },
    },
  });
})();
