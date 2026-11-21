'use strict';
// ============================================================================
// NEON TURF — econ.js : power, harvesting, regrow, passive income, recruits  (HEADLESS-SAFE, DETERMINISTIC)
// System 'econ' (order 20). Commands: harvest, return (and it wraps move / stop to park harvesters).
//
// MONEY — every credit moves through one of these (never touch player.credits elsewhere):
//   NT.Econ.spend(player, amount) -> paid      pays what the player can afford (never below 0), tracks stats.spent
//   NT.Econ.earn(player, amount, scaled) -> got   adds income (stats.income); scaled = true multiplies by
//                                               player.incomeMul (harvested + passive income; bounties are not scaled)
//   NT.Econ.refund(player, amount)             gives back money that was spent (cancel): un-counts stats.spent.
//                                               Selling a structure is income (earn, unscaled), not a refund.
//
// POWER — per player, every tick: power.made = sum of positive def.power of its alive buildings, power.used = the
// negative ones, power.low = used > made ('lowpower' event when it flips). ent.powered = !(def.needsPower && low);
// neutral buildings are always powered. player.radar = owns a powered building with the radar trait.
//
// HARVESTERS (trait harvester {capacity, loadTimeT, unloadTimeT}) — ent.hstate is one of NT.Econ.IDLE / TO_FIELD /
// LOADING / TO_DROP / UNLOADING / PARKED; ent.hcell = the resource cell it works (kept while it delivers: the field
// it returns to), ent.hdrop = the drop-off it is bound for, ent.htimer = next tick it looks for work, ent.cargo
// whole credits (ent.hacc carries the fraction between ticks).
// Two order types run the loop on top of move.js' order machinery:
//   {type:'harvest', cx?, cy?, cell?}   field -> load -> drop-off -> unload -> field ... (cx, cy: work near this cell;
//                                       cell: a resource cell index picked by the caller). Never finishes while there
//                                       is anything to gather or deliver; ends (unit idle, order null) when there is no
//                                       resource worth the trip or no drop-off to take a full load to.
//   {type:'return'}                     deliver now, then carry on as a 'harvest' order
// A harvester without an order looks for work NT.Econ.START ticks after it spawned or finished another order, then
// every NT.Econ.RECHECK ticks — unless the player's own move / stop command PARKED it (until a harvest / return
// command or any other order). NT.Econ.work(world, ent, cx?, cy?) -> bool puts it to work at once (prod.js does
// that for new harvesters).
// Cells: the nearest resource cell holding >= NT.Econ.MIN_CELL credits that no other harvester (of any player) has
// claimed (world.sys.econ.claims: cell -> harvester id), that it can stand on and reach; the same field first
// (within NT.Econ.FIELD cells of ent.hcell), else nearest to itself. Ties -> lower cell index.
//
// REGROW — every rules.regrowEvery ticks each map.spawners[i] adds rate x regrowEvery / TPS credits to the cells
// within its radius that are below resCap (lowest first), never under a building. Whole credits; the fraction is
// carried per spawner.
//
// INCOME (trait income {amount, everyT}): an owned building pays every everyT ticks counted from its spawn tick.
// RECRUIT (trait recruit {everyT}): an owned building spawns NT.Econ.recruitDef(world, ownerFaction) beside it every
// everyT ticks counted from the tick it was placed or changed hands (ent.htimer of a building = next recruit tick).
// ============================================================================
NT.Econ = { IDLE: 0, TO_FIELD: 1, LOADING: 2, TO_DROP: 3, UNLOADING: 4, PARKED: 5 };
NT.Econ.START = 20;        // ticks a harvester left alone waits before it goes to work
NT.Econ.RECHECK = 60;      // ticks between looks for work when there was none
NT.Econ.FIELD = 6;         // cells: resource this close to the cell being worked is "the same field"
NT.Econ.MIN_CELL = 20;     // credits a cell must hold before a harvester drives to it
NT.Econ.RETRY = 20;        // ticks before a failed drive (cell taken, ring jammed) is tried again

NT.Econ._sys = function (world) {
  let S = world.sys.econ;
  if (S) return S;
  const map = world.map, n = world.w * world.h, cells = [];
  for (let i = 0; i < n; i++) if (map.res[i] > 0 || map.resCap[i] > 0) cells.push(i);
  S = world.sys.econ = {
    claims: new Int32Array(n),                 // resource cell -> id of the harvester working / heading for it
    cells: cells,                              // every cell that can ever hold resource, ascending
    carry: new Float64Array(map.spawners.length),
    recruit: {},                               // faction id -> def a recruit building hands out (null = none)
    radar: [], tmp: [], grow: [],
  };
  return S;
};

NT.Econ.spend = function (player, amount) {
  if (!(amount > 0) || !(player.credits > 0)) return 0;
  const paid = amount < player.credits ? amount : player.credits;
  player.credits -= paid; player.stats.spent += paid;
  return paid;
};
NT.Econ.earn = function (player, amount, scaled) {
  if (!(amount > 0)) return 0;
  const got = scaled ? amount * player.incomeMul : amount;
  player.credits += got; player.stats.income += got;
  return got;
};
NT.Econ.refund = function (player, amount) {
  if (!(amount > 0)) return 0;
  player.credits += amount; player.stats.spent -= amount;
  return amount;
};

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------
NT.Econ._power = function (world) {
  const ps = world.players, ents = world.ents;
  for (let i = 0; i < ps.length; i++) { ps[i].power.made = 0; ps[i].power.used = 0; }
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i], pw = e.def.power;
    if (!pw || !e.alive || e.kind !== 'building') continue;
    const p = ps[e.owner];
    if (!p) continue;
    if (pw > 0) p.power.made += pw; else p.power.used -= pw;
  }
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i], low = p.power.used > p.power.made;
    if (low === p.power.low) continue;
    p.power.low = low;
    world.events.push({ t: 'lowpower', owner: p.id, on: low });
  }
};

// ---------------------------------------------------------------------------
// Resource cells
// ---------------------------------------------------------------------------
NT.Econ._claimed = function (world, i, selfId) {
  const c = NT.Econ._sys(world).claims, id = c[i];
  if (!id || id === selfId) return false;
  const o = world.byId.get(id), E = NT.Econ;
  if (o && o.hcell === i && (o.hstate === E.TO_FIELD || o.hstate === E.LOADING)) return true;
  c[i] = 0;                                                   // stale: its holder died or moved on
  return false;
};
NT.Econ._claim = function (world, e, i) { NT.Econ._sys(world).claims[i] = e.id; e.hcell = i; };
// The claim goes; ent.hcell stays (the field it comes back to).
NT.Econ._release = function (world, e) {
  const c = NT.Econ._sys(world).claims;
  if (e.hcell >= 0 && c[e.hcell] === e.id) c[e.hcell] = 0;
};

// Best resource cell for harvester e around cell (nx, ny): nearest, worth the trip, unclaimed, standable, reachable.
// maxR = 0 searches the whole map. -1 = none.
NT.Econ._pick = function (world, e, nx, ny, maxR) {
  const S = NT.Econ._sys(world), cells = S.cells, res = world.map.res, w = world.w, min = NT.Econ.MIN_CELL;
  const ground = e.layer !== 'air', region = ground ? NT.Path.region(world, e.cx, e.cy) : 0, r2 = maxR ? maxR * maxR : Infinity;
  let best = -1, bd = Infinity;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (res[i] < min) continue;
    const x = i % w, y = (i - x) / w, d = (x - nx) * (x - nx) + (y - ny) * (y - ny);
    if (d >= bd || d > r2 || NT.Econ._claimed(world, i, e.id)) continue;
    if (ground && (NT.Path.region(world, x, y) !== region || !NT.Occ.canStand(world, e.body, x, y, e.id))) continue;
    best = i; bd = d;
  }
  return best;
};

// Nearest alive drop-off of e's owner (null = none). Ties -> lower id.
NT.Econ.dropoff = function (world, e) {
  const ents = world.ents;
  let best = null, bd = Infinity;
  for (let i = 0; i < ents.length; i++) {
    const b = ents[i];
    if (!b.alive || b.kind !== 'building' || b.owner !== e.owner || !b.def.traits.dropoff) continue;
    const d = NT.distTo(e.x, e.y, b);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
};

// ---------------------------------------------------------------------------
// The harvest loop (order types 'harvest' and 'return'). Every step returns true when the order is over.
// ---------------------------------------------------------------------------
NT.Econ._rest = function (world, e) {
  e.hstate = NT.Econ.IDLE; e.htimer = world.tick + NT.Econ.RECHECK;
  return true;
};

// Head for the next resource cell: the field it knows first, then whatever is nearest. Nothing left: deliver
// what it carries, or rest.
NT.Econ._seek = function (world, e, o) {
  const E = NT.Econ, w = world.w;
  E._release(world, e);
  let cell = -1;
  if (e.hcell >= 0) { const hx = e.hcell % w; cell = E._pick(world, e, hx, (e.hcell - hx) / w, E.FIELD); }
  if (cell < 0) cell = E._pick(world, e, e.cx, e.cy, 0);
  if (cell < 0) return e.cargo > 0 ? E._deliver(world, e, o) : E._rest(world, e);
  return E._goCell(world, e, cell);
};
NT.Econ._goCell = function (world, e, cell) {
  const cx = cell % world.w;
  NT.Econ._claim(world, e, cell);
  e.hstate = NT.Econ.TO_FIELD; e.htimer = world.tick + NT.Econ.RETRY;
  NT.Move.to(world, e, cx, (cell - cx) / world.w, null);
  return false;
};

NT.Econ._do = { adjacentTo: null };
NT.Econ._deliver = function (world, e, o) {
  const E = NT.Econ, d = E.dropoff(world, e);
  E._release(world, e);
  if (!d) return E._rest(world, e);                           // nowhere to take it: wait with the cargo
  e.hdrop = d.id; e.hstate = E.TO_DROP; e.htimer = world.tick + E.RETRY;
  E._do.adjacentTo = d;
  NT.Move.to(world, e, d.cx, d.cy, E._do);
  E._do.adjacentTo = null;
  return false;
};

// One 'dump' event per delivery, however many ticks the unloading took.
NT.Econ._dump = function (world, e, o) {
  if (!(o.sum > 0)) return;
  world.events.push({ t: 'dump', id: e.id, owner: e.owner, amount: o.sum, x: e.x, y: e.y });
  o.sum = 0;
};

NT.Econ._first = function (world, e, o) {
  const E = NT.Econ, tr = e.def.traits.harvester, w = world.w;
  o.go = true; o.sum = 0; e.hacc = 0;
  if (o.type === 'return' ? e.cargo > 0 : e.cargo >= tr.capacity) return E._deliver(world, e, o);
  let cell = -1;
  if (o.cell >= 0 && world.map.res[o.cell] > 0 && !E._claimed(world, o.cell, e.id)) cell = o.cell;
  else if (o.cx >= 0 && o.cy >= 0) cell = E._pick(world, e, o.cx, o.cy, 0);
  if (cell < 0) return E._seek(world, e, o);
  E._release(world, e);
  return E._goCell(world, e, cell);
};

NT.Econ._tick = function (world, e, o) {
  const E = NT.Econ, tr = e.def.traits.harvester, map = world.map, w = world.w, tick = world.tick;
  if (!o.go) return E._first(world, e, o);
  switch (e.hstate) {
    case E.TO_FIELD: {
      const i = e.hcell;
      if (i < 0 || map.res[i] <= 0 || E._claimed(world, i, e.id)) return E._seek(world, e, o);   // emptied or taken meanwhile
      if (e.mv.st === NT.Move.MOVING) return false;
      if (e.hopT < 0 && e.cy * w + e.cx === i) { e.hstate = E.LOADING; e.hacc = 0; return false; }
      if (tick < e.htimer) return false;
      return E._seek(world, e, o);                            // somebody stands on it: another cell (or this one again later)
    }
    case E.LOADING: {
      const i = e.hcell;
      if (e.hopT >= 0 || e.cy * w + e.cx !== i) return E._goCell(world, e, i);     // shoved off the cell
      e.hacc += tr.capacity / tr.loadTimeT;
      let n = Math.floor(e.hacc);
      const room = tr.capacity - e.cargo;
      if (n > map.res[i]) n = map.res[i];
      if (n > room) n = room;
      e.hacc -= n; map.res[i] -= n; e.cargo += n;
      if (e.cargo >= tr.capacity) return E._deliver(world, e, o);
      return map.res[i] > 0 ? false : E._seek(world, e, o);
    }
    case E.TO_DROP: {
      const d = world.byId.get(e.hdrop);
      if (!d || d.owner !== e.owner || !d.def.traits.dropoff) return E._deliver(world, e, o);    // gone: another one
      if (e.mv.st === NT.Move.MOVING) return false;
      if (e.hopT < 0 && NT.touching(e, d)) { e.hstate = E.UNLOADING; e.hacc = 0; return false; }
      return tick < e.htimer ? false : E._deliver(world, e, o);                    // ring jammed: try again
    }
    case E.UNLOADING: {
      const d = world.byId.get(e.hdrop), p = world.players[e.owner];
      if (!d || d.owner !== e.owner || e.hopT >= 0 || !NT.touching(e, d)) { E._dump(world, e, o); return E._deliver(world, e, o); }
      e.hacc += tr.capacity / tr.unloadTimeT;
      let n = Math.floor(e.hacc);
      if (n > e.cargo) n = e.cargo;
      e.hacc -= n; e.cargo -= n;
      if (p) o.sum += E.earn(p, n, true);
      if (e.cargo > 0) return false;
      E._dump(world, e, o);
      if (o.type === 'return') { NT.Orders.give(world, e, { type: 'harvest' }); return false; }
      return E._seek(world, e, o);
    }
  }
  return E._first(world, e, o);
};

NT.Econ._end = function (world, e, o) {
  const E = NT.Econ;
  E._dump(world, e, o);
  E._release(world, e);
  NT.Move.stop(world, e);
  if (e.hstate !== E.PARKED) e.hstate = E.IDLE;
  if (e.htimer < world.tick + E.START) e.htimer = world.tick + E.START;
};

NT.Orders.define('harvest', { tick: NT.Econ._tick, end: NT.Econ._end });
NT.Orders.define('return', { tick: NT.Econ._tick, end: NT.Econ._end });

// Put a harvester to work now (at / near cell (cx, cy) if given). false = nothing for it to do.
NT.Econ.work = function (world, e, cx, cy) {
  const E = NT.Econ, tr = e.def.traits.harvester;
  if (!tr || !e.alive || e.hidden) return false;
  const near = cx >= 0 && cy >= 0;
  if (e.cargo < tr.capacity) {
    let cell = near ? E._pick(world, e, cx, cy, 0) : -1;
    if (cell < 0 && e.hcell >= 0 && !near) { const hx = e.hcell % world.w; cell = E._pick(world, e, hx, (e.hcell - hx) / world.w, E.FIELD); }
    if (cell < 0) cell = E._pick(world, e, e.cx, e.cy, 0);
    if (cell >= 0) return NT.Orders.give(world, e, { type: 'harvest', cell: cell });
  }
  if (e.cargo > 0 && E.dropoff(world, e)) return NT.Orders.give(world, e, { type: 'return' });
  return false;
};

// A harvester with no harvest order: look for work when its timer says so.
NT.Econ._idle = function (world, e) {
  const E = NT.Econ, o = e.order, tick = world.tick;
  if (o) {
    if (o.type === 'harvest' || o.type === 'return') return;
    if (o.type !== 'move') e.hstate = E.IDLE;                 // only the player's move / stop parks it
    e.htimer = tick + E.START;
    return;
  }
  if (e.hstate === E.PARKED || tick < e.htimer) return;
  if (!E.work(world, e)) e.htimer = tick + E.RECHECK;
};

// The player's own move / stop: the harvester stays where it is told until it is told to harvest again.
NT.Econ._park = function (world, p, c) {
  const ids = c && Array.isArray(c.ids) ? c.ids : null;
  for (let i = 0; ids && i < ids.length; i++) {
    const e = world.byId.get(ids[i]);
    if (e && e.owner === p.id && e.kind === 'unit' && e.def.traits.harvester && (!e.order || e.order.type === 'move')) e.hstate = NT.Econ.PARKED;
  }
};
(function () {
  const move = NT.commands.move, stop = NT.commands.stop;
  NT.command('move', function (world, p, c) { move(world, p, c); NT.Econ._park(world, p, c); });
  NT.command('stop', function (world, p, c) { stop(world, p, c); NT.Econ._park(world, p, c); });
})();

NT.Econ._us = [];
NT.command('harvest', function (world, p, c) {
  if (!c) return;
  const us = NT.ownUnits(world, p, Array.isArray(c.ids) ? c.ids : null, NT.Econ._us);
  let cx = -1, cy = -1, home = false;
  if (Number.isFinite(c.x) && Number.isFinite(c.y)) {
    cx = NT.clamp(NT.cellOf(c.x), 0, world.w - 1); cy = NT.clamp(NT.cellOf(c.y), 0, world.h - 1);
    const b = world.byId.get(NT.Occ.solid(world, cx, cy));
    home = !!b && b.kind === 'building' && b.owner === p.id && !!b.def.traits.dropoff;
  }
  for (let i = 0; i < us.length; i++) {
    if (!us[i].def.traits.harvester || us.indexOf(us[i]) < i) continue;
    NT.Orders.give(world, us[i], home ? { type: 'return' } : { type: 'harvest', cx: cx, cy: cy }, !!c.queue);
  }
});
NT.command('return', function (world, p, c) {
  const us = NT.ownUnits(world, p, c && Array.isArray(c.ids) ? c.ids : null, NT.Econ._us);
  for (let i = 0; i < us.length; i++) {
    if (us[i].def.traits.harvester && us.indexOf(us[i]) === i) NT.Orders.give(world, us[i], { type: 'return' }, !!c.queue);
  }
});

// ---------------------------------------------------------------------------
// Regrow
// ---------------------------------------------------------------------------
NT.Econ._regrow = function (world) {
  const S = NT.Econ._sys(world), map = world.map, w = world.w, h = world.h, res = map.res, cap = map.resCap, sp = map.spawners;
  const every = world.rules.regrowEvery, list = S.grow;
  for (let s = 0; s < sp.length; s++) {
    S.carry[s] += sp[s].rate * every / NT.TPS;
    let budget = Math.floor(S.carry[s]);
    if (budget < 1) continue;
    S.carry[s] -= budget;
    const offs = NT.circleOffsets(sp[s].radius);
    list.length = 0;
    for (let k = 0; k < offs.length; k++) {
      const x = sp[s].cx + offs[k][0], y = sp[s].cy + offs[k][1];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x;
      if (res[i] >= cap[i] || !map.pass[i]) continue;
      const b = world.occ[i] ? world.byId.get(world.occ[i]) : null;
      if (b && b.kind === 'building') continue;
      list.push(i);
    }
    if (!list.length) continue;                               // the field is full: this pulse is lost
    list.sort(function (a, b) { return res[a] - res[b] || a - b; });
    const share = Math.max(1, Math.floor(budget / list.length));
    for (let round = 0; round < 2 && budget > 0; round++) {
      for (let k = 0; k < list.length && budget > 0; k++) {
        const i = list[k], n = Math.min(round ? budget : share, cap[i] - res[i], budget);
        res[i] += n; budget -= n;
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Recruits
// ---------------------------------------------------------------------------
// The unit a recruit building hands to a player of this faction: the cheapest armed unit that needs no
// prerequisite and has no limit (ties -> declaration order). null = the faction has none.
NT.Econ.recruitDef = function (world, faction) {
  const S = NT.Econ._sys(world);
  if (S.recruit[faction.id] !== undefined) return S.recruit[faction.id];
  let best = null;
  for (let i = 0; i < faction.defs.length; i++) {
    const d = faction.defs[i];
    if (d.kind !== 'unit' || !(d.cost > 0) || d.requires.length || d.limit || !NT.Combat.armed(d)) continue;
    if (!best || d.cost < best.cost) best = d;
  }
  return (S.recruit[faction.id] = best);
};

// Free cell for a unit of `def` beside building b, nearest to the middle of its bottom edge. null = no room.
NT.Econ.besideCell = function (world, b, def) {
  const cx = b.cx + (b.w >> 1), cy = b.cy + b.h;
  if (def.layer === 'air') return [NT.clamp(cx, 0, world.w - 1), NT.clamp(cy, 0, world.h - 1)];
  return NT.spiral(cx, cy, 3, function (x, y) { return NT.Occ.canStand(world, def.body, x, y); });
};

NT.Econ._recruit = function (world, b, p) {
  const def = NT.Econ.recruitDef(world, p.faction);
  if (!def) { b.htimer = world.tick + b.def.traits.recruit.everyT; return; }
  const at = NT.Econ.besideCell(world, b, def);
  if (!at) return;                                            // crowded: try again next tick
  const u = NT.spawn(world, def, p.id, at[0], at[1], { exact: def.layer !== 'air' });
  if (!u) return;
  b.htimer = world.tick + b.def.traits.recruit.everyT;
  world.events.push({ t: 'produced', owner: p.id, id: u.id, def: def.id, x: u.x, y: u.y });
};

// ---------------------------------------------------------------------------
NT.system('econ', 20, {
  init: function (world) { NT.Econ._sys(world); },
  onSpawn: function (world, e) {
    if (e.kind === 'unit') e.htimer = world.tick + NT.Econ.START;
    else if (e.def.traits.recruit) e.htimer = world.tick + e.def.traits.recruit.everyT;
  },
  onOwner: function (world, e) { if (e.def.traits.recruit) e.htimer = world.tick + e.def.traits.recruit.everyT; },
  onRemove: function (world, e) { if (e.kind === 'unit' && e.hcell >= 0) NT.Econ._release(world, e); },
  step: function (world) {
    const E = NT.Econ, S = E._sys(world), ps = world.players, ents = world.ents, tick = world.tick, radar = S.radar;
    E._power(world);
    for (let i = 0; i < ps.length; i++) radar[i] = false;
    for (let n = 0; n < ents.length; n++) {
      const e = ents[n];
      if (!e.alive) continue;
      const tr = e.def.traits;
      if (e.kind !== 'building') { if (tr.harvester && !e.hidden) E._idle(world, e); continue; }
      const p = ps[e.owner];
      e.powered = !(p && e.def.needsPower && p.power.low);
      if (!p || p.defeated) continue;
      if (tr.radar && e.powered) radar[p.id] = true;
      if (tr.income && tick > e.born && (tick - e.born) % tr.income.everyT === 0) {
        const got = E.earn(p, tr.income.amount, true);
        world.events.push({ t: 'income', id: e.id, owner: p.id, amount: got, x: e.x, y: e.y });
      }
      if (tr.recruit && tick >= e.htimer) E._recruit(world, e, p);
    }
    for (let i = 0; i < ps.length; i++) ps[i].radar = radar[i];
    if (tick > 0 && tick % world.rules.regrowEvery === 0 && world.map.spawners.length) E._regrow(world);
  },
});
