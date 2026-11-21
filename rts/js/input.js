'use strict';
// ============================================================================
// NEON TURF — input.js : player input — mouse, keyboard, touch  (presentation; DOM)
//
//   NT.Input.init(canvas) · frame(dt)            main.js hooks (frame: edge / key scrolling, hover + pointer refresh)
//   NT.Input.smartOrder(wx, wy, opts) -> bool    context order of the selection at a world point (RMB, touch tap,
//                                                minimap right-click). opts: {target: entity|null, queue|shift: bool}
//                                                (no target = ground / resource semantics, e.g. the minimap)
//   NT.Input.cancelMode()                        back to {type:'normal'} (a ready structure stays READY)
//   NT.Input.confirmPlace() -> bool              touch placement: place the ghost where it is now
//   NT.Input.selectAllCombat(onScreenOnly)       Q / W
//   NT.Input.selectType(ent, add)                all own entities of ent's def on screen
//   NT.Input.alert(wx, wy)                       remember a spot for Space (the HUD may call this; sim alerts are tracked here too)
//   NT.Input.escape()                            the Esc chain: cancel mode -> deselect -> NT.UI.onEscape()
//                                                (while a menu is open, or outside a match: straight to NT.UI.onEscape())
//
// Ownership: the main canvas (#view) and the keyboard. The HUD owns every DOM element inside #hud; pointer events
// that reach the canvas are playfield events. Nothing here mutates the world: orders go through NT.Game.cmd.
// Engine rule: no faction / unit / building id in this file — behaviour comes from def.traits / weapons / kind.
//
// GOTCHAS
//   - Parses before main.js: NT.Game is only touched inside functions.
//   - NT.Render.pick uses the last drawn frame: after moving the camera, pick on the next frame.
//   - Synthetic pointer ids make setPointerCapture throw: always try/catch.
//   - Keys match on e.code (layout / IME / Shift independent).
//   - The sim may not register every command yet (enter / deploy / power): never gate feedback on cmd()'s result.
// ============================================================================
(function () {
  const I = NT.Input = {};
  const DRAG = 6, TOUCH_DRAG = 10, LONG_MS = 350, DBL_MS = 350, DBL_PX = 24, GROUP_DBL_MS = 400;
  const EDGE = 10, SCROLL = 950, KEY_ZOOM = 1.2;

  let cv = null;
  const ptrs = new Map();                 // pointerId -> gesture record
  const keys = new Set();                 // held arrow keys (e.code)
  const edge = { x: -1, y: -1, on: false };
  let mouseBox = null;                    // LMB drag-select in progress: {x0, y0, x1, y1}
  let lastClick = { t: 0, x: 0, y: 0, def: null };
  let lastTap = { t: 0, x: 0, y: 0 };
  let lastGroup = { code: '', t: 0 };
  let lastAlert = null;                   // {x, y}
  let pinch = null;                       // two-finger gesture
  let touchLock = false;                  // a multi-finger gesture ran: ignore the rest until every finger is up
  let lastType = 'mouse';
  let cursor = '';
  const tmp = [];

  function G() { return NT.Game; }
  function now() { return performance.now(); }
  function world() { return NT.Game.world; }
  function playing() { const g = NT.Game; return !!g.world && (g.state === 'playing' || g.state === 'over'); }
  function blocked() { return NT.Game.modal || !playing(); }
  const TEXTY = /^(text|search|email|password|number|tel|url)$/i;
  function textFocus() {
    const a = document.activeElement;
    if (!a || a === document.body) return false;
    const tag = a.tagName;
    if (tag === 'INPUT') return TEXTY.test(a.type || 'text');
    return tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
  }
  function defOf(d) { return typeof d === 'string' ? NT.DEFS[d] || null : d || null; }
  function marker(wx, wy, kind) { if (NT.FX && NT.FX.marker) NT.FX.marker(wx, wy, kind); }
  function setBox(a, b, c, d) { if (NT.Render && NT.Render.setBox) NT.Render.setBox(a, b, c, d); }
  function mine(e) { return !!e && NT.Game.me >= 0 && e.owner === NT.Game.me; }
  function enemy(e) { return !!e && NT.Game.me >= 0 && NT.isEnemy(world(), NT.Game.me, e.owner); }
  function onScreen(e) {
    const s = NT.Game.toScreen(e.x, e.y), v = NT.Game.view;
    return s[0] >= 0 && s[1] >= 0 && s[0] <= v.w && s[1] <= v.h;
  }
  function isCombat(e) { return e.kind === 'unit' && e.def.weapons.length > 0 && !e.def.traits.harvester; }
  // a building that sends units out (producer of a 'unit' queue of its owner's faction)
  function isDoor(e) {
    const pr = e.def.traits.producer, p = world().players[e.owner];
    if (!pr || !p) return false;
    const qs = p.faction.queues || [];
    for (let i = 0; i < pr.queues.length; i++) for (let k = 0; k < qs.length; k++) if (qs[k].id === pr.queues[i] && qs[k].kind === 'unit') return true;
    return false;
  }

  // ---------------------------------------------------------------------------
  // Strings (only keys the HUD has not defined already)
  // ---------------------------------------------------------------------------
  function addStrings(t) {
    for (const lang in t) {
      const cur = NT.STR[lang] || {}, add = {};
      for (const k in t[lang]) if (cur[k] === undefined) add[k] = t[lang][k];
      const o = {}; o[lang] = add; NT.strings(o);
    }
  }
  function registerStrings() {
    addStrings({
      en: { 'err.place': 'Cannot build there', 'err.place.blocked': 'Cannot build there: blocked',
        'err.place.anchor': 'Too far from your base', 'err.place.vision': 'Cannot build where you cannot see',
        'err.noUnits': 'Select units first' },
      zh: { 'err.place': '无法在此建造', 'err.place.blocked': '无法在此建造：被阻挡',
        'err.place.anchor': '离基地太远', 'err.place.vision': '看不见的地方无法建造',
        'err.noUnits': '请先选择单位' },
    });
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------
  function selEnts() { return NT.Game.selected(tmp); }
  function ownUnits() {
    const out = [], s = selEnts();
    for (let i = 0; i < s.length; i++) if (mine(s[i]) && s[i].kind === 'unit' && !s[i].hidden) out.push(s[i]);
    return out;
  }
  function ids(list) { const out = []; for (let i = 0; i < list.length; i++) out.push(list[i].id); return out; }

  // click on an entity (or nothing): plain / shift (add-remove) / type (ctrl or double-click)
  function clickSelect(e, shift, type) {
    const g = NT.Game;
    if (!e) { if (!shift) g.select([]); return; }
    if (type && mine(e)) { I.selectType(e, shift); return; }
    if (shift && mine(e)) {
      const cur = selEnts().filter(mine).map(function (x) { return x.id; });
      const at = cur.indexOf(e.id);
      if (at >= 0) cur.splice(at, 1); else cur.push(e.id);
      g.select(cur);
      return;
    }
    g.select([e.id]);
  }

  I.selectType = function (e, add) {
    const g = NT.Game, w = world();
    if (!w || !e) return;
    const out = add ? selEnts().filter(mine).map(function (x) { return x.id; }) : [];
    for (let i = 0; i < w.ents.length; i++) {
      const o = w.ents[i];
      if (o.alive && !o.hidden && o.def === e.def && mine(o) && onScreen(o) && out.indexOf(o.id) < 0) out.push(o.id);
    }
    if (out.indexOf(e.id) < 0) out.push(e.id);
    g.select(out);
  };

  // own units inside a screen rectangle; with none, a lone own building under it
  function boxSelect(x0, y0, x1, y1, add) {
    const g = NT.Game, w = world();
    if (!w) return;
    const a = g.toWorld(Math.min(x0, x1), Math.min(y0, y1)), b = g.toWorld(Math.max(x0, x1), Math.max(y0, y1));
    const out = add ? selEnts().filter(mine).map(function (x) { return x.id; }) : [];
    let n = 0;
    for (let i = 0; i < w.ents.length; i++) {
      const e = w.ents[i];
      if (!e.alive || e.hidden || e.kind !== 'unit' || !mine(e)) continue;
      const r = e.def.radius * 0.6;
      if (e.x + r < a[0] || e.x - r > b[0] || e.y + r < a[1] || e.y - r > b[1]) continue;
      n++;
      if (out.indexOf(e.id) < 0) out.push(e.id);
    }
    if (n || !add) g.select(out);
  }

  I.selectAllCombat = function (onScreenOnly) {
    const w = world();
    if (!w || NT.Game.me < 0) return;
    const out = [];
    for (let i = 0; i < w.ents.length; i++) {
      const e = w.ents[i];
      if (e.alive && !e.hidden && mine(e) && isCombat(e) && (!onScreenOnly || onScreen(e))) out.push(e.id);
    }
    NT.Game.select(out);
  };

  function centreOn(list) {
    if (!list.length) return;
    let x = 0, y = 0;
    for (let i = 0; i < list.length; i++) { x += list[i].x; y += list[i].y; }
    NT.Game.lookAt(x / list.length, y / list.length);
  }

  function groupKey(code, ctrl, shift) {
    const g = NT.Game, d = code.slice(-1), w = world();
    if (ctrl) { g.groups[d] = selEnts().filter(mine).map(function (e) { return e.id; }); return; }
    const alive = (g.groups[d] || []).filter(function (id) { return w.byId.has(id); });
    g.groups[d] = alive;
    if (!alive.length) return;
    if (shift) {
      const cur = selEnts().filter(mine).map(function (e) { return e.id; });
      for (let i = 0; i < alive.length; i++) if (cur.indexOf(alive[i]) < 0) cur.push(alive[i]);
      g.select(cur);
      return;
    }
    const t = now();
    g.select(alive);
    if (lastGroup.code === code && t - lastGroup.t < GROUP_DBL_MS) centreOn(selEnts());
    lastGroup.code = code; lastGroup.t = t;
  }

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------
  function cmd(c) { return NT.Game.cmd(c); }

  function resourceAt(wx, wy) {
    const w = world(), cx = Math.floor(wx / NT.TILE), cy = Math.floor(wy / NT.TILE);
    if (cx < 0 || cy < 0 || cx >= w.w || cy >= w.h || !w.map.res) return false;
    if (w.map.res[cy * w.w + cx] <= 0) return false;
    const g = NT.Game;
    if (g.me >= 0 && w.fogEnabled) { const t = w.teams[g.team()]; if (t && !t.explored[cy * w.w + cx]) return false; }
    return true;
  }

  function rallyOrder(wx, wy) {
    const doors = selEnts().filter(function (e) { return mine(e) && e.kind === 'building' && isDoor(e); });
    if (!doors.length) return false;
    for (let i = 0; i < doors.length; i++) cmd({ type: 'rally', id: doors[i].id, x: wx, y: wy });
    marker(wx, wy, 'rally');
    return true;
  }

  // The context order for the current selection at (wx, wy). Returns true when something was ordered.
  I.smartOrder = function (wx, wy, opts) {
    opts = opts || {};
    const g = NT.Game, w = world();
    if (!w || g.me < 0 || blocked()) return false;
    if (g.paused) { NT.emit('ui:error', 'ui.t.paused'); return false; }
    const units = ownUnits(), q = !!(opts.queue || opts.shift);
    if (!units.length) return rallyOrder(wx, wy);
    let t = opts.target || null;
    if (t && (!t.alive || t.hidden || !g.sees(t))) t = null;
    const harv = [], capt = [], rest = [];
    for (let i = 0; i < units.length; i++) {
      const u = units[i], tr = u.def.traits;
      if (tr.harvester) harv.push(u); else if (tr.capturer) capt.push(u); else rest.push(u);
    }
    let kind = 'move';
    const movers = [];
    const send = function (type, list, extra) {
      if (!list.length) return;
      const c = Object.assign({ type: type, ids: ids(list) }, extra || {});
      if (q) c.queue = true;
      cmd(c);
    };
    if (t && t.kind === 'building' && !mine(t) && t.def.traits.capturable && capt.length && !NT.isAlly(w, g.me, t.owner)) {
      send('enter', capt, { target: t.id });
      kind = 'capture';
      const others = rest.concat(harv);
      if (enemy(t)) { send('attack', others.filter(armed), { target: t.id }); push(movers, others.filter(unarmed)); }
      else push(movers, others);
    } else if (t && enemy(t)) {
      const fighters = units.filter(armed);
      send('attack', fighters, { target: t.id });
      push(movers, units.filter(unarmed));
      kind = fighters.length ? 'attack' : 'move';
    } else if (t && mine(t) && t.kind === 'building' && t.def.traits.dropoff && harv.length) {
      send('return', harv);
      push(movers, capt.concat(rest));
      kind = 'harvest';
    } else if (!t && harv.length && resourceAt(wx, wy)) {
      send('harvest', harv, { x: wx, y: wy });
      push(movers, capt.concat(rest));
      kind = 'harvest';
    } else {
      push(movers, units);
    }
    if (movers.length) send('move', movers, { x: wx, y: wy });
    const mx = t && kind !== 'move' ? t.x : wx, my = t && kind !== 'move' ? t.y : wy;
    marker(mx, my, kind);
    return true;
  };
  function push(a, b) { for (let i = 0; i < b.length; i++) a.push(b[i]); }
  function armed(u) { return u.def.weapons.length > 0; }
  function unarmed(u) { return u.def.weapons.length === 0; }

  function amoveAt(wx, wy, queue, target) {
    const units = ownUnits();
    if (!units.length) return false;
    if (target && enemy(target) && NT.Game.sees(target)) {
      const c = { type: 'attack', ids: ids(units), target: target.id };
      if (queue) c.queue = true;
      cmd(c);
      marker(target.x, target.y, 'attack');
      return true;
    }
    const c = { type: 'amove', ids: ids(units), x: wx, y: wy };
    if (queue) c.queue = true;
    cmd(c);
    marker(wx, wy, 'amove');
    return true;
  }

  function unitCmd(type, extra) {
    const units = ownUnits();
    if (!units.length) return false;
    cmd(Object.assign({ type: type, ids: ids(units) }, extra || {}));
    return true;
  }
  function toggleStance() {
    const units = ownUnits();
    if (!units.length) return;
    const allHold = units.every(function (u) { return u.stance === 'hold'; });
    unitCmd('stance', { stance: allHold ? 'aggressive' : 'hold' });
  }
  function deploy() {
    const units = ownUnits().filter(function (u) { return !!u.def.traits.deploy; });
    if (units.length) cmd({ type: 'deploy', ids: ids(units) });
  }

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------
  I.cancelMode = function () {
    const g = NT.Game;
    if (g.mode && g.mode.type !== 'normal') g.setMode({ type: 'normal' });
  };

  function placeDef() { const m = NT.Game.mode; return m && m.type === 'place' ? defOf(m.def) : null; }
  function placeCellAt(def, wx, wy) {
    if (NT.Render && NT.Render.placeCell) return NT.Render.placeCell(def, wx, wy);
    return [Math.round(wx / NT.TILE - def.size[0] / 2), Math.round(wy / NT.TILE - def.size[1] / 2)];
  }
  function tryPlace(cx, cy) {
    const g = NT.Game, def = placeDef(), p = g.player();
    if (!def || !p || !NT.Prod || !NT.Prod.canPlace) return false;
    const res = NT.Prod.canPlace(g.world, p, def, cx, cy);
    if (!res || !res.ok) {
      const key = res && NT.STR.en['err.place.' + res.reason] !== undefined ? 'err.place.' + res.reason : 'err.place';
      NT.emit('ui:error', key);
      marker((cx + def.size[0] / 2) * NT.TILE, (cy + def.size[1] / 2) * NT.TILE, 'deny');
      return false;
    }
    cmd({ type: 'place', def: def.id, cx: cx, cy: cy });
    I.cancelMode();
    return true;
  }
  I.confirmPlace = function () {
    const g = NT.Game, m = g.mode, def = placeDef();
    if (!def || blocked()) return false;
    const c = m.cx !== undefined ? [m.cx, m.cy] : placeCellAt(def, g.pointer.wx, g.pointer.wy);
    return tryPlace(c[0], c[1]);
  };
  // touch: pin the ghost (render.js draws mode.cx / cy when set)
  function pinGhost(def, wx, wy) {
    const m = NT.Game.mode, c = placeCellAt(def, wx, wy);
    m.cx = c[0]; m.cy = c[1];
  }
  function seedGhost() {
    const g = NT.Game, m = g.mode, def = placeDef(), p = g.player();
    if (!def || m.cx !== undefined || !p) return;
    let c = null;
    if (NT.Prod && NT.Prod.findPlace) c = NT.Prod.findPlace(g.world, p, def, Math.floor(g.cam.x / NT.TILE), Math.floor(g.cam.y / NT.TILE), { maxR: 8 });
    if (!c) c = placeCellAt(def, g.cam.x, g.cam.y);
    m.cx = c[0]; m.cy = c[1];
  }

  function powerId(pw) { return typeof pw === 'string' ? pw : pw && pw.id; }

  // LMB / tap in a targeting mode. Returns true if the mode consumed the click.
  function modeClick(sx, sy, shift) {
    const g = NT.Game, m = g.mode;
    if (!m || m.type === 'normal') return false;
    if (g.paused) { NT.emit('ui:error', 'ui.t.paused'); return true; }     // the mode stays armed for after the pause
    const p = g.toWorld(sx, sy), wx = p[0], wy = p[1];
    if (m.type === 'place') {
      const def = placeDef();
      if (def) { const c = placeCellAt(def, wx, wy); tryPlace(c[0], c[1]); }
      return true;
    }
    if (m.type === 'target') {
      const t = NT.Render && NT.Render.pick ? NT.Render.pick(sx, sy) : null;
      if (m.what === 'amove') amoveAt(wx, wy, shift, t);
      else if (m.what === 'attack') { if (t && enemy(t)) amoveAt(wx, wy, shift, t); else amoveAt(wx, wy, shift, null); }
      else if (m.what === 'power') {
        // pre-check (the sim's verdict only arrives next tick): a bad target keeps the power armed for another try
        const chk = NT.Powers && NT.Powers.canFire && g.player() ? NT.Powers.canFire(g.world, g.player(), m.power, wx, wy) : null;
        if (chk && !chk.ok) {
          NT.emit('ui:error', 'ui.deny.' + chk.reason);
          marker(wx, wy, 'deny');
          if (chk.reason !== 'target') I.cancelMode();
          return true;
        }
        cmd({ type: 'power', power: powerId(m.power), x: wx, y: wy }); marker(wx, wy, 'attack');
      }
      else if (m.what === 'rally') rallyOrder(wx, wy);
      if (!shift || m.what === 'power') I.cancelMode();
      return true;
    }
    I.cancelMode();
    return true;
  }

  I.escape = function () {
    const g = NT.Game;
    if (!g.modal && playing()) {
      if (g.mode && g.mode.type !== 'normal') { I.cancelMode(); return; }
      if (g.sel.length) { g.select([]); return; }
    }
    if (NT.UI && NT.UI.onEscape) NT.UI.onEscape();
  };

  I.alert = function (wx, wy) { lastAlert = { x: wx, y: wy, t: NT.Game.now }; };
  function onSim(ev) {
    const g = NT.Game, me = g.me;
    if (me < 0 || !g.world) return;
    if (ev.t === 'hurt' && ev.owner === me) I.alert(ev.x, ev.y);
    else if (ev.t === 'captured' && (ev.to === me || ev.from === me)) I.alert(ev.x, ev.y);
    else if (ev.t === 'strike_warn' && NT.isEnemy(g.world, me, ev.owner)) I.alert(ev.x, ev.y);
    else if ((ev.t === 'placed' || ev.t === 'produced') && ev.owner === me) I.alert(ev.x, ev.y);
  }
  function jumpAlert() {
    let a = lastAlert, u = NT.UI && NT.UI.lastAlert;
    if (typeof u === 'function') u = u();
    if (u && (!a || (u.t || 0) >= a.t)) a = u;      // the newer of the HUD's located alerts and ours
    if (a) NT.Game.lookAt(a.x, a.y);
  }
  function jumpBase() {
    const w = world(), g = NT.Game;
    if (!w || g.me < 0) return;
    let best = null;
    for (let i = 0; i < w.ents.length; i++) {
      const e = w.ents[i];
      if (!e.alive || e.kind !== 'building' || !mine(e)) continue;
      if (e.def.role === 'hq') { best = e; break; }
      if (!best || (e.def.countsForDefeat && !best.def.countsForDefeat)) best = e;
    }
    if (best) g.lookAt(best.x, best.y);
    else { const p = g.player(); g.lookAt((p.startCx + 1.5) * NT.TILE, (p.startCy + 1.5) * NT.TILE); }
  }

  // ---------------------------------------------------------------------------
  // Pointer plumbing
  // ---------------------------------------------------------------------------
  function local(e) { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  function setPointer(x, y, inside) {
    const g = NT.Game, p = g.pointer, w = g.toWorld(x, y);
    p.x = x; p.y = y; p.wx = w[0]; p.wy = w[1]; p.inside = inside;
  }
  function capture(e) { try { cv.setPointerCapture(e.pointerId); } catch (err) { /* synthetic id */ } }
  function panTo(r, x, y) {
    const g = NT.Game;
    g.cam.x = r.camX - (x - r.x0) / g.cam.zoom;
    g.cam.y = r.camY - (y - r.y0) / g.cam.zoom;
    g.clampCam();
  }

  function onDown(e) {
    lastType = e.pointerType || 'mouse';
    if (NT.Audio && NT.Audio.unlock) { try { NT.Audio.unlock(); } catch (err) { /* fail soft */ } }
    if (blocked()) return;
    e.preventDefault();                              // also stops the default focus change: hand focus back ourselves
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();
    if (lastType === 'touch') { touchDown(e); return; }
    const xy = local(e), g = NT.Game;
    setPointer(xy[0], xy[1], true);
    capture(e);
    const r = { id: e.pointerId, button: e.button, x0: xy[0], y0: xy[1], x: xy[0], y: xy[1], camX: g.cam.x, camY: g.cam.y, moved: false, t0: now() };
    ptrs.set(e.pointerId, r);
    if (e.button === 0) {
      if (g.mode.type !== 'normal') { modeClick(xy[0], xy[1], e.shiftKey); r.done = true; return; }
      mouseBox = null;
    }
  }

  function onMove(e) {
    const t = e.pointerType || 'mouse';
    if (t === 'touch') { touchMove(e); return; }
    const xy = local(e), m = NT.Game.mode;
    setPointer(xy[0], xy[1], true);
    lastType = t;
    if (m.type === 'place' && m.cx !== undefined) { delete m.cx; delete m.cy; }   // a touch-pinned ghost follows the mouse again
    const r = ptrs.get(e.pointerId);
    if (!r) return;
    r.x = xy[0]; r.y = xy[1];
    if (!r.moved && Math.hypot(r.x - r.x0, r.y - r.y0) > DRAG) r.moved = true;
    if (!r.moved || r.done) return;
    if (r.button === 0) {
      mouseBox = { x0: r.x0, y0: r.y0, x1: r.x, y1: r.y };
      setBox(r.x0, r.y0, r.x, r.y);
    } else panTo(r, r.x, r.y);
  }

  function onUp(e) {
    const t = e.pointerType || 'mouse';
    if (t === 'touch') { touchUp(e, false); return; }
    const r = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (!r) return;
    const xy = local(e);
    if (r.done || blocked()) { endBox(); return; }
    const g = NT.Game;
    if (r.button === 0) {
      if (r.moved && mouseBox) { boxSelect(mouseBox.x0, mouseBox.y0, xy[0], xy[1], e.shiftKey); endBox(); return; }
      endBox();
      const ent = NT.Render && NT.Render.pick ? NT.Render.pick(xy[0], xy[1]) : null;
      const tt = now();
      const dbl = !!ent && !e.shiftKey && tt - lastClick.t < DBL_MS && Math.hypot(xy[0] - lastClick.x, xy[1] - lastClick.y) < DBL_PX && lastClick.def === ent.def;
      lastClick = { t: tt, x: xy[0], y: xy[1], def: ent ? ent.def : null };
      clickSelect(ent, e.shiftKey, e.ctrlKey || e.metaKey || dbl);
    } else if (r.button === 2 && !r.moved) {
      if (g.mode.type !== 'normal') { I.cancelMode(); return; }
      const w = g.toWorld(xy[0], xy[1]);
      const ent = NT.Render && NT.Render.pick ? NT.Render.pick(xy[0], xy[1]) : null;
      I.smartOrder(w[0], w[1], { target: ent, queue: e.shiftKey });
    }
  }
  function endBox() { mouseBox = null; setBox(null); }

  function onCancel(e) {
    if ((e.pointerType || 'mouse') === 'touch') { touchUp(e, true); return; }
    ptrs.delete(e.pointerId);
    endBox();
  }

  function onWheel(e) {
    e.preventDefault();
    if (blocked()) return;
    const xy = local(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32; else if (e.deltaMode === 2) dy *= 400;
    NT.Game.zoomAt(xy[0], xy[1], Math.exp(-NT.clamp(dy, -300, 300) * 0.0015));
  }

  // ---------------------------------------------------------------------------
  // Touch: tap / drag-pan / long-press box / pinch / double-tap
  // ---------------------------------------------------------------------------
  function touchDown(e) {
    const xy = local(e), g = NT.Game;
    capture(e);
    const r = { id: e.pointerId, x0: xy[0], y0: xy[1], x: xy[0], y: xy[1], camX: g.cam.x, camY: g.cam.y, moved: false,
      t0: now(), box: false, timer: 0, ghost: null };
    ptrs.set(e.pointerId, r);
    setPointer(xy[0], xy[1], false);
    if (ptrs.size === 2) { startPinch(); return; }
    if (ptrs.size > 2 || touchLock) return;
    const def = placeDef();
    if (def) {
      if (g.mode.cx === undefined) pinGhost(def, g.toWorld(xy[0], xy[1])[0], g.toWorld(xy[0], xy[1])[1]);
      r.ghost = [g.mode.cx, g.mode.cy];
      return;
    }
    r.timer = setTimeout(function () {
      if (ptrs.get(r.id) !== r || r.moved || touchLock) return;
      r.box = true;
      setBox(r.x0, r.y0, r.x, r.y);
      if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* ignore */ } }
    }, LONG_MS);
  }

  function touchMove(e) {
    const r = ptrs.get(e.pointerId);
    if (!r) return;
    const xy = local(e), g = NT.Game;
    r.x = xy[0]; r.y = xy[1];
    if (pinch) { movePinch(); return; }
    if (touchLock || blocked()) return;
    if (!r.moved && Math.hypot(r.x - r.x0, r.y - r.y0) > TOUCH_DRAG) { r.moved = true; clearTimeout(r.timer); }
    if (!r.moved) return;
    setPointer(xy[0], xy[1], false);
    if (r.ghost) {                                   // drag moves the ghost by the finger's delta (finger never hides it)
      const k = NT.TILE * g.cam.zoom;
      g.mode.cx = r.ghost[0] + Math.round((r.x - r.x0) / k);
      g.mode.cy = r.ghost[1] + Math.round((r.y - r.y0) / k);
    } else if (r.box) setBox(r.x0, r.y0, r.x, r.y);
    else panTo(r, r.x, r.y);
  }

  function touchUp(e, cancelled) {
    const r = ptrs.get(e.pointerId);
    ptrs.delete(e.pointerId);
    if (!r) return;
    clearTimeout(r.timer);
    if (pinch) { if (ptrs.size < 2) { pinch = null; touchLock = ptrs.size > 0; } return; }
    if (touchLock) { if (!ptrs.size) touchLock = false; return; }
    if (cancelled || blocked()) { endBox(); return; }
    if (r.box) {
      if (r.moved) boxSelect(r.x0, r.y0, r.x, r.y, false);
      else {                                         // long-press without a drag: add / remove like Shift-click
        const ent = pickTouch(r.x, r.y);
        if (ent && mine(ent)) clickSelect(ent, true, false);
      }
      endBox();
      return;
    }
    if (r.ghost) {
      if (!r.moved) { const w = NT.Game.toWorld(r.x, r.y); pinGhost(placeDef(), w[0], w[1]); }
      return;
    }
    if (!r.moved) tap(r.x, r.y);
  }

  // pick with a fingertip: exact point first, then a small ring around it
  const RING = [[0, -14], [14, 0], [0, 14], [-14, 0], [10, -10], [10, 10], [-10, 10], [-10, -10]];
  function pickTouch(x, y) {
    if (!NT.Render || !NT.Render.pick) return null;
    let e = NT.Render.pick(x, y);
    for (let i = 0; !e && i < RING.length; i++) e = NT.Render.pick(x + RING[i][0], y + RING[i][1]);
    return e;
  }

  function tap(x, y) {
    const g = NT.Game, t = now();
    const dbl = t - lastTap.t < DBL_MS && Math.hypot(x - lastTap.x, y - lastTap.y) < DBL_PX * 1.5;
    lastTap = { t: dbl ? 0 : t, x: x, y: y };
    if (g.mode.type === 'target') { modeClick(x, y, false); return; }
    const ent = pickTouch(x, y);
    if (dbl && ent && mine(ent)) { I.selectType(ent, false); return; }
    if (ent && mine(ent)) { clickSelect(ent, false, false); return; }
    const w = g.toWorld(x, y);
    const commanding = ownUnits().length > 0 || selEnts().some(function (s) { return mine(s) && s.kind === 'building' && isDoor(s); });
    // with something to command, a tap on ground / enemy / resource / turf is the RMB order; friends are inspected
    if (commanding && !(ent && !enemy(ent) && !(ent.kind === 'building' && ent.def.traits.capturable))) {
      I.smartOrder(w[0], w[1], { target: ent });
      return;
    }
    clickSelect(ent, false, false);
  }

  function startPinch() {
    const g = NT.Game, a = Array.from(ptrs.values());
    for (let i = 0; i < a.length; i++) clearTimeout(a[i].timer);
    endBox();
    const mx = (a[0].x + a[1].x) / 2, my = (a[0].y + a[1].y) / 2;
    pinch = { a: a[0], b: a[1], d0: Math.max(20, Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y)), z0: g.cam.zoom, w0: g.toWorld(mx, my) };
    touchLock = true;
  }
  function movePinch() {
    const g = NT.Game, a = pinch.a, b = pinch.b;
    const d = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    g.cam.zoom = NT.clamp(pinch.z0 * d / pinch.d0, g.ZOOM_MIN, g.ZOOM_MAX);
    g.cam.x = pinch.w0[0] - (mx - g.view.w / 2) / g.cam.zoom;
    g.cam.y = pinch.w0[1] - (my - g.view.h / 2) / g.cam.zoom;
    g.clampCam();
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------
  const ARROWS = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
  function onKey(e) {
    const g = NT.Game, code = e.code;
    if (textFocus()) return;
    if (code === 'Escape') { if (!e.repeat) I.escape(); e.preventDefault(); return; }   // menus too: ui.js has no key listener
    if (g.modal || !playing()) return;
    const ctrl = e.ctrlKey || e.metaKey, alt = e.altKey;
    if (ARROWS[code]) { keys.add(code); e.preventDefault(); return; }
    if (/^Digit[1-9]$/.test(code) || /^Numpad[1-9]$/.test(code)) {
      if (e.repeat) { e.preventDefault(); return; }
      groupKey(code, ctrl || alt, e.shiftKey);
      e.preventDefault();
      return;
    }
    if (code === 'Equal' || code === 'NumpadAdd') { g.zoomAt(g.view.w / 2, g.view.h / 2, KEY_ZOOM); e.preventDefault(); return; }
    if (code === 'Minus' || code === 'NumpadSubtract') { g.zoomAt(g.view.w / 2, g.view.h / 2, 1 / KEY_ZOOM); e.preventDefault(); return; }
    if (ctrl || alt || e.repeat) return;
    switch (code) {
      case 'KeyA': if (ownUnits().length) g.setMode({ type: 'target', what: 'amove' }); break;
      case 'KeyS': unitCmd('stop'); break;
      case 'KeyH': toggleStance(); break;
      case 'KeyD': deploy(); break;
      case 'KeyQ': I.selectAllCombat(true); break;
      case 'KeyW': I.selectAllCombat(false); break;
      case 'Space': jumpAlert(); break;
      case 'KeyB': jumpBase(); break;
      case 'KeyP': g.pause(); break;
      case 'KeyM': g.saveSettings({ mute: !g.settings.mute }); break;
      default: return;
    }
    e.preventDefault();
  }
  function onKeyUp(e) { keys.delete(e.code); }
  function onBlur() { keys.clear(); edge.on = false; }

  // ---------------------------------------------------------------------------
  // Frame: scrolling, pointer + hover refresh, cursor
  // ---------------------------------------------------------------------------
  I.frame = function (dt) {
    const g = NT.Game;
    if (!playing()) return;
    let vx = 0, vy = 0;
    if (!g.modal && !textFocus()) {
      if (keys.has('ArrowLeft')) vx -= 1;
      if (keys.has('ArrowRight')) vx += 1;
      if (keys.has('ArrowUp')) vy -= 1;
      if (keys.has('ArrowDown')) vy += 1;
      if (edge.on && g.settings && g.settings.edgeScroll && !mouseBox && !anyDrag()) {
        const v = g.view;
        if (edge.x <= EDGE) vx -= 1; else if (edge.x >= v.w - 1 - EDGE) vx += 1;
        if (edge.y <= EDGE) vy -= 1; else if (edge.y >= v.h - 1 - EDGE) vy += 1;
      }
    }
    if (vx || vy) {
      const k = SCROLL * dt / g.cam.zoom / (vx && vy ? Math.SQRT2 : 1);
      g.cam.x += vx * k; g.cam.y += vy * k;
      g.clampCam();
    }
    const p = g.pointer;
    const w = g.toWorld(p.x, p.y); p.wx = w[0]; p.wy = w[1];
    let hov = 0;
    if (p.inside && lastType !== 'touch' && !g.modal && NT.Render && NT.Render.pick) { const e = NT.Render.pick(p.x, p.y); hov = e ? e.id : 0; }
    g.hover = hov;
    updateCursor(hov);
  };
  function anyDrag() { for (const r of ptrs.values()) if (r.moved) return true; return false; }

  function updateCursor(hov) {
    const g = NT.Game, m = g.mode;
    let c = 'default';
    if (m.type === 'target') c = 'crosshair';
    else if (m.type === 'place') c = 'copy';
    else if (anyDrag() && !mouseBox) c = 'grabbing';
    else if (hov) {
      const e = NT.get(g.world, hov);
      if (e && enemy(e) && ownUnits().length) c = 'crosshair';
      else if (e) c = 'pointer';
    }
    if (c !== cursor) { cursor = c; cv.style.cursor = c; }
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  I.init = function (canvas) {
    cv = canvas;
    cv.style.touchAction = 'none';
    registerStrings();
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onCancel);
    cv.addEventListener('lostpointercapture', function (e) { if (ptrs.has(e.pointerId) && (e.pointerType || 'mouse') !== 'touch') onCancel(e); });
    cv.addEventListener('pointerleave', function (e) { if ((e.pointerType || 'mouse') !== 'touch' && !ptrs.size) NT.Game.pointer.inside = false; });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) lastType = 'touch';
    // HUD taps count too: a touch user enters place mode from a HUD button and must get a pinned ghost
    document.addEventListener('pointerdown', function (e) { lastType = e.pointerType || 'mouse'; }, true);
    // edge scroll sees the mouse over HUD panels too (they cover the screen edges)
    document.addEventListener('pointermove', function (e) {
      if ((e.pointerType || 'mouse') !== 'mouse') { edge.on = false; return; }
      edge.x = e.clientX; edge.y = e.clientY; edge.on = true;
    }, true);
    document.documentElement.addEventListener('mouseleave', function () { edge.on = false; });
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    NT.on('sim', onSim);
    NT.on('ui:mode', function (m) {
      if (m && m.type === 'place' && lastType === 'touch') seedGhost();
      if (!m || m.type !== 'place') endBox();
    });
    NT.on('game:start', function () { ptrs.clear(); pinch = null; touchLock = false; lastAlert = null; endBox(); keys.clear(); });
    NT.on('game:stop', function () { ptrs.clear(); pinch = null; touchLock = false; endBox(); keys.clear(); });
    NT.on('game:over', function () { I.cancelMode(); mouseBox = null; endBox(); });   // no armed crosshair behind the result screen
  };
})();
