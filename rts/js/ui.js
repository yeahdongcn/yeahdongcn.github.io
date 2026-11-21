'use strict';
// ============================================================================
// NEON TURF — ui.js : the DOM HUD + menus  (presentation; NT.UI)
//
//   NT.UI.init(root)                 build the HUD skeleton inside #hud (main.js, once)
//   NT.UI.frame(dt)                  per frame: counters, toasts; meters / build grid / selection / minimap at ~10 Hz
//   NT.UI.showMenu()                 the main menu (boot without ?autostart, quit, NT.Game.stop)
//   NT.UI.toast(key, vars, opts)     a bilingual message. vars may hold {en, zh} objects (re-translated on 'lang').
//                                    opts: { kind: 'info'|'good'|'warn'|'bad', at: [wx, wy] (click = jump + ping),
//                                    group (same group refreshes one toast, counts repeats), every (ms throttle per
//                                    group), ttl (s), onClick () }
//   NT.UI.onEscape() -> bool         input.js calls it for an Esc nobody else used: closes the open overlay or opens
//                                    the pause menu. true = consumed.
//   NT.UI.openPause() / closeOverlay() / showHowTo()
//   NT.UI.lastAlert                  {x, y, t} world px of the latest located alert (input: Space = jump there) or null
//   NT.UI.compact                    true while the touch / small-screen layout is active
//   NT.UI.insets() -> {top, right, bottom, left}   CSS px of the playfield edges the HUD covers right now (for a
//                                    camera clamp that keeps the map edge out from under the sidebar / sheet)
//
// DOM (inside #hud, which ignores the pointer; panels opt back in):
//   .nt-top      top bar: Glint · power meter · clock | speed · sound · language · menu
//   .nt-side     right sidebar: minimap (.nt-mm) · support powers · queue tabs · build grids
//                (compact: a bottom sheet; the minimap moves to a corner and the selection shares the sheet)
//   .nt-sel      selection panel (portrait + stats, or grouped portraits) + action buttons
//   .nt-toasts   toasts / alerts       .nt-hint  first-game coach line       .nt-banner  mode line + touch confirm bar
//   .nt-tip      build tooltip         .nt-ov    full-screen overlays (main menu, pause, how to play, game over)
//
// Engine rule: no faction / unit / building id in this file. Names, numbers and looks come from def data,
// NT.Art and the trait vocabulary. All strings: NT.strings below, keys prefixed 'ui.'.
// GOTCHAS
//   - Parses before main.js: NT.Game is only touched inside functions.
//   - Commands take def ID strings (produce / cancel); modes take def OBJECTS (setMode place).
//   - NT.Art.icon returns a shared cached canvas: always blit it, never append it.
//   - HUD buttons must never keep focus (Space / Enter belong to input.js): mousedown default is prevented.
// ============================================================================
(function () {
  const UI = NT.UI = {};
  const NEUTRAL = '#8d97ad';
  const SPEEDS = [0.5, 1, 1.5, 2, 3];
  const H = {};                       // DOM references
  let root = null, built = null, tab = null;
  let acc = 0, mmAcc = 0, selDirty = true, selSig = '', actSig = '';
  let tipRec = null, overT = -1, shown = 0;
  const rows = [], selEnts = [];
  UI.lastAlert = null;
  UI.compact = false;

  // --------------------------------------------------------------------------
  // Small helpers
  // --------------------------------------------------------------------------
  function el(tag, cls, parent, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  function btn(cls, parent, text) { const b = el('button', cls, parent, text); b.type = 'button'; b.tabIndex = -1; return b; }
  function txt(e, s) { s = String(s); if (e._t !== s) { e._t = s; e.textContent = s; } }
  function tog(e, c, on) { on = !!on; const k = '_c_' + c; if (e[k] !== on) { e[k] = on; e.classList.toggle(c, on); } }
  function css(e, k, v) { const kk = '_s_' + k; if (e[kk] !== v) { e[kk] = v; e.style.setProperty(k, v); } }
  function T(k, v) {
    if (v) { const o = {}; for (const n in v) o[n] = v[n] && typeof v[n] === 'object' ? NT.tr(v[n]) : v[n]; v = o; }
    return NT.T(k, v);
  }
  function G() { return NT.Game; }
  function dpr() { return Math.min(3, window.devicePixelRatio || 1); }
  function fmt(n) { return Math.floor(n).toLocaleString('en-US'); }
  function sec(s) { return (Math.round(s * 10) / 10).toString(); }
  function pct(x) { return Math.round(x * 100) + '%'; }
  function signed(x) { const v = Math.round((x - 1) * 100); return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v) + '%'; }
  function clock(ticks) { const s = Math.floor(ticks / NT.TPS), m = Math.floor(s / 60); return m + ':' + String(s % 60).padStart(2, '0'); }
  function colorOf(owner) { const w = G().world, p = w && w.players[owner]; return p ? p.color : NEUTRAL; }
  function rgba(hex, a) {
    const h = (hex || NEUTRAL).replace('#', ''), n = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h, 16);
    return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function svg(path, cls) { return '<svg class="' + (cls || 'nt-ico') + '" viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>'; }
  const ICON = {
    glint: svg('<path d="M12 2l2.6 7.4L22 12l-7.4 2.6L12 22l-2.6-7.4L2 12l7.4-2.6z" fill="currentColor"/><path d="M19 3l.8 2.2L22 6l-2.2.8L19 9l-.8-2.2L16 6l2.2-.8z" fill="currentColor" opacity=".6"/>'),
    bolt: svg('<path d="M13 2L4 14h6l-1 8 9-12h-6z" fill="currentColor"/>'),
    clock: svg('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 7v5l3 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
    snd: svg('<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
    mute: svg('<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'),
    menu: svg('<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
    ff: svg('<path d="M3 6l8 6-8 6zM12 6l8 6-8 6z" fill="currentColor"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="1.5" fill="currentColor"/><path d="M8 11V8a4 4 0 018 0v3" fill="none" stroke="currentColor" stroke-width="2"/>'),
    jump: svg('<circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5" stroke="currentColor" stroke-width="2"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  };

  // Draw a cached art icon into our own canvas (the cached one is shared).
  function blit(cv, def, team, px) {
    const S = Math.round(px * dpr());
    if (cv.width !== S) { cv.width = S; cv.height = S; }
    cv.style.width = cv.style.height = px + 'px';
    const x = cv.getContext('2d');
    x.clearRect(0, 0, S, S);
    if (def && NT.Art && NT.Art.icon) x.drawImage(NT.Art.icon(def, team, px), 0, 0, S, S);
  }
  function iconCanvas(cls, parent, def, team, px) { const c = el('canvas', cls, parent); blit(c, def, team, px); return c; }

  // Every def of a faction whose producer trait builds queue qid.
  function producersOf(faction, qid) {
    return faction.defs.filter(function (d) { return d.traits.producer && d.traits.producer.queues.indexOf(qid) >= 0; });
  }
  // A building that sends units out (produces some unit queue of its faction).
  function isDoor(def) {
    const pr = def.traits.producer, f = NT.FACTIONS[def.faction];
    return !!(pr && f && pr.queues.some(function (q) { return f.queueById[q] && f.queueById[q].kind === 'unit'; }));
  }
  function armed(def) { return def.weapons.some(function (w) { return !w.heal; }); }
  function powerDef(p) { return typeof p === 'string' ? NT.POWERS[p] : p; }

  // --------------------------------------------------------------------------
  // Strings
  // --------------------------------------------------------------------------
  NT.strings({
    en: {
      'ui.glint': 'Glint', 'ui.clock': 'Match time', 'ui.speed': 'Game speed', 'ui.sound': 'Sound on / off',
      'ui.langbtn': '中文', 'ui.langtip': 'Language', 'ui.menu': 'Menu', 'ui.paused': 'PAUSED',
      'ui.nosignal': 'NO SIGNAL', 'ui.nosignal.need': 'Build a {name} for the minimap', 'ui.nosignal.none': 'No minimap',
      'ui.ready': 'READY', 'ui.max': 'MAX', 'ui.hold': 'WAIT', 'ui.cancel1': 'Cancel one',
      'ui.powers': 'Support powers', 'ui.charging': '{s}s', 'ui.offline': 'offline',
      // tooltips
      'ui.tip.time': '{s}s', 'ui.tip.supply': '+{n} {power}', 'ui.tip.draw': '−{n} {power}',
      'ui.tip.requires': 'Requires', 'ui.tip.needprod': 'Needs a {name}', 'ui.tip.limit': 'Limit {n}', 'ui.tip.limitHit': 'Limit reached ({n})',
      'ui.tip.hp': 'HP', 'ui.tip.armor': 'Armour', 'ui.tip.speed': 'Speed', 'ui.tip.sight': 'Sight', 'ui.tip.cells': '{n} cells', 'ui.tip.cps': '{n} cells/s',
      'ui.tip.weapon': 'Weapon', 'ui.tip.dmg': '{d} dmg', 'ui.tip.burst': '{d}×{n} dmg', 'ui.tip.range': 'range {r}', 'ui.tip.reload': 'every {s}s',
      'ui.tip.splash': 'splash {r}', 'ui.tip.heals': 'heals {d} hp', 'ui.tip.minrange': 'min range {r}', 'ui.tip.needsBrace': 'braced only',
      'ui.tip.oneshot': 'single use', 'ui.tip.hits': 'Hits', 'ui.tip.ground': 'ground', 'ui.tip.air': 'air', 'ui.tip.strong': 'Strong vs', 'ui.tip.weak': 'Weak vs',
      'ui.tip.dps': '{n} dps', 'ui.tip.slows': 'slows', 'ui.tip.burns': 'burns',
      'ui.tip.mouse': 'Click: build · Shift: ×5 · Right-click: cancel', 'ui.tip.mouseReady': 'Click: place · Right-click: cancel (full refund)',
      'ui.tip.touch': 'Tap: build · Long-press: cancel', 'ui.tip.touchReady': 'Tap: place · Long-press: cancel',
      'ui.tip.power': 'Click when ready, then pick a target',
      'ui.armor.infantry': 'Infantry', 'ui.armor.light': 'Light', 'ui.armor.heavy': 'Heavy', 'ui.armor.building': 'Structure',
      'ui.mod.dmg': '{v} damage', 'ui.mod.taken': '{v} damage taken', 'ui.mod.speed': '{v} speed', 'ui.mod.rof': '{v} fire rate',
      'ui.mod.range': '{v} range', 'ui.mod.sight': '{v} sight', 'ui.mod.regen': 'heals {v}/s',
      'ui.who.allies': 'allies', 'ui.who.enemies': 'enemies', 'ui.who.self': 'itself',
      'ui.trait.producer': 'Produces: {q}', 'ui.trait.dropoff': 'Glint drop-off', 'ui.trait.dropoffFree': 'Glint drop-off · comes with a {unit}',
      'ui.trait.harvester': 'Gathers Glint ({n} per load)', 'ui.trait.radar': 'Gives the minimap while powered',
      'ui.trait.income': 'Pays {n} Glint every {s}s', 'ui.trait.recruit': 'A local joins you here every {s}s',
      'ui.trait.selfHeal': 'Regenerates {r}/s after {s}s out of combat', 'ui.trait.aura': 'Aura ({rad} cells, {who}): {mods}',
      'ui.trait.enrage': 'Below {p} health: {mods}', 'ui.trait.brace': 'Braces after {s}s standing still: {mods}',
      'ui.trait.surge': 'Surge for {d}s: {mods} — then {c}s comedown', 'ui.trait.leap': 'Leaps onto targets up to {r} cells away',
      'ui.trait.dash': 'Charges targets up to {r} cells away', 'ui.trait.deploy': 'Deploys into a {name}',
      'ui.trait.capturer': 'Captures turf in {s}s', 'ui.trait.capturerUsed': 'Captures turf in {s}s (used up)',
      'ui.trait.capturable': 'Can be captured', 'ui.trait.crusher': 'Runs over infantry',
      'ui.trait.explodeOnDeath': 'Explodes when destroyed ({d} dmg)', 'ui.trait.spawnOnDeath': 'Leaves {n}× {name} when destroyed',
      'ui.trait.bounty': 'Earns {p} of each victim\'s cost', 'ui.trait.lifesteal': 'Heals {p} of the damage it deals',
      'ui.tb.producer': 'Producer', 'ui.tb.dropoff': 'Drop-off', 'ui.tb.harvester': 'Harvester', 'ui.tb.radar': 'Radar', 'ui.tb.income': 'Income',
      'ui.tb.recruit': 'Recruits', 'ui.tb.selfHeal': 'Regen', 'ui.tb.aura': 'Aura', 'ui.tb.enrage': 'Enrage', 'ui.tb.brace': 'Brace',
      'ui.tb.surge': 'Surge', 'ui.tb.leap': 'Leap', 'ui.tb.deploy': 'Deploy', 'ui.tb.capturer': 'Captures', 'ui.tb.capturable': 'Capturable',
      'ui.tb.crusher': 'Crusher', 'ui.tb.explodeOnDeath': 'Volatile', 'ui.tb.spawnOnDeath': 'Spawns', 'ui.tb.bounty': 'Bounty', 'ui.tb.lifesteal': 'Lifesteal',
      // selection
      'ui.sel.n': '{n} selected', 'ui.rank1': 'Veteran', 'ui.rank2': 'Elite', 'ui.owner.neutral': 'Neutral', 'ui.owner.enemy': 'Enemy · {name}',
      'ui.owner.ally': 'Ally · {name}',
      'ui.st.braced': 'Braced', 'ui.st.surge': 'Surging', 'ui.st.crash': 'Comedown', 'ui.st.slow': 'Slowed', 'ui.st.buff': 'Boosted',
      'ui.st.unpowered': 'Unpowered', 'ui.st.repairing': 'Repairing', 'ui.st.captured': 'Being captured', 'ui.st.deployed': 'Deployed',
      'ui.st.primary': 'Primary', 'ui.st.hold': 'Holding', 'ui.st.passive': 'Passive', 'ui.st.cargo': 'Cargo {n}/{m}', 'ui.st.idle': 'Idle',
      'ui.act.stop': 'Stop', 'ui.act.amove': 'Attack-move', 'ui.act.hold': 'Hold', 'ui.act.deploy': 'Deploy', 'ui.act.surge': 'Surge',
      'ui.act.harvest': 'Harvest', 'ui.act.return': 'Return', 'ui.act.sell': 'Sell', 'ui.act.repair': 'Repair', 'ui.act.primary': 'Primary',
      'ui.act.deselect': 'Deselect', 'ui.act.capture': 'Capture',
      'ui.act.stop.tip': 'Stop all orders', 'ui.act.amove.tip': 'Move and fight anything on the way', 'ui.act.hold.tip': 'Toggle: hold position / engage freely',
      'ui.act.deploy.tip': 'Turn into a structure on the spot', 'ui.act.surge.tip': 'Trigger the surge now', 'ui.act.harvest.tip': 'Go gather Glint',
      'ui.act.return.tip': 'Deliver the load now', 'ui.act.sell.tip': 'Sell for {n} Glint', 'ui.act.repair.tip': 'Toggle repairs (costs Glint)',
      'ui.act.primary.tip': 'New units leave from here', 'ui.act.deselect.tip': 'Clear the selection',
      'ui.rally': 'Right-click the map: rally point', 'ui.rallyTouch': 'Tap the map: rally point',
      // toasts
      'ui.t.ready': '{name} ready — place it', 'ui.t.unit': '{name} ready', 'ui.t.units': '{name} ×{n} ready', 'ui.t.nofunds': 'Not enough Glint',
      'ui.t.lowpower': 'Low {power}: production slowed', 'ui.t.powerok': '{power} restored', 'ui.t.base': 'Base under attack',
      'ui.t.harv': 'Harvester under attack', 'ui.t.army': 'Units under attack', 'ui.t.captured': 'Turf claimed: {name}', 'ui.t.lost': 'Turf lost: {name}',
      'ui.t.blost': '{name} destroyed', 'ui.t.pready': '{name} ready', 'ui.t.strike': 'Incoming: {name}!', 'ui.t.super': 'Enemy {name} detected', 'ui.t.elim': '{name} eliminated',
      'ui.t.rank': 'A unit was promoted', 'ui.t.sold': 'Sold: +{n}', 'ui.t.paused': 'Paused — press P to resume',
      'ui.deny.place': 'Cannot build there', 'ui.deny.prereq': 'Requirements not met', 'ui.deny.limit': 'Limit reached', 'ui.deny.queue': 'Queue full',
      'ui.deny.producer': 'Nothing can build that yet', 'ui.deny.charge': 'Not charged yet', 'ui.deny.target': 'Invalid target', 'ui.deny.def': 'Not available',
      'ui.deny.funds': 'Not enough Glint',
      // modes
      'ui.m.place': 'Place {name} · Right-click or Esc to cancel', 'ui.m.placeTouch': 'Drag to position {name}',
      'ui.m.amove': 'Attack-move: click a destination · Esc to cancel', 'ui.m.amoveTouch': 'Attack-move: tap a destination',
      'ui.m.power': '{name}: choose a target · Esc to cancel', 'ui.m.powerTouch': '{name}: tap a target',
      'ui.m.target': 'Choose a target · Esc to cancel', 'ui.confirm': 'Place', 'ui.cancel': 'Cancel',
    },
    zh: {
      'ui.glint': '碎金', 'ui.clock': '对局时间', 'ui.speed': '游戏速度', 'ui.sound': '声音开关',
      'ui.langbtn': 'EN', 'ui.langtip': '语言', 'ui.menu': '菜单', 'ui.paused': '已暂停',
      'ui.nosignal': '无信号', 'ui.nosignal.need': '建造{name}以启用小地图', 'ui.nosignal.none': '无小地图',
      'ui.ready': '就绪', 'ui.max': '上限', 'ui.hold': '等待', 'ui.cancel1': '取消一个',
      'ui.powers': '支援技能', 'ui.charging': '{s}秒', 'ui.offline': '离线',
      'ui.tip.time': '{s}秒', 'ui.tip.supply': '+{n} {power}', 'ui.tip.draw': '−{n} {power}',
      'ui.tip.requires': '需要', 'ui.tip.needprod': '需要{name}', 'ui.tip.limit': '限造 {n}', 'ui.tip.limitHit': '已达上限（{n}）',
      'ui.tip.hp': '生命', 'ui.tip.armor': '护甲', 'ui.tip.speed': '速度', 'ui.tip.sight': '视野', 'ui.tip.cells': '{n} 格', 'ui.tip.cps': '{n} 格/秒',
      'ui.tip.weapon': '武器', 'ui.tip.dmg': '{d} 伤害', 'ui.tip.burst': '{d}×{n} 伤害', 'ui.tip.range': '射程 {r}', 'ui.tip.reload': '每 {s} 秒',
      'ui.tip.splash': '溅射 {r}', 'ui.tip.heals': '治疗 {d}', 'ui.tip.minrange': '最近 {r}', 'ui.tip.needsBrace': '仅站稳时',
      'ui.tip.oneshot': '一次性', 'ui.tip.hits': '目标', 'ui.tip.ground': '地面', 'ui.tip.air': '空中', 'ui.tip.strong': '克制', 'ui.tip.weak': '弱于',
      'ui.tip.dps': '每秒 {n}', 'ui.tip.slows': '减速', 'ui.tip.burns': '灼烧',
      'ui.tip.mouse': '左键：建造 · Shift：×5 · 右键：取消', 'ui.tip.mouseReady': '左键：放置 · 右键：取消（全额退款）',
      'ui.tip.touch': '轻点：建造 · 长按：取消', 'ui.tip.touchReady': '轻点：放置 · 长按：取消',
      'ui.tip.power': '就绪后点击，再选择目标',
      'ui.armor.infantry': '步兵', 'ui.armor.light': '轻甲', 'ui.armor.heavy': '重甲', 'ui.armor.building': '建筑',
      'ui.mod.dmg': '伤害 {v}', 'ui.mod.taken': '承伤 {v}', 'ui.mod.speed': '速度 {v}', 'ui.mod.rof': '射速 {v}',
      'ui.mod.range': '射程 {v}', 'ui.mod.sight': '视野 {v}', 'ui.mod.regen': '每秒回复 {v}',
      'ui.who.allies': '友军', 'ui.who.enemies': '敌军', 'ui.who.self': '自身',
      'ui.trait.producer': '生产：{q}', 'ui.trait.dropoff': '碎金卸货点', 'ui.trait.dropoffFree': '碎金卸货点 · 附赠一台{unit}',
      'ui.trait.harvester': '采集碎金（每趟 {n}）', 'ui.trait.radar': '通电时提供小地图',
      'ui.trait.income': '每 {s} 秒进账 {n} 碎金', 'ui.trait.recruit': '每 {s} 秒有一名街坊在此入伙',
      'ui.trait.selfHeal': '脱战 {s} 秒后每秒回复 {r}', 'ui.trait.aura': '光环（{rad} 格，{who}）：{mods}',
      'ui.trait.enrage': '生命低于 {p} 时：{mods}', 'ui.trait.brace': '静止 {s} 秒后站稳：{mods}',
      'ui.trait.surge': '爆发 {d} 秒：{mods}，随后虚脱 {c} 秒', 'ui.trait.leap': '可扑向 {r} 格内的目标',
      'ui.trait.dash': '可冲向 {r} 格内的目标', 'ui.trait.deploy': '可就地展开为{name}',
      'ui.trait.capturer': '{s} 秒占领地盘', 'ui.trait.capturerUsed': '{s} 秒占领地盘（占领后消耗）',
      'ui.trait.capturable': '可被占领', 'ui.trait.crusher': '可碾压步兵',
      'ui.trait.explodeOnDeath': '被毁时爆炸（{d} 伤害）', 'ui.trait.spawnOnDeath': '被毁时留下 {n} 个{name}',
      'ui.trait.bounty': '击杀可获得目标造价的 {p}', 'ui.trait.lifesteal': '回复造成伤害的 {p}',
      'ui.tb.producer': '生产', 'ui.tb.dropoff': '卸货', 'ui.tb.harvester': '采集', 'ui.tb.radar': '雷达', 'ui.tb.income': '收入',
      'ui.tb.recruit': '招募', 'ui.tb.selfHeal': '回复', 'ui.tb.aura': '光环', 'ui.tb.enrage': '狂暴', 'ui.tb.brace': '站稳',
      'ui.tb.surge': '爆发', 'ui.tb.leap': '飞扑', 'ui.tb.deploy': '展开', 'ui.tb.capturer': '占领', 'ui.tb.capturable': '可占领',
      'ui.tb.crusher': '碾压', 'ui.tb.explodeOnDeath': '易爆', 'ui.tb.spawnOnDeath': '遗留', 'ui.tb.bounty': '赏金', 'ui.tb.lifesteal': '吸血',
      'ui.sel.n': '已选 {n}', 'ui.rank1': '老兵', 'ui.rank2': '精英', 'ui.owner.neutral': '中立', 'ui.owner.enemy': '敌方 · {name}',
      'ui.owner.ally': '友方 · {name}',
      'ui.st.braced': '已站稳', 'ui.st.surge': '爆发中', 'ui.st.crash': '虚脱', 'ui.st.slow': '减速', 'ui.st.buff': '增益',
      'ui.st.unpowered': '断电', 'ui.st.repairing': '维修中', 'ui.st.captured': '正被占领', 'ui.st.deployed': '已展开',
      'ui.st.primary': '主建筑', 'ui.st.hold': '坚守', 'ui.st.passive': '消极', 'ui.st.cargo': '载货 {n}/{m}', 'ui.st.idle': '空闲',
      'ui.act.stop': '停止', 'ui.act.amove': '攻击移动', 'ui.act.hold': '坚守', 'ui.act.deploy': '展开', 'ui.act.surge': '爆发',
      'ui.act.harvest': '采集', 'ui.act.return': '返回', 'ui.act.sell': '出售', 'ui.act.repair': '维修', 'ui.act.primary': '设为主',
      'ui.act.deselect': '取消选择', 'ui.act.capture': '占领',
      'ui.act.stop.tip': '停止一切命令', 'ui.act.amove.tip': '移动并攻击沿途敌人', 'ui.act.hold.tip': '切换：原地坚守 / 自由交战',
      'ui.act.deploy.tip': '就地展开为建筑', 'ui.act.surge.tip': '立即爆发', 'ui.act.harvest.tip': '前去采集碎金',
      'ui.act.return.tip': '立即卸货', 'ui.act.sell.tip': '出售，得 {n} 碎金', 'ui.act.repair.tip': '切换维修（消耗碎金）',
      'ui.act.primary.tip': '新单位从这里出发', 'ui.act.deselect.tip': '清空选择',
      'ui.rally': '右键地图：设置集结点', 'ui.rallyTouch': '轻点地图：设置集结点',
      'ui.t.ready': '{name}已就绪，请放置', 'ui.t.unit': '{name}就绪', 'ui.t.units': '{name} ×{n} 就绪', 'ui.t.nofunds': '碎金不足',
      'ui.t.lowpower': '{power}不足：生产减速', 'ui.t.powerok': '{power}已恢复', 'ui.t.base': '基地遭到攻击',
      'ui.t.harv': '采集车遭到攻击', 'ui.t.army': '部队遭到攻击', 'ui.t.captured': '占领地盘：{name}', 'ui.t.lost': '失去地盘：{name}',
      'ui.t.blost': '{name}被摧毁', 'ui.t.pready': '{name}已就绪', 'ui.t.strike': '敌方{name}来袭！', 'ui.t.super': '发现敌方{name}', 'ui.t.elim': '{name}已被淘汰',
      'ui.t.rank': '有部队晋升了', 'ui.t.sold': '出售：+{n}', 'ui.t.paused': '已暂停：按 P 继续',
      'ui.deny.place': '无法在此建造', 'ui.deny.prereq': '前置条件不足', 'ui.deny.limit': '已达上限', 'ui.deny.queue': '队列已满',
      'ui.deny.producer': '还没有能生产它的建筑', 'ui.deny.charge': '尚未充能', 'ui.deny.target': '目标无效', 'ui.deny.def': '不可用',
      'ui.deny.funds': '碎金不足',
      'ui.m.place': '放置{name} · 右键或 Esc 取消', 'ui.m.placeTouch': '拖动以摆放{name}',
      'ui.m.amove': '攻击移动：点击目的地 · Esc 取消', 'ui.m.amoveTouch': '攻击移动：轻点目的地',
      'ui.m.power': '{name}：选择目标 · Esc 取消', 'ui.m.powerTouch': '{name}：轻点目标',
      'ui.m.target': '选择目标 · Esc 取消', 'ui.confirm': '放置', 'ui.cancel': '取消',
    },
  });

  // --------------------------------------------------------------------------
  // Init + skeleton
  // --------------------------------------------------------------------------
  UI.init = function (r) {
    root = r;
    root.classList.add('nt-hud', 'nt-off');
    // never let a HUD button keep focus: Space / Enter belong to input.js
    root.addEventListener('mousedown', function (e) {
      const t = e.target, tag = t && t.tagName;
      if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA' && !(t.closest && t.closest('a'))) e.preventDefault();
    });
    root.addEventListener('contextmenu', function (e) { if (e.target !== root) e.preventDefault(); });
    // touch tips stay up after the finger lifts (a touch release fires pointerleave): the next tap elsewhere hides them
    window.addEventListener('pointerdown', function (e) { if (e.pointerType !== 'mouse' && H.tip._c_on && !(tipRec && e.target.closest && e.target.closest('.nt-b') === tipRec.btn)) hideTip(); }, true);
    buildTop(); buildSide(); buildSel(); buildMisc();
    if (UI._buildOverlay) UI._buildOverlay();
    NT.on('game:start', onStart);
    NT.on('game:stop', function () { built = null; root.classList.add('nt-off'); hideTip(); clearToasts(); });
    NT.on('game:over', function () { overT = 1.6; tog(H.hint, 'on', false); });
    NT.on('game:pause', function () { tog(H.paused, 'on', G().paused && !G().modal && G().state === 'playing'); });
    NT.on('game:speed', syncSys);
    NT.on('ui:select', function () { selDirty = true; if (built) built.selHide = false; });
    NT.on('ui:mode', syncMode);
    NT.on('settings', syncSys);
    NT.on('lang', relabel);
    NT.on('resize', layout);
    NT.on('sim', onSim);
    NT.on('ui:error', function (key) { UI.toast(key, null, { kind: 'warn', group: 'err', every: 700 }); });
    layout();
  };

  function buildTop() {
    const top = H.top = el('div', 'nt-top', root);
    const res = H.res = el('div', 'nt-res nt-glass', top);
    const g = H.glint = el('div', 'nt-meter nt-glint', res);
    g.innerHTML = ICON.glint;
    H.glintV = el('span', 'nt-val', g); H.glintL = el('span', 'nt-lbl', g);
    g._shown = -1;
    const p = H.pow = el('div', 'nt-meter nt-pow', res);
    p.innerHTML = ICON.bolt;
    H.powL = el('span', 'nt-lbl', p);
    const bar = el('span', 'nt-pbar', p); H.powFill = el('i', '', bar);
    H.powV = el('span', 'nt-val nt-small', p);
    const c = H.clock = el('div', 'nt-meter nt-clock', res);
    c.innerHTML = ICON.clock;
    H.clockV = el('span', 'nt-val nt-small', c);
    const sys = H.sys = el('div', 'nt-sys nt-glass', top);
    H.bSpeed = btn('nt-sb nt-speed', sys); H.bSpeed.innerHTML = ICON.ff; H.bSpeedV = el('span', '', H.bSpeed);
    H.bSnd = btn('nt-sb', sys);
    H.bLang = btn('nt-sb nt-lang', sys);
    H.bMenu = btn('nt-sb', sys); H.bMenu.innerHTML = ICON.menu;
    H.bSpeed.addEventListener('click', function () {
      const s = G().speed, i = SPEEDS.indexOf(s), n = SPEEDS[(i + 1) % SPEEDS.length];
      G().setSpeed(n); G().saveSettings({ speed: n });
    });
    H.bSnd.addEventListener('click', function () { G().saveSettings({ mute: !G().settings.mute }); });
    H.bLang.addEventListener('click', toggleLang);
    H.bMenu.addEventListener('click', function () { UI.openPause(); });
  }
  function toggleLang() { const l = NT.lang === 'zh' ? 'en' : 'zh'; NT.setLang(l); G().saveSettings({ lang: l }); }
  UI._toggleLang = toggleLang;

  function buildSide() {
    const s = H.side = el('div', 'nt-side nt-glass', root);
    const mm = H.mm = el('div', 'nt-mm', s);
    H.mmc = el('canvas', 'nt-mmc', mm);
    H.mmNo = el('div', 'nt-nosig', mm);
    H.mmNoT = el('b', '', H.mmNo); H.mmNoS = el('span', '', H.mmNo);
    H.mmFrame = el('div', 'nt-mmframe', mm);
    H.powers = el('div', 'nt-powers', s);
    H.tabs = el('div', 'nt-tabs', s);
    H.grid = el('div', 'nt-grid', s);
    H.sheetSel = el('div', 'nt-sheetsel', s);         // compact: the selection panel lives here
    H.collapse = btn('nt-collapse', s); H.collapse.textContent = '▾';
    H.collapse.addEventListener('click', function () { fold(!H.side._c_folded); });
    minimapInput();
  }

  function buildSel() {
    const p = H.sel = el('div', 'nt-sel nt-glass', root);
    H.selBody = el('div', 'nt-selbody', p);
    // single
    const one = H.one = el('div', 'nt-one', H.selBody);
    H.onePic = el('canvas', 'nt-pic', one);
    const info = el('div', 'nt-oneinfo', one);
    const head = el('div', 'nt-onehead', info);
    H.oneName = el('b', 'nt-onename', head); H.oneRank = el('span', 'nt-rank', head); H.oneOwner = el('span', 'nt-owner', head);
    const hp = el('div', 'nt-hp', info); H.oneHp = el('i', '', hp); H.oneHpT = el('span', '', hp);
    H.oneCargo = el('div', 'nt-cargo', info); H.oneCargoF = el('i', '', H.oneCargo);
    H.oneStats = el('div', 'nt-stats', info);
    H.oneChips = el('div', 'nt-chips', info);
    // many
    H.many = el('div', 'nt-many', H.selBody);
    H.manyHead = el('div', 'nt-manyhead', H.many);
    H.manyGrid = el('div', 'nt-manygrid', H.many);
    H.acts = el('div', 'nt-acts', p);
    H.selHint = el('div', 'nt-selhint', p);
  }

  function buildMisc() {
    H.toasts = el('div', 'nt-toasts', root);
    H.hint = el('div', 'nt-hint nt-glass', root);
    H.banner = el('div', 'nt-banner', root);
    H.bannerT = el('div', 'nt-bannert nt-glass', H.banner);
    H.confirm = el('div', 'nt-confirm', H.banner);
    H.bOk = btn('nt-cbtn nt-ok', H.confirm); H.bNo = btn('nt-cbtn nt-no', H.confirm);
    H.bOk.addEventListener('click', function () { if (NT.Input && NT.Input.confirmPlace) NT.Input.confirmPlace(); });
    H.bNo.addEventListener('click', cancelMode);
    H.paused = el('div', 'nt-paused', root);
    H.tip = el('div', 'nt-tip nt-glass', root);
    H.rotate = el('div', 'nt-rotate', root);
  }
  function fold(on) { tog(H.side, 'folded', on); tog(root, 'nt-folded', on); }
  function cancelMode() { if (NT.Input && NT.Input.cancelMode) NT.Input.cancelMode(); else G().setMode(null); }

  // --------------------------------------------------------------------------
  // Layout: desktop vs compact (coarse pointer or narrow)
  // --------------------------------------------------------------------------
  function layout() {
    if (!root) return;
    const w = window.innerWidth, h = window.innerHeight;
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    const c = coarse || w < 900 || h < 480;
    if (c !== UI.compact || !H._laid) {
      UI.compact = c; H._laid = true;
      tog(root, 'nt-compact', c);
      // the minimap goes to a corner, the selection panel into the sheet
      if (c) { root.appendChild(H.mm); root.appendChild(H.powers); H.sheetSel.appendChild(H.sel); }
      else { H.side.insertBefore(H.mm, H.tabs); H.side.insertBefore(H.powers, H.tabs); root.appendChild(H.sel); tog(H.mm, 'big', false); }
      if (built) setTab(tab);
      relabelModes();
    }
    tog(root, 'nt-portrait', c && h > w * 1.1);
    sizeMinimap();
    selDirty = true;
  }
  function sizeMinimap() {
    const c = H.mmc, r = c.getBoundingClientRect(), d = dpr();
    c._w = Math.round(r.width); c._h = Math.round(r.height);
    const W = Math.max(1, Math.round(r.width * d)), Hh = Math.max(1, Math.round(r.height * d));
    if (c.width !== W) c.width = W;
    if (c.height !== Hh) c.height = Hh;
    mmAcc = 1;
  }

  // --------------------------------------------------------------------------
  // Match start: per-match HUD (team colour, tabs, build buttons, powers)
  // --------------------------------------------------------------------------
  function onStart(world) {
    const g = G(), p = g.player();
    g.modal = false;
    if (UI._closeAll) UI._closeAll();
    root.classList.remove('nt-off');
    tog(root, 'nt-spec', !p);
    const team = p ? p.color : '#c9d3e8';
    css(root, '--acc', team); css(root, '--acc-a', rgba(team, 0.5)); css(root, '--acc-b', rgba(team, 0.16)); css(root, '--acc-c', rgba(team, 0.08));
    clearToasts(); hideTip();
    for (const k in lastBy) delete lastBy[k];
    for (const k in prodAgg) delete prodAgg[k];
    H.glint._shown = -1;
    H.tabs.textContent = ''; H.grid.textContent = ''; H.powers.textContent = '';
    built = { world: world, p: p, team: team, recs: {}, tabs: {}, pows: {}, prod: {}, prodN: 0 };
    overT = -1; selSig = ''; actSig = ''; selDirty = true;
    H.selTab = btn('nt-tab nt-seltab', H.tabs);
    H.selTab._n = el('span', 'nt-tabn', H.selTab);
    H.selTab.addEventListener('click', function () { built.selHide = false; built.selTab = true; setTab(tab); fold(false); });
    if (p) {
      const f = p.faction;
      for (let i = 0; i < f.queues.length; i++) {
        const q = f.queues[i], t = btn('nt-tab', H.tabs);
        t._n = el('span', 'nt-tabn', t); t._b = el('span', 'nt-tabb', t); t._bar = el('i', 'nt-tabbar', t);
        const grid = el('div', 'nt-qgrid', H.grid);
        built.tabs[q.id] = { btn: t, grid: grid, q: q };
        t.addEventListener('click', function () { built.selHide = true; built.selTab = false; setTab(q.id); if (UI.compact) fold(false); });
      }
      NT.Prod.options(world, p, rows);
      for (let i = 0; i < rows.length; i++) makeBuild(rows[i].def, team);
      if (!built.tabs[tab]) tab = f.queues.length ? f.queues[0].id : null;
    }
    setTab(tab);
    relabel();
    layout();
    if (UI._hintsStart) UI._hintsStart(world);
    refresh(true);
  }

  function setTab(id) {
    if (!built) return;
    tab = id;
    for (const k in built.tabs) { const t = built.tabs[k]; tog(t.btn, 'on', k === id && !(UI.compact && built.selTab)); tog(t.grid, 'on', k === id); }
    tog(H.side, 'selmode', !!(UI.compact && built.selTab));
    if (H.selTab) tog(H.selTab, 'on', !!(UI.compact && built.selTab));
    hideTip();
  }

  // --------------------------------------------------------------------------
  // Build buttons
  // --------------------------------------------------------------------------
  function makeBuild(def, team) {
    const t = built.tabs[def.queue];
    if (!t) return;
    const b = btn('nt-b', t.grid);
    const rec = { def: def, btn: b, sig: '', lp: false, lpT: 0 };
    rec.icon = iconCanvas('nt-bi', b, def, team, 56);
    rec.sweep = el('span', 'nt-bsweep', b);
    rec.pct = el('span', 'nt-bpct', b);
    rec.count = el('span', 'nt-bcount', b);
    rec.state = el('span', 'nt-bstate', b);
    rec.lock = el('span', 'nt-block', b); rec.lock.innerHTML = ICON.lock;
    rec.name = el('span', 'nt-bname', b);
    rec.cost = el('span', 'nt-bcost', b);
    rec.x = el('span', 'nt-bx', b); rec.x.innerHTML = ICON.x;
    built.recs[def.id] = rec;
    b.addEventListener('click', function (e) {
      if (rec.lp) { rec.lp = false; return; }
      if (e.target.closest('.nt-bx')) { cancelBuild(rec); return; }
      clickBuild(rec, e.shiftKey ? 5 : 1);
    });
    b.addEventListener('contextmenu', function (e) { e.preventDefault(); cancelBuild(rec); });
    b.addEventListener('pointerdown', function (e) {
      rec.lp = false;
      if (e.pointerType === 'mouse') return;
      clearTimeout(rec.lpT);
      rec.lpT = setTimeout(function () {
        rec.lp = true;
        if (rec.row && (rec.row.count || rec.row.ready)) cancelBuild(rec); else showTip(rec);
      }, 420);
    });
    const end = function () { clearTimeout(rec.lpT); };
    b.addEventListener('pointerup', end); b.addEventListener('pointercancel', end); b.addEventListener('pointerleave', end);
    b.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') showTip(rec); });
    b.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hideTip(); });
  }

  function clickBuild(rec, n) {
    const g = G(), p = g.player(), r = rec.row;
    if (!p || !r) return;
    if (r.ready || p.queues[rec.def.queue].ready === rec.def) {          // rec.row may be up to 100 ms stale
      if (g.mode.type === 'place' && g.mode.def === rec.def) cancelMode();
      else g.setMode({ type: 'place', def: rec.def });
      return;
    }
    if (!r.ok) { UI.toast('ui.deny.' + r.reason, null, { kind: 'warn', group: 'deny', every: 600 }); if (UI.compact) showTip(rec); return; }
    for (let i = 0; i < n; i++) g.cmd({ type: 'produce', def: rec.def.id });
  }
  function cancelBuild(rec) {
    const g = G();
    if (g.mode.type === 'place' && g.mode.def === rec.def) cancelMode();
    if (rec.row && (rec.row.count || rec.row.ready)) g.cmd({ type: 'cancel', def: rec.def.id });
  }

  // 10 Hz: patch the state of every build button (classes / text only when they change).
  function refreshGrid(world, p) {
    NT.Prod.options(world, p, rows);
    const agg = {};
    for (const k in built.tabs) agg[k] = { n: 0, ready: false, prog: -1 };
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], rec = built.recs[r.def.id];
      if (!rec) continue;
      rec.row = r;
      const q = p.queues[r.queue], head = q.items[0], d = r.def;
      const producing = !!(head && head.def === d), held = producing && !!q.ready;
      const left = producing ? d.cost - head.paid : d.cost;
      const locked = !r.ok && (r.reason === 'prereq' || r.reason === 'producer') && !r.count && !r.ready;
      const max = r.cap && !r.ready && !r.count;
      const poor = !r.ready && p.credits < left - 0.5 && !locked && !max;
      const prog = producing ? Math.floor(r.progress * 100) : -1;
      const sig = (r.ready ? 1 : 0) + '|' + (producing ? 1 : 0) + '|' + (held ? 1 : 0) + '|' + r.count + '|' + (locked ? 1 : 0) + '|' + (max ? 1 : 0) + '|' + (poor ? 1 : 0) + '|' + prog;
      const a = agg[r.queue];
      if (a) { a.n += r.count; if (r.ready) a.ready = true; if (producing && !held) a.prog = r.progress; }
      if (sig === rec.sig) continue;
      rec.sig = sig;
      const b = rec.btn;
      tog(b, 'ready', r.ready); tog(b, 'prod', producing && !held); tog(b, 'held', held || (!producing && r.count > 0));
      tog(b, 'locked', locked); tog(b, 'max', max); tog(b, 'poor', poor); tog(b, 'queued', r.count > 0 || r.ready);
      css(rec.sweep, '--p', producing ? r.progress.toFixed(3) : '0');
      txt(rec.pct, producing && !held ? prog + '%' : '');
      txt(rec.count, r.count > 1 || (r.count === 1 && !producing) ? String(r.count) : '');
      txt(rec.state, r.ready ? T('ui.ready') : max ? T('ui.max') : held ? T('ui.hold') : '');
      if (rec === tipRec) showTip(rec);
    }
    for (const k in built.tabs) {
      const t = built.tabs[k], a = agg[k];
      tog(t.btn, 'ready', a.ready); tog(t.btn, 'busy', a.prog >= 0);
      txt(t.btn._b, a.ready ? '!' : a.n ? String(a.n) : '');
      css(t.btn._bar, '--p', a.prog >= 0 ? a.prog.toFixed(3) : '0');
    }
  }

  // --------------------------------------------------------------------------
  // Tooltip
  // --------------------------------------------------------------------------
  function line(parent, cls, text) { return el('div', cls, parent, text); }
  function modsText(m) {
    const out = [];
    if (!m) return '';
    for (const k of ['dmg', 'taken', 'speed', 'rof', 'range', 'sight']) if (typeof m[k] === 'number' && m[k] !== 1) out.push(T('ui.mod.' + k, { v: signed(m[k]) }));
    if (m.regen) out.push(T('ui.mod.regen', { v: pct(m.regen) }));
    return out.join(NT.lang === 'zh' ? '，' : ', ');
  }
  function nameOf(id) { const d = NT.DEFS[id]; return d ? NT.tr(d.name) : id; }
  function traitLine(name, t, def) {
    const k = 'ui.trait.' + name, f = NT.FACTIONS[def.faction];
    switch (name) {
      case 'producer': return T(k, { q: t.queues.map(function (q) { return f && f.queueById[q] ? NT.tr(f.queueById[q].name) : q; }).join(' · ') });
      case 'dropoff': return t.freeUnit ? T('ui.trait.dropoffFree', { unit: nameOf(t.freeUnit) }) : T(k);
      case 'harvester': return T(k, { n: t.capacity });
      case 'income': return T(k, { n: t.amount, s: sec(t.every) });
      case 'recruit': return T(k, { s: sec(t.every) });
      case 'selfHeal': return T(k, { r: pct(t.rate), s: sec(t.delay) });
      case 'aura': return T(k, { rad: t.radius, who: T(t.self && t.affects === 'allies' ? 'ui.who.allies' : 'ui.who.' + t.affects), mods: modsText(t.mods) });
      case 'enrage': return T(k, { p: pct(t.below), mods: modsText(t.mods) });
      case 'brace': return T(k, { s: sec(t.delay), mods: modsText(t.mods) });
      case 'surge': return T(k, { d: sec(t.dur), mods: modsText(t.mods), c: sec(t.crash) });
      case 'leap': return T(t.style === 'dash' ? 'ui.trait.dash' : k, { r: t.range });
      case 'deploy': return T(k, { name: nameOf(t.into) });
      case 'capturer': return T(t.consumed ? 'ui.trait.capturerUsed' : k, { s: sec(t.time) });
      case 'explodeOnDeath': return T(k, { d: t.dmg });
      case 'spawnOnDeath': return T(k, { n: t.count, name: nameOf(t.def) });
      case 'bounty': case 'lifesteal': return T(k, { p: pct(t.frac) });
      default: return NT.STR.en[k] ? T(k) : name;
    }
  }
  function weaponLines(parent, def) {
    for (let i = 0; i < def.weapons.length; i++) {
      const w = def.weapons[i], box = el('div', 'nt-tw', parent);
      const head = el('div', 'nt-twh', box);
      el('b', '', head, w.name ? NT.tr(w.name) : T('ui.tip.weapon') + (def.weapons.length > 1 ? ' ' + (i + 1) : ''));
      const bits = [];
      if (w.heal) bits.push(T('ui.tip.heals', { d: w.dmg }));
      else bits.push(w.burst > 1 ? T('ui.tip.burst', { d: w.dmg, n: w.burst }) : T('ui.tip.dmg', { d: w.dmg }));
      bits.push(T('ui.tip.range', { r: w.range }));
      if (w.minRangePx) bits.push(T('ui.tip.minrange', { r: w.minRangePx / NT.TILE }));
      bits.push(T('ui.tip.reload', { s: sec(w.cooldown) }));
      if (w.splash) bits.push(T('ui.tip.splash', { r: w.splash }));
      if (w.onHit && w.onHit.slow) bits.push(T('ui.tip.slows'));
      if (w.onHit && w.onHit.burn) bits.push(T('ui.tip.burns'));
      if (w.needsBrace) bits.push(T('ui.tip.needsBrace'));
      if (w.consume) bits.push(T('ui.tip.oneshot'));
      el('span', 'nt-dim', head, bits.join(' · '));
      if (w.heal) continue;
      const hits = [];
      if (w.ground) hits.push(T('ui.tip.ground'));
      if (w.air) hits.push(T('ui.tip.air'));
      const strong = [], weak = [], row = NT.WARHEADS[w.warhead] || {};
      for (let a = 0; a < NT.ARMORS.length; a++) {
        const ar = NT.ARMORS[a], m = (row[ar] || 0) * (w.vs && w.vs[ar] !== undefined ? w.vs[ar] : 1);
        if (m >= 1) strong.push(T('ui.armor.' + ar)); else if (m <= 0.5) weak.push(T('ui.armor.' + ar));
      }
      const r2 = el('div', 'nt-twr', box);
      el('span', '', r2, T('ui.tip.hits') + ': ' + hits.join(' + '));
      if (strong.length) el('span', 'nt-good', r2, T('ui.tip.strong') + ': ' + strong.join(' · '));
      if (weak.length) el('span', 'nt-bad', r2, T('ui.tip.weak') + ': ' + weak.join(' · '));
    }
  }
  // The static part of a def's tooltip (name, numbers, desc, weapons, traits) for the current language.
  function tipBody(def, team) {
    const box = document.createElement('div'), f = NT.FACTIONS[def.faction];
    const head = el('div', 'nt-th', box);
    iconCanvas('nt-thi', head, def, team, 40);
    const hc = el('div', 'nt-thc', head);
    el('b', 'nt-tn', hc, NT.tr(def.name));
    const meta = el('div', 'nt-tm', hc);
    if (def.cost) { const c = el('span', 'nt-tcost', meta); c.innerHTML = ICON.glint; el('span', '', c, fmt(def.cost)); }
    if (def.queue) { const c = el('span', '', meta); c.innerHTML = ICON.clock; el('span', '', c, T('ui.tip.time', { s: sec(def.buildTime) })); }
    if (def.kind === 'building' && def.power) {
      const c = el('span', def.power > 0 ? 'nt-good' : 'nt-warn', meta); c.innerHTML = ICON.bolt;
      el('span', '', c, T(def.power > 0 ? 'ui.tip.supply' : 'ui.tip.draw', { n: Math.abs(def.power), power: f ? NT.tr(f.powerName) : '' }));
    }
    if (def.limit) el('span', 'nt-dim', meta, T('ui.tip.limit', { n: def.limit }));
    const st = el('div', 'nt-tstats', box);
    const stat = function (k, v) { const s = el('span', '', st); el('i', '', s, T(k)); el('b', '', s, v); };
    stat('ui.tip.hp', fmt(def.hp));
    stat('ui.tip.armor', T('ui.armor.' + def.armor));
    if (def.move) stat('ui.tip.speed', T('ui.tip.cps', { n: def.move.speed }));
    stat('ui.tip.sight', T('ui.tip.cells', { n: def.sight }));
    if (NT.tr(def.desc)) el('p', 'nt-td', box, NT.tr(def.desc));
    if (def.weapons.length) weaponLines(box, def);
    const tl = Object.keys(def.traits);
    if (tl.length) { const ul = el('ul', 'nt-tt', box); for (const n of tl) el('li', '', ul, traitLine(n, def.traits[n], def)); }
    box._req = el('div', 'nt-treq', box);
    box._hint = el('div', 'nt-thint', box);
    return box;
  }
  function showTip(rec) {
    const g = G(), p = g.player();
    if (!p || !built) return;
    tipRec = rec;
    const key = NT.lang + '|' + rec.def.id;
    if (H.tip._key !== key) { H.tip._key = key; H.tip.textContent = ''; H.tip._body = tipBody(rec.def, built.team); H.tip.appendChild(H.tip._body); }
    const body = H.tip._body, r = rec.row, req = body._req;
    req.textContent = '';
    if (r && r.reason === 'producer') line(req, 'nt-bad', T('ui.tip.needprod', { name: producersOf(p.faction, rec.def.queue).map(function (d) { return NT.tr(d.name); }).join(' / ') }));
    if (rec.def.requires.length) {
      const l = line(req, 'nt-reqs');
      el('span', 'nt-dim', l, T('ui.tip.requires') + ': ');
      for (const id of rec.def.requires) el('span', p.owned[id] > 0 ? 'nt-good' : 'nt-bad', l, nameOf(id));
    }
    if (r && r.cap) line(req, 'nt-warn', T('ui.tip.limitHit', { n: rec.def.limit }));
    txt(body._hint, T(UI.compact ? (r && r.ready ? 'ui.tip.touchReady' : 'ui.tip.touch') : (r && r.ready ? 'ui.tip.mouseReady' : 'ui.tip.mouse')));
    tog(H.tip, 'on', true);
    placeTip(rec.btn);
  }
  function placeTip(anchor) {
    const a = anchor.getBoundingClientRect(), t = H.tip, W = window.innerWidth, Hh = window.innerHeight;
    const tw = t.offsetWidth, th = t.offsetHeight;
    let x, y;
    if (UI.compact) { x = NT.clamp(a.left + a.width / 2 - tw / 2, 6, W - tw - 6); y = Math.max(6, a.top - th - 8); }
    else { const s = H.side.getBoundingClientRect(); x = s.left - tw - 10; y = NT.clamp(a.top - 10, 50, Hh - th - 10); }
    t.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }
  function hideTip() { tipRec = null; if (H.tip) tog(H.tip, 'on', false); }
  UI._placeTip = placeTip;

  // --------------------------------------------------------------------------
  // Support powers (feature-tested: NT.Powers.state may not exist yet)
  // --------------------------------------------------------------------------
  function refreshPowers(world, p) {
    const list = NT.Powers && NT.Powers.state ? NT.Powers.state(world, p) : null;
    let any = false;
    const seen = {};
    for (let i = 0; list && i < list.length; i++) {
      const s = list[i], pd = powerDef(s.power);
      if (!pd || (!s.available && !s.ready && !(s.charge > 0))) continue;
      any = true; seen[pd.id] = true;
      let rec = built.pows[pd.id];
      if (!rec) rec = makePower(pd);
      rec.st = s;
      const k = s.cooldownT ? Math.min(1, s.charge / s.cooldownT) : 0;
      const left = s.ready ? '' : s.available ? T('ui.charging', { s: Math.ceil((s.cooldownT - s.charge) / NT.TPS) }) : T('ui.offline');
      tog(rec.btn, 'ready', !!s.ready); tog(rec.btn, 'off', !s.available && !s.ready);
      tog(rec.btn, 'on', G().mode.type === 'target' && G().mode.what === 'power' && powerDef(G().mode.power) === pd);
      css(rec.btn, '--p', k.toFixed(3));
      txt(rec.t, s.ready ? T('ui.ready') : left);
    }
    for (const id in built.pows) tog(built.pows[id].btn, 'gone', !seen[id]);
    tog(H.powers, 'on', any);
  }
  function makePower(pd) {
    const b = btn('nt-pw', H.powers), rec = { pd: pd, btn: b, st: null };
    const ring = el('span', 'nt-pwring', b);
    iconCanvas('nt-pwi', ring, NT.DEFS[pd.building], built.team, 34);
    const c = el('span', 'nt-pwc', b);
    rec.n = el('b', '', c); rec.t = el('span', '', c);
    txt(rec.n, NT.tr(pd.name));
    b.addEventListener('click', function () {
      const g = G();
      if (!rec.st || !rec.st.ready) { UI.toast('ui.deny.charge', null, { kind: 'warn', group: 'deny', every: 600 }); return; }
      if (g.mode.type === 'target' && g.mode.what === 'power' && powerDef(g.mode.power) === pd) cancelMode();
      else g.setMode({ type: 'target', what: 'power', power: pd });
    });
    b.addEventListener('pointerenter', function (e) { if (e.pointerType === 'mouse') powerTip(rec); });
    b.addEventListener('pointerleave', hideTip);
    built.pows[pd.id] = rec;
    return rec;
  }
  function powerTip(rec) {
    const pd = rec.pd, t = H.tip;
    tipRec = null; t._key = ''; t.textContent = '';
    const head = el('div', 'nt-th', t);
    iconCanvas('nt-thi', head, NT.DEFS[pd.building], built.team, 40);
    const hc = el('div', 'nt-thc', head);
    el('b', 'nt-tn', hc, NT.tr(pd.name));
    const m = el('div', 'nt-tm', hc); const c = el('span', '', m); c.innerHTML = ICON.clock; el('span', '', c, T('ui.tip.time', { s: sec(pd.cooldown) }));
    el('p', 'nt-td', t, NT.tr(pd.desc));
    const l = el('div', 'nt-treq', t); el('span', 'nt-dim', l, T('ui.tip.requires') + ': '); el('span', '', l, nameOf(pd.building));
    el('div', 'nt-thint', t, T('ui.tip.power'));
    tog(t, 'on', true);
    placeTip(rec.btn);
  }

  // --------------------------------------------------------------------------
  // Minimap
  // --------------------------------------------------------------------------
  let noise = null;
  function drawNoise(ctx, w, h) {
    if (!noise) {
      noise = el('canvas'); noise.width = 96; noise.height = 96;
      const x = noise.getContext('2d'), img = x.createImageData(96, 96);
      for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 120 | 0; img.data[i] = v * 0.7; img.data[i + 1] = v * 0.85; img.data[i + 2] = v; img.data[i + 3] = 255; }
      x.putImageData(img, 0, 0);
    }
    ctx.save();
    ctx.globalAlpha = 0.92; ctx.imageSmoothingEnabled = false;
    const ox = Math.random() * 48 | 0, oy = Math.random() * 48 | 0;
    ctx.drawImage(noise, ox, oy, 48, 48, 0, 0, w, h);
    ctx.globalAlpha = 0.18; ctx.fillStyle = '#000';
    for (let y = (G().now * 40) % 4; y < h; y += 4) ctx.fillRect(0, y, w, 1.5);
    ctx.restore();
  }
  function drawMinimap() {
    const c = H.mmc, w = c._w, h = c._h, g = G();
    if (!w || !h || !g.world) return;
    const ctx = c.getContext('2d'), d = c.width / w;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const p = g.player(), dark = !!p && !p.radar;
    if (!dark && NT.Render && NT.Render.drawMinimap) NT.Render.drawMinimap(ctx, w, h);
    if (dark) drawNoise(ctx, w, h);
    if (dark !== H.mm._dark) { H.mm._dark = dark; tog(H.mm, 'dark', dark); relabelMini(); }
  }
  function relabelMini() {
    const p = G().player();
    txt(H.mmNoT, T('ui.nosignal'));
    const radar = p && p.faction.defs.find(function (d) { return d.traits.radar && d.queue; });
    txt(H.mmNoS, radar ? T('ui.nosignal.need', { name: radar.name }) : T('ui.nosignal.none'));
  }
  function minimapInput() {
    const c = H.mmc;
    let drag = false;
    const at = function (e) {
      const r = c.getBoundingClientRect();
      return NT.Render && NT.Render.minimapToWorld ? NT.Render.minimapToWorld(e.clientX - r.left, e.clientY - r.top, r.width, r.height) : null;
    };
    c.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      const g = G();
      if (!g.world) return;
      if (UI.compact && !H.mm._c_big) { tog(H.mm, 'big', true); sizeMinimap(); return; }
      if (e.button === 2) {
        const pt = at(e);
        if (pt && NT.Input && NT.Input.smartOrder) NT.Input.smartOrder(pt[0], pt[1], { shift: e.shiftKey, minimap: true });
        return;
      }
      if (e.button !== 0) return;
      drag = true;
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
      const pt = at(e); if (pt) g.focus(pt[0], pt[1]);
      mmAcc = 1;
    });
    c.addEventListener('pointermove', function (e) {
      if (!drag) return;
      const pt = at(e); if (pt) G().focus(pt[0], pt[1]);
      mmAcc = 1;
    });
    const up = function () {
      if (!drag) return;
      drag = false;
      if (UI.compact && H.mm._c_big) { tog(H.mm, 'big', false); setTimeout(sizeMinimap, 0); }
    };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  // --------------------------------------------------------------------------
  // Selection panel
  // --------------------------------------------------------------------------
  function stateChips(e) {
    const out = [], g = G(), t = g.world.tick;
    if (e.braced) out.push(['braced', 'good']);
    for (let i = 0; i < e.buffs.length; i++) {
      const b = e.buffs[i];
      if (b.from && t < b.from) continue;
      if (b.id === 'surge') out.push(['surge', 'acc']); else if (b.id === 'crash') out.push(['crash', 'warn']);
      else if (b.id === 'slow') out.push(['slow', 'bad']); else if (out.indexOf('buff') < 0) out.push(['buff', 'acc']);
    }
    if (e.kind === 'building') {
      if (e.def.needsPower && !e.powered) out.push(['unpowered', 'bad']);
      if (e.repairing) out.push(['repairing', 'good']);
      if (e.captureT > 0) out.push(['captured', 'bad']);
      if (e.primary) out.push(['primary', 'acc']);
    } else {
      if (e.deployed) out.push(['deployed', 'acc']);
      if (e.stance === 'hold') out.push(['hold', '']); else if (e.stance === 'passive' && armed(e.def)) out.push(['passive', '']);
    }
    const seen = {};
    return out.filter(function (c) { if (seen[c[0]]) return false; seen[c[0]] = 1; return true; });
  }
  function ownerLabel(e) {
    const g = G(), w = g.world;
    if (e.owner === g.me) return '';
    const p = w.players[e.owner];
    if (!p) return T('ui.owner.neutral');
    if (g.me < 0) return NT.tr(p.faction.name);
    return T(NT.isAlly(w, g.me, e.owner) ? 'ui.owner.ally' : 'ui.owner.enemy', { name: p.faction.name });
  }

  function refreshSel() {
    const g = G(), ents = g.selected(selEnts);
    const vis = ents.length > 0 && g.state !== 'menu';
    tog(H.sel, 'on', vis);
    if (built) {
      const want = UI.compact && vis && !built.selHide;
      if (want !== !!built.selTab) { built.selTab = want; setTab(tab); }
      if (H.selTab) { tog(H.selTab, 'vis', UI.compact && vis); txt(H.selTab._n, T('ui.sel.n', { n: ents.length })); }
    }
    if (!vis) { selSig = ''; actSig = ''; return; }
    const single = ents.length === 1 || ents.every(function (e) { return e === ents[0]; });
    let sig = single ? 'one:' + ents[0].id + ':' + ents[0].owner + ':' + NT.lang : 'many:' + NT.lang;
    if (!single) for (let i = 0; i < ents.length; i++) sig += ',' + ents[i].def.id + ents[i].owner;
    tog(H.one, 'on', single); tog(H.many, 'on', !single);
    if (sig !== selSig) { selSig = sig; if (single) buildOne(ents[0]); else buildMany(ents); }
    if (single) updateOne(ents[0]); else updateMany(ents);
    refreshActs(ents);
  }
  function buildOne(e) {
    blit(H.onePic, e.def, colorOf(e.owner), UI.compact ? 44 : 68);
    txt(H.oneName, NT.tr(e.def.name));
    txt(H.oneOwner, ownerLabel(e));
    css(H.oneOwner, 'color', colorOf(e.owner));
    const s = H.oneStats; s.textContent = '';
    const d = e.def, bits = [T('ui.armor.' + d.armor)];
    if (d.move) bits.push(T('ui.tip.cps', { n: d.move.speed }));
    for (let i = 0; i < d.weapons.length; i++) {
      const w = d.weapons[i];
      bits.push((w.heal ? '+' : '') + (w.burst > 1 ? w.dmg + '×' + w.burst : w.dmg) + ' · ' + T('ui.tip.range', { r: w.range }));
    }
    txt(s, bits.join('  ·  '));
    H.oneChips._sig = '';
    H.oneTraits = Object.keys(d.traits).filter(function (n) { return NT.STR.en['ui.tb.' + n]; });
  }
  function updateOne(e) {
    const k = Math.max(0, e.hp / e.maxHp);
    css(H.oneHp, '--p', k.toFixed(3));
    tog(H.oneHp.parentNode, 'mid', k < 0.6 && k >= 0.3); tog(H.oneHp.parentNode, 'low', k < 0.3);
    txt(H.oneHpT, fmt(Math.ceil(e.hp)) + ' / ' + fmt(e.maxHp));
    txt(H.oneRank, e.rank > 0 ? '▲'.repeat(e.rank) + ' ' + T('ui.rank' + e.rank) : '');
    const hv = e.def.traits.harvester;
    tog(H.oneCargo, 'on', !!hv);
    if (hv) { css(H.oneCargoF, '--p', Math.min(1, e.cargo / hv.capacity).toFixed(3)); H.oneCargo.title = T('ui.st.cargo', { n: e.cargo, m: hv.capacity }); }
    const chips = stateChips(e), sig = chips.map(function (c) { return c[0]; }).join() + '|' + NT.lang;
    if (sig !== H.oneChips._sig) {
      H.oneChips._sig = sig; H.oneChips.textContent = '';
      for (const c of chips) el('span', 'nt-chip ' + c[1], H.oneChips, T('ui.st.' + c[0]));
      for (const n of H.oneTraits) { const b = el('span', 'nt-chip trait', H.oneChips, T('ui.tb.' + n)); b.title = traitLine(n, e.def.traits[n], e.def); }
    }
  }
  function groupsOf(ents) {
    const gs = [], by = {};
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i], k = e.def.id + '|' + e.owner;
      let gr = by[k];
      if (!gr) { gr = by[k] = { def: e.def, owner: e.owner, ids: [], hp: 0, max: 0 }; gs.push(gr); }
      gr.ids.push(e.id); gr.hp += e.hp; gr.max += e.maxHp;
    }
    return gs;
  }
  function buildMany(ents) {
    const gs = groupsOf(ents);
    H.manyGrid.textContent = '';
    H.groups = [];
    for (let i = 0; i < gs.length && i < 24; i++) {
      const gr = gs[i], b = btn('nt-grp', H.manyGrid);
      iconCanvas('nt-grpi', b, gr.def, colorOf(gr.owner), UI.compact ? 34 : 42);
      gr.n = el('span', 'nt-grpn', b); gr.bar = el('i', 'nt-grphp', b);
      b.title = NT.tr(gr.def.name);
      b.addEventListener('click', function (ev) {
        const cur = G().sel, ids = gr.ids.filter(function (id) { return cur.indexOf(id) >= 0; });
        if (ev.shiftKey) G().select(cur.filter(function (id) { return ids.indexOf(id) < 0; }));
        else G().select(ids);
      });
      gr.btn = b;
      H.groups.push(gr);
    }
  }
  function updateMany(ents) {
    txt(H.manyHead, T('ui.sel.n', { n: ents.length }));
    const gs = groupsOf(ents);
    for (let i = 0; i < H.groups.length; i++) {
      const gr = H.groups[i], now = gs[i];
      if (!now) continue;
      gr.ids = now.ids;
      txt(gr.n, now.ids.length > 1 ? '×' + now.ids.length : '');
      css(gr.bar, '--p', (now.hp / now.max).toFixed(3));
    }
  }

  // Which buttons the current selection gets. Each: {id, key, on, dis, fn, tip}
  function actionsFor(ents) {
    const g = G(), mine = ents.filter(function (e) { return e.owner === g.me; }), out = [];
    if (!mine.length || g.me < 0) return out;
    const units = mine.filter(function (e) { return e.kind === 'unit'; }), blds = mine.filter(function (e) { return e.kind === 'building'; });
    const ids = function (list) { return list.map(function (e) { return e.id; }); };
    if (units.length) {
      const us = ids(units), fighters = units.filter(function (e) { return armed(e.def); });
      out.push({ id: 'stop', key: 'S', fn: function () { g.cmd({ type: 'stop', ids: us }); } });
      if (fighters.length) {
        out.push({ id: 'amove', key: 'A', on: g.mode.type === 'target' && g.mode.what === 'amove',
          fn: function () { if (g.mode.what === 'amove') cancelMode(); else g.setMode({ type: 'target', what: 'amove' }); } });
        const hold = fighters.every(function (e) { return e.stance === 'hold'; });
        out.push({ id: 'hold', key: 'H', on: hold, fn: function () { g.cmd({ type: 'stance', ids: ids(fighters), stance: hold ? 'aggressive' : 'hold' }); } });
      }
      const dep = units.filter(function (e) { return e.def.traits.deploy; });
      if (dep.length) out.push({ id: 'deploy', key: 'D', fn: function () { g.cmd({ type: 'deploy', ids: ids(dep) }); } });
      const sg = units.filter(function (e) { return e.def.traits.surge; });
      if (sg.length) {
        const rdy = sg.some(function (e) { return !(e.abil.surge > g.world.tick); });
        out.push({ id: 'surge', dis: !rdy, fn: function () { g.cmd({ type: 'ability', ids: ids(sg), ability: 'surge' }); } });
      }
      const hv = units.filter(function (e) { return e.def.traits.harvester; });
      if (hv.length) {
        out.push({ id: 'harvest', fn: function () { g.cmd({ type: 'harvest', ids: ids(hv) }); } });
        out.push({ id: 'return', dis: !hv.some(function (e) { return e.cargo > 0; }), fn: function () { g.cmd({ type: 'return', ids: ids(hv) }); } });
      }
    } else if (blds.length) {
      const sellable = blds.filter(function (e) { return e.def.queue; });
      if (sellable.length) {
        let refund = 0;
        for (const e of sellable) refund += g.world.rules.sellRefund * e.def.cost * e.hp / e.maxHp;
        out.push({ id: 'sell', tipVars: { n: fmt(refund) }, fn: function () { for (const e of sellable) g.cmd({ type: 'sell', id: e.id }); } });
      }
      const hurt = blds.filter(function (e) { return e.hp < e.maxHp || e.repairing; });
      if (hurt.length) {
        const on = hurt.every(function (e) { return e.repairing; });
        out.push({ id: 'repair', on: on, fn: function () { for (const e of hurt) g.cmd({ type: 'repair', id: e.id, on: !on }); } });
      }
      if (blds.length === 1 && isDoor(blds[0].def)) out.push({ id: 'primary', on: blds[0].primary, fn: function () { g.cmd({ type: 'primary', id: blds[0].id }); } });
    }
    if (UI.compact) out.push({ id: 'deselect', fn: function () { g.select([]); } });
    return out;
  }
  function refreshActs(ents) {
    const acts = actionsFor(ents);
    const sig = acts.map(function (a) { return a.id; }).join() + '|' + NT.lang + '|' + (UI.compact ? 1 : 0);
    if (sig !== actSig) {
      actSig = sig;
      H.acts.textContent = '';
      H.actBtns = acts.map(function (a) {
        const b = btn('nt-act nt-act-' + a.id, H.acts);
        el('span', 'nt-actl', b, T('ui.act.' + a.id));
        if (a.key && !UI.compact) el('kbd', '', b, a.key);
        b.addEventListener('click', function () { if (b._a && !b._a.dis) { b._a.fn(); refresh(true); } });
        return b;
      });
    }
    for (let i = 0; i < acts.length; i++) {
      const b = H.actBtns[i], a = acts[i];
      b._a = a;
      tog(b, 'on', !!a.on); tog(b, 'dis', !!a.dis);
      const tip = T('ui.act.' + a.id + '.tip', a.tipVars);
      if (b._tip !== tip) { b._tip = tip; b.title = tip; }
    }
    const g = G(), one = ents.length === 1 && ents[0].owner === g.me && ents[0].kind === 'building' && isDoor(ents[0].def);
    txt(H.selHint, one ? T(UI.compact ? 'ui.rallyTouch' : 'ui.rally') : '');
  }

  // --------------------------------------------------------------------------
  // Toasts + alerts
  // --------------------------------------------------------------------------
  const toasts = [], lastBy = {};
  UI.toast = function (key, vars, opts) {
    if (!root) return null;
    opts = opts || {};
    const group = opts.group || key, now = performance.now();
    UI.toastFresh = false;
    if (opts.every && lastBy[group] && now - lastBy[group] < opts.every) {
      const live = toasts.find(function (t) { return t.group === group; });
      if (live) { live.ttl = Math.max(live.ttl, 2); unfade(live); }
      return live || null;
    }
    lastBy[group] = now;
    UI.toastFresh = true;
    let t = toasts.find(function (x) { return x.group === group; });
    if (t) { t.n++; t.key = key; t.vars = vars; t.ttl = opts.ttl || 4.5; unfade(t); tog(t.el, 'bump', false); void t.el.offsetWidth; tog(t.el, 'bump', true); }
    else {
      t = { key: key, vars: vars, group: group, n: 1, ttl: opts.ttl || 4.5, kind: opts.kind || 'info', at: opts.at || null, onClick: opts.onClick || null };
      t.el = el('div', 'nt-toast nt-glass ' + t.kind, null);
      if (t.at || t.onClick) { t.el.classList.add('click'); t.icon = el('span', 'nt-tjump', t.el); t.icon.innerHTML = ICON.jump; }
      t.txt = el('span', 'nt-ttxt', t.el); t.cnt = el('span', 'nt-tcnt', t.el);
      t.el.addEventListener('click', function () {
        if (t.at) { G().lookAt(t.at[0], t.at[1]); if (NT.Render && NT.Render.ping) NT.Render.ping(t.at[0], t.at[1], '#ff4d5e'); }
        if (t.onClick) t.onClick();
        t.ttl = Math.min(t.ttl, 0.3);
      });
      H.toasts.insertBefore(t.el, H.toasts.firstChild);
      toasts.push(t);
      while (toasts.length > (UI.compact ? 2 : 5)) dropToast(toasts[0]);
    }
    if (t.at) { t.at = opts.at; UI.lastAlert = { x: opts.at[0], y: opts.at[1], t: G().now }; }
    renderToast(t);
    return t;
  };
  function renderToast(t) {
    txt(t.txt, T(t.key, t.vars));
    txt(t.cnt, t.n > 1 && t.key.indexOf('ui.t.unit') < 0 ? '×' + t.n : '');
  }
  function unfade(t) { if (t.fading) { t.fading = false; t.el.classList.remove('out'); } }
  function dropToast(t) { const i = toasts.indexOf(t); if (i >= 0) toasts.splice(i, 1); if (t.el.parentNode) t.el.parentNode.removeChild(t.el); }
  function clearToasts() { while (toasts.length) dropToast(toasts[0]); }
  function tickToasts(dt) {
    for (let i = toasts.length - 1; i >= 0; i--) {
      const t = toasts[i];
      t.ttl -= dt;
      if (t.ttl < 0.4 && !t.fading) { t.fading = true; t.el.classList.add('out'); }
      if (t.ttl <= 0) dropToast(t);
    }
  }

  function alertAt(key, vars, x, y, group, every) {
    const t = UI.toast(key, vars, { kind: 'bad', at: [x, y], group: group, every: every, ttl: 6 });
    if (t && UI.toastFresh && NT.Render && NT.Render.ping) NT.Render.ping(x, y, '#ff4d5e');
    return t;
  }
  const prodAgg = {};
  function onSim(ev) {
    const g = G(), w = g.world, me = g.me;
    if (!w || me < 0 || !built) return;
    const p = w.players[me];
    switch (ev.t) {
      case 'ready': if (ev.owner === me) {
        const d = NT.DEFS[ev.def];
        UI.toast('ui.t.ready', { name: d.name }, { kind: 'good', group: 'ready:' + ev.def, onClick: function () { if (p.queues[d.queue].ready === d) g.setMode({ type: 'place', def: d }); } });
      } break;
      case 'produced': if (ev.owner === me) {
        const d = NT.DEFS[ev.def], k = ev.def, now = g.now;
        const a = prodAgg[k] && now - prodAgg[k].t < 4 ? prodAgg[k] : (prodAgg[k] = { n: 0, t: now });
        a.n++; a.t = now;
        UI.toast(a.n > 1 ? 'ui.t.units' : 'ui.t.unit', { name: d.name, n: a.n }, { kind: 'good', group: 'prod:' + k, ttl: 3.5 });
      } break;
      case 'placed': case 'cancelled': if (ev.owner === me) { const t = toasts.find(function (x) { return x.group === 'ready:' + ev.def; }); if (t) dropToast(t); }
        else if (ev.t === 'placed' && NT.isEnemy(w, me, ev.owner)) {             // fog never hides a superweapon (fog.js): say so
          const d = NT.DEFS[ev.def];
          if (d && d.role === 'super') alertAt('ui.t.super', { name: d.name }, ev.x, ev.y, 'super:' + ev.id, 0);
        } break;
      case 'nofunds': if (ev.owner === me) UI.toast('ui.t.nofunds', null, { kind: 'warn', group: 'nofunds', every: 9000 }); break;
      case 'lowpower': if (ev.owner === me) { const o = toasts.find(function (x) { return x.group === (ev.on ? 'power:ok' : 'power:low'); }); if (o) dropToast(o); }
        if (ev.owner === me) UI.toast(ev.on ? 'ui.t.lowpower' : 'ui.t.powerok', { power: p.faction.powerName }, { kind: ev.on ? 'bad' : 'good', group: ev.on ? 'power:low' : 'power:ok' }); break;
      case 'hurt': if (ev.owner === me) {
        const e = w.byId.get(ev.id);
        if (!e) break;
        if (e.kind === 'building') alertAt('ui.t.base', null, ev.x, ev.y, 'atk:base', 12000);
        else if (e.def.traits.harvester) alertAt('ui.t.harv', null, ev.x, ev.y, 'atk:harv', 12000);
        else if (!(NT.Render && NT.Render.onScreen && NT.Render.onScreen(ev.x, ev.y, 0))) alertAt('ui.t.army', null, ev.x, ev.y, 'atk:army', 20000);
      } break;
      case 'captured': {
        const e = w.byId.get(ev.id), name = e ? e.def.name : null;
        if (ev.to === me) UI.toast('ui.t.captured', { name: name }, { kind: 'good', at: [ev.x, ev.y], group: 'cap:' + ev.id });
        else if (ev.from === me) alertAt('ui.t.lost', { name: name }, ev.x, ev.y, 'lost:' + ev.id, 3000);
      } break;
      case 'death': if (ev.owner === me && ev.kind === 'building') {
        const d = NT.DEFS[ev.def];
        UI.toast('ui.t.blost', { name: d ? d.name : '' }, { kind: 'bad', at: [ev.x, ev.y], group: 'blost', every: 1500 });
      } break;
      case 'power_ready': if (ev.owner === me) { const pd = powerDef(ev.power); if (pd) UI.toast('ui.t.pready', { name: pd.name }, { kind: 'good', group: 'pow:' + pd.id }); } break;
      case 'strike_warn': if (NT.isEnemy(w, me, ev.owner)) {
        const pd = powerDef(ev.power);
        alertAt('ui.t.strike', { name: pd ? pd.name : '' }, ev.x, ev.y, 'strike:' + ev.x + ',' + ev.y, 0);
      } break;
      case 'denied': if (ev.owner === me) UI.toast('ui.deny.' + ev.reason, null, { kind: 'warn', group: 'deny', every: 900 }); break;
      case 'defeated': if (ev.player !== me && w.players[ev.player]) UI.toast('ui.t.elim', { name: w.players[ev.player].faction.name }, { kind: 'good', ttl: 6 }); break;
      case 'rank': if (ev.owner === me) UI.toast('ui.t.rank', null, { kind: 'info', group: 'rank', every: 8000, ttl: 3 }); break;
    }
    if (UI._hintsSim) UI._hintsSim(ev);
  }

  // --------------------------------------------------------------------------
  // Top bar, mode banner, language
  // --------------------------------------------------------------------------
  function refreshTop(world, p) {
    txt(H.clockV, clock(world.tick));
    if (!p) return;
    const pw = p.power, low = pw.low;
    txt(H.powV, Math.round(pw.used) + ' / ' + Math.round(pw.made));
    css(H.powFill, '--p', pw.made > 0 ? Math.min(1, pw.used / pw.made).toFixed(3) : (pw.used > 0 ? '1' : '0'));
    tog(H.pow, 'low', low); tog(H.pow, 'tight', !low && pw.made > 0 && pw.used / pw.made > 0.85);
  }
  function tickGlint(dt, p) {
    const g = H.glint, target = Math.floor(p.credits);
    if (g._shown < 0) g._shown = target;
    const d = target - g._shown;
    if (d !== 0) {
      g._shown = Math.abs(d) < 2 ? target : g._shown + d * Math.min(1, dt * 9) + Math.sign(d);
      if ((d > 0 && g._shown > target) || (d < 0 && g._shown < target)) g._shown = target;
      tog(g, 'up', d > 0); tog(g, 'down', d < 0);
    } else { tog(g, 'up', false); tog(g, 'down', false); }
    txt(H.glintV, fmt(g._shown));
  }
  function syncSys() {
    if (!root) return;
    const s = G().settings || {};
    H.bSnd.innerHTML = s.mute ? ICON.mute : ICON.snd;
    tog(H.bSnd, 'off', !!s.mute);
    txt(H.bSpeedV, '×' + G().speed);
    if (UI._syncSettings) UI._syncSettings();
  }
  function syncMode() {
    const g = G(), m = g.mode;
    let s = '';
    const t = UI.compact ? 'Touch' : '';
    if (m.type === 'place' && m.def) s = T('ui.m.place' + t, { name: m.def.name });
    else if (m.type === 'target' && m.what === 'amove') s = T('ui.m.amove' + t);
    else if (m.type === 'target' && m.what === 'power') { const pd = powerDef(m.power); s = T('ui.m.power' + t, { name: pd ? pd.name : '' }); }
    else if (m.type === 'target') s = T('ui.m.target');
    txt(H.bannerT, s);
    tog(H.banner, 'on', !!s && g.state === 'playing');
    tog(H.confirm, 'on', m.type === 'place' && UI.compact);
    tog(root, 'nt-moding', !!s);
    hideTip();
    if (built) refresh(true);
  }
  function relabelModes() { if (H.bOk) { txt(H.bOk, T('ui.confirm')); txt(H.bNo, T('ui.cancel')); } syncMode(); }

  function relabel() {
    if (!root) return;
    txt(H.glintL, T('ui.glint'));
    H.glint.title = T('ui.glint'); H.clock.title = T('ui.clock');
    H.bSpeed.title = T('ui.speed'); H.bSnd.title = T('ui.sound'); H.bLang.title = T('ui.langtip'); H.bMenu.title = T('ui.menu');
    txt(H.bLang, T('ui.langbtn'));
    txt(H.paused, T('ui.paused'));
    H.collapse.title = '';
    const p = G().player();
    if (p) { txt(H.powL, NT.tr(p.faction.powerName)); H.pow.title = NT.tr(p.faction.powerName); }
    if (built) {
      for (const k in built.tabs) txt(built.tabs[k].btn._n, NT.tr(built.tabs[k].q.name));
      for (const id in built.recs) { const r = built.recs[id]; txt(r.name, NT.tr(r.def.name)); txt(r.cost, fmt(r.def.cost)); r.sig = ''; }
      for (const id in built.pows) txt(built.pows[id].n, NT.tr(built.pows[id].pd.name));
    }
    for (const t of toasts) renderToast(t);
    relabelMini(); relabelModes(); syncSys();
    selSig = ''; actSig = ''; selDirty = true;
    H.tip._key = ''; hideTip();
    document.documentElement.lang = NT.lang === 'zh' ? 'zh-CN' : 'en';
    if (UI._relabelOverlay) UI._relabelOverlay();
    if (UI._relabelHints) UI._relabelHints();
  }

  // --------------------------------------------------------------------------
  // Frame
  // --------------------------------------------------------------------------
  function refresh(force) {
    const g = G(), w = g.world;
    if (!w || !built) return;
    const p = g.player();
    refreshTop(w, p);
    if (p) { refreshGrid(w, p); refreshPowers(w, p); }
    selDirty = false; refreshSel();
    if (UI._hintsTick) UI._hintsTick(w, p);
  }
  UI.frame = function (dt) {
    if (!root) return;
    const g = G();
    tickToasts(dt);
    if (!g.world || !built || g.state === 'menu') return;
    const p = g.player();
    if (p) tickGlint(dt, p);
    acc += dt; mmAcc += dt;
    if (acc >= 0.1) { acc = 0; refresh(false); }
    if (mmAcc >= 0.1) { mmAcc = 0; drawMinimap(); }
    if (overT > 0) { overT -= dt; if (overT <= 0 && UI._showOver) UI._showOver(g.result); }
    tog(H.paused, 'on', g.paused && !g.modal && g.state === 'playing');
  };

  UI.insets = function () {
    const o = { top: 0, right: 0, bottom: 0, left: 0 };
    if (!root || root.classList.contains('nt-off')) return o;
    const W = window.innerWidth, Hh = window.innerHeight, t = H.top.getBoundingClientRect(), sd = H.side.getBoundingClientRect();
    o.top = Math.round(t.bottom);
    if (sd.width && sd.height) { if (UI.compact) o.bottom = Math.round(Hh - sd.top); else o.right = Math.round(W - sd.left); }
    return o;
  };
  UI.showMenu = function () { if (UI._showMain) UI._showMain(); };
  UI.onEscape = function () { return UI._escape ? UI._escape() : false; };
  UI.openPause = function () { if (UI._openPause) UI._openPause(); };

  // shared with the overlay part below
  UI._k = { el: el, btn: btn, txt: txt, tog: tog, css: css, T: T, G: G, blit: blit, iconCanvas: iconCanvas, fmt: fmt, clock: clock,
    ICON: ICON, rgba: rgba, root: function () { return root; }, H: H, layout: layout, producersOf: producersOf, armed: armed, hideTip: hideTip,
    recBtn: function (id) { return built && built.recs[id] ? built.recs[id].btn : null; } };
})();

// ============================================================================
// Overlays: main menu, pause, settings, how to play, game over — and first-game hints.
// One overlay element; screens stack (main | pause > settings | howto | over). NT.Game.modal mirrors "stack not empty".
// ============================================================================
(function () {
  const UI = NT.UI, K = UI._k;
  const el = K.el, btn = K.btn, txt = K.txt, tog = K.tog, css = K.css, T = K.T, G = K.G, H = K.H;
  const DIFFS = ['easy', 'normal', 'hard'];
  let ov = null, stack = [], wasPaused = false, menuSel = null, mapCache = {}, sure = false, quiet = false;

  NT.strings({
    en: {
      'ui.title': 'NEON TURF', 'ui.title2': '霓虹地盘', 'ui.menu.tag': 'Gang warfare in a neon megacity. Harvest Glint, build your block, break the rival gang.',
      'ui.menu.gang': 'Choose your gang', 'ui.menu.enemy': 'Opponent', 'ui.menu.random': 'Random', 'ui.menu.diff': 'Difficulty',
      'ui.diff.easy': 'Easy', 'ui.diff.normal': 'Normal', 'ui.diff.hard': 'Hard',
      'ui.menu.map': 'Battleground', 'ui.menu.randomMap': 'Random block', 'ui.menu.randomDesc': 'A freshly generated district: nobody knows these streets yet.',
      'ui.size.small': 'Small', 'ui.size.medium': 'Medium', 'ui.size.large': 'Large', 'ui.menu.cells': '{w}×{h}',
      'ui.menu.start': 'Start match', 'ui.menu.howto': 'How to play', 'ui.menu.hub': '← All games', 'ui.menu.units': 'Signature roster',
      'ui.p.title': 'Paused', 'ui.p.resume': 'Resume', 'ui.p.restart': 'Restart', 'ui.p.settings': 'Settings', 'ui.p.surrender': 'Surrender',
      'ui.p.sure': 'Tap again to surrender', 'ui.p.quit': 'Quit to menu', 'ui.p.over': 'Match over',
      'ui.s.title': 'Settings', 'ui.s.sfx': 'Effects', 'ui.s.music': 'Music', 'ui.s.mute': 'Mute all', 'ui.s.lang': 'Language', 'ui.s.edge': 'Edge scrolling',
      'ui.s.hints': 'First-game tips', 'ui.s.speed': 'Game speed', 'ui.on': 'On', 'ui.off': 'Off', 'ui.back': 'Back', 'ui.close': 'Close',
      'ui.o.win': 'VICTORY', 'ui.o.lose': 'DEFEAT', 'ui.o.end': 'MATCH OVER', 'ui.o.winSub': 'The district is yours.', 'ui.o.loseSub': 'Your turf has fallen.',
      'ui.o.specSub': '{name} takes the district.', 'ui.o.time': 'Match time {t}', 'ui.o.gang': 'Gang', 'ui.o.produced': 'Trained', 'ui.o.built': 'Built',
      'ui.o.kills': 'Kills', 'ui.o.lost': 'Lost', 'ui.o.razed': 'Razed', 'ui.o.income': 'Earned', 'ui.o.spent': 'Spent',
      'ui.o.again': 'Play again', 'ui.o.menu': 'Main menu', 'ui.o.watch': 'Keep watching', 'ui.o.you': 'You', 'ui.o.ai': 'AI · {d}',
      'ui.how.title': 'How to play',
      'ui.how.goal.h': 'Goal', 'ui.how.goal': 'Wreck the rival gang\'s HQ and every building that trains troops. Keep yours standing: lose them all and you are out.',
      'ui.how.eco.h': 'Glint', 'ui.how.eco': 'Glint is money. Harvesters scoop it from the glittering heaps and haul it to a drop-off. Production pays as it goes: when Glint runs out, building simply pauses.',
      'ui.how.pow.h': 'Power', 'ui.how.pow': 'Producers, radar and the heavy defences draw power. Keep the meter in the top bar out of the red: when it blinks, production slows and powered defences go dark.',
      'ui.how.build.h': 'Building', 'ui.how.build': 'Pick a tab in the sidebar and click an item. Structures turn READY: click again and place them near your base. Units walk out of their producer by themselves. Right-click an item to cancel it.',
      'ui.how.turf.h': 'Turf', 'ui.how.turf': 'The grey street businesses on the map pay whoever holds the block. Send a unit that can capture into one to claim it.',
      'ui.how.sp.h': 'Support powers', 'ui.how.sp': 'Late structures charge a support power. When its ring is full, click it in the sidebar and pick a target.',
      'ui.how.mouse': 'Mouse + keyboard', 'ui.how.touch': 'Touch',
      'ui.k.sel': 'Select · drag a box for many', 'ui.k.order': 'Move / attack / harvest / capture', 'ui.k.amove': 'Attack-move', 'ui.k.stop': 'Stop',
      'ui.k.hold': 'Hold position on / off', 'ui.k.deploy': 'Deploy', 'ui.k.group': 'Make group / recall group', 'ui.k.army': 'Army on screen / whole army',
      'ui.k.alert': 'Jump to the last alert', 'ui.k.home': 'Jump to your HQ', 'ui.k.scroll': 'Scroll (or push the screen edge)', 'ui.k.zoom': 'Zoom',
      'ui.k.esc': 'Cancel · pause menu', 'ui.k.pause': 'Pause', 'ui.k.mute': 'Mute',
      'ui.t.tap': 'Tap a unit or building to select it', 'ui.t.order': 'With units selected, tap the ground or an enemy to order', 'ui.t.pan': 'Drag to pan · pinch to zoom',
      'ui.t.box': 'Long-press, then drag: select a group', 'ui.t.dbl': 'Double-tap a unit: all of that type on screen', 'ui.t.sheet': 'Build from the bottom sheet · tap the minimap to enlarge it',
      'ui.k.lmb': 'Left click', 'ui.k.rmb': 'Right click', 'ui.k.wheel': 'Wheel', 'ui.k.arrows': 'Arrows',
      'ui.h.tip': 'Tip {i}/{n}', 'ui.h.power': 'Build a {name} first: everything else runs on {power}.', 'ui.h.drop': 'Build a {name}: it comes with a harvester that gathers Glint.', 'ui.h.drop0': 'Build a {name}: harvesters deliver their Glint there.',
      'ui.h.army': 'Build a {name} and train fighters there.', 'ui.h.move': 'Select units, then right-click to move. A + click: attack-move.',
      'ui.h.moveTouch': 'Tap your units to select them, then tap the ground to move.', 'ui.h.ok': 'Got it', 'ui.h.off': 'Hide tips',
      'ui.rotate': 'Rotate your phone for a wider view',
    },
    zh: {
      'ui.title': 'NEON TURF', 'ui.title2': '霓虹地盘', 'ui.menu.tag': '霓虹巨城里的帮派战争。采集碎金，经营街区，击垮对手帮派。',
      'ui.menu.gang': '选择你的帮派', 'ui.menu.enemy': '对手', 'ui.menu.random': '随机', 'ui.menu.diff': '难度',
      'ui.diff.easy': '简单', 'ui.diff.normal': '普通', 'ui.diff.hard': '困难',
      'ui.menu.map': '战场', 'ui.menu.randomMap': '随机街区', 'ui.menu.randomDesc': '全新生成的街区：没人熟悉这些街道。',
      'ui.size.small': '小', 'ui.size.medium': '中', 'ui.size.large': '大', 'ui.menu.cells': '{w}×{h}',
      'ui.menu.start': '开战', 'ui.menu.howto': '玩法说明', 'ui.menu.hub': '← 全部游戏', 'ui.menu.units': '代表阵容',
      'ui.p.title': '已暂停', 'ui.p.resume': '继续', 'ui.p.restart': '重新开始', 'ui.p.settings': '设置', 'ui.p.surrender': '投降',
      'ui.p.sure': '再点一次确认投降', 'ui.p.quit': '退出到主菜单', 'ui.p.over': '对局已结束',
      'ui.s.title': '设置', 'ui.s.sfx': '音效', 'ui.s.music': '音乐', 'ui.s.mute': '全部静音', 'ui.s.lang': '语言', 'ui.s.edge': '屏幕边缘滚动',
      'ui.s.hints': '新手提示', 'ui.s.speed': '游戏速度', 'ui.on': '开', 'ui.off': '关', 'ui.back': '返回', 'ui.close': '关闭',
      'ui.o.win': '胜利', 'ui.o.lose': '败北', 'ui.o.end': '对局结束', 'ui.o.winSub': '这片街区归你了。', 'ui.o.loseSub': '你的地盘失守了。',
      'ui.o.specSub': '{name}拿下了这片街区。', 'ui.o.time': '对局时长 {t}', 'ui.o.gang': '帮派', 'ui.o.produced': '训练', 'ui.o.built': '建造',
      'ui.o.kills': '击杀', 'ui.o.lost': '损失', 'ui.o.razed': '摧毁', 'ui.o.income': '收入', 'ui.o.spent': '支出',
      'ui.o.again': '再来一局', 'ui.o.menu': '主菜单', 'ui.o.watch': '继续观看', 'ui.o.you': '你', 'ui.o.ai': '电脑 · {d}',
      'ui.how.title': '玩法说明',
      'ui.how.goal.h': '目标', 'ui.how.goal': '摧毁对手帮派的总部和所有训练部队的建筑；守住你自己的——全部失去就出局。',
      'ui.how.eco.h': '碎金', 'ui.how.eco': '碎金就是钱。采集车从闪光的碎金堆里铲起碎金，运回卸货点。生产边造边付款：碎金用完，建造就会暂停。',
      'ui.how.pow.h': '电力', 'ui.how.pow': '生产建筑、雷达和重型防御都要耗电。别让顶栏的电表变红：一旦闪烁，生产就会减速，耗电的防御也会熄火。',
      'ui.how.build.h': '建造', 'ui.how.build': '在侧栏选一个分页，点击项目开始建造。建筑完成后显示“就绪”：再点一次，放在基地附近。部队会自己从生产建筑里走出来。右键项目可取消。',
      'ui.how.turf.h': '地盘', 'ui.how.turf': '地图上灰色的街头生意向占住街区的一方交钱。派一名能占领的单位进去，就能把它拿下。',
      'ui.how.sp.h': '支援技能', 'ui.how.sp': '后期建筑会为支援技能充能。圆环充满后，在侧栏点击它并选择目标。',
      'ui.how.mouse': '鼠标 + 键盘', 'ui.how.touch': '触屏',
      'ui.k.sel': '选择 · 拖框多选', 'ui.k.order': '移动 / 攻击 / 采集 / 占领', 'ui.k.amove': '攻击移动', 'ui.k.stop': '停止',
      'ui.k.hold': '坚守开 / 关', 'ui.k.deploy': '展开', 'ui.k.group': '编队 / 选择编队', 'ui.k.army': '屏幕内部队 / 全部部队',
      'ui.k.alert': '跳到最近的警报', 'ui.k.home': '回到总部', 'ui.k.scroll': '滚动视角（或推屏幕边缘）', 'ui.k.zoom': '缩放',
      'ui.k.esc': '取消 · 暂停菜单', 'ui.k.pause': '暂停', 'ui.k.mute': '静音',
      'ui.t.tap': '轻点单位或建筑即可选中', 'ui.t.order': '选中部队后，轻点地面或敌人下达命令', 'ui.t.pan': '拖动平移 · 双指缩放',
      'ui.t.box': '长按后拖动：框选一组', 'ui.t.dbl': '双击单位：选中屏幕内所有同类', 'ui.t.sheet': '在底部面板建造 · 轻点小地图可放大',
      'ui.k.lmb': '左键', 'ui.k.rmb': '右键', 'ui.k.wheel': '滚轮', 'ui.k.arrows': '方向键',
      'ui.h.tip': '提示 {i}/{n}', 'ui.h.power': '先建一座{name}：其他一切都要靠{power}运转。', 'ui.h.drop': '建造{name}：它会附赠一台采集车来采集碎金。', 'ui.h.drop0': '建造{name}：采集车会把碎金运到这里。',
      'ui.h.army': '建造{name}，在那里训练战斗人员。', 'ui.h.move': '选中部队，右键移动。A + 左键：攻击移动。',
      'ui.h.moveTouch': '轻点你的部队选中，再轻点地面让它们移动。', 'ui.h.ok': '知道了', 'ui.h.off': '关闭提示',
      'ui.rotate': '横屏可获得更宽的视野',
    },
  });

  // --------------------------------------------------------------------------
  // Stack
  // --------------------------------------------------------------------------
  UI._buildOverlay = function () {
    ov = el('div', 'nt-ov', K.root());
    ov.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    txt(H.rotate, T('ui.rotate'));
  };
  function top() { return stack[stack.length - 1] || null; }
  function render() {
    const s = top(), g = G();
    g.modal = stack.length > 0;
    tog(ov, 'on', !!s);
    ov.className = 'nt-ov' + (s ? ' on nt-ov-' + s : '');
    ov.textContent = '';
    K.hideTip();
    if (!s) return;
    ({ main: mainMenu, pause: pauseMenu, settings: settingsMenu, howto: howTo, over: overScreen })[s]();
  }
  function push(s) { if (top() !== s) stack.push(s); sure = false; render(); }
  function back() {
    const s = stack.pop();
    if (s === 'pause' && G().state !== 'menu') G().pause(wasPaused);
    render();
  }
  UI._closeAll = function () { stack = []; render(); };
  UI.closeOverlay = function () { while (stack.length && top() !== 'main') back(); };
  UI._escape = function () {
    const s = top(), g = G();
    if (s === 'settings' || s === 'howto') { back(); return true; }
    if (s === 'pause') { back(); return true; }
    if (s === 'main' || s === 'over') return true;
    if (g.state === 'playing' || g.state === 'over') { UI._openPause(); return true; }
    return false;
  };
  UI._openPause = function () {
    const g = G();
    if (!g.world || top() === 'pause') return;
    if (!stack.length) { wasPaused = g.paused; g.pause(true); }
    push('pause');
  };
  UI.showHowTo = function () { push('howto'); };
  UI._relabelOverlay = function () { txt(H.rotate, T('ui.rotate')); if (top()) render(); };
  UI._syncSettings = function () { if (top() === 'settings' && !quiet) render(); };

  // shared pieces
  function panel(cls) { const p = el('div', 'nt-panel nt-glass ' + (cls || ''), ov); return p; }
  function title(parent, key) { return el('h2', 'nt-ptitle', parent, T(key)); }
  function bigBtn(parent, key, fn, cls) { const b = btn('nt-mbtn ' + (cls || ''), parent, T(key)); b.addEventListener('click', fn); return b; }
  function chips(parent, items, cur, fn) {
    const row = el('div', 'nt-chiprow', parent);
    for (const it of items) {
      const b = btn('nt-mchip' + (it.v === cur ? ' on' : ''), row, it.label);
      if (it.color) css(b, '--c', it.color);
      b.addEventListener('click', function () { fn(it.v); });
    }
    return row;
  }

  // --------------------------------------------------------------------------
  // Main menu
  // --------------------------------------------------------------------------
  UI._showMain = function () {
    const s = G().settings || {};
    const F = NT.FACTION_LIST;
    menuSel = {
      faction: NT.FACTIONS[s.faction] && NT.FACTIONS[s.faction].playable ? s.faction : (F[0] && F[0].id),
      enemy: s.enemy === 'random' || (NT.FACTIONS[s.enemy] && NT.FACTIONS[s.enemy].playable) ? s.enemy : 'random',
      difficulty: DIFFS.indexOf(s.difficulty) >= 0 ? s.difficulty : 'normal',
      map: s.map === 'random' || (NT.MAPS || []).some(function (m) { return m.id === s.map; }) ? s.map : (NT.MAPS && NT.MAPS[0] ? NT.MAPS[0].id : 'random'),
    };
    K.root().classList.add('nt-off');
    stack = ['main'];
    render();
  };
  function mapOf(id) {
    if (!mapCache[id] && NT.MapGen && NT.MapGen.fromPreset) { try { mapCache[id] = NT.MapGen.fromPreset(id); } catch (e) { mapCache[id] = null; } }
    return mapCache[id];
  }
  function collage(f) {
    const units = f.defs.filter(function (d) { return d.kind === 'unit' && d.queue && K.armed(d) && !d.traits.harvester; });
    const pick = [];
    const hq = f.start.buildings[0] && NT.DEFS[f.start.buildings[0].def];
    if (hq) pick.push(hq);
    for (let tier = 1; tier <= 3; tier++) {
      const u = units.filter(function (d) { return d.tier === tier; }).sort(function (a, b) { return b.cost - a.cost; })[0];
      if (u) pick.push(u);
    }
    for (let i = 0; pick.length < 4 && i < units.length; i++) if (pick.indexOf(units[i]) < 0) pick.push(units[i]);
    return pick.slice(0, 4);
  }
  function setMenu(k, v) {
    menuSel[k] = v;
    const patch = {}; patch[k] = v;
    G().saveSettings(patch);
    const sc = ov.scrollTop, inner = ov.querySelector('.nt-menu'), isc = inner ? inner.scrollTop : 0;
    render();
    ov.scrollTop = sc; const n = ov.querySelector('.nt-menu'); if (n) n.scrollTop = isc;
  }
  function mainMenu() {
    const sel = menuSel, F = NT.FACTION_LIST, me = NT.FACTIONS[sel.faction];
    const acc = me ? me.color : '#19e3ff';
    css(ov, '--acc', acc); css(ov, '--acc-a', K.rgba(acc, 0.5)); css(ov, '--acc-b', K.rgba(acc, 0.16)); css(ov, '--acc-c', K.rgba(acc, 0.08));
    const m = el('div', 'nt-menu', ov);
    const head = el('header', 'nt-mhead', m);
    const logo = el('div', 'nt-logo', head);
    el('h1', '', logo, T('ui.title'));
    el('span', 'nt-logo2', logo, T('ui.title2'));
    el('p', 'nt-mtag', logo, T('ui.menu.tag'));
    const tools = el('div', 'nt-mtools', head);
    const a = el('a', 'nt-mlink', tools, T('ui.menu.hub')); a.href = '../';
    const lb = btn('nt-mlink nt-mlang', tools, T('ui.langbtn')); lb.addEventListener('click', UI._toggleLang);
    // gangs
    el('h3', 'nt-msec', m, T('ui.menu.gang'));
    const cards = el('div', 'nt-fcards', m);
    for (const f of F) {
      const c = btn('nt-fcard' + (f.id === sel.faction ? ' on' : ''), cards);
      css(c, '--c', f.color); css(c, '--ca', K.rgba(f.color, 0.18));
      const col = el('div', 'nt-fcol', c);
      for (const d of collage(f)) K.iconCanvas('', col, d, f.color, 58);
      const body = el('div', 'nt-fbody', c);
      el('b', 'nt-fname', body, NT.tr(f.name));
      el('i', 'nt-ftag', body, NT.tr(f.tagline));
      el('p', 'nt-fdesc', body, NT.tr(f.desc));
      c.addEventListener('click', function () { setMenu('faction', f.id); });
    }
    // opponent + difficulty
    const opts = el('div', 'nt-mopts', m);
    const o1 = el('div', 'nt-mopt', opts); el('h3', 'nt-msec', o1, T('ui.menu.enemy'));
    chips(o1, [{ v: 'random', label: T('ui.menu.random') }].concat(F.map(function (f) { return { v: f.id, label: NT.tr(f.name), color: f.color }; })), sel.enemy, function (v) { setMenu('enemy', v); });
    const o2 = el('div', 'nt-mopt', opts); el('h3', 'nt-msec', o2, T('ui.menu.diff'));
    chips(o2, DIFFS.map(function (d) { return { v: d, label: T('ui.diff.' + d) }; }), sel.difficulty, function (v) { setMenu('difficulty', v); });
    // maps
    el('h3', 'nt-msec', m, T('ui.menu.map'));
    const maps = el('div', 'nt-maps', m);
    const enemyCol = NT.FACTIONS[sel.enemy] ? NT.FACTIONS[sel.enemy].color : '#e8ecf5';
    let desc = T('ui.menu.randomDesc');
    for (const mp of (NT.MAPS || [])) {
      const c = btn('nt-mapc' + (mp.id === sel.map ? ' on' : ''), maps);
      const cv = el('canvas', 'nt-mapv', c);
      drawPreview(cv, mapOf(mp.id), acc, enemyCol);
      const lbl = el('div', 'nt-mapl', c);
      el('b', '', lbl, NT.tr(mp.name));
      const map = mapOf(mp.id);
      el('span', '', lbl, T('ui.size.' + mp.size) + (map ? ' · ' + T('ui.menu.cells', { w: map.w, h: map.h }) : ''));
      if (mp.id === sel.map) desc = NT.tr(mp.desc);
      c.addEventListener('click', function () { setMenu('map', mp.id); });
    }
    const rc = btn('nt-mapc nt-maprand' + (sel.map === 'random' ? ' on' : ''), maps);
    const rv = el('div', 'nt-mapv nt-mapq', rc); rv.textContent = '?';
    const rl = el('div', 'nt-mapl', rc); el('b', '', rl, T('ui.menu.randomMap')); el('span', '', rl, T('ui.size.medium'));
    rc.addEventListener('click', function () { setMenu('map', 'random'); });
    el('p', 'nt-mapdesc', m, desc);
    // footer
    const foot = el('footer', 'nt-mfoot', m);
    bigBtn(foot, 'ui.menu.howto', function () { push('howto'); }, 'ghost');
    const st = bigBtn(foot, 'ui.menu.start', startMatch, 'primary');
    st.innerHTML = '<span>' + T('ui.menu.start') + '</span>' + '<svg class="nt-ico" viewBox="0 0 24 24"><path d="M7 4l12 8-12 8z" fill="currentColor"/></svg>';
  }
  function drawPreview(cv, map, c1, c2) {
    const px = 132, d = Math.min(3, window.devicePixelRatio || 1), S = Math.round(px * d);
    cv.width = cv.height = S; cv.style.width = cv.style.height = px + 'px';
    const x = cv.getContext('2d');
    x.fillStyle = '#05060a'; x.fillRect(0, 0, S, S);
    if (!map) return;
    const k = S / Math.max(map.w, map.h), ox = (S - map.w * k) / 2, oy = (S - map.h * k) / 2;
    x.imageSmoothingEnabled = false;
    if (NT.Terrain && NT.Terrain.minimap) x.drawImage(NT.Terrain.minimap(map), ox, oy, map.w * k, map.h * k);
    x.fillStyle = 'rgba(141,151,173,.9)';
    for (const n of map.neutrals || []) { const dd = NT.DEFS[n.def], w = dd && dd.size ? dd.size[0] : 2, h = dd && dd.size ? dd.size[1] : 2; x.fillRect(ox + n.cx * k, oy + n.cy * k, w * k, h * k); }
    const cols = [c1, c2];
    for (let i = 0; i < map.starts.length; i++) {
      const s = map.starts[i], cx = ox + (s.cx + 1.5) * k, cy = oy + (s.cy + 1.5) * k;
      x.fillStyle = cols[i] || '#fff'; x.strokeStyle = '#05060a'; x.lineWidth = 2 * d;
      x.beginPath(); x.arc(cx, cy, 5 * d, 0, Math.PI * 2); x.fill(); x.stroke();
    }
  }
  function startMatch() {
    const s = menuSel;
    G().saveSettings({ faction: s.faction, enemy: s.enemy, difficulty: s.difficulty, map: s.map });
    G().start({ faction: s.faction, enemy: s.enemy, difficulty: s.difficulty, map: s.map === 'random' ? null : s.map });
  }

  // --------------------------------------------------------------------------
  // Pause + settings
  // --------------------------------------------------------------------------
  function pauseMenu() {
    const g = G(), p = panel('nt-pause');
    title(p, g.state === 'over' ? 'ui.p.over' : 'ui.p.title');
    const col = el('div', 'nt-pcol', p);
    bigBtn(col, 'ui.p.resume', back, 'primary');
    bigBtn(col, 'ui.p.restart', function () { G().restart(); });
    bigBtn(col, 'ui.p.settings', function () { push('settings'); });
    bigBtn(col, 'ui.menu.howto', function () { push('howto'); });
    if (g.state === 'playing' && g.me >= 0) {
      const sb = bigBtn(col, sure ? 'ui.p.sure' : 'ui.p.surrender', function () {
        if (!sure) { sure = true; txt(sb, T('ui.p.sure')); tog(sb, 'danger', true); return; }
        g.cmd({ type: 'surrender' }); stack = []; g.pause(false); render();
      }, 'warn');
    }
    bigBtn(col, 'ui.p.quit', function () { stack = []; G().stop(); });
  }
  function settingsMenu() {
    const g = G(), s = g.settings, p = panel('nt-settings');
    title(p, 'ui.s.title');
    const rows = el('div', 'nt-srows', p);
    const row = function (key) { const r = el('div', 'nt-srow', rows); el('span', 'nt-slab', r, T(key)); return el('div', 'nt-sctl', r); };
    const slider = function (key, field) {
      const c = row(key), i = el('input', 'nt-range', c);
      i.type = 'range'; i.min = 0; i.max = 100; i.step = 5; i.value = Math.round((s[field] || 0) * 100);
      const v = el('span', 'nt-sval', c, i.value);
      i.addEventListener('input', function () { v.textContent = i.value; s[field] = i.value / 100; quiet = true; NT.emit('settings', s); quiet = false; });
      i.addEventListener('change', function () { g.saveSettings(); });
    };
    const onoff = function (key, field) {
      chips(row(key), [{ v: true, label: T('ui.on') }, { v: false, label: T('ui.off') }], !!s[field], function (v) { const o = {}; o[field] = v; g.saveSettings(o); render(); });
    };
    slider('ui.s.sfx', 'sfx'); slider('ui.s.music', 'music');
    onoff('ui.s.mute', 'mute');
    chips(row('ui.s.lang'), [{ v: 'en', label: 'English' }, { v: 'zh', label: '简体中文' }], NT.lang, function (v) { NT.setLang(v); g.saveSettings({ lang: v }); });
    chips(row('ui.s.speed'), [0.5, 1, 1.5, 2, 3].map(function (v) { return { v: v, label: '×' + v }; }), g.speed, function (v) { g.setSpeed(v); g.saveSettings({ speed: v }); render(); });
    onoff('ui.s.edge', 'edgeScroll');
    onoff('ui.s.hints', 'hints');
    const f = el('div', 'nt-pfoot', p);
    bigBtn(f, 'ui.back', back, 'primary');
  }

  // --------------------------------------------------------------------------
  // How to play
  // --------------------------------------------------------------------------
  const KEYS = [['ui.k.lmb', 'ui.k.sel'], ['ui.k.rmb', 'ui.k.order'], ['A', 'ui.k.amove'], ['S', 'ui.k.stop'], ['H', 'ui.k.hold'], ['D', 'ui.k.deploy'],
    ['Ctrl+1–9 / 1–9', 'ui.k.group'], ['Q / W', 'ui.k.army'], ['Space', 'ui.k.alert'], ['B', 'ui.k.home'], ['ui.k.arrows', 'ui.k.scroll'],
    ['ui.k.wheel', 'ui.k.zoom'], ['Esc', 'ui.k.esc'], ['P', 'ui.k.pause'], ['M', 'ui.k.mute']];
  const TOUCH = ['ui.t.tap', 'ui.t.order', 'ui.t.pan', 'ui.t.box', 'ui.t.dbl', 'ui.t.sheet'];
  function howTo() {
    const p = panel('nt-howto');
    title(p, 'ui.how.title');
    const cols = el('div', 'nt-hcols', p);
    const left = el('div', 'nt-hcol', cols);
    for (const k of ['goal', 'eco', 'pow', 'build', 'turf', 'sp']) {
      const s = el('section', 'nt-hsec', left);
      el('h4', '', s, T('ui.how.' + k + '.h'));
      el('p', '', s, T('ui.how.' + k));
    }
    const right = el('div', 'nt-hcol', cols);
    const order = UI.compact ? ['touch', 'mouse'] : ['mouse', 'touch'];
    for (const o of order) {
      el('h4', 'nt-hk', right, T('ui.how.' + o));
      if (o === 'mouse') {
        const tb = el('div', 'nt-keys', right);
        const canDeploy = NT.FACTION_LIST.some(function (f) { return f.defs.some(function (d) { return d.traits.deploy; }); });
        for (const kk of KEYS) {
          if (kk[1] === 'ui.k.deploy' && !canDeploy) continue;        // no unit deploys yet: don't advertise a dead key
          el('kbd', '', tb, kk[0].indexOf('ui.') === 0 ? T(kk[0]) : kk[0]); el('span', '', tb, T(kk[1]));
        }
      } else {
        const ul = el('ul', 'nt-tlist', right);
        for (const t of TOUCH) el('li', '', ul, T(t));
      }
    }
    const f = el('div', 'nt-pfoot', p);
    bigBtn(f, stack.length > 1 ? 'ui.back' : 'ui.close', back, 'primary');
  }

  // --------------------------------------------------------------------------
  // Game over
  // --------------------------------------------------------------------------
  UI._showOver = function (res) {
    if (!res || G().state !== 'over') return;
    if (top() === 'pause' || top() === 'settings' || top() === 'howto') stack = [];
    else if (stack.length) return;
    wasPaused = G().paused;
    push('over');
  };
  function overScreen() {
    const g = G(), res = g.result, w = g.world;
    if (!res || !w) { stack = []; render(); return; }
    const spec = res.me < 0, won = !!res.won;
    const p = panel('nt-over ' + (spec ? 'spec' : won ? 'win' : 'lose'));
    const winner = w.players.find(function (pl) { return pl.team === res.winner; });
    el('h1', 'nt-otitle', p, T(spec ? 'ui.o.end' : won ? 'ui.o.win' : 'ui.o.lose'));
    el('p', 'nt-osub', p, spec ? T('ui.o.specSub', { name: winner ? winner.faction.name : '' }) : T(won ? 'ui.o.winSub' : 'ui.o.loseSub'));
    el('p', 'nt-otime', p, T('ui.o.time', { t: K.clock(res.ticks) }));
    const cols = ['produced', 'built', 'kills', 'lost', 'razed', 'income', 'spent'];
    const tbl = el('table', 'nt-otbl', p), hr = el('tr', '', el('thead', '', tbl));
    el('th', '', hr, T('ui.o.gang'));
    for (const c of cols) el('th', '', hr, T('ui.o.' + c));
    const tb = el('tbody', '', tbl);
    for (let i = 0; i < w.players.length; i++) {
      const pl = w.players[i], st = res.stats[i] || pl.stats, tr = el('tr', pl.team === res.winner ? 'won' : '', tb);
      const td = el('td', 'nt-ogang', tr), sw = el('i', '', td); css(sw, 'background', pl.color);
      el('b', '', td, NT.tr(pl.faction.name));
      el('span', '', td, i === res.me ? T('ui.o.you') : pl.ai ? T('ui.o.ai', { d: T('ui.diff.' + pl.ai) }) : '');
      for (const c of cols) el('td', '', tr, K.fmt(st[c] || 0));
    }
    const f = el('div', 'nt-pfoot', p);
    bigBtn(f, 'ui.o.watch', function () { stack = []; render(); }, 'ghost');
    bigBtn(f, 'ui.o.menu', function () { stack = []; G().stop(); });
    bigBtn(f, 'ui.o.again', function () { G().restart(); }, 'primary');
  }

  // --------------------------------------------------------------------------
  // First-game hints: generated from the player's own faction data by ROLE
  // --------------------------------------------------------------------------
  let hints = null;
  function startCount(p, test) {
    let n = 0;
    for (const b of p.faction.start.buildings) { const d = NT.DEFS[b.def]; if (d && test(d)) n++; }
    return n;
  }
  function ownedCount(p, test) { let n = 0; for (const id in p.owned) { const d = NT.DEFS[id]; if (d && test(d)) n += p.owned[id]; } return n; }
  UI._hintsStart = function () {
    const g = G(), p = g.player();
    hints = null;
    tog(H.hint, 'on', false);
    if (!p || !g.settings.hints) return;
    const f = p.faction, list = [];
    const buildable = f.defs.filter(function (d) { return d.kind === 'building' && d.queue; });
    const byCost = function (a, b) { return a.cost - b.cost; };
    const powerD = buildable.filter(function (d) { return d.role === 'power' && d.power > 0; }).sort(byCost)[0];
    const dropD = buildable.filter(function (d) { return d.traits.dropoff; }).sort(byCost)[0];
    const doorD = buildable.filter(function (d) {
      const pr = d.traits.producer;
      return pr && pr.queues.some(function (q) { return f.defs.some(function (u) { return u.kind === 'unit' && u.queue === q && K.armed(u) && !u.requires.length; }); });
    }).sort(byCost)[0];
    const isPow = function (d) { return d.role === 'power' && d.power > 0; }, isDrop = function (d) { return !!d.traits.dropoff; };
    if (powerD) { const base = startCount(p, isPow); list.push({ key: 'ui.h.power', vars: { name: powerD.name, power: f.powerName }, def: powerD, done: function () { return ownedCount(p, isPow) > base; } }); }
    if (dropD) { const base = startCount(p, isDrop); list.push({ key: dropD.traits.dropoff.freeUnit ? 'ui.h.drop' : 'ui.h.drop0', vars: { name: dropD.name }, def: dropD, done: function () { return ownedCount(p, isDrop) > base; } }); }
    if (doorD) list.push({ key: 'ui.h.army', vars: { name: doorD.name }, def: doorD, done: function () { return p.stats.produced >= 2; } });
    list.push({ key: 'move', vars: null, done: function () { return !!hints.moved; } });
    hints = { list: list, i: -1, moved: false, skip: {} };
    H.hint.textContent = '';
    hints.tag = el('span', 'nt-htag', H.hint);
    hints.txt = el('span', 'nt-htxt', H.hint);
    hints.ok = btn('nt-hbtn', H.hint); hints.off = btn('nt-hbtn ghost', H.hint);
    hints.ok.addEventListener('click', function () { if (hints && hints.list[hints.i]) hints.skip[hints.i] = true; UI._hintsTick(); });
    hints.off.addEventListener('click', function () { G().saveSettings({ hints: false }); endHints(); });
    UI._relabelHints();
  };
  function endHints() { if (hints && hints.hl) tog(hints.hl, 'nt-hl', false); hints = null; tog(H.hint, 'on', false); }
  UI._relabelHints = function () {
    if (!hints) return;
    txt(hints.ok, T('ui.h.ok')); txt(hints.off, T('ui.h.off'));
    hints.i = -2;
    UI._hintsTick();
  };
  UI._hintsTick = function () {
    if (!hints) return;
    if (!G().settings.hints) { endHints(); return; }
    let i = 0;
    while (i < hints.list.length && (hints.skip[i] || hints.list[i].done())) i++;
    if (i >= hints.list.length) { G().saveSettings({ hints: false }); endHints(); return; }
    if (i === hints.i) return;
    hints.i = i;
    const h = hints.list[i];
    txt(hints.tag, T('ui.h.tip', { i: i + 1, n: hints.list.length }));
    txt(hints.txt, h.key === 'move' ? T(UI.compact ? 'ui.h.moveTouch' : 'ui.h.move') : T(h.key, h.vars));
    if (hints.hl) tog(hints.hl, 'nt-hl', false);
    hints.hl = h.def && K.recBtn ? K.recBtn(h.def.id) : null;
    if (hints.hl) tog(hints.hl, 'nt-hl', true);
    tog(H.hint, 'on', true);
  };
  UI._hintsSim = function () { };
  NT.on('ui:cmd', function (c) { if (hints && c && (c.type === 'move' || c.type === 'amove' || c.type === 'attack')) hints.moved = true; });
})();
