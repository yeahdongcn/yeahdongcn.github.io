'use strict';
// ============================================================================
// NEON TURF — core.js
// Namespace, constants, deterministic RNG, math / grid helpers, binary heap,
// presentation event bus. Loaded FIRST. Everything hangs off the global `NT`.
//
// HEADLESS-SAFE: this file (and rules/factions/map/sim/ai) must never touch
// window/document/canvas at load or during NT.step(). Only art/render/audio/
// ui/input/main may use the DOM. test/smoke.js loads the sim files in Node.
// ============================================================================
globalThis.NT = globalThis.NT || {};

NT.VERSION = '0.1.0';
NT.TILE = 32;            // world units (px at zoom 1) per map cell
NT.TPS = 20;             // simulation ticks per second (fixed step)
NT.DT = 1 / NT.TPS;      // seconds per tick
NT.MAX_PLAYERS = 4;
NT.NEUTRAL = -1;         // owner index of neutral entities
// (NT.SUBCELL / NT.INF_PER_CELL — how many small bodies share a cell — live in sim.js)

// seconds -> ticks (always >= 1 so a cooldown can never become 0)
NT.ticks = function (seconds) { return Math.max(1, Math.round(seconds * NT.TPS)); };

// ---------------------------------------------------------------------------
// Deterministic RNG (mulberry32). ALL simulation randomness goes through
// world.rng — never Math.random() inside the sim. `state` is a plain uint32,
// so a world can be cloned / hashed / replayed.
// ---------------------------------------------------------------------------
NT.Rng = function (seed) { this.state = (seed >>> 0) || 0x9e3779b9; };
NT.Rng.prototype.next = function () {            // float in [0, 1)
  let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
NT.Rng.prototype.int = function (n) { return (this.next() * n) | 0; };               // int in [0, n)
NT.Rng.prototype.range = function (a, b) { return a + this.next() * (b - a); };      // float in [a, b)
NT.Rng.prototype.irange = function (a, b) { return a + this.int(b - a + 1); };       // int in [a, b]
NT.Rng.prototype.chance = function (p) { return this.next() < p; };
NT.Rng.prototype.pick = function (arr) { return arr.length ? arr[this.int(arr.length)] : undefined; };
NT.Rng.prototype.shuffle = function (arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = this.int(i + 1); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  return arr;
};
NT.Rng.prototype.fork = function () { return new NT.Rng((this.next() * 4294967296) >>> 0); };

// FNV-1a over a string / number list -> uint32 (stable seeds from names, state hashes)
NT.hash32 = function () {
  let h = 0x811c9dc5;
  for (let a = 0; a < arguments.length; a++) {
    const s = String(arguments[a]);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0x7c; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------
NT.TAU = Math.PI * 2;
NT.clamp = function (v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; };
NT.lerp = function (a, b, t) { return a + (b - a) * t; };
NT.dist = function (ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); };
NT.dist2 = function (ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };
NT.angNorm = function (a) { a %= NT.TAU; if (a > Math.PI) a -= NT.TAU; else if (a < -Math.PI) a += NT.TAU; return a; };
NT.angDiff = function (from, to) { return NT.angNorm(to - from); };                  // signed shortest turn
NT.angTo = function (ax, ay, bx, by) { return Math.atan2(by - ay, bx - ax); };
// rotate `from` toward `to` by at most `maxStep` radians; returns the new angle
NT.turnToward = function (from, to, maxStep) {
  const d = NT.angDiff(from, to);
  if (Math.abs(d) <= maxStep) return to;
  return NT.angNorm(from + (d > 0 ? maxStep : -maxStep));
};

// ---------------------------------------------------------------------------
// Grid helpers. World coords are px (x right, y down); cell (cx, cy) covers
// [cx*TILE, (cx+1)*TILE). idx = cy * w + cx.
// ---------------------------------------------------------------------------
NT.cellOf = function (v) { return Math.floor(v / NT.TILE); };
NT.cellCenter = function (c) { return c * NT.TILE + NT.TILE / 2; };
// 8 neighbours: [dx, dy, cost]. Orthogonals first (deterministic tie-breaks).
NT.DIRS8 = [[1, 0, 1], [0, 1, 1], [-1, 0, 1], [0, -1, 1], [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2], [1, -1, Math.SQRT2]];
NT.DIRS4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];

// Offsets of every cell whose centre lies within `r` cells of (0,0), sorted
// near -> far (stable). Cached per radius. Used by fog, scans, splash, placement.
NT._circleCache = {};
NT.circleOffsets = function (r) {
  const key = Math.round(r * 2);              // half-cell resolution
  let c = NT._circleCache[key];
  if (c) return c;
  const R = key / 2, R2 = R * R, n = Math.ceil(R);
  c = [];
  for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) {
    const d2 = dx * dx + dy * dy;
    if (d2 <= R2 + 0.25) c.push([dx, dy, d2]);
  }
  c.sort(function (a, b) { return a[2] - b[2] || a[1] - b[1] || a[0] - b[0]; });
  NT._circleCache[key] = c;
  return c;
};

// Visit cells in expanding square rings around (cx, cy) up to maxR. `fn(x, y, ring)`
// returning true stops the walk and makes spiral() return [x, y]. Deterministic order.
NT.spiral = function (cx, cy, maxR, fn) {
  if (fn(cx, cy, 0)) return [cx, cy];
  for (let r = 1; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      if (fn(cx + dx, cy - r, r)) return [cx + dx, cy - r];
      if (fn(cx + dx, cy + r, r)) return [cx + dx, cy + r];
    }
    for (let dy = -r + 1; dy <= r - 1; dy++) {
      if (fn(cx - r, cy + dy, r)) return [cx - r, cy + dy];
      if (fn(cx + r, cy + dy, r)) return [cx + r, cy + dy];
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Binary min-heap keyed by a numeric priority (A*, timers). Ties resolve by
// insertion order so searches are deterministic.
// ---------------------------------------------------------------------------
NT.Heap = function () { this.items = []; this.prio = []; this.seq = []; this._n = 0; };
NT.Heap.prototype.size = function () { return this.items.length; };
NT.Heap.prototype.clear = function () { this.items.length = 0; this.prio.length = 0; this.seq.length = 0; this._n = 0; };
NT.Heap.prototype._less = function (i, j) {
  return this.prio[i] < this.prio[j] || (this.prio[i] === this.prio[j] && this.seq[i] < this.seq[j]);
};
NT.Heap.prototype._swap = function (i, j) {
  const a = this.items, p = this.prio, s = this.seq;
  let t = a[i]; a[i] = a[j]; a[j] = t;
  t = p[i]; p[i] = p[j]; p[j] = t;
  t = s[i]; s[i] = s[j]; s[j] = t;
};
NT.Heap.prototype.push = function (item, prio) {
  let i = this.items.length;
  this.items.push(item); this.prio.push(prio); this.seq.push(this._n++);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!this._less(i, p)) break;
    this._swap(i, p); i = p;
  }
};
NT.Heap.prototype.pop = function () {
  const n = this.items.length;
  if (!n) return undefined;
  const top = this.items[0];
  const li = this.items.pop(), lp = this.prio.pop(), ls = this.seq.pop();
  if (n > 1) {
    this.items[0] = li; this.prio[0] = lp; this.seq[0] = ls;
    let i = 0;
    const m = n - 1;
    for (;;) {
      const l = i * 2 + 1, r = l + 1;
      let s = i;
      if (l < m && this._less(l, s)) s = l;
      if (r < m && this._less(r, s)) s = r;
      if (s === i) break;
      this._swap(i, s); i = s;
    }
  }
  return top;
};

// ---------------------------------------------------------------------------
// Presentation event bus (UI / audio / fx listeners). NOT simulation state:
// the sim only appends plain objects to world.events; main.js forwards them
// here after every tick. Headless runs simply never subscribe.
// ---------------------------------------------------------------------------
NT._listeners = {};
NT.on = function (type, fn) { (NT._listeners[type] = NT._listeners[type] || []).push(fn); return fn; };
NT.off = function (type, fn) {
  const l = NT._listeners[type]; if (!l) return;
  const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
};
NT.emit = function (type, payload) {
  const l = NT._listeners[type];
  if (l) for (let i = 0; i < l.length; i++) l[i](payload);
  const any = NT._listeners['*'];
  if (any) for (let i = 0; i < any.length; i++) any[i](type, payload);
};

NT.assert = function (cond, msg) { if (!cond) throw new Error('NT assert: ' + (msg || 'failed')); };

// Shallow-merge helper for defaults: fills missing keys of `obj` from `defaults`.
NT.defaults = function (obj, defaults) {
  const o = obj || {};
  for (const k in defaults) if (o[k] === undefined) o[k] = defaults[k];
  return o;
};
