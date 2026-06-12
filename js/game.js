'use strict';
// ============ Core sim + render. Night City: Pixel Edition ============
const SAVE_KEY = 'ncpx2077_v1';
let CV = null, C = null, G = null;

// ---- helpers ----
function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function lerp(a, b, f) { return a + (b - a) * f; }
function rnd(a, b) { return a + Math.random() * (b - a); }
function irnd(a, b) { return Math.floor(rnd(a, b + 1)); }
function pick(arr) { return arr[Math.random() * arr.length | 0]; }
function distPx(x0, y0, x1, y1) { return Math.hypot(x1 - x0, y1 - y0); }
function turnToward(cur, want, max) {
  const diff = ((want - cur) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return cur + clamp(diff, -max, max);
}
const FOV_HALF = 1.0; // ~57° half-angle view cone
function enemyRange(e) { return e.psycho ? 420 : e.bounty ? 230 : e.kind === 'gun' ? 185 : 160; }
function fmt(n) {
  n = Math.round(n); let s = String(Math.abs(n)), o = '';
  while (s.length > 3) { o = ',' + s.slice(-3) + o; s = s.slice(0, -3); }
  return (n < 0 ? '-' : '') + s + o;
}
function curWpn() { const id = G.loadout[G.slot]; return id ? WPN[id] : null; }

// ---- NCPX mod API: players become creators. See MODDING.md; mods load from mods/mods.js ----
const NCPX = {
  mods: [], hooks: {},
  registerMod(m) {
    this.mods.push(m);
    (m.weapons || []).forEach(w => { if (w.id && !WPN[w.id]) { WEAPONS.push(w); WPN[w.id] = w; } });
    (m.cars || []).forEach(cd => { if (cd.id && !CARD[cd.id]) { CARS.push(cd); CARD[cd.id] = cd; } });
    (m.cyber || []).forEach(cy => { if (cy.id && !CYB[cy.id]) { CYBER.push(cy); CYB[cy.id] = cy; } });
    (m.stations || []).forEach(st => SFX.stations.push(st));
    for (const k in (m.on || {})) (this.hooks[k] = this.hooks[k] || []).push(m.on[k]);
    if (typeof console !== 'undefined') console.log('[NCPX] mod loaded:', m.name || 'unnamed');
  },
  emit(name, data) {
    for (const fn of this.hooks[name] || []) {
      try { fn(data, G); } catch (e) { if (typeof console !== 'undefined') console.warn('[NCPX] mod hook error:', e); }
    }
  },
};
NCPX.mel = _mel; // melody helper from sfx.js, re-exported for station mods
window.NCPX = NCPX;
function hasSave() { try { return !!localStorage.getItem(SAVE_KEY); } catch (e) { return false; } }
function wipeSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

// ---- fresh state ----
function newGame() {
  return {
    state: 'title', titleMode: 'menu', ui: null, uiS: { sel: 0, scroll: 0, tab: 0, confirm: false },
    gender: 'm',
    t: 0, rt: 0, frame: 0, timeScale: 1,
    cam: { x: 0, y: 0 }, shake: 0,
    keys: new Set(), pressed: new Set(),
    mouse: { sx: 320, sy: 180, wx: 0, wy: 0, down: false, click: false, moved: false }, uiWheel: 0,
    p: null,
    eddies: 500, lvl: 1, xp: 0, maxdocs: 1,
    weapons: {}, loadout: [null, null, null], slot: 0,
    cars: {}, activeCar: null, car: null, driving: false, summonCd: 0,
    cyber: {}, os: null,
    enemies: [], bullets: [], parts: [], texts: [], pickups: [], crates: [], civs: [], slashes: [], glows: [],
    bounty: null, bountyT: 10, bountyCount: 0, psychoPending: 0,
    airdrop: null, airdropT: 90, talk: null, fade: null,
    skippyFound: false, skippyHintT: 0,
    msgs: [], bannerO: null, tipsQ: [], fixerT: 75,
    stats: { kills: 0, psychos: 0, bounties: 0, crates: 0, dist: 0, playT: 0, airdrops: 0 },
    saveT: 12, deadT: 0, deathFee: 0, hurtT: 0, flashT: 0, thunderT: rnd(18, 40),
    rain: [], prompt: null, lockTarget: null, lastDistrict: null,
  };
}

function makePlayer(x, y) {
  return {
    x, y, vx: 0, vy: 0, face: 'down', flip: false, anim: 0, moving: false,
    hp: 100, maxhp: 100, armor: 0,
    aim: 0, recoil: 0, fireCd: 0, reloadT: 0, useT: 0, iframes: 0, regenT: 0,
    dashT: 0, dashCd: 0, kzT: 0, trail: [],
    speedMult: 1, rofMult: 1, xpMult: 1, critCh: 0.05, smartTurn: 0, dashCdMult: 1,
    osT: 0, osCd: 0, camoT: 0, camoCd: 0, bioCd: 0, shCd: 0, buffT: 0, joyT: 0,
  };
}

// ---- save / load ----
function saveGame() {
  if (!G || !G.p) return;
  const d = {
    v: 1, gender: G.gender, eddies: G.eddies, lvl: G.lvl, xp: G.xp, maxdocs: G.maxdocs,
    px: G.p.x, py: G.p.y, hp: G.p.hp,
    weapons: Object.keys(G.weapons), loadout: G.loadout, slot: G.slot,
    cars: Object.keys(G.cars), activeCar: G.activeCar,
    cyber: G.cyber, os: G.os, stats: G.stats,
    skippyFound: G.skippyFound, bountyCount: G.bountyCount,
    dens: WORLD.dens.filter(dn => dn.cleared).map(dn => dn.id),
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(d)); } catch (e) {}
}

function applySave() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(SAVE_KEY)); } catch (e) {}
  if (!d) return false;
  G.gender = d.gender === 'f' ? 'f' : 'm';
  G.eddies = d.eddies; G.lvl = d.lvl; G.xp = d.xp; G.maxdocs = d.maxdocs;
  d.weapons.forEach(id => { if (WPN[id]) G.weapons[id] = { mag: WPN[id].mag || 0 }; });
  G.loadout = d.loadout.map(id => (id && G.weapons[id]) ? id : null);
  G.slot = d.slot || 0;
  d.cars.forEach(id => { if (CARD[id]) G.cars[id] = 1; });
  G.activeCar = d.activeCar && G.cars[d.activeCar] ? d.activeCar : null;
  G.cyber = d.cyber || {}; G.os = d.os || null;
  G.stats = Object.assign(G.stats, d.stats);
  G.skippyFound = !!d.skippyFound; G.bountyCount = d.bountyCount || 0;
  (d.dens || []).forEach(id => { const dn = WORLD.dens[id]; if (dn) { dn.cleared = true; dn.done = true; } });
  if (!WORLD.blockedPx(d.px, d.py)) { G.p.x = d.px; G.p.y = d.py; } // saves standing on old-version furniture fall back to spawn
  G.p.hp = d.hp || 100;
  return true;
}

function startGame(cont, gender) {
  const keep = G ? { keys: G.keys, mouse: G.mouse, rain: G.rain } : null;
  G = newGame();
  if (keep) { G.keys = keep.keys; G.mouse = keep.mouse; G.rain = keep.rain; }
  G.gender = gender === 'f' ? 'f' : 'm';
  G.p = makePlayer(WORLD.spawn.x, WORLD.spawn.y);
  G.crates = WORLD.crateSpots.map(s => ({ x: s.x, y: s.y, hp: 1, respT: 0 }));
  if (cont && applySave()) {
    recalcStats(); G.p.hp = clamp(G.p.hp, 1, G.p.maxhp);
    banner('WELCOME BACK TO NIGHT CITY', DISTRICTS[WORLD.districtAt(G.p.x, G.p.y)].name, '#05d9e8');
  } else {
    // random starter kit: one weapon, one ride
    const sw = pick(STARTER_WPNS), sc = pick(STARTER_CARS);
    giveWeapon(sw, true); G.loadout[0] = sw; G.slot = 0;
    G.cars[sc] = 1; G.activeCar = sc;
    recalcStats(); G.p.hp = G.p.maxhp;
    banner('NIGHT CITY', 'WAKE UP, SAMURAI. WE HAVE A CITY TO BURN', '#f9f002');
    msg('STARTER KIT: ' + WPN[sw].name + ' + ' + CARD[sc].name + ' [V]', '#2ecc71');
    TIPS.forEach((tip, i) => G.tipsQ.push({ at: 3 + i * 6, text: tip }));
    NCPX.emit('newgame', { gender: G.gender });
  }
  G.state = 'play'; G.ui = null;
  snapCam();
  maintainCivs();
}

function snapCam() {
  G.cam.x = clamp(G.p.x - VIEW_W / 2, 0, WORLD.W * TILE - VIEW_W);
  G.cam.y = clamp(G.p.y - VIEW_H / 2, 0, WORLD.H * TILE - VIEW_H);
}

// =================== boot & input ===================
function boot() {
  CV = document.getElementById('cv');
  C = CV.getContext('2d');
  C.imageSmoothingEnabled = false;
  genWorld();
  G = newGame();
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  window.addEventListener('keydown', e => {
    if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    G.keys.add(e.code); G.pressed.add(e.code);
    if (e.code === 'KeyM') { SFX.init(); msg('SOUND ' + (SFX.toggleMute() ? 'OFF' : 'ON'), '#8a93a6'); }
    if (G.state === 'play') {
      if (e.code === 'Escape') {
        if (G.ui) { G.ui = null; SFX.ui(); }
        else { G.ui = 'pause'; G.uiS = { sel: 0, scroll: 0, tab: 0, confirm: false }; }
      }
      if (e.code === 'Tab') {
        if (G.ui === 'inv') G.ui = null;
        else if (!G.ui) { G.ui = 'inv'; G.uiS = { sel: 0, scroll: 0, tab: 0, confirm: false }; SFX.ui(); }
      }
    }
  });
  window.addEventListener('keyup', e => G.keys.delete(e.code));
  CV.addEventListener('mousemove', e => {
    const r = CV.getBoundingClientRect();
    G.mouse.sx = (e.clientX - r.left) * (VIEW_W / r.width);
    G.mouse.sy = (e.clientY - r.top) * (VIEW_H / r.height);
    G.mouse.moved = true;
  });
  CV.addEventListener('mousedown', e => { SFX.init(); G.mouse.down = true; G.mouse.click = true; e.preventDefault(); });
  window.addEventListener('mouseup', () => { G.mouse.down = false; });
  CV.addEventListener('contextmenu', e => e.preventDefault());
  CV.addEventListener('wheel', e => {
    e.preventDefault();
    const d = Math.sign(e.deltaY);
    if (G.ui) G.uiWheel += d;
    else if (G.state === 'play') cycleSlot(d);
  }, { passive: false });

  // headless/screenshot support: ?autostart skips the title menu, ?demo fast-forwards into action
  const q = (window.location && window.location.search) || '';
  if (/autostart|demo/.test(q)) startGame(false, /v=f/.test(q) ? 'f' : 'm');
  else if (/charsel/.test(q)) G.titleMode = 'gender';
  else if (/indoor/.test(q)) { // screenshot helper: stand inside the gun shop
    startGame(false);
    G.p.x = WORLD.shops.guns.x; G.p.y = WORLD.shops.guns.y + 6;
    for (let i = 0; i < 90; i++) step(1 / 60);
    G.bannerO = null;
  } else if (/doorstep/.test(q)) { // screenshot helper: stand at the Afterlife door, outside
    startGame(false);
    const bs = WORLD.signs.find(s => s.text === 'AFTERLIFE');
    const r = WORLD.roofs[bs.roof];
    G.p.x = r.doorTx[0] * TILE + 8; G.p.y = (r.doorTy + 1) * TILE + 10;
    for (let i = 0; i < 90; i++) step(1 / 60);
    G.bannerO = null;
  } else if (/airdrop/.test(q)) { // screenshot helper: chase an airdrop in Dogtown
    startGame(false);
    G.airdropT = 0; spawnAirdrop();
    if (G.airdrop) { G.p.x = G.airdrop.x + 40; G.p.y = G.airdrop.y + 50; }
    for (let i = 0; i < 300; i++) step(1 / 60);
    G.bannerO = null;
  } else if (/jigjig/.test(q)) { // screenshot helper: Jig-Jig Street
    startGame(false);
    const jj = WORLD.npcs.find(n => n.kind === 'joy');
    if (jj) { G.p.x = jj.x + 14; G.p.y = jj.y + 12; }
    for (let i = 0; i < 90; i++) step(1 / 60);
    G.bannerO = null;
  }
  if (/demo/.test(q)) {
    G.eddies = 60000;
    G.cars.galena = 1; G.activeCar = 'galena';
    summonCar();
    spawnPack(G.p.x + 110, G.p.y - 30, 4, { alerted: true });
    for (let i = 0; i < 240; i++) step(1 / 60);
    if (G.car) { // scripted run-over so screenshots show vehicle combat + blood decals
      enterCar();
      G.car.a = 0; G.car.vx = 260; G.car.vy = 0;
      for (let k = 0; k < 3; k++) G.enemies.push(makeEnemy(G.car.x + 30 + k * 22, G.car.y + rnd(-4, 4), 1, 'scavs', 'melee', { alerted: true }));
      for (let i = 0; i < 80; i++) step(1 / 60);
      if (G.driving) exitCar();
      for (let i = 0; i < 30; i++) step(1 / 60);
    }
  }
  step(1 / 60); // paint one frame synchronously so load-time screenshots aren't black

  let last = performance.now();
  const loop = now => {
    const dt = clamp((now - last) / 1000, 0.001, 0.05);
    last = now;
    // crash shield: a bad frame (or a broken mod) must never freeze the game
    try { step(dt); } catch (err) {
      if (typeof console !== 'undefined') console.error('[NCPX] frame error:', err);
      try {
        C.fillStyle = 'rgba(60,0,12,0.85)'; C.fillRect(0, 150, VIEW_W, 36);
        drawTextC(C, 'SCRIPT ERROR — CHECK CONSOLE (F12), HARD-REFRESH (CTRL+SHIFT+R)', VIEW_W / 2, 158, '#ff5a5a', 1);
        drawTextC(C, String(err && err.message || err).slice(0, 90), VIEW_W / 2, 172, '#ffaaaa', 1);
      } catch (e2) {}
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

function fitCanvas() {
  // HiDPI-aware: pick an integer scale in DEVICE pixels so each game pixel maps to a
  // whole number of physical pixels (mac retina 2x, fractional Windows scaling, etc.)
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  let s = Math.min(w * dpr / VIEW_W, h * dpr / VIEW_H);
  if (s >= 1) s = Math.floor(s);
  CV.style.width = (VIEW_W * s / dpr) + 'px';
  CV.style.height = (VIEW_H * s / dpr) + 'px';
  // refit when the window moves to a display with a different pixel density
  if (window.matchMedia && fitCanvas._dpr !== dpr) {
    fitCanvas._dpr = dpr;
    try { window.matchMedia('(resolution: ' + dpr + 'dppx)').addEventListener('change', fitCanvas, { once: true }); } catch (e) {}
  }
}

function cycleSlot(d) {
  for (let k = 0; k < 3; k++) {
    G.slot = ((G.slot + d) % 3 + 3) % 3;
    if (G.loadout[G.slot]) break;
  }
  G.p.reloadT = 0; G.p.fireCd = Math.max(G.p.fireCd, 0.12);
  const w = curWpn(); if (w) msg('EQUIPPED: ' + w.name, RAR_COL[w.rar]);
}

// =================== main step ===================
function step(dt) {
  G.rt += dt; G.frame++;
  updateRain(dt);
  if (G.state === 'title') { render(); endFrame(); return; }
  if (G.state === 'dead') {
    G.deadT -= dt;
    if (G.deadT <= 0) respawn();
    render(); endFrame(); return;
  }
  // time dilation
  const p = G.p;
  let ts = 1;
  if (G.os === 'sandevistan' && p.osT > 0) ts = CYB.sandevistan.tiers[G.cyber.sandevistan - 1].ts;
  else if (p.kzT > 0 && G.cyber.kerenzikov) ts = CYB.kerenzikov.tiers[G.cyber.kerenzikov - 1].ts;
  G.timeScale = ts;
  const dtW = dt * ts, dtP = dt * lerp(ts, 1, 0.6);

  if (!G.ui) {
    G.t += dtW;
    G.stats.playT += dt;
    updatePlayer(dt, dtP);
    updateCar(dtW, dt);
    updateEnemies(dtW);
    updateBullets(dtW);
    updatePickups(dtW);
    updateCrates(dt);
    updateCivs(dtW);
    updateSpawns(dt);
    updateAirdrop(dt, dtW);
    updateTips(dt);
    // roof reveal + gang hideout ambushes
    const ptx = Math.floor(p.x / TILE), pty = Math.floor(p.y / TILE);
    for (const r of WORLD.roofs) {
      let inside = ptx >= r.tx0 && ptx <= r.tx1 && pty >= r.ty0 && pty <= r.ty1;
      // standing on the doorstep already fades the roof, so crossing the door never pops
      if (!inside && pty === r.doorTy + 1 && r.doorTx.indexOf(ptx) >= 0) inside = true;
      r.a += ((inside ? 0.04 : 1) - r.a) * Math.min(1, 9 * dt);
    }
    for (const dn of WORLD.dens) {
      if (!dn.done && ptx > dn.tx0 && ptx < dn.tx1 && pty > dn.ty0 && pty < dn.ty1) triggerDen(dn);
    }
    G.parts = G.parts.filter(pa => (pa.t -= dtW) > 0 && (pa.x += pa.vx * dtW, pa.y += pa.vy * dtW, pa.vy += (pa.grav || 0) * dtW, true));
    G.texts = G.texts.filter(tx => (tx.t -= dt) > 0 && (tx.y -= 14 * dt, true));
    G.slashes = G.slashes.filter(s => (s.t -= dtW) > 0);
    G.glows = G.glows.filter(g => (g.t -= dtW) > 0);
    // autosave
    G.saveT -= dt;
    if (G.saveT <= 0) { G.saveT = 12; saveGame(); }
    // fixer chatter
    G.fixerT -= dt;
    if (G.fixerT <= 0) { G.fixerT = rnd(80, 140); msg(pick(FIXER_LINES), '#8a93a6'); SFX.msg(); }
  }
  G.msgs = G.msgs.filter(m => (m.t -= dt) > 0);
  if (G.bannerO && (G.bannerO.t -= dt) <= 0) G.bannerO = null;
  if (G.fade && (G.fade.t += dt) >= G.fade.dur) G.fade = null;
  G.hurtT = Math.max(0, G.hurtT - dt * 2);
  G.flashT = Math.max(0, G.flashT - dt * 3);
  G.thunderT -= dt;
  if (G.thunderT <= 0) { G.thunderT = rnd(20, 50); G.flashT = 0.25; SFX.thunder(); }
  // camera
  const tgt = G.driving && G.car ? { x: G.car.x + G.car.vx * 0.35, y: G.car.y + G.car.vy * 0.35 }
    : { x: p.x + (G.mouse.sx - VIEW_W / 2) * 0.18, y: p.y + (G.mouse.sy - VIEW_H / 2) * 0.18 };
  G.cam.x = clamp(lerp(G.cam.x, tgt.x - VIEW_W / 2, Math.min(1, 6 * dt)), 0, WORLD.W * TILE - VIEW_W);
  G.cam.y = clamp(lerp(G.cam.y, tgt.y - VIEW_H / 2, Math.min(1, 6 * dt)), 0, WORLD.H * TILE - VIEW_H);
  if (G.shake > 0) {
    G.cam.x += rnd(-G.shake, G.shake); G.cam.y += rnd(-G.shake, G.shake);
    G.shake = Math.max(0, G.shake - dt * 30);
  }
  G.mouse.wx = G.mouse.sx + G.cam.x; G.mouse.wy = G.mouse.sy + G.cam.y;
  render();
  endFrame();
}

function endFrame() { G.pressed.clear(); G.mouse.click = false; G.mouse.moved = false; G.uiWheel = 0; }

function updateTips(dt) {
  for (const tip of G.tipsQ) {
    tip.at -= dt;
    if (tip.at <= 0 && !tip.done) { tip.done = true; msg(tip.text, '#05d9e8'); SFX.msg(); }
  }
  G.tipsQ = G.tipsQ.filter(t => !t.done);
}

// =================== player ===================
function updatePlayer(dt, dtP) {
  const p = G.p;
  p.iframes = Math.max(0, p.iframes - dt);
  p.fireCd = Math.max(0, p.fireCd - dtP);
  p.recoil = Math.max(0, p.recoil - dt * 3);
  p.osCd = Math.max(0, p.osCd - (p.osT > 0 ? 0 : dt));
  p.osT = Math.max(0, p.osT - dt);
  p.camoT = Math.max(0, p.camoT - dt); p.camoCd = Math.max(0, p.camoCd - dt);
  p.bioCd = Math.max(0, p.bioCd - dt); p.shCd = Math.max(0, p.shCd - dt);
  p.buffT = Math.max(0, p.buffT - dt); p.kzT = Math.max(0, p.kzT - dt);
  p.joyT = Math.max(0, p.joyT - dt);
  p.dashCd = Math.max(0, p.dashCd - dt);
  G.summonCd = Math.max(0, G.summonCd - dt);

  // passive regen after 6s out of combat
  p.regenT += dt;
  if (p.regenT > 6 && p.hp < p.maxhp) p.hp = Math.min(p.maxhp, p.hp + 3 * dt);
  // maxdoc use
  if (p.useT > 0) {
    p.useT -= dt;
    if (p.useT <= 0) { p.hp = Math.min(p.maxhp, p.hp + p.maxhp * 0.5); SFX.heal(); addTxt(p.x, p.y - 14, '+HP', '#2ecc71'); }
  }
  if (G.cyber.biomonitor && p.hp < p.maxhp * 0.3 && p.bioCd <= 0 && G.maxdocs > 0 && p.useT <= 0) {
    G.maxdocs--; p.useT = 0.4; p.bioCd = 45; msg('BIOMONITOR: MAXDOC AUTO-INJECTED', '#2ecc71');
  }
  if (press('KeyC') && G.maxdocs > 0 && p.useT <= 0 && p.hp < p.maxhp) { G.maxdocs--; p.useT = 1.0; SFX.drink(); }
  // OS ability
  if (press('KeyQ') && G.os && p.osCd <= 0 && p.osT <= 0) {
    const t = CYB[G.os].tiers[G.cyber[G.os] - 1];
    p.osT = t.dur; p.osCd = t.cd;
    if (G.os === 'sandevistan') { SFX.sande(true); banner('SANDEVISTAN', null, '#00ff9f'); }
    else { SFX.psycho(); banner('BERSERK', null, '#ff2a3c'); }
    recalcStats();
  }
  if (p.osT <= 0 && p.osWasOn) { recalcStats(); }
  p.osWasOn = p.osT > 0;
  // camo
  if (press('KeyF') && G.cyber.camo && p.camoCd <= 0) {
    const t = CYB.camo.tiers[0];
    p.camoT = t.dur; p.camoCd = t.cd; SFX.camo();
    for (const e of G.enemies) { e.alerted = false; e.state = 'idle'; }
    msg('OPTICAL CAMO ENGAGED', '#05d9e8');
  }
  // weapon slots
  if (press('Digit1') && G.loadout[0]) { G.slot = 0; cycleSlot(0); }
  if (press('Digit2') && G.loadout[1]) { G.slot = 1; cycleSlot(0); }
  if (press('Digit3') && G.loadout[2]) { G.slot = 2; cycleSlot(0); }
  // vehicle
  if (press('KeyV')) vehicleKey();
  // radio
  if (press('KeyN')) { SFX.init(); msg('RADIO: ' + SFX.cycleStation(), '#ff2a6d'); SFX.ui(); }

  if (G.driving) { interactScan(); return; }

  // movement
  let mx = (G.keys.has('KeyD') ? 1 : 0) - (G.keys.has('KeyA') ? 1 : 0);
  let my = (G.keys.has('KeyS') ? 1 : 0) - (G.keys.has('KeyW') ? 1 : 0);
  const mlen = Math.hypot(mx, my);
  if (mlen > 0) { mx /= mlen; my /= mlen; }
  let spd = 95 * p.speedMult * (p.buffT > 0 ? 1.25 : 1);
  // dash
  if (press('Space') && p.dashCd <= 0 && mlen > 0) {
    p.dashT = 0.18; p.dashCd = 0.9 * p.dashCdMult; p.iframes = Math.max(p.iframes, 0.25);
    if (G.cyber.kerenzikov) p.kzT = CYB.kerenzikov.tiers[G.cyber.kerenzikov - 1].dur + 0.18;
    SFX.dash();
  }
  if (p.dashT > 0) { p.dashT -= dt; spd *= 3.1; p.trail.push({ x: p.x, y: p.y, t: 0.25, face: p.face, flip: p.flip }); }
  p.trail = p.trail.filter(tr => (tr.t -= dt) > 0);
  p.vx = mx * spd; p.vy = my * spd;
  p.moving = mlen > 0;
  moveCollide(p, p.vx * dtP, p.vy * dtP, 5);
  if (p.moving) { p.anim += dtP * 9; G.stats.dist += Math.hypot(p.vx, p.vy) * dtP; }

  // aim & face
  p.aim = Math.atan2(G.mouse.wy - p.y, G.mouse.wx - p.x);
  const ca = Math.cos(p.aim), sa = Math.sin(p.aim);
  if (Math.abs(ca) > Math.abs(sa)) { p.face = 'side'; p.flip = ca > 0; }
  else { p.face = sa > 0 ? 'down' : 'up'; }

  // smart lock
  G.lockTarget = null;
  const w = curWpn();
  if (w && w.kind === 'smart' && p.smartTurn > 0) {
    let best = null, bd = 1e9;
    for (const e of G.enemies) {
      if (e.dead) continue;
      const d = distPx(p.x, p.y, e.x, e.y);
      if (d > 270) continue;
      let da = Math.abs(((Math.atan2(e.y - p.y, e.x - p.x) - p.aim) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      if (da < 0.55 && d < bd && WORLD.losClear(p.x, p.y, e.x, e.y)) { best = e; bd = d; }
    }
    G.lockTarget = best;
  }
  // fire / reload
  if (press('KeyR')) startReload();
  if (p.reloadT > 0) {
    p.reloadT -= dtP;
    if (p.reloadT <= 0 && w && !MELEE_CLS[w.cls]) { G.weapons[w.id].mag = w.mag; SFX.reload(); }
  }
  if (G.mouse.down && w && !G.ui) tryFire(w);

  // district banner
  const dk = WORLD.districtAt(p.x, p.y);
  if (dk !== G.lastDistrict) {
    G.lastDistrict = dk;
    const d = DISTRICTS[dk];
    banner(d.name, 'DANGER ' + '★'.repeat(d.danger), d.col);
  }
  // skippy
  if (!G.skippyFound) {
    const sd = distPx(p.x, p.y, WORLD.skippySpot.x, WORLD.skippySpot.y);
    G.skippyHintT = Math.max(0, G.skippyHintT - dt);
    if (sd < 480 && G.skippyHintT <= 0) { G.skippyHintT = 18; msg('YOU HEAR A MUFFLED, CHEERFUL VOICE NEARBY...', '#f9f002'); }
    if (sd < 22) {
      G.skippyFound = true; giveWeapon('skippy');
      banner('SKIPPY ACQUIRED!', 'SKIPPY: HI! I\'M SKIPPY! LET\'S BE BEST FRIENDS!', '#f9f002');
      SFX.levelup(); saveGame();
    }
  }
  interactScan();
}

function moveCollide(ent, dx, dy, r) {
  if (dx && !WORLD.blockedPx(ent.x + dx + Math.sign(dx) * r, ent.y - r * 0.6) && !WORLD.blockedPx(ent.x + dx + Math.sign(dx) * r, ent.y + r * 0.6)) ent.x += dx;
  if (dy && !WORLD.blockedPx(ent.x - r * 0.6, ent.y + dy + Math.sign(dy) * r) && !WORLD.blockedPx(ent.x + r * 0.6, ent.y + dy + Math.sign(dy) * r)) ent.y += dy;
  ent.x = clamp(ent.x, 8, WORLD.W * TILE - 8); ent.y = clamp(ent.y, 8, WORLD.H * TILE - 8);
}

const SHOP_PROMPTS = {
  guns: 'BROWSE IRON — WILSON',
  ripper: 'GET CHROMED — VIKTOR',
  cars: 'BROWSE RIDES — DAKOTA',
  bar: 'ORDER A DRINK — CLAIRE',
};

function interactScan() {
  G.prompt = null;
  const p = G.p;
  for (const k of ['guns', 'ripper', 'cars', 'bar']) {
    const s = WORLD.shops[k];
    if (distPx(p.x, p.y, s.x, s.y) < 26) {
      G.prompt = '[E] ' + SHOP_PROMPTS[k];
      if (press('KeyE')) { G.ui = k === 'bar' ? 'bar' : k; G.uiS = { sel: 0, scroll: 0, tab: 0, confirm: false }; SFX.ui(); }
      return;
    }
  }
  if (G.airdrop && G.airdrop.state === 'landed' && distPx(p.x, p.y, G.airdrop.x, G.airdrop.y) < 24) {
    G.prompt = '[E] CRACK AIRDROP';
    if (press('KeyE')) openAirdrop();
    return;
  }
  for (const n of WORLD.npcs) {
    if ((n.kind === 'joy' || n.kind === 'doll') && distPx(p.x, p.y, n.x, n.y) < 22) {
      G.prompt = '[E] TALK — ' + n.name;
      if (press('KeyE')) openTalk(n);
      return;
    }
  }
  for (const v of WORLD.vends) {
    if (distPx(p.x, p.y, v.x, v.y) < 22) {
      G.prompt = '[E] MAXDOC — €$50' + (G.maxdocs >= 5 ? ' (FULL)' : '');
      if (press('KeyE')) vendBuy();
      return;
    }
  }
  if (!G.driving && G.car && !G.car.dead && distPx(p.x, p.y, G.car.x, G.car.y) < 30) {
    G.prompt = '[E/V] ENTER VEHICLE';
    if (press('KeyE')) enterCar();
  }
}

function vendBuy() {
  if (G.maxdocs >= 5) { msg('MAXDOC POUCH FULL', '#ff5a5a'); SFX.deny(); return; }
  if (G.eddies < 50) { msg('NOT ENOUGH EDDIES', '#ff5a5a'); SFX.deny(); return; }
  G.eddies -= 50; G.maxdocs++; SFX.drink(); msg('MAXDOC +1', '#2ecc71');
}

function barSelect(i) {
  if (i === 0) {
    if (G.eddies < 100) { msg('NOT ENOUGH EDDIES', '#ff5a5a'); SFX.deny(); return; }
    G.eddies -= 100; G.p.hp = G.p.maxhp; G.p.buffT = 20; SFX.drink(); SFX.heal();
    msg('TO JOHNNY. FULL HP + SPEED BUFF', '#ff2a6d'); G.ui = null;
  } else if (i === 1) vendBuy();
  else { G.ui = null; SFX.ui(); }
}

// =================== combat ===================
function startReload() {
  const w = curWpn();
  if (!w || MELEE_CLS[w.cls]) return;
  const st = G.weapons[w.id];
  if (st.mag >= w.mag || G.p.reloadT > 0) return;
  G.p.reloadT = w.rel;
}

function tryFire(w) {
  const p = G.p;
  if (p.fireCd > 0 || p.useT > 0) return;
  if (MELEE_CLS[w.cls]) { swingMelee(w); return; }
  const st = G.weapons[w.id];
  if (p.reloadT > 0) return;
  if (st.mag <= 0) { startReload(); return; }
  st.mag--;
  p.fireCd = 1 / (w.rof * p.rofMult);
  p.recoil = Math.min(1, p.recoil + 0.25);
  SFX.shoot(w.cls);
  alertNearby(p.x, p.y, 240);
  const n = w.pellets || 1;
  const dmgMult = (G.os === 'berserk' && p.osT > 0) ? CYB.berserk.tiers[G.cyber.berserk - 1].dmg : 1;
  for (let i = 0; i < n; i++) {
    const a = p.aim + (rnd(-w.spread, w.spread) * Math.PI / 180);
    const crit = Math.random() < p.critCh + (w.crit || 0) + (p.joyT > 0 ? 0.05 : 0);
    G.bullets.push({
      x: p.x + Math.cos(p.aim) * 8, y: p.y - 2 + Math.sin(p.aim) * 8,
      vx: Math.cos(a) * w.spd, vy: Math.sin(a) * w.spd,
      dmg: w.dmg * dmgMult * (crit ? 1.8 : 1), crit, from: 'p',
      pierce: w.pierce || 0, wallPierce: !!w.wallPierce, life: 1.5,
      col: w.kind === 'smart' ? '#ff7ab8' : w.kind === 'tech' ? '#7af2ff' : '#ffe9a0',
      homing: (w.kind === 'smart' && G.lockTarget && !G.lockTarget.dead) ? G.lockTarget : null,
      turn: (w.homing || 0) + p.smartTurn, aoe: w.aoe || 0, kb: w.kb || 0, burn: w.burn,
    });
  }
  G.glows.push({ x: p.x + Math.cos(p.aim) * 12, y: p.y - 2 + Math.sin(p.aim) * 12, r: 14, col: '#ffd27a', t: 0.05 });
  if (st.mag <= 0) startReload();
}

function swingMelee(w) {
  const p = G.p;
  p.fireCd = 1 / (w.rof * p.rofMult);
  p.recoil = Math.min(1, p.recoil + 0.3);
  SFX.shoot(w.cls);
  const dmgMult = (G.os === 'berserk' && p.osT > 0) ? CYB.berserk.tiers[G.cyber.berserk - 1].dmg : 1;
  G.slashes.push({ x: p.x, y: p.y, a: p.aim, t: 0.16, range: w.range + 6, col: w.cls === 'mantis' ? '#ff2a3c' : w.cls === 'wire' ? '#05d9e8' : '#dfe6f2' });
  let hitAny = false;
  for (const e of G.enemies) {
    if (e.dead) continue;
    const d = distPx(p.x, p.y, e.x, e.y);
    if (d > w.range + (e.psycho ? 14 : 6)) continue;
    let da = Math.abs(((Math.atan2(e.y - p.y, e.x - p.x) - p.aim) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
    if (da > (w.arc / 2) * Math.PI / 180) continue;
    const crit = Math.random() < p.critCh + (w.crit || 0) + (p.joyT > 0 ? 0.05 : 0);
    const sneakM = e.alerted ? 1 : 2.5;
    if (sneakM > 1) addTxt(e.x, e.y - 20, 'TAKEDOWN', '#f9f002');
    damageEnemy(e, w.dmg * dmgMult * sneakM * (crit ? 1.8 : 1), crit, p.aim, w.kb || 140, w.burn);
    hitAny = true;
    if (G.os === 'berserk' && p.osT > 0) p.hp = Math.min(p.maxhp, p.hp + 2);
  }
  for (const cr of G.crates) {
    if (cr.hp > 0 && distPx(p.x, p.y, cr.x, cr.y) < w.range + 6) breakCrate(cr);
  }
  if (hitAny) { SFX.hit(); G.shake = Math.max(G.shake, 1.5); }
}

function updateBullets(dt) {
  const p = G.p;
  for (const b of G.bullets) {
    if (b.dead) continue;
    b.life -= dt;
    if (b.life <= 0) { b.dead = true; continue; }
    if (b.homing && !b.homing.dead && b.turn > 0) {
      const want = Math.atan2(b.homing.y - b.y, b.homing.x - b.x);
      const cur = Math.atan2(b.vy, b.vx);
      let diff = ((want - cur) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
      const na = cur + clamp(diff, -b.turn * dt, b.turn * dt);
      const sp = Math.hypot(b.vx, b.vy);
      b.vx = Math.cos(na) * sp; b.vy = Math.sin(na) * sp;
    }
    const steps = 2, sx = b.vx * dt / steps, sy = b.vy * dt / steps;
    for (let s = 0; s < steps && !b.dead; s++) {
      b.x += sx; b.y += sy;
      if (!b.wallPierce && WORLD.solidPx(b.x, b.y)) { impact(b); b.dead = true; break; }
      if (b.from === 'p') {
        for (const e of G.enemies) {
          if (e.dead || e.hitBy === b) continue;
          if (distPx(b.x, b.y, e.x, e.y - 4) < (e.psycho ? 13 : 6.5)) {
            damageEnemy(e, b.dmg * (e.alerted ? 1 : 1.5), b.crit, Math.atan2(b.vy, b.vx), b.kb, b.burn);
            e.hitBy = b;
            if (b.aoe) { explode(b.x, b.y, b.aoe, b.dmg, 'p'); b.dead = true; }
            else if (b.pierce > 0) b.pierce--;
            else b.dead = true;
            break;
          }
        }
        for (const cr of G.crates) {
          if (cr.hp > 0 && distPx(b.x, b.y, cr.x, cr.y) < 8) { breakCrate(cr); if (!b.pierce) b.dead = true; }
        }
      } else {
        if (G.driving && G.car && distPx(b.x, b.y, G.car.x, G.car.y) < 12) { damageCar(b.dmg); b.dead = true; break; }
        if (!G.driving && p.iframes <= 0 && distPx(b.x, b.y, p.x, p.y - 4) < 6) { damagePlayer(b.dmg); b.dead = true; break; }
      }
    }
    if (b.aoe && b.dead && !b.exploded) { b.exploded = true; explode(b.x, b.y, b.aoe, b.dmg, b.from); }
  }
  G.bullets = G.bullets.filter(b => !b.dead);
}

function impact(b) {
  addP(3, b.x, b.y, { col: '#8a93a6', sp: 40, life: 0.2 });
  if (b.aoe && !b.exploded) { b.exploded = true; explode(b.x, b.y, b.aoe, b.dmg, b.from); }
}

function explode(x, y, r, dmg, from) {
  SFX.explode(); G.shake = Math.max(G.shake, 5);
  G.glows.push({ x, y, r: r * 1.6, col: '#ff9f1c', t: 0.25 });
  addP(24, x, y, { col: '#ff9f1c', sp: 130, life: 0.5, grav: 60 });
  addP(12, x, y, { col: '#3a3a44', sp: 60, life: 0.8 });
  for (const e of G.enemies) {
    if (e.dead) continue;
    const d = distPx(x, y, e.x, e.y);
    if (d < r + 8) damageEnemy(e, dmg * (1 - d / (r + 20)) * 1.5, false, Math.atan2(e.y - y, e.x - x), 220);
  }
  const pd = distPx(x, y, G.p.x, G.p.y);
  if (from !== 'p' || pd < r * 0.5) {
    if (pd < r + 6 && G.p.iframes <= 0 && !G.driving) damagePlayer(dmg * 0.5 * (1 - pd / (r + 20)));
  }
  for (const cr of G.crates) if (cr.hp > 0 && distPx(x, y, cr.x, cr.y) < r + 8) breakCrate(cr);
}

function damageEnemy(e, dmg, crit, dir, kb, burn) {
  if (e.dead) return;
  e.hp -= dmg;
  e.hitT = 0.08;
  e.alerted = true; e.alertT = 5; e.lkx = G.p.x; e.lky = G.p.y; // pain reveals roughly where it came from
  if (dir != null) e.lastHitDir = dir;
  if (kb && !e.psycho) { e.kbx += Math.cos(dir || 0) * kb; e.kby += Math.sin(dir || 0) * kb; }
  if (burn) e.burnT = 2;
  addTxt(e.x + rnd(-4, 4), e.y - 14, String(Math.round(dmg)), crit ? '#f9f002' : '#e8f6ff');
  addP(crit ? 6 : 3, e.x, e.y - 4, { col: '#a01828', sp: 70, life: 0.35, grav: 100, dir, cone: 0.8 });
  if (Math.random() < 0.2) bloodStain(e.x, e.y, dir, 0.12);
  if (crit) SFX.crit(); else SFX.hit();
  if (e.hp <= 0) killEnemy(e);
}

function killEnemy(e) {
  e.dead = true;
  SFX.kill();
  G.stats.kills++;
  addP(14, e.x, e.y - 4, { col: '#a01828', sp: 100, life: 0.5, grav: 120, dir: e.lastHitDir, cone: 1.2 });
  addP(6, e.x, e.y - 4, { col: '#ff2a3c', sp: 60, life: 0.3, dir: e.lastHitDir, cone: 1.4 });
  bloodStain(e.x, e.y, e.lastHitDir, e.psycho ? 1.6 : 0.7);
  xpGain(8 + 6 * e.tier + (e.psycho ? 350 : 0));
  // eddies
  const amt = Math.round((10 + 8 * e.tier) * rnd(0.8, 1.3)) * (e.psycho ? 8 : 1);
  G.pickups.push({ kind: 'ed', amt, x: e.x + rnd(-6, 6), y: e.y + rnd(-6, 6), vx: rnd(-20, 20), vy: rnd(-20, 20), t: 30 });
  // weapon drops
  if (e.psycho) {
    G.stats.psychos++;
    const next = ICONICS.find(id => !G.weapons[id]);
    if (next) G.pickups.push({ kind: 'wpn', id: next, x: e.x, y: e.y, vx: 0, vy: 0, t: 120 });
    else G.pickups.push({ kind: 'ed', amt: 5000, x: e.x, y: e.y, vx: 0, vy: 0, t: 120 });
    banner('CYBERPSYCHO NEUTRALIZED', e.name + ' — ' + (next ? 'DROPPED: ' + WPN[next].name : '+€$5,000'), '#bd00ff');
    SFX.levelup();
  } else if (Math.random() < 0.09) {
    const pool = WEAPONS.filter(w => !w.iconic && !w.granted && !w.hidden && w.lvl <= G.lvl + 3 && w.price > 0);
    const unowned = pool.filter(w => !G.weapons[w.id]);
    const w = pick(unowned.length && Math.random() < 0.65 ? unowned : pool);
    if (w) G.pickups.push({ kind: 'wpn', id: w.id, x: e.x, y: e.y, vx: 0, vy: 0, t: 60 });
  } else if (Math.random() < 0.05) {
    G.pickups.push({ kind: 'doc', x: e.x, y: e.y, vx: 0, vy: 0, t: 60 });
  }
  // skippy chatter
  const w = curWpn();
  if (w && w.id === 'skippy' && Math.random() < 0.14) msg(pick(SKIPPY_LINES), '#f9f002');
  // gang den clear bonus
  if (e.denId != null) {
    const dn = WORLD.dens[e.denId];
    if (dn && --dn.left <= 0 && !dn.cleared) {
      dn.cleared = true;
      const bonus = 120 + 90 * e.tier;
      G.eddies += bonus;
      msg('HIDEOUT CLEARED: +€$' + fmt(bonus), '#2ecc71');
      xpGain(30 + 12 * e.tier);
      SFX.buy();
    }
  }
  // bounty tracking
  if (e.bounty && G.bounty) {
    G.bounty.left--;
    if (G.bounty.left <= 0) completeBounty();
  }
  G.p.regenT = Math.min(G.p.regenT, 4);
  NCPX.emit('kill', { enemy: e });
}

function damagePlayer(dmg) {
  const p = G.p;
  if (p.iframes > 0) return;
  let armor = p.armor + ((G.os === 'berserk' && p.osT > 0) ? CYB.berserk.tiers[G.cyber.berserk - 1].armor : 0);
  dmg = dmg * 100 / (100 + armor);
  p.hp -= dmg;
  p.iframes = 0.3; p.regenT = 0;
  G.hurtT = 1; G.shake = Math.max(G.shake, 2.5);
  SFX.hurt();
  if (p.hp <= 0) {
    if (G.cyber.second_heart && p.shCd <= 0) {
      p.hp = p.maxhp; p.shCd = 180; p.iframes = 1.5;
      banner('SECOND HEART', 'CLINICAL DEATH REVERSED', '#ff2a6d'); SFX.levelup();
      return;
    }
    killPlayer();
  }
}

function killPlayer() {
  G.state = 'dead'; G.deadT = 3.2;
  G.deathFee = Math.min(5000, Math.round(G.eddies * 0.1));
  G.driving = false;
  SFX.explode();
}

function respawn() {
  const p = G.p;
  G.eddies = Math.max(0, G.eddies - G.deathFee);
  p.hp = p.maxhp; p.iframes = 2;
  p.x = WORLD.spawn.x; p.y = WORLD.spawn.y;
  snapCam();
  G.state = 'play';
  G.enemies = G.enemies.filter(e => e.bounty || e.psycho);
  for (const e of G.enemies) e.alerted = false;
  banner('BACK ON YOUR FEET', 'TRAUMA TEAM SENDS THEIR REGARDS', '#05d9e8');
  saveGame();
}

function xpGain(n) {
  n = Math.round(n * G.p.xpMult * (G.p.joyT > 0 ? 1.15 : 1));
  G.xp += n;
  addTxt(G.p.x, G.p.y - 18, '+' + n + ' XP', '#05d9e8');
  while (G.xp >= xpFor(G.lvl)) {
    G.xp -= xpFor(G.lvl);
    G.lvl++;
    recalcStats();
    G.p.hp = Math.min(G.p.maxhp, G.p.hp + G.p.maxhp * 0.4);
    banner('STREET CRED UP — LV ' + G.lvl, 'NEW GEAR UNLOCKED AT VENDORS', '#f9f002');
    SFX.levelup();
    NCPX.emit('levelup', { lvl: G.lvl });
    saveGame();
  }
}

function alertNearby(x, y, r) {
  for (const e of G.enemies) if (!e.dead && distPx(x, y, e.x, e.y) < r) {
    e.alerted = true; e.alertT = Math.max(e.alertT, 3.5);
    e.lkx = x; e.lky = y; // they heard it — investigate the noise
  }
  for (const cv of G.civs) if (distPx(x, y, cv.x, cv.y) < r) cv.fleeT = 3;
}

// =================== enemies ===================
function makeEnemy(x, y, tier, fac, kind, opts) {
  const hp = Math.round((26 + tier * 22) * (kind === 'heavy' ? 1.8 : 1) * ((opts && opts.psycho) ? 16 : 1));
  return Object.assign({
    x, y, vx: 0, vy: 0, hp, maxhp: hp, tier, fac, kind,
    state: 'idle', alerted: false, aimT: 0, shootCd: rnd(0.5, 1.5), wanderT: 0,
    face: 'down', flip: false, anim: 0, hitT: 0, kbx: 0, kby: 0, burnT: 0, burnTick: 0, roCd: 0,
    dead: false, bounty: false, psycho: false, name: FACTIONS[fac].name,
    chargeT: 0, burstT: 0,
    lookA: rnd(0, Math.PI * 2), detect: 0, seen: false, lkx: null, lky: null, alertT: 0, flashT: 0,
  }, opts || {});
}

function updateEnemies(dt) {
  const p = G.p;
  const px = G.driving && G.car ? G.car.x : p.x, py = G.driving && G.car ? G.car.y : p.y;
  for (const e of G.enemies) {
    if (e.dead) continue;
    e.hitT = Math.max(0, e.hitT - dt);
    e.roCd = Math.max(0, e.roCd - dt);
    e.shootCd -= dt; e.aimT = Math.max(0, e.aimT - dt);
    // burn dot
    if (e.burnT > 0) {
      e.burnT -= dt; e.burnTick -= dt;
      if (e.burnTick <= 0) { e.burnTick = 0.4; damageEnemy(e, 4, false); addP(2, e.x, e.y - 6, { col: '#ff9f1c', sp: 30, life: 0.3, grav: -60 }); }
      if (e.dead) continue;
    }
    // knockback decay
    if (e.kbx || e.kby) {
      moveCollide(e, e.kbx * dt, e.kby * dt, 5);
      e.kbx *= Math.max(0, 1 - 8 * dt); e.kby *= Math.max(0, 1 - 8 * dt);
      if (Math.abs(e.kbx) < 4) e.kbx = 0; if (Math.abs(e.kby) < 4) e.kby = 0;
    }
    const d = distPx(e.x, e.y, px, py);
    // despawn strays (den dwellers stay home)
    if (d > 950 && !e.bounty && !e.psycho && e.denId == null) { e.dead = true; e.silent = true; continue; }

    // ---- field of view: facing cone + wall occlusion + proximity sense ----
    const aToV = Math.atan2(py - e.y, px - e.x);
    const range = enemyRange(e);
    let seen = false;
    if (p.camoT <= 0) {
      const prox = G.driving ? 55 : 30;
      const da = Math.abs(((aToV - e.lookA) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      const inCone = d < prox || (d < range && (da < FOV_HALF || e.psycho)) || (G.driving && (G.carSpd || 0) > 140 && d < 230);
      if (inCone) seen = WORLD.losClear(e.x, e.y - 4, px, py - 4);
    }
    e.seen = seen;
    if (seen) {
      e.detect = e.psycho ? 1 : Math.min(1, e.detect + dt * (1.2 + (1 - Math.min(1, d / range)) * 2.2));
      e.lookA = turnToward(e.lookA, aToV, 3.5 * dt); // suspicion: turn toward V
      if (e.detect >= 1) {
        if (!e.alerted) {
          e.alerted = true; e.flashT = 0.7; SFX.spot();
          for (const o of G.enemies) if (!o.dead && o !== e && distPx(e.x, e.y, o.x, o.y) < 90) { o.alerted = true; o.alertT = 4; o.lkx = px; o.lky = py; }
        }
        e.lkx = px; e.lky = py; e.alertT = 4.5;
      }
    } else {
      e.detect = Math.max(0, e.detect - dt * 0.45);
      if (e.alerted) { e.alertT -= dt; if (e.alertT <= 0) e.alerted = false; }
    }
    e.flashT = Math.max(0, e.flashT - dt);

    let mvx = 0, mvy = 0, spd = e.psycho ? 75 : e.kind === 'heavy' ? 42 : 58;

    if (!e.alerted) {
      if (e.detect > 0.12) { /* freeze and stare toward the noise */ }
      else {
        e.wanderT -= dt;
        if (e.wanderT <= 0) { e.wanderT = rnd(1.5, 4); const a = rnd(0, Math.PI * 2); e.wx = Math.cos(a); e.wy = Math.sin(a); if (Math.random() < 0.4) { e.wx = 0; e.wy = 0; } }
        mvx = (e.wx || 0) * 0.4; mvy = (e.wy || 0) * 0.4;
      }
    } else {
      // chase what they can see; otherwise sweep to the last known position
      const tx2 = seen ? px : (e.lkx != null ? e.lkx : px);
      const ty2 = seen ? py : (e.lky != null ? e.lky : py);
      const aTo = Math.atan2(ty2 - e.y, tx2 - e.x);
      const dT = distPx(e.x, e.y, tx2, ty2);
      e.lookA = turnToward(e.lookA, aTo, 6 * dt);
      if (e.psycho) {
        e.chargeT -= dt; e.burstT -= dt;
        if (e.chargeT <= 0 && dT < 360 && dT > 60) { e.chargeT = 5; e.kbx = Math.cos(aTo) * 320; e.kby = Math.sin(aTo) * 320; SFX.dash(); }
        if (seen && e.burstT <= 0 && d < 320) {
          e.burstT = 3.6;
          for (let k = 0; k < 14; k++) {
            const a = k / 14 * Math.PI * 2;
            G.bullets.push({ x: e.x, y: e.y - 4, vx: Math.cos(a) * 200, vy: Math.sin(a) * 200, dmg: 8 + 2 * e.tier, from: 'e', life: 2, col: '#bd00ff', pierce: 0, turn: 0 });
          }
          SFX.shoot('shotgun');
        }
        if (d < 24 && p.iframes <= 0 && !G.driving) damagePlayer(14 + 2 * e.tier);
        mvx = Math.cos(aTo); mvy = Math.sin(aTo);
      } else if (e.kind !== 'melee') {
        // gunner: keep distance band when V is visible, else sweep to last known
        if (!seen) {
          if (dT > 16) { mvx = Math.cos(aTo); mvy = Math.sin(aTo); }
          else e.lookA += 1.5 * dt; // reached it: scan around
        } else {
          if (d > 180) { mvx = Math.cos(aTo); mvy = Math.sin(aTo); }
          else if (d < 90) { mvx = -Math.cos(aTo); mvy = -Math.sin(aTo); }
          else { mvx = Math.cos(aTo + Math.PI / 2) * 0.4 * (e.strafe || (e.strafe = Math.random() < 0.5 ? 1 : -1)); mvy = Math.sin(aTo + Math.PI / 2) * 0.4 * e.strafe; }
          if (d < 260 && e.shootCd <= 0) {
            if (e.aimT <= 0 && !e.aiming) { e.aiming = true; e.aimT = 0.4; }
            else if (e.aiming && e.aimT <= 0) {
              e.aiming = false;
              e.shootCd = e.kind === 'heavy' ? 2.2 : rnd(1.2, 2);
              const shots = e.kind === 'heavy' ? 5 : 3;
              for (let k = 0; k < shots; k++) {
                const a = aToV + rnd(-8, 8) * Math.PI / 180;
                G.bullets.push({ x: e.x, y: e.y - 4, vx: Math.cos(a) * 230, vy: Math.sin(a) * 230, dmg: (e.kind === 'heavy' ? 7 : 5) + 2 * e.tier, from: 'e', life: 1.6, col: '#ff5a7a', pierce: 0, turn: 0 });
              }
              SFX.shoot(e.kind === 'heavy' ? 'shotgun' : 'smg');
            }
          }
        }
      } else {
        // melee rusher
        mvx = Math.cos(aTo); mvy = Math.sin(aTo);
        if (d < 20) {
          if (e.aimT <= 0 && !e.aiming) { e.aiming = true; e.aimT = 0.28; }
          else if (e.aiming && e.aimT <= 0) {
            e.aiming = false;
            if (distPx(e.x, e.y, px, py) < 26 && p.iframes <= 0 && !G.driving) damagePlayer(7 + 2.5 * e.tier);
            G.slashes.push({ x: e.x, y: e.y, a: aToV, t: 0.12, range: 20, col: '#ff5a7a' });
          }
          mvx = 0; mvy = 0;
        } else if (!seen && dT < 16) { mvx = 0; mvy = 0; e.lookA += 1.5 * dt; }
      }
    }
    const ml = Math.hypot(mvx, mvy);
    if (ml > 0) {
      moveCollide(e, mvx / ml * spd * dt, mvy / ml * spd * dt, 5);
      e.anim += dt * 8;
      if (!e.alerted && !seen) e.lookA = Math.atan2(mvy, mvx); // look where you walk
      if (Math.abs(mvx) > Math.abs(mvy)) { e.face = 'side'; e.flip = mvx > 0; }
      else e.face = mvy > 0 ? 'down' : 'up';
    }
  }
  // soft separation so packs don't stack into one blob
  for (let i = 0; i < G.enemies.length; i++) {
    const a = G.enemies[i]; if (a.dead) continue;
    for (let j = i + 1; j < G.enemies.length; j++) {
      const b = G.enemies[j]; if (b.dead) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0.01 && d < 9) {
        const push = (9 - d) / 2, nx = dx / d, ny = dy / d;
        moveCollide(a, -nx * push, -ny * push, 4);
        moveCollide(b, nx * push, ny * push, 4);
      }
    }
  }
  // clean dead
  G.enemies = G.enemies.filter(e => !e.dead);
}

function findSpot(cx, cy, rMin, rMax) {
  for (let k = 0; k < 30; k++) {
    const a = rnd(0, Math.PI * 2), r = rnd(rMin, rMax);
    const x = clamp(cx + Math.cos(a) * r, 100, WORLD.W * TILE - 100);
    const y = clamp(cy + Math.sin(a) * r, 100, WORLD.H * TILE - 100);
    if (!WORLD.solidPx(x, y) && WORLD.tileAt(x, y) < 5) return { x, y }; // outdoors only
  }
  return null;
}

// =================== airdrops (Dogtown) ===================
function spawnAirdrop() {
  for (let k = 0; k < 80; k++) {
    const tx = irnd(8, 40), ty = irnd(80, 114);
    if (WORLD.solidAt(tx, ty) || WORLD.t[ty * WORLD.W + tx] >= 5) continue;
    const x = tx * TILE + 8, y = ty * TILE + 8;
    if (WORLD.districtAt(x, y) !== 'dogtown') continue;
    G.airdrop = { x, y, alt: 360, state: 'falling', t: 0 };
    banner('AIRDROP INBOUND', 'MILITECH SUPPLY DROP OVER DOGTOWN — RACE THE BARGHEST', '#ff6a00');
    msg('REGINA: AIRDROP ON MILITECH FREQUENCIES. SOUTH-WEST, MOVE', '#ff6a00');
    SFX.msg();
    return;
  }
  G.airdropT = 30; // no spot found, retry soon
}

function updateAirdrop(dt, dtW) {
  if (!G.airdrop) {
    G.airdropT -= dt;
    if (G.airdropT <= 0) spawnAirdrop();
    return;
  }
  const a = G.airdrop;
  if (a.state === 'falling') {
    a.alt -= 65 * dtW;
    if (a.alt <= 0) {
      a.alt = 0; a.state = 'landed'; a.t = 90;
      SFX.explode(); G.shake = Math.max(G.shake, 3);
      addP(14, a.x, a.y, { col: '#8a7a5a', sp: 80, life: 0.5 });
      spawnPack(a.x, a.y, irnd(3, 4), { alerted: true, alertT: 12, lkx: a.x, lky: a.y });
      msg('SUPPLY DROP LANDED — BARGHEST CONVERGING', '#ff6a00');
    }
  } else {
    a.t -= dt;
    if (a.t <= 0) {
      G.airdrop = null; G.airdropT = rnd(150, 240);
      msg('BARGHEST SECURED THE AIRDROP. NEXT TIME, MERC', '#8a93a6');
    }
  }
}

function openAirdrop() {
  const a = G.airdrop;
  G.airdrop = null; G.airdropT = rnd(150, 240);
  G.stats.airdrops = (G.stats.airdrops || 0) + 1;
  for (let k = 0; k < 5; k++)
    G.pickups.push({ kind: 'ed', amt: Math.round((60 + 10 * G.lvl) * rnd(0.8, 1.3)), x: a.x + rnd(-8, 8), y: a.y + rnd(-8, 8), vx: rnd(-30, 30), vy: rnd(-30, 30), t: 60 });
  G.pickups.push({ kind: 'doc', x: a.x, y: a.y - 6, vx: 0, vy: 0, t: 60 });
  // rarity-boosted gear
  const pool = WEAPONS.filter(w => !w.iconic && !w.granted && !w.hidden && w.price > 0 && w.lvl <= G.lvl + 5);
  const un = pool.filter(w => !G.weapons[w.id]);
  const hi = (un.length ? un : pool).filter(w => w.rar >= 2);
  const w = pick(hi.length ? hi : (un.length ? un : pool));
  if (w) G.pickups.push({ kind: 'wpn', id: w.id, x: a.x, y: a.y + 6, vx: 0, vy: 0, t: 90 });
  addP(16, a.x, a.y, { col: '#ff9f1c', sp: 90, life: 0.5 });
  banner('AIRDROP SECURED', 'MILITECH SUPPLIES: GEAR + EDDIES', '#ff6a00');
  SFX.buy(); SFX.levelup();
  xpGain(25 + 8 * G.lvl);
  saveGame();
}

// =================== joytoys & dolls ===================
function openTalk(n) {
  G.ui = 'talk';
  G.uiS = { sel: 0, scroll: 0, tab: 0, confirm: false };
  G.talk = { npc: n, text: pick(n.kind === 'doll' ? DOLL_GREET : JOY_GREET) };
  SFX.ui();
}
function talkOptions(n) {
  return n.kind === 'doll' ? ['TALK', 'BRAINDANCE BLISS — €$300', 'LEAVE'] : ['FLIRT', 'GOOD TIME — €$100', 'LEAVE'];
}
function talkSelect(i) {
  const n = G.talk.npc;
  if (i === 0) { G.talk.text = pick(n.kind === 'doll' ? DOLL_LINES : JOY_LINES); SFX.ui(); return; }
  if (i === 1) {
    const price = n.kind === 'doll' ? 300 : 100;
    if (G.eddies < price) { msg('NOT ENOUGH EDDIES', '#ff5a5a'); SFX.deny(); return; }
    G.eddies -= price;
    G.ui = null; G.talk = null;
    G.fade = { t: 0, dur: 2.8, label: 'SOME TIME LATER...' };
    const p = G.p;
    p.hp = p.maxhp; p.iframes = 4;
    p.joyT = n.kind === 'doll' ? 120 : 60;
    msg((n.kind === 'doll' ? 'CLOUD NINE' : 'EUPHORIA') + ': +CRIT +XP, FULLY RESTED', '#ff2a6d');
    SFX.heal();
    saveGame();
    return;
  }
  G.ui = null; G.talk = null; SFX.ui();
}

function triggerDen(dn) {
  dn.done = true;
  const wx = (dn.tx0 + 1) * TILE, wy = (dn.ty0 + 1) * TILE;
  const dist = DISTRICTS[WORLD.districtAt(wx, wy)];
  const tier = dist.danger + Math.floor(G.lvl / 4);
  const spots = [];
  for (let ty = dn.ty0 + 1; ty < dn.ty1; ty++) for (let tx = dn.tx0 + 1; tx < dn.tx1; tx++)
    if (WORLD.t[ty * WORLD.W + tx] === 5) spots.push({ x: tx * TILE + 8, y: ty * TILE + 8 });
  const want = Math.min(spots.length, irnd(2, 4));
  dn.left = 0;
  for (let k = 0; k < want && spots.length; k++) {
    const s = spots.splice(Math.random() * spots.length | 0, 1)[0];
    if (distPx(s.x, s.y, G.p.x, G.p.y) < 26) continue; // never on top of V
    if (WORLD.blockedPx(s.x, s.y)) continue;           // never inside furniture
    G.enemies.push(makeEnemy(s.x, s.y, tier, dist.fac, Math.random() < 0.5 ? 'gun' : 'melee', { denId: dn.id }));
    dn.left++;
  }
  if (dn.left > 0) { msg('GANG HIDEOUT — TAKE THEM OUT, CLAIM THE BONUS', '#ff9f1c'); SFX.msg(); }
  else dn.cleared = true;
}

function spawnPack(x, y, n, opts) {
  const fac = DISTRICTS[WORLD.districtAt(x, y)].fac;
  const danger = DISTRICTS[WORLD.districtAt(x, y)].danger;
  const tier = danger + Math.floor(G.lvl / 4);
  for (let i = 0; i < n; i++) {
    const s = findSpot(x, y, 8, 60); if (!s) continue;
    const gun = Math.random() < FACTIONS[fac].gun;
    const heavy = tier >= 3 && Math.random() < 0.18;
    G.enemies.push(makeEnemy(s.x, s.y, tier, fac, heavy ? 'heavy' : gun ? 'gun' : 'melee', opts));
  }
  return tier;
}

function updateSpawns(dt) {
  // ambient packs
  G.ambientT = (G.ambientT || 0) - dt;
  if (G.ambientT <= 0) {
    G.ambientT = 5;
    const ambient = G.enemies.filter(e => !e.bounty && !e.psycho).length;
    if (ambient < 8) {
      const s = findSpot(G.p.x, G.p.y, 420, 640);
      if (s) spawnPack(s.x, s.y, irnd(2, 3));
    }
  }
  // bounties
  if (!G.bounty) {
    G.bountyT -= dt;
    if (G.bountyT <= 0) {
      if (G.psychoPending > 0) { G.psychoPending = 0; spawnPsycho(); }
      else spawnBounty();
    }
  } else if (G.bounty.psycho) {
    const ps = G.enemies.find(e => e.psycho);
    if (ps) { G.bounty.x = ps.x; G.bounty.y = ps.y; }
    else if (!G.enemies.some(e => e.psycho)) { /* killed; completeBounty handled via left */ }
  }
}

function spawnBounty() {
  const s = findSpot(G.p.x, G.p.y, 520, 900);
  if (!s) { G.bountyT = 5; return; }
  const n = 4 + Math.min(6, Math.floor(G.lvl / 2));
  const tier = spawnPack(s.x, s.y, n, { bounty: true });
  const danger = DISTRICTS[WORLD.districtAt(s.x, s.y)].danger;
  G.bounty = { x: s.x, y: s.y, left: G.enemies.filter(e => e.bounty).length, reward: Math.round(280 * danger + 45 * G.lvl), psycho: false };
  msg('REGINA: BOUNTY POSTED — ' + G.bounty.left + ' TARGETS, €$' + fmt(G.bounty.reward), '#ff9f1c');
  SFX.msg();
}

function spawnPsycho() {
  const s = findSpot(G.p.x, G.p.y, 420, 700);
  if (!s) { G.bountyT = 5; return; }
  const danger = DISTRICTS[WORLD.districtAt(s.x, s.y)].danger;
  const tier = danger + 2 + Math.floor(G.lvl / 4);
  const name = PSYCHO_NAMES[G.stats.psychos % PSYCHO_NAMES.length];
  G.enemies.push(makeEnemy(s.x, s.y, tier, 'maelstrom', 'gun', { psycho: true, bounty: true, name, alerted: true }));
  G.bounty = { x: s.x, y: s.y, left: 1, reward: 1200 + 400 * danger, psycho: true };
  banner('CYBERPSYCHO SIGHTING', name + ' — APPROACH WITH EVERYTHING YOU HAVE', '#bd00ff');
  SFX.psycho();
}

function completeBounty() {
  const b = G.bounty;
  G.bounty = null;
  G.bountyT = rnd(26, 40);
  G.bountyCount++;
  G.stats.bounties++;
  G.eddies += b.reward;
  xpGain(40 + 20 * G.lvl);
  msg('BOUNTY COMPLETE: +€$' + fmt(b.reward), '#2ecc71');
  SFX.buy();
  if (!b.psycho) {
    // guaranteed gear drop at site
    const pool = WEAPONS.filter(w => !w.iconic && !w.granted && !w.hidden && w.lvl <= G.lvl + 3 && w.price > 0);
    const unowned = pool.filter(w => !G.weapons[w.id]);
    const w = pick(unowned.length ? unowned : pool);
    if (w) G.pickups.push({ kind: 'wpn', id: w.id, x: b.x, y: b.y, vx: 0, vy: 0, t: 90 });
    if (G.bountyCount % 3 === 0) { G.psychoPending = 1; G.bountyT = 7; msg('REGINA: PICKING UP A PSYCHO SIGNAL... STAND BY', '#bd00ff'); }
  }
  NCPX.emit('bounty', { reward: b.reward, psycho: b.psycho });
  saveGame();
}

// =================== pickups / crates / civs ===================
function updatePickups(dt) {
  const p = G.p;
  for (const pk of G.pickups) {
    pk.t -= dt;
    const d = distPx(pk.x, pk.y, p.x, p.y);
    if (d < 52 && d > 1 && !G.driving) { pk.vx = (p.x - pk.x) / d * 130; pk.vy = (p.y - pk.y) / d * 130; }
    pk.x += (pk.vx || 0) * dt; pk.y += (pk.vy || 0) * dt;
    pk.vx *= Math.max(0, 1 - 3 * dt); pk.vy *= Math.max(0, 1 - 3 * dt);
    if (d < 12 && !G.driving) {
      pk.t = -1;
      if (pk.kind === 'ed') { G.eddies += pk.amt; addTxt(p.x, p.y - 16, '+€$' + fmt(pk.amt), '#f9f002'); SFX.coin(); }
      else if (pk.kind === 'doc') {
        if (G.maxdocs < 5) { G.maxdocs++; msg('MAXDOC +1', '#2ecc71'); }
        else { G.eddies += 25; addTxt(p.x, p.y - 16, '+€$25', '#f9f002'); }
        SFX.coin();
      } else if (pk.kind === 'wpn') giveWeapon(pk.id);
    }
  }
  G.pickups = G.pickups.filter(pk => pk.t > 0);
}

function breakCrate(cr) {
  if (cr.hp <= 0) return;
  cr.hp = 0; cr.respT = 90;
  G.stats.crates++;
  addP(8, cr.x, cr.y, { col: '#5a4632', sp: 80, life: 0.4, grav: 140 });
  SFX.hit();
  const r = Math.random();
  if (r < 0.72) G.pickups.push({ kind: 'ed', amt: irnd(15, 60), x: cr.x, y: cr.y, vx: rnd(-10, 10), vy: rnd(-10, 10), t: 30 });
  else if (r < 0.85) G.pickups.push({ kind: 'doc', x: cr.x, y: cr.y, vx: 0, vy: 0, t: 30 });
  else {
    const pool = WEAPONS.filter(w => !w.iconic && !w.granted && !w.hidden && w.lvl <= G.lvl + 2 && w.price > 0 && !G.weapons[w.id]);
    if (pool.length && Math.random() < 0.4) G.pickups.push({ kind: 'wpn', id: pick(pool).id, x: cr.x, y: cr.y, vx: 0, vy: 0, t: 60 });
    else G.pickups.push({ kind: 'ed', amt: irnd(30, 90), x: cr.x, y: cr.y, vx: 0, vy: 0, t: 30 });
  }
}

function updateCrates(dt) {
  for (const cr of G.crates) {
    if (cr.hp <= 0) { cr.respT -= dt; if (cr.respT <= 0) cr.hp = 1; }
  }
}

function maintainCivs() {
  while (G.civs.length < 10) {
    const s = findSpot(G.p.x, G.p.y, 180, 460);
    if (!s) break;
    G.civs.push({ x: s.x, y: s.y, i: irnd(0, 5), anim: 0, face: 'down', flip: false, wanderT: 0, fleeT: 0, wx: 0, wy: 0 });
  }
}

function updateCivs(dt) {
  const p = G.p;
  for (const cv of G.civs) {
    if (distPx(cv.x, cv.y, p.x, p.y) > 700) { cv.gone = true; continue; }
    cv.fleeT = Math.max(0, cv.fleeT - dt);
    cv.wanderT -= dt;
    if (cv.wanderT <= 0) { cv.wanderT = rnd(2, 5); const a = rnd(0, Math.PI * 2); cv.wx = Math.cos(a); cv.wy = Math.sin(a); if (Math.random() < 0.35) { cv.wx = 0; cv.wy = 0; } }
    let vx = cv.wx * 28, vy = cv.wy * 28;
    if (cv.fleeT > 0) { const a = Math.atan2(cv.y - p.y, cv.x - p.x); vx = Math.cos(a) * 95; vy = Math.sin(a) * 95; }
    if (vx || vy) {
      moveCollide(cv, vx * dt, vy * dt, 4);
      cv.anim += dt * 7;
      if (Math.abs(vx) > Math.abs(vy)) { cv.face = 'side'; cv.flip = vx > 0; } else cv.face = vy > 0 ? 'down' : 'up';
    }
  }
  G.civs = G.civs.filter(cv => !cv.gone);
  G.civT = (G.civT || 0) - dt;
  if (G.civT <= 0) { G.civT = 3; maintainCivs(); }
}

// =================== vehicles ===================
function vehicleKey() {
  if (G.driving) { exitCar(); return; }
  if (G.car && !G.car.dead && distPx(G.p.x, G.p.y, G.car.x, G.car.y) < 34) { enterCar(); return; }
  summonCar();
}

function summonCar() {
  if (!G.activeCar) { msg('NO VEHICLE OWNED — VISIT NC AUTOFIXER [A]', '#ff5a5a'); SFX.deny(); return; }
  if (G.summonCd > 0) { msg('VEHICLE INBOUND IN ' + Math.ceil(G.summonCd) + 'S', '#8a93a6'); return; }
  // find nearest road px
  let best = null, bd = 1e9;
  for (let r = 1; r < 30; r++) {
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2;
      const x = G.p.x + Math.cos(a) * r * 16, y = G.p.y + Math.sin(a) * r * 16;
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      if (tx >= 0 && ty >= 0 && tx < WORLD.W && ty < WORLD.H && WORLD.t[ty * WORLD.W + tx] === 0) {
        const d = distPx(x, y, G.p.x, G.p.y);
        if (d < bd) { bd = d; best = { x: tx * TILE + 8, y: ty * TILE + 8 }; }
      }
    }
    if (best) break;
  }
  if (!best) { msg('NO ROAD ACCESS HERE', '#ff5a5a'); return; }
  G.car = { id: G.activeCar, x: best.x, y: best.y, a: -Math.PI / 2, vx: 0, vy: 0, hp: CARD[G.activeCar].hp, dead: false };
  G.summonCd = 15;
  addP(10, best.x, best.y, { col: '#05d9e8', sp: 60, life: 0.4 });
  msg(CARD[G.activeCar].name + ' DELIVERED', '#00ff9f');
  SFX.buy();
}

function enterCar() { G.driving = true; SFX.ui(); }

function exitCar() {
  const c = G.car;
  G.driving = false;
  if (!c) return;
  const a = c.a + Math.PI / 2;
  for (const off of [a, a + Math.PI, c.a, c.a + Math.PI]) {
    const x = c.x + Math.cos(off) * 22, y = c.y + Math.sin(off) * 22;
    if (!WORLD.blockedPx(x, y)) { G.p.x = x; G.p.y = y; break; }
  }
  SFX.engine(false, 0);
}

function runOverHit(e, sp, dir) {
  if (e.roCd > 0) return; // one big hit per pass, not 60 ticks of contact
  e.roCd = 0.5;
  SFX.squish();
  G.shake = Math.max(G.shake, Math.min(6, sp / 55));
  addP(Math.round(10 + sp / 22), e.x, e.y - 4, { col: '#a01828', sp: sp * 0.55, life: 0.6, grav: 140, dir, cone: 0.85 });
  addP(7, e.x, e.y - 4, { col: '#ff2a3c', sp: sp * 0.35, life: 0.35, dir, cone: 1.1 });
  bloodStain(e.x, e.y, dir, Math.min(1.6, sp / 200));
  if (G.car) G.car.bloodT = 0.9;
  if (e.psycho) damageCar(35); // hitting a cyberpsycho hurts the ride too
  damageEnemy(e, sp * 0.45, sp > 240, dir, Math.min(420, sp * 1.2));
}

function damageCar(dmg) {
  if (!G.car || G.car.dead) return;
  G.car.hp -= dmg;
  if (G.car.hp <= 0) {
    G.car.dead = true;
    explode(G.car.x, G.car.y, 60, 50, 'e');
    if (G.driving) { G.driving = false; G.p.x = G.car.x; G.p.y = G.car.y; G.p.iframes = 1; damagePlayer(30); }
    msg('VEHICLE DESTROYED — RESUMMON WHEN READY', '#ff5a5a');
    G.car = null;
    SFX.engine(false, 0);
  }
}

function updateCar(dt, rdt) {
  const c = G.car;
  if (!c || c.dead) { SFX.engine(false, 0); return; }
  const def = CARD[c.id];
  if (G.driving) {
    const fwdIn = (G.keys.has('KeyW') ? 1 : 0) - (G.keys.has('KeyS') ? 0.6 : 0);
    const steer = (G.keys.has('KeyD') ? 1 : 0) - (G.keys.has('KeyA') ? 1 : 0);
    const hb = G.keys.has('Space');
    const hx = Math.cos(c.a), hy = Math.sin(c.a);
    let fwd = hx * c.vx + hy * c.vy, lat = -hy * c.vx + hx * c.vy;
    fwd += def.acc * fwdIn * dt;
    fwd *= Math.max(0, 1 - 0.5 * dt);
    fwd = clamp(fwd, -def.top * 0.3, def.top);
    lat *= Math.max(0, 1 - (hb ? 3.2 : def.grip * 13) * dt);
    c.a += steer * 2.5 * dt * clamp(Math.abs(fwd) / 130, 0, 1) * Math.sign(fwd || 1) * (hb ? 1.5 : 1);
    c.vx = hx * fwd - hy * lat; c.vy = hy * fwd + hx * lat;
    const nx = c.x + c.vx * dt, ny = c.y + c.vy * dt;
    // corner collision
    const hw = def.bike ? 4 : 7, hl = def.bike ? 10 : 13;
    let blocked = false;
    for (const [ox, oy] of [[hl, 0], [-hl, 0], [0, hw], [0, -hw]]) {
      const wx2 = nx + hx * ox - hy * oy, wy2 = ny + hy * ox + hx * oy;
      if (WORLD.blockedPx(wx2, wy2)) { blocked = true; break; }
    }
    if (blocked) {
      const sp = Math.hypot(c.vx, c.vy);
      if (sp > 130) { damageCar(sp * 0.16); G.shake = Math.max(G.shake, 3); addP(8, c.x + hx * hl, c.y + hy * hl, { col: '#ffd27a', sp: 90, life: 0.3 }); SFX.hit(); }
      c.vx *= -0.32; c.vy *= -0.32;
    } else { c.x = nx; c.y = ny; }
    G.stats.dist += Math.hypot(c.vx, c.vy) * dt;
    // mow down enemies — hit test against the car's oriented body, not a point
    const sp = Math.hypot(c.vx, c.vy);
    G.carSpd = sp;
    const rhw = (def.bike ? 4 : 8), rhl = (def.bike ? 11 : 15);
    for (const e of G.enemies) {
      if (e.dead) continue;
      const dx = e.x - c.x, dy = e.y - c.y;
      if (dx * dx + dy * dy > 1100) continue;
      const lx = hx * dx + hy * dy, ly = -hy * dx + hx * dy; // into car-local frame
      if (Math.abs(lx) < rhl && Math.abs(ly) < rhw) {
        if (sp > 70) {
          runOverHit(e, sp, Math.atan2(c.vy, c.vx));
          c.vx *= e.psycho ? 0.75 : 0.93; c.vy *= e.psycho ? 0.75 : 0.93;
        } else {
          const a = Math.atan2(dy, dx);
          e.kbx += Math.cos(a) * 120; e.kby += Math.sin(a) * 120; // low speed: shove aside
        }
      }
    }
    // civilians dive out of the way instead of clipping through
    for (const cv2 of G.civs) {
      const dx = cv2.x - c.x, dy = cv2.y - c.y;
      if (dx * dx + dy * dy > 1100) continue;
      const lx = hx * dx + hy * dy, ly = -hy * dx + hx * dy;
      if (Math.abs(lx) < rhl && Math.abs(ly) < rhw) {
        const a = Math.atan2(dy, dx);
        cv2.x += Math.cos(a) * 3; cv2.y += Math.sin(a) * 3;
        cv2.fleeT = 3;
      }
    }
    if (sp > 110) alertNearby(c.x, c.y, 200);
    // bloody tire tracks for a moment after a run-over; smear fades as blood wears off
    if ((c.bloodT || 0) > 0) {
      c.bloodT -= dt;
      if (sp > 50) {
        const wc = worldCtx(), nx = -hy, ny = hx;
        wc.fillStyle = 'rgba(110,12,22,' + (0.42 * Math.min(1, c.bloodT / 0.6)).toFixed(2) + ')';
        const span = sp * dt, n2 = Math.max(1, Math.round(span / 2));
        for (let k = 0; k < n2; k++) {
          const back = 9 + (k / n2) * span;
          const bx = c.x - hx * back, by = c.y - hy * back;
          wc.fillRect(Math.round(bx + nx * 4 + rnd(-0.6, 0.6)) - 1, Math.round(by + ny * 4) - 1, 2, 2);
          wc.fillRect(Math.round(bx - nx * 4) - 1, Math.round(by - ny * 4 + rnd(-0.6, 0.6)) - 1, 2, 2);
        }
      }
    }
    // skids
    if (hb && sp > 90) addP(1, c.x - hx * 10, c.y - hy * 10, { col: '#0c0c10', sp: 4, life: 1.2 });
    SFX.engine(true, clamp(sp / def.top, 0, 1));
    G.p.x = c.x; G.p.y = c.y; // keep player synced under the hood
  } else {
    G.carSpd = 0;
    c.vx *= Math.max(0, 1 - 3 * dt); c.vy *= Math.max(0, 1 - 3 * dt);
    c.x += c.vx * dt; c.y += c.vy * dt;
    SFX.engine(false, 0);
  }
}

// =================== economy ===================
function giveWeapon(id, silent) {
  const w = WPN[id];
  if (!w) return;
  if (G.weapons[id]) {
    const scrap = Math.max(10, Math.round(w.price * 0.25));
    G.eddies += scrap;
    if (!silent) msg('DUPLICATE ' + w.name + ' SCRAPPED: +€$' + fmt(scrap), '#8a93a6');
    return;
  }
  G.weapons[id] = { mag: w.mag || 0 };
  const slot = G.loadout.indexOf(null);
  if (slot >= 0) G.loadout[slot] = id;
  if (!silent) {
    msg('ACQUIRED: ' + w.name + ' [' + RAR_NAME[w.rar] + ']', RAR_COL[w.rar]);
    SFX.buy();
    const owned = WEAPONS.filter(x => G.weapons[x.id]).length;
    if (owned === WEAPONS.length) banner('COLLECTION COMPLETE', 'EVERY WEAPON IN NIGHT CITY IS YOURS', '#f9f002');
  }
}

function buyWeapon(id) {
  const w = WPN[id];
  if (G.weapons[id]) { SFX.deny(); return; }
  if (G.lvl < w.lvl) { msg('REQUIRES LEVEL ' + w.lvl, '#ff5a5a'); SFX.deny(); return; }
  if (G.eddies < w.price) { msg('NOT ENOUGH EDDIES', '#ff5a5a'); SFX.deny(); return; }
  G.eddies -= w.price;
  giveWeapon(id);
  saveGame();
}

function buyCar(id) {
  const car = CARD[id];
  if (G.cars[id]) { setActiveCar(id); return; }
  if (G.eddies < car.price) { msg('NOT ENOUGH EDDIES', '#ff5a5a'); SFX.deny(); return; }
  G.eddies -= car.price;
  G.cars[id] = 1;
  G.activeCar = id;
  msg('PURCHASED: ' + car.name + ' — [V] TO SUMMON', '#00ff9f');
  SFX.buy();
  const owned = CARS.filter(x => G.cars[x.id]).length;
  if (owned === CARS.length) banner('GARAGE COMPLETE', 'EVERY RIDE IN NIGHT CITY IS YOURS', '#00ff9f');
  saveGame();
}

function setActiveCar(id) {
  if (!G.cars[id]) return;
  G.activeCar = id;
  msg('ACTIVE VEHICLE: ' + CARD[id].name, '#00ff9f');
  SFX.ui();
  saveGame();
}

function buyCyber(id) {
  const cy = CYB[id];
  const tier = G.cyber[id] || 0;
  if (cy.os && tier && G.os !== id) {
    G.os = id; msg('OS ACTIVE: ' + cy.name, '#05d9e8'); SFX.install(); recalcStats(); saveGame(); return;
  }
  if (tier >= cy.tiers.length) { SFX.deny(); return; }
  const t = cy.tiers[tier];
  if (G.lvl < t.lvl) { msg('REQUIRES LEVEL ' + t.lvl, '#ff5a5a'); SFX.deny(); return; }
  if (G.eddies < t.price) { msg('NOT ENOUGH EDDIES', '#ff5a5a'); SFX.deny(); return; }
  G.eddies -= t.price;
  G.cyber[id] = tier + 1;
  if (cy.os && !tier) G.os = id;
  if (cy.grants) giveWeapon(cy.grants);
  msg('INSTALLED: ' + cy.name + ' MK.' + (tier + 1), '#05d9e8');
  SFX.install();
  recalcStats();
  saveGame();
}

function assignSlot(id, k) {
  if (!G.weapons[id]) return;
  const old = G.loadout.indexOf(id);
  if (old >= 0) G.loadout[old] = G.loadout[k];
  G.loadout[k] = id;
  G.slot = k;
  msg('SLOT ' + (k + 1) + ': ' + WPN[id].name, RAR_COL[WPN[id].rar]);
  SFX.ui();
}

function recalcStats() {
  const p = G.p;
  if (!p) return;
  const T = id => G.cyber[id] || 0;
  const tv = (id, f) => T(id) ? CYB[id].tiers[T(id) - 1][f] : null;
  const oldMax = p.maxhp;
  p.maxhp = 100 + (G.lvl - 1) * 6 + (tv('titanium', 'hp') || 0);
  p.hp = clamp(p.hp + Math.max(0, p.maxhp - oldMax), 1, p.maxhp);
  p.armor = (tv('subdermal', 'armor') || 0);
  p.speedMult = tv('tendons', 'spd') || 1;
  p.dashCdMult = tv('tendons', 'dash') || 1;
  p.rofMult = tv('microrotor', 'rof') || 1;
  p.xpMult = tv('memboost', 'xp') || 1;
  p.critCh = 0.05 + (tv('kiroshi', 'crit') || 0);
  p.smartTurn = tv('smartlink', 'turn') || 0;
}

// =================== fx & messages ===================
function addP(n, x, y, o) {
  for (let i = 0; i < n; i++) {
    // o.dir + o.cone spray particles in a direction; omit for a radial burst
    const a = o.dir != null ? o.dir + rnd(-(o.cone || 0.5), o.cone || 0.5) : rnd(0, Math.PI * 2);
    const sp = rnd(0.3, 1) * (o.sp || 60);
    G.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (o.grav ? 20 : 0), t: rnd(0.5, 1) * (o.life || 0.4), col: o.col || '#fff', sz: o.sz || 1, grav: o.grav || 0 });
  }
}

// ---- gore decals: baked into the prerendered city so stains stay forever ----
function worldCtx() { return WORLD.ctx2 || (WORLD.ctx2 = WORLD.cv.getContext('2d')); }
function bloodStain(x, y, dir, power) {
  const wc = worldCtx();
  const n = Math.round(5 + power * 14);
  for (let i = 0; i < n; i++) {
    const a = dir != null ? dir + rnd(-0.75, 0.75) : rnd(0, Math.PI * 2);
    const d = rnd(1, 7 + power * 18);
    const s = Math.random() < 0.3 ? 2 : 1;
    wc.fillStyle = Math.random() < 0.5 ? 'rgba(122,14,28,0.55)' : 'rgba(160,24,40,0.45)';
    wc.fillRect(Math.round(x + Math.cos(a) * d), Math.round(y + Math.sin(a) * d * 0.7), s, s);
  }
  wc.fillStyle = 'rgba(110,12,24,0.5)';
  wc.beginPath(); wc.ellipse(x, y, 1.5 + power * 3.5, 1 + power * 2.2, 0, 0, Math.PI * 2); wc.fill();
}
function addTxt(x, y, text, col) { G.texts.push({ x, y, text, col, t: 0.8 }); }
function msg(text, col) {
  G.msgs.push({ text, col: col || '#cfd6e4', t: 5 });
  if (G.msgs.length > 8) G.msgs.shift();
}
function banner(text, sub, col) { G.bannerO = { text, sub, col: col || '#f9f002', t: 3 }; }

function updateRain(dt) {
  if (!G.rain.length) for (let i = 0; i < 110; i++) G.rain.push({ x: rnd(0, VIEW_W), y: rnd(0, VIEW_H), s: rnd(220, 380), l: rnd(4, 9) });
  for (const r of G.rain) {
    r.y += r.s * dt; r.x -= r.s * 0.18 * dt;
    if (r.y > VIEW_H) { r.y = -10; r.x = rnd(0, VIEW_W + 60); }
  }
}

function drawRain(c) {
  c.strokeStyle = 'rgba(150,190,230,0.20)';
  c.lineWidth = 1;
  c.beginPath();
  for (const r of G.rain) { c.moveTo(r.x, r.y); c.lineTo(r.x - r.l * 0.18, r.y - r.l); }
  c.stroke();
}

// =================== render ===================
function drawPed(c, ped, face, flip, frame, x, y, alpha, scale) {
  scale = scale || 1;
  const spr = ped[face === 'side' ? 'side' : face][frame % 2];
  c.save();
  if (alpha != null) c.globalAlpha = alpha;
  c.translate(Math.round(x), Math.round(y));
  // shadow
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(-3 * scale, -2, 6 * scale, 2);
  if (face === 'side' && flip) c.scale(-scale, scale); else c.scale(scale, scale);
  c.drawImage(spr, -4, -14);
  c.restore();
  c.globalAlpha = 1;
}

function visible(x, y, m) {
  m = m || 40;
  return x > G.cam.x - m && x < G.cam.x + VIEW_W + m && y > G.cam.y - m && y < G.cam.y + VIEW_H + m;
}

function indoorAt(x, y) { return WORLD.tileAt(x, y) >= 5; } // FLOOR or DOOR

// One pass per depth layer: indoor entities draw under the roof canvases,
// outdoor entities draw over them (you stand in FRONT of a south facade).
function drawWorldEntities(c, indoor) {
  const p = G.p;
  // pickups
  for (const pk of G.pickups) {
    if (!visible(pk.x, pk.y) || indoorAt(pk.x, pk.y) !== indoor) continue;
    const bob = Math.sin(G.rt * 4 + pk.x) * 1.5;
    if (pk.kind === 'ed') { c.fillStyle = '#f9f002'; c.fillRect(pk.x - 1, pk.y - 1 + bob, 3, 3); }
    else if (pk.kind === 'doc') { c.fillStyle = '#fff'; c.fillRect(pk.x - 3, pk.y - 1 + bob, 6, 2); c.fillRect(pk.x - 1, pk.y - 3 + bob, 2, 6); }
    else {
      const w = WPN[pk.id];
      c.drawImage(SPR.wicon(w.cls, KIND_COL[w.kind]), pk.x - 8, pk.y - 4 + bob, 16, 7);
    }
  }
  // player car
  if (G.car && !G.car.dead && visible(G.car.x, G.car.y) && indoorAt(G.car.x, G.car.y) === indoor) {
    c.save(); c.translate(Math.round(G.car.x), Math.round(G.car.y)); c.rotate(G.car.a + Math.PI / 2);
    c.fillStyle = 'rgba(0,0,0,0.4)'; c.fillRect(-7, -13, 14, 26);
    c.drawImage(SPR.car(G.car.id), -8, -15);
    c.restore();
  }
  // enemies
  for (const e of G.enemies) {
    if (e.dead || !visible(e.x, e.y) || indoorAt(e.x, e.y) !== indoor) continue;
    // Kiroshi optics: visualize unaware enemies' view cones
    if (G.cyber.kiroshi && !e.alerted) {
      c.globalAlpha = 0.05 + e.detect * 0.08;
      c.fillStyle = e.detect > 0.05 ? '#ff9f1c' : '#f9f002';
      c.beginPath(); c.moveTo(e.x, e.y - 4);
      c.arc(e.x, e.y - 4, enemyRange(e) * 0.45, e.lookA - FOV_HALF, e.lookA + FOV_HALF);
      c.closePath(); c.fill();
      c.globalAlpha = 1;
    }
    if (e.psycho) {
      c.globalAlpha = 0.5 + 0.3 * Math.sin(G.rt * 6);
      c.drawImage(SPR.glowS('#bd00ff', 18), e.x - 18, e.y - 22);
      c.globalAlpha = 1;
    }
    drawPed(c, e.psycho ? SPR.psycho : SPR.ped(e.fac), e.face, e.flip, Math.floor(e.anim), e.x, e.y, e.hitT > 0 ? 0.55 : 1, e.psycho ? 1.8 : 1);
    if (e.aiming && e.aimT > 0 && e.kind !== 'melee') {
      c.strokeStyle = 'rgba(255,42,60,0.35)'; c.beginPath(); c.moveTo(e.x, e.y - 4);
      const tx2 = G.driving && G.car ? G.car.x : p.x, ty2 = G.driving && G.car ? G.car.y : p.y;
      c.lineTo(tx2, ty2 - 2); c.stroke();
    }
    if ((G.cyber.kiroshi || e.bounty || e.psycho) && e.hp < e.maxhp) {
      c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(e.x - 7, e.y - (e.psycho ? 30 : 18), 14, 2);
      c.fillStyle = e.psycho ? '#bd00ff' : '#ff2a3c'; c.fillRect(e.x - 7, e.y - (e.psycho ? 30 : 18), 14 * e.hp / e.maxhp, 2);
    }
    if (e.bounty && !e.psycho) { c.fillStyle = '#ff2a3c'; c.fillRect(e.x - 1, e.y - (G.cyber.kiroshi ? 23 : 19), 2, 2); }
    // detection state: '?' suspicion meter, '!' on full alert
    if (e.flashT > 0) drawTextC(c, '!', e.x, e.y - (e.psycho ? 36 : 26), '#ff2a3c', 1);
    else if (!e.alerted && e.detect > 0.05) {
      drawTextC(c, '?', e.x, e.y - 26, '#f9f002', 1);
      c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(e.x - 5, e.y - 19, 10, 2);
      c.fillStyle = e.detect > 0.6 ? '#ff9f1c' : '#f9f002'; c.fillRect(e.x - 5, e.y - 19, 10 * e.detect, 2);
    }
  }
  // civs
  for (const cv2 of G.civs) {
    if (!visible(cv2.x, cv2.y) || indoorAt(cv2.x, cv2.y) !== indoor) continue;
    drawPed(c, SPR.civ(cv2.i), cv2.face, cv2.flip, Math.floor(cv2.anim), cv2.x, cv2.y);
  }
  // shop vendors, joytoys, dolls
  for (const n of WORLD.npcs) {
    if (!visible(n.x, n.y) || indoorAt(n.x, n.y) !== indoor) continue;
    drawPed(c, SPR.civ(n.i), 'down', false, 0, n.x, n.y);
    drawTextC(c, n.name, n.x, n.y - 20, n.kind === 'joy' || n.kind === 'doll' ? '#ff2a6d' : '#5a6372', 1);
  }
  // airdrop: chute on the way down, beacon container on the ground
  if (!indoor && G.airdrop && visible(G.airdrop.x, G.airdrop.y, 80)) {
    const a = G.airdrop, prog = 1 - Math.min(1, a.alt / 360), cy2 = a.y - a.alt;
    c.fillStyle = 'rgba(0,0,0,' + (0.12 + 0.26 * prog).toFixed(2) + ')';
    c.beginPath(); c.ellipse(a.x, a.y, 4 + 7 * prog, 2 + 3.5 * prog, 0, 0, Math.PI * 2); c.fill();
    if (a.state === 'falling') {
      c.fillStyle = '#ff6a00';
      c.beginPath(); c.arc(a.x, cy2 - 14, 10, Math.PI, 0); c.fill();
      c.fillStyle = '#c24e00'; c.fillRect(a.x - 10, cy2 - 14, 20, 2);
      c.strokeStyle = 'rgba(200,200,210,0.7)';
      c.beginPath();
      c.moveTo(a.x - 9, cy2 - 13); c.lineTo(a.x - 5, cy2 - 3);
      c.moveTo(a.x + 9, cy2 - 13); c.lineTo(a.x + 5, cy2 - 3);
      c.stroke();
      c.drawImage(SPR.crate, a.x - 6, cy2 - 4);
    } else {
      c.fillStyle = '#5a2c0c'; c.fillRect(a.x - 7, a.y - 9, 14, 11);
      c.fillStyle = '#ff6a00'; c.fillRect(a.x - 7, a.y - 9, 14, 2); c.fillRect(a.x - 1, a.y - 9, 2, 11);
      c.fillStyle = '#2c1606'; c.fillRect(a.x - 7, a.y + 1, 14, 1);
      if ((G.frame / 12 | 0) % 2) { c.fillStyle = '#ffd27a'; c.fillRect(a.x - 6, a.y - 8, 1, 1); }
    }
  }
  // player
  if (!G.driving && indoorAt(p.x, p.y) === indoor) {
    const pedSpr = SPR.player[G.gender] || SPR.player.m;
    for (const tr of p.trail) drawPed(c, pedSpr, tr.face, tr.flip, 0, tr.x, tr.y, tr.t * 1.2);
    drawPed(c, pedSpr, p.face, p.flip, p.moving ? Math.floor(p.anim) : 0, p.x, p.y, p.camoT > 0 ? 0.25 : 1);
    // held gun
    const w = curWpn();
    if (w && !MELEE_CLS[w.cls] && p.camoT <= 0) {
      const len = { pistol: 6, revolver: 7, smg: 8, rifle: 10, shotgun: 9, sniper: 12, lmg: 11, launcher: 8 }[w.cls] || 7;
      c.save(); c.translate(p.x, p.y - 4); c.rotate(p.aim);
      c.fillStyle = '#1a1c24'; c.fillRect(2, 0, len, 2);
      c.fillStyle = KIND_COL[w.kind]; c.fillRect(2 + len - 2, 0, 2, 1);
      c.restore();
    }
  }
  // slashes
  for (const s of G.slashes) {
    if (indoorAt(s.x, s.y) !== indoor) continue;
    c.strokeStyle = s.col; c.globalAlpha = s.t / 0.16; c.lineWidth = 2;
    c.beginPath(); c.arc(s.x, s.y - 3, s.range, s.a - 0.9, s.a + 0.9); c.stroke();
    c.globalAlpha = 1; c.lineWidth = 1;
  }
  // bullets
  for (const b of G.bullets) {
    if (indoorAt(b.x, b.y) !== indoor) continue;
    c.strokeStyle = b.col; c.lineWidth = b.from === 'p' ? 1.5 : 1;
    c.beginPath(); c.moveTo(b.x - b.vx * 0.02, b.y - b.vy * 0.02); c.lineTo(b.x, b.y); c.stroke();
  }
  c.lineWidth = 1;
  // particles
  for (const pa of G.parts) {
    if (indoorAt(pa.x, pa.y) !== indoor) continue;
    c.fillStyle = pa.col; c.fillRect(pa.x, pa.y, pa.sz, pa.sz);
  }
}

function render() {
  const c = C;
  c.fillStyle = '#06060a'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  if (G.state === 'title') { drawTitle(c); c.drawImage(SPR.scan, 0, 0); return; }
  const p = G.p, camX = Math.round(G.cam.x), camY = Math.round(G.cam.y);
  c.save();
  c.translate(-camX, -camY);
  // ground
  c.drawImage(WORLD.cv, camX, camY, VIEW_W, VIEW_H, camX, camY, VIEW_W, VIEW_H);
  // puddle shimmer
  for (const pd of WORLD.puddles) {
    if (!visible(pd.x, pd.y, 20)) continue;
    c.globalAlpha = 0.06 + 0.04 * Math.sin(G.rt * 2 + pd.x);
    c.fillStyle = pd.col;
    c.beginPath(); c.ellipse(pd.x, pd.y, pd.w / 2, pd.h / 2, 0, 0, Math.PI * 2); c.fill();
  }
  c.globalAlpha = 1;
  // crates & vends & displays
  for (const cr of G.crates) if (cr.hp > 0 && visible(cr.x, cr.y)) c.drawImage(SPR.crate, cr.x - 6, cr.y - 6);
  for (const v of WORLD.vends) if (visible(v.x, v.y)) c.drawImage(SPR.vend, v.x - 6, v.y - 12);
  for (const d of WORLD.displays) {
    if (!visible(d.x, d.y)) continue;
    c.drawImage(SPR.car(d.id), d.x - 8, d.y - 15);
  }
  // entities under roofs (indoors) — hidden until the roof fades
  drawWorldEntities(c, true);
  // roofs of enterable buildings (fade away when V is inside)
  for (const r of WORLD.roofs) {
    if (r.a < 0.02) continue;
    if (r.x > camX + VIEW_W + 8 || r.y > camY + VIEW_H + 8 || r.x + r.w < camX - 8 || r.y + r.h < camY - 8) continue;
    c.globalAlpha = r.a;
    c.drawImage(r.cv, r.x, r.y);
  }
  c.globalAlpha = 1;
  // neon signs sit on the exterior walls: drawn over the roof layer, fading with it indoors
  for (const s of WORLD.signs) {
    if (!visible(s.x, s.y, 60)) continue;
    const flick = Math.random() < 0.02 ? 0.4 : 1;
    const rfA = s.roof != null && WORLD.roofs[s.roof] ? WORLD.roofs[s.roof].a : 1;
    c.globalAlpha = (0.75 + 0.25 * Math.sin(G.rt * 3 + s.x)) * flick * rfA;
    drawTextC(c, s.text, s.x, s.y, s.col, s.big ? 2 : 1);
    c.globalAlpha = 1;
  }
  // entities in the open air — in FRONT of facades and roofs, never covered by them
  drawWorldEntities(c, false);
  // glow pass
  c.globalCompositeOperation = 'lighter';
  for (const g of G.glows) {
    c.globalAlpha = Math.min(1, g.t * 8);
    c.drawImage(SPR.glowS(g.col, Math.round(g.r)), g.x - g.r, g.y - g.r);
  }
  for (const s of WORLD.signs) {
    if (!visible(s.x, s.y, 60)) continue;
    const rfA = s.roof != null && WORLD.roofs[s.roof] ? WORLD.roofs[s.roof].a : 1;
    const gr = s.big ? 32 : 22;
    c.globalAlpha = (s.big ? 0.22 : 0.16) + 0.05 * Math.sin(G.rt * 3 + s.x);
    c.globalAlpha *= rfA;
    c.drawImage(SPR.glowS(s.col, gr), s.x - gr, s.y - gr + 4);
  }
  for (const L of WORLD.lights) {
    if (!visible(L.x, L.y, 30)) continue;
    c.globalAlpha = 0.25;
    c.drawImage(SPR.glowS('#ffd9a0', 10), L.x - 10, L.y - 10);
  }
  for (const v of WORLD.vends) {
    if (!visible(v.x, v.y)) continue;
    c.globalAlpha = 0.3 + 0.1 * Math.sin(G.rt * 2 + v.x);
    c.drawImage(SPR.glowS('#05d9e8', 12), v.x - 12, v.y - 16);
  }
  for (const r of WORLD.roofs) { // interior mood lights, revealed with the room
    if (r.a > 0.6 || !r.lights.length) continue;
    for (const L of r.lights) {
      c.globalAlpha = 0.32 * (1 - r.a);
      c.drawImage(SPR.glowS(L.col, 18), L.x - 18, L.y - 18);
    }
  }
  for (const cr of G.crates) { // loot crates pulse so they read as breakable
    if (cr.hp <= 0 || !visible(cr.x, cr.y)) continue;
    c.globalAlpha = 0.12 + 0.07 * Math.sin(G.rt * 3 + cr.x);
    c.drawImage(SPR.glowS('#f9f002', 9), cr.x - 9, cr.y - 13);
  }
  if (G.airdrop && visible(G.airdrop.x, G.airdrop.y, 80)) {
    c.globalAlpha = 0.4 + 0.1 * Math.sin(G.rt * 5);
    c.drawImage(SPR.glowS('#ff6a00', 14), G.airdrop.x - 14, G.airdrop.y - G.airdrop.alt - 18);
  }
  for (const b of G.bullets) {
    c.globalAlpha = 0.5;
    c.drawImage(SPR.glowS(b.col, 5), b.x - 5, b.y - 5);
  }
  if (G.car && !G.car.dead && G.driving) {
    const hx = Math.cos(G.car.a), hy = Math.sin(G.car.a);
    c.globalAlpha = 0.3;
    c.drawImage(SPR.glowS('#ffe9c0', 26), G.car.x + hx * 26 - 26, G.car.y + hy * 26 - 26);
  }
  for (const pk of G.pickups) {
    if (!visible(pk.x, pk.y)) continue;
    c.globalAlpha = 0.35 + 0.15 * Math.sin(G.rt * 5);
    const col = pk.kind === 'wpn' ? RAR_COL[WPN[pk.id].rar] : pk.kind === 'ed' ? '#f9f002' : '#2ecc71';
    c.drawImage(SPR.glowS(col, 9), pk.x - 9, pk.y - 9);
  }
  c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  // holo billboards
  for (const h of WORLD.holos) {
    if (!visible(h.x, h.y, 60)) continue;
    const bob = Math.sin(G.rt * 1.2 + h.x * 0.1) * 2;
    const hw = Math.max(34, textW(h.text) + 10);
    c.globalAlpha = 0.82 + 0.1 * Math.sin(G.rt * 7 + h.x);
    c.fillStyle = 'rgba(8,12,20,0.85)';
    c.fillRect(h.x - hw / 2, h.y - 30 + bob, hw, 13);
    c.strokeStyle = h.col; c.strokeRect(h.x - hw / 2 + 0.5, h.y - 30 + bob + 0.5, hw - 1, 12);
    drawTextC(c, h.text, h.x, h.y - 26 + bob, h.col, 1);
    c.globalAlpha = 1;
  }
  // floating combat text
  for (const tx of G.texts) drawText(c, tx.text, tx.x - 4, tx.y, tx.col, 1);
  c.restore();

  // screen-space overlays
  drawRain(c);
  if (G.flashT > 0) { c.fillStyle = 'rgba(200,220,255,' + (G.flashT * 0.35) + ')'; c.fillRect(0, 0, VIEW_W, VIEW_H); }
  if (G.os === 'sandevistan' && p.osT > 0) {
    c.fillStyle = 'rgba(0,255,159,0.07)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
    c.fillStyle = '#00ff9f'; c.fillRect(0, 0, 3, VIEW_H); c.fillRect(VIEW_W - 3, 0, 3, VIEW_H);
  }
  if (G.os === 'berserk' && p.osT > 0) { c.fillStyle = 'rgba(255,42,60,0.08)'; c.fillRect(0, 0, VIEW_W, VIEW_H); }
  if (p.kzT > 0 && G.timeScale < 1 && !(G.os === 'sandevistan' && p.osT > 0)) { c.fillStyle = 'rgba(5,217,232,0.06)'; c.fillRect(0, 0, VIEW_W, VIEW_H); }
  if (p.camoT > 0) { c.strokeStyle = 'rgba(5,217,232,0.5)'; c.strokeRect(1.5, 1.5, VIEW_W - 3, VIEW_H - 3); }
  if (G.hurtT > 0) {
    const g = c.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H / 3, VIEW_W / 2, VIEW_H / 2, VIEW_W / 1.4);
    g.addColorStop(0, 'rgba(255,0,30,0)'); g.addColorStop(1, 'rgba(255,0,30,' + (0.3 * G.hurtT) + ')');
    c.fillStyle = g; c.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  if (G.state === 'dead') drawDead(c);
  else if (G.ui === 'pause') drawPause(c);
  else if (G.ui === 'inv') drawInv(c);
  else if (G.ui === 'guns') drawShopGuns(c);
  else if (G.ui === 'cars') drawShopCars(c);
  else if (G.ui === 'ripper') drawRipper(c);
  else if (G.ui === 'bar') drawBar(c);
  else if (G.ui === 'talk') { drawHUD(c); drawTalk(c); }
  else { drawHUD(c); drawCrosshair(c); }

  // fade-to-black interludes
  if (G.fade) {
    const a = Math.sin(Math.PI * Math.min(1, G.fade.t / G.fade.dur));
    c.fillStyle = 'rgba(4,2,8,' + (0.97 * a).toFixed(2) + ')';
    c.fillRect(0, 0, VIEW_W, VIEW_H);
    if (a > 0.6) drawTextC(c, G.fade.label, VIEW_W / 2, 172, '#ff2a6d', 1);
  }

  c.drawImage(SPR.scan, 0, 0);
}

// boot
window.addEventListener('load', boot);
window.__boot = boot;
window.__step = step;
