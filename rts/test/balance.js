'use strict';
// NEON TURF — AI-vs-AI balance harness (NOT part of the gate).
//   node rts/test/balance.js [--games N] [--diff normal] [--size medium] [--seeds 1,2,3 | --seed0 S]
//                            [--factions a,b] [--tg] [--max 40] [--fog 0|1] [--jobs J] [--json out.json] [--list]
//                            [--patch '{"curfew.picket":{"hp":75,"w0.dmg":13}}' | --patch file.json]   (try numbers)
// Plays N games per unordered faction pair (alternating start slots, seeds seed0, seed0+1, ...) and prints win
// rates, match lengths, peak army value, credits harvested, units built per def and kills per def.
// Deterministic for a given seed list (each game is a pure function of its seed, factions and slots).
// smoke.js requires this file for runMatch(); the CLI only runs when invoked directly.
const path = require('path');
const { NT, load } = require('./harness');

// One AI-vs-AI match. opts: {factions: [a, b], seed, size, diff ('normal' or [d0, d1]), maxMin, fog, every, onTick}
// onTick(world, stats) runs every `every` ticks (default 200). Returns a plain result object.
function runMatch(opts) {
  const size = opts.size || 'small', seed = opts.seed >>> 0 || 1, maxT = Math.round((opts.maxMin || 40) * 60 * NT.TPS);
  const diff = Array.isArray(opts.diff) ? opts.diff : [opts.diff || 'normal', opts.diff || 'normal'];
  const map = NT.MapGen.generate({ seed: seed, size: size, players: 2 });
  const world = NT.createWorld({ map: map, seed: seed, fog: opts.fog !== false,
    players: [{ faction: opts.factions[0], ai: diff[0] }, { faction: opts.factions[1], ai: diff[1] }] });
  const n = world.players.length, every = opts.every || 200;
  const st = {
    produced: [], kills: [], killsBy: [], dumps: [0, 0], denied: [], peakArmy: [0, 0], peakEnts: 0, hurtFoe: [0, 0],
    firstHit: [-1, -1], placed: [{}, {}], turf: [0, 0], turfN: 0, flips: [0, 0], fired: new Map(),   // fired: produced id -> {owner, def}
  };
  for (let i = 0; i < n; i++) { st.produced.push({}); st.kills.push({}); st.denied.push({}); }
  let ms = 0, steps = 0, maxMs = 0;
  const t0all = Date.now();
  while (!world.over && world.tick < maxT) {
    const t0 = process.hrtime.bigint();
    NT.step(world);
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    ms += dt; steps++; if (dt > maxMs) maxMs = dt;
    const evs = NT.drainEvents(world);
    for (let i = 0; i < evs.length; i++) {
      const ev = evs[i];
      if (ev.t === 'produced') { const pr = st.produced[ev.owner]; if (pr) pr[ev.def] = (pr[ev.def] || 0) + 1; st.fired.set(ev.id, { owner: ev.owner, def: NT.DEFS[ev.def] }); }
      else if (ev.t === 'placed') { const pl = st.placed[ev.owner]; if (pl) pl[ev.def] = (pl[ev.def] || 0) + 1; }
      else if (ev.t === 'captured') { if (ev.to >= 0 && ev.to < 2) st.flips[ev.to]++; }
      else if (ev.t === 'death' && ev.by) {
        const killer = world.byId.get(ev.by) || st.fired.get(ev.by) || null;      // single-use shooters are gone by now
        if (killer && killer.owner >= 0 && killer.owner !== ev.owner && st.kills[killer.owner]) st.kills[killer.owner][killer.def.id] = (st.kills[killer.owner][killer.def.id] || 0) + 1;
      } else if (ev.t === 'dump') { if (ev.owner >= 0 && ev.owner < 2) st.dumps[ev.owner] += ev.amount; }
      else if (ev.t === 'denied') { const d = st.denied[ev.owner]; if (d) d[ev.reason] = (d[ev.reason] || 0) + 1; }
      else if (ev.t === 'hurt') {
        const by = world.byId.get(ev.by);
        if (by && by.owner >= 0 && by.owner !== ev.owner && ev.owner >= 0) { st.hurtFoe[by.owner]++; if (st.firstHit[by.owner] < 0) st.firstHit[by.owner] = world.tick; }
      }
    }
    if (world.tick % 20 === 0) {
      if (world.ents.length > st.peakEnts) st.peakEnts = world.ents.length;
      st.turfN++;
      for (const e of world.ents) if (e.alive && e.kind === 'building' && e.def.role === 'turf' && e.owner >= 0 && e.owner < 2) st.turf[e.owner]++;
      for (let pid = 0; pid < 2; pid++) {
        let v = 0;
        for (const e of world.ents) if (e.alive && e.owner === pid && e.kind === 'unit' && NT.Combat.armed(e.def) && !e.def.traits.harvester) v += e.def.cost;
        if (v > st.peakArmy[pid]) st.peakArmy[pid] = v;
      }
    }
    if (opts.onTick && world.tick % every === 0) opts.onTick(world, st);
  }
  return {
    factions: opts.factions.slice(), seed: seed, size: size, over: world.over,
    winner: world.over ? (world.winner >= 0 ? world.teams[world.winner].players[0] : -1) : -1,
    ticks: world.tick, minutes: world.tick / NT.TPS / 60, avgMs: ms / Math.max(1, steps), maxMs: maxMs, wallMs: Date.now() - t0all,
    income: world.players.map(function (p) { return p.stats.income; }), spent: world.players.map(function (p) { return p.stats.spent; }),
    harvested: st.dumps.slice(), produced: st.produced, kills: st.kills, denied: st.denied, peakArmy: st.peakArmy, peakEnts: st.peakEnts,
    placed: st.placed, hurtFoe: st.hurtFoe, firstHit: st.firstHit, turf: st.turf.map(function (x) { return x / Math.max(1, st.turfN); }), captured: st.flips.slice(),
    brains: [0, 1].map(function (i) { const b = NT.AI.brain(world, i); return b ? Object.assign({}, b.stats) : null; }),
    world: opts.keepWorld ? world : null,
  };
}

// Tuning aid: apply number changes to the loaded defs without editing the faction files.
// patch = { 'faction.key': { hp, cost, speed, sight, 'w0.dmg', 'w0.cooldown', 'w0.range', 'w0.splash', 'traits.brace.delay', ... } }
function applyPatch(patch) {
  const T = NT.TILE;
  for (const id in patch) {
    const d = NT.DEFS[id];
    if (!d) throw new Error('patch: unknown def ' + id);
    for (const key in patch[id]) {
      const v = patch[id][key], parts = key.split('.');
      if (key === 'hp') d.hp = v;
      else if (key === 'cost') {
        if (Math.abs(d.buildTime - Math.max(2, d.cost * NT.RULES.buildSecPerCredit)) < 1e-9) { d.buildTime = Math.max(2, v * NT.RULES.buildSecPerCredit); d.buildTicks = NT.ticks(d.buildTime); }
        d.cost = v;
      } else if (key === 'buildTime') { d.buildTime = v; d.buildTicks = NT.ticks(v); }
      else if (key === 'speed') { d.move.speed = v; d.move.speedPx = v * T / NT.TPS; }
      else if (key === 'sight') { d.sight = v; d.sightPx = v * T; }
      else if (key === 'power') d.power = v;
      else if (parts[0][0] === 'w' && /^w\d+$/.test(parts[0])) {
        const w = d.weapons[+parts[0].slice(1)], f = parts[1];
        if (parts.length > 2) { w[f] = Object.assign({}, w[f]); w[f][parts[2]] = v; continue; }
        w[f] = v;
        if (f === 'cooldown') w.cd = NT.ticks(v);
        if (f === 'range') w.rangePx = v * T;
        if (f === 'minRange') w.minRangePx = v * T;
        if (f === 'splash') w.splashPx = v * T;
        if (f === 'speed') w.speedPx = v * T / NT.TPS;
        w.dps = w.dmg * w.burst / (w.cooldown + (w.burst - 1) * w.burstCd / NT.TPS);
      } else if (parts[0] === 'traits') {
        const t = d.traits[parts[1]], spec = NT.TRAITS[parts[1]];
        if (parts.length > 3) { t[parts[2]] = Object.assign({}, t[parts[2]]); t[parts[2]][parts[3]] = v; continue; }
        t[parts[2]] = v;
        if (spec.time.indexOf(parts[2]) >= 0) t[parts[2] + 'T'] = NT.ticks(v);
        if (spec.dist.indexOf(parts[2]) >= 0) t[parts[2] + 'Px'] = v * T;
      } else throw new Error('patch: unsupported field ' + key);
    }
  }
}

// --------------------------------------------------------------------------------------------------------------
function argv(name, def) { const a = process.argv, i = a.indexOf('--' + name); return i < 0 ? def : a[i + 1]; }
function flag(name) { return process.argv.indexOf('--' + name) >= 0; }

function games(cfg) {
  const out = [];
  const fs = cfg.factions;
  for (let a = 0; a < fs.length; a++) for (let b = a; b < fs.length; b++) {
    if (a === b && !cfg.mirror) continue;
    for (let g = 0; g < cfg.games; g++) {
      const k = a === b ? g : g >> 1;                                     // a mirror has no slots to swap
      const seed = cfg.seeds ? cfg.seeds[k % cfg.seeds.length] + 1000 * Math.floor(k / cfg.seeds.length) : cfg.seed0 + k;
      out.push({ factions: g % 2 ? [fs[b], fs[a]] : [fs[a], fs[b]], seed: seed, size: cfg.size, diff: cfg.diff, maxMin: cfg.max, fog: cfg.fog });
    }
  }
  return out;
}

function summarize(results) {
  const pct = function (a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '-'; };
  const fac = {};
  const F = function (id) { return fac[id] || (fac[id] = { games: 0, wins: 0, draws: 0, peak: 0, harv: 0, income: 0, turf: 0, produced: {}, kills: {}, placed: {}, ai: {}, slotWins: [0, 0], slotGames: [0, 0] }); };
  const lens = [];
  for (const r of results) {
    lens.push(r.minutes);
    for (let i = 0; i < 2; i++) {
      const f = F(r.factions[i]);
      f.games++; f.slotGames[i]++;
      if (r.winner === i) { f.wins++; f.slotWins[i]++; } else if (r.winner < 0) f.draws++;
      f.peak += r.peakArmy[i]; f.harv += r.harvested[i]; f.income += r.income[i] / r.minutes; f.turf += r.turf[i];
      for (const d in r.produced[i]) f.produced[d] = (f.produced[d] || 0) + r.produced[i][d];
      for (const d in r.kills[i]) f.kills[d] = (f.kills[d] || 0) + r.kills[i][d];
      for (const d in r.placed[i]) f.placed[d] = (f.placed[d] || 0) + r.placed[i][d];
      const b = r.brains[i] || {};
      for (const key of ['waves', 'retreats', 'defends', 'captureOrders', 'dives', 'repairs', 'cancels', 'expansions', 'harass']) f.ai[key] = (f.ai[key] || 0) + (b[key] || 0);
      f.ai.turfTaken = (f.ai.turfTaken || 0) + r.captured[i];
      for (const kind in (b.powers || {})) f.ai['power:' + kind] = (f.ai['power:' + kind] || 0) + b.powers[kind];
    }
  }
  lens.sort(function (a, b) { return a - b; });
  const mean = lens.reduce(function (s, x) { return s + x; }, 0) / Math.max(1, lens.length);
  const lines = [];
  lines.push('games: ' + results.length + '   length (sim minutes): mean ' + mean.toFixed(1) + ', median ' + (lens[lens.length >> 1] || 0).toFixed(1) +
    ', min ' + (lens[0] || 0).toFixed(1) + ', max ' + (lens[lens.length - 1] || 0).toFixed(1) +
    '   8-30 min: ' + pct(lens.filter(function (x) { return x >= 8 && x <= 30; }).length, lens.length) +
    '   unfinished: ' + results.filter(function (r) { return !r.over; }).length);
  for (const id in fac) {
    const f = fac[id];
    lines.push('');
    lines.push(id + ': win ' + pct(f.wins, f.games) + ' (' + f.wins + '/' + f.games + ', draws ' + f.draws + ')  slot0 ' + f.slotWins[0] + '/' + f.slotGames[0] +
      ' slot1 ' + f.slotWins[1] + '/' + f.slotGames[1] + '   mean peak army ' + Math.round(f.peak / f.games) + '   mean harvested ' + Math.round(f.harv / f.games) +
      '   income/min ' + Math.round(f.income / f.games) + '   turf held (avg) ' + (f.turf / f.games).toFixed(1));
    const faction = NT.FACTIONS[id];
    const rows = faction.defs.filter(function (d) { return d.kind === 'unit' && d.queue; });
    lines.push('  ' + 'unit'.padEnd(16) + 'built'.padStart(7) + '/game'.padStart(7) + 'kills'.padStart(7) + '  k/built');
    for (const d of rows) {
      const b = f.produced[d.id] || 0, k = f.kills[d.id] || 0;
      lines.push('  ' + d.key.padEnd(16) + String(b).padStart(7) + (b / f.games).toFixed(1).padStart(7) + String(k).padStart(7) + '  ' + (b ? (k / b).toFixed(2) : '-'));
    }
    lines.push('  structures placed per game: ' + faction.defs.filter(function (d) { return d.kind === 'building' && f.placed[d.id]; })
      .map(function (d) { return d.key + ' ' + (f.placed[d.id] / f.games).toFixed(1); }).join(', '));
    lines.push('  AI per game: ' + Object.keys(f.ai).map(function (key) { return key + ' ' + (f.ai[key] / f.games).toFixed(1); }).join(', '));
    const sk = faction.defs.filter(function (d) { return d.kind === 'building' && f.kills[d.id]; });
    for (const d of sk) lines.push('  ' + ('[' + d.key + ']').padEnd(16) + '      -      -' + String(f.kills[d.id]).padStart(7));
  }
  return lines.join('\n');
}

function main() {
  // tuning env: NT_X='{"HALT":8,"DEF_R":9}' overrides NT.AI tunables; NT_LV='{"normal":{"firstWave":4000}}' level fields
  if (process.env.NT_X) Object.assign(NT.AI, JSON.parse(process.env.NT_X));
  if (process.env.NT_LV) for (const k in JSON.parse(process.env.NT_LV)) Object.assign(NT.AI.LEVELS[k], JSON.parse(process.env.NT_LV)[k]);
  if (argv('patch', '')) applyPatch(JSON.parse(argv('patch')[0] === '{' ? argv('patch') : require('fs').readFileSync(argv('patch'), 'utf8')));
  if (flag('tg')) load('test/fixtures/thirdgang.js');
  const cfg = {
    games: +argv('games', 20), diff: argv('diff', 'normal'), size: argv('size', 'medium'),
    seed0: +argv('seed0', 1), seeds: argv('seeds', '') ? argv('seeds').split(',').map(Number) : null,
    factions: argv('factions', '') ? argv('factions').split(',') : NT.FACTION_LIST.map(function (f) { return f.id; }),
    max: +argv('max', 40), fog: argv('fog', '1') !== '0', mirror: flag('mirror'), jobs: +argv('jobs', 0),
  };
  const list = games(cfg);
  if (process.env.NT_BALANCE_SLICE) {                                       // worker: play a slice, print JSON
    const [k, m] = process.env.NT_BALANCE_SLICE.split('/').map(Number);
    const out = [];
    for (let i = k; i < list.length; i += m) { const r = runMatch(list[i]); r.index = i; out.push(r); }
    process.stdout.write(JSON.stringify(out));
    return;
  }
  const jobs = cfg.jobs || Math.max(1, Math.min(list.length, require('os').cpus().length - 1));
  console.log('NEON TURF balance: ' + list.length + ' games, ' + cfg.diff + ' vs ' + cfg.diff + ', size ' + cfg.size + ', fog ' + (cfg.fog ? 'on' : 'off') +
    ', factions ' + cfg.factions.join(' / ') + ', ' + jobs + ' workers');
  const t0 = Date.now();
  const done = function (results) {
    results.sort(function (a, b) { return a.index - b.index; });
    if (flag('list')) for (const r of results) {
      console.log('  seed ' + String(r.seed).padStart(5) + '  ' + r.factions.join(' v ').padEnd(18) + ' -> ' + (r.winner >= 0 ? r.factions[r.winner] : 'none').padEnd(8) +
        r.minutes.toFixed(1).padStart(6) + ' min  harvested ' + r.harvested.map(Math.round).join('/') + '  peak army ' + r.peakArmy.join('/') +
        '  waves ' + r.brains.map(function (b) { return b ? b.waves : '-'; }).join('/') + '  ' + r.avgMs.toFixed(3) + ' ms/tick');
    }
    console.log(summarize(results));
    console.log('\nwall time ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
    if (flag('json')) require('fs').writeFileSync(argv('json'), JSON.stringify(results.map(function (r) { r.world = null; return r; })));
  };
  if (jobs <= 1) { done(list.map(function (g, i) { const r = runMatch(g); r.index = i; return r; })); return; }
  const cp = require('child_process'), results = [];
  let left = jobs;
  for (let k = 0; k < jobs; k++) {
    const child = cp.spawn(process.execPath, [__filename].concat(process.argv.slice(2)), { env: Object.assign({}, process.env, { NT_BALANCE_SLICE: k + '/' + jobs }) });
    let buf = '';
    child.stdout.on('data', function (d) { buf += d; });
    child.stderr.on('data', function (d) { process.stderr.write(d); });
    child.on('close', function () {
      try { for (const r of JSON.parse(buf)) results.push(r); } catch (e) { console.error('worker ' + k + ' failed: ' + e.message); }
      if (--left === 0) done(results);
    });
  }
}

module.exports = { runMatch: runMatch, summarize: summarize };
if (require.main === module) main();
