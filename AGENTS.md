# AGENTS.md — for AI coding agents (and fast-moving humans)

This repo was built agent-first and welcomes agentic PRs. Everything an agent needs to
work here safely is on this page.

## What is in here

One GitHub Pages site (https://yeahdongcn.github.io/), three browser games, one landing page.
Each game is self-contained in its own directory; they share nothing but the origin.

| Path | What | Gate |
|---|---|---|
| `index.html`, `img/` | landing page: pick a game | open it; no script logic worth testing |
| `pixel/` | NIGHT CITY — Pixel Edition: top-down action RPG | none in this repo (see below) |
| `diablo/` | NIGHT CITY — 2.5D Edition: the same game, isometric | none in this repo |
| `rts/` | **NEON TURF**: an original base-building RTS (two gangs, skirmish vs AI) | `node rts/test/smoke.js` |

```bash
python3 -m http.server 8080      # serve the repo root, then open http://localhost:8080/
node rts/test/smoke.js           # NEON TURF gate: ~25 s, deterministic, must stay green
node rts/test/mapgen.test.js     # NEON TURF map generator tests
node rts/test/balance.js         # NEON TURF AI-vs-AI balance report (not a gate; usage in its header)
```

Deploys: `git push origin main` — GitHub Pages serves `main` at the site root. There is one
remote and one push URL.

## Rules for the whole repo

1. **Zero dependencies, zero binary assets, no build step.** Plain `<script>` files. All art is
   drawn in code, all audio is synthesized. PNGs exist only under `img/` (landing page cards)
   and `screenshots/` (README).
2. **Load order is the script-tag order** in each game's `index.html`, and **`?v=N` must be
   bumped on every tag of that page together** whenever one of its files changes — browsers
   otherwise mix cached versions.
3. **One game per change.** Never edit `pixel/` or `diablo/` while working on `rts/`, or the
   reverse. `pixel/` and `diablo/` share a save (`localStorage` key `ncpx2077_v1`); NEON TURF
   uses only `neonturf.settings.v1`.
4. 2-space indent, compact single-purpose functions. Comments only where the code cannot say
   it (constraints, gotchas) — not narration.
5. If it is visual, look at it: headless Chromium / Firefox plus the debug URL parameters each
   game documents make screenshots cheap.

---

## NEON TURF (`rts/`)

An ORIGINAL game: its setting, gangs, units, art and audio are its own. Do not import names,
units, art, sounds or UI from any existing game or film.

### Map of the code

Plain scripts sharing ONE global, `NT`. `rts/index.html` is the single source of truth for
load order; tags marked `data-sim` are the headless-safe simulation, and `rts/test/harness.js`
loads exactly those tags in Node.

| File | Owns |
|---|---|
| `js/core.js` | `NT` namespace: constants, seeded RNG, math, grid helpers, heap, event bus |
| `js/rules.js` | global tunables, warhead × armor matrix, the trait vocabulary, `NT.defineFaction`, validation. **Its header is the faction authoring contract.** |
| `js/factions/<id>.js` | one gang = one pure data file. `neutral.js` is the capturable street businesses |
| `js/factions/<id>.art.js` | that gang's sprites (presentation). Optional: a def without art gets generic fallback art |
| `js/map.js`, `js/mapgen.js` | map structure; procedural city generator and the preset maps |
| `js/sim.js` | the spine: world / player / entity structs, `NT.cmd` (the only door into the world), `NT.step`, the events list |
| `js/path.js`, `move.js`, `combat.js`, `fog.js`, `econ.js`, `prod.js`, `traits.js`, `powers.js`, `victory.js` | the simulation systems |
| `js/ai.js` | skirmish AI: plays ANY faction from its data, acts only through `NT.cmd` |
| `js/main.js` | presentation spine: `NT.Game`, frame loop, settings, URL debug parameters |
| `js/i18n.js`, `art.js`, `terrain.js`, `render.js`, `fx.js`, `audio.js`, `ui.js`, `input.js`, `css/neon.css` | presentation: EN / 中文 text, the sprite kit, the city, the renderer, effects, synthesized sound, the DOM HUD and menus, mouse / keyboard / touch |
| `gallery.html`, `mapview.html` | dev pages: every sprite in every state; every map |
| `test/` | `smoke.js` (the gate), `mapgen.test.js`, `balance.js`, `fixtures/thirdgang.js` (a test-only third gang) |

### Hard invariants

1. **The simulation is deterministic and headless.** Fixed step (20 ticks/s), seeded `NT.Rng`,
   no DOM, no `Date`, no `Math.random` in any `data-sim` file. Same seed + same commands = same
   `NT.hashWorld`. The gate checks this.
2. **`NT.cmd(world, playerId, cmd)` is the only way to change the world.** The UI and the AI
   both use it; the AI gets no other access (its one direct write is its own handicap).
   Presentation learns what happened from `world.events`.
3. **Engine files never name a faction, unit, building or power.** Behaviour comes from generic
   roles, tags and traits in the data files. The gate scans for literals and plays full AI
   matches with the fixture gang to prove it.
4. **A gang is data.** Adding one must not require touching any engine file (see below).
5. All player-facing text is bilingual `{en, zh}` and goes through `NT.tr` / `NT.T`.
6. Presentation never mutates the world; the sim never reads presentation.

### Adding a gang

1. Write `rts/js/factions/<id>.js` — one `NT.defineFaction({...})` call following the contract
   at the top of `js/rules.js` (queues, buildings, units, weapons, traits, support powers,
   optional `ai` hints for the skirmish AI, optional `music` hints that give the gang its own
   voice in the score — vocabulary at the top of `js/audio.js`). Copy the shape of `curfew.js`
   or `pitfang.js`.
2. Optionally write `rts/js/factions/<id>.art.js` — one `NT.Art.define('<id>', {...})`; the kit
   and the art contract are documented at the top of `js/art.js`, and `gallery.html` shows the
   result. Without it the gang plays with generic fallback art.
3. Add the two `<script>` tags to `rts/index.html` (the data file with `data-sim`, next to the
   other factions) and bump `?v=`.

That is all: the menu, the HUD, the AI, the map generator and the gate pick the gang up from
the registry. Run `node rts/test/smoke.js` (it validates the data, builds the whole tech tree
through commands and plays AI matches with every faction) and `node rts/test/balance.js
--factions <id>,curfew` to see how it fares.

### Working on it

- Debug URLs (all documented at the top of `js/main.js`): `?autostart&faction=&enemy=&diff=&map=&seed=`,
  `?demo` (AI vs AI, spectate), `&t=<seconds>` fast-forward, `&speed=`, `&nofog`, `&paused`,
  `&cam=x,y,zoom`, `&lang=en|zh`, `&mute`, `&brawl=<n>` (instant mirror battle).
- New mechanics get assertions in `rts/test/smoke.js`; new numbers get a `balance.js` run.
- The score and every sound were composed and checked by instruments and spectrograms only
  (levels, onsets, pitch, band energy) — nobody has listened. Trust your ears over the numbers.
- Commands are refused while the game is paused (`NT.Game.cmd`), except surrender.

---

## NIGHT CITY (`pixel/`, `diablo/`)

Two editions of one game. The file roles below are the same in both directories
(`diablo/` adds `js/iso.js` and has its own `game.js` / `ui.js`). The headless gate and the
`run.sh` helper these games were developed with are not in this repository, so test changes
by playing them (debug URLs: `?autostart`, `?demo`, `?charsel`, `?indoor`, `?jigjig`,
`?airdrop`, `&wx=storm|fog|acid|…`).

| File | Owns |
|---|---|
| `index.html` | canvas + script tags (LOAD ORDER MATTERS) + `?v=N` cache-bust |
| `js/font.js` | 3×5 bitmap font, `drawText*` |
| `js/data.js` | all content data: WEAPONS / CARS / CYBER / DISTRICTS / FACTIONS / WEATHERS / dialogue |
| `js/sfx.js` | WebAudio synth SFX + station-driven radio sequencer |
| `js/sprites.js` | all pixel art, generated at boot (`SPR.*`) |
| `js/world.js` | deterministic city gen → `WORLD` (tiles, prerendered canvases, roofs, dens, npcs, obst, bushes) |
| `js/ui.js` | HUD + every menu (immediate-mode canvas UI) |
| `js/game.js` | sim core: G state, player/enemy/vehicle logic, weather, airdrops, saves, render pipeline |
| `pixel/mods/mods.js` | player mod entry point (NCPX API — see MODDING.md) |

Load order: `font → data → sfx → sprites → world → ui → game → mods`.

Invariants (break these and you break players):

1. **World gen is deterministic** (seed `20770612`, `mulberry32`). Saves store player
   position; changing generation invalidates them — if you must, say so loudly in the PR.
2. **Save shape** lives in `saveGame()/applySave()` (`localStorage` key `ncpx2077_v1`, shared
   by both editions). New fields must be optional-with-defaults so old saves keep loading.
3. **Tile codes:** 0 road · 1 sidewalk · 2 building (solid) · 3 plaza · 4 park ·
   5 interior floor · 6 door. `<5` = outdoor. `WORLD.solidPx` = walls only (bullets/LOS);
   `WORLD.blockedPx` = walls + furniture/NPC rects (movers).
4. **Render depth:** ground → indoor entities → roof layers (fade when V inside) → signs →
   outdoor entities → foliage canopy → glow pass (additive) → weather → HUD. Entities are
   drawn via `drawWorldEntities(c, indoor)` twice — keep new world objects in the right pass.
5. **Time scales:** `dt` real (UI/timers), `dtW` world (slowed by Sandevistan/Kerenzikov),
   `dtP` player-relative. Pick deliberately.
6. **No `Date.now()`/wall-clock in sim logic** — everything ticks off `step(dt)`.

Conventions: `UPPER_SNAKE` for data tables; all player-facing text is UPPERCASE (the bitmap
font has no lowercase) and stays PG-13. New content (weapons/cars/stations/cyber) belongs in
`data.js` tables or — better — a mod in `pixel/mods/`.
