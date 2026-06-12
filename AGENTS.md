# AGENTS.md — for AI coding agents (and fast-moving humans)

This repo was built agent-first and welcomes agentic PRs. Everything an agent needs to
work here safely is on this page.

## Commands

```bash
node test/smoke.js     # THE gate. Headless sim of every system. Must pass (run it 2-3x; it's mildly random).
./run.sh               # serve on :8080 for manual testing
node --check js/*.js   # quick syntax sweep
```

## Project map

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
| `mods/mods.js` | player mod entry point (NCPX API — see MODDING.md) |
| `test/smoke.js` | stubbed-DOM headless test driving the whole game |

Plain `<script>` files sharing one global scope — **no modules, no build, no imports**.
`font → data → sfx → sprites → world → ui → game → mods` is the required load order;
`test/smoke.js` concatenates in the same order.

## Hard invariants (break these and you break players)

1. **Zero dependencies, zero binary assets.** All art is drawn in `sprites.js`/`world.js`;
   all audio is synthesized in `sfx.js`. PNGs exist only under `screenshots/` for the README.
2. **World gen is deterministic** (seed `20770612`, `mulberry32`). Saves store player
   position; changing generation invalidates them — if you must, say so loudly in the PR.
3. **Save shape** lives in `saveGame()/applySave()` (`localStorage` key `ncpx2077_v1`).
   New fields must be optional-with-defaults so old saves keep loading (there's a
   legacy-save regression in the smoke test).
4. **Bump `?v=N`** on every script tag in `index.html` when you change any js file —
   browsers otherwise mix cached versions and the game freezes on the first frame.
5. **Tile codes:** 0 road · 1 sidewalk · 2 building (solid) · 3 plaza · 4 park ·
   5 interior floor · 6 door. `<5` = outdoor. `WORLD.solidPx` = walls only (bullets/LOS);
   `WORLD.blockedPx` = walls + furniture/NPC rects (movers).
6. **Render depth:** ground → indoor entities → roof layers (fade when V inside) → signs →
   outdoor entities → foliage canopy → glow pass (additive) → weather → HUD. Entities are
   drawn via `drawWorldEntities(c, indoor)` twice — keep new world objects in the right pass.
7. **Time scales:** `dt` real (UI/timers), `dtW` world (slowed by Sandevistan/Kerenzikov),
   `dtP` player-relative. Pick deliberately.
8. **No `Date.now()`/wall-clock in sim logic** — everything ticks off `step(dt)` so the
   headless test can drive it.

## Conventions

- 2-space indent, compact single-purpose functions, `UPPER_SNAKE` for data tables.
- Comments only where the code can't say it (constraints, gotchas) — not narration.
- All player-facing text is UPPERCASE (the bitmap font has no lowercase) and stays
  PG-13: violence is pixel-gore, romance is fade-to-black.
- New content (weapons/cars/stations/cyber) belongs in `data.js` tables or — better —
  a mod in `mods/`. New mechanics belong in `game.js` with a smoke-test assertion.
- Add a debug URL param (`?yourthing`) when a feature is hard to reach manually — they
  double as headless screenshot hooks.

## Testing expectations for PRs

- `node test/smoke.js` green (run 2-3×; flakes are treated as bugs — add diagnostics, not retries).
- New systems get asserts in `test/smoke.js` (drive `G` directly; see existing patterns).
- If it's visual, include a screenshot (debug params + headless Firefox work well).
