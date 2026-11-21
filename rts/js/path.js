'use strict';
// ============================================================================
// NEON TURF — path.js : grid pathfinding  (HEADLESS-SAFE, DETERMINISTIC)
//
// NT.Path.find(world, body, sx, sy, gx, gy, opts) -> number[] | null
//   A* over cells, 8 directions, NO corner cutting (a diagonal step needs both
//   orthogonal neighbours walkable), step cost = length / map.speed[cell].
//   Returns the cell indices to walk (start excluded, goal included):
//     []    the start already satisfies the goal
//     null  no progress is possible (the start is as close as it gets)
//   Static blocking = !NT.Occ.walkable (terrain + buildings). Units are ignored
//   unless opts.avoid. If the goal cannot be reached the result is the path to
//   the reachable cell CLOSEST to it; world.sys.path.reached tells which one
//   you got (true = the goal itself), world.sys.path.expanded what it cost.
//   opts:
//     adjacentTo  building entity: stop on any cell touching its footprint
//     range       px: stop as soon as the cell CENTRE is within range of the goal
//     target      entity the range is measured to (building: its footprint; ground
//                 unit: the centre of its cell; flyer: its position). Default: the
//                 centre of the goal cell.
//     avoid       treat cells held by STATIONARY units (hopT < 0) as blocked: a
//                 large body needs the cell empty, a small one needs a free slot.
//                 An exact goal cell is exempt (the mover deals with it on arrival).
//     self        the moving entity: never its own obstacle; a crusher (def.traits)
//                 is not stopped by the infantry it may run over
//     cap         max node expansions (default NT.Path.CAP / CAP_AVOID), then best effort
//     out         array to fill and return instead of a fresh one
//
// NT.Path.request(world, ent, gx, gy, opts) -> ticket
//   FIFO queue served by the 'path' system (order 35, between orders and move)
//   within NT.Path.BUDGET node expansions per tick, so sixty units ordered in one
//   tick do not spike it. The search starts from the cell the unit claims WHEN
//   ITS TURN COMES. NT.Path.consumer.wants(world, ent, ticket) is asked first
//   (stale requests cost nothing), then .result(world, ent, ticket, path, reached)
//   is called; `path` is a scratch array (or null) — copy what you keep.
//   opts.low = true queues behind every normal request (speculative re-plans).
//
// NT.Path.satisfies(world, cx, cy, gx, gy, opts) -> bool   would standing in (cx, cy) meet that goal?
// NT.Path.region(world, cx, cy) -> id   static connectivity label (0 = not walkable); equal ids > 0 are connected
//
// Scratch (typed arrays, heap, request pool) lives in world.sys.path and is
// reused, so steady-state searching allocates nothing. Connectivity labels of
// the static grid (rebuilt when world.passVersion changes) answer "is the goal
// reachable at all" before any search: an unreachable goal is swapped for the
// closest cell of the mover's own region instead of flooding the map.
// Air units never come here (they fly straight).
// ============================================================================
NT.Path = {};

NT.Path.BUDGET = 3000;       // node expansions the request queue may spend per tick (the last search may overshoot)
NT.Path.CAP = 12000;         // one static search
NT.Path.CAP_AVOID = 1200;    // one avoid search: a local detour or nothing
NT.Path._none = {};
NT.Path._o = { avoid: false, self: null, adjacentTo: null, range: 0, target: null, cap: 0, out: null };

NT.Path.consumer = {
  wants: function () { return true; },
  result: function () {},
};

NT.Path._sys = function (world) {
  let S = world.sys.path;
  if (!S) {
    const n = world.w * world.h, sp = world.map.speed;
    let top = 0;
    for (let i = 0; i < n; i++) if (sp[i] > top) top = sp[i];
    S = world.sys.path = {
      g: new Float64Array(n), par: new Int32Array(n), seen: new Uint32Array(n), closed: new Uint32Array(n),
      comp: new Int32Array(n), stack: new Int32Array(n), pv: -1, stamp: 0,
      heap: new NT.Heap(), hk: 1.001 / (top || 1),          // heuristic scale: admissible on the fastest terrain, ties -> nearer the goal
      queue: [], head: 0, low: [], lowHead: 0, pool: [], seq: 0, tmp: [],
      reached: false, expanded: 0, used: 0, pending: 0,
      mode: 0, gi: 0, gx: 0, gy: 0, bx0: 0, by0: 0, bx1: 0, by1: 0, tx: 0, ty: 0, tent: null, range: 0,
    };
  }
  if (S.pv !== world.passVersion) NT.Path._label(world, S);
  return S;
};

// Connected regions of the static grid: comp[i] = 0 (not walkable) or a region id >= 1.
// 4-connectivity is exactly what 8-directional movement without corner cutting can reach.
NT.Path._label = function (world, S) {
  const w = world.w, n = w * world.h, comp = S.comp, st = S.stack, pass = world.map.pass, occ = world.occ;
  for (let i = 0; i < n; i++) {
    let ok = pass[i] === 1;
    if (ok && occ[i]) { const e = world.byId.get(occ[i]); ok = !e || e.kind !== 'building'; }
    comp[i] = ok ? -1 : 0;
  }
  let c = 0;
  for (let i = 0; i < n; i++) {
    if (comp[i] !== -1) continue;
    c++; comp[i] = c;
    let top = 0; st[top++] = i;
    while (top) {
      const k = st[--top], x = k % w;
      if (x > 0 && comp[k - 1] === -1) { comp[k - 1] = c; st[top++] = k - 1; }
      if (x < w - 1 && comp[k + 1] === -1) { comp[k + 1] = c; st[top++] = k + 1; }
      if (k >= w && comp[k - w] === -1) { comp[k - w] = c; st[top++] = k - w; }
      if (k + w < n && comp[k + w] === -1) { comp[k + w] = c; st[top++] = k + w; }
    }
  }
  S.pv = world.passVersion;
};

// Static region id of a cell (0 = not walkable / out of bounds). Two cells with the same id > 0 are connected.
NT.Path.region = function (world, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return 0;
  return NT.Path._sys(world).comp[cy * world.w + cx];
};

// --- goal shapes: 0 = one cell, 1 = any cell touching a building, 2 = any cell centre within range
NT.Path._goal = function (world, S, gx, gy, opts) {
  const T = NT.TILE, b = opts.adjacentTo, t = opts.target;
  S.gx = gx; S.gy = gy; S.gi = gy * world.w + gx; S.tent = null; S.range = 0;
  if (b) {
    S.mode = 1; S.bx0 = b.cx - 1; S.by0 = b.cy - 1; S.bx1 = b.cx + b.w; S.by1 = b.cy + b.h;
  } else if (opts.range > 0) {
    S.mode = 2; S.range = opts.range;
    if (t && t.kind === 'building') S.tent = t;
    else if (t && t.layer === 'air') { S.tx = t.x; S.ty = t.y; }
    else if (t) { S.tx = (t.cx + 0.5) * T; S.ty = (t.cy + 0.5) * T; }
    else { S.tx = (gx + 0.5) * T; S.ty = (gy + 0.5) * T; }
  } else S.mode = 0;
};

// Distance in cells from the centre of cell (x, y) to the goal shape; 0 = satisfied.
NT.Path._d = function (S, x, y) {
  if (S.mode === 0) { const dx = x - S.gx, dy = y - S.gy; return Math.sqrt(dx * dx + dy * dy); }
  if (S.mode === 1) {
    const dx = x < S.bx0 ? S.bx0 - x : x > S.bx1 ? x - S.bx1 : 0, dy = y < S.by0 ? S.by0 - y : y > S.by1 ? y - S.by1 : 0;
    return Math.sqrt(dx * dx + dy * dy);
  }
  const T = NT.TILE, px = (x + 0.5) * T, py = (y + 0.5) * T;
  const d = S.tent ? NT.distTo(px, py, S.tent) : NT.dist(px, py, S.tx, S.ty);
  return d <= S.range ? 0 : (d - S.range) / T;
};

// Would standing in cell (cx, cy) satisfy goal (gx, gy, opts)? Same shapes as find().
NT.Path.satisfies = function (world, cx, cy, gx, gy, opts) {
  const S = world.sys.path || NT.Path._sys(world);
  NT.Path._goal(world, S, gx, gy, opts || NT.Path._none);
  return S.mode === 0 ? cx === gx && cy === gy : NT.Path._d(S, cx, cy) === 0;
};

// Admissible estimate of the remaining cost, in cells.
NT.Path._h = function (S, x, y) {
  let dx, dy;
  if (S.mode === 0) { dx = Math.abs(x - S.gx); dy = Math.abs(y - S.gy); }
  else if (S.mode === 1) {
    dx = x < S.bx0 ? S.bx0 - x : x > S.bx1 ? x - S.bx1 : 0; dy = y < S.by0 ? S.by0 - y : y > S.by1 ? y - S.by1 : 0;
  } else return NT.Path._d(S, x, y);
  return dx > dy ? dx + 0.41421356 * dy : dy + 0.41421356 * dx;
};

// Does any cell of region `sc` satisfy the goal?
NT.Path._feasible = function (world, S, sc) {
  const w = world.w, h = world.h, comp = S.comp;
  if (S.mode === 0) return comp[S.gi] === sc;
  let x0, y0, x1, y1;
  if (S.mode === 1) { x0 = S.bx0; y0 = S.by0; x1 = S.bx1; y1 = S.by1; }
  else {
    const r = Math.ceil(S.range / NT.TILE) + 1, t = S.tent;
    if (t) { x0 = t.cx - r; y0 = t.cy - r; x1 = t.cx + t.w - 1 + r; y1 = t.cy + t.h - 1 + r; }
    else { const cx = NT.cellOf(S.tx), cy = NT.cellOf(S.ty); x0 = cx - r; y0 = cy - r; x1 = cx + r; y1 = cy + r; }
  }
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 >= w) x1 = w - 1; if (y1 >= h) y1 = h - 1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (comp[y * w + x] === sc && NT.Path._d(S, x, y) === 0) return true;
  }
  return false;
};

// The cell of region `sc` closest to the goal shape (first in row-major order on ties).
NT.Path._closest = function (world, S, sc) {
  const w = world.w, n = w * world.h, comp = S.comp;
  let best = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    if (comp[i] !== sc) continue;
    const x = i % w, d = NT.Path._d(S, x, (i - x) / w);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

// avoid mode: do stationary units keep `body` out of cell i?
NT.Path._held = function (world, i, body, self) {
  const selfId = self ? self.id : 0, s = world.occ[i];
  if (s && s !== selfId) { const o = world.byId.get(s); if (o && o.hopT < 0) return true; }
  const b = i * NT.INF_PER_CELL, small = body === 'small';
  let n = 0;
  for (let k = 0; k < NT.INF_PER_CELL; k++) {
    const id = world.inf[b + k];
    if (!id || id === selfId) continue;
    const o = world.byId.get(id);
    if (!o || o.hopT >= 0) continue;
    if (small) n++;
    else if (!(self && NT.Move && NT.Move.crushable(world, self, o))) return true;
  }
  return n >= NT.INF_PER_CELL;
};

NT.Path.find = function (world, body, sx, sy, gx, gy, opts) {
  opts = opts || NT.Path._none;
  const S = NT.Path._sys(world), w = world.w, h = world.h, comp = S.comp;
  const out = opts.out || [];
  out.length = 0;
  S.reached = false; S.expanded = 0;
  if (!(sx >= 0 && sy >= 0 && sx < w && sy < h)) return null;
  gx = NT.clamp(gx | 0, 0, w - 1); gy = NT.clamp(gy | 0, 0, h - 1);
  NT.Path._goal(world, S, gx, gy, opts);
  const si = sy * w + sx, sc = comp[si];
  if (S.mode === 0 ? si === S.gi : NT.Path._d(S, sx, sy) === 0) { S.reached = true; return out; }
  let exact = true;
  if (sc > 0 && !NT.Path._feasible(world, S, sc)) {
    // nothing in the mover's region satisfies the goal: walk to the region's closest cell instead
    const c = NT.Path._closest(world, S, sc);
    if (c < 0 || c === si) return null;
    S.mode = 0; S.gi = c; S.gx = c % w; S.gy = (c - S.gx) / w;
    exact = false;
  }
  const avoid = !!opts.avoid, self = opts.self || null;
  const cap = opts.cap || (avoid ? NT.Path.CAP_AVOID : NT.Path.CAP);
  const exempt = avoid && S.mode === 0 ? S.gi : -1;
  const g = S.g, par = S.par, seen = S.seen, closed = S.closed, heap = S.heap, speed = world.map.speed, hk = S.hk;
  const D = NT.DIRS8, mode0 = S.mode === 0, stamp = ++S.stamp;
  heap.clear();
  g[si] = 0; par[si] = -1; seen[si] = stamp;
  heap.push(si, 0);
  let best = si, bestD = NT.Path._d(S, sx, sy), bestG = 0, found = -1, n = 0;
  while (heap.size()) {
    const cur = heap.pop();
    if (closed[cur] === stamp) continue;
    closed[cur] = stamp; n++;
    const cx = cur % w, cy = (cur - cx) / w, gc = g[cur];
    const d = NT.Path._d(S, cx, cy);
    if (mode0 ? cur === S.gi : d === 0) { found = cur; break; }
    if (d < bestD || (d === bestD && gc < bestG)) { best = cur; bestD = d; bestG = gc; }
    if (n >= cap) break;
    for (let k = 0; k < 8; k++) {
      const nx = cx + D[k][0], ny = cy + D[k][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (!comp[ni] || closed[ni] === stamp) continue;
      if (k > 3 && (!comp[cy * w + nx] || !comp[ny * w + cx])) continue;          // no corner cutting
      if (avoid && ni !== exempt && NT.Path._held(world, ni, body, self)) continue;
      const ng = gc + D[k][2] / speed[ni];
      if (seen[ni] === stamp && ng >= g[ni]) continue;
      g[ni] = ng; par[ni] = cur; seen[ni] = stamp;
      heap.push(ni, ng + NT.Path._h(S, nx, ny) * hk);
    }
  }
  S.expanded = n;
  const end = found >= 0 ? found : best;
  S.reached = found >= 0 && exact;
  if (end === si) return null;
  let len = 0;
  for (let c = end; c !== si; c = par[c]) len++;
  out.length = len;
  for (let c = end; c !== si; c = par[c]) out[--len] = c;
  return out;
};

// ---------------------------------------------------------------------------
// Request queue
// ---------------------------------------------------------------------------
NT.Path.request = function (world, ent, gx, gy, opts) {
  const S = world.sys.path || NT.Path._sys(world);
  opts = opts || NT.Path._none;
  const r = S.pool.pop() || { seq: 0, id: 0, gx: 0, gy: 0, avoid: false, adj: 0, tgt: 0, range: 0 };
  r.seq = ++S.seq; r.id = ent.id; r.gx = gx; r.gy = gy;
  r.avoid = !!opts.avoid; r.range = opts.range || 0;
  r.adj = opts.adjacentTo ? opts.adjacentTo.id : 0; r.tgt = opts.target ? opts.target.id : 0;
  (opts.low ? S.low : S.queue).push(r);
  S.pending++;
  return r.seq;
};

NT.Path._serve = function (world, S, r) {
  const e = world.byId.get(r.id);
  if (e && NT.Path.consumer.wants(world, e, r.seq)) {
    const o = NT.Path._o;
    o.avoid = r.avoid; o.self = e; o.range = r.range; o.out = S.tmp;
    o.adjacentTo = r.adj ? world.byId.get(r.adj) || null : null;
    o.target = r.tgt ? world.byId.get(r.tgt) || null : null;
    const path = NT.Path.find(world, e.body, e.cx, e.cy, r.gx, r.gy, o);
    S.used += S.expanded + 16;
    o.self = o.adjacentTo = o.target = o.out = null;
    NT.Path.consumer.result(world, e, r.seq, path, S.reached);
  }
  S.pending--;
  S.pool.push(r);
};

NT.system('path', 35, {
  step: function (world) {
    const S = world.sys.path;
    if (!S) return;
    S.used = 0;
    if (!S.pending) return;
    const q = S.queue, lo = S.low, B = NT.Path.BUDGET;
    while (S.head < q.length && S.used < B) NT.Path._serve(world, S, q[S.head++]);
    if (S.head >= q.length) { q.length = 0; S.head = 0; }
    else if (S.head > 512) { q.splice(0, S.head); S.head = 0; }
    while (!q.length && S.lowHead < lo.length && S.used < B) NT.Path._serve(world, S, lo[S.lowHead++]);
    if (S.lowHead >= lo.length) { lo.length = 0; S.lowHead = 0; }
    else if (S.lowHead > 512) { lo.splice(0, S.lowHead); S.lowHead = 0; }
  },
});
