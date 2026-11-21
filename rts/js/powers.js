'use strict';
// ============================================================================
// NEON TURF — powers.js : support powers  (HEADLESS-SAFE, DETERMINISTIC)
// System 'powers' (order 80). Command: power {power, x, y} (full power id, target in world px).
//
// STATE — player.powers[powerId] = { charge, ready, had } for every power of the player's faction (init).
//   AVAILABLE = the owner has an alive `power.building`, powered if that def needsPower (= not low on power).
//   While available, charge += 1 per tick up to cooldownT; the first time the building is obtained (had: false ->
//   true) charge jumps to initial x cooldownT. Reaching cooldownT: ready, 'power_ready' once. Losing the
//   building keeps the charge but stops it (and the power cannot be fired until it is available again).
//
// FIRING — needs ready + available and a target inside the map, else 'denied' {def: power id, reason: 'charge'
// (not ready / not available / not this faction's power) | 'target'}. Then charge = 0, ready = false,
// 'power_used' {owner, power, x, y}. Kinds (params normalized in rules.js):
//   strike {radiusPx, shells, dmg, splashPx, warhead, delayT, overT}: 'strike_warn' {radius: radiusPx, delay:
//     delayT}; `shells` impacts at world.rng points inside the radius (uniform over the disc), the first at
//     +delayT, the rest spread evenly over overT. Each impact: NT.damage (source null, warhead) to the caster's
//     ENEMIES and neutrals on the ground within splashPx (structures: from their footprint), falloff to
//     rules.splashFalloff at the rim; 'impact' {proj: 'shell', splash: splashPx, hit: 0}.
//   reveal {radiusPx, durT}: NT.Fog.reveal for the caster's team.
//   buff {radiusPx, durT, affects, mods, tags?, heal?, after?}: every alive entity in the radius on the matching
//     side (allies = caster's team, enemies = hostile; owned by a player) with one of `tags` (if given) gets
//     {id: 'power:<id>', until: +durT, ...mods}; heal = that fraction of max hp at once; after = a comedown
//     {id: 'power:<id>:after', from: +durT, until: +durT + after.durT, ...after.mods}.
//   spawn {def, count, delayT?, lifetimeT?}: the target cell must be walkable and (fog on) VISIBLE to the caster's
//     team, else 'target'. 'strike_warn' {radius: 1.5 cells, delay} marks the spot; after delayT (0 if absent)
//     `count` units of def spawn around it for the caster ('spawn' events); lifetimeT sets ent.expires.
// Scheduled effects (shells, delayed spawns) live in world.sys.powers.pending and resolve in this system's step,
// even if the caster has been defeated meanwhile (what is in the air lands).
//
// API:
//   NT.Powers.state(world, player) -> [{power, id, charge, cooldownT, ready, available}]   power = the def object, id = its id
//   (the power command takes the id; a def object is accepted too)
//   NT.Powers.available(world, player, def) -> bool
//   NT.Powers.canFire(world, player, def, x, y) -> {ok, reason}    reason 'ok' | 'charge' | 'target'
// ============================================================================
NT.Powers = {};
NT.Powers.SPAWN_WARN = 1.5;      // cells: telegraph ring of a spawn power

NT.Powers._sys = function (world) { return world.sys.powers || (world.sys.powers = { pending: [], near: [] }); };

NT.Powers._def = function (p) { return typeof p === 'string' ? NT.POWERS[p] || null : p || null; };

NT.Powers.available = function (world, player, def) {
  const b = NT.DEFS[def.building];
  return !!b && player.owned[b.id] > 0 && !(b.needsPower && player.power.low);
};

NT.Powers.state = function (world, player, out) {
  out = out || []; out.length = 0;
  const ps = player.faction.powers;
  for (const k in ps) {
    const d = ps[k], s = player.powers[d.id];
    if (!s) continue;
    out.push({ power: d, id: d.id, charge: s.charge, cooldownT: d.cooldownT, ready: s.ready, available: NT.Powers.available(world, player, d) });
  }
  return out;
};

NT.Powers.canFire = function (world, player, def, x, y) {
  def = NT.Powers._def(def);
  const s = def && player.powers[def.id];
  if (!s || def.faction !== player.faction.id || !s.ready || !NT.Powers.available(world, player, def)) return { ok: false, reason: 'charge' };
  const T = NT.TILE;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= world.w * T || y >= world.h * T) return { ok: false, reason: 'target' };
  if (def.kind === 'spawn') {
    const cx = NT.cellOf(x), cy = NT.cellOf(y), sd = NT.DEFS[def.spawn.def];
    if (!sd || (sd.layer !== 'air' && !NT.Occ.walkable(world, cx, cy)) || !NT.Fog.visible(world, player.team, cx, cy)) return { ok: false, reason: 'target' };
  }
  return { ok: true, reason: 'ok' };
};

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------
NT.Powers._impact = function (world, j) {
  const S = NT.Powers._sys(world), a = j.a, rim = 1 - world.rules.splashFalloff;
  const near = NT.entsInRadius(world, j.x, j.y, a.splashPx, S.near).slice();
  for (let i = 0; i < near.length; i++) {
    const o = near[i];
    if (!o.alive || o.hidden || o.layer === 'air' || (o.owner !== NT.NEUTRAL && !NT.isEnemy(world, j.owner, o.owner))) continue;
    NT.damage(world, o, a.dmg * (1 - rim * Math.min(1, NT.distTo(j.x, j.y, o) / a.splashPx)), a.warhead, null, null);
  }
  world.events.push({ t: 'impact', x: j.x, y: j.y, proj: 'shell', warhead: a.warhead, splash: a.splashPx, hit: 0 });
};

NT.Powers._spawn = function (world, j) {
  const a = j.a, def = NT.DEFS[a.def];
  for (let i = 0; i < (a.count || 1); i++) {
    const u = NT.spawn(world, def, j.owner, j.cx, j.cy);
    if (u && a.lifetimeT > 0) u.expires = world.tick + a.lifetimeT;
  }
};

NT.Powers._buff = function (world, p, d, x, y) {
  const a = d.buff, tick = world.tick, team = p.team, id = 'power:' + d.id;
  const near = NT.entsInRadius(world, x, y, a.radiusPx, NT.Powers._sys(world).near).slice();
  for (let i = 0; i < near.length; i++) {
    const e = near[i];
    if (!e.alive || e.hidden || e.owner < 0) continue;
    if (a.affects === 'enemies' ? !NT.isEnemy(world, p.id, e.owner) : NT.teamOf(world, e.owner) !== team) continue;
    if (a.tags && !NT.Combat._tagged(e.def, a.tags)) continue;
    NT.Traits.buff(e, Object.assign({}, a.mods, { id: id, until: tick + a.durT }));
    if (a.after) NT.Traits.buff(e, Object.assign({}, a.after.mods, { id: id + ':after', from: tick + a.durT, until: tick + a.durT + a.after.durT }));
    if (a.heal > 0) NT.damage(world, e, -a.heal * e.maxHp, null, null, null);
  }
};

NT.Powers._fire = function (world, p, d, x, y) {
  const S = NT.Powers._sys(world), tick = world.tick, T = NT.TILE;
  if (d.kind === 'strike') {
    const a = d.strike, n = Math.max(1, a.shells | 0), delay = a.delayT || 0, over = a.overT || 0;
    world.events.push({ t: 'strike_warn', owner: p.id, power: d.id, x: x, y: y, radius: a.radiusPx, delay: delay });
    for (let k = 0; k < n; k++) {
      const ang = world.rng.next() * NT.TAU, r = a.radiusPx * Math.sqrt(world.rng.next());
      S.pending.push({ at: tick + delay + (n > 1 ? Math.round(k * over / (n - 1)) : 0), kind: 'shell', owner: p.id, a: a,
        x: NT.clamp(x + Math.cos(ang) * r, 0, world.w * T - 1), y: NT.clamp(y + Math.sin(ang) * r, 0, world.h * T - 1), cx: 0, cy: 0 });
    }
  } else if (d.kind === 'reveal') NT.Fog.reveal(world, p.team, x, y, d.reveal.radiusPx, d.reveal.durT);
  else if (d.kind === 'buff') NT.Powers._buff(world, p, d, x, y);
  else if (d.kind === 'spawn') {
    const a = d.spawn, delay = a.delayT || 0;
    world.events.push({ t: 'strike_warn', owner: p.id, power: d.id, x: x, y: y, radius: NT.Powers.SPAWN_WARN * T, delay: delay });
    S.pending.push({ at: tick + delay, kind: 'spawn', owner: p.id, a: a, x: x, y: y, cx: NT.cellOf(x), cy: NT.cellOf(y) });
  }
};

NT.command('power', function (world, p, c) {
  const d = !c ? null : typeof c.power === 'string' ? NT.POWERS[c.power] || null : c.power && c.power.id && NT.POWERS[c.power.id] === c.power ? c.power : null;
  const r = d ? NT.Powers.canFire(world, p, d, c.x, c.y) : { ok: false, reason: 'charge' };
  if (!r.ok) { world.events.push({ t: 'denied', owner: p.id, def: d ? d.id : c && typeof c.power === 'string' ? c.power : null, reason: r.reason }); return; }
  NT.Powers._fire(world, p, d, c.x, c.y);
  const s = p.powers[d.id];
  s.charge = 0; s.ready = false;
  world.events.push({ t: 'power_used', owner: p.id, power: d.id, x: c.x, y: c.y });
});

// ---------------------------------------------------------------------------
NT.system('powers', 80, {
  init: function (world) {
    NT.Powers._sys(world);
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i], ps = p.faction.powers;
      for (const k in ps) p.powers[ps[k].id] = { charge: 0, ready: false, had: false };
    }
  },
  step: function (world) {
    const P = NT.Powers, S = P._sys(world), ps = world.players, tick = world.tick;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.defeated) continue;
      const defs = p.faction.powers;
      for (const k in defs) {
        const d = defs[k], s = p.powers[d.id];
        if (!s || !P.available(world, p, d)) continue;
        if (!s.had) { s.had = true; s.charge = Math.max(s.charge, Math.min(d.cooldownT, Math.round(d.initial * d.cooldownT))); }
        if (s.ready) continue;
        if (s.charge < d.cooldownT) s.charge++;
        if (s.charge >= d.cooldownT) {
          s.charge = d.cooldownT; s.ready = true;
          world.events.push({ t: 'power_ready', owner: p.id, power: d.id });
        }
      }
    }
    const pend = S.pending;
    if (!pend.length) return;
    let j = 0;
    for (let i = 0; i < pend.length; i++) {
      const e = pend[i];
      if (e.at > tick) { pend[j++] = e; continue; }
      if (e.kind === 'shell') P._impact(world, e); else P._spawn(world, e);
    }
    pend.length = j;
  },
});
