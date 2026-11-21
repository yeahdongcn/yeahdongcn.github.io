'use strict';
// ============================================================================
// NEON TURF — ai.js : the skirmish AI  (HEADLESS-SAFE, DETERMINISTIC)
// System 'ai' (order 5): every player with player.ai = 'easy' | 'normal' | 'hard' gets a brain that thinks
// every LEVELS[ai].think ticks (staggered per player) and acts ONLY through NT.cmd — the door the human UI uses.
// The one direct write: its own handicaps player.incomeMul / player.prodMul, set once.
//
// FACTION-AGNOSTIC: decisions come from generic data only — def.role, def.traits, def.tags, tier, cost, requires,
// limit, weapons (range, dps, warhead x armor, air/ground, heal, consume), the queues' kinds, NT.Prod.options /
// findPlace, NT.Powers.state and power kinds. Optional hints in faction.ai (shape in the rules.js contract header):
//   opening: ['key', ...]     structures built first, in this order (repeat a key for a second one)
//   army: { key: weight }     relative share of army VALUE per unit key (replaces the generic tag/tier weights)
//   harvesters: n             harvesters per drop-off (default 3)
//   attackAt: x               multiplies the level's wave sizes (default 1; < 1 attacks earlier and smaller)
//
// HOW IT DECIDES (one think):
//   scan     one pass over world.ents: my structures / units by job, enemy structures (always known: classic RTS
//            AI) and enemy units it can SEE (NT.Fog.canSee) -> their army mix by armor class
//   economy  idle harvesters back to work; pick the field the next drop-off should serve (expansion); scout it
//   build    place ready structures; then the first unmet entry of a want-list per building queue:
//            power if short -> drop-off -> a producer per unit queue -> radar -> defences -> expansion ->
//            tech -> super -> late defences / second producers when floating (opening hints go first;
//            missing prerequisites are resolved recursively; failed placements are cancelled and retried later)
//   army     every unit queue keeps 1-2 items: harvesters to target, a capturer, a healer per ~8 fighters,
//            single-use units, then fighters picked by weighted deficit (generic or hinted weights, adapted to
//            the enemy mix by warhead x armor effectiveness, anti-air guaranteed when the enemy flies)
//   control  rally point toward the enemy; defenders answer threats near my structures; attack waves when the
//            gathered army reaches the threshold (growing per wave, capped, and an escalation clock forces
//            all-in waves late); waves re-target, reinforce, retreat at a loss; siege trails, healers follow;
//            single-use units dive at the costliest thing they see; a capturer claims turf; harass on hard
//   powers   strike the densest enemy value away from my stuff, reveal ahead of a wave, buff a wave in contact,
//            spawn on visible harvesters / weak structures
//   upkeep   repair damaged structures; never sells
//
// API: NT.AI.LEVELS (difficulty table), NT.AI.brain(world, pid) -> brain (tests read brain.stats).
// ============================================================================
NT.AI = {};
NT.AI.MIN = 60 * NT.TPS;           // ticks per minute

//   think       ticks between thinks           harvesters  total target (capped by perDrop x drop-offs)
//   maxDrop     drop-offs it will own          firstWave / waveGrow / waveMax   army value of attack waves
//   allIn       minutes after which waves stop waiting for the threshold      defences / lateDefences  counts
//   producers   max producers per unit queue   powers / harass / recapture     behaviour switches
//   retreat     a wave below this fraction of its starting value falls back
//   prodMul / incomeMul   handicaps (normal = 1 exactly: fair)
NT.AI.LEVELS = {
  easy:   { think: 40, harvesters: 4, maxDrop: 2, firstWave: 3000, waveGrow: 800, waveMax: 6000, allIn: 25,
            defences: 1, lateDefences: 1, producers: 1, powers: false, harass: false, recapture: false,
            retreat: 0.25, prodMul: 0.75, incomeMul: 0.8, depth: 1 },
  normal: { think: 20, harvesters: 6, maxDrop: 3, firstWave: 5000, waveGrow: 1500, waveMax: 12000, allIn: 20,
            defences: 3, lateDefences: 2, producers: 2, powers: true, harass: false, recapture: true,
            retreat: 0.35, prodMul: 1, incomeMul: 1, depth: 2 },
  hard:   { think: 10, harvesters: 8, maxDrop: 4, firstWave: 5000, waveGrow: 1500, waveMax: 14000, allIn: 16,
            defences: 4, lateDefences: 3, producers: 3, powers: true, harass: true, recapture: true,
            retreat: 0.4, prodMul: 1.1, incomeMul: 1.15, depth: 2 },
};

NT.AI.ROLE_W = { dropoff: 3, producer: 3, super: 2.6, power: 2.4, hq: 2.2, tech: 2, radar: 1.8, support: 1.4, defense: 1 };
NT.AI.DEF_R = 9;                   // cells around my structures that count as "home" for defence
NT.AI.SERVE = 12;                  // cells: a field this close to a drop-off is served by it
NT.AI.RICH = 2500;                 // credits left in a field worth a drop-off

NT.AI._sys = function (world) { return world.sys.ai || (world.sys.ai = { brains: [], info: {}, fields: null }); };
NT.AI.brain = function (world, pid) { const S = world.sys.ai; return S ? S.brains[pid] || null : null; };

// ---------------------------------------------------------------------------
// Generic def analysis (per faction, built on first use)
// ---------------------------------------------------------------------------
// classes of things a weapon is good against: 0 infantry, 1 light, 2 heavy, 3 air, 4 structure
NT.AI._clsOf = function (e) {
  return e.kind === 'building' ? 4 : e.layer === 'air' ? 3 : e.def.armor === 'heavy' ? 2 : e.def.armor === 'light' ? 1 : 0;
};
NT.AI._ARM = ['infantry', 'light', 'heavy', 'light', 'building'];
NT.AI._eff = function (def, c) {
  const armor = NT.AI._ARM[c], ws = def.weapons;
  let best = 0;
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    if (w.heal || w.consume || (c === 3 ? !w.air : !w.ground)) continue;
    const vs = w.vs && typeof w.vs[armor] === 'number' ? w.vs[armor] : 1;
    const v = w.dps * NT.WARHEADS[w.warhead][armor] * vs * (1 + Math.min(1, w.splash) * 0.4) * (w.onHit ? 1.3 : 1);
    if (v > best) best = v;
  }
  return best;
};

NT.AI._info = function (world, faction) {
  const S = NT.AI._sys(world);
  if (S.info[faction.id]) return S.info[faction.id];
  const I = { units: [], unitQ: [], buildQ: [], prods: {}, role: {}, maxEff: [0, 0, 0, 0, 0], prior: [0, 0, 0, 0, 0] };
  for (const q of faction.queues) (q.kind === 'unit' ? I.unitQ : I.buildQ).push(q.id);
  for (const d of faction.defs) {
    if (d.kind === 'building') {
      if (d.traits.producer) for (const q of d.traits.producer.queues) (I.prods[q] = I.prods[q] || []).push(d);
      if (d.queue && faction.queueById[d.queue]) (I.role[d.role] = I.role[d.role] || []).push(d);
      continue;
    }
    if (!d.queue || !faction.queueById[d.queue]) continue;
    const u = {
      def: d, eff: [0, 1, 2, 3, 4].map(function (c) { return NT.AI._eff(d, c); }),
      job: d.traits.harvester ? 'harvester' : NT.Combat._spent(d) ? 'consume' : NT.Combat.armed(d) ? 'army' :
        d.weapons.some(function (w) { return w.heal; }) ? 'healer' : d.traits.capturer ? 'capturer' : d.traits.deploy ? 'deploy' : 'other',
    };
    if (u.job === 'army') {
      for (let c = 0; c < 5; c++) I.maxEff[c] = Math.max(I.maxEff[c], u.eff[c]);
      I.prior[d.layer === 'air' ? 3 : d.armor === 'heavy' ? 2 : d.armor === 'light' ? 1 : 0] += 1;
    }
    I.units.push(u);
  }
  for (const r in I.role) I.role[r].sort(function (a, b) { return a.cost - b.cost; });
  for (const q in I.prods) I.prods[q].sort(function (a, b) { return a.cost - b.cost; });
  const n = I.prior[0] + I.prior[1] + I.prior[2] + I.prior[3];
  for (let c = 0; c < 4; c++) I.prior[c] = n ? I.prior[c] / n : 0.25;
  return (S.info[faction.id] = I);
};

// Resource fields: resource cells grouped by proximity (2 cells), computed once per world.
NT.AI._fields = function (world) {
  const S = NT.AI._sys(world);
  if (S.fields) return S.fields;
  const map = world.map, w = world.w, h = world.h, n = w * h, seen = new Uint8Array(n), fields = [];
  const isRes = function (i) { return map.res[i] > 0 || map.resCap[i] > 0; };
  for (let i = 0; i < n; i++) {
    if (!isRes(i) || seen[i]) continue;
    const cells = [], stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const c = stack.pop(), cx = c % w, cy = (c - cx) / w;
      cells.push(c);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const j = y * w + x;
        if (!seen[j] && isRes(j)) { seen[j] = 1; stack.push(j); }
      }
    }
    cells.sort(function (a, b) { return a - b; });
    let sx = 0, sy = 0;
    for (const c of cells) { sx += c % w + 0.5; sy += (c - c % w) / w + 0.5; }
    fields.push({ id: fields.length, cells: cells, cx: sx / cells.length, cy: sy / cells.length, left: 0 });
  }
  return (S.fields = fields);
};
NT.AI._fieldLeft = function (world, f) {
  let s = 0;
  for (let i = 0; i < f.cells.length; i++) s += world.map.res[f.cells[i]];
  return (f.left = s);
};

// ---------------------------------------------------------------------------
// Brain
// ---------------------------------------------------------------------------
NT.AI._make = function (world, p) {
  const lv = NT.AI.LEVELS[p.ai];
  const hint = p.faction.ai || {};
  const n = world.players.length;
  p.incomeMul = lv.incomeMul; p.prodMul = lv.prodMul;
  return {
    pid: p.id, lv: lv, hint: hint, rng: new NT.Rng(NT.hash32(world.seed, 'ai', p.id)),
    offset: Math.floor(lv.think * p.id / Math.max(1, n)) % lv.think,
    role: {}, wave: null, waves: 0, lastWave: 0, defending: false,
    rally: null, fail: {}, blocked: {}, expand: null, scout: 0,
    capt: 0, captT: 0, captAt: 0, captLost: 0, foeSeen: 0, harass: [], harassAt: 0,
    comp: [0, 0, 0, 0, 0], foeAir: 0,
    k: null, batch: {}, pstate: [], tmp: [],
    stats: { thinks: 0, waves: 0, retreats: 0, defends: 0, captureOrders: 0, placed: 0, cancels: 0, expansions: 0,
      powers: {}, harass: 0, dives: 0, repairs: 0, maxArmy: 0 },
  };
};

NT.AI._tick = function (world) {
  const S = NT.AI._sys(world), ps = world.players;
  if (world.over) return;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!p.ai || !NT.AI.LEVELS[p.ai] || p.defeated) continue;
    let B = S.brains[i];
    if (!B) B = S.brains[i] = NT.AI._make(world, p);
    if ((world.tick + B.offset) % B.lv.think !== 0) continue;
    NT.AI.think(world, B);
  }
};

NT.AI.think = function (world, B) {
  const A = NT.AI, p = world.players[B.pid];
  B.stats.thinks++;
  A._scan(world, B, p);
  if (!B.k.base) return;
  A._economy(world, B, p);
  A._build(world, B, p);
  A._army(world, B, p);
  A._control(world, B, p);
  if (B.lv.powers) A._powers(world, B, p);
  A._upkeep(world, B, p);
  A._flush(world, B);
};

// ---------------------------------------------------------------------------
// Scan: what I own, what I know about the enemy
// ---------------------------------------------------------------------------
NT.AI._newK = function () {
  return { myB: [], myU: [], army: [], harv: [], heal: [], cons: [], capt: [], depl: [], foeB: [], foeU: [],
    hq: null, base: null, foe: null, foePid: -1, armyValue: 0, foeArmy: 0, vis: [0, 0, 0, 0, 0], defs: 0 };
};
NT.AI._job = function (e) {
  const d = e.def;
  if (d.traits.harvester) return 'harvester';
  if (NT.Combat._spent(d)) return 'consume';
  if (NT.Combat.armed(d)) return 'army';
  for (let i = 0; i < d.weapons.length; i++) if (d.weapons[i].heal) return 'healer';
  if (d.traits.capturer) return 'capturer';
  if (d.traits.deploy) return 'deploy';
  return 'other';
};

NT.AI._scan = function (world, B, p) {
  const A = NT.AI, k = B.k || (B.k = A._newK()), ents = world.ents, team = p.team, T = NT.TILE;
  k.myB.length = 0; k.myU.length = 0; k.army.length = 0; k.harv.length = 0; k.heal.length = 0; k.cons.length = 0;
  k.capt.length = 0; k.depl.length = 0; k.foeB.length = 0; k.foeU.length = 0;
  k.hq = null; k.armyValue = 0; k.foeArmy = 0; k.defs = 0;
  for (let c = 0; c < 5; c++) k.vis[c] = 0;
  const role = {};
  let foeHq = null, foeHqD = Infinity;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.alive || e.hidden) continue;
    if (e.owner === p.id) {
      if (e.kind === 'building') {
        k.myB.push(e);
        if (e.def.role === 'hq' && !k.hq) k.hq = e;
        if (e.def.role === 'defense') k.defs++;
        continue;
      }
      k.myU.push(e);
      const job = A._job(e);
      role[e.id] = B.role[e.id] || 'idle';
      if (job === 'harvester') k.harv.push(e);
      else if (job === 'consume') k.cons.push(e);
      else if (job === 'healer') { if (e.def.traits.capturer && B.capt === e.id) k.capt.push(e); else k.heal.push(e); }
      else if (job === 'deploy') k.depl.push(e);
      else if (job === 'capturer') k.capt.push(e);
      else if (job === 'army') {
        if (e.def.traits.capturer && (B.capt === e.id)) k.capt.push(e);
        else { k.army.push(e); k.armyValue += e.def.cost; }
      }
      continue;
    }
    if (!NT.isEnemy(world, p.id, e.owner)) continue;
    if (e.kind === 'building') {
      k.foeB.push(e);
      if (e.def.role === 'hq') {
        const d = NT.dist2(e.x, e.y, (p.startCx + 1.5) * T, (p.startCy + 1.5) * T);
        if (d < foeHqD) { foeHqD = d; foeHq = e; }
      }
      continue;
    }
    if (!NT.Fog.canSee(world, team, e)) continue;
    k.foeU.push(e);
    if (NT.Combat.armed(e.def) || NT.Combat._spent(e.def)) { k.vis[A._clsOf(e)] += e.def.cost; k.foeArmy += e.def.cost; }
  }
  B.role = role;
  if (k.armyValue > B.stats.maxArmy) B.stats.maxArmy = k.armyValue;
  // my base centre: the HQ, else my structures' centroid, else my units'
  const src = k.hq ? [k.hq] : k.myB.length ? k.myB : k.myU;
  if (!src.length) { k.base = null; return; }
  let sx = 0, sy = 0;
  for (const e of src) { sx += e.x; sy += e.y; }
  k.base = { cx: sx / src.length / T, cy: sy / src.length / T };
  // the enemy I fight: nearest enemy HQ, else nearest enemy structure, else nearest undefeated enemy start
  let foe = foeHq;
  if (!foe) {
    let bd = Infinity;
    for (const e of k.foeB) {
      if (!e.def.countsForDefeat) continue;
      const d = NT.dist2(e.x / T, e.y / T, k.base.cx, k.base.cy);
      if (d < bd) { bd = d; foe = e; }
    }
  }
  if (foe) { k.foe = { cx: foe.x / T, cy: foe.y / T }; k.foePid = foe.owner; }
  else {
    let bd = Infinity;
    k.foe = null;
    for (const o of world.players) {
      if (o.defeated || !NT.isEnemy(world, p.id, o.id)) continue;
      const d = NT.dist2(o.startCx, o.startCy, k.base.cx, k.base.cy);
      if (d < bd) { bd = d; k.foe = { cx: o.startCx + 1.5, cy: o.startCy + 1.5 }; k.foePid = o.id; }
    }
    if (!k.foe) k.foe = { cx: world.w - k.base.cx, cy: world.h - k.base.cy };
  }
  // enemy army mix: an exponential average of what I see, on top of the enemy faction's roster (public knowledge)
  for (let c = 0; c < 4; c++) B.comp[c] = B.comp[c] * 0.85 + k.vis[c] * 0.15;
  B.foeAir = Math.max(B.foeAir * 0.97, k.vis[3]);
  B.foeSeen = Math.max(B.foeSeen * 0.995, k.foeArmy);
};

// enemy army share per class (0..3), a blend of the roster prior and what was seen
NT.AI._mix = function (world, B, out) {
  const fp = B.k.foePid >= 0 ? world.players[B.k.foePid] : null, prior = fp ? NT.AI._info(world, fp.faction).prior : [0.25, 0.25, 0.25, 0.25];
  const seen = B.comp[0] + B.comp[1] + B.comp[2] + B.comp[3];
  for (let c = 0; c < 4; c++) out[c] = seen > 0 ? prior[c] * 0.3 + (B.comp[c] / seen) * 0.7 : prior[c];
  return out;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
NT.AI._cdist = function (e, cx, cy) { return NT.dist(e.x / NT.TILE, e.y / NT.TILE, cx, cy); };
NT.AI._order = function (B, type, e, cx, cy) {
  const key = type + '|' + Math.round(cx) + '|' + Math.round(cy);
  const b = B.batch[key] || (B.batch[key] = { type: type, cx: Math.round(cx), cy: Math.round(cy), ids: [] });
  b.ids.push(e.id);
};
NT.AI._flush = function (world, B) {
  const T = NT.TILE;
  for (const key in B.batch) {
    const b = B.batch[key];
    if (b.ids.length) NT.cmd(world, B.pid, { type: b.type, ids: b.ids, x: (b.cx + 0.5) * T, y: (b.cy + 0.5) * T });
  }
  B.batch = {};
};
// is the unit idle (no order, standing)?
NT.AI._idle = function (e) { return !e.order && !e.queue.length; };
// the cell an order of this unit heads for (null = none)
NT.AI._dest = function (e) { const o = e.order; return o && (o.type === 'amove' || o.type === 'move') ? o : null; };
NT.AI._value = function (list) { let v = 0; for (const e of list) v += e.def.cost; return v; };
NT.AI._centroid = function (list, out) {
  let sx = 0, sy = 0, n = 0;
  for (const e of list) { if (e.layer === 'air' && list.length > 1) continue; sx += e.x; sy += e.y; n++; }
  if (!n) for (const e of list) { sx += e.x; sy += e.y; n++; }
  out.cx = n ? sx / n / NT.TILE : 0; out.cy = n ? sy / n / NT.TILE : 0;
  return out;
};
// nearest walkable cell to (cx, cy) inside the static region `region` (0 = any)
NT.AI._walk = function (world, cx, cy, region) {
  const at = NT.spiral(Math.round(cx), Math.round(cy), 14, function (x, y) {
    if (!NT.Map.passable(world.map, x, y)) return false;
    return !region || NT.Path.region(world, x, y) === region;
  });
  return at ? { cx: at[0], cy: at[1] } : { cx: Math.round(cx), cy: Math.round(cy) };
};
NT.AI._homeRegion = function (world, B) {
  const k = B.k, b = k.hq || k.myB[0];
  if (!b) return 0;
  const ring = NT.ringCells(world, b, B.tmp);
  for (const i of ring) { const r = NT.Path.region(world, i % world.w, (i - i % world.w) / world.w); if (r) return r; }
  return 0;
};

// ---------------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------------
NT.AI._myDrops = function (B) {
  const out = [];
  for (const b of B.k.myB) if (b.def.traits.dropoff) out.push(b);
  return out;
};
NT.AI._served = function (f, drops) {
  for (const d of drops) if (NT.AI._cdist(d, f.cx, f.cy) <= NT.AI.SERVE) return true;
  return false;
};

NT.AI._economy = function (world, B, p) {
  const A = NT.AI, k = B.k, fields = A._fields(world), drops = A._myDrops(B), T = NT.TILE;
  for (const f of fields) A._fieldLeft(world, f);
  // where harvesters should work: the richest served field nearest my base
  let work = null, wd = Infinity;
  for (const f of fields) {
    if (f.left < NT.Econ.MIN_CELL * 2 || !A._served(f, drops)) continue;
    const d = NT.dist(f.cx, f.cy, k.base.cx, k.base.cy) - Math.min(f.left, 6000) / 600;
    if (d < wd) { wd = d; work = f; }
  }
  for (const h of k.harv) {
    if (h.order || h.queue.length) continue;
    if (h.hstate === NT.Econ.PARKED || world.tick >= h.htimer) {
      const f = work || A._nearestField(world, fields, h.x / T, h.y / T, 1);
      if (f) NT.cmd(world, B.pid, { type: 'harvest', ids: [h.id], x: f.cx * T, y: f.cy * T });
    }
  }
  // the field the next drop-off should go to
  B.expand = null;
  const dropDefs = A._info(world, p.faction).role.dropoff;
  if (!dropDefs || !dropDefs.length) return;
  let richServed = 0;
  for (const f of fields) if (f.left >= A.RICH && A._served(f, drops)) richServed++;
  const perDrop = B.hint.harvesters || 3;
  const want = drops.length === 0 || (drops.length < B.lv.maxDrop &&
    (richServed === 0 || p.credits > 2500 || (k.harv.length >= perDrop * drops.length - 1 && world.tick > 5 * A.MIN)));
  if (!want) return;
  let best = null, bd = Infinity;
  for (const f of fields) {
    if (f.left < A.RICH || A._served(f, drops)) continue;
    const dMe = NT.dist(f.cx, f.cy, k.base.cx, k.base.cy), dFoe = k.foe ? NT.dist(f.cx, f.cy, k.foe.cx, k.foe.cy) : 999;
    if (drops.length && dFoe < dMe * 0.8) continue;                       // the enemy's back yard
    const d = dMe + (dFoe < dMe ? 10 : 0);
    if (d < bd) { bd = d; best = f; }
  }
  B.expand = best;
};
NT.AI._nearestField = function (world, fields, cx, cy, minLeft) {
  let best = null, bd = Infinity;
  for (const f of fields) {
    if (f.left < minLeft) continue;
    const d = NT.dist(f.cx, f.cy, cx, cy);
    if (d < bd) { bd = d; best = f; }
  }
  return best;
};

// ---------------------------------------------------------------------------
// Build: placement + the want-list
// ---------------------------------------------------------------------------
NT.AI._powerShort = function (p, extra) { return p.power.made - p.power.used - extra < 10; };

NT.AI._placeAt = function (world, B, p, def) {
  const A = NT.AI, k = B.k, P = NT.Prod, base = k.base, foe = k.foe;
  if (def.traits.dropoff) {
    const f = B.expand || A._nearestField(world, A._fields(world), base.cx, base.cy, A.RICH) || A._nearestField(world, A._fields(world), base.cx, base.cy, 1);
    if (f) {
      const s = P.findPlace(world, p, def, f.cx, f.cy, { maxR: 9, avoidRes: true }) || P.findPlace(world, p, def, f.cx, f.cy, { maxR: 12 });
      if (s && (def.placement !== 'free' || NT.dist(s[0] + def.size[0] / 2, s[1] + def.size[1] / 2, f.cx, f.cy) < 11)) return s;
      if (def.placement === 'free') { A._scoutTo(world, B, f.cx, f.cy); return null; }
    }
  }
  if (def.role === 'defense') {
    const guard = A._guardPoint(world, B);
    const s = P.findPlace(world, p, def, guard.cx, guard.cy, { maxR: 6, gap: 1, avoidRes: true }) || P.findPlace(world, p, def, guard.cx, guard.cy, { maxR: 10, avoidRes: true });
    if (s) return s;
  }
  // compact base around the HQ, nudged away from the enemy; 1-cell lanes
  const dx = foe ? foe.cx - base.cx : 0, dy = foe ? foe.cy - base.cy : 0, dl = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const nx = base.cx - dx / dl * 2, ny = base.cy - dy / dl * 2;
  return P.findPlace(world, p, def, nx, ny, { maxR: 16, gap: 1, avoidRes: true }) ||
         P.findPlace(world, p, def, nx, ny, { maxR: 20, avoidRes: true }) ||
         P.findPlace(world, p, def, nx, ny, { maxR: 26 });
};

// Where a defence goes: beside something worth protecting (drop-off, power, HQ), on the side facing the enemy.
NT.AI._guardPoint = function (world, B) {
  const k = B.k, foe = k.foe, n = k.defs;
  const worth = [];
  for (const b of k.myB) if (b.def.traits.dropoff) worth.push(b);
  if (k.hq) worth.push(k.hq);
  for (const b of k.myB) if (b.def.role === 'power') worth.push(b);
  if (!worth.length) return k.base;
  const b = worth[n % worth.length], bx = b.x / NT.TILE, by = b.y / NT.TILE;
  const dx = foe.cx - bx, dy = foe.cy - by, dl = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const r = Math.max(b.w, b.h) / 2 + 2;
  const side = (n % 3 - 1) * 2;                          // fan out along the front
  return { cx: bx + dx / dl * r - dy / dl * side, cy: by + dy / dl * r + dx / dl * side };
};

NT.AI._scoutTo = function (world, B, cx, cy) {
  const k = B.k, A = NT.AI;
  let s = B.scout ? world.byId.get(B.scout) : null;
  if (s && (!s.alive || s.owner !== B.pid)) s = null;
  if (!s) {
    let bd = Infinity;
    for (const e of k.army) {
      if (B.role[e.id] !== 'idle') continue;
      const d = A._cdist(e, cx, cy) / Math.max(0.5, e.def.move.speed);
      if (d < bd) { bd = d; s = e; }
    }
    if (!s) return;
    B.scout = s.id;
  }
  B.role[s.id] = 'scout';
  const o = A._dest(s);
  if (!o || NT.dist(o.cx, o.cy, cx, cy) > 3) A._order(B, 'move', s, cx, cy);
};

NT.AI._dropPending = function (world, B, p) {
  const I = NT.AI._info(world, p.faction);
  for (const qid of I.buildQ) {
    const q = p.queues[qid];
    if (q && q.ready && q.ready.traits.dropoff) return true;
    for (let i = 0; q && i < q.items.length; i++) if (q.items[i].def.traits.dropoff) return true;
  }
  return false;
};

NT.AI._ready = function (world, B, p) {
  const A = NT.AI, I = A._info(world, p.faction);
  for (const qid of I.buildQ) {
    const q = p.queues[qid];
    if (!q || !q.ready) continue;
    const def = q.ready, s = A._placeAt(world, B, p, def);
    if (s) {
      NT.cmd(world, B.pid, { type: 'place', def: def.id, cx: s[0], cy: s[1] });
      B.fail[def.id] = 0; B.stats.placed++;
      if (def.traits.dropoff && A._myDrops(B).length) B.stats.expansions++;
      continue;
    }
    B.fail[def.id] = (B.fail[def.id] || 0) + 1;
    if (B.fail[def.id] > (def.placement === 'free' ? 60 : 8)) {             // give the spot up: refund, try later
      NT.cmd(world, B.pid, { type: 'cancel', def: def.id });
      B.blocked[def.id] = world.tick + 2 * A.MIN; B.fail[def.id] = 0; B.stats.cancels++;
    }
  }
};

// The want-list: [{def, n}] = "have (alive + queued + ready) at least n of def", in priority order.
NT.AI._wants = function (world, B, p) {
  const A = NT.AI, I = A._info(world, p.faction), k = B.k, lv = B.lv, out = [], R = I.role, tick = world.tick;
  const have = function (d) { return NT.Prod.count(world, p, d); };
  const add = function (d, n) { if (d && have(d) < n) out.push({ def: d, n: n }); };
  const cheapest = function (list) { return list && list.length ? list[0] : null; };
  const power = cheapest(R.power);
  const nRole = function (r) { let n = 0; for (const d of (R[r] || [])) n += have(d); return n; };
  if (power && nRole('power') === 0) add(power, 1);
  // opening hints
  const op = B.hint.opening, seen = {};
  if (op && tick < 8 * A.MIN) for (const key of op) {
    const d = p.faction.buildings[key];
    if (!d) continue;
    seen[key] = (seen[key] || 0) + 1;
    add(d, seen[key]);
  }
  const drop = cheapest(R.dropoff);
  if (drop && nRole('dropoff') === 0) add(drop, 1);
  for (const qid of I.unitQ) if (!NT.Prod.producers(world, p, qid) && I.prods[qid]) add(I.prods[qid][0], 1);
  if (R.radar && nRole('radar') === 0) add(cheapest(R.radar), 1);
  const army = k.armyValue + (p.credits > 2000 ? 1000 : 0);
  if (R.defense && army > 300 && nRole('defense') < lv.defences) {
    const d = A._pickDefense(world, B, p, nRole('defense') === lv.defences - 1);
    if (d) add(d, nRole('defense') + 1);
  }
  if (B.expand && drop) add(drop, nRole('dropoff') + 1);
  if (R.tech && (army > 1200 || tick > 8 * A.MIN)) for (const d of R.tech) add(d, 1);
  if (R.super && (army > 2000 || tick > 11 * A.MIN) && nRole('tech') > 0) for (const d of R.super) add(d, 1);
  if (R.defense && p.credits > 1500 && nRole('defense') < lv.defences + lv.lateDefences) add(A._pickDefense(world, B, p), nRole('defense') + 1);
  if (p.credits > 2000) {
    for (const qid of I.unitQ) {
      const n = NT.Prod.producers(world, p, qid), d = I.prods[qid] && I.prods[qid][0];
      if (d && n < lv.producers && n > 0) { add(d, have(d) + 1); break; }
    }
  }
  return out;
};

// Defence mix: the def whose damage profile best covers what the enemy fields and my defences do not cover yet.
// profile = what a def is best at (infantry / armour / air, normalised over the faction's defences). `mix`: the
// pick must have a profile none of my defences has; if no such def can be built yet it returns null (wait for it).
NT.AI._profile = function (d, maxE) {
  const A = NT.AI, v = [A._eff(d, 0) / (maxE[0] || 1), Math.max(A._eff(d, 1), A._eff(d, 2)) / (maxE[1] || 1), A._eff(d, 3) / (maxE[3] || 1)];
  return v[0] >= v[1] && v[0] >= v[2] ? 0 : v[1] >= v[2] ? 1 : 2;
};
NT.AI._pickDefense = function (world, B, p, mix) {
  const A = NT.AI, I = A._info(world, p.faction), list = I.role.defense, foe = A._mix(world, B, [0, 0, 0, 0]);
  if (!list || !list.length) return null;
  const cover = [0, 0, 0, 0], E = function (d, c) { return A._eff(d, c); };
  const maxE = [0, 0, 0, 0];
  for (const d of list) for (let c = 0; c < 4; c++) maxE[c] = Math.max(maxE[c], E(d, c));
  maxE[1] = Math.max(maxE[1], maxE[2]);
  const have = [false, false, false];
  for (const b of B.k.myB) if (b.def.role === 'defense') {
    have[A._profile(b.def, maxE)] = true;
    for (let c = 0; c < 4; c++) cover[c] += maxE[c] ? E(b.def, c) / maxE[c] : 0;
  }
  let best = null, bs = -1, other = false;
  for (const d of list) {
    if (B.blocked[d.id] > world.tick) continue;
    if (mix && have[A._profile(d, maxE)]) continue;
    other = true;
    const ok = NT.Prod.canProduce(world, p, d).ok;
    if (mix && !ok && !NT.AI._resolve(world, B, p, d, 0)) continue;
    let s = 0;
    for (let c = 0; c < 4; c++) if (maxE[c]) s += (foe[c] + 0.1) * (E(d, c) / maxE[c]) / (1 + cover[c]);
    s = s / Math.sqrt(d.cost) * (ok ? 1 : 0.5);
    if (s > bs) { bs = s; best = d; }
  }
  if (mix && !best && !other) return A._pickDefense(world, B, p, false);   // one profile is all the faction has
  return best;
};

// First producible def for a want: the def itself, else (recursively) a missing prerequisite / producer.
NT.AI._resolve = function (world, B, p, def, depth) {
  if (!def || depth > 5 || B.blocked[def.id] > world.tick) return null;
  const why = NT.Prod.canProduce(world, p, def).reason;
  if (why === 'ok') return def;
  if (why === 'prereq') {
    for (const r of def.requires) {
      if (p.owned[r] > 0) continue;
      const rd = NT.DEFS[r];
      if (NT.Prod.count(world, p, rd) > 0) return null;                     // already on its way
      const got = NT.AI._resolve(world, B, p, rd, depth + 1);
      if (got) return got;
    }
    return null;
  }
  if (why === 'producer') {
    const I = NT.AI._info(world, p.faction), pr = I.prods[def.queue];
    if (!pr) return null;
    for (const d of pr) if (NT.Prod.count(world, p, d) > 0) return null;
    return NT.AI._resolve(world, B, p, pr[0], depth + 1);
  }
  return null;
};

NT.AI._build = function (world, B, p) {
  const A = NT.AI, I = A._info(world, p.faction);
  A._ready(world, B, p);
  const wants = A._wants(world, B, p), busy = {};
  for (const qid of I.buildQ) { const q = p.queues[qid]; busy[qid] = !q || q.ready || q.items.length > 0; }
  const power = I.role.power && I.role.power[0];
  for (const w of wants) {
    let d = A._resolve(world, B, p, w.def, 0);
    if (!d || busy[d.queue]) continue;
    if (d.power < 0 && power && A._powerShort(p, -d.power)) {             // keep power positive with headroom
      d = A._resolve(world, B, p, power, 0);
      if (!d || busy[d.queue]) continue;
    }
    NT.cmd(world, B.pid, { type: 'produce', def: d.id });
    busy[d.queue] = true;
  }
  // plain power top-up whenever the margin is thin
  if (power && A._powerShort(p, 20)) {
    const d = A._resolve(world, B, p, power, 0);
    if (d && !busy[d.queue]) { NT.cmd(world, B.pid, { type: 'produce', def: d.id }); busy[d.queue] = true; }
  }
};

// ---------------------------------------------------------------------------
// Army production
// ---------------------------------------------------------------------------
NT.AI._queued = function (p, qid, def) {
  const q = p.queues[qid];
  let n = 0;
  for (let i = 0; i < q.items.length; i++) if (q.items[i].def === def) n++;
  return n;
};

NT.AI._army = function (world, B, p) {
  const A = NT.AI, I = A._info(world, p.faction), k = B.k, lv = B.lv;
  const drops = A._myDrops(B).length;
  const perDrop = B.hint.harvesters || 3;
  const harvWant = Math.min(lv.harvesters, Math.max(1, drops) * perDrop);
  const mix = A._mix(world, B, [0, 0, 0, 0]);
  const structBusy = I.buildQ.some(function (q) { return p.queues[q] && p.queues[q].items.length; });
  const fight = A._fighters(world, B, p, mix);
  for (const qid of I.unitQ) {
    const q = p.queues[qid];
    if (!q || !NT.Prod.producers(world, p, qid)) continue;
    const depth = p.credits > 400 || !structBusy ? lv.depth : 1;
    if (q.items.length >= depth) continue;
    let d = A._special(world, B, p, qid, harvWant);
    if (!d) {
      let best = null;
      for (const c of fight) if (c.def.queue === qid && (!best || c.s > best.s)) best = c;
      if (best) d = best.def;
    }
    if (d) NT.cmd(world, B.pid, { type: 'produce', def: d.id });
  }
};

NT.AI._ok = function (world, B, p, def) { return NT.Prod.canProduce(world, p, def).ok && !(B.blocked[def.id] > world.tick); };

// Non-fighters a queue should make first: harvesters to target, a capturer, healers, single-use units.
NT.AI._special = function (world, B, p, qid, harvWant) {
  const A = NT.AI, I = A._info(world, p.faction), k = B.k, tick = world.tick;
  const ok = function (u) { return u.def.queue === qid && A._ok(world, B, p, u.def); };
  let harvN = 0, healN = 0, consN = 0, captN = 0;
  for (const u of I.units) {
    const n = NT.Prod.count(world, p, u.def);
    if (u.job === 'harvester') harvN += n;
    else if (u.job === 'healer') healN += n;
    else if (u.job === 'consume') consN += n;
    if (u.def.traits.capturer && (u.job === 'capturer' || u.job === 'healer')) captN += n;
  }
  if (B.capt && world.byId.get(B.capt)) captN++;
  const siege = B.defending && k.foeArmy > k.armyValue;                     // under real pressure: fighters first
  if (harvN < harvWant && (!siege || harvN === 0)) for (const u of I.units) if (u.job === 'harvester' && ok(u)) return u.def;
  if (captN === 0 && !siege && tick >= B.captAt && A._captureTarget(world, B, p)) {
    let best = null;
    for (const u of I.units) if (u.def.traits.capturer && ok(u) && (!best || u.def.cost < best.cost)) best = u.def;
    if (best) { B.captAt = tick + A.MIN; return best; }
  }
  if (healN < Math.floor(k.army.length / 8)) for (const u of I.units) if (u.job === 'healer' && ok(u)) return u.def;
  if (consN < 2 && k.army.length >= 6) for (const u of I.units) if (u.job === 'consume' && ok(u) && B.rng.chance(0.35)) return u.def;
  return null;
};

// Every fighter def I could queue now, scored by weighted deficit: s = weight / (value I have + its cost).
NT.AI._fighters = function (world, B, p, mix) {
  const A = NT.AI, I = A._info(world, p.faction), k = B.k, hw = B.hint.army, out = [];
  let aa = 0, siege = 0, total = 0;
  for (const e of k.army) { total += e.def.cost; if (e.def.weapons.some(function (w) { return w.air && !w.heal; })) aa += e.def.cost; if (e.def.is.siege) siege += e.def.cost; }
  const needAA = B.foeAir > 0 && aa < B.foeAir * 0.8;
  for (const u of I.units) {
    const d = u.def;
    if (u.job !== 'army' || !A._ok(world, B, p, d)) continue;
    if (d.cost > p.credits + 1500 && d.cost > 500) continue;                  // cannot afford it soon
    let w;
    if (hw) w = hw[d.key] || 0;
    else {
      w = d.tier >= 3 ? 1.5 : d.tier === 2 ? 1.3 : 1;
      if (d.is.siege) w *= 0.6;
      if (d.is.scout) w *= 0.7;
      if (d.limit > 0) w *= 2;
    }
    if (w <= 0) continue;
    let fit = 0;
    for (let c = 0; c < 4; c++) if (I.maxEff[c]) fit += mix[c] * u.eff[c] / I.maxEff[c];
    if (I.maxEff[4]) fit = fit * 0.8 + 0.2 * u.eff[4] / I.maxEff[4];       // a share of every war is breaking structures
    w *= 0.35 + 1.3 * fit;
    if (needAA && u.eff[3] > 0) w *= 3;
    if (d.is.siege && siege > total * 0.25) w *= 0.2;
    let have = 0;
    for (const e of k.army) if (e.def === d) have += d.cost;
    have += A._queued(p, d.queue, d) * d.cost;
    out.push({ def: d, s: w / (have + d.cost) * (1 + 0.15 * B.rng.next()) });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Army control
// ---------------------------------------------------------------------------
NT.AI._rallyPoint = function (world, B) {
  const A = NT.AI, k = B.k, base = k.base, foe = k.foe, region = A._homeRegion(world, B);
  const dx = foe.cx - base.cx, dy = foe.cy - base.cy, dl = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const r = Math.min(10, dl * 0.25);
  return A._walk(world, base.cx + dx / dl * r, base.cy + dy / dl * r, region);
};

NT.AI._control = function (world, B, p) {
  const A = NT.AI, k = B.k, T = NT.TILE;
  if (!B.rally || B.stats.thinks % 10 === 0) B.rally = A._rallyPoint(world, B);
  // producers send new units to the rally point
  const I = A._info(world, p.faction);
  for (const b of k.myB) {
    const pr = b.def.traits.producer;
    if (!pr || !pr.queues.some(function (q) { return I.unitQ.indexOf(q) >= 0; })) continue;
    if (b.rally && NT.cellOf(b.rally.x) === B.rally.cx && NT.cellOf(b.rally.y) === B.rally.cy) continue;
    NT.cmd(world, B.pid, { type: 'rally', id: b.id, x: (B.rally.cx + 0.5) * T, y: (B.rally.cy + 0.5) * T });
  }
  if (B.scout && !A._dropPending(world, B, p)) { if (B.role[B.scout] === 'scout') B.role[B.scout] = 'idle'; B.scout = 0; }
  A._defend(world, B, p);
  A._waves(world, B, p);
  if (B.lv.harass) A._harass(world, B, p);
  A._capture(world, B, p);
  A._support(world, B, p);
  A._deployers(world, B, p);
  // idle units that drifted away (chases, finished orders) walk back to the rally point
  for (const e of k.army) {
    if (B.role[e.id] !== 'idle' || !A._idle(e) || e.target) continue;
    if (A._cdist(e, B.rally.cx, B.rally.cy) > 7) A._order(B, 'amove', e, B.rally.cx, B.rally.cy);
  }
};

// Defence: enemies seen near my structures or harvesters, and whoever hurt them lately (lastHurt / lastHurtBy:
// shells landing from out of sight still give the attacker away, as they would to a human watching).
NT.AI.HURT = 3 * NT.TPS;
NT.AI._defend = function (world, B, p) {
  const A = NT.AI, k = B.k, T = NT.TILE, tick = world.tick;
  let tv = 0, best = null, bd = Infinity;
  const take = function (u) {
    tv += u.def.cost;
    const d = A._cdist(u, k.base.cx, k.base.cy);
    if (d < bd) { bd = d; best = u; }
  };
  for (const u of k.foeU) {
    if (!NT.Combat.armed(u.def) && !u.def.traits.capturer) continue;
    let near = Infinity;
    for (const b of k.myB) { const d = NT.distTo(u.x, u.y, b) / T; if (d < near) near = d; }
    for (const h of k.harv) { const d = NT.dist(u.x, u.y, h.x, h.y) / T; if (d < near && d < 6) near = d; }
    if (near <= A.DEF_R) take(u);
  }
  const unseen = [];
  const hurt = function (e) {
    if (tick - e.lastHurt > A.HURT) return;
    const u = world.byId.get(e.lastHurtBy);
    if (!u || !u.alive || u.kind !== 'unit' || !NT.isEnemy(world, B.pid, u.owner) || NT.Fog.canSee(world, p.team, u) || unseen.indexOf(u) >= 0) return;
    unseen.push(u); take(u);
  };
  for (const b of k.myB) hurt(b);
  for (const h of k.harv) hurt(h);
  const pool = [];
  if (!tv) {
    if (B.defending) {
      for (const e of k.army) if (B.role[e.id] === 'def') { B.role[e.id] = 'idle'; A._order(B, 'amove', e, B.rally.cx, B.rally.cy); }
      B.defending = false;
    }
    return;
  }
  if (!B.defending) B.stats.defends++;
  B.defending = true;
  const px = best.x / T, py = best.y / T;
  const waveHome = !!B.wave && NT.dist(B.wave.c.cx, B.wave.c.cy, k.base.cx, k.base.cy) < 18;
  for (const e of k.army) {
    const r = B.role[e.id];
    if (r === 'idle' || r === 'def' || (r === 'wave' && waveHome)) pool.push(e);
  }
  pool.sort(function (a, b) { return A._cdist(a, px, py) - A._cdist(b, px, py) || a.id - b.id; });
  let sent = 0;
  const need = tv * 1.5 + 300;
  for (const e of pool) {
    if (sent >= need) break;
    sent += e.def.cost;
    if (B.role[e.id] === 'wave') A._leaveWave(B, e);
    B.role[e.id] = 'def';
    const o = A._dest(e);
    if (e.target && NT.Combat.bears(world, e, world.byId.get(e.target) || e)) continue;
    if (e.def.traits.brace && A._idle(e) && A._cdist(e, px, py) < A.HALT) continue;
    if (!o || o.type !== 'amove' || NT.dist(o.cx, o.cy, px, py) > 5) A._order(B, 'amove', e, px, py);
  }
  A._halt(world, B, pool);
};

NT.AI._leaveWave = function (B, e) {
  if (!B.wave) return;
  const i = B.wave.ids.indexOf(e.id);
  if (i >= 0) { B.wave.ids.splice(i, 1); B.wave.start -= e.def.cost; }
};

// Units that brace fight far better standing: when armed enemies come within HALT cells, a moving one stops and digs
// in instead of walking into them (its own scan still picks the targets).
NT.AI.HALT = 8;
NT.AI._halt = function (world, B, list) {
  const A = NT.AI, k = B.k, T = NT.TILE, r2 = A.HALT * A.HALT * T * T, ids = [];
  for (const e of list) {
    if (!e.def.traits.brace || !e.order || (e.order.type !== 'amove' && e.order.type !== 'move') || e.layer === 'air') continue;
    for (const u of k.foeU) {
      if (u.kind !== 'unit' || !NT.Combat.armed(u.def) || NT.dist2(e.x, e.y, u.x, u.y) > r2) continue;
      ids.push(e.id); break;
    }
  }
  if (ids.length) NT.cmd(world, B.pid, { type: 'stop', ids: ids });
  return ids.length;
};

// Attack waves.
NT.AI._threshold = function (world, B) {
  const lv = B.lv, mul = B.hint.attackAt || 1;
  return Math.min(lv.waveMax, lv.firstWave + B.waves * lv.waveGrow) * mul;
};

NT.AI._pickTarget = function (world, B, cx, cy) {
  const A = NT.AI, k = B.k;
  let best = null, bs = -1;
  for (const b of k.foeB) {
    if (!b.alive || b.def.role === 'turf') continue;
    const w = A.ROLE_W[b.def.role] || 1;
    const s = w / (10 + A._cdist(b, cx, cy));
    if (s > bs) { bs = s; best = b; }
  }
  return best;
};

NT.AI._waves = function (world, B, p) {
  const A = NT.AI, k = B.k, lv = B.lv, tick = world.tick, T = NT.TILE;
  const allIn = tick > lv.allIn * A.MIN;
  const thr = A._threshold(world, B) * (allIn ? 0.5 : 1);
  // gathered idle army
  const idle = [];
  let gv = 0;
  for (const e of k.army) if (B.role[e.id] === 'idle') { idle.push(e); if (A._cdist(e, B.rally.cx, B.rally.cy) < 12) gv += e.def.cost; }
  if (!B.wave) {
    const late = tick - B.lastWave > 5 * A.MIN && gv >= thr * 0.5;
    const strong = gv >= thr && gv >= B.foeSeen * 1.1;
    if (idle.length && (strong || late || (allIn && gv >= thr * 0.4))) {
      const c = A._centroid(idle, {}), t = A._pickTarget(world, B, c.cx, c.cy);
      if (!t) return;
      B.wave = { ids: idle.map(function (e) { return e.id; }), units: idle, target: t.id, start: A._value(idle), c: c };
      B.waves++; B.lastWave = tick; B.stats.waves++;
      for (const e of idle) { B.role[e.id] = 'wave'; A._order(B, 'amove', e, t.x / T, t.y / T); }
    }
    return;
  }
  const W = B.wave, units = [];
  for (const id of W.ids) { const e = world.byId.get(id); if (e && e.alive && e.owner === B.pid) { units.push(e); B.role[e.id] = 'wave'; } }
  W.ids = units.map(function (e) { return e.id; }); W.units = units;
  const v = A._value(units);
  if (!units.length || v < W.start * lv.retreat) {
    for (const e of units) { B.role[e.id] = 'idle'; A._order(B, 'move', e, B.rally.cx, B.rally.cy); }
    if (units.length) B.stats.retreats++;
    B.wave = null; B.lastWave = tick;
    return;
  }
  A._centroid(units, W.c);
  let t = world.byId.get(W.target);
  if (!t || !t.alive || !NT.isEnemy(world, B.pid, t.owner)) {
    t = A._pickTarget(world, B, W.c.cx, W.c.cy);
    if (!t) { for (const e of units) B.role[e.id] = 'idle'; B.wave = null; return; }
    W.target = t.id;
    for (const e of units) if (!e.def.is.siege) A._order(B, 'amove', e, t.x / T, t.y / T);
  }
  // reinforcements from the rally point
  if (gv >= thr * 0.5 && v >= W.start * 0.4) {
    for (const e of idle) { B.role[e.id] = 'wave'; W.ids.push(e.id); A._order(B, 'amove', e, t.x / T, t.y / T); }
  }
  const seen = NT.Fog.canSee(world, p.team, t), tx = t.x / T, ty = t.y / T, hit = [];
  // the main body: idle stragglers get the target again; siege trails the body
  const front = { cx: 0, cy: 0 }, body = units.filter(function (e) { return !e.def.is.siege; });
  A._centroid(body.length ? body : units, front);
  for (const e of units) {
    if (e.def.is.siege && body.length) {
      const o = A._dest(e), bx = front.cx + (k.base.cx - front.cx) * 0.1, by = front.cy + (k.base.cy - front.cy) * 0.1;
      if (A._idle(e) && !e.target ? A._cdist(e, bx, by) > 4 : o && NT.dist(o.cx, o.cy, bx, by) > 6) A._order(B, 'amove', e, bx, by);
      continue;
    }
    if (!A._idle(e) || e.target) continue;
    if (e.def.traits.brace && A._contact(B, e)) continue;                    // dug in with enemies around
    if (seen && A._cdist(e, tx, ty) < 8) hit.push(e.id);
    else A._order(B, 'amove', e, tx, ty);
  }
  if (hit.length) NT.cmd(world, B.pid, { type: 'attack', ids: hit, target: t.id });
  A._halt(world, B, units);
};
NT.AI._contact = function (B, e) {
  const T = NT.TILE, r2 = NT.AI.HALT * NT.AI.HALT * T * T;
  for (const u of B.k.foeU) if (u.kind === 'unit' && NT.Combat.armed(u.def) && NT.dist2(e.x, e.y, u.x, u.y) <= r2) return true;
  return false;
};

// Harass (hard): a few fast units hunt harvesters.
NT.AI._harass = function (world, B, p) {
  const A = NT.AI, k = B.k, T = NT.TILE, tick = world.tick;
  let grp = B.harass.map(function (id) { return world.byId.get(id); }).filter(function (e) { return e && e.alive; });
  if (!grp.length && tick >= B.harassAt && k.army.length >= 8) {
    const fast = k.army.filter(function (e) { return B.role[e.id] === 'idle' && e.layer === 'ground' && (e.def.is.scout || e.def.move.speed >= 3.4); });
    fast.sort(function (a, b) { return b.def.move.speed - a.def.move.speed || a.id - b.id; });
    grp = fast.slice(0, 3);
    if (grp.length >= 2) { B.harassAt = tick + 3 * A.MIN; B.stats.harass++; } else grp = [];
  }
  B.harass = grp.map(function (e) { return e.id; });
  if (!grp.length) return;
  for (const e of grp) B.role[e.id] = 'harass';
  let prey = null, pd = Infinity;
  const c = A._centroid(grp, {});
  for (const u of k.foeU) if (u.def.traits.harvester) { const d = A._cdist(u, c.cx, c.cy); if (d < pd) { pd = d; prey = u; } }
  if (prey) { for (const e of grp) if (e.target !== prey.id) NT.cmd(world, B.pid, { type: 'attack', ids: [e.id], target: prey.id }); return; }
  let goal = null, gd = Infinity;
  for (const b of k.foeB) if (b.def.traits.dropoff) { const d = A._cdist(b, c.cx, c.cy); if (d < gd) { gd = d; goal = b; } }
  if (!goal) return;
  for (const e of grp) if (A._idle(e) && !e.target) A._order(B, 'amove', e, goal.x / T, goal.y / T + 2);
};

// Capture: one capturer claims the nearest turf not held by my team.
NT.AI._captureTarget = function (world, B, p) {
  const A = NT.AI, k = B.k;
  let best = null, bs = Infinity;
  for (const e of world.ents) {
    if (!e.alive || e.kind !== 'building' || !e.def.traits.capturable) continue;
    if (e.owner >= 0 && (NT.isAlly(world, p.id, e.owner) || !B.lv.recapture)) continue;
    const dMe = A._cdist(e, k.base.cx, k.base.cy), dFoe = NT.dist(e.x / NT.TILE, e.y / NT.TILE, k.foe.cx, k.foe.cy);
    if (dFoe < dMe * 0.7 && e.owner < 0) continue;                           // deep in enemy land
    let guard = 0;
    for (const u of k.foeU) if (NT.Combat.armed(u.def) && NT.distTo(u.x, u.y, e) < 6 * NT.TILE) guard += u.def.cost;
    if (guard > 300) continue;                                               // wait for the army
    const s = dMe + (dFoe < dMe ? 12 : 0) - (e.def.traits.income ? e.def.traits.income.amount / 6 : 0);
    if (s < bs) { bs = s; best = e; }
  }
  return best;
};

NT.AI._capture = function (world, B, p) {
  const A = NT.AI, k = B.k, T = NT.TILE;
  let c = B.capt ? world.byId.get(B.capt) : null;
  if (c && (!c.alive || c.owner !== B.pid)) c = null;
  if (!c && B.capt) {                                     // lost one: wait longer before the next try
    B.captLost++;
    B.captAt = Math.max(B.captAt, world.tick + Math.min(4, 1 + B.captLost) * A.MIN);
  }
  if (!c) {
    B.capt = 0;
    if (world.tick < B.captAt) return;                    // still waiting after a loss
    for (const e of k.capt) if (!B.capt) B.capt = e.id;
    for (const e of k.heal) if (!B.capt && e.def.traits.capturer) B.capt = e.id;
    if (!B.capt) {                                        // an armed capturer standing idle
      for (const e of k.army) if (e.def.traits.capturer && B.role[e.id] === 'idle') { B.capt = e.id; break; }
    }
    c = B.capt ? world.byId.get(B.capt) : null;
    if (!c) return;
  }
  B.role[c.id] = 'capt';
  const t = A._captureTarget(world, B, p);
  if (!t) { if (A._idle(c) && A._cdist(c, B.rally.cx, B.rally.cy) > 5) A._order(B, 'move', c, B.rally.cx, B.rally.cy); return; }
  if (c.order && c.order.type === 'enter' && c.order.target === t.id) return;
  if (NT.Fog.canSee(world, p.team, t)) {
    NT.cmd(world, B.pid, { type: 'enter', ids: [c.id], target: t.id });
    if (B.captT !== t.id) { B.captT = t.id; B.stats.captureOrders++; }
    return;
  }
  const o = A._dest(c);
  if (!o || NT.dist(o.cx, o.cy, t.x / T, t.y / T) > 3) A._order(B, 'move', c, t.x / T, t.y / T + t.h / 2 + 1);
};

// Healers follow the army; single-use units dive at the costliest thing they can see.
NT.AI._support = function (world, B, p) {
  const A = NT.AI, k = B.k, T = NT.TILE;
  const follow = B.wave && B.wave.units.length ? B.wave.c : B.rally;
  for (const e of k.heal) {
    if (e.id === B.capt) continue;
    const fx = follow.cx + (k.base.cx - follow.cx) * 0.08, fy = follow.cy + (k.base.cy - follow.cy) * 0.08;
    const o = A._dest(e);
    if (A._cdist(e, fx, fy) > 4 && (!o || NT.dist(o.cx, o.cy, fx, fy) > 4)) A._order(B, 'move', e, fx, fy);
  }
  for (const e of k.cons) {
    if (e.order && e.order.type === 'attack') continue;
    let best = null, bv = 0;
    for (const u of k.foeU) {
      if (A._cdist(u, e.x / T, e.y / T) > 18 || !NT.Combat.valid(world, e, u)) continue;
      if (u.def.cost > bv) { bv = u.def.cost; best = u; }
    }
    for (const b of k.foeB) {
      if (b.def.role === 'turf' || A._cdist(b, e.x / T, e.y / T) > 18 || !NT.Combat.valid(world, e, b)) continue;
      if (b.def.cost * 0.6 > bv) { bv = b.def.cost * 0.6; best = b; }
    }
    if (best && bv >= e.def.cost * 0.8) { NT.cmd(world, B.pid, { type: 'attack', ids: [e.id], target: best.id }); B.stats.dives++; continue; }
    const o = A._dest(e);
    if (A._cdist(e, follow.cx, follow.cy) > 5 && (!o || NT.dist(o.cx, o.cy, follow.cx, follow.cy) > 5)) A._order(B, 'move', e, follow.cx, follow.cy);
  }
};

// A base on wheels (deploy trait): set it up when I have no HQ, else keep it home.
NT.AI._deployers = function (world, B, p) {
  const A = NT.AI, k = B.k;
  for (const e of k.depl) {
    if (!A._idle(e)) continue;
    if (NT.Traits.deploySpot(world, e)) { if (!k.hq) NT.cmd(world, B.pid, { type: 'deploy', ids: [e.id] }); continue; }
    if (A._cdist(e, k.base.cx, k.base.cy) > 6) A._order(B, 'move', e, k.base.cx + B.rng.irange(-6, 6), k.base.cy + B.rng.irange(-6, 6));
  }
};

// ---------------------------------------------------------------------------
// Support powers
// ---------------------------------------------------------------------------
NT.AI._powers = function (world, B, p) {
  const A = NT.AI, k = B.k, T = NT.TILE, st = NT.Powers.state(world, p, B.pstate);
  for (const s of st) {
    if (!s.ready || !s.available) continue;
    const d = s.power, at = A['_pw_' + d.kind] ? A['_pw_' + d.kind](world, B, p, d) : null;
    if (!at || !NT.Powers.canFire(world, p, d, at.x, at.y).ok) continue;
    NT.cmd(world, B.pid, { type: 'power', power: d.id, x: at.x, y: at.y });
    B.stats.powers[d.kind] = (B.stats.powers[d.kind] || 0) + 1;
  }
};
NT.AI._pw_strike = function (world, B, p, d) {
  const A = NT.AI, k = B.k, T = NT.TILE, r = (d.strike.radius || 3) + (d.strike.splash || 1), safe = r + 2;
  let best = null, bs = 900;
  const cands = k.foeU.concat(k.foeB);
  for (const c of cands) {
    if (c.def.role === 'turf') continue;
    const cx = c.x, cy = c.y;
    let v = 0, bad = false;
    for (const e of cands) if (NT.dist(e.x, e.y, cx, cy) <= r * T) v += e.kind === 'building' ? e.def.cost * 0.7 : e.def.cost;
    for (const e of k.myB) if (NT.distTo(cx, cy, e) <= safe * T) { bad = true; break; }
    if (!bad) for (const e of k.myU) if (NT.dist(e.x, e.y, cx, cy) <= safe * T) { bad = true; break; }
    if (!bad && v > bs) { bs = v; best = { x: cx, y: cy }; }
  }
  return best;
};
NT.AI._pw_reveal = function (world, B, p, d) {
  const k = B.k, T = NT.TILE, W = B.wave;
  if (W) {
    const t = world.byId.get(W.target);
    if (t && NT.dist(W.c.cx, W.c.cy, t.x / T, t.y / T) < 16) return { x: t.x, y: t.y };
    return null;
  }
  if (world.tick % (4 * NT.AI.MIN) < B.lv.think) return { x: k.foe.cx * T, y: k.foe.cy * T };
  return null;
};
NT.AI._pw_buff = function (world, B, p, d) {
  const A = NT.AI, k = B.k, T = NT.TILE, a = d.buff, r = a.radius || 4;
  if (a.affects === 'enemies') {
    let best = null, bn = 3;
    for (const u of k.foeU) {
      let n = 0;
      for (const v of k.foeU) if (NT.dist(u.x, u.y, v.x, v.y) <= r * T) n++;
      if (n > bn) { bn = n; best = { x: u.x, y: u.y }; }
    }
    return best;
  }
  const W = B.wave;
  if (!W || W.units.length < 4) return null;
  const cx = W.c.cx * T, cy = W.c.cy * T;
  let mine = 0, foes = 0;
  for (const e of W.units) if (NT.dist(e.x, e.y, cx, cy) <= r * T) mine++;
  for (const u of k.foeU) if (NT.dist(u.x, u.y, cx, cy) <= (r + 6) * T) foes++;
  for (const b of k.foeB) if (NT.distTo(cx, cy, b) <= (r + 4) * T) foes++;
  return mine >= 4 && foes > 0 ? { x: cx, y: cy } : null;
};
NT.AI._pw_spawn = function (world, B, p, d) {
  const A = NT.AI, k = B.k, T = NT.TILE, sd = NT.DEFS[d.spawn.def];
  const cell = function (cx, cy) {
    const at = NT.spiral(cx, cy, 2, function (x, y) {
      return (sd && sd.layer === 'air' ? NT.Map.inBounds(world.map, x, y) : NT.Occ.walkable(world, x, y)) && NT.Fog.visible(world, p.team, x, y);
    });
    return at ? { x: (at[0] + 0.5) * T, y: (at[1] + 0.5) * T } : null;
  };
  for (const u of k.foeU) if (u.def.traits.harvester) { const c = cell(u.cx, u.cy); if (c) return c; }
  let best = null, bs = Infinity;
  for (const b of k.foeB) {
    if (b.def.role === 'turf' || !NT.Fog.canSee(world, p.team, b)) continue;
    let guard = 0;
    for (const u of k.foeU) if (NT.Combat.armed(u.def) && NT.distTo(u.x, u.y, b) < 6 * T) guard += u.def.cost;
    for (const o of k.foeB) if (o.def.role === 'defense' && NT.entDist(o, b) < 6 * T) guard += o.def.cost;
    const s = guard - b.def.cost * 0.3;
    if (s < bs) { const c = cell(b.cx + (b.w >> 1), b.cy + b.h); if (c) { bs = s; best = c; } }
  }
  return best;
};

// ---------------------------------------------------------------------------
// Upkeep
// ---------------------------------------------------------------------------
NT.AI._upkeep = function (world, B, p) {
  if (p.credits < 500) return;
  for (const b of B.k.myB) {
    if (b.repairing || b.hp >= b.maxHp * 0.6 || !b.def.queue) continue;
    NT.cmd(world, B.pid, { type: 'repair', id: b.id, on: true });
    B.stats.repairs++;
  }
};

NT.system('ai', 5, {
  init: function (world) { NT.AI._sys(world); },
  step: NT.AI._tick,
});
