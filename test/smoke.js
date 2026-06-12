'use strict';
// Headless smoke test: stub browser APIs, load all scripts in one scope,
// then drive the sim through every major system. Any throw = fail.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ---- canvas/ctx stubs ----
const ctxHandler = {
  get(t, k) {
    if (k === Symbol.toPrimitive) return () => '[ctx]';
    if (!(k in t)) t[k] = (...args) => new Proxy({}, ctxHandler);
    return t[k];
  },
  set(t, k, v) { t[k] = v; return true; },
};
function makeCanvas() {
  return {
    width: 0, height: 0, style: {},
    getContext: () => new Proxy({}, ctxHandler),
    addEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 640, height: 360 }),
  };
}

const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
global.window = global;
global.innerWidth = 1280; global.innerHeight = 720;
const listeners = {};
global.addEventListener = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
global.removeEventListener = () => {};
global.requestAnimationFrame = () => 0;
const mainCanvas = makeCanvas();
global.document = {
  getElementById: () => mainCanvas,
  createElement: () => makeCanvas(),
  addEventListener: () => {},
  body: { appendChild: () => {} },
};

// ---- load game scripts in one shared scope (same order as index.html) ----
const files = ['js/font.js', 'js/data.js', 'js/sfx.js', 'js/sprites.js', 'js/world.js', 'js/ui.js', 'js/game.js', 'mods/mods.js'];
const src = files.map(f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
vm.runInThisContext(src, { filename: 'bundle.js' });

const steps = (n, dt) => { for (let i = 0; i < n; i++) window.__step(dt || 1 / 60); };
const assert = (cond, what) => { if (!cond) throw new Error('ASSERT FAIL: ' + what); };

window.__boot();
assert(WORLD && WORLD.t.length === 128 * 128, 'world generated');
assert(WORLD.shops.guns && WORLD.shops.ripper && WORLD.shops.cars && WORLD.shops.bar, 'shops placed');
assert(!WORLD.solidPx(WORLD.spawn.x, WORLD.spawn.y), 'spawn walkable');
steps(5); // title renders

startGame(false, 'f');
assert(G.state === 'play' && G.gender === 'f', 'new game started as female V');
assert(Object.keys(G.weapons).length === 1 && G.loadout[0], 'random starter weapon granted');
assert(Object.keys(G.cars).length === 1 && G.activeCar, 'random starter vehicle granted');
G.p.iframes = 99999; // god mode for the soak; the death test clears it explicitly

// radio dial: cycles all stations + OFF, then wraps
const startStation = SFX.stationIdx, names = new Set();
for (let i = 0; i < SFX.stations.length + 1; i++) names.add(SFX.cycleStation());
assert(names.has('OFF') && names.size === SFX.stations.length + 1, 'radio cycles stations + off');
assert(SFX.stationIdx === startStation, 'radio dial wraps');
G.pressed.add('KeyN'); steps(2); // in-game key path

// mod API: register content + hook before combat so the kill hook fires
let modKills = 0;
NCPX.registerMod({
  name: 'test-mod',
  weapons: [{ id: 'test_blaster', name: 'TEST BLASTER', cls: 'pistol', kind: 'power', rar: 1, dmg: 10, rof: 5, mag: 10, rel: 1, spd: 400, spread: 4, price: 100, lvl: 1, desc: 'TEST' }],
  cars: [{ id: 'test_kart', name: 'TEST KART', price: 100, top: 200, acc: 150, grip: 0.9, hp: 200, shape: 'sedan', col: '#123456', col2: '#654321' }],
  stations: [{ name: 'TEST FM', bpm: 100, roots: [33, 33, 33, 33], kick: [0], snare: [8], hat: 2, bass: 'roll', arp: null, pad: null, wv: { bass: 'square', arp: 'square', lead: 'square', pad: 'square' }, lead: NCPX.mel([[0, 12]]) }],
  on: { kill: () => { modKills++; } },
});
assert(WPN.test_blaster && CARD.test_kart, 'mod content registered');
assert(SFX.stations.some(s => s.name === 'TEST FM'), 'mod station registered');
G.eddies += 200; buyWeapon('test_blaster');
assert(G.weapons.test_blaster, 'mod weapon purchasable');

// walk + shoot
G.keys.add('KeyD'); G.mouse.down = true;
steps(240);
assert(G.stats.dist > 0, 'player moved');
G.keys.delete('KeyD');

// combat near player
spawnPack(G.p.x + 70, G.p.y, 5);
assert(G.enemies.length >= 3, 'pack spawned');
steps(420);
if (G.stats.kills > 0) assert(modKills > 0, 'mod kill hook fired');

// melee path
G.eddies = 999999;
buyWeapon('katana'); assignSlot('katana', 1); G.slot = 1;
steps(120);

// economy: weapons, cyberware, cars (level up past all gates first)
G.lvl = 25; recalcStats();
['lexington', 'ajax', 'carnage', 'nekomata', 'shingen'].forEach(buyWeapon);
['sandevistan', 'kiroshi', 'subdermal', 'tendons', 'smartlink', 'arm_mantis', 'biomonitor', 'kerenzikov', 'microrotor', 'memboost', 'titanium'].forEach(buyCyber);
buyCyber('sandevistan'); // upgrade to MK.2
assert(G.cyber.sandevistan >= 1 && G.os === 'sandevistan', 'OS installed');
assert(G.weapons.mantis_blades, 'arm cyberware granted weapon');
buyCar('galena'); buyCar('caliburn');
assert(G.cars.galena && G.activeCar === 'caliburn', 'cars bought');

// sandevistan + smart gun
assignSlot('shingen', 2); G.slot = 2;
G.pressed.add('KeyQ');
steps(60);
assert(G.p.maxhp > 100, 'titanium raised hp');

// drive
summonCar();
assert(G.car, 'car summoned');
enterCar();
G.keys.add('KeyW');
steps(300);
assert(G.driving, 'driving');
G.keys.delete('KeyW');

// vehicular manslaughter: target directly in the car's path takes the hit
const roadkill = makeEnemy(G.car.x + 26, G.car.y, 1, 'scavs', 'melee', {});
G.enemies.push(roadkill);
G.car.a = 0; G.car.vx = 240; G.car.vy = 0;
steps(30);
assert(roadkill.dead || roadkill.hp < roadkill.maxhp, 'vehicle run-over connects');

exitCar();
assert(!G.driving, 'exited car');

// dash + maxdoc + camo keys (camo not owned: should no-op)
G.keys.add('KeyW'); G.pressed.add('Space'); G.pressed.add('KeyC'); G.pressed.add('KeyF');
steps(40); G.keys.delete('KeyW');

// bounty flow
G.bounty = null; G.enemies = [];
spawnBounty();
assert(G.bounty && G.bounty.left > 0, 'bounty spawned');
for (const e of G.enemies.slice()) damageEnemy(e, 1e7, false);
steps(10);
assert(!G.bounty, 'bounty completed');
assert(G.stats.bounties === 1, 'bounty stat');

// psycho flow
G.bounty = null;
spawnPsycho();
const ps = G.enemies.find(e => e.psycho);
assert(ps, 'psycho spawned');
steps(120);
damageEnemy(ps, 1e9, false);
steps(30);
assert(G.stats.psychos === 1, 'psycho stat');
// collect its iconic drop (may already be magnet-collected if the psycho died close)
const drop = G.pickups.find(pk => pk.kind === 'wpn' && WPN[pk.id].iconic);
if (drop) { G.p.x = drop.x; G.p.y = drop.y; steps(30); }
assert(Object.keys(G.weapons).some(id => WPN[id].iconic), 'iconic collected');

// skippy
G.p.x = WORLD.skippySpot.x; G.p.y = WORLD.skippySpot.y;
steps(5);
assert(G.skippyFound && G.weapons.skippy, 'skippy found');

// crate break
const cr = G.crates[0];
G.p.x = cr.x + 4; G.p.y = cr.y;
breakCrate(cr);
assert(cr.hp <= 0 && G.stats.crates > 0, 'crate broken');

// UI screens render without throwing
for (const ui of ['pause', 'guns', 'cars', 'ripper', 'bar']) {
  G.ui = ui; G.uiS = { sel: 0, scroll: 0, tab: 0, confirm: false };
  steps(8);
  G.pressed.add('ArrowDown'); G.pressed.add('ArrowUp');
  steps(4);
}
G.ui = 'inv';
for (let tab = 0; tab < 4; tab++) { G.uiS.tab = tab; steps(6); }
G.ui = null;

// vendor + bar purchases
G.maxdocs = 0; vendBuy(); assert(G.maxdocs === 1, 'vending works');
barSelect(0); assert(G.p.hp === G.p.maxhp && G.p.buffT > 0, 'bar drink works');

// death + respawn
G.p.iframes = 0; G.p.hp = 5; G.cyber.second_heart = 0;
damagePlayer(1e9);
assert(G.state === 'dead', 'player flatlined');
steps(260);
assert(G.state === 'play' && G.p.hp === G.p.maxhp, 'respawned');

// save / load roundtrip
const eddiesBefore = G.eddies, weaponsBefore = Object.keys(G.weapons).length;
saveGame();
startGame(true);
assert(G.eddies === eddiesBefore, 'eddies persisted');
assert(Object.keys(G.weapons).length === weaponsBefore, 'weapons persisted');
assert(G.cars.caliburn && G.cyber.sandevistan, 'cars+chrome persisted');
assert(G.gender === 'f', 'gender persisted');
steps(120);

// long soak: everything running together
spawnPack(G.p.x + 80, G.p.y + 40, 6);
G.mouse.down = true; G.keys.add('KeyA');
steps(900);

// ---- stealth FOV: enemies only see inside their view cone ----
G.mouse.down = false; G.keys.clear();
G.p.iframes = 99999;
G.p.x = WORLD.spawn.x; G.p.y = WORLD.spawn.y;
G.enemies = []; G.bounty = null; G.driving = false; G.car = null;
const watcher = makeEnemy(G.p.x + 90, G.p.y, 1, 'scavs', 'gun', {});
watcher.wanderT = 9999; watcher.wx = 0; watcher.wy = 0; watcher.lookA = 0; // facing away from V
G.enemies.push(watcher);
steps(90);
assert(!watcher.alerted && watcher.detect === 0, 'enemy cannot see behind itself');
watcher.lookA = Math.PI; // now facing V
steps(180);
assert(watcher.alerted, 'enemy spots V inside its view cone');

// ---- enterable buildings: roof fade, den ambush, clear bonus ----
assert(WORLD.roofs.length > 0 && WORLD.dens.length > 0, 'interiors generated');
let den = WORLD.dens[0];
for (const dn of WORLD.dens) {
  if ((dn.tx1 - dn.tx0) * (dn.ty1 - dn.ty0) > (den.tx1 - den.tx0) * (den.ty1 - den.ty0)) den = dn;
}
G.enemies = [];
G.p.x = (den.tx0 + 1) * TILE + 8; G.p.y = (den.ty0 + 1) * TILE + 8;
steps(40);
assert(den.done, 'den ambush triggered');
const denE = G.enemies.filter(e => e.denId === den.id);
assert(denE.length > 0, 'den enemies spawned');
const roof = WORLD.roofs.find(r => r.tx0 === den.tx0 && r.ty0 === den.ty0);
assert(roof && roof.a < 0.5, 'roof fades when V is inside');
const edBefore = G.eddies;
denE.forEach(e => damageEnemy(e, 1e9, false));
steps(5);
assert(den.cleared && G.eddies > edBefore, 'hideout clear bonus paid');
G.p.x = WORLD.spawn.x; G.p.y = WORLD.spawn.y;
steps(60);
assert(roof.a > 0.85, 'roof restores when V leaves');

// ---- walk-in shop counters ----
G.p.x = WORLD.shops.guns.x; G.p.y = WORLD.shops.guns.y;
steps(2);
G.pressed.add('KeyE'); steps(2);
assert(G.ui === 'guns', 'walk-in shop counter opens shop');
assert(G.prompt && G.prompt.includes('WILSON'), 'counter prompt names the vendor');
G.ui = null;

// ---- shop marquees stay visible from outside ----
const barSign = WORLD.signs.find(s => s.text === 'AFTERLIFE');
assert(barSign && barSign.big && barSign.roof != null && WORLD.roofs[barSign.roof], 'afterlife marquee wired to its roof layer');

// ---- doorstep fade: standing at the door (outside) already lifts the roof ----
const barRoof = WORLD.roofs[barSign.roof];
G.p.x = barRoof.doorTx[0] * TILE + 8; G.p.y = (barRoof.doorTy + 1) * TILE + 10;
steps(40);
assert(barRoof.a < 0.5, 'roof fades from the doorstep');
assert(!indoorAt(G.p.x, G.p.y), 'doorstep itself is outdoors (drawn in front of facade)');
G.p.x = WORLD.spawn.x; G.p.y = WORLD.spawn.y;
steps(60);
assert(barRoof.a > 0.85, 'roof restores after stepping away');

// ---- furniture & NPC collision: the bar counter blocks V ----
assert(WORLD.obst.length > 20, 'interior obstacles registered');
const barObst = WORLD.obst.find(o =>
  o.w > 40 && Math.abs(o.x + o.w / 2 - WORLD.shops.bar.x) < 4 && Math.abs(o.y - (WORLD.shops.bar.y - 12)) < 6);
assert(barObst, 'bar counter obstacle exists');
G.enemies = [];
G.p.x = barObst.x + barObst.w / 2; G.p.y = barObst.y + barObst.h + 8;
G.keys.add('KeyW');
steps(80);
G.keys.delete('KeyW');
assert(G.p.y >= barObst.y + barObst.h - 0.01, 'cannot walk through the bar counter');
assert(!WORLD.blockedPx(G.p.x, G.p.y), 'player not stuck inside furniture');

// ---- Dogtown + airdrops ----
G.p.iframes = 99999;
assert(DISTRICTS.dogtown && FACTIONS.barghest, 'dogtown + barghest defined');
assert(WORLD.districtAt(20 * TILE, 100 * TILE) === 'dogtown', 'dogtown occupies the SW corner');
G.enemies = []; G.bounty = null; G.airdrop = null; G.airdropT = 0;
spawnAirdrop();
assert(G.airdrop && G.airdrop.state === 'falling', 'airdrop spawned');
assert(WORLD.districtAt(G.airdrop.x, G.airdrop.y) === 'dogtown', 'airdrop targets dogtown');
steps(60 * 7);
assert(G.airdrop && G.airdrop.state === 'landed', 'airdrop landed');
assert(G.enemies.some(e => e.fac === 'barghest'), 'barghest converge on the drop');
G.p.x = G.airdrop.x; G.p.y = G.airdrop.y + 10;
const edBeforeDrop = G.eddies;
steps(2); G.pressed.add('KeyE'); steps(3);
assert(!G.airdrop, 'airdrop cracked open');
steps(80); // hoover the loot
assert(G.stats.airdrops === 1, 'airdrop stat counted');
assert(G.eddies > edBeforeDrop, 'airdrop eddies collected');

// ---- joytoys & dolls: talk, flirt, pay, buff ----
const joy = WORLD.npcs.find(n => n.kind === 'joy');
const doll = WORLD.npcs.find(n => n.kind === 'doll');
assert(joy && doll, 'joytoy + doll exist (jig-jig street / clouds)');
G.eddies = 1000; G.p.hp = 10;
openTalk(joy);
assert(G.ui === 'talk' && G.talk.npc === joy, 'talk opened');
talkSelect(0); // flirt
assert(G.ui === 'talk', 'flirt keeps the conversation going');
talkSelect(1); // good time
assert(G.ui === null && G.eddies === 900, 'service paid');
assert(G.p.hp === G.p.maxhp && G.p.joyT > 0, 'fully rested + euphoria buff');
assert(G.fade && G.fade.label, 'fade-to-black interlude');
steps(240);
assert(!G.fade, 'fade ends');
openTalk(doll);
talkSelect(2); // leave
assert(G.ui === null, 'leave closes talk');

// ---- legacy save (pre-gender/dens fields) still continues ----
localStorage.setItem('ncpx2077_v1', JSON.stringify({
  v: 1, eddies: 777, lvl: 3, xp: 10, maxdocs: 1,
  px: WORLD.spawn.x, py: WORLD.spawn.y, hp: 80,
  weapons: ['liberty'], loadout: ['liberty', null, null], slot: 0,
  cars: [], activeCar: null, cyber: {}, os: null,
  stats: { kills: 1, psychos: 0, bounties: 0, crates: 0, dist: 0, playT: 5 },
}));
startGame(true);
assert(G.state === 'play' && G.eddies === 777 && G.weapons.liberty, 'legacy save continues cleanly');
steps(60);

console.log('SMOKE OK —',
  'kills:' + G.stats.kills,
  'weapons:' + Object.keys(G.weapons).length + '/' + WEAPONS.length,
  'cars:' + Object.keys(G.cars).length + '/' + CARS.length,
  'chrome:' + Object.keys(G.cyber).length + '/' + CYBER.length,
  'enemies:' + G.enemies.length,
  'lvl:' + G.lvl);
