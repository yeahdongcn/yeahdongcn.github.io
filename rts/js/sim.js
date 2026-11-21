'use strict';
// ============================================================================
// NEON TURF — sim.js : the simulation SPINE  (HEADLESS-SAFE, DETERMINISTIC)
//
// Owns: world + player + entity shapes, spawn/kill/ownership, the occupancy
// grids, spatial queries, the command queue, the ordered system pipeline and
// NT.step(). Gameplay lives in SYSTEMS that plug in here (move.js, combat.js,
// fog.js, econ.js, prod.js, traits.js, powers.js, victory.js, ai.js).
//
// HARD RULES for every sim file:
//   1. Faction-agnostic: never mention a faction / unit / building id. Read
//      behaviour from def data (def.traits, def.tags, def.role, def.weapons).
//   2. Deterministic: randomness only via world.rng; no Date / Math.random /
//      wall clock; iterate world.ents (ascending id) — never rely on Map/Set
//      order of anything keyed by non-insertion data.
//   3. No DOM. Presentation learns what happened from world.events only.
//   4. The ONLY way players (human UI and AI alike) change the world is
//      NT.cmd(world, playerId, command). No back doors.
//
// TICK PIPELINE — systems run in ascending `order`:
//     5 ai        think + issue commands (same NT.cmd as the UI)
//    (built-in)   drain world.cmdQueue -> NT.commands[type]
//    10 prod      production queues, progressive payment, ready structures
//    20 econ      power totals, harvesting, drop-off, regrow, passive income
//    30 orders    per-unit order state machines
//    35 path      budgeted path-request queue (path.js)
//    40 move      path following, cell claims, nudging
//    50 combat    target acquisition, turrets, weapons fire
//    60 proj      projectile flight + impact
//    70 traits    auras, regen, buffs, conditional mods, abilities
//    80 powers    support-power charge timers
//    90 fog       team visibility
//    (built-in)   compact dead entities
//   110 victory   defeat / win detection
//
// COORDINATES: world px, x right, y down. Angles in radians, 0 = +x (east),
// increasing clockwise on screen (atan2(dy, dx)).
//
// EVENTS — world.events is the ONLY channel from sim to presentation (fx,
// audio, HUD). Plain objects, `t` = type, positions in world px. Emit exactly
// these shapes; if a system needs a new event, add it to this list.
//   spawn       {id, owner, x, y}
//   death       {id, def, kind, owner, x, y, w, h, by}      by = killer id or 0
//   despawn     {id, def, kind, owner, x, y, w, h, by}      silent removal (transform, board, sell)
//   captured    {id, from, to, x, y}
//   fire        {id, wi, x, y, tx, ty, target, proj, warhead}   weapon #wi of `id` fired from (x,y) at (tx,ty)
//   impact      {x, y, proj, warhead, splash, hit}          a shot landed; splash in px; hit = entity id or 0. Also a strike
//                                                           shell (proj 'shell', hit 0) and a death blast (explodeOnDeath)
//   hurt        {id, owner, x, y, by}                       throttled: at most one per entity per second
//   rank        {id, owner, rank}
//   queued      {owner, def}                                item added to a production queue
//   cancelled   {owner, def, refund}
//   ready       {owner, def}                                structure finished, waiting to be placed
//   placed      {owner, id, def, x, y}
//   produced    {owner, id, def, x, y}                      unit left its producer
//   sold        {owner, id, def, x, y, refund}
//   repair      {id, owner, on}
//   nofunds     {owner}                                     throttled: at most one per 3 s per player
//   lowpower    {owner, on}                                 power state flipped
//   denied      {owner, def, reason}                        a command was rejected ('place'|'prereq'|'queue'|'funds'|...)
//   dump        {id, owner, amount, x, y}                   harvester delivered cargo
//   income      {id, owner, amount, x, y}                   credits earned at (x, y): passive income (id = the building),
//                                                           a capture payout (id = the building), a bounty (id = the killer,
//                                                           x/y = where the victim died)
//   deploy      {id, owner, on}
//   ability     {id, owner, ability, x, y}
//   board       {id, carrier, owner}   /   unboard {id, carrier, owner, x, y}
//   power_ready {owner, power}
//   power_used  {owner, power, x, y}
//   strike_warn {owner, power, x, y, radius, delay}         telegraph for a delayed area strike (radius px, delay ticks);
//                                                           a spawn power marks its drop point the same way (1.5 cells)
//   defeated    {player}
//   gameover    {winner}                                    winner = team id
//
// PROJECTILES — world.projectiles[] (owned by combat.js), one stable shape:
//   { id, w, owner, src, x, y, px, py, sx, sy, tx, ty, target, speed, born, eta, dmgMul }
//   w = normalized weapon def · src = shooter id · (sx,sy) launch point ·
//   (tx,ty) aim point (tracks `target` if w.homing) · speed px/tick ·
//   eta = tick it lands (lobbed shells) · px/py = previous-tick position.
//
// RENDER INTERPOLATION: NT.step copies x/y/facing/aim to px/py/pfacing/paim on
// every entity before systems run, so presentation can lerp(prev, cur, alpha).
//
// SPINE ADDITIONS made for sim core I (path / move / combat / fog) — nothing
// existing changed meaning:
//   - pipeline slot 35 'path' (path.js serves its request queue between orders and move);
//   - entity field `mv`     private movement state of move.js (null until NT.Move.state(ent));
//   - entity field `hurtAt` tick of the entity's last 'hurt' event (combat.js throttle).
// SPINE ADDITIONS made for sim core II (econ / prod / traits / powers / victory) — again additive only:
//   - player fields `incomeMul` / `prodMul` (difficulty handicaps, default 1) and `units` (def id -> alive
//     units of that def; the unit twin of `owned`, kept by NT._count);
//   - entity fields `hacc` (econ.js: fractional credit carry of a harvester) and `aura` (traits.js scratch);
//   - NT.footprintFree takes an optional 5th argument: an entity id that does not count as standing there
//     (a unit deploying into a structure on its own cell);
//   - player field `hadBase` (victory.js: only a player who ever stood — counting structure or deploy unit — can be
//     defeated, so sandboxes / tests without bases never end by themselves); powers state objects carry `had`;
//   - no new event types. `denied.reason` values in use: 'def' | 'producer' | 'prereq' | 'limit' | 'queue' |
//     'place' | 'target' | 'charge'; `denied.def` carries a def id, or a power id for the power command.
// ============================================================================

// Sub-cell offsets (in cells) for small bodies sharing one cell. Slot 0 is the
// centre so a lone soldier stands in the middle of its cell.
NT.SUBCELL = [[0, 0], [-0.28, -0.28], [0.28, -0.28], [-0.28, 0.28], [0.28, 0.28]];
NT.INF_PER_CELL = NT.SUBCELL.length;

// ---------------------------------------------------------------------------
// Systems + commands registries
// ---------------------------------------------------------------------------
NT.systems = [];        // [{name, order, init?, step?, onSpawn?, onRemove?, onOwner?, onDamage?}] sorted by order
NT.commands = {};       // type -> function (world, player, cmd)

// Register (or replace, by name) a system. Hooks, all optional:
//   init(world)                    once, at the end of NT.createWorld
//   step(world)                    every tick, in `order`
//   onSpawn(world, ent)            after an entity is fully created
//   onRemove(world, ent, killer, silent)   entity is dying (silent = false, killer = entity or null) or being
//                                  despawned without a death (silent = true: sold, transformed, boarded-and-lost...).
//                                  It is still on the grid while the hook runs.
//   onOwner(world, ent, oldOwner)  ownership changed (capture)
//   onDamage(world, ent, amount, source)   after damage was applied (source = attacker entity or null)
NT.system = function (name, order, impl) {
  impl.name = name; impl.order = order;
  const i = NT.systems.findIndex(function (s) { return s.name === name; });
  if (i >= 0) NT.systems.splice(i, 1);
  NT.systems.push(impl);
  NT.systems.sort(function (a, b) { return a.order - b.order; });
  return impl;
};
NT.command = function (type, fn) { NT.commands[type] = fn; };

NT._hook = function (hook, world, a, b, c) {
  const s = NT.systems;
  for (let i = 0; i < s.length; i++) if (s[i][hook]) s[i][hook](world, a, b, c);
};

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
// opts: {
//   map,                       required (NT.Map)
//   seed,                      match seed (default: map.seed)
//   players: [{ faction:'id', ai:null|'easy'|'normal'|'hard', team?, color?:'#hex', name?, slot?, credits? }],
//   fog: true|false,           default true
//   rules: {...}               per-match overrides merged over NT.RULES
//   noBases: true              tests: do not spawn starting bases / neutrals
// }
NT.createWorld = function (opts) {
  NT.assert(opts && opts.map, 'createWorld: opts.map is required');
  NT.assert(opts.players && opts.players.length >= 1, 'createWorld: opts.players is required');
  const map = opts.map, n = map.w * map.h;
  const world = {
    seed: (opts.seed >>> 0) || map.seed || 1,
    rng: null,
    tick: 0,
    map: map, w: map.w, h: map.h,
    rules: Object.assign({}, NT.RULES, opts.rules || {}),
    players: [], teams: [],
    ents: [],                 // live entities, ascending id (stable iteration order)
    byId: new Map(),          // id -> entity (alive only)
    nextId: 1,
    air: [],                  // live flying units (never in the occupancy grids)
    projectiles: [],          // owned by the combat system
    events: [],               // presentation events; drained by the caller (NT.drainEvents)
    cmdQueue: [],
    occ: new Int32Array(n),                      // solid occupant per cell: building or large body id, 0 = none
    inf: new Int32Array(n * NT.INF_PER_CELL),    // small-body ids per cell sub-slot, 0 = free
    passVersion: 1,           // bumped when static blocking changes (structure placed / removed)
    fogEnabled: opts.fog !== false,
    over: false, winner: -1,  // winner = team id once over
    sys: {},                  // per-system private state: world.sys[systemName]
    _q: 0,                    // spatial query stamp
  };
  world.rng = new NT.Rng(world.seed);

  for (let i = 0; i < opts.players.length; i++) {
    const po = opts.players[i];
    const faction = NT.FACTIONS[po.faction];
    NT.assert(faction, 'createWorld: unknown faction "' + po.faction + '"');
    const team = po.team === undefined ? i : po.team;
    if (!world.teams[team]) world.teams[team] = { id: team, players: [], vis: new Uint16Array(n), explored: new Uint8Array(n) };
    world.teams[team].players.push(i);
    const slot = po.slot === undefined ? i : po.slot;
    NT.assert(map.starts[slot], 'createWorld: map has no start slot ' + slot);
    world.players.push({
      id: i, faction: faction, team: team,
      color: po.color || null,                            // team colour '#rrggbb' (presentation only; resolved below)
      name: po.name || null,
      ai: po.ai || null,                                  // null = human; else difficulty id
      credits: po.credits === undefined ? world.rules.startCredits : po.credits,
      power: { made: 0, used: 0, low: false },            // econ system
      queues: {},                                         // prod system: queueId -> state
      owned: {},                                          // full def id -> alive buildings of that def
      nBuildings: 0,                                      // alive buildings that count for defeat
      nUnits: 0,
      radar: false,                                       // has an online radar-trait building
      units: {},                                          // full def id -> alive units of that def (like `owned`, for units)
      incomeMul: 1,                                       // handicap: x harvested + passive income (econ.js)
      prodMul: 1,                                         // handicap: x production speed (prod.js)
      powers: {},                                         // powers system: power id -> state
      defeated: false,
      hadBase: false,                                     // victory.js: has ever owned a counting structure / deploy unit (only then can it lose)
      startCx: map.starts[slot].cx, startCy: map.starts[slot].cy,
      stats: { produced: 0, built: 0, lost: 0, kills: 0, razed: 0, income: 0, spent: 0 },
    });
  }
  for (let t = 0; t < world.teams.length; t++) NT.assert(world.teams[t], 'createWorld: team ids must be contiguous from 0');
  // Team colours: the faction's signature colour unless an earlier player already wears it.
  const used = {};
  for (let i = 0; i < world.players.length; i++) { const c = world.players[i].color; if (c) used[c] = true; }
  for (let i = 0; i < world.players.length; i++) {
    const p = world.players[i];
    if (p.color) continue;
    let c = p.faction.color;
    for (let k = 0; used[c] && k < NT.PLAYER_COLORS.length; k++) c = NT.PLAYER_COLORS[k];
    p.color = c; used[c] = true;
  }

  for (let i = 0; i < NT.systems.length; i++) if (NT.systems[i].init) NT.systems[i].init(world);

  if (!opts.noBases) {
    for (let i = 0; i < map.neutrals.length; i++) {
      const nd = map.neutrals[i];
      if (NT.DEFS[nd.def]) NT.spawn(world, nd.def, NT.NEUTRAL, nd.cx, nd.cy);
    }
    for (let i = 0; i < world.players.length; i++) NT.spawnBase(world, world.players[i]);
  }
  return world;
};

// Spawn a player's starting base from faction.start around its start cell.
NT.spawnBase = function (world, p) {
  const st = p.faction.start;
  for (let i = 0; i < st.buildings.length; i++) {
    const b = st.buildings[i], at = b.at || [0, 0];
    NT.spawn(world, b.def, p.id, p.startCx + at[0], p.startCy + at[1]);
  }
  const hq = NT.DEFS[st.buildings[0].def];
  const ox = p.startCx + (hq.size[0] >> 1), oy = p.startCy + hq.size[1] + 1;   // muster below the HQ
  for (let i = 0; i < st.units.length; i++) {
    const u = st.units[i];
    for (let k = 0; k < (u.n || 1); k++) NT.spawn(world, u.def, p.id, ox, oy);
  }
};

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
// ONE struct for units and buildings; every field exists on every entity so
// systems (and V8) see a single stable shape. Systems own the fields listed
// under their name — add new fields HERE, not ad hoc.
NT._newEnt = function (world, def, owner) {
  const isB = def.kind === 'building';
  const nW = def.weapons ? def.weapons.length : 0;
  return {
    // --- identity
    id: world.nextId++, kind: def.kind, def: def, owner: owner, born: world.tick, alive: true,
    // --- spatial
    x: 0, y: 0,                 // world px. unit: current (interpolated) position; building: footprint centre
    cx: 0, cy: 0,               // unit: the cell it occupies (claims); building: top-left footprint cell
    w: isB ? def.size[0] : 1, h: isB ? def.size[1] : 1,
    layer: def.layer,           // 'ground' | 'air'
    body: def.body,             // 'small' | 'large' | 'building' | 'air'   (occupancy class)
    slot: -1,                   // sub-cell slot for small bodies
    facing: 0,                  // hull / body direction
    aim: 0,                     // turret / upper-body direction
    px: 0, py: 0, pfacing: 0, paim: 0,   // previous-tick copies (render interpolation; written by NT.step)
    hidden: false,              // true while carried inside a transport (off the grids, untargetable)
    // --- health
    hp: def.hp, maxHp: def.hp,
    lastHurt: -99999, lastHurtBy: 0,
    hurtAt: -99999,             // tick of this entity's last 'hurt' event (combat.js throttle)
    // --- orders + movement (move.js)
    mv: null,                   // private movement state, created on first use by NT.Move.state(ent) (see move.js)
    order: null,                // current order object {type, ...} or null (idle)
    queue: [],                  // shift-queued orders
    path: null, pathI: 0,       // remaining path as cell indices
    hopFromX: 0, hopFromY: 0, hopToX: 0, hopToY: 0,
    hopT: -1,                   // progress 0..1 of the current cell-to-cell hop; -1 = standing
    blocked: 0,                 // consecutive ticks spent waiting on a blocked cell
    homeX: 0, homeY: 0,         // guard post to return to after chasing
    // --- combat (combat.js)
    target: 0,                  // entity id being engaged
    cd: nW ? new Array(nW).fill(0) : [],       // ticks until weapon i may fire
    burst: nW ? new Array(nW).fill(0) : [],    // shots left in the current burst
    scanAt: 0,                  // next tick this entity looks for targets
    stance: def.stance || 'aggressive',        // 'aggressive' | 'hold' | 'passive'
    lastShot: -99999,
    xp: 0, rank: 0, kills: 0,
    // --- economy (econ.js)
    cargo: 0,                   // credits carried by a harvester
    hstate: 0,                  // harvester state machine (econ.js owns the meaning: NT.Econ.IDLE ... PARKED)
    htimer: 0, hdrop: 0, hcell: -1,   // next tick it looks for work · drop-off id it is bound for · resource cell it works
    hacc: 0,                    // fraction of a credit carried between ticks while loading / unloading
    // --- structures (prod.js)
    rally: null,                // {x, y} world px
    primary: false,
    repairing: false,
    powered: true,              // false when def.needsPower and the owner is low on power
    age: 0,                     // ticks since placement (rise-up animation, sell lockout)
    // --- traits (traits.js)
    mods: { dmg: 1, taken: 1, speed: 1, rof: 1, range: 1, sight: 1, regen: 0 },   // aggregated MODS (see rules.js); traits.js recomputes
    buffs: [],                  // [{id, until, from?, ...mods}]   (inactive before `from`)
    aura: null,                 // traits.js scratch: best aura value per stat covering this entity this tick
    abil: {},                   // ability name -> tick it is ready again
    deployed: false,
    still: 0,                   // ticks since the unit last moved (traits.js; drives the brace trait)
    braced: false,              // brace trait active (dug in after standing still)
    stealth: false, seenUntil: 0,
    riders: [],                 // ids carried (transport trait)
    carrier: 0,                 // id of the transport this entity rides in
    captureBy: 0, captureT: 0,
    expires: 0,                 // tick at which a temporary (summoned) entity despawns; 0 = never
    // --- presentation hints (written by sim, read by render; never read back by sim)
    flash: 0, recoil: 0,
    _q: 0,                      // spatial query stamp
  };
};

// Create an entity. `def` may be a full id string or a def object.
//   building: (cx, cy) = top-left footprint cell. The caller guarantees the footprint is free.
//   unit: nearest free cell to (cx, cy) for its body (opts.exact = fail instead of searching).
// Returns the entity, or null if a unit found no room.
NT.spawn = function (world, def, owner, cx, cy, opts) {
  if (typeof def === 'string') { const d = NT.DEFS[def]; NT.assert(d, 'spawn: unknown def "' + def + '"'); def = d; }
  opts = opts || {};
  const e = NT._newEnt(world, def, owner);
  if (def.kind === 'building') {
    e.cx = cx; e.cy = cy;
    e.x = (cx + e.w / 2) * NT.TILE; e.y = (cy + e.h / 2) * NT.TILE;
    for (let y = cy; y < cy + e.h; y++) for (let x = cx; x < cx + e.w; x++) {
      if (x >= 0 && y >= 0 && x < world.w && y < world.h) world.occ[y * world.w + x] = e.id;
    }
    world.passVersion++;
    e.facing = e.aim = Math.PI / 2;
  } else if (def.layer === 'air') {
    e.cx = NT.clamp(cx, 0, world.w - 1); e.cy = NT.clamp(cy, 0, world.h - 1);
    e.x = NT.cellCenter(e.cx); e.y = NT.cellCenter(e.cy);
    world.air.push(e);
  } else {
    const cell = opts.exact ? (NT.Occ.canStand(world, def.body, cx, cy) ? [cx, cy] : null)
                            : NT.findFreeCell(world, def.body, cx, cy, 24);
    if (!cell) { world.nextId--; return null; }
    NT.Occ.claim(world, e, cell[0], cell[1]);
    const pos = NT.Occ.slotPos(e.cx, e.cy, e.slot);
    e.x = pos[0]; e.y = pos[1];
  }
  e.facing = e.aim = opts.facing === undefined ? e.facing : opts.facing;
  e.homeX = e.x; e.homeY = e.y;
  e.px = e.x; e.py = e.y; e.pfacing = e.facing; e.paim = e.aim;
  world.ents.push(e); world.byId.set(e.id, e);
  NT._count(world, e, owner, +1);
  NT._hook('onSpawn', world, e);
  world.events.push({ t: 'spawn', id: e.id, owner: owner, x: e.x, y: e.y });
  return e;
};

NT.get = function (world, id) { return id ? world.byId.get(id) : undefined; };

// Maintain per-player counters.
NT._count = function (world, e, owner, d) {
  const p = world.players[owner];
  if (!p) return;
  if (e.kind === 'building') {
    p.owned[e.def.id] = (p.owned[e.def.id] || 0) + d;
    if (e.def.countsForDefeat) p.nBuildings += d;
  } else { p.nUnits += d; p.units[e.def.id] = (p.units[e.def.id] || 0) + d; }
};

// Kill (killer = entity or null) or despawn (opts.silent: no death event —
// transform / board / sell bookkeeping). Frees the grids immediately; the
// entity object stays in world.ents (alive = false) until the end of the tick.
NT.kill = function (world, e, killer, opts) {
  if (!e.alive) return;
  e.alive = false; e.hp = 0;
  NT._hook('onRemove', world, e, killer || null, !!(opts && opts.silent));
  if (e.kind === 'building') {
    for (let y = e.cy; y < e.cy + e.h; y++) for (let x = e.cx; x < e.cx + e.w; x++) {
      if (x >= 0 && y >= 0 && x < world.w && y < world.h && world.occ[y * world.w + x] === e.id) world.occ[y * world.w + x] = 0;
    }
    world.passVersion++;
  } else if (e.layer === 'air') {
    const i = world.air.indexOf(e); if (i >= 0) world.air.splice(i, 1);
  } else if (!e.hidden) NT.Occ.release(world, e);
  world.byId.delete(e.id);
  NT._count(world, e, e.owner, -1);
  world._dead = true;
  const silent = opts && opts.silent;
  if (!silent) {
    const p = world.players[e.owner];
    if (p) p.stats.lost++;
    if (killer && killer.owner !== e.owner) {
      const kp = world.players[killer.owner];
      if (kp) { if (e.kind === 'building') kp.stats.razed++; else kp.stats.kills++; }
    }
  }
  world.events.push({ t: silent ? 'despawn' : 'death', id: e.id, def: e.def.id, kind: e.kind, owner: e.owner,
    x: e.x, y: e.y, w: e.w, h: e.h, by: killer ? killer.id : 0 });
};

// Change ownership (capture). Fires onOwner hooks.
NT.setOwner = function (world, e, owner) {
  if (e.owner === owner) return;
  const old = e.owner;
  NT._count(world, e, old, -1);
  e.owner = owner;
  NT._count(world, e, owner, +1);
  e.target = 0; e.rally = null; e.primary = false; e.repairing = false;
  NT._hook('onOwner', world, e, old);
  world.events.push({ t: 'captured', id: e.id, from: old, to: owner, x: e.x, y: e.y });
};

// Relationship helpers. Neutral (-1) is nobody's enemy and nobody's ally.
NT.teamOf = function (world, owner) { const p = world.players[owner]; return p ? p.team : -1; };
NT.isEnemy = function (world, ownerA, ownerB) {
  if (ownerA < 0 || ownerB < 0) return false;
  return world.players[ownerA].team !== world.players[ownerB].team;
};
NT.isAlly = function (world, ownerA, ownerB) {
  if (ownerA < 0 || ownerB < 0) return false;
  return world.players[ownerA].team === world.players[ownerB].team;
};

// ---------------------------------------------------------------------------
// Occupancy. Buildings fill every footprint cell of world.occ. A 'large' body
// (vehicle, big beast) owns one whole cell. Up to NT.INF_PER_CELL 'small'
// bodies share a cell via sub-slots in world.inf. Air units are not on the
// grids. A moving unit claims its NEXT cell when the hop starts and gives up
// the old one at the same moment (e.cx/e.cy always = the claimed cell; e.x/e.y
// glide toward it).
// ---------------------------------------------------------------------------
NT.Occ = {};

// id of the building / large body in the cell (0 = none, -1 = out of bounds)
NT.Occ.solid = function (world, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return -1;
  return world.occ[cy * world.w + cx];
};
NT.Occ.smallCount = function (world, cx, cy) {
  const b = (cy * world.w + cx) * NT.INF_PER_CELL;
  let c = 0;
  for (let k = 0; k < NT.INF_PER_CELL; k++) if (world.inf[b + k]) c++;
  return c;
};
NT.Occ.freeSlot = function (world, cx, cy) {
  const b = (cy * world.w + cx) * NT.INF_PER_CELL;
  for (let k = 0; k < NT.INF_PER_CELL; k++) if (!world.inf[b + k]) return k;
  return -1;
};
// Could a body of this class stand in the cell right now? `selfId` is ignored as a blocker.
NT.Occ.canStand = function (world, body, cx, cy, selfId) {
  if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return false;
  const i = cy * world.w + cx;
  if (!world.map.pass[i]) return false;
  const s = world.occ[i];
  if (s && s !== selfId) return false;
  const b = i * NT.INF_PER_CELL;
  if (body === 'small') {
    for (let k = 0; k < NT.INF_PER_CELL; k++) if (!world.inf[b + k] || world.inf[b + k] === selfId) return true;
    return false;
  }
  for (let k = 0; k < NT.INF_PER_CELL; k++) if (world.inf[b + k] && world.inf[b + k] !== selfId) return false;
  return true;
};
// Static-only test: terrain passable and no BUILDING in the cell (units ignored). Path planning uses this.
NT.Occ.walkable = function (world, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return false;
  const i = cy * world.w + cx;
  if (!world.map.pass[i]) return false;
  const s = world.occ[i];
  if (!s) return true;
  const e = world.byId.get(s);
  return !e || e.kind !== 'building';
};
// Move e's claim to (cx, cy). Caller must have checked canStand. Updates e.cx/e.cy/e.slot only.
NT.Occ.claim = function (world, e, cx, cy) {
  if (e.slot >= 0 || world.occ[e.cy * world.w + e.cx] === e.id) NT.Occ.release(world, e);
  const i = cy * world.w + cx;
  e.cx = cx; e.cy = cy;
  if (e.body === 'small') {
    const k = NT.Occ.freeSlot(world, cx, cy);
    NT.assert(k >= 0, 'Occ.claim: no free slot');
    world.inf[i * NT.INF_PER_CELL + k] = e.id; e.slot = k;
  } else { world.occ[i] = e.id; e.slot = -1; }
};
NT.Occ.release = function (world, e) {
  const i = e.cy * world.w + e.cx;
  if (e.body === 'small') {
    if (e.slot >= 0 && world.inf[i * NT.INF_PER_CELL + e.slot] === e.id) world.inf[i * NT.INF_PER_CELL + e.slot] = 0;
    e.slot = -1;
  } else if (world.occ[i] === e.id) world.occ[i] = 0;
};
// World position of a sub-slot (slot < 0 -> cell centre).
NT.Occ.slotPos = function (cx, cy, slot) {
  const o = slot >= 0 ? NT.SUBCELL[slot] : NT.SUBCELL[0];
  return [(cx + 0.5 + o[0]) * NT.TILE, (cy + 0.5 + o[1]) * NT.TILE];
};
// Ground entities standing in / claiming the cell (building or large body first, then smalls).
NT.Occ.at = function (world, cx, cy, out) {
  out = out || []; out.length = 0;
  if (cx < 0 || cy < 0 || cx >= world.w || cy >= world.h) return out;
  const i = cy * world.w + cx, s = world.occ[i];
  if (s) { const e = world.byId.get(s); if (e) out.push(e); }
  const b = i * NT.INF_PER_CELL;
  for (let k = 0; k < NT.INF_PER_CELL; k++) if (world.inf[b + k]) { const e = world.byId.get(world.inf[b + k]); if (e) out.push(e); }
  return out;
};

// Nearest cell (expanding rings, deterministic) where the body can stand.
NT.findFreeCell = function (world, body, cx, cy, maxR) {
  return NT.spiral(cx, cy, maxR === undefined ? 12 : maxR, function (x, y) { return NT.Occ.canStand(world, body, x, y); });
};

// Can a structure footprint go here? Terrain buildable, nothing standing on it.
// (Adjacency / ownership rules are the prod system's business.)
// `ignoreId`: an entity that does not count (a unit deploying into a structure where it stands).
NT.footprintFree = function (world, def, cx, cy, ignoreId) {
  for (let y = cy; y < cy + def.size[1]; y++) for (let x = cx; x < cx + def.size[0]; x++) {
    if (!NT.Map.buildableTerrain(world.map, x, y)) return false;
    const i = y * world.w + x;
    if (world.occ[i] && world.occ[i] !== ignoreId) return false;
    const b = i * NT.INF_PER_CELL;
    for (let k = 0; k < NT.INF_PER_CELL; k++) if (world.inf[b + k] && world.inf[b + k] !== ignoreId) return false;
  }
  return true;
};

// ---------------------------------------------------------------------------
// Spatial queries
// ---------------------------------------------------------------------------
// Distance in px from point to entity: buildings measure to the footprint
// rectangle (0 inside), units to their centre. Use this for ALL range checks
// so melee can reach big structures.
NT.distTo = function (x, y, e) {
  if (e.kind !== 'building') return NT.dist(x, y, e.x, e.y);
  const T = NT.TILE, x0 = e.cx * T, y0 = e.cy * T, x1 = x0 + e.w * T, y1 = y0 + e.h * T;
  const dx = x < x0 ? x0 - x : x > x1 ? x - x1 : 0, dy = y < y0 ? y0 - y : y > y1 ? y - y1 : 0;
  return Math.sqrt(dx * dx + dy * dy);
};
NT.entDist = function (a, b) { return a.kind === 'building' && b.kind !== 'building' ? NT.distTo(b.x, b.y, a) : NT.distTo(a.x, a.y, b); };

// Every live, non-hidden entity within r px of (x, y) — ground (via the grids),
// buildings (once each) and air. Appends to `out` (cleared first) and returns it.
// Order is deterministic (row-major cells, then world.air order).
NT.entsInRadius = function (world, x, y, r, out) {
  out = out || []; out.length = 0;
  const T = NT.TILE, q = ++world._q;
  const x0 = Math.max(0, Math.floor((x - r) / T) - 1), x1 = Math.min(world.w - 1, Math.floor((x + r) / T) + 1);
  const y0 = Math.max(0, Math.floor((y - r) / T) - 1), y1 = Math.min(world.h - 1, Math.floor((y + r) / T) + 1);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const i = cy * world.w + cx, s = world.occ[i];
    if (s) { const e = world.byId.get(s); if (e && e._q !== q) { e._q = q; if (NT.distTo(x, y, e) <= r) out.push(e); } }
    const b = i * NT.INF_PER_CELL;
    for (let k = 0; k < NT.INF_PER_CELL; k++) {
      const id = world.inf[b + k];
      if (id) { const e = world.byId.get(id); if (e && e._q !== q) { e._q = q; if (NT.dist(x, y, e.x, e.y) <= r) out.push(e); } }
    }
  }
  for (let i = 0; i < world.air.length; i++) { const e = world.air[i]; if (e.alive && NT.dist(x, y, e.x, e.y) <= r) out.push(e); }
  return out;
};

// Topmost entity under a world point (UI picking + smart orders): air, then units, then buildings.
NT.entAt = function (world, x, y, pad) {
  pad = pad === undefined ? 0 : pad;
  let best = null, bd = Infinity;
  for (let i = 0; i < world.air.length; i++) {
    const e = world.air[i], d = NT.dist(x, y, e.x, e.y);
    if (e.alive && d <= e.def.radius + pad && d < bd) { best = e; bd = d; }
  }
  if (best) return best;
  const cx = NT.cellOf(x), cy = NT.cellOf(y), tmp = [];
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    NT.Occ.at(world, cx + ox, cy + oy, tmp);
    for (let k = 0; k < tmp.length; k++) {
      const e = tmp[k]; if (e.kind === 'building') continue;
      const d = NT.dist(x, y, e.x, e.y);
      if (d <= e.def.radius + pad && d < bd) { best = e; bd = d; }
    }
  }
  if (best) return best;
  const s = NT.Occ.solid(world, cx, cy);
  if (s > 0) { const e = world.byId.get(s); if (e && e.kind === 'building') return e; }
  return null;
};

// Cells bordering a building footprint (8-neighbourhood ring), row-major. Units
// "use" a building (dock, enter, capture, melee) from any ring cell.
NT.ringCells = function (world, e, out) {
  out = out || []; out.length = 0;
  for (let y = e.cy - 1; y <= e.cy + e.h; y++) for (let x = e.cx - 1; x <= e.cx + e.w; x++) {
    if (x >= e.cx && x < e.cx + e.w && y >= e.cy && y < e.cy + e.h) continue;
    if (x >= 0 && y >= 0 && x < world.w && y < world.h) out.push(y * world.w + x);
  }
  return out;
};
// Is unit u standing in a cell that touches building b?
NT.touching = function (u, b) {
  return u.cx >= b.cx - 1 && u.cx <= b.cx + b.w && u.cy >= b.cy - 1 && u.cy <= b.cy + b.h;
};

// ---------------------------------------------------------------------------
// Commands: the single entry point for humans and AI.
// ---------------------------------------------------------------------------
// Queues the command for the start of the next tick. Returns false if the type
// is unknown. Handlers re-validate everything at execution time (ownership,
// funds, prerequisites) — callers may send stale or hostile commands.
//
// UNIT ORDERS (ids: number[]; `queue: true` appends instead of replacing):
//   {type:'move',    ids, x, y}
//   {type:'attack',  ids, target}             target = enemy entity id
//   {type:'amove',   ids, x, y}               attack-move
//   {type:'stop',    ids}
//   {type:'stance',  ids, stance}             'aggressive' | 'hold' | 'passive'
//   {type:'harvest', ids, x, y}               gather at / near this resource cell
//   {type:'return',  ids}                     harvesters: deliver cargo now
//   {type:'enter',   ids, target}             context use of a building / transport:
//                                             capture, board, dock, get repaired
//   {type:'unload',  ids}                     transports: everybody out
//   {type:'deploy',  ids}                     toggle the deploy trait
//   {type:'ability', ids, ability, x?, y?, target?}
// PRODUCTION / BASE:
//   {type:'produce', def}                     enqueue one (queue comes from the def)
//   {type:'cancel',  def}                     remove one of this def (refunds what was paid)
//   {type:'place',   def, cx, cy}             put the finished structure on the map
//   {type:'sell',    id}
//   {type:'repair',  id, on?}                 toggle (or set) repairing
//   {type:'rally',   id, x, y}
//   {type:'primary', id}
//   {type:'power',   power, x, y}             fire a support power (full power id)
//   {type:'surrender'}
NT.cmd = function (world, pid, cmd) {
  if (!cmd || !NT.commands[cmd.type] || !world.players[pid]) return false;
  world.cmdQueue.push({ pid: pid, cmd: cmd });
  return true;
};

// Alive, visible-on-map units from `ids` that belong to player p (dedupes nothing; ids are trusted to be unique).
NT.ownUnits = function (world, p, ids, out) {
  out = out || []; out.length = 0;
  if (!ids) return out;
  for (let i = 0; i < ids.length; i++) {
    const e = world.byId.get(ids[i]);
    if (e && e.owner === p.id && e.kind === 'unit' && !e.hidden) out.push(e);
  }
  return out;
};

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------
NT.step = function (world) {
  if (world.events.length > 8192) world.events.length = 0;      // nobody is draining (headless)
  const all = world.ents;
  for (let i = 0; i < all.length; i++) { const e = all[i]; e.px = e.x; e.py = e.y; e.pfacing = e.facing; e.paim = e.aim; }
  const sys = NT.systems;
  let ranCmds = false;
  for (let i = 0; i < sys.length; i++) {
    if (!ranCmds && sys[i].order >= 10) { NT._runCommands(world); ranCmds = true; }
    if (sys[i].step) sys[i].step(world);
  }
  if (!ranCmds) NT._runCommands(world);
  if (world._dead) {
    let j = 0;
    const ents = world.ents;
    for (let i = 0; i < ents.length; i++) if (ents[i].alive) ents[j++] = ents[i];
    ents.length = j;
    world._dead = false;
    // victory runs at order 110, i.e. before this compaction, and tolerates alive === false
  }
  world.tick++;
};

NT._runCommands = function (world) {
  const q = world.cmdQueue;
  if (!q.length) return;
  world.cmdQueue = [];
  for (let i = 0; i < q.length; i++) {
    const p = world.players[q[i].pid], c = q[i].cmd;
    if (!p || p.defeated || world.over) continue;
    const fn = NT.commands[c.type];
    if (fn) fn(world, p, c);
  }
};

// Take (and clear) the presentation events accumulated since the last drain.
NT.drainEvents = function (world) { const ev = world.events; world.events = []; return ev; };

// Order-independent-of-nothing state hash for determinism tests: same seed +
// same commands => same hash at every tick.
NT.hashWorld = function (world) {
  let h = (0x811c9dc5 ^ world.tick) >>> 0;
  const mix = function (v) { h ^= (v | 0); h = Math.imul(h, 0x01000193) >>> 0; };
  mix(world.rng.state);
  for (let i = 0; i < world.players.length; i++) { const p = world.players[i]; mix(Math.round(p.credits)); mix(p.nBuildings); mix(p.nUnits); }
  for (let i = 0; i < world.ents.length; i++) {
    const e = world.ents[i];
    if (!e.alive) continue;
    mix(e.id); mix(e.owner); mix(Math.round(e.hp * 16)); mix(Math.round(e.x * 16)); mix(Math.round(e.y * 16)); mix(e.cargo);
  }
  mix(world.projectiles.length);
  return h >>> 0;
};
