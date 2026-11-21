'use strict';
// ============================================================================
// NEON TURF — main.js : the PRESENTATION SPINE  (DOM; loaded LAST)
//
// Owns NT.Game: shared presentation state (camera, selection, input mode,
// settings), the match lifecycle and the frame loop. The simulation never sees
// any of this; render / ui / input / audio all read NT.Game and talk to the sim
// only through NT.Game.cmd() (-> NT.cmd, the same door the AI uses).
//
// MODULE HOOKS — every presentation module is optional; main calls a hook only
// if it exists, so the game boots while modules are still being written:
//   NT.Render.init(canvas)   NT.Render.resize()   NT.Render.frame(dt)
//   NT.UI.init(hudRoot)      NT.UI.frame(dt)      NT.UI.showMenu()
//   NT.Input.init(canvas)    NT.Input.frame(dt)   (edge / key scrolling lives here)
//   NT.Audio.init()          NT.Audio.frame(dt)
// FRAME ORDER: Input.frame -> sim ticks (+ event dispatch) -> Render.frame ->
// UI.frame -> Audio.frame.
//
// BUS EVENTS (NT.on):
//   'game:boot'   ()                 modules are initialised, settings loaded
//   'game:start'  (world)            a match began (build caches, reset HUD)
//   'game:stop'   ()                 back to the menu
//   'game:over'   (result)           {won, winner, me, ticks, stats}
//   'game:pause'  (bool)             'game:speed' (number)
//   'sim'         (ev)               EVERY simulation event (see sim.js EVENTS)
//   'sim:<type>'  (ev)               the same event, by type ('sim:fire', ...)
//   'ui:select'   (ids)              selection changed
//   'ui:mode'     (mode)             input mode changed
//   'ui:cmd'      (cmd)              the local player issued a command (ack sounds)
//   'ui:error'    (key)              a local refusal worth a buzz + toast (i18n key)
//   'settings'    (settings)         settings changed / saved
//   'lang'        (lang)             language switched (i18n.js)
//   'resize'      (view)
//
// URL PARAMS (debug + screenshot hooks):
//   ?autostart        skip the menu       &faction=<id> &enemy=<id|random> &diff=easy|normal|hard
//   &map=<presetId>   &seed=<n> &size=small|medium|large   (seed/size = random map instead of a preset)
//   ?demo             spectate AI vs AI, fog off (implies autostart)
//   &t=<seconds>      fast-forward the sim this long before the first frame (deterministic)
//   &paused           start paused (freeze-frame for screenshots)   &speed=<n>
//   &cam=x,y,zoom     camera in world px     &nofog     &lang=en|zh     &mute     &fps
//   &brawl=<n>        drop n random armed units per side near the map centre and send them at each other
// ============================================================================
NT.Game = {
  state: 'boot',                    // 'boot' | 'menu' | 'playing' | 'over'
  paused: false,
  modal: false,                     // a menu overlay is open: input ignores game keys / playfield clicks (ui.js sets it)
  world: null,
  me: 0,                            // local player index; -1 = spectator (sees everything, commands ignored)
  speed: 1,                         // sim speed multiplier
  now: 0,                           // presentation clock in seconds (runs even while paused; drives animation)
  alpha: 0,                         // 0..1 between the previous and the current sim tick (render interpolation)
  fps: 0,
  cam: { x: 0, y: 0, zoom: 1 },     // world px at the view centre; zoom = CSS px per world px
  view: { w: 0, h: 0, dpr: 1 },     // canvas size in CSS px + devicePixelRatio
  sel: [],                          // selected entity ids (dead ones are pruned every frame)
  groups: {},                       // control groups: '1'..'9' -> ids
  mode: { type: 'normal' },         // {type:'normal'} | {type:'place', def} | {type:'target', what:'amove'|'attack'|'power'|'rally', power?}
  hover: 0,                         // entity id under the pointer (input.js keeps it fresh)
  pointer: { x: 0, y: 0, wx: 0, wy: 0, inside: false },   // screen CSS px + world px
  settings: null,
  match: null,                      // options of the running match (restart uses them)
  result: null,
  params: null,                     // URLSearchParams of the page
  canvas: null, hud: null,
  _acc: 0, _last: 0, _frames: 0, _fpsT: 0,
};

NT.Game.ZOOM_MIN = 0.45;
NT.Game.ZOOM_MAX = 2.5;
NT.Game.SETTINGS_KEY = 'neonturf.settings.v1';     // this origin is shared with the other games: namespaced keys only
NT.Game.DEFAULTS = { lang: null, sfx: 0.8, music: 0.5, mute: false, edgeScroll: true, speed: 1, hints: true,
  faction: null, enemy: 'random', difficulty: 'easy', map: null };

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
NT.Game.loadSettings = function () {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(NT.Game.SETTINGS_KEY)) || {}; } catch (e) { s = {}; }
  NT.Game.settings = Object.assign({}, NT.Game.DEFAULTS, s);
};
NT.Game.saveSettings = function (patch) {
  if (patch) Object.assign(NT.Game.settings, patch);
  try { localStorage.setItem(NT.Game.SETTINGS_KEY, JSON.stringify(NT.Game.settings)); } catch (e) { /* private mode */ }
  NT.emit('settings', NT.Game.settings);
};

// ---------------------------------------------------------------------------
// Camera + coordinates
// ---------------------------------------------------------------------------
NT.Game.toWorld = function (sx, sy) {
  const G = NT.Game, c = G.cam;
  return [c.x + (sx - G.view.w / 2) / c.zoom, c.y + (sy - G.view.h / 2) / c.zoom];
};
NT.Game.toScreen = function (wx, wy) {
  const G = NT.Game, c = G.cam;
  return [(wx - c.x) * c.zoom + G.view.w / 2, (wy - c.y) * c.zoom + G.view.h / 2];
};
// Keep the view inside the map (with a small margin so edge cells clear the HUD).
NT.Game.clampCam = function () {
  const G = NT.Game, c = G.cam;
  c.zoom = NT.clamp(c.zoom, G.ZOOM_MIN, G.ZOOM_MAX);
  if (!G.world) return;
  const mw = G.world.w * NT.TILE, mh = G.world.h * NT.TILE, pad = 4 * NT.TILE;
  const hw = G.view.w / 2 / c.zoom, hh = G.view.h / 2 / c.zoom;
  // the HUD covers some playfield edges: let the camera travel that much further so no cell hides under a panel
  const ins = NT.UI && NT.UI.insets ? NT.UI.insets() : null;
  const il = ins ? ins.left / c.zoom : 0, ir = ins ? ins.right / c.zoom : 0, it = ins ? ins.top / c.zoom : 0, ib = ins ? ins.bottom / c.zoom : 0;
  c.x = mw + 2 * pad <= 2 * hw - il - ir ? mw / 2 + (ir - il) / 2 : NT.clamp(c.x, hw - pad - il, mw - hw + pad + ir);
  c.y = mh + 2 * pad <= 2 * hh - it - ib ? mh / 2 + (ib - it) / 2 : NT.clamp(c.y, hh - pad - it, mh - hh + pad + ib);
};
NT.Game.focus = function (wx, wy) { NT.Game.cam.x = wx; NT.Game.cam.y = wy; NT.Game.clampCam(); };
// Like focus, but centres the point in the part of the playfield the HUD leaves uncovered (sidebar / bottom sheet).
NT.Game.lookAt = function (wx, wy) {
  const G = NT.Game, z = G.cam.zoom, ins = NT.UI && NT.UI.insets ? NT.UI.insets() : null;
  if (!ins) { G.focus(wx, wy); return; }
  G.focus(wx + (ins.right - ins.left) / 2 / z, wy + (ins.bottom - ins.top) / 2 / z);
};
// Zoom keeping the world point under screen (sx, sy) fixed.
NT.Game.zoomAt = function (sx, sy, factor) {
  const G = NT.Game, before = G.toWorld(sx, sy);
  G.cam.zoom = NT.clamp(G.cam.zoom * factor, G.ZOOM_MIN, G.ZOOM_MAX);
  const after = G.toWorld(sx, sy);
  G.cam.x += before[0] - after[0]; G.cam.y += before[1] - after[1];
  G.clampCam();
};

// ---------------------------------------------------------------------------
// Local player helpers
// ---------------------------------------------------------------------------
NT.Game.player = function () { const G = NT.Game; return G.world && G.me >= 0 ? G.world.players[G.me] : null; };
NT.Game.team = function () { const p = NT.Game.player(); return p ? p.team : -1; };
// Can the local viewer see this entity? Spectators and fog-off matches see everything.
NT.Game.sees = function (e) {
  const G = NT.Game;
  if (G.me < 0 || !G.world.fogEnabled || !NT.Fog) return true;
  return NT.Fog.canSee(G.world, G.team(), e);
};

// The ONLY way presentation code changes the world.
NT.Game.cmd = function (cmd) {
  const G = NT.Game;
  if (G.state !== 'playing' || G.me < 0 || !G.world || G.world.over) return false;
  // paused = frozen: nothing queues up behind the PAUSED sign (the pause menu's surrender is the one exception)
  if (G.paused && cmd.type !== 'surrender') { NT.emit('ui:error', 'ui.t.paused'); return false; }
  const ok = NT.cmd(G.world, G.me, cmd);
  if (ok) NT.emit('ui:cmd', cmd);
  return ok;
};
NT.Game.select = function (ids) {
  NT.Game.sel = ids ? ids.slice() : [];
  NT.emit('ui:select', NT.Game.sel);
};
NT.Game.setMode = function (mode) {
  NT.Game.mode = mode || { type: 'normal' };
  NT.emit('ui:mode', NT.Game.mode);
};
// Selected, still-alive entities.
NT.Game.selected = function (out) {
  const G = NT.Game; out = out || []; out.length = 0;
  if (!G.world) return out;
  for (let i = 0; i < G.sel.length; i++) { const e = NT.get(G.world, G.sel[i]); if (e) out.push(e); }
  return out;
};

// ---------------------------------------------------------------------------
// Match lifecycle
// ---------------------------------------------------------------------------
// opts: { faction, enemy: id|'random', difficulty: 'easy'|'normal'|'hard',
//         map: presetId | null, seed?, size?, fog?: bool, spectate?: bool }
NT.Game.start = function (opts) {
  const G = NT.Game, F = NT.FACTION_LIST;
  NT.assert(F.length > 0, 'no playable factions are registered');
  opts = Object.assign({}, opts || {});
  if (!NT.FACTIONS[opts.faction] || !NT.FACTIONS[opts.faction].playable) opts.faction = F[0].id;
  if (!opts.seed) opts.seed = (Math.random() * 0x7fffffff) | 0 || 1;
  if (!NT.FACTIONS[opts.enemy] || !NT.FACTIONS[opts.enemy].playable) {
    const others = F.filter(function (f) { return f.id !== opts.faction; });
    const pool = others.length ? others : F;
    opts.enemyResolved = pool[opts.seed % pool.length].id;
  } else opts.enemyResolved = opts.enemy;
  if (['easy', 'normal', 'hard'].indexOf(opts.difficulty) < 0) opts.difficulty = 'normal';

  let map;
  const preset = opts.map && NT.MAPS && NT.MAPS.find(function (m) { return m.id === opts.map; });
  if (preset) map = NT.MapGen.fromPreset(preset.id);
  else if (NT.MapGen) map = NT.MapGen.generate({ seed: opts.seed, size: opts.size || 'medium', players: 2 });
  NT.assert(map, 'no map generator available');

  const spectate = !!opts.spectate;
  G.world = NT.createWorld({
    map: map, seed: opts.seed, fog: opts.fog !== false && !spectate,
    players: [
      { faction: opts.faction, ai: spectate ? opts.difficulty : null },
      { faction: opts.enemyResolved, ai: opts.difficulty },
    ],
  });
  G.me = spectate ? -1 : 0;
  G.match = opts; G.result = null;
  G.sel = []; G.groups = {}; G.mode = { type: 'normal' }; G.hover = 0;
  G.paused = false; G._acc = 0; G.alpha = 0;
  G.speed = G.settings.speed || 1;
  G.state = 'playing';
  const p = G.world.players[Math.max(0, G.me)];
  G.cam.zoom = 1;
  G.focus((p.startCx + 1.5) * NT.TILE, (p.startCy + 1.5) * NT.TILE);
  NT.emit('game:start', G.world);
  G.lookAt((p.startCx + 1.5) * NT.TILE, (p.startCy + 3) * NT.TILE);   // HQ + start squad; after game:start: the HUD is laid out only now
  return G.world;
};
NT.Game.restart = function () { if (NT.Game.match) NT.Game.start(NT.Game.match); };
NT.Game.stop = function () {
  const G = NT.Game;
  G.world = null; G.state = 'menu'; G.sel = []; G.result = null; G.paused = false;
  NT.emit('game:stop');
  if (NT.UI && NT.UI.showMenu) NT.UI.showMenu();
};
NT.Game.pause = function (on) {
  const G = NT.Game;
  G.paused = on === undefined ? !G.paused : !!on;
  NT.emit('game:pause', G.paused);
};
NT.Game.setSpeed = function (x) {
  NT.Game.speed = NT.clamp(x, 0.25, 4);
  NT.emit('game:speed', NT.Game.speed);
};

// Debug (&brawl=n): n random armed units per player near the map centre, attack-moving at each
// other. Deterministic for a seed. Handy for judging art, fx and sound without playing a match.
NT.Game.brawl = function (n) {
  const G = NT.Game, w = G.world, rng = new NT.Rng((w.seed ^ 0xb7a11) >>> 0);
  const cx = w.w >> 1, cy = w.h >> 1;
  for (let i = 0; i < w.players.length; i++) {
    const p = w.players[i], side = i % 2 ? 6 : -6, ids = [];
    const defs = p.faction.defs.filter(function (d) { return d.kind === 'unit' && d.weapons.length > 0; });
    for (let k = 0; k < n && defs.length; k++) {
      const e = NT.spawn(w, rng.pick(defs), p.id, cx + side + rng.irange(-3, 3), cy + rng.irange(-5, 5));
      if (e) ids.push(e.id);
    }
    NT.cmd(w, p.id, { type: 'amove', ids: ids, x: NT.cellCenter(cx - side), y: NT.cellCenter(cy) });
  }
  G.focus(NT.cellCenter(cx), NT.cellCenter(cy));
};

// Advance the simulation one tick and publish what happened.
NT.Game.tick = function () {
  const G = NT.Game, w = G.world;
  NT.step(w);
  const evs = NT.drainEvents(w);
  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i];
    NT.emit('sim', ev);
    NT.emit('sim:' + ev.t, ev);
    if (ev.t === 'gameover' && G.state === 'playing') {
      G.state = 'over';
      G.result = { winner: ev.winner, me: G.me, won: G.me >= 0 && ev.winner === G.team(), ticks: w.tick,
        stats: w.players.map(function (p) { return Object.assign({ faction: p.faction.id, team: p.team }, p.stats); }) };
      NT.emit('game:over', G.result);
    }
  }
};

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------
NT.Game.frame = function (t) {
  const G = NT.Game;
  requestAnimationFrame(G.frame);
  const dt = Math.min(0.1, Math.max(0, (t - G._last) / 1000));
  G._last = t; G.now += dt;
  G._frames++; G._fpsT += dt;
  if (G._fpsT >= 0.5) { G.fps = Math.round(G._frames / G._fpsT); G._frames = 0; G._fpsT = 0; }

  if (NT.Input && NT.Input.frame) NT.Input.frame(dt);
  if (G.world && (G.state === 'playing' || G.state === 'over') && !G.paused) {
    G._acc += dt * G.speed;
    let n = 0;
    while (G._acc >= NT.DT && n < 10) { G.tick(); G._acc -= NT.DT; n++; }
    if (G._acc > NT.DT) G._acc = NT.DT;                    // dropped frames: never spiral
    G.alpha = G._acc / NT.DT;
    if (G.sel.length) {                                    // prune the dead from the selection
      const w = G.world; let j = 0;
      for (let i = 0; i < G.sel.length; i++) if (w.byId.has(G.sel[i])) G.sel[j++] = G.sel[i];
      if (j !== G.sel.length) { G.sel.length = j; NT.emit('ui:select', G.sel); }
    }
  }
  if (NT.Render && NT.Render.frame) NT.Render.frame(dt);
  if (NT.UI && NT.UI.frame) NT.UI.frame(dt);
  if (NT.Audio && NT.Audio.frame) NT.Audio.frame(dt);
};

NT.Game.resize = function () {
  const G = NT.Game;
  G.view.w = window.innerWidth; G.view.h = window.innerHeight;
  G.view.dpr = Math.min(3, window.devicePixelRatio || 1);
  if (NT.Render && NT.Render.resize) NT.Render.resize();
  G.clampCam();
  NT.emit('resize', G.view);
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
NT.Game.boot = function () {
  const G = NT.Game;
  G.canvas = document.getElementById('view');
  G.hud = document.getElementById('hud');
  G.params = new URLSearchParams(location.search);
  const q = G.params;
  G.loadSettings();
  NT.setLang(q.get('lang') || G.settings.lang || NT.guessLang(navigator.language));
  if (q.has('mute')) G.settings.mute = true;

  if (NT.Render && NT.Render.init) NT.Render.init(G.canvas);
  if (NT.UI && NT.UI.init) NT.UI.init(G.hud);
  if (NT.Input && NT.Input.init) NT.Input.init(G.canvas);
  if (NT.Audio && NT.Audio.init) NT.Audio.init();
  window.addEventListener('resize', G.resize);
  G.resize();
  G.state = 'menu';
  NT.emit('game:boot');

  if (q.has('demo') || q.has('autostart')) {
    const s = G.settings;
    G.start({
      faction: q.get('faction') || s.faction, enemy: q.get('enemy') || s.enemy,
      difficulty: q.get('diff') || s.difficulty,
      map: q.has('seed') || q.has('size') ? null : (q.get('map') || s.map || (NT.MAPS && NT.MAPS[0] && NT.MAPS[0].id)),
      seed: +q.get('seed') || (q.has('demo') ? 20260611 : 0), size: q.get('size') || undefined,
      fog: !q.has('nofog'), spectate: q.has('demo'),
    });
    if (q.has('brawl')) G.brawl(Math.min(200, +q.get('brawl') || 12));
    const ff = Math.min(3600, +q.get('t') || 0) * NT.TPS;
    for (let i = 0; i < ff && !G.world.over; i++) G.tick();
    if (q.has('speed')) G.setSpeed(+q.get('speed') || 1);
    if (q.has('cam')) {
      const c = q.get('cam').split(',').map(Number);
      if (c[2]) G.cam.zoom = c[2];
      G.focus(c[0] || 0, c[1] || 0);
    }
    if (q.has('paused')) G.pause(true);
  } else if (NT.UI && NT.UI.showMenu) NT.UI.showMenu();

  G._last = performance.now();
  requestAnimationFrame(G.frame);
};

window.addEventListener('load', NT.Game.boot);
