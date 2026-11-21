'use strict';
// ============================================================================
// NEON TURF — map.js  (HEADLESS-SAFE)
// The map data structure every other file agrees on, plus tiny helpers and an
// ASCII loader for tests. Procedural city generation lives in mapgen.js and
// must return maps built with NT.Map.create() + NT.Map.finalize().
//
// MAP SHAPE (all arrays are w*h, idx = cy*w + cx):
//   w, h, name, seed
//   terrain  Uint8Array   NT.TERRAIN code per cell
//   res      Uint16Array  resource left in the cell, in CREDITS (0 = none).
//                         Resource cells are passable but never buildable.
//   resCap   Uint16Array  the most a cell may regrow to (0 = never regrows)
//   pass     Uint8Array   1 = ground-passable terrain (derived by finalize)
//   speed    Float32Array terrain speed multiplier (derived by finalize)
//   blocks   [{x,y,w,h,style,height}]  solid city blocks (BLOCK terrain) — the
//                         renderer draws these as towers; sim only reads terrain
//   starts   [{cx,cy}]    one per player slot: TOP-LEFT cell where the starting
//                         HQ footprint goes (>= 8 clear buildable cells around)
//   neutrals [{def,cx,cy}] neutral "turf" structures to spawn (full def ids,
//                         e.g. 'neutral.storefront'), top-left cell
//   spawners [{cx,cy,radius,rate}] resource regrow sources: every cell within
//                         `radius` regrows toward resCap at `rate` credits/sec
//                         shared across the field
//   deco     [{type,x,y,rot,scale,seed}] render-only street furniture (world px)
// ============================================================================
NT.TERRAIN = { ROAD: 0, PAVE: 1, LOT: 2, RUBBLE: 3, WATER: 4, BLOCK: 5 };

// pass: ground units may enter · build: structures may be placed · speed: ground speed multiplier
NT.TERRAIN_INFO = [
  { key: 'road',   pass: true,  build: true,  speed: 1.0 },
  { key: 'pave',   pass: true,  build: true,  speed: 1.0 },
  { key: 'lot',    pass: true,  build: true,  speed: 0.9 },
  { key: 'rubble', pass: true,  build: false, speed: 0.6 },
  { key: 'water',  pass: false, build: false, speed: 0 },
  { key: 'block',  pass: false, build: false, speed: 0 },
];

NT.Map = {};

NT.Map.create = function (w, h, opts) {
  opts = opts || {};
  const n = w * h;
  return {
    w: w, h: h, name: opts.name || 'untitled', seed: (opts.seed >>> 0) || 1,
    terrain: new Uint8Array(n).fill(opts.fill === undefined ? NT.TERRAIN.PAVE : opts.fill),
    res: new Uint16Array(n), resCap: new Uint16Array(n),
    pass: new Uint8Array(n), speed: new Float32Array(n),
    blocks: [], starts: [], neutrals: [], spawners: [], deco: [],
  };
};

// Recompute derived arrays after terrain edits. Call once at the end of generation.
NT.Map.finalize = function (map) {
  const n = map.w * map.h, T = NT.TERRAIN_INFO;
  for (let i = 0; i < n; i++) {
    const t = T[map.terrain[i]] || T[0];
    map.pass[i] = t.pass ? 1 : 0;
    map.speed[i] = t.speed;
    if (!t.pass) { map.res[i] = 0; map.resCap[i] = 0; }
    else if (map.resCap[i] < map.res[i]) map.resCap[i] = map.res[i];
  }
  return map;
};

NT.Map.inBounds = function (map, cx, cy) { return cx >= 0 && cy >= 0 && cx < map.w && cy < map.h; };
NT.Map.idx = function (map, cx, cy) { return cy * map.w + cx; };
NT.Map.passable = function (map, cx, cy) {
  return cx >= 0 && cy >= 0 && cx < map.w && cy < map.h && map.pass[cy * map.w + cx] === 1;
};
// terrain allows a structure here (ignores entities — the sim checks occupancy)
NT.Map.buildableTerrain = function (map, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) return false;
  const i = cy * map.w + cx;
  return NT.TERRAIN_INFO[map.terrain[i]].build && map.res[i] === 0;
};

// ASCII maps for tests and hand-made layouts.
//   '.' pave   '=' road   ',' lot   '%' rubble   '~' water   '#' block
//   '$' resource (full cell, on lot)   '1'..'4' player start (top-left of HQ, on pave)
// opts.resAmount (default 600), opts.neutrals / opts.spawners passed through.
NT.Map.fromAscii = function (rows, opts) {
  opts = opts || {};
  const h = rows.length, w = rows[0].length;
  const map = NT.Map.create(w, h, opts);
  const T = NT.TERRAIN, amount = opts.resAmount || 600;
  const code = { '.': T.PAVE, '=': T.ROAD, ',': T.LOT, '%': T.RUBBLE, '~': T.WATER, '#': T.BLOCK, '$': T.LOT };
  const starts = [];
  for (let y = 0; y < h; y++) {
    NT.assert(rows[y].length === w, 'ascii map row ' + y + ' has the wrong width');
    for (let x = 0; x < w; x++) {
      const ch = rows[y][x], i = y * w + x;
      if (ch >= '1' && ch <= '4') { map.terrain[i] = T.PAVE; starts[+ch - 1] = { cx: x, cy: y }; continue; }
      NT.assert(code[ch] !== undefined, 'unknown ascii map char "' + ch + '"');
      map.terrain[i] = code[ch];
      if (ch === '$') { map.res[i] = amount; map.resCap[i] = amount; }
    }
  }
  for (let i = 0; i < starts.length; i++) NT.assert(starts[i], 'ascii map is missing start ' + (i + 1));
  map.starts = starts;
  if (opts.neutrals) map.neutrals = opts.neutrals.slice();
  if (opts.spawners) map.spawners = opts.spawners.slice();
  return NT.Map.finalize(map);
};

// Total resource left on the map (tests, AI planning).
NT.Map.totalRes = function (map) { let s = 0; for (let i = 0; i < map.res.length; i++) s += map.res[i]; return s; };
