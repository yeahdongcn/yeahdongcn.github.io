# Modding NIGHT CITY — Pixel Edition

Players are creators here. The game ships with a mod loader: edit **`mods/mods.js`**,
refresh the page, and your content is live — no build step, no tooling. Mod content
appears everywhere vanilla content does: shops, the weapon database, the garage,
the radio dial, collection completion meters.

Start by opening `mods/mods.js` and uncommenting the last line to enable the sample mod.

## The API

`mods/mods.js` loads after the game scripts, so the global `NCPX` object and all
game globals are available:

```js
NCPX.registerMod({
  name: 'my-mod',
  weapons:  [ /* weapon defs  → sold at 2nd Amendment, counted in the database */ ],
  cars:     [ /* vehicle defs → sold at NC Autofixer, shown in the garage */ ],
  cyber:    [ /* cyberware defs → listed at Vik's (use an existing slot name) */ ],
  stations: [ /* radio station defs → on the N-key dial */ ],
  on:       { /* event hooks */ },
});
```

You can register any number of mods; duplicate ids are ignored (first one wins).

### Weapon def

```js
{ id: 'my_gun',          // unique, stable — saves store ids
  name: 'MY GUN', cls: 'smg',        // pistol|revolver|smg|rifle|shotgun|sniper|lmg|blade|blunt|launcher
  kind: 'power',                     // power | tech (pierces) | smart (homes; needs Smart Link) | melee
  rar: 2,                            // 0..5 (common → iconic)
  dmg: 8, rof: 10, mag: 30, rel: 1.3,// damage/bullet, shots/sec, magazine, reload secs
  spd: 380, spread: 7,               // bullet px/s, spread degrees
  price: 9000, lvl: 8,               // eddies + level gate in the shop
  desc: 'FLAVOR TEXT.',
  // optional: pellets, pierce, homing, kb, burn, aoe, crit, wallPierce,
  // iconic: 1 (drops from psychos instead of being sold)
}
```

Melee classes use `range` (px) and `arc` (degrees) instead of mag/spd/spread.

### Vehicle def

```js
{ id: 'my_car', name: 'MY CAR', price: 20000,
  top: 260, acc: 210, grip: 0.9, hp: 320,   // px/s, px/s², 0.85–0.95, durability
  shape: 'sport',                            // sedan|sport|muscle|van|pickup|hyper|bike
  col: '#1b4f72', col2: '#05d9e8' }          // body + accent (sprite is generated)
```

### Radio station def

```js
{ name: 'MY FM', bpm: 120,
  roots: [33, 33, 29, 31],          // 4 bass roots (midi), one per bar
  kick: [0, 8], snare: [4, 12],     // 16th-step positions within a bar
  hat: 2,                           // hi-hat every N 16ths
  bass: 'roll',                     // roll | half | funk | pump
  arp: [12, 15, 19, 24] | null,     // semitone offsets, cycles on offbeats
  pad: [0, 3, 7] | null,            // chord intervals at each bar start
  wv: { bass: 'sawtooth', arp: 'square', lead: 'square', pad: 'sawtooth' },
  lead: NCPX.mel([[0, 12], [4, 15] /* [16th-step, semitones above root+2 octaves] */]) }
```

### Events

```js
on: {
  newgame: (d, G) => {},   // d = { gender }
  kill:    (d, G) => {},   // d = { enemy }
  levelup: (d, G) => {},   // d = { lvl }
  bounty:  (d, G) => {},   // d = { reward, psycho }
}
```

`G` is the live game state (eddies, p, weapons, cars, …). Handy globals you can call
from hooks: `msg(text, color)`, `banner(big, sub, color)`, `giveWeapon(id)`,
`xpGain(n)`, `spawnPack(x, y, n)`.

## Rules of the road

- **Keep ids stable.** Saves reference weapon/car/cyber ids; renaming an id orphans
  it from old saves (the loader skips unknown ids rather than crashing).
- Mods are plain JS with full page access — only install mods you've read.
- Balance is yours to break. The vanilla DPS range is ~35 (starter) to ~130 (endgame).

## Contributing to the game itself

PRs welcome — the codebase is dependency-free vanilla JS (`js/`, ~7 files, load
order matters). Before submitting: `node test/smoke.js` must pass, and please keep
new code procedural-art only (no binary assets). See README for the layout.
