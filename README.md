# NIGHT CITY — Pixel Edition

A pixel-art, top-down cyberpunk action game that runs entirely in the browser.
Pure HTML5 Canvas + vanilla JS — no dependencies, no build step, no asset files
(every sprite, the city, and the synthwave soundtrack are generated procedurally at boot).

An unofficial fan tribute inspired by Cyberpunk 2077. Not affiliated with CD PROJEKT RED.
All pixels and code are original. Personal/educational use.

## Run it

```bash
cd night-city-pixel
./run.sh                      # serves on http://localhost:8080
# or: python3 -m http.server 8080
# or: npx serve .
```

Then open http://localhost:8080 in a desktop browser (Chrome/Firefox/Edge).
Opening `index.html` directly from disk also works.
Click once on the page to enable audio. Keyboard + mouse required.

## The loop

Pick your V (male or female) on new game and roll a **random starter kit** — one
weapon, one ride. Then: hunt **bounties** (red on the minimap) → earn **eddies (€$)**
and street cred → spend them at the three shops near spawn → take on
**cyberpsychos** for iconic loot. Five radio stations keep you company (**N** to dial).

- **2ND AMENDMENT** `[G]` — 25 weapons for sale: power / tech (piercing) / smart (homing) pistols, SMGs, rifles, shotguns, snipers, LMG, blades. Stock unlocks as you level.
- **NC AUTOFIXER** `[A]` — 12 vehicles, from a €$3,200 Thorton beater to the €$157,000 Rayfield Caliburn, plus two bikes. Press **V** anywhere to have your active ride delivered. Run gonks over — full-body hit detection, speed-scaled damage, blood spray, and stains that stay on the asphalt.
- **VIK'S CLINIC** `[R]` — 17 pieces of cyberware across 10 body slots, most with 3 upgrade marks: **Sandevistan** (bullet-time), Berserk, Kerenzikov (slow-mo dash), Optical Camo, Second Heart, Subdermal Armor, Smart Link (enables smart guns), Mantis Blades / Gorilla Arms / Monowire / Projectile Launch System, and more.
- **AFTERLIFE** `[B]` — drinks heal. Vending machines sell MaxDocs.

### Collection goals (TAB)
- **Weapon database: 38** — 25 shop guns + 4 cyber-arm weapons + **8 iconics dropped only by cyberpsychos** (every 3rd bounty summons one) + 1 hidden talking pistol lost in a gutter somewhere…
- **Garage: 12 vehicles** · **Chrome: 17 implants** · full stats page with net worth.

Six districts (Watson, Westbrook, City Center, Santo Domingo, Pacifica — and **Dogtown**,
the ★★★★ Barghest-held corner in the south-west) with their own gangs and danger ratings.
**Airdrops** parachute into Dogtown every few minutes: race the Barghest squad to the
container for eddies, MaxDocs, and rarity-boosted gear. And when the city wears you down,
**Jig-Jig Street** (NE) has joytoys to chat up — or visit EVE at the CLOUDS dollhouse —
for a fade-to-black good time that fully rests V and grants a crit/XP euphoria buff.

## Controls

| Key | Action |
|---|---|
| WASD | Move / drive |
| Mouse + LMB | Aim / fire / swing |
| Space | Dash (handbrake in car) |
| R | Reload |
| 1 / 2 / 3 / wheel | Weapon slots |
| Q | OS ability (Sandevistan / Berserk) |
| F | Optical camo |
| C | MaxDoc (heal) |
| E | Interact (shops, vending, vehicle) |
| V | Summon / enter / exit vehicle |
| N | Radio — cycle 5 stations + off |
| TAB | Inventory · collections · stats |
| M | Mute · ESC | Pause |

Progress autosaves to localStorage every 12 seconds.

## Open source · players become creators

MIT licensed (see LICENSE — code, art, and audio are all original; the fan-tribute
disclaimer applies to the universe it riffs on). The game ships with a **mod loader**:
drop content into `mods/mods.js` — new weapons, vehicles, cyberware, radio stations,
and event hooks — refresh, and it's live in the shops, collections, and radio dial.
No build step, no tooling. See **MODDING.md** for the full API and a working sample
mod. PRs to the core game are welcome; `node test/smoke.js` must stay green.

## Tech notes

- 640×360 internal canvas, integer-scaled with `image-rendering: pixelated`; custom 3×5 bitmap font.
- 128×128-tile city pre-rendered once to an offscreen canvas (deterministic seed so saves stay valid).
- WebAudio: all SFX synthesized; MIDI-style radio with 5 composed stations (synthwave, vaporwave, funk, dream-pop, industrial) on one 64-step sequencer — stations are data, so mods can add their own.
- HiDPI-aware integer scaling: the canvas size is chosen in device pixels, so retina/2× displays (and fractional Windows scaling) stay pixel-crisp.
- `node test/smoke.js` runs a headless simulation of every system (combat, shops, driving, psychos, death, save/load) against stubbed DOM/canvas.
- Debug URLs: `?autostart` skips the title menu; `?demo` also fast-forwards ~4s with enemies and a delivered car (handy for headless screenshots).
