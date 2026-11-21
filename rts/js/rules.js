'use strict';
// ============================================================================
// NEON TURF — rules.js  (HEADLESS-SAFE)
//   1. NT.RULES          global tunables
//   2. NT.WARHEADS       warhead x armor damage matrix
//   3. NT.TRAITS         the generic trait vocabulary (params + defaults)
//   4. NT.defineFaction  registry: faction data file -> normalized defs
//   5. NT.validate       consistency checks (run by the smoke test)
//
// ----------------------------------------------------------------------------
// FACTION AUTHORING CONTRACT  (a faction is ONE data file: js/factions/<id>.js)
// ----------------------------------------------------------------------------
// The engine never names a faction, unit or building. Everything a gang can do
// is expressed here as data that references GENERIC roles, tags and traits.
// Authoring units: seconds, cells, cells/second. Normalization adds tick / px
// twins (see "derived" below) — sim code reads the derived fields.
//
// NT.defineFaction({
//   id: 'mygang',                       // [a-z][a-z0-9]*; full def ids become 'mygang.<key>'
//   name: {en, zh}, tagline: {en, zh}, desc: {en, zh},
//   color: '#rrggbb',                   // signature team colour
//   powerName: {en, zh},                // what this gang calls "power" in the HUD (default Power / 电力)
//   palette: {...},                     // free-form colours for the faction's art file
//   playable: true,                     // false for the neutral pseudo-faction
//   queues: [                           // production tabs, in UI order
//     { id: 'structure', name: {en, zh}, kind: 'building' },   // kind 'building' = finished item is placed by hand
//     { id: 'infantry',  name: {en, zh}, kind: 'unit' },       // kind 'unit'     = finished item walks out of a producer
//   ],
//   start: { buildings: [{ def: 'hq', at: [0, 0] }], units: [{ def: 'grunt', n: 3 }] },   // buildings[0] must be role 'hq'
//   buildings: { <key>: BUILDING }, units: { <key>: UNIT }, powers: { <key>: POWER },
//   ai: AI_HINTS,                       // optional: the skirmish AI plays any faction from generic data alone
// });
//
// AI_HINTS {  // every field optional; unknown keys are ignored (read by js/ai.js only)
//   opening: ['key', ...],        // structures queued first, in order (a repeated key = one more of it); power is
//                                 // still topped up and missing prerequisites are built first. Ignored after 8 minutes.
//   army: { <unitKey>: weight },  // relative share of army VALUE per fighter (armed, non-harvester unit). Replaces
//                                 // the generic weights (tier / siege / scout / limit); 0 or absent = never built as
//                                 // a fighter. The AI still adapts the weights to the enemy's mix and forces anti-air.
//   harvesters: n,                // harvesters per drop-off (default 3; the difficulty level caps the total)
//   attackAt: x,                  // multiplies the level's attack-wave army values (default 1; < 1 = earlier, smaller)
// }
//
// BUILDING {
//   name, desc: {en, zh}
//   role: 'hq'|'power'|'dropoff'|'producer'|'radar'|'tech'|'defense'|'super'|'support'|'turf'
//   tags: [...],  tier: 1..3
//   queue: 'structure',           // which queue builds it (omit = cannot be built, e.g. turf)
//   cost, buildTime?,             // buildTime seconds; default = cost * RULES.buildSecPerCredit
//   hp, armor: 'building',
//   size: [w, h],                 // footprint in cells
//   power: +n | -n,               // produces / consumes
//   needsPower: bool,             // switches off while the owner is low on power (default: true for defense/radar/super)
//   sight: cells,
//   requires: ['key', ...],       // buildings of the SAME faction the owner must have
//   weapons: [WEAPON],            // defenses
//   traits: { <trait>: {params} },
//   anchor: bool,                 // other structures may be placed next to it (default: false for defense/turf)
//   countsForDefeat: bool,        // a player with none of these left is defeated. Default: true for hq / producer only
//   placement: 'anchor'|'free',   // 'anchor' (default): within RULES.buildGap of one of the owner's anchor structures.
//                                 // 'free': anywhere the owner can currently SEE the whole footprint (expansions).
//   limit: n,                     // max alive + queued per player (0 = unlimited). Also valid on units (heroes).
// }
// UNIT {
//   name, desc, tags: [...], tier, queue, cost, buildTime?, hp,
//   armor: 'infantry'|'light'|'heavy',
//   move: { type: 'foot'|'wheel'|'track'|'beast'|'hover'|'air', speed: cells/sec, turn?: deg/sec, body?: 'small'|'large' },
//                                 // body = occupancy class; default small for foot, large otherwise ('air' flies)
//   sight: cells, requires: [...], weapons: [WEAPON], traits: {...},
//   stance?: 'aggressive'|'hold'|'passive'   // default aggressive; passive for unarmed units
// }
// WEAPON {
//   name?: {en, zh},
//   dmg, range (cells), minRange?, cooldown (s), burst?, burstGap? (s),
//   proj: 'instant'|'bullet'|'rocket'|'shell'|'lob'|'beam'|'flame'|'melee',
//                                 // 'melee' ALSO reaches any ground target standing in the same or a touching cell
//                                 // (and any building the attacker touches), whatever the sub-cell offsets are —
//                                 // on a cell grid "adjacent" must always mean "in reach".
//   speed?: cells/sec (travelling projectiles), splash?: cells, warhead: <NT.WARHEADS key>,
//   ground?: true, air?: false,   // which layers it can hit
//   turret?: bool,                // aims independently of the hull (uses ent.aim)
//   homing?: bool,                // travelling projectile tracks its target
//   heal?: bool, healTags?: [...],// targets damaged ALLIES carrying one of healTags; dmg = hp restored
//   needsBrace?: bool,            // may only fire while the unit is braced (see the brace trait): set-up weapons
//   consume?: bool,               // single-use: the shooter is destroyed when this weapon fires (loitering munitions).
//                                 // Give such units stance 'passive' so they only spend themselves on an explicit order.
//   onHit?: { slow?: {mult, dur, armor?: [classes]}, burn?: {dps, dur} },   // slow.armor limits which armor classes are slowed
//   only?: [tags], not?: [tags],  // target filters
//   vs?: { <armor>: mult },       // per-weapon override on top of the warhead row
//   fx?: 'water'|'acid'|'harpoon'|...   // free-form presentation hint (how the shot looks / sounds); the sim ignores it
// }
// POWER {  // support power, charged while the owner has `building`
//   name, desc, building: 'key', cooldown (s), initial?: 0..1 (charge at start),
//   kind: 'strike' | 'reveal' | 'buff' | 'spawn',
//   strike: { radius (cells: warning ring + scatter area), shells (count), dmg + splash (cells) + warhead per shell,
//             delay (s of warning before the first shell), over (s the shells are spread across) }
//   reveal: { radius, dur }
//   buff:   { radius, dur, affects: 'allies'|'enemies', mods: MODS, tags?: [...], heal?: 0..1 (instant, fraction of max hp),
//             after?: { dur, mods: MODS } }                // a comedown applied when the buff runs out
//   spawn:  { def: 'key', count, lifetime? (s), delay? (s) }   // target: walkable ground the owner can currently see
// }
//
// MODS — one shape everywhere a stat modifier appears (auras, buffs, enrage,
// stim, deploy, veterancy). Omitted keys mean "no change":
//   { dmg: x damage dealt, taken: x damage TAKEN (0.8 = 20% tougher), speed: x
//     move speed, rof: x rate of fire, range: x weapon range, sight: x sight,
//     regen: + fraction of max hp healed per second }
// Multipliers from different sources multiply; several auras of the same kind
// do not stack (the strongest value per stat wins); regen adds up.
//
// META — def.meta is a free-form object copied through untouched, for tools
// that want hints without the engine knowing about them (e.g. mapgen reads
// meta.mapWeight on neutral turf structures).
//
// DERIVED fields added by normalization (read these in sim code):
//   def.id 'faction.key' · def.key · def.faction · def.kind · def.is[tag] ·
//   def.buildTicks · def.layer · def.body · def.radius (px) · def.sightPx ·
//   def.move.speedPx (px/tick) · def.move.turnRad (rad/tick) ·
//   weapon.rangePx · minRangePx · cd (ticks) · burstCd (ticks) · speedPx
//   (px/tick; 0 = hits instantly) · splashPx · onHit.*.durT ·
//   trait params: every field listed in the trait's `time` gets a <field>T
//   twin in ticks, every field in `dist` a <field>Px twin in px.
// ============================================================================

NT.RULES = {
  startCredits: 6000,
  buildSecPerCredit: 0.02,     // default build time: 1000 credits = 20 s
  sellRefund: 0.5,             // x cost x current hp fraction
  repairRate: 0.02,            // fraction of max hp restored per second while repairing
  repairCost: 0.3,             // a full 0 -> 100% repair costs this fraction of the price
  buildGap: 3,                 // max empty cells between a new structure and one of the owner's anchor structures
  lowPowerProd: 0.4,           // production speed multiplier while low on power
  producerBonus: 0.5,          // every extra producer of a queue adds this much speed ...
  producerBonusMax: 2.5,       // ... up to this total multiplier
  maxQueue: 20,                // items waiting in one queue
  fogEvery: 4,                 // ticks between visibility recomputes
  scanEvery: 6,                // ticks between target scans of an idle armed entity
  leash: 7,                    // cells an aggressive idle unit will chase from its post
  splashFalloff: 0.5,          // splash damage at the rim, as a fraction of the centre
  vetXp: [3, 7],               // xp (as a multiple of the unit's own cost) needed for rank 1, 2; xp gained = victim cost
  vetMods: [                   // MODS per rank (rank 0 = none)
    {},
    { dmg: 1.15, taken: 0.88, rof: 1.1 },
    { dmg: 1.3, taken: 0.76, rof: 1.2, regen: 0.01 },
  ],
  regrowEvery: 40,             // ticks between resource regrow pulses
  hurtEventEvery: 20,          // min ticks between 'hurt' events of one entity
  crushDmg: 9999,
};

// Team colours handed out when a faction's signature colour is already taken.
NT.PLAYER_COLORS = ['#19e3ff', '#ff3d81', '#ffb21e', '#8dff3a', '#b07cff', '#f2f5fa'];

// ---------------------------------------------------------------------------
// Warheads: damage multiplier per armor class. final = dmg x WARHEADS[w][armor]
// x weapon.vs[armor] x attacker mods x target mods.
// ---------------------------------------------------------------------------
NT.ARMORS = ['infantry', 'light', 'heavy', 'building'];
NT.WARHEADS = {};
NT.defineWarhead = function (name, vs) {
  for (const a of NT.ARMORS) NT.assert(typeof vs[a] === 'number', 'warhead ' + name + ' needs a multiplier for ' + a);
  NT.WARHEADS[name] = vs;
};
//                                   infantry      light        heavy        building
NT.defineWarhead('small', { infantry: 1.00, light: 0.60, heavy: 0.25, building: 0.25 });   // small arms, machine guns
NT.defineWarhead('ap',    { infantry: 0.35, light: 1.00, heavy: 1.00, building: 0.60 });   // cannon, rockets, harpoons, thrown rebar
NT.defineWarhead('he',    { infantry: 1.00, light: 0.80, heavy: 0.50, building: 1.10 });   // shells, grenades, cinder blocks
NT.defineWarhead('fire',  { infantry: 1.20, light: 0.70, heavy: 0.35, building: 0.90 });   // flame, incendiary, acid
NT.defineWarhead('melee', { infantry: 1.00, light: 0.80, heavy: 0.25, building: 0.30 });   // fists, claws, bites
NT.defineWarhead('smash', { infantry: 0.35, light: 1.00, heavy: 1.00, building: 1.20 });   // rams, horns, breaching tools
NT.defineWarhead('shock', { infantry: 1.00, light: 0.90, heavy: 0.75, building: 0.25 });   // water jets, electricity, sonics

// ---------------------------------------------------------------------------
// Traits: the generic vocabulary factions compose behaviour from. A def opts
// in with traits: { name: {params} }. `defaults` fill missing params; fields
// listed in `time` (seconds) / `dist` (cells) get <field>T / <field>Px twins.
// Behaviour is implemented by the systems (econ / prod / traits / powers) —
// adding a trait here without implementing it does nothing.
// ---------------------------------------------------------------------------
NT.TRAITS = {};
NT.defineTrait = function (name, spec) {
  spec.defaults = spec.defaults || {}; spec.time = spec.time || []; spec.dist = spec.dist || [];
  NT.TRAITS[name] = spec;
};

// --- economy / production
NT.defineTrait('producer', { on: 'building', defaults: { queues: [], exit: null },
  doc: 'Builds items of the listed queue ids. exit: [dx,dy] from the top-left cell where units appear (default: below the bottom edge, centred).' });
NT.defineTrait('dropoff', { on: 'building', defaults: { freeUnit: null },
  doc: 'Harvesters deliver cargo from any cell touching this building. freeUnit: unit key spawned for the owner when the building is placed (the free harvester).' });
NT.defineTrait('harvester', { on: 'unit', defaults: { capacity: 600, loadTime: 20, unloadTime: 4 }, time: ['loadTime', 'unloadTime'],
  doc: 'Gathers map resource (credits) and returns it to the nearest dropoff. loadTime/unloadTime = seconds for a full load.' });
NT.defineTrait('radar', { on: 'building', defaults: {},
  doc: 'Owner gets the minimap while this is alive and powered.' });
NT.defineTrait('income', { on: 'building', defaults: { amount: 25, every: 5 }, time: ['every'],
  doc: 'Pays the owner `amount` credits every `every` seconds.' });
NT.defineTrait('recruit', { on: 'building', defaults: { every: 45 }, time: ['every'],
  doc: 'Every `every` seconds a local joins the owner: spawns, beside the building, the cheapest armed unit of the OWNER\'s faction that has no prerequisites and no limit (picked generically from data).' });

// --- unit / structure behaviour
NT.defineTrait('selfHeal', { on: 'any', defaults: { rate: 0.02, delay: 5 }, time: ['delay'],
  doc: 'Regenerates `rate` (fraction of max hp) per second after `delay` seconds without taking damage.' });
NT.defineTrait('aura', { on: 'any', defaults: { radius: 4, affects: 'allies', tags: null, self: false, mods: {} }, dist: ['radius'],
  doc: 'Entities in radius (allies | enemies, optionally only those with one of `tags`) get MODS `mods`. self: also affects the carrier. Auras do not stack; the strongest value per stat wins.' });
NT.defineTrait('enrage', { on: 'any', defaults: { below: 0.5, mods: {} },
  doc: 'While hp fraction < `below`, apply MODS `mods` to itself.' });
NT.defineTrait('brace', { on: 'unit', defaults: { delay: 2, mods: {}, uncrushable: true }, time: ['delay'],
  doc: 'After standing still for `delay` seconds the unit is BRACED (ent.braced): MODS `mods` apply and, if uncrushable, crushers cannot run it over. Moving cancels it at once. Weapons flagged needsBrace only fire while braced.' });
NT.defineTrait('surge', { on: 'unit', defaults: { cooldown: 20, dur: 6, mods: {}, crash: 4, crashMods: {}, hpCost: 0, range: 5, auto: true }, time: ['cooldown', 'dur', 'crash'], dist: ['range'],
  doc: 'Self-buff with a price: MODS `mods` for `dur` seconds, then MODS `crashMods` for `crash` seconds (the comedown). Optional hpCost (fraction of max hp, never lethal). auto: triggers itself when the unit\'s attack target is within `range` cells. Cooldown starts when it triggers.' });
NT.defineTrait('leap', { on: 'unit', defaults: { range: 4, minRange: 1.5, cooldown: 8, dmg: 0, warhead: 'melee', slow: null, style: 'jump' }, time: ['cooldown'], dist: ['range', 'minRange'],
  doc: 'Gap-closer: when its attack target is between minRange and range, the unit relocates to a free cell touching the target (deals `dmg` + optional slow {mult, dur} on arrival). style: jump (arcs over units) | dash (charges along the ground) — presentation only.' });
NT.defineTrait('deploy', { on: 'unit', defaults: { into: null },
  doc: 'Deploy command: the unit turns into the building `into` (key) centred on its cell, if the footprint fits.' });
NT.defineTrait('capturer', { on: 'unit', defaults: { time: 6, consumed: false, payout: 0 }, time: ['time'],
  doc: 'Enter command on a capturable building: channels `time` seconds while touching it, then takes ownership (consumed: the unit is spent; payout: credits collected on the spot).' });
NT.defineTrait('capturable', { on: 'building', defaults: { revert: true, revertHp: 0.5 },
  doc: 'Can be captured. revert: at 0 hp it is not destroyed but returns to neutral with revertHp of its health; while neutral it cannot be damaged.' });
NT.defineTrait('crusher', { on: 'unit', defaults: {},
  doc: 'May move into cells holding only enemy small bodies, killing them — unless they are tagged uncrushable or are braced with brace.uncrushable.' });
NT.defineTrait('explodeOnDeath', { on: 'any', defaults: { dmg: 60, radius: 1.5, warhead: 'he' }, dist: ['radius'],
  doc: 'Area damage to EVERYONE nearby (friend and foe) when destroyed.' });
NT.defineTrait('spawnOnDeath', { on: 'any', defaults: { def: null, count: 1 },
  doc: 'Spawns `count` units of `def` (same-faction key) for the owner when destroyed.' });
NT.defineTrait('bounty', { on: 'any', defaults: { frac: 0.1, buildings: false },
  doc: 'When this entity kills an enemy unit (and structures too, if buildings: true), its owner earns frac x the victim\'s cost.' });
NT.defineTrait('lifesteal', { on: 'unit', defaults: { frac: 0.25 },
  doc: 'Heals itself for frac x damage dealt.' });

// ---------------------------------------------------------------------------
// Registry + normalization
// ---------------------------------------------------------------------------
NT.FACTIONS = {};        // id -> faction (including non-playable ones)
NT.FACTION_LIST = [];    // playable factions, registration order
NT.DEFS = {};            // 'faction.key' -> normalized unit / building def
NT.POWERS = {};          // 'faction.key' -> normalized support-power def

NT.PROJ = { instant: 0, beam: 0, flame: 0, melee: 0, bullet: 26, rocket: 10, shell: 15, lob: 8 };   // default speeds, cells/sec (0 = instant)
NT.BUILDING_ROLES = ['hq', 'power', 'dropoff', 'producer', 'radar', 'tech', 'defense', 'super', 'support', 'turf'];

NT._name = function (n, where) {
  NT.assert(n && typeof n.en === 'string' && typeof n.zh === 'string', where + ': name/desc needs {en, zh}');
  return { en: n.en, zh: n.zh };
};

NT._normTraits = function (traits, where) {
  const out = {};
  for (const name in (traits || {})) {
    const spec = NT.TRAITS[name];
    NT.assert(spec, where + ': unknown trait "' + name + '"');
    const p = Object.assign({}, spec.defaults, traits[name] === true ? {} : traits[name]);
    for (const f of spec.time) if (typeof p[f] === 'number') p[f + 'T'] = NT.ticks(p[f]);
    for (const f of spec.dist) if (typeof p[f] === 'number') p[f + 'Px'] = p[f] * NT.TILE;
    out[name] = p;
  }
  return out;
};

NT._normWeapon = function (w, where) {
  NT.assert(NT.PROJ[w.proj] !== undefined, where + ': unknown proj "' + w.proj + '"');
  NT.assert(NT.WARHEADS[w.warhead], where + ': unknown warhead "' + w.warhead + '"');
  NT.assert(w.dmg > 0 && w.range > 0 && w.cooldown > 0, where + ': dmg, range and cooldown must be > 0');
  const speed = w.speed === undefined ? NT.PROJ[w.proj] : w.speed;
  const o = {
    name: w.name || null,
    dmg: w.dmg, range: w.range, rangePx: w.range * NT.TILE, minRangePx: (w.minRange || 0) * NT.TILE,
    cooldown: w.cooldown, cd: NT.ticks(w.cooldown),
    burst: w.burst || 1, burstCd: NT.ticks(w.burstGap || 0.12),
    proj: w.proj, speedPx: speed * NT.TILE / NT.TPS,
    splash: w.splash || 0, splashPx: (w.splash || 0) * NT.TILE,
    warhead: w.warhead,
    ground: w.ground !== false, air: !!w.air,
    turret: !!w.turret, homing: !!w.homing,
    heal: !!w.heal, healTags: w.healTags || null,
    needsBrace: !!w.needsBrace, consume: !!w.consume,
    onHit: null, only: w.only || null, not: w.not || null, vs: w.vs || null,
    fx: w.fx || null,
  };
  if (w.onHit) {
    o.onHit = {};
    for (const k in w.onHit) { o.onHit[k] = Object.assign({}, w.onHit[k]); o.onHit[k].durT = NT.ticks(w.onHit[k].dur || 1); }
  }
  // sustained damage per second vs a neutral target — UI tooltips and AI valuation
  o.dps = o.dmg * o.burst / (o.cooldown + (o.burst - 1) * (w.burstGap || 0.12));
  return o;
};

NT._normDef = function (f, key, src, kind) {
  const where = f.id + '.' + key;
  const isB = kind === 'building';
  NT.assert(/^[a-zA-Z][a-zA-Z0-9]*$/.test(key), where + ': keys are alphanumeric');
  NT.assert(src.hp > 0, where + ': hp must be > 0');
  const role = isB ? (src.role || 'support') : '';
  if (isB) NT.assert(NT.BUILDING_ROLES.indexOf(role) >= 0, where + ': unknown role "' + role + '"');
  const d = {
    id: where, key: key, faction: f.id, kind: kind,
    name: NT._name(src.name, where), desc: NT._name(src.desc || { en: '', zh: '' }, where),
    role: role, tags: (src.tags || []).slice(), is: {},
    meta: src.meta || {},
    tier: src.tier || 1,
    queue: src.queue || null,
    cost: src.cost || 0,
    buildTime: 0, buildTicks: 0,
    hp: src.hp,
    armor: isB ? 'building' : (src.armor || 'infantry'),
    sight: src.sight === undefined ? (isB ? 5 : 6) : src.sight, sightPx: 0,
    requires: (src.requires || []).map(function (k) { return k.indexOf('.') >= 0 ? k : f.id + '.' + k; }),
    weapons: (src.weapons || []).map(function (w, i) { return NT._normWeapon(w, where + '.weapons[' + i + ']'); }),
    traits: NT._normTraits(src.traits, where),
    layer: 'ground', body: 'building', radius: 0,
    stance: src.stance || null,
    limit: src.limit || 0,
    // buildings
    size: null, power: 0, needsPower: false, anchor: false, countsForDefeat: false, placement: 'anchor',
    // units
    move: null,
    art: null,                       // attached by NT.defineArt (presentation)
  };
  NT.assert(NT.ARMORS.indexOf(d.armor) >= 0, where + ': unknown armor "' + d.armor + '"');
  d.buildTime = src.buildTime === undefined ? Math.max(2, d.cost * NT.RULES.buildSecPerCredit) : src.buildTime;
  d.buildTicks = NT.ticks(d.buildTime);
  d.sightPx = d.sight * NT.TILE;
  if (isB) {
    NT.assert(src.size && src.size[0] >= 1 && src.size[1] >= 1, where + ': size [w, h] required');
    d.size = [src.size[0], src.size[1]];
    d.power = src.power || 0;
    const soft = role === 'defense' || role === 'turf';
    d.needsPower = src.needsPower === undefined ? (role === 'defense' || role === 'radar' || role === 'super') && d.power < 0 : !!src.needsPower;
    d.anchor = src.anchor === undefined ? !soft : !!src.anchor;
    d.countsForDefeat = src.countsForDefeat === undefined ? (role === 'hq' || role === 'producer') : !!src.countsForDefeat;
    d.placement = src.placement === 'free' ? 'free' : 'anchor';
    d.radius = Math.max(d.size[0], d.size[1]) * NT.TILE / 2;
    d.tags.push('structure');
  } else {
    const m = src.move || {};
    NT.assert(m.type, where + ': move.type required');
    const air = m.type === 'air';
    d.layer = air ? 'air' : 'ground';
    d.body = air ? 'air' : (m.body || (m.type === 'foot' ? 'small' : 'large'));
    NT.assert(d.body === 'air' || d.body === 'small' || d.body === 'large', where + ': move.body must be small|large');
    const speed = m.speed || 0, turn = m.turn === undefined ? (d.body === 'small' ? 720 : air ? 240 : 180) : m.turn;
    d.move = { type: m.type, speed: speed, speedPx: speed * NT.TILE / NT.TPS, turn: turn, turnRad: turn * Math.PI / 180 / NT.TPS };
    d.radius = src.radius || (d.body === 'small' ? 7 : d.body === 'air' ? 11 : 13);
    if (!d.stance) d.stance = d.weapons.some(function (w) { return !w.heal; }) ? 'aggressive' : 'passive';
  }
  // auto tags
  const auto = function (t) { if (d.tags.indexOf(t) < 0) d.tags.push(t); };
  if (d.layer === 'air') auto('air');
  if (d.traits.harvester) auto('harvester');
  if (d.traits.capturer) auto('capturer');
  if (d.tags.indexOf('infantry') >= 0 || d.tags.indexOf('beast') >= 0) auto('organic');
  if (isB || d.tags.indexOf('vehicle') >= 0 || d.tags.indexOf('drone') >= 0) auto('mechanical');
  for (const t of d.tags) d.is[t] = true;
  return d;
};

NT.defineFaction = function (spec) {
  NT.assert(spec && /^[a-z][a-z0-9]*$/.test(spec.id || ''), 'defineFaction: id must match [a-z][a-z0-9]*');
  NT.assert(!NT.FACTIONS[spec.id], 'defineFaction: duplicate faction "' + spec.id + '"');
  const f = {
    id: spec.id, playable: spec.playable !== false,
    name: NT._name(spec.name, spec.id), tagline: NT._name(spec.tagline || { en: '', zh: '' }, spec.id),
    desc: NT._name(spec.desc || { en: '', zh: '' }, spec.id),
    color: spec.color || NT.PLAYER_COLORS[0], palette: spec.palette || {},
    powerName: NT._name(spec.powerName || { en: 'Power', zh: '电力' }, spec.id),
    queues: [], queueById: {},
    buildings: {}, units: {}, powers: {},
    defs: [],                         // every unit + building def, declaration order (buildings first)
    start: { buildings: [], units: [] },
    ai: spec.ai || {},
    art: null,                        // attached by NT.defineArt
  };
  for (const q of (spec.queues || [])) {
    NT.assert(q.id && (q.kind === 'building' || q.kind === 'unit'), f.id + ': queue needs id + kind');
    const nq = { id: q.id, name: NT._name(q.name, f.id + ' queue ' + q.id), kind: q.kind };
    f.queues.push(nq); f.queueById[q.id] = nq;
  }
  for (const key in (spec.buildings || {})) {
    const d = NT._normDef(f, key, spec.buildings[key], 'building');
    f.buildings[key] = d; f.defs.push(d); NT.DEFS[d.id] = d;
  }
  for (const key in (spec.units || {})) {
    NT.assert(!f.buildings[key], f.id + '.' + key + ': a unit and a building share this key');
    const d = NT._normDef(f, key, spec.units[key], 'unit');
    f.units[key] = d; f.defs.push(d); NT.DEFS[d.id] = d;
  }
  const full = function (k) { return k && k.indexOf('.') < 0 ? f.id + '.' + k : k; };
  for (const key in (spec.powers || {})) {
    const s = spec.powers[key], where = f.id + '.' + key;
    NT.assert(['strike', 'reveal', 'buff', 'spawn'].indexOf(s.kind) >= 0, where + ': unknown power kind');
    const p = {
      id: where, key: key, faction: f.id,
      name: NT._name(s.name, where), desc: NT._name(s.desc || { en: '', zh: '' }, where),
      building: full(s.building), cooldown: s.cooldown, cooldownT: NT.ticks(s.cooldown),
      initial: s.initial || 0, kind: s.kind,
      strike: null, reveal: null, buff: null, spawn: null,
    };
    const a = Object.assign({}, s[s.kind]);
    if (typeof a.radius === 'number') a.radiusPx = a.radius * NT.TILE;
    if (typeof a.splash === 'number') a.splashPx = a.splash * NT.TILE;
    if (typeof a.over === 'number') a.overT = NT.ticks(a.over);
    if (typeof a.delay === 'number') a.delayT = NT.ticks(a.delay);
    if (typeof a.dur === 'number') a.durT = NT.ticks(a.dur);
    if (typeof a.lifetime === 'number') a.lifetimeT = NT.ticks(a.lifetime);
    if (a.def) a.def = full(a.def);
    if (a.after) { a.after = Object.assign({}, a.after); a.after.durT = NT.ticks(a.after.dur || 1); }
    p[s.kind] = a;
    f.powers[key] = p; NT.POWERS[p.id] = p;
  }
  // resolve cross references inside traits to full ids
  for (const d of f.defs) {
    const t = d.traits;
    if (t.deploy && t.deploy.into) t.deploy.into = full(t.deploy.into);
    if (t.spawnOnDeath && t.spawnOnDeath.def) t.spawnOnDeath.def = full(t.spawnOnDeath.def);
    if (t.dropoff && t.dropoff.freeUnit) t.dropoff.freeUnit = full(t.dropoff.freeUnit);
  }
  const st = spec.start || {};
  f.start.buildings = (st.buildings || []).map(function (b) { return { def: full(b.def), at: b.at || [0, 0] }; });
  f.start.units = (st.units || []).map(function (u) { return { def: full(u.def), n: u.n || 1 }; });
  NT.FACTIONS[f.id] = f;
  if (f.playable) NT.FACTION_LIST.push(f);
  return f;
};

// ---------------------------------------------------------------------------
// Validation — returns a list of human-readable problems ([] = fine).
// The smoke test fails on any problem, so a broken faction file is caught
// before anyone plays it.
// ---------------------------------------------------------------------------
NT.validateFaction = function (f) {
  const errs = [], bad = function (m) { errs.push(f.id + ': ' + m); };
  const producersOf = {};
  for (const d of f.defs) {
    if (d.traits.producer) for (const q of d.traits.producer.queues) (producersOf[q] = producersOf[q] || []).push(d);
  }
  for (const d of f.defs) {
    if (!d.name.en || !d.name.zh) bad(d.key + ' is missing a name in en or zh');
    for (const r of d.requires) {
      const rd = NT.DEFS[r];
      if (!rd) bad(d.key + ' requires unknown "' + r + '"');
      else if (rd.kind !== 'building' || rd.faction !== f.id) bad(d.key + ' requires "' + r + '" which is not a building of this faction');
    }
    if (d.queue) {
      const q = f.queueById[d.queue];
      if (!q) bad(d.key + ' uses unknown queue "' + d.queue + '"');
      else {
        if ((q.kind === 'building') !== (d.kind === 'building')) bad(d.key + ' is a ' + d.kind + ' in a ' + q.kind + ' queue');
        if (!producersOf[d.queue]) bad('nothing produces queue "' + d.queue + '" (needed by ' + d.key + ')');
      }
      if (!(d.cost > 0)) bad(d.key + ' is buildable but has no cost');
    }
    for (const w of d.weapons) {
      if (!w.ground && !w.air) bad(d.key + ' has a weapon that can hit nothing');
      if (w.heal && !w.healTags) bad(d.key + ' heal weapon needs healTags');
    }
    if (d.kind === 'unit' && !(d.move.speed > 0)) bad(d.key + ' cannot move (move.speed)');
    const t = d.traits;
    if (t.deploy && t.deploy.into && !NT.DEFS[t.deploy.into]) bad(d.key + ' deploys into unknown "' + t.deploy.into + '"');
    if (t.spawnOnDeath && !NT.DEFS[t.spawnOnDeath.def]) bad(d.key + ' spawnOnDeath unknown def');
    if (t.dropoff && t.dropoff.freeUnit && !NT.DEFS[t.dropoff.freeUnit]) bad(d.key + ' dropoff.freeUnit unknown def');
    for (const name in t) {
      const on = NT.TRAITS[name].on;
      if (on !== 'any' && on !== d.kind) bad(d.key + ' has trait ' + name + ' which only applies to a ' + on);
    }
  }
  for (const key in f.powers) {
    const p = f.powers[key];
    if (!NT.DEFS[p.building] || NT.DEFS[p.building].kind !== 'building') bad('power ' + key + ' is charged by unknown building "' + p.building + '"');
    if (!(p.cooldown > 0)) bad('power ' + key + ' needs a cooldown');
    if (p.kind === 'spawn' && !NT.DEFS[p.spawn.def]) bad('power ' + key + ' spawns unknown def');
    if (p.kind === 'strike' && !NT.WARHEADS[p.strike.warhead]) bad('power ' + key + ' has an unknown warhead');
  }
  if (!f.playable) return errs;

  // a playable faction must be able to bootstrap an economy and reach every item it lists
  if (!f.queues.length) bad('no production queues');
  const st = f.start;
  if (!st.buildings.length || !NT.DEFS[st.buildings[0].def] || NT.DEFS[st.buildings[0].def].role !== 'hq') bad('start.buildings[0] must be the role "hq" building');
  for (const b of st.buildings) if (!NT.DEFS[b.def]) bad('start building unknown "' + b.def + '"');
  const hq0 = st.buildings.length && NT.DEFS[st.buildings[0].def];
  if (hq0 && (hq0.size[0] > 3 || hq0.size[1] > 3)) bad('the HQ footprint must fit in 3x3 (map start yards assume it)');
  for (const u of st.units) if (!NT.DEFS[u.def]) bad('start unit unknown "' + u.def + '"');
  // reachability: start buildings -> whatever their queues + satisfied prerequisites unlock, to a fixed point
  const have = {};
  for (const b of st.buildings) have[b.def] = true;
  for (let changed = true; changed;) {
    changed = false;
    for (const d of f.defs) {
      if (have[d.id] || !d.queue) continue;
      const prods = producersOf[d.queue] || [];
      if (!prods.some(function (p) { return have[p.id]; })) continue;
      if (!d.requires.every(function (r) { return have[r]; })) continue;
      have[d.id] = true; changed = true;
    }
  }
  for (const d of f.defs) if (d.queue && !have[d.id]) bad(d.key + ' can never be built (unreachable prerequisites or producer)');
  const reach = f.defs.filter(function (d) { return have[d.id]; });
  if (!reach.some(function (d) { return d.kind === 'building' && d.power > 0 && d.queue; })) bad('no buildable power source');
  if (!reach.some(function (d) { return d.traits.dropoff && d.queue; })) bad('no buildable dropoff');
  if (!reach.some(function (d) { return d.traits.harvester; })) bad('no obtainable harvester');
  if (!reach.some(function (d) { return d.kind === 'unit' && d.weapons.some(function (w) { return !w.heal; }); })) bad('no obtainable armed unit');
  return errs;
};

NT.validate = function () {
  let errs = [];
  for (const id in NT.FACTIONS) errs = errs.concat(NT.validateFaction(NT.FACTIONS[id]));
  return errs;
};
