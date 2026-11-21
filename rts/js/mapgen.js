'use strict';
// ============================================================================
// NEON TURF — mapgen.js  (HEADLESS-SAFE, DETERMINISTIC)
// Procedural 2-player city maps. Every random choice comes from an NT.Rng
// seeded by opts.seed (never Math.random / Date), so a seed IS a map.
//
//   NT.MapGen.SIZES                                   { small, medium, large } -> cells per side
//   NT.MapGen.generate({ seed, size, players: 2 })    -> map (NT.Map.create + NT.Map.finalize)
//   NT.MAPS                                           menu presets [{ id, name, desc, size, seed, players }]
//   NT.MapGen.fromPreset(id)                          -> map, map.name = id
//   NT.MapGen.ascii(map)                              -> debug dump (fromAscii legend + 'T' turf, '1'/'2' starts)
//
// HOW A MAP IS MADE
//   1. PLAN in a canonical frame: player 1 owns the top half, the SEAM between
//      the halves is a horizontal avenue (or a canal with quays and two
//      bridges) through the centre. A per-seed transpose / flip of the finished
//      plan gives diagonal, left-right and top-bottom base placements.
//   2. STREETS: the top half is cut recursively (3-wide avenues first, 2-wide
//      streets below) into lots of 3-8 cells per side. Streets that would meet
//      a cross street a cell or two apart are lined up into square crossings.
//   3. ZONES are laid over the grid and keep towers out: the start yard, the
//      home field, the expansion pad and the central plaza. What a zone leaves
//      of a lot is still a lot; what it leaves of a street, if less than 2
//      cells wide, becomes pavement.
//   4. TURF goes into free lots; the other lots become towers, plazas, car
//      parks or rubble by district (towers close in around the plaza, fields
//      and yards keep clean edges) until the mid-map is about 30% BLOCK.
//   5. VALIDATE: symmetry, yard, turf rings, 2-wide passages, BLOCK share,
//      three separated routes. A layout that fails is rebuilt from a seed
//      derived from (seed, attempt), so the result for a given seed never changes.
//
// SYMMETRY: paint() / setRes() write a cell AND its 180-degree mirror
// (index n-1-i), and every list entry is pushed together with its mirror, so
// the map is symmetric by construction — never write terrain any other way
// (trimRoads() is the one exception: a local rule maps a symmetric map onto a
// symmetric map).
// ============================================================================
(function () {
  const T = NT.TERRAIN;
  const G = NT.MapGen = {};

  G.SIZES = { small: 64, medium: 80, large: 96 };

  const HQ = 3;                       // start yards assume an HQ footprint of at most HQ x HQ cells
  const MIN_LOT = 3, MAX_LOT = 8;     // tower blocks are 3-8 cells per side
  const HQ_CLEAR = 12;                // turf stays this far from every HQ; farther than this from both = "mid-map"
  const BLOCK_LO = 0.2, BLOCK_HI = 0.35, BLOCK_AIM = [0.27, 0.33];     // BLOCK share of the mid-map: hard limits, target
  const RUBBLE_MAX = 0.06;            // most of the mid-map that may lie in ruins
  const MIN_ROAD = 16;                // cells: a detached piece of road smaller than this is paved over
  const FIELD_CLEAR = 3;              // lots this close to a field are never car parks or ruins (nor ruins this close to a yard)
  const EDGE = 5;                     // a strip narrower than this between a yard and the map edge joins the yard
  const TURF_GAP = 6;                 // cells between two turf structures
  const ROUTE_GAP = 2;                // paths kept more than this apart can never share a 3x3 patch
  const CREDITS = { home: 700, expansion: 700, central: 900 };
  const RATE = { home: 3, expansion: 3, central: 6 };                  // regrow, credits/sec for the whole field
  const TRIES = 40, STRICT_TRIES = 28;                                 // later tries accept a map short of turf

  // corner: chance of diagonal bases · yard / slack: rng.int(n) extra cells of yard / of HQ setback and (x2) of
  // plaza, so 1 = none: a small map has no row to spare between yard and plaza, each one is needed for towers ·
  // home/exp/central: field cells · turf: structures per side · districts: district centres per half · deco: items
  const PARAMS = {
    small:  { corner: 0.7,  yard: 1, slack: 1, home: [14, 16], exp: [10, 11], central: [18, 20], turf: [3, 4], districts: 3, deco: 190 },
    medium: { corner: 0.5,  yard: 2, slack: 2, home: [16, 18], exp: [11, 12], central: [20, 24], turf: [4, 5], districts: 4, deco: 280 },
    large:  { corner: 0.45, yard: 2, slack: 2, home: [17, 18], exp: [12, 12], central: [22, 24], turf: [5, 5], districts: 5, deco: 370 },
  };

  // Districts give the city its grain: every lot takes its odds from the nearest district
  // centre. odds = [tower, plaza, parking] (rubble = the rest); lift raises the skyline.
  const DISTRICTS = [
    { odds: [0.88, 0.06, 0.04], lift: 0.3 },      // core: wall-to-wall towers
    { odds: [0.68, 0.14, 0.12], lift: 0.05 },     // mixed blocks
    { odds: [0.68, 0.12, 0.12], lift: 0 },
    { odds: [0.5, 0.26, 0.2], lift: -0.05 },      // market: squares and car parks
    { odds: [0.42, 0.08, 0.1], lift: -0.25 },     // ruins: rubble fields
  ];

  // --- rects ({x, y, w, h} in cells) ---------------------------------------------------
  const R = function (x, y, w, h) { return { x: x, y: y, w: w, h: h }; };
  const grow = function (r, k) { return R(r.x - k, r.y - k, r.w + 2 * k, r.h + 2 * k); };
  const hits = function (a, b) { return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h; };
  const inside = function (r, x0, y0, x1, y1) { return r.x >= x0 && r.y >= y0 && r.x + r.w <= x1 && r.y + r.h <= y1; };
  const has = function (r, x, y) { return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h; };
  // Chebyshev distance between the nearest cells of two rects (touching = 1, overlapping = 0)
  const gap = function (a, b) {
    return Math.max(0, a.x - (b.x + b.w - 1), b.x - (a.x + a.w - 1), a.y - (b.y + b.h - 1), b.y - (a.y + a.h - 1));
  };
  // The parts of r that stay clear of z and are still MIN_LOT thick. What z leaves of r is cut into
  // rects two ways (full-height side strips first, or full-width ones): the way that keeps more ground wins.
  function clipAway(r, z) {
    if (!hits(r, z)) return [r];
    const x0 = Math.max(r.x, z.x), x1 = Math.min(r.x + r.w, z.x + z.w), y0 = Math.max(r.y, z.y), y1 = Math.min(r.y + r.h, z.y + z.h);
    const ways = [
      [R(r.x, r.y, x0 - r.x, r.h), R(x1, r.y, r.x + r.w - x1, r.h), R(x0, r.y, x1 - x0, y0 - r.y), R(x0, y1, x1 - x0, r.y + r.h - y1)],
      [R(r.x, r.y, r.w, y0 - r.y), R(r.x, y1, r.w, r.y + r.h - y1), R(r.x, y0, x0 - r.x, y1 - y0), R(x1, y0, r.x + r.w - x1, y1 - y0)],
    ].map(function (parts) { return parts.filter(function (p) { return p.w >= MIN_LOT && p.h >= MIN_LOT; }); });
    const area = function (parts) { return parts.reduce(function (a, p) { return a + p.w * p.h; }, 0); };
    return area(ways[1]) > area(ways[0]) ? ways[1] : ways[0];
  }
  const mirror = function (c, r) { return R(c.w - r.x - r.w, c.h - r.y - r.h, r.w, r.h); };
  // canonical frame -> map frame (maps are square, so a transpose keeps the size)
  function real(c, r) {
    let x = r.x, y = r.y, w = r.w, h = r.h;
    if (c.transpose) { x = r.y; y = r.x; w = r.h; h = r.w; }
    if (c.flip) x = c.w - x - w;
    return R(x, y, w, h);
  }
  function eachCell(c, r, fn) {       // cells of r that are on the map
    const x1 = Math.min(c.w, r.x + r.w), y1 = Math.min(c.h, r.y + r.h);
    for (let y = Math.max(0, r.y); y < y1; y++) for (let x = Math.max(0, r.x); x < x1; x++) fn(y * c.w + x, x, y);
  }
  // distance from cell (x, y) to a rect: [Chebyshev, Euclidean]
  function cellDist(r, x, y) {
    const dx = Math.max(0, r.x - x, x - (r.x + r.w - 1)), dy = Math.max(0, r.y - y, y - (r.y + r.h - 1));
    return [Math.max(dx, dy), Math.sqrt(dx * dx + dy * dy)];
  }

  // --- symmetric writers ----------------------------------------------------------------
  function paint(c, r, t) {
    const ter = c.map.terrain, last = c.n - 1;
    eachCell(c, r, function (i) { ter[i] = t; ter[last - i] = t; });
  }
  function setRes(c, x, y, amount) {
    const m = c.map, i = y * c.w + x, j = c.n - 1 - i;
    m.res[i] = m.resCap[i] = m.res[j] = m.resCap[j] = amount;
    paint(c, R(x - 1, y - 1, 3, 3), T.LOT);
  }

  // --- turf catalogue: read generically from the neutral faction, never by key ----------
  function turfDefs() {
    const f = NT.FACTIONS && NT.FACTIONS.neutral, out = [];
    if (!f) return out;
    for (const key in f.buildings) {
      const d = f.buildings[key], wt = +(d.meta && d.meta.mapWeight) || 0;
      if (wt > 0 && d.size) out.push({ id: d.id, w: d.size[0], h: d.size[1], wt: wt, central: !!d.meta.central });
    }
    return out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });   // independent of file order
  }
  function weighted(rng, defs) {
    let total = 0;
    for (const d of defs) total += d.wt;
    let roll = rng.next() * total;
    for (const d of defs) { roll -= d.wt; if (roll < 0) return d; }
    return defs[defs.length - 1];
  }

  // --- 1. plan (canonical frame) ----------------------------------------------------------
  // Cut a region into lots. A cut falls a whole number of lots from one end (k of n, jittered
  // a cell either way) so that blocks come out 5-8 a side, not as rows of slivers.
  // `twin` is the cut the region on the other side of the parent street made, if any. A street that
  // would meet the parent a cell or two off its twin lines up with it instead: streets cross
  // squarely or meet as clear T-junctions, never as a near miss.
  function cutStreets(c, x, y, w, h, twin) {
    const rng = c.rng, big = Math.max(w, h);
    if (big < MAX_LOT || (big === MAX_LOT && (Math.min(w, h) < 5 || !rng.chance(0.15)))) { c.lots.push(R(x, y, w, h)); return null; }
    let alongX = w > h * 1.3 ? true : h > w * 1.3 ? false : rng.chance(0.5);
    if (Math.min(w, h) <= MAX_LOT) alongX = w >= h;
    const len = alongX ? w : h;
    let rw = len >= 34 ? 3 : len >= 20 && rng.chance(0.35) ? 3 : 2;
    const n = Math.ceil((len + 2) / (MAX_LOT + 2)), k = n < 2 ? 0.5 : rng.irange(n >> 1, (n + 1) >> 1);
    let at = NT.clamp(Math.round((len + 2) * k / n) - 2 + rng.irange(-1, 1), MIN_LOT, len - rw - MIN_LOT);
    // a 9-11 long piece can only split into slivers of 3-5: slide the cut until neither side is one
    const sliver = function (v) { return v > MAX_LOT && v < 12; };
    for (const d of [0, -1, 1, -2, 2, -3, 3]) {
      const a = at + d;
      if (a >= MIN_LOT && a <= len - rw - MIN_LOT && !sliver(a) && !sliver(len - rw - a)) { at = a; break; }
    }
    if (twin && twin.alongX === alongX && Math.abs(twin.at - at) <= 2) { at = twin.at; rw = twin.rw; }
    // only cuts ACROSS this street face each other over it (same origin, same length: a twin's cut always fits)
    const facing = function (cut) { return cut && cut.alongX !== alongX ? cut : null; };
    if (alongX) {
      c.roads.push(R(x + at, y, rw, h));
      cutStreets(c, x + at + rw, y, w - at - rw, h, facing(cutStreets(c, x, y, at, h, null)));
    } else {
      c.roads.push(R(x, y + at, w, rw));
      cutStreets(c, x, y + at + rw, w, h - at - rw, facing(cutStreets(c, x, y, w, at, null)));
    }
    return { alongX: alongX, at: at, rw: rw };
  }

  // n cells of a compact blob inside a bw x bh box: lowest elliptical distance first
  function blob(rng, bw, bh, n) {
    const cx = (bw - 1) / 2, cy = (bh - 1) / 2, cells = [];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const dx = (x - cx) / bw, dy = (y - cy) / bh;
      cells.push({ x: x, y: y, s: dx * dx + dy * dy + rng.next() * 0.012 });
    }
    cells.sort(function (a, b) { return a.s - b.s || a.y - b.y || a.x - b.x; });
    return cells.slice(0, n);
  }
  function nearest(r, cells, ox, oy) {            // [Chebyshev, Euclidean] from rect r to the blob placed at (ox, oy)
    let ch = 1e9, eu = 1e9;
    for (const p of cells) { const d = cellDist(r, ox + p.x, oy + p.y); if (d[0] < ch) ch = d[0]; if (d[1] < eu) eu = d[1]; }
    return [ch, eu];
  }

  // HQ, yard and home field. The field sits `g` cells off one side of the HQ; the yard is the
  // clear ground up to it plus at least 8 clear cells on the other three sides (map.js: starts),
  // so the base grows away from its resource heap.
  function planBase(c) {
    const rng = c.rng, w = c.w;
    // facing bases on a small map leave no room for a field in front of or behind the HQ: keep it beside
    const dir = NT.DIRS4[!c.corner && c.size === 'small' ? 2 * rng.int(2) : rng.int(4)], g = rng.irange(6, 8);
    const alongX = dir[0] !== 0, fwd = dir[0] + dir[1] > 0;
    const la = g - 1 + HQ + 8 + rng.int(c.P.yard), ll = 8 + HQ + 8 + rng.int(c.P.yard);   // yard length along / across the field axis
    const a0 = fwd ? HQ + g - 1 - la : 1 - g;                           // yard start along the axis, relative to the HQ
    const l0 = -(8 + rng.int(ll - 18));
    const b0 = fwd ? HQ + g - 1 : -g - 3;                               // 4-deep blob box: nearest row exactly g from the HQ
    const bl = rng.irange(-2, 0);                                       // 5 across, centred on the HQ so the gap is straight
    const yard = alongX ? R(a0, l0, la, ll) : R(l0, a0, ll, la);
    const box = alongX ? R(b0, bl, 4, 5) : R(bl, b0, 5, 4);
    const pad = grow(box, 1);
    const x0 = Math.min(yard.x, pad.x), y0 = Math.min(yard.y, pad.y);
    const x1 = Math.max(yard.x + yard.w, pad.x + pad.w), y1 = Math.max(yard.y + yard.h, pad.y + pad.h);
    const lox = Math.max(5, 1 - x0), hix = Math.min(w - HQ - 5, w - 1 - x1);
    const loy = Math.max(5, 1 - y0), hiy = c.top - 1 - y1;
    if (lox > hix || loy > hiy) return false;
    const hy = Math.min(hiy, loy + rng.int(c.P.slack));
    // facing bases are staggered off the centre line so the yards do not stare straight at each other
    const hx = c.corner ? Math.min(hix, lox + rng.int(c.P.slack)) : NT.clamp(Math.round(w / 2 - 1.5 + (rng.chance(0.5) ? 1 : -1) * rng.range(0.08, 0.17) * w), lox, hix);
    if (hits(grow(R(hx + x0, hy + y0, x1 - x0, y1 - y0), 2), c.plaza)) return false;
    const move = function (r) { return R(r.x + hx, r.y + hy, r.w, r.h); };
    c.hq = R(hx, hy, HQ, HQ); c.homeBox = move(box); c.homePad = move(pad);
    // a thin strip between yard and map edge would only hold slivers of tower and dead-end stubs: the yard takes it
    const yd = c.yard = move(yard), xe = yd.x + yd.w;
    if (yd.y < EDGE) { yd.h += yd.y; yd.y = 0; }
    if (yd.x < EDGE) { yd.w += yd.x; yd.x = 0; }
    if (w - xe < EDGE) yd.w += w - xe;
    c.home = blob(rng, box.w, box.h, rng.irange(c.P.home[0], c.P.home[1])).map(function (p) { return R(c.homeBox.x + p.x, c.homeBox.y + p.y, 1, 1); });
    return true;
  }

  // One expansion per side: 14-22 cells from the own HQ, clearly farther from the enemy,
  // with a 3-deep strip of lot on the HQ side for a drop-off.
  function planExpansion(c) {
    const rng = c.rng, cells = blob(rng, 4, 4, rng.irange(c.P.exp[0], c.P.exp[1]));
    const enemy = mirror(c, c.hq), keep = [grow(c.yard, 2), grow(c.homePad, 2), grow(c.plaza, 2)], near = [], far = [];
    for (let y = 2; y + 4 <= c.top - 2; y++) for (let x = 2; x + 4 <= c.w - 2; x++) {
      const own = nearest(c.hq, cells, x, y);
      if (own[0] < 14 || own[1] > 21.5 || nearest(enemy, cells, x, y)[1] < own[1] + 8) continue;
      if (gap(R(x, y, 4, 4), c.homeBox) < 9) continue;             // a second site, not an annex of the home field
      const dx = c.hq.x + 1 - (x + 1.5), dy = c.hq.y + 1 - (y + 1.5);
      let pad = grow(R(x, y, 4, 4), 1);
      if (Math.abs(dx) >= Math.abs(dy)) pad = R(pad.x - (dx < 0 ? 2 : 0), pad.y, pad.w + 2, pad.h);
      else pad = R(pad.x, pad.y - (dy < 0 ? 2 : 0), pad.w, pad.h + 2);
      if (!inside(pad, 1, 1, c.w - 1, c.top - 1) || keep.some(function (k) { return hits(pad, k); })) continue;
      (gap(pad, c.plaza) >= 7 ? far : near).push({ x: x, y: y, pad: pad });
    }
    if (!near.length && !far.length) return false;
    const pick = rng.pick(far.length ? far : near);                // well away from the contested centre when the map allows
    c.expPad = pick.pad;
    c.exp = cells.map(function (p) { return R(pick.x + p.x, pick.y + p.y, 1, 1); });
    return true;
  }

  // Central field: cells of the top half of a 6x6 box, nearest the exact centre first; setRes mirrors them.
  function planCentre(c) {
    const rng = c.rng, cx = (c.w - 1) / 2, cy = (c.h - 1) / 2, cells = [];
    for (let y = c.h / 2 - 3; y < c.h / 2; y++) for (let x = c.w / 2 - 3; x < c.w / 2 + 3; x++) {
      cells.push({ x: x, y: y, s: (x - cx) * (x - cx) + (y - cy) * (y - cy) + rng.next() * 0.3 });
    }
    cells.sort(function (a, b) { return a.s - b.s || a.y - b.y || a.x - b.x; });
    c.centre = cells.slice(0, rng.irange(c.P.central[0] / 2, c.P.central[1] / 2)).map(function (p) { return R(p.x, p.y, 1, 1); });
  }

  function plan(c) {
    const rng = c.rng, w = c.w, half = c.h / 2;
    c.transpose = rng.chance(0.5); c.flip = rng.chance(0.5);
    c.corner = rng.chance(c.P.corner);
    const canal = rng.chance(0.35);
    // seam: a 2-wide avenue, or 2 quay rows + 2 water rows + 2 quay rows. Its width must be even to mirror onto itself.
    c.top = half - (canal ? 3 : 1);
    c.avenues = canal ? [R(0, c.top, w, 2), R(0, half + 1, w, 2)] : [R(0, c.top, w, 2)];
    c.water = canal ? [R(0, half - 1, w, 2)] : [];
    c.bridges = canal ? [R(Math.round(w * rng.range(0.1, 0.22)), half - 1, 3 + rng.int(2), 2)] : [];
    // plaza: long enough for the central blob (6 wide) plus a turf structure and its ring at each end
    const cd = c.central.length ? weighted(rng, c.central) : c.side.length ? weighted(rng, c.side) : null;
    const fa = cd ? (c.transpose ? cd.h : cd.w) : 1, fc = cd ? (c.transpose ? cd.w : cd.h) : 1;
    const pw = 12 + 2 * fa + 2 * rng.int(c.P.slack), ph = Math.max(8, 2 * Math.ceil(fc / 2) + 2) + 2 * rng.int(c.P.slack);
    c.plaza = R(w / 2 - pw / 2, half - ph / 2, pw, ph);
    c.turf = cd ? [{ def: cd.id, r: R(w / 2 - 5 - fa, half - Math.ceil(fc / 2), fa, fc) }] : [];
    c.roads = []; c.lots = []; c.districts = [];
    cutStreets(c, 0, 0, w, c.top);
    // every kind of district turns up before any repeats: a map has its towers, its market and its ruins
    const kinds = rng.shuffle(DISTRICTS.map(function (d, i) { return i; }));
    for (let k = 0; k < c.P.districts; k++) c.districts.push({ kind: kinds[k % kinds.length], r: R(rng.int(w), rng.int(c.top), 1, 1) });
    if (!planBase(c) || !planExpansion(c)) return false;
    planCentre(c);
    // canonical -> map frame
    const tr = function (r) { return real(c, r); };
    for (const k of ['plaza', 'hq', 'yard', 'homePad', 'expPad']) c[k] = tr(c[k]);
    for (const k of ['avenues', 'water', 'bridges', 'roads', 'lots', 'home', 'exp', 'centre']) c[k] = c[k].map(tr);
    for (const t of c.turf.concat(c.districts)) t.r = tr(t.r);
    return true;
  }

  // --- 2-3. streets, zones, fields ----------------------------------------------------------
  function paintGround(c) {
    for (const r of c.roads.concat(c.avenues)) paint(c, r, T.ROAD);
    for (const r of c.water) paint(c, r, T.WATER);
    for (const r of c.bridges) paint(c, r, T.ROAD);
    paint(c, c.plaza, T.PAVE);          // also decks over the canal: the plaza is its widest crossing
    paint(c, c.yard, T.PAVE);
    paint(c, c.expPad, T.LOT);
  }

  // cells: one field (primary side). Its spawner sits on the centre cell and reaches every cell.
  function addField(c, cells, kind) {
    let sx = 0, sy = 0, far = 0;
    for (const p of cells) { setRes(c, p.x, p.y, CREDITS[kind]); sx += p.x; sy += p.y; }
    const cx = Math.round(sx / cells.length), cy = Math.round(sy / cells.length);
    for (const p of cells) far = Math.max(far, NT.dist(cx, cy, p.x, p.y));
    const radius = Math.ceil(far * 2) / 2 + 0.5;
    c.map.spawners.push({ cx: cx, cy: cy, radius: radius, rate: RATE[kind] }, { cx: c.w - 1 - cx, cy: c.h - 1 - cy, radius: radius, rate: RATE[kind] });
  }
  // The symmetry centre of an even-sized map is a cell corner, so the central field's
  // spawner cannot be its own mirror image: it becomes a mirrored pair on the two
  // diagonal centre cells, each paying half the rate over the whole field.
  function addCentralField(c) {
    const cx = c.w / 2 - 1, cy = c.h / 2 - 1;
    let far = 0;
    for (const p of c.centre) {
      setRes(c, p.x, p.y, CREDITS.central);
      far = Math.max(far, NT.dist(cx, cy, p.x, p.y), NT.dist(cx, cy, c.w - 1 - p.x, c.h - 1 - p.y));
    }
    const radius = Math.ceil(far * 2) / 2 + 0.5, rate = RATE.central / 2;
    c.map.spawners.push({ cx: cx, cy: cy, radius: radius, rate: rate }, { cx: cx + 1, cy: cy + 1, radius: radius, rate: rate });
  }

  // lots with the zones cut out of them: what is left may hold a tower or a turf structure
  function freeLots(c) {
    const zones = [c.yard, c.homePad, c.expPad, c.plaza], out = [];
    for (let i = 0; i < 3; i++) zones.push(mirror(c, zones[i]));
    for (const lot of c.lots) {
      let parts = [lot];
      for (const z of zones) parts = parts.reduce(function (all, r) { return all.concat(clipAway(r, z)); }, []);
      for (const r of parts) out.push({ r: r, kind: '', rects: [], district: null, split: parts.length > 1 });
    }
    return out;
  }

  // --- 4. turf --------------------------------------------------------------------------------
  // footprint buildable, ring passable and on the map, no resources within two cells
  function turfFits(c, r) {
    const m = c.map;
    let ok = inside(r, 1, 1, c.w - 1, c.h - 1);
    eachCell(c, grow(r, 2), function (i, x, y) {
      const t = NT.TERRAIN_INFO[m.terrain[i]];
      if (m.res[i] || (has(grow(r, 1), x, y) && !t.pass) || (has(r, x, y) && !t.build)) ok = false;
    });
    return ok;
  }
  // The free lot for def d that lies farthest from the turf already placed (with some noise).
  function turfSpot(c, lots, d) {
    const rng = c.rng, hq2 = mirror(c, c.hq);
    let best = null, bestScore = -1;
    for (const lot of lots) {
      const ring = lot.split ? 2 : 0;       // a whole lot has streets around it; a piece of one must hold the ring itself
      if (lot.kind || lot.r.w < d.w + ring || lot.r.h < d.h + ring) continue;
      const r = R(lot.r.x + ((lot.r.w - d.w) >> 1), lot.r.y + ((lot.r.h - d.h) >> 1), d.w, d.h);
      let near = gap(r, mirror(c, r));
      for (const t of c.turf) near = Math.min(near, gap(r, t.r), gap(r, mirror(c, t.r)));
      if (near < TURF_GAP || gap(r, c.hq) < HQ_CLEAR || gap(r, hq2) < HQ_CLEAR || !turfFits(c, r)) continue;
      const score = Math.min(near, 40) * rng.range(0.6, 1) + (lot.r.w >= d.w + 2 && lot.r.h >= d.h + 2 ? 2 : 0);
      if (score > bestScore) { bestScore = score; best = { lot: lot, r: r }; }
    }
    return best;
  }
  function placeTurf(c, lots) {
    const rng = c.rng;
    if (c.turf.length && !turfFits(c, c.turf[0].r)) { if (c.strict) return false; c.turf.length = 0; }
    let placed = 0;
    for (let k = c.side.length ? rng.irange(c.P.turf[0], c.P.turf[1]) : 0; k > 0; k--) {
      for (let t = 0; t < 4; t++) {                 // a def that fits nowhere is redrawn, not forced
        const d = weighted(rng, c.side), spot = turfSpot(c, lots, d);
        if (!spot) continue;
        spot.lot.kind = 'turf';
        c.turf.push({ def: d.id, r: spot.r });
        placed++;
        break;
      }
    }
    return placed >= 3 || !c.side.length || !c.strict;
  }

  // --- 4. lots -> towers / open ground ----------------------------------------------------------
  function passableAt(c, x, y) {
    return x >= 0 && y >= 0 && x < c.w && y < c.h && NT.TERRAIN_INFO[c.map.terrain[y * c.w + x]].pass;
  }
  // Tower footprint(s) for a lot: sometimes set back a cell from the street, sometimes two towers side by side.
  // The pieces of a lot split by a zone touch each other: no setback there, it would open a 1-wide alley between them.
  function towerRects(c, l) {
    const rng = c.rng;
    let r = l.r;
    if (!l.split && rng.chance(0.22)) {
      const side = rng.int(4), horiz = side % 2 === 0;
      const ox = side === 0 ? r.x + r.w : side === 2 ? r.x - 1 : r.x + (r.w >> 1);
      const oy = side === 1 ? r.y + r.h : side === 3 ? r.y - 1 : r.y + (r.h >> 1);
      // only step back from open ground: a 1-wide strip against a wall or the map edge would be a dead alley
      if ((horiz ? r.w : r.h) >= 5 && passableAt(c, ox, oy)) {
        r = horiz ? R(r.x + (side === 2 ? 1 : 0), r.y, r.w - 1, r.h) : R(r.x, r.y + (side === 3 ? 1 : 0), r.w, r.h - 1);
      }
    }
    const long = Math.max(r.w, r.h);
    if (long < 2 * MIN_LOT || !rng.chance(0.3)) return [r];
    const a = rng.irange(MIN_LOT, long - MIN_LOT);
    return r.w >= r.h ? [R(r.x, r.y, a, r.h), R(r.x + a, r.y, r.w - a, r.h)] : [R(r.x, r.y, r.w, a), R(r.x, r.y + a, r.w, r.h - a)];
  }
  function midCells(c, rects) {
    let n = 0;
    for (const r of rects) eachCell(c, r, function (i) { n += c.mid[i]; });
    return n;
  }
  function districtOf(c, r) {
    const x = r.x + r.w / 2, y = r.y + r.h / 2;
    let best = DISTRICTS[1], bd = 1e9;
    for (const d of c.districts) {
      for (const p of [d.r, mirror(c, d.r)]) { const dd = NT.dist2(x, y, p.x, p.y); if (dd < bd) { bd = dd; best = DISTRICTS[d.kind]; } }
    }
    return best;
  }
  // Give every free lot a use, then steer the mid-map BLOCK share into the target window.
  function zoneLots(c, free) {
    const rng = c.rng;
    let blockMid = 0;
    const pads = [c.homePad, c.expPad, mirror(c, c.homePad), mirror(c, c.expPad)], yards = [c.yard, mirror(c, c.yard)];
    const by = function (l, zones) { return zones.some(function (z) { return gap(l.r, z) <= FIELD_CLEAR; }); };
    for (const l of free) {
      const o = (l.district = districtOf(c, l.r)).odds, roll = rng.next();
      l.kind = roll < o[0] ? 'tower' : roll < o[0] + o[1] ? 'plaza' : roll < o[0] + o[1] + o[2] ? 'parking' : 'rubble';
      const open = l.kind === 'parking' || l.kind === 'rubble';
      l.core = by(l, [c.plaza]);
      const field = l.core || by(l, pads);
      // downtown: towers close in on the central plaza whatever the district
      if (l.core && rng.chance(0.75)) l.kind = 'tower';
      // resource ground must read at a glance: a car park (the same LOT) or ruins beside a field would blur its edge
      else if (open && field) l.kind = rng.chance(0.6) ? 'tower' : 'plaza';
      // a yard is walled by towers and car parks: ruins on the doorstep are ground the base can never grow onto,
      // and one more empty square would only blur where the yard ends
      else if (l.kind !== 'tower' && l.kind !== 'parking' && by(l, yards)) l.kind = l.kind === 'plaza' && rng.chance(0.6) ? 'tower' : field ? 'plaza' : 'parking';
      if (l.kind === 'tower') { l.rects = towerRects(c, l); blockMid += 2 * midCells(c, l.rects); }
    }
    // Steering only moves lots that count: dense districts are built up first, sparse ones thinned out first.
    const order = rng.shuffle(free.filter(function (l) { return midCells(c, [l.r]) > 0; })).sort(function (a, b) { return b.district.odds[0] - a.district.odds[0]; });
    for (let i = 0; i < order.length && blockMid < BLOCK_AIM[0] * c.midTotal; i++) {
      const l = order[i];
      if (l.kind !== 'tower') { l.kind = 'tower'; l.rects = [l.r]; blockMid += 2 * midCells(c, l.rects); }
    }
    for (let i = order.length - 1; i >= 0 && blockMid > BLOCK_AIM[1] * c.midTotal; i--) {
      const l = order[i];
      if (l.kind === 'tower' && !l.core) { blockMid -= 2 * midCells(c, l.rects); l.kind = 'plaza'; l.rects = []; }
    }
    c.share = blockMid / c.midTotal;
    // ruins are an accent: past the cap, the fields in the densest districts are cleared first
    let rubbleMid = 0, cleared = 0;
    for (const l of free) if (l.kind === 'rubble') rubbleMid += 2 * midCells(c, [l.r]);
    for (let i = 0; i < order.length && rubbleMid > RUBBLE_MAX * c.midTotal; i++) {
      const l = order[i];
      if (l.kind === 'rubble') { rubbleMid -= 2 * midCells(c, [l.r]); l.kind = cleared++ % 2 ? 'plaza' : 'parking'; }
    }
  }
  function buildLots(c, lots) {
    const rng = c.rng, free = lots.filter(function (l) { return !l.kind; }), centre = c.w / 2, reach = c.w * 0.7;
    zoneLots(c, free);
    for (const l of free) {
      if (l.kind !== 'tower') { paint(c, l.r, l.kind === 'parking' ? T.LOT : l.kind === 'rubble' ? T.RUBBLE : T.PAVE); continue; }
      for (const r of l.rects) {
        // skyline: taller toward the middle of the map and in the core districts
        const lift = 0.45 * (1 - NT.dist(r.x + r.w / 2, r.y + r.h / 2, centre, centre) / reach) + l.district.lift + rng.range(0, 0.45);
        const b = { x: r.x, y: r.y, w: r.w, h: r.h, style: rng.int(6), height: Math.round(NT.clamp(14 + 26 * lift, 14, 40)) };
        const m = mirror(c, r);
        c.map.blocks.push(b, { x: m.x, y: m.y, w: m.w, h: m.h, style: b.style, height: b.height });
        paint(c, r, T.BLOCK);
      }
    }
    c.plazas = free.filter(function (l) { return l.kind === 'plaza'; }).map(function (l) { return l.r; });
  }

  // Zones are painted over the street grid and can shave a street down to a single row. A road
  // is at least 2 cells wide: what is left over becomes pavement. (Symmetric in, symmetric out.)
  function trimRoads(c) {
    const ter = c.map.terrain, w = c.w, wide = c.tmp;
    wide.fill(0);
    for (let y = 0; y < c.h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (ter[i] === T.ROAD && ter[i + 1] === T.ROAD && ter[i + w] === T.ROAD && ter[i + w + 1] === T.ROAD) wide[i] = wide[i + 1] = wide[i + w] = wide[i + w + 1] = 1;
    }
    for (let i = 0; i < c.n; i++) if (ter[i] === T.ROAD && !wide[i]) ter[i] = T.PAVE;
    // ... and a stretch cut off from every other street is not a street: a few cells of asphalt become pavement too
    for (let i = 0; i < c.n; i++) {
      if (!wide[i]) continue;
      const count = search(c, wide, [i], null), q = c.queue;
      for (let k = 0; k < count; k++) { wide[q[k]] = 0; if (count < MIN_ROAD) ter[q[k]] = T.PAVE; }
    }
  }

  // --- 5. validation --------------------------------------------------------------------------
  function symmetric(c) {
    const m = c.map, last = c.n - 1;
    for (let i = 0; i < c.n >> 1; i++) {
      if (m.terrain[i] !== m.terrain[last - i] || m.res[i] !== m.res[last - i] || m.resCap[i] !== m.resCap[last - i]) return false;
    }
    return true;
  }
  // Every passable cell must be swept by a 2x2 body walking from the HQ: no 1-wide passages,
  // no pockets. (Stronger than "each cell lies in some passable 2x2".)
  function wideEverywhere(c) {
    const w = c.w, n = c.n, ok = c.ok, fat = c.tmp, swept = c.seen, q = c.queue;
    fat.fill(0); swept.fill(0);
    for (let y = 0; y < c.h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      if (ok[i] && ok[i + 1] && ok[i + w] && ok[i + w + 1]) fat[i] = 1;
    }
    const start = c.hq.y * w + c.hq.x;
    if (!fat[start]) return false;
    let qh = 0, qt = 0;
    q[qt++] = start; fat[start] = 2;
    while (qh < qt) {
      const i = q[qh++], x = i % w;
      swept[i] = swept[i + 1] = swept[i + w] = swept[i + w + 1] = 1;
      if (x > 0 && fat[i - 1] === 1) { fat[i - 1] = 2; q[qt++] = i - 1; }
      if (x < w - 1 && fat[i + 1] === 1) { fat[i + 1] = 2; q[qt++] = i + 1; }
      if (i >= w && fat[i - w] === 1) { fat[i - w] = 2; q[qt++] = i - w; }
      if (i + w < n && fat[i + w] === 1) { fat[i + w] = 2; q[qt++] = i + w; }
    }
    for (let i = 0; i < n; i++) if (ok[i] && !swept[i]) return false;
    return true;
  }
  // 4-connected BFS (the pathfinder never cuts corners) over cells with open[i] === 1, from `src`
  // to any cell flagged in `goal`: the path as cell indices, or null. With goal = null: the flood count.
  function search(c, open, src, goal) {
    const w = c.w, n = c.n, prev = c.prev, q = c.queue;
    prev.fill(-1);
    let qh = 0, qt = 0;
    for (const s of src) if (open[s] && prev[s] < 0) { prev[s] = s; q[qt++] = s; }
    while (qh < qt) {
      const i = q[qh++];
      if (goal && goal[i]) {
        const path = [];
        for (let k = i; ; k = prev[k]) { path.push(k); if (prev[k] === k) break; }
        return path;
      }
      const x = i % w;
      if (x < w - 1 && open[i + 1] && prev[i + 1] < 0) { prev[i + 1] = i; q[qt++] = i + 1; }
      if (i + w < n && open[i + w] && prev[i + w] < 0) { prev[i + w] = i; q[qt++] = i + w; }
      if (x > 0 && open[i - 1] && prev[i - 1] < 0) { prev[i - 1] = i; q[qt++] = i - 1; }
      if (i >= w && open[i - w] && prev[i - w] < 0) { prev[i - w] = i; q[qt++] = i - w; }
    }
    return goal ? null : qt;
  }
  function ringOf(c, r) {
    const out = [];
    eachCell(c, grow(r, 1), function (i, x, y) { if (!has(r, x, y)) out.push(i); });
    return out;
  }
  // Buildings are solid at run time, so routes are judged with HQ and turf footprints closed.
  // Three start-to-start paths that never come within a 3x3 patch of one another: no such
  // patch can cut the bases apart, and each path is a genuinely different way across town.
  function routesOk(c) {
    const open = c.tmp, goal = c.seen, hq2 = mirror(c, c.hq);
    open.set(c.ok); goal.fill(0);
    let nOpen = c.nPass;
    const close = function (i) { nOpen -= open[i]; open[i] = 0; };
    for (const t of c.turf.concat([{ r: c.hq }])) { eachCell(c, t.r, close); eachCell(c, mirror(c, t.r), close); }
    const src = ringOf(c, c.hq);
    if (search(c, open, src, null) !== nOpen) return 'pocket';
    for (const i of ringOf(c, hq2)) goal[i] = 1;
    for (let k = 1; k <= 3; k++) {
      const path = search(c, open, src, goal);
      if (!path) return 'route' + k;
      for (const i of path) eachCell(c, grow(R(i % c.w, (i / c.w) | 0, 1, 1), ROUTE_GAP), close);
    }
    return '';
  }
  function validate(c) {
    const m = c.map, info = NT.TERRAIN_INFO;
    let yardOk = true;
    c.nPass = 0;
    for (let i = 0; i < c.n; i++) { c.ok[i] = info[m.terrain[i]].pass ? 1 : 0; c.nPass += c.ok[i]; }
    eachCell(c, c.yard, function (i, x, y) { if (!NT.Map.buildableTerrain(m, x, y)) yardOk = false; });
    const ringsOk = c.turf.every(function (t) { return ringOf(c, t.r).every(function (i) { return c.ok[i]; }); });
    return !symmetric(c) ? 'symmetry' : !yardOk ? 'yard' : !ringsOk ? 'ring' : !wideEverywhere(c) ? 'narrow' : c.share < BLOCK_LO || c.share > BLOCK_HI ? 'blocks' : routesOk(c);
  }

  // --- deco: render-only, from its own RNG stream so it can never disturb the layout ---------------
  function decoKit(c) {
    const rng = new NT.Rng(NT.hash32(c.seed, c.size, 'deco')), TL = NT.TILE, w = c.w, quiet = c.tmp, used = c.seen;
    // quiet: ground where street furniture would end up under a base, a turf structure or a harvester
    quiet.fill(0); used.fill(0);
    const hush = function (i) { quiet[i] = 1; };
    eachCell(c, c.yard, hush); eachCell(c, mirror(c, c.yard), hush);
    for (const t of c.turf) { eachCell(c, grow(t.r, 1), hush); eachCell(c, grow(mirror(c, t.r), 1), hush); }
    for (let i = 0; i < c.n; i++) if (c.map.resCap[i]) quiet[i] = 1;
    return {
      rng: rng, budget: c.P.deco, quiet: quiet,
      free: function (x, y) { return x >= 0 && y >= 0 && x < w && y < c.h && !quiet[y * w + x]; },
      put: function (type, x, y, rot, scale) {             // x, y in cells
        c.map.deco.push({ type: type, x: Math.round(x * TL), y: Math.round(y * TL), rot: Math.round(rot * 1000) / 1000, scale: Math.round(scale * 100) / 100, seed: rng.int(0x7fffffff) });
      },
      take: function (list, share, fn) {                   // up to share x budget random entries, one item per cell
        rng.shuffle(list);
        for (let k = 0, left = Math.round(share * c.P.deco); k < list.length && left > 0; k++) {
          const i = list[k].i === undefined ? list[k] : list[k].i;
          if (used[i]) continue;
          used[i] = 1; left--; fn(i % w + 0.5, ((i / w) | 0) + 0.5, list[k]);
        }
      },
      spin: function () { return rng.range(-Math.PI, Math.PI); },
      size: function () { return rng.range(0.85, 1.2); },
    };
  }
  // lamps on alternating kerbs every 5-7 cells, crosswalks where a street runs into another
  function decoStreets(c, k) {
    const rng = k.rng, ter = c.map.terrain, w = c.w, lamps = [], walks = [], roads = c.avenues.slice();
    for (const r of c.roads) roads.push(r, mirror(c, r));
    const isRoad = function (x, y) { return k.free(x, y) && ter[y * w + x] === T.ROAD; };
    for (const r of roads) {
      const vert = r.h > r.w, len = vert ? r.h : r.w, wid = vert ? r.w : r.h;
      let side = rng.int(2);
      for (let s = 1 + rng.int(4); s < len - 1; s += rng.irange(5, 7), side ^= 1) {
        const x = vert ? r.x + (side ? wid - 1 : 0) : r.x + s, y = vert ? r.y + s : r.y + (side ? wid - 1 : 0), kerb = side ? 0.86 : 0.14;
        if (isRoad(x, y)) lamps.push(vert ? [x + kerb, y + 0.5, side ? Math.PI : 0] : [x + 0.5, y + kerb, side ? -Math.PI / 2 : Math.PI / 2]);
      }
      for (const end of [0, len - 1]) {             // (x, y) = middle of the street's mouth, (bx, by) = the street it meets
        const x = vert ? r.x + (wid >> 1) : r.x + end, y = vert ? r.y + end : r.y + (wid >> 1);
        const bx = vert ? x : x + (end ? 1 : -1), by = vert ? y + (end ? 1 : -1) : y;
        if (isRoad(x, y) && isRoad(bx, by)) walks.push(vert ? [r.x + wid / 2, y + 0.5, Math.PI / 2, wid / 2] : [x + 0.5, r.y + wid / 2, 0, wid / 2]);
      }
    }
    const nLamps = Math.min(lamps.length, Math.round(k.budget * 0.5));
    for (let i = 0; i < nLamps; i++) { const l = lamps[Math.floor(i * lamps.length / nLamps)]; k.put('lamp', l[0], l[1], l[2], 1); }
    rng.shuffle(walks);
    for (let i = 0; i < Math.min(walks.length, Math.round(k.budget * 0.07)); i++) k.put('crosswalk', walks[i][0], walks[i][1], walks[i][2], walks[i][3]);
  }
  // neon signs hang on tower faces that look onto open ground; rot = the way the sign faces
  function decoSigns(c, k) {
    const rng = k.rng, faces = [], E = 0, S = Math.PI / 2, W = Math.PI, N = -Math.PI / 2;
    for (const b of c.map.blocks) {
      const t = rng.range(0.25, 0.75), mx = b.x + (b.w >> 1), my = b.y + (b.h >> 1);
      const f = [[b.x + b.w, my, b.x + b.w, b.y + b.h * t, E], [mx, b.y + b.h, b.x + b.w * t, b.y + b.h, S],
        [b.x - 1, my, b.x, b.y + b.h * t, W], [mx, b.y - 1, b.x + b.w * t, b.y, N]][rng.int(4)];
      if (passableAt(c, f[0], f[1])) faces.push(f);
    }
    rng.shuffle(faces);
    for (let i = 0; i < Math.min(faces.length, Math.round(k.budget * 0.09)); i++) k.put('sign', faces[i][2], faces[i][3], faces[i][4], k.size());
  }
  // everything that just stands about: sorted into candidate cells by one scan of the open ground
  function decoClutter(c, k) {
    const ter = c.map.terrain, w = c.w, h = c.h, rng = k.rng;
    const road = [], pave = [], lot = [], rubble = [], wall = [], verge = [], corners = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, t = ter[i];
      if (k.quiet[i] || t === T.WATER || t === T.BLOCK) continue;
      (t === T.ROAD ? road : t === T.PAVE ? pave : t === T.LOT ? lot : rubble).push(i);
      for (let d = 0; d < 4 && t !== T.RUBBLE; d++) {
        const nx = x + NT.DIRS4[d][0], ny = y + NT.DIRS4[d][1];
        const nt = nx < 0 || ny < 0 || nx >= w || ny >= h ? -1 : ter[ny * w + nx];
        if (nt === T.BLOCK) { wall.push({ i: i, d: d }); break; }
        if (nt === T.RUBBLE || nt === T.WATER) { verge.push({ i: i, d: d }); break; }
      }
    }
    for (const p of c.plazas.concat([c.plaza])) {
      for (const r of [p, mirror(c, p)]) {
        for (const q of [[r.x, r.y], [r.x + r.w - 1, r.y], [r.x, r.y + r.h - 1], [r.x + r.w - 1, r.y + r.h - 1]]) if (k.free(q[0], q[1])) corners.push(q[1] * w + q[0]);
      }
    }
    const lean = function (e, far) { return [NT.DIRS4[e.d][0] * far, NT.DIRS4[e.d][1] * far, e.d % 2 ? 0 : Math.PI / 2]; };   // toward the wall, lying along it
    k.take(wall, 0.05, function (x, y, e) { const o = lean(e, 0.25); k.put('dumpster', x + o[0], y + o[1], o[2], k.size()); });
    k.take(wall, 0.04, function (x, y, e) { const o = lean(e, 0.3); k.put('vent', x + o[0], y + o[1], 0, k.size()); });
    k.take(verge, 0.03, function (x, y, e) { const o = lean(e, 0.35); k.put('barrier', x + o[0], y + o[1], o[2], k.size()); });
    k.take(rubble.concat(lot), 0.04, function (x, y) { k.put('wreck', x, y, k.spin(), k.size()); });
    k.take(lot.concat(pave), 0.03, function (x, y) { k.put('crate', x + rng.range(-0.2, 0.2), y + rng.range(-0.2, 0.2), k.spin(), k.size()); });
    k.take(corners, 0.05, function (x, y) { k.put('planter', x, y, 0, k.size()); });
    k.take(road, 0.04, function (x, y) { k.put('manhole', x, y, k.spin(), 1); });
    // puddles soak up whatever is left of the budget
    k.take(road.concat(pave, lot), 1 - c.map.deco.length / k.budget, function (x, y) { k.put('puddle', x + rng.range(-0.2, 0.2), y + rng.range(-0.2, 0.2), k.spin(), rng.range(0.7, 1.5)); });
  }

  // --- assembly ------------------------------------------------------------------------------------
  function attempt(seed, size, k) {
    const w = G.SIZES[size], n = w * w, defs = turfDefs();
    const c = {
      w: w, h: w, n: n, size: size, seed: seed, P: PARAMS[size], strict: k < STRICT_TRIES,
      rng: new NT.Rng(NT.hash32(seed, size, k)),
      map: NT.Map.create(w, w, { name: size + '-' + seed, seed: seed }),
      central: defs.filter(function (d) { return d.central; }), side: defs.filter(function (d) { return !d.central; }),
      ok: new Uint8Array(n), tmp: new Uint8Array(n), seen: new Uint8Array(n), mid: new Uint8Array(n),
      prev: new Int32Array(n), queue: new Int32Array(n),
    };
    if (!plan(c)) return 'plan';
    // mid: farther than HQ_CLEAR from both HQs — the city proper
    const hq2 = mirror(c, c.hq);
    c.midTotal = 0;
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
      c.midTotal += c.mid[y * w + x] = Math.min(cellDist(c.hq, x, y)[0], cellDist(hq2, x, y)[0]) > HQ_CLEAR ? 1 : 0;
    }
    paintGround(c);
    addField(c, c.home, 'home'); addField(c, c.exp, 'expansion'); addCentralField(c);
    const lots = freeLots(c);
    if (!placeTurf(c, lots)) return 'turf';
    buildLots(c, lots);
    trimRoads(c);
    const why = validate(c);
    if (why) return why;
    const m = c.map, kit = decoKit(c);
    m.starts = [{ cx: c.hq.x, cy: c.hq.y }, { cx: hq2.x, cy: hq2.y }];
    for (const t of c.turf) { const r = mirror(c, t.r); m.neutrals.push({ def: t.def, cx: t.r.x, cy: t.r.y }, { def: t.def, cx: r.x, cy: r.y }); }
    decoStreets(c, kit); decoSigns(c, kit); decoClutter(c, kit);
    return NT.Map.finalize(m);
  }

  G.stats = { maps: 0, attempts: 0, fails: {} };          // retry bookkeeping for tests / tuning

  G.generate = function (opts) {
    opts = opts || {};
    const size = opts.size || 'medium', seed = (opts.seed >>> 0) || 1;
    NT.assert(G.SIZES[size], 'MapGen: unknown size "' + size + '"');
    NT.assert(opts.players === undefined || opts.players === 2, 'MapGen: only 2-player maps are supported');
    G.stats.maps++;
    for (let k = 0; k < TRIES; k++) {
      const res = attempt(seed, size, k);
      G.stats.attempts++;
      if (typeof res !== 'string') return res;
      G.stats.fails[res] = (G.stats.fails[res] || 0) + 1;
    }
    throw new Error('MapGen: no valid layout for seed ' + seed + ' (' + size + ')');
  };

  // Menu presets. The FIRST entry is the map a new player lands on (main.js falls back to NT.MAPS[0]).
  // A preset is nothing but (size, seed): if this file or the turf catalogue changes, look at the dumps again.
  NT.MAPS = [
    {
      id: 'sodium-row', name: { en: 'Sodium Row', zh: '钠灯街' }, size: 'medium', seed: 2176, players: 2,
      desc: {
        en: 'Corner to corner across the old market grid, under street lamps that never quite warm up. The fattest heap in town lies dead centre, a night market at either end of it.',
        zh: '从街区一角打到另一角，头顶的钠灯永远亮不透。全城最肥的碎金堆就在正中央，两头各守着一座夜市。',
      },
    },
    {
      id: 'sluice-lane', name: { en: 'Sluice Lane', zh: '闸口巷' }, size: 'small', seed: 1911, players: 2,
      desc: {
        en: 'A short, mean neighbourhood cut in two by a storm canal. Two bridges and the plaza deck are the only ways over: expect company on all three.',
        zh: '一条排洪渠把这片小街区一劈两半。过渠只有两座桥和中央的广场，三处都少不了人。',
      },
    },
    {
      id: 'bargepole-cut', name: { en: 'Bargepole Cut', zh: '撑篙渠' }, size: 'medium', seed: 2603, players: 2,
      desc: {
        en: 'Two gangs, one canal between them. Each side has a bridge close to home that opens onto the other\'s back streets, and the long quays offer no cover at all.',
        zh: '两个帮派，中间隔着一条运河。两边各有一座离家不远的桥，直通对面的后街；长长的河岸上毫无遮挡。',
      },
    },
    {
      id: 'brownout-boulevard', name: { en: 'Brownout Boulevard', zh: '限电大道' }, size: 'large', seed: 972, players: 2,
      desc: {
        en: 'The long way across town: block after flickering block between two bases at opposite ends. Room for a second front, and plenty of turf to bleed for on the way.',
        zh: '横穿全城的一趟远路：东西两头的基地之间，是一片又一片灯光忽明忽暗的街区。足够开辟第二战场，沿途的地盘也够抢上很久。',
      },
    },
  ];

  G.fromPreset = function (id) {
    const p = NT.MAPS.find(function (m) { return m.id === id; });
    NT.assert(p, 'MapGen: unknown preset "' + id + '"');
    const map = G.generate({ seed: p.seed, size: p.size, players: p.players });
    map.name = p.id;
    return map;
  };

  // Debug dump. Legend of NT.Map.fromAscii, plus 'T' = turf footprint; a start marks the HQ's top-left cell.
  G.ascii = function (map) {
    const glyph = [];
    glyph[T.ROAD] = '='; glyph[T.PAVE] = '.'; glyph[T.LOT] = ','; glyph[T.RUBBLE] = '%'; glyph[T.WATER] = '~'; glyph[T.BLOCK] = '#';
    const rows = [];
    for (let y = 0; y < map.h; y++) {
      const row = [];
      for (let x = 0; x < map.w; x++) { const i = y * map.w + x; row.push(map.res[i] ? '$' : glyph[map.terrain[i]] || '?'); }
      rows.push(row);
    }
    for (const nt of map.neutrals) {
      const d = NT.DEFS && NT.DEFS[nt.def], fw = d && d.size ? d.size[0] : 1, fh = d && d.size ? d.size[1] : 1;
      for (let y = nt.cy; y < nt.cy + fh; y++) for (let x = nt.cx; x < nt.cx + fw; x++) if (rows[y] && x >= 0 && x < map.w) rows[y][x] = 'T';
    }
    for (let i = 0; i < map.starts.length; i++) rows[map.starts[i].cy][map.starts[i].cx] = String(i + 1);
    return rows.map(function (r) { return r.join(''); }).join('\n');
  };
})();
