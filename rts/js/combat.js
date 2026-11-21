'use strict';
// ============================================================================
// NEON TURF — combat.js : targets, weapons, projectiles, damage  (HEADLESS-SAFE, DETERMINISTIC)
// Systems 'combat' (50) and 'proj' (60).
//
// NT.damage(world, target, amount, warhead, source, weapon) -> hp actually removed (negative = healed)
//   THE one place hp changes. amount < 0 heals (clamped to maxHp, no matrix, no events). Otherwise
//     final = amount x WARHEADS[warhead][armor] x weapon.vs[armor] x source.mods.dmg x target.mods.taken
//   (warhead / weapon / source may be null: that factor is 1). Neutral-owned capturables take nothing.
//   Sets lastHurt / lastHurtBy / flash, emits a throttled 'hurt', calls the onDamage hooks, applies
//   weapon.onHit, then: a capturable with `revert` owned by a player flips to neutral at revertHp instead of
//   dying; anything else at 0 hp is NT.kill'ed and the killer is credited (kills, and for units xp = victim
//   cost -> rank, 'rank' event; folding rank MODS into ent.mods is traits.js' job). An idle aggressive unit
//   (or one on attack-move) hurt by something it could engage targets it at once.
//
// TARGETS — ent.target is the entity being engaged (0 = none). An 'attack' order owns it while it runs;
// otherwise it is chosen here every rules.scanEvery ticks (staggered by id), NT.Combat.mode(ent):
//     0  never looks (explicit attack order)
//     1  only what a weapon can reach from where it stands: buildings, hold / passive stance, units busy
//        with any other order, units walking home
//     2  anything within max(sight, weapon range); the orders system then walks it there (idle aggressive
//        units within rules.leash of their post, attack-moving units)
//   Passive units never auto-ATTACK, but heal weapons always look for patients. `consume` (single-use) weapons
//   never auto-acquire (no scan pick, no retaliation), whatever the stance: they are spent on explicit attack
//   orders only. Candidates must be alive,
//   not hidden, visible to the team (NT.Fog.canSee), on a layer and with tags the weapon accepts; enemies
//   for ordinary weapons, damaged allies with one of weapon.healTags for heal weapons. Neutral things are
//   never targets. Score: what my best weapon is good against, nearer, already in reach, armed, units over
//   buildings, and above all whoever hurt me last; enemy-held turf comes last; ties -> lower id.
//
// RANGE — one set of helpers used by firing, acquisition, engaging and the path goal:
//   NT.Combat.canHit(world, e, w, t)    relationship / layer / tag filters of weapon w against t
//   NT.Combat.inRange(world, e, w, t)   minRangePx <= NT.entDist(e, t) <= rangePx x mods.range; a 'melee'
//                                       weapon also reaches any ground unit in the same or a touching cell and
//                                       any building the attacker touches (rules.js contract)
//   NT.Combat.bears(world, e, t)        some weapon of e can hit t from here, right now
//   NT.Combat.valid(world, e, t)        t is something e may engage at all (alive, seen, a weapon applies)
//   NT.Combat.approach(world, e, t)     px to hand NT.Move.to as opts.range so that a weapon will bear on
//                                       arrival whatever sub-cell slots the two end up in (0 = no weapon applies)
//
// FIRING — weapon i fires when cd[i] is 0, the target is in range and the aiming part points at it:
// turret weapons aim with ent.aim (slews NT.Combat.TURRET rad / tick, fires on the move); other weapons need
// ent.facing on target, which only a unit that is not travelling can arrange (small bodies snap, large ones
// and hovering flyers turn at their turn rate; buildings are always "on target"). needsBrace weapons wait
// for ent.braced; a `consume` weapon destroys its shooter. Bursts: weapon.burst shots burstCd apart, then
// cd / mods.rof. Instant kinds (speedPx 0) land at once; the rest become world.projectiles (shape in sim.js;
// dmgMul = the shooter's mods.dmg at launch, used if it is dead when the shot lands). Homing shots follow
// the target and always hit; the others fly to where it stood and hit it only if it is still within
// NT.Combat.HIT px. Splash: everything else within splashPx that the weapon may hit and that is an enemy of
// the shooter or neutral, falling off linearly to rules.splashFalloff at the rim. No friendly fire.
//
// BUFFS — ent.buffs entries pushed here (one per id; the stronger value and the later expiry win):
//   {id:'slow', until, speed}            movement multiplier. See NT.Move.slow for who applies it.
//   {id:'burn', until, dps, src, next}   true damage (no warhead matrix) every NT.Combat.BURN ticks, credited
//                                        to entity id `src`; ticked here. `next` = tick of the next pulse.
//   Expired entries of ANY id are pruned here every tick.
//
// Presentation hints: ent.flash (1 when hurt) and ent.recoil (1 when firing) decay to 0 here; ent.aim of a
// unit without a target returns to its facing.
// ============================================================================
NT.Combat = {};
NT.Combat.TURRET = 0.3;                 // rad per tick a turret slews
NT.Combat.AIM = 0.26;                   // rad: how well the aiming part must point at the target to fire
NT.Combat.HIT = 0.6 * NT.TILE;          // a ballistic shot hits its target if it is still this close to the aim point
NT.Combat.BURN = 10;                    // ticks between burn pulses
NT.Combat.SLOT = Math.ceil(0.28 * Math.SQRT2 * NT.TILE);   // how far a small body may stand from its cell centre
NT.Combat.FLIGHT = 240;                 // ticks after which a homing shot gives up chasing

NT.Combat._sys = function (world) { return world.sys.combat || (world.sys.combat = { pid: 0 }); };

NT.Combat._tagged = function (def, tags) {
  for (let i = 0; i < tags.length; i++) if (def.is[tags[i]]) return true;
  return false;
};

NT.Combat.canHit = function (world, e, w, t) {
  if (t === e || !t.alive || t.hidden) return false;
  if (w.heal) {
    if (!NT.isAlly(world, e.owner, t.owner) || t.hp >= t.maxHp || !w.healTags || !NT.Combat._tagged(t.def, w.healTags)) return false;
  } else if (!NT.isEnemy(world, e.owner, t.owner)) return false;
  if (t.layer === 'air' ? !w.air : !w.ground) return false;
  if (w.only && !NT.Combat._tagged(t.def, w.only)) return false;
  return !(w.not && NT.Combat._tagged(t.def, w.not));
};

NT.Combat.inRange = function (world, e, w, t) {
  const d = NT.entDist(e, t);
  if (d <= w.rangePx * e.mods.range) return d >= w.minRangePx;
  if (w.proj !== 'melee' || e.layer !== 'ground' || t.layer !== 'ground' || e.kind !== 'unit') return false;
  return t.kind === 'building' ? NT.touching(e, t) : Math.abs(e.cx - t.cx) <= 1 && Math.abs(e.cy - t.cy) <= 1;
};

NT.Combat.bears = function (world, e, t) {
  const ws = e.def.weapons;
  for (let i = 0; i < ws.length; i++) if (NT.Combat.canHit(world, e, ws[i], t) && NT.Combat.inRange(world, e, ws[i], t)) return true;
  return false;
};

NT.Combat.valid = function (world, e, t) {
  if (!t || !t.alive || t.hidden || t === e || !NT.Fog.canSee(world, NT.teamOf(world, e.owner), t)) return false;
  const ws = e.def.weapons;
  for (let i = 0; i < ws.length; i++) if (NT.Combat.canHit(world, e, ws[i], t)) return true;
  return false;
};

NT.Combat.approach = function (world, e, t) {
  const C = NT.Combat, ws = e.def.weapons, T = NT.TILE;
  const pad = (e.body === 'small' ? C.SLOT : 0) + (t.body === 'small' ? C.SLOT : 0) + 1;
  let best = 0;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (!C.canHit(world, e, w, t)) continue;
    let r = w.rangePx * e.mods.range - pad;
    // melee always reaches a touching cell: make the walk end in one
    if (w.proj === 'melee' && e.layer === 'ground' && t.layer === 'ground') r = Math.max(r, t.kind === 'building' ? 0.75 * T : 1.45 * T);
    if (r < 1) r = 1;
    if (r > best) best = r;
  }
  return best;
};

NT.Combat.mode = function (e) {
  if (e.kind !== 'unit') return 1;
  const o = e.order;
  if (o) return o.type === 'attack' ? 0 : o.type === 'amove' && e.stance === 'aggressive' ? 2 : 1;
  return e.stance === 'aggressive' && !(e.mv && e.mv.guard === 2) ? 2 : 1;
};

// Every weapon is single-use (`consume`): such a unit never picks a target by itself (scan or retaliation).
NT.Combat._spent = function (def) {
  const ws = def.weapons;
  for (let i = 0; i < ws.length; i++) if (!ws[i].consume) return false;
  return ws.length > 0;
};

NT.Combat.armed = function (def) {
  for (let i = 0; i < def.weapons.length; i++) if (!def.weapons[i].heal) return true;
  return false;
};

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------
NT.damage = function (world, target, amount, warhead, source, weapon) {
  if (!target.alive || !(amount === amount) || amount === 0) return 0;
  if (amount < 0) {
    const room = target.maxHp - target.hp, heal = -amount < room ? -amount : room > 0 ? room : 0;
    target.hp += heal;
    return -heal;
  }
  const cap = target.def.traits.capturable, armor = target.def.armor;
  if (cap && target.owner === NT.NEUTRAL) return 0;
  let final = amount * target.mods.taken;
  if (warhead) final *= NT.WARHEADS[warhead][armor];
  if (weapon && weapon.vs && weapon.vs[armor] !== undefined) final *= weapon.vs[armor];
  if (source) final *= source.mods.dmg;
  target.hp -= final;
  target.lastHurt = world.tick; target.lastHurtBy = source ? source.id : 0;
  target.flash = 1;
  if (world.tick - target.hurtAt >= world.rules.hurtEventEvery) {
    target.hurtAt = world.tick;
    world.events.push({ t: 'hurt', id: target.id, owner: target.owner, x: target.x, y: target.y, by: source ? source.id : 0 });
  }
  NT._hook('onDamage', world, target, final, source || null);
  if (!target.alive) return final;
  if (weapon && weapon.onHit) NT.Combat._onHit(world, target, weapon.onHit, source);
  if (target.hp <= 0) {
    if (cap && cap.revert && target.owner >= 0) {
      target.hp = cap.revertHp * target.maxHp;
      target.buffs.length = 0;
      NT.setOwner(world, target, NT.NEUTRAL);
    } else {
      NT.kill(world, target, source || null);
      if (source && source.alive) NT.Combat._credit(world, source, target);
    }
    return final;
  }
  if (target.hp > target.maxHp) target.hp = target.maxHp;
  // retaliation
  if (source && source.alive && target.kind === 'unit' && !target.target && target.stance === 'aggressive' &&
      NT.Combat.mode(target) === 2 && !NT.Combat._spent(target.def) && NT.Combat.valid(world, target, source)) target.target = source.id;
  return final;
};

NT.Combat._credit = function (world, k, victim) {
  if (!NT.isEnemy(world, k.owner, victim.owner)) return;
  k.kills++;
  if (k.kind !== 'unit' || !(k.def.cost > 0)) return;
  k.xp += victim.def.cost;
  const need = world.rules.vetXp;
  while (k.rank < need.length && k.xp >= need[k.rank] * k.def.cost) {
    k.rank++;
    world.events.push({ t: 'rank', id: k.id, owner: k.owner, rank: k.rank });
  }
};

NT.Combat._buff = function (t, id) {
  for (let i = 0; i < t.buffs.length; i++) if (t.buffs[i].id === id) return t.buffs[i];
  return null;
};

NT.Combat._onHit = function (world, t, onHit, source) {
  const s = onHit.slow, f = onHit.burn, tick = world.tick;
  if (s && (!s.armor || s.armor.indexOf(t.def.armor) >= 0)) {
    const b = NT.Combat._buff(t, 'slow');
    if (!b || b.until <= tick) { if (b) { b.until = tick + s.durT; b.speed = s.mult; } else t.buffs.push({ id: 'slow', until: tick + s.durT, speed: s.mult }); }
    else { if (s.mult < b.speed) b.speed = s.mult; if (tick + s.durT > b.until) b.until = tick + s.durT; }
  }
  if (f) {
    const b = NT.Combat._buff(t, 'burn'), src = source ? source.id : 0;
    if (!b || b.until <= tick) {
      if (b) { b.until = tick + f.durT; b.dps = f.dps; b.src = src; b.next = tick + NT.Combat.BURN; }
      else t.buffs.push({ id: 'burn', until: tick + f.durT, dps: f.dps, src: src, next: tick + NT.Combat.BURN });
    } else { if (f.dps > b.dps) b.dps = f.dps; if (tick + f.durT > b.until) b.until = tick + f.durT; b.src = src; }
  }
};

// Tick burns, prune whatever has run out.
NT.Combat._buffs = function (world, e) {
  const bs = e.buffs, tick = world.tick;
  let j = 0;
  for (let i = 0; i < bs.length; i++) {
    const b = bs[i];
    if (b.id === 'burn' && tick >= b.next && b.next <= b.until) {
      b.next += NT.Combat.BURN;
      NT.damage(world, e, b.dps * NT.Combat.BURN / NT.TPS, null, world.byId.get(b.src) || null, null);
      if (!e.alive) return;
    }
    if (b.until > tick) bs[j++] = b;
  }
  bs.length = j;
};

// ---------------------------------------------------------------------------
// Acquisition
// ---------------------------------------------------------------------------
NT.Combat._near = [];

NT.Combat._scan = function (world, e, mode) {
  const C = NT.Combat, ws = e.def.weapons, T = NT.TILE, tick = world.tick;
  const team = NT.teamOf(world, e.owner), passive = e.kind === 'unit' && e.stance === 'passive';
  const ig = e.mv && tick < e.mv.ignoreT ? e.mv.ignore : 0;
  let reach = 0;
  for (let i = 0; i < ws.length; i++) { const r = ws[i].rangePx * e.mods.range; if (r > reach) reach = r; }
  const look = mode === 2 ? Math.max(reach, e.def.sight * e.mods.sight * T) : reach;
  const near = NT.entsInRadius(world, e.x, e.y, Math.max(look, 2.2 * T), C._near);
  let best = 0, bs = -Infinity;
  for (let n = 0; n < near.length; n++) {
    const c = near[n];
    if (c === e || c.owner < 0 || c.id === ig) continue;
    let eff = -1, heal = false, inR = false;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if ((passive && !w.heal) || w.consume || !C.canHit(world, e, w, c)) continue;   // single-use weapons only on orders
      const r = C.inRange(world, e, w, c);
      if (!r && mode === 1) continue;
      const a = c.def.armor, v = w.heal ? 1 : NT.WARHEADS[w.warhead][a] * (w.vs && w.vs[a] !== undefined ? w.vs[a] : 1);
      if (v > eff) { eff = v; heal = w.heal; }
      if (r) inR = true;
    }
    if (eff < 0) continue;
    const d = NT.entDist(e, c);
    if (d > look && !inR) continue;
    if (!NT.Fog.canSee(world, team, c)) continue;
    let s;
    if (heal) s = 300 - 100 * c.hp / c.maxHp - 2 * d / T;
    else {
      s = 40 * eff - 4 * d / T;
      if (inR) s += 12;
      if (C.armed(c.def)) s += 15;
      if (c.kind === 'unit') s += 10;
      if (c.id === e.lastHurtBy && tick - e.lastHurt < 100) s += 60;
      if (c.def.is.turf) s -= 200;
    }
    if (c.id === e.target) s += 8;                            // do not flip between near-equals
    if (s > bs || (s === bs && c.id < best)) { bs = s; best = c.id; }
  }
  return best;
};

// Keep ent.target honest, look for a new one when it is this entity's turn.
NT.Combat._think = function (world, e) {
  const C = NT.Combat, mode = C.mode(e);
  let t = e.target ? world.byId.get(e.target) : null;
  if (e.target && (!t || !C.valid(world, e, t))) { e.target = 0; t = null; }
  if (!mode) return;
  if (t && e.kind === 'unit' && e.stance === 'passive' && NT.isEnemy(world, e.owner, t.owner)) { e.target = 0; t = null; }
  if (t && mode === 1 && !C.bears(world, e, t)) { e.target = 0; t = null; e.scanAt = 0; }
  if (world.tick < e.scanAt) return;
  e.scanAt = world.tick + world.rules.scanEvery;
  e.target = C._scan(world, e, mode);
};

// ---------------------------------------------------------------------------
// Firing
// ---------------------------------------------------------------------------
NT.Combat._bufs = [];
NT.Combat._depth = 0;

// A shot of weapon w lands at (x, y). t = the entity it was meant for (or null), sure = it cannot miss t.
// src = the shooter if it is still alive (then NT.damage applies its mods.dmg), else mul carries its dmgMul.
NT.Combat._land = function (world, w, src, owner, x, y, t, mul, sure) {
  const C = NT.Combat, base = w.dmg * mul;
  let hit = 0;
  if (t && t.alive && !t.hidden && (sure || NT.distTo(x, y, t) <= C.HIT)) {
    hit = t.id;
    NT.damage(world, t, w.heal ? -base : base, w.warhead, src, w);
  }
  if (w.splashPx > 0 && !w.heal) {
    const near = NT.entsInRadius(world, x, y, w.splashPx, C._bufs[C._depth] || (C._bufs[C._depth] = []));
    const rim = 1 - world.rules.splashFalloff;
    C._depth++;
    for (let i = 0; i < near.length; i++) {
      const o = near[i];
      if (o.id === hit || !o.alive || (o.owner !== NT.NEUTRAL && !NT.isEnemy(world, owner, o.owner))) continue;
      if (o.layer === 'air' ? !w.air : !w.ground) continue;
      NT.damage(world, o, base * (1 - rim * Math.min(1, NT.distTo(x, y, o) / w.splashPx)), w.warhead, src, w);
    }
    C._depth--;
  }
  world.events.push({ t: 'impact', x: x, y: y, proj: w.proj, warhead: w.warhead, splash: w.splashPx, hit: hit });
};

NT.Combat._fire = function (world, e, i, w, t) {
  const C = NT.Combat;
  if (e.burst[i] <= 0) e.burst[i] = w.burst;
  e.burst[i]--;
  e.cd[i] = e.burst[i] > 0 ? w.burstCd : Math.max(1, Math.round(w.cd / e.mods.rof));
  e.lastShot = world.tick; e.recoil = 1;
  world.events.push({ t: 'fire', id: e.id, wi: i, x: e.x, y: e.y, tx: t.x, ty: t.y, target: t.id, proj: w.proj, warhead: w.warhead });
  if (w.speedPx > 0) {
    world.projectiles.push({
      id: ++C._sys(world).pid, w: w, owner: e.owner, src: e.id,
      x: e.x, y: e.y, px: e.x, py: e.y, sx: e.x, sy: e.y, tx: t.x, ty: t.y, target: t.id,
      speed: w.speedPx, born: world.tick, eta: world.tick + Math.max(1, Math.ceil(NT.dist(e.x, e.y, t.x, t.y) / w.speedPx)),
      dmgMul: e.mods.dmg,
    });
  } else C._land(world, w, e, e.owner, t.x, t.y, t, 1, true);
  if (w.consume && e.alive) NT.kill(world, e, null);
};

// Point the right part at the target and fire whatever is ready.
NT.Combat._shoot = function (world, e, t) {
  const C = NT.Combat, ws = e.def.weapons, unit = e.kind === 'unit';
  const ang = Math.atan2(t.y - e.y, t.x - e.x);
  const going = unit && !!e.mv && e.mv.st === NT.Move.MOVING;
  const still = !unit || (e.layer === 'air' ? !going : e.hopT < 0);
  let turret = false, hull = false;
  for (let i = 0; i < ws.length; i++) if (C.canHit(world, e, ws[i], t)) { if (ws[i].turret) turret = true; else hull = true; }
  // the body only comes round for a hull weapon, and never fights the driver for the wheel
  if (unit && hull && still) {
    if (e.body === 'small') e.facing = ang;
    else if (!going) e.facing = NT.turnToward(e.facing, ang, e.def.move.turnRad);
  }
  e.aim = turret ? NT.turnToward(e.aim, ang, C.TURRET) : unit ? e.facing : ang;
  for (let i = 0; i < ws.length && e.alive && t.alive; i++) {
    const w = ws[i];
    if (e.cd[i] > 0 || (w.needsBrace && !e.braced) || !C.canHit(world, e, w, t) || !C.inRange(world, e, w, t)) continue;
    if (w.turret) { if (Math.abs(NT.angDiff(e.aim, ang)) > C.AIM) continue; }
    else if (unit && (!still || Math.abs(NT.angDiff(e.facing, ang)) > C.AIM)) continue;
    C._fire(world, e, i, w, t);
  }
};

NT.system('combat', 50, {
  onSpawn: function (world, e) { e.scanAt = world.tick + e.id % world.rules.scanEvery; },
  // nobody keeps aiming at something that is gone
  onRemove: function (world, e) {
    const ents = world.ents;
    for (let i = 0; i < ents.length; i++) if (ents[i].target === e.id) ents[i].target = 0;
  },
  onOwner: function (world, e) {
    const ents = world.ents;
    for (let i = 0; i < ents.length; i++) if (ents[i].target === e.id) ents[i].target = 0;
  },
  step: function (world) {
    const ents = world.ents, C = NT.Combat;
    for (let n = 0; n < ents.length; n++) {
      const e = ents[n];
      if (!e.alive) continue;
      if (e.flash > 0) e.flash = e.flash > 0.25 ? e.flash - 0.25 : 0;
      if (e.recoil > 0) e.recoil = e.recoil > 0.2 ? e.recoil - 0.2 : 0;
      if (e.buffs.length) { C._buffs(world, e); if (!e.alive) continue; }
      const ws = e.def.weapons;
      if (!ws.length) { if (e.kind === 'unit') e.aim = e.facing; continue; }
      for (let i = 0; i < ws.length; i++) if (e.cd[i] > 0) e.cd[i]--;
      if (e.hidden) continue;
      if (e.kind === 'building' && e.def.needsPower && !e.powered) { e.target = 0; continue; }
      C._think(world, e);
      const t = e.target ? world.byId.get(e.target) : null;
      if (t) C._shoot(world, e, t);
      else if (e.kind === 'unit') e.aim = NT.turnToward(e.aim, e.facing, C.TURRET);
    }
  },
});

// ---------------------------------------------------------------------------
// Projectiles
// ---------------------------------------------------------------------------
NT.system('proj', 60, {
  step: function (world) {
    const ps = world.projectiles, C = NT.Combat;
    let j = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i], t = p.target ? world.byId.get(p.target) : null;
      let landed;
      p.px = p.x; p.py = p.y;
      if (p.w.homing) {
        if (t && !t.hidden) { p.tx = t.x; p.ty = t.y; }
        const d = NT.dist(p.x, p.y, p.tx, p.ty);
        landed = d <= p.speed || world.tick - p.born > C.FLIGHT;
        if (!landed) { p.x += (p.tx - p.x) / d * p.speed; p.y += (p.ty - p.y) / d * p.speed; }
      } else {
        const f = (world.tick + 1 - p.born) / (p.eta - p.born);
        landed = f >= 1;
        if (!landed) { p.x = p.sx + (p.tx - p.sx) * f; p.y = p.sy + (p.ty - p.sy) * f; }
      }
      if (!landed) { ps[j++] = p; continue; }
      p.x = p.tx; p.y = p.ty;
      const src = world.byId.get(p.src) || null;
      C._land(world, p.w, src, p.owner, p.tx, p.ty, t || null, src ? 1 : p.dmgMul, p.w.homing);
    }
    ps.length = j;
  },
});
