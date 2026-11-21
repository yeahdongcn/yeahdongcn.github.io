# yeahdongcn.github.io

Read **AGENTS.md** for the project map, hard invariants, and conventions — it is the
single source of truth for working in this repo.

Three self-contained browser games behind one landing page: `pixel/` and `diablo/`
(NIGHT CITY, two editions) and `rts/` (NEON TURF, an original RTS).

Quick reference:
- Serve: `python3 -m http.server 8080` at the repo root → http://localhost:8080/
- NEON TURF gate: `node rts/test/smoke.js` (deterministic, ~25 s, must stay green) and
  `node rts/test/mapgen.test.js`
- `pixel/` and `diablo/` have no headless gate in this repo: test by playing
- Ship checklist: gate green → bump `?v=N` on every tag of the game's `index.html` →
  update README if player-facing → `git push origin main` (GitHub Pages serves `main`)
