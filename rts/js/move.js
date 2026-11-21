'use strict';
// ============================================================================
// NEON TURF — move.js : orders, movement, traffic  (HEADLESS-SAFE, DETERMINISTIC)
// Systems 'orders' (30) and 'move' (40). Commands: move, amove, attack, stop, stance.
//
// ORDERS — ent.order is the current order object (null = idle), ent.queue the
// shift-queued ones. An order type is a small state machine:
//   NT.Orders.define(type, { start?(world, ent, o), tick(world, ent, o) -> true when finished, end?(world, ent, o) })
//   NT.Orders.give(world, ent, order, queue?)   replace the current order (queue = true: append; starts at once if idle)
//   NT.Orders.next(world, ent)                  end the current order and start the next queued one (or go idle)
//   NT.Orders.clear(world, ent)                 drop order + queue + target and stand still
// `end` runs whenever an order stops being current (finished, replaced, cleared).
// Order shapes defined here (other systems add harvest / enter / ... the same way):
//   {type:'move',   x, y, cx, cy, n}       walk to cell (cx, cy); x, y = the clicked point (px); n = units in the group
//   {type:'amove',  x, y, cx, cy, n, eng, ax, ay}   same, but fights what it meets (eng / ax / ay: engagement
//                                          state — where it left the road; written by the order itself)
//   {type:'attack', target}                engage entity id `target` until it dies, turns friendly, drops out of sight or
//                                          proves out of reach (walled off / crowded out for NT.Orders.VAIN ticks)
// Idle units (order === null) guard their post: an aggressive one chases what combat.js acquires for it up to
// rules.leash cells from ent.homeX/homeY, then walks back (ent.mv.guard: 0 at post, 1 chasing, 2 walking home).
// The post is wherever the unit comes to rest: it is reset when an order ends or is stopped (never the place it left).
//
// MOVEMENT PRIMITIVES (what orders are built from):
//   NT.Move.to(world, ent, cx, cy, opts) -> bool    start moving. opts: range (px: stop once the cell centre is that
//       close to the goal), target (entity the range is measured to; flyers track it), adjacentTo (building: stop on
//       any cell touching it), group (units sharing the order). The unit keeps doing what it was doing until its
//       path arrives. false = cannot move at all (status 'failed').
//   NT.Move.stop(world, ent)                        finish the current hop, then stand (status 'idle')
//   NT.Move.status(ent) -> 'idle' | 'moving' | 'arrived' | 'failed'
//       'arrived' on a range / adjacentTo goal means the goal really holds. On a plain cell goal it means "as close
//       as it gets": the cell itself, the nearest free cell around a taken one, or the reachable cell nearest to an
//       unreachable one. 'failed' = could not get there (walled off, jammed for 6 s, the building is gone).
// All per-unit movement state lives in ent.mv (NT.Move.state(ent), created on first use) plus the spine fields
// path / pathI / hop* / blocked / homeX / homeY.
//
// CELLS: a ground unit hops cell to cell. Starting a hop CLAIMS the next cell at once (ent.cx/cy jump, the old cell
// is free immediately) and ent.x/y glide from hopFrom to hopTo while hopT runs 0 -> 1; hopT < 0 = standing exactly
// on its (sub-)cell position. Speed = def.move.speedPx x mods.speed x terrain speed of the cell being entered;
// diagonal hops take sqrt(2) longer. Large bodies turn toward the hop first (NT.Move.ALIGN), small ones snap.
//
// TRAFFIC (NT.Move._blocked — the next cell cannot be entered):
//   - a friend that is mid-hop, or queueing with somewhere else to go: wait; after WAIT ticks ask for a route
//     around standing units (taken only if it really reaches the goal; retries back off);
//   - a friend standing in the way that wants MY cell (head-on): the two cells trade occupants;
//   - an idle friend: it makes way to a free neighbouring cell off my route (pushing a further idle unit if it must,
//     trading cells with me if there is no room at all). Units that are deployed, holding, fighting or busy with an
//     order never make way; they, enemies and neutrals are obstacles: route around them at once;
//   - the LAST cell of a plain move taken by someone staying there: settle for the nearest free cell to the goal;
//   - blocked GIVE_UP ticks within 2 (+1 per 5 units of the group) cells of a plain goal: arrived;
//   - STUCK ticks without progress: failed. This single rule is what guarantees every move ends.
//   A crusher (def.traits.crusher, large body) simply drives into a cell held only by crushable enemy infantry.
//
// AIR units are off the grid: they fly straight at the goal, turning at their turn rate, keep ~1 cell apart from
// other flyers, stay inside the map, hover when idle. ent.cx/cy track the cell below.
//
// SLOW: NT.Move.slow(world, ent) is the strongest active {id:'slow', until, speed} buff (see combat.js). Movement
// applies it itself ONLY while no system named 'traits' is registered; once traits.js exists it is expected to fold
// buffs into ent.mods.speed and movement trusts that alone (no double slow).
// ============================================================================
NT.Move = { IDLE: 0, MOVING: 1, ARRIVED: 2, FAILED: 3 };
NT.Move.STATUS = ['idle', 'moving', 'arrived', 'failed'];
NT.Move.ALIGN = 35 * Math.PI / 180;    // a large body starts a hop once its hull is this close to the hop direction
NT.Move.WAIT = 10;                     // ticks behind moving friends before asking for a way round
NT.Move.GIVE_UP = 20;                  // ticks blocked near a plain goal before settling where it stands
NT.Move.STUCK = 120;                   // ticks without progress before a move fails
NT.Move.SEPARATION = 1.5;              // px per tick two overlapping flyers push each other apart

NT.Move.state = function (e) {
  return e.mv || (e.mv = {
    st: 0,                             // NT.Move.IDLE | MOVING | ARRIVED | FAILED
    gx: 0, gy: 0,                      // goal cell (may shift to a free neighbour when the cell is taken)
    ox: 0, oy: 0,                      // the cell that was asked for
    range: 0, adj: 0, tgt: 0,          // goal shape: px range / building id to touch / entity id the range is measured to
    grp: 1,                            // units sharing the order
    ticket: 0, asked: 0,               // pending path request; 1 = plain, 2 = around standing units
    avoid: false,                      // the current path was planned around standing units
    partial: false,                    // the current path ends at the closest reachable cell, not at the goal
    len: NT.TILE,                      // length of the current hop (px)
    replanAt: 0, backoff: 0,           // throttle for "around standing units" requests
    hard: false,                       // the last block was an obstacle (not just a queue of friends)
    noWay: 0,                          // tick a search for a way round first came back empty since the last hop (0 = none)
    stuck: 0, best: Infinity,          // ticks without progress / closest squared cell distance to the goal so far
    make: 0,                           // 0 = ordinary move; else id of the unit this one is making way for
    depth: 0,                          // how many units deep in a make-way chain
    pushedAt: -9999, pushedFrom: -1,   // last time it made way, and the cell it left
    settled: 0,                        // times it had to pick another final cell
    guard: 0,                          // idle guard state: 0 at post, 1 chasing, 2 walking home
    chaseAt: 0, chaseCell: -1,         // chase re-plan throttle
    ignore: 0, ignoreT: 0,             // target id not worth acquiring again before tick ignoreT (could not be reached)
    stamp: 0,                          // group-order scratch
  });
};

NT.Move._sys = function (world) {
  return world.sys.move || (world.sys.move = {
    mark: new Uint32Array(world.w * world.h), stamp: 0, heap: new NT.Heap(),
    cells: [], capL: [], capS: [], useL: [], useS: [],
    ownSlow: !NT.systems.some(function (s) { return s.name === 'traits'; }),
  });
};

NT.Move.status = function (e) { return NT.Move.STATUS[e.mv ? e.mv.st : 0]; };

NT.Move.slow = function (world, e) {
  const b = e.buffs;
  let s = 1;
  for (let i = 0; i < b.length; i++) if (b[i].id === 'slow' && b[i].until > world.tick && b[i].speed < s) s = b[i].speed;
  return s;
};
// px per tick this unit covers right now (terrain not included)
NT.Move.speed = function (world, e) {
  const v = e.def.move.speedPx * e.mods.speed;
  return NT.Move._sys(world).ownSlow ? v * NT.Move.slow(world, e) : v;
};

NT.Move._po = { avoid: false, low: false, self: null, adjacentTo: null, range: 0, target: null };
NT.Move._goal = function (world, e, m, avoid) {
  const o = NT.Move._po;
  o.avoid = avoid; o.low = avoid; o.self = e; o.range = m.range;
  o.adjacentTo = m.adj ? world.byId.get(m.adj) || null : null;
  o.target = m.tgt ? world.byId.get(m.tgt) || null : null;
  return o;
};
NT.Move._atGoal = function (world, e, m) {
  return NT.Path.satisfies(world, e.cx, e.cy, m.gx, m.gy, NT.Move._goal(world, e, m, false));
};
NT.Move._plan = function (world, e, m, avoid) {
  m.asked = avoid ? 2 : 1;
  m.ticket = NT.Path.request(world, e, m.gx, m.gy, NT.Move._goal(world, e, m, avoid));
};
NT.Move._end = function (e, m, st) {
  m.st = st; m.ticket = 0; m.asked = 0; m.make = 0; m.depth = 0; m.avoid = false; m.partial = false;
  if (e.path) e.path.length = 0;
  e.pathI = 0; e.blocked = 0;
};

NT.Move.to = function (world, e, cx, cy, opts) {
  const M = NT.Move, m = M.state(e);
  if (!e.alive || e.kind !== 'unit' || e.hidden || e.deployed || !(e.def.move.speedPx > 0)) { M._end(e, m, M.FAILED); return false; }
  m.gx = m.ox = NT.clamp(cx | 0, 0, world.w - 1); m.gy = m.oy = NT.clamp(cy | 0, 0, world.h - 1);
  m.range = opts && opts.range > 0 ? opts.range : 0;
  m.adj = opts && opts.adjacentTo ? opts.adjacentTo.id : 0;
  m.tgt = opts && opts.target ? opts.target.id : 0;
  m.grp = opts && opts.group > 1 ? opts.group : 1;
  m.st = M.MOVING; m.make = 0; m.depth = 0;
  m.stuck = 0; m.best = Infinity; m.replanAt = 0; m.backoff = 0; m.settled = 0; m.noWay = 0;
  e.blocked = 0;
  if (e.layer === 'air') { m.ticket = 0; return true; }
  if (e.hopT < 0 && M._atGoal(world, e, m)) { M._end(e, m, M.ARRIVED); return true; }
  M._plan(world, e, m, false);
  return true;
};

NT.Move.stop = function (world, e) { if (e.mv) NT.Move._end(e, e.mv, NT.Move.IDLE); };

// --- path delivery (see path.js)
NT.Path.consumer.wants = function (world, e, ticket) { return !!e.mv && e.mv.ticket === ticket && e.mv.st === NT.Move.MOVING; };
NT.Path.consumer.result = function (world, e, ticket, path, reached) {
  const m = e.mv, around = m.asked === 2;
  m.ticket = 0; m.asked = 0;
  if (around && !(path && reached)) { if (!m.noWay) m.noWay = world.tick; return; }   // no way round: keep the plan, keep waiting
  if (around && !m.hard && e.path && path.length > (e.path.length - e.pathI) * 2 + 6) return;   // the queue will clear sooner
  const p = e.path || (e.path = []);
  p.length = 0;
  if (path) for (let i = 0; i < path.length; i++) p.push(path[i]);
  e.pathI = 0;
  m.avoid = around; m.partial = !reached;
  if (around) e.blocked = 0;
};

// ---------------------------------------------------------------------------
// Ground movement
// ---------------------------------------------------------------------------
// `forced` = the hop is a displacement (cells traded in a jam), which only counts as progress if it gets nearer.
NT.Move._hop = function (world, e, m, nx, ny, forced) {
  const T = NT.TILE;
  m.len = nx !== e.cx && ny !== e.cy ? T * Math.SQRT2 : T;
  e.hopFromX = e.x; e.hopFromY = e.y;
  NT.Occ.claim(world, e, nx, ny);
  const o = NT.SUBCELL[e.slot >= 0 ? e.slot : 0];
  e.hopToX = (nx + 0.5 + o[0]) * T; e.hopToY = (ny + 0.5 + o[1]) * T;
  e.hopT = 0; e.blocked = 0; m.noWay = 0;
  const dx = nx - m.gx, dy = ny - m.gy, d = dx * dx + dy * dy;
  // progress = a step along a planned route, or (on a detour around units) a step nearer than ever before
  if (d < m.best) { m.best = d; m.stuck = 0; m.backoff = 0; } else if (!m.avoid && !forced) m.stuck = 0;
};

// Standing on a cell and wanting to move: pick the next step. true = a hop has started.
NT.Move._begin = function (world, e, m) {
  const M = NT.Move, w = world.w;
  if (m.adj && !world.byId.has(m.adj)) { M._end(e, m, M.FAILED); return false; }
  if (!m.make && M._atGoal(world, e, m)) { M._end(e, m, M.ARRIVED); return false; }
  const path = e.path;
  if (!path || e.pathI >= path.length) {
    if (m.ticket) return false;                               // the route is on its way
    if (m.make) { M._end(e, m, M.IDLE); return false; }
    if (m.partial) { M._end(e, m, m.range > 0 || m.adj ? M.FAILED : M.ARRIVED); return false; }
    if (++m.stuck > M.STUCK) { M._end(e, m, M.FAILED); return false; }
    M._plan(world, e, m, false);
    return false;
  }
  const next = path[e.pathI], nx = next % w, ny = (next - nx) / w, dx = nx - e.cx, dy = ny - e.cy;
  if (dx < -1 || dx > 1 || dy < -1 || dy > 1 || (!dx && !dy) || !NT.Occ.walkable(world, nx, ny) ||
      (dx && dy && (!NT.Occ.walkable(world, nx, e.cy) || !NT.Occ.walkable(world, e.cx, ny)))) {
    // the route no longer starts here (the unit was displaced) or a structure went up on it
    path.length = 0; e.pathI = 0;
    if (m.make) { M._end(e, m, M.IDLE); return false; }
    if (m.asked !== 1) M._plan(world, e, m, false);
    return false;
  }
  if (e.body === 'large') {
    const ang = Math.atan2(dy, dx);
    if (Math.abs(NT.angDiff(e.facing, ang)) > M.ALIGN) { e.facing = NT.turnToward(e.facing, ang, e.def.move.turnRad); return false; }
  }
  if (!NT.Occ.canStand(world, e.body, nx, ny, e.id) && !M._crush(world, e, nx, ny)) return M._blocked(world, e, m, nx, ny);
  M._hop(world, e, m, nx, ny);
  e.pathI++;
  return true;
};

NT.Move._ground = function (world, e, m) {
  const M = NT.Move, T = NT.TILE;
  let left = 1;                                               // fraction of this tick not spent yet
  for (let k = 0; k < 4 && left > 1e-6; k++) {
    if (e.hopT < 0 && (m.st !== M.MOVING || !M._begin(world, e, m))) return;
    const v = M.speed(world, e) * world.map.speed[e.cy * world.w + e.cx];
    if (!(v > 0)) return;
    const need = (1 - e.hopT) * m.len;
    if (v * left < need) { e.hopT += v * left / m.len; left = 0; } else { e.hopT = 1; left -= need / v; }
    const ang = Math.atan2(e.hopToY - e.hopFromY, e.hopToX - e.hopFromX);
    e.facing = e.body === 'small' ? ang : NT.turnToward(e.facing, ang, e.def.move.turnRad * (k ? 0 : 1));
    if (e.hopT >= 1) { e.x = e.hopToX; e.y = e.hopToY; e.hopT = -1; }
    else { e.x = e.hopFromX + (e.hopToX - e.hopFromX) * e.hopT; e.y = e.hopFromY + (e.hopToY - e.hopFromY) * e.hopT; }
  }
};

// ---------------------------------------------------------------------------
// Crushing
// ---------------------------------------------------------------------------
NT.Move.crushable = function (world, crusher, v) {
  if (crusher.body !== 'large' || !crusher.def.traits.crusher) return false;
  if (v.body !== 'small' || !NT.isEnemy(world, crusher.owner, v.owner) || v.def.is.uncrushable) return false;
  const br = v.def.traits.brace;
  return !(v.braced && br && br.uncrushable);
};

// A crusher about to enter (nx, ny): if the cell holds nothing but crushable enemy infantry, they die. true = cell cleared.
NT.Move._crush = function (world, e, nx, ny) {
  if (e.body !== 'large' || !e.def.traits.crusher) return false;
  const i = ny * world.w + nx, b = i * NT.INF_PER_CELL, inf = world.inf;
  if (world.occ[i]) return false;
  let any = false;
  for (let k = 0; k < NT.INF_PER_CELL; k++) {
    if (!inf[b + k]) continue;
    const v = world.byId.get(inf[b + k]);
    if (!v || !NT.Move.crushable(world, e, v)) return false;
    any = true;
  }
  if (!any) return false;
  for (let k = 0; k < NT.INF_PER_CELL; k++) {
    const v = inf[b + k] ? world.byId.get(inf[b + k]) : null;
    if (!v) continue;
    if (NT.damage) NT.damage(world, v, world.rules.crushDmg, null, e, null);
    if (v.alive) NT.kill(world, v, e);
  }
  return NT.Occ.canStand(world, e.body, nx, ny, e.id);
};

// ---------------------------------------------------------------------------
// Traffic
// ---------------------------------------------------------------------------
NT.Move._occ = [];
NT.Move._mates = [];

// Would this unit step aside for a friend? Only if it has nothing better to do.
NT.Move.idle = function (o) {
  return o.kind === 'unit' && !o.order && !o.target && !o.deployed && o.hopT < 0 && o.stance !== 'hold' &&
    !(o.mv && o.mv.st === NT.Move.MOVING) && o.def.move.speedPx > 0;
};

// How does occupant `o` of the cell `e` wants stand in the way?
//   0 passing (mid-hop, or queueing with somewhere else to go)   1 wants e's cell (head-on)
//   2 idle friend (will make way)                                3 obstacle (enemy, neutral, friend that stays put)
NT.Move._kind = function (world, e, o) {
  if (!NT.isAlly(world, e.owner, o.owner) || o.kind !== 'unit') return 3;
  if (o.hopT >= 0) return 0;
  if (o.mv && o.mv.st === NT.Move.MOVING) {
    return o.path && o.pathI < o.path.length && o.path[o.pathI] === e.cy * world.w + e.cx ? 1 : 0;
  }
  return NT.Move.idle(o) ? 2 : 3;
};

// The next cell (nx, ny) cannot be entered. Decide what to do about it; true = a hop was started anyway (cells traded).
NT.Move._blocked = function (world, e, m, nx, ny) {
  const M = NT.Move, occ = NT.Occ.at(world, nx, ny, M._occ);
  e.blocked++;
  if (++m.stuck > M.STUCK) { M._end(e, m, m.make ? M.IDLE : M.FAILED); return false; }
  // a small body is only kept out by a solid body or a full house; then ONE of the five leaving is enough
  const one = e.body === 'small' && occ.length > 0 && occ[0].body === 'small';
  let pass = 0, head = 0, idle = 0, hard = 0;
  for (let i = 0; i < occ.length; i++) {
    const k = M._kind(world, e, occ[i]);
    if (k === 0) pass++; else if (k === 1) head++; else if (k === 2) idle++; else hard++;
  }
  if (m.make) {                                               // only stepping aside: never push the problem further than allowed
    if (hard || head || (idle && m.depth >= 2) || e.blocked > M.WAIT) { M._end(e, m, M.IDLE); return false; }
  }
  const plain = !m.range && !m.adj && !m.make;
  const stays = one ? pass + head === 0 : hard + idle > 0;    // whoever is there is not about to leave by itself
  if (plain && stays && e.pathI === e.path.length - 1 && nx === m.gx && ny === m.gy) { M._settle(world, e, m); return false; }
  if (one ? hard === occ.length : hard > 0) { m.hard = true; M._around(world, e, m); }
  else if (one) {
    if (!pass) {
      for (let i = 0; i < occ.length && head; i++) if (M._kind(world, e, occ[i]) === 1) return M._trade(world, e, m, nx, ny, occ[i]);
      for (let i = 0; i < occ.length; i++) if (M._kind(world, e, occ[i]) === 2 && M._nudge(world, e, occ[i], m.depth + 1)) return false;
      for (let i = 0; i < occ.length; i++) if (M._kind(world, e, occ[i]) === 2) return M._trade(world, e, m, nx, ny, occ[i]);
    }
  } else {
    let room = true;
    for (let i = 0; i < occ.length; i++) if (M._kind(world, e, occ[i]) === 2 && !M._nudge(world, e, occ[i], m.depth + 1)) room = false;
    if (!pass && (head || !room) && !m.make) {
      // re-read: nudges may have started some of them moving
      let all = true;
      for (let i = 0; i < occ.length; i++) { const k = M._kind(world, e, occ[i]); if (k !== 1 && k !== 2) all = false; }
      if (all && M._trade(world, e, m, nx, ny, null)) return true;
    }
  }
  if (e.blocked >= M.WAIT && !m.make) {
    if (!hard && M._jam(world, e, m, nx, ny, occ, one)) return true;
    if (!hard) m.hard = false;
    M._around(world, e, m);
  }
  if (plain && e.blocked > M.GIVE_UP) {
    const r = 2 + ((m.grp / 5) | 0);
    if (Math.abs(e.cx - m.ox) <= r && Math.abs(e.cy - m.oy) <= r) M._end(e, m, M.ARRIVED);
  }
  return false;
};

// Ask the path queue for a route around standing units (throttled; retries back off).
NT.Move._around = function (world, e, m) {
  if (m.ticket || world.tick < m.replanAt) return;
  m.replanAt = world.tick + (NT.Move.WAIT << Math.min(m.backoff, 3));
  m.backoff++;
  NT.Move._plan(world, e, m, true);
};

// The last cell of a plain move is taken by someone who stays: head for the nearest free cell around the goal
// instead, or stop here if nothing free is nearer.
NT.Move._settle = function (world, e, m) {
  const M = NT.Move, r = 2 + ((m.grp / 5) | 0);
  const offs = NT.circleOffsets(r), mine = (e.cx - m.ox) * (e.cx - m.ox) + (e.cy - m.oy) * (e.cy - m.oy);
  const region = NT.Path.region(world, e.cx, e.cy);
  for (let k = 0; k < offs.length && offs[k][2] < mine && m.settled < 4; k++) {
    const x = m.ox + offs[k][0], y = m.oy + offs[k][1];
    if (NT.Path.region(world, x, y) !== region || !NT.Occ.canStand(world, e.body, x, y, e.id)) continue;
    m.settled++;
    m.gx = x; m.gy = y; m.partial = false; m.avoid = false;
    e.path.length = 0; e.pathI = 0; e.blocked = 0;
    M._plan(world, e, m, false);
    return;
  }
  M._end(e, m, M.ARRIVED);
};

// Send idle unit `o` one cell out of the way: path = [cell], make = who asked.
NT.Move._makeWay = function (world, o, cell, by, depth) {
  const om = NT.Move.state(o), w = world.w, p = o.path || (o.path = []);
  p.length = 0; p.push(cell); o.pathI = 0; o.blocked = 0;
  om.st = NT.Move.MOVING; om.make = by.id; om.depth = depth;
  om.ticket = 0; om.asked = 0; om.avoid = false; om.partial = false; om.stuck = 0; om.best = Infinity;
  om.gx = om.ox = cell % w; om.gy = om.oy = (cell - om.gx) / w; om.range = 0; om.adj = 0; om.tgt = 0; om.grp = 1;
  om.pushedFrom = o.cy * w + o.cx; om.pushedAt = world.tick;
};

// Idle friend `o` stands where `e` wants to go: send it to a neighbouring cell off e's route — sideways for
// preference, never straight back where it was just pushed from. If every neighbour is taken it may push ONE
// further rank of idle friends (depth). true = it is leaving.
NT.Move._nudge = function (world, e, o, depth) {
  const M = NT.Move, w = world.w, h = world.h, D = NT.DIRS8, om = M.state(o);
  const pdx = o.cx - e.cx, pdy = o.cy - e.cy, ep = e.path, ei = e.pathI;
  const a1 = ep && ei + 1 < ep.length ? ep[ei + 1] : -1, a2 = ep && ei + 2 < ep.length ? ep[ei + 2] : -1;
  let best = -1, bs = -1, push = -1, ps = -1;
  for (let k = 0; k < 8; k++) {
    const x = o.cx + D[k][0], y = o.cy + D[k][1];
    if (x < 0 || y < 0 || x >= w || y >= h || (x === e.cx && y === e.cy)) continue;
    const i = y * w + x;
    if (i === a1 || i === a2 || (i === om.pushedFrom && world.tick - om.pushedAt < 40)) continue;
    if (!NT.Occ.walkable(world, x, y) || (k > 3 && (!NT.Occ.walkable(world, x, o.cy) || !NT.Occ.walkable(world, o.cx, y)))) continue;
    const dot = D[k][0] * pdx + D[k][1] * pdy, sc = dot === 0 ? 2 : dot > 0 ? 1 : 0;
    if (NT.Occ.canStand(world, o.body, x, y, o.id)) { if (sc > bs) { bs = sc; best = i; } }
    else if (sc > ps && depth < 2 && M._pushable(world, o, x, y)) { ps = sc; push = i; }
  }
  if (best < 0 && push >= 0) {
    const occ = NT.Occ.at(world, push % w, (push / w) | 0, []);
    let ok = true;
    for (let i = 0; i < occ.length && ok; i++) if (!M._nudge(world, o, occ[i], depth + 1)) ok = false;
    if (ok) best = push;
  }
  if (best < 0) return false;
  M._makeWay(world, o, best, e, depth);
  return true;
};
// Is the cell held only by idle friends of `o` (so that a make-way chain may go through it)?
NT.Move._pushable = function (world, o, x, y) {
  const occ = NT.Occ.at(world, x, y, []);
  if (!occ.length) return false;
  for (let i = 0; i < occ.length; i++) if (!NT.isAlly(world, o.owner, occ[i].owner) || !NT.Move.idle(occ[i])) return false;
  return true;
};

// Jam breaker, after WAIT ticks: if everyone in the wanted cell is a standing friend that is NOT going e's way
// (cross or counter traffic, each waiting on someone else), trade cells with them; whoever is displaced re-plans.
// Friends queueing in e's direction are left alone — that is just a queue.
NT.Move._jam = function (world, e, m, nx, ny, occ, one) {
  const M = NT.Move, w = world.w, dx = nx - e.cx, dy = ny - e.cy;
  let pick = null;
  for (let i = 0; i < occ.length; i++) {
    const o = occ[i], k = M._kind(world, e, o);
    let ok = k === 1 || k === 2;
    if (k === 0 && o.hopT < 0) {
      const nxt = o.path && o.pathI < o.path.length ? o.path[o.pathI] : -1;
      ok = nxt < 0 || ((nxt % w) - o.cx) * dx + (((nxt / w) | 0) - o.cy) * dy <= 0;
    }
    if (one) { if (ok && !pick) pick = o; } else if (!ok) return false;
  }
  if (one && !pick) return false;
  return M._trade(world, e, m, nx, ny, pick, true);
};

// Trade cells: `e` hops into (nx, ny) while the occupants hop into e's cell. `only` = a single small body to trade
// with (e small, cell full); otherwise everyone in both cells changes sides, which is always a legal arrangement.
// The caller has vetted the occupants. e's own cell mates must be going e's way or be idle — or, when `forced`
// (jam), merely be friends able to move.
NT.Move._trade = function (world, e, m, nx, ny, only, forced) {
  const M = NT.Move, w = world.w, mx = e.cx, my = e.cy, mi = my * w + mx, ni = ny * w + nx;
  const there = only ? [only] : NT.Occ.at(world, nx, ny, []), here = [e];
  if (!only && e.body === 'small') {
    const mates = NT.Occ.at(world, mx, my, M._mates);
    for (let i = 0; i < mates.length; i++) {
      const c = mates[i];
      if (c === e) continue;
      if (c.hopT >= 0 || !NT.isAlly(world, e.owner, c.owner)) return false;
      const cm = c.mv, moving = cm && cm.st === M.MOVING;
      const going = moving && c.path && c.pathI < c.path.length && c.path[c.pathI] === ni;
      if (!going && !M.idle(c) && !(forced && moving)) return false;
      here.push(c);
    }
  }
  for (let i = 0; i < there.length; i++) NT.Occ.release(world, there[i]);
  for (let i = 0; i < here.length; i++) NT.Occ.release(world, here[i]);
  for (let i = 0; i < here.length; i++) M._cross(world, here[i], nx, ny, ni, e, forced);
  for (let i = 0; i < there.length; i++) M._cross(world, there[i], mx, my, mi, e, forced);
  return true;
};
// One unit's half of a trade: hop into (cx, cy). Its route continues if that was its next cell anyway; a unit
// with a goal of its own re-plans on landing; an idle one just makes way.
NT.Move._cross = function (world, u, cx, cy, ci, by, forced) {
  const M = NT.Move, um = M.state(u);
  if (um.st !== M.MOVING) M._makeWay(world, u, ci, by, 1);
  if (u.path && u.pathI < u.path.length && u.path[u.pathI] === ci) { M._hop(world, u, um, cx, cy, forced); u.pathI++; return; }
  M._hop(world, u, um, cx, cy, true);
  if (u.path) u.path.length = 0;
  u.pathI = 0;
};

// ---------------------------------------------------------------------------
// Air movement
// ---------------------------------------------------------------------------
NT.Move._air = function (world, e, m) {
  const M = NT.Move, T = NT.TILE;
  if (m.st === M.MOVING) {
    const t = m.tgt ? world.byId.get(m.tgt) : null, b = m.adj ? world.byId.get(m.adj) : null, to = t || b;
    const tx = to ? to.x : (m.gx + 0.5) * T, ty = to ? to.y : (m.gy + 0.5) * T;
    const stop = b ? T : m.range, d = to ? NT.distTo(e.x, e.y, to) : NT.dist(e.x, e.y, tx, ty);
    if (m.adj && !b) M._end(e, m, M.FAILED);
    else if (d <= stop) M._end(e, m, M.ARRIVED);
    else {
      const v = M.speed(world, e), want = Math.atan2(ty - e.y, tx - e.x);
      e.facing = NT.turnToward(e.facing, want, e.def.move.turnRad);
      if (!stop && d <= v) { e.x = tx; e.y = ty; M._end(e, m, M.ARRIVED); }
      else {
        // creep while the nose is still coming round, so a tight turn never becomes an orbit
        const step = Math.min(d - stop + 0.01, v * Math.max(0.15, Math.cos(NT.angDiff(e.facing, want))));
        e.x += Math.cos(e.facing) * step; e.y += Math.sin(e.facing) * step;
      }
    }
  }
  const air = world.air;
  for (let i = 0; i < air.length; i++) {
    const o = air[i];
    if (o === e || !o.alive) continue;
    let dx = e.x - o.x, dy = e.y - o.y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= T * T) continue;
    let d = Math.sqrt(d2);
    if (d < 0.01) { const a = (e.id * 2.399963) % NT.TAU; dx = Math.cos(a); dy = Math.sin(a); d = 1; }
    const push = M.SEPARATION * (1 - Math.sqrt(d2) / T);
    e.x += dx / d * push; e.y += dy / d * push;
  }
  const r = e.def.radius;
  e.x = NT.clamp(e.x, r, world.w * T - r); e.y = NT.clamp(e.y, r, world.h * T - r);
  e.cx = NT.clamp(NT.cellOf(e.x), 0, world.w - 1); e.cy = NT.clamp(NT.cellOf(e.y), 0, world.h - 1);
};

NT.system('move', 40, {
  step: function (world) {
    const ents = world.ents, M = NT.Move;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive || e.kind !== 'unit' || e.hidden) continue;
      if (e.layer === 'air') M._air(world, e, M.state(e));
      else if (e.mv && (e.hopT >= 0 || e.mv.st === M.MOVING)) M._ground(world, e, e.mv);
    }
  },
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
NT.Orders = { types: {} };

NT.Orders.define = function (type, impl) { NT.Orders.types[type] = impl; };

NT.Orders._start = function (world, e, o) {
  e.order = o;
  const impl = NT.Orders.types[o.type];
  if (impl.start) impl.start(world, e, o);
};
NT.Orders._end = function (world, e) {
  const o = e.order;
  if (!o) return;
  e.order = null;
  const impl = NT.Orders.types[o.type];
  if (impl && impl.end) impl.end(world, e, o);
};

NT.Orders.give = function (world, e, order, queue) {
  if (!e.alive || e.kind !== 'unit' || !order || !NT.Orders.types[order.type]) return false;
  if (queue && e.order) { e.queue.push(order); return true; }
  NT.Orders._end(world, e);
  e.queue.length = 0;
  NT.Orders._leavePost(e);
  NT.Orders._start(world, e, order);
  return true;
};

NT.Orders.next = function (world, e) {
  NT.Orders._end(world, e);
  while (!e.order && e.queue.length) {
    const o = e.queue.shift();
    if (NT.Orders.types[o.type]) NT.Orders._start(world, e, o);
  }
  if (!e.order) NT.Orders._post(e);
};

NT.Orders.clear = function (world, e) {
  NT.Orders._end(world, e);
  e.queue.length = 0; e.target = 0;
  NT.Move.stop(world, e);
  NT.Orders._post(e);
};

// An order (or a stop) cancels whatever the idle guard was up to.
NT.Orders._leavePost = function (e) { if (e.mv) e.mv.guard = 0; };
// Going idle: wherever the unit comes to rest is the post it guards from now on (never the one it left behind).
NT.Orders._post = function (e) {
  NT.Orders._leavePost(e);
  if (e.hopT >= 0) { e.homeX = e.hopToX; e.homeY = e.hopToY; } else { e.homeX = e.x; e.homeY = e.y; }
};

// Close on target `t` until a weapon bears, then stand and let combat.js shoot. true = in reach right now.
NT.Orders._eo = { range: 0, target: null };
NT.Orders._engage = function (world, e, t) {
  const M = NT.Move, m = M.state(e);
  if (NT.Combat.bears(world, e, t)) {
    if (m.st === M.MOVING) M.stop(world, e);
    return true;
  }
  const tc = t.cy * world.w + t.cx;
  if (world.tick >= m.chaseAt && (m.st !== M.MOVING || m.chaseCell !== tc)) {
    const o = NT.Orders._eo;
    o.range = NT.Combat.approach(world, e, t); o.target = t;
    m.chaseAt = world.tick + 10; m.chaseCell = tc;
    if (o.range > 0) M.to(world, e, t.cx, t.cy, o);
    o.target = null;
  }
  return false;
};

// A new engagement must not inherit the re-plan throttle of the last one.
NT.Orders._fresh = function (m) { m.chaseAt = 0; m.chaseCell = -1; };

// Is the walk toward the target going nowhere? Walled off (the move failed), or crowded out: it has stood blocked
// for VAIN ticks since a search for a way round found none (every cell in reach of the target is taken).
// Whoever engages then picks something else.
NT.Orders.VAIN = 40;
NT.Orders._vain = function (world, m) {
  if (world.tick < m.chaseAt) return false;
  return m.st === NT.Move.FAILED || (m.st === NT.Move.MOVING && m.noWay > 0 && world.tick - m.noWay >= NT.Orders.VAIN);
};
// Give up on target t: not worth acquiring again for 3 s.
NT.Orders._giveUp = function (world, e, m, t) { m.ignore = t.id; m.ignoreT = world.tick + 60; e.target = 0; };

// Idle units: keep the post, chase what combat acquired (aggressive only), walk home afterwards.
NT.Orders._idle = function (world, e) {
  const M = NT.Move, m = e.mv;
  if (m && m.make) return;                                    // stepping aside for a friend
  const t = e.target ? world.byId.get(e.target) : null;
  if (!t || e.stance !== 'aggressive' || (m && m.guard === 2)) {
    if (!m) return;
    if (m.guard === 1) {                                      // the chase is over
      m.guard = 2;
      M.to(world, e, NT.cellOf(e.homeX), NT.cellOf(e.homeY), null);
    } else if (m.guard === 2) {
      if (m.st !== M.MOVING) { m.guard = 0; M.stop(world, e); }
    } else if (m.st !== M.MOVING && e.hopT < 0) { e.homeX = e.x; e.homeY = e.y; }
    return;
  }
  const mm = M.state(e);
  if (mm.guard !== 1) { mm.guard = 1; NT.Orders._fresh(mm); }
  const far = NT.dist(e.x, e.y, e.homeX, e.homeY) > world.rules.leash * NT.TILE;
  const lost = NT.Orders._vain(world, mm);                               // cannot get at it
  if ((far || lost) && !NT.Combat.bears(world, e, t)) {
    if (lost) NT.Orders._giveUp(world, e, mm, t);
    e.target = 0;
    return;
  }
  NT.Orders._engage(world, e, t);
};

NT.Orders._mo = { group: 1 };
NT.Orders.define('move', {
  start: function (world, e, o) { const g = NT.Orders._mo; g.group = o.n || 1; NT.Move.to(world, e, o.cx, o.cy, g); },
  tick: function (world, e) { return e.mv.st !== NT.Move.MOVING; },
  end: function (world, e) { NT.Move.stop(world, e); },
});

NT.Orders.define('amove', {
  start: function (world, e, o) { const g = NT.Orders._mo; g.group = o.n || 1; o.eng = false; NT.Move.to(world, e, o.cx, o.cy, g); },
  tick: function (world, e, o) {
    const M = NT.Move, m = e.mv, t = e.target ? world.byId.get(e.target) : null;
    if (t) {
      if (!o.eng) { o.eng = true; o.ax = e.x; o.ay = e.y; NT.Orders._fresh(m); }
      const far = NT.dist(e.x, e.y, o.ax, o.ay) > world.rules.leash * NT.TILE;
      if ((far || NT.Orders._vain(world, m)) && !NT.Combat.bears(world, e, t)) NT.Orders._giveUp(world, e, m, t);
      else { NT.Orders._engage(world, e, t); return false; }
    }
    if (o.eng) {                                              // fight over: back on the road
      o.eng = false;
      const g = NT.Orders._mo; g.group = o.n || 1;
      M.to(world, e, o.cx, o.cy, g);
      return false;
    }
    return m.st !== M.MOVING;
  },
  end: function (world, e) { NT.Move.stop(world, e); },
});

NT.Orders.define('attack', {
  start: function (world, e) { NT.Orders._fresh(NT.Move.state(e)); },
  tick: function (world, e, o) {
    const t = world.byId.get(o.target);
    if (!t || !NT.Combat.valid(world, e, t)) return true;
    e.target = t.id;
    if (NT.Orders._engage(world, e, t) || !NT.Orders._vain(world, e.mv)) return false;
    NT.Orders._giveUp(world, e, e.mv, t);                     // out of reach for good: the order ends, something else will do
    return true;
  },
  end: function (world, e, o) { if (e.target === o.target) e.target = 0; NT.Move.stop(world, e); },
});

NT.system('orders', 30, {
  step: function (world) {
    const ents = world.ents, O = NT.Orders;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive || e.kind !== 'unit' || e.hidden) continue;
      if (!e.order) { if (e.queue.length) O.next(world, e); else O._idle(world, e); }
      const o = e.order;
      if (o && O.types[o.type].tick(world, e, o) && e.order === o) O.next(world, e);
    }
  },
});

// ---------------------------------------------------------------------------
// Group destinations
// ---------------------------------------------------------------------------
// Capacity of a destination cell once the units that are staying there (not part of the group) are counted.
NT.Move._cap = function (world, S, i, k) {
  const INF = NT.INF_PER_CELL, M = NT.Move;
  let big = 1, small = INF;
  const s = world.occ[i];
  if (s) { const o = world.byId.get(s); if (o && o.hopT < 0 && !(o.mv && (o.mv.stamp === S.stamp || o.mv.st === M.MOVING))) { big = 0; small = 0; } }
  for (let j = 0; j < INF; j++) {
    const id = world.inf[i * INF + j];
    if (!id) continue;
    const o = world.byId.get(id);
    if (o && o.hopT < 0 && !(o.mv && (o.mv.stamp === S.stamp || o.mv.st === M.MOVING))) { big = 0; if (small > 0) small--; }
  }
  S.capL[k] = big; S.capS[k] = small; S.useL[k] = 0; S.useS[k] = 0;
};

// Add the next usable cell of the growing blob around the anchor. false = the region is exhausted.
NT.Move._grow = function (world, S, comp, region, ax, ay) {
  const w = world.w, h = world.h, heap = S.heap, mark = S.mark, D = NT.DIRS4;
  while (heap.size()) {
    const i = heap.pop(), x = i % w, y = (i - x) / w;
    for (let d = 0; d < 4; d++) {
      const nx = x + D[d][0], ny = y + D[d][1];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const ni = ny * w + nx;
      if (mark[ni] === S.stamp || comp[ni] !== region) continue;
      mark[ni] = S.stamp;
      heap.push(ni, (nx - ax) * (nx - ax) + (ny - ay) * (ny - ay));
    }
    const k = S.cells.length;
    NT.Move._cap(world, S, i, k);
    if (!S.capL[k] && !S.capS[k]) continue;
    S.cells.push(i);
    return true;
  }
  return false;
};

// Destination cell for every unit of a group sent to world point (x, y): one cell per large body, up to
// NT.INF_PER_CELL small bodies per cell, one cell per flyer; cells come from a compact blob of connected walkable
// ground around the point. The group's shape is squeezed into the blob, nearest unit first, so the front rank ends
// up on the far side and nobody has to walk through a parked friend. Returns out[i] = cell index for units[i].
NT.Move.spread = function (world, units, x, y, out) {
  const M = NT.Move, S = M._sys(world), w = world.w, h = world.h, T = NT.TILE, n = units.length, INF = NT.INF_PER_CELL;
  const tx = NT.clamp(NT.cellOf(x), 0, w - 1), ty = NT.clamp(NT.cellOf(y), 0, h - 1), ti = ty * w + tx;
  out = out || []; out.length = n;
  for (let i = 0; i < n; i++) out[i] = ti;
  if (n < 2) return out;
  const order = [];
  let sx = 0, sy = 0, lead = null, nL = 0, nS = 0;
  S.stamp++;
  for (let i = 0; i < n; i++) {
    const u = units[i];
    order.push(i); sx += u.x; sy += u.y;
    M.state(u).stamp = S.stamp;
    if (u.layer !== 'air') { if (u.body === 'small') nS++; else nL++; }
  }
  sx /= n; sy /= n;
  order.sort(function (a, b) {
    return NT.dist2(units[a].x, units[a].y, x, y) - NT.dist2(units[b].x, units[b].y, x, y) || units[a].id - units[b].id;
  });
  let far = 1;
  for (let i = 0; i < n; i++) far = Math.max(far, NT.dist(units[i].x, units[i].y, sx, sy));
  for (let i = 0; i < n && !lead; i++) if (units[order[i]].layer !== 'air') lead = units[order[i]];

  // ground: grow a blob of free cells around the reachable cell nearest to the click
  let ax = tx, ay = ty, blob = 0;
  S.cells.length = 0; S.heap.clear();
  if (lead) {
    const comp = NT.Path._sys(world).comp, region = comp[lead.cy * w + lead.cx];
    const a = region ? NT.spiral(tx, ty, Math.max(w, h), function (cx, cy) {
      return cx >= 0 && cy >= 0 && cx < w && cy < h && comp[cy * w + cx] === region;
    }) : null;
    if (a) {
      ax = a[0]; ay = a[1];
      S.mark[ay * w + ax] = S.stamp; S.heap.push(ay * w + ax, 0);
      const want = nL + Math.ceil(nS / INF) + 1 + (n >> 3);
      while (S.cells.length < want && M._grow(world, S, comp, region, ax, ay)) { /* collecting */ }
      for (let k = 0; k < S.cells.length; k++) {
        const c = S.cells[k], cx = c % w;
        blob = Math.max(blob, NT.dist(cx, (c - cx) / w, ax, ay));
      }
      const squeeze = Math.min(1, (blob + 0.5) * T / far);
      for (let q = 0; q < n; q++) {
        const u = units[order[q]];
        if (u.layer === 'air') continue;
        const small = u.body === 'small';
        const ix = (ax + 0.5) * T + (u.x - sx) * squeeze, iy = (ay + 0.5) * T + (u.y - sy) * squeeze;
        let best = -1;
        for (let tries = 0; best < 0 && tries < 64; tries++) {
          let bd = Infinity;
          for (let k = 0; k < S.cells.length; k++) {
            // small bodies pack into cells their kind already opened; a large body needs an untouched cell
            if (small ? (!S.useS[k] || S.useS[k] >= S.capS[k]) : (S.useL[k] || S.useS[k] || !S.capL[k])) continue;
            const c = S.cells[k], cx = c % w, d = NT.dist2((cx + 0.5) * T, ((c - cx) / w + 0.5) * T, ix, iy);
            if (d < bd) { bd = d; best = k; }
          }
          for (let k = 0; small && best < 0 && k < S.cells.length; k++) if (!S.useL[k] && !S.useS[k] && S.capS[k]) best = k;
          if (best < 0 && !M._grow(world, S, comp, region, ax, ay)) break;
        }
        if (best < 0) { out[order[q]] = ay * w + ax; continue; }
        if (small) S.useS[best]++; else S.useL[best] = 1;
        out[order[q]] = S.cells[best];
      }
    }
  }
  // flyers: one cell each, rings around the click, nearest flyer first
  const offs = NT.circleOffsets(8);
  let k = 0;
  for (let q = 0; q < n; q++) {
    const u = units[order[q]];
    if (u.layer !== 'air') continue;
    for (; k < offs.length; k++) {
      const cx = tx + offs[k][0], cy = ty + offs[k][1];
      if (cx >= 0 && cy >= 0 && cx < w && cy < h) { out[order[q]] = cy * w + cx; k++; break; }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Commands (the handlers trust nothing: ownership via NT.ownUnits, junk ignored)
// ---------------------------------------------------------------------------
NT.Move._us = [];
NT.Move._dest = [];

// Own units of the command that are able to walk, each once.
NT.Move._movers = function (world, p, ids) {
  const us = NT.ownUnits(world, p, Array.isArray(ids) ? ids : null, NT.Move._us);
  let j = 0;
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    if (!(u.def.move.speedPx > 0) || u.deployed || us.indexOf(u) < i) continue;
    us[j++] = u;
  }
  us.length = j;
  return us;
};

NT.Move._cmdMove = function (world, p, c, type) {
  if (!c || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
  const us = NT.Move._movers(world, p, c.ids);
  if (!us.length) return;
  const T = NT.TILE, w = world.w;
  const x = NT.clamp(c.x, 0, world.w * T - 1), y = NT.clamp(c.y, 0, world.h * T - 1);
  const dest = NT.Move.spread(world, us, x, y, NT.Move._dest);
  for (let i = 0; i < us.length; i++) {
    const cx = dest[i] % w;
    NT.Orders.give(world, us[i], { type: type, x: x, y: y, cx: cx, cy: (dest[i] - cx) / w, n: us.length }, !!c.queue);
  }
};

NT.command('move', function (world, p, c) { NT.Move._cmdMove(world, p, c, 'move'); });
NT.command('amove', function (world, p, c) { NT.Move._cmdMove(world, p, c, 'amove'); });

NT.command('stop', function (world, p, c) {
  const us = NT.ownUnits(world, p, c && Array.isArray(c.ids) ? c.ids : null, NT.Move._us);
  for (let i = 0; i < us.length; i++) NT.Orders.clear(world, us[i]);
});

NT.command('stance', function (world, p, c) {
  if (!c || (c.stance !== 'aggressive' && c.stance !== 'hold' && c.stance !== 'passive')) return;
  const us = NT.ownUnits(world, p, Array.isArray(c.ids) ? c.ids : null, NT.Move._us);
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    u.stance = c.stance;
    if (u.order || !u.mv) continue;
    // an idle unit that was out chasing stays where the new stance caught it
    if (c.stance !== 'aggressive' && u.mv.guard) { u.mv.guard = 0; NT.Move.stop(world, u); }
    if (c.stance === 'passive') u.target = 0;
  }
});

NT.command('attack', function (world, p, c) {
  const t = c ? world.byId.get(c.target) : null;
  if (!t || !t.alive || t.hidden || !NT.Fog.canSee(world, p.team, t)) return;
  const us = NT.ownUnits(world, p, Array.isArray(c.ids) ? c.ids : null, NT.Move._us);
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    if (u !== t && us.indexOf(u) === i && NT.Combat.valid(world, u, t)) NT.Orders.give(world, u, { type: 'attack', target: t.id }, !!c.queue);
  }
});

// ---------------------------------------------------------------------------
// NT.debugCheck(world) -> string[]   invariants of the grids and the entity table ([] = sound)
// ---------------------------------------------------------------------------
NT.debugCheck = function (world) {
  const errs = [], w = world.w, h = world.h, INF = NT.INF_PER_CELL, T = NT.TILE, fin = Number.isFinite;
  const bad = function (msg) { if (errs.length < 30) errs.push('tick ' + world.tick + ': ' + msg); };
  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive) continue;
    const who = e.def.id + '#' + e.id;
    if (world.byId.get(e.id) !== e) bad(who + ' is alive but not in byId');
    if (!fin(e.x) || !fin(e.y) || !fin(e.hp) || !fin(e.facing) || !fin(e.aim)) bad(who + ' has a non-finite x / y / hp / facing / aim');
    if (!(e.hp >= 0 && e.hp <= e.maxHp)) bad(who + ' hp ' + e.hp + ' outside 0..' + e.maxHp);
    if (e.target && !world.byId.has(e.target)) bad(who + ' targets #' + e.target + ' which is not alive');
    if (e.hidden) continue;
    if (e.kind === 'building') {
      for (let y = e.cy; y < e.cy + e.h; y++) for (let x = e.cx; x < e.cx + e.w; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (world.occ[y * w + x] !== e.id) bad(who + ' does not own footprint cell ' + x + ',' + y);
      }
      continue;
    }
    if (!(e.cx >= 0 && e.cy >= 0 && e.cx < w && e.cy < h)) { bad(who + ' claims a cell outside the map'); continue; }
    if (e.layer === 'air') {
      if (world.air.indexOf(e) < 0) bad(who + ' flies but is not in world.air');
      if (e.x < 0 || e.y < 0 || e.x > w * T || e.y > h * T) bad(who + ' left the map');
      continue;
    }
    const ci = e.cy * w + e.cx;
    if (e.body === 'small') {
      if (!(e.slot >= 0 && e.slot < INF) || world.inf[ci * INF + e.slot] !== e.id) bad(who + ' slot ' + e.slot + ' of cell ' + e.cx + ',' + e.cy + ' does not point back');
    } else if (world.occ[ci] !== e.id) bad(who + ' cell ' + e.cx + ',' + e.cy + ' does not point back');
    if (e.hopT >= 0) {
      const fx = NT.cellOf(e.hopFromX), fy = NT.cellOf(e.hopFromY), tx = NT.cellOf(e.hopToX), ty = NT.cellOf(e.hopToY);
      if (!(e.hopT <= 1)) bad(who + ' hopT ' + e.hopT);
      if (tx !== e.cx || ty !== e.cy) bad(who + ' hops to ' + tx + ',' + ty + ' but claims ' + e.cx + ',' + e.cy);
      if (Math.abs(fx - tx) > 1 || Math.abs(fy - ty) > 1 || (fx === tx && fy === ty)) bad(who + ' hop ' + fx + ',' + fy + ' -> ' + tx + ',' + ty + ' is not between adjacent cells');
    } else {
      const p = NT.Occ.slotPos(e.cx, e.cy, e.slot);
      if (Math.abs(e.x - p[0]) > 0.01 || Math.abs(e.y - p[1]) > 0.01) bad(who + ' stands off its cell position');
    }
  }
  for (let i = 0; i < world.air.length; i++) if (!world.air[i].alive) bad('world.air holds dead #' + world.air[i].id);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = (i - x) / w, s = world.occ[i];
    let smalls = 0;
    for (let k = 0; k < INF; k++) {
      const id = world.inf[i * INF + k];
      if (!id) continue;
      smalls++;
      const e = world.byId.get(id);
      if (!e) bad('stale id ' + id + ' in inf at ' + x + ',' + y);
      else if (e.body !== 'small' || e.hidden || e.cx !== x || e.cy !== y || e.slot !== k) bad('inf at ' + x + ',' + y + ' slot ' + k + ' holds ' + e.def.id + '#' + id + ' which claims ' + e.cx + ',' + e.cy + ' slot ' + e.slot);
    }
    if (!s) continue;
    const e = world.byId.get(s);
    if (!e) { bad('stale id ' + s + ' in occ at ' + x + ',' + y); continue; }
    if (smalls) bad('cell ' + x + ',' + y + ' holds ' + e.def.id + '#' + s + ' and ' + smalls + ' small bodies');
    if (e.kind === 'building') {
      if (x < e.cx || y < e.cy || x >= e.cx + e.w || y >= e.cy + e.h) bad(e.def.id + '#' + s + ' owns cell ' + x + ',' + y + ' outside its footprint');
    } else if (e.body !== 'large' || e.hidden || e.cx !== x || e.cy !== y) bad('occ at ' + x + ',' + y + ' holds ' + e.def.id + '#' + s + ' which claims ' + e.cx + ',' + e.cy);
  }
  return errs;
};
