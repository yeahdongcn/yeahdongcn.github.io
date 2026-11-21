'use strict';
// NEON TURF — THE gate.  node rts/test/smoke.js   (run it 2-3x; it must stay green)
// Headless simulation of every system: no DOM, no canvas, fixed seeds.
// Add a section per system; drive the world only through NT.cmd + NT.step.
const { NT, missing, load, check, section, run, done } = require('./harness');
load('test/fixtures/thirdgang.js');          // test-only faction: proves the engine is faction-agnostic

// ---------------------------------------------------------------------------
section('data: every faction file is well-formed');
{
  const errs = NT.validate();
  check(errs.length === 0, 'NT.validate() problems:\n    ' + errs.join('\n    '));
  for (const id in NT.FACTIONS) {
    const f = NT.FACTIONS[id];
    for (const d of f.defs) {
      check(d.name.en && d.name.zh, d.id + ' has a bilingual name');
      for (const w of d.weapons) check(w.rangePx > 0 && w.cd >= 1, d.id + ' weapon normalized');
    }
  }
}

// ---------------------------------------------------------------------------
section('spine: world, occupancy, spawn / kill / capture');
{
  const map = NT.Map.fromAscii([
    '1...........',
    '............',
    '............',
    '....$$......',
    '....##......',
    '............',
    '........2...',
    '............',
    '............',
    '............',
    '............',
    '............',
  ]);
  const w = NT.createWorld({ map, seed: 7, players: [{ faction: 'tg' }, { faction: 'tg' }] });
  check(w.players.length === 2 && w.players[0].team !== w.players[1].team, 'two players on two teams');
  check(w.players[0].color !== w.players[1].color, 'mirror match gets two different team colours');
  const p0 = w.players[0];
  check(p0.nBuildings === 1 && p0.owned['tg.core'] === 1, 'start base: HQ spawned and counted');
  check(p0.nUnits === 4, 'start base: 3 grunts + 1 hauler (got ' + p0.nUnits + ')');
  const hq = w.ents.find(e => e.owner === 0 && e.kind === 'building');
  check(NT.Occ.solid(w, hq.cx, hq.cy) === hq.id && NT.Occ.solid(w, hq.cx + 2, hq.cy + 2) === hq.id, 'HQ footprint is solid');
  check(!NT.Occ.canStand(w, 'small', hq.cx + 1, hq.cy + 1), 'nobody can stand inside a building');
  check(!NT.Occ.walkable(w, hq.cx, hq.cy) && NT.Occ.walkable(w, 6, 6), 'walkable() sees buildings, ignores units');
  check(!NT.Occ.canStand(w, 'large', 4, 4), 'block terrain is impassable');

  // five small bodies share a cell, the sixth spills over; a large body needs a whole empty cell
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(NT.spawn(w, 'tg.grunt', 0, 10, 10));
  const inCell = ids.filter(e => e.cx === 10 && e.cy === 10).length;
  check(inCell === NT.INF_PER_CELL, NT.INF_PER_CELL + ' infantry share one cell (got ' + inCell + ')');
  check(new Set(ids.filter(e => e.cx === 10 && e.cy === 10).map(e => e.slot)).size === NT.INF_PER_CELL, 'each in its own sub-slot');
  const tank = NT.spawn(w, 'tg.tank', 0, 10, 10);
  check(tank && !(tank.cx === 10 && tank.cy === 10), 'a vehicle will not share a cell with infantry');
  check(NT.Occ.solid(w, tank.cx, tank.cy) === tank.id, 'vehicle claims its cell');

  const near = NT.entsInRadius(w, NT.cellCenter(10), NT.cellCenter(10), 40);
  check(near.length >= NT.INF_PER_CELL, 'entsInRadius finds the squad');
  check(NT.entAt(w, tank.x, tank.y) === tank, 'entAt picks the vehicle');
  check(NT.entAt(w, hq.x, hq.y) === hq, 'entAt picks the building');
  check(NT.ringCells(w, hq).length === 7, 'ring of a 3x3 in the map corner = 7 in-bounds cells');
  const before = NT.hashWorld(w);
  NT.kill(w, tank, null);
  check(!tank.alive && NT.Occ.solid(w, tank.cx, tank.cy) === 0 && !NT.get(w, tank.id), 'kill frees the grid and the id');
  check(NT.hashWorld(w) !== before, 'hash reacts to state');
  NT.step(w);
  check(w.ents.indexOf(tank) < 0, 'dead entities are compacted at the end of the tick');
  check(p0.nUnits === 4 + 6, 'unit counter follows spawns and deaths (got ' + p0.nUnits + ')');

  NT.setOwner(w, hq, 1);
  check(p0.nBuildings === 0 && w.players[1].nBuildings === 2 && w.players[1].owned['tg.core'] === 2, 'setOwner moves the counters');
  check(NT.isEnemy(w, 0, 1) && !NT.isEnemy(w, 0, NT.NEUTRAL) && !NT.isAlly(w, 0, 1), 'relationships');
  check(NT.cmd(w, 0, { type: 'no-such-command' }) === false, 'unknown commands are rejected');
}

// ===========================================================================
// SIM CORE I — path.js, move.js, combat.js, fog.js
// Every scenario is a small ASCII world without bases, set up with NT.spawn and
// then driven ONLY through NT.cmd + NT.step by go(), which runs NT.debugCheck
// every 10 ticks; sound() closes a scenario by asserting the grids stayed
// consistent throughout. Expected numbers are derived from the fixture's data
// (NT.DEFS / NT.WARHEADS / world.rules), so a balance edit cannot turn the gate red.
// ===========================================================================
const T = NT.TILE;
const at = c => (c + 0.5) * T;                                // cell coordinate -> world px of the cell centre
let dbg = [];
// two players of the fixture faction on two teams, no bases; fog ON like a real match unless opts says otherwise
function mkWorld(rows, opts) {
  return NT.createWorld(Object.assign({ map: NT.Map.fromAscii(rows), seed: 11, noBases: true,
    players: [{ faction: 'tg' }, { faction: 'tg' }] }, opts || {}));
}
// wd x ht cells of pavement; paint(x, y) may return another map char. The start slots sit in two corners.
function board(wd, ht, paint) {
  const rows = [];
  for (let y = 0; y < ht; y++) {
    let r = '';
    for (let x = 0; x < wd; x++) r += (!x && !y) ? '1' : (x === wd - 1 && y === ht - 1) ? '2' : (paint && paint(x, y)) || '.';
    rows.push(r);
  }
  return rows;
}
// Step up to n ticks; stops early once pred(world) holds AFTER a step (so a command given just before has run).
// Returns the ticks stepped.
function go(w, n, pred) {
  for (let i = 1; i <= n; i++) {
    NT.step(w);
    if (w.tick % 10 === 0) for (const m of NT.debugCheck(w)) if (dbg.length < 6) dbg.push(m);
    if (pred && pred(w)) return i;
  }
  return n;
}
function sound(name) {
  check(dbg.length === 0, name + ': NT.debugCheck stayed clean\n    ' + dbg.join('\n    '));
  dbg = [];
}
const ids = us => us.map(u => u.id);
const idle = u => !u.order && NT.Move.status(u) !== 'moving' && u.hopT < 0;
const cheb = (u, cx, cy) => Math.max(Math.abs(u.cx - cx), Math.abs(u.cy - cy));
const close = (a, b) => Math.abs(a - b) < 1e-6;
const order = (w, pid, type, us, extra) => NT.cmd(w, pid, Object.assign({ type: type, ids: ids(us) }, extra || {}));
const stance = (w, pid, us, s) => order(w, pid, 'stance', us, { stance: s });
const moveTo = (w, pid, us, cx, cy, extra) => order(w, pid, 'move', us, Object.assign({ x: at(cx), y: at(cy) }, extra || {}));
// what one hit of weapon #wi of `def` takes off a target of `armor` (the rules.js formula, mods all 1)
const hitDmg = (def, wi, armor) => {
  const wp = def.weapons[wi];
  return wp.dmg * NT.WARHEADS[wp.warhead][armor] * (wp.vs && wp.vs[armor] !== undefined ? wp.vs[armor] : 1);
};
// step until an event of this type shows up; returns it (or undefined after n ticks). Events are drained on the way.
function until(w, n, type, pred) {
  let hit;
  go(w, n, () => { for (const ev of NT.drainEvents(w)) if (!hit && ev.t === type && (!pred || pred(ev))) hit = ev; return !!hit; });
  return hit;
}

// ---------------------------------------------------------------------------
section('path: A*, no corner cutting, best-effort goals, adjacentTo / range / avoid, request budget');
{
  const w = mkWorld([
    '1.........',
    '....#.....',
    '....#.....',
    '....#.....',
    '....#.....',
    '..........',
    '~~~~~~....',
    '......#...',
    '.....#....',
    '..........',
    '..###.....',
    '..#.#.....',
    '..###....2',
  ]);
  const cell = (x, y) => y * w.w + x, P = w.sys.path || NT.Path._sys(w);
  // legal = every step goes to a neighbour, onto walkable ground, never between two blocked corners
  const legal = (sx, sy, p) => {
    let x = sx, y = sy;
    for (const i of p) {
      const nx = i % w.w, ny = (i - nx) / w.w, dx = nx - x, dy = ny - y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (!dx && !dy) || !NT.Occ.walkable(w, nx, ny)) return false;
      if (dx && dy && (!NT.Occ.walkable(w, nx, y) || !NT.Occ.walkable(w, x, ny))) return false;
      x = nx; y = ny;
    }
    return true;
  };
  let p = NT.Path.find(w, 'large', 1, 2, 7, 2);
  check(p && p.length === 6 && p[5] === cell(7, 2) && legal(1, 2, p) && P.reached, 'routes round the wall the short way (6 steps, got ' + (p && p.length) + ')');
  p = NT.Path.find(w, 'large', 1, 2, 1, 2);
  check(p && p.length === 0 && P.reached, 'already there -> []');
  p = NT.Path.find(w, 'large', 5, 9, 6, 8);
  check(p && p.length === 2 && p[0] === cell(6, 9) && legal(5, 9, p), 'a diagonal past a blocked corner becomes two straight steps');
  p = NT.Path.find(w, 'large', 5, 7, 6, 8);
  check(p && p.length > 1 && p[p.length - 1] === cell(6, 8) && legal(5, 7, p), 'never squeezes between two blocks that touch at a corner');
  p = NT.Path.find(w, 'large', 1, 2, 4, 2);
  check(p && p[p.length - 1] === cell(3, 2) && !P.reached, 'goal on a block -> stops at the nearest walkable cell');
  p = NT.Path.find(w, 'small', 1, 2, 2, 6);
  check(p && p[p.length - 1] === cell(2, 5) && !P.reached && legal(1, 2, p), 'goal in the water -> stops on the bank');
  p = NT.Path.find(w, 'large', 0, 9, 3, 11);
  const end = p && p[p.length - 1], ex = end % w.w, ey = (end - ex) / w.w;
  check(p && legal(0, 9, p) && !P.reached && Math.hypot(ex - 3, ey - 11) === 2, 'walled-in goal -> closest reachable cell (got ' + ex + ',' + ey + ')');
  check(NT.Path.find(w, 'large', 3, 11, 0, 0) === null, 'walled-in start -> null (no progress possible)');
  check(NT.Path.region(w, 3, 11) > 0 && NT.Path.region(w, 3, 11) !== NT.Path.region(w, 0, 0) && NT.Path.region(w, 4, 2) === 0, 'regions tell reachable from unreachable');

  p = NT.Path.find(w, 'large', 0, 9, 9, 9, { range: 3 * T });
  check(p && p.length === 6 && p[5] === cell(6, 9) && P.reached, 'range goal: stops as soon as the cell centre is within range');
  const hq = NT.spawn(w, 'tg.core', 0, 6, 1);
  p = NT.Path.find(w, 'large', 1, 2, 7, 2, { adjacentTo: hq });
  const last = { cx: p[p.length - 1] % w.w, cy: (p[p.length - 1] / w.w) | 0 };
  check(legal(1, 2, p) && NT.touching(last, hq) && P.reached && p.length === 4, 'adjacentTo: stops on the first cell touching the building');
  p = NT.Path.find(w, 'large', 0, 9, 7, 2, { range: 2 * T, target: hq });
  check(p && P.reached && NT.distTo(at(p[p.length - 1] % w.w), at((p[p.length - 1] / w.w) | 0), hq) <= 2 * T, 'range to a building is measured to its footprint');
  check(NT.Path.find(w, 'large', 1, 2, 7, 2)[0] !== undefined && !P.reached, 'a structure on the goal is found out (passVersion relabels the grid)');
  check(NT.Path.satisfies(w, 5, 2, 7, 2, { adjacentTo: hq }) && !NT.Path.satisfies(w, 3, 2, 7, 2, { adjacentTo: hq }), 'satisfies() agrees with find()');

  // avoid: standing units become obstacles; row 5 is the only gap between the wall and the water
  const tank = NT.spawn(w, 'tg.tank', 0, 4, 5), mover = NT.spawn(w, 'tg.tank', 0, 0, 5);
  p = NT.Path.find(w, 'large', 0, 5, 9, 5);
  check(p.indexOf(cell(4, 5)) >= 0 && p.length === 9, 'units are not obstacles by default');
  p = NT.Path.find(w, 'large', 0, 5, 9, 5, { avoid: true, self: mover });
  check(p && P.reached && p.indexOf(cell(4, 5)) < 0 && legal(0, 5, p), 'avoid: goes the long way round a parked vehicle');
  NT.kill(w, tank, null);
  const squad = [];
  for (let i = 0; i < 2; i++) squad.push(NT.spawn(w, 'tg.grunt', 0, 4, 5, { exact: true }));
  p = NT.Path.find(w, 'small', 0, 5, 9, 5, { avoid: true });
  check(p.indexOf(cell(4, 5)) >= 0, 'avoid: a small body may pass a cell that still has a free slot ...');
  p = NT.Path.find(w, 'large', 0, 5, 9, 5, { avoid: true, self: mover });
  check(p.indexOf(cell(4, 5)) < 0, '... a large one may not');
  for (let i = 0; i < 3; i++) squad.push(NT.spawn(w, 'tg.grunt', 0, 4, 5, { exact: true }));
  p = NT.Path.find(w, 'small', 0, 5, 9, 5, { avoid: true });
  check(p.indexOf(cell(4, 5)) < 0, '... and nobody passes a full one');
  const out = [99, 98];
  check(NT.Path.find(w, 'small', 0, 5, 3, 5, { out: out }) === out && out.length === 3, 'opts.out is filled and returned (no allocation)');
  sound('path');
}
{
  // sixty orders in one tick are spread over several ticks by the request budget, and everybody still gets there
  const w = mkWorld(board(40, 30, (x, y) => (x === 20 && y > 2 && y < 27) ? '#' : null));
  const us = [], keep = NT.Path.BUDGET;
  for (let i = 0; i < 60; i++) us.push(NT.spawn(w, i % 3 ? 'tg.grunt' : 'tg.buggy', 0, 2 + (i % 6), 3 + ((i / 6) | 0) * 2));
  NT.Path.BUDGET = 400;
  NT.cmd(w, 0, { type: 'move', ids: ids(us), x: at(33), y: at(15) });
  NT.step(w);
  const P = w.sys.path, waiting = us.filter(u => u.mv.ticket).length;
  let worst = P.used;
  check(waiting > 0 && waiting < 60, 'a tight budget serves only part of the queue in the first tick (' + (60 - waiting) + ' of 60)');
  go(w, 60, () => { if (P.used > worst) worst = P.used; return !P.pending; });
  check(!P.pending && us.every(u => !u.mv.ticket), 'the queue drains in order over the next ticks');
  check(worst < 400 + NT.Path.CAP, 'no tick spends more than its budget plus one search (' + worst + ' expansions)');
  NT.Path.BUDGET = keep;
  go(w, 900, () => us.every(idle));
  check(us.every(u => idle(u) && cheb(u, 33, 15) <= 5), 'all sixty arrive');
  sound('path budget');
}

// ---------------------------------------------------------------------------
section('move: hops, speed, stop, queued waypoints, junk commands');
{
  const w = mkWorld([
    '1...........',
    '....#.......',
    '....#.......',
    '....#.......',
    '....#.......',
    '............',
    '...........2',
  ]);
  const g = NT.spawn(w, 'tg.grunt', 0, 1, 2), t = NT.spawn(w, 'tg.tank', 0, 1, 3);
  check(NT.Move.status(g) === 'idle', 'a fresh unit is idle');
  NT.cmd(w, 0, { type: 'move', ids: [g.id], x: at(8), y: at(2) });
  NT.cmd(w, 0, { type: 'move', ids: [t.id], x: at(8), y: at(3) });
  NT.step(w);
  check(g.order && g.order.type === 'move' && NT.Move.status(g) === 'moving' && g.hopT >= 0, 'the order starts in the tick it was given');
  const n = go(w, 400, () => idle(g) && idle(t));
  check(g.cx === 8 && g.cy === 2 && t.cx === 8 && t.cy === 3, 'grunt and tank walk round the wall to their cells');
  check(n < 200, 'in good time (' + n + ' ticks)');
  check(g.x === at(8) && g.y === at(2) && t.x === at(8) && t.y === at(3), 'and stand exactly on their cell positions');
  check(NT.Move.status(g) === 'idle' && g.homeX === g.x && g.homeY === g.y, 'done: idle, and the new spot is its post');
  sound('single unit');
}
{
  const w = mkWorld(board(20, 14));
  const speedPx = NT.DEFS['tg.buggy'].move.speedPx;
  const trip = (u, cx, cy) => { NT.cmd(w, u.owner, { type: 'move', ids: [u.id], x: at(cx), y: at(cy) }); return go(w, 400, () => u.cx === cx && u.cy === cy && u.hopT < 0); };
  const road = trip(NT.spawn(w, 'tg.buggy', 0, 1, 2), 11, 2), exact = 10 * T / speedPx;
  check(road >= Math.floor(exact) && road <= exact + 2, 'ten cells take 10 x TILE / speedPx ticks (' + road + ' vs ' + exact.toFixed(1) + ')');
  {
    // all rubble, so the route cannot dodge the slow ground
    const r = mkWorld(['1%%%%%%%%%%%', '%%%%%%%%%%%2']), u = NT.spawn(r, 'tg.buggy', 0, 1, 0), k = r.map.speed[5];
    moveTo(r, 0, [u], 11, 0);
    const slow = go(r, 400, () => u.cx === 11 && u.hopT < 0);
    check(k < 1 && slow >= Math.floor(exact / k) && slow <= exact / k + 2, 'rubble slows every hop by its terrain factor (' + slow + ' vs ' + (exact / k).toFixed(1) + ')');
  }
  const straight = trip(NT.spawn(w, 'tg.grunt', 0, 1, 4), 7, 4), diag = trip(NT.spawn(w, 'tg.grunt', 0, 1, 5), 7, 11);
  check(Math.abs(diag / straight - Math.SQRT2) < 0.05, 'diagonal hops take sqrt(2) longer (' + diag + ' vs ' + straight + ')');
  const tank = NT.spawn(w, 'tg.tank', 0, 14, 6);
  NT.cmd(w, 0, { type: 'move', ids: [tank.id], x: at(14), y: at(1) });
  NT.step(w); NT.step(w);
  check(tank.hopT < 0 && tank.cy === 6 && tank.facing !== 0, 'a large body turns its hull before it sets off');
  go(w, 200, () => idle(tank));
  check(tank.cy === 1 && Math.abs(NT.angDiff(tank.facing, -Math.PI / 2)) < 0.01, 'and ends up facing the way it drove');

  // stop: the order is gone at once, the unit finishes its hop and stands on a cell
  const b = NT.spawn(w, 'tg.buggy', 0, 1, 8);
  NT.cmd(w, 0, { type: 'move', ids: [b.id], x: at(18), y: at(8) });
  go(w, 12);
  NT.cmd(w, 0, { type: 'stop', ids: [b.id] });
  NT.step(w);
  check(!b.order && NT.Move.status(b) === 'idle', 'stop clears the order');
  go(w, 20, () => b.hopT < 0);
  go(w, 20);
  check(b.hopT < 0 && b.cx > 1 && b.cx < 10 && b.x === at(b.cx), 'the unit stands where the stop caught it (cell ' + b.cx + ')');

  // queue: waypoints in order
  const q = NT.spawn(w, 'tg.buggy', 0, 1, 10), seen = [];
  NT.cmd(w, 0, { type: 'move', ids: [q.id], x: at(6), y: at(10) });
  NT.cmd(w, 0, { type: 'move', ids: [q.id], x: at(6), y: at(7), queue: true });
  NT.cmd(w, 0, { type: 'move', ids: [q.id], x: at(2), y: at(7), queue: true });
  NT.step(w);
  check(q.queue.length === 2, 'queue:true appends to ent.queue');
  go(w, 400, () => {
    for (const c of [[6, 10], [6, 7], [2, 7]]) if (q.cx === c[0] && q.cy === c[1] && q.hopT < 0 && seen.indexOf(c.join()) < 0) seen.push(c.join());
    return idle(q) && !q.queue.length;
  });
  check(seen.join(' ') === '6,10 6,7 2,7' && q.cx === 2 && q.cy === 7, 'queued moves are walked in order (' + seen.join(' ') + ')');

  // junk and hostile commands change nothing
  const foe = NT.spawn(w, 'tg.grunt', 1, 16, 3), mine = NT.spawn(w, 'tg.grunt', 0, 16, 9);
  NT.cmd(w, 0, { type: 'move', ids: [foe.id], x: at(1), y: at(1) });
  NT.cmd(w, 0, { type: 'stop', ids: [foe.id] });
  NT.cmd(w, 0, { type: 'stance', ids: [foe.id], stance: 'passive' });
  NT.cmd(w, 0, { type: 'move', ids: [mine.id], x: NaN, y: 5 });
  NT.cmd(w, 0, { type: 'move', ids: [mine.id] });
  NT.cmd(w, 0, { type: 'amove', ids: 'all of them', x: 5, y: 5 });
  NT.cmd(w, 0, { type: 'attack', ids: [mine.id], target: 987654 });
  NT.cmd(w, 0, { type: 'attack', ids: [mine.id], target: mine.id });
  NT.cmd(w, 0, { type: 'attack', ids: [mine.id] });
  NT.cmd(w, 0, { type: 'stance', ids: [mine.id], stance: 'berserk' });
  NT.cmd(w, 0, { type: 'stance' });
  NT.cmd(w, 0, { type: 'stop' });
  NT.cmd(w, 0, { type: 'move', ids: [987654, -3, null, 'x', mine.id, mine.id], x: 1e9, y: -1e9 });
  NT.step(w);
  check(!foe.order && foe.stance === 'aggressive' && mine.stance === 'aggressive', 'commands for units that are not mine, or with junk fields, are ignored');
  check(mine.order && mine.order.cx === w.w - 1 && mine.order.cy === 0, 'an off-map point is clamped into the map');
  sound('move basics');
}

// ---------------------------------------------------------------------------
section('move: shared cells, group destinations, flyers');
{
  const w = mkWorld(board(24, 12));
  const INF = NT.INF_PER_CELL, squad = [];
  for (let i = 0; i < INF + 1; i++) squad.push(NT.spawn(w, 'tg.grunt', 0, 1, 1 + (i % 3)));
  NT.cmd(w, 0, { type: 'move', ids: ids(squad), x: at(8), y: at(3) });
  go(w, 300, () => squad.every(idle));
  const inCell = squad.filter(u => u.cx === 8 && u.cy === 3);
  check(inCell.length === INF && new Set(inCell.map(u => u.slot)).size === INF, INF + ' infantry fit the clicked cell, each in its own slot (got ' + inCell.length + ')');
  const odd = squad.find(u => inCell.indexOf(u) < 0);
  check(odd && cheb(odd, 8, 3) === 1 && idle(odd), 'the one too many stands in the next cell');

  // the same when they are sent one by one: the last one settles next to the full cell instead of evicting a friend
  const late = [];
  for (let i = 0; i < INF + 1; i++) late.push(NT.spawn(w, 'tg.grunt', 0, 1, 7 + (i % 3)));
  for (const u of late) NT.cmd(w, 0, { type: 'move', ids: [u.id], x: at(8), y: at(8) });
  const n = go(w, 300, () => late.every(idle));
  check(late.filter(u => u.cx === 8 && u.cy === 8).length === INF && late.every(u => cheb(u, 8, 8) <= 1), 'sent one by one: five in, the sixth beside it');
  check(n < 150, 'and it does not dither about it (' + n + ' ticks)');
  check(squad.every(u => inCell.indexOf(u) < 0 || (u.cx === 8 && u.cy === 3)), 'nobody was pushed out of an occupied destination');

  // a mixed group: every large body gets a cell of its own, small bodies pack, nobody is left behind
  const mix = [];
  for (let i = 0; i < 9; i++) mix.push(NT.spawn(w, i % 3 === 2 ? 'tg.buggy' : 'tg.tank', 0, 12 + (i % 3), 1 + ((i / 3) | 0)));
  for (let i = 0; i < 8; i++) mix.push(NT.spawn(w, i % 2 ? 'tg.lancer' : 'tg.grunt', 0, 15, 1 + (i % 3)));
  NT.cmd(w, 0, { type: 'move', ids: ids(mix), x: at(17), y: at(8) });
  NT.step(w);
  const big = mix.filter(u => u.body === 'large'), dest = u => u.order.cy * w.w + u.order.cx;
  check(new Set(big.map(dest)).size === big.length, 'group move: one destination cell per large body');
  check(mix.every(u => u.body !== 'small' || big.every(v => dest(v) !== dest(u))), 'group move: no small body is sent into a vehicle\'s cell');
  const perCell = {};
  for (const u of mix) if (u.body === 'small') perCell[dest(u)] = (perCell[dest(u)] || 0) + 1;
  check(Object.keys(perCell).every(k => perCell[k] <= INF) && Object.keys(perCell).length === 2, 'group move: small bodies pack ' + INF + ' to a cell');
  go(w, 500, () => mix.every(idle));
  check(mix.every(idle) && mix.every(u => cheb(u, 17, 8) <= 4), 'the whole group arrives around the click');
  check(new Set(big.map(u => u.cy * w.w + u.cx)).size === big.length, 'and no two large bodies end up in one cell');

  // flyers: straight over everything, one cell each
  const f1 = NT.spawn(w, 'tg.flyer', 0, 1, 10), f2 = NT.spawn(w, 'tg.flyer', 0, 1, 10);
  check(NT.Occ.at(w, 1, 10).length === 0 && w.air.length === 2, 'flyers are not on the grids');
  NT.cmd(w, 0, { type: 'move', ids: [f1.id, f2.id], x: at(21), y: at(10) });
  go(w, 300, () => idle(f1) && idle(f2));
  check(NT.dist(f1.x, f1.y, f2.x, f2.y) >= T * 0.9 && cheb(f1, 21, 10) <= 1 && cheb(f2, 21, 10) <= 1, 'two flyers sent to one point hover a cell apart');
  sound('groups');
}
{
  const w = mkWorld(board(30, 12, (x, y) => (x > 8 && x < 14) ? (y % 2 ? '#' : '~') : null));
  const f = NT.spawn(w, 'tg.flyer', 0, 2, 6), d = NT.DEFS['tg.flyer'];
  let over = 0;
  NT.cmd(w, 0, { type: 'move', ids: [f.id], x: at(26), y: at(6) });
  const n = go(w, 300, () => { if (!w.map.pass[f.cy * w.w + f.cx]) over++; return idle(f) && w.tick > 2; });
  const exact = 24 * T / d.move.speedPx;
  check(f.x === at(26) && f.y === at(6) && over > 5, 'a flyer crosses blocks and water in a straight line');
  check(n >= Math.floor(exact) && n <= exact + 4, 'at its own speed (' + n + ' ticks vs ' + exact.toFixed(1) + ')');
  NT.cmd(w, 0, { type: 'move', ids: [f.id], x: -500, y: 99999 });
  go(w, 400, () => idle(f) && w.tick > n + 3);
  check(f.x >= 0 && f.y <= w.h * T && f.cx === 0 && f.cy === w.h - 1, 'and stays inside the map');
  sound('air');
}
// ---------------------------------------------------------------------------
section('traffic: choke, head-on corridors, making way, obstacles, giving up cleanly, crushing');
{
  // 30 mixed units pour through a 2-wide gap in a wall
  const MIX = ['tg.grunt', 'tg.tank', 'tg.grunt', 'tg.buggy', 'tg.lancer', 'tg.hauler', 'tg.grunt', 'tg.mortar', 'tg.medic', 'tg.tank'];
  const w = mkWorld(board(40, 22, (x, y) => (x === 20 || x === 21) && y !== 10 && y !== 11 ? '#' : null));
  const us = [];
  for (let i = 0; i < 30; i++) us.push(NT.spawn(w, MIX[i % MIX.length], 0, 3 + (i % 6) * 2, 4 + ((i / 6) | 0) * 3));
  moveTo(w, 0, us, 32, 10);
  const n = go(w, 700, () => us.every(idle));
  check(us.every(idle) && n < 700, '30 mixed units through a 2-wide choke: everyone is done within 35 s (' + n + ' ticks)');
  check(us.every(u => u.cx > 21 && cheb(u, 32, 10) <= 5), 'and all of them stand around the clicked cell on the far side');
  const big = us.filter(u => u.body === 'large');
  check(new Set(big.map(u => u.cy * w.w + u.cx)).size === big.length, 'no two large bodies share a cell');
  sound('choke');
}
{
  // two friendly platoons meet head-on in a 2-wide corridor, then two columns in a 1-wide alley
  const kinds = ['tg.tank', 'tg.buggy', 'tg.tank', 'tg.grunt', 'tg.grunt', 'tg.hauler', 'tg.grunt', 'tg.tank'];
  for (const wide of [2, 1]) {
    const w = mkWorld(board(34, 9, (x, y) => (x >= 6 && x < 28 && (y < 4 || y >= 4 + wide)) ? '#' : null));
    const A = [], B = [];
    for (let i = 0; i < 8; i++) A.push(NT.spawn(w, kinds[i], 0, 1 + (i % 4), 3 + ((i / 4) | 0) * 2));
    for (let i = 0; i < 8; i++) B.push(NT.spawn(w, kinds[i], 0, 29 + (i % 4), 3 + ((i / 4) | 0) * 2));
    moveTo(w, 0, A, 31, 4); moveTo(w, 0, B, 2, 4);
    const all = A.concat(B), n = go(w, 800, () => all.every(idle));
    check(all.every(idle) && n < 800, 'head-on platoons, ' + wide + '-wide corridor: resolved within 40 s (' + n + ' ticks)');
    check(A.every(u => u.cx >= 28) && B.every(u => u.cx < 6), wide + '-wide corridor: both platoons passed each other and came out the far end');
    sound('head-on ' + wide);
  }
}
{
  const door = ['1.....#......', '......#......', '.............', '......#......', '......#.....2'];
  const speedPx = NT.DEFS['tg.tank'].move.speedPx;
  // an idle friend parked in a doorway gets out of the way
  let w = mkWorld(door), sit = NT.spawn(w, 'tg.tank', 0, 6, 2), mover = NT.spawn(w, 'tg.tank', 0, 1, 2), moves = 0, last = sit.cx;
  moveTo(w, 0, [mover], 11, 2);
  let n = go(w, 400, () => { if (sit.cx !== last) { moves++; last = sit.cx; } return idle(mover) && idle(sit); });
  check(mover.cx === 11 && mover.cy === 2 && n < 150, 'an idle friend in a doorway makes way and the mover gets through (' + n + ' ticks)');
  check(moves === 1 && cheb(sit, 6, 2) === 1 && idle(sit), 'it moves once, one cell, and stays there (no ping-pong)');
  sound('doorway');

  // on hold it never moves: the mover cannot pass and stops trying instead of spinning forever
  for (const who of ['a friend on hold', 'an enemy']) {
    w = mkWorld(door);
    sit = NT.spawn(w, who === 'an enemy' ? 'tg.hauler' : 'tg.tank', who === 'an enemy' ? 1 : 0, 6, 2);
    mover = NT.spawn(w, 'tg.hauler', 0, 1, 2);
    if (who !== 'an enemy') stance(w, 0, [sit], 'hold');
    moveTo(w, 0, [mover], 11, 2);
    let st = '';
    n = go(w, 600, () => { if (mover.order) st = NT.Move.status(mover); return idle(mover); });
    check(st === 'failed' && idle(mover) && mover.cx === 5 && n < 4 * T / mover.def.move.speedPx + NT.Move.STUCK + 40,
      who + ' in a 1-wide door: the move fails cleanly after ' + (NT.Move.STUCK / NT.TPS) + ' s without progress (' + n + ' ticks, status ' + st + ')');
    check(sit.cx === 6 && sit.cy === 2 && sit.hopT < 0, who + ' was not pushed');
    sound('blocked door');
  }

  // with room to spare an enemy on the road is just an obstacle
  w = mkWorld(board(14, 5));
  sit = NT.spawn(w, 'tg.hauler', 1, 6, 2); mover = NT.spawn(w, 'tg.hauler', 0, 1, 2);
  moveTo(w, 0, [mover], 11, 2);
  n = go(w, 400, () => idle(mover));
  check(mover.cx === 11 && mover.cy === 2 && sit.cx === 6 && n < 10 * T / mover.def.move.speedPx + 40, 'an enemy on the road is driven around (' + n + ' ticks)');

  // the destination is taken by someone who stays: stand next to it, at once
  w = mkWorld(board(14, 5));
  sit = NT.spawn(w, 'tg.tank', 0, 9, 2); mover = NT.spawn(w, 'tg.tank', 0, 1, 2);
  stance(w, 0, [sit], 'hold');
  moveTo(w, 0, [mover], 9, 2);
  n = go(w, 400, () => idle(mover));
  check(cheb(mover, 9, 2) === 1 && sit.cx === 9 && n < 8 * T / speedPx + 10, 'destination held by a friend that stays: settles in the next cell without waiting (' + n + ' ticks)');

  // ... and when even the cells around it are taken: arrival is declared after a second of being blocked nearby
  w = mkWorld(board(16, 9));
  const blk = [];
  for (let y = 3; y <= 5; y++) for (let x = 9; x <= 11; x++) blk.push(NT.spawn(w, 'tg.tank', 0, x, y));
  stance(w, 0, blk, 'hold');
  mover = NT.spawn(w, 'tg.tank', 0, 1, 4);
  moveTo(w, 0, [mover], 10, 4);
  n = go(w, 400, () => idle(mover));
  check(cheb(mover, 10, 4) === 2 && n < 7 * T / speedPx + NT.Move.GIVE_UP + 20, 'destination boxed in: declares arrival 2 cells out after ~1 s (' + n + ' ticks)');
  check(blk.every((u, i) => u.cx === 9 + (i % 3) && u.cy === 3 + ((i / 3) | 0)), 'nobody on hold was moved');
  sound('taken destinations');
}
{
  // a column drives through a crowd parked across a 3-wide street; afterwards everything is at rest
  const w = mkWorld(board(22, 5, (x, y) => (y === 0 || y === 4) && x > 0 && x < 21 ? '#' : null));
  const parked = [];
  for (let x = 9; x < 12; x++) for (let y = 1; y <= 3; y++) parked.push(NT.spawn(w, (x + y) % 2 ? 'tg.tank' : 'tg.grunt', 0, x, y));
  const spots = parked.map(u => [u.cx, u.cy]);
  const movers = [NT.spawn(w, 'tg.tank', 0, 1, 1), NT.spawn(w, 'tg.buggy', 0, 1, 2), NT.spawn(w, 'tg.tank', 0, 1, 3), NT.spawn(w, 'tg.grunt', 0, 2, 2)];
  moveTo(w, 0, movers, 18, 2);
  const everyone = parked.concat(movers), n = go(w, 500, () => everyone.every(idle));
  check(everyone.every(idle) && n < 500 && movers.every(u => cheb(u, 18, 2) <= 2), 'a column gets through a parked crowd (' + n + ' ticks)');
  check(parked.every((u, i) => cheb(u, spots[i][0], spots[i][1]) <= 4), 'the crowd only shuffles aside');
  const snap = everyone.map(u => u.x + ',' + u.y).join(';');
  go(w, 100);
  check(snap === everyone.map(u => u.x + ',' + u.y).join(';'), 'and nobody keeps shuffling afterwards');
  sound('parked crowd');
}
{
  // CRUSH: only enemy small bodies, never friends or neutrals
  const lane = ['1###########', '............', '###########2'];
  let w = mkWorld(lane), tank = NT.spawn(w, 'tg.tank', 0, 1, 1);
  check(!!tank.def.traits.crusher && tank.body === 'large', 'the fixture tank is a crusher');
  const foes = [NT.spawn(w, 'tg.grunt', 1, 5, 1), NT.spawn(w, 'tg.grunt', 1, 5, 1), NT.spawn(w, 'tg.lancer', 1, 7, 1)];
  stance(w, 0, [tank], 'passive'); stance(w, 1, foes, 'hold');      // the tank holds its fire: every death below is a crush
  moveTo(w, 0, [tank], 10, 1);
  const deaths = [];
  let n = go(w, 400, () => { for (const ev of NT.drainEvents(w)) if (ev.t === 'death') deaths.push(ev); return idle(tank); });
  check(deaths.length === 3 && deaths.every(d => d.by === tank.id) && foes.every(f => !f.alive), 'a crusher runs over enemy infantry in its way (deaths by the tank: ' + deaths.length + ')');
  check(tank.cx === 10 && n < 9 * T / tank.def.move.speedPx + 10, 'without even slowing down (' + n + ' ticks)');
  check(tank.kills === 3 && tank.xp === foes.reduce((s, f) => s + f.def.cost, 0), 'and is credited with the kills');
  sound('crush');

  w = mkWorld(lane); tank = NT.spawn(w, 'tg.tank', 0, 1, 1);
  const pals = [NT.spawn(w, 'tg.grunt', 0, 5, 1), NT.spawn(w, 'tg.grunt', 0, 5, 1)], neutral = NT.spawn(w, 'tg.grunt', NT.NEUTRAL, 8, 1);
  stance(w, 0, pals, 'hold');
  moveTo(w, 0, [tank], 10, 1);
  n = go(w, 400, () => idle(tank));
  check(pals.every(p => p.alive && p.cx === 5 && p.hp === p.maxHp) && tank.cx === 4, 'friendly infantry holding a lane is never crushed: the tank stops in front of it');
  w = mkWorld(lane); tank = NT.spawn(w, 'tg.tank', 0, 1, 1);
  const bystander = NT.spawn(w, 'tg.grunt', NT.NEUTRAL, 6, 1);
  moveTo(w, 0, [tank], 10, 1);
  go(w, 400, () => idle(tank));
  check(bystander.alive && bystander.hp === bystander.maxHp && tank.cx === 5 && neutral.alive, 'neither is a neutral');
  sound('no crush');
}

// ---------------------------------------------------------------------------
section('combat: acquisition, range, the damage matrix, splash, homing, healing');
{
  // duel: two against one, everybody on default (aggressive) stance
  const w = mkWorld(board(20, 10));
  const pair = [NT.spawn(w, 'tg.grunt', 0, 5, 4), NT.spawn(w, 'tg.grunt', 0, 5, 6)], lone = NT.spawn(w, 'tg.grunt', 1, 9, 5);
  const n = go(w, 300, () => !lone.alive || pair.every(u => !u.alive));
  check(!lone.alive && pair.every(u => u.alive), 'duel 2 grunts vs 1: the pair wins and both survive (' + n + ' ticks)');
  check(pair[0].kills + pair[1].kills === 1 && pair.some(u => u.hp < u.maxHp), 'one kill credited, and the loser got some shots in');
  go(w, 60);
  check(pair.every(u => idle(u) && !u.target), 'with nothing left to shoot they stand down');
  sound('duel');
}
{
  // range: a unit on hold fires at 4 cells, not at 5 (grunt range 4.5); min range keeps a lobber quiet
  const reach = NT.DEFS['tg.grunt'].weapons[0].range;
  for (const dx of [Math.ceil(reach), Math.floor(reach)]) {
    const w = mkWorld(board(20, 10)), g = NT.spawn(w, 'tg.grunt', 0, 5, 5), foe = NT.spawn(w, 'tg.grunt', 1, 5 + dx, 5);
    stance(w, 0, [g], 'hold'); stance(w, 1, [foe], 'passive');
    let fires = 0, bad = 0;
    go(w, 100, () => {
      for (const ev of NT.drainEvents(w)) if (ev.t === 'fire' && ev.id === g.id) { fires++; if (NT.dist(ev.x, ev.y, ev.tx, ev.ty) > reach * T + 1e-6) bad++; }
      return false;
    });
    if (dx > reach) check(fires === 0 && foe.hp === foe.maxHp, 'an enemy ' + dx + ' cells away is outside a ' + reach + '-cell weapon: no shot');
    else check(fires > 0 && bad === 0 && !foe.alive, 'at ' + dx + ' cells it is shot dead (' + fires + ' shots)');
    check(g.cx === 5 && g.cy === 5, 'the shooter on hold did not move');
    sound('range');
  }
  const mdef = NT.DEFS['tg.mortar'], mw = mdef.weapons[0];
  check(mw.minRangePx > 0, 'the fixture mortar has a minimum range');
  const w = mkWorld(board(20, 10)), m = NT.spawn(w, 'tg.mortar', 0, 5, 5), foe = NT.spawn(w, 'tg.tank', 1, 7, 5);
  stance(w, 0, [m], 'hold'); stance(w, 1, [foe], 'passive');
  let fires = 0;
  go(w, 150, () => { for (const ev of NT.drainEvents(w)) if (ev.t === 'fire' && ev.id === m.id) fires++; return false; });
  check(fires === 0 && foe.hp === foe.maxHp, 'a target inside the minimum range is not fired at');
  sound('min range');
}
{
  // the matrix: one shell against each armor class, exact hp
  const tdef = NT.DEFS['tg.tank'];
  for (const vic of ['tg.grunt', 'tg.buggy', 'tg.tank', 'tg.core']) {
    const w = mkWorld(board(24, 12)), tank = NT.spawn(w, 'tg.tank', 0, 5, 5), v = NT.spawn(w, vic, 1, 10, 5);
    stance(w, 0, [tank], 'hold');
    if (v.kind === 'unit') stance(w, 1, [v], 'passive');
    const ev = until(w, 200, 'impact', e => e.hit === v.id), want = v.maxHp - hitDmg(tdef, 0, v.def.armor);
    check(!!ev && close(v.hp, want), 'tank shell vs ' + v.def.armor + ' armor: ' + v.maxHp + ' -> ' + want + ' (got ' + v.hp + ')');
    check(v.lastHurtBy === tank.id && v.flash > 0, 'the hit is recorded on the victim');
    sound('matrix');
  }
}
{
  // splash: linear falloff to rules.splashFalloff at the rim; enemies and neutrals only
  const w = mkWorld(board(30, 14), { fog: false });
  const mortar = NT.spawn(w, 'tg.mortar', 0, 4, 6), wp = mortar.def.weapons[0];
  const centre = NT.spawn(w, 'tg.tank', 1, 11, 6), orth = NT.spawn(w, 'tg.tank', 1, 12, 6), diag = NT.spawn(w, 'tg.tank', 1, 12, 7), out = NT.spawn(w, 'tg.tank', 1, 13, 6);
  const pal = NT.spawn(w, 'tg.tank', 0, 11, 5), bystander = NT.spawn(w, 'tg.buggy', NT.NEUTRAL, 10, 6);
  stance(w, 1, [centre, orth, diag, out], 'passive'); stance(w, 0, [pal], 'passive'); stance(w, 0, [mortar], 'hold');
  order(w, 0, 'attack', [mortar], { target: centre.id });
  const ev = until(w, 300, 'impact');
  const want = u => u.maxHp - wp.dmg * NT.WARHEADS[wp.warhead][u.def.armor] *
    (1 - (1 - w.rules.splashFalloff) * Math.min(1, NT.dist(ev.x, ev.y, u.x, u.y) / wp.splashPx));
  check(!!ev && ev.hit === centre.id && ev.splash === wp.splashPx && close(centre.hp, centre.maxHp - hitDmg(mortar.def, 0, 'heavy')), 'lob: the target takes the full hit (' + centre.hp + ')');
  check(close(orth.hp, want(orth)) && close(diag.hp, want(diag)) && orth.hp < diag.hp && diag.hp < diag.maxHp, 'splash falls off with distance (1 cell: ' + orth.hp.toFixed(1) + ', diagonal: ' + diag.hp.toFixed(1) + ')');
  check(out.hp === out.maxHp, 'nothing beyond the splash radius is touched');
  check(pal.hp === pal.maxHp, 'no friendly fire from splash');
  check(close(bystander.hp, want(bystander)) && bystander.hp < bystander.maxHp, 'a neutral unit in the blast is hurt');
  sound('splash');
}
{
  // a lobbed shell lands where the target WAS; a homing rocket follows it
  for (const kind of ['tg.mortar', 'tg.lancer']) {
    const w = mkWorld(board(40, 16), { fog: false });
    const shooter = NT.spawn(w, kind, 0, 20, 12), runner = NT.spawn(w, 'tg.buggy', 1, 2, kind === 'tg.mortar' ? 6 : 8);
    stance(w, 0, [shooter], 'hold'); stance(w, 1, [runner], 'passive');
    moveTo(w, 1, [runner], 38, runner.cy);
    const ev = until(w, 260, 'impact');
    if (shooter.def.weapons[0].homing) {
      check(!!ev && ev.hit === runner.id && close(runner.hp, runner.maxHp - hitDmg(shooter.def, 0, runner.def.armor)), 'a homing rocket hits a moving target (hp ' + runner.hp + ')');
    } else {
      check(!!ev && ev.hit === 0 && runner.hp === runner.maxHp && NT.dist(ev.x, ev.y, runner.x, runner.y) > shooter.def.weapons[0].splashPx, 'a lobbed shell misses a fast mover completely');
    }
    sound('movers');
  }
}
{
  // healing: wounds are dealt by a real enemy, then the medic walks over
  const w = mkWorld(board(24, 12));
  const g = NT.spawn(w, 'tg.grunt', 0, 6, 5), tk = NT.spawn(w, 'tg.tank', 0, 6, 7), medic = NT.spawn(w, 'tg.medic', 0, 1, 6);
  const foe = NT.spawn(w, 'tg.tank', 1, 10, 6), heal = medic.def.weapons[0];
  stance(w, 0, [g, tk], 'passive'); stance(w, 1, [foe], 'hold');
  order(w, 1, 'attack', [foe], { target: g.id });
  go(w, 200, () => g.hp < g.maxHp);
  order(w, 1, 'attack', [foe], { target: tk.id });
  go(w, 200, () => tk.hp < tk.maxHp);
  order(w, 1, 'stop', [foe]); stance(w, 1, [foe], 'passive');
  go(w, 40);
  const hp0 = g.hp, thp = tk.hp;
  check(hp0 < g.maxHp && thp < tk.maxHp && g.alive, 'setup: a grunt and a tank were wounded in a fight');
  go(w, 40);
  check(g.hp === hp0 && medic.cx === 1, 'a medic out of reach heals nobody and does not wander off');
  moveTo(w, 0, [medic], 5, 6);
  let over = 0, big = 0, last = g.hp;
  const n = go(w, 400, () => { if (g.hp > g.maxHp) over++; if (g.hp - last > heal.dmg + 1e-6) big++; last = g.hp; return g.hp >= g.maxHp; });
  check(g.hp === g.maxHp && over === 0 && big === 0, 'heal restores hp in steps of at most ' + heal.dmg + ' and never past the maximum (' + n + ' ticks)');
  check(tk.hp === thp, 'only allies carrying one of the heal tags are treated (the tank is not ' + heal.healTags.join('/') + ')');
  NT.drainEvents(w);
  let fires = 0;
  go(w, 60, () => { for (const ev of NT.drainEvents(w)) if (ev.t === 'fire' && ev.id === medic.id) fires++; return false; });
  check(fires === 0 && !medic.target && foe.hp === foe.maxHp, 'the medic stops when everyone is patched up and never shoots the enemy');
  sound('heal');
}

// ---------------------------------------------------------------------------
section('combat: buildings, stances, leash, attack-move, attack orders, veterancy, turf');
{
  // a sentry gun defends itself against whoever walks into range
  const w = mkWorld(board(24, 12)), sentry = NT.spawn(w, 'tg.sentry', 0, 10, 5), foe = NT.spawn(w, 'tg.grunt', 1, 2, 5);
  NT.spawn(w, 'tg.cell', 0, 21, 9);                           // the gun draws power (econ.js): give it a supply
  stance(w, 1, [foe], 'passive');
  moveTo(w, 1, [foe], 8, 5);
  let bad = 0, shots = 0;
  const n = go(w, 300, () => {
    for (const ev of NT.drainEvents(w)) if (ev.t === 'fire' && ev.id === sentry.id) { shots++; if (NT.distTo(ev.tx, ev.ty, sentry) > sentry.def.weapons[0].rangePx + 1e-6) bad++; }
    return !foe.alive;
  });
  check(!foe.alive && shots > 0 && bad === 0 && sentry.kills === 1, 'a sentry building shoots an intruder dead, every shot inside its range (' + shots + ' shots, ' + n + ' ticks)');
  sound('sentry');
}
{
  // hold: never moves, even while being shot from outside its own range
  const w = mkWorld(board(24, 12)), g = NT.spawn(w, 'tg.grunt', 0, 5, 5), foe = NT.spawn(w, 'tg.lancer', 1, 10, 5);
  check(foe.def.weapons[0].range > g.def.weapons[0].range && g.def.sight >= 5, 'setup: the lancer outranges the grunt, in plain sight');
  stance(w, 0, [g], 'hold'); stance(w, 1, [foe], 'hold');
  let moved = 0, fires = 0;
  go(w, 300, () => { if (g.alive && (g.cx !== 5 || g.cy !== 5 || g.hopT >= 0)) moved++; for (const ev of NT.drainEvents(w)) if (ev.t === 'fire' && ev.id === g.id) fires++; return !g.alive; });
  check(moved === 0 && fires === 0 && !g.alive && foe.hp === foe.maxHp, 'hold stance never moves: it is shot dead where it stands rather than chase');
  sound('hold');
}
{
  // aggressive: chases what it sees, but only rules.leash cells from its post, then walks back.
  // The runner is as fast as the chaser (never in range); passive spotters keep it in sight all the way.
  const w = mkWorld(board(50, 20)), g = NT.spawn(w, 'tg.grunt', 0, 5, 10), runner = NT.spawn(w, 'tg.grunt', 1, 10, 10);
  const spotters = [NT.spawn(w, 'tg.grunt', 0, 14, 14), NT.spawn(w, 'tg.grunt', 0, 21, 14), NT.spawn(w, 'tg.grunt', 0, 28, 14)];
  stance(w, 0, spotters, 'passive'); stance(w, 1, [runner], 'passive');
  moveTo(w, 1, [runner], 45, 10);
  let far = 0, seenAtDrop = false, had = false;
  const n = go(w, 600, () => {
    far = Math.max(far, NT.dist(g.x, g.y, at(5), at(10)) / T);
    if (g.target) had = true; else if (had && !seenAtDrop) seenAtDrop = NT.Fog.canSee(w, 0, runner);
    return had && !g.target && idle(g) && g.cx === 5 && g.cy === 10;
  });
  check(had && far > 3, 'an aggressive unit chases an enemy it sees (' + far.toFixed(1) + ' cells from its post)');
  check(far <= w.rules.leash + 1.5 && seenAtDrop, 'it gives up at the leash (' + w.rules.leash + ' cells) although the enemy is still in sight');
  check(g.cx === 5 && g.cy === 10 && idle(g) && runner.hp === runner.maxHp, 'and walks back to its post (' + n + ' ticks)');
  go(w, 100);
  check(g.cx === 5 && g.cy === 10 && spotters.every(s => idle(s) && !s.target), 'passive units never joined in');
  sound('leash');
}
{
  // a move order ends where it ends: fighting at the destination must not send the unit back to its old post
  const w = mkWorld(board(30, 8)), g = NT.spawn(w, 'tg.grunt', 0, 2, 3), foe = NT.spawn(w, 'tg.grunt', 1, 26, 3);
  stance(w, 1, [foe], 'passive');
  moveTo(w, 0, [g], 23, 3);
  go(w, 600, () => !foe.alive);
  go(w, 200);
  check(!foe.alive && g.cx === 23 && g.cy === 3 && idle(g), 'after a move and a fight on arrival the unit keeps its new post');
  sound('post');
}
{
  // attack-move: engage what turns up on the way, then carry on and arrive
  const w = mkWorld(board(36, 12));
  const us = [NT.spawn(w, 'tg.grunt', 0, 3, 4), NT.spawn(w, 'tg.grunt', 0, 3, 5), NT.spawn(w, 'tg.grunt', 0, 3, 6)], foe = NT.spawn(w, 'tg.grunt', 1, 16, 7);
  stance(w, 1, [foe], 'hold');
  order(w, 0, 'amove', us, { x: at(30), y: at(5) });
  let deadAt = 0, where = -1;
  const n = go(w, 900, () => { if (!foe.alive && !deadAt) { deadAt = w.tick; where = Math.max(...us.map(u => u.cx)); } return us.every(u => !u.alive || idle(u)); });
  check(deadAt > 0 && where < 20, 'attack-move: the squad stops to kill an enemy near the road (tick ' + deadAt + ', column at x=' + where + ')');
  check(us.every(u => u.alive && idle(u) && cheb(u, 30, 5) <= 1) && n < 600, 'then resumes and arrives (' + n + ' ticks)');
  sound('attack-move');
  const w2 = mkWorld(board(36, 12)), u2 = NT.spawn(w2, 'tg.grunt', 0, 3, 5), f2 = NT.spawn(w2, 'tg.grunt', 1, 16, 7);
  stance(w2, 1, [f2], 'passive');
  moveTo(w2, 0, [u2], 30, 5);
  const n2 = go(w2, 900, () => idle(u2));
  check(u2.cx === 30 && f2.hp === f2.maxHp && n2 <= 27 * T / u2.def.move.speedPx + 3, 'a plain move walks past the same enemy without stopping (' + n2 + ' ticks)');
  sound('plain move');
}
{
  // explicit attack: no leash. The prey drives 20 cells away; the tank follows and finishes it there.
  const w = mkWorld(board(50, 12), { fog: false }), tank = NT.spawn(w, 'tg.tank', 0, 3, 5), prey = NT.spawn(w, 'tg.hauler', 1, 8, 5);
  order(w, 0, 'attack', [tank], { target: prey.id });
  moveTo(w, 1, [prey], 30, 5);
  let by = -1;
  const n = go(w, 1200, () => { for (const ev of NT.drainEvents(w)) if (ev.t === 'death' && ev.id === prey.id) by = ev.by; return !prey.alive && idle(tank); });
  check(!prey.alive && by === tank.id && tank.kills === 1, 'attack order: the target is hunted down and killed (' + n + ' ticks)');
  check(tank.cx - 3 > w.rules.leash + 3 && !tank.order && !tank.target, 'far beyond the leash (' + (tank.cx - 3) + ' cells), and the order ends with the target');
  sound('attack chase');

  // with fog: the order needs a visible target and ends when it is lost
  const w2 = mkWorld(board(50, 12)), g = NT.spawn(w2, 'tg.grunt', 0, 3, 5), b = NT.spawn(w2, 'tg.buggy', 1, 8, 5), unseen = NT.spawn(w2, 'tg.grunt', 1, 40, 2);
  stance(w2, 1, [b], 'passive');
  order(w2, 0, 'attack', [g], { target: unseen.id });
  NT.step(w2);
  check(!g.order, 'an attack order on something my team cannot see is ignored');
  order(w2, 0, 'attack', [g], { target: b.id });
  NT.step(w2);
  check(g.order && g.order.type === 'attack' && g.target === b.id, 'on a visible enemy it is taken');
  moveTo(w2, 1, [b], 45, 5);
  const n2 = go(w2, 400, () => !g.order);
  check(!g.order && b.alive && n2 < 100, 'and it ends when the target drives out of sight (' + n2 + ' ticks)');
  // visibility is "as of the latest fog pass": give the passes a moment, then it must be gone for good
  go(w2, 3 * w2.rules.fogEvery);
  let seen = 0;
  go(w2, 100, () => { if (NT.Fog.canSee(w2, 0, b)) seen++; return false; });
  check(seen === 0 && idle(g) && !g.target && g.cx < 12, 'the target stays lost and the unit stays where it lost it');
  sound('attack orders');

  // a weapon that cannot hit the target at all: the order is ignored
  const w3 = mkWorld(board(20, 10)), tk = NT.spawn(w3, 'tg.tank', 0, 3, 5), fly = NT.spawn(w3, 'tg.flyer', 1, 6, 5);
  stance(w3, 1, [fly], 'passive');
  check(!tk.def.weapons.some(x => x.air), 'setup: the tank gun cannot hit air');
  order(w3, 0, 'attack', [tk], { target: fly.id });
  go(w3, 60);
  check(!tk.order && !tk.target && fly.hp === fly.maxHp && tk.cx === 3, 'a unit with no weapon able to hit the target ignores the order (and never auto-targets it)');
  sound('unhittable');
}
{
  // veterancy: xp = victim cost; rank up at rules.vetXp[rank] x own cost; capped at the last rank
  const w = mkWorld(board(24, 12)), l = NT.spawn(w, 'tg.lancer', 0, 5, 5), need = w.rules.vetXp.map(x => x * l.def.cost);
  const vs = [NT.spawn(w, 'tg.mortar', 1, 9, 4), NT.spawn(w, 'tg.mortar', 1, 9, 5), NT.spawn(w, 'tg.mortar', 1, 9, 6)], cost = vs[0].def.cost;
  check(cost >= need[0] && cost < need[1] && 2 * cost >= need[1], 'setup: one kill is worth rank 1, two are worth rank 2');
  stance(w, 1, vs, 'passive');
  order(w, 0, 'attack', [l], { target: vs[0].id });
  order(w, 0, 'attack', [l], { target: vs[1].id, queue: true });
  order(w, 0, 'attack', [l], { target: vs[2].id, queue: true });
  const ranks = [];
  go(w, 1500, () => { for (const ev of NT.drainEvents(w)) if (ev.t === 'rank' && ev.id === l.id) ranks.push(ev.rank + ':' + l.kills + ':' + l.xp); return vs.every(v => !v.alive); });
  check(ranks.join(' ') === '1:1:' + cost + ' 2:2:' + 2 * cost, 'kills turn into xp and xp into rank, one "rank" event per step (' + ranks.join(' ') + ')');
  check(l.kills === 3 && l.xp === 3 * cost && l.rank === w.rules.vetXp.length, 'rank stops at ' + w.rules.vetXp.length + ' while xp keeps counting; queued attack orders ran in turn');
  sound('rank');
}
{
  // turf: neutral capturables cannot be hurt; owned ones flip back to neutral at 0 hp instead of dying
  const turf = Object.values(NT.DEFS).filter(d => d.kind === 'building' && d.traits.capturable && d.traits.capturable.revert).sort((a, b) => a.hp - b.hp)[0];
  check(!!turf, 'some faction file defines a capturable structure that reverts');
  const w = mkWorld(board(30, 14), { fog: false });
  const shop = NT.spawn(w, turf, NT.NEUTRAL, 14, 6), foe = NT.spawn(w, 'tg.tank', 1, 14 + turf.size[0], 6), mortar = NT.spawn(w, 'tg.mortar', 0, 6, 6);
  stance(w, 1, [foe], 'passive'); stance(w, 0, [mortar], 'hold');
  order(w, 0, 'attack', [mortar], { target: shop.id });
  NT.step(w);
  check(!mortar.order, 'neutral turf cannot be given as an attack target');
  order(w, 0, 'attack', [mortar], { target: foe.id });
  const ev = until(w, 300, 'impact');
  check(!!ev && NT.distTo(ev.x, ev.y, shop) < mortar.def.weapons[0].splashPx && foe.hp < foe.maxHp && shop.hp === shop.maxHp, 'neutral turf inside a blast takes no damage');
  sound('neutral turf');

  const w2 = mkWorld(board(30, 14)), owned = NT.spawn(w2, turf, 1, 14, 6), tanks = [0, 1, 2, 3].map(i => NT.spawn(w2, 'tg.tank', 0, 9, 4 + i));
  check(w2.players[1].owned[turf.id] === 1, 'setup: player 2 holds the turf');
  order(w2, 0, 'attack', tanks, { target: owned.id });
  const evs = [];
  const n = go(w2, 1500, () => { for (const e of NT.drainEvents(w2)) if (e.t === 'captured' || e.t === 'death') evs.push(e); return owned.owner === NT.NEUTRAL; });
  check(owned.alive && owned.owner === NT.NEUTRAL && close(owned.hp, turf.traits.capturable.revertHp * owned.maxHp), 'owned turf beaten to 0 hp reverts to neutral at revertHp (' + owned.hp + ' hp, ' + n + ' ticks)');
  check(evs.length === 1 && evs[0].t === 'captured' && evs[0].from === 1 && evs[0].to === NT.NEUTRAL && !w2.players[1].owned[turf.id], 'a "captured" event, no death, counters follow');
  go(w2, 120);
  check(close(owned.hp, turf.traits.capturable.revertHp * owned.maxHp) && tanks.every(t => idle(t) && !t.target && t.kills === 0), 'the attackers stand down: it is nobody\'s enemy now and takes no more damage');
  sound('revert');
}

// ---------------------------------------------------------------------------
section('fog: sight circles, explored memory, targets need vision, reveal');
{
  const w = mkWorld(board(40, 24)), g = NT.spawn(w, 'tg.grunt', 0, 10, 10), s = g.def.sight, team = w.players[0].team, other = w.players[1].team;
  const V = (x, y, t) => NT.Fog.visible(w, t === undefined ? team : t, x, y), E = (x, y) => NT.Fog.explored(w, team, x, y);
  check(w.fogEnabled && V(10, 10) && V(10 + s, 10) && !V(10 + s + 1, 10) && V(10, 10 - s) && !V(10, 10 - s - 1), 'tick 0: a unit sees exactly its sight radius (' + s + ' cells) along the axes');
  const dIn = Math.floor(s / Math.SQRT2), dOut = dIn + 1;
  check(V(10 + dIn, 10 + dIn) && !V(10 + dOut, 10 + dOut), 'and a circle, not a square, on the diagonals');
  let cells = 0;
  for (let y = 0; y < w.h; y++) for (let x = 0; x < w.w; x++) if (V(x, y)) cells++;
  check(cells === NT.circleOffsets(s).length, 'the visible area is NT.circleOffsets(sight) (' + cells + ' cells)');
  check(!V(10, 10, other) && !NT.Fog.explored(w, other, 10, 10), 'the other team sees none of it');
  check(NT.Fog.canSee(w, team, g) && !NT.Fog.canSee(w, other, g), 'canSee: own units always, enemy units only in sight');
  const pal = NT.spawn(w, 'tg.grunt', 0, 11, 10);
  check(w.teams[team].vis[10 * w.w + 10] === 2, 'vis counts the sight sources of a cell (a fresh spawn is stamped at once)');

  moveTo(w, 0, [g, pal], 30, 10);
  go(w, 400, () => idle(g) && idle(pal));
  go(w, 2 * w.rules.fogEvery);
  check(!V(10, 10) && E(10, 10) && V(30, 10), 'explored sticks after the unit has walked away; sight moved with it');
  check(!E(10, 22) && !V(10, 22), 'ground nobody ever saw stays unexplored');

  // buildings look from the footprint centre, sight + half the footprint
  const core = NT.spawn(w, 'tg.core', 0, 4, 16), r = Math.floor(core.def.sight + Math.max(core.w, core.h) / 2), mx = 4 + ((core.w - 1) >> 1), my = 16 + ((core.h - 1) >> 1);
  go(w, 2 * w.rules.fogEvery);
  check(V(mx + r, my) && !V(mx + r + 1, my), 'a building sees sight + half its footprint from its centre (' + r + ' cells)');
  sound('fog');
}
{
  // weapon range beyond own sight: no vision, no target — until somebody on the team spots it
  const w = mkWorld(board(40, 24)), sentry = NT.spawn(w, 'tg.sentry', 0, 10, 10), wp = sentry.def.weapons[0], reach = wp.range, dx = Math.floor(reach);
  check(reach > sentry.def.sight + Math.max(sentry.w, sentry.h) / 2, 'setup: the fixture sentry outranges its own sight');
  const foe = NT.spawn(w, 'tg.tank', 1, 10 + dx, 10);
  NT.spawn(w, 'tg.cell', 0, 36, 20);                          // power for the gun, far out of everybody's sight
  stance(w, 1, [foe], 'passive');
  let fires = 0;
  const count = () => { for (const ev of NT.drainEvents(w)) if (ev.t === 'fire' && ev.id === sentry.id) fires++; return false; };
  go(w, 80, count);
  check(NT.entDist(sentry, foe) <= wp.rangePx && !NT.Fog.canSee(w, 0, foe) && fires === 0 && foe.hp === foe.maxHp && !sentry.target,
    'an enemy inside weapon range but outside the team\'s vision is not auto-targeted');
  const spotter = NT.spawn(w, 'tg.grunt', 0, 10 + dx - 2, 14);
  stance(w, 0, [spotter], 'passive');
  go(w, 40, count);
  check(NT.Fog.canSee(w, 0, foe) && fires > 0 && foe.hp < foe.maxHp && sentry.target === foe.id, 'once a team-mate sees it, the gun opens up (' + fires + ' shots)');
  sound('fog targets');

  // the same stand-off with fog switched off: everything is visible to everybody
  const w2 = mkWorld(board(40, 24), { fog: false }), s2 = NT.spawn(w2, 'tg.sentry', 0, 10, 10), f2 = NT.spawn(w2, 'tg.tank', 1, 10 + dx, 10);
  NT.spawn(w2, 'tg.cell', 0, 36, 20);
  stance(w2, 1, [f2], 'passive');
  go(w2, 40);
  check(NT.Fog.visible(w2, 0, 39, 23) && NT.Fog.explored(w2, 0, 39, 23) && NT.Fog.canSee(w2, 0, f2) && f2.hp < f2.maxHp && s2.target === f2.id, 'fog off: visible / explored / canSee are always true and the gun fires at once');
  sound('fog off');
}
{
  // reveal: a temporary sight source
  const w = mkWorld(board(40, 24)), far = NT.spawn(w, 'tg.grunt', 1, 30, 12), R = 3, ticks = 40;
  NT.spawn(w, 'tg.grunt', 0, 2, 2);
  check(!NT.Fog.visible(w, 0, 30, 12) && !NT.Fog.canSee(w, 0, far), 'before: the far corner is dark');
  NT.Fog.reveal(w, 0, at(30), at(12), R * T, ticks);
  check(NT.Fog.visible(w, 0, 30, 12) && NT.Fog.visible(w, 0, 30 + R, 12) && !NT.Fog.visible(w, 0, 30 + R + 1, 12) && NT.Fog.canSee(w, 0, far), 'reveal() lights its radius at once (' + R + ' cells)');
  go(w, ticks - 8);
  check(NT.Fog.visible(w, 0, 30, 12) && NT.Fog.canSee(w, 0, far), 'it survives the fog passes while it lasts');
  go(w, 8 + w.rules.fogEvery);
  check(!NT.Fog.visible(w, 0, 30, 12) && !NT.Fog.canSee(w, 0, far) && NT.Fog.explored(w, 0, 30, 12), 'and expires: dark again, but remembered as explored');
  sound('reveal');
}

// ---------------------------------------------------------------------------
section('combat: on-hit slow (weapons found generically in the faction data)');
{
  // The fixture has no onHit weapon, so take whatever the loaded factions offer: a unit, ranged, no bracing needed.
  // Those files belong to other people: if none of them has such a weapon the scenario is skipped (and says so).
  const slowOf = u => u.buffs.find(b => b.id === 'slow');
  const find = filtered => {
    for (const id in NT.DEFS) {
      const d = NT.DEFS[id];
      if (d.kind !== 'unit') continue;
      for (let wi = 0; wi < d.weapons.length; wi++) {
        const wp = d.weapons[wi], sl = wp.onHit && wp.onHit.slow;
        if (sl && !wp.heal && !wp.needsBrace && wp.ground && wp.proj !== 'melee' && !!sl.armor === filtered) return { d: d, wp: wp, sl: sl };
      }
    }
    return null;
  };
  const victims = ['tg.tank', 'tg.buggy', 'tg.grunt'].map(k => NT.DEFS[k]);
  const any = find(false) || find(true);
  if (!any) console.log('  (skipped: no ranged unit weapon with onHit.slow in the loaded faction data)');
  else {
    const sl = any.sl, vdef = victims.find(v => !sl.armor || sl.armor.indexOf(v.armor) >= 0), w = mkWorld(board(40, 9));
    const shooter = NT.spawn(w, any.d, 0, 5, 4), v = NT.spawn(w, vdef, 1, 5 + Math.max(2, Math.floor(any.wp.range) - 1), 4);
    stance(w, 0, [shooter], 'hold'); stance(w, 1, [v], 'passive');
    go(w, 200, () => !!slowOf(v));
    const b = slowOf(v);
    check(!!b && b.speed === sl.mult && b.until === v.lastHurt + sl.durT, any.d.id + ' hit: {id:"slow", until: hit + ' + sl.durT + ', speed: ' + sl.mult + '} is pushed onto the victim');
    check(NT.Move.slow(w, v) === sl.mult, 'NT.Move.slow reports it');
    moveTo(w, 1, [v], 36, 4);
    go(w, 6);
    let x0 = v.x;
    go(w, 5);
    check(!!slowOf(v) && close((v.x - x0) / 5, vdef.move.speedPx * sl.mult), 'movement honours the slow: ' + ((v.x - x0) / 5).toFixed(3) + ' px/tick instead of ' + vdef.move.speedPx.toFixed(3));
    go(w, 300, () => !slowOf(v));
    go(w, 6);
    x0 = v.x;
    go(w, 5);
    check(!slowOf(v) && NT.Move.slow(w, v) === 1 && close((v.x - x0) / 5, vdef.move.speedPx), 'out of reach the buff runs out, is pruned, and full speed returns');
    sound('slow');
  }
  const picky = find(true);
  if (!picky) console.log('  (skipped: no slow limited to armor classes in the loaded faction data)');
  const spared = picky && victims.find(v => picky.sl.armor.indexOf(v.armor) < 0);
  if (picky && spared) {
    const w = mkWorld(board(40, 9)), shooter = NT.spawn(w, picky.d, 0, 5, 4), v = NT.spawn(w, spared, 1, 5 + Math.max(2, Math.floor(picky.wp.range) - 1), 4);
    stance(w, 0, [shooter], 'hold'); stance(w, 1, [v], 'passive');
    let buffed = 0;
    go(w, 120, () => { if (slowOf(v)) buffed++; return !v.alive; });
    check(v.hp < v.maxHp && buffed === 0, picky.d.id + ' vs ' + spared.armor + ' armor: the hit lands but slow.armor (' + picky.sl.armor.join('/') + ') spares it');
    sound('slow filter');
  }
}

// ---------------------------------------------------------------------------
section('determinism + performance: scripted battles, fog on');
const ARMY = ['tg.grunt', 'tg.grunt', 'tg.lancer', 'tg.tank', 'tg.buggy', 'tg.grunt', 'tg.medic', 'tg.mortar', 'tg.brawler', 'tg.flyer'];
{
  // 40 v 40 mixed units + a sentry each, 600 ticks, a fixed script of commands. Every shot is audited on the way.
  const battle = () => {
    const w = mkWorld(board(48, 32, (x, y) => ((x === 23 || x === 24) && (y < 8 || (y > 13 && y < 19) || y > 25)) ? '#' : (x > 20 && x < 27 && y === 22) ? '~' : null), { seed: 77 });
    const side = [[], []], defOf = {};
    for (let p = 0; p < 2; p++) for (let i = 0; i < 40; i++) {
      const u = NT.spawn(w, ARMY[i % ARMY.length], p, p ? 42 - (i % 5) : 5 + (i % 5), 4 + ((i / 5) | 0) * 3);
      side[p].push(u); defOf[u.id] = u.def;
    }
    for (let p = 0; p < 2; p++) { const s = NT.spawn(w, 'tg.sentry', p, p ? 30 : 17, 16); defOf[s.id] = s.def; NT.spawn(w, 'tg.cell', p, p ? 45 : 1, 15); }
    const hashes = [], st = { deaths: 0, fires: 0, outOfRange: 0 };
    for (let t = 0; t < 600; t++) {
      if (t === 0) { order(w, 0, 'amove', side[0], { x: at(30), y: at(16) }); order(w, 1, 'amove', side[1], { x: at(17), y: at(16) }); }
      if (t === 60) stance(w, 0, side[0].slice(0, 8), 'hold');
      if (t === 120) order(w, 1, 'attack', side[1].slice(0, 10), { target: side[0][3].id });
      if (t === 200) order(w, 0, 'stop', side[0].slice(8, 14));
      if (t === 260) { moveTo(w, 0, side[0].slice(14, 24), 20, 4); moveTo(w, 1, side[1].slice(20, 30), 28, 28, { queue: true }); }
      if (t === 340) { order(w, 0, 'amove', side[0], { x: at(40), y: at(16) }); stance(w, 1, side[1].slice(30), 'passive'); }
      if (t === 460) order(w, 1, 'amove', side[1], { x: at(8), y: at(16) });
      go(w, 1);
      for (const ev of NT.drainEvents(w)) {
        if (ev.t === 'death') st.deaths++;
        if (ev.t !== 'fire') continue;
        st.fires++;
        // range is measured the way the engine measures it: to a building's footprint, between unit centres otherwise
        const d = defOf[ev.id], wp = d.weapons[ev.wi], sh = w.byId.get(ev.id), tg = w.byId.get(ev.target);
        if ((d.kind === 'building' && !sh) || !tg) continue;
        const dist = d.kind === 'building' ? NT.distTo(ev.tx, ev.ty, sh) : tg.kind === 'building' ? NT.distTo(ev.x, ev.y, tg) : NT.dist(ev.x, ev.y, ev.tx, ev.ty);
        const touching = wp.proj === 'melee' && dist <= 2.3 * T;        // melee reaches any touching cell whatever the slots
        if (!touching && (dist > wp.rangePx + 1e-6 || dist < wp.minRangePx - 1e-6)) st.outOfRange++;
      }
      if (w.tick % 50 === 0) hashes.push(NT.hashWorld(w));
    }
    return { hashes: hashes, st: st };
  };
  const a = battle(), b = battle();
  check(a.hashes.length === 12 && a.hashes.join() === b.hashes.join(), 'the same scripted 600-tick battle run twice: identical NT.hashWorld every 50 ticks');
  check(new Set(a.hashes).size === 12 && a.st.deaths > 20 && a.st.fires > 200, 'and it was a real battle (' + a.st.deaths + ' deaths, ' + a.st.fires + ' shots)');
  check(a.st.outOfRange === 0, 'every one of those shots was fired inside [minRange, range] (' + a.st.outOfRange + ' were not)');
  sound('battle');
}
{
  // 100 v 100 on 64x64. Only NT.step is timed; debugCheck runs outside the clock.
  const w = mkWorld(board(64, 64, (x, y) => ((x % 16 === 7 || x % 16 === 8) && y % 12 > 3 && y % 12 < 9) ? '#' : null), { seed: 5 });
  const side = [[], []];
  for (let p = 0; p < 2; p++) for (let i = 0; i < 100; i++) side[p].push(NT.spawn(w, ARMY[i % ARMY.length], p, p ? 60 - (i % 10) : 3 + (i % 10), 12 + ((i / 10) | 0) * 4));
  order(w, 0, 'amove', side[0], { x: at(40), y: at(32) }); order(w, 1, 'amove', side[1], { x: at(23), y: at(32) });
  let total = 0, max = 0, busy = 0, busyN = 0;
  for (let t = 0; t < 600; t++) {
    if (t === 300) { order(w, 0, 'amove', side[0], { x: at(55), y: at(32) }); order(w, 1, 'amove', side[1], { x: at(8), y: at(32) }); }
    const crowd = w.ents.length, t0 = process.hrtime.bigint();
    NT.step(w);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    total += ms; if (ms > max) max = ms;
    if (crowd >= 150) { busy += ms; busyN++; }
    if (w.tick % 10 === 0) for (const m of NT.debugCheck(w)) if (dbg.length < 6) dbg.push(m);
    NT.drainEvents(w);
  }
  const avg = total / 600, heavy = busyN ? busy / busyN : 0, left = side.map(s => s.filter(u => u.alive).length);
  console.log('  perf 100 v 100, 64x64, 600 ticks: avg ' + avg.toFixed(3) + ' ms, max ' + max.toFixed(2) + ' ms per NT.step' +
    ' (avg ' + heavy.toFixed(3) + ' ms over the ' + busyN + ' ticks with >= 150 units alive; survivors ' + left.join(' v ') + ')');
  check(busyN > 50 && left[0] + left[1] < 150, 'the armies really met');
  check(avg < 4 && heavy < 4, 'average step under the 4 ms target (' + avg.toFixed(3) + ' ms, ' + heavy.toFixed(3) + ' ms while crowded)');
  check(max < 36, 'worst step ' + max.toFixed(2) + ' ms (target < 12 ms; the gate only fails beyond 36 ms so a GC pause cannot turn it red)');
  sound('brawl');
}

// ===========================================================================
// SIM CORE II — melee audit, econ.js, prod.js, traits.js, powers.js, victory.js
// ===========================================================================
// Every ground melee unit of every loaded faction (found generically) plus the fixture's brawler.
const MELEE = Object.values(NT.DEFS).filter(d => d.kind === 'unit' && d.layer === 'ground' && d.weapons.some(wp => wp.proj === 'melee' && wp.ground && !wp.heal));
const AIR_MELEE = Object.values(NT.DEFS).filter(d => d.kind === 'unit' && d.layer === 'air' && d.weapons.some(wp => wp.proj === 'melee'));
const fired = (w, n, pred) => {                                 // step n ticks; returns Map shooter id -> Set of target ids hit
  const m = new Map();
  go(w, n, () => {
    for (const ev of NT.drainEvents(w)) if (ev.t === 'fire') { if (!m.has(ev.id)) m.set(ev.id, new Set()); m.get(ev.id).add(ev.target); }
    return pred ? pred(w) : false;
  });
  return m;
};

section('melee audit: every melee unit connects from every touching cell, by order and on its own');
{
  let bad = [];
  for (const d of MELEE) {
    for (const mode of ['attack', 'auto']) {
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        if (!ox && !oy && d.body !== 'small') continue;               // a large body owns its whole cell
        const w = mkWorld(board(14, 14));
        const a = NT.spawn(w, d, 0, 6, 6, { exact: true }), v = NT.spawn(w, 'tg.grunt', 1, 6 + ox, 6 + oy, { exact: true });
        if (!a || !v) { bad.push(d.id + ' setup ' + ox + ',' + oy); continue; }
        stance(w, 1, [v], 'passive');
        if (mode === 'attack') order(w, 0, 'attack', [a], { target: v.id });
        const n = go(w, 400, () => !v.alive);
        if (v.alive || cheb(a, 6, 6) > 1) bad.push(d.id + ' ' + mode + ' at ' + ox + ',' + oy + (v.alive ? ' never killed it (hp ' + v.hp.toFixed(0) + ')' : ' wandered off'));
        else if (n > 300) bad.push(d.id + ' ' + mode + ' at ' + ox + ',' + oy + ' took ' + n + ' ticks');
      }
    }
  }
  check(MELEE.length >= 2 && bad.length === 0, MELEE.length + ' melee defs x 9 cells x {attack order, auto-acquire}: every adjacent grunt dies without the attacker leaving\n    ' + bad.slice(0, 8).join('\n    '));
  sound('melee adjacency');
}
{
  // 12 small melee bodies vs one big body and vs a 3x3 structure: they surround it and everyone in touch deals damage
  for (const d of MELEE.filter(d => d.body === 'small').slice(0, 3)) {
    for (const vic of ['tg.tank', 'tg.core']) {
      const w = mkWorld(board(30, 24), { fog: false });
      const v = NT.spawn(w, vic, 1, 15, 10, { exact: true }), as = [];
      v.hp = v.maxHp = 1e6;
      if (v.kind === 'unit') stance(w, 1, [v], 'passive');
      for (let i = 0; i < 12; i++) as.push(NT.spawn(w, d, 0, 3 + (i % 4), 4 + ((i / 4) | 0)));
      order(w, 0, 'attack', as, { target: v.id });
      const hit = fired(w, 500);
      const hitters = as.filter(a => hit.has(a.id) && hit.get(a.id).has(v.id)).length, cells = new Set(as.map(a => a.cx + ',' + a.cy)).size;
      check(hitters === 12 && cells >= 3, '12 ' + d.id + ' vs ' + vic + ': all 12 land blows (' + hitters + '), spread over ' + cells + ' cells');
      sound('melee crowd ' + d.id + ' ' + vic);
    }
  }
}
{
  // large melee bodies vs infantry packed 5 to a cell, vs large bodies, vs a structure
  const big = MELEE.filter(d => d.body === 'large');
  for (const d of big) {
    let w = mkWorld(board(30, 20), { fog: false });
    const vs = [];
    for (let i = 0; i < 10; i++) vs.push(NT.spawn(w, 'tg.grunt', 1, 18 + (i < 5 ? 0 : 1), 10, { exact: true }));
    stance(w, 1, vs, 'passive');
    const as = [0, 1, 2, 3].map(i => NT.spawn(w, d, 0, 4, 7 + i * 2));
    order(w, 0, 'amove', as, { x: at(19), y: at(10) });
    go(w, 900, () => vs.every(v => !v.alive));
    check(vs.every(v => !v.alive) && vs.filter(v => v.cx === 18).length === 5, '4 ' + d.id + ' wipe out 10 grunts packed 5 to a cell');
    sound('melee big vs packed');
    w = mkWorld(board(30, 20), { fog: false });
    const tanks = [NT.spawn(w, 'tg.buggy', 1, 18, 9), NT.spawn(w, 'tg.buggy', 1, 18, 11)], core = NT.spawn(w, 'tg.core', 1, 24, 9);
    stance(w, 1, tanks, 'passive');
    const bs = [0, 1, 2, 3].map(i => NT.spawn(w, d, 0, 4, 7 + i * 2));
    order(w, 0, 'amove', bs, { x: at(25), y: at(10) });
    go(w, 1600, () => !core.alive || core.hp < core.maxHp * 0.6);
    check(tanks.every(t => !t.alive) && core.hp < core.maxHp, d.id + ': kills two vehicles, then batters a structure (' + (core.hp / core.maxHp * 100).toFixed(0) + '% left)');
    sound('melee big vs big');
  }
}
{
  // chase a target that walks away; the next target after a kill; give up on one it cannot reach
  const d = NT.DEFS['tg.brawler'];
  let w = mkWorld(board(40, 10));
  const a = NT.spawn(w, d, 0, 4, 4), v = NT.spawn(w, 'tg.grunt', 1, 7, 4);
  stance(w, 1, [v], 'passive');
  order(w, 0, 'attack', [a], { target: v.id });
  go(w, 2);
  moveTo(w, 1, [v], 38, 4);
  go(w, 600, () => !v.alive);
  check(!v.alive && v.cx > 9, 'a brawler runs down a grunt walking away and kills it (at x=' + v.cx + ')');
  sound('melee chase');
  w = mkWorld(board(20, 12));
  const b = NT.spawn(w, d, 0, 5, 5), v1 = NT.spawn(w, 'tg.grunt', 1, 6, 5), v2 = NT.spawn(w, 'tg.grunt', 1, 9, 7);
  stance(w, 1, [v1, v2], 'passive');
  go(w, 900, () => !v1.alive && !v2.alive);
  check(!v1.alive && !v2.alive, 'an idle brawler kills the grunt beside it, then acquires and kills the next one');
  sound('melee next target');
  // the nearest enemy sits on an island across water: the brawler gives up on it and takes the reachable one
  w = mkWorld(board(24, 14, (x, y) => (x >= 9 && x <= 13 && y >= 3 && y <= 7 && !(x === 11 && y === 5)) ? '~' : null));
  const c = NT.spawn(w, d, 0, 7, 5), isl = NT.spawn(w, 'tg.grunt', 1, 11, 5), far = NT.spawn(w, 'tg.grunt', 1, 7, 11);
  stance(w, 1, [isl, far], 'passive');
  go(w, 6);
  const first = c.target;
  go(w, 500, () => !far.alive);
  check(first === isl.id && !far.alive && isl.alive, 'unreachable nearest target (island) is dropped and the reachable one is killed');
  sound('melee unreachable');
}
{
  // flying melee (generic): hits ground and air
  if (!AIR_MELEE.length) console.log('  (skipped: no flying melee unit in the loaded data)');
  for (const d of AIR_MELEE) {
    const wp = d.weapons.find(x => x.proj === 'melee');
    for (const vic of ['tg.grunt', 'tg.flyer']) {
      const vd = NT.DEFS[vic];
      if (vd.layer === 'air' ? !wp.air : !wp.ground) continue;
      const w = mkWorld(board(20, 12), { fog: false });
      const a = NT.spawn(w, d, 0, 4, 5), v = NT.spawn(w, vd, 1, 12, 5);
      stance(w, 1, [v], 'passive');
      order(w, 0, 'attack', [a], { target: v.id });
      go(w, 900, () => !v.alive);
      check(!v.alive, d.id + ' (air melee) kills a ' + vic);
      sound('air melee');
    }
  }
}

// ---------------------------------------------------------------------------
// Economy worlds: the fixture faction, no bases unless asked, credits 0 so every credit is accounted for.
function ecoWorld(rows, opts, mapOpts) {
  return NT.createWorld(Object.assign({ map: NT.Map.fromAscii(rows, mapOpts || {}), seed: 13, noBases: true,
    players: [{ faction: 'tg', credits: 0 }, { faction: 'tg', credits: 0 }] }, opts || {}));
}
const evs = (w, n, pred) => {                                  // step n ticks collecting every event (stops early on pred(w, list))
  const all = [];
  go(w, n, () => { for (const ev of NT.drainEvents(w)) all.push(ev); return pred ? pred(w, all) : false; });
  return all;
};
const HAUL = NT.DEFS['tg.hauler'], HT = HAUL.traits.harvester, DEPOT = NT.DEFS['tg.depot'];
const fieldRows = (wd, ht, fx0, fy0, fx1, fy1, extra) => board(wd, ht, (x, y) => (x >= fx0 && x <= fx1 && y >= fy0 && y <= fy1) ? '$' : extra ? extra(x, y) : null);

section('econ: harvesters fill, deliver, share, move on, re-target, idle, park');
{
  const E = NT.Econ;
  // fill -> drive -> unload: credits rise by exactly one load, one dump event
  let w = ecoWorld(fieldRows(30, 16, 20, 6, 23, 9), { fog: false });
  const p = w.players[0], depot = NT.spawn(w, DEPOT, 0, 4, 6), h = NT.spawn(w, HAUL, 0, 9, 8);
  let list = evs(w, 2000, (w, l) => l.some(e => e.t === 'dump'));
  const dump = list.find(e => e.t === 'dump');
  check(!!dump && dump.id === h.id && dump.amount === HT.capacity && close(p.credits, HT.capacity) && close(p.stats.income, HT.capacity),
    'a lone hauler starts on its own, fills up (' + HT.capacity + '), drives home and unloads: one dump of ' + (dump && dump.amount) + ', credits ' + p.credits);
  check(!!dump && NT.touching(h, depot), 'it unloads standing on a cell touching the drop-off');
  const fieldLeft = NT.Map.totalRes(w.map);
  check(fieldLeft === 16 * 600 - HT.capacity, 'the field lost exactly what was delivered');
  go(w, 30);
  check(h.order && h.order.type === 'harvest' && (h.hstate === E.TO_FIELD || h.hstate === E.LOADING), 'and goes straight back to the field');
  // load rate: capacity / loadTimeT per tick
  go(w, 400, () => h.hstate === E.LOADING);
  const c0 = h.cargo; go(w, 40);
  check(Math.abs((h.cargo - c0) - 40 * HT.capacity / HT.loadTimeT) <= 1, 'loads capacity / loadTime per tick (' + (h.cargo - c0) + ' in 40 ticks)');
  // incomeMul scales what is harvested
  p.incomeMul = 1.5;
  const before = p.credits;
  list = evs(w, 2000, (w, l) => l.some(e => e.t === 'dump'));
  check(close(p.credits - before, HT.capacity * 1.5), 'player.incomeMul 1.5 pays 1.5x the load (' + (p.credits - before) + ')');
  sound('harvest loop');

  // two harvesters share one field for 3 simulated minutes: no deadlock, both keep earning, claims stay unique
  w = ecoWorld(fieldRows(30, 16, 20, 6, 22, 8), { fog: false });
  NT.spawn(w, DEPOT, 0, 4, 6);
  const h1 = NT.spawn(w, HAUL, 0, 9, 8), h2 = NT.spawn(w, HAUL, 0, 9, 10), dumps = { [h1.id]: 0, [h2.id]: 0 };
  let dup = 0;
  go(w, 3600, () => {
    for (const ev of NT.drainEvents(w)) if (ev.t === 'dump') dumps[ev.id]++;
    if ((h1.hstate === E.TO_FIELD || h1.hstate === E.LOADING) && (h2.hstate === E.TO_FIELD || h2.hstate === E.LOADING) && h1.hcell === h2.hcell) dup++;
    return false;
  });
  check(dumps[h1.id] >= 3 && dumps[h2.id] >= 3 && dup === 0, 'two haulers on one field for 3 minutes: ' + dumps[h1.id] + ' + ' + dumps[h2.id] + ' deliveries, never on the same cell');
  sound('shared field');

  // a field runs dry -> the hauler moves to the next field
  w = ecoWorld(fieldRows(40, 16, 12, 7, 12, 7, (x, y) => (x >= 32 && x <= 34 && y >= 6 && y <= 8) ? '$' : null), { fog: false }, { resAmount: 300 });
  NT.spawn(w, DEPOT, 0, 4, 6);
  const h3 = NT.spawn(w, HAUL, 0, 9, 8);
  go(w, 3000, () => h3.hstate === E.LOADING && h3.cx >= 32);
  check(w.map.res[7 * 40 + 12] === 0 && h3.cx >= 32 && h3.hstate === E.LOADING, 'the near cell runs dry, the hauler drives on to the far field and loads there');
  sound('next field');

  // the drop-off it is driving to is destroyed: it re-targets the other one
  w = ecoWorld(fieldRows(40, 16, 18, 6, 21, 9), { fog: false });
  const dA = NT.spawn(w, DEPOT, 0, 12, 6), dB = NT.spawn(w, DEPOT, 0, 30, 12), h4 = NT.spawn(w, HAUL, 0, 16, 8);
  go(w, 2000, () => h4.hstate === E.TO_DROP);
  check(h4.hdrop === dA.id, 'a full hauler heads for the nearest drop-off');
  NT.kill(w, dA, null);
  list = evs(w, 1500, (w, l) => l.some(e => e.t === 'dump'));
  check(list.some(e => e.t === 'dump' && e.id === h4.id) && h4.hdrop === dB.id && NT.touching(h4, dB), 'it is destroyed on the way: the hauler delivers to the other one instead');
  sound('drop-off lost');

  // no resource anywhere: idle; it regrows (spawner) -> back to work. Regrow never exceeds resCap, never under a building.
  const rows = fieldRows(30, 16, 20, 6, 23, 9);
  const map = NT.Map.fromAscii(rows, { spawners: [{ cx: 21, cy: 7, radius: 2, rate: 80 }] });
  for (let i = 0; i < map.res.length; i++) map.res[i] = 0;
  w = NT.createWorld({ map: map, seed: 3, noBases: true, fog: false, players: [{ faction: 'tg', credits: 0 }, { faction: 'tg', credits: 0 }] });
  NT.spawn(w, DEPOT, 0, 4, 6);
  const plug = NT.spawn(w, 'tg.cell', 1, 22, 8);                // a structure standing on part of the field
  const h5 = NT.spawn(w, HAUL, 0, 9, 8);
  go(w, 30);
  check(!h5.order && h5.cargo === 0, 'no resource anywhere: the hauler idles');
  let over = 0, under = 0;
  go(w, 1200, () => {
    for (let i = 0; i < map.res.length; i++) if (map.res[i] > map.resCap[i]) over++;
    for (let y = plug.cy; y < plug.cy + plug.h; y++) for (let x = plug.cx; x < plug.cx + plug.w; x++) if (map.res[y * 30 + x] > 0) under++;
    return h5.cargo > 0;
  });
  check(h5.cargo > 0 && h5.order && h5.order.type === 'harvest', 'the spawner regrows the field and the idle hauler goes back to work by itself');
  check(over === 0 && under === 0, 'regrow never exceeds resCap and never grows under a structure');
  NT.kill(w, h5, null);
  go(w, 20 * 60 * 3);
  let full = 0, cells = 0;
  for (let y = 5; y <= 10; y++) for (let x = 19; x <= 24; x++) { const i = y * 30 + x; if (map.resCap[i] && !(x >= plug.cx && x < plug.cx + 2 && y >= plug.cy && y < plug.cy + 2) && (x - 21) ** 2 + (y - 7) ** 2 <= 4.25) { cells++; if (map.res[i] === map.resCap[i]) full++; } }
  check(cells > 0 && full === cells, 'left alone the field regrows to its cap (' + full + '/' + cells + ' cells full) and stops there');
  sound('regrow');

  // the player's own move parks a hauler until it is told to harvest
  w = ecoWorld(fieldRows(30, 16, 20, 6, 23, 9), { fog: false });
  NT.spawn(w, DEPOT, 0, 4, 6);
  const h6 = NT.spawn(w, HAUL, 0, 9, 8);
  go(w, 60);
  moveTo(w, 0, [h6], 10, 13);
  go(w, 400);
  check(!h6.order && h6.cx === 10 && h6.cy === 13 && h6.hstate === E.PARKED && h6.cargo < HT.capacity, 'a move command parks the hauler where it was sent; it does not wander back');
  order(w, 0, 'harvest', [h6], { x: at(21), y: at(7) });
  go(w, 300, () => h6.hstate === E.LOADING);
  check(h6.hstate === E.LOADING && Math.abs(h6.cx - 21) <= 2, 'a harvest command at the field sends it back to work there');
  // harvest on its own drop-off = return (deliver now)
  go(w, 40);
  order(w, 0, 'harvest', [h6], { x: at(5), y: at(6) });
  list = evs(w, 600, (w, l) => l.some(e => e.t === 'dump'));
  const d6 = list.find(e => e.t === 'dump');
  check(!!d6 && d6.amount > 0 && d6.amount < HT.capacity, 'harvest on its own drop-off delivers the partial load now (' + (d6 && d6.amount) + ')');
  go(w, 60);
  check(h6.order && h6.order.type === 'harvest', 'and then resumes harvesting');
  go(w, 600, () => h6.hstate === NT.Econ.LOADING && h6.cargo > 100);
  order(w, 0, 'return', [h6]);
  list = evs(w, 600, (w, l) => l.some(e => e.t === 'dump'));
  const r6 = list.find(e => e.t === 'dump');
  check(!!r6 && r6.amount > 100 && r6.amount < HT.capacity, 'the return command delivers a partial load too (' + (r6 && r6.amount) + ')');
  sound('park');

  // no drop-off: it waits with its cargo, then delivers once one exists
  w = ecoWorld(fieldRows(30, 16, 20, 6, 23, 9), { fog: false });
  const h7 = NT.spawn(w, HAUL, 0, 18, 8);
  go(w, 900);
  check(h7.cargo === HT.capacity && h7.hstate !== E.LOADING, 'no drop-off: the hauler fills up and waits with the load');
  NT.spawn(w, DEPOT, 0, 4, 6);
  list = evs(w, 900, (w, l) => l.some(e => e.t === 'dump'));
  check(list.some(e => e.t === 'dump' && e.id === h7.id), 'a drop-off appears: it delivers');
  sound('no drop-off');
}
{
  // passive income and recruits (defs found generically)
  const inc = Object.values(NT.DEFS).find(d => d.kind === 'building' && d.traits.income);
  const rec = Object.values(NT.DEFS).find(d => d.kind === 'building' && d.traits.recruit);
  let w = ecoWorld(board(24, 16), { fog: false });
  const p = w.players[0];
  const b = NT.spawn(w, inc, 0, 4, 4), nb = NT.spawn(w, inc, NT.NEUTRAL, 14, 4), ti = inc.traits.income;
  const list = evs(w, ti.everyT * 3 + 1);
  const pays = list.filter(e => e.t === 'income');
  check(pays.length === 3 && pays.every(e => e.id === b.id && e.amount === ti.amount) && close(p.credits, 3 * ti.amount), inc.id + ' pays ' + ti.amount + ' every ' + ti.everyT + ' ticks (3 payments, credits ' + p.credits + '); the neutral one pays nobody');
  if (!rec) console.log('  (skipped: no recruit building in the data)');
  else {
    w = ecoWorld(board(24, 16), { fog: false });
    const r = NT.spawn(w, rec, NT.NEUTRAL, 8, 6), tr = rec.traits.recruit;
    go(w, tr.everyT + 5);
    check(w.players[0].nUnits === 0, 'a neutral recruit building recruits for nobody');
    NT.setOwner(w, r, 0);
    const l2 = evs(w, tr.everyT + 2);
    const pr = l2.filter(e => e.t === 'produced');
    const want = NT.FACTIONS.tg.defs.filter(d => d.kind === 'unit' && d.cost > 0 && !d.requires.length && !d.limit && NT.Combat.armed(d)).sort((a, b) => a.cost - b.cost)[0];
    check(pr.length === 1 && pr[0].def === want.id && w.byId.get(pr[0].id).owner === 0, rec.id + ' captured: after ' + tr.everyT + ' ticks one ' + want.id + ' (cheapest armed, no prerequisites) joins the owner');
    check(NT.touching(w.byId.get(pr[0].id), r) || cheb(w.byId.get(pr[0].id), r.cx, r.cy + r.h) <= 3, 'and appears beside the building');
  }
  sound('income + recruit');
}

section('econ: power');
{
  let w = ecoWorld(board(30, 16), { fog: false });
  const p = w.players[0];
  const core = NT.spawn(w, 'tg.core', 0, 2, 2);
  go(w, 2);
  check(p.power.made === core.def.power && p.power.used === 0 && !p.power.low, 'power made = sum of positive def.power (' + p.power.made + ')');
  const mast = NT.spawn(w, 'tg.mast', 0, 8, 2);
  let list = evs(w, 2);
  check(p.power.used === -mast.def.power && p.power.low === (p.power.used > p.power.made), 'power used = sum of the negative ones (' + p.power.used + ')');
  check(p.power.low && list.some(e => e.t === 'lowpower' && e.owner === 0 && e.on === true), 'demand beats supply: low power, lowpower {on: true}');
  check(!mast.powered && !p.radar && core.powered, 'needsPower structures switch off (the radar too); others keep running');
  // production while low: lowPowerProd
  NT.spawn(w, 'tg.bunk', 0, 12, 2);
  NT.Econ.earn(p, 5000);
  NT.cmd(w, 0, { type: 'produce', def: 'tg.grunt' });
  go(w, 3);
  const q = p.queues.crew, g = NT.DEFS['tg.grunt'];
  let pr0 = q.items[0].paid; go(w, 10);
  check(close((q.items[0].paid - pr0) / 10, g.cost / g.buildTicks * w.rules.lowPowerProd), 'low power: production runs at lowPowerProd (' + ((q.items[0].paid - pr0) / 10).toFixed(3) + ' credits/tick)');
  const cell = NT.spawn(w, 'tg.cell', 0, 16, 2);
  list = evs(w, 2);
  check(!p.power.low && list.some(e => e.t === 'lowpower' && e.on === false) && mast.powered && p.radar, 'a power plant restores it: lowpower {on: false}, radar back on');
  pr0 = q.items[0].paid; go(w, 10);
  check(close((q.items[0].paid - pr0) / 10, g.cost / g.buildTicks), 'and production is back to full speed');
  // a needsPower defence stops shooting while unpowered
  NT.kill(w, cell, null);
  const sentry = NT.spawn(w, 'tg.sentry', 0, 20, 8), foe = NT.spawn(w, 'tg.grunt', 1, 23, 8);
  stance(w, 1, [foe], 'passive');
  go(w, 60);
  check(sentry.def.needsPower && !sentry.powered && foe.hp === foe.maxHp, 'an unpowered defence does not fire');
  NT.spawn(w, 'tg.cell', 0, 16, 2);
  go(w, 60);
  check(foe.hp < foe.maxHp, 'powered again, it does');
  // neutral structures are always powered
  const sub = Object.values(NT.DEFS).find(d => d.kind === 'building' && d.faction === 'neutral');
  const n = NT.spawn(w, sub, NT.NEUTRAL, 24, 12);
  go(w, 2);
  check(n.powered, 'neutral structures are always powered');
  sound('power');
}

// ---------------------------------------------------------------------------
section('prod: progressive payment, stalls, producer bonus, prerequisites, limits, cancel, exits, rally');
{
  const G = NT.DEFS['tg.grunt'], R = NT.RULES;
  const base = (credits, extra) => {
    const w = ecoWorld(board(32, 20), Object.assign({ fog: false }, extra || {}));
    const p = w.players[0];
    NT.spawn(w, 'tg.core', 0, 2, 2); NT.spawn(w, 'tg.cell', 0, 7, 2);
    const bunk = NT.spawn(w, 'tg.bunk', 0, 10, 2);
    if (credits) NT.Econ.earn(p, credits);
    p.stats.income = 0;
    return { w: w, p: p, bunk: bunk };
  };
  let { w, p, bunk } = base(1000);
  NT.cmd(w, 0, { type: 'produce', def: G.id });
  let list = evs(w, 11);
  const per = G.cost / G.buildTicks;
  check(list.some(e => e.t === 'queued' && e.def === G.id) && close(p.credits, 1000 - 11 * per), 'progressive payment: 11 ticks in, the grunt has cost 11 x cost/buildTicks (credits ' + p.credits.toFixed(2) + ')');
  check(close(p.queues.crew.items[0].progress, 11 * per / G.cost), 'progress = paid / cost');
  list = evs(w, G.buildTicks + 5, (w, l) => l.some(e => e.t === 'produced'));
  const made = list.find(e => e.t === 'produced');
  check(!!made && made.def === G.id && close(p.credits, 1000 - G.cost) && p.stats.produced === 1 && !p.queues.crew.items.length, 'the grunt walks out after buildTicks; it cost exactly its price');
  const u = w.byId.get(made.id);
  check(u.cy >= bunk.cy + bunk.h && Math.abs(u.cx - (bunk.cx + 1)) <= 1, 'it appears at the exit (below the bottom edge, centred)');
  go(w, 80);
  check(cheb(u, bunk.cx + 1, bunk.cy + bunk.h) >= 2 && idle(u), 'and walks a few cells out so the door clears (' + u.cx + ',' + u.cy + ')');
  // rally point
  NT.cmd(w, 0, { type: 'rally', id: bunk.id, x: at(25), y: at(15) });
  NT.cmd(w, 0, { type: 'produce', def: G.id });
  list = evs(w, G.buildTicks + 5, (w, l) => l.some(e => e.t === 'produced'));
  const u2 = w.byId.get(list.find(e => e.t === 'produced').id);
  go(w, 300);
  check(u2.cx === 25 && u2.cy === 15, 'with a rally point set, the next one walks to it');
  sound('produce');

  // no money: stall + nofunds (throttled), resume when money comes
  ({ w, p } = base(50));
  NT.cmd(w, 0, { type: 'produce', def: G.id });
  list = evs(w, 200);
  const nf = list.filter(e => e.t === 'nofunds' && e.owner === 0);
  check(p.credits === 0 && close(p.queues.crew.items[0].paid, 50) && !list.some(e => e.t === 'produced'), 'out of credits: the item has taken all 50 and stalls');
  check(nf.length >= 2 && nf.length <= 4, "'nofunds' is throttled to one per 3 s (" + nf.length + ' in 200 ticks)');
  NT.Econ.earn(p, 500);
  list = evs(w, G.buildTicks, (w, l) => l.some(e => e.t === 'produced'));
  check(list.some(e => e.t === 'produced') && close(p.credits, 500 - (G.cost - 50)), 'money arrives: production resumes and completes at the same total price');
  sound('nofunds');

  // more producers of the queue build faster, up to producerBonusMax
  const rate = n => {
    const b = base(5000);
    for (let i = 1; i < n; i++) NT.spawn(b.w, 'tg.bunk', 0, 2 + (i % 5) * 3, 8 + ((i / 5) | 0) * 3);
    NT.spawn(b.w, 'tg.cell', 0, 28, 2); NT.spawn(b.w, 'tg.cell', 0, 28, 6);
    NT.cmd(b.w, 0, { type: 'produce', def: G.id });
    go(b.w, 2);
    const c0 = b.p.credits; go(b.w, 5);
    return (c0 - b.p.credits) / 5;
  };
  const r1 = rate(1), r2 = rate(2), r6 = rate(6);
  check(close(r1, per) && close(r2, per * (1 + R.producerBonus)) && close(r6, per * R.producerBonusMax), 'producer bonus: 1 bunk x1, 2 bunks x' + (1 + R.producerBonus) + ', 6 bunks capped at x' + R.producerBonusMax + ' (' + [r1, r2, r6].map(x => (x / per).toFixed(2)).join(', ') + ')');
  // player.prodMul
  ({ w, p } = base(5000));
  p.prodMul = 0.5;
  NT.cmd(w, 0, { type: 'produce', def: G.id }); go(w, 2);
  let c0 = p.credits; go(w, 4);
  check(close((c0 - p.credits) / 4, per * 0.5), 'player.prodMul 0.5 halves production speed');
  sound('producer bonus');

  // prerequisites, missing producers, limits, the queue cap
  let w2 = ecoWorld(board(32, 20), { fog: false });
  const p2 = w2.players[0];
  NT.spawn(w2, 'tg.core', 0, 2, 2);
  NT.Econ.earn(p2, 9000);
  let opts = NT.Prod.options(w2, p2), row = k => opts.find(o => o.def.id === k);
  check(row('tg.cell').ok && row('tg.bunk').reason === 'prereq' && row('tg.bunk').missing.join() === 'tg.cell' && row('tg.grunt').reason === 'producer',
    'options(): cell ok, bunk needs the cell (missing [tg.cell]), grunts need a producer');
  check(opts.map(o => o.def.id).join() === NT.FACTIONS.tg.defs.filter(d => d.queue).map(d => d.id).join(), 'options() lists every queued def in declaration order');
  NT.cmd(w2, 0, { type: 'produce', def: 'tg.bunk' }); NT.cmd(w2, 0, { type: 'produce', def: 'tg.grunt' }); NT.cmd(w2, 0, { type: 'produce', def: 'curfew.genny' });
  list = evs(w2, 1);
  const den = list.filter(e => e.t === 'denied').map(e => e.def + ':' + e.reason).join(' ');
  check(den === 'tg.bunk:prereq tg.grunt:producer curfew.genny:def', "produce is refused with 'denied' events (" + den + ')');
  for (let i = 0; i < R.maxQueue + 1; i++) NT.cmd(w2, 0, { type: 'produce', def: 'tg.cell' });
  list = evs(w2, 1);
  check(p2.queues.rigs.items.length === R.maxQueue && list.filter(e => e.t === 'denied' && e.reason === 'queue').length === 1, 'a queue holds at most ' + R.maxQueue + " items ('queue')");
  opts = NT.Prod.options(w2, p2);
  check(row('tg.cell').count === R.maxQueue && row('tg.cell').progress > 0, 'options() count / progress of the item being built');
  // cancel refunds what was paid; the last queued one goes first
  const paidHead = p2.queues.rigs.items[0].paid, cr0 = p2.credits;
  for (let i = 0; i < R.maxQueue - 1; i++) NT.cmd(w2, 0, { type: 'cancel', def: 'tg.cell' });
  list = evs(w2, 1);
  check(p2.queues.rigs.items.length === 1 && list.filter(e => e.t === 'cancelled').every(e => e.refund === 0), 'cancel takes the LAST queued item first (nothing paid, nothing refunded)');
  NT.cmd(w2, 0, { type: 'cancel', def: 'tg.cell' });
  list = evs(w2, 1);
  const cc = list.find(e => e.t === 'cancelled');
  check(!!cc && cc.refund > 0 && close(p2.credits, 9000) && close(p2.stats.spent, 0), 'cancelling the head refunds every credit it took (' + (cc && cc.refund.toFixed(1)) + ')');
  NT.cmd(w2, 0, { type: 'produce', def: 'tg.cell' });
  list = evs(w2, NT.DEFS['tg.cell'].buildTicks + 4, (w, l) => l.some(e => e.t === 'ready'));
  opts = NT.Prod.options(w2, p2);
  check(list.some(e => e.t === 'ready' && e.def === 'tg.cell') && p2.queues.rigs.ready === NT.DEFS['tg.cell'] && row('tg.cell').ready, "a finished structure is 'ready' and waits for placement");
  NT.cmd(w2, 0, { type: 'produce', def: 'tg.core' }); go(w2, 30);
  check(p2.queues.rigs.items.length === 1 && p2.queues.rigs.items[0].paid === 0, 'the structure queue holds while something waits to be placed');
  NT.cmd(w2, 0, { type: 'cancel', def: 'tg.cell' });
  list = evs(w2, 1);
  check(p2.queues.rigs.ready === null && list.some(e => e.t === 'cancelled' && e.refund === NT.DEFS['tg.cell'].cost), 'cancelling a ready structure refunds the full price');
  sound('prereq / queue / cancel');

  // limit (found generically: any playable def with limit > 0)
  const lim = NT.FACTION_LIST.map(f => f.defs.find(d => d.limit > 0 && d.queue)).find(Boolean);
  if (!lim) console.log('  (skipped: no def with a limit in the data)');
  else {
    const f = NT.FACTIONS[lim.faction];
    const w3 = NT.createWorld({ map: NT.Map.fromAscii(board(40, 30)), seed: 5, noBases: true, fog: false, players: [{ faction: f.id, credits: 50000 }, { faction: 'tg' }] });
    const p3 = w3.players[0];
    let x = 1;
    const give = d => { NT.spawn(w3, d, 0, x, 1); x += d.size[0] + 1; if (x > 34) x = 1; };
    for (const r of lim.requires) give(NT.DEFS[r]);
    const prodDef = f.defs.find(d => d.traits.producer && d.traits.producer.queues.indexOf(lim.queue) >= 0);
    if (!p3.owned[prodDef.id]) give(prodDef);
    for (const d of f.defs) if (d.kind === 'building' && d.power > 0) { give(d); give(d); give(d); break; }
    NT.cmd(w3, 0, { type: 'produce', def: lim.id }); NT.cmd(w3, 0, { type: 'produce', def: lim.id });
    list = evs(w3, 1);
    const o3 = NT.Prod.options(w3, p3).find(o => o.def === lim);
    check(p3.queues[lim.queue].items.length === 1 && list.some(e => e.t === 'denied' && e.reason === 'limit') && o3.cap && o3.reason === 'limit',
      lim.id + ' (limit ' + lim.limit + '): the second one is refused, options() shows cap');
    go(w3, lim.buildTicks + 20);
    if (lim.kind === 'building') check(p3.queues[lim.queue].ready === lim && !NT.Prod.canProduce(w3, p3, lim).ok, 'still capped while it waits to be placed');
    else check(p3.units[lim.id] === 1 && !NT.Prod.canProduce(w3, p3, lim).ok, 'still capped while it is alive');
  }

  // a blocked exit: the finished unit waits at the door, then comes out when there is room
  ({ w, p, bunk } = base(1000));
  const ex = [bunk.cx + 1, bunk.cy + bunk.h], plugs = [];
  for (let y = ex[1] - 4; y <= ex[1] + 4; y++) for (let x = ex[0] - 4; x <= ex[0] + 4; x++) {
    if (NT.Occ.canStand(w, 'large', x, y)) { const t = NT.spawn(w, 'tg.tank', 0, x, y, { exact: true }); if (t) plugs.push(t); }
  }
  stance(w, 0, plugs, 'hold');
  NT.cmd(w, 0, { type: 'produce', def: G.id });
  list = evs(w, G.buildTicks + 60);
  check(!list.some(e => e.t === 'produced') && p.queues.crew.items.length === 1 && p.queues.crew.items[0].progress === 1, 'the exit is jammed: the finished grunt waits inside');
  NT.kill(w, plugs.find(t => t.cx === ex[0] && t.cy === ex[1] + 1), null);
  list = evs(w, 3);
  check(list.some(e => e.t === 'produced') && !p.queues.crew.items.length, 'room at the door: it comes out on the next tick');
  sound('blocked exit');

  // the producer dies: the item pauses; a new producer resumes it. primary chooses the door.
  ({ w, p, bunk } = base(3000));
  NT.cmd(w, 0, { type: 'produce', def: G.id }); go(w, 10);
  NT.kill(w, bunk, null);
  const paid = p.queues.crew.items[0].paid;
  go(w, 30);
  check(p.queues.crew.items[0].paid === paid && NT.Prod.options(w, p).find(o => o.def === G).reason === 'producer', 'producer destroyed: the item pauses');
  const bA = NT.spawn(w, 'tg.bunk', 0, 14, 8), bB = NT.spawn(w, 'tg.bunk', 0, 22, 8);
  NT.cmd(w, 0, { type: 'primary', id: bB.id });
  list = evs(w, G.buildTicks, (w, l) => l.some(e => e.t === 'produced'));
  const pu = w.byId.get(list.find(e => e.t === 'produced').id);
  check(pu && cheb(pu, bB.cx + 1, bB.cy + bB.h) <= 1 && bB.primary && !bA.primary, 'a new producer resumes it, and units leave from the primary one');
  NT.cmd(w, 0, { type: 'primary', id: bA.id }); go(w, 1);
  check(bA.primary && !bB.primary, 'primary moves (only one per queue)');
  sound('primary');
}

section('prod: placement, findPlace, free units, sell, repair');
{
  const CELL = NT.DEFS['tg.cell'], R = NT.RULES;
  // anchor gap, terrain, units, resources, fog
  const rows = board(40, 24, (x, y) => (x === 20 && y >= 2 && y <= 3) ? '~' : (x === 21 && y === 2) ? '%' : (x >= 2 && x <= 3 && y >= 14 && y <= 15) ? '$' : null);
  let w = ecoWorld(rows, { fog: true });
  const p = w.players[0];
  const core = NT.spawn(w, 'tg.core', 0, 10, 2);               // right edge at x = 13
  const cp = (cx, cy, d) => NT.Prod.canPlace(w, p, d || CELL, cx, cy);
  check(cp(13 + R.buildGap, 2).ok && cp(14 + R.buildGap, 2).reason === 'anchor', 'anchor rule: ' + R.buildGap + ' empty cells from an anchor is fine, ' + (R.buildGap + 1) + ' is too far');
  check(cp(13, 2).ok && cp(12, 2).reason === 'blocked', 'touching is fine; overlapping is blocked');
  const r = cp(19, 2);
  check(r.reason === 'blocked' && r.cells.length === 4 && r.cells.filter(c => !c.ok).length === 2, 'water / rubble block it; cells[] marks each footprint cell for the ghost');
  const g = NT.spawn(w, 'tg.grunt', 1, 15, 3, { exact: true });
  check(cp(14, 2).reason === 'blocked', 'a unit standing there blocks it (even an enemy one)');
  NT.kill(w, g, null);
  const sentry = NT.spawn(w, 'tg.sentry', 0, 30, 10);
  check(!sentry.def.anchor && cp(31, 10).reason !== 'ok', 'defences are no anchors');
  NT.spawn(w, 'tg.core', 0, 2, 10);
  check(cp(2, 14).reason === 'blocked' && cp(2, 16).ok, 'resource cells are never buildable');
  check(cp(38, 22).reason === 'vision' || cp(38, 22).reason === 'anchor', 'fog: unexplored ground cannot be built on');
  const ws = NT.spawn(w, 'tg.core', 0, 30, 18);
  w.teams[0].explored.fill(0);                                // nothing explored any more ...
  NT.Fog.recompute(w);                                          // ... except what is in sight right now
  check(cp(34, 18).ok, 'explored ground next to an anchor is fine');
  // free placement (found generically): needs the whole footprint VISIBLE now, no anchor needed
  const freeDef = Object.values(NT.DEFS).find(d => d.kind === 'building' && d.placement === 'free' && d.faction === 'tg') ||
                  Object.values(NT.DEFS).find(d => d.kind === 'building' && d.placement === 'free');
  if (freeDef) {
    const f = NT.FACTIONS[freeDef.faction];
    const w4 = NT.createWorld({ map: NT.Map.fromAscii(board(50, 20)), seed: 3, noBases: true, players: [{ faction: f.id }, { faction: 'tg' }] });
    const p4 = w4.players[0], hq = NT.spawn(w4, f.start.buildings[0].def, 0, 2, 2);
    const scout = NT.spawn(w4, f.defs.find(d => d.kind === 'unit' && d.layer === 'ground'), 0, 40, 10);
    go(w4, 8);
    check(NT.Prod.canPlace(w4, p4, freeDef, 39, 8).ok, freeDef.id + " (placement 'free'): fine anywhere the team sees right now, far from any anchor");
    NT.kill(w4, scout, null); go(w4, 8);
    check(NT.Prod.canPlace(w4, p4, freeDef, 39, 8).reason === 'vision', 'remembered but no longer visible: refused');
    check(NT.Prod.canPlace(w4, p4, freeDef, hq.cx + hq.w, 2).ok, 'next to the base (in sight) it is fine');
  } else console.log("  (skipped: no 'free' placement def)");
  sound('canPlace');

  // findPlace: every spot it returns is valid; gap keeps a walkway; avoidRes keeps off the field
  w = ecoWorld(fieldRows(40, 30, 22, 8, 25, 11), { fog: false });
  const p5 = w.players[0];
  NT.spawn(w, 'tg.core', 0, 14, 8); NT.spawn(w, 'tg.depot', 0, 18, 9);
  let bad = 0, n = 0;
  for (const k of ['tg.cell', 'tg.bunk', 'tg.works', 'tg.mast', 'tg.sentry', 'tg.cell', 'tg.cell', 'tg.lab']) {
    const d = NT.DEFS[k], at2 = NT.Prod.findPlace(w, p5, d, 15, 9, { gap: 1, avoidRes: true });
    if (!at2) { bad++; continue; }
    n++;
    if (!NT.Prod.canPlace(w, p5, d, at2[0], at2[1]).ok) bad++;
    for (let y = at2[1] - 1; y <= at2[1] + d.size[1]; y++) for (let x = at2[0] - 1; x <= at2[0] + d.size[0]; x++) {
      if (x < 0 || y < 0 || x >= 40 || y >= 30) continue;
      if (w.map.resCap[y * 40 + x] > 0) bad++;
      const inside = x >= at2[0] && x < at2[0] + d.size[0] && y >= at2[1] && y < at2[1] + d.size[1];
      if (!inside && !NT.Occ.walkable(w, x, y)) bad++;
    }
    NT.spawn(w, d, 0, at2[0], at2[1]);
  }
  check(n === 8 && bad === 0, 'findPlace(gap 1, avoidRes): 8 structures in a row, each spot valid, a free ring around it, none touching the field (' + bad + ' problems)');
  check(!NT.debugCheck(w).length, 'the grid is still sound');
  check(NT.Prod.findPlace(w, p5, NT.DEFS['tg.lab'], 15, 9, { maxR: 1 }) === null, 'findPlace returns null when nothing fits within maxR');

  // place: needs ready + a valid spot; the drop-off's free harvester goes to work
  w = ecoWorld(fieldRows(40, 24, 26, 8, 29, 11), { fog: false });
  const p6 = w.players[0];
  NT.spawn(w, 'tg.core', 0, 14, 8); NT.spawn(w, 'tg.cell', 0, 14, 12);
  NT.Econ.earn(p6, 5000);
  NT.cmd(w, 0, { type: 'place', def: 'tg.depot', cx: 18, cy: 9 });
  let list = evs(w, 1);
  check(list.some(e => e.t === 'denied' && e.reason === 'place') && !p6.owned['tg.depot'], "place without a ready structure: denied 'place'");
  NT.cmd(w, 0, { type: 'produce', def: 'tg.depot' });
  go(w, DEPOT.buildTicks + 5);
  NT.cmd(w, 0, { type: 'place', def: 'tg.depot', cx: 30, cy: 20 });
  list = evs(w, 1);
  check(list.some(e => e.t === 'denied' && e.reason === 'place') && p6.queues.rigs.ready === DEPOT, 'an invalid spot is denied and the structure stays ready');
  NT.cmd(w, 0, { type: 'place', def: 'tg.depot', cx: 18, cy: 9 });
  list = evs(w, 2);
  const pl = list.find(e => e.t === 'placed');
  const fu = list.find(e => e.t === 'spawn' && w.byId.get(e.id) && w.byId.get(e.id).def.id === DEPOT.traits.dropoff.freeUnit);
  check(!!pl && p6.owned['tg.depot'] === 1 && p6.queues.rigs.ready === null && p6.stats.built === 1, "placed: 'placed' event, counted, the queue is free again");
  check(!!fu && w.byId.get(fu.id).owner === 0, 'the drop-off brings its free ' + DEPOT.traits.dropoff.freeUnit);
  go(w, 200);
  check(!!fu && w.byId.get(fu.id).order && w.byId.get(fu.id).order.type === 'harvest', 'which goes straight to work');
  sound('place');

  // sell: refund sellRefund x cost x hp fraction; never captured turf, never someone else's
  const depot = w.ents.find(e => e.def === DEPOT);
  NT.damage(w, depot, depot.maxHp / 2, null, null, null);
  const cr = p6.credits, hpFrac = depot.hp / depot.maxHp;
  NT.cmd(w, 0, { type: 'sell', id: depot.id });
  list = evs(w, 1);
  const sold = list.find(e => e.t === 'sold');
  check(!!sold && close(sold.refund, R.sellRefund * DEPOT.cost * hpFrac) && close(p6.credits - cr, sold.refund) && !depot.alive && !list.some(e => e.t === 'death' && e.id === depot.id),
    'sell: refund ' + (sold && sold.refund.toFixed(1)) + ' = sellRefund x cost x hp fraction, removed without a death');
  const turf = Object.values(NT.DEFS).find(d => d.kind === 'building' && d.traits.capturable);
  const tb = NT.spawn(w, turf, 0, 2, 2), eb = NT.spawn(w, 'tg.cell', 1, 2, 18);
  NT.cmd(w, 0, { type: 'sell', id: tb.id }); NT.cmd(w, 0, { type: 'sell', id: eb.id });
  go(w, 1);
  check(tb.alive && eb.alive, 'captured turf and enemy structures cannot be sold');
  sound('sell');

  // repair: heals repairRate x maxHp per second for repairCost x cost x healed / maxHp; stops at full or broke
  const cellB = w.ents.find(e => e.def.id === 'tg.cell' && e.owner === 0);
  NT.damage(w, cellB, cellB.maxHp * 0.5, null, null, null);
  const hp0 = cellB.hp, cr1 = p6.credits;
  NT.cmd(w, 0, { type: 'repair', id: cellB.id });
  list = evs(w, 21);
  const healed = cellB.hp - hp0;
  check(list.some(e => e.t === 'repair' && e.on) && close(healed, 21 * R.repairRate * cellB.maxHp / NT.TPS), 'repair heals repairRate x maxHp per second (' + healed.toFixed(2) + ' hp in 21 ticks)');
  check(close(cr1 - p6.credits, R.repairCost * CELL.cost * healed / cellB.maxHp), 'and costs repairCost x cost x healed / maxHp (' + (cr1 - p6.credits).toFixed(3) + ')');
  list = evs(w, 2000, () => !cellB.repairing);
  check(cellB.hp === cellB.maxHp && list.some(e => e.t === 'repair' && !e.on), 'it stops by itself at full health');
  NT.damage(w, cellB, cellB.maxHp * 0.5, null, null, null);
  NT.Econ.spend(p6, p6.credits); NT.Econ.earn(p6, 1);
  NT.cmd(w, 0, { type: 'repair', id: cellB.id });
  list = evs(w, 200, () => !cellB.repairing);
  check(!cellB.repairing && p6.credits < 1e-6 && cellB.hp < cellB.maxHp, 'and when the money runs out');
  NT.cmd(w, 0, { type: 'repair', id: eb.id }); go(w, 1);
  check(!eb.repairing, 'nobody repairs an enemy structure');
  sound('repair');
}

// ---------------------------------------------------------------------------
// TEST-ONLY, non-playable: trait combinations no shipped data uses yet (an uncrushable brace, a surge with an hp
// price and no auto trigger, a consumed capturer, death effects on a unit, ground lifesteal).
NT.defineFaction({
  id: 'tx', playable: false, name: { en: 'Trait Lab', zh: '特性实验' },
  units: {
    sapper: { name: { en: 'Sapper', zh: '工兵' }, tags: ['infantry'], cost: 200, hp: 100, armor: 'infantry', move: { type: 'foot', speed: 2 },
      traits: { brace: { delay: 1, mods: { taken: 0.5 }, uncrushable: true }, capturer: { time: 2, consumed: true, payout: 75 },
        surge: { cooldown: 10, dur: 2, crash: 1, hpCost: 0.3, auto: false, mods: { dmg: 2 }, crashMods: { dmg: 0.5 } },
        explodeOnDeath: { dmg: 50, radius: 2, warhead: 'he' }, spawnOnDeath: { def: 'imp', count: 2 } } },
    imp: { name: { en: 'Imp', zh: '小鬼' }, tags: ['infantry'], cost: 50, hp: 30, armor: 'infantry', move: { type: 'foot', speed: 2 },
      weapons: [{ dmg: 6, range: 1.5, cooldown: 0.5, proj: 'melee', warhead: 'melee' }], traits: { lifesteal: { frac: 0.5 } } },
  },
  buildings: {
    beacon: { name: { en: 'Beacon', zh: '信标' }, role: 'support', hp: 300, size: [1, 1], countsForDefeat: true },
  },
  powers: {
    kick: { name: { en: 'Kick', zh: '兴奋剂' }, building: 'beacon', cooldown: 10, initial: 0.5, kind: 'buff',
      buff: { radius: 3, dur: 2, affects: 'allies', tags: ['infantry'], mods: { dmg: 2 }, heal: 0.5, after: { dur: 1, mods: { dmg: 0.5 } } } },
    summon: { name: { en: 'Summon', zh: '召唤' }, building: 'beacon', cooldown: 5, kind: 'spawn', spawn: { def: 'imp', count: 2, delay: 1, lifetime: 3 } },
  },
});
const findDef = pred => Object.values(NT.DEFS).find(pred);
const traitDef = (name, extra) => findDef(d => d.traits[name] && d.faction !== 'tx' && (!extra || extra(d)));
const spawnFor = (w, d, owner, cx, cy) => NT.spawn(w, d, owner, cx, cy);
const playersOf = (fa, fb) => [{ faction: fa || 'tg', credits: 0 }, { faction: fb || 'tg', credits: 0 }];

section('traits: MODS aggregation (veterancy, enrage, brace, buffs, auras), regen, selfHeal');
{
  const K = NT.Traits.KEYS, R = NT.RULES;
  const modsEq = (m, want) => K.every(k => close(m[k], want[k] === undefined ? (k === 'regen' ? 0 : 1) : want[k]));
  let w = mkWorld(board(30, 20), { fog: false });
  const g = NT.spawn(w, 'tg.grunt', 0, 5, 5);
  stance(w, 0, [g], 'hold');
  go(w, 2);
  check(modsEq(g.mods, {}), 'a plain unit: neutral MODS');
  g.rank = 2; go(w, 1);
  check(modsEq(g.mods, R.vetMods[2]), 'rank 2: exactly rules.vetMods[2]');
  g.rank = 0;
  // buffs: expiry, no stacking per id, delayed start
  NT.Traits.buff(g, { id: 'x', until: w.tick + 10, dmg: 2 });
  NT.Traits.buff(g, { id: 'x', until: w.tick + 5, dmg: 3 });
  NT.Traits.buff(g, { id: 'y', from: w.tick + 4, until: w.tick + 8, rof: 0.5 });
  go(w, 1);
  check(close(g.mods.dmg, 2) && close(g.mods.rof, 1) && g.buffs.filter(b => b.id === 'x').length === 1, 'same-id buffs do not stack (the later-ending stays); a buff with `from` waits');
  go(w, 4);
  check(close(g.mods.rof, 0.5) && close(g.mods.dmg, 2), 'the delayed buff kicks in at `from`');
  go(w, 6);
  check(modsEq(g.mods, {}) && !g.buffs.length, 'expired buffs stop counting and are pruned');
  sound('mods basics');

  // enrage (generic)
  const en = traitDef('enrage', d => d.kind === 'unit');
  if (en) {
    const u = NT.spawn(w, en, 0, 10, 10);
    stance(w, 0, [u], 'hold'); go(w, 2);
    const before = u.mods.dmg;
    NT.damage(w, u, u.maxHp * (1 - en.traits.enrage.below) + 1, null, null, null);
    go(w, 1);
    check(close(before, 1) && close(u.mods.dmg, en.traits.enrage.mods.dmg || 1) && close(u.mods.speed, en.traits.enrage.mods.speed || 1), en.id + ' enrages below ' + en.traits.enrage.below + ' hp: mods ' + JSON.stringify(en.traits.enrage.mods));
  }
  // brace: sets after delayT standing, breaks the moment it moves (generic)
  const br = traitDef('brace', d => d.layer === 'ground');
  if (br) {
    const u = NT.spawn(w, br, 0, 12, 14), D = br.traits.brace.delayT, t0 = w.tick;
    stance(w, 0, [u], 'hold');
    let first = -1;
    go(w, D + 10, () => { if (u.braced && first < 0) first = w.tick - t0; return false; });
    check(first >= D && first <= D + 2 && u.braced && modsEq(u.mods, br.traits.brace.mods), br.id + ' braces after ' + D + ' ticks standing still (at ' + first + '): mods ' + JSON.stringify(br.traits.brace.mods));
    moveTo(w, 0, [u], 20, 14);
    let broke = 0;
    go(w, 3, () => { if (!u.braced && modsEq(u.mods, {})) broke++; return false; });
    check(broke >= 2 && u.still === 0, 'moving breaks it at once');
    go(w, 200, () => idle(u));
    go(w, D + 2);
    check(u.braced, 'and it braces again where it stops');
  }
  sound('enrage + brace');

  // auras: best value per stat, never stacking; allies only; neutral carriers project nothing; self flag (generic)
  const au = traitDef('aura', d => d.kind === 'unit' && Object.keys(d.traits.aura.mods).some(k => k !== 'regen'));
  const auR = Object.values(NT.DEFS).filter(d => d.traits.aura && d.traits.aura.mods.regen > 0 && d.kind === 'building' && d.faction !== 'tx').sort((a, b) => a.traits.aura.mods.regen - b.traits.aura.mods.regen);
  if (au) {
    w = mkWorld(board(40, 20), { fog: false });
    const A = au.traits.aura, c1 = NT.spawn(w, au, 0, 10, 10), c2 = NT.spawn(w, au, 0, 11, 11), ally = NT.spawn(w, 'tg.grunt', 0, 12, 10), foe = NT.spawn(w, 'tg.grunt', 1, 12, 12);
    const far = NT.spawn(w, 'tg.grunt', 0, 10 + Math.ceil(A.radius) + 3, 3);
    stance(w, 0, [c1, c2, ally, far], 'hold'); stance(w, 1, [foe], 'passive');
    go(w, 3);
    const want = A.affects === 'enemies' ? null : A.mods;
    check(!!want && modsEq(ally.mods, want), au.id + ' aura: an ally inside gets ' + JSON.stringify(A.mods) + ' once, although two carriers cover it');
    check(modsEq(foe.mods, {}) && modsEq(far.mods, {}), 'enemies and allies out of range are untouched');
    check(modsEq(c1.mods, A.mods), 'carriers covered by each other count like anyone');
    const lone = NT.spawn(w, au, 0, 36, 18);
    stance(w, 0, [lone], 'hold'); go(w, 2);
    check(A.self ? modsEq(lone.mods, A.mods) : modsEq(lone.mods, {}), 'a lone carrier: self ' + !!A.self + ' -> ' + (A.self ? 'covered' : 'not covered'));
    sound('aura units');
  }
  // a fixture unit covered by regen auras of two different strengths
  const tagOk = (d, b) => !b.traits.aura.tags || b.traits.aura.tags.some(t => d.is[t]);
  const vic = NT.FACTIONS.tg.defs.find(d => d.kind === 'unit' && d.layer === 'ground' && new Set(auR.filter(b => tagOk(d, b)).map(b => b.traits.aura.mods.regen)).size >= 2);
  if (vic) {
    w = mkWorld(board(40, 20), { fog: false });
    const fit = auR.filter(b => tagOk(vic, b)), lo = fit[0], hi = fit[fit.length - 1];
    const bLo = NT.spawn(w, lo, 0, 5, 5), bHi = NT.spawn(w, hi, NT.NEUTRAL, 5 + lo.size[0], 5);
    const u = NT.spawn(w, vic, 0, 5 + lo.size[0], 5 + Math.max(lo.size[1], hi.size[1]));
    stance(w, 0, [u], 'hold');
    NT.damage(w, u, u.maxHp / 2, null, null, null);
    go(w, 2);
    check(close(u.mods.regen, lo.traits.aura.mods.regen + (u.def.traits.selfHeal ? 0 : 0)), lo.id + ' regen aura ' + lo.traits.aura.mods.regen + ' on ' + vic.id + '; the neutral ' + hi.id + ' projects nothing');
    const hp0 = u.hp; go(w, 10);
    check(close(u.hp - hp0, 10 * u.maxHp * lo.traits.aura.mods.regen / NT.TPS), 'regen heals maxHp x regen per second (' + (u.hp - hp0).toFixed(3) + ' in 10 ticks)');
    if (hi !== lo) {
      NT.setOwner(w, bHi, 0); go(w, 2);
      check(close(u.mods.regen, hi.traits.aura.mods.regen), 'two regen auras: the larger wins, they do not add (' + u.mods.regen + ')');
    }
    void bLo;
    sound('aura regen');
  }
  // selfHeal waits delayT after the last hurt
  w = mkWorld(board(20, 10), { fog: false });
  const b = NT.spawn(w, 'tg.brawler', 0, 5, 5), SH = b.def.traits.selfHeal;
  stance(w, 0, [b], 'hold');
  NT.damage(w, b, 30, null, null, null);
  const hurt = w.tick, hp0 = b.hp;
  go(w, SH.delayT - 2);
  check(b.hp === hp0, 'selfHeal: nothing for ' + SH.delayT + ' ticks after the last hit');
  go(w, 12);
  check(b.hp > hp0 && close(b.hp - hp0, (w.tick - hurt - SH.delayT) * b.maxHp * SH.rate / NT.TPS), 'then rate x maxHp per second (' + (b.hp - hp0).toFixed(3) + ')');
  NT.kill(w, b, null); go(w, 30);
  check(!b.alive && b.hp === 0, 'regen never revives the dead');
  sound('selfHeal');
}

section('traits: brace gates needsBrace weapons + crushing, surge, leap');
{
  // needsBrace (generic): no shot until braced, none while moving
  const nb = findDef(d => d.kind === 'unit' && d.weapons.some(x => x.needsBrace) && d.traits.brace);
  if (!nb) console.log('  (skipped: no needsBrace weapon)');
  else {
    const wp = nb.weapons.find(x => x.needsBrace), w = mkWorld(board(40, 12), { fog: false });
    const u = NT.spawn(w, nb, 0, 4, 5), v = NT.spawn(w, 'tg.core', 1, 4 + Math.ceil(wp.minRangePx / T) + 2, 4);
    v.hp = v.maxHp = 1e6;
    stance(w, 0, [u], 'hold');
    let shots = [], braceAt = -1;
    go(w, nb.traits.brace.delayT + wp.cd + 20, () => { if (u.braced && braceAt < 0) braceAt = w.tick; for (const ev of NT.drainEvents(w)) if (ev.t === 'fire' && ev.id === u.id) shots.push(w.tick); return false; });
    check(shots.length > 0 && shots[0] >= braceAt && braceAt > 0, nb.id + ': the needsBrace weapon first fires once braced (braced ' + braceAt + ', first shot ' + shots[0] + ')');
    moveTo(w, 0, [u], 4, 10);
    shots = [];
    go(w, 15, () => { for (const ev of NT.drainEvents(w)) if (ev.t === 'fire' && ev.id === u.id) shots.push(w.tick); return false; });
    check(shots.length === 0, 'and holds fire while it moves');
    sound('needsBrace');
  }
  // a braced uncrushable body is not crushed; an unbraced one (or one whose brace is crushable) is
  const w = mkWorld(board(20, 9), { fog: false });
  const s1 = NT.spawn(w, 'tx.sapper', 1, 10, 4), tank = NT.spawn(w, 'tg.tank', 0, 4, 4);
  stance(w, 1, [s1], 'passive'); stance(w, 0, [tank], 'passive');
  go(w, s1.def.traits.brace.delayT + 2);
  check(s1.braced && !NT.Move.crushable(w, tank, s1), 'braced with uncrushable: crushers cannot run it over');
  moveTo(w, 0, [tank], 16, 4);
  go(w, 200, () => idle(tank));
  check(s1.alive && tank.cx !== 10, 'the tank drives around it');
  const crushBrace = findDef(d => d.traits.brace && d.traits.brace.uncrushable === false && d.body === 'small' && !d.is.uncrushable);
  if (crushBrace) {
    const w2 = mkWorld(board(20, 9), { fog: false });
    const s2 = NT.spawn(w2, crushBrace, 1, 10, 4), t2 = NT.spawn(w2, 'tg.tank', 0, 4, 4);
    stance(w2, 1, [s2], 'passive'); stance(w2, 0, [t2], 'passive');
    go(w2, crushBrace.traits.brace.delayT + 2);
    moveTo(w2, 0, [t2], 16, 4);
    go(w2, 200, () => idle(t2));
    check(!s2.alive && w2.tick > crushBrace.traits.brace.delayT, crushBrace.id + ' (brace.uncrushable false) is crushed even when braced');
  }
  sound('brace crush');
}
{
  // surge (generic auto unit): buff, crash, cooldown
  const su = traitDef('surge', d => d.traits.surge.auto && d.layer === 'ground');
  if (su) {
    const S = su.traits.surge, w = mkWorld(board(40, 12), { fog: false });
    const u = NT.spawn(w, su, 0, 4, 5), v = NT.spawn(w, 'tg.core', 1, 4 + Math.floor(S.range) - 1, 4);
    v.hp = v.maxHp = 1e7;
    const abil = [];
    let inBuff = 0, inCrash = 0;
    go(w, S.cooldownT + 60, () => {
      for (const ev of NT.drainEvents(w)) if (ev.t === 'ability' && ev.id === u.id) abil.push(w.tick);
      if (abil.length === 1 && w.tick < abil[0] + S.durT && close(u.mods.speed, S.mods.speed || 1) && close(u.mods.rof, S.mods.rof || 1)) inBuff++;
      if (abil.length === 1 && w.tick >= abil[0] + S.durT && w.tick < abil[0] + S.durT + S.crashT && close(u.mods.speed, S.crashMods.speed || 1)) inCrash++;
      return false;
    });
    check(abil.length >= 1 && abil[0] < 20, su.id + ' surges by itself once its target is within ' + S.range + ' cells (tick ' + abil[0] + ')');
    check(inBuff >= S.durT - 2 && inCrash >= S.crashT - 2, 'mods ' + JSON.stringify(S.mods) + ' for durT, then the crash ' + JSON.stringify(S.crashMods) + ' (' + inBuff + ' + ' + inCrash + ' ticks)');
    check(abil.length === 2 && abil[1] - abil[0] === S.cooldownT, 'and again exactly one cooldown later (' + (abil[1] - abil[0]) + ' ticks)');
    sound('surge auto');
  }
  // manual surge with an hp price (tx.sapper: auto off)
  const w = mkWorld(board(20, 10), { fog: false });
  const s = NT.spawn(w, 'tx.sapper', 0, 5, 5), S = s.def.traits.surge;
  go(w, 30);
  check(!s.buffs.length, 'auto: false never triggers by itself');
  order(w, 0, 'ability', [s], { ability: 'surge' });
  const list = evs(w, 1);
  check(list.some(e => e.t === 'ability' && e.ability === 'surge') && close(s.hp, s.maxHp * (1 - S.hpCost)) && close(s.mods.dmg, S.mods.dmg), 'the ability command triggers it: pays ' + S.hpCost + ' x maxHp, gets ' + JSON.stringify(S.mods));
  go(w, S.cooldownT - 5);
  order(w, 0, 'ability', [s], { ability: 'surge' });
  check(!evs(w, 1).some(e => e.t === 'ability'), 'refused while cooling down');
  go(w, 10);
  NT.damage(w, s, (s.hp - S.hpCost * s.maxHp - 0.5) / s.mods.taken, null, null, null);
  order(w, 0, 'ability', [s], { ability: 'surge' });
  check(!evs(w, 1).some(e => e.t === 'ability') && s.hp > 1, 'refused when the price would leave it at 1 hp or less (never lethal)');
  sound('surge manual');
}
{
  // leap (generic): relocates next to the target, damages, respects min / max range and the cooldown
  const leapers = Object.values(NT.DEFS).filter(d => d.traits.leap && d.layer === 'ground' && d.faction !== 'tx');
  if (!leapers.length) console.log('  (skipped: no leap trait in the data)');
  for (const d of leapers) {
    const L = d.traits.leap, w = mkWorld(board(40, 14), { fog: false });
    const dist = Math.floor((L.minRange + L.range) / 2);
    const u = NT.spawn(w, d, 0, 5, 6), v = NT.spawn(w, 'tg.tank', 1, 5 + dist, 6);
    v.hp = v.maxHp = 1e6;
    stance(w, 1, [v], 'passive');
    order(w, 0, 'attack', [u], { target: v.id });
    let ev = null, from = null, hp0 = v.hp, dropped = 0;
    go(w, 40, () => {
      for (const e of NT.drainEvents(w)) if (e.t === 'ability' && e.ability === 'leap' && !ev) { ev = e; from = [u.px, u.py]; dropped = hp0 - v.hp; }
      return !!ev;
    });
    const want = L.dmg * NT.WARHEADS[L.warhead][v.def.armor] * u.mods.dmg;
    check(!!ev && cheb(u, v.cx, v.cy) === 1 && NT.dist(from[0], from[1], v.x, v.y) >= L.minRangePx - 1 && NT.dist(from[0], from[1], v.x, v.y) <= L.rangePx + 1,
      d.id + ' leaps from ' + (from && (NT.dist(from[0], from[1], v.x, v.y) / T).toFixed(1)) + ' cells and lands touching the target');
    check(!!ev && close(dropped, want), 'landing deals dmg x warhead (' + dropped.toFixed(1) + ' / ' + want.toFixed(1) + ')');
    if (L.slow) check(!!v.buffs.find(b => b.id === 'slow' && close(b.speed, L.slow.mult)), 'and slows the target to ' + L.slow.mult);
    check(NT.debugCheck(w).length === 0, 'the grid stays sound after the relocation');
    // cooldown: inside it, a fresh target at leap distance is walked to; once it has run out, the leap comes back
    const t1 = w.tick - 1;
    check(u.abil.leap === t1 + L.cooldownT, 'cooldown set: ready again at leap + ' + L.cooldownT + ' ticks');
    const v2 = NT.spawn(w, 'tg.tank', 1, u.cx - dist, u.cy);
    v2.hp = v2.maxHp = 1e6;
    stance(w, 1, [v2], 'passive');
    order(w, 0, 'attack', [u], { target: v2.id });
    let early = 0;
    go(w, Math.min(L.cooldownT - 5, 120), () => { for (const e of NT.drainEvents(w)) if (e.t === 'ability' && e.ability === 'leap') early++; return false; });
    check(early === 0 && cheb(u, v2.cx, v2.cy) <= 1, 'during the cooldown it walks to the next target instead (' + early + ' leaps)');
    moveTo(w, 0, [u], 5, 2);
    go(w, L.cooldownT, () => w.tick >= u.abil.leap && idle(u));
    order(w, 0, 'attack', [u], { target: v.id });
    let again = 0;
    go(w, 60, () => { for (const e of NT.drainEvents(w)) if (e.t === 'ability' && e.ability === 'leap') again++; return again > 0; });
    check(again === 1, 'after the cooldown it leaps again');
    sound('leap ' + d.id);
  }
  if (leapers.length) {
    // too close / too far: no leap
    const d = leapers[0], L = d.traits.leap, w = mkWorld(board(40, 14), { fog: false });
    const u = NT.spawn(w, d, 0, 5, 6), v = NT.spawn(w, 'tg.core', 1, 6, 5);
    v.hp = v.maxHp = 1e6;
    let leaps = 0;
    go(w, 60, () => { for (const e of NT.drainEvents(w)) if (e.t === 'ability' && e.ability === 'leap') leaps++; return false; });
    check(leaps === 0, 'no leap at a target already in reach (inside minRange)');
    const w2 = mkWorld(board(40, 14), { fog: false });
    const u2 = NT.spawn(w2, d, 0, 5, 6), v2 = NT.spawn(w2, 'tg.flyer', 1, 7, 6);
    stance(w2, 1, [v2], 'passive');
    order(w2, 0, 'attack', [u2], { target: v2.id });
    leaps = 0;
    go(w2, 60, () => { for (const e of NT.drainEvents(w2)) if (e.t === 'ability' && e.ability === 'leap') leaps++; return false; });
    check(leaps === 0, 'and never at a flyer');
    void u;
    // from beyond range: it closes in on foot and takes off only once inside [minRange, range]
    const w3 = mkWorld(board(40, 14), { fog: false });
    const u3 = NT.spawn(w3, d, 0, 3, 6), v3 = NT.spawn(w3, 'tg.tank', 1, 3 + Math.ceil(L.range) + 4, 6);
    v3.hp = v3.maxHp = 1e6;
    stance(w3, 1, [v3], 'passive');
    order(w3, 0, 'attack', [u3], { target: v3.id });
    let off = -1;
    go(w3, 200, () => { for (const e of NT.drainEvents(w3)) if (e.t === 'ability' && e.ability === 'leap' && off < 0) off = NT.dist(u3.px, u3.py, v3.x, v3.y); return off >= 0; });
    // px/py = where it stood at the start of the take-off tick, i.e. up to one tick of walking before the check
    check(off > 0 && off <= L.rangePx + 1.5 * d.move.speedPx * u3.mods.speed && off >= L.minRangePx - 1, 'starting ' + (Math.ceil(L.range) + 4) + ' cells away it walks in and leaps from ' + (off / T).toFixed(2) + ' cells (range ' + L.range + ')');
    sound('leap limits');
  }
}

section('traits: capture, deploy, death effects, bounty, lifesteal, consume, expires');
{
  const turf = traitDef('capturable', d => d.kind === 'building' && !d.traits.recruit && !d.traits.aura);
  let w = mkWorld(board(30, 16), { fog: false });
  const b = NT.spawn(w, turf, NT.NEUTRAL, 15, 6), g = NT.spawn(w, 'tg.grunt', 0, 4, 7), CT = g.def.traits.capturer.timeT;
  NT.cmd(w, 0, { type: 'enter', ids: [g.id], target: b.id });
  go(w, 200, () => b.captureBy === g.id);
  check(b.captureBy === g.id && NT.touching(g, b), 'enter: the capturer walks to the ring and starts channelling');
  go(w, Math.floor(CT / 2));
  check(b.captureT > 0 && b.owner === NT.NEUTRAL && NT.Traits.capture(w, b).need === CT, 'progress counts up (' + b.captureT + '/' + CT + ')');
  moveTo(w, 0, [g], 4, 7); go(w, 3);
  check(b.captureBy === 0 && b.captureT === 0, 'walking away resets the progress');
  go(w, 100);
  NT.cmd(w, 0, { type: 'enter', ids: [g.id], target: b.id });
  const list = evs(w, 400, () => b.owner === 0);
  const cap = list.find(e => e.t === 'captured');
  check(b.owner === 0 && !!cap && cap.from === NT.NEUTRAL && cap.to === 0 && w.players[0].owned[turf.id] === 1 && g.alive && !g.order, 'after timeT the building changes hands (captured event, counters) and the capturer stays');
  NT.damage(w, b, b.hp + 10, null, null, null);
  check(b.alive && b.owner === NT.NEUTRAL && close(b.hp, b.maxHp * turf.traits.capturable.revertHp) && !w.players[0].owned[turf.id], 'beaten to 0 hp it reverts to neutral at revertHp');
  sound('capture');
  // two capturers: one channels, the other waits; it takes over (from zero) when the first dies. payout + consumed (tx.sapper)
  w = mkWorld(board(30, 16), { fog: false });
  const b2 = NT.spawn(w, turf, NT.NEUTRAL, 15, 6), g1 = NT.spawn(w, 'tg.grunt', 0, 13, 7), g2 = NT.spawn(w, 'tg.grunt', 0, 13, 8);
  NT.cmd(w, 0, { type: 'enter', ids: [g1.id, g2.id], target: b2.id });
  go(w, 40);
  const first = b2.captureBy;
  check(first === g1.id || first === g2.id, 'two capturers: one channels at a time');
  const other = first === g1.id ? g2 : g1;
  NT.kill(w, w.byId.get(first), null);
  go(w, 2);
  check(b2.captureBy === other.id && b2.captureT <= 2, 'the first one dies: the second takes over from zero');
  const w3 = mkWorld(board(30, 16), { fog: false });
  const b3 = NT.spawn(w3, turf, 1, 15, 6), sp = NT.spawn(w3, 'tx.sapper', 0, 13, 7);
  NT.cmd(w3, 0, { type: 'enter', ids: [sp.id], target: b3.id });
  const l3 = evs(w3, 300, () => b3.owner === 0);
  check(b3.owner === 0 && !sp.alive && l3.some(e => e.t === 'despawn' && e.id === sp.id) && !l3.some(e => e.t === 'death' && e.id === sp.id), 'an enemy-held building can be taken too; a consumed capturer is spent silently');
  check(l3.some(e => e.t === 'income' && e.id === b3.id && e.amount === sp.def.traits.capturer.payout) && w3.players[0].credits >= sp.def.traits.capturer.payout, 'payout is credited with an income event at the building');
  // friendly target: just walk up
  const fb = NT.spawn(w3, 'tg.cell', 0, 4, 12), g4 = NT.spawn(w3, 'tg.grunt', 0, 20, 12);
  NT.cmd(w3, 0, { type: 'enter', ids: [g4.id], target: fb.id });
  go(w3, 300, () => !g4.order);
  check(NT.touching(g4, fb) && !g4.order && fb.owner === 0, 'enter on a friendly structure: walks up to it and stops');
  sound('capture 2');
}
{
  // deploy (generic: a unit whose deploy.into is a building)
  const dep = traitDef('deploy', d => d.traits.deploy.into);
  if (dep) {
    const into = NT.DEFS[dep.traits.deploy.into], w = NT.createWorld({ map: NT.Map.fromAscii(board(30, 16)), seed: 2, noBases: true, fog: false, players: playersOf(dep.faction, 'tg') });
    const u = NT.spawn(w, dep, 0, 10, 8), blocker = NT.spawn(w, 'tg.grunt', 1, 11, 8);
    stance(w, 1, [blocker], 'passive'); stance(w, 0, [u], 'passive');
    order(w, 0, 'deploy', [u]);
    let list = evs(w, 1);
    check(u.alive && list.some(e => e.t === 'denied' && e.reason === 'place' && e.def === into.id), dep.id + ': no room for the footprint -> denied');
    NT.kill(w, blocker, null);
    order(w, 0, 'deploy', [u]);
    list = evs(w, 1);
    const dv = list.find(e => e.t === 'deploy'), nb = dv && w.byId.get(dv.id);
    check(!u.alive && !!nb && nb.def === into && nb.owner === 0 && nb.cx === 10 - ((into.size[0] - 1) >> 1) && nb.cy === 8 - ((into.size[1] - 1) >> 1) && dv.on === true,
      'room: the unit becomes a ' + into.id + ' centred on its cell (deploy event)');
    check(list.some(e => e.t === 'despawn' && e.id === u.id) && w.players[0].nBuildings === (into.countsForDefeat ? 1 : 0), 'the unit despawned silently; the structure counts');
    sound('deploy');
  }
}
{
  // explodeOnDeath: hurts friend and foe, not when sold. spawnOnDeath. (generic building + tx.sapper)
  const ex = traitDef('explodeOnDeath', d => d.kind === 'building' && d.queue);
  const f = NT.FACTIONS[ex.faction];
  const mk = () => NT.createWorld({ map: NT.Map.fromAscii(board(30, 16)), seed: 2, noBases: true, fog: false, players: playersOf(f.id, 'tg') });
  let w = mk();
  const b = NT.spawn(w, ex, 0, 10, 6), own = NT.spawn(w, 'tg.grunt', 0, 9, 7), foe = NT.spawn(w, 'tg.grunt', 1, 10 + ex.size[0], 7), out = NT.spawn(w, 'tg.grunt', 1, 20, 7);
  stance(w, 0, [own], 'passive'); stance(w, 1, [foe, out], 'passive');
  NT.damage(w, b, b.hp + 1, null, null, null);
  check(!b.alive && own.hp < own.maxHp && foe.hp < foe.maxHp && out.hp === out.maxHp, ex.id + ' explodes on death: friend and foe nearby are hurt, the far one is not');
  w = mk();
  const b2 = NT.spawn(w, ex, 0, 10, 6), own2 = NT.spawn(w, 'tg.grunt', 0, 9, 7);
  stance(w, 0, [own2], 'passive');
  NT.cmd(w, 0, { type: 'sell', id: b2.id }); go(w, 1);
  check(!b2.alive && own2.hp === own2.maxHp, 'sold: no explosion');
  w = mkWorld(board(30, 16), { fog: false });
  const s = NT.spawn(w, 'tx.sapper', 0, 10, 6), near = NT.spawn(w, 'tg.grunt', 1, 11, 6);
  stance(w, 1, [near], 'passive');
  const list = (() => { NT.damage(w, s, 1e6, null, null, null); return NT.drainEvents(w); })();
  const imps = list.filter(e => e.t === 'spawn' && w.byId.get(e.id) && w.byId.get(e.id).def.id === 'tx.imp');
  check(imps.length === 2 && imps.every(e => w.byId.get(e.id).owner === 0) && near.hp < near.maxHp, 'a unit with explodeOnDeath + spawnOnDeath: blast, then 2 imps for its owner');
  sound('death effects');
}
{
  // bounty (generic): units only unless buildings: true
  const bo = traitDef('bounty', d => d.kind === 'unit' && d.layer === 'ground' && NT.Combat.armed(d) && !d.traits.bounty.buildings && d.weapons[0].ground);
  if (bo) {
    const w = NT.createWorld({ map: NT.Map.fromAscii(board(30, 16)), seed: 2, noBases: true, fog: false, players: playersOf(bo.faction, 'tg') });
    const k = NT.spawn(w, bo, 0, 5, 5), v = NT.spawn(w, 'tg.grunt', 1, 6, 5), c = NT.spawn(w, 'tg.cell', 1, 12, 9);
    stance(w, 1, [v], 'passive');
    let list = evs(w, 600, () => !v.alive);
    const pay = list.find(e => e.t === 'income');
    check(!v.alive && !!pay && close(pay.amount, bo.traits.bounty.frac * v.def.cost) && close(w.players[0].credits, pay.amount) && pay.x === v.x, bo.id + ' kills a grunt: bounty ' + bo.traits.bounty.frac + ' x cost paid at the victim');
    order(w, 0, 'attack', [k], { target: c.id });
    list = evs(w, 4000, () => !c.alive);
    check(!c.alive && !list.some(e => e.t === 'income'), 'no bounty for a structure (buildings: false)');
    sound('bounty');
  }
  // lifesteal (tx.imp, ground melee; and any flying lifestealer from the data)
  const w = mkWorld(board(20, 10), { fog: false });
  const imp = NT.spawn(w, 'tx.imp', 0, 5, 5), tank = NT.spawn(w, 'tg.core', 1, 6, 4);
  tank.hp = tank.maxHp = 1e6;
  NT.damage(w, imp, 20, null, null, null);
  const ih = imp.hp;
  go(w, 30);
  const dealt = 1e6 - tank.hp;
  check(dealt > 0 && close(imp.hp - ih, Math.min(imp.maxHp - ih, imp.def.traits.lifesteal.frac * dealt)), 'lifesteal heals frac x damage dealt (' + (imp.hp - ih).toFixed(2) + ' for ' + dealt.toFixed(2) + ')');
  sound('lifesteal');
}
{
  // consume (generic): kills the shooter after the shot; never auto-acquires, even when made aggressive
  const cu = findDef(d => d.kind === 'unit' && d.weapons.length && d.weapons.every(x => x.consume));
  if (!cu) console.log('  (skipped: no consume weapon)');
  else {
    const wp = cu.weapons[0], w = NT.createWorld({ map: NT.Map.fromAscii(board(30, 16)), seed: 2, noBases: true, fog: false, players: playersOf(cu.faction, 'tg') });
    const u = NT.spawn(w, cu, 0, 5, 7), v = NT.spawn(w, wp.ground ? 'tg.tank' : 'tg.flyer', 1, 6, 7);
    stance(w, 1, [v], 'passive'); stance(w, 0, [u], 'aggressive');
    go(w, 80);
    check(u.alive && v.hp === v.maxHp && u.stance === 'aggressive', cu.id + ' (consume): never fires on its own, even when aggressive');
    order(w, 0, 'attack', [u], { target: v.id });
    const list = evs(w, 200, () => !u.alive);
    check(!u.alive && list.some(e => e.t === 'death' && e.id === u.id) && list.some(e => e.t === 'fire' && e.id === u.id) && v.hp < v.maxHp, 'on an attack order it strikes once and is destroyed');
    // shot at while aggressive: no retaliation either (combat.js guard)
    const w2 = NT.createWorld({ map: NT.Map.fromAscii(board(30, 16)), seed: 2, noBases: true, fog: false, players: playersOf(cu.faction, 'tg') });
    const u2 = NT.spawn(w2, cu, 0, 5, 7), shooter = NT.spawn(w2, cu.layer === 'air' ? 'tg.grunt' : 'tg.buggy', 1, 7, 7);
    stance(w2, 0, [u2], 'aggressive');
    let fired2 = 0;
    go(w2, 60, () => { for (const e of NT.drainEvents(w2)) if (e.t === 'fire' && e.id === u2.id) fired2++; return !u2.alive && false; });
    check(u2.hp < u2.maxHp && fired2 === 0 && u2.target === 0, 'shot at, it does not retaliate (it is spent only on orders)');
    sound('consume');
  }
  // expires: removed silently on time
  const w = mkWorld(board(20, 10), { fog: false });
  const u = NT.spawn(w, 'tg.grunt', 0, 5, 5);
  u.expires = w.tick + 10;
  const list = evs(w, 12);
  check(!u.alive && list.some(e => e.t === 'despawn' && e.id === u.id) && !list.some(e => e.t === 'death'), 'ent.expires: removed silently on time');
  sound('expires');
}

// ---------------------------------------------------------------------------
section('powers: charge with the building, ready, strike, reveal, buff + after, spawn, superweapon detected');
{
  const PW = NT.FACTIONS.tg.powers;
  const flare = PW.flare, bomb = PW.bombard;
  let w = mkWorld(board(40, 24), { fog: true });
  const p = w.players[0];
  check(p.powers[flare.id] && p.powers[flare.id].charge === 0 && !p.powers[flare.id].ready, 'player.powers holds one state per power of the faction');
  go(w, 60);
  let st = NT.Powers.state(w, p).find(s => s.power === flare);
  check(st && st.charge === 0 && !st.available && st.cooldownT === flare.cooldownT, 'no ' + flare.building + ': no charge, not available');
  NT.cmd(w, 0, { type: 'power', power: flare.id, x: at(30), y: at(10) });
  let list = evs(w, 1);
  check(list.some(e => e.t === 'denied' && e.def === flare.id && e.reason === 'charge'), "firing an uncharged power: denied 'charge'");
  const mast = NT.spawn(w, flare.building, 0, 2, 2), cell = NT.spawn(w, 'tg.cell', 0, 5, 2);
  go(w, 100);
  st = NT.Powers.state(w, p).find(s => s.power === flare);
  check(st.available && st.charge >= 98 && st.charge <= 101, 'with the (powered) building it charges 1 per tick (' + st.charge + ')');
  NT.kill(w, cell, null); go(w, 1);
  const c1 = p.powers[flare.id].charge; go(w, 30);
  check(p.power.low && p.powers[flare.id].charge === c1, 'low power stops a needsPower charger');
  const cell2 = NT.spawn(w, 'tg.cell', 0, 5, 2);
  NT.kill(w, mast, null); go(w, 30);
  check(p.powers[flare.id].charge === c1 && !NT.Powers.available(w, p, flare), 'losing the building keeps the charge, but it stops');
  const mast2 = NT.spawn(w, flare.building, 0, 2, 2);
  list = evs(w, flare.cooldownT, (w, l) => l.some(e => e.t === 'power_ready'));
  check(list.filter(e => e.t === 'power_ready' && e.power === flare.id).length === 1 && p.powers[flare.id].ready, "back again: it resumes and 'power_ready' fires once");
  go(w, 30);
  check(p.powers[flare.id].charge === flare.cooldownT, 'and it stays full until used');
  // reveal: lifts the fog for durT
  check(!NT.Fog.visible(w, 0, 30, 18), 'the target area is dark');
  NT.cmd(w, 0, { type: 'power', power: flare.id, x: at(30), y: at(18) });
  list = evs(w, 1);
  check(list.some(e => e.t === 'power_used' && e.power === flare.id) && NT.Fog.visible(w, 0, 30, 18) && !p.powers[flare.id].ready && p.powers[flare.id].charge <= 1,
    "reveal: the area is visible at once; 'power_used', charge back to 0");
  go(w, flare.reveal.durT + w.rules.fogEvery);
  check(!NT.Fog.visible(w, 0, 30, 18), 'and dark again after durT');
  NT.cmd(w, 0, { type: 'power', power: flare.id, x: at(30), y: at(18) });
  check(evs(w, 1).some(e => e.t === 'denied' && e.reason === 'charge'), 'used: denied until it recharges');
  void mast2; void cell2;
  sound('charge + reveal');

  // strike: telegraph, shells spread over `over`, enemies and neutrals hurt, own units not
  w = mkWorld(board(40, 24), { fog: false });
  NT.spawn(w, bomb.building, 0, 2, 2); NT.spawn(w, 'tg.cell', 0, 5, 2); NT.spawn(w, 'tg.cell', 0, 5, 5); NT.spawn(w, 'tg.cell', 0, 8, 2);
  go(w, bomb.cooldownT + 2);
  check(w.players[0].powers[bomb.id].ready, bomb.id + ' charged after cooldownT');
  const A = bomb.strike, cx = 25, cy = 12;
  const foe = NT.spawn(w, 'tg.core', 1, cx - 1, cy - 1), mine = [NT.spawn(w, 'tg.grunt', 0, cx + 1, cy + 2), NT.spawn(w, 'tg.grunt', 0, cx - 2, cy)];
  foe.hp = foe.maxHp = 1e6;
  stance(w, 0, mine, 'passive');
  NT.cmd(w, 0, { type: 'power', power: bomb, x: at(cx), y: at(cy) });            // a def object is accepted as well as the id
  const t0 = w.tick;                                           // the command runs during this tick
  const impacts = [], when = [];
  list = [];
  go(w, A.delayT + A.overT + 5, () => { for (const e of NT.drainEvents(w)) { list.push(e); if (e.t === 'impact' && e.proj === 'shell') { impacts.push(e); when.push(w.tick - 1 - t0); } } return false; });
  const warn = list.find(e => e.t === 'strike_warn');
  check(!!warn && warn.radius === A.radiusPx && warn.delay === A.delayT && warn.x === at(cx), "strike_warn {radius, delay} telegraphs it");
  check(impacts.length === A.shells && impacts.every(e => NT.dist(e.x, e.y, at(cx), at(cy)) <= A.radiusPx + 1e-6), A.shells + ' shells, all inside the radius');
  check(foe.hp < foe.maxHp && mine.every(u => u.hp === u.maxHp), 'enemies are hit, the caster\'s own units are not');
  check(when[0] === A.delayT && when[when.length - 1] === A.delayT + A.overT, 'the first shell lands after delayT (' + when[0] + '), the last overT later (' + when[when.length - 1] + ')');
  sound('strike');

  // buff + after, spawn: tx (test faction)
  w = NT.createWorld({ map: NT.Map.fromAscii(board(30, 16)), seed: 4, noBases: true, fog: true, players: playersOf('tx', 'tg') });
  const tp = w.players[0], K = NT.FACTIONS.tx.powers.kick, SU = NT.FACTIONS.tx.powers.summon;
  NT.spawn(w, 'tx.beacon', 0, 2, 2);
  go(w, 2);
  check(tp.powers[K.id].charge >= Math.round(K.initial * K.cooldownT), 'initial: the first time the building is owned, charge jumps to initial x cooldownT (' + tp.powers[K.id].charge + ')');
  go(w, K.cooldownT);
  const al = [NT.spawn(w, 'tx.sapper', 0, 6, 6), NT.spawn(w, 'tx.sapper', 0, 7, 6)], en = NT.spawn(w, 'tg.grunt', 1, 6, 7), out = NT.spawn(w, 'tx.sapper', 0, 6, 12);
  stance(w, 1, [en], 'passive');
  NT.damage(w, al[0], 60 / al[0].mods.taken, null, null, null);
  const hpA = al[0].hp;
  NT.cmd(w, 0, { type: 'power', power: K.id, x: at(6), y: at(6) });
  go(w, 1);
  check(al.every(u => close(u.mods.dmg, K.buff.mods.dmg)) && close(al[0].hp, Math.min(al[0].maxHp, hpA + K.buff.heal * al[0].maxHp)), 'buff: allies in the radius get the mods and heal ' + K.buff.heal + ' x maxHp');
  check(close(en.mods.dmg, 1) && close(out.mods.dmg, 1), 'enemies and allies outside are untouched');
  go(w, K.buff.durT);
  check(al.every(u => close(u.mods.dmg, K.buff.after.mods.dmg)), 'then the comedown (after) for its duration');
  go(w, K.buff.after.durT + 1);
  check(al.every(u => close(u.mods.dmg, 1)), 'then nothing');
  sound('buff');
  go(w, SU.cooldownT);
  NT.cmd(w, 0, { type: 'power', power: SU.id, x: at(26), y: at(12) });
  list = evs(w, 1);
  check(list.some(e => e.t === 'denied' && e.reason === 'target' && e.def === SU.id), "spawn into the fog: denied 'target'");
  NT.cmd(w, 0, { type: 'power', power: SU.id, x: at(8), y: at(4) });
  list = evs(w, SU.spawn.delayT + 1);
  const sw = list.find(e => e.t === 'strike_warn'), sp = list.filter(e => e.t === 'spawn').map(e => w.byId.get(e.id)).filter(u => u && u.def.id === SU.spawn.def);
  check(!!sw && close(sw.radius, 1.5 * T) && sw.delay === SU.spawn.delayT, 'spawn telegraphs the spot (1.5 cells) ...');
  check(sp.length === SU.spawn.count && sp.every(u => u.owner === 0 && cheb(u, 8, 4) <= 2 && u.expires === w.tick - 1 + SU.spawn.lifetimeT), '... and after delayT ' + SU.spawn.count + ' summons appear around it with a lifetime');
  list = evs(w, SU.spawn.lifetimeT + 2);
  check(sp.every(u => !u.alive) && list.filter(e => e.t === 'despawn').length === SU.spawn.count, 'they vanish when it runs out');
  sound('spawn power');

  // a real spawn power from the data (generic)
  const realSpawn = NT.FACTION_LIST.map(f => Object.values(f.powers).find(x => x.kind === 'spawn')).find(Boolean);
  if (realSpawn) check(NT.DEFS[realSpawn.spawn.def] && realSpawn.spawn.lifetimeT > 0, realSpawn.id + ' is a well-formed spawn power');

  // superweapon detected (generic: role 'super'): always seen by every team
  const sup = findDef(d => d.kind === 'building' && d.role === 'super');
  if (!sup) console.log("  (skipped: no role 'super' structure)");
  else {
    w = mkWorld(board(48, 30), { fog: true });
    NT.spawn(w, 'tg.core', 0, 1, 1);
    const s = NT.spawn(w, sup, 1, 40, 24), plain = NT.spawn(w, 'tg.cell', 1, 40, 20);
    go(w, 8);
    check(NT.Fog.canSee(w, 0, s) && !NT.Fog.canSee(w, 0, plain) && !NT.Fog.visible(w, 0, 41, 25), sup.id + " (role 'super') is always seen by the enemy, deep in the fog; a plain structure next to it is not");
    sound('super');
  }
}

section('victory: defeat, turf reverts, game over, surrender');
{
  const turf = traitDef('capturable', d => d.kind === 'building');
  let w = NT.createWorld({ map: NT.Map.fromAscii(board(40, 24)), seed: 9, fog: false, players: playersOf('tg', 'tg') });
  const p1 = w.players[1], hq1 = w.ents.find(e => e.owner === 1 && e.def.role === 'hq');
  const t1 = NT.spawn(w, turf, 1, 20, 3), cell1 = NT.spawn(w, 'tg.cell', 1, hq1.cx - 3, hq1.cy);
  go(w, 5);
  check(!p1.defeated && p1.hadBase && !w.over, 'both start standing');
  NT.kill(w, hq1, null);
  const list = evs(w, 2);
  check(p1.defeated && list.some(e => e.t === 'defeated' && e.player === 1), "losing the last structure that counts: defeated");
  check(!cell1.alive && w.ents.every(e => !e.alive || e.owner !== 1) && p1.nUnits === 0, 'everything they owned is destroyed ...');
  check(t1.alive && t1.owner === NT.NEUTRAL, '... except captured turf, which reverts to neutral');
  const go1 = list.find(e => e.t === 'gameover');
  check(w.over && w.winner === w.players[0].team && !!go1 && go1.winner === w.players[0].team, 'one team left: gameover, winner = team ' + w.winner);
  const n0 = w.players[0].nUnits;
  NT.cmd(w, 0, { type: 'move', ids: w.ents.filter(e => e.owner === 0 && e.kind === 'unit').map(e => e.id), x: at(30), y: at(20) });
  go(w, 30);
  check(w.players[0].nUnits === n0 && w.ents.filter(e => e.owner === 0 && e.kind === 'unit').every(u => !u.order), 'after the game is over the sim keeps stepping; commands are ignored');
  sound('defeat');

  // a deploy unit keeps a player in the game (generic)
  const dep = traitDef('deploy', d => d.traits.deploy.into);
  if (dep) {
    w = NT.createWorld({ map: NT.Map.fromAscii(board(40, 24)), seed: 9, fog: false, players: playersOf(dep.faction, dep.faction) });
    const hq = w.ents.find(e => e.owner === 1 && e.def.role === 'hq'), rov = NT.spawn(w, dep, 1, 30, 20);
    go(w, 2);
    NT.kill(w, hq, null); go(w, 3);
    check(!w.players[1].defeated && !w.over, 'no structures left but a ' + dep.id + ' (deploys into a base): still in the game');
    NT.kill(w, rov, null); go(w, 3);
    check(w.players[1].defeated && w.over, 'the last one dies: defeated');
  }
  // surrender; teams of two
  w = NT.createWorld({ map: NT.Map.fromAscii(board(40, 24, (x, y) => (x === 30 && y === 2) ? '3' : null)), seed: 9, fog: false,
    players: [{ faction: 'tg', team: 0 }, { faction: 'tg', team: 1 }, { faction: 'tg', team: 1 }] });
  NT.cmd(w, 1, { type: 'surrender' });
  let l2 = evs(w, 2);
  check(w.players[1].defeated && l2.some(e => e.t === 'defeated' && e.player === 1) && !w.over, 'surrender defeats at once; its teammate fights on');
  NT.cmd(w, 1, { type: 'produce', def: 'tg.cell' });
  go(w, 2);
  check(!w.players[1].queues.rigs.items.length, 'a defeated player\'s commands are ignored');
  NT.cmd(w, 2, { type: 'surrender' });
  l2 = evs(w, 2);
  check(w.over && w.winner === 0 && l2.some(e => e.t === 'gameover' && e.winner === 0), 'the last of the team gives up: team 0 wins');
  // sandboxes without bases never end
  w = mkWorld(board(20, 10));
  NT.spawn(w, 'tg.grunt', 0, 3, 3);
  go(w, 30);
  check(!w.over && !w.players[0].defeated && !w.players[1].defeated, 'a world with no bases at all never ends by itself');
  sound('surrender');
}

// ---------------------------------------------------------------------------
// A generic "build everything" bot: reads only NT.Prod.options / findPlace / player state and acts only through
// NT.cmd. Every BOT_EVERY ticks: place what is ready, keep a power margin, queue the next def nobody has reached yet.
const BOT_EVERY = 10;
function botRows(wd, ht) {
  return board(wd, ht, (x, y) => (x >= 16 && x <= 19 && y >= 3 && y <= 8) || (x >= wd - 20 && x <= wd - 17 && y >= ht - 9 && y <= ht - 4) ? '$' : null)
    .map((r, y) => y === 0 ? '.' + r.slice(1) : y === ht - 1 ? r.slice(0, wd - 1) + '.' : r)
    .map((r, y) => y === 6 ? r.slice(0, 6) + '1' + r.slice(7) : y === ht - 9 ? r.slice(0, wd - 9) + '2' + r.slice(wd - 8) : r);
}
function botStep(w, pid, st) {
  const p = w.players[pid], hq = w.ents.find(e => e.alive && e.owner === pid && e.kind === 'building' && e.def.role === 'hq') ||
                               w.ents.find(e => e.alive && e.owner === pid && e.kind === 'building');
  if (!hq || p.defeated) return;
  const opts = NT.Prod.options(w, p), qs = p.queues;
  for (const qid in qs) {
    const q = qs[qid];
    if (!q.ready) continue;
    const spot = NT.Prod.findPlace(w, p, q.ready, hq.cx + 1, hq.cy + 1, { maxR: 18, gap: 1, avoidRes: true }) ||
                 NT.Prod.findPlace(w, p, q.ready, hq.cx + 1, hq.cy + 1, { maxR: 22 });
    if (spot) NT.cmd(w, pid, { type: 'place', def: q.ready.id, cx: spot[0], cy: spot[1] });
  }
  const margin = p.power.made - p.power.used;
  const plant = opts.filter(o => o.ok && o.def.kind === 'building' && o.def.power > 0).sort((a, b) => a.def.cost - b.def.cost)[0];
  const plantBusy = plant && (qs[plant.def.queue].items.length || qs[plant.def.queue].ready);
  if (plant && margin < 60 && !plantBusy) { NT.cmd(w, pid, { type: 'produce', def: plant.def.id }); return; }
  for (const o of opts) {
    const q = qs[o.def.queue];
    if (st.reached[o.def.id] || !o.ok || q.items.length || q.ready) continue;
    if (plant && o.def.queue === plant.def.queue && margin < 60) continue;
    NT.cmd(w, pid, { type: 'produce', def: o.def.id });
  }
}
function botWorld(fa, fb, opts) {
  return NT.createWorld(Object.assign({ map: NT.Map.fromAscii(botRows(56, 40)), seed: 21, fog: true, players: [{ faction: fa }, { faction: fb }] }, opts || {}));
}
const botNote = (w, st, pid) => {
  const p = w.players[pid];
  for (const ev of NT.drainEvents(w)) {
    if (ev.t === 'produced' && ev.owner === pid) st.reached[ev.def] = true;
    if (ev.t === 'dump') st.dumps++;
    if (ev.t === 'death') st.deaths++;
  }
  for (const id in p.owned) if (p.owned[id] > 0) st.reached[id] = true;
};

section('build everything: every playable faction (and the fixture) can reach its whole tech tree through commands');
{
  const LIMIT = 20 * 60 * 15;                                   // 15 game minutes
  for (const f of NT.FACTION_LIST.concat(NT.FACTION_LIST.indexOf(NT.FACTIONS.tg) < 0 ? [NT.FACTIONS.tg] : [])) {   // the fixture registers as playable
    const w = botWorld(f.id, 'tg', { players: [{ faction: f.id, credits: 60000 }, { faction: 'tg' }] });
    const st = { reached: {}, dumps: 0, deaths: 0 }, want = f.defs.filter(d => d.queue);
    let t = 0;
    for (; t < LIMIT; t += BOT_EVERY) {
      botStep(w, 0, st);
      go(w, BOT_EVERY);
      botNote(w, st, 0);
      if (want.every(d => st.reached[d.id])) break;
    }
    const miss = want.filter(d => !st.reached[d.id]).map(d => d.key);
    console.log('  ' + f.id + ': tech tree done in ' + (t / NT.TPS / 60).toFixed(1) + ' game minutes, ' + st.dumps + ' deliveries');
    check(miss.length === 0, f.id + ': every buildable def reached in ' + (t / NT.TPS / 60).toFixed(1) + ' game minutes' + (miss.length ? ' — missing ' + miss.join(', ') : ''));
    check(st.dumps > 0, f.id + ': its harvesters delivered along the way (' + st.dumps + ' dumps)');
    sound('build everything ' + f.id);
  }
}

section('determinism + performance: full matches with economy, production and combat');
{
  // 3 minutes: both sides run the bot from their real start; at 1:40 and 2:30 every armed unit attack-moves at the enemy HQ
  const match = () => {
    const fa = NT.FACTION_LIST[0].id, fb = NT.FACTION_LIST[1 % NT.FACTION_LIST.length].id;
    const w = botWorld(fa, fb, { seed: 31 });
    const st = [{ reached: {}, dumps: 0, deaths: 0 }, { reached: {}, dumps: 0, deaths: 0 }], hashes = [];
    for (let t = 0; t < 3600; t += BOT_EVERY) {
      botStep(w, 0, st[0]); botStep(w, 1, st[1]);
      if (t === 2000 || t === 3000) for (let pid = 0; pid < 2; pid++) {
        const foe = w.ents.find(e => e.alive && e.owner === 1 - pid && e.kind === 'building');
        const army = w.ents.filter(e => e.alive && e.owner === pid && e.kind === 'unit' && NT.Combat.armed(e.def));
        if (foe && army.length) NT.cmd(w, pid, { type: 'amove', ids: army.map(e => e.id), x: foe.x, y: foe.y });
      }
      for (let k = 0; k < BOT_EVERY; k++) {
        go(w, 1);
        const evs2 = NT.drainEvents(w);
        for (const ev of evs2) { if (ev.t === 'dump') st[0].dumps++; if (ev.t === 'death') st[0].deaths++; if (ev.t === 'produced') st[ev.owner === 0 ? 0 : 1].reached[ev.def] = true; }
      }
      if (w.tick % 300 === 0) hashes.push(NT.hashWorld(w));
    }
    return { hashes: hashes, st: st, w: w };
  };
  const a = match(), b = match();
  console.log('  match: ' + a.st[0].dumps + ' deliveries, ' + Object.keys(a.st[0].reached).length + ' + ' + Object.keys(a.st[1].reached).length + ' unit types produced, ' + a.st[0].deaths + ' deaths');
  check(a.hashes.length === 12 && a.hashes.join() === b.hashes.join(), '3-minute bot match run twice: identical NT.hashWorld every 15 s');
  check(new Set(a.hashes).size === 12 && a.st[0].dumps > 4 && Object.keys(a.st[0].reached).length + Object.keys(a.st[1].reached).length > 4 && a.st[0].deaths > 0,
    'and a real one (' + a.st[0].dumps + ' deliveries, ' + Object.keys(a.st[0].reached).length + ' + ' + Object.keys(a.st[1].reached).length + ' unit types produced, ' + a.st[0].deaths + ' deaths)');
  sound('match determinism');
}
{
  // 2 players with bases and running economies + 150 armed units, fog on; only NT.step is timed
  const w = botWorld(NT.FACTION_LIST[0].id, NT.FACTION_LIST[1 % NT.FACTION_LIST.length].id, { seed: 41 });
  const st = [{ reached: {}, dumps: 0, deaths: 0 }, { reached: {}, dumps: 0, deaths: 0 }];
  for (let pid = 0; pid < 2; pid++) {
    const p = w.players[pid], dropoff = p.faction.defs.find(d => d.traits.dropoff && d.queue), hq = w.ents.find(e => e.owner === pid && e.def.role === 'hq');
    const spot = NT.Prod.findPlace(w, p, dropoff, hq.cx + 1, hq.cy + 1, { maxR: 18, gap: 1, avoidRes: true });
    const d = NT.spawn(w, dropoff, pid, spot[0], spot[1]);
    for (let k = 0; k < 2; k++) NT.spawn(w, dropoff.traits.dropoff.freeUnit, pid, d.cx + 1, d.cy + d.h);
    const armed = p.faction.defs.filter(x => x.kind === 'unit' && NT.Combat.armed(x));
    for (let i = 0; i < 75; i++) NT.spawn(w, armed[i % armed.length], pid, pid ? 40 - (i % 8) : 14 + (i % 8), 14 + ((i / 8) | 0));
  }
  let total = 0, max = 0;
  const N = 1200;
  for (let t = 0; t < N; t++) {
    if (t % BOT_EVERY === 0) { botStep(w, 0, st[0]); botStep(w, 1, st[1]); }
    if (t === 100) for (let pid = 0; pid < 2; pid++) {
      const army = w.ents.filter(e => e.alive && e.owner === pid && e.kind === 'unit' && NT.Combat.armed(e.def));
      NT.cmd(w, pid, { type: 'amove', ids: army.map(e => e.id), x: at(28), y: at(20) });
    }
    const t0 = process.hrtime.bigint();
    NT.step(w);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    total += ms; if (ms > max) max = ms;
    if (w.tick % 10 === 0) for (const m of NT.debugCheck(w)) if (dbg.length < 6) dbg.push(m);
    for (const ev of NT.drainEvents(w)) { if (ev.t === 'dump') st[0].dumps++; if (ev.t === 'death') st[0].deaths++; }
  }
  const avg = total / N;
  console.log('  perf full economy, 2 bases + 150 armed units, 56x40, fog on, ' + N + ' ticks: avg ' + avg.toFixed(3) + ' ms, max ' + max.toFixed(2) + ' ms per NT.step (' + st[0].dumps + ' deliveries, ' + st[0].deaths + ' deaths)');
  check(st[0].dumps > 0 && st[0].deaths > 20, 'economy and battle both ran');
  check(avg < 4, 'average step under the 4 ms target (' + avg.toFixed(3) + ' ms)');
  check(max < 36, 'worst step ' + max.toFixed(2) + ' ms (target < 12 ms; fails only beyond 36 ms)');
  sound('perf economy');
}

// ===========================================================================
// THE SKIRMISH AI (ai.js). Real matches on generated maps, fog on, both players AI, driven by NT.step alone.
// runMatch (test/balance.js) plays one; the balance harness uses the same function with more seeds.
// ===========================================================================
const { runMatch } = require('./balance');
const AI_MAX_MIN = 40;                                        // a match that has not ended after this is a failure
const AI_SEEDS = [101, 202, 303];
const aiFacs = NT.FACTION_LIST.map(f => f.id);               // the shipped gangs + the fixture
const shipped = aiFacs.filter(id => require('fs').existsSync(require('path').join(__dirname, '..', 'js', 'factions', id + '.js')));

section('ai: difficulty table, fairness, a brain only for AI players, commands only for itself');
{
  const L = NT.AI.LEVELS;
  check(L.easy && L.normal && L.hard, 'NT.AI.LEVELS has easy / normal / hard');
  check(L.normal.prodMul === 1 && L.normal.incomeMul === 1, 'normal is fair: production and income multipliers exactly 1');
  check(L.easy.prodMul < 1 && L.easy.incomeMul < 1, 'easy is handicapped (< 1)');
  check(L.hard.prodMul > 1 && L.hard.incomeMul > 1 && L.hard.prodMul <= 1.25 && L.hard.incomeMul <= 1.25, 'hard is only slightly boosted (1 < x <= 1.25)');
  check(L.easy.think > L.normal.think && L.normal.think > L.hard.think, 'harder levels think more often');
  // a human (no ai) and a hard AI: the AI never sends a command for the human's player
  const fa = shipped[0], fb = shipped[1 % shipped.length];
  const w = NT.createWorld({ map: NT.MapGen.generate({ seed: 7, size: 'small', players: 2 }), seed: 7, players: [{ faction: fa }, { faction: fb, ai: 'hard' }] });
  const realCmd = NT.cmd, sent = [0, 0], types = {};
  NT.cmd = function (world, pid, c) { if (world === w) { sent[pid]++; types[c.type] = true; } return realCmd(world, pid, c); };
  try { go(w, 4 * 60 * NT.TPS); } finally { NT.cmd = realCmd; }
  check(sent[0] === 0 && sent[1] > 50, 'the AI only commands its own player (' + sent[1] + ' commands for it, ' + sent[0] + ' for the human)');
  check(['produce', 'place', 'rally', 'amove'].every(t => types[t]), 'it builds, places, rallies and moves troops (' + Object.keys(types).join(', ') + ')');
  check(!NT.AI.brain(w, 0) && !!NT.AI.brain(w, 1), 'a brain exists for the AI player only');
  check(w.players[0].incomeMul === 1 && w.players[0].prodMul === 1 && w.players[1].incomeMul === L.hard.incomeMul && w.players[1].prodMul === L.hard.prodMul,
    'difficulty handicaps are set on the AI player only');
  const p1 = w.players[1], roles = {};
  for (const e of w.ents) if (e.alive && e.owner === 1 && e.kind === 'building') roles[e.def.role] = true;
  check(roles.power && roles.dropoff && roles.producer, 'after 4 minutes the AI has power, a drop-off and a producer (' + Object.keys(roles).join(', ') + ')');
  check(p1.stats.income > 1000 && w.ents.some(e => e.alive && e.owner === 1 && e.def.traits.harvester), 'and harvests (' + Math.round(p1.stats.income) + ' credits earned)');
  sound('ai vs human');
}

section('ai: AI vs AI on normal — every ordered faction pair (fixture included), 3 seeds, generated small maps, fog on');
{
  const roles = {}, aiSum = {}, wins = {}, games = {}, qused = {}, denied = {};
  let capFlips = 0;
  let ms = 0, steps = 0, peak = 0, longest = 0, shortest = Infinity, stuckN = 0, stuckMsg = '';
  const t0 = Date.now();
  for (const a of aiFacs) for (const b of aiFacs) for (const seed of AI_SEEDS) {
    const hv = new Map(), held = [{}, {}];                     // held[pid][queue] = ticks it owned a producer of that queue
    const r = runMatch({ factions: [a, b], seed: seed, size: 'small', maxMin: AI_MAX_MIN, every: 200, onTick: function (w) {
      for (const m of NT.debugCheck(w)) if (dbg.length < 6) dbg.push(a + ' v ' + b + ' #' + seed + ' ' + m);
      for (const p of w.players) for (const q of p.faction.queues) if (NT.Prod.producers(w, p, q.id)) held[p.id][q.id] = (held[p.id][q.id] || 0) + 200;
      for (const p of w.players) if (!Number.isFinite(p.credits) || p.credits < 0) dbg.push('player ' + p.id + ' credits ' + p.credits);
      // every harvester's cargo or position changes at least once per 90 s while there is resource and a drop-off
      const res = NT.Map.totalRes(w.map);
      for (const e of w.ents) {
        if (!e.alive || !e.def.traits.harvester) continue;
        const h = hv.get(e.id);
        if (!h || h.cargo !== e.cargo || Math.abs(h.x - e.x) > 1 || Math.abs(h.y - e.y) > 1) { hv.set(e.id, { cargo: e.cargo, x: e.x, y: e.y, t: w.tick }); continue; }
        const drop = w.ents.some(o => o.alive && o.owner === e.owner && o.def.traits.dropoff);
        if (w.tick - h.t > 90 * NT.TPS && drop && res > 2000) { stuckN++; stuckMsg = stuckMsg || (a + ' v ' + b + ' #' + seed + ' ' + e.def.id + '#' + e.id + ' at ' + e.cx + ',' + e.cy); h.t = w.tick; }
      }
    } });
    const tag = a + ' v ' + b + ' #' + seed;
    check(r.over && r.winner >= 0, tag + ': the match ends with a winner within ' + AI_MAX_MIN + ' min (' + r.minutes.toFixed(1) + ' min)');
    check(r.harvested[0] > 0 && r.harvested[1] > 0, tag + ': both sides harvest (' + r.harvested.map(Math.round).join(' / ') + ')');
    check(r.hurtFoe[0] > 0 && r.hurtFoe[1] > 0, tag + ': both sides attack (enemy hurt ' + r.hurtFoe.join(' / ') + ' times)');
    for (let i = 0; i < 2; i++) {
      const f = NT.FACTIONS[r.factions[i]], made = {};
      for (const id in r.produced[i]) made[NT.DEFS[id].queue] = true;
      // the winner, and a loser that lasted 8+ minutes, use every unit queue it held a producer of for 2+ minutes
      // (a gang crushed early may die paying for its first heavy item; the per-faction total below still counts it)
      const qs = f.queues.filter(q => q.kind === 'unit' && held[i][q.id] >= 2 * 60 * NT.TPS).map(q => q.id), miss = qs.filter(q => !made[q]);
      if (r.winner === i || r.minutes >= 8) check(miss.length === 0, tag + ': ' + f.id + ' produced units from every unit queue it held a producer of for 2+ minutes (' + qs.join(', ') + ')' + (miss.length ? ' — none from ' + miss.join(', ') : ''));
      const QU = qused[f.id] = qused[f.id] || {};
      for (const q of f.queues) if (q.kind === 'unit' && made[q.id]) QU[q.id] = (QU[q.id] || 0) + 1;
      const R = roles[f.id] = roles[f.id] || {};
      for (const id in r.placed[i]) R[NT.DEFS[id].role] = true;
      const b2 = r.brains[i];
      for (const key in b2) if (typeof b2[key] === 'number') aiSum[key] = (aiSum[key] || 0) + b2[key];
      for (const kind in b2.powers) aiSum['power:' + kind] = (aiSum['power:' + kind] || 0) + b2.powers[kind];
      games[f.id] = (games[f.id] || 0) + 1;
      if (r.winner === i) { const key = f.id + '>' + r.factions[1 - i]; wins[key] = (wins[key] || 0) + 1; }
    }
    capFlips += r.captured[0] + r.captured[1];
    for (const d of r.denied) for (const why in d) denied[why] = (denied[why] || 0) + d[why];
    ms += r.avgMs * r.ticks; steps += r.ticks; peak = Math.max(peak, r.peakEnts);
    longest = Math.max(longest, r.minutes); shortest = Math.min(shortest, r.minutes);
  }
  const avg = ms / steps;
  console.log('  ' + aiFacs.length * aiFacs.length * AI_SEEDS.length + ' matches in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s: ' + shortest.toFixed(1) + ' - ' + longest.toFixed(1) +
    ' sim min, avg ' + avg.toFixed(3) + ' ms per NT.step, peak ' + peak + ' entities');
  console.log('  AI totals: ' + Object.keys(aiSum).map(k => k + ' ' + aiSum[k]).join(', ') + ', turf taken ' + capFlips);
  console.log('  denied commands: ' + (Object.keys(denied).map(k => k + ' ' + denied[k]).join(', ') || 'none'));
  check(stuckN === 0, 'no harvester sat still for 90 s while resource and a drop-off existed (' + stuckN + (stuckMsg ? ', first: ' + stuckMsg : '') + ')');
  check(avg < 1.5, 'average step time within budget (' + avg.toFixed(3) + ' ms < 1.5 ms)');
  for (const id of aiFacs) {
    const I = NT.AI._info({ sys: {} }, NT.FACTIONS[id]), want = Object.keys(I.role).filter(r => r !== 'hq' && r !== 'turf');
    const miss = want.filter(r => !roles[id][r]);
    check(miss.length === 0, id + ': across its matches the AI placed every structure role it has (' + want.join(', ') + ')' + (miss.length ? ' — never ' + miss.join(', ') : ''));
  }
  for (const id of aiFacs) for (const q of NT.FACTIONS[id].queues) {
    if (q.kind !== 'unit') continue;
    const n = (qused[id] && qused[id][q.id]) || 0;
    check(n >= games[id] * 0.85, id + ': units came out of its ' + q.id + ' queue in ' + n + ' of ' + games[id] + ' matches (>= 85%)');
  }
  for (const id of shipped) check((wins['tg>' + id] || 0) > 0, 'extensibility: the fixture faction wins at least sometimes against ' + id + ' (' + (wins['tg>' + id] || 0) + ' of ' + 2 * AI_SEEDS.length + ')');
  check(capFlips > 0, 'turf actually changed hands to the AI (' + capFlips + ' captures)');
  for (const key of ['waves', 'defends', 'captureOrders', 'retreats', 'repairs', 'expansions']) check(aiSum[key] > 0, 'the AI ' + key + ' in these matches (' + (aiSum[key] || 0) + ')');
  check(Object.keys(aiSum).some(k => k.indexOf('power:') === 0), 'the AI fires support powers (' + Object.keys(aiSum).filter(k => k.indexOf('power:') === 0).map(k => k + ' ' + aiSum[k]).join(', ') + ')');
  sound('ai vs ai');
}

section('ai: presets, determinism, difficulty');
{
  // every menu preset, both start slots, the shipped gangs
  for (const m of NT.MAPS) for (const pair of [[shipped[0], shipped[1 % shipped.length]], [shipped[1 % shipped.length], shipped[0]]]) {
    const w = NT.createWorld({ map: NT.MapGen.fromPreset(m.id), seed: 5, players: [{ faction: pair[0], ai: 'normal' }, { faction: pair[1], ai: 'normal' }] });
    const n = go(w, AI_MAX_MIN * 60 * NT.TPS, x => x.over);
    check(w.over && w.winner >= 0, m.id + ' (' + m.size + ') ' + pair.join(' v ') + ': ends with a winner (' + (n / NT.TPS / 60).toFixed(1) + ' min)');
  }
  // same seed, same match: identical world hashes every 30 s
  const hashes = function () {
    const out = [];
    runMatch({ factions: [shipped[0], 'tg'], seed: 404, size: 'small', maxMin: 12, every: 600, onTick: function (w) { out.push(NT.hashWorld(w)); } });
    return out;
  };
  const h1 = hashes(), h2 = hashes();
  check(h1.length > 6 && h1.join() === h2.join(), 'an AI match run twice gives identical NT.hashWorld every 30 s (' + h1.length + ' samples)');
  check(new Set(h1).size === h1.length, 'and the world really changes between samples');
  // hard beats easy; easy still plays a real game
  let hardWins = 0, easyIncome = 0;
  for (const seed of [11, 12]) for (const flip of [0, 1]) {
    const diff = flip ? ['easy', 'hard'] : ['hard', 'easy'];
    const r = runMatch({ factions: flip ? [shipped[1 % shipped.length], shipped[0]] : [shipped[0], shipped[1 % shipped.length]], seed: seed, size: 'small', diff: diff, maxMin: AI_MAX_MIN });
    if (r.winner >= 0 && diff[r.winner] === 'hard') hardWins++;
    easyIncome += r.harvested[diff.indexOf('easy')];
  }
  check(hardWins >= 3, 'hard beats easy in at least 3 of 4 matches (' + hardWins + ')');
  check(easyIncome > 0, 'easy harvests too (' + Math.round(easyIncome) + ')');
  sound('ai presets');
}

section('ai: faction.ai hints are obeyed (opening, harvesters, attackAt) — set on the fixture for one match');
{
  const tg = NT.FACTIONS.tg, saved = tg.ai, power = tg.defs.find(d => d.role === 'power' && d.queue), prod = tg.defs.find(d => d.role === 'producer' && d.queue && d.requires.length);
  const drop = tg.defs.find(d => d.traits.dropoff && d.queue), harv = tg.defs.find(d => d.traits.harvester);
  const opening = [power.key, prod.key, power.key, drop.key];                 // differs from the generic order (drop-off first)
  const play = function (hints) {
    const out = { order: [], thr: 0, waveAt: -1, bought: 0 }, seen = {};
    tg.ai = hints;
    try {
      const r = runMatch({ factions: ['tg', shipped[0]], seed: 77, size: 'small', maxMin: 10, every: 20, onTick: function (w) {
        const B = NT.AI.brain(w, 0);
        if (B && !out.thr) out.thr = NT.AI._threshold(w, B);
        if (B && out.waveAt < 0 && B.stats.waves > 0) out.waveAt = w.tick;
        for (const e of w.ents) if (e.alive && e.owner === 0 && e.kind === 'building' && e.def.queue === power.queue && !seen[e.id]) { seen[e.id] = true; out.order.push(e.def.key); }
      } });
      out.bought = r.produced[0][harv.id] || 0;                               // free drop-off harvesters emit no 'produced'
    } finally { tg.ai = saved; }
    return out;
  };
  const hinted = play({ opening: opening, harvesters: 1, attackAt: 0.5 }), plain = play({});
  const order = hinted.order.slice(1, 5), thr = hinted.thr, waveAt = hinted.waveAt;   // order[0] is the start HQ
  check(order.join() === opening.join(), 'opening hint: the first structures follow it (' + order.join(', ') + '; without hints: ' + plain.order.slice(1, 5).join(', ') + ')');
  check(hinted.bought < plain.bought, 'harvesters hint (1 per drop-off) buys fewer harvesters than the default 3 (' + hinted.bought + ' vs ' + plain.bought + ')');
  check(Math.abs(thr - NT.AI.LEVELS.normal.firstWave * 0.5) < 1e-9, 'attackAt 0.5 halves the first wave (' + thr + ')');
  check(waveAt > 0, 'and a wave went out (' + (waveAt / NT.TPS / 60).toFixed(1) + ' min)');
}

section('ai: extensibility — no engine file names a shipped faction, unit, building or power');
{
  const fs = require('fs'), path = require('path'), root = path.join(__dirname, '..');
  const ids = [], keys = new Set();
  for (const id in NT.FACTIONS) {
    if (!fs.existsSync(path.join(root, 'js', 'factions', id + '.js'))) continue;      // test fixtures are not shipped
    const f = NT.FACTIONS[id];
    ids.push(id);
    for (const d of f.defs) keys.add(d.key);
    for (const k in f.powers) keys.add(k);
  }
  // string literals of a source file, comments skipped
  const literals = function (src) {
    const out = [];
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); if (i < 0) break; i++; continue; }
      if (c !== "'" && c !== '"' && c !== '`') continue;
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { s += src[j + 1]; j += 2; } else s += src[j++]; }
      out.push(s); i = j;
    }
    return out;
  };
  const scan = function (file, withKeys) {
    const hits = [];
    for (const s of literals(fs.readFileSync(path.join(root, file), 'utf8'))) {
      if (ids.some(id => s === id || s.indexOf(id + '.') === 0) || (withKeys && keys.has(s))) hits.push(s);
    }
    return hits;
  };
  const probe = literals("x = 'a'; // '" + ids[0] + "'\n/* \"" + ids[0] + "\" */ y = \"" + ids[0] + ".k\"; z = `b`;");
  check(probe.join('|') === 'a|' + ids[0] + '.k|b', 'the literal scanner reads strings and skips comments (' + probe.join('|') + ')');
  const engine = require('./harness').files.filter(f => f.indexOf('js/factions/') !== 0);
  check(engine.length > 10, 'engine = every data-sim file of index.html outside js/factions/ (' + engine.length + ')');
  for (const f of engine) {
    const hits = scan(f, true);
    check(hits.length === 0, f + ': no shipped faction id / def key / power key as a string literal' + (hits.length ? ' — found ' + hits.join(', ') : ''));
  }
  // presentation files may share plain words with def keys (an art shape, a sound) but never name a faction
  const pres = fs.readdirSync(path.join(root, 'js')).filter(f => f.endsWith('.js')).map(f => 'js/' + f).filter(f => engine.indexOf(f) < 0);
  const presHits = [];
  for (const f of pres) for (const h of scan(f, false)) presHits.push(f + ': ' + h);
  check(presHits.length === 0, 'presentation files name no shipped faction id' + (presHits.length ? ' — ' + presHits.join(', ') : ''));
}

// ---------------------------------------------------------------------------
section('build: every sim file listed in index.html exists');
check(missing.length === 0, 'missing sim files: ' + missing.join(', '));

done();
