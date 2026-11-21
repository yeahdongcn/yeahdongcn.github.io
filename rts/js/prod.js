'use strict';
// ============================================================================
// NEON TURF — prod.js : production queues, placement, selling, repair  (HEADLESS-SAFE, DETERMINISTIC)
// System 'prod' (order 10). Commands: produce, cancel, place, sell, repair, rally, primary.
//
// STATE — player.queues[queueId] = { id, kind: 'building' | 'unit', items: [{def, paid, progress}], ready: null }
// for every queue of the player's faction. Only items[0] progresses. A finished unit walks out of a producer; a
// finished structure moves to `ready` (a def object) and the queue holds until it is placed or cancelled.
// Commands and events carry def IDS (strings); queue items, `ready` and the rows of options() hold def OBJECTS.
//
// WHAT CAN BE BUILT (the HUD build menu and the AI read exactly this):
//   NT.Prod.options(world, player, out?) -> [{def, queue, ok, reason, missing, count, progress, ready, cap}]
//       one row per def of the player's faction that has a queue, declaration order. ok: may be queued now.
//       reason: 'ok' | 'producer' (no alive own building produces its queue) | 'prereq' | 'limit'.
//       missing: def ids of unmet `requires`. count: how many are queued. progress: 0..1 if it is the item being
//       built. ready: it is the finished structure waiting to be placed. cap: def.limit reached (alive + queued + ready).
//   NT.Prod.canProduce(world, player, def) -> {ok, reason}      def = object or id; reason as above, or 'def'
//   NT.Prod.count(world, player, def) -> alive + queued + ready of that def
//   NT.Prod.producers(world, player, queueId) -> number of alive own buildings producing that queue
//   NT.Prod.producer(world, player, queueId) -> the building new units of that queue leave from (primary, else oldest)
// SPEED: (1 + rules.producerBonus x (producers - 1), capped at rules.producerBonusMax) x (rules.lowPowerProd while
// low on power) x player.prodMul. PAYMENT is progressive: each tick the head item asks for cost x speed / buildTicks
// and takes what the player can afford; with nothing to take it stalls ('nofunds', at most one per 3 s). An item
// whose producer or prerequisite is gone pauses and resumes by itself.
//
// PLACEMENT:
//   NT.Prod.canPlace(world, player, def, cx, cy) -> {ok, reason, cells: [{cx, cy, ok}]}     (cx, cy) = top-left cell
//       every footprint cell must be in bounds, buildable terrain, empty (no unit, no structure) and, with fog on,
//       explored by the team. Then def.placement 'anchor': within rules.buildGap empty cells (Chebyshev gap between
//       the rectangles, 0 = touching) of an alive own structure with def.anchor; 'free': instead every cell must be
//       VISIBLE to the team right now. reason: 'ok' | 'blocked' | 'vision' | 'anchor' | 'def'.
//   NT.Prod.findPlace(world, player, def, nearCx, nearCy, opts) -> [cx, cy] | null
//       the valid top-left cell whose footprint centre is nearest to (nearCx, nearCy), searched in square rings
//       (deterministic). It never covers the exit of one of the player's own producers. opts:
//         maxR      rings to search (default 12)
//         gap       N: every cell within N of the footprint must be open ground (in bounds, passable, no structure),
//                   so the new structure can always be walked around and never plugs a passage
//         avoidRes  keep 1 cell clear of resource fields and off the straight lane between each of the player's
//                   drop-offs and its field
//
// REPAIR: a building with ent.repairing heals rules.repairRate x maxHp / TPS per tick for rules.repairCost x
// def.cost x healed / maxHp credits; it stops ('repair' event, on: false) at full health or when the money runs out.
// ent.age counts the ticks a building has stood.
// ============================================================================
NT.Prod = {};
NT.Prod.EPS = 1e-6;
NT.Prod.EXIT_R = 3;        // rings around a producer's exit cell searched for room to put a new unit
NT.Prod.NOFUNDS = 60;      // min ticks between 'nofunds' events of one player
NT.Prod.LANE = 10;         // cells: resource this close to a drop-off is "its field" (findPlace avoidRes)

NT.Prod._sys = function (world) {
  return world.sys.prod || (world.sys.prod = { fac: {}, nofunds: [], made: 0, anchors: [], keep: [] });
};

// Per-faction lookups, built on first use (a faction registered after this file loaded works the same).
NT.Prod._fac = function (world, faction) {
  const S = NT.Prod._sys(world);
  let F = S.fac[faction.id];
  if (F) return F;
  F = S.fac[faction.id] = { prods: {}, list: [] };
  for (let i = 0; i < faction.defs.length; i++) {
    const d = faction.defs[i], pr = d.traits.producer;
    if (pr && d.kind === 'building') for (let k = 0; k < pr.queues.length; k++) (F.prods[pr.queues[k]] = F.prods[pr.queues[k]] || []).push(d);
    if (d.queue && faction.queueById[d.queue]) F.list.push(d);
  }
  return F;
};

NT.Prod._def = function (def) { return typeof def === 'string' ? NT.DEFS[def] || null : def || null; };

NT.Prod.producers = function (world, player, qid) {
  const ds = NT.Prod._fac(world, player.faction).prods[qid];
  let n = 0;
  for (let i = 0; ds && i < ds.length; i++) n += player.owned[ds[i].id] || 0;
  return n;
};

NT.Prod.producer = function (world, player, qid) {
  const ents = world.ents;
  let first = null;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i], pr = e.def.traits.producer;
    if (!pr || !e.alive || e.kind !== 'building' || e.owner !== player.id || e.def.faction !== player.faction.id || pr.queues.indexOf(qid) < 0) continue;
    if (e.primary) return e;
    if (!first) first = e;
  }
  return first;
};

NT.Prod.count = function (world, player, def) {
  def = NT.Prod._def(def);
  if (!def) return 0;
  const q = player.queues[def.queue];
  let n = (def.kind === 'building' ? player.owned[def.id] : player.units[def.id]) || 0;
  if (!q) return n;
  for (let i = 0; i < q.items.length; i++) if (q.items[i].def === def) n++;
  return q.ready === def ? n + 1 : n;
};

NT.Prod._why = function (world, player, def, noLimit) {
  if (!def || def.faction !== player.faction.id || !def.queue || !player.queues[def.queue]) return 'def';
  if (!NT.Prod.producers(world, player, def.queue)) return 'producer';
  for (let i = 0; i < def.requires.length; i++) if (!(player.owned[def.requires[i]] > 0)) return 'prereq';
  if (!noLimit && def.limit > 0 && NT.Prod.count(world, player, def) >= def.limit) return 'limit';
  return 'ok';
};

NT.Prod.canProduce = function (world, player, def) {
  const reason = NT.Prod._why(world, player, NT.Prod._def(def), false);
  return { ok: reason === 'ok', reason: reason };
};

NT.Prod.options = function (world, player, out) {
  const P = NT.Prod, list = P._fac(world, player.faction).list;
  out = out || []; out.length = 0;
  for (let i = 0; i < list.length; i++) {
    const d = list[i], q = player.queues[d.queue], head = q.items[0], missing = [];
    let n = 0;
    for (let k = 0; k < q.items.length; k++) if (q.items[k].def === d) n++;
    for (let k = 0; k < d.requires.length; k++) if (!(player.owned[d.requires[k]] > 0)) missing.push(d.requires[k]);
    const reason = P._why(world, player, d, false);
    out.push({ def: d, queue: d.queue, ok: reason === 'ok', reason: reason, missing: missing, count: n,
      progress: head && head.def === d ? head.progress : 0, ready: q.ready === d,
      cap: d.limit > 0 && P.count(world, player, d) >= d.limit });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------
// 0 = fine, 1 = blocked (off the map, terrain, something stands there), 2 = not seen
NT.Prod._cell = function (world, team, x, y, free) {
  if (!NT.Map.buildableTerrain(world.map, x, y)) return 1;
  const i = y * world.w + x, b = i * NT.INF_PER_CELL;
  if (world.occ[i]) return 1;
  for (let k = 0; k < NT.INF_PER_CELL; k++) if (world.inf[b + k]) return 1;
  if (world.fogEnabled === false) return 0;
  return (free ? NT.Fog.visible(world, team, x, y) : NT.Fog.explored(world, team, x, y)) ? 0 : 2;
};

// Alive own structures others may be built next to.
NT.Prod._anchors = function (world, player, out) {
  const ents = world.ents;
  out.length = 0;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (e.alive && e.kind === 'building' && e.owner === player.id && e.def.anchor) out.push(e);
  }
  return out;
};

NT.Prod._near = function (anchors, def, cx, cy, gap) {
  const w = def.size[0], h = def.size[1];
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const dx = Math.max(0, cx - (a.cx + a.w), a.cx - (cx + w)), dy = Math.max(0, cy - (a.cy + a.h), a.cy - (cy + h));
    if (dx <= gap && dy <= gap) return true;
  }
  return false;
};

NT.Prod._placeOk = function (world, player, def, cx, cy, anchors) {
  const free = def.placement === 'free';
  for (let y = cy; y < cy + def.size[1]; y++) for (let x = cx; x < cx + def.size[0]; x++) {
    if (NT.Prod._cell(world, player.team, x, y, free)) return false;
  }
  return free || NT.Prod._near(anchors, def, cx, cy, world.rules.buildGap);
};

NT.Prod.canPlace = function (world, player, def, cx, cy) {
  const P = NT.Prod, cells = [];
  def = P._def(def);
  if (!def || def.kind !== 'building' || !Number.isInteger(cx) || !Number.isInteger(cy)) return { ok: false, reason: 'def', cells: cells };
  const free = def.placement === 'free';
  let worst = 0;
  for (let y = cy; y < cy + def.size[1]; y++) for (let x = cx; x < cx + def.size[0]; x++) {
    const c = P._cell(world, player.team, x, y, free);
    cells.push({ cx: x, cy: y, ok: !c });
    if (c && (!worst || c < worst)) worst = c;
  }
  let reason = worst === 1 ? 'blocked' : worst === 2 ? 'vision' : 'ok';
  if (!worst && !free && !P._near(P._anchors(world, player, P._sys(world).anchors), def, cx, cy, world.rules.buildGap)) reason = 'anchor';
  return { ok: reason === 'ok', reason: reason, cells: cells };
};

// The cell a producer's units appear on, and the direction that leads away from the building.
NT.Prod._exitOf = function (b, out) {
  const ex = b.def.traits.producer.exit;
  out[0] = ex ? b.cx + ex[0] : b.cx + (b.w >> 1); out[1] = ex ? b.cy + ex[1] : b.cy + b.h;
  out[2] = out[0] < b.cx ? -1 : out[0] >= b.cx + b.w ? 1 : 0;
  out[3] = out[1] < b.cy ? -1 : out[1] >= b.cy + b.h ? 1 : 0;
  if (!out[2] && !out[3]) out[3] = 1;
  return out;
};

// Cells findPlace must leave alone: [x0, y0, x1, y1] boxes (inclusive) around producer exits and, with avoidRes,
// points along each drop-off's lane to its field.
NT.Prod._keepOut = function (world, player, avoidRes, out) {
  const ents = world.ents, T = NT.TILE, ex = [0, 0, 0, 0], fac = player.faction;
  out.length = 0;
  const cells = avoidRes && NT.Econ ? NT.Econ._sys(world).cells : null, res = world.map.res, w = world.w, R = NT.Prod.LANE;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.alive || e.kind !== 'building' || e.owner !== player.id) continue;
    const pr = e.def.traits.producer;
    if (pr && pr.queues.some(function (q) { return fac.queueById[q] && fac.queueById[q].kind === 'unit'; })) {
      NT.Prod._exitOf(e, ex);
      const x1 = ex[0] + ex[2] * 2, y1 = ex[1] + ex[3] * 2;
      out.push(Math.min(ex[0], x1), Math.min(ex[1], y1), Math.max(ex[0], x1), Math.max(ex[1], y1));
    }
    if (!cells || !e.def.traits.dropoff) continue;
    const bx = e.x / T, by = e.y / T;
    let sx = 0, sy = 0, n = 0;
    for (let k = 0; k < cells.length; k++) {
      const c = cells[k];
      if (!res[c]) continue;
      const x = c % w + 0.5, y = (c - c % w) / w + 0.5;
      if (Math.abs(x - bx) <= R && Math.abs(y - by) <= R) { sx += x; sy += y; n++; }
    }
    if (!n) continue;
    const steps = Math.max(1, Math.ceil(NT.dist(bx, by, sx / n, sy / n) * 2));
    for (let s = 0; s <= steps; s++) {
      const x = Math.floor(bx + (sx / n - bx) * s / steps), y = Math.floor(by + (sy / n - by) * s / steps);
      out.push(x - 1, y - 1, x + 1, y + 1);
    }
  }
  return out;
};

NT.Prod._ex = [0, 0, 0, 0];
NT.Prod.findPlace = function (world, player, def, nearCx, nearCy, opts) {
  const P = NT.Prod, S = P._sys(world);
  def = P._def(def); opts = opts || {};
  if (!def || def.kind !== 'building') return null;
  const w = def.size[0], h = def.size[1], gap = opts.gap | 0, avoidRes = !!opts.avoidRes, map = world.map;
  const anchors = P._anchors(world, player, S.anchors), keep = P._keepOut(world, player, avoidRes, S.keep);
  const at = NT.spiral(nearCx | 0, nearCy | 0, opts.maxR || 12, function (sx, sy) {
    const cx = sx - (w >> 1), cy = sy - (h >> 1);
    if (!P._placeOk(world, player, def, cx, cy, anchors)) return false;
    for (let k = 0; k < keep.length; k += 4) {
      if (cx <= keep[k + 2] && cx + w > keep[k] && cy <= keep[k + 3] && cy + h > keep[k + 1]) return false;
    }
    const m = avoidRes && gap < 1 ? 1 : gap;
    for (let y = cy - m; y < cy + h + m; y++) for (let x = cx - m; x < cx + w + m; x++) {
      const d = Math.max(cx - x, x - (cx + w - 1), cy - y, y - (cy + h - 1));       // 0 = a footprint cell
      if (avoidRes && d <= 1 && x >= 0 && y >= 0 && x < world.w && y < world.h) {
        const i = y * world.w + x;
        if (map.res[i] > 0 || map.resCap[i] > 0) return false;
      }
      if (d > 0 && d <= gap && !NT.Occ.walkable(world, x, y)) return false;
    }
    return true;
  });
  return at ? [at[0] - (w >> 1), at[1] - (h >> 1)] : null;
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
NT.Prod._deny = function (world, p, def, reason) {
  world.events.push({ t: 'denied', owner: p.id, def: typeof def === 'string' ? def : def && def.id ? def.id : null, reason: reason });
};
// An alive building of player p (commands name it by id).
NT.Prod._own = function (world, p, c) {
  const e = c ? world.byId.get(c.id) : null;
  return e && e.alive && e.kind === 'building' && e.owner === p.id ? e : null;
};

NT.command('produce', function (world, p, c) {
  const P = NT.Prod, def = c && typeof c.def === 'string' ? NT.DEFS[c.def] : null;
  let reason = P._why(world, p, def, false);
  if (reason === 'ok' && p.queues[def.queue].items.length >= world.rules.maxQueue) reason = 'queue';
  if (reason !== 'ok') { P._deny(world, p, c && c.def, reason); return; }
  p.queues[def.queue].items.push({ def: def, paid: 0, progress: 0 });
  world.events.push({ t: 'queued', owner: p.id, def: def.id });
});

NT.command('cancel', function (world, p, c) {
  const def = c && typeof c.def === 'string' ? NT.DEFS[c.def] : null, q = def && def.faction === p.faction.id ? p.queues[def.queue] : null;
  if (!q) return;
  let refund = 0;
  if (q.ready === def) { q.ready = null; refund = def.cost; }
  else {
    let i = q.items.length - 1;
    while (i >= 0 && q.items[i].def !== def) i--;
    if (i < 0) return;
    refund = q.items[i].paid;
    q.items.splice(i, 1);
  }
  NT.Econ.refund(p, refund);
  world.events.push({ t: 'cancelled', owner: p.id, def: def.id, refund: refund });
});

NT.command('place', function (world, p, c) {
  const P = NT.Prod, def = c && typeof c.def === 'string' ? NT.DEFS[c.def] : null, q = def && def.faction === p.faction.id ? p.queues[def.queue] : null;
  if (!q || q.ready !== def || !Number.isInteger(c.cx) || !Number.isInteger(c.cy) ||
      !P._placeOk(world, p, def, c.cx, c.cy, P._anchors(world, p, P._sys(world).anchors))) { P._deny(world, p, c && c.def, 'place'); return; }
  const b = NT.spawn(world, def, p.id, c.cx, c.cy);
  q.ready = null;
  p.stats.built++;
  world.events.push({ t: 'placed', owner: p.id, id: b.id, def: def.id, x: b.x, y: b.y });
  const free = def.traits.dropoff && def.traits.dropoff.freeUnit ? NT.DEFS[def.traits.dropoff.freeUnit] : null;
  if (!free) return;
  const at = NT.Econ.besideCell(world, b, free) || [b.cx + (b.w >> 1), b.cy + b.h];
  const u = NT.spawn(world, free, p.id, at[0], at[1]);
  if (u && u.def.traits.harvester) NT.Econ.work(world, u);
});

NT.command('sell', function (world, p, c) {
  const e = NT.Prod._own(world, p, c);
  if (!e || !e.def.queue) return;                             // only what can be built can be sold (never captured turf)
  const refund = world.rules.sellRefund * e.def.cost * e.hp / e.maxHp;
  NT.Econ.earn(p, refund, false);                             // income, not un-spending: the start HQ was never paid for
  NT.kill(world, e, null, { silent: true });
  world.events.push({ t: 'sold', owner: p.id, id: e.id, def: e.def.id, x: e.x, y: e.y, refund: refund });
});

NT.command('repair', function (world, p, c) {
  const e = NT.Prod._own(world, p, c);
  if (!e) return;
  const on = c.on === undefined ? !e.repairing : !!c.on;
  if (on === e.repairing || (on && e.hp >= e.maxHp)) return;
  e.repairing = on;
  world.events.push({ t: 'repair', id: e.id, owner: p.id, on: on });
});

// Does this building send units out (a producer of some unit queue of its owner's faction)?
NT.Prod._door = function (p, e) {
  const pr = e.def.traits.producer, qs = p.faction.queueById;
  for (let i = 0; pr && i < pr.queues.length; i++) if (qs[pr.queues[i]] && qs[pr.queues[i]].kind === 'unit') return true;
  return false;
};

NT.command('rally', function (world, p, c) {
  const e = NT.Prod._own(world, p, c);
  if (!e || !NT.Prod._door(p, e) || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return;
  e.rally = { x: NT.clamp(c.x, 0, world.w * NT.TILE - 1), y: NT.clamp(c.y, 0, world.h * NT.TILE - 1) };
});

NT.command('primary', function (world, p, c) {
  const e = NT.Prod._own(world, p, c), pr = e && e.def.traits.producer, ents = world.ents;
  if (!pr) return;
  for (let i = 0; i < ents.length; i++) {
    const o = ents[i], opr = o.def.traits.producer;
    if (o === e || !opr || o.owner !== p.id || !o.primary) continue;
    if (opr.queues.some(function (q) { return pr.queues.indexOf(q) >= 0; })) o.primary = false;
  }
  e.primary = true;
});

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------
// A finished unit leaves its producer. false = no room at the door yet (try again next tick).
NT.Prod._roll = function (world, p, q, def) {
  const P = NT.Prod, S = P._sys(world), b = P.producer(world, p, q.id), ex = P._ex, T = NT.TILE;
  if (!b) return false;
  P._exitOf(b, ex);
  const air = def.layer === 'air';
  const at = air ? ex : NT.spiral(ex[0], ex[1], P.EXIT_R, function (x, y) { return NT.Occ.canStand(world, def.body, x, y); });
  const u = at ? NT.spawn(world, def, p.id, at[0], at[1], { exact: !air, facing: Math.atan2(ex[3], ex[2]) }) : null;
  if (!u) return false;
  p.stats.produced++;
  world.events.push({ t: 'produced', owner: p.id, id: u.id, def: def.id, x: u.x, y: u.y });
  if (def.traits.harvester) { NT.Econ.work(world, u); return true; }
  let cx, cy;
  if (b.rally) { cx = NT.cellOf(b.rally.x); cy = NT.cellOf(b.rally.y); }
  else {                                                      // clear the door: a few cells straight out, fanned sideways
    const k = 2 + S.made % 2, side = S.made % 3 - 1;
    cx = ex[0] + ex[2] * k - ex[3] * side; cy = ex[1] + ex[3] * k + ex[2] * side;
    S.made++;
  }
  cx = NT.clamp(cx, 0, world.w - 1); cy = NT.clamp(cy, 0, world.h - 1);
  NT.Orders.give(world, u, { type: 'move', x: (cx + 0.5) * T, y: (cy + 0.5) * T, cx: cx, cy: cy, n: 1 });
  return true;
};

NT.Prod._queue = function (world, p, q) {
  const P = NT.Prod, R = world.rules, item = q.items[0], def = item.def;
  if (P._why(world, p, def, true) !== 'ok') return;           // producer or prerequisite gone: paused
  if (item.paid < def.cost - P.EPS) {
    const n = P.producers(world, p, q.id);
    const speed = Math.min(1 + R.producerBonus * (n - 1), R.producerBonusMax) * (p.power.low ? R.lowPowerProd : 1) * p.prodMul;
    const want = Math.min(def.cost * speed / def.buildTicks, def.cost - item.paid), paid = NT.Econ.spend(p, want);
    item.paid += paid;
    item.progress = Math.min(1, item.paid / def.cost);
    if (paid < want - P.EPS) {
      const S = P._sys(world);
      if (!(world.tick - S.nofunds[p.id] < P.NOFUNDS)) { S.nofunds[p.id] = world.tick; world.events.push({ t: 'nofunds', owner: p.id }); }
      return;
    }
  }
  if (item.paid < def.cost - P.EPS) return;
  item.paid = def.cost; item.progress = 1;
  if (q.kind === 'unit') { if (P._roll(world, p, q, def)) q.items.shift(); return; }
  q.items.shift();
  q.ready = def;
  world.events.push({ t: 'ready', owner: p.id, def: def.id });
};

NT.Prod._repair = function (world, e) {
  const p = world.players[e.owner], R = world.rules;
  let done = !p || e.hp >= e.maxHp;
  if (!done) {
    const heal = Math.min(R.repairRate * e.maxHp / NT.TPS, e.maxHp - e.hp), cost = R.repairCost * e.def.cost * heal / e.maxHp;
    const paid = cost > 0 ? NT.Econ.spend(p, cost) : 0, frac = cost > 0 ? paid / cost : 1;
    NT.damage(world, e, -heal * frac, null, null, null);
    done = frac < 1 - NT.Prod.EPS || e.hp >= e.maxHp - NT.Prod.EPS;
  }
  if (!done) return;
  if (e.hp > e.maxHp - NT.Prod.EPS) e.hp = e.maxHp;
  e.repairing = false;
  world.events.push({ t: 'repair', id: e.id, owner: e.owner, on: false });
};

NT.system('prod', 10, {
  init: function (world) {
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i], qs = p.faction.queues;
      for (let k = 0; k < qs.length; k++) p.queues[qs[k].id] = { id: qs[k].id, kind: qs[k].kind, items: [], ready: null };
    }
  },
  step: function (world) {
    const P = NT.Prod, ents = world.ents, ps = world.players;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive || e.kind !== 'building') continue;
      e.age++;
      if (e.repairing) P._repair(world, e);
    }
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i], qs = p.faction.queues;
      if (p.defeated) continue;
      for (let k = 0; k < qs.length; k++) {
        const q = p.queues[qs[k].id];
        if (q.items.length && !q.ready) P._queue(world, p, q);
      }
    }
  },
});
