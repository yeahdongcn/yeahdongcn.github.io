'use strict';
// NEON TURF — procedural map generator tests.
//   node rts/test/mapgen.test.js                 the suite (must stay green)
//   node rts/test/mapgen.test.js --seeds=200     more seeds per size (default 30)
//   node rts/test/mapgen.test.js --dump=<dir>    also write <dir>/<preset-id>.txt ASCII dumps
// Everything is re-derived from the finished map — the checks never look at
// generator internals, so they hold for any generator that honours the map spec.
const { NT, check, section, done } = require('./harness');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const T = NT.TERRAIN, INFO = NT.TERRAIN_INFO, G = NT.MapGen;
const SIZE_KEYS = ['small', 'medium', 'large'];
const arg = function (name, dflt) {
  const a = process.argv.find(function (s) { return s.indexOf('--' + name + '=') === 0; });
  return a ? a.slice(name.length + 3) : dflt;
};
const N_SEEDS = Math.max(25, +arg('seeds', 30));
const SEEDS = [];
for (let s = 1; s <= N_SEEDS; s++) SEEDS.push(s);
SEEDS.push(0xdeadbeef, 0xffffffff, 20771210);
const DECO_TYPES = ['lamp', 'wreck', 'dumpster', 'barrier', 'crate', 'vent', 'sign', 'puddle', 'manhole', 'crosswalk', 'planter'];

// ---------------------------------------------------------------------------
// helpers (independent re-implementations: the generator's own are private)
// ---------------------------------------------------------------------------
function fnv(h, bytes) { for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); } return h >>> 0; }
function lists(map) { return JSON.stringify([map.w, map.h, map.seed, map.blocks, map.starts, map.neutrals, map.spawners, map.deco]); }
function hashMap(map) {
  let h = 0x811c9dc5;
  for (const k of ['terrain', 'res', 'resCap', 'pass', 'speed']) h = fnv(h, new Uint8Array(map[k].buffer, map[k].byteOffset, map[k].byteLength));
  return fnv(h, Buffer.from(lists(map)));
}
function sameBytes(a, b) {
  return Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
}
// `--hash`: print one fingerprint of a fixed set of maps and exit (cross-process determinism check)
function fingerprint() {
  let h = 0;
  for (const size of SIZE_KEYS) for (const seed of [1, 7, 4242]) h = (Math.imul(h, 31) + hashMap(G.generate({ seed: seed, size: size, players: 2 }))) >>> 0;
  return h;
}
if (process.argv.indexOf('--hash') >= 0) { console.log(fingerprint()); process.exit(0); }

function defSize(id) {                        // works for the real catalogue and for the stand-in one
  if (NT.DEFS[id] && NT.DEFS[id].size) return NT.DEFS[id].size;
  const f = NT.FACTIONS.neutral;
  for (const k in (f ? f.buildings : {})) if (f.buildings[k].id === id) return f.buildings[k].size;
  return null;
}
function defMeta(id) {
  const f = NT.FACTIONS.neutral;
  for (const k in (f ? f.buildings : {})) if (f.buildings[k].id === id) return f.buildings[k].meta || {};
  return null;
}
// distance from a cell to a rect: [Chebyshev, Euclidean]
function cellDist(r, x, y) {
  const dx = Math.max(0, r.x - x, x - (r.x + r.w - 1)), dy = Math.max(0, r.y - y, y - (r.y + r.h - 1));
  return [Math.max(dx, dy), Math.hypot(dx, dy)];
}
function rectGap(a, b) {                      // Chebyshev distance between nearest cells (touching = 1, overlapping = 0)
  return Math.max(0, a.x - (b.x + b.w - 1), b.x - (a.x + a.w - 1), a.y - (b.y + b.h - 1), b.y - (a.y + a.h - 1));
}
function forRect(r, fn) { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) fn(x, y); }
function ringCells(map, r) {                  // null if part of the ring falls off the map
  const out = [];
  for (let y = r.y - 1; y <= r.y + r.h; y++) for (let x = r.x - 1; x <= r.x + r.w; x++) {
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) continue;
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return null;
    out.push(y * map.w + x);
  }
  return out;
}

// Derived facts shared by the checks.
function analyse(map) {
  const w = map.w, h = map.h, n = w * h;
  const pass = new Uint8Array(n), solid = new Uint8Array(n);
  for (let i = 0; i < n; i++) pass[i] = INFO[map.terrain[i]].pass ? 1 : 0;
  const hqs = map.starts.map(function (s) { return { x: s.cx, y: s.cy, w: 3, h: 3 }; });
  const turf = map.neutrals.map(function (nt) { const s = defSize(nt.def) || [1, 1]; return { def: nt.def, x: nt.cx, y: nt.cy, w: s[0], h: s[1] }; });
  for (const r of hqs.concat(turf)) forRect(r, function (x, y) { if (x >= 0 && y >= 0 && x < w && y < h) solid[y * w + x] = 1; });
  const open = new Uint8Array(n);             // passable with every building footprint closed
  for (let i = 0; i < n; i++) open[i] = pass[i] && !solid[i] ? 1 : 0;
  return { w: w, h: h, n: n, pass: pass, solid: solid, open: open, hqs: hqs, turf: turf };
}

const _q = new Int32Array(96 * 96), _prev = new Int32Array(96 * 96);
// 4-connected flood over open[] from src cells. Returns the reached mask, or — with `goal` — the first path found (or null).
function flood(a, open, src, goal) {
  const w = a.w, n = a.n, seen = new Uint8Array(n);
  let qh = 0, qt = 0;
  for (const s of src) if (open[s] && !seen[s]) { seen[s] = 1; _prev[s] = s; _q[qt++] = s; }
  while (qh < qt) {
    const i = _q[qh++];
    if (goal && goal[i]) {
      const p = [];
      for (let k = i; ; k = _prev[k]) { p.push(k); if (_prev[k] === k) break; }
      return p;
    }
    const x = i % w;
    if (x < w - 1 && open[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; _prev[i + 1] = i; _q[qt++] = i + 1; }
    if (i + w < n && open[i + w] && !seen[i + w]) { seen[i + w] = 1; _prev[i + w] = i; _q[qt++] = i + w; }
    if (x > 0 && open[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; _prev[i - 1] = i; _q[qt++] = i - 1; }
    if (i >= w && open[i - w] && !seen[i - w]) { seen[i - w] = 1; _prev[i - w] = i; _q[qt++] = i - w; }
  }
  return goal ? null : seen;
}
function maskOf(a, cells) { const m = new Uint8Array(a.n); for (const i of cells) m[i] = 1; return m; }

// 8-connected components of resource cells -> [{cells:[idx], kind, owner}]
function fieldsOf(map, a) {
  const w = a.w, seen = new Uint8Array(a.n), out = [];
  for (let i0 = 0; i0 < a.n; i0++) {
    if (!map.resCap[i0] || seen[i0]) continue;
    const cells = [], stack = [i0];
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i / w) | 0;
      cells.push(i);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, k = ny * w + nx;
        if (nx < 0 || ny < 0 || nx >= w || ny >= a.h || seen[k] || !map.resCap[k]) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    let sx = 0, sy = 0;
    const d = [1e9, 1e9], e = [1e9, 1e9];
    for (const i of cells) {
      const x = i % w, y = (i / w) | 0;
      sx += x; sy += y;
      for (let p = 0; p < 2; p++) { const cd = cellDist(a.hqs[p], x, y); d[p] = Math.min(d[p], cd[0]); e[p] = Math.min(e[p], cd[1]); }
    }
    const f = { cells: cells, cx: sx / cells.length, cy: sy / cells.length, cheb: d, eu: e, owner: d[0] <= d[1] ? 0 : 1 };
    f.kind = Math.min(d[0], d[1]) <= 9 ? 'home' : Math.hypot(f.cx - (w - 1) / 2, f.cy - (a.h - 1) / 2) <= 4 ? 'central' : 'expansion';
    out.push(f);
  }
  return out;
}

// Is there a 3x3 patch whose removal cuts every src -> dst walk? Only a patch touching one fixed
// src-dst path can do that, so (unless `brute`) only those are tried. Returns the patch or null.
function findCut(a, open, src, goal, brute) {
  const w = a.w, h = a.h;
  const base = flood(a, open, src, goal);
  if (!base) return { x: -1, y: -1 };
  const cand = new Set();
  if (brute) { for (let y = 0; y <= h - 3; y++) for (let x = 0; x <= w - 3; x++) cand.add(y * w + x); }
  else for (const i of base) {
    const px = i % w, py = (i / w) | 0;
    for (let oy = -2; oy <= 0; oy++) for (let ox = -2; ox <= 0; ox++) {
      const x = px + ox, y = py + oy;
      if (x >= 0 && y >= 0 && x <= w - 3 && y <= h - 3) cand.add(y * w + x);
    }
  }
  const work = Uint8Array.from(open);
  for (const p of cand) {
    const x0 = p % w, y0 = (p / w) | 0;
    for (let y = y0; y < y0 + 3; y++) for (let x = x0; x < x0 + 3; x++) work[y * w + x] = 0;
    const okPath = flood(a, work, src, goal);
    for (let y = y0; y < y0 + 3; y++) for (let x = x0; x < x0 + 3; x++) work[y * w + x] = open[y * w + x];
    if (!okPath) return { x: x0, y: y0 };
  }
  return null;
}

// Up to `want` start-to-start paths, each kept more than 2 cells (Chebyshev) from the others,
// so no 3x3 patch can touch two of them. Found greedily, then verified pairwise.
function separatedRoutes(a, src, goal, want) {
  const w = a.w, open = Uint8Array.from(a.open), paths = [];
  for (let k = 0; k < want; k++) {
    const p = flood(a, open, src, goal);
    if (!p) break;
    paths.push(p);
    for (const i of p) {
      const px = i % w, py = (i / w) | 0;
      for (let y = Math.max(0, py - 2); y <= Math.min(a.h - 1, py + 2); y++) for (let x = Math.max(0, px - 2); x <= Math.min(w - 1, px + 2); x++) open[y * w + x] = 0;
    }
  }
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) {
    for (const p of paths[i]) for (const q of paths[j]) {
      if (Math.max(Math.abs(p % w - q % w), Math.abs(((p / w) | 0) - ((q / w) | 0))) < 3) return [];
    }
  }
  for (const p of paths) {                    // each one really is a walk over open ground
    for (let k = 0; k < p.length; k++) {
      if (!a.open[p[k]]) return [];
      if (k && Math.abs(p[k] % w - p[k - 1] % w) + Math.abs(((p[k] / w) | 0) - ((p[k - 1] / w) | 0)) !== 1) return [];
    }
  }
  return paths;
}

// ---------------------------------------------------------------------------
// per-map checks: each returns '' or the first problem found
// ---------------------------------------------------------------------------
function chkShape(map, size) {
  const w = G.SIZES[size], n = w * w;
  if (map.w !== w || map.h !== w) return 'size ' + map.w + 'x' + map.h;
  if (!(map.terrain instanceof Uint8Array) || !(map.res instanceof Uint16Array) || !(map.resCap instanceof Uint16Array) ||
      !(map.pass instanceof Uint8Array) || !(map.speed instanceof Float32Array)) return 'typed arrays of the wrong type';
  for (const k of ['terrain', 'res', 'resCap', 'pass', 'speed']) if (map[k].length !== n) return k + ' has the wrong length';
  for (const k of ['blocks', 'starts', 'neutrals', 'spawners', 'deco']) if (!Array.isArray(map[k])) return k + ' is not a list';
  if (map.starts.length !== 2) return 'expected 2 starts';
  for (let i = 0; i < n; i++) {
    const t = INFO[map.terrain[i]];
    if (!t) return 'unknown terrain code at ' + i;
    if (map.pass[i] !== (t.pass ? 1 : 0) || map.speed[i] !== Math.fround(t.speed)) return 'not finalized at ' + i;
    if (map.res[i] !== map.resCap[i]) return 'res != resCap at ' + i;
    if (map.res[i] && map.terrain[i] !== T.LOT) return 'resource not on LOT at ' + i;
  }
  return '';
}

function chkSymmetry(map, a) {
  const n = a.n, w = a.w, h = a.h;
  for (let i = 0; i < n; i++) {
    const j = n - 1 - i;
    if (map.terrain[i] !== map.terrain[j]) return 'terrain differs at ' + (i % w) + ',' + ((i / w) | 0);
    if (map.res[i] !== map.res[j] || map.resCap[i] !== map.resCap[j]) return 'resources differ at ' + (i % w) + ',' + ((i / w) | 0);
  }
  const s = map.starts;
  if (s[1].cx !== w - 3 - s[0].cx || s[1].cy !== h - 3 - s[0].cy) return 'start 2 is not the mirror of start 1';
  const key = function (r) { return r.def + '@' + r.x + ',' + r.y; };
  const have = new Set(a.turf.map(key));
  if (have.size !== a.turf.length) return 'duplicate neutral';
  for (const r of a.turf) {
    const m = { def: r.def, x: w - r.x - r.w, y: h - r.y - r.h };
    if (m.x === r.x && m.y === r.y) continue;                       // self-symmetric at the exact centre
    if (!have.has(key(m))) return 'neutral ' + key(r) + ' has no mirror';
  }
  const sk = function (p) { return p.cx + ',' + p.cy + ',' + p.radius + ',' + p.rate; };
  const sp = new Set(map.spawners.map(sk));
  if (sp.size !== map.spawners.length) return 'duplicate spawner';
  for (const p of map.spawners) if (!sp.has(sk({ cx: w - 1 - p.cx, cy: h - 1 - p.cy, radius: p.radius, rate: p.rate }))) return 'spawner ' + sk(p) + ' has no mirror';
  const bk = function (b) { return [b.x, b.y, b.w, b.h, b.style, b.height].join(','); };
  const bs = new Set(map.blocks.map(bk));
  for (const b of map.blocks) if (!bs.has(bk({ x: w - b.x - b.w, y: h - b.y - b.h, w: b.w, h: b.h, style: b.style, height: b.height }))) return 'block ' + bk(b) + ' has no mirror';
  return '';
}

function chkConnected(map, a) {
  const hqCells = [];
  forRect(a.hqs[0], function (x, y) { hqCells.push(y * a.w + x); });
  const seen = flood(a, a.pass, hqCells, null);
  for (let i = 0; i < a.n; i++) if (a.pass[i] && !seen[i]) return 'passable cell ' + (i % a.w) + ',' + ((i / a.w) | 0) + ' is cut off';
  for (const r of a.hqs) { let bad = ''; forRect(r, function (x, y) { if (!seen[y * a.w + x]) bad = 'HQ cell ' + x + ',' + y + ' not in the component'; }); if (bad) return bad; }
  for (let i = 0; i < a.n; i++) if (map.res[i] && !seen[i]) return 'resource cell cut off';
  // with every building standing: still one piece, and it holds every turf ring and both HQ rings
  const ring0 = ringCells(map, a.hqs[0]);
  if (!ring0) return 'HQ ring leaves the map';
  const seen2 = flood(a, a.open, ring0, null);
  for (let i = 0; i < a.n; i++) if (a.open[i] && !seen2[i]) return 'cell ' + (i % a.w) + ',' + ((i / a.w) | 0) + ' is cut off once buildings stand';
  for (const r of a.turf.concat(a.hqs)) {
    const ring = ringCells(map, r);
    if (!ring) return 'ring leaves the map';
    for (const i of ring) if (!seen2[i]) return 'ring cell of ' + (r.def || 'HQ') + ' not in the component';
  }
  return '';
}

function chkStarts(map, a) {
  const w = a.w, h = a.h;
  for (let p = 0; p < 2; p++) {
    const r = a.hqs[p];
    if (r.x < 5 || r.y < 5 || r.x + 3 > w - 5 || r.y + 3 > h - 5) return 'start ' + (p + 1) + ' is closer than 5 cells to an edge';
    // an 18x16 (or 16x18) rect around the footprint: PAVE / LOT / ROAD, no resources
    let found = false;
    for (const dim of [[18, 16], [16, 18]]) {
      for (let y0 = r.y + 3 - dim[1]; y0 <= r.y && !found; y0++) for (let x0 = r.x + 3 - dim[0]; x0 <= r.x && !found; x0++) {
        if (x0 < 0 || y0 < 0 || x0 + dim[0] > w || y0 + dim[1] > h) continue;
        let ok = true;
        for (let y = y0; y < y0 + dim[1] && ok; y++) for (let x = x0; x < x0 + dim[0] && ok; x++) {
          const t = map.terrain[y * w + x];
          ok = (t === T.PAVE || t === T.LOT || t === T.ROAD) && map.res[y * w + x] === 0 && NT.Map.buildableTerrain(map, x, y);
        }
        found = ok;
      }
    }
    if (!found) return 'start ' + (p + 1) + ' has no clear 18x16 yard';
    for (const nt of a.turf) if (rectGap(nt, r) < 12) return 'turf inside the yard of start ' + (p + 1);
  }
  return '';
}

function hasDropoffRoom(map, a, f) {            // a buildable 3x3 touching the field
  const w = a.w, inField = maskOf(a, f.cells);
  for (const i of f.cells) {
    const fx = i % w, fy = (i / w) | 0;
    for (let y0 = fy - 3; y0 <= fy + 1; y0++) for (let x0 = fx - 3; x0 <= fx + 1; x0++) {
      let ok = true;
      for (let y = y0; y < y0 + 3 && ok; y++) for (let x = x0; x < x0 + 3 && ok; x++) {
        ok = NT.Map.buildableTerrain(map, x, y) && !inField[y * w + x] && !a.solid[y * w + x];
      }
      if (ok) return true;
    }
  }
  return false;
}
function chkFields(map, a, size) {
  const w = a.w, fields = fieldsOf(map, a);
  const by = function (kind, owner) { return fields.filter(function (f) { return f.kind === kind && (owner === undefined || f.owner === owner); }); };
  for (let p = 0; p < 2; p++) {
    const home = by('home', p), exp = by('expansion', p);
    if (home.length !== 1) return 'player ' + (p + 1) + ' has ' + home.length + ' home fields';
    if (exp.length !== 1) return 'player ' + (p + 1) + ' has ' + exp.length + ' expansion fields';
    const hf = home[0], ef = exp[0];
    if (hf.cells.length < 14 || hf.cells.length > 18) return 'home field of ' + hf.cells.length + ' cells';
    if (ef.cells.length < 10 || ef.cells.length > 12) return 'expansion field of ' + ef.cells.length + ' cells';
    for (const i of hf.cells.concat(ef.cells)) if (map.res[i] !== 700) return 'home/expansion cell holds ' + map.res[i];
    if (hf.cheb[p] < 6 || hf.eu[p] > 9.001) return 'home field ' + hf.cheb[p] + '/' + hf.eu[p].toFixed(1) + ' cells from its HQ (want 6-9)';
    if (ef.cheb[p] < 14 || ef.eu[p] > 22.001) return 'expansion ' + ef.cheb[p] + '/' + ef.eu[p].toFixed(1) + ' cells from its HQ (want 14-22)';
    if (ef.eu[1 - p] <= ef.eu[p]) return 'expansion is nearer to the enemy';
    // compact: the field fits a 5x5 box and fills most of its bounding box
    for (const f of [hf, ef]) {
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (const i of f.cells) { x0 = Math.min(x0, i % w); x1 = Math.max(x1, i % w); y0 = Math.min(y0, (i / w) | 0); y1 = Math.max(y1, (i / w) | 0); }
      if (x1 - x0 > 4 || y1 - y0 > 4 || f.cells.length < 0.6 * (x1 - x0 + 1) * (y1 - y0 + 1)) return f.kind + ' field is not a compact blob';
      if (!hasDropoffRoom(map, a, f)) return f.kind + ' field has no room for a 3x3 drop-off';
    }
    // clear ground between HQ and home field: the straight walk to its nearest cell is buildable
    let best = -1, bd = 1e9;
    for (const i of hf.cells) { const d = cellDist(a.hqs[p], i % w, (i / w) | 0); if (d[1] < bd) { bd = d[1]; best = i; } }
    const hq = a.hqs[p], tx = best % w, ty = (best / w) | 0;
    const sx = NT.clamp(tx, hq.x, hq.x + 2), sy = NT.clamp(ty, hq.y, hq.y + 2), steps = Math.max(Math.abs(tx - sx), Math.abs(ty - sy));
    for (let k = 1; k < steps; k++) {
      const x = Math.round(sx + (tx - sx) * k / steps), y = Math.round(sy + (ty - sy) * k / steps);
      if (!NT.Map.buildableTerrain(map, x, y)) return 'ground between HQ ' + (p + 1) + ' and its field is not clear at ' + x + ',' + y;
    }
  }
  const central = by('central');
  if (central.length < 1) return 'no central field';
  let nCentral = 0;
  const cmask = new Uint8Array(a.n);
  for (const f of central) for (const i of f.cells) { nCentral++; cmask[i] = 1; if (map.res[i] !== 900) return 'central cell holds ' + map.res[i]; }
  if (nCentral < 18 || nCentral > 24) return 'central field(s) of ' + nCentral + ' cells';
  for (let i = 0; i < a.n; i++) if (cmask[i] !== cmask[a.n - 1 - i]) return 'central field is not symmetric';
  for (const f of central) if (!hasDropoffRoom(map, a, f)) return 'central field has no room for a 3x3 drop-off';
  if (fields.length !== 4 + central.length) return 'unexpected extra fields (' + fields.length + ')';

  // spawners: one per field at its centre (the central one may be a mirrored pair sharing the rate)
  const covers = function (s, i) { return Math.hypot(i % w - s.cx, ((i / w) | 0) - s.cy) <= s.radius + 1e-9; };
  const usedBy = new Map();
  for (const f of fields) {
    const mine = map.spawners.filter(function (s) { return f.cells.some(function (i) { return covers(s, i); }); });
    let rate = 0;
    for (const s of mine) {
      if (usedBy.has(s) && usedBy.get(s) !== f) return 'a spawner feeds two fields';
      usedBy.set(s, f);
      if (!f.cells.every(function (i) { return covers(s, i); })) return 'spawner misses part of its ' + f.kind + ' field';
      if (Math.hypot(s.cx - f.cx, s.cy - f.cy) > 1.5) return 'spawner is not at the centre of its ' + f.kind + ' field';
      rate += s.rate;
    }
    if (f.kind === 'central') { if (mine.length < 1 || mine.length > 2 || rate !== 6) return 'central field regrows at ' + rate + '/s from ' + mine.length + ' spawner(s)'; }
    else if (mine.length !== 1 || rate !== 3) return f.kind + ' field regrows at ' + rate + '/s from ' + mine.length + ' spawner(s)';
  }
  for (const s of map.spawners) {
    if (!usedBy.has(s)) return 'spawner without a field';
    if (!Number.isInteger(s.cx) || !Number.isInteger(s.cy) || !(s.radius > 0) || !NT.Map.inBounds(map, s.cx, s.cy)) return 'malformed spawner';
  }
  const total = NT.Map.totalRes(map);
  if (total < 49000 || total > 75000) return 'total resources ' + total;
  if (size === 'medium' && total < 55000) return 'medium map holds only ' + total + ' credits (want 55-75k)';
  return '';
}

function chkFabric(map, a) {
  const w = a.w, h = a.h;
  // blocks <-> BLOCK terrain, exactly
  const own = new Uint8Array(a.n);
  for (const b of map.blocks) {
    if (b.w < 3 || b.w > 8 || b.h < 3 || b.h > 8) return 'block of ' + b.w + 'x' + b.h;
    if (!Number.isInteger(b.style) || b.style < 0 || b.style > 5) return 'block style ' + b.style;
    if (!(b.height >= 14 && b.height <= 40)) return 'block height ' + b.height;
    if (b.x < 0 || b.y < 0 || b.x + b.w > w || b.y + b.h > h) return 'block off the map';
    let bad = '';
    forRect(b, function (x, y) { const i = y * w + x; if (own[i]) bad = 'blocks overlap at ' + x + ',' + y; if (map.terrain[i] !== T.BLOCK) bad = 'block cell ' + x + ',' + y + ' is not BLOCK terrain'; own[i] = 1; });
    if (bad) return bad;
  }
  for (let i = 0; i < a.n; i++) if (map.terrain[i] === T.BLOCK && !own[i]) return 'BLOCK cell ' + (i % w) + ',' + ((i / w) | 0) + ' belongs to no block';
  // mid-map = farther than 12 cells from both HQs
  let mid = 0, blk = 0, rub = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (Math.min(cellDist(a.hqs[0], x, y)[0], cellDist(a.hqs[1], x, y)[0]) <= 12) continue;
    mid++; if (map.terrain[y * w + x] === T.BLOCK) blk++; else if (map.terrain[y * w + x] === T.RUBBLE) rub++;
  }
  a.blockShare = blk / mid; a.rubbleShare = rub / mid;
  if (a.blockShare < 0.2 || a.blockShare > 0.35) return 'mid-map is ' + (100 * a.blockShare).toFixed(1) + '% BLOCK (want 20-35%)';
  if (a.rubbleShare > 0.08) return 'mid-map is ' + (100 * a.rubbleShare).toFixed(1) + '% RUBBLE (ruins are an accent: want <= 8%)';
  return '';
}

// ROAD is 2-3 cells wide: no single-row slivers, no fields of asphalt, no stray patches.
function chkRoads(map, a) {
  const w = a.w, h = a.h, t = map.terrain, R = T.ROAD;
  const square = function (x, y, k) {            // all-ROAD k x k square with its top-left cell at (x, y)?
    if (x < 0 || y < 0 || x + k > w || y + k > h) return false;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) if (t[(y + dy) * w + x + dx] !== R) return false;
    return true;
  };
  // a bridge may be 4 wide, so the only 4x4 of asphalt allowed is one that lies on a canal crossing
  const wetRow = new Uint8Array(h), wetCol = new Uint8Array(w);
  let nRow = 0, nCol = 0;
  for (let i = 0; i < a.n; i++) if (t[i] === T.WATER) { wetRow[(i / w) | 0] = 1; wetCol[i % w] = 1; }
  for (let k = 0; k < h; k++) nRow += wetRow[k];
  for (let k = 0; k < w; k++) nCol += wetCol[k];
  const onCrossing = function (x, y) {
    for (let d = 0; d < 4; d++) if (nRow && nRow <= nCol ? wetRow[y + d] : nCol && wetCol[x + d]) return true;
    return false;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (t[y * w + x] !== R) continue;
    if (!square(x, y, 2) && !square(x - 1, y, 2) && !square(x, y - 1, 2) && !square(x - 1, y - 1, 2)) return 'road cell ' + x + ',' + y + ' is in a 1-wide sliver';
    if (square(x, y, 5)) return 'a 5x5 field of asphalt at ' + x + ',' + y;
    if (square(x, y, 4) && !onCrossing(x, y)) return 'the road is 4 wide at ' + x + ',' + y + ', away from any bridge';
  }
  // every stretch of road is a real street: connected pieces of at least 16 cells
  const seen = new Uint8Array(a.n);
  for (let i0 = 0; i0 < a.n; i0++) {
    if (t[i0] !== R || seen[i0]) continue;
    const stack = [i0];
    let size = 0;
    seen[i0] = 1;
    while (stack.length) {
      const i = stack.pop(), x = i % w;
      size++;
      for (const k of [x < w - 1 ? i + 1 : -1, i + w < a.n ? i + w : -1, x > 0 ? i - 1 : -1, i - w]) if (k >= 0 && t[k] === R && !seen[k]) { seen[k] = 1; stack.push(k); }
    }
    if (size < 16) return 'a stray ' + size + '-cell patch of road at ' + (i0 % w) + ',' + ((i0 / w) | 0);
  }
  return '';
}

function chkWidth(map, a) {
  const w = a.w, h = a.h, p = a.pass;
  const inSquare = function (x, y) { return x >= 0 && y >= 0 && x < w - 1 && y < h - 1 && p[y * w + x] && p[y * w + x + 1] && p[(y + 1) * w + x] && p[(y + 1) * w + x + 1]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (p[y * w + x] && !inSquare(x, y) && !inSquare(x - 1, y) && !inSquare(x, y - 1) && !inSquare(x - 1, y - 1)) return 'cell ' + x + ',' + y + ' is in a 1-wide passage';
  }
  // stronger: a 2x2 body walking from the HQ sweeps over every passable cell
  const fat = new Uint8Array(a.n), swept = new Uint8Array(a.n);
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) if (inSquare(x, y)) fat[y * w + x] = 1;
  const start = a.hqs[0].y * w + a.hqs[0].x;
  if (!fat[start]) return 'HQ does not stand on open ground';
  const reach = flood(a, fat, [start], null);
  for (let i = 0; i < a.n; i++) if (reach[i]) swept[i] = swept[i + 1] = swept[i + w] = swept[i + w + 1] = 1;
  for (let i = 0; i < a.n; i++) if (p[i] && !swept[i]) return 'a 2x2 body cannot reach ' + (i % w) + ',' + ((i / w) | 0);
  return '';
}

function chkRoutes(map, a, brute) {
  const src = ringCells(map, a.hqs[0]), dst = ringCells(map, a.hqs[1]);
  if (!src || !dst) return 'HQ ring leaves the map';
  const goal = maskOf(a, dst);
  // buildings standing (the real game) and bare terrain (the letter of the spec)
  for (const open of [a.open, a.pass]) {
    const cut = findCut(a, open, src, goal, brute);
    if (cut) return cut.x < 0 ? 'the starts are not connected' : 'the 3x3 patch at ' + cut.x + ',' + cut.y + ' cuts the bases apart';
  }
  a.routes = separatedRoutes(a, src, goal, 3).length;
  if (a.routes < 3) return 'only ' + a.routes + ' separated route(s) between the bases';
  return '';
}

function chkNeutrals(map, a) {
  const w = a.w, h = a.h, cx = (w - 1) / 2, cy = (h - 1) / 2;
  let central = 0, side = 0;
  const foot = new Int16Array(a.n);
  a.turf.forEach(function (r, k) { forRect(r, function (x, y) { if (x >= 0 && y >= 0 && x < w && y < h) foot[y * w + x] = foot[y * w + x] ? -1 : k + 1; }); });
  for (let k = 0; k < a.turf.length; k++) {
    const r = a.turf[k], meta = defMeta(r.def);
    if (!meta) return r.def + ' is not a neutral building';
    if (!(meta.mapWeight > 0)) return r.def + ' has no mapWeight but was placed';
    if (r.x < 0 || r.y < 0 || r.x + r.w > w || r.y + r.h > h) return r.def + ' leaves the map';
    let bad = '';
    forRect(r, function (x, y) {
      if (!NT.Map.buildableTerrain(map, x, y)) bad = r.def + ' stands on unbuildable ground at ' + x + ',' + y;
      if (foot[y * w + x] === -1) bad = r.def + ' overlaps another structure';
    });
    if (bad) return bad;
    const ring = ringCells(map, r);
    if (!ring) return r.def + ' touches the map edge (no ring)';
    for (const i of ring) {
      if (!a.pass[i]) return r.def + ' ring blocked at ' + (i % w) + ',' + ((i / w) | 0);
      if (map.res[i]) return r.def + ' ring holds resources';
      if (foot[i]) return r.def + ' ring runs into another structure';
    }
    for (const hq of a.hqs) if (rectGap(r, hq) < 12) return r.def + ' is ' + rectGap(r, hq) + ' cells from an HQ (want >= 12)';
    const dc = Math.max(Math.abs(r.x + (r.w - 1) / 2 - cx), Math.abs(r.y + (r.h - 1) / 2 - cy));
    if (meta.central) { central++; if (dc > 12) return r.def + ' is a central def placed ' + dc + ' cells from the centre'; }
    else side++;
  }
  a.nCentral = central; a.nSide = side;
  return '';
}

function chkCanal(map, a) {
  const w = a.w, h = a.h;
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let i = 0; i < a.n; i++) if (map.terrain[i] === T.WATER) { n++; x0 = Math.min(x0, i % w); x1 = Math.max(x1, i % w); y0 = Math.min(y0, (i / w) | 0); y1 = Math.max(y1, (i / w) | 0); }
  a.canal = n > 0;
  if (!n) return '';
  const horiz = x1 - x0 > y1 - y0, wide = horiz ? y1 - y0 + 1 : x1 - x0 + 1, len = horiz ? w : h;
  if (wide < 2 || wide > 3) return 'canal is ' + wide + ' cells wide';
  if ((horiz ? x0 : y0) !== 0 || (horiz ? x1 : y1) !== len - 1) return 'canal does not cross the whole map';
  const runs = [];                              // crossings: stretches where the whole width is dry
  let run = null;
  for (let t = 0; t < len; t++) {
    let wet = 0, road = 0;
    for (let k = 0; k < wide; k++) {
      const i = horiz ? (y0 + k) * w + t : t * w + x0 + k;
      if (map.terrain[i] === T.WATER) wet++; else if (!a.pass[i]) return 'canal crossing is blocked'; else if (map.terrain[i] === T.ROAD) road++;
    }
    if (wet && wet !== wide) return 'ragged canal at ' + t;
    if (!wet) { if (!run) runs.push(run = { len: 0, road: true }); run.len++; if (road !== wide) run.road = false; } else run = null;
  }
  a.crossings = runs.length;
  if (runs.length < 2 || runs.length > 4) return runs.length + ' canal crossings (want 2-4)';
  for (const r of runs) if (r.len < 3) return 'a canal crossing is only ' + r.len + ' wide';
  if (runs.filter(function (r) { return r.road; }).length < 2) return 'fewer than 2 ROAD bridges';
  return '';
}

function chkDeco(map, a, size) {
  const w = a.w, px = w * NT.TILE, lim = { small: [150, 260], medium: [200, 340], large: [260, 400] }[size];
  if (map.deco.length < lim[0] || map.deco.length > lim[1]) return map.deco.length + ' deco items (want ' + lim[0] + '-' + lim[1] + ' on a ' + size + ' map)';
  const cellAt = function (d) { return NT.clamp(Math.floor(d.y / NT.TILE), 0, a.h - 1) * w + NT.clamp(Math.floor(d.x / NT.TILE), 0, w - 1); };
  for (const d of map.deco) {
    if (DECO_TYPES.indexOf(d.type) < 0) return 'unknown deco type ' + d.type;
    if (!(d.x >= 0 && d.x <= px && d.y >= 0 && d.y <= px)) return d.type + ' off the map';
    if (!Number.isFinite(d.rot) || !(d.scale > 0) || !Number.isInteger(d.seed)) return d.type + ' has a malformed rot / scale / seed';
    const t = map.terrain[cellAt(d)];
    if (d.type === 'sign') {
      const onEdge = map.blocks.some(function (b) {
        const bx0 = b.x * NT.TILE, by0 = b.y * NT.TILE, bx1 = (b.x + b.w) * NT.TILE, by1 = (b.y + b.h) * NT.TILE;
        return d.x >= bx0 && d.x <= bx1 && d.y >= by0 && d.y <= by1 && (d.x === bx0 || d.x === bx1 || d.y === by0 || d.y === by1);
      });
      if (!onEdge) return 'sign is not on a block edge';
      continue;
    }
    if (t === T.BLOCK || t === T.WATER) return d.type + ' stands inside a ' + INFO[t].key;
    if ((d.type === 'lamp' || d.type === 'crosswalk' || d.type === 'manhole') && t !== T.ROAD) return d.type + ' is not on a road';
    if (d.type === 'planter' && t !== T.PAVE) return 'planter is not on a plaza';
    if (map.res[cellAt(d)]) return d.type + ' sits on a resource cell';
  }
  return '';
}

function placement(map) {
  const s = map.starts, dx = Math.abs(s[0].cx - s[1].cx), dy = Math.abs(s[0].cy - s[1].cy);
  return Math.min(dx, dy) > 0.4 * map.w ? 'diagonal' : dx > dy ? 'left-right' : 'top-bottom';
}

// ---------------------------------------------------------------------------
section('api');
{
  const t0 = process.hrtime.bigint();
  G.generate({ seed: 1, size: 'large', players: 2 });
  console.log('  cold start: the first large map of this process took ' + (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1) + ' ms (not asserted: JIT + machine load)');
  check(G && G.SIZES.small === 64 && G.SIZES.medium === 80 && G.SIZES.large === 96, 'NT.MapGen.SIZES = 64 / 80 / 96');
  check(typeof G.generate === 'function' && typeof G.fromPreset === 'function' && typeof G.ascii === 'function', 'generate / fromPreset / ascii exist');
  const bad = function (opts) { try { G.generate(opts); return false; } catch (e) { return true; } };
  check(bad({ seed: 1, size: 'huge' }), 'unknown size is rejected');
  check(bad({ seed: 1, size: 'small', players: 3 }), 'player counts other than 2 are rejected');
  const d = G.generate({ seed: 5 });
  check(d.w === 80 && d.seed === 5, 'size defaults to medium, map.seed = opts.seed');
  check(sameBytes(G.generate({ seed: 0, size: 'small' }).terrain, G.generate({ seed: 0, size: 'small' }).terrain), 'seed 0 is usable');
}

// ---------------------------------------------------------------------------
const tally = {};
for (const size of SIZE_KEYS) {
  section('generate: ' + size + ' x ' + SEEDS.length + ' seeds');
  const t = tally[size] = { ms: [], share: [], rubble: [], res: [], deco: [], neutrals: [], place: {}, canals: 0, terrain: new Set(), decoTypes: new Set(), hashes: new Set() };
  for (const seed of SEEDS) {
    const tag = size + ' #' + seed + ': ';
    let map, best = 1e9;
    // the fastest run is the generator's own cost, anything slower is GC or a busy machine: retry before blaming it
    for (let k = 0; k < 6 && (k < 2 || best >= 50); k++) {
      const t0 = process.hrtime.bigint();
      map = G.generate({ seed: seed, size: size, players: 2 });
      best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
    }
    t.ms.push(best);
    check(best < 50, tag + 'generated in ' + best.toFixed(1) + ' ms (want < 50)');

    const again = G.generate({ seed: seed, size: size, players: 2 });
    check(['terrain', 'res', 'resCap', 'pass', 'speed'].every(function (k) { return sameBytes(map[k], again[k]); }) && lists(map) === lists(again) && map.name === again.name,
      tag + 'two generate() calls give the same map');

    let why = chkShape(map, size);
    check(!why, tag + 'shape: ' + why);
    if (why) continue;
    const a = analyse(map);
    const run = function (name, fn) { const msg = fn(); check(!msg, tag + name + ': ' + msg); };
    run('symmetry', function () { return chkSymmetry(map, a); });
    run('connectivity', function () { return chkConnected(map, a); });
    run('starts', function () { return chkStarts(map, a); });
    run('fields', function () { return chkFields(map, a, size); });
    run('city fabric', function () { return chkFabric(map, a); });
    run('roads', function () { return chkRoads(map, a); });
    run('passage width', function () { return chkWidth(map, a); });
    run('routes', function () { return chkRoutes(map, a, seed <= 2); });
    run('neutrals', function () { return chkNeutrals(map, a); });
    check(a.nSide % 2 === 0 && a.nSide / 2 >= 3 && a.nSide / 2 <= 5, tag + 'turf per side = ' + a.nSide / 2 + ' (want 3-5)');
    check(a.nCentral >= 1 && a.nCentral <= 2, tag + 'turf near the centre = ' + a.nCentral + ' (want 1-2)');
    run('canal', function () { return chkCanal(map, a); });
    run('deco', function () { return chkDeco(map, a, size); });

    t.share.push(a.blockShare); t.rubble.push(a.rubbleShare); t.res.push(NT.Map.totalRes(map)); t.deco.push(map.deco.length); t.neutrals.push(map.neutrals.length);
    t.place[placement(map)] = (t.place[placement(map)] || 0) + 1;
    if (a.canal) t.canals++;
    for (let i = 0; i < a.n; i++) if (Math.min(cellDist(a.hqs[0], i % a.w, (i / a.w) | 0)[0], cellDist(a.hqs[1], i % a.w, (i / a.w) | 0)[0]) > 12) t.terrain.add(map.terrain[i]);
    for (const d of map.deco) t.decoTypes.add(d.type);
    t.hashes.add(hashMap(map));
  }
  const avg = function (l) { return l.reduce(function (s, v) { return s + v; }, 0) / l.length; };
  const span = function (l, f) { return (f || String)(Math.min.apply(null, l)) + '..' + (f || String)(Math.max.apply(null, l)); };
  const pct = function (v) { return (100 * v).toFixed(1) + '%'; };
  console.log('  time ' + avg(t.ms).toFixed(2) + ' ms avg, ' + Math.max.apply(null, t.ms).toFixed(1) + ' ms worst · mid-map BLOCK ' + span(t.share, pct) + ', RUBBLE ' + span(t.rubble, pct) +
    ' · credits ' + span(t.res) + ' · neutrals ' + span(t.neutrals) + ' · deco ' + span(t.deco));
  console.log('  placement ' + JSON.stringify(t.place) + ' · canals ' + t.canals + '/' + SEEDS.length);
  check(t.hashes.size === SEEDS.length, size + ': every seed gives a different map (' + t.hashes.size + '/' + SEEDS.length + ')');
  check(t.place.diagonal > 0 && t.place['left-right'] > 0 && t.place['top-bottom'] > 0, size + ': base placement varies by seed ' + JSON.stringify(t.place));
  check(t.canals > 0 && t.canals < SEEDS.length, size + ': some seeds have a canal, some do not (' + t.canals + ')');
  check([T.ROAD, T.PAVE, T.LOT, T.RUBBLE, T.BLOCK].every(function (k) { return t.terrain.has(k); }), size + ': streets, plazas, parking lots, rubble and towers all occur in the mid-map');
  check(DECO_TYPES.every(function (k) { return t.decoTypes.has(k); }), size + ': every deco type is used (' + DECO_TYPES.filter(function (k) { return !t.decoTypes.has(k); }).join(', ') + ' missing)');
}
check(tally.small.deco.every(function (v, i) { return v < tally.medium.deco[i] && tally.medium.deco[i] < tally.large.deco[i]; }), 'deco count grows with map size');
console.log('\n  retries: ' + JSON.stringify(G.stats));
check(G.stats.attempts < G.stats.maps * 1.25, 'layouts rarely need a retry (' + G.stats.attempts + ' attempts for ' + G.stats.maps + ' maps)');

// ---------------------------------------------------------------------------
section('determinism: no hidden randomness, same result in a fresh process');
{
  const realRandom = Math.random, realNow = Date.now;
  let touched = false;
  Math.random = function () { touched = true; return 0.5; };
  Date.now = function () { touched = true; return 0; };
  const mine = fingerprint();
  Math.random = realRandom; Date.now = realNow;
  check(!touched, 'generation never calls Math.random or Date.now');
  const theirs = +execFileSync(process.execPath, [__filename, '--hash'], { encoding: 'utf8' }).trim();
  check(mine === theirs, 'a fresh process generates byte-identical maps (' + mine + ' vs ' + theirs + ')');
  const a = G.generate({ seed: 11, size: 'small' });
  G.generate({ seed: 12, size: 'large' });        // an unrelated call in between must not leak state
  check(hashMap(a) === hashMap(G.generate({ seed: 11, size: 'small' })), 'results do not depend on call history');
  check(hashMap(G.generate({ seed: 11, size: 'small' })) !== hashMap(G.generate({ seed: 11, size: 'medium' })), 'size changes the map');
}

// ---------------------------------------------------------------------------
section('turf is picked by weight, never by key');
{
  const neutral = NT.FACTIONS.neutral, real = neutral.buildings;
  const fake = function (key, size, meta) { return { id: 'neutral.' + key, key: key, size: size, meta: meta }; };
  neutral.buildings = {
    zzcommon: fake('zzcommon', [2, 2], { mapWeight: 9 }),
    aararity: fake('aararity', [2, 2], { mapWeight: 1 }),
    never: fake('never', [2, 2], { mapWeight: 0 }),
    unlisted: fake('unlisted', [2, 2]),
    wide: fake('wide', [4, 2], { mapWeight: 3 }),
    hub: fake('hub', [2, 3], { mapWeight: 1, central: true }),
  };
  const count = {};
  let problems = '', hubOk = true, pairs = true;
  for (let seed = 1; seed <= 40; seed++) {
    const map = G.generate({ seed: seed, size: 'medium' }), a = analyse(map);
    problems = problems || chkSymmetry(map, a) || chkConnected(map, a) || chkNeutrals(map, a) || chkRoutes(map, a, false) || chkFields(map, a, 'medium') || chkRoads(map, a);
    for (const nt of map.neutrals) count[nt.def] = (count[nt.def] || 0) + 1;
    hubOk = hubOk && a.nCentral === 2;
    pairs = pairs && a.nSide / 2 >= 3 && a.nSide / 2 <= 5;
  }
  check(!problems, 'maps stay valid with a different turf catalogue: ' + problems);
  check(Object.keys(count).every(function (k) { return /^neutral\.(zzcommon|aararity|wide|hub)$/.test(k); }), 'only catalogue entries with a weight are placed: ' + JSON.stringify(count));
  check(!count['neutral.never'] && !count['neutral.unlisted'], 'weight 0 / no weight is never placed');
  check(count['neutral.zzcommon'] > 4 * (count['neutral.aararity'] || 0) && count['neutral.aararity'] > 0, 'frequency follows mapWeight: ' + JSON.stringify(count));
  check(count['neutral.wide'] > count['neutral.aararity'], 'a 4x2 footprint with weight 3 beats a 2x2 with weight 1');
  check(hubOk && count['neutral.hub'] === 80, 'the central def appears as one mirrored pair near the centre, nowhere else');
  check(pairs, '3-5 side structures per player with the stand-in catalogue');

  neutral.buildings = { solo: fake('solo', [2, 2], { mapWeight: 1 }) };
  const one = G.generate({ seed: 3, size: 'medium' }), a1 = analyse(one);
  check(one.neutrals.every(function (nt) { return nt.def === 'neutral.solo'; }) && one.neutrals.length >= 8 && !chkNeutrals(one, a1) && !chkSymmetry(one, a1),
    'with no central def the centre slots fall back to an ordinary one');

  neutral.buildings = {};
  const none = G.generate({ seed: 3, size: 'medium' });
  check(none.neutrals.length === 0 && !chkConnected(none, analyse(none)) && !chkFields(none, analyse(none), 'medium'), 'an empty catalogue gives a valid map without turf');
  delete NT.FACTIONS.neutral;
  let survived = true;
  try { survived = G.generate({ seed: 3, size: 'small' }).neutrals.length === 0; } catch (e) { survived = false; }
  check(survived, 'no neutral faction at all: still generates');
  NT.FACTIONS.neutral = neutral; neutral.buildings = real;

  // the real catalogue: commoner defs show up more often
  const seen = {};
  for (let seed = 1; seed <= 60; seed++) for (const nt of G.generate({ seed: seed, size: 'medium' }).neutrals) seen[nt.def] = (seen[nt.def] || 0) + 1;
  const all = Object.keys(real).map(function (k) { return real[k]; });
  const ids = all.filter(function (d) { return d.meta.mapWeight > 0 && !d.meta.central; });
  const heavy = ids.reduce(function (m, d) { return d.meta.mapWeight > m.meta.mapWeight ? d : m; }), light = ids.reduce(function (m, d) { return d.meta.mapWeight < m.meta.mapWeight ? d : m; });
  check(ids.length > 0 && ids.every(function (d) { return seen[d.id] > 0; }), 'every weighted neutral def gets placed over 60 maps');
  check(all.every(function (d) { return d.meta.mapWeight > 0 || !seen[d.id]; }), 'defs without a positive mapWeight stay off the map');
  check(heavy.meta.mapWeight === light.meta.mapWeight || seen[heavy.id] > seen[light.id], 'heaviest def (' + heavy.id + ' x' + seen[heavy.id] + ') outnumbers the lightest (' + light.id + ' x' + seen[light.id] + ')');
  check(Object.keys(seen).every(function (id) { return NT.DEFS[id] && NT.DEFS[id].faction === 'neutral'; }), 'map.neutrals holds full ids of neutral defs');
}

// ---------------------------------------------------------------------------
section('presets');
{
  check(Array.isArray(NT.MAPS) && NT.MAPS.length === 4, 'NT.MAPS lists 4 presets');
  check(new Set(NT.MAPS.map(function (p) { return p.id; })).size === NT.MAPS.length, 'preset ids are unique');
  check(new Set(NT.MAPS.map(function (p) { return p.size; })).size === 3, 'presets cover all three sizes');
  const dumpDir = arg('dump', '');
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true });
  const kinds = new Set();
  for (const p of NT.MAPS) {
    const tag = 'preset ' + p.id + ': ';
    check(/^[a-z][a-z0-9-]*$/.test(p.id) && p.players === 2 && G.SIZES[p.size] && Number.isInteger(p.seed) && p.seed > 0, tag + 'well-formed entry');
    check(p.name && p.name.en && p.name.zh && p.desc && p.desc.en && p.desc.zh && /[一-鿿]/.test(p.name.zh) && /[一-鿿]/.test(p.desc.zh), tag + 'bilingual name and description');
    check(p.desc && p.desc.en.length > 40 && p.desc.zh.length > 15 && !/todo|lorem/i.test(p.desc.en + p.desc.zh), tag + 'the description is real text');
    const map = G.fromPreset(p.id), a = analyse(map);
    check(map.name === p.id, tag + 'map.name is the preset id');
    check(hashMap(map) === hashMap(G.generate({ seed: p.seed, size: p.size, players: 2 })), tag + 'same data as generate(seed, size)');
    const why = chkShape(map, p.size) || chkSymmetry(map, a) || chkConnected(map, a) || chkStarts(map, a) || chkFields(map, a, p.size) || chkFabric(map, a) || chkRoads(map, a) ||
      chkWidth(map, a) || chkRoutes(map, a, true) || chkNeutrals(map, a) || chkCanal(map, a) || chkDeco(map, a, p.size);
    check(!why, tag + 'passes every map check (3x3-cut by brute force): ' + why);
    kinds.add(placement(map) + (a.canal ? '+canal' : ''));

    // the dump: fromAscii legend + T + 1/2, and it loads back
    const text = G.ascii(map), rows = text.split('\n');
    check(rows.length === map.h && rows.every(function (r) { return r.length === map.w && /^[.=,%~#$T12]+$/.test(r); }), tag + 'ascii dump is w x h of legend characters');
    check((text.match(/1/g) || []).length === 1 && (text.match(/2/g) || []).length === 1 && rows[map.starts[0].cy][map.starts[0].cx] === '1', tag + 'ascii marks both starts');
    let nT = 0;
    for (const r of a.turf) nT += r.w * r.h;
    check((text.match(/T/g) || []).length === nT && (text.match(/\$/g) || []).length === map.res.filter(function (v) { return v > 0; }).length, tag + 'ascii marks turf footprints and resources');
    const back = NT.Map.fromAscii(rows.map(function (r) { return r.replace(/T/g, '.'); }));
    check(sameBytes(back.terrain, map.terrain) && back.starts[0].cx === map.starts[0].cx && back.starts[1].cy === map.starts[1].cy, tag + 'ascii dump round-trips through NT.Map.fromAscii');
    if (dumpDir) fs.writeFileSync(path.join(dumpDir, p.id + '.txt'), text + '\n');
    console.log('  ' + p.id + '  "' + p.name.en + '" / "' + p.name.zh + '"  ' + p.size + ' seed ' + p.seed + '  ' + placement(map) + (a.canal ? ', canal' : '') +
      ', ' + map.blocks.length + ' blocks, ' + pctOf(a.blockShare) + ' BLOCK, ' + NT.Map.totalRes(map) + ' credits, ' + map.neutrals.length + ' turf, ' + map.deco.length + ' deco');
  }
  check(kinds.size >= 3, 'presets differ in layout: ' + Array.from(kinds).join(' | '));
  let threw = false;
  try { G.fromPreset('no-such-map'); } catch (e) { threw = true; }
  check(threw, 'unknown preset id is rejected');
  if (dumpDir) console.log('  dumps written to ' + dumpDir);
}
function pctOf(v) { return (100 * v).toFixed(1) + '%'; }

done();
