'use strict';
// ============================================================================
// NEON TURF — victory.js : defeat, surrender, game over  (HEADLESS-SAFE, DETERMINISTIC)
// System 'victory' (order 110). Command: surrender.
//
// A player STANDS while they own an alive building with def.countsForDefeat (player.nBuildings > 0) or a unit
// with a deploy.into trait (a base on wheels). player.hadBase records that they ever stood; only such a player
// can be defeated by losing it all (test worlds and sandboxes without bases never end by themselves).
// DEFEAT (losing the last one, or the surrender command): player.defeated = true, 'defeated' {player}, and
// everything they still own goes: units and structures die (real deaths, so death effects play), capturable turf
// with `revert` returns to neutral instead (hp kept). Their queues are emptied (no refunds).
// GAME OVER — checked whenever someone was defeated: once at most one team has undefeated players, world.over =
// true, world.winner = that team (-1 if nobody is left), 'gameover' {winner}. After that the sim keeps stepping
// (the spine ignores commands; nobody is defeated any more).
//
// API:
//   NT.Victory.stands(world, player) -> bool     owns something that keeps them in the game
//   NT.Victory.defeat(world, player)             defeat now (used by the surrender command)
// ============================================================================
NT.Victory = {};

NT.Victory._mobile = function (player) {
  const ds = player.faction.defs;
  for (let i = 0; i < ds.length; i++) if (ds[i].traits.deploy && ds[i].traits.deploy.into && player.units[ds[i].id] > 0) return true;
  return false;
};

NT.Victory.stands = function (world, player) { return player.nBuildings > 0 || NT.Victory._mobile(player); };

NT.Victory.defeat = function (world, p) {
  if (p.defeated) return;
  p.defeated = true;
  world.events.push({ t: 'defeated', player: p.id });
  for (const k in p.queues) { p.queues[k].items.length = 0; p.queues[k].ready = null; }
  const ents = world.ents;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    if (!e.alive || e.owner !== p.id) continue;
    const cap = e.def.traits.capturable;
    if (cap && cap.revert) NT.setOwner(world, e, NT.NEUTRAL);
    else NT.kill(world, e, null);
  }
  world.sys.victory.check = true;
};

NT.Victory._over = function (world) {
  const teams = [];
  for (let i = 0; i < world.players.length; i++) {
    const p = world.players[i];
    if (!p.defeated && teams.indexOf(p.team) < 0) teams.push(p.team);
  }
  if (teams.length > 1) return;
  world.over = true; world.winner = teams.length ? teams[0] : -1;
  world.events.push({ t: 'gameover', winner: world.winner });
};

NT.command('surrender', function (world, p) { NT.Victory.defeat(world, p); });

NT.system('victory', 110, {
  init: function (world) { world.sys.victory = { check: false }; },
  step: function (world) {
    if (world.over) return;
    const V = NT.Victory, S = world.sys.victory, ps = world.players;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.defeated) continue;
      if (V.stands(world, p)) p.hadBase = true;
      else if (p.hadBase) V.defeat(world, p);
    }
    if (!S.check) return;
    S.check = false;
    V._over(world);
  },
});
