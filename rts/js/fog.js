'use strict';
// ============================================================================
// NEON TURF — fog.js : team visibility  (HEADLESS-SAFE, DETERMINISTIC)
// System 'fog' (order 90).
//
// Per team (world.teams[t]):
//   vis       Uint16Array  how many sight sources see the cell right now
//   explored  Uint8Array   1 once the cell has ever been seen (sticky)
// Recomputed from scratch every rules.fogEvery ticks: every alive, non-hidden
// entity of the team stamps NT.circleOffsets(def.sight x mods.sight) around its
// cell (buildings: around the footprint centre, radius + half the footprint).
// A freshly spawned entity stamps its circle at once (onSpawn), so tick 0 and
// units leaving a producer never wait for the next pass.
//
//   NT.Fog.visible(world, team, cx, cy)    cell in sight now (always true with fog off)
//   NT.Fog.explored(world, team, cx, cy)   cell seen at least once (always true with fog off)
//   NT.Fog.canSee(world, team, ent)        own-team entities: always. Others: not hidden, not an
//                                          undetected stealth unit (ent.stealth && seenUntil <= tick),
//                                          and — unless fog is off — some cell it covers is in sight.
//                                          A structure with role 'super' is always seen ("superweapon detected").
//   NT.Fog.reveal(world, team, x, y, radiusPx, ticks)   temporary sight source (flares, scans);
//                                          seen at once, dropped by the first pass after it expires.
//   NT.Fog.recompute(world)                force a pass now
// `team` is a team id (world.players[i].team); a negative team sees nothing.
// The arrays keep being maintained with fog off, so AI and minimap can still read them.
// ============================================================================
NT.Fog = {};

NT.Fog._sys = function (world) { return world.sys.fog || (world.sys.fog = { reveals: [] }); };

NT.Fog._stamp = function (world, team, cx, cy, r) {
  const t = world.teams[team];
  if (!t) return;
  const offs = NT.circleOffsets(r), w = world.w, h = world.h, vis = t.vis, ex = t.explored;
  for (let k = 0; k < offs.length; k++) {
    const x = cx + offs[k][0], y = cy + offs[k][1];
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const i = y * w + x;
    if (vis[i] < 65535) vis[i]++;
    ex[i] = 1;
  }
};

NT.Fog._stampEnt = function (world, e) {
  const p = world.players[e.owner];
  if (!p || !e.alive || e.hidden) return;
  const r = e.def.sight * e.mods.sight;
  if (e.kind === 'building') NT.Fog._stamp(world, p.team, e.cx + ((e.w - 1) >> 1), e.cy + ((e.h - 1) >> 1), r + Math.max(e.w, e.h) / 2);
  else NT.Fog._stamp(world, p.team, e.cx, e.cy, r);
};

NT.Fog.recompute = function (world) {
  const S = NT.Fog._sys(world), teams = world.teams, ents = world.ents;
  for (let t = 0; t < teams.length; t++) teams[t].vis.fill(0);
  for (let i = 0; i < ents.length; i++) NT.Fog._stampEnt(world, ents[i]);
  const rv = S.reveals;
  let j = 0;
  for (let i = 0; i < rv.length; i++) {
    const r = rv[i];
    if (r.until <= world.tick) continue;
    NT.Fog._stamp(world, r.team, r.cx, r.cy, r.r);
    rv[j++] = r;
  }
  rv.length = j;
};

NT.Fog.visible = function (world, team, cx, cy) {
  if (world.fogEnabled === false) return true;
  const t = world.teams[team];
  return !!t && cx >= 0 && cy >= 0 && cx < world.w && cy < world.h && t.vis[cy * world.w + cx] > 0;
};

NT.Fog.explored = function (world, team, cx, cy) {
  if (world.fogEnabled === false) return true;
  const t = world.teams[team];
  return !!t && cx >= 0 && cy >= 0 && cx < world.w && cy < world.h && t.explored[cy * world.w + cx] === 1;
};

NT.Fog.canSee = function (world, team, e) {
  const p = world.players[e.owner];
  if (p && p.team === team) return true;
  if (e.hidden || (e.stealth && e.seenUntil <= world.tick)) return false;
  if (world.fogEnabled === false || e.def.role === 'super') return true;   // superweapons are always known to everyone
  const t = world.teams[team];
  if (!t) return false;
  const vis = t.vis, w = world.w;
  if (e.kind !== 'building') return vis[e.cy * w + e.cx] > 0;
  for (let y = e.cy; y < e.cy + e.h; y++) for (let x = e.cx; x < e.cx + e.w; x++) {
    if (x >= 0 && y >= 0 && x < w && y < world.h && vis[y * w + x] > 0) return true;
  }
  return false;
};

NT.Fog.reveal = function (world, team, x, y, radiusPx, ticks) {
  if (!world.teams[team]) return;
  const r = { team: team, cx: NT.cellOf(x), cy: NT.cellOf(y), r: radiusPx / NT.TILE, until: world.tick + ticks };
  NT.Fog._sys(world).reveals.push(r);
  NT.Fog._stamp(world, team, r.cx, r.cy, r.r);
};

NT.system('fog', 90, {
  init: function (world) { NT.Fog.recompute(world); },
  onSpawn: function (world, e) { NT.Fog._stampEnt(world, e); },
  step: function (world) { if (world.tick % world.rules.fogEvery === 0) NT.Fog.recompute(world); },
});
