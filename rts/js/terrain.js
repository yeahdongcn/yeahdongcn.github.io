'use strict';
// ============================================================================
// NEON TURF — terrain.js : THE CITY  (presentation; needs canvas; uses the NT.Art kit when it is loaded)
// Ground, canal, city blocks, Glint heaps, street furniture — and every cache behind them. All of it is
// drawn by code from the map alone and is a pure function of (map.seed, position): a chunk looks the same
// whenever and at whatever resolution it is baked.
//
//   NT.Terrain.build(map)                    index the map + bake the coarse base layer. Runs by itself on
//                                            'game:start'; the same map again is a no-op.
//   NT.Terrain.drawGround(ctx, view)         roads, pavement, lots, rubble, canal (ripples move with view.t),
//                                            flat deco. MUST be the first terrain call of a frame: it picks
//                                            the resolution bucket and opens the frame's bake budget.
//   NT.Terrain.shadowsFor(ctx, view)         soft tower shadows on the ground
//   NT.Terrain.drawResources(ctx, view, map) Glint heaps from LIVE map.res / map.resCap (6 looks: spent + 5 fills)
//   NT.Terrain.drawPropsLow(ctx, view)       wrecks, dumpsters, barriers, crates, planters
//   NT.Terrain.blocks(view) -> [{y, draw(ctx)}]   visible towers for the renderer's y-sort. A fresh array on
//                                            every call; y = south edge of the footprint in world px.
//   NT.Terrain.drawPropsHigh(ctx, view)      what overhangs units: lamp heads, steam
//   NT.Terrain.drawLights(ctx, view)         ADDITIVE (caller set 'lighter'): lamp pools, window + neon glow,
//                                            canal reflections, roof beacons, Glint glow + twinkle
//   NT.Terrain.minimap(map) -> canvas        1 px per cell, cached per map, independent of build()
//   NT.Terrain.clear()                       drop every raster (hot reload, benchmarks)
//   NT.Terrain.stats / .budget / .bakeMs / .LADDER
//
//   view = { x0, y0, x1, y1 (visible world px), zoom, dpr, t (seconds) }. ctx arrives in WORLD space
//   (1 unit = 1 world px) and leaves every call exactly as it came (transform, alpha, composite mode).
//
// CACHES. Nothing static is drawn per frame: a frame is blits plus a handful of live bits (ripples, steam,
// twinkles, flickering lamps, beacons).
//   - resolution bucket = the first T.LADDER step that needs <= 12% upscaling for zoom x dpr (with
//     hysteresis), capped so that one screenful of every layer fits the budget;
//   - CHUNKS per bucket for three layers: ground (opaque), shade (tower shadows), light (static additive
//     light); the soft layers are stored at half resolution. A chunk covers fewer cells the finer the
//     bucket, so its canvas is always 384-768 px;
//   - SPRITES per bucket: one per tower (wall, roof, props, signs), per standing prop, per Glint look;
//   - bucket 0 of every chunk is baked in build() and pinned: whatever is not baked yet at the wanted
//     resolution shows that coarse piece first, then sharpens. Baking is limited to T.bakeMs per frame
//     (the first frame after build() / clear() bakes its whole view at once); T.stats.pending counts what
//     the last frame still lacked;
//   - T.budget cached pixels in total, least-recently-used rasters go first.
// Blits are snapped to device pixels (read from the ctx transform), so chunks never show seams.
// ============================================================================
(function () {
  const TILE = NT.TILE, TER = NT.TERRAIN, TAU = Math.PI * 2, PI = Math.PI;
  const ROAD = TER.ROAD, PAVE = TER.PAVE, LOT = TER.LOT, RUBBLE = TER.RUBBLE, WATER = TER.WATER, BLOCK = TER.BLOCK;
  const T = NT.Terrain = {};

  T.LADDER = [0.5, 0.75, 1, 1.5, 2, 3, 4];          // device px per world px of the cached rasters
  const CELLS = [32, 16, 16, 8, 8, 8, 4];           // chunk edge in cells per ladder step
  const GROUND = 0, SHADE = 1, LIGHT = 2;
  T.budget = (function (m) { return m >= 8 ? 40e6 : m && m <= 2 ? 16e6 : 28e6; })(typeof navigator !== 'undefined' && navigator.deviceMemory);
  T.bakeMs = 5;
  T.stats = { pixels: 0, canvases: 0, bakes: 0, bakeMs: 0, evictions: 0, pending: 0, bucket: 0 };

  const SHADOW = (NT.Art && NT.Art.SHADOW) || [0.58, 0.46];      // ground shadow displacement per px of height
  const COL = { void: '#07080c', road: '#141821', pave: '#262c39', lot: '#2b2825', rubble: '#1c1c1f', water: '#07151e', block: '#0d0f14',
    kerb: '#3f4756', line: '#c4cee0' };
  const MINI = ['#1a1e29', '#2b3241', '#37332f', '#453f39', '#123c58', '#4d5872', '#5fe8d6'];
  // city light sits BETWEEN the player colours and stays small; lamps are pale, never amber
  const WARM = '#ffe2b0', ICE = '#d9f4ff', NEON = ['#ff8a4c', '#3df0a8', '#8fb8ff', '#e06bff', '#f2f06a'];
  const GLINT = ['#2d5961', '#4b8f97', '#7cc9c8', '#b4efe6', '#e9fffb'];

  let S = null;                                     // everything known about the built map
  const F = { n: 0, spent: 0, fresh: true, b: 2 };  // the running frame
  const CH = new Map(), LIVE = [];

  function mk(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w - 1e-6)); c.height = Math.max(1, Math.ceil(h - 1e-6));
    return c;
  }
  function ih(a, b) {                               // integer pair -> [0, 1)
    let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
    return (h >>> 0) / 4294967296;
  }
  function hc(x, y, k) { return ih(x * 131 + k * 7919 + S.salt, y * 31 + k); }      // per cell, per purpose
  function rgb(c) { const n = parseInt(c.slice(1, 7), 16); return [n >> 16, n >> 8 & 255, n & 255]; }
  function rgba(c, a) { const v = rgb(c); return 'rgba(' + v[0] + ',' + v[1] + ',' + v[2] + ',' + a + ')'; }
  function shade(c, k) {
    const v = rgb(c), t = k < 0 ? 0 : 255, f = Math.abs(k);
    return 'rgb(' + Math.round(v[0] + (t - v[0]) * f) + ',' + Math.round(v[1] + (t - v[1]) * f) + ',' + Math.round(v[2] + (t - v[2]) * f) + ')';
  }
  function kit(c, res, mode) { return NT.Art && NT.Art.kit ? NT.Art.kit(c, res, mode) : null; }

  // --- cache ------------------------------------------------------------------------------------
  function store(cv, pin, owner, slot) {
    const e = { cv: cv, px: cv.width * cv.height, used: F.n, pin: pin, owner: owner, slot: slot };
    LIVE.push(e);
    T.stats.pixels += e.px; T.stats.canvases++;
    if (T.stats.pixels > T.budget) evict();
    return e;
  }
  function evict() {
    LIVE.sort(function (a, b) { return (b.pin - a.pin) || (b.used - a.used); });
    while (LIVE.length && T.stats.pixels > T.budget * 0.8) {
      const e = LIVE[LIVE.length - 1];
      if (e.pin || e.used >= F.n) break;            // never drop what this frame is drawing
      LIVE.pop();
      if (e.owner) e.owner[e.slot] = null; else CH.delete(e.slot);
      T.stats.pixels -= e.px; T.stats.canvases--; T.stats.evictions++;
      e.cv.width = e.cv.height = 0;
    }
  }
  function clearCache() {
    for (const e of LIVE) { if (e.owner) e.owner[e.slot] = null; e.cv.width = e.cv.height = 0; }
    LIVE.length = 0; CH.clear();
    T.stats.pixels = T.stats.canvases = 0;
  }
  function mayBake() { return F.fresh || F.spent < T.bakeMs; }
  function timed(fn, a, b, c, d, e) {
    const t0 = performance.now();
    fn(a, b, c, d, e);
    const dt = performance.now() - t0;
    F.spent += dt; T.stats.bakes++; T.stats.bakeMs += dt;
  }

  // --- resolution bucket ----------------------------------------------------------------------------
  function bucketFor(view) {
    const L = T.LADDER, z = view.zoom * (view.dpr || 1), area = Math.max(1, (view.x1 - view.x0) * (view.y1 - view.y0));
    const cap = Math.sqrt(T.budget * 0.2 / area);
    let b = F.b;
    if (F.fresh || z > L[b] * 1.12 || (b > 0 && z <= L[b - 1] * 1.04)) {
      b = 0;
      while (b < L.length - 1 && L[b] * 1.12 < z) b++;
    }
    while (b > 0 && L[b] > cap) b--;
    return b;
  }

  // --- chunks -----------------------------------------------------------------------------------------
  function chunk(layer, b, cx, cy, force) {
    const key = ((layer * 8 + b) * 128 + cy) * 128 + cx;
    let e = CH.get(key);
    if (e) { e.used = F.n; return e.cv; }
    if (!force && !mayBake()) { T.stats.pending++; return null; }
    const n = CELLS[b], res = T.LADDER[b] * (layer === GROUND ? 1 : 0.5), cv = mk(n * TILE * res, n * TILE * res), c = cv.getContext('2d');
    c.setTransform(res, 0, 0, res, -cx * n * TILE * res, -cy * n * TILE * res);
    timed(layer === GROUND ? paintGround : layer === SHADE ? paintShade : paintLight, c, res, cx * n, cy * n, n);
    e = store(cv, b === 0 ? 1 : 0, null, key);
    CH.set(key, e);
    return cv;
  }
  function drawLayer(ctx, view, layer, b) {
    const m = ctx.getTransform(), n = CELLS[b], cw = n * TILE, n0 = CELLS[0], nx = Math.ceil(S.w / n), ny = Math.ceil(S.h / n);
    const cx0 = Math.max(0, Math.floor(view.x0 / cw)), cy0 = Math.max(0, Math.floor(view.y0 / cw));
    const cx1 = Math.min(nx, Math.ceil(view.x1 / cw)), cy1 = Math.min(ny, Math.ceil(view.y1 / cw));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let cy = cy0; cy < cy1; cy++) {
      const dy0 = Math.round(m.d * cy * cw + m.f), dy1 = Math.round(m.d * (cy + 1) * cw + m.f);
      for (let cx = cx0; cx < cx1; cx++) {
        const dx0 = Math.round(m.a * cx * cw + m.e), dx1 = Math.round(m.a * (cx + 1) * cw + m.e);
        const cv = chunk(layer, b, cx, cy);
        if (cv) { ctx.drawImage(cv, dx0, dy0, dx1 - dx0, dy1 - dy0); continue; }
        const bx = (cx * n / n0) | 0, by = (cy * n / n0) | 0, base = chunk(layer, 0, bx, by, true), k = base.width / n0;
        ctx.drawImage(base, (cx * n - bx * n0) * k, (cy * n - by * n0) * k, n * k, n * k, dx0, dy0, dx1 - dx0, dy1 - dy0);
      }
    }
    ctx.setTransform(m);
    // an idle frame bakes one chunk of the ring around the view, so that panning rarely meets a cold one
    if (F.spent > 0 || T.stats.pending) return;
    for (let cy = Math.max(0, cy0 - 1); cy < Math.min(ny, cy1 + 1); cy++) for (let cx = Math.max(0, cx0 - 1); cx < Math.min(nx, cx1 + 1); cx++) {
      if ((cy >= cy0 && cy < cy1 && cx >= cx0 && cx < cx1) || CH.has(((layer * 8 + b) * 128 + cy) * 128 + cx)) continue;
      chunk(layer, b, cx, cy);
      return;
    }
  }

  // --- sprites: one raster per item per bucket ----------------------------------------------------------
  // item = { bx, by, bw, bh (world rect of everything it paints, relative to where it is put), paint(c, res, it), spr: [] }
  function sprite(it, b) {
    let e = it.spr[b];
    if (e) { e.used = F.n; return e; }
    if (b > 0 && !mayBake()) { T.stats.pending++; return sprite(it, 0); }
    const res = T.LADDER[b], cv = mk(it.bw * res, it.bh * res), c = cv.getContext('2d');
    c.setTransform(res, 0, 0, res, -it.bx * res, -it.by * res);
    timed(it.paint, c, res, it);
    e = it.spr[b] = store(cv, b === 0 ? 1 : 0, it.spr, b);
    e.res = res;
    return e;
  }
  // blit a sprite with its origin at world (x, y); m = the ctx transform, ctx itself is in device space
  function put(ctx, m, it, x, y) {
    const e = sprite(it, F.b), cv = e.cv;
    const dx0 = Math.round(m.a * (x + it.bx) + m.e), dy0 = Math.round(m.d * (y + it.by) + m.f);
    ctx.drawImage(cv, dx0, dy0, Math.round(m.a * cv.width / e.res), Math.round(m.d * cv.height / e.res));
  }
  function seen(it, view) { return it.bx < view.x1 && it.by < view.y1 && it.bx + it.bw > view.x0 && it.by + it.bh > view.y0; }
  function near(x, y, r, view) { return x + r > view.x0 && x - r < view.x1 && y + r > view.y0 && y - r < view.y1; }

  // ======================================================================================================
  // GROUND
  // ======================================================================================================
  // Seamless grain tiles (96 world px), one canvas per look per resolution.
  const TILES = new Map(), PATW = 96;
  const GRAIN = {
    asphalt: function (c, R) {
      for (let i = 0; i < 300; i++) speck(c, R, R.chance(0.55) ? 'rgba(0,0,0,' + R.range(0.12, 0.3) + ')' : 'rgba(170,190,225,' + R.range(0.03, 0.085) + ')', R.range(0.6, 1.7));
      for (let i = 0; i < 5; i++) blot(c, R, 'rgba(0,0,0,0.1)', R.range(9, 20));
      for (let i = 0; i < 4; i++) blot(c, R, 'rgba(120,150,200,0.03)', R.range(10, 22));
    },
    gravel: function (c, R) {
      for (let i = 0; i < 520; i++) speck(c, R, R.chance(0.5) ? 'rgba(0,0,0,' + R.range(0.14, 0.3) + ')' : 'rgba(205,190,165,' + R.range(0.05, 0.15) + ')', R.range(0.8, 2.3));
      for (let i = 0; i < 6; i++) blot(c, R, 'rgba(0,0,0,0.09)', R.range(8, 18));
    },
    concrete: function (c, R) {
      for (let i = 0; i < 170; i++) speck(c, R, R.chance(0.5) ? 'rgba(0,0,0,' + R.range(0.06, 0.16) + ')' : 'rgba(200,215,240,' + R.range(0.02, 0.05) + ')', R.range(0.6, 1.5));
      for (let i = 0; i < 4; i++) blot(c, R, 'rgba(0,0,0,0.06)', R.range(9, 18));
    },
    ripple: function (c, R) {
      c.lineCap = 'round';
      for (let i = 0; i < 34; i++) {
        const x = R.range(0, PATW), y = R.range(0, PATW), l = R.range(5, 15), a = R.range(0.5, 1.6);
        c.strokeStyle = 'rgba(150,205,225,' + R.range(0.1, 0.34) + ')'; c.lineWidth = R.range(0.5, 1);
        wrap(function (ox, oy) { c.beginPath(); c.moveTo(x + ox, y + oy); c.quadraticCurveTo(x + ox + l / 2, y + oy - a, x + ox + l, y + oy); c.stroke(); });
      }
    },
  };
  function wrap(fn) { for (let oy = -PATW; oy <= PATW; oy += PATW) for (let ox = -PATW; ox <= PATW; ox += PATW) fn(ox, oy); }
  function speck(c, R, col, s) {
    const x = R.range(0, PATW), y = R.range(0, PATW), w = s * R.range(0.7, 1.4);
    c.fillStyle = col;
    wrap(function (ox, oy) { c.fillRect(x + ox, y + oy, w, s); });
  }
  function blot(c, R, col, r) {
    const x = R.range(0, PATW), y = R.range(0, PATW), k = R.range(0.5, 1);
    wrap(function (ox, oy) {
      const g = c.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
      g.addColorStop(0, col); g.addColorStop(1, col.replace(/[\d.]+\)$/, '0)'));
      c.fillStyle = g; c.save(); c.translate(x + ox, y + oy); c.scale(1, k); c.translate(-x - ox, -y - oy); c.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r); c.restore();
    });
  }
  function grain(c, name, res) {
    const key = name + res;
    let p = TILES.get(key);
    if (!p) {
      const cv = mk(PATW * res, PATW * res), x = cv.getContext('2d');
      x.scale(res, res);
      GRAIN[name](x, new NT.Rng(NT.hash32('grain', name)));
      p = c.createPattern(cv, 'repeat');
      if (p.setTransform) p.setTransform(new DOMMatrix([1 / res, 0, 0, 1 / res, 0, 0]));
      TILES.set(key, p);
    }
    return p;
  }

  function surf(x, y, own) { return x < 0 || y < 0 || x >= S.w || y >= S.h ? own : S.map.terrain[y * S.w + x]; }
  function strip(c, x, y, d, off, t) {              // a band along side d (0 E, 1 S, 2 W, 3 N) of a cell
    const X = x * TILE, Y = y * TILE;
    if (d === 0) c.fillRect(X + TILE - off - t, Y, t, TILE);
    else if (d === 1) c.fillRect(X, Y + TILE - off - t, TILE, t);
    else if (d === 2) c.fillRect(X + off, Y, t, TILE);
    else c.fillRect(X, Y + off, TILE, t);
  }
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];

  function paintGround(c, res, cx0, cy0, n) {
    const ter = S.map.terrain, w = S.w, h = S.h, lod = res >= 1 ? 2 : res >= 0.75 ? 1 : 0;
    const a0 = Math.max(0, cx0 - 1), b0 = Math.max(0, cy0 - 1), a1 = Math.min(w, cx0 + n + 1), b1 = Math.min(h, cy0 + n + 1);
    const fills = [COL.road, COL.pave, COL.lot, COL.rubble, COL.water, COL.block], pats = ['asphalt', 'concrete', 'gravel', 'gravel', null, null];
    c.fillStyle = COL.void; c.fillRect(cx0 * TILE, cy0 * TILE, n * TILE, n * TILE);
    // base colour + grain, in runs
    for (let pass = 0; pass < 2; pass++) for (let y = b0; y < b1; y++) for (let x = a0; x < a1;) {
      const t = ter[y * w + x];
      let e = x + 1;
      while (e < a1 && ter[y * w + e] === t) e++;
      if (!pass) { c.fillStyle = fills[t] || COL.road; c.fillRect(x * TILE, y * TILE, (e - x) * TILE, TILE); }
      else if (pats[t]) { c.fillStyle = grain(c, pats[t], res); c.fillRect(x * TILE, y * TILE, (e - x) * TILE, TILE); }
      x = e;
    }
    for (let y = b0; y < b1; y++) for (let x = a0; x < a1; x++) {
      const t = ter[y * w + x];
      if (t === PAVE) slabs(c, x, y, lod); else if (t === LOT) lotCell(c, x, y, lod); else if (t === ROAD) roadCell(c, x, y, lod);
      else if (t === WATER) waterCell(c, x, y);
    }
    for (let y = b0; y < b1; y++) for (let x = a0; x < a1; x++) edges(c, x, y, ter[y * w + x], lod);
    for (let y = b0; y < b1; y++) for (let x = a0; x < a1; x++) if (ter[y * w + x] === ROAD) markings(c, x, y);
    // rubble last: it spills over its neighbours (two cells of margin so that a chunk border never cuts a heap)
    for (let y = Math.max(0, cy0 - 1); y < b1; y++) for (let x = Math.max(0, cx0 - 1); x < a1; x++) if (ter[y * w + x] === RUBBLE) rubble(c, x, y, lod);
    flat(c, cx0, cy0, n, lod);
  }

  function slabs(c, x, y, lod) {
    const X = x * TILE, Y = y * TILE, big = hc(x >> 2, y >> 2, 3) < 0.3;
    if (lod) for (let k = 0; k < 4; k++) {            // slab by slab tone
      const v = hc(x * 2 + (k & 1), y * 2 + (k >> 1), 1);
      c.fillStyle = v < 0.5 ? 'rgba(0,0,0,' + (0.5 - v) * 0.2 + ')' : 'rgba(150,175,220,' + (v - 0.5) * 0.07 + ')';
      c.fillRect(X + (k & 1) * 16, Y + (k >> 1) * 16, 16, 16);
    }
    c.fillStyle = 'rgba(0,0,0,0.3)';
    c.fillRect(X, Y, TILE, 0.8); c.fillRect(X, Y, 0.8, TILE);
    if (!big || lod < 2) { c.fillRect(X, Y + 16, TILE, 0.7); c.fillRect(X + 16, Y, 0.7, TILE); }
    if (lod > 1) {
      c.fillStyle = 'rgba(160,185,230,0.035)';
      c.fillRect(X, Y + 0.8, TILE, 0.7); c.fillRect(X + 0.8, Y, 0.7, TILE);
      if (hc(x, y, 2) < 0.07) {                       // a cracked slab
        const u = hc(x, y, 4) * 20 + 4;
        c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 0.6; c.beginPath();
        c.moveTo(X + u, Y + 2); c.lineTo(X + u + 3, Y + 9); c.lineTo(X + u - 2, Y + 14); c.lineTo(X + u + 4, Y + 24); c.stroke();
      }
    }
  }
  function lotCell(c, x, y, lod) {
    if (lod < 2) return;
    const X = x * TILE, Y = y * TILE, v = hc(x, y, 5);
    if (v < 0.12) {                                   // oil stain
      const g = c.createRadialGradient(X + 16, Y + 16, 1, X + 16, Y + 16, 11);
      g.addColorStop(0, 'rgba(0,0,0,0.3)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(X, Y, TILE, TILE);
    } else if (v > 0.8) {                             // tyre ruts
      c.strokeStyle = 'rgba(0,0,0,0.16)'; c.lineWidth = 2.2; c.beginPath();
      const u = hc(x, y, 6) * 14;
      c.moveTo(X, Y + 6 + u); c.quadraticCurveTo(X + 16, Y + 2 + u, X + TILE, Y + 8 + u);
      c.moveTo(X, Y + 13 + u); c.quadraticCurveTo(X + 16, Y + 9 + u, X + TILE, Y + 15 + u); c.stroke();
    }
  }
  function roadCell(c, x, y, lod) {
    if (lod < 2) return;
    const X = x * TILE, Y = y * TILE, rc = S.rc[y * S.w + x], v = hc(x, y, 7);
    // worn wheel lanes along the street
    c.fillStyle = 'rgba(150,170,210,0.022)';
    if (rc === 1) { c.fillRect(X, Y + 7, TILE, 6); c.fillRect(X, Y + 20, TILE, 6); }
    else if (rc === 2) { c.fillRect(X + 7, Y, 6, TILE); c.fillRect(X + 20, Y, 6, TILE); }
    if (v < 0.07) {                                   // patched tarmac
      c.fillStyle = 'rgba(0,0,0,0.2)'; c.fillRect(X + 4 + hc(x, y, 8) * 10, Y + 5 + hc(x, y, 9) * 10, 9 + v * 90, 7 + hc(x, y, 10) * 6);
    } else if (v > 0.93) {                            // crack
      const u = hc(x, y, 8) * 16;
      c.strokeStyle = 'rgba(0,0,0,0.42)'; c.lineWidth = 0.7; c.beginPath();
      c.moveTo(X + 3, Y + 6 + u); c.lineTo(X + 11, Y + 9 + u); c.lineTo(X + 15, Y + 5 + u); c.lineTo(X + 26, Y + 10 + u); c.stroke();
    }
  }
  function waterCell(c, x, y) {
    const X = x * TILE, Y = y * TILE, v = hc(x, y, 11);
    c.fillStyle = 'rgba(40,110,130,' + (0.03 + v * 0.07) + ')'; c.fillRect(X, Y, TILE, TILE);
  }

  // kerbs, tower aprons, quays, bridge rails: whatever happens where two surfaces meet
  function edges(c, x, y, t, lod) {
    const X = x * TILE, Y = y * TILE, deck = S.deck[y * S.w + x];
    for (let d = 0; d < 4; d++) {
      const nt = surf(x + DX[d], y + DY[d], t);
      if (nt === t) continue;
      if (t === WATER) {
        if (d === 3) {                                // the quay wall is seen from the south, like every wall
          const g = c.createLinearGradient(0, Y, 0, Y + 9);
          g.addColorStop(0, '#2c333f'); g.addColorStop(0.75, '#141a22'); g.addColorStop(1, '#0a1218');
          c.fillStyle = g; c.fillRect(X, Y, TILE, 9);
          c.fillStyle = 'rgba(0,0,0,0.25)'; for (let k = 0; k < 4; k++) c.fillRect(X + k * 8 + (y & 1) * 4, Y, 0.7, 7);
          c.fillStyle = 'rgba(150,215,235,0.3)'; c.fillRect(X, Y + 8.6, TILE, 0.8);
          c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(X, Y + 9.4, TILE, 5);
        } else if (d === 2) {
          const g = c.createLinearGradient(X, 0, X + 9, 0);
          g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0)');
          c.fillStyle = g; c.fillRect(X, Y, 9, TILE);
        } else { c.fillStyle = 'rgba(0,0,0,0.5)'; strip(c, x, y, d, 0, 1.2); c.fillStyle = 'rgba(150,215,235,0.12)'; strip(c, x, y, d, 1.2, 0.7); }
        continue;
      }
      if (t === BLOCK) continue;
      if (nt === WATER) {
        if (deck) {                                   // bridge / plaza deck: a rail instead of coping
          c.fillStyle = '#0c0f15'; strip(c, x, y, d, 0, 3);
          c.fillStyle = '#6a7690'; strip(c, x, y, d, 1, 1.1);
          if (lod) { c.fillStyle = '#a3aec4'; for (let k = 0; k < 4; k++) d & 1 ? c.fillRect(X + 3 + k * 8, d === 1 ? Y + TILE - 2.6 : Y + 0.6, 1.6, 2) : c.fillRect(d === 0 ? X + TILE - 2.6 : X + 0.6, Y + 3 + k * 8, 2, 1.6); }
        } else {
          c.fillStyle = '#4a5261'; strip(c, x, y, d, 0, 3.6);
          c.fillStyle = 'rgba(190,210,240,0.14)'; strip(c, x, y, d, 2.6, 1);
          c.fillStyle = 'rgba(0,0,0,0.4)'; strip(c, x, y, d, 3.6, 0.8);
          if (lod) for (let k = 0; k < 3; k++) d & 1 ? c.fillRect(X + 5 + k * 11, d === 1 ? Y + TILE - 3.6 : Y, 0.7, 3.6) : c.fillRect(d === 0 ? X + TILE - 3.6 : X, Y + 5 + k * 11, 3.6, 0.7);
        }
      } else if (nt === BLOCK) {
        if (t === ROAD) {                             // a strip of pavement at the foot of the tower
          c.fillStyle = COL.pave; strip(c, x, y, d, 0, 5);
          c.fillStyle = COL.kerb; strip(c, x, y, d, 5, 1.2);
          c.fillStyle = 'rgba(0,0,0,0.4)'; strip(c, x, y, d, 6.2, 0.9);
        }
        c.fillStyle = 'rgba(0,0,0,0.5)'; strip(c, x, y, d, 0, 1.4);
      } else if (t === PAVE) {
        if (nt === ROAD) { c.fillStyle = COL.kerb; strip(c, x, y, d, 0, 2.2); c.fillStyle = 'rgba(200,220,255,0.12)'; strip(c, x, y, d, 1.5, 0.7); }
        else { c.fillStyle = '#39414f'; strip(c, x, y, d, 0, 1.5); c.fillStyle = 'rgba(0,0,0,0.35)'; strip(c, x, y, d, -0.7, 0.7); }
      } else if (t === ROAD && (nt === PAVE || nt === LOT)) { c.fillStyle = 'rgba(0,0,0,0.5)'; strip(c, x, y, d, 0, 1.3); }
      else if (t === LOT && nt === ROAD) { c.fillStyle = '#3b3d42'; strip(c, x, y, d, 0, 1.8); }
    }
    if (t === BLOCK || t === WATER) return;
    // inner corners: the apron turns the corner of a tower
    if (t === ROAD) for (let k = 0; k < 4; k++) {
      const sx = k & 1 ? 1 : -1, sy = k & 2 ? 1 : -1;
      if (surf(x + sx, y + sy, t) !== BLOCK || surf(x + sx, y, t) === BLOCK || surf(x, y + sy, t) === BLOCK) continue;
      const px = sx > 0 ? X + TILE - 6.2 : X, py = sy > 0 ? Y + TILE - 6.2 : Y;
      c.fillStyle = COL.kerb; c.fillRect(px, py, 6.2, 6.2);
      c.fillStyle = COL.pave; c.fillRect(sx > 0 ? px + 1.2 : px, sy > 0 ? py + 1.2 : py, 5, 5);
    }
    if (deck && lod > 1) { c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(X, Y + 15.6, TILE, 0.8); c.fillRect(X + 15.6, Y, 0.8, TILE); }
  }

  // lane dashes along street runs, stop lines where a street meets a crossing
  function markings(c, x, y) {
    const w = S.w, i = y * w + x, rc = S.rc[i], X = x * TILE, Y = y * TILE;
    if (rc !== 1 && rc !== 2) return;
    const hz = rc === 1, fwd = hz ? (x + 1 < w && S.rc[i + 1] === 3) : (y + 1 < S.h && S.rc[i + w] === 3), back = hz ? (x > 0 && S.rc[i - 1] === 3) : (y > 0 && S.rc[i - w] === 3);
    const wear = 0.2 + hc(x, y, 12) * 0.16;
    if (fwd || back) {
      const far = S.xwalk[i] ? 3.5 : TILE - 6;        // behind the crosswalk, or right at the crossing
      c.fillStyle = rgba(COL.line, wear + 0.08);
      const o = fwd ? far : TILE - far - 2.4;
      if (hz) c.fillRect(X + o, Y + 2.5, 2.4, TILE - 5 + (S.rc[i + w] === 1 ? 5 : 0)); else c.fillRect(X + 2.5, Y + o, TILE - 5 + (S.rc[i + 1] === 2 ? 5 : 0), 2.4);
      return;
    }
    if (hc(x, y, 13) < 0.06) return;                  // worn away
    c.fillStyle = rgba(COL.line, wear);
    if (hz && y + 1 < S.h && S.rc[i + w] === 1) c.fillRect(X + 8, Y + TILE - 0.8, 16, 1.6);
    if (!hz && x + 1 < w && S.rc[i + 1] === 2) c.fillRect(X + TILE - 0.8, Y + 8, 1.6, 16);
  }

  function rubble(c, x, y, lod) {
    const X = x * TILE, Y = y * TILE, n = lod ? 9 : 5, R = new NT.Rng(NT.hash32(S.salt, 'rubble', x, y));
    const g = c.createRadialGradient(X + 16, Y + 16, 4, X + 16, Y + 16, 25);
    g.addColorStop(0, 'rgba(8,8,10,0.5)'); g.addColorStop(1, 'rgba(8,8,10,0)');
    c.fillStyle = g; c.fillRect(X - 10, Y - 10, 52, 52);
    for (let k = 0; k < n; k++) {
      const px = X + R.range(-3, TILE + 3), py = Y + R.range(-3, TILE + 3), r = R.range(2.2, 6.6), m = 4 + R.int(3), a0 = R.range(0, TAU), tone = R.range(0.22, 0.5);
      const pts = [];
      for (let j = 0; j < m; j++) { const a = a0 + j * TAU / m + R.range(-0.3, 0.3), rr = r * R.range(0.6, 1); pts.push(px + Math.cos(a) * rr, py + Math.sin(a) * rr * 0.8); }
      const path = function (ox, oy) { c.beginPath(); c.moveTo(pts[0] + ox, pts[1] + oy); for (let j = 2; j < pts.length; j += 2) c.lineTo(pts[j] + ox, pts[j + 1] + oy); c.closePath(); };
      c.fillStyle = 'rgba(0,0,0,0.55)'; path(1.3, 1.6); c.fill();
      const v = Math.round(255 * tone);
      c.fillStyle = 'rgb(' + Math.round(v * 0.86) + ',' + Math.round(v * 0.88) + ',' + Math.round(v * 0.94) + ')'; path(0, 0); c.fill();
      if (lod > 1 && r > 3.4) {                       // lit top-left facet
        c.save(); c.clip(); c.fillStyle = 'rgba(255,255,255,0.14)'; c.fillRect(px - r, py - r, r * 1.1, r * 1.2); c.restore();
      }
    }
    if (lod) for (let k = 0; k < 2; k++) {            // rebar
      const px = X + R.range(2, 30), py = Y + R.range(2, 30), a = R.range(0, PI), l = R.range(5, 11);
      c.strokeStyle = k ? '#6d4a38' : '#585d66'; c.lineWidth = 0.8; c.beginPath(); c.moveTo(px, py); c.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); c.stroke();
    }
    if (lod > 1) { c.fillStyle = 'rgba(150,155,165,0.3)'; for (let k = 0; k < 9; k++) c.fillRect(X + R.range(-2, 33), Y + R.range(-2, 33), 1, 1); }
  }

  // flat deco: everything a unit simply walks over
  function flat(c, cx0, cy0, n, lod) {
    const x0 = cx0 * TILE - 64, y0 = cy0 * TILE - 64, x1 = (cx0 + n) * TILE + 64, y1 = (cy0 + n) * TILE + 64;
    for (const d of S.flat) {
      if (d.x < x0 || d.y < y0 || d.x > x1 || d.y > y1) continue;
      c.save(); c.translate(d.x, d.y);
      FLAT[d.type](c, d, lod);
      c.restore();
    }
  }
  const FLAT = {
    crosswalk: function (c, d) {
      const half = (d.scale || 1) * TILE - 3, vert = Math.abs(Math.sin(d.rot)) > 0.5;
      if (vert) c.rotate(PI / 2);
      for (let v = -half + 1.5, k = 0; v + 4.4 <= half; v += 8.2, k++) {
        c.fillStyle = rgba(COL.line, 0.26 + ih(d.seed, k) * 0.16); c.fillRect(-10, v, 20, 4.4);
      }
    },
    manhole: function (c, d) {
      c.rotate(d.rot);
      c.fillStyle = '#0b0d12'; c.beginPath(); c.arc(0, 0, 7, 0, TAU); c.fill();
      c.fillStyle = '#2a303b'; c.beginPath(); c.arc(0, 0, 6, 0, TAU); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 0.8; c.beginPath();
      for (let k = -4; k <= 4; k += 2) { const e = Math.sqrt(30 - k * k); c.moveTo(k, -e); c.lineTo(k, e); }
      c.stroke();
      c.strokeStyle = 'rgba(170,190,225,0.22)'; c.lineWidth = 0.7; c.beginPath(); c.arc(0, 0, 6, PI, PI * 1.5); c.stroke();
    },
    puddle: function (c, d) {
      const R = new NT.Rng(d.seed), k = d.scale || 1, pts = [], m = 7, col = NEON[d.seed % NEON.length];
      c.rotate(d.rot);
      for (let j = 0; j < m; j++) { const a = j * TAU / m, r = R.range(8, 14) * k; pts.push(Math.cos(a) * r * 1.25, Math.sin(a) * r * 0.7); }
      c.beginPath(); c.moveTo((pts[2 * m - 2] + pts[0]) / 2, (pts[2 * m - 1] + pts[1]) / 2);
      for (let j = 0; j < m; j++) { const e = (j + 1) % m; c.quadraticCurveTo(pts[2 * j], pts[2 * j + 1], (pts[2 * j] + pts[2 * e]) / 2, (pts[2 * j + 1] + pts[2 * e + 1]) / 2); }
      c.closePath();
      c.fillStyle = 'rgba(4,7,12,0.62)'; c.fill();
      c.strokeStyle = 'rgba(150,185,230,0.2)'; c.lineWidth = 0.7; c.stroke();
      c.save(); c.clip(); c.rotate(-d.rot);           // what it mirrors hangs straight down the screen
      const g = c.createLinearGradient(0, -12 * k, 0, 12 * k);
      g.addColorStop(0, rgba(col, 0)); g.addColorStop(0.5, rgba(col, 0.2)); g.addColorStop(1, rgba(col, 0));
      c.fillStyle = g; c.fillRect(R.range(-7, 4) * k, -14 * k, 2.6 * k, 28 * k);
      c.fillStyle = 'rgba(190,215,245,0.1)'; c.fillRect(R.range(-9, 6) * k, -14 * k, 1.4 * k, 28 * k);
      c.fillStyle = 'rgba(190,215,245,0.07)'; c.fillRect(-16 * k, R.range(-4, 3) * k, 32 * k, 1.1);
      c.restore();
    },
    vent: function (c) {
      c.fillStyle = '#090b0f'; c.fillRect(-7.5, -5.5, 15, 11);
      c.fillStyle = '#272c36'; c.fillRect(-6.5, -4.5, 13, 9);
      c.fillStyle = '#07080b'; for (let k = 0; k < 4; k++) c.fillRect(-5.5, -3.6 + k * 2.2, 11, 1.1);
      c.fillStyle = 'rgba(170,190,225,0.16)'; c.fillRect(-6.5, -4.5, 13, 0.7);
    },
    lamp: function (c) {                              // foot of the post + the shadow of post and arm
      c.strokeStyle = 'rgba(0,0,0,0.3)'; c.lineWidth = 1.5; c.lineCap = 'round';
      c.beginPath(); c.moveTo(0, 0); c.lineTo(LAMP_H * SHADOW[0], LAMP_H * SHADOW[1]); c.stroke();
      c.fillStyle = '#0a0c11'; c.beginPath(); c.arc(0, 0, 2.6, 0, TAU); c.fill();
      c.fillStyle = '#4c5464'; c.beginPath(); c.arc(0, 0, 1.7, 0, TAU); c.fill();
    },
  };

  // ======================================================================================================
  // SHADE: tower shadows, one blurred union per chunk
  // ======================================================================================================
  function paintShade(c, res, cx0, cy0, n) {
    const x0 = cx0 * TILE - 48, y0 = cy0 * TILE - 48, x1 = (cx0 + n) * TILE + 16, y1 = (cy0 + n) * TILE + 16, OFF = 8192, p = new Path2D(), q = new Path2D();
    let any = false;
    for (const B of S.blocks) {
      if (B.x0 > x1 || B.y0 > y1 || B.x0 + B.W < x0 || B.y0 + B.D < y0) continue;
      const dx = B.H * SHADOW[0], dy = B.H * SHADOW[1], X = B.x0, Y = B.y0, W = B.W, D = B.D;
      p.moveTo(X, Y); p.lineTo(X + W, Y); p.lineTo(X + W + dx, Y + dy); p.lineTo(X + W + dx, Y + D + dy); p.lineTo(X + dx, Y + D + dy); p.lineTo(X, Y + D); p.closePath();
      q.rect(X - 1, Y, W + 5, D + 4);                  // the dark seam where wall meets street
      any = true;
    }
    if (!any) return;
    const m = c.getTransform();
    c.setTransform(m.a, 0, 0, m.d, m.e - OFF, m.f);   // only the blurred copy lands on the canvas
    c.shadowOffsetX = OFF; c.shadowColor = 'rgba(0,0,0,0.5)'; c.shadowBlur = 5 * res; c.fill(p);
    c.shadowColor = 'rgba(0,0,0,0.3)'; c.shadowBlur = 3 * res; c.fill(q);
    c.shadowColor = 'transparent'; c.setTransform(m);
  }

  // ======================================================================================================
  // LIGHT: static additive light. Ground light first, then every tower north to south: its silhouette
  // punches a hole (a roof hides the lamp pool behind it) and its own windows and neon go on top.
  // ======================================================================================================
  const LAMP_H = 17, LAMP_ARM = 12;
  function pool(c, x, y, r, col, a) {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(col, a)); g.addColorStop(0.3, rgba(col, a * 0.55)); g.addColorStop(0.65, rgba(col, a * 0.16)); g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; c.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  function paintLight(c, res, cx0, cy0, n) {
    const x0 = cx0 * TILE, y0 = cy0 * TILE, x1 = (cx0 + n) * TILE, y1 = (cy0 + n) * TILE;
    for (const L of S.lamps) {
      if (L.live || L.px < x0 - 90 || L.py < y0 - 90 || L.px > x1 + 90 || L.py > y1 + 90) continue;
      pool(c, L.px, L.py, 86, WARM, 0.2);
    }
    for (const B of S.blocks) {
      if (B.bx > x1 || B.by > y1 || B.bx + B.bw < x0 || B.by + B.bh + 24 < y0) continue;
      c.globalCompositeOperation = 'destination-out'; c.fillStyle = '#000'; c.fillRect(B.x0, B.y0 - B.H, B.W, B.D + B.H);
      c.globalCompositeOperation = 'source-over';
      const g = kit(c, res, 'glow');
      if (!g) continue;
      c.save(); c.translate(B.x0, B.y0); tower(g, B); c.restore();
    }
    for (const L of S.lamps) {                        // the fixtures themselves
      if (L.hidden || L.live || L.hx < x0 - 20 || L.hy < y0 - 20 || L.hx > x1 + 20 || L.hy > y1 + 20) continue;
      pool(c, L.hx, L.hy, 11, WARM, 0.5);
    }
  }

  // ======================================================================================================
  // TOWERS. Six styles; origin = footprint top-left, footprint W x D, B.H tall. Drawn with the art kit in
  // 'main' mode for the sprite and in 'glow' mode for the light layer: same code, same random numbers.
  // ======================================================================================================
  const STYLES = [
    { roof: '#3c4454', wall: '#2d3340', deck: '#333a48', win: [ICE, WARM, '#8fb8ff'], lit: 0.34 },     // 0 office slab
    { roof: '#3b3537', wall: '#4b3a35', deck: '#2f2b2e', win: [WARM, '#ffc98a', '#ffd9a0'], lit: 0.44 },  // 1 tenement
    { roof: '#2d3948', wall: '#1c2a38', deck: '#263242', win: ['#8fb8ff', ICE, '#a8e6ff'], lit: 0.38 },   // 2 glass tower
    { roof: '#474c55', wall: '#353940', deck: '#3c4149', win: [WARM, ICE], lit: 0.3 },                   // 3 works
    { roof: '#38324a', wall: '#3d2f47', deck: '#2d2839', win: [WARM, '#ff8a4c', '#e06bff'], lit: 0.46 },  // 4 arcade
    { roof: '#292e37', wall: '#1f232b', deck: '#22262e', win: ['#3df0a8', '#8fb8ff'], lit: 0.32 },        // 5 data vault
  ];

  // a made-up sign character: a short walk over a 3 x 3 lattice, sometimes with a dot
  function mark(g, seed, x, y, s, col, lw) {
    const R = new NT.Rng(seed), pts = [];
    let px = R.int(3), py = R.int(3), lx = -1, ly = -1;
    pts.push(x + px * s / 2, y + py * s / 2);
    for (let k = 0; k < 4; k++) {
      let nx, ny, tries = 0;
      do { nx = NT.clamp(px + R.irange(-1, 1) * (1 + R.int(2)), 0, 2); ny = NT.clamp(py + R.irange(-1, 1) * (1 + R.int(2)), 0, 2); }
      while (((nx === px && ny === py) || (nx === lx && ny === ly)) && ++tries < 8);
      lx = px; ly = py; px = nx; py = ny;
      pts.push(x + px * s / 2, y + py * s / 2);
    }
    g.neon(pts, col, { w: lw || Math.max(0.8, s * 0.14), r: 2.4 });
  }
  // sign board at as-drawn rect: marks + trim
  function signFace(g, x, y, w, h, seed, col) {
    const A = NT.Art, vert = h > w * 1.3, s = Math.min(w, h) - 3, n = Math.max(1, Math.floor(((vert ? h : w) - 1.5) / (s + 1.5))), col2 = NEON[(seed >> 3) % NEON.length];
    g.rect(x, y, w, h, '#10131a', { lit: 0, bevel: 0.5, r: 0.8, ol: '#05060a' });
    for (let k = 0; k < n; k++) {
      const o = ((vert ? h : w) - n * (s + 1.5) + 1.5) / 2 + k * (s + 1.5);
      mark(g, seed + k * 977, vert ? x + 1.5 : x + o, vert ? y + o : y + 1.5, s, k === 0 ? col : A.mix(col, col2, 0.5));
    }
    g.neon(A.P.rect(x + 0.5, y + 0.5, w - 1, h - 1, 0.8), col2, { w: 0.55, r: 1.8, a: 0.6 });
  }
  function wallSign(g, B, s) {
    const k = s.scale || 1, H = B.H, col = NEON[s.seed % NEON.length], lx = s.x - B.x0, ly = s.y - B.y0, side = Math.round(s.rot / (PI / 2)) & 3;
    if (side === 1) {                                 // on the south wall
      const h = Math.min(9 * k, H - 6), w = Math.min(B.W - 6, (h - 3) * 3 + 6);
      signFace(g, NT.clamp(lx - w / 2, 3, B.W - w - 3), B.D - H + Math.max(2, (H - 6 - h) * 0.4), w, h, s.seed, col);
    } else if (side === 3) {                          // on the roof edge, facing the street behind
      const w = 26 * k, x = NT.clamp(lx - w / 2, 3, B.W - w - 3);
      g.at(H, function () { const b = g.billboard(x, 4, w, 9 * k, { lift: 2.5, legs: 2 }); signFace(g, b.x, b.y, b.w, b.h, s.seed, col); });
    } else {                                          // a blade sticking out of an east / west wall
      const w = 9 * k, h = NT.clamp(H * 0.62, 10, 26), y = NT.clamp(ly, 8, B.D - 4), x = side === 0 ? B.W + 1 : -w - 1;
      const b = g.billboard(x, y, w, h, { lift: H * 0.24, legs: 0 });
      g.line(side === 0 ? B.W : 0, b.y + 1.5, x + (side === 0 ? 0 : w), b.y + 1.5, '#3a4252', 1.2); g.line(side === 0 ? B.W : 0, b.y + h - 1.5, x + (side === 0 ? 0 : w), b.y + h - 1.5, '#3a4252', 1.2);
      signFace(g, b.x, b.y, b.w, b.h, s.seed, col);
    }
  }

  // window grid between the roof line and the ground floor; returns the y where the ground floor starts
  function panes(g, wl, R, st, o) {
    const top = o.top === undefined ? 3 : o.top, gf = o.gf === undefined ? 7 : o.gf, mx = o.mx === undefined ? 4 : o.mx, gap = o.gap;
    const rows = Math.max(1, Math.floor((wl.h - top - gf + gap) / (o.ph + gap))), cols = Math.max(1, Math.floor((wl.w - 2 * mx + gap) / (o.pw + gap)));
    const w = o.fill ? wl.w - 2 * mx : cols * (o.pw + gap) - gap, h = rows * (o.ph + gap) - gap;
    g.windows(wl.x + (wl.w - w) / 2, wl.y + top, w, h, { cols: cols, rows: rows, gap: gap, lit: st.lit * (o.lit || 1), col: st.win, seed: R.int(99999), a: 0.3, blur: 1.5, dark: o.dark });
    return wl.y + wl.h - gf;
  }
  const FACADE = [
    function office(g, B, R, wl, st) {
      const A = NT.Art;
      if (g.vis()) { g.ctx.fillStyle = A.alpha('#ffffff', 0.05); for (let x = wl.x + 11; x < wl.x + wl.w - 6; x += 22) g.ctx.fillRect(x, wl.y, 1.4, wl.h); }
      panes(g, wl, R, st, { pw: 3.3, ph: 2.8, gap: 1.6 });
      g.door(wl.x + wl.w * R.range(0.3, 0.7) - 5, wl.y + wl.h - 7, 10, 7, { lit: ICE });
    },
    function tenement(g, B, R, wl, st) {
      panes(g, wl, R, st, { pw: 3.6, ph: 3.8, gap: 2.8, mx: 5 });
      if (wl.h >= 20 && g.vis()) {                    // fire escape
        const c = g.ctx, x = wl.x + 8 + R.range(0, wl.w - 26);
        c.strokeStyle = '#15171c'; c.lineWidth = 0.8; c.beginPath();
        for (let y = wl.y + 8; y < wl.y + wl.h - 4; y += 6.6) { c.moveTo(x, y); c.lineTo(x + 10, y); c.moveTo(x + 1, y); c.lineTo(x + 9, y + 6.6); }
        c.stroke();
      }
      g.door(wl.x + wl.w * R.range(0.2, 0.8) - 3, wl.y + wl.h - 7, 6, 7, { lit: R.chance(0.6) ? WARM : null });
    },
    function glass(g, B, R, wl, st) {
      panes(g, wl, R, st, { pw: 6.4, ph: 2.6, gap: 1, mx: 2, top: 2.5, gf: 7.5, dark: '#1f3549', fill: true });
      g.windows(wl.x + 5, wl.y + wl.h - 6, wl.w - 10, 5, { cols: Math.max(2, Math.round(wl.w / 16)), rows: 1, gap: 1.2, lit: 0.8, col: [ICE, '#a8e6ff'], seed: R.int(999), a: 0.3 });
    },
    function works(g, B, R, wl, st) {
      g.panels(wl.x, wl.y, wl.w, wl.h, Math.round(wl.w / 4.5), 1, 'rgba(0,0,0,0.16)', 0.5);
      g.windows(wl.x + 6, wl.y + 3, wl.w - 12, 3, { cols: Math.max(2, Math.round(wl.w / 13)), rows: 1, gap: 5, lit: st.lit, col: st.win, seed: R.int(999), a: 0.3 });
      const dh = Math.min(11, wl.h - 8), n = Math.max(1, Math.floor(wl.w / 52));
      for (let k = 0; k < n; k++) g.door(wl.x + wl.w * (k + 0.5) / n - 7 + R.range(-6, 6), wl.y + wl.h - dh, 14, dh, { shut: R.range(0.5, 1), lit: R.chance(0.45) ? WARM : null, slats: '#555c68' });
      g.hazard(wl.x, wl.y + wl.h - 1.8, wl.w, 1.8, { a: '#8f7a34', b: '#17191e', step: 2.6 });
    },
    function arcade(g, B, R, wl, st) {
      const A = NT.Art, gf = Math.min(10, wl.h - 5);
      if (wl.h - gf >= 7) panes(g, wl, R, st, { pw: 3.8, ph: 3.2, gap: 2.6, gf: gf + 1.5, lit: 0.8 });
      const n = Math.max(1, Math.round(wl.w / 21)), bw = wl.w / n, y = wl.y + wl.h - gf;
      for (let k = 0; k < n; k++) {                   // shopfronts
        const x = wl.x + k * bw, open = R.chance(0.72), col = R.pick([WARM, WARM, '#ffd0a0', ICE]);
        if (open) g.windows(x + 2, y + 2.6, bw - 4, gf - 3.4, { cols: 2, rows: 1, gap: 1, lit: 1, col: col, seed: R.int(999), a: 0.42, blur: 2 });
        else g.door(x + 2, y + 2.6, bw - 4, gf - 2.6, { shut: 1, slats: '#4d4658' });
        g.rect(x + 1, y, bw - 2, 2.4, k % 2 ? '#6a6f7c' : '#c9c2b0', { lit: 0, bevel: 0.5, lw: 0.4 });
        if (open) g.pool(x + bw / 2, wl.y + wl.h + 3, bw * 0.7, 5, col, 0.22);
        if (open && wl.h - gf >= 12 && R.chance(0.5)) mark(g, R.int(99999), x + bw / 2 - 2.2, y - 6, 4.4, R.pick(NEON), 0.8);
      }
      g.neon([wl.x + 2, y - 0.6, wl.x + wl.w - 2, y - 0.6], A.mix(R.pick(NEON), '#ffffff', 0.15), { w: 0.6, r: 1.6, a: 0.5 });
    },
    function vault(g, B, R, wl, st) {
      if (wl.h >= 16) g.windows(wl.x + 5, wl.y + 5, wl.w - 10, wl.h - 14, { cols: Math.max(2, Math.round(wl.w / 7)), rows: Math.max(1, Math.round((wl.h - 14) / 5)), gap: 4.6, lit: st.lit, col: st.win, seed: R.int(999), a: 0.5, blur: 1.6, dark: '#11151b' });
      g.neon([wl.x + 3, wl.y + 2.2, wl.x + wl.w - 3, wl.y + 2.2], st.win[R.int(2)], { w: 0.6, r: 1.8, a: 0.55 });
      g.door(wl.x + wl.w * R.range(0.3, 0.7) - 6, wl.y + wl.h - 8, 12, 8, { shut: 1, slats: '#39404d' });
    },
  ];

  // rooftop props; s = slot { x, y, w, d } in plan coordinates of the roof they stand on
  const PROP = {
    ac: function (g, s, R) { const n = s.w > 24 && R.chance(0.6) ? 2 : 1; for (let k = 0; k < n; k++) g.ac(s.x + s.w / 2 - n * 5 + k * 10 + 1, s.y + s.d / 2 - 3, 8, 6); },
    vent: function (g, s, R) { g.vent(s.x + s.w / 2 - 5.5, s.y + s.d / 2 - 3.5, 11, 7, { v: R.chance(0.5) }); },
    cowl: function (g, s, R) { for (let k = 0; k < 2; k++) g.cyl(s.x + s.w / 2 - 4 + k * 8, s.y + s.d / 2 + R.range(-2, 2), 2.5, 3.5, '#7f8899', { cap: '#272c36' }); },
    stack: function (g, s, R) { g.stack(s.x + s.w / 2, s.y + s.d / 2 + 2, R.range(2.4, 3.4), R.range(6, 11)); },
    tank: function (g, s, R) {
      const x = s.x + s.w / 2, y = s.y + s.d / 2 + 4, wood = R.chance(0.5);
      for (const o of [-4.5, 4.5]) g.line(x + o, y + 2, x + o, y - 2, '#22262e', 1.2);
      g.at(4, function () { g.cyl(x, y, 6.5, 8, wood ? '#6f5b48' : '#7a8494', { cap: wood ? '#54432f' : '#5d6676', bands: 2 }); });
    },
    drum: function (g, s, R) { g.tank(s.x + s.w / 2 - 7, s.y + s.d / 2, s.x + s.w / 2 + 7, s.y + s.d / 2, 4, '#8591a3', { bands: 2, stripe: R.chance(0.4) ? '#5f6b7e' : null }); },
    skylight: function (g, s, R, st) {
      const w = Math.min(s.w - 6, 18), d = Math.min(s.d - 6, 11), x = s.x + (s.w - w) / 2, y = s.y + (s.d - d) / 2;
      if (w < 4 || d < 3) return;                       // slot too small for a skylight
      g.rect(x - 1.2, y - 1.2, w + 2.4, d + 2.4, '#1f242d', { lit: 0, bevel: 0.7, r: 0.6 });
      g.windows(x, y, w, d, { cols: 3, rows: 2, gap: 0.8, lit: 0.5, col: st.win, seed: R.int(999), a: 0.26, blur: 2 });
    },
    stair: function (g, s, R, st) {
      const b = g.box(s.x + s.w / 2 - 6.5, s.y + s.d / 2 - 4, 13, 9, 7, { roof: shade(st.roof, -0.12) });
      g.door(b.wall.x + 4, b.wall.y + 1.2, 5, 5.8, { lit: R.chance(0.5) ? WARM : null });
    },
    dish: function (g, s, R) { g.cyl(s.x + s.w / 2, s.y + s.d / 2 + 1, 1.6, 2.5, '#59616f'); g.at(3, function () { g.dish(s.x + s.w / 2, s.y + s.d / 2, R.range(4.2, 6), { ang: R.range(0, TAU) }); }); },
    mast: function (g, s, R, st, P) {
      const x = s.x + s.w / 2, y = s.y + s.d / 2, h = Math.min(R.range(13, 21), y + 14);
      g.mast(x, y, h, { bars: 2, barW: 6, col: '#8b96aa' });
      g.led(x, y - h, ICE, 0.8);
      if (P.beacons) P.beacons.push(x, y - h - P.z);
    },
    solar: function (g, s) {
      const n = Math.max(1, Math.floor((s.w - 4) / 9)), m = Math.max(1, Math.floor((s.d - 4) / 8));
      for (let j = 0; j < m; j++) for (let k = 0; k < n; k++) {
        const x = s.x + 2 + k * 9, y = s.y + 2 + j * 8;
        g.rect(x, y, 8, 6.5, '#1c2c48', { lit: 0.2, bevel: 0.6, lw: 0.5 }); g.panels(x, y, 8, 6.5, 2, 2, 'rgba(120,160,220,0.25)', 0.4);
      }
    },
    fan: function (g, s) {
      const x = s.x + s.w / 2, y = s.y + s.d / 2 + 1;
      g.cyl(x, y, 6.5, 2.5, '#5d6676', { cap: '#14171d' });
      if (g.vis()) { g.line(x - 3.4, y - 2.5, x + 3.4, y - 2.5, '#4a5261', 0.9); g.line(x, y - 5.9, x, y + 0.9, '#4a5261', 0.9); }
    },
    pipes: function (g, s) { g.pipe([s.x + 3, s.y + s.d / 2, s.x + s.w - 4, s.y + s.d / 2, s.x + s.w - 4, s.y + 3], 1.8, '#7b8496'); g.pipe([s.x + 3, s.y + s.d / 2 + 4, s.x + s.w * 0.5, s.y + s.d / 2 + 4], 1.6, '#69707f'); },
    garden: function (g, s, R) {
      const w = Math.min(s.w - 6, 18), d = Math.min(s.d - 6, 12), x = s.x + (s.w - w) / 2, y = s.y + (s.d - d) / 2;
      g.rect(x, y, w, d, '#24211c', { lit: 0, bevel: -0.7, r: 1 });
      for (let k = 0; k < 4; k++) g.circle(x + 3 + R.range(0, w - 6), y + 3 + R.range(0, d - 6), R.range(2, 3.4), R.chance(0.5) ? '#2c4a3d' : '#37584a', { lit: 0.25, lw: 0.4 });
    },
    tarp: function (g, s, R) { g.tarp(s.x + s.w / 2 - 7, s.y + s.d / 2 - 5, 14, 10, R.pick(['#46566a', '#5a5346', '#3f4c45']), { seed: R.int(99) }); },
    crates: function (g, s, R) { g.crate(s.x + s.w / 2 - 8, s.y + s.d / 2 - 2, 8, 6, 4, '#6d5238'); g.crate(s.x + s.w / 2 + 1, s.y + s.d / 2 - 3, 7, 7, 5, '#5a606c', { nx: 1 }); },
  };
  // [prop, weight, most per roof]
  const ROOFKIT = [
    [['ac', 5], ['vent', 2], ['cowl', 1.5], ['stair', 1.5, 1], ['skylight', 1], ['dish', 0.7, 1], ['mast', 0.8, 1], ['pipes', 0.8]],
    [['tank', 2.5, 2], ['skylight', 2], ['stack', 2], ['cowl', 1], ['garden', 1.5], ['tarp', 1.2], ['crates', 1], ['stair', 1.5, 1], ['ac', 1]],
    [['ac', 2], ['vent', 1], ['mast', 1, 1], ['dish', 1, 1], ['skylight', 1]],
    [['fan', 2.5], ['stack', 2.5], ['drum', 2], ['pipes', 2], ['vent', 2], ['crates', 1], ['ac', 1]],
    [['ac', 2.5], ['skylight', 2.5], ['tarp', 1.5], ['garden', 1.5], ['crates', 1], ['cowl', 1], ['stair', 1, 1]],
    [['fan', 3], ['solar', 3], ['dish', 1.5, 2], ['mast', 1.5, 2], ['pipes', 1.5], ['vent', 1]],
  ];
  const DENSITY = [0.5, 0.5, 0.22, 0.5, 0.42, 0.6];

  // fill a roof rect with props: jittered slots, weighted picks, drawn north to south so heights overlap right
  function furnish(g, P, x, y, w, d, style, density, skip) {
    const R = P.R, kitS = ROOFKIT[style], nx = Math.max(1, Math.floor(w / 28)), ny = Math.max(1, Math.floor(d / 24)), sw = w / nx, sd = d / ny, used = {};
    let total = 0;
    for (const k of kitS) total += k[1];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const s = { x: x + i * sw + R.range(-1.5, 1.5), y: y + j * sd + R.range(-1.5, 1.5), w: sw, d: sd }, roll = R.next(), pick = R.next() * total, sub = P.R.fork();
      let k = 0, acc = kitS[0][1];
      while (acc < pick && k < kitS.length - 1) acc += kitS[++k][1];
      const name = kitS[k][0];
      if (roll > density || (skip && s.x < skip.x + skip.w && skip.x < s.x + sw && s.y < skip.y + skip.d && skip.y < s.y + sd)) continue;
      if (kitS[k][2] && (used[name] || 0) >= kitS[k][2]) continue;
      used[name] = (used[name] || 0) + 1;
      PROP[name](g, s, sub, P.st, P);
    }
  }
  function helipad(g, x, y, r) {
    const A = NT.Art;
    g.circle(x, y, r, '#2b313c', { lit: 0, bevel: -0.6 });
    if (g.vis()) { g.stroke(A.P.circle(x, y, r - 2.5), 'rgba(217,244,255,0.5)', 1); g.lines([x - r * 0.4, y + r * 0.3, x, y - r * 0.42, x + r * 0.4, y + r * 0.3], 'rgba(217,244,255,0.6)', 1.6); g.line(x - r * 0.2, y + r * 0.05, x + r * 0.2, y + r * 0.05, 'rgba(217,244,255,0.6)', 1.4); }
    for (let k = 0; k < 4; k++) g.led(x + Math.cos(k * PI / 2 + PI / 4) * (r - 0.6), y + Math.sin(k * PI / 2 + PI / 4) * (r - 0.6), '#3df0a8', 0.7);
  }

  function tower(g, B) {
    const A = NT.Art, st = STYLES[B.style], R = new NT.Rng(B.seed), W = B.W, D = B.D, H = B.H, tint = R.range(-0.07, 0.07);
    const roof = A.shade(st.roof, tint), wall = A.shade(st.wall, tint), deck = A.shade(st.deck, tint);
    const P = { R: R, st: st, z: H, beacons: B.beacons ? null : [] }, big = Math.min(W, D) >= 120, gable = B.style === 3 && R.chance(0.55) && Math.max(W, D) <= 224;
    let wl;
    if (gable) {                                      // a shed under a ribbed pitched roof
      const rise = Math.min(9, H * 0.3), ridge = W >= D ? 'x' : 'y';
      g.gable(0, 0, W, D, H - rise, rise, { roof: roof, wall: wall, ridge: ridge, ribs: 4 });
      wl = { x: 0, y: D - H + rise, w: W, h: H - rise };
    } else wl = g.box(0, 0, W, D, H, { roof: roof, wall: wall, lip: 3, deck: deck }).wall;
    if (g.vis()) { g.ctx.fillStyle = 'rgba(0,0,0,0.3)'; g.ctx.fillRect(wl.x, wl.y, wl.w, 1.5); }
    FACADE[B.style](g, B, R, wl, st);
    g.at(H, function () {
      if (gable) {
        const n = Math.max(1, Math.floor(Math.max(W, D) / 56));
        for (let k = 0; k < n; k++) { const u = (k + 0.5) / n; if (W >= D) g.stack(W * u, D * 0.5 + 3, 3, 6); else g.stack(W * 0.5, D * u, 3, 6); }
        return;
      }
      let skip = null;
      // an upper tier: the tower steps back and goes on
      if ((B.style === 2 && Math.min(W, D) >= 96) || (big && R.chance(B.style === 3 ? 0.2 : 0.5))) {
        const h2 = R.irange(8, 13), tw = Math.round(W * R.range(0.42, 0.6)), td = Math.round((D - h2) * R.range(0.4, 0.58));
        const tx = Math.round(6 + R.next() * (W - tw - 12)), ty = Math.round(h2 + 2 + R.next() * (D - td - h2 - 9));
        skip = { x: tx - 3, y: ty - h2 - 3, w: tw + 6, d: td + h2 + 6 };
        furnish(g, P, 5, 5, W - 10, skip.y - 3, B.style, DENSITY[B.style], null);            // what stands north of the tier goes first
        const t = g.box(tx, ty, tw, td, h2, { roof: A.shade(roof, 0.05), wall: A.shade(wall, 0.06), lip: 2, deck: A.shade(deck, 0.04) });
        g.windows(t.wall.x + 2.5, t.wall.y + 2.5, tw - 5, h2 - 5, { cols: Math.max(2, Math.round(tw / 6)), rows: Math.max(1, Math.round((h2 - 5) / 4)), gap: 1.2, lit: st.lit * 1.2, col: st.win, seed: R.int(999), a: 0.3, blur: 1.5 });
        P.z = H + h2;
        g.at(h2, function () {
          if (B.style === 2 || B.style === 4) g.neon(A.P.rect(tx + 1.2, ty + 1.2, tw - 2.4, td - 2.4, 1), B.style === 2 ? '#8fb8ff' : R.pick(NEON), { w: 0.6, r: 2, a: 0.5 });
          if (Math.min(tw, td) >= 40 && R.chance(0.7)) helipad(g, tx + tw / 2, ty + td / 2, Math.min(tw, td) / 2 - 5);
          else furnish(g, P, tx + 4, ty + 4, tw - 8, td - 8, B.style === 4 ? 0 : B.style, 0.5, null);
        });
        P.z = H;
        furnish(g, P, 5, skip.y + skip.d, W - 10, D - 5 - skip.y - skip.d, B.style, DENSITY[B.style], null);
        furnish(g, P, 5, skip.y, tx - 8, skip.d, B.style, DENSITY[B.style], null);
        furnish(g, P, tx + tw + 3, skip.y, W - tx - tw - 8, skip.d, B.style, DENSITY[B.style], null);
        return;
      }
      if (B.style === 4 && W >= 64) {                 // the arcade's rooftop billboard
        const bw = Math.min(W - 16, R.range(34, 52)), bx = R.range(8, W - bw - 8), by = Math.min(D - 8, R.range(16, 26)), col = R.pick(NEON);
        skip = { x: bx - 2, y: by - 4, w: bw + 4, d: 8 };
        furnish(g, P, 5, 5, W - 10, D - 10, B.style, DENSITY[B.style], skip);
        const b = g.billboard(bx, by, bw, 11, { lift: 3, legs: 2 });
        signFace(g, b.x, b.y, b.w, b.h, R.int(99999), col);
        return;
      }
      if (B.style === 2 && Math.min(W, D) >= 56) { helipad(g, W / 2, D / 2, Math.min(W, D) / 2 - 9); return; }
      furnish(g, P, 5, 5, W - 10, D - 10, B.style, DENSITY[B.style], null);
    });
    if (B.style === 1 && Math.min(W, D) >= 90 && R.chance(0.5)) g.at(H, function () {      // a string of bulbs over a roof hangout
      g.string([8, D - 8, 0, W * 0.5, D - 14, 7, W - 8, D - 8, 0], { n: 5, cols: [WARM, '#ffd0a0'], r: 0.7, reach: 4 });
    });
    for (const s of B.signs) wallSign(g, B, s);
    if (P.beacons) B.beacons = P.beacons;
  }
  function paintBlock(c, res, B) {
    const g = kit(c, res, 'main');
    c.translate(B.x0, B.y0);
    if (g) return tower(g, B);
    c.fillStyle = shade(STYLES[B.style].wall, 0); c.fillRect(0, B.D - B.H, B.W, B.H);     // no art kit: a plain box
    c.fillStyle = STYLES[B.style].roof; c.fillRect(0, -B.H, B.W, B.D);
  }

  // ======================================================================================================
  // STANDING PROPS (low: under units) — one sprite per instance, its soft shadow baked in
  // ======================================================================================================
  const LOW = {
    wreck: function (g, d, R) {
      const k = d.scale || 1, kind = R.int(3), col = R.pick(['#3b302c', '#2f343d', '#3a3a34', '#40342e']);
      g.ellipse(1, 1.5, 15 * k, 9 * k, 'rgba(0,0,0,0.42)', { lit: 0, bevel: 0, ol: false, rot: d.rot });
      if (kind < 2) {
        g.car(0, 0, 25 * k, 11.5 * k, col, { rot: d.rot, glass: '#07090c', wheels: kind === 0 });
        g.push(0, 0, d.rot);
        g.poly([-4 * k, -5.2 * k, 3 * k, -5.2 * k, 1 * k, -1.5 * k, -5 * k, -2 * k], '#0b0c0f', { lit: 0, bevel: 0, ol: false, alpha: 0.75 });
        g.line(6 * k, -4 * k, 10 * k, 3 * k, 'rgba(0,0,0,0.5)', 1);
        g.pop();
      } else {                                        // stripped chassis
        g.push(0, 0, d.rot);
        g.rect(-11 * k, -4.6 * k, 22 * k, 9.2 * k, '#2a2c31', { r: 1.5, lit: 0.1 });
        g.rect(-8 * k, -3.2 * k, 6 * k, 6.4 * k, '#0b0c0f', { lit: 0, bevel: -0.6, ol: false }); g.rect(1 * k, -3.2 * k, 7 * k, 6.4 * k, '#111318', { lit: 0, bevel: -0.6, ol: false });
        g.tyre(13 * k, 6.5 * k, 2.6 * k);
        g.pop();
      }
    },
    dumpster: function (g, d, R) {
      const vert = Math.abs(Math.sin(d.rot)) > 0.5, k = d.scale || 1, w = (vert ? 10 : 18) * k, dd = (vert ? 17 : 10) * k, col = R.pick(['#31503f', '#3b4a66', '#5a4038', '#4a4f5a']);
      const b = g.box(-w / 2, -dd / 2, w, dd, 6, { roof: col });
      if (vert) g.line(b.x + w / 2, b.y + 0.8, b.x + w / 2, b.y + dd - 0.8, 'rgba(0,0,0,0.4)', 0.7); else g.line(b.x + 0.8, b.y + dd / 2, b.x + w - 0.8, b.y + dd / 2, 'rgba(0,0,0,0.4)', 0.7);
      g.circle(-w / 2 - 2.5, dd / 2 - 1, 2.6, '#16181d', { lit: 0.2 }); g.circle(w / 2 + 1.5, dd / 2 + 1, 2.2, '#1d2026', { lit: 0.2 });
    },
    barrier: function (g, d, R) {
      const vert = Math.abs(Math.sin(d.rot)) > 0.5, k = d.scale || 1, n = 2 + R.int(2);
      for (let i = 0; i < n; i++) {
        const o = (i - (n - 1) / 2) * 10.5 * k, w = (vert ? 4.6 : 9.6) * k, dd = (vert ? 9.6 : 4.6) * k, tilt = R.range(-1, 1);
        const b = g.box((vert ? tilt : o) - w / 2, (vert ? o : tilt) - dd / 2, w, dd, 4.5, { roof: '#8b9098', wall: '#5b6068' });
        if (g.vis() && !vert) g.hazard(b.wall.x + 1, b.wall.y + 1.4, w - 2, 1.8, { a: '#b39a45', b: '#22252b', step: 2 });
      }
    },
    crate: function (g, d, R) {
      const k = d.scale || 1, n = 1 + R.int(3);
      g.rect(-8 * k, -5 * k, 16 * k, 11 * k, '#3c3126', { lit: 0, bevel: 0.4, lw: 0.5 });      // pallet
      for (let i = 0; i < n; i++) {
        const x = (i - (n - 1) / 2) * 8.4 * k, col = R.pick(['#7a5638', '#6a6f7b', '#4f6654']);
        g.crate(x - 3.8 * k, -3 * k + R.range(-1, 1), 7.6 * k, 6.6 * k, 5, col, { strap: R.chance(0.4) ? 'rgba(0,0,0,0.3)' : null });
      }
      if (n > 1 && R.chance(0.5)) g.at(5, function () { g.crate(-3.6 * k, -3 * k, 7.2 * k, 6.2 * k, 4.5, '#6d5238'); });
    },
    planter: function (g, d, R) {
      const k = d.scale || 1, s = 17 * k;
      g.box(-s / 2, -s / 2, s, s, 3.5, { roof: '#5d6370', lip: 2, deck: '#1c2620' });
      if (R.chance(0.55)) {                            // a street tree
        g.at(3.5, function () { g.cyl(0, 0, 1.3, 7, '#3a2e26'); });
        g.at(10, function () {
          for (let i = 0; i < 6; i++) { const a = i * TAU / 6 + R.next(), r = R.range(3, 6) * k; g.circle(Math.cos(a) * r, Math.sin(a) * r * 0.8, R.range(4, 5.6) * k, i % 2 ? '#23483c' : '#2c5546', { lit: 0.3, lw: 0.5 }); }
          g.circle(-1.5, -1.5, 4.6 * k, '#35634f', { lit: 0.3, lw: 0.4 });
        });
      } else g.at(4, function () { for (let i = 0; i < 6; i++) g.circle(R.range(-5, 5) * k, R.range(-5, 5) * k, R.range(2.4, 3.8) * k, i % 2 ? '#2a4c3e' : '#356050', { lit: 0.3, lw: 0.4 }); });
    },
    sign: function (g, d) {                            // a sign that hangs on no tower stands on its own post
      g.mast(0, 0, 14, { col: '#6d7688' });
      const b = g.billboard(-9, 0, 18, 8, { lift: 12, legs: 0 });
      signFace(g, b.x, b.y, b.w, b.h, d.seed, NEON[d.seed % NEON.length]);
    },
  };
  function paintProp(c, res, it) {
    const d = it.d, fn = LOW[d.type];
    if (!kit(c, res, 'main')) { c.fillStyle = '#4a5261'; c.fillRect(-6, -6, 12, 9); c.fillStyle = '#2c323e'; c.fillRect(-6, 3, 12, 4); return; }
    fn(kit(c, res, 'shadow'), d, new NT.Rng(d.seed));
    c.globalCompositeOperation = 'destination-in'; c.fillStyle = 'rgba(0,0,0,0.36)'; c.fillRect(it.bx, it.by, it.bw, it.bh);
    c.globalCompositeOperation = 'source-over';
    fn(kit(c, res, 'main'), d, new NT.Rng(d.seed));
  }

  // lamp head: post, arm and lantern, one sprite per arm direction
  function paintLamp(c, res, it) {
    const ax = DX[it.dir] * LAMP_ARM, ay = DY[it.dir] * LAMP_ARM, h = LAMP_H;
    c.lineCap = 'round'; c.lineJoin = 'round';
    for (let k = 0; k < 2; k++) {
      c.strokeStyle = k ? '#7b8598' : '#0a0c11'; c.lineWidth = k ? 1.3 : 2.6;
      c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -h + 2); c.quadraticCurveTo(0, -h, ax * 0.3, ay * 0.3 - h); c.lineTo(ax, ay - h); c.stroke();
    }
    c.fillStyle = '#0a0c11'; c.beginPath(); c.ellipse(ax, ay - h, 4, 3, 0, 0, TAU); c.fill();
    c.fillStyle = '#566072'; c.beginPath(); c.ellipse(ax, ay - h, 3.1, 2.2, 0, 0, TAU); c.fill();
    c.fillStyle = '#ffeccb'; c.beginPath(); c.ellipse(ax, ay - h + 0.3, 2, 1.4, 0, 0, TAU); c.fill();
    c.fillStyle = '#ffffff'; c.beginPath(); c.ellipse(ax, ay - h + 0.3, 1, 0.7, 0, 0, TAU); c.fill();
  }
  const LAMPS = [0, 1, 2, 3].map(function (dir) { return { dir: dir, bx: -18, by: -34, bw: 36, bh: 38, paint: paintLamp, spr: [] }; });

  // ======================================================================================================
  // GLINT: heaps of glittering rare-metal scrap. 6 looks (0 = picked clean, 1-5 = fill) x 4 variants.
  // ======================================================================================================
  function paintHeap(c, res, it) {
    const lvl = it.lvl, R = new NT.Rng(NT.hash32('glint', lvl, it.v)), n = [5, 6, 10, 15, 21, 28][lvl], spread = [11, 9, 11, 13, 14.5, 16][lvl], pile = [0, 0, 1.5, 3.5, 6, 8.5][lvl];
    if (lvl) {
      const g = c.createRadialGradient(0, 2, 2, 0, 2, spread + 6);
      g.addColorStop(0, 'rgba(2,10,14,0.6)'); g.addColorStop(0.7, 'rgba(2,10,14,0.35)'); g.addColorStop(1, 'rgba(2,10,14,0)');
      c.fillStyle = g; c.fillRect(-24, -24, 48, 48);
    }
    const bits = [];
    for (let k = 0; k < n; k++) {
      const a = R.range(0, TAU), u = Math.sqrt(R.next()), r = u * spread;
      bits.push({ x: Math.cos(a) * r, y: Math.sin(a) * r * 0.78, up: (1 - u) * pile, s: (lvl ? R.range(2.2, 4.2) + (1 - u) * lvl * 0.34 : R.range(0.8, 1.6)), a: R.range(0, TAU), m: 3 + R.int(3), tone: R.next(), dark: R.chance(lvl ? 0.16 : 0.5) });
    }
    bits.sort(function (p, q) { return p.y - q.y; });
    for (const b of bits) {
      const pts = [], y = b.y - b.up;
      for (let j = 0; j < b.m; j++) { const a = b.a + j * TAU / b.m + R.range(-0.35, 0.35), rr = b.s * R.range(0.65, 1.1); pts.push(b.x + Math.cos(a) * rr, y + Math.sin(a) * rr); }
      const path = function (ox, oy) { c.beginPath(); c.moveTo(pts[0] + ox, pts[1] + oy); for (let j = 2; j < pts.length; j += 2) c.lineTo(pts[j] + ox, pts[j + 1] + oy); c.closePath(); };
      if (!lvl) { c.fillStyle = b.dark ? 'rgba(10,22,26,0.7)' : 'rgba(124,201,200,0.5)'; path(0, 0); c.fill(); continue; }
      c.fillStyle = 'rgba(1,8,11,0.6)'; path(0.9, 1.3); c.fill();
      const base = b.dark ? '#27343b' : GLINT[Math.min(4, 1 + Math.floor(b.tone * 2.4 + (b.up / 9) * 1.4))];
      c.fillStyle = base; path(0, 0); c.fill();
      c.save(); c.clip();
      c.fillStyle = b.dark ? 'rgba(180,239,230,0.25)' : 'rgba(255,255,255,0.55)';
      c.beginPath(); c.moveTo(b.x - b.s * 1.2, y - b.s * 1.2); c.lineTo(b.x + b.s * 0.5, y - b.s * 1.2); c.lineTo(b.x - b.s * 1.2, y + b.s * 0.5); c.fill();
      c.fillStyle = 'rgba(3,22,28,0.32)';
      c.beginPath(); c.moveTo(b.x + b.s * 1.2, y + b.s * 1.2); c.lineTo(b.x - b.s * 0.2, y + b.s * 1.2); c.lineTo(b.x + b.s * 1.2, y - b.s * 0.2); c.fill();
      c.restore();
      c.strokeStyle = 'rgba(2,16,20,0.7)'; c.lineWidth = 0.5; path(0, 0); c.stroke();
    }
    if (!lvl) return;
    c.fillStyle = '#ffffff';                           // hard sparkles
    for (let k = 0; k < 1 + lvl; k++) {
      const b = bits[R.int(bits.length)], y = b.y - b.up, s = R.range(1.3, 2.3);
      c.beginPath(); c.moveTo(b.x - s, y); c.lineTo(b.x, y - 0.35); c.lineTo(b.x + s, y); c.lineTo(b.x, y + 0.35); c.fill();
      c.beginPath(); c.moveTo(b.x, y - s); c.lineTo(b.x + 0.35, y); c.lineTo(b.x, y + s); c.lineTo(b.x - 0.35, y); c.fill();
    }
  }
  const HEAPS = [];
  for (let lvl = 0; lvl < 6; lvl++) for (let v = 0; v < 4; v++) HEAPS.push({ lvl: lvl, v: v, bx: -24, by: -27, bw: 48, bh: 50, paint: paintHeap, spr: [] });
  function fill(res, cap) { return res <= 0 ? 0 : Math.min(5, Math.ceil(res / Math.max(cap, res) * 5)); }

  // small shared light sprites
  const GLOW = {};
  function dot(col) {
    let cv = GLOW[col];
    if (cv) return cv;
    cv = GLOW[col] = mk(64, 64);
    const c = cv.getContext('2d'), g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, rgba(col, 1)); g.addColorStop(0.35, rgba(col, 0.42)); g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g; c.fillRect(0, 0, 64, 64);
    return cv;
  }
  function star() {
    let cv = GLOW.star;
    if (cv) return cv;
    cv = GLOW.star = mk(64, 64);
    const c = cv.getContext('2d');
    c.translate(32, 32);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 13);
    g.addColorStop(0, 'rgba(210,255,246,0.9)'); g.addColorStop(1, 'rgba(120,240,225,0)');
    c.fillStyle = g; c.fillRect(-13, -13, 26, 26);
    for (let k = 0; k < 2; k++) {
      const l = c.createLinearGradient(-31, 0, 31, 0);
      l.addColorStop(0, 'rgba(160,255,240,0)'); l.addColorStop(0.5, 'rgba(255,255,255,1)'); l.addColorStop(1, 'rgba(160,255,240,0)');
      c.fillStyle = l; c.beginPath(); c.moveTo(-31, 0); c.lineTo(0, -2.2); c.lineTo(31, 0); c.lineTo(0, 2.2); c.fill();
      c.rotate(PI / 2);
    }
    return cv;
  }
  function streak(col) {
    const key = 's' + col;
    let cv = GLOW[key];
    if (cv) return cv;
    cv = GLOW[key] = mk(16, 64);
    const c = cv.getContext('2d'), g = c.createRadialGradient(0, 0, 0, 0, 0, 8);
    g.addColorStop(0, rgba(col, 1)); g.addColorStop(1, rgba(col, 0));
    c.translate(8, 32); c.scale(1, 4); c.fillStyle = g; c.fillRect(-8, -8, 16, 16);
    return cv;
  }

  // ======================================================================================================
  // BUILD: index the map
  // ======================================================================================================
  function mkBlock(b) {
    const B = { x0: b.x * TILE, y0: b.y * TILE, W: b.w * TILE, D: b.h * TILE, H: NT.clamp(b.height || 20, 10, 48), style: ((b.style | 0) % 6 + 6) % 6,
      seed: NT.hash32(S.map.seed, 'block', b.x, b.y), spr: [], paint: paintBlock, signs: [], beacons: null };
    B.bx = B.x0 - 16; B.by = B.y0 - B.H - 20; B.bw = B.W + 32; B.bh = B.D + B.H + 24;
    B.y = B.y0 + B.D;
    B.item = { y: B.y, draw: function (ctx) { const m = ctx.getTransform(); ctx.setTransform(1, 0, 0, 1, 0, 0); put(ctx, m, B, 0, 0); ctx.setTransform(m); } };
    return B;
  }
  // BLOCK cells that no map.blocks entry covers (hand-made ASCII maps) are merged into towers of their own
  function looseBlocks(map) {
    const w = map.w, h = map.h, done = new Uint8Array(w * h), out = [];
    for (const b of map.blocks) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (x >= 0 && y >= 0 && x < w && y < h) done[y * w + x] = 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (done[y * w + x] || map.terrain[y * w + x] !== BLOCK) continue;
      let bw = 0, bh = 1;
      while (bw < 8 && x + bw < w && !done[y * w + x + bw] && map.terrain[y * w + x + bw] === BLOCK) bw++;
      for (; bh < 8 && y + bh < h; bh++) { let ok = true; for (let k = 0; k < bw && ok; k++) ok = !done[(y + bh) * w + x + k] && map.terrain[(y + bh) * w + x + k] === BLOCK; if (!ok) break; }
      for (let j = 0; j < bh; j++) for (let k = 0; k < bw; k++) done[(y + j) * w + x + k] = 1;
      out.push({ x: x, y: y, w: bw, h: bh, style: Math.floor(ih(x + S.salt, y) * 6), height: 14 + Math.round(ih(y + S.salt, x) * 22) });
    }
    return out;
  }
  function indexRoads(map) {
    const w = map.w, h = map.h, ter = map.terrain, hl = new Uint8Array(w * h), vl = new Uint8Array(w * h), rc = S.rc = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w;) {
      if (ter[y * w + x] !== ROAD) { x++; continue; }
      let e = x; while (e < w && ter[y * w + e] === ROAD) e++;
      for (let k = x; k < e; k++) hl[y * w + k] = Math.min(255, e - x);
      x = e;
    }
    for (let x = 0; x < w; x++) for (let y = 0; y < h;) {
      if (ter[y * w + x] !== ROAD) { y++; continue; }
      let e = y; while (e < h && ter[e * w + x] === ROAD) e++;
      for (let k = y; k < e; k++) vl[k * w + x] = Math.min(255, e - y);
      y = e;
    }
    // 1 = street running east-west, 2 = north-south, 3 = crossing, 4 = a patch of asphalt
    for (let i = 0; i < w * h; i++) if (ter[i] === ROAD) rc[i] = hl[i] >= 4 && vl[i] >= 4 ? 3 : hl[i] >= 4 ? 1 : vl[i] >= 4 ? 2 : 4;
  }
  // Decks: ground that lies in line with the canal between two stretches of water (bridges, the plaza deck).
  function indexWater(map) {
    const w = map.w, h = map.h, ter = map.terrain, deck = S.deck = new Uint8Array(w * h), SPAN = 26;
    const scan = function (len, at) {
      let last = -1;
      for (let k = 0; k < len; k++) {
        if (ter[at(k)] !== WATER) continue;
        if (last >= 0 && k - last > 1 && k - last <= SPAN) for (let j = last + 1; j < k; j++) if (ter[at(j)] !== BLOCK) deck[at(j)] = 1;
        last = k;
      }
    };
    for (let y = 0; y < h; y++) scan(w, function (k) { return y * w + k; });
    for (let x = 0; x < w; x++) scan(h, function (k) { return k * w + x; });
    // open water as rects (row runs, merged downward) for the ripples
    const runs = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w;) {
      if (ter[y * w + x] !== WATER) { x++; continue; }
      let e = x; while (e < w && ter[y * w + e] === WATER) e++;
      const up = runs.find(function (r) { return r.cx === x && r.cw === e - x && r.cy + r.ch === y; });
      if (up) up.ch++; else runs.push({ cx: x, cy: y, cw: e - x, ch: 1 });
      x = e;
    }
    S.water = runs.map(function (r) {
      const quay = r.cy > 0 && ter[(r.cy - 1) * w + r.cx] !== WATER ? 9.4 : 0, o = { x: r.cx * TILE, y: r.cy * TILE + quay, w: r.cw * TILE, h: r.ch * TILE - quay, glints: [] };
      const n = Math.round(o.w * o.h / 2600);
      for (let k = 0; k < n; k++) o.glints.push({ x: o.x + 4 + ih(r.cx * 31 + k, r.cy + S.salt) * (o.w - 8), y: o.y + 14 + ih(r.cy * 17 + k, r.cx + S.salt + 5) * Math.max(1, o.h - 30), col: k % 3 ? NEON[(k * 7 + r.cx) % NEON.length] : WARM, ph: ih(k, r.cx + r.cy * 57) * TAU });
      return o;
    });
  }
  function indexDeco(map) {
    const w = map.w, h = map.h;
    S.flat = []; S.lows = []; S.lamps = []; S.vents = []; S.xwalk = new Uint8Array(w * h);
    const under = function (x, y) {                   // behind a roof: inside the drawn rect of a tower, north of its wall foot
      for (const B of S.blocks) if (x > B.x0 - 2 && x < B.x0 + B.W + 2 && y > B.y0 - B.H - 2 && y < B.y0 + B.D) return true;
      return false;
    };
    for (const d of map.deco || []) {
      const t = d.type;
      if (t === 'lamp') {
        const dir = Math.round(d.rot / (PI / 2)) & 3, L = { x: d.x, y: d.y, dir: dir, px: d.x + DX[dir] * LAMP_ARM, py: d.y + DY[dir] * LAMP_ARM, seed: d.seed };
        L.hx = L.px; L.hy = L.py - LAMP_H;
        L.hidden = under(L.hx, L.hy) || under(d.x, d.y - 4);
        L.live = !L.hidden && ih(d.seed, 77) < 0.12 && !S.blocks.some(function (B) { return L.px + 70 > B.x0 && L.px - 70 < B.x0 + B.W && L.py + 70 > B.y0 - B.H && L.py - 70 < B.y0 + B.D; });
        S.lamps.push(L);
        if (!under(d.x, d.y)) S.flat.push(d);
      } else if (t === 'sign') {
        const side = Math.round(d.rot / (PI / 2)) & 3;
        const B = S.blocks.find(function (B) {
          return side === 0 ? Math.abs(d.x - B.x0 - B.W) < 3 && d.y >= B.y0 && d.y <= B.y0 + B.D : side === 2 ? Math.abs(d.x - B.x0) < 3 && d.y >= B.y0 && d.y <= B.y0 + B.D :
            side === 1 ? Math.abs(d.y - B.y0 - B.D) < 3 && d.x >= B.x0 && d.x <= B.x0 + B.W : Math.abs(d.y - B.y0) < 3 && d.x >= B.x0 && d.x <= B.x0 + B.W;
        });
        if (B) B.signs.push(d); else S.lows.push({ d: d, x: d.x, y: d.y, bx: -14, by: -26, bw: 28, bh: 30, paint: paintProp, spr: [] });
      } else if (t === 'crosswalk') {
        const vert = Math.abs(Math.sin(d.rot)) > 0.5, cx = Math.floor(d.x / TILE), cy = Math.floor(d.y / TILE), half = Math.ceil(d.scale || 1);
        for (let k = -half; k < half; k++) { const x = vert ? Math.floor(d.x / TILE + k + 0.5) : cx, y = vert ? cy : Math.floor(d.y / TILE + k + 0.5); if (x >= 0 && y >= 0 && x < w && y < h) S.xwalk[y * w + x] = 1; }
        S.flat.push(d);
      } else if (t === 'vent') {
        if (!under(d.x, d.y)) { S.flat.push(d); S.vents.push({ x: d.x, y: d.y, ph: ih(d.seed, 5), high: !under(d.x, d.y - 14) }); }
      } else if (FLAT[t]) { if (!under(d.x, d.y)) S.flat.push(d); }
      else if (LOW[t]) { if (!under(d.x, d.y + 4)) S.lows.push({ d: d, x: d.x, y: d.y, bx: -24, by: -30, bw: 50, bh: 54, paint: paintProp, spr: [] }); }
    }
    S.lows.sort(function (a, b) { return a.y - b.y; });
  }

  T.build = function (map) {
    if (!map || (S && S.map === map)) return;
    clearCache();
    S = { map: map, w: map.w, h: map.h, salt: (map.seed >>> 0) % 100003, first: true };
    S.blocks = (map.blocks || []).concat(looseBlocks(map)).map(mkBlock).sort(function (a, b) { return a.y - b.y || a.x0 - b.x0; });
    indexRoads(map); indexWater(map); indexDeco(map);
    bakeBase();
  };
  function bakeBase() {
    const n = CELLS[0];
    for (let layer = 0; layer < 3; layer++) for (let cy = 0; cy * n < S.h; cy++) for (let cx = 0; cx * n < S.w; cx++) chunk(layer, 0, cx, cy, true);
  }
  T.clear = function () {
    clearCache();
    TILES.clear();
    if (!S) return;
    S.first = true;
    bakeBase();
  };

  // ======================================================================================================
  // FRAME
  // ======================================================================================================
  T.drawGround = function (ctx, view) {
    if (!S) return;
    F.n++; F.spent = 0; T.stats.pending = 0;
    F.fresh = S.first; S.first = false;
    F.b = T.stats.bucket = bucketFor(view);
    drawLayer(ctx, view, GROUND, F.b);
    if (S.water.length) ripples(ctx, view);
  };
  function ripples(ctx, view) {
    const t = view.t || 0, res = T.LADDER[F.b], pat = grain(ctx, 'ripple', res);
    ctx.save();
    for (const r of S.water) {
      if (r.x > view.x1 || r.y > view.y1 || r.x + r.w < view.x0 || r.y + r.h < view.y0) continue;
      const x0 = Math.max(r.x, view.x0), x1 = Math.min(r.x + r.w, view.x1);
      ctx.fillStyle = pat;
      for (let k = 0; k < 2; k++) {
        const ox = (k ? -t * 5 : t * 8) % PATW, oy = k ? 37 + Math.sin(t * 0.5) * 3 : Math.sin(t * 0.7 + 1) * 2;
        ctx.globalAlpha = 0.55 + 0.25 * Math.sin(t * 0.9 + k * 2);
        ctx.translate(ox, oy); ctx.fillRect(x0 - ox, r.y - oy, x1 - x0, r.h); ctx.translate(-ox, -oy);
      }
    }
    ctx.restore();
  }
  T.shadowsFor = function (ctx, view) { if (S) drawLayer(ctx, view, SHADE, F.b); };

  T.drawResources = function (ctx, view, map) {
    if (map && (!S || S.map !== map)) T.build(map);
    if (!S) return;
    const m = ctx.getTransform(), mp = S.map, w = S.w, res = mp.res, cap = mp.resCap;
    const x0 = Math.max(0, Math.floor((view.x0 - 24) / TILE)), y0 = Math.max(0, Math.floor((view.y0 - 24) / TILE));
    const x1 = Math.min(w, Math.ceil((view.x1 + 24) / TILE)), y1 = Math.min(S.h, Math.ceil((view.y1 + 27) / TILE));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * w + x;
      if (!cap[i] && !res[i]) continue;
      put(ctx, m, HEAPS[fill(res[i], cap[i]) * 4 + ((ih(x + S.salt, y) * 4) | 0)], (x + 0.5) * TILE, (y + 0.5) * TILE);
    }
    ctx.setTransform(m);
  };

  T.drawPropsLow = function (ctx, view) {
    if (!S) return;
    const m = ctx.getTransform();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const p of S.lows) if (near(p.x, p.y, 30, view)) put(ctx, m, p, p.x, p.y);
    ctx.setTransform(m);
    steam(ctx, view, false);
  };

  T.blocks = function (view) {
    const out = [];
    if (S) for (const B of S.blocks) if (seen(B, view)) out.push(B.item);
    return out;
  };

  T.drawPropsHigh = function (ctx, view) {
    if (!S) return;
    const m = ctx.getTransform();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const L of S.lamps) if (!L.hidden && near(L.x, L.y, 36, view)) put(ctx, m, LAMPS[L.dir], L.x, L.y);
    ctx.setTransform(m);
    steam(ctx, view, true);
  };
  // steam off the street vents: over units where nothing hides it, else under them
  function steam(ctx, view, high) {
    const t = view.t || 0, cv = dot('#cfd8e6'), ga = ctx.globalAlpha;
    for (const v of S.vents) {
      if (v.high !== high || !near(v.x, v.y, 40, view)) continue;
      for (let k = 0; k < 5; k++) {
        const u = (t * 0.32 + k / 5 + v.ph) % 1, r = 4 + u * 9, x = v.x + Math.sin(u * 5 + k * 1.7 + v.ph * 9) * 4 * u, y = v.y - u * 24;
        ctx.globalAlpha = ga * 0.24 * (1 - u) * Math.min(1, u * 7);
        ctx.drawImage(cv, x - r, y - r, 2 * r, 2 * r);
      }
    }
    ctx.globalAlpha = ga;
  }

  T.drawLights = function (ctx, view) {
    if (!S) return;
    const t = view.t || 0, ga = ctx.globalAlpha, mp = S.map, w = S.w;
    drawLayer(ctx, view, LIGHT, F.b);
    // lamps on their last legs
    const lamp = dot(WARM);
    for (const L of S.lamps) {
      if (!L.live || !near(L.px, L.py, 90, view)) continue;
      const k = Math.floor(t * 11 + L.seed % 7), f = ih(k, L.seed) < 0.16 ? 0.25 + ih(k, 3) * 0.4 : 1;
      ctx.globalAlpha = ga * 0.34 * f; ctx.drawImage(lamp, L.px - 80, L.py - 80, 160, 160);
      ctx.globalAlpha = ga * 0.7 * f; ctx.drawImage(lamp, L.hx - 9, L.hy - 9, 18, 18);
    }
    // neon and lamp light lying on the canal
    for (const r of S.water) {
      if (r.x > view.x1 || r.y > view.y1 || r.x + r.w < view.x0 || r.y + r.h < view.y0) continue;
      for (const g of r.glints) {
        if (g.x < view.x0 - 8 || g.x > view.x1 + 8) continue;
        ctx.globalAlpha = ga * (0.16 + 0.1 * Math.sin(t * 1.7 + g.ph));
        ctx.drawImage(streak(g.col), g.x - 4 + Math.sin(t * 1.1 + g.ph) * 1.6, g.y - 15, 8, 30);
      }
    }
    // roof beacons
    const ice = dot(ICE);
    for (const B of S.blocks) {
      if (!B.beacons || !B.beacons.length || !seen(B, view)) continue;
      for (let k = 0; k < B.beacons.length; k += 2) {
        const u = (t * 0.6 + ih(B.seed, k)) % 1;
        if (u > 0.16) continue;
        ctx.globalAlpha = ga * Math.sin(u / 0.16 * PI);
        ctx.drawImage(ice, B.x0 + B.beacons[k] - 7, B.y0 + B.beacons[k + 1] - 7, 14, 14);
      }
    }
    // Glint: a cool glow under every heap and glints that come and go
    const x0 = Math.max(0, Math.floor((view.x0 - 30) / TILE)), y0 = Math.max(0, Math.floor((view.y0 - 30) / TILE));
    const x1 = Math.min(w, Math.ceil((view.x1 + 30) / TILE)), y1 = Math.min(S.h, Math.ceil((view.y1 + 30) / TILE)), glow = dot('#7ff0e0'), st = star();
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * w + x, lvl = mp.res[i] ? fill(mp.res[i], mp.resCap[i]) : 0;
      if (!lvl) continue;
      const X = (x + 0.5) * TILE, Y = (y + 0.5) * TILE;
      ctx.globalAlpha = ga * (0.1 + lvl * 0.035); ctx.drawImage(glow, X - 27, Y - 28, 54, 54);
      for (let k = 0; k < 2; k++) {
        const ph = ih(x * 7 + k, y * 13 + S.salt), u = (t * (0.34 + ph * 0.3) + ph * 9) % 1;
        if (u > 0.3) continue;
        const cyc = Math.floor(t * (0.34 + ph * 0.3) + ph * 9), s = (4 + lvl * 1.3) * Math.sin(u / 0.3 * PI) * (0.7 + ih(cyc, i) * 0.6);
        const px = X + (ih(cyc + k * 31, i) - 0.5) * (12 + lvl * 3), py = Y + (ih(cyc + k * 57, i + 9) - 0.5) * (10 + lvl * 2) - lvl;
        ctx.globalAlpha = ga * 0.95; ctx.drawImage(st, px - s, py - s, 2 * s, 2 * s);
      }
    }
    ctx.globalAlpha = ga;
  };

  // --- minimap ----------------------------------------------------------------------------------------------
  const MINIS = new WeakMap();
  T.minimap = function (map) {
    let cv = MINIS.get(map);
    if (cv) return cv;
    cv = mk(map.w, map.h);
    const c = cv.getContext('2d'), img = c.createImageData(map.w, map.h), d = img.data, n = map.w * map.h, pal = MINI.map(rgb);
    for (let i = 0; i < n; i++) {
      const p = pal[map.resCap[i] ? 6 : map.terrain[i]] || pal[0], k = ((i % map.w) + ((i / map.w) | 0)) & 1 ? 0 : 3;
      d[i * 4] = p[0] + k; d[i * 4 + 1] = p[1] + k; d[i * 4 + 2] = p[2] + k; d[i * 4 + 3] = 255;
    }
    c.putImageData(img, 0, 0);
    MINIS.set(map, cv);
    return cv;
  };

  if (NT.on) NT.on('game:start', function (world) { if (world && world.map) T.build(world.map); });
})();
