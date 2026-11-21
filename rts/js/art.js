'use strict';
// ============================================================================
// NEON TURF — art.js : the ART KIT  (presentation; needs canvas; load before any *.art.js)
//
// Every pixel of the game is drawn by code. This file owns
//   1. the drawing KIT `g` (shapes, materials, building blocks, vehicle parts,
//      humanoid / quadruped / winged / drone rigs),
//   2. the sprite CACHE (vector art is rasterised once, then blitted),
//   3. FALLBACK art generated from def data, so a new gang is playable before
//      anyone draws it,
//   4. the NT.Art entry points the renderer and the HUD call.
//
// ----------------------------------------------------------------------------
// ART AUTHORING CONTRACT  (one file per faction: js/factions/<id>.art.js)
// ----------------------------------------------------------------------------
//   NT.Art.define('mygang', { <defKey>: ART, ... });        // attaches to NT.DEFS['mygang.<defKey>'].art
//
// ART (unit) = {
//   body(g, s),            // REQUIRED. Art px (1 = 1 world px at zoom 1), origin = unit centre, +x = FORWARD.
//                          // Rotates with st.facing.
//   top(g, s),             // optional turret / upper body. Origin = `pivot`, +x = AIM direction. Rotates with st.aim.
//   pivot: [x, y],         // where the top sits, in body coords (default [0, 0])
//   muzzle: [[x, y], ...], // one per weapon: where shots leave. In TOP coords when the art has a top, else body
//                          // coords; append 'body' ([x, y, 'body']) for a hull gun on a turreted unit.
//   frames: n,             // animation frames (default 1 = static). s.walk = phase 0..1, s.moving = true while cycling.
//   fps: f,                // set: frames advance with time (rotors, wings); unset: with st.walk while st.moving
//   height: px,            // fake altitude = shadow offset (defaults: infantry 2.5, vehicles 3.5, air 18)
//   kick: px,              // whole sprite jerks back along facing by kick * st.fire (hand-held guns)
//   recoil: px,            // the top slides back along aim by recoil * st.fire (turret guns; default 1.5)
//   flash: {col, size} | false,   // muzzle flash override (default: derived from weapon 0)
//   anim(g, s),            // optional LIVE overlay, body frame, drawn every frame — keep it to a few shapes
//   lights(g, s),          // optional LIVE additive overlay (pass 3), body frame
//   icon(g, s),            // optional custom portrait (drawn in a 1x1 box scaled to the icon; rarely needed)
// }
// ART (building) = {
//   height: px,            // tallest point above the ground: shadow length + bounds
//   base(g, s),            // REQUIRED. Origin = footprint TOP-LEFT, footprint = s.W x s.H px (def.size * 32). May
//                          // draw north of it (y < 0) by its height. Cached per team colour, damage state
//                          // (s.dmg 0|1|2), power state and variant.
//   top(g, s), pivot, muzzle, recoil,   // rotating turret exactly as for units; pivot in footprint coords AS DRAWN
//   anim(g, s),            // LIVE overlay each frame, footprint coords (rotating dish, blinking lamp, steam)
//   lights(g, s),          // LIVE additive overlay
//   variants: n,           // 1..4 looks picked by st.seed (s.variant; s.rnd is seeded per variant)
//   ao: false,             // skip the soft contact shadow around the footprint
//   glowPad: px,           // how far baked glow may spill outside the drawn pixels (default 14)
// }
//
// THREE PASSES FROM ONE DRAWING. body / top / base run in three kit modes:
//   'main'   the sprite itself (lit, bevelled, outlined),
//   'glow'   only EMISSIVE primitives draw (neon, lamp, windows, glow, pool, led), blurred, into a separate
//            sprite that drawLights adds on top; everything else acts as an occluder,
//   'shadow' buildings: every primitive that has a height (box, prism, cyl, gable, mast, crate, awning,
//            anything inside g.at(z)) sweeps its footprint along the light; units: the silhouette.
// So you draw a neon sign once and get the tube, its halo and no extra shadow code. Unpowered buildings
// (st.powered === false) bake with dead emissives automatically.
//
// LIGHT comes from the TOP-LEFT in WORLD space. Unit layers are baked per facing bucket (NT.Art.ROT_N) and
// the kit knows the bake rotation: highlights, bevels and gradients stay world-consistent while a unit
// turns. Never hand-paint a directional highlight — use `lit` / `bevel` options and let the kit do it.
//
// `s` — what art functions may read:
//   s.team / teamHi / teamLo / teamDk / teamInk   the owner's colour + shades (ink = readable mark colour on team)
//   s.pal        A.PAL overlaid with the faction's palette (s.pal.steel, s.pal.<yourKey> ...)
//   s.W, s.H     building footprint in px          s.def   the normalized def
//   s.moving, s.walk (0..1)                        animation frame (quantised)
//   s.fire (0|.4|1), s.cargo (0|1/3|2/3|1), s.deployed   reading one of these inside a cached function makes the
//                cache key include it (detected automatically) — read them only if the sprite really changes
//   s.dmg (0|1|2), s.powered, s.variant, s.rnd() / s.rnd(n)   seeded per def + variant
//   live functions (anim, lights) additionally get the raw st: s.t, s.active, s.hp, s.facing, s.aim, s.seed ...
//                s.boost / s.hinder: a helpful / harmful timed buff is running (surge, a support power, a slow) —
//                LIVE ONLY: baked layers never see them (nor s.t, which is 0 while baking)
//
// TEAM COLOUR: every sprite must show s.team on >= ~20% of its top surface (pads, stripes, roof panels,
// banners, lamps). Neutral structures simply receive a grey team colour.
// READABILITY at zoom 1: infantry 14-18 px across, vehicles 26-34 px long, big beasts 24-30 px. Avoid
// near-black fills for anything that defines the silhouette: the ground is dark.
//
// ----------------------------------------------------------------------------
// ENTRY POINTS (renderer / HUD)
// ----------------------------------------------------------------------------
//   NT.Art.drawShadow(ctx, def, st)    pass 1 — all shadows before all bodies
//   NT.Art.drawEntity(ctx, def, st)    pass 2 — caller translated to the entity position and applied zoom; the
//                                      origin is the unit centre / the building's footprint CENTRE
//   NT.Art.drawLights(ctx, def, st)    pass 3 — caller set globalCompositeOperation = 'lighter'
//   NT.Art.icon(def, team, px)         -> cached square HTMLCanvasElement (px = CSS size; honours devicePixelRatio)
//   NT.Art.muzzle(def, st, wi)         -> [dx, dy] world px from the entity origin, rotated by facing / aim
//   NT.Art.bounds(def)                 -> { w, h, up, x0, y0, x1, y1 } world px. Selection / picking box around the
//                                      entity origin: x in [-w/2, w/2], y in [-h/2 - up, h/2]. Buildings: w x h
//                                      covers the footprint, `up` is the rise NORTH of it. Units: w = h = the
//                                      BODY (barrels, rifles and tails are left out so brackets hug the figure),
//                                      up = 0. x0..y1 = everything that can ever be drawn (any facing): culling.
//   NT.Art.clearCache()                drop every cached raster (after a palette / art hot-reload)
//   NT.Art.kit(ctx, scale)             -> a live kit bound to ctx (map decoration, fx) — same primitives
//   NT.Art.stats                       { hits, misses, canvases, pixels, evictions, bakeMs, cap }
//   NT.Art.budget                      cached pixels before least-recently-used sprites are evicted
//   NT.Art.opts                        { flash: true, rank: false }. flash: drawLights paints a muzzle flash at
//                                      NT.Art.muzzle while st.fire > 0 (set false if the fx layer draws its own).
//                                      rank: drawEntity paints veterancy chevrons from st.rank (off: the renderer's
//                                      overlay pass owns them; NT.Art.drawRank(ctx, rank, r) draws the same mark).
//   NOT drawn here: health bars, selection / brace / capture rings, projectiles — renderer and fx.
//   st = { team:'#rrggbb', facing, aim, t, moving, walk, fire, hp, deployed, cargo, rank, powered, active,
//          ghost, flash, seed, zoom, weapon, boost, hinder }  — every field optional (see _newEnt in sim.js for the sources);
//          zoom = camera zoom x devicePixelRatio; weapon = index of the weapon that fired (which muzzle flashes)
//
// CACHE: drawEntity / drawShadow / drawLights only BLIT. A sprite is rasterised the first time a combination
// of (def, team, layer, resolution bucket, facing bucket, frame, state bits) is needed. Resolution bucket =
// the first step of NT.Art.LADDER >= st.zoom (zoom x devicePixelRatio), so sprites are never upscaled.
// Sprites turn smoothly: the nearest facing bucket is blitted with the small residual rotation (16 buckets below
// 2x, 8 from 2x up). Memory is bounded by NT.Art.budget (LRU); if the sprites IN USE do not fit, the resolution
// cap drops below the current ladder step (NT.Art.stats.cap) rather than thrashing — it lifts again when the
// zoom reaches another step. Live overlays
// (anim, lights) are the only per-frame vector work: keep them to g.puff / a few flat shapes.
// For the crispest 1x look the renderer should snap the camera to device pixels.
//
// KIT QUICK REFERENCE (all sizes in art px; `o` = options, always optional)
//   colour   A.shade(c, k) k -1..1 · A.mix(a, b, t) · A.alpha(c, a) · A.lum(c)
//   paths    A.P.rect(x,y,w,h,r) poly(pts,r) circle(x,y,r) ellipse(x,y,rx,ry,rot) capsule(x0,y0,x1,y1,r,r1)
//            blob(pts) line(pts,close) ring(x,y,r0,r1,a0,a1)      (flat point lists [x0,y0,x1,y1,...])
//   paint    g.solid(path, col, o)  o: { lit, bevel, bw, ol, lw, alpha, fill }  -> lit + bevelled + outlined
//            g.rect(x,y,w,h,col,o) o.r · g.poly(pts,col,o) · g.circle(x,y,r,col,o) · g.ellipse(x,y,rx,ry,col,o)
//            g.capsule(x0,y0,x1,y1,r,col,o) · g.blob(pts,col,o) · g.line(x0,y0,x1,y1,col,w) · g.stroke(path,col,w)
//   frame    g.push(x,y,rot,sx,sy) ... g.pop() · g.at(z, fn)  draw fn lifted z px above the ground
//   surface  g.panels g.rivets g.vent g.stripes g.hazard g.windows g.chevrons g.scribble g.mesh
//   fills    g.lgrad(x0,y0,x1,y1,stops) g.rgrad(x,y,r0,r1,stops) -> gradient for the `fill` option
//   light    g.neon(path|pts,col,o) g.glyph(name,x,y,w,h,col,o) g.sign(x,y,w,h,o) g.lamp(x,y,col,o)
//            g.led(x,y,col,r) g.glow(path,col,o) g.pool(x,y,rx,ry,col,a) g.puff(x,y,r,col,a)
//            g.screen(x,y,w,h,col,o) g.string([x,y,z,...],o)  (bulbs / bunting)   glyph names: NT.Art.GLYPHS
//   build    g.box(x,y,w,d,h,o) g.prism(pts,h,col,o) g.cyl(x,y,r,h,col,o) g.gable(x,y,w,d,h,rise,o)
//            g.mast g.dish g.pipe g.crate g.sandbags g.tarp g.awning g.umbrella g.banner g.flag g.ac g.stack
//            g.tyre g.drum g.tank g.fence g.billboard g.door
//   vehicle  g.tracks(len,gauge,w,phase,o) g.wheels(xs,gauge,o) g.hull(len,wid,col,o) g.barrel(x,y,len,w,col,o)
//            g.windshield(x,y,w,h,o) g.hatch(x,y,r,col) g.exhaust(x,y,o) g.car(x,y,len,wid,col,o)
//   rigs     g.humanoid(o) g.quadruped(o) g.winged(o) g.drone(o)     (options documented at each rig)
// ============================================================================
(function () {
  const TAU = Math.PI * 2, PI = Math.PI, TILE = NT.TILE, NONE = Object.freeze({});
  const A = NT.Art = {};

  A.LIGHT = [-0.7071, -0.7071];      // unit vector pointing TO the light (top-left), world space
  A.SHADOW = [0.58, 0.46];           // ground shadow displacement per px of height
  A.ROT_N = 16;                      // facing buckets of baked unit layers
  A.LADDER = [0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];   // sprite resolutions (device px per art px)
  // cached pixels (x4 bytes) before least-recently-used sprites are evicted: 80 .. 190 MB by device memory
  A.budget = (function (m) { return m >= 8 ? 48e6 : m && m <= 2 ? 20e6 : 32e6; })(typeof navigator !== 'undefined' && navigator.deviceMemory);
  A.stats = { hits: 0, misses: 0, canvases: 0, pixels: 0, evictions: 0, bakeMs: 0, cap: 8 };
  A.opts = { flash: true, rank: false };   // drawLights paints muzzle flashes / drawEntity paints veterancy chevrons

  // Shared material tones. A faction palette overrides / extends these in s.pal.
  A.PAL = {
    ink: '#06070c', asphalt: '#11141c', concrete: '#6a7180', concreteDark: '#454b58', tar: '#2b303c',
    steel: '#5b6475', steelDark: '#363d4b', steelLight: '#8d98ab', gun: '#7c8698', rubber: '#20232c',
    glass: '#16202e', glassLit: '#ffd98a', wood: '#7a5638', rust: '#8a4b2a', brick: '#6d4038',
    canvas: '#a39676', bone: '#e6dfcc', skin: '#c9966f', hazard: '#ffc91f',
    warm: '#ffb45a', cool: '#58d6ff', hot: '#ff4d6a', toxic: '#7dff5a', white: '#eef3ff',
    glint: '#c4f6ee',               // the resource: cool white-teal, never a team colour
  };

  // --------------------------------------------------------------------------
  // Colour
  // --------------------------------------------------------------------------
  const colCache = new Map();
  function rgb(c) {                                   // -> [r, g, b, a]
    let v = colCache.get(c);
    if (v) return v;
    if (c[0] === '#') {
      const h = c.length < 6 ? c.replace(/[0-9a-f]/gi, '$&$&') : c, n = parseInt(h.slice(1, 7), 16);
      v = [n >> 16 & 255, n >> 8 & 255, n & 255, h.length > 7 ? parseInt(h.slice(7, 9), 16) / 255 : 1];
    } else {
      const m = c.match(/[\d.]+/g) || [0, 0, 0];
      v = [+m[0], +m[1], +m[2], m[3] === undefined ? 1 : +m[3]];
    }
    colCache.set(c, v);
    return v;
  }
  function css(r, g, b, a) {
    r = r < 0 ? 0 : r > 255 ? 255 : Math.round(r); g = g < 0 ? 0 : g > 255 ? 255 : Math.round(g); b = b < 0 ? 0 : b > 255 ? 255 : Math.round(b);
    if (a === undefined || a >= 1) return '#' + (0x1000000 + (r << 16) + (g << 8) + b).toString(16).slice(1);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + Math.round(a * 1000) / 1000 + ')';
  }
  A.rgb = rgb;
  // k < 0 darkens toward black, k > 0 lightens toward white (|k| <= 1)
  A.shade = function (c, k) {
    const v = rgb(c), t = k < 0 ? 0 : 255, f = k < 0 ? -k : k;
    return css(v[0] + (t - v[0]) * f, v[1] + (t - v[1]) * f, v[2] + (t - v[2]) * f, v[3]);
  };
  A.mix = function (a, b, t) {
    const u = rgb(a), v = rgb(b);
    return css(u[0] + (v[0] - u[0]) * t, u[1] + (v[1] - u[1]) * t, u[2] + (v[2] - u[2]) * t, u[3] + (v[3] - u[3]) * t);
  };
  A.alpha = function (c, a) { const v = rgb(c); return css(v[0], v[1], v[2], Math.min(0.999, v[3] * a)); };
  A.lum = function (c) { const v = rgb(c); return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255; };
  // never let a silhouette-defining material sink into the asphalt
  A.visible = function (c, min) {
    const m = min || 0.16;
    for (let i = 0; i < 6 && A.lum(c) < m; i++) c = A.shade(c, 0.12);
    return c;
  };

  // deterministic helpers for art variation (never Math.random: sprites must bake identically every time)
  A.rng = function (seed) {
    const r = new NT.Rng(seed);
    return function (n) { return n === undefined ? r.next() : r.int(n); };
  };
  function ih(a, b) {                                 // integer pair -> [0, 1)
    let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    return (h >>> 0) / 4294967296;
  }
  A.hash01 = ih;

  // --------------------------------------------------------------------------
  // Paths. Every builder returns a Path2D tagged with .bb = [x, y, w, h] (lit gradients need the box).
  // --------------------------------------------------------------------------
  function bbOf(pts) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < pts.length; i += 2) {
      if (pts[i] < x0) x0 = pts[i]; if (pts[i] > x1) x1 = pts[i];
      if (pts[i + 1] < y0) y0 = pts[i + 1]; if (pts[i + 1] > y1) y1 = pts[i + 1];
    }
    return [x0, y0, x1 - x0, y1 - y0];
  }
  const P = A.P = {
    rect: function (x, y, w, h, r) {
      const p = new Path2D();
      if (w < 0) { x += w; w = -w; }
      if (h < 0) { y += h; h = -h; }
      r = Math.min(r || 0, w / 2, h / 2);
      if (r > 0) {
        p.moveTo(x + r, y); p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r);
        p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r); p.closePath();
      } else p.rect(x, y, w, h);
      p.bb = [x, y, w, h];
      return p;
    },
    poly: function (pts, r) {                         // closed; r rounds the corners
      const p = new Path2D(), n = pts.length;
      if (r > 0) {
        p.moveTo((pts[n - 2] + pts[0]) / 2, (pts[n - 1] + pts[1]) / 2);
        for (let i = 0; i < n; i += 2) {
          const j = (i + 2) % n;
          p.arcTo(pts[i], pts[i + 1], (pts[i] + pts[j]) / 2, (pts[i + 1] + pts[j + 1]) / 2, r);
        }
      } else {
        p.moveTo(pts[0], pts[1]);
        for (let i = 2; i < n; i += 2) p.lineTo(pts[i], pts[i + 1]);
      }
      p.closePath(); p.bb = bbOf(pts);
      return p;
    },
    line: function (pts, close) {                     // open polyline (for strokes / neon)
      const p = new Path2D();
      p.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
      if (close) p.closePath();
      p.bb = bbOf(pts);
      return p;
    },
    circle: function (x, y, r) {
      const p = new Path2D(); p.arc(x, y, r, 0, TAU); p.bb = [x - r, y - r, 2 * r, 2 * r];
      return p;
    },
    ellipse: function (x, y, rx, ry, rot) {
      const p = new Path2D(), m = rot ? Math.max(rx, ry) : 0;
      p.ellipse(x, y, rx, ry, rot || 0, 0, TAU);
      p.bb = rot ? [x - m, y - m, 2 * m, 2 * m] : [x - rx, y - ry, 2 * rx, 2 * ry];
      return p;
    },
    capsule: function (x0, y0, x1, y1, r, r1) {       // round-capped limb; r1 = end radius (taper)
      const p = new Path2D(), a = Math.atan2(y1 - y0, x1 - x0);
      if (r1 === undefined) r1 = r;
      p.arc(x0, y0, r, a + PI / 2, a - PI / 2); p.arc(x1, y1, r1, a - PI / 2, a + PI / 2); p.closePath();
      const m = Math.max(r, r1);
      p.bb = [Math.min(x0, x1) - m, Math.min(y0, y1) - m, Math.abs(x1 - x0) + 2 * m, Math.abs(y1 - y0) + 2 * m];
      return p;
    },
    blob: function (pts) {                            // smooth closed curve; pts are CONTROL points (curve stays inside)
      const p = new Path2D(), n = pts.length;
      p.moveTo((pts[n - 2] + pts[0]) / 2, (pts[n - 1] + pts[1]) / 2);
      for (let i = 0; i < n; i += 2) {
        const j = (i + 2) % n;
        p.quadraticCurveTo(pts[i], pts[i + 1], (pts[i] + pts[j]) / 2, (pts[i + 1] + pts[j + 1]) / 2);
      }
      p.closePath(); p.bb = bbOf(pts);
      return p;
    },
    ring: function (x, y, r0, r1, a0, a1) {           // annulus sector between radii r0 < r1
      const p = new Path2D();
      if (a0 === undefined) { a0 = 0; a1 = TAU; }
      p.arc(x, y, r1, a0, a1); p.arc(x, y, r0, a1, a0, true); p.closePath();
      p.bb = [x - r1, y - r1, 2 * r1, 2 * r1];
      return p;
    },
  };

  // --------------------------------------------------------------------------
  // The kit
  // --------------------------------------------------------------------------
  function Kit() {
    this.ctx = null; this.mode = 'main'; this.scale = 1; this.on = true;
    this.z = 0;                      // current elevation (g.at)
    this.em = 0;                     // emissive primitives seen (decides whether a glow layer exists)
    this.lx = 0; this.ly = 0;        // unit vector to the light, LOCAL frame
    this.sx = 0; this.sy = 0;        // shadow displacement per px of height, LOCAL frame
    this.ux = 0; this.uy = -1;       // screen "up" (north) per px of height, LOCAL frame
    this.outer = false;              // outlines grow OUTSIDE the shape (unit layers) instead of inside (buildings)
    this._st = [];
  }
  const K = Kit.prototype;
  A.Kit = Kit;

  // mode: 'main' | 'glow' | 'shadow' | 'sil' | 'live'. rot = how far the sprite is rotated when drawn.
  K.begin = function (ctx, mode, rot, scale, on, outer) {
    const c = Math.cos(rot || 0), s = Math.sin(rot || 0);
    this.ctx = ctx; this.mode = mode; this.scale = scale || 1; this.on = on !== false; this.outer = !!outer;
    this.z = 0; this.em = 0; this._st.length = 0;
    this.lx = A.LIGHT[0] * c + A.LIGHT[1] * s; this.ly = -A.LIGHT[0] * s + A.LIGHT[1] * c;
    this.sx = A.SHADOW[0] * c + A.SHADOW[1] * s; this.sy = -A.SHADOW[0] * s + A.SHADOW[1] * c;
    this.ux = -s; this.uy = -c;
    ctx.lineJoin = 'round';
    return this;
  };
  K.vis = function () { return this.mode === 'main' || this.mode === 'live'; };

  // Local frame. The kit tracks the light through it, so bevels stay correct on rotated / mirrored parts.
  K.push = function (x, y, rot, kx, ky) {
    const c = this.ctx;
    c.save();
    this._st.push(this.lx, this.ly, this.sx, this.sy, this.ux, this.uy);
    if (x || y) c.translate(x, y);
    if (rot) {
      c.rotate(rot);
      const co = Math.cos(rot), si = Math.sin(rot);
      let a = this.lx, b = this.ly; this.lx = a * co + b * si; this.ly = -a * si + b * co;
      a = this.sx; b = this.sy; this.sx = a * co + b * si; this.sy = -a * si + b * co;
      a = this.ux; b = this.uy; this.ux = a * co + b * si; this.uy = -a * si + b * co;
    }
    if (kx !== undefined && (kx !== 1 || (ky !== undefined && ky !== 1))) {
      if (ky === undefined) ky = kx;
      c.scale(kx, ky);
      if (kx < 0) this.lx = -this.lx;
      if (ky < 0) this.ly = -this.ly;
      this.sx /= kx; this.sy /= ky; this.ux /= kx; this.uy /= ky;
    }
    return this;
  };
  K.pop = function () {
    const s = this._st;
    this.uy = s.pop(); this.ux = s.pop(); this.sy = s.pop(); this.sx = s.pop(); this.ly = s.pop(); this.lx = s.pop();
    this.ctx.restore();
    return this;
  };
  // Draw fn lifted z px above the current ground plane (roof details, canopies). Coordinates inside stay
  // PLAN coordinates; the kit shifts them north on screen and along the light in the shadow pass.
  K.at = function (z, fn) {
    const c = this.ctx, sh = this.mode === 'shadow';
    const dx = (sh ? this.sx : this.ux) * z, dy = (sh ? this.sy : this.uy) * z;
    c.translate(dx, dy); this.z += z;
    fn(this);
    this.z -= z; c.translate(-dx, -dy);
    return this;
  };

  K._lit = function (bb, col, k) {
    const cx = bb[0] + bb[2] / 2, cy = bb[1] + bb[3] / 2;
    const e = (Math.abs(this.lx) * bb[2] + Math.abs(this.ly) * bb[3]) / 2 || 1;
    const gr = this.ctx.createLinearGradient(cx + this.lx * e, cy + this.ly * e, cx - this.lx * e, cy - this.ly * e);
    gr.addColorStop(0, A.shade(col, k)); gr.addColorStop(1, A.shade(col, -k * 1.4));
    return gr;
  };
  // fill the part of the (already clipped) shape that the shape shifted by (dx, dy) does not cover
  K._band = function (p, dx, dy, style) {
    const c = this.ctx, q = new Path2D(p);
    q.rect(-4096, -4096, 8192, 8192);
    c.translate(dx, dy); c.fillStyle = style; c.fill(q, 'evenodd'); c.translate(-dx, -dy);
  };

  // THE painter: lit fill + light-side highlight band + far-side shade band + outline.
  // o: { lit: gradient strength (0 = flat, default .12), bevel: band strength (0 = none, < 0 = recessed, default 1),
  //      bw: band width, ol: outline colour | false, lw: outline width, outer: outline outside the shape (default:
  //      true on unit layers so small parts keep their colour, false on buildings so footprints stay exact),
  //      alpha, fill: CanvasGradient override }
  K.solid = function (p, col, o) {
    const c = this.ctx, m = this.mode;
    o = o || NONE;
    if (m !== 'main') {
      const a = o.alpha === undefined ? 1 : o.alpha, ga = c.globalAlpha;
      if (m === 'live') {
        c.globalAlpha = ga * a; c.fillStyle = o.fill || col; c.fill(p);
        if (o.ol) { c.strokeStyle = o.ol; c.lineWidth = o.lw || 1; c.stroke(p); }
      } else if (m === 'sil' || (m === 'shadow' && this.z > 0)) {
        c.globalAlpha = ga * a; c.fillStyle = '#000'; c.fill(p);
      } else if (m === 'glow' && a > 0.5) {
        c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000'; c.fill(p);
        c.globalCompositeOperation = 'source-over';
      }
      c.globalAlpha = ga;
      return p;
    }
    const outer = o.outer === undefined ? this.outer : o.outer, lw = o.lw === undefined ? (outer ? 0.7 : 0.9) : o.lw;
    const ol = o.ol === false ? null : o.ol || A.shade(col, outer ? -0.74 : -0.62);
    c.save();
    if (o.alpha !== undefined) c.globalAlpha *= o.alpha;
    if (ol && outer) { c.strokeStyle = ol; c.lineWidth = 2 * lw; c.stroke(p); }
    c.clip(p);
    const lit = o.lit === undefined ? 0.12 : o.lit;
    c.fillStyle = o.fill || (lit && p.bb ? this._lit(p.bb, col, lit) : col);
    c.fill(p);
    const bv = o.bevel === undefined ? 1 : o.bevel;
    if (bv) {
      const w = (o.bw || (outer ? 0.8 : 1)) * (bv < 0 ? -1 : 1), k = bv < 0 ? -bv : bv;
      this._band(p, -this.lx * w, -this.ly * w, 'rgba(255,255,255,' + 0.26 * k + ')');
      this._band(p, this.lx * w, this.ly * w, 'rgba(0,0,0,' + 0.3 * k + ')');
    }
    if (ol && !outer) { c.strokeStyle = ol; c.lineWidth = 2 * lw; c.stroke(p); }
    c.restore();
    return p;
  };
  A.FLAT = Object.freeze({ lit: 0, bevel: 0, ol: false });

  K.rect = function (x, y, w, h, col, o) { return this.solid(P.rect(x, y, w, h, o && o.r), col, o); };
  K.poly = function (pts, col, o) { return this.solid(P.poly(pts, o && o.r), col, o); };
  K.circle = function (x, y, r, col, o) { return this.solid(P.circle(x, y, r), col, o); };
  K.ellipse = function (x, y, rx, ry, col, o) { return this.solid(P.ellipse(x, y, rx, ry, o && o.rot), col, o); };
  K.capsule = function (x0, y0, x1, y1, r, col, o) { return this.solid(P.capsule(x0, y0, x1, y1, r, o && o.r1), col, o); };
  K.blob = function (pts, col, o) { return this.solid(P.blob(pts), col, o); };

  // plain stroke of a path (wires, seams, antennas). Occludes glow, joins the silhouette.
  K.stroke = function (p, col, w, o) {
    const c = this.ctx, m = this.mode;
    if (m === 'shadow' && this.z <= 0) return p;
    c.lineCap = (o && o.cap) || 'round'; c.lineWidth = w || 1;
    if (m === 'glow') { c.globalCompositeOperation = 'destination-out'; c.strokeStyle = '#000'; c.stroke(p); c.globalCompositeOperation = 'source-over'; return p; }
    c.strokeStyle = m === 'sil' || m === 'shadow' ? '#000' : col;
    c.stroke(p);
    return p;
  };
  K.line = function (x0, y0, x1, y1, col, w, o) { return this.stroke(P.line([x0, y0, x1, y1]), col, w, o); };
  K.lines = function (pts, col, w, o) { return this.stroke(P.line(pts, o && o.close), col, w, o); };
  // gradients for the `fill` option. stops = [offset, colour, offset, colour, ...]
  K.lgrad = function (x0, y0, x1, y1, stops) {
    const gr = this.ctx.createLinearGradient(x0, y0, x1, y1);
    for (let i = 0; i < stops.length; i += 2) gr.addColorStop(stops[i], stops[i + 1]);
    return gr;
  };
  K.rgrad = function (x, y, r0, r1, stops) {
    const gr = this.ctx.createRadialGradient(x, y, r0, x, y, r1);
    for (let i = 0; i < stops.length; i += 2) gr.addColorStop(stops[i], stops[i + 1]);
    return gr;
  };

  // --------------------------------------------------------------------------
  // Surface details (main pass only — they never change a silhouette)
  // --------------------------------------------------------------------------
  // engraved seams splitting a rect into nx x ny panels
  K.panels = function (x, y, w, h, nx, ny, col, lw) {
    if (!this.vis()) return;
    const c = this.ctx;
    c.strokeStyle = col || 'rgba(0,0,0,0.28)'; c.lineWidth = lw || 0.6; c.lineCap = 'butt'; c.beginPath();
    for (let i = 1; i < nx; i++) { const X = x + w * i / nx; c.moveTo(X, y); c.lineTo(X, y + h); }
    for (let j = 1; j < ny; j++) { const Y = y + h * j / ny; c.moveTo(x, Y); c.lineTo(x + w, Y); }
    c.stroke();
  };
  // rivet dots along the long edges of a rect
  K.rivets = function (x, y, w, h, step, col) {
    if (!this.vis()) return;
    const c = this.ctx;
    c.fillStyle = col || 'rgba(0,0,0,0.38)'; step = step || 4;
    for (let X = x + step / 2; X < x + w; X += step) { c.fillRect(X - 0.4, y + 0.6, 0.8, 0.8); c.fillRect(X - 0.4, y + h - 1.4, 0.8, 0.8); }
  };
  // louvred vent / radiator. o: { col, slat, step, v: vertical slats, r }
  K.vent = function (x, y, w, h, o) {
    o = o || NONE;
    this.rect(x, y, w, h, o.col || '#1d222b', { lit: 0, bevel: -0.7, r: o.r === undefined ? 0.6 : o.r, ol: '#0b0d12' });
    if (!this.vis()) return;
    const c = this.ctx, st = o.step || 2;
    c.strokeStyle = o.slat || 'rgba(150,165,190,0.4)'; c.lineWidth = 0.6; c.lineCap = 'butt'; c.beginPath();
    if (o.v) for (let X = x + st; X < x + w - 0.6; X += st) { c.moveTo(X, y + 1); c.lineTo(X, y + h - 1); }
    else for (let Y = y + st; Y < y + h - 0.6; Y += st) { c.moveTo(x + 1, Y); c.lineTo(x + w - 1, Y); }
    c.stroke();
  };
  // stripes clipped to a path. cols cycle (null = leave the surface showing); ang 0 = bands along x.
  K.stripes = function (p, cols, step, ang) {
    if (!this.vis()) return;
    const c = this.ctx, b = p.bb, R = Math.hypot(b[2], b[3]) / 2 + step * 2;
    c.save(); c.clip(p); c.translate(b[0] + b[2] / 2, b[1] + b[3] / 2); c.rotate(ang || 0);
    let i = 0;
    for (let X = -Math.ceil(R / step) * step; X < R; X += step, i++) {
      const col = cols[i % cols.length];
      if (col) { c.fillStyle = col; c.fillRect(X, -R, step + 0.06, 2 * R); }
    }
    c.restore();
  };
  // warning stripes. o: { a, b, step, ang, r }
  K.hazard = function (x, y, w, h, o) {
    o = o || NONE;
    const p = P.rect(x, y, w, h, o.r);
    this.solid(p, o.a || A.PAL.hazard, A.FLAT);
    this.stripes(p, [null, o.b || '#16181d'], o.step || 2.4, o.ang === undefined ? 0.8 : o.ang);
    if (this.vis()) { const c = this.ctx; c.strokeStyle = 'rgba(0,0,0,0.45)'; c.lineWidth = 0.6; c.stroke(p); }
  };
  // n chevrons pointing along +x (rank marks, team markings, direction arrows)
  K.chevrons = function (x, y, w, h, col, n, lw) {
    if (!this.vis()) return;
    const c = this.ctx; n = n || 2;
    c.strokeStyle = col; c.lineWidth = lw || 1.1; c.lineCap = 'butt'; c.lineJoin = 'miter'; c.beginPath();
    for (let i = 0; i < n; i++) {
      const X = x + (w / n) * i;
      c.moveTo(X, y); c.lineTo(X + w / n * 0.62, y + h / 2); c.lineTo(X, y + h);
    }
    c.stroke(); c.lineJoin = 'round';
  };
  // rows of dashes that read as signage text from above. o: { rows, seed, lw, vertical }
  K.scribble = function (x, y, w, h, col, o) {
    if (!this.vis()) return;
    o = o || NONE;
    const c = this.ctx, rows = o.rows || Math.max(1, Math.round((o.vertical ? w : h) / 2.4)), seed = o.seed || 7;
    c.strokeStyle = col; c.lineWidth = o.lw || 0.8; c.lineCap = 'butt'; c.beginPath();
    for (let j = 0; j < rows; j++) {
      const span = o.vertical ? h : w;
      let u = 0, k = 0;
      while (u < span - 1) {
        const len = 1 + ih(seed + j * 17, k) * 3.2, e = Math.min(span, u + len), v = (j + 0.5) / rows;
        if (o.vertical) { c.moveTo(x + w * v, y + u); c.lineTo(x + w * v, y + e); }
        else { c.moveTo(x + u, y + h * v); c.lineTo(x + e, y + h * v); }
        u = e + 0.9 + ih(seed + j, k + 31) * 1.2; k++;
      }
    }
    c.stroke();
  };
  // chain-link / cage / grating hatch clipped to a path. o: { step, col, lw, ang, cross: false = one direction only }
  K.mesh = function (p, o) {
    if (!this.vis()) return;
    o = o || NONE;
    const c = this.ctx, b = p.bb, st = o.step || 3, R = Math.hypot(b[2], b[3]) / 2 + st;
    c.save(); c.clip(p); c.translate(b[0] + b[2] / 2, b[1] + b[3] / 2); c.rotate(o.ang === undefined ? PI / 4 : o.ang);
    c.strokeStyle = o.col || 'rgba(170,184,210,0.42)'; c.lineWidth = o.lw || 0.5; c.lineCap = 'butt'; c.beginPath();
    for (let v = -Math.ceil(R / st) * st; v <= R; v += st) {
      c.moveTo(v, -R); c.lineTo(v, R);
      if (o.cross !== false) { c.moveTo(-R, v); c.lineTo(R, v); }
    }
    c.stroke(); c.restore();
  };

  // --------------------------------------------------------------------------
  // Light: emissive primitives. They paint their fixture in the main pass and their halo in the glow pass.
  // --------------------------------------------------------------------------
  // Only the BLURRED image of whatever draw() paints lands on the canvas (the shape itself is parked
  // far outside). Bake-time only: shadowBlur per frame is exactly what the cache exists to avoid.
  K._blur = function (col, r, draw) {
    const c = this.ctx, m = c.getTransform(), OFF = 16384;
    c.save();
    c.shadowColor = col; c.shadowBlur = Math.max(0.5, r * this.scale * 2); c.shadowOffsetX = OFF; c.shadowOffsetY = 0;
    c.setTransform(m.a, m.b, m.c, m.d, m.e - OFF, m.f);
    c.fillStyle = '#000'; c.strokeStyle = '#000';
    draw(c);
    c.restore();
  };
  // free-form halo around a path (glow pass). o: { r: blur px, a: strength }
  K.glow = function (p, col, o) {
    this.em++;
    if (this.mode !== 'glow' || !this.on) return;
    o = o || NONE;
    this._blur(A.alpha(col, o.a === undefined ? 0.8 : o.a), o.r || 3, function (c) { c.fill(p); });
  };
  // soft pool of coloured light on the ground / a wall (glow pass)
  K.pool = function (x, y, rx, ry, col, a) {
    this.em++;
    if (this.mode !== 'glow' || !this.on) return;
    const c = this.ctx, gr = c.createRadialGradient(0, 0, 0, 0, 0, rx);
    gr.addColorStop(0, A.alpha(col, a === undefined ? 0.4 : a)); gr.addColorStop(1, A.alpha(col, 0));
    c.save(); c.translate(x, y); c.scale(1, ry / rx); c.fillStyle = gr; c.beginPath(); c.arc(0, 0, rx, 0, TAU); c.fill(); c.restore();
  };
  // neon tube along a path (Path2D or flat points). o: { w: tube width, r: halo px, a, close }
  K.neon = function (path, col, o) {
    o = o || NONE;
    const c = this.ctx, m = this.mode, w = o.w || 1.5, p = path instanceof Path2D ? path : P.line(path, o.close);
    this.em++;
    c.lineCap = 'round'; c.lineJoin = 'round';
    if (m === 'main' || m === 'live') {
      c.strokeStyle = 'rgba(5,6,10,0.8)'; c.lineWidth = w + 1.3; c.stroke(p);
      if (this.on) {
        c.strokeStyle = col; c.lineWidth = w; c.stroke(p);
        c.strokeStyle = A.mix(col, '#ffffff', 0.72); c.lineWidth = w * 0.42; c.stroke(p);
      } else { c.strokeStyle = A.mix(col, '#343842', 0.82); c.lineWidth = w; c.stroke(p); }
    } else if (m === 'glow') {
      if (!this.on) return;
      this._blur(A.alpha(col, o.a === undefined ? 0.95 : o.a), o.r || 3.2, function (x) { x.lineCap = 'round'; x.lineWidth = w * 1.8; x.stroke(p); });
      c.strokeStyle = A.alpha(col, 0.3); c.lineWidth = w; c.stroke(p);
    } else if (m === 'sil' || this.z > 0) { c.strokeStyle = '#000'; c.lineWidth = w; c.stroke(p); }
  };
  // light fixture + halo. o: { r: bulb radius, reach: halo radius, a }
  K.lamp = function (x, y, col, o) {
    o = o || NONE;
    const c = this.ctx, m = this.mode, r = o.r || 1.2;
    this.em++;
    if (m === 'main' || m === 'live') {
      c.fillStyle = '#0a0c12'; c.beginPath(); c.arc(x, y, r + 0.7, 0, TAU); c.fill();
      c.fillStyle = this.on ? col : A.mix(col, '#2a2d36', 0.85); c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill();
      if (this.on) { c.fillStyle = 'rgba(255,255,255,0.85)'; c.beginPath(); c.arc(x, y, r * 0.5, 0, TAU); c.fill(); }
    } else if (m === 'glow' && this.on) {
      const R = o.reach || 9, gr = c.createRadialGradient(x, y, 0, x, y, R);
      gr.addColorStop(0, A.alpha(col, o.a === undefined ? 0.75 : o.a)); gr.addColorStop(0.35, A.alpha(col, 0.22)); gr.addColorStop(1, A.alpha(col, 0));
      c.fillStyle = gr; c.beginPath(); c.arc(x, y, R, 0, TAU); c.fill();
    }
  };
  // tiny indicator light (no fixture)
  K.led = function (x, y, col, r) { this.lamp(x, y, col, { r: r || 0.7, reach: (r || 0.7) * 5, a: 0.6 }); };
  // translucent steam / smoke / light ball — THE primitive of live overlays (anim, lights): one blit of a
  // cached soft dot per call, no gradient objects per frame
  K.puff = function (x, y, r, col, a) {
    if (!this.vis()) return;
    const c = this.ctx, ga = c.globalAlpha;
    c.globalAlpha = ga * (a === undefined ? 0.3 : a);
    c.drawImage(dot(col || '#cfd8e6'), x - r, y - r, 2 * r, 2 * r);
    c.globalAlpha = ga;
  };
  // Glowing flat panel (TV, ad screen, lit sign face). o: { a: halo strength, blur, dark: colour when off, scan: false, r }
  K.screen = function (x, y, w, h, col, o) {
    o = o || NONE;
    const c = this.ctx, m = this.mode, p = P.rect(x, y, w, h, o.r);
    this.em++;
    if (m === 'main' || m === 'live') {
      if (!this.on) { c.fillStyle = o.dark || '#0c1017'; c.fill(p); return p; }
      const gr = c.createLinearGradient(0, y, 0, y + h);
      gr.addColorStop(0, A.shade(col, 0.22)); gr.addColorStop(1, A.shade(col, -0.22));
      c.fillStyle = gr; c.fill(p);
      if (o.scan !== false && h > 3) { c.fillStyle = 'rgba(0,0,0,0.13)'; for (let Y = y + 1; Y < y + h; Y += 2) c.fillRect(x, Y, w, 0.7); }
    } else if (m === 'glow') {
      if (!this.on) return p;
      this._blur(A.alpha(col, o.a === undefined ? 0.6 : o.a), o.blur || 3, function (k) { k.fill(p); });
      c.fillStyle = A.alpha(col, 0.22); c.fill(p);
    } else if (m === 'sil' || this.z > 0) { c.fillStyle = '#000'; c.fill(p); }
    return p;
  };
  // String of bulbs (or pennants) through elevated points. pts = [x, y, z, x, y, z, ...] (plan position + height).
  // o: { n: bulbs per span, col | cols: [...], r, reach, sag, wire, flags: true = bunting instead of bulbs }
  K.string = function (pts, o) {
    o = o || NONE;
    if (this.mode === 'shadow' || this.mode === 'sil') return;
    const c = this.ctx, n = o.n || 4, sag = o.sag === undefined ? 2 : o.sag, cols = o.cols || [o.col || '#ffe2b0'], V = this.vis();
    let k = 0;
    for (let i = 0; i + 5 < pts.length; i += 3) {
      const ax = pts[i] + this.ux * pts[i + 2], ay = pts[i + 1] + this.uy * pts[i + 2];
      const bx = pts[i + 3] + this.ux * pts[i + 5], by = pts[i + 4] + this.uy * pts[i + 5];
      const mx = (ax + bx) / 2 - this.ux * sag * 2, my = (ay + by) / 2 - this.uy * sag * 2;      // hangs toward the ground
      if (V) { c.strokeStyle = o.wire || 'rgba(6,7,11,0.9)'; c.lineWidth = 0.6; c.beginPath(); c.moveTo(ax, ay); c.quadraticCurveTo(mx, my, bx, by); c.stroke(); }
      for (let j = 0; j < n; j++, k++) {
        const t = (j + 0.5) / n, u = 1 - t, X = u * u * ax + 2 * u * t * mx + t * t * bx, Y = u * u * ay + 2 * u * t * my + t * t * by, col = cols[k % cols.length];
        if (!o.flags) this.lamp(X, Y, col, { r: o.r || 0.9, reach: o.reach || 5, a: 0.6 });
        else if (V) { c.fillStyle = col; c.beginPath(); c.moveTo(X - 1.4, Y); c.lineTo(X + 1.4, Y); c.lineTo(X, Y + 2.8); c.fill(); }
      }
    }
  };

  // Stroke pictograms for signs: polylines in a 0..1 box; ['o', cx, cy, r] = circle.
  A.GLYPHS = {
    cross: [[0.5, 0.08, 0.5, 0.92], [0.08, 0.5, 0.92, 0.5]],
    plus: [[0.36, 0.08, 0.64, 0.08, 0.64, 0.36, 0.92, 0.36, 0.92, 0.64, 0.64, 0.64, 0.64, 0.92, 0.36, 0.92, 0.36, 0.64, 0.08, 0.64, 0.08, 0.36, 0.36, 0.36, 0.36, 0.08]],
    bolt: [[0.64, 0.04, 0.26, 0.54, 0.52, 0.54, 0.36, 0.96, 0.76, 0.42, 0.5, 0.42, 0.64, 0.04]],
    bowl: [[0.04, 0.5, 0.96, 0.5], [0.12, 0.52, 0.26, 0.88, 0.74, 0.88, 0.88, 0.52], [0.34, 0.36, 0.42, 0.24, 0.34, 0.1], [0.6, 0.36, 0.68, 0.24, 0.6, 0.1]],
    gem: [[0.5, 0.94, 0.06, 0.38, 0.28, 0.08, 0.72, 0.08, 0.94, 0.38, 0.5, 0.94], [0.06, 0.38, 0.94, 0.38]],
    balls: [['o', 0.5, 0.24, 0.17], ['o', 0.22, 0.72, 0.17], ['o', 0.78, 0.72, 0.17]],
    wrench: [[0.2, 0.06, 0.2, 0.3, 0.36, 0.42, 0.52, 0.3, 0.52, 0.06], [0.36, 0.42, 0.72, 0.94]],
    gear: [['o', 0.5, 0.5, 0.2], [0.5, 0.04, 0.5, 0.22], [0.5, 0.78, 0.5, 0.96], [0.04, 0.5, 0.22, 0.5], [0.78, 0.5, 0.96, 0.5], [0.17, 0.17, 0.3, 0.3], [0.7, 0.7, 0.83, 0.83], [0.83, 0.17, 0.7, 0.3], [0.3, 0.7, 0.17, 0.83]],
    eye: [[0.03, 0.5, 0.3, 0.2, 0.7, 0.2, 0.97, 0.5, 0.7, 0.8, 0.3, 0.8, 0.03, 0.5], ['o', 0.5, 0.5, 0.15]],
    lantern: [[0.3, 0.2, 0.7, 0.2, 0.84, 0.5, 0.7, 0.8, 0.3, 0.8, 0.16, 0.5, 0.3, 0.2], [0.5, 0.04, 0.5, 0.2], [0.5, 0.8, 0.5, 0.97]],
    arrow: [[0.06, 0.5, 0.9, 0.5], [0.62, 0.2, 0.92, 0.5, 0.62, 0.8]],
    star: [[0.5, 0.04, 0.62, 0.38, 0.97, 0.38, 0.68, 0.6, 0.8, 0.95, 0.5, 0.73, 0.2, 0.95, 0.32, 0.6, 0.03, 0.38, 0.38, 0.38, 0.5, 0.04]],
    fang: [[0.14, 0.08, 0.86, 0.08], [0.24, 0.1, 0.36, 0.92, 0.48, 0.1], [0.56, 0.1, 0.68, 0.7, 0.78, 0.1]],
    shield: [[0.5, 0.96, 0.12, 0.62, 0.12, 0.1, 0.88, 0.1, 0.88, 0.62, 0.5, 0.96]],
    skull: [['o', 0.5, 0.4, 0.32], [0.36, 0.7, 0.36, 0.94, 0.64, 0.94, 0.64, 0.7], [0.5, 0.74, 0.5, 0.94]],
    crown: [[0.08, 0.86, 0.08, 0.24, 0.3, 0.52, 0.5, 0.14, 0.7, 0.52, 0.92, 0.24, 0.92, 0.86, 0.08, 0.86]],
    bars: [[0.1, 0.2, 0.9, 0.2], [0.1, 0.5, 0.66, 0.5], [0.1, 0.8, 0.82, 0.8]],
    dish: [[0.1, 0.34, 0.3, 0.72, 0.7, 0.72, 0.9, 0.34], [0.5, 0.72, 0.5, 0.96], [0.5, 0.5, 0.74, 0.12]],
    paw: [['o', 0.5, 0.64, 0.22], ['o', 0.2, 0.34, 0.1], ['o', 0.42, 0.16, 0.1], ['o', 0.66, 0.18, 0.1], ['o', 0.84, 0.4, 0.1]],
    glass: [[0.08, 0.1, 0.92, 0.1, 0.5, 0.56, 0.08, 0.1], [0.5, 0.56, 0.5, 0.9], [0.26, 0.92, 0.74, 0.92]],
    mug: [[0.14, 0.14, 0.14, 0.9, 0.66, 0.9, 0.66, 0.14, 0.14, 0.14], [0.66, 0.3, 0.9, 0.3, 0.9, 0.7, 0.66, 0.7]],
    bottle: [[0.4, 0.04, 0.4, 0.3, 0.24, 0.48, 0.24, 0.96, 0.76, 0.96, 0.76, 0.48, 0.6, 0.3, 0.6, 0.04, 0.4, 0.04]],
    coin: [['o', 0.5, 0.5, 0.42], [0.5, 0.24, 0.5, 0.76], [0.34, 0.4, 0.66, 0.4], [0.34, 0.58, 0.66, 0.58]],
    flame: [[0.5, 0.04, 0.8, 0.5, 0.74, 0.8, 0.5, 0.96, 0.26, 0.8, 0.2, 0.5, 0.38, 0.38, 0.42, 0.56, 0.5, 0.04]],
  };
  A.glyphPath = function (name, x, y, w, h) {
    const p = new Path2D(), gl = A.GLYPHS[name] || A.GLYPHS.bars;
    for (let i = 0; i < gl.length; i++) {
      const s = gl[i];
      if (s[0] === 'o') { const r = s[3] * Math.min(w, h); p.moveTo(x + s[1] * w + r, y + s[2] * h); p.arc(x + s[1] * w, y + s[2] * h, r, 0, TAU); continue; }
      p.moveTo(x + s[0] * w, y + s[1] * h);
      for (let k = 2; k < s.length; k += 2) p.lineTo(x + s[k] * w, y + s[k + 1] * h);
    }
    p.bb = [x, y, w, h];
    return p;
  };
  // neon pictogram. o as for neon
  K.glyph = function (name, x, y, w, h, col, o) { this.neon(A.glyphPath(name, x, y, w, h), col, o); };
  // backing board + neon pictogram / pseudo text. o: { col, glyph, back, frame, text: colour of extra dashes, seed, w }
  K.sign = function (x, y, w, h, o) {
    o = o || NONE;
    const col = o.col || A.PAL.hot, m = Math.min(w, h) * 0.16;
    this.rect(x, y, w, h, o.back || '#12151d', { lit: 0, bevel: 0.5, r: 1, ol: o.frame || '#05060a' });
    if (o.glyph) {
      const gs = Math.min(w, h) - 2 * m;
      this.glyph(o.glyph, o.text ? x + m : x + (w - gs) / 2, y + (h - gs) / 2, gs, gs, col, { w: o.w || Math.max(0.9, gs * 0.13), r: o.r });
      if (o.text && this.on) this.scribble(x + gs + m * 2, y + m * 1.4, w - gs - m * 3, h - m * 2.8, o.text, { seed: o.seed, lw: 0.9 });
    } else if (this.on) this.scribble(x + m, y + m, w - 2 * m, h - 2 * m, col, { seed: o.seed, lw: 1 });
    if (!o.glyph || o.text) this.glow(P.rect(x + m, y + m, w - 2 * m, h - 2 * m), o.text || col, { r: 2.4, a: 0.4 });
  };
  // Grid of panes on a wall or roof. o: { cols, rows, gap, lit: 0..1 share, col: lit colour | [colours], dark, seed, a, blur }
  K.windows = function (x, y, w, h, o) {
    o = o || NONE;
    const m = this.mode, c = this.ctx;
    this.em++;
    if (m === 'sil' || m === 'shadow') return;
    const cols = o.cols || Math.max(1, Math.round(w / 5)), rows = o.rows || Math.max(1, Math.round(h / 5));
    const gap = o.gap === undefined ? 1 : o.gap, pw = (w - gap * (cols - 1)) / cols, ph = (h - gap * (rows - 1)) / rows;
    const lit = o.lit === undefined ? 0.5 : o.lit, seed = o.seed || 0, pal = Array.isArray(o.col) ? o.col : [o.col || A.PAL.glassLit];
    const halo = new Path2D();
    let any = false;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const X = x + i * (pw + gap), Y = y + j * (ph + gap), r = ih(seed * 131 + i, j * 29 + 7), on = this.on && r < lit;
      if (m === 'glow') { if (on) { halo.rect(X, Y, pw, ph); any = true; } continue; }
      if (on) {
        c.fillStyle = pal[((r / lit) * pal.length) | 0] || pal[0]; c.fillRect(X, Y, pw, ph);
        c.fillStyle = 'rgba(255,255,255,0.3)'; c.fillRect(X, Y, pw, ph * 0.4);
      } else {
        c.fillStyle = o.dark || A.PAL.glass; c.fillRect(X, Y, pw, ph);
        c.fillStyle = 'rgba(130,160,200,0.14)'; c.fillRect(X, Y, pw * 0.5, ph * 0.5);
      }
    }
    if (any) this._blur(A.alpha(pal[0], o.a === undefined ? 0.5 : o.a), o.blur || 2, function (x2) { x2.fill(halo); });
  };

  // --------------------------------------------------------------------------
  // Building blocks. Height is faked: a thing h px tall shows a SOUTH wall and its top drawn h px north.
  // --------------------------------------------------------------------------
  // ground shadow of a prism: the footprint swept along the light (shadow pass)
  K._sweep = function (pts, h) {
    const c = this.ctx, dx = this.sx * h, dy = this.sy * h, n = pts.length;
    c.fillStyle = '#000';
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n;
      c.beginPath(); c.moveTo(pts[i], pts[i + 1]); c.lineTo(pts[j], pts[j + 1]);
      c.lineTo(pts[j] + dx, pts[j + 1] + dy); c.lineTo(pts[i] + dx, pts[i + 1] + dy); c.fill();
    }
    for (let k = 0; k < 2; k++) {
      const ox = k ? dx : 0, oy = k ? dy : 0;
      c.beginPath(); c.moveTo(pts[0] + ox, pts[1] + oy);
      for (let i = 2; i < n; i += 2) c.lineTo(pts[i] + ox, pts[i + 1] + oy);
      c.fill();
    }
  };
  K._wallFill = function (wall, y0, y1) {
    if (this.mode !== 'main') return null;
    const gr = this.ctx.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, A.shade(wall, 0.05)); gr.addColorStop(1, A.shade(wall, -0.32));
    return gr;
  };
  // Extruded box: plan footprint (x, y, w, d), h px tall. o: { roof, wall, r, lip: parapet width, deck }
  // Returns the roof AS DRAWN {x, y, w, d, h} + .wall {x, y, w, h} (the visible south face) for placing details.
  K.box = function (x, y, w, d, h, o) {
    o = o || NONE;
    const roof = o.roof || '#39404f', wall = o.wall || A.shade(roof, -0.42);
    const out = { x: x, y: y - h, w: w, d: d, h: h, wall: { x: x, y: y + d - h, w: w, h: h } };
    if (this.mode === 'shadow') { this._sweep([x, y, x + w, y, x + w, y + d, x, y + d], h); return out; }
    if (h > 0) this.solid(P.rect(x, y + d - h, w, h), wall, { fill: this._wallFill(wall, y + d - h, y + d), bevel: 0, lit: 0 });
    this.solid(P.rect(x, y - h, w, d, o.r), roof, { lit: 0.1 });
    if (o.lip) {
      const l = o.lip;
      this.solid(P.rect(x + l, y - h + l, w - 2 * l, d - 2 * l, o.r), o.deck || A.shade(roof, -0.16), { lit: 0.06, bevel: -0.8 });
    }
    return out;
  };
  // Extruded convex polygon (flat plan points, CLOCKWISE on screen). o: { wall, roof, r }
  K.prism = function (pts, h, col, o) {
    o = o || NONE;
    const n = pts.length, wall = o.wall || A.shade(col, -0.42), top = [];
    if (this.mode === 'shadow') { this._sweep(pts, h); return null; }
    for (let i = 0; i < n; i += 2) {
      const j = (i + 2) % n, ex = pts[j] - pts[i], ey = pts[j + 1] - pts[i + 1], len = Math.hypot(ex, ey) || 1;
      top.push(pts[i], pts[i + 1] - h);
      if (-ex / len <= 0.02 || h <= 0) continue;                     // normal (ey, -ex) does not face south: hidden
      this.poly([pts[i], pts[i + 1] - h, pts[j], pts[j + 1] - h, pts[j], pts[j + 1], pts[i], pts[i + 1]],
        A.shade(wall, -0.22 * ey / len), { lit: 0, bevel: 0 });
    }
    return this.poly(top, o.roof || col, { r: o.r, lit: 0.1 });
  };
  // Upright cylinder standing on plan point (x, y). o: { wall, top, cap: colour of an inner lid, bands: n }
  K.cyl = function (x, y, r, h, col, o) {
    o = o || NONE;
    const c = this.ctx;
    if (this.mode === 'shadow') { c.fillStyle = '#000'; c.fill(P.capsule(x, y, x + this.sx * h, y + this.sy * h, r)); return; }
    if (h > 0) {
      const p = new Path2D(), wall = o.wall || A.shade(col, -0.3);
      p.moveTo(x - r, y - h); p.lineTo(x - r, y); p.arc(x, y, r, PI, 0, true); p.lineTo(x + r, y - h); p.closePath();
      let fill = null;
      if (this.mode === 'main') {
        fill = c.createLinearGradient(x - r, 0, x + r, 0);
        fill.addColorStop(0, A.shade(wall, 0.2)); fill.addColorStop(0.4, wall); fill.addColorStop(1, A.shade(wall, -0.42));
      }
      this.solid(p, wall, { fill: fill, bevel: 0, lit: 0 });
      if (o.bands && this.vis()) {
        c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 0.6;
        for (let i = 1; i <= o.bands; i++) { c.beginPath(); c.arc(x, y - h * i / (o.bands + 1), r, 0, PI); c.stroke(); }
      }
    }
    this.solid(P.circle(x, y - h, r), o.top || col, { lit: 0.18 });
    if (o.cap) this.solid(P.circle(x, y - h, r * 0.56), o.cap, { lit: 0.12, bevel: 0.7, lw: 0.6 });
  };
  // Pitched roof on a box: eaves h px up, ridge `rise` px higher, along x (default) or y (o.ridge = 'y').
  // o: { roof, wall, ridge, ribs: seam spacing px }
  K.gable = function (x, y, w, d, h, rise, o) {
    o = o || NONE;
    const roof = o.roof || '#4a5262', wall = o.wall || A.shade(roof, -0.42), c = this.ctx, yE = y + d - h;
    if (this.mode === 'shadow') { this._sweep([x, y, x + w, y, x + w, y + d, x, y + d], h + rise * 0.6); return; }
    const hi = A.shade(roof, 0.1), lo = A.shade(roof, -0.18), rib = o.ribs, V = this.vis();
    if (o.ridge === 'y') {
      const xm = x + w / 2;
      this.poly([x, yE, xm, yE - rise, x + w, yE, x + w, y + d, x, y + d], wall, { fill: this._wallFill(wall, yE - rise, y + d), bevel: 0, lit: 0 });
      this.poly([x, y - h, xm, y - h - rise, xm, yE - rise, x, yE], hi, { lit: 0.08 });
      this.poly([xm, y - h - rise, x + w, y - h, x + w, yE, xm, yE - rise], lo, { lit: 0.08 });
      if (rib && V) {
        c.strokeStyle = 'rgba(0,0,0,0.2)'; c.lineWidth = 0.6; c.beginPath();
        for (let Y = y - h + rib; Y < yE - 0.5; Y += rib) { c.moveTo(x + 0.8, Y); c.lineTo(xm, Y - rise); c.lineTo(x + w - 0.8, Y); }
        c.stroke();
      }
      if (V) this.line(xm, y - h - rise + 0.6, xm, yE - rise - 0.6, A.shade(roof, 0.3), 0.8);
    } else {
      const yR = y + d / 2 - h - rise;
      if (h > 0) this.solid(P.rect(x, yE, w, h), wall, { fill: this._wallFill(wall, yE, y + d), bevel: 0, lit: 0 });
      this.poly([x, y - h, x + w, y - h, x + w, yR, x, yR], hi, { lit: 0.08 });
      this.poly([x, yR, x + w, yR, x + w, yE, x, yE], lo, { lit: 0.08 });
      if (rib && V) {
        c.strokeStyle = 'rgba(0,0,0,0.2)'; c.lineWidth = 0.6; c.beginPath();
        for (let X = x + rib; X < x + w - 0.5; X += rib) { c.moveTo(X, y - h + 0.8); c.lineTo(X, yE - 0.8); }
        c.stroke();
      }
      if (V) this.line(x + 0.6, yR, x + w - 0.6, yR, A.shade(roof, 0.3), 0.8);
    }
  };
  // Thin vertical pole on plan point (x, y), h px tall. o: { col, w, bars: n cross-arms, barW, tip: lamp colour }
  K.mast = function (x, y, h, o) {
    o = o || NONE;
    const c = this.ctx, w = o.w || 1.2, col = o.col || '#8b96aa';
    if (this.mode === 'shadow') {
      c.strokeStyle = '#000'; c.lineWidth = w + 0.4; c.lineCap = 'round';
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + this.sx * h, y + this.sy * h); c.stroke();
      return;
    }
    const tx = x + this.ux * h, ty = y + this.uy * h;
    this.rect(x - w - 0.4, y - 1, 2 * w + 0.8, 2, A.shade(col, -0.45), { lit: 0, bevel: 0.5, r: 0.5, lw: 0.4 });
    this.line(x, y, tx, ty, A.shade(col, -0.7), w + 0.9, { cap: 'butt' });
    this.line(x, y, tx, ty, col, w, { cap: 'butt' });
    for (let i = 1; i <= (o.bars || 0); i++) {
      const f = 1 - i * 0.17, bw = (o.barW || 5) * (1 - i * 0.18), bx = x + this.ux * h * f, by = y + this.uy * h * f;
      this.line(bx - bw / 2, by, bx + bw / 2, by, col, 0.8);
    }
    if (o.tip) this.lamp(tx, ty, o.tip, { r: 0.9, reach: 6 });
  };
  // Parabolic dish seen from above. o: { ang: pointing direction, col }
  K.dish = function (x, y, r, o) {
    o = o || NONE;
    const col = o.col || '#aab4c6';
    if (this.mode === 'shadow') { if (this.z > 0) { this.ctx.fillStyle = '#000'; this.ctx.fill(P.circle(x, y, r * 0.8)); } return; }
    this.push(x, y, o.ang || 0);
    this.ellipse(0, 0, r * 0.62, r, col, { lit: 0.2 });
    this.ellipse(r * 0.08, 0, r * 0.4, r * 0.76, A.shade(col, -0.24), { lit: 0.1, bevel: -0.8, ol: false });
    this.line(0, 0, r * 0.78, 0, A.shade(col, -0.5), 0.8);
    this.circle(r * 0.8, 0, 0.9, '#eef3ff', A.FLAT);
    this.pop();
  };
  // Round pipe along a polyline (flat points)
  K.pipe = function (pts, w, col) {
    const p = P.line(pts), c = this.ctx, cap = { cap: 'butt' };
    w = w || 2; col = col || '#6b7384';
    this.stroke(p, A.shade(col, -0.62), w + 1.1, cap); this.stroke(p, col, w, cap);
    if (this.vis()) {
      c.save(); c.translate(this.lx * w * 0.24, this.ly * w * 0.24);
      this.stroke(p, A.shade(col, 0.32), w * 0.3, cap);
      c.restore();
    }
  };
  // Small box with plank seams. o: { nx, ny, strap: colour }
  K.crate = function (x, y, w, d, h, col, o) {
    o = o || NONE;
    const r = this.box(x, y, w, d, h, { roof: col || A.PAL.wood });
    this.panels(r.x, r.y, w, d, o.nx || 2, o.ny || 1, 'rgba(0,0,0,0.3)');
    if (o.strap && this.vis()) { this.ctx.fillStyle = o.strap; this.ctx.fillRect(r.x + w * 0.42, r.y, w * 0.16, d + h); }
    return r;
  };
  // Sandbag wall along a polyline. o: { col, rows: 1..3, bag: length, w: bag width }
  K.sandbags = function (pts, o) {
    o = o || NONE;
    const col = o.col || A.PAL.canvas, L = o.bag || 5, rows = o.rows || 2, wd = o.w || 3.2;
    for (let r = 0; r < rows; r++) for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3], len = Math.hypot(bx - ax, by - ay), ang = Math.atan2(by - ay, bx - ax);
      if (this.mode === 'shadow') {
        if (r) continue;
        const nx = -(by - ay) / len * wd / 2, ny = (bx - ax) / len * wd / 2;
        this._sweep([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny], rows * 2.2);
        continue;
      }
      const n = Math.max(1, Math.round(len / L)), bl = len / n;
      for (let k = 0; k < n - (r % 2); k++) {
        const t = (k + 0.5 + (r % 2) * 0.5) / n;
        this.push(ax + (bx - ax) * t + this.ux * r * 2, ay + (by - ay) * t + this.uy * r * 2, ang);
        this.rect(-bl / 2 + 0.15, -wd / 2, bl - 0.3, wd, A.shade(col, r * 0.07 - ((k + i) % 2) * 0.06), { r: 1.3, lit: 0.1, bevel: 0.8, lw: 0.5 });
        this.pop();
      }
    }
  };
  // Loose fabric sheet. o: { seed, folds: n }
  K.tarp = function (x, y, w, h, col, o) {
    o = o || NONE;
    const sd = o.seed || 3, j = function (k) { return (ih(sd, k) - 0.5) * 1.6; };
    const p = P.poly([x + j(1), y + j(2), x + w * 0.5, y + j(3) * 0.5, x + w + j(4), y + j(5), x + w + j(6) * 0.5, y + h * 0.5,
      x + w + j(7), y + h + j(8), x + w * 0.5, y + h + j(9) * 0.5, x + j(10), y + h + j(11), x + j(12) * 0.5, y + h * 0.5], 1.2);
    this.solid(p, col, { lit: 0.16 });
    if (!this.vis()) return p;
    const c = this.ctx, n = o.folds === undefined ? 2 : o.folds;
    c.save(); c.clip(p); c.lineWidth = 1; c.lineCap = 'butt';
    for (let k = 0; k < n; k++) {
      const X = x + w * (k + 1) / (n + 1) + j(20 + k) * 2, X2 = X + j(30 + k) * 3;
      c.strokeStyle = 'rgba(255,255,255,0.16)'; c.beginPath(); c.moveTo(X, y - 1); c.lineTo(X2, y + h + 1); c.stroke();
      c.strokeStyle = 'rgba(0,0,0,0.2)'; c.beginPath(); c.moveTo(X + 1.1, y - 1); c.lineTo(X2 + 1.1, y + h + 1); c.stroke();
    }
    c.restore();
    return p;
  };
  // Striped canopy over the plan rect (x, y, w, d), raised o.z px, sloping toward the south: fixed to a wall
  // line by default, free-standing with o.posts (market stalls, pens, carports).
  // o: { cols: [stripe colours], step, z, slope, posts: true, post: colour }
  K.awning = function (x, y, w, d, o) {
    o = o || NONE;
    const c = this.ctx, z = o.z === undefined ? 8 : o.z, sl = o.slope === undefined ? 2 : o.slope, cols = o.cols || ['#c8343f', '#e9e4d6'];
    if (this.mode === 'shadow') { c.fillStyle = '#000'; c.fillRect(x + this.sx * z, y + this.sy * z, w, d); return; }
    if (o.posts) for (let k = 0; k < 2; k++) {
      const X = k ? x + w - 1.1 : x + 1.1;
      this.line(X, y + d - 0.6, X, y + d - z, A.shade(o.post || '#8b96aa', -0.6), 1.9, { cap: 'butt' });
      this.line(X, y + d - 0.6, X, y + d - z, o.post || '#8b96aa', 1, { cap: 'butt' });
    }
    const Y = y - z - sl, H = d + sl, p = P.rect(x, Y, w, H, 0.8);
    this.solid(p, cols[0], A.FLAT);
    this.stripes(p, cols, o.step || 4, 0);
    if (!this.vis()) return;
    const gr = c.createLinearGradient(0, Y, 0, Y + H);
    gr.addColorStop(0, 'rgba(255,255,255,0.2)'); gr.addColorStop(0.55, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.28)');
    c.fillStyle = gr; c.fill(p);
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(x, Y + H - 1.5, w, 1.5);
    c.strokeStyle = 'rgba(4,5,9,0.75)'; c.lineWidth = 0.7; c.stroke(p);
  };
  // Round canopy on a pole standing on plan point (x, y). o: { z: height, cols: [a, b], n: panels }
  K.umbrella = function (x, y, r, o) {
    o = o || NONE;
    const c = this.ctx, z = o.z === undefined ? 8 : o.z, n = o.n || 8, cols = o.cols || ['#c8343f', '#e9e4d6'];
    if (this.mode === 'shadow') { c.fillStyle = '#000'; c.fill(P.circle(x + this.sx * z, y + this.sy * z, r)); return; }
    const tx = x + this.ux * z, ty = y + this.uy * z, pts = [];
    this.line(x, y, tx, ty, '#20242d', 1.3, { cap: 'butt' });
    for (let i = 0; i < n; i++) { const a = (i + 0.5) * TAU / n; pts.push(tx + Math.cos(a) * r, ty + Math.sin(a) * r); }
    const p = this.solid(P.poly(pts), cols[0], A.FLAT);
    if (!this.vis()) return;
    c.save(); c.clip(p);
    c.fillStyle = cols[1];
    for (let i = 0; i < n; i += 2) { const j = (i + 1) % n; c.beginPath(); c.moveTo(tx, ty); c.lineTo(pts[2 * i], pts[2 * i + 1]); c.lineTo(pts[2 * j], pts[2 * j + 1]); c.fill(); }
    const gr = c.createLinearGradient(tx + this.lx * r, ty + this.ly * r, tx - this.lx * r, ty - this.ly * r);
    gr.addColorStop(0, 'rgba(255,255,255,0.3)'); gr.addColorStop(0.5, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.36)');
    c.fillStyle = gr; c.fill(p);
    c.strokeStyle = 'rgba(0,0,0,0.22)'; c.lineWidth = 0.5; c.beginPath();
    for (let i = 0; i < n; i++) { c.moveTo(tx, ty); c.lineTo(pts[2 * i], pts[2 * i + 1]); }
    c.stroke(); c.restore();
    c.strokeStyle = 'rgba(4,5,9,0.8)'; c.lineWidth = 0.7; c.stroke(p);
    c.fillStyle = '#eef3ff'; c.beginPath(); c.arc(tx, ty, 0.8, 0, TAU); c.fill();
  };
  // Cloth hanging on a wall (coords as drawn). o: { mark: glyph name, ink, tail: swallow-tail depth }
  K.banner = function (x, y, w, h, col, o) {
    o = o || NONE;
    const t = o.tail === undefined ? Math.min(2.2, w * 0.4) : o.tail;
    this.rect(x - 0.7, y - 1, w + 1.4, 1.5, '#262b35', { lit: 0, bevel: 0.5, r: 0.5, lw: 0.4 });
    this.poly([x, y, x + w, y, x + w, y + h, x + w / 2, y + h - t, x, y + h], col, { lit: 0.2, bevel: 0.7, lw: 0.6 });
    if (!this.vis()) return;
    const c = this.ctx;
    c.fillStyle = 'rgba(255,255,255,0.22)'; c.fillRect(x + 0.9, y + 1, w - 1.8, 0.7);
    if (o.mark) { c.strokeStyle = o.ink || A.shade(col, -0.6); c.lineWidth = Math.max(0.7, w * 0.13); c.lineCap = 'round'; c.stroke(A.glyphPath(o.mark, x + w * 0.2, y + h * 0.24, w * 0.6, w * 0.6)); }
  };
  // Flag on a pole standing on plan point (x, y), h px tall. o: { len, drop, wave: phase 0..1, pole }
  K.flag = function (x, y, h, col, o) {
    o = o || NONE;
    const c = this.ctx, L = o.len || 8, D = o.drop || 5, wv = (o.wave || 0) * TAU;
    this.mast(x, y, h, { col: o.pole || '#9aa3b5', w: 1 });
    if (this.mode === 'shadow') {
      const ax = x + this.sx * (h - D), ay = y + this.sy * (h - D), bx = x + this.sx * h, by = y + this.sy * h;
      c.fillStyle = '#000'; c.beginPath(); c.moveTo(ax, ay); c.lineTo(ax + L, ay); c.lineTo(bx + L, by); c.lineTo(bx, by); c.fill();
      return;
    }
    const tx = x + this.ux * h, ty = y + this.uy * h, a = Math.sin(wv) * 1.1, b = Math.sin(wv + 1.4) * 1.3;
    const p = this.poly([tx, ty, tx + L * 0.5, ty + a, tx + L, ty + b, tx + L, ty + D + b, tx + L * 0.5, ty + D + a, tx, ty + D], col, { lit: 0.16, bevel: 0.6, r: 0.4, lw: 0.5 });
    if (this.vis()) { c.save(); c.clip(p); c.fillStyle = 'rgba(0,0,0,0.2)'; c.fillRect(tx + L * 0.42, ty - 3, L * 0.26, D + 6); c.restore(); }
  };
  // Rooftop air-conditioning unit on plan rect
  K.ac = function (x, y, w, d, o) {
    const r = this.box(x, y, w || 7, d || 5, 3, { roof: (o && o.col) || '#8a93a6' }), m = Math.min(r.w, r.d);
    this.circle(r.x + r.w * 0.32, r.y + r.d / 2, m * 0.34, '#1c2028', { lit: 0, bevel: -0.8, lw: 0.4 });
    this.vent(r.x + r.w * 0.62, r.y + 1, r.w * 0.3, r.d - 2, { step: 1.4 });
    return r;
  };
  // Chimney / exhaust stack
  K.stack = function (x, y, r, h, col) {
    this.cyl(x, y, r, h, col || '#5d6676');
    this.circle(x, y - h, r * 0.62, '#0c0e13', { lit: 0, bevel: -1, ol: false });
  };
  K.tyre = function (x, y, r) {
    this.circle(x, y, r, '#2a2e38', { lit: 0.12 });
    this.circle(x, y, r * 0.46, '#0e1015', { lit: 0, bevel: -0.8, ol: false });
  };
  K.drum = function (x, y, r, col, h) {
    h = h || 4;
    this.cyl(x, y, r, h, col || '#3f6f8f', { bands: 1 });
    if (this.vis()) this.stroke(P.circle(x, y - h, r * 0.58), 'rgba(0,0,0,0.3)', 0.5);
  };
  // Tank lying on its side from plan point (x0, y0) to (x1, y1), radius r. o: { bands: n, stripe: colour of a painted band }
  K.tank = function (x0, y0, x1, y1, r, col, o) {
    o = o || NONE;
    const c = this.ctx;
    if (this.mode === 'shadow') {
      c.fillStyle = '#000';
      for (let k = 0; k <= 2; k++) c.fill(P.capsule(x0 + this.sx * r * k, y0 + this.sy * r * k, x1 + this.sx * r * k, y1 + this.sy * r * k, r));
      return;
    }
    const ax = x0 + this.ux * r * 0.7, ay = y0 + this.uy * r * 0.7, bx = x1 + this.ux * r * 0.7, by = y1 + this.uy * r * 0.7;
    const len = Math.hypot(bx - ax, by - ay) || 1, nx = -(by - ay) / len * r, ny = (bx - ax) / len * r;
    const p = this.solid(P.capsule(ax, ay, bx, by, r), col || '#8d98ab', { lit: 0.3 });
    if (!this.vis()) return;
    const at = function (t, w) { c.moveTo(ax + (bx - ax) * t - nx, ay + (by - ay) * t - ny); c.lineTo(ax + (bx - ax) * t + nx, ay + (by - ay) * t + ny); c.lineWidth = w; };
    c.save(); c.clip(p); c.lineCap = 'butt';
    if (o.stripe) { c.strokeStyle = o.stripe; c.beginPath(); at(0.5, len * 0.24); c.stroke(); }
    c.strokeStyle = 'rgba(0,0,0,0.3)';
    for (let i = 1; i <= (o.bands || 0); i++) { c.beginPath(); at(i / (o.bands + 1), 0.7); c.stroke(); }
    c.restore();
  };
  // Chain-link fence along a polyline. o: { col, h, step }
  K.fence = function (pts, o) {
    o = o || NONE;
    const c = this.ctx, h = o.h || 5, col = o.col || '#8a94a8', st = o.step || 8;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
      if (this.mode === 'shadow') {
        c.globalAlpha = 0.4; this._sweep([ax, ay, bx, by, bx, by + 0.6, ax, ay + 0.6], h); c.globalAlpha = 1;
        continue;
      }
      if (!this.vis()) continue;
      c.fillStyle = 'rgba(150,168,200,0.13)'; c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.lineTo(bx, by - h); c.lineTo(ax, ay - h); c.fill();
      c.lineCap = 'butt'; c.lineWidth = 0.7;
      c.strokeStyle = A.shade(col, -0.45); c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.stroke();
      c.strokeStyle = col; c.beginPath(); c.moveTo(ax, ay - h); c.lineTo(bx, by - h);
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / st));
      for (let k = 0; k <= n; k++) { const X = ax + (bx - ax) * k / n, Y = ay + (by - ay) * k / n; c.moveTo(X, Y); c.lineTo(X, Y - h); }
      c.stroke();
    }
  };
  // Vertical board on the plan line (x .. x + w, y), bottom edge o.lift px above the ground, h px tall, facing
  // south. Returns its face AS DRAWN {x, y, w, h}. o: { face, frame, legs: n, lift }
  K.billboard = function (x, y, w, h, o) {
    o = o || NONE;
    const c = this.ctx, lift = o.lift || 0, n = o.legs === undefined ? 2 : o.legs, out = { x: x, y: y - lift - h, w: w, h: h };
    if (this.mode === 'shadow') {
      const ax = this.sx * lift, ay = this.sy * lift, bx = this.sx * (lift + h), by = this.sy * (lift + h);
      c.fillStyle = '#000'; c.beginPath(); c.moveTo(x + ax, y + ay); c.lineTo(x + w + ax, y + ay); c.lineTo(x + w + bx, y + by); c.lineTo(x + bx, y + by); c.fill();
      for (let i = 0; i < n; i++) { const X = x + w * (i + 0.5) / n; c.fillRect(X - 0.6, y, 1.2 + ax, Math.max(1.2, ay)); }
      return out;
    }
    for (let i = 0; i < n && lift > 0; i++) { const X = x + w * (i + 0.5) / n; this.line(X, y, X, y - lift - 1, '#394152', 1.5, { cap: 'butt' }); }
    this.rect(x, y - lift - h, w, h, o.face || '#0d1017', { lit: 0, bevel: 0.6, ol: o.frame || '#2c323f', lw: 1, r: 0.8 });
    return out;
  };
  // Door / gate on a south wall (coords as drawn). o: { frame, lit: colour of the light inside, shut: 0..1 roller shutter, slats }
  K.door = function (x, y, w, h, o) {
    o = o || NONE;
    const c = this.ctx, sh = o.shut || 0;
    this.rect(x - 0.9, y - 0.9, w + 1.8, h + 0.9, o.frame || '#272c37', { lit: 0, bevel: 0.6, ol: '#07080c', lw: 0.6 });
    if (this.vis()) {
      if (o.lit && this.on) {
        const gr = c.createLinearGradient(0, y, 0, y + h);
        gr.addColorStop(0, A.shade(o.lit, -0.5)); gr.addColorStop(1, o.lit); c.fillStyle = gr;
      } else c.fillStyle = '#090b10';
      c.fillRect(x, y, w, h);
      if (sh > 0) {
        c.fillStyle = o.slats || '#59616f'; c.fillRect(x, y, w, h * sh);
        c.strokeStyle = 'rgba(0,0,0,0.38)'; c.lineWidth = 0.5; c.lineCap = 'butt'; c.beginPath();
        for (let Y = y + 1.4; Y < y + h * sh; Y += 1.6) { c.moveTo(x, Y); c.lineTo(x + w, Y); }
        c.stroke();
      }
    }
    if (o.lit && sh < 0.95) {
      this.glow(P.rect(x, y + h * sh, w, h * (1 - sh)), o.lit, { r: 2.4, a: 0.5 });
      this.pool(x + w / 2, y + h + 2.5, w * 0.8, 4.5, o.lit, 0.32);
    }
  };

  // --------------------------------------------------------------------------
  // Vehicle parts (unit frame: +x = forward)
  // --------------------------------------------------------------------------
  // Pair of tracks along x. gauge = centre-to-centre distance, w = track width, phase 0..1 scrolls the treads.
  // o: { x: centre offset, col, tread, step }
  K.tracks = function (len, gauge, w, phase, o) {
    o = o || NONE;
    const c = this.ctx, st = o.step || 2.6, x0 = (o.x || 0) - len / 2;
    for (let s = -1; s <= 1; s += 2) {
      const y0 = s * gauge / 2 - w / 2, p = this.rect(x0, y0, len, w, o.col || '#30343f', { r: w * 0.32, lit: 0.06, bevel: 0.7 });
      if (!this.vis()) continue;
      c.save(); c.clip(p); c.strokeStyle = o.tread || 'rgba(165,178,202,0.36)'; c.lineWidth = 0.8; c.lineCap = 'butt'; c.beginPath();
      for (let X = x0 - st + ((phase || 0) % 1) * st; X < x0 + len + st; X += st) { c.moveTo(X, y0); c.lineTo(X, y0 + w); }
      c.stroke(); c.restore();
    }
  };
  // Wheel pairs at the given axle x positions. o: { l: tyre length, w: tyre width, col }
  K.wheels = function (xs, gauge, o) {
    o = o || NONE;
    const l = o.l || 6, w = o.w || 3.2;
    for (let i = 0; i < xs.length; i++) for (let s = -1; s <= 1; s += 2) {
      this.rect(xs[i] - l / 2, s * gauge / 2 - w / 2, l, w, o.col || '#2b2f39', { r: 1.1, lit: 0.08, bevel: 0.7 });
    }
  };
  // Chamfered hull centred on (o.x, 0). o: { x, nose, tail: chamfer lengths, nw, tw: end width share, r } + solid options
  K.hull = function (len, wid, col, o) {
    o = o || NONE;
    const cx = o.x || 0, x0 = cx - len / 2, x1 = cx + len / 2, hw = wid / 2;
    const n = o.nose === undefined ? 3 : o.nose, t = o.tail === undefined ? 1.5 : o.tail;
    const nw = o.nw === undefined ? 0.62 : o.nw, tw = o.tw === undefined ? 0.8 : o.tw;
    return this.solid(P.poly([x0 + t, -hw, x1 - n, -hw, x1, -hw * nw, x1, hw * nw, x1 - n, hw, x0 + t, hw, x0, hw * tw, x0, -hw * tw],
      o.r === undefined ? 0.8 : o.r), col, o);
  };
  // Gun barrel along +x from (x, y). o: { brake: muzzle brake, sleeve: length of a thicker base }
  K.barrel = function (x, y, len, w, col, o) {
    o = o || NONE; col = col || A.PAL.gun;
    this.rect(x, y - w / 2, len, w, col, { lit: 0.16, bevel: 0.8, lw: Math.min(0.7, w * 0.22), r: 0.3 });
    if (o.sleeve) this.rect(x, y - w / 2 - 0.6, o.sleeve, w + 1.2, A.shade(col, -0.14), { lit: 0.1, lw: 0.55, r: 0.5 });
    if (o.brake) this.rect(x + len - 2.4, y - w / 2 - 0.7, 2.4, w + 1.4, A.shade(col, -0.22), { lit: 0.1, lw: 0.55, r: 0.5 });
  };
  K.windshield = function (x, y, w, h, o) {
    o = o || NONE;
    const p = this.rect(x, y, w, h, o.col || '#1a2a3e', { r: o.r === undefined ? 1 : o.r, lit: 0.22, bevel: -0.6, ol: '#07090d', lw: 0.6 });
    if (!this.vis()) return;
    const c = this.ctx;
    c.save(); c.clip(p); c.strokeStyle = 'rgba(170,205,255,0.3)'; c.lineWidth = Math.min(w, h) * 0.28; c.lineCap = 'butt';
    c.beginPath(); c.moveTo(x - 1, y + h * 0.95); c.lineTo(x + w * 0.75, y - 1); c.stroke(); c.restore();
  };
  K.hatch = function (x, y, r, col) {
    this.circle(x, y, r, col, { lit: 0.16, lw: 0.55 });
    if (this.vis()) this.line(x - r * 0.5, y, x + r * 0.5, y, 'rgba(0,0,0,0.35)', 0.6);
  };
  K.exhaust = function (x, y, o) {
    this.rect(x - 1.7, y - 1, 3.4, 2, (o && o.col) || '#4a4f5c', { r: 0.9, lit: 0.1, lw: 0.5 });
    this.circle(x - 0.6, y, 0.6, '#08090c', A.FLAT);
  };
  // Whole civilian car centred on (x, y), nose toward o.rot (props, wrecks, cars on lifts).
  // o: { rot, glass, lamps: true = headlights on, wheels: false, stripe: colour of a centre stripe }
  K.car = function (x, y, len, wid, col, o) {
    o = o || NONE;
    const hl = len / 2, hw = wid / 2;
    this.push(x, y, o.rot || 0);
    if (o.wheels !== false) this.wheels([hl * 0.58, -hl * 0.58], wid - 1.4, { l: len * 0.2, w: 2.4 });
    this.rect(-hl, -hw + 0.7, len, wid - 1.4, col, { r: Math.min(3.2, wid * 0.3), lit: 0.16 });
    if (o.stripe) this.rect(-hl + 0.8, -wid * 0.12, len - 1.6, wid * 0.24, o.stripe, A.FLAT);
    this.windshield(hl * 0.22, -hw + 1.9, len * 0.15, wid - 3.8, { col: o.glass, r: 0.9 });
    this.windshield(-hl * 0.62, -hw + 2.1, len * 0.1, wid - 4.2, { col: o.glass, r: 0.7 });
    this.rect(-hl * 0.44, -hw + 1.6, len * 0.34, wid - 3.2, A.shade(col, 0.14), { r: 1.4, lit: 0.12, bevel: 0.6, lw: 0.4 });
    if (o.lamps) { this.lamp(hl - 0.9, -hw + 2.2, '#fff3c4', { r: 0.7, reach: 4, a: 0.5 }); this.lamp(hl - 0.9, hw - 2.2, '#fff3c4', { r: 0.7, reach: 4, a: 0.5 }); }
    this.pop();
  };

  // --------------------------------------------------------------------------
  // Rigs
  // --------------------------------------------------------------------------
  A.rigs = {};
  function hgeo(o) {
    const b = o.build === undefined ? 0.5 : o.build;
    return { b: b, sw: 5.6 + 3.2 * b, td: 2.6 + 1.5 * b, ar: 1.3 + 0.9 * b, hr: 2.75 + 0.45 * b };
  }
  // Where the humanoid rig's weapon ends, for ART.muzzle: NT.Art.rigs.humanoidMuzzle({ build, size, weapon })
  A.rigs.humanoidMuzzle = function (o) {
    const q = hgeo(o), k = o.size || 1, wp = o.weapon || 'none';
    let x = q.td + 5, y = 0;
    if (wp === 'rifle') { x = q.td + 9.8; y = q.sw * 0.24; }
    else if (wp === 'smg') { x = q.td + 6.8; y = q.sw * 0.24; }
    else if (wp === 'heavy') { x = q.td + 11.6; y = q.sw * 0.5; }
    else if (wp === 'launcher') { x = q.td + 7; y = q.sw * 0.62; }
    else if (wp === 'pistol') { x = q.td + 7.8; y = q.sw * 0.3; }
    else if (wp === 'spear') { x = q.td + 7; y = q.sw * 0.6; }
    else if (wp === 'kit') { x = q.td + 5.6; y = q.sw * 0.4; }
    return [x * k, y * k];
  };

  // Top-down person facing +x: a shoulder bar with team-coloured ends, the head in the middle, arms reaching
  // forward to whatever is held.
  // o: { build: 0 slim .. 1 hulking, size: scale,
  //      skin, cloth: torso, chest: vest colour, pad: shoulder colour (TEAM), sleeve, glove, boot, pack: backpack colour,
  //      head: 'bare'|'helmet'|'cap'|'hood'|'mohawk'|'bandana'|'mask', headCol, hair, stripe: helmet stripe / bandana colour,
  //      weapon: 'none'|'rifle'|'smg'|'pistol'|'heavy'|'launcher'|'blade'|'club'|'fists'|'spear'|'kit', wcol, ammo, kitCol, cross,
  //      walk: 0..1, moving, fire: 0..1 }
  K.humanoid = function (o) {
    const g = this, q = hgeo(o), b = q.b, sw = q.sw, td = q.td, ar = q.ar, hr = q.hr;
    const mv = !!o.moving, sn = mv ? Math.sin((o.walk || 0) * TAU) : 0, fire = o.fire || 0;
    const skin = o.skin || A.PAL.skin, cloth = o.cloth || '#5d6779', sleeve = o.sleeve || cloth, glove = o.glove || skin;
    const boot = o.boot || '#3a3f4c', wcol = o.wcol || A.PAL.gun, wp = o.weapon || 'none', rc = -fire * 1.4;
    const SY = sw - td * 0.8, fy = sw * 0.4, st = mv ? 2.2 + b : 0, fr = 2 + 0.8 * b;
    function arm(side, hx, hy, fist) {
      g.capsule(0.4, side * SY, hx, hy, ar, sleeve, { r1: ar * 0.85, lit: 0.1, lw: 0.55 });
      g.circle(hx, hy, ar * (fist || 0.95), glove, { lit: 0.12, bevel: 0.6, lw: 0.5 });
    }
    function cap(side) {                       // outer end of the shoulder bar
      const p = new Path2D(), y0 = side * sw * 0.34, yc = side * (sw - td);
      p.moveTo(-0.3 - td, y0); p.lineTo(-0.3 - td, yc); p.arc(-0.3, yc, td, PI, 0, side > 0); p.lineTo(-0.3 + td, y0); p.closePath();
      p.bb = [-0.3 - td, side > 0 ? y0 : -sw, 2 * td, sw - sw * 0.34];
      return p;
    }
    g.push(0, 0, 0, o.size || 1);
    g.ellipse(0.8 + sn * st, -fy, fr, fr * 0.7, boot, { lit: 0.08, bevel: 0.6, lw: 0.5 });
    g.ellipse(0.8 - sn * st, fy, fr, fr * 0.7, boot, { lit: 0.08, bevel: 0.6, lw: 0.5 });
    g.push(0, 0, sn * 0.09);
    if (o.pack) g.rect(-td - 2.7, -sw * 0.46, 3.6, sw * 0.92, o.pack, { r: 1.3, lw: 0.6 });
    if (b > 0.75) g.ellipse(-td * 0.55, 0, td, sw * 0.62, A.shade(cloth, -0.14), { lit: 0.1 });       // trapezius bulk
    g.capsule(-0.3, -(sw - td), -0.3, sw - td, td, cloth, { lit: 0.14 });
    if (o.chest) g.rect(-td * 0.62 - 0.3, -sw * 0.34, td * 1.24, sw * 0.68, o.chest, { r: 1, lit: 0.1, bevel: 0.6, lw: 0.4 });
    if (o.pad) { g.solid(cap(-1), o.pad, { lit: 0.2, lw: 0.5 }); g.solid(cap(1), o.pad, { lit: 0.2, lw: 0.5 }); }

    if (wp === 'rifle' || wp === 'smg') {
      const gy = sw * 0.24, L = wp === 'smg' ? 6.8 : 9.8;
      g.push(rc, 0);
      g.rect(-0.4, gy - 1.25, td + L * 0.52, 2.5, wcol, { r: 0.5, lw: 0.6, lit: 0.12 });
      g.rect(td + L * 0.5 - 0.4, gy - 0.7, L * 0.5 + 0.4, 1.4, A.shade(wcol, 0.22), { lw: 0.55, lit: 0.1, r: 0.3 });
      g.rect(td + 1.7, gy + 0.9, 1.5, 1.9, A.shade(wcol, -0.3), { lw: 0.4, r: 0.3 });
      arm(1, td + 0.8, gy + 1.1); arm(-1, td + L * 0.4, gy - 0.6);
      g.pop();
    } else if (wp === 'heavy') {
      const gy = sw * 0.5;
      g.push(rc, 0);
      g.rect(-1.5, gy - 2, td + 5.6, 4, wcol, { r: 0.8, lw: 0.6 });
      g.rect(td + 3.6, gy - 1, 8, 2, A.shade(wcol, 0.2), { lw: 0.55, r: 0.3 });
      g.rect(td + 10, gy - 1.5, 1.7, 3, A.shade(wcol, -0.2), { lw: 0.5, r: 0.4 });
      g.rect(0.3, gy - 4.5, 3.4, 2.8, o.ammo || A.shade(wcol, -0.3), { lw: 0.5, r: 0.4 });
      arm(1, td + 0.2, gy + 1.8); arm(-1, td + 3.6, gy - 1.4);
      g.pop();
    } else if (wp === 'launcher') {
      const gy = sw * 0.62;
      g.push(rc * 0.6, 0);
      g.rect(-td - 4.2, gy - 1.8, td * 2 + 11, 3.6, wcol, { r: 1.1, lw: 0.6, lit: 0.16 });
      g.rect(td + 5, gy - 2.4, 2.1, 4.8, A.shade(wcol, -0.24), { r: 0.8, lw: 0.5 });
      g.rect(-td - 4.9, gy - 2.2, 1.7, 4.4, A.shade(wcol, -0.3), { r: 0.6, lw: 0.5 });
      arm(1, td + 1.4, gy + 0.8); arm(-1, td + 3.2, gy - 2.1);
      g.pop();
    } else if (wp === 'pistol') {
      const gy = sw * 0.3;
      arm(-1, 2.2 - sn * 2.2, -(SY + 0.8));
      g.rect(td + 4.2 + rc, gy - 0.9, 3.8, 1.8, wcol, { lw: 0.55, r: 0.3 });
      arm(1, td + 4.2 + rc, gy);
    } else if (wp === 'fists') {
      const tape = o.glove || A.PAL.bone, lx = td + 2.6 - sn * 1.6, rx = td + 2.6 + sn * 1.6 + fire * 4.4, ry = sw * 0.42 - fire * 1.6;
      g.capsule(0.4, -SY, lx, -sw * 0.42, ar, sleeve, { r1: ar * 0.9, lit: 0.1, lw: 0.55 });
      g.circle(lx, -sw * 0.42, ar * 1.05, tape, { lit: 0.14, lw: 0.5 });
      g.capsule(0.4, SY, rx, ry, ar, sleeve, { r1: ar * 0.9, lit: 0.1, lw: 0.55 });
      g.circle(rx, ry, ar * 1.05, tape, { lit: 0.14, lw: 0.5 });
    } else if (wp === 'blade' || wp === 'club') {
      const hx = td + 3, hy = sw * 0.56;
      arm(-1, td + 1.8 - sn * 1.5, -sw * 0.5);
      g.push(hx, hy, 0.4 - fire * 1.7);
      if (wp === 'blade') {
        g.poly([0.4, -1.1, 8.8, -0.7, 10.4, 0.4, 0.4, 1.1], o.wcol || '#dfe6f2', { lit: 0.25, lw: 0.5 });
        g.rect(-0.5, -1.8, 1.3, 3.6, '#4a505e', { lw: 0.4, r: 0.3 });
      } else g.rect(0, -1.2, 10, 2.4, o.wcol || A.PAL.rust, { r: 1.1, lw: 0.55, lit: 0.18 });
      g.pop();
      arm(1, hx, hy);
    } else if (wp === 'spear') {
      const gy = sw * 0.6, th = fire * 5;
      g.rect(-td - 5 + th, gy - 0.65, td * 2 + 12.5, 1.3, o.wcol || '#c3ccdb', { lw: 0.5, r: 0.3, lit: 0.2 });
      arm(1, -1.2 + th, gy + 0.2); arm(-1, td + 3.4, -sw * 0.3);
    } else if (wp === 'kit') {
      const kx = td + 1.2, ky = sw * 0.14;
      arm(-1, 2.2 - sn * 2.2, -(SY + 0.8));
      g.rect(kx, ky, 4.8, 4.4, o.kitCol || '#eef3ff', { r: 0.8, lw: 0.55 });
      if (g.vis()) { g.ctx.fillStyle = o.cross || '#19b884'; g.ctx.fillRect(kx + 1.9, ky + 0.9, 1, 2.6); g.ctx.fillRect(kx + 1.1, ky + 1.7, 2.6, 1); }
      arm(1, kx + 0.4, ky + 3.6);
    } else { arm(-1, 2.2 - sn * 2.4, -(SY + 0.8)); arm(1, 2.2 + sn * 2.4, SY + 0.8); }

    const hx = 0.6, head = o.head || 'bare', flesh = head === 'bare' || head === 'mohawk' || head === 'bandana';
    const hc = o.headCol || (flesh ? skin : head === 'hood' ? A.shade(cloth, 0.12) : A.PAL.steelLight);
    if (head === 'hood') {
      g.poly([hx - hr - 2.2, 0, hx - hr * 0.3, -hr - 0.4, hx + hr, -hr * 0.82, hx + hr + 0.5, 0, hx + hr, hr * 0.82, hx - hr * 0.3, hr + 0.4], hc, { r: 1.7, lit: 0.22 });
      g.ellipse(hx + hr * 0.52, 0, hr * 0.4, hr * 0.54, A.mix(skin, '#14161d', 0.45), { lit: 0, bevel: 0, lw: 0.4 });
    } else {
      if (head === 'cap') g.rect(hx + hr * 0.35, -hr * 0.76, hr * 1.15, hr * 1.52, A.shade(hc, -0.22), { r: 1.2, lw: 0.5 });
      g.circle(hx, 0, hr + (head === 'helmet' || head === 'mask' ? 0.3 : 0), hc, { lit: 0.24 });
      if (head === 'helmet' && o.stripe) g.rect(hx - hr + 0.5, -0.7, 2 * hr - 1, 1.4, o.stripe, { lit: 0, bevel: 0, ol: false, r: 0.6 });
      else if (head === 'bare') {
        const p = new Path2D();
        p.arc(hx, 0, hr, PI * 0.42, PI * 1.58); p.closePath(); p.bb = [hx - hr, -hr, hr, 2 * hr];
        g.solid(p, o.hair || '#33261f', { lit: 0.12, bevel: 0.6, ol: false });
      } else if (head === 'mohawk') g.rect(hx - hr - 1, -0.9, 2 * hr + 1.4, 1.8, o.hair || '#ff5a3c', { r: 0.9, lit: 0.2, lw: 0.4 });
      else if (head === 'bandana') {
        g.poly([hx - hr + 0.3, -0.6, hx - hr - 2.4, -1.6, hx - hr - 1.7, 0.2, hx - hr - 2.6, 1.3, hx - hr + 0.3, 0.6], o.stripe || '#c33', { lw: 0.4, lit: 0.1 });
        g.rect(hx - 0.4, -hr + 0.25, 1.8, 2 * hr - 0.5, o.stripe || '#c33', { lit: 0, bevel: 0, ol: false });
      } else if (head === 'mask') { g.circle(hx + hr - 0.2, -1.4, 1, '#20242d', { lw: 0.3, lit: 0 }); g.circle(hx + hr - 0.2, 1.4, 1, '#20242d', { lw: 0.3, lit: 0 }); }
    }
    g.pop(); g.pop();
  };

  // Top-down four-legged beast facing +x.
  // o: { len, girth, col, sprawl: reptile stance (legs out to the sides),
  //      head: 'hound'|'boar'|'lizard'|'bull', headCol, headSize, tusks: colour | false, eye: emissive colour,
  //      leg: reach px, legW, tail: 'whip'|'thick'|'stub'|'none', tailLen, hump: true,
  //      mane, stripe, saddle, collar: colours, bands: n war-paint stripes, bandCol (use TEAM for some of these),
  //      plates: n, plateCol, plateAlt, spikes: n, spikeCol, pack: colour of a back load, cargo: 0..1, cargoCol,
  //      walk: 0..1, moving, fire: 0..1 (lunge) }
  K.quadruped = function (o) {
    const g = this, L = o.len || 22, G = o.girth || 9, col = o.col || '#7a6a58', dark = A.shade(col, -0.2);
    const mv = !!o.moving, ph = mv ? (o.walk || 0) * TAU : 0, sway = mv ? Math.sin(ph) : 0, fire = o.fire || 0, sp = !!o.sprawl;
    const reach = o.leg === undefined ? G * (sp ? 0.62 : 0.18) : o.leg, lw = o.legW || Math.max(1.3, G * (sp ? 0.16 : 0.2));
    const hcol = o.headCol || A.shade(col, 0.07), head = o.head || 'hound', hs = o.headSize || 1;
    g.push(fire * 2.6, 0);
    for (let i = 0; i < 4; i++) {
      const front = i < 2, side = i % 2 ? 1 : -1, p = ph + ((front ? side > 0 : side < 0) ? PI : 0);
      const sw = mv ? Math.sin(p) * L * 0.1 : 0, bx = front ? L * 0.24 : -L * 0.3;
      g.capsule(bx, side * G * 0.32, bx + sw + (front ? L * 0.09 : -L * 0.07), side * (G * 0.5 + reach), lw, dark, { r1: lw * 1.25, lit: 0.08, bevel: 0.6, lw: 0.55 });
    }
    const tl = o.tailLen || L * 0.4, tx = -L * 0.5;
    if (o.tail === 'thick') g.capsule(tx + 2, 0, tx - tl, sway * tl * 0.3, G * 0.3, col, { r1: 0.7, lit: 0.12 });
    else if (o.tail === 'stub') g.circle(tx - 0.4, sway * 0.6, G * 0.13 + 0.7, dark, { lit: 0.1, lw: 0.5 });
    else if (o.tail !== 'none') {
      g.capsule(tx + 1, 0, tx - tl * 0.55, sway * tl * 0.22, Math.max(1, G * 0.12), dark, { r1: 0.85, lw: 0.5, lit: 0.08 });
      g.capsule(tx - tl * 0.55, sway * tl * 0.22, tx - tl, sway * tl * 0.55, 0.85, dark, { r1: 0.5, lw: 0.45, lit: 0.08 });
    }
    g.blob([-L * 0.6, 0, -L * 0.5, -G * 0.56, -L * 0.2, -G * 0.54, 0, -G * 0.42, L * 0.2, -G * 0.66, L * 0.48, -G * 0.54, L * 0.52, 0,
      L * 0.48, G * 0.54, L * 0.2, G * 0.66, 0, G * 0.42, -L * 0.2, G * 0.54, -L * 0.5, G * 0.56], col, { lit: 0.18 });
    if (o.hump) g.ellipse(L * 0.14, 0, L * 0.2, G * 0.36, A.shade(col, 0.1), { lit: 0.12, bevel: 0.5, ol: false });
    if (o.mane) g.rect(-L * 0.3, -G * 0.1, L * 0.7, G * 0.2, o.mane, { r: G * 0.1, lit: 0.06, bevel: 0.5, lw: 0.35 });
    if (o.stripe) g.rect(-L * 0.36, -G * 0.16, L * 0.6, G * 0.32, o.stripe, { r: G * 0.16, lit: 0.14, bevel: 0.6, lw: 0.4 });
    for (let i = 0, n = o.bands || 0; i < n; i++) {
      const X = -L * 0.3 + (i + 0.5) * (L * 0.56 / n), w = G * (0.74 + 0.1 * i / Math.max(1, n - 1));
      g.rect(X - 1.2, -w / 2, 2.4, w, o.bandCol || A.PAL.bone, { r: 1.1, lit: 0.12, bevel: 0.5, lw: 0.35 });
    }
    if (o.saddle) {
      g.rect(-L * 0.18, -G * 0.52, L * 0.34, G * 1.04, o.saddle, { r: 1.6, lit: 0.16, lw: 0.55 });
      g.rect(-L * 0.18 + 1.3, -G * 0.2, L * 0.34 - 2.6, G * 0.4, A.shade(o.saddle, -0.3), { r: 1, lit: 0.06, bevel: 0.5, lw: 0.3 });
    }
    for (let i = 0, n = o.plates || 0; i < n; i++) {
      const X = L * 0.32 - (i + 0.5) * (L * 0.74 / n), w = G * (0.98 - Math.abs(i - (n - 1) / 2) * 0.08);
      g.rect(X - L * 0.41 / n, -w / 2, L * 0.82 / n, w, i % 2 && o.plateAlt ? o.plateAlt : (o.plateCol || A.PAL.steel), { r: 1.7, lit: 0.16, lw: 0.55 });
    }
    if (o.pack) {
      const k = 0.6 + 0.4 * (o.cargo || 0);
      g.rect(-L * 0.3, -G * 0.44 * k - 1, L * 0.44, G * 0.88 * k + 2, o.pack, { r: 2.4, lit: 0.16 });
      if (o.cargo > 0) g.rect(-L * 0.3 + 1.6, -G * 0.3 * k, L * 0.44 - 3.2, G * 0.6 * k, o.cargoCol || A.PAL.glint, { r: 1.6, lit: 0.22, lw: 0.4 });
      g.line(-L * 0.08, -G * 0.44 * k - 1, -L * 0.08, G * 0.44 * k + 1, 'rgba(0,0,0,0.35)', 0.8);
    }
    for (let i = 0, n = o.spikes || 0; i < n; i++) {
      const X = L * 0.26 - i * (L * 0.64 / Math.max(1, n - 1));
      g.poly([X + 1.3, 0, X - 1.3, -1.5, X - 0.5, 0, X - 1.3, 1.5], o.spikeCol || A.PAL.bone, { lit: 0.2, lw: 0.35 });
    }
    const nx = L * 0.4;
    if (head === 'boar') {
      const hw = G * 0.42 * hs, HL = L * 0.26 * hs;
      for (let s = -1; s <= 1; s += 2) g.ellipse(nx + 0.2, s * hw * 0.98, 1.8, 1.2, dark, { lw: 0.4, lit: 0.1, rot: s * 0.5 });
      g.capsule(nx, 0, nx + HL, 0, hw, hcol, { r1: hw * 0.66, lit: 0.18 });
      if (o.tusks !== false) for (let s = -1; s <= 1; s += 2) g.capsule(nx + HL * 0.7, s * hw * 0.6, nx + HL + 3.4, s * (hw + 1.4), 1.05, o.tusks || A.PAL.bone, { r1: 0.4, lw: 0.4, lit: 0.2 });
      g.ellipse(nx + HL + hw * 0.4, 0, hw * 0.32, hw * 0.52, A.shade(hcol, 0.22), { lw: 0.4, lit: 0.1 });
    } else if (head === 'lizard') {
      const hw = G * 0.4 * hs, HL = L * 0.27 * hs;
      g.poly([nx - 1, -hw, nx + HL * 0.5, -hw * 0.86, nx + HL, -hw * 0.3, nx + HL, hw * 0.3, nx + HL * 0.5, hw * 0.86, nx - 1, hw], hcol, { r: 1.6, lit: 0.18 });
    } else if (head === 'bull') {
      const hw = G * 0.38 * hs, HL = L * 0.21 * hs;
      for (let s = -1; s <= 1; s += 2) g.capsule(nx + 1, s * (hw + 0.2), nx + HL + 3, s * (hw + 2.6), 1.25, o.tusks || A.PAL.bone, { r1: 0.35, lw: 0.4, lit: 0.2 });
      g.rect(nx - 1, -hw, HL + 1.6, 2 * hw, hcol, { r: 1.8, lit: 0.18 });
      g.rect(nx + HL - 0.6, -hw * 0.6, 1.6, hw * 1.2, A.shade(hcol, -0.25), { r: 0.7, lw: 0.3, lit: 0 });
    } else {
      const hw = G * 0.36 * hs, HL = L * 0.3 * hs;
      for (let s = -1; s <= 1; s += 2) g.poly([nx + 1.8, s * hw * 0.66, nx - 2.2, s * (hw + 2.2), nx - 0.8, s * hw * 0.15], dark, { r: 0.6, lw: 0.45, lit: 0.1 });
      g.capsule(nx, 0, nx + HL, 0, hw, hcol, { r1: hw * 0.56, lit: 0.18 });
      g.circle(nx + HL + hw * 0.22, 0, 0.85, '#1b1d24', A.FLAT);
    }
    if (o.collar) g.rect(nx - 2.4, -G * 0.4, 2.4, G * 0.8, o.collar, { r: 1, lit: 0.14, lw: 0.45 });
    if (o.eye) { const ex = nx + L * 0.09 * hs, ey = G * 0.22 * hs; g.led(ex, -ey, o.eye, 0.55); g.led(ex, ey, o.eye, 0.55); }
    g.pop();
  };

  // Big bird / bat seen from above, facing +x.
  // o: { span, len, col, wing, band: TEAM stripe across both wings, head, beak, flap: 0..1 }
  K.winged = function (o) {
    const g = this, c = g.ctx, S = o.span || 28, L = o.len || 13, col = o.col || '#6d6876', wing = o.wing || A.shade(col, 0.08);
    const f = Math.cos((o.flap || 0) * TAU), hs = S / 2 * (0.82 + 0.18 * f), sw = (1 - f) * 1.6;
    for (let s = -1; s <= 1; s += 2) {
      const p = g.poly([L * 0.26, s * 1.2, L * 0.34 - sw * 0.3, s * hs * 0.42, L * 0.2 - sw, s * hs * 0.84, 0 - sw * 1.4, s * hs,
        -L * 0.2 - sw * 1.4, s * hs * 0.94, -L * 0.14 - sw * 1.2, s * hs * 0.8, -L * 0.32 - sw, s * hs * 0.72, -L * 0.26, s * hs * 0.58,
        -L * 0.42, s * hs * 0.46, -L * 0.36, s * hs * 0.3, -L * 0.46, s * hs * 0.16, -L * 0.3, s * 1.2], wing, { r: 0.9, lit: 0.18 });
      if (o.band && g.vis()) {
        c.save(); c.clip(p); c.fillStyle = o.band; c.beginPath();
        c.moveTo(L * 0.6, s * hs * 0.46); c.lineTo(L * 0.6, s * hs * 0.66); c.lineTo(-L * 0.6, s * hs * 0.72); c.lineTo(-L * 0.6, s * hs * 0.5); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(-L * 0.6, s > 0 ? hs * 0.84 : -hs, L * 1.2, hs * 0.16);
        c.restore();
      }
    }
    g.poly([-L * 0.26, -1.8, -L * 0.78, -3.4, -L * 0.68, 0, -L * 0.78, 3.4, -L * 0.26, 1.8], A.shade(col, -0.12), { r: 0.8, lit: 0.1, lw: 0.5 });
    g.ellipse(-L * 0.02, 0, L * 0.4, L * 0.17 + 0.7, col, { lit: 0.2 });
    g.poly([L * 0.5, -1.1, L * 0.5 + 3.4, 0, L * 0.5, 1.1], o.beak || A.PAL.bone, { lw: 0.4, lit: 0.2 });
    g.circle(L * 0.42, 0, L * 0.13 + 0.5, o.head || A.shade(col, 0.2), { lit: 0.22, lw: 0.55 });
  };

  // Multirotor seen from above, nose toward +x.
  // o: { r: body radius, arms, reach: hub distance, rotor: disc radius, spin: 0..1, col, shell: TEAM panel, eye, led, gun: true }
  K.drone = function (o) {
    const g = this, c = g.ctx, r = o.r || 5, n = o.arms || 4, reach = o.reach || r + 5, R = o.rotor || 4.2, col = o.col || '#5a6376';
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) * TAU / n, hx = Math.cos(a) * reach, hy = Math.sin(a) * reach;
      g.line(0, 0, hx, hy, '#15181f', 2.8, { cap: 'butt' }); g.line(0, 0, hx, hy, A.shade(col, 0.1), 1.6, { cap: 'butt' });
    }
    for (let i = 0; i < n; i++) {
      const a = (i + 0.5) * TAU / n, hx = Math.cos(a) * reach, hy = Math.sin(a) * reach, sp = (o.spin || 0) * PI + i * 0.9;
      g.circle(hx, hy, R, '#bcd4ff', { alpha: 0.22, lit: 0, bevel: 0, ol: '#eaf2ff', lw: 0.3, outer: false });
      if (g.vis()) {
        c.strokeStyle = 'rgba(236,243,255,0.62)'; c.lineWidth = 0.9; c.lineCap = 'round'; c.beginPath();
        c.moveTo(hx - Math.cos(sp) * R * 0.92, hy - Math.sin(sp) * R * 0.92); c.lineTo(hx + Math.cos(sp) * R * 0.92, hy + Math.sin(sp) * R * 0.92); c.stroke();
      }
      g.circle(hx, hy, 1.2, '#2a2f3a', { lit: 0, bevel: 0.6, lw: 0.4 });
    }
    if (o.gun) g.barrel(r * 0.5, 0, r * 1.1, 1.4);
    g.poly([-r * 1.05, -r * 0.5, -r * 0.55, -r * 0.92, r * 0.6, -r * 0.92, r * 1.15, -r * 0.42, r * 1.15, r * 0.42, r * 0.6, r * 0.92, -r * 0.55, r * 0.92, -r * 1.05, r * 0.5], col, { r: 1.2, lit: 0.18 });
    if (o.shell) g.rect(-r * 0.66, -r * 0.68, r, r * 1.36, o.shell, { r: 1, lit: 0.18, lw: 0.5 });
    g.lamp(r * 0.74, 0, o.eye || A.PAL.hot, { r: 1, reach: 5 });
    g.led(-r * 0.94, 0, o.led || '#ff4040', 0.55);
  };

  // ==========================================================================
  // ENGINE: registry, measuring, baking, cache, entry points
  // ==========================================================================
  const STEP = TAU / A.ROT_N, ZERO = [0, 0], GPAD = 9;
  const L_BODY = 0, L_TOP = 1, L_BASE = 2, L_GBODY = 3, L_GTOP = 4, L_GBASE = 5, L_SIL = 6, L_SILTOP = 7;
  const FIRE = [0, 0.4, 1];
  const LIVE = [];                          // every cached sprite, for LRU eviction
  const ICONS = new Map(), FLASH = new Map(), PALS = {};
  const KIT = new Kit(), LKIT = new Kit();  // bake kit / live kit
  const MZ = [0, 0, 0];                     // muzzle scratch: x, y, angle
  let clock = 0;

  A.define = function (factionId, arts) {
    const f = NT.FACTIONS[factionId];
    if (!f) { console.warn('NT.Art.define: unknown faction "' + factionId + '"'); return; }
    f.art = f.art || {};
    for (const key in arts) {
      const def = NT.DEFS[factionId + '.' + key];
      if (!def) { console.warn('NT.Art.define: no def "' + factionId + '.' + key + '"'); continue; }
      def.art = f.art[key] = arts[key];
      forget(def);
    }
  };
  NT.defineArt = A.define;

  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
    return c;
  }
  const DOTS = new Map();
  function dot(col) {                       // soft round sprite behind g.puff, one per colour
    let c = DOTS.get(col);
    if (c) return c;
    c = mk(64, 64);
    const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, A.alpha(col, 1)); gr.addColorStop(1, A.alpha(col, 0));
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    if (DOTS.size > 96) DOTS.clear();
    DOTS.set(col, c);
    return c;
  }
  function free(e) { e.c.width = e.c.height = 0; if (e.fl) e.fl.width = e.fl.height = 0; e.dead = true; }
  function store(map, key, r) {             // r = [canvas, scale, ox, oy]
    const c = r[0], e = { c: c, w: c.width / r[1], h: c.height / r[1], ox: r[2], oy: r[3], px: c.width * c.height, used: ++clock, map: map, key: key, fl: null, dead: false, sc: r[1] };
    map.set(key, e); LIVE.push(e);
    if (map.ev && map.ev.delete(key)) rebaked++;
    A.stats.canvases++; A.stats.pixels += e.px;
    if (A.stats.pixels > A.budget) evict();
    return e;
  }
  // Least-recently-used sprites go until 70% of the budget is left. The newest few always survive so a
  // sprite fetched earlier in the same draw call cannot vanish under it.
  function evict() {
    LIVE.sort(function (a, b) { return b.used - a.used; });
    const cap = A.budget * 0.7;
    const thrash = lastEvicted > 0 && rebaked > lastEvicted * 0.3;
    let keep = 0, px = 0;
    while (keep < LIVE.length && (keep < 8 || px + LIVE[keep].px <= cap)) px += LIVE[keep++].px;
    for (let i = 0; i < EVM.length; i++) EVM[i].ev.clear();        // only the round just before this one counts
    EVM.length = 0;
    for (let i = keep; i < LIVE.length; i++) {
      const e = LIVE[i], ev = e.map.ev || (e.map.ev = new Set());
      if (!ev.size) EVM.push(e.map);
      ev.add(e.key); e.map.delete(e.key); free(e); A.stats.evictions++;
    }
    lastEvicted = LIVE.length - keep; rebaked = 0;
    LIVE.length = keep; A.stats.pixels = px; A.stats.canvases = keep;
    if (thrash && capIdx > 2) lowerCap();
  }
  // A third of what the last round evicted had to be baked again = the sprites IN USE do not fit the budget.
  // Bake one resolution step below the current one from now on (slightly soft when zoomed in) instead of
  // re-baking every frame. The cap lifts again as soon as the zoom moves to another ladder step (and on
  // clearCache); the newest few sprites survive a drop (a caller may be holding one).
  const EVM = [];
  let lastEvicted = 0, rebaked = 0;
  function lowerCap() {
    capIdx = Math.max(2, Math.min(capIdx, lastSi) - 1); lastZoom = -1; A.stats.cap = A.LADDER[capIdx];
    let j = 0;
    for (let i = 0; i < LIVE.length; i++) {
      const e = LIVE[i];
      if (e.sc > A.LADDER[capIdx] && clock - e.used > 8) { e.map.delete(e.key); A.stats.pixels -= e.px; free(e); } else LIVE[j++] = e;
    }
    LIVE.length = j; A.stats.canvases = j;
  }
  function forget(def) {
    const rt = def._art;
    if (!rt) return;
    rt.sheets.forEach(function (sh) { sh.map.forEach(free); });
    rt.common.forEach(free);
    let j = 0;
    for (let i = 0; i < LIVE.length; i++) { if (LIVE[i].dead) { A.stats.pixels -= LIVE[i].px; A.stats.canvases--; } else LIVE[j++] = LIVE[i]; }
    LIVE.length = j;
    ICONS.forEach(function (v, k) { if (k.indexOf(def.id + '|') === 0) ICONS.delete(k); });
    delete def._art;
  }
  A.clearCache = function () {
    for (let i = 0; i < LIVE.length; i++) free(LIVE[i]);
    LIVE.length = 0; ICONS.clear(); FLASH.clear();
    for (const id in NT.DEFS) delete NT.DEFS[id]._art;
    for (const k in PALS) delete PALS[k];
    const s = A.stats; s.hits = s.misses = s.canvases = s.pixels = s.evictions = s.bakeMs = 0;
    lastZoom = -1; capIdx = A.LADDER.length - 1; s.cap = A.LADDER[capIdx]; lastEvicted = rebaked = 0;
  };

  // --- per-def runtime -------------------------------------------------------
  function runtime(def) {
    const isB = def.kind === 'building', f = NT.FACTIONS[def.faction] || NONE;
    const rt = def._art = {
      def: def, art: def.art || A.fallback(def), isB: isB, W: isB ? def.size[0] * TILE : 0, H: isB ? def.size[1] * TILE : 0,
      team0: f.color || '#8d97ad', pal: PALS[def.faction] || (PALS[def.faction] = Object.assign({}, A.PAL, f.palette)),
      frames: 1, fps: 0, nVar: 1, height: 0, flashK: null,
      sheets: new Map(), common: new Map(),
      uFire: false, uCargo: false, uDep: false,     // set when the art reads s.fire / s.cargo / s.deployed
      box: null, rBody: 8, rTop: 0, tight: 8, gBody: false, gTop: false, bounds: null,
    };
    try { measure(rt); } catch (err) {
      console.error('NT.Art: art for ' + def.id + ' failed (' + err.message + ') - using fallback art', err);
      rt.art = A.fallback(def); rt.sheets.clear();
      measure(rt);
    }
    return rt;
  }
  function sheetOf(rt, team) {
    let sh = rt.sheets.get(team);
    if (!sh) {
      sh = { team: team, hi: A.shade(team, 0.35), lo: A.shade(team, -0.3), dk: A.shade(team, -0.58),
        ink: A.lum(team) > 0.5 ? A.shade(team, -0.74) : A.shade(team, 0.8), map: new Map() };
      rt.sheets.set(team, sh);
    }
    return sh;
  }

  // What cached art functions receive. fire / cargo / deployed are getters: reading one marks the def so
  // the cache key starts to include it — art that ignores a state never pays for it.
  function BakeState() {}
  Object.defineProperty(BakeState.prototype, 'fire', { get: function () { this._rt.uFire = true; return this._fire; } });
  Object.defineProperty(BakeState.prototype, 'cargo', { get: function () { this._rt.uCargo = true; return this._cargo; } });
  Object.defineProperty(BakeState.prototype, 'deployed', { get: function () { this._rt.uDep = true; return this._dep; } });
  function bakeState(rt, sh, q) {
    const s = new BakeState();
    s._rt = rt; s._fire = FIRE[q.fire]; s._cargo = q.cargo / 3; s._dep = !!q.dep;
    s.def = rt.def; s.W = rt.W; s.H = rt.H; s.pal = rt.pal;
    s.team = sh.team; s.teamHi = sh.hi; s.teamLo = sh.lo; s.teamDk = sh.dk; s.teamInk = sh.ink;
    s.moving = q.frame > 0; s.walk = q.frame > 0 ? (q.frame - 0.5) / rt.frames : 0;
    s.dmg = q.dmg; s.powered = !q.off; s.variant = q.variant; s.rnd = A.rng(NT.hash32(rt.def.id, q.variant));
    s.t = 0; s.active = false; s.hp = 1; s.facing = 0; s.aim = 0; s.seed = q.variant; s.rank = 0; s.zoom = 1; s.boost = false; s.hinder = false;
    return s;
  }
  // What live functions (anim, lights) receive: one reused object, raw values.
  const LS = { rnd: function (n) { const v = ih(LS.seed, LS._k++); return n === undefined ? v : (v * n) | 0; }, _k: 0 };
  function liveState(rt, sh, st) {
    LS._k = 0; LS.def = rt.def; LS.W = rt.W; LS.H = rt.H; LS.pal = rt.pal;
    LS.team = sh.team; LS.teamHi = sh.hi; LS.teamLo = sh.lo; LS.teamDk = sh.dk; LS.teamInk = sh.ink;
    LS.t = st.t || 0; LS.moving = !!st.moving; LS.walk = st.walk || 0; LS.fire = st.fire || 0;
    LS.hp = st.hp === undefined ? 1 : st.hp; LS.dmg = Q.dmg; LS.deployed = !!st.deployed; LS.cargo = st.cargo || 0;
    LS.rank = st.rank || 0; LS.powered = st.powered !== false; LS.active = !!st.active; LS.seed = st.seed | 0; LS.variant = Q.variant;
    LS.facing = st.facing || 0; LS.aim = st.aim === undefined ? LS.facing : st.aim; LS.zoom = st.zoom || 1;
    LS.boost = !!st.boost; LS.hinder = !!st.hinder;
    return LS;
  }

  // --- quantised state -> cache key ---------------------------------------------
  const Q = { frame: 0, fire: 0, dmg: 0, off: 0, dep: 0, cargo: 0, variant: 0, sk: 0 };
  const Q0 = { frame: 0, fire: 0, dmg: 0, off: 0, dep: 0, cargo: 0, variant: 0, sk: 0 };
  function quant(rt, st) {
    const n = rt.frames;
    Q.frame = n < 2 ? 0 : rt.fps ? 1 + ((Math.floor((st.t || 0) * rt.fps) % n) + n) % n
      : st.moving ? 1 + ((Math.floor((st.walk || 0) * n) % n) + n) % n : 0;
    Q.fire = rt.uFire ? (st.fire > 0.5 ? 2 : st.fire > 0.05 ? 1 : 0) : 0;
    Q.dep = rt.uDep && st.deployed ? 1 : 0;
    Q.cargo = rt.uCargo ? Math.min(3, Math.round((st.cargo || 0) * 3)) : 0;
    Q.variant = rt.nVar > 1 ? (((st.seed | 0) % rt.nVar) + rt.nVar) % rt.nVar : 0;
    Q.dmg = 0; Q.off = 0;
    if (rt.isB) {
      const hp = st.hp === undefined ? 1 : st.hp;
      Q.dmg = hp > 0.66 ? 0 : hp > 0.33 ? 1 : 2; Q.off = st.powered === false ? 1 : 0;
    }
    Q.sk = ((((Q.dmg * 2 + Q.off) * 2 + Q.dep) * 4 + Q.cargo) * 4 + Q.variant) * 4 + Q.fire;      // < 1024
    return Q;
  }
  function keyOf(layer, si, rot, frame, sk) { return (((layer * 16 + si) * 16 + rot) * 16 + frame) * 1024 + sk; }
  let lastZoom = -1, lastSi = 2, lastWant = -1, capIdx = A.LADDER.length - 1, RS = 1;
  function scaleIdx(z) {                       // first ladder step >= zoom (sprites are only scaled DOWN), up to the cap
    if (z === lastZoom) return lastSi;
    const L = A.LADDER, zz = (z || 1) * 0.985;
    let i = 0, want = 0;
    while (want < L.length - 1 && L[want] < zz) want++;
    if (want !== lastWant) { lastWant = want; capIdx = L.length - 1; A.stats.cap = L[capIdx]; lastEvicted = rebaked = 0; }   // new zoom step: try full quality again
    while (i < capIdx && L[i] < zz) i++;
    lastZoom = z; lastSi = i; RS = L[i] >= 2 ? 2 : 1;
    return i;
  }
  function glowScale(si) { return Math.max(0.5, A.LADDER[si] / 2); }      // halos are soft: half resolution
  function softIdx(si) { return si <= 1 ? 0 : si <= 4 ? 1 : 2; }          // shadows: three resolutions (1:1 at zoom 1 = the fast blit)
  const SOFT = [0.5, 1, 2];

  // --- measuring: render once at 1x, read back what was touched -------------------
  let scratch = null, sctx = null, emSeen = 0;
  // -> [x0, y0, x1, y1, maxRadius, massRadius] relative to (ox, oy) | null. massRadius = the circle holding
  // `frac` of the painted mass: the body without its thin protrusions (barrels, rifles, tails).
  function scan(side, ox, oy, draw, frac) {
    if (!scratch || scratch.width < side) { scratch = mk(side, side); sctx = scratch.getContext('2d', { willReadFrequently: true }); }
    const S = scratch.width;
    sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.globalAlpha = 1; sctx.globalCompositeOperation = 'source-over';
    sctx.clearRect(0, 0, S, S); sctx.translate(ox, oy);
    draw(sctx);
    const d = sctx.getImageData(0, 0, S, S).data;
    const hist = frac ? new Float64Array(192) : null;
    let x0 = S, y0 = S, x1 = -1, y1 = -1, r2 = 0, tot = 0, rm = 0;
    for (let y = 0, i = 3; y < S; y++) for (let x = 0; x < S; x++, i += 4) if (d[i] > 6) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const dx = x + 0.5 - ox, dy = y + 0.5 - oy, q = dx * dx + dy * dy;
      if (q > r2) r2 = q;
      if (hist) { hist[Math.min(191, Math.sqrt(q) | 0)] += d[i]; tot += d[i]; }
    }
    if (hist) { let acc = 0; while (rm < 191 && acc + hist[rm] < tot * frac) acc += hist[rm++]; rm++; }
    return x1 < 0 ? null : [x0 - ox, y0 - oy, x1 + 1 - ox, y1 + 1 - oy, Math.sqrt(r2), rm];
  }
  // every frame and state of a layer, drawn on top of each other
  function overlay(rt, sh, layer) {
    return function (c) {
      const walk = layer === 'body' ? rt.frames : 1, nv = layer === 'base' ? rt.nVar : 1;
      emSeen = 0;
      for (let v = 0; v < nv; v++) for (let f = 0; f <= (walk > 1 ? walk : 0); f++) for (let k = 0; k < 4; k++) {
        if (k && (f || v)) continue;
        const q = { frame: f, fire: k === 1 ? 2 : 0, dmg: 0, off: 0, dep: k === 2 ? 1 : 0, cargo: k === 3 ? 3 : 0, variant: v, sk: 0 };
        c.save();
        rt.art[layer](KIT.begin(c, 'main', 0, 1, true, layer !== 'base'), bakeState(rt, sh, q));
        c.restore();
        emSeen += KIT.em;
      }
    };
  }
  function measure(rt) {
    const art = rt.art, def = rt.def, sh = sheetOf(rt, rt.team0), pv = art.pivot || ZERO;
    rt.frames = Math.max(1, Math.min(15, art.frames | 0)); rt.fps = art.fps || 0; rt.nVar = Math.max(1, Math.min(4, art.variants | 0));
    rt.height = art.height !== undefined ? art.height : rt.isB ? 0 : def.layer === 'air' ? 18 : def.body === 'small' ? 2.5 : 3.5;
    rt.flashK = flashKind(rt);
    let m;
    if (art.top) { m = scan(256, 128, 128, overlay(rt, sh, 'top')); rt.rTop = m ? Math.ceil(m[4]) + 1 : 4; rt.gTop = emSeen > 0; }
    if (!rt.isB) {
      m = scan(256, 128, 128, overlay(rt, sh, 'body')); rt.rBody = m ? Math.ceil(m[4]) + 1 : 8; rt.gBody = emSeen > 0;
      const R = Math.max(rt.rBody, art.top ? Math.hypot(pv[0], pv[1]) + rt.rTop : 0);
      m = scan(256, 128, 128, function (c) { c.save(); art.body(KIT.begin(c, 'main', 0, 1, true, true), bakeState(rt, sh, Q0)); c.restore(); }, 0.92);
      rt.tight = m ? Math.min(R, m[5] + 1) : R;
      rt.bounds = { w: 2 * rt.tight, h: 2 * rt.tight, up: 0, x0: -R, y0: -R, x1: R, y1: R };
      return;
    }
    const W = rt.W, H = rt.H, side = Math.max(320, W + 192, H + 256);
    m = scan(side, Math.round((side - W) / 2), side - H - 64, overlay(rt, sh, 'base')) || [0, 0, W, H, 0];
    rt.gBody = emSeen > 0;
    rt.box = [Math.floor(m[0]) - 1, Math.floor(m[1]) - 1, Math.ceil(m[2]) + 1, Math.ceil(m[3]) + 1];
    if (!rt.height) rt.height = Math.max(4, -rt.box[1]);
    let x0 = rt.box[0], y0 = rt.box[1], x1 = rt.box[2], y1 = rt.box[3];
    if (art.top) { x0 = Math.min(x0, pv[0] - rt.rTop); y0 = Math.min(y0, pv[1] - rt.rTop); x1 = Math.max(x1, pv[0] + rt.rTop); y1 = Math.max(y1, pv[1] + rt.rTop); }
    rt.bounds = { w: 2 * Math.max(W / 2 - x0, x1 - W / 2), h: 2 * Math.max(H / 2, y1 - H / 2), up: Math.max(0, -y0),
      x0: x0 - W / 2, y0: y0 - H / 2, x1: x1 - W / 2, y1: y1 - H / 2 };
  }

  // --- baking -------------------------------------------------------------------
  // unit body / any top: square sprite around the layer origin, pre-rotated to a facing bucket
  function bakeLayer(rt, sh, layer, glow, si, rot, q) {
    const R = (layer === 'top' ? rt.rTop : rt.rBody) + (glow ? GPAD : 0), sc = glow ? glowScale(si) : A.LADDER[si];
    const half = Math.ceil(R * sc) + 1, c = mk(half * 2, half * 2), x = c.getContext('2d'), ang = rot * STEP;
    x.translate(half, half); x.scale(sc, sc); x.rotate(ang);
    rt.art[layer](KIT.begin(x, glow ? 'glow' : 'main', ang, sc, !q.off, true), bakeState(rt, sh, q));
    return [c, sc, half / sc, half / sc];
  }
  function bakeBase(rt, sh, glow, si, q) {
    const b = rt.box, pad = glow ? (rt.art.glowPad || 14) : 0, sc = glow ? glowScale(si) : A.LADDER[si];
    const c = mk(Math.ceil((b[2] - b[0] + 2 * pad) * sc), Math.ceil((b[3] - b[1] + 2 * pad) * sc)), x = c.getContext('2d');
    x.scale(sc, sc); x.translate(pad - b[0], pad - b[1]);
    rt.art.base(KIT.begin(x, glow ? 'glow' : 'main', 0, sc, !q.off), bakeState(rt, sh, q));
    if (!glow && q.dmg) wreck(x, rt, q.dmg, q.variant);
    return [c, sc, rt.W / 2 - b[0] + pad, rt.H / 2 - b[1] + pad];
  }
  // src blurred into a new canvas (shadow-offset trick: only the blurred copy lands inside)
  function soften(src, blur) {
    const c = mk(src.width, src.height), x = c.getContext('2d');
    x.shadowColor = '#000'; x.shadowBlur = blur; x.shadowOffsetX = 16384;
    x.drawImage(src, -16384, 0);
    src.width = src.height = 0;
    return c;
  }
  function bakeSil(rt, layer, sc, rot) {       // soft silhouette of a unit layer, pre-rotated: shadows blit axis-aligned
    const R = (layer === 'top' ? rt.rTop : rt.rBody) + 3, half = Math.ceil(R * sc) + 1, t = mk(half * 2, half * 2), x = t.getContext('2d');
    x.translate(half, half); x.scale(sc, sc); x.rotate(rot * STEP);
    rt.art[layer](KIT.begin(x, 'sil', rot * STEP, sc, true), bakeState(rt, sheetOf(rt, rt.team0), Q0));
    return [soften(t, 2.6 * sc), sc, half / sc, half / sc];
  }
  function bakeCast(rt, sc, variant) {         // ground shadow of a building
    const b = rt.box, W = rt.W, H = rt.H, hm = rt.height + 2, x0 = Math.min(b[0], 0) - 5, y0 = -5;
    const x1 = Math.max(b[2], W) + hm * A.SHADOW[0] + 5, y1 = Math.max(b[3], H) + hm * A.SHADOW[1] + 5;
    const t = mk(Math.ceil((x1 - x0) * sc), Math.ceil((y1 - y0) * sc)), x = t.getContext('2d'), q = Object.assign({}, Q0, { variant: variant });
    x.scale(sc, sc); x.translate(-x0, -y0);
    rt.art.base(KIT.begin(x, 'shadow', 0, sc, true), bakeState(rt, sheetOf(rt, rt.team0), q));
    if (rt.art.ao !== false) { x.globalAlpha = 0.5; x.fillStyle = '#000'; x.fillRect(-1.5, -1.5, W + 3, H + 3); }
    return [soften(t, 3.4 * sc), sc, W / 2 - x0, H / 2 - y0];
  }
  // generic battle damage, clipped to whatever the art painted
  function wreck(x, rt, lvl, variant) {
    const b = rt.box, w = b[2] - b[0], h = b[3] - b[1], r = A.rng(NT.hash32(rt.def.id, 'dmg', variant));
    x.save(); x.globalCompositeOperation = 'source-atop'; x.lineCap = 'round'; x.lineJoin = 'round';
    for (let i = 0, n = lvl === 1 ? 3 : 6; i < n; i++) {
      const cx = b[0] + r() * w, cy = b[1] + r() * h, R = 5 + r() * (lvl === 1 ? 7 : 12), gr = x.createRadialGradient(cx, cy, 0, cx, cy, R);
      gr.addColorStop(0, 'rgba(6,5,6,' + (0.45 + 0.12 * lvl) + ')'); gr.addColorStop(1, 'rgba(6,5,6,0)');
      x.fillStyle = gr; x.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    }
    for (let i = 0, n = lvl * 3; i < n; i++) {
      let cx = b[0] + r() * w, cy = b[1] + r() * h;
      const p = new Path2D();
      p.moveTo(cx, cy);
      for (let k = 0, m = 3 + r(3); k < m; k++) { cx += (r() - 0.5) * 9; cy += (r() - 0.3) * 7; p.lineTo(cx, cy); }
      x.strokeStyle = 'rgba(4,4,7,0.75)'; x.lineWidth = 0.9; x.stroke(p);
      x.translate(0.7, 0.7); x.strokeStyle = 'rgba(255,255,255,0.13)'; x.lineWidth = 0.5; x.stroke(p); x.translate(-0.7, -0.7);
    }
    if (lvl === 2) {
      for (let i = 0; i < 3; i++) {
        const cx = b[0] + (0.15 + 0.7 * r()) * w, cy = b[1] + (0.15 + 0.7 * r()) * h, R = 3 + r() * 4, pts = [];
        for (let k = 0; k < 7; k++) { const a = k / 7 * TAU, rr = R * (0.6 + r() * 0.6); pts.push(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.8); }
        const p = P.poly(pts);
        x.fillStyle = '#07080c'; x.fill(p); x.strokeStyle = 'rgba(255,170,90,0.22)'; x.lineWidth = 0.6; x.stroke(p);
      }
      x.fillStyle = 'rgba(12,8,8,0.22)'; x.fillRect(b[0], b[1], w, h);
    }
    x.restore();
  }

  // --- cache lookups (no allocation on a hit) --------------------------------------
  function miss(t0, e) { A.stats.misses++; A.stats.bakeMs += performance.now() - t0; return e; }
  function getLayer(rt, sh, L, layer, glow, si, rot, q) {
    const key = keyOf(L, si, rot, layer === 'top' ? 0 : q.frame, q.sk), e = sh.map.get(key);
    if (e) { A.stats.hits++; e.used = ++clock; return e; }
    const t0 = performance.now();
    return miss(t0, store(sh.map, key, bakeLayer(rt, sh, layer, glow, si, rot, q)));
  }
  function getBase(rt, sh, glow, si, q) {
    const key = keyOf(glow ? L_GBASE : L_BASE, si, 0, 0, q.sk), e = sh.map.get(key);
    if (e) { A.stats.hits++; e.used = ++clock; return e; }
    const t0 = performance.now();
    return miss(t0, store(sh.map, key, bakeBase(rt, sh, glow, si, q)));
  }
  function getSoft(rt, L, si, variant, rot) {  // shadows are colourless: shared by every team
    const fi = softIdx(si), key = keyOf(L, fi, rot || 0, 0, variant), e = rt.common.get(key);
    if (e) { A.stats.hits++; e.used = ++clock; return e; }
    const t0 = performance.now();
    return miss(t0, store(rt.common, key, L === L_BASE ? bakeCast(rt, SOFT[fi], variant) : bakeSil(rt, L === L_SILTOP ? 'top' : 'body', SOFT[fi], rot || 0)));
  }
  function flashOf(e) {                        // white silhouette of a sprite (hit flash), made on first use
    if (!e.fl) {
      const c = mk(e.c.width, e.c.height), x = c.getContext('2d');
      x.drawImage(e.c, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      e.fl = c; A.stats.pixels += e.px; e.px *= 2;
    }
    return e.fl;
  }

  // --- blitting ---------------------------------------------------------------------
  function blit(ctx, img, e, x, y, rot) {
    if (rot > 0.04 || rot < -0.04) {
      ctx.translate(x, y); ctx.rotate(rot); ctx.drawImage(img, -e.ox, -e.oy, e.w, e.h); ctx.rotate(-rot); ctx.translate(-x, -y);
    } else ctx.drawImage(img, x - e.ox, y - e.oy, e.w, e.h);
  }
  // Facing bucket, always in ROT_N units. Sprites baked at 2x or more use every second bucket (RS = 2): half
  // the memory, and the larger residual turn resamples cleanly at that size. Shadows always use all 16.
  function bucket(a) { const i = (Math.round(a / (STEP * RS)) * RS) % A.ROT_N; return i < 0 ? i + A.ROT_N : i; }
  function residue(a) { return a - Math.round(a / (STEP * RS)) * (STEP * RS); }
  function b16(a) { const i = Math.round(a / STEP) % A.ROT_N; return i < 0 ? i + A.ROT_N : i; }
  function drawTop(ctx, rt, sh, si, q, st, px, py, ga) {
    const a = st.aim === undefined ? (st.facing || 0) : st.aim, fire = st.fire || 0;
    if (fire > 0) { const k = (rt.art.recoil === undefined ? 1.5 : rt.art.recoil) * fire; px -= Math.cos(a) * k; py -= Math.sin(a) * k; }
    const e = getLayer(rt, sh, L_TOP, 'top', false, si, bucket(a), q), res = residue(a);
    blit(ctx, e.c, e, px, py, res);
    if (st.flash > 0.02) { ctx.globalAlpha = ga * Math.min(1, st.flash) * 0.85; blit(ctx, flashOf(e), e, px, py, res); ctx.globalAlpha = ga; }
  }
  function pips(ctx, rank, R) {                // veterancy chevrons, bottom-right, never rotated
    const x = R * 0.6, y = R * 0.55;
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? '#ffd95a' : '#05060a'; ctx.lineWidth = pass ? 1.1 : 2.4; ctx.beginPath();
      for (let i = 0; i < rank; i++) { const yy = y - i * 2.7; ctx.moveTo(x - 2.5, yy); ctx.lineTo(x, yy + 1.9); ctx.lineTo(x + 2.5, yy); }
      ctx.stroke();
    }
    ctx.lineJoin = 'round';
  }
  function drawUnit(ctx, rt, st) {
    const art = rt.art, si = scaleIdx(st.zoom), sh = sheetOf(rt, st.team || rt.team0), q = quant(rt, st);
    const f = st.facing || 0, res = residue(f), e = getLayer(rt, sh, L_BODY, 'body', false, si, bucket(f), q);
    const ga0 = ctx.globalAlpha, ga = st.ghost === undefined ? ga0 : ga0 * st.ghost, fire = st.fire || 0;
    let kx = 0, ky = 0;
    if (art.kick && fire > 0) { kx = -Math.cos(f) * art.kick * fire; ky = -Math.sin(f) * art.kick * fire; }
    ctx.globalAlpha = ga;
    blit(ctx, e.c, e, kx, ky, res);
    if (st.flash > 0.02) { ctx.globalAlpha = ga * Math.min(1, st.flash) * 0.85; blit(ctx, flashOf(e), e, kx, ky, res); ctx.globalAlpha = ga; }
    if (art.top) {
      const pv = art.pivot || ZERO, c = Math.cos(f), s = Math.sin(f);
      drawTop(ctx, rt, sh, si, q, st, pv[0] * c - pv[1] * s, pv[0] * s + pv[1] * c, ga);
    }
    if (art.anim) { ctx.rotate(f); art.anim(LKIT.begin(ctx, 'live', f, st.zoom || 1, true), liveState(rt, sh, st)); ctx.rotate(-f); }
    if (A.opts.rank && st.rank > 0) pips(ctx, st.rank, rt.tight);
    ctx.globalAlpha = ga0;
  }
  function drawBuilding(ctx, rt, st) {
    const art = rt.art, si = scaleIdx(st.zoom), sh = sheetOf(rt, st.team || rt.team0), q = quant(rt, st), e = getBase(rt, sh, false, si, q);
    const ga0 = ctx.globalAlpha, ga = st.ghost === undefined ? ga0 : ga0 * st.ghost;
    ctx.globalAlpha = ga;
    ctx.drawImage(e.c, -e.ox, -e.oy, e.w, e.h);
    if (st.flash > 0.02) { ctx.globalAlpha = ga * Math.min(1, st.flash) * 0.6; ctx.drawImage(flashOf(e), -e.ox, -e.oy, e.w, e.h); ctx.globalAlpha = ga; }
    if (art.anim) {
      ctx.translate(-rt.W / 2, -rt.H / 2);
      art.anim(LKIT.begin(ctx, 'live', 0, st.zoom || 1, st.powered !== false), liveState(rt, sh, st));
      ctx.translate(rt.W / 2, rt.H / 2);
    }
    if (art.top) { const pv = art.pivot || ZERO; drawTop(ctx, rt, sh, si, q, st, pv[0] - rt.W / 2, pv[1] - rt.H / 2, ga); }
    ctx.globalAlpha = ga0;
  }

  // ==========================================================================
  // Entry points
  // ==========================================================================
  A.drawEntity = function (ctx, def, st) {
    const rt = def._art || runtime(def);
    if (rt.isB) drawBuilding(ctx, rt, st); else drawUnit(ctx, rt, st);
  };

  A.drawShadow = function (ctx, def, st) {
    const rt = def._art || runtime(def), si = scaleIdx(st.zoom), ga0 = ctx.globalAlpha, gh = st.ghost === undefined ? 1 : st.ghost;
    if (rt.isB) {
      const e = getSoft(rt, L_BASE, si, rt.nVar > 1 ? (((st.seed | 0) % rt.nVar) + rt.nVar) % rt.nVar : 0);
      ctx.globalAlpha = ga0 * 0.46 * gh;
      ctx.drawImage(e.c, -e.ox, -e.oy, e.w, e.h);
    } else {
      const h = rt.height, air = h > 8, f = st.facing || 0, dx = h * A.SHADOW[0], dy = h * A.SHADOW[1], e = getSoft(rt, L_SIL, si, 0, b16(f));
      ctx.globalAlpha = ga0 * (air ? 0.26 : 0.42) * gh;
      ctx.drawImage(e.c, dx - e.ox, dy - e.oy, e.w, e.h);
      if (rt.art.top) {
        const pv = rt.art.pivot || ZERO, c = Math.cos(f), s = Math.sin(f), t = getSoft(rt, L_SILTOP, si, 0, b16(st.aim === undefined ? f : st.aim));
        ctx.drawImage(t.c, dx + pv[0] * c - pv[1] * s + 1 - t.ox, dy + pv[0] * s + pv[1] * c + 0.8 - t.oy, t.w, t.h);
      }
    }
    ctx.globalAlpha = ga0;
  };

  A.drawLights = function (ctx, def, st) {
    const rt = def._art || runtime(def), art = rt.art, on = st.powered !== false, fire = st.fire || 0;
    const glow = on && (rt.gBody || rt.gTop), flash = A.opts.flash && fire > 0.12 && rt.flashK;
    if (!glow && !flash && !art.lights) return;
    const si = scaleIdx(st.zoom), sh = sheetOf(rt, st.team || rt.team0), q = quant(rt, st);
    const ga0 = ctx.globalAlpha, ga = st.ghost === undefined ? ga0 : ga0 * st.ghost, f = st.facing || 0, t = st.t || 0, sd = (st.seed | 0) % 97;
    if (glow) {
      let k = 0.94 + 0.06 * Math.sin(t * 11 + sd * 1.7) * Math.sin(t * 4.3 + sd);          // neon never sits perfectly still
      if (q.dmg === 2 && Math.sin(t * 2.3 + sd) > 0.3) k *= 0.45 + 0.3 * Math.sin(t * 31 + sd);   // failing wiring
      ctx.globalAlpha = ga * k;
      if (rt.isB) {
        if (rt.gBody) { const e = getBase(rt, sh, true, si, q); ctx.drawImage(e.c, -e.ox, -e.oy, e.w, e.h); }
      } else if (rt.gBody) { const e = getLayer(rt, sh, L_GBODY, 'body', true, si, bucket(f), q); blit(ctx, e.c, e, 0, 0, residue(f)); }
      if (rt.gTop) {
        const a = st.aim === undefined ? f : st.aim, pv = art.pivot || ZERO, c = Math.cos(f), s = Math.sin(f);
        const e = getLayer(rt, sh, L_GTOP, 'top', true, si, bucket(a), q);
        if (rt.isB) blit(ctx, e.c, e, pv[0] - rt.W / 2, pv[1] - rt.H / 2, residue(a));
        else blit(ctx, e.c, e, pv[0] * c - pv[1] * s, pv[0] * s + pv[1] * c, residue(a));
      }
    }
    if (flash) {
      const fs = flashSprite(rt.flashK), k = 0.5 + 0.5 * fire;
      muz(rt, st, st.weapon | 0);
      ctx.globalAlpha = ga * Math.min(1, fire * 1.4);
      ctx.translate(MZ[0], MZ[1]); ctx.rotate(MZ[2]);
      ctx.drawImage(fs.c, -fs.ox * k, -fs.oy * k, fs.w * k, fs.h * k);
      ctx.rotate(-MZ[2]); ctx.translate(-MZ[0], -MZ[1]);
    }
    if (art.lights) {
      ctx.globalAlpha = ga;
      if (rt.isB) ctx.translate(-rt.W / 2, -rt.H / 2); else ctx.rotate(f);
      art.lights(LKIT.begin(ctx, 'live', rt.isB ? 0 : f, st.zoom || 1, on), liveState(rt, sh, st));
      if (rt.isB) ctx.translate(rt.W / 2, rt.H / 2); else ctx.rotate(-f);
    }
    ctx.globalAlpha = ga0;
  };

  // muzzle flash sprites: one per (colour, size), pointing +x from the muzzle
  function flashKind(rt) {
    const fl = rt.art.flash, w = rt.def.weapons && rt.def.weapons[0];
    if (fl === false || (!fl && !w)) return null;
    if (fl) return (fl.col || '#ffd27a') + '|' + (fl.size || 6);
    if (w.heal || w.proj === 'melee' || w.proj === 'beam' || w.proj === 'flame') return null;
    if (w.proj === 'shell') return '#ffc27a|' + (w.dmg >= 100 ? 13 : 10);
    if (w.proj === 'rocket' || w.proj === 'lob') return '#ff9a52|7';
    return '#ffe08a|' + (w.dmg >= 20 ? 7 : 5);
  }
  function flashSprite(kind) {
    let e = FLASH.get(kind);
    if (e) return e;
    const col = kind.split('|')[0], sz = +kind.split('|')[1], sc = 3, R = sz * 1.5, half = Math.ceil(R * sc);
    const c = mk(half * 2, half * 2), x = c.getContext('2d');
    x.translate(half, half); x.scale(sc, sc);
    const blob = function (cx, cy, rx, ry, a, inner) {
      const gr = x.createRadialGradient(0, 0, 0, 0, 0, rx);
      gr.addColorStop(0, A.alpha(inner, a)); gr.addColorStop(0.4, A.alpha(col, a * 0.6)); gr.addColorStop(1, A.alpha(col, 0));
      x.save(); x.translate(cx, cy); x.scale(1, ry / rx); x.fillStyle = gr; x.beginPath(); x.arc(0, 0, rx, 0, TAU); x.fill(); x.restore();
    };
    blob(sz * 0.15, 0, sz * 0.75, sz * 0.75, 0.9, '#ffffff');
    blob(sz * 0.62, 0, sz * 0.85, sz * 0.26, 1, '#ffffff');
    x.rotate(1.05); blob(sz * 0.3, 0, sz * 0.5, sz * 0.14, 0.7, '#ffffff'); x.rotate(-2.1); blob(sz * 0.3, 0, sz * 0.5, sz * 0.14, 0.7, '#ffffff');
    e = { c: c, w: c.width / sc, h: c.height / sc, ox: half / sc, oy: half / sc };
    FLASH.set(kind, e);
    return e;
  }

  function muz(rt, st, wi) {
    const art = rt.art, ms = art.muzzle, f = st.facing || 0, a = st.aim === undefined ? f : st.aim;
    const m = ms && ms.length ? ms[Math.min(wi, ms.length - 1)] : null, onTop = !!art.top && !(m && m[2] === 'body');
    let ox = 0, oy = 0;
    if (rt.isB) {
      if (!onTop) { MZ[0] = m ? m[0] - rt.W / 2 : 0; MZ[1] = m ? m[1] - rt.H / 2 : -rt.height * 0.5; MZ[2] = a; return; }
      const pv = art.pivot || ZERO;
      ox = pv[0] - rt.W / 2; oy = pv[1] - rt.H / 2;
    } else if (onTop) {
      const pv = art.pivot || ZERO, c = Math.cos(f), s = Math.sin(f);
      ox = pv[0] * c - pv[1] * s; oy = pv[0] * s + pv[1] * c;
    }
    const ang = onTop ? a : f, c = Math.cos(ang), s = Math.sin(ang), x = m ? m[0] : rt.def.radius || 0, y = m ? m[1] : 0;
    MZ[0] = ox + x * c - y * s; MZ[1] = oy + x * s + y * c; MZ[2] = ang;
  }
  A.muzzle = function (def, st, wi) {
    muz(def._art || runtime(def), st || NONE, wi | 0);
    return [MZ[0], MZ[1]];
  };
  A.bounds = function (def) { return (def._art || runtime(def)).bounds; };
  // the standard veterancy chevrons at the lower right of a unit of radius r (for the renderer's overlay pass)
  A.drawRank = function (ctx, rank, r) { if (rank > 0) pips(ctx, rank, r || 9); };

  // A kit bound to any context: 'main' for full-quality one-off drawing (bake your own caches),
  // 'live' for cheap per-frame shapes.
  A.kit = function (ctx, scale, mode) { return new Kit().begin(ctx, mode || 'main', 0, scale || 1, true); };

  A.icon = function (def, team, px) {
    const rt = def._art || runtime(def), art = rt.art, dpr = Math.min(3, window.devicePixelRatio || 1);
    const key = def.id + '|' + (team = team || rt.team0) + '|' + px + '|' + dpr;
    let c = ICONS.get(key);
    if (c) return c;
    const S = Math.round(px * dpr), sh = sheetOf(rt, team), s = bakeState(rt, sh, Q0), pv = art.pivot || ZERO;
    c = mk(S, S);
    const x = c.getContext('2d'), bg = x.createLinearGradient(0, 0, S, S), tile = P.rect(0, 0, S, S, S * 0.1);
    bg.addColorStop(0, A.mix('#222a3a', team, 0.16)); bg.addColorStop(1, '#0b0d14');
    x.save(); x.clip(tile); x.fillStyle = bg; x.fillRect(0, 0, S, S);
    // the same drawing for the picture and for its glow
    const paint = function (cx, mode) {
      if (art.icon) { cx.scale(S, S); art.icon(KIT.begin(cx, mode, 0, S, true), s); return; }
      if (rt.isB) {
        const b = rt.bounds, W = rt.W, H = rt.H, k = S * 0.86 / Math.max(b.x1 - b.x0, b.y1 - b.y0);
        cx.translate(S / 2 - ((b.x0 + b.x1) / 2 + W / 2) * k, S / 2 - ((b.y0 + b.y1) / 2 + H / 2) * k); cx.scale(k, k);
        art.base(KIT.begin(cx, mode, 0, k, true), s);
        if (art.top) { cx.translate(pv[0], pv[1]); cx.rotate(1.1); art.top(KIT.begin(cx, mode, 1.1, k, true, true), s); }
      } else {
        const ang = -0.55, R = Math.max(rt.rBody, art.top ? Math.hypot(pv[0], pv[1]) + rt.rTop : 0), k = Math.min(S * 0.45 / R, S / 22);
        cx.translate(S / 2, S / 2); cx.scale(k, k); cx.rotate(ang);
        art.body(KIT.begin(cx, mode, ang, k, true, true), s);
        if (art.top) { cx.translate(pv[0], pv[1]); art.top(KIT.begin(cx, mode, ang, k, true, true), s); }
      }
    };
    x.save(); paint(x, 'main'); x.restore();
    if (rt.gBody || rt.gTop) {
      const gc = mk(S, S), gx = gc.getContext('2d');
      paint(gx, 'glow');
      x.globalCompositeOperation = 'lighter'; x.drawImage(gc, 0, 0); x.globalCompositeOperation = 'source-over';
      gc.width = gc.height = 0;
    }
    x.restore();
    x.strokeStyle = A.alpha(team, 0.55); x.lineWidth = Math.max(1, S * 0.03); x.stroke(P.rect(x.lineWidth / 2, x.lineWidth / 2, S - x.lineWidth, S - x.lineWidth, S * 0.1));
    ICONS.set(key, c);
    return c;
  };

  // ==========================================================================
  // FALLBACK ART — a readable placeholder for ANY def, derived from its data only: kind, layer, body,
  // tags, move type, weapons, traits, role, footprint, and the faction palette's first three colours.
  // ==========================================================================
  function mats(def) {
    const f = NT.FACTIONS[def.faction] || NONE, pal = f.palette || NONE, pv = Object.keys(pal).map(function (k) { return pal[k]; });
    return { a: A.visible(pv[0] || '#66707f', 0.26), b: A.visible(pv[1] || '#464e5d', 0.17), c: A.visible(pv[2] || '#98a1b3', 0.42),
      skin: pal.skin || A.PAL.skin, h: NT.hash32(def.id) };
  }
  A.fallback = function (def) {
    const C = mats(def);
    if (def.kind === 'building') return fbBuilding(def, C);
    if (def.layer === 'air') return def.is.beast ? fbWinged(def, C) : fbDrone(def, C);
    if (def.is.beast) return fbBeast(def, C);
    if (def.is.infantry || def.move.type === 'foot') return fbInfantry(def, C);
    return fbVehicle(def, C);
  };

  function fbInfantry(def, C) {
    const w = def.weapons[0], melee = !!w && w.proj === 'melee', hero = !!def.is.hero;
    const build = NT.clamp((def.hp - 40) / 300, 0.25, 1), size = hero ? 1.24 : def.hp >= 250 ? 1.12 : 1;
    const weapon = !w ? 'none' : w.heal ? 'kit' : melee ? (hero ? 'club' : build > 0.6 || w.dmg < 30 ? 'fists' : 'blade')
      : w.proj === 'rocket' || w.proj === 'lob' || w.proj === 'shell' ? 'launcher' : w.proj === 'flame' ? 'heavy' : w.proj === 'beam' ? 'pistol'
      : w.speedPx > 0 && w.speedPx < 30 && w.cooldown > 1.2 ? 'spear' : w.cooldown <= 0.4 ? 'heavy' : 'rifle';
    const head = melee ? ['mohawk', 'bare', 'bandana'][C.h % 3] : w && w.heal ? 'cap' : ['helmet', 'cap', 'hood', 'mask'][C.h % 4];
    const anim = melee || weapon === 'spear';
    return {
      frames: 6, kick: anim || !w || w.heal ? 0 : 0.9, muzzle: [A.rigs.humanoidMuzzle({ build: build, size: size, weapon: weapon })],
      body: function (g, s) {
        g.humanoid({
          build: build, size: size, weapon: weapon, head: head, skin: C.skin, cloth: C.a, sleeve: melee ? C.skin : C.a, pad: s.team,
          stripe: s.team, hair: head === 'mohawk' ? s.teamHi : undefined, headCol: head === 'helmet' || head === 'mask' ? C.c : head === 'cap' ? s.teamLo : undefined,
          pack: melee || weapon === 'kit' ? null : A.shade(C.c, -0.25), chest: hero ? s.teamLo : weapon === 'kit' ? '#eef3ff' : null,
          walk: s.walk, moving: s.moving, fire: anim ? s.fire : 0,
        });
      },
    };
  }

  function fbBeast(def, C) {
    const small = def.body === 'small', w = def.weapons[0], harv = !!def.traits.harvester;
    const siege = !!def.is.siege || (!!w && w.range > 5), tank = !harv && (!!def.is.tank || def.armor === 'heavy');
    const len = small ? 16.5 : siege ? 30 : NT.clamp(20 + def.hp / 90, 22, 28), girth = small ? 7.6 : siege ? 10 : NT.clamp(9.5 + def.hp / 150, 11, 15);
    const head = small ? 'hound' : siege ? 'lizard' : harv || tank ? 'boar' : ['bull', 'boar', 'hound'][C.h % 3];
    const lunge = !!w && w.proj === 'melee';
    return {
      frames: 6, height: small ? 2 : 3.5, flash: false, muzzle: [[len * 0.5 + (siege ? 7 : 4), 0]],
      body: function (g, s) {
        g.quadruped({
          len: len, girth: girth, col: C.a, head: head, headCol: A.shade(C.a, 0.1), headSize: small ? 1.08 : 1, sprawl: siege,
          tail: siege ? 'thick' : small ? 'whip' : 'stub', tailLen: siege ? len * 0.55 : undefined, hump: !small && !siege,
          collar: s.team, bands: small ? 2 : 0, bandCol: s.team, saddle: !small && !harv && !tank ? s.team : null,
          plates: tank ? 3 : 0, plateCol: C.c, plateAlt: s.team, spikes: siege ? 5 : 0,
          pack: harv ? s.team : null, cargo: harv ? s.cargo : 0, cargoCol: s.pal.glint, eye: small ? null : s.pal.hot,
          walk: s.walk, moving: s.moving, fire: lunge ? s.fire : 0,
        });
      },
    };
  }

  function fbWinged(def, C) {
    const span = NT.clamp(22 + def.hp / 12, 28, 36);
    return {
      frames: 4, fps: 7, flash: false, muzzle: [[span * 0.3, 0]],
      body: function (g, s) { g.winged({ span: span, len: span * 0.46, col: C.b, wing: C.a, band: s.team, head: C.c, flap: s.walk }); },
    };
  }

  function fbDrone(def, C) {
    const r = NT.clamp(4 + def.hp / 60, 4.5, 8), w = def.weapons[0];
    return {
      frames: 3, fps: 24, muzzle: [[r * 1.6, 0]],
      body: function (g, s) {
        g.drone({ r: r, reach: r + 5, rotor: r * 0.85 + 1, col: C.b, shell: s.team, spin: s.walk, eye: s.pal.hot, gun: !!w && w.proj !== 'lob' });
      },
    };
  }

  function fbVehicle(def, C) {
    const w0 = def.weapons[0], mv = def.move.type, tracked = mv === 'track', harv = !!def.traits.harvester;
    const big = def.hp >= 900, turret = !!w0 && w0.turret, lob = !!w0 && !turret && (w0.proj === 'lob' || w0.needsBrace);
    const heavy = !!w0 && w0.dmg >= 50, spray = !!w0 && w0.proj === 'flame';
    const blen = w0 ? NT.clamp(w0.range * 2.1 + (heavy ? 4 : 0), 9, 20) : 0, bw = heavy ? (big ? 3.4 : 2.8) : spray ? 2.2 : 1.4;
    const legs = !!(def.traits.brace || def.traits.deploy) && !tracked;
    const art = { frames: tracked ? 3 : 1 };
    if (tracked) {
      const len = big ? 33 : 28, wid = big ? 21.5 : 18.5, tr = big ? 7.2 : 6;
      art.body = function (g, s) {
        g.tracks(len, wid - 5, 5, s.walk);
        g.hull(len - 5, wid - 3, C.a, { nose: 3.5, tail: 2, nw: 0.7 });
        g.rect(len * 0.5 - 7.5, -wid / 2 + 2.6, 2.6, wid - 5.2, s.team, { lit: 0.1, bevel: 0.5, lw: 0.4, r: 0.4 });      // glacis band
        g.vent(-len * 0.5 + 3.6, -wid / 2 + 3.6, 5, wid - 7.2, { v: true });
        g.rect(-len * 0.5 + 9.4, -wid / 2 + 2.6, 1.8, wid - 5.2, s.team, { lit: 0.1, bevel: 0.5, lw: 0.4, r: 0.4 });
        g.exhaust(-len * 0.5 + 1.6, -wid / 2 + 4); g.exhaust(-len * 0.5 + 1.6, wid / 2 - 4);
        if (!turret) { g.rect(-3, -wid / 2 + 3.4, 9, wid - 6.8, C.b, { r: 1.2 }); if (w0) g.barrel(5, 0, blen, bw, s.pal.gun, { brake: heavy, sleeve: 3 }); }
      };
      art.muzzle = [[turret ? tr * 0.6 + blen : 5 + blen, 0]];
      if (turret) {
        art.pivot = [-1.5, 0];
        art.top = function (g, s) {
          if (def.weapons.length > 1) g.barrel(tr * 0.4, tr * 0.55, blen * 0.6, 1.1, s.pal.gun);
          g.barrel(tr * 0.6, 0, blen, bw, s.pal.gun, { brake: heavy, sleeve: 3.2 });
          g.poly([-tr, -tr * 0.74, tr * 0.3, -tr * 0.88, tr, -tr * 0.4, tr, tr * 0.4, tr * 0.3, tr * 0.88, -tr, tr * 0.74], A.shade(C.a, 0.08), { r: 1.6, lit: 0.16 });
          g.rect(-tr * 0.7, -tr * 0.54, tr * 1.05, tr * 1.08, s.team, { r: 1.2, lit: 0.16, lw: 0.6 });
          g.hatch(-tr * 0.2, 0, tr * 0.27, s.teamLo);
        };
        if (def.weapons.length > 1) art.muzzle.push([tr * 0.4 + blen * 0.6, tr * 0.55]);
      }
      return art;
    }
    const len = harv ? 31 : def.hp >= 350 ? 30 : 27, wid = harv ? 16.5 : def.hp >= 350 ? 15 : 14, hw = wid / 2;
    const cab = len * 0.14, bed0 = -len / 2 + 1.2, bedL = cab - 1.2 - bed0;       // cab starts at x = cab; the bed fills the rear
    art.body = function (g, s) {
      if (legs && s.deployed) for (let i = 0; i < 4; i++) {
        const X = (i < 2 ? 1 : -1) * len * 0.3, sgn = i % 2 ? 1 : -1;
        g.line(X, sgn * (hw - 1), X, sgn * (hw + 3), '#59616f', 1.4); g.rect(X - 1.8, sgn * (hw + 3.2) - 1.2, 3.6, 2.4, C.c, { r: 0.6, lw: 0.5 });
      }
      if (mv === 'hover') g.hull(len + 2, wid + 3, '#2a2e38', { r: 4, nose: 5, tail: 4 });
      else g.wheels(len > 28 ? [len * 0.32, -len * 0.1, -len * 0.34] : [len * 0.3, -len * 0.3], wid - 2.6, { l: 6.2, w: 3.4 });
      g.hull(len, wid - 2.2, A.shade(C.a, -0.18), { nose: 2.2, tail: 1, nw: 0.78, tw: 0.92 });
      // bed
      if (harv) {
        g.rect(bed0, -hw + 1.2, bedL, wid - 2.4, C.a, { r: 1.2 });
        g.rect(bed0 + 1.8, -hw + 3, bedL - 3.6, wid - 6, '#12151b', { lit: 0, bevel: -1, r: 0.8, lw: 0.5 });
        const k = s.cargo;
        if (k > 0) g.ellipse(bed0 + bedL / 2, 0, (bedL / 2 - 2.6) * (0.55 + 0.45 * k), (hw - 3.6) * (0.55 + 0.45 * k), s.pal.glint, { lit: 0.26, lw: 0.5 });
        g.rect(bed0, -hw + 1.2, 2.6, wid - 2.4, s.team, { r: 0.8, lit: 0.12, lw: 0.5 });
        g.line(bed0 + 3, -hw + 2, cab - 2, -hw + 2, C.c, 1.4);                     // crane arm, folded
        g.circle(cab - 2, -hw + 2, 1.5, C.c, { lw: 0.5 });
      } else if (turret || lob) {
        g.rect(bed0, -hw + 1.2, bedL, wid - 2.4, C.a, { r: 1 });
        g.rect(bed0 + 1.4, -hw + 2.6, bedL - 2.8, wid - 5.2, A.shade(C.b, -0.3), { lit: 0, bevel: -0.9, r: 0.6, lw: 0.5 });
        if (lob) {
          g.circle(bed0 + bedL * 0.45, 0, 3.4, C.c, { lit: 0.14, lw: 0.6 });
          g.barrel(bed0 + bedL * 0.45 - 1, 0, 8.5, 3, s.pal.gun, { sleeve: 2.4 });
          g.circle(bed0 + bedL * 0.45 + 7.4, 0, 1, '#0b0c10', A.FLAT);
        }
      } else {
        g.rect(bed0, -hw + 1.2, bedL, wid - 2.4, C.a, { r: 1.2, lit: 0.14 });
        g.panels(bed0, -hw + 1.2, bedL, wid - 2.4, 3, 1);
        g.rect(bed0 + bedL * 0.3, -hw + 1.2, bedL * 0.28, wid - 2.4, s.team, { lit: 0.12, bevel: 0.5, lw: 0.4 });
      }
      // cab: team-coloured roof, glass in front, short bonnet
      g.rect(cab + len * 0.2, -hw + 2, len * 0.36 - len * 0.2 + 2.2, wid - 4, C.a, { r: 1.4, lit: 0.14 });
      g.windshield(cab + len * 0.2 - 0.6, -hw + 2.6, 3.2, wid - 5.2);
      g.rect(cab, -hw + 1.6, len * 0.21, wid - 3.2, s.team, { r: 1.6, lit: 0.18 });
      g.lamp(len / 2 - 1, -hw + 3, '#fff3c4', { r: 0.7, reach: 3.2, a: 0.5 }); g.lamp(len / 2 - 1, hw - 3, '#fff3c4', { r: 0.7, reach: 3.2, a: 0.5 });
      if (!harv && !turret && !lob && w0) g.barrel(len * 0.3, 0, blen * 0.6, bw);
    };
    art.muzzle = [[lob ? bed0 + bedL * 0.45 + 7.5 : len * 0.5, 0]];
    if (turret) {
      art.pivot = [bed0 + bedL * 0.5, 0];
      art.muzzle = [[2 + blen, 0]];
      art.top = function (g, s) {
        if (heavy || spray) g.barrel(2, 0, blen, bw, spray ? C.c : s.pal.gun, { brake: heavy, sleeve: 3 });
        else { g.barrel(1.5, -1.25, blen, bw); g.barrel(1.5, 1.25, blen, bw); }
        g.circle(0, 0, 3.6, C.c, { lit: 0.16, lw: 0.6 });
        g.rect(-3.4, -3, 4.2, 6, s.team, { r: 1, lit: 0.16, lw: 0.5 });                // gun shield
      };
    }
    return art;
  }

  // --- structures ---------------------------------------------------------------------
  function ngon(cx, cy, r, n, rot) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (rot || 0) + i * TAU / n; pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    return pts;
  }
  function steam(g, x, y, t, col, n, rise) {       // puffs drifting north-east; a cheap live overlay
    for (let k = 0; k < (n || 3); k++) {
      const p = (t * 0.45 + k / (n || 3)) % 1;
      g.puff(x + p * 5 + Math.sin(t * 2 + k * 2.1) * 1.4, y - p * (rise || 16), 2 + p * 4.5, col || '#cdd6e4', 0.34 * (1 - p));
    }
  }
  A.steam = steam;

  function fbBuilding(def, C) {
    const W = def.size[0] * TILE, H = def.size[1] * TILE, role = def.role, w0 = def.weapons[0], sd = C.h % 997;
    const f = NT.FACTIONS[def.faction], qs = (def.traits.producer && def.traits.producer.queues) || [];
    const makesBig = !!f && f.defs.some(function (d) { return qs.indexOf(d.queue) >= 0 && (d.kind === 'building' || d.body !== 'small'); });
    const wall = A.shade(C.a, -0.46), art = {};
    // the shared shell: one block, lit windows + a door on the south face, a team panel on the roof
    const shell = function (g, s, h, o) {
      o = o || NONE;
      const mx = o.mx === undefined ? 5 : o.mx, r = g.box(mx, 12, W - 2 * mx, H - 26, h, { roof: o.roof || C.a, wall: wall, lip: 2 });
      if (o.windows !== false) g.windows(r.wall.x + 4, r.wall.y + 3.5, r.wall.w - 8, Math.min(6, h * 0.36), { cols: Math.round((r.wall.w - 8) / 7), rows: 1, lit: 0.6, seed: sd, col: [s.pal.glassLit, s.pal.cool] });
      if (o.door !== false) g.door(W / 2 - 4.5, r.wall.y + h - 9, 9, 9, { lit: s.pal.warm });
      return r;
    };
    const teamPanel = function (g, s, x, y, w, d) {
      g.rect(x, y, w, d, s.team, { r: 1.2, lit: 0.16, lw: 0.6 });
      g.chevrons(x + w * 0.22, y + d / 2 - Math.min(4, d * 0.3), w * 0.56, Math.min(8, d * 0.6), s.teamInk, 2, 1.5);
    };

    if (role === 'hq') {
      art.height = 46;
      art.base = function (g, s) {
        const h = 22, r = shell(g, s, h);
        g.banner(W / 2 - 14, r.wall.y + h - 12, 5, 10, s.team, { mark: 'star' }); g.banner(W / 2 + 9, r.wall.y + h - 12, 5, 10, s.team, { mark: 'star' });
        teamPanel(g, s, r.x + 5, r.y + 5, r.w * 0.36, r.d - 10);
        g.at(h, function () {
          const p = g.box(W * 0.52, 22, W * 0.32, H * 0.3, 8, { roof: C.b, lip: 1.4 });
          g.windows(p.wall.x + 2, p.wall.y + 2, p.wall.w - 4, 4, { cols: 4, rows: 1, lit: 0.8, seed: sd + 3, col: s.pal.cool });
          g.ac(W * 0.54, H * 0.58, 9, 6);
          g.at(8, function () { g.mast(W * 0.76, 28, 16, { bars: 2, tip: s.team }); g.dish(W * 0.6, 30, 4.5, { ang: -0.8 }); });
        });
        g.flag(10, H - 6, 22, s.team, { len: 10, drop: 6 });
        g.lamp(W / 2, r.wall.y + h - 11.5, s.pal.warm, { r: 0.9, reach: 7 });
      };
      art.lights = function (g, s) { if (s.powered) g.puff(W * 0.76, 28 - 46, 5, s.team, 0.35 + 0.35 * Math.sin(s.t * 4)); };
    } else if (role === 'power') {
      const n = W >= 3 * TILE ? 3 : 2, tr = Math.min(W / n, H - 20) * 0.32;
      art.height = 24;
      art.base = function (g, s) {
        const r = g.box(4, 10, W - 8, H - 18, 5, { roof: C.b, lip: 1.5 });
        g.hazard(r.wall.x + 2, r.wall.y + 1, r.wall.w - 4, 2.6);
        g.at(5, function () {
          g.pipe([W / (2 * n), H * 0.5 + tr * 0.4, W - W / (2 * n), H * 0.5 + tr * 0.4], 2.4, C.c);
          for (let i = 0; i < n; i++) {
            const cx = W * (i + 0.5) / n;
            g.cyl(cx, H * 0.5, tr, 14, C.a, { bands: 2, cap: s.team });
            g.at(14, function () { g.lamp(cx, H * 0.5, s.pal.cool, { r: 1.6, reach: 10 }); });
          }
          g.stack(W - 10, 18, 3, 10, C.c);
        });
      };
      art.anim = function (g, s) { steam(g, W - 10, 18 - 16, s.t + s.seed, '#cdd6e4', 3, 14); };
      art.lights = function (g, s) {
        if (!s.powered) return;
        for (let i = 0; i < n; i++) g.puff(W * (i + 0.5) / n, H * 0.5 - 19, tr * 0.9, s.pal.cool, 0.22 + 0.16 * Math.sin(s.t * 3 + i * 2));
      };
    } else if (role === 'dropoff') {
      art.height = 26;
      art.base = function (g, s) {
        const px = W * 0.5, pw = W * 0.5 - 4;
        g.rect(px, 16, pw, H - 22, '#242a35', { r: 1.5, lit: 0.05, bevel: -0.6 });
        g.hazard(px + 1.5, H - 10, pw - 3, 2.6); g.hazard(px + 1.5, 17.5, pw - 3, 2.6);
        g.chevrons(px + pw * 0.72, H * 0.5 + 1, -pw * 0.5, 9, A.alpha(s.pal.hazard, 0.7), 2, 1.6);
        const r = g.box(5, 12, W * 0.44, H - 26, 16, { roof: C.a, wall: wall, lip: 2 });
        g.rect(r.x + 4.5, r.y + 4.5, r.w - 9, r.d - 9, '#0f1218', { lit: 0, bevel: -1, r: 1 });
        for (let i = 0; i < 7; i++) g.rect(r.x + 7 + s.rnd() * (r.w - 16), r.y + 7 + s.rnd() * (r.d - 16), 2 + s.rnd() * 2.5, 2 + s.rnd() * 2, i % 3 ? s.pal.hazard : C.c, { r: 0.5, lit: 0.2, lw: 0.4 });
        g.rect(r.x + 1.6, r.y + 1.6, r.w - 3.2, 2.4, s.team, A.FLAT); g.rect(r.x + 1.6, r.y + r.d - 4, r.w - 3.2, 2.4, s.team, A.FLAT);
        g.door(r.wall.x + r.wall.w / 2 - 4, r.wall.y + 7, 8, 9, { lit: s.pal.warm });
        g.at(6, function () { g.rect(W * 0.4, H * 0.42, W * 0.2, 6, '#4b5362', { lit: 0.1, r: 0.6 }); });
        g.vent(W * 0.4 + 1, H * 0.42 - 5, W * 0.2 - 2, 4, { v: true, step: 2.2 });
        g.cyl(W - 14, 24, 7, 18, C.c, { bands: 2, cap: s.team });
      };
    } else if (role === 'producer' && !makesBig) {
      art.height = 22;
      art.base = function (g, s) {
        const h = 10, rise = 6, y = 12, d = H - 26, yE = y + d - h, yR = y + d / 2 - h - rise;
        g.gable(5, y, W - 10, d, h, rise, { roof: C.a, wall: wall, ribs: 5 });
        for (let i = 0; i < 2; i++) {
          const X = 5 + (W - 10) * (i ? 0.72 : 0.16);
          g.rect(X, y - h + 0.9, 8, yR - (y - h) - 0.9, A.shade(s.team, 0.12), A.FLAT); g.rect(X, yR, 8, yE - yR - 0.9, A.shade(s.team, -0.16), A.FLAT);
        }
        g.door(W / 2 - 5, yE + 1.5, 10, h - 1.5, { lit: s.pal.warm });
        g.windows(10, yE + 3, W * 0.5 - 20, 4, { rows: 1, lit: 0.7, seed: sd }); g.windows(W * 0.5 + 10, yE + 3, W * 0.5 - 20, 4, { rows: 1, lit: 0.7, seed: sd + 5 });
        g.sandbags([8, H - 5, W * 0.5 - 10, H - 5], { rows: 2 });
        g.flag(W - 9, H - 6, 18, s.team, { len: 9, drop: 5.5 });
      };
    } else if (role === 'producer') {
      const dw = Math.min(30, W * 0.38);
      art.height = 34;
      art.base = function (g, s) {
        const h = 20, r = shell(g, s, h, { mx: 4, door: false, windows: false });
        for (let k = 0; k < 3; k++) g.windows(r.x + 5, r.y + 5 + k * (r.d - 9) / 3, r.w * 0.56, 3.6, { cols: 6, rows: 1, lit: 0.85, seed: sd + k, col: s.pal.cool });
        teamPanel(g, s, r.x + r.w * 0.66, r.y + 4, r.w * 0.29, r.d - 8);
        g.door(W / 2 - dw / 2, r.wall.y + 4, dw, h - 4, { lit: s.pal.warm, shut: 0.4 });
        g.hazard(W / 2 - dw / 2 - 4.5, r.wall.y + 4, 3, h - 4); g.hazard(W / 2 + dw / 2 + 1.5, r.wall.y + 4, 3, h - 4);
        g.rect(W / 2 - dw / 2, H - 13, dw, 10, '#232833', { lit: 0, bevel: -0.5, r: 0.8 });
        g.chevrons(W / 2 - 4, H - 11, 8, 6, A.alpha(s.pal.hazard, 0.7), 1, 1.5);
        g.at(h, function () { g.stack(W - 13, 20, 3.4, 12, C.c); g.stack(W - 22, 20, 3.2, 9, C.c); g.ac(9, 16, 9, 6); });
      };
      art.anim = function (g, s) { steam(g, W - 13, 20 - 34, s.t + s.seed, '#9aa3b4', 3, 16); if (s.active) steam(g, W - 22, 20 - 31, s.t * 1.6 + 1, '#9aa3b4', 3, 14); };
      art.lights = function (g, s) { if (s.active && s.powered) g.puff(W / 2, H - 12, dw * 0.6, s.pal.warm, 0.22 + 0.12 * Math.sin(s.t * 9)); };
    } else if (role === 'radar') {
      art.height = 36;
      art.base = function (g, s) {
        const h = 12, r = shell(g, s, h, { mx: 6 });
        teamPanel(g, s, r.x + 4, r.y + r.d - 12, r.w - 8, 8);
        g.at(h, function () {
          g.cyl(W / 2, H / 2 - 6, 5, 7, C.b, { cap: s.team });
          g.mast(W - 13, 20, 18, { bars: 3, tip: s.pal.hot });
        });
      };
      art.anim = function (g, s) { g.dish(W / 2, H / 2 - 6 - 21, 9, { ang: s.powered ? s.t * 1.3 + s.seed : 0.6, col: C.c }); };
      art.lights = function (g, s) { if (s.powered) g.puff(W - 13, 20 - 30, 4.5, s.pal.hot, 0.3 + 0.4 * (Math.sin(s.t * 5) > 0.5 ? 1 : 0)); };
    } else if (role === 'tech') {
      art.height = 26;
      art.base = function (g, s) {
        const h = 14, r = shell(g, s, h);
        const n = W >= 3 * TILE ? 2 : 1;
        g.at(h, function () {
          for (let i = 0; i < n; i++) {
            const cx = W * (n === 1 ? 0.4 : 0.3 + i * 0.4), cy = H * 0.42;
            g.cyl(cx, cy, 9, 5, C.c, { top: '#243c50', cap: s.team });
            g.at(5, function () { g.neon(P.circle(cx, cy, 6.6), s.pal.toxic, { w: 1.1 }); });
          }
          g.pipe([10, H - 26, W - 14, H - 26, W - 14, 20], 2.2, C.b);
          g.ac(W - 20, H * 0.5, 8, 6);
        });
        g.banner(r.wall.x + 5, r.wall.y + 2.5, 5, 9, s.team, { mark: 'gear' });
      };
    } else if (role === 'super') {
      const cx = W / 2, cy = H / 2 + 2, R = Math.min(W, H) / 2 - 5;
      art.height = 34;
      art.base = function (g, s) {
        g.prism(ngon(cx, cy, R, 8, PI / 8), 6, C.b, { wall: A.shade(C.b, -0.4) });
        g.at(6, function () {
          g.circle(cx, cy, R * 0.74, C.a, { lit: 0.14 });
          g.circle(cx, cy, R * 0.52, '#10131a', { lit: 0, bevel: -1 });
          g.neon(P.circle(cx, cy, R * 0.63), s.team, { w: 1.7, r: 4 });
          g.cyl(cx, cy, R * 0.28, 12, C.c, { bands: 2, cap: s.team });
          for (let i = 0; i < 4; i++) { const a = PI / 4 + i * PI / 2; g.mast(cx + Math.cos(a) * R * 0.82, cy + Math.sin(a) * R * 0.82, 16, { w: 1.8, tip: s.pal.hot }); }
        });
        g.hazard(cx - R * 0.5, cy + R * 0.92 - 3.5, R, 2.6);
      };
      art.lights = function (g, s) { if (s.powered) g.puff(cx, cy - 18, R * 0.55, s.team, 0.2 + 0.16 * Math.sin(s.t * 2.2)); };
    } else if (role === 'defense') {
      const big = W > TILE, cx = W / 2, cy = H / 2 + (big ? 3 : 2), heavy = !!w0 && w0.dmg >= 50;
      const tr = big ? 8.5 : 5.6, blen = w0 ? NT.clamp(w0.range * 1.8, 8, 17) : 9, lift = big ? 7 : 3;
      art.height = big ? 14 : 10;
      art.base = function (g, s) {
        if (big) {
          g.prism(ngon(cx, cy, W / 2 - 5, 8, PI / 8), 6, s.pal.concrete, { wall: s.pal.concreteDark });
          g.at(6, function () { g.circle(cx, cy, W / 2 - 11, C.b, { lit: 0.1, bevel: -0.8 }); g.solid(P.ring(cx, cy, W / 2 - 10, W / 2 - 7.4), s.team, { lit: 0.14, lw: 0.5 }); });
        } else {
          g.circle(cx, cy, 10.5, '#242933', { lit: 0, bevel: -0.8 });
          g.sandbags(ngon(cx, cy, 11.4, 9, PI * 0.72).slice(0, 16), { rows: 2, bag: 5 });
          g.rect(cx - 12.5, cy - 13.5, 5, 3.2, s.team, { r: 0.6, lit: 0.14, lw: 0.5 });
        }
        if (!w0 || !w0.turret) {                                     // fixed post: a small watch platform
          const r = g.box(cx - 7, cy - 6, 14, 12, 12, { roof: C.a, wall: wall });
          g.rect(r.x + 2, r.y + 2, r.w - 4, r.d - 4, s.team, { r: 1, lit: 0.16, lw: 0.6 });
          g.at(12, function () { g.crate(cx - 3, cy - 3, 6, 5, 3, C.c); });
        }
      };
      if (w0 && w0.turret) {
        art.pivot = [cx, cy - lift];
        art.muzzle = [[tr * 0.5 + blen, 0]];
        art.top = function (g, s) {
          if (heavy) g.barrel(tr * 0.5, 0, blen, big ? 3 : 2.4, s.pal.gun, { brake: true, sleeve: 4 });
          else { g.barrel(tr * 0.4, -1.4, blen, 1.3); g.barrel(tr * 0.4, 1.4, blen, 1.3); }
          g.poly([-tr, -tr * 0.8, tr * 0.5, -tr * 0.9, tr, -tr * 0.36, tr, tr * 0.36, tr * 0.5, tr * 0.9, -tr, tr * 0.8], C.a, { r: 1.4, lit: 0.16 });
          g.rect(-tr * 0.72, -tr * 0.56, tr * 1.05, tr * 1.12, s.team, { r: 1.2, lit: 0.16, lw: 0.6 });
        };
      } else art.muzzle = [[cx, cy - 16]];
    } else {
      const glyph = ['bars', 'star', 'gear', 'shield', 'arrow'][C.h % 5];
      art.height = 24;
      art.base = function (g, s) {
        const h = 14, r = shell(g, s, h);
        g.awning(W / 2 - 9, r.wall.y + h - 1, 18, 5, { z: 9, cols: [s.team, s.teamInk], step: 3 });
        teamPanel(g, s, r.x + 4, r.y + 4, r.w - 8, 7);
        g.at(h, function () { g.ac(W - 18, 22, 8, 6); const b = g.billboard(9, H - 18, Math.min(26, W - 30), 8, { lift: 2 }); g.glyph(glyph, b.x + 2, b.y + 1.2, 5.6, 5.6, s.team, { w: 1 }); g.scribble(b.x + 10, b.y + 2, b.w - 12, 4, s.pal.warm, { seed: sd }); });
      };
    }
    return art;
  }
})();
