'use strict';
// ============================================================================
// NEON TURF — traits.js : stat modifiers, regen, abilities, capture, deploy, death effects  (HEADLESS-SAFE, DETERMINISTIC)
// System 'traits' (order 70). Commands: enter, deploy, ability. Order type: enter.
//
// MODS — ent.mods is rebuilt from scratch every tick for every entity (shape: rules.js MODS):
//   1 x rules.vetMods[rank] x enrage.mods (hp/maxHp < below) x brace.mods (ent.braced) x every ACTIVE buff
//   (from <= tick < until; one per id, the later-ending wins) x the best aura per stat (see below).
//   regen adds up instead of multiplying. Buffs are read for the seven MODS keys only, so part 1's
//   {id:'slow', until, speed} is just a speed multiplier here (move.js then trusts mods.speed alone).
//   AURAS {radiusPx, affects, tags, self, mods}: carriers that are alive, visible and player-owned (neutral
//   carriers project nothing) cover entities within radiusPx (buildings measure from their footprint):
//   allies = the carrier's team, enemies = hostile teams; `tags` = the target needs one of them; `self` = the
//   carrier is covered too. Per stat the strongest raise (>1) and the strongest cut (<1) apply — auras never
//   stack with their own kind; regen takes the max.
// REGEN — hp += maxHp x mods.regen / TPS, plus selfHeal {rate, delayT}: maxHp x rate / TPS once
//   tick - lastHurt >= delayT. Never revives the dead (only alive entities are visited).
// BRACE {delayT, mods, uncrushable} — ent.still = ticks since the unit last moved (any unit; reset while it is
//   mid-hop or its position changed this tick); ent.braced = has brace && still >= delayT. combat.js holds
//   needsBrace weapons until braced; move.js will not crush a braced uncrushable body.
// SURGE {cooldownT, durT, mods, crashT, crashMods, hpCost, rangePx, auto} — ability 'surge':
//   needs tick >= ent.abil.surge and (hpCost > 0) hp - hpCost x maxHp > 1. Pushes {id:'surge', until} with the
//   mods and the comedown {id:'crash', from, until} with crashMods; cooldown from the trigger; 'ability' event.
//   auto: fires by itself when its target (explicit or acquired) is within rangePx and it is not crashing.
// LEAP {rangePx, minRangePx, cooldownT, dmg, warhead, slow:{mult, dur}, style} — automatic: when the ground unit's
//   target is alive, on the ground and minRangePx <= distance <= rangePx and tick >= ent.abil.leap (standing or
//   mid-hop: a chasing unit is nearly always mid-hop, the relocation handles both), it RELOCATES to the free cell touching the target (8 neighbours of a unit, the ring of
//   a building) nearest to itself, in its own path region. The relocation is instant on the grid: ent.px/py keep
//   the take-off point for that tick, so presentation sees the streak (style 'jump' arcs, 'dash' runs). On
//   landing: NT.damage(dmg, warhead, source = leaper) and the optional slow; cooldown; 'ability' event.
// CAPTURE — order {type:'enter', target}: walk to the building's ring; a capturer (trait capturer {timeT,
//   consumed, payout}) touching a capturable building that is not on its team channels while it stands there:
//   building.captureBy = unit id, captureT counts up (one capturer at a time; the others wait their turn). At
//   timeT: NT.setOwner -> the unit's owner (hp kept), payout credited ('income' event at the building),
//   consumed units vanish silently. Leaving, dying or being re-ordered resets the progress. Friendly or
//   non-capturable targets: the order just walks up to them.
// DEPLOY {into} — command deploy: a standing unit becomes the structure `into`, footprint centred on its cell, if
//   NT.footprintFree (ignoring the unit): unit despawns silently, the structure spawns, 'deploy' {id: new
//   structure, owner, on: true}; else 'denied' {def: into, reason: 'place'}.
// DEATH (real deaths only, never sales / despawns): explodeOnDeath {dmg, radiusPx, warhead} hurts EVERYONE within
//   radiusPx (of a structure's footprint; friend and foe; falloff to rules.splashFalloff at the rim; source = the
//   dead entity; an 'impact' event marks the blast);
//   spawnOnDeath {def, count} spawns for the owner beside it; bounty {frac, buildings} on the KILLER pays its owner
//   frac x victim cost for enemy units (and structures if buildings), 'income' {id: killer} at the victim.
// LIFESTEAL {frac} — the attacker heals frac x the damage it really did.
// EXPIRES — ent.expires > 0: removed silently once tick >= expires (summons).
//
// API:
//   NT.Traits.buff(ent, buff)                 add a buff {id, until, from?, ...mods}; same id: the later-ending stays
//   NT.Traits.active(world, ent, id) -> buff | null      the active buff with that id
//   NT.Traits.canSurge(world, ent) -> bool    NT.Traits.surge(world, ent) -> bool (triggered)
//   NT.Traits.deploySpot(world, ent) -> [cx, cy] | null  where `into` would go (null: it does not fit / cannot deploy)
//   NT.Traits.capture(world, building) -> {by, t, need} | null   channel in progress (need = capturer's timeT)
//   NT.Traits.leapCell(world, ent, target) -> [cx, cy] | null    where a leap at target would land
// ============================================================================
NT.Traits = {};
NT.Traits.KEYS = ['dmg', 'taken', 'speed', 'rof', 'range', 'sight', 'regen'];

NT.Traits._sys = function (world) {
  return world.sys.traits || (world.sys.traits = { carriers: [], near: [], bufs: [], depth: 0 });
};

// m x src (regen adds); src is any object, only the seven MODS keys are read
NT.Traits._apply = function (m, s) {
  if (typeof s.dmg === 'number') m.dmg *= s.dmg;
  if (typeof s.taken === 'number') m.taken *= s.taken;
  if (typeof s.speed === 'number') m.speed *= s.speed;
  if (typeof s.rof === 'number') m.rof *= s.rof;
  if (typeof s.range === 'number') m.range *= s.range;
  if (typeof s.sight === 'number') m.sight *= s.sight;
  if (typeof s.regen === 'number') m.regen += s.regen;
};

NT.Traits.buff = function (e, b) {
  const bs = e.buffs;
  for (let i = 0; i < bs.length; i++) {
    if (bs[i].id !== b.id) continue;
    if (b.until > bs[i].until) bs[i] = b;
    return bs[i];
  }
  bs.push(b);
  return b;
};

NT.Traits.active = function (world, e, id) {
  const bs = e.buffs, tick = world.tick;
  let best = null;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.id === id && b.until > tick && !(b.from > tick) && (!best || b.until > best.until)) best = b;
  }
  return best;
};

// ---------------------------------------------------------------------------
// Auras
// ---------------------------------------------------------------------------
NT.Traits._auraOf = function (e, tick) {
  let a = e.aura;
  if (!a) a = e.aura = { t: -1, up: { dmg: 1, taken: 1, speed: 1, rof: 1, range: 1, sight: 1 }, dn: { dmg: 1, taken: 1, speed: 1, rof: 1, range: 1, sight: 1 }, regen: 0 };
  if (a.t !== tick) {
    a.t = tick; a.regen = 0;
    const u = a.up, d = a.dn;
    u.dmg = u.taken = u.speed = u.rof = u.range = u.sight = 1;
    d.dmg = d.taken = d.speed = d.rof = d.range = d.sight = 1;
  }
  return a;
};

NT.Traits._project = function (world, c, au) {
  const S = NT.Traits._sys(world), tick = world.tick, mods = au.mods, K = NT.Traits.KEYS;
  const team = NT.teamOf(world, c.owner), r = au.radiusPx, big = c.kind === 'building';
  const near = NT.entsInRadius(world, c.x, c.y, big ? r + c.def.radius * 1.5 : r, S.near);
  for (let n = 0; n < near.length; n++) {
    const t = near[n];
    if (!t.alive || t.hidden || t.owner < 0) continue;
    if (t === c ? !au.self : (au.affects === 'enemies' ? !NT.isEnemy(world, c.owner, t.owner) : NT.teamOf(world, t.owner) !== team)) continue;
    if (au.tags && !NT.Combat._tagged(t.def, au.tags)) continue;
    if (big && t !== c && NT.entDist(c, t) > r) continue;
    const a = NT.Traits._auraOf(t, tick);
    for (let k = 0; k < K.length; k++) {
      const key = K[k], v = mods[key];
      if (typeof v !== 'number') continue;
      if (key === 'regen') { if (v > a.regen) a.regen = v; }
      else if (v > 1) { if (v > a.up[key]) a.up[key] = v; }
      else if (v < 1 && v < a.dn[key]) a.dn[key] = v;
    }
  }
};

NT.Traits._auras = function (world) {
  const ents = world.ents;
  for (let i = 0; i < ents.length; i++) {
    const c = ents[i], au = c.def.traits.aura;
    if (au && c.alive && !c.hidden && c.owner >= 0) NT.Traits._project(world, c, au);
  }
};

// ---------------------------------------------------------------------------
// Mods + regen
// ---------------------------------------------------------------------------
NT.Traits._mods = function (world, e) {
  const m = e.mods, tick = world.tick, tr = e.def.traits, T = NT.Traits;
  m.dmg = 1; m.taken = 1; m.speed = 1; m.rof = 1; m.range = 1; m.sight = 1; m.regen = 0;
  const vm = world.rules.vetMods[e.rank];
  if (vm) T._apply(m, vm);
  if (tr.enrage && e.hp < tr.enrage.below * e.maxHp) T._apply(m, tr.enrage.mods);
  if (tr.brace && e.braced) T._apply(m, tr.brace.mods);
  const bs = e.buffs;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (!(b.until > tick) || b.from > tick) continue;
    let dup = false;                                          // same id twice (should not happen): the later-ending one counts
    for (let k = 0; k < bs.length && !dup; k++) {
      const o = bs[k];
      if (k !== i && o.id === b.id && o.until > tick && !(o.from > tick) && (o.until > b.until || (o.until === b.until && k < i))) dup = true;
    }
    if (!dup) T._apply(m, b);
  }
  const a = e.aura;
  if (a && a.t === tick) {
    m.dmg *= a.up.dmg * a.dn.dmg; m.taken *= a.up.taken * a.dn.taken; m.speed *= a.up.speed * a.dn.speed;
    m.rof *= a.up.rof * a.dn.rof; m.range *= a.up.range * a.dn.range; m.sight *= a.up.sight * a.dn.sight;
    m.regen += a.regen;
  }
};

NT.Traits._regen = function (world, e) {
  if (e.hp >= e.maxHp) return;
  const sh = e.def.traits.selfHeal;
  let r = e.mods.regen;
  if (sh && world.tick - e.lastHurt >= sh.delayT) r += sh.rate;
  if (r > 0) NT.damage(world, e, -e.maxHp * r / NT.TPS, null, null, null);
};

// ---------------------------------------------------------------------------
// Surge
// ---------------------------------------------------------------------------
NT.Traits.canSurge = function (world, e) {
  const s = e.def.traits.surge;
  if (!s || !e.alive || e.hidden || world.tick < (e.abil.surge || 0)) return false;
  return !(s.hpCost > 0 && e.hp - s.hpCost * e.maxHp <= 1);
};

NT.Traits.surge = function (world, e) {
  if (!NT.Traits.canSurge(world, e)) return false;
  const s = e.def.traits.surge, tick = world.tick, T = NT.Traits;
  if (s.hpCost > 0) e.hp -= s.hpCost * e.maxHp;
  T.buff(e, Object.assign({}, s.mods, { id: 'surge', until: tick + s.durT }));
  if (s.crashT > 0) T.buff(e, Object.assign({}, s.crashMods, { id: 'crash', from: tick + s.durT, until: tick + s.durT + s.crashT }));
  e.abil.surge = tick + s.cooldownT;
  world.events.push({ t: 'ability', id: e.id, owner: e.owner, ability: 'surge', x: e.x, y: e.y });
  return true;
};

NT.Traits._autoSurge = function (world, e, s) {
  if (!s.auto || !e.target || world.tick < (e.abil.surge || 0)) return;
  const t = world.byId.get(e.target);
  if (!t || !NT.isEnemy(world, e.owner, t.owner) || NT.entDist(e, t) > s.rangePx || NT.Traits.active(world, e, 'crash')) return;
  NT.Traits.surge(world, e);
};

// ---------------------------------------------------------------------------
// Leap
// ---------------------------------------------------------------------------
NT.Traits._ring = [];
NT.Traits.leapCell = function (world, e, t) {
  const w = world.w, region = NT.Path.region(world, e.cx, e.cy);
  let best = null, bd = Infinity;
  const consider = function (x, y) {
    if (x < 0 || y < 0 || x >= w || y >= world.h || NT.Path.region(world, x, y) !== region) return;
    if (!NT.Occ.canStand(world, e.body, x, y, e.id)) return;
    const d = (x - e.cx) * (x - e.cx) + (y - e.cy) * (y - e.cy);
    if (d < bd) { bd = d; best = [x, y]; }
  };
  if (t.kind === 'building') {
    const ring = NT.ringCells(world, t, NT.Traits._ring);
    for (let i = 0; i < ring.length; i++) consider(ring[i] % w, (ring[i] - ring[i] % w) / w);
  } else {
    for (let k = 0; k < 8; k++) consider(t.cx + NT.DIRS8[k][0], t.cy + NT.DIRS8[k][1]);
  }
  return best;
};

NT.Traits._leap = function (world, e, l) {
  if (!e.target || e.layer !== 'ground' || world.tick < (e.abil.leap || 0)) return;
  const t = world.byId.get(e.target);
  if (!t || !t.alive || t.hidden || t.layer !== 'ground' || !NT.isEnemy(world, e.owner, t.owner)) return;
  const d = NT.entDist(e, t);
  if (d < l.minRangePx || d > l.rangePx) return;
  const at = NT.Traits.leapCell(world, e, t);
  if (!at) return;
  NT.Move.stop(world, e);
  NT.Occ.claim(world, e, at[0], at[1]);
  const p = NT.Occ.slotPos(e.cx, e.cy, e.slot);
  e.facing = e.aim = Math.atan2(t.y - p[1], t.x - p[0]);
  e.x = e.hopToX = p[0]; e.y = e.hopToY = p[1]; e.hopT = -1;   // px / py still hold the take-off point: the streak
  e.still = 0; e.braced = false;
  e.abil.leap = world.tick + l.cooldownT;
  world.events.push({ t: 'ability', id: e.id, owner: e.owner, ability: 'leap', x: e.x, y: e.y });
  if (l.dmg > 0) NT.damage(world, t, l.dmg, l.warhead, e, null);
  if (l.slow && t.alive) NT.Combat._onHit(world, t, { slow: { mult: l.slow.mult, durT: NT.ticks(l.slow.dur || 1), armor: l.slow.armor || null } }, e);
};

// ---------------------------------------------------------------------------
// Capture (order 'enter')
// ---------------------------------------------------------------------------
NT.Traits._mayCapture = function (world, u, b) {
  return !!(u.def.traits.capturer && b.def.traits.capturable && b.kind === 'building' && b.owner !== u.owner && !NT.isAlly(world, u.owner, b.owner));
};
NT.Traits._channeling = function (world, u, b) {
  return !!u && u.alive && !u.hidden && u.order && u.order.type === 'enter' && u.order.target === b.id && u.hopT < 0 && NT.touching(u, b);
};
NT.Traits._resetCapture = function (b) { b.captureBy = 0; b.captureT = 0; };

NT.Traits.capture = function (world, b) {
  const u = b.captureBy ? world.byId.get(b.captureBy) : null;
  if (!u || !u.def.traits.capturer) return null;
  return { by: u.id, t: b.captureT, need: u.def.traits.capturer.timeT };
};

NT.Traits._eo = { adjacentTo: null };
NT.Orders.define('enter', {
  start: function (world, e, o) { o.go = false; },
  tick: function (world, e, o) {
    const T = NT.Traits, M = NT.Move, b = world.byId.get(o.target), m = M.state(e);
    if (!b || !b.alive || b.kind !== 'building') return true;
    if (e.hopT >= 0 || !NT.touching(e, b)) {
      if (b.captureBy === e.id) T._resetCapture(b);
      if (m.st === M.MOVING) return false;
      if (o.go && m.st === M.FAILED) return true;             // cannot get there
      o.go = true;
      T._eo.adjacentTo = b; M.to(world, e, b.cx, b.cy, T._eo); T._eo.adjacentTo = null;
      return false;
    }
    if (m.st === M.MOVING) M.stop(world, e);
    if (!T._mayCapture(world, e, b)) return true;              // friendly / not capturable: walking up was the job
    if (b.captureBy !== e.id) {
      if (b.captureBy && T._channeling(world, world.byId.get(b.captureBy), b)) return false;   // someone else's turn
      b.captureBy = e.id; b.captureT = 0;
    }
    const cap = e.def.traits.capturer;
    if (++b.captureT < cap.timeT) return false;
    T._resetCapture(b);
    NT.setOwner(world, b, e.owner);
    const p = world.players[e.owner];
    if (cap.payout > 0 && p) {
      const got = NT.Econ.earn(p, cap.payout, false);
      world.events.push({ t: 'income', id: b.id, owner: e.owner, amount: got, x: b.x, y: b.y });
    }
    if (cap.consumed) NT.kill(world, e, null, { silent: true });
    return true;
  },
  end: function (world, e, o) {
    const b = world.byId.get(o.target);
    if (b && b.captureBy === e.id) NT.Traits._resetCapture(b);
    NT.Move.stop(world, e);
  },
});

NT.Traits._us = [];
NT.command('enter', function (world, p, c) {
  const b = c ? world.byId.get(c.target) : null;
  if (!b || !b.alive || b.kind !== 'building' || !NT.Fog.canSee(world, p.team, b)) return;
  const us = NT.ownUnits(world, p, Array.isArray(c.ids) ? c.ids : null, NT.Traits._us);
  for (let i = 0; i < us.length; i++) {
    const u = us[i];
    if (us.indexOf(u) === i && u.layer === 'ground' && u.def.move.speedPx > 0) NT.Orders.give(world, u, { type: 'enter', target: b.id }, !!c.queue);
  }
});

// ---------------------------------------------------------------------------
// Deploy
// ---------------------------------------------------------------------------
NT.Traits.deploySpot = function (world, e) {
  const dp = e.def.traits.deploy, into = dp && dp.into ? NT.DEFS[dp.into] : null;
  if (!into || !e.alive || e.hidden || e.layer !== 'ground' || into.kind !== 'building') return null;
  const cx = e.cx - ((into.size[0] - 1) >> 1), cy = e.cy - ((into.size[1] - 1) >> 1);
  return NT.footprintFree(world, into, cx, cy, e.id) ? [cx, cy] : null;
};

NT.command('deploy', function (world, p, c) {
  const us = NT.ownUnits(world, p, c && Array.isArray(c.ids) ? c.ids : null, NT.Traits._us).slice();
  for (let i = 0; i < us.length; i++) {
    const u = us[i], dp = u.def.traits.deploy;
    if (!dp || !dp.into || !u.alive || us.indexOf(u) < i) continue;
    const spot = u.hopT < 0 ? NT.Traits.deploySpot(world, u) : null;
    if (!spot) { world.events.push({ t: 'denied', owner: p.id, def: dp.into, reason: 'place' }); continue; }
    NT.Orders.clear(world, u);
    NT.kill(world, u, null, { silent: true });
    const b = NT.spawn(world, dp.into, p.id, spot[0], spot[1]);
    world.events.push({ t: 'deploy', id: b.id, owner: p.id, on: true });
  }
});

// ---------------------------------------------------------------------------
// Abilities by command
// ---------------------------------------------------------------------------
NT.command('ability', function (world, p, c) {
  if (!c || c.ability !== 'surge') return;
  const us = NT.ownUnits(world, p, Array.isArray(c.ids) ? c.ids : null, NT.Traits._us);
  for (let i = 0; i < us.length; i++) if (us.indexOf(us[i]) === i) NT.Traits.surge(world, us[i]);
});

// ---------------------------------------------------------------------------
// Death effects
// ---------------------------------------------------------------------------
// Distances are measured from a structure's footprint (a blast of 1.5 cells reaches 1.5 cells past its walls).
NT.Traits._explode = function (world, e, x) {
  const S = NT.Traits._sys(world), big = e.kind === 'building';
  const near = NT.entsInRadius(world, e.x, e.y, big ? x.radiusPx + e.def.radius * 1.5 : x.radiusPx, S.bufs[S.depth] || (S.bufs[S.depth] = []));
  const rim = 1 - world.rules.splashFalloff;
  S.depth++;
  for (let i = 0; i < near.length; i++) {
    const o = near[i];
    if (o === e || !o.alive || o.hidden) continue;
    const d = NT.entDist(e, o);
    if (d > x.radiusPx) continue;
    NT.damage(world, o, x.dmg * (1 - rim * Math.min(1, d / x.radiusPx)), x.warhead, e, null);
  }
  S.depth--;
  world.events.push({ t: 'impact', x: e.x, y: e.y, proj: 'shell', warhead: x.warhead, splash: x.radiusPx, hit: 0 });
};

NT.Traits._onRemove = function (world, e, killer, silent) {
  const tr = e.def.traits;
  if (e.order && e.order.type === 'enter') {
    const b = world.byId.get(e.order.target);
    if (b && b.captureBy === e.id) NT.Traits._resetCapture(b);
  }
  if (silent) return;
  if (tr.explodeOnDeath && tr.explodeOnDeath.radiusPx > 0) NT.Traits._explode(world, e, tr.explodeOnDeath);
  const sod = tr.spawnOnDeath;
  if (sod && sod.def && NT.DEFS[sod.def]) {
    const cx = e.kind === 'building' ? e.cx + (e.w >> 1) : e.cx, cy = e.kind === 'building' ? e.cy + e.h : e.cy;
    for (let i = 0; i < sod.count; i++) NT.spawn(world, sod.def, e.owner, cx, cy);
  }
  const bt = killer && killer.def.traits.bounty;
  if (bt && bt.frac > 0 && NT.isEnemy(world, killer.owner, e.owner) && (e.kind === 'unit' || bt.buildings) && e.def.cost > 0) {
    const p = world.players[killer.owner];
    const got = NT.Econ.earn(p, bt.frac * e.def.cost, false);
    world.events.push({ t: 'income', id: killer.id, owner: killer.owner, amount: got, x: e.x, y: e.y });
  }
};

// ---------------------------------------------------------------------------
NT.system('traits', 70, {
  init: function (world) { NT.Traits._sys(world); },
  onRemove: NT.Traits._onRemove,
  onOwner: function (world, e) { NT.Traits._resetCapture(e); },
  onDamage: function (world, e, amount, src) {
    const ls = src && src.alive && src.def.traits.lifesteal;
    if (!ls || !(amount > 0)) return;
    const real = e.hp < 0 ? amount + e.hp : amount;            // overkill does not feed it
    if (real > 0) NT.damage(world, src, -ls.frac * real, null, null, null);
  },
  step: function (world) {
    const T = NT.Traits, ents = world.ents, tick = world.tick;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.alive && e.expires > 0 && tick >= e.expires) NT.kill(world, e, null, { silent: true });
    }
    T._auras(world);
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive) continue;
      const tr = e.def.traits;
      if (e.kind === 'unit') {
        if (e.hopT >= 0 || e.x !== e.px || e.y !== e.py) e.still = 0; else e.still++;
        e.braced = !!tr.brace && e.still >= tr.brace.delayT;
      }
      T._mods(world, e);
      T._regen(world, e);
      if (e.hidden || e.kind !== 'unit') continue;
      if (tr.surge) T._autoSurge(world, e, tr.surge);
      if (tr.leap) T._leap(world, e, tr.leap);
    }
  },
});
