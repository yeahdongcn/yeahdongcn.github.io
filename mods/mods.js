'use strict';
// ============================================================================
// NIGHT CITY — Pixel Edition · player mods
//
// This file is yours. It loads after the game scripts, so the full NCPX mod
// API (and every game global) is available. Register content here and it
// shows up in shops, the weapon database, the garage and the radio dial.
// Full reference: MODDING.md
// ============================================================================

const SAMPLE_MOD = {
  name: 'sample-mod',

  // ---- new weapons: appear in the shop + collection database ----
  weapons: [
    { id: 'neon_widow', name: 'NEON WIDOW', cls: 'smg', kind: 'smart', rar: 4,
      dmg: 8, rof: 13, mag: 40, rel: 1.2, spd: 330, spread: 8, homing: 6,
      price: 15500, lvl: 10, desc: 'COMMUNITY-MADE SMART SMG. SHE NEVER MISSES TWICE.' },
  ],

  // ---- new vehicles: appear at the autofixer + garage ----
  // shapes: sedan / sport / muscle / van / pickup / hyper / bike
  cars: [
    { id: 'city_wagon', name: 'CITY WAGON CUSTOM', price: 12000,
      top: 240, acc: 200, grip: 0.9, hp: 380, shape: 'van', col: '#28503c', col2: '#00ff9f' },
  ],

  // ---- new radio stations: N key cycles to them ----
  stations: [
    { name: 'CHIP-32 FM', bpm: 140, roots: [36, 36, 31, 33],
      kick: [0, 4, 8, 12], snare: [4, 12], hat: 1, bass: 'roll',
      arp: [12, 16, 19, 24], pad: null,
      wv: { bass: 'square', arp: 'square', lead: 'square', pad: 'square' },
      lead: NCPX.mel([[0, 12], [2, 16], [4, 19], [6, 24], [8, 19], [12, 16], [16, 12], [20, 14], [24, 16], [28, 19], [32, 24], [36, 19], [40, 16], [44, 12], [48, 14], [52, 16], [56, 19], [60, 24]]) },
  ],

  // ---- event hooks: (data, G) => { ... } ----
  on: {
    kill: (d, g) => { if (Math.random() < 0.04) { g.eddies += 25; msg('LUCKY SCRAP: +€$25', '#2ecc71'); } },
    levelup: d => { if (d.lvl === 10) banner('MOD MILESTONE', 'LEVEL 10 — THE STREETS KNOW YOUR NAME', '#00ff9f'); },
  },
};

// Uncomment to enable the sample mod — then refresh the page:
// NCPX.registerMod(SAMPLE_MOD);
