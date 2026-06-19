'use strict';
// ============ Static game data: weapons / cars / cyberware / districts ============
const TILE = 16, VIEW_W = 640, VIEW_H = 360;

const NEON = ['#ff2a6d', '#05d9e8', '#f9f002', '#bd00ff', '#00ff9f', '#ff9f1c'];
const RAR_NAME = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'ICONIC'];
const RAR_COL  = ['#9aa0a6', '#2ecc71', '#3da9fc', '#bd00ff', '#ff9f1c', '#f9f002'];
const KIND_COL = { power: '#ff9f1c', tech: '#05d9e8', smart: '#ff2a6d', melee: '#cfd6e4' };
const MELEE_CLS = { blade: 1, blunt: 1, mantis: 1, gorilla: 1, wire: 1 };

// dmg=per bullet/pellet, rof=shots per sec, spd=bullet px/s, spread=degrees
// melee: range px, arc degrees. pierce=walls&bodies passed. kb=knockback px/s
const WEAPONS = [
  // ---- pistols / revolvers ----
  { id:'liberty',    name:'CT-9M LIBERTY',      cls:'pistol',  kind:'power', rar:0, dmg:9,  rof:4.5, mag:12, rel:0.9, spd:380, spread:5,  price:0,     lvl:1,  desc:'STANDARD ISSUE SIDEARM. EVERY MERC STARTS SOMEWHERE.' },
  { id:'lexington',  name:'M-10AF LEXINGTON',   cls:'pistol',  kind:'power', rar:0, dmg:7,  rof:7,   mag:18, rel:0.9, spd:380, spread:6,  price:450,   lvl:1,  desc:'CHEAP, FAST, EVERYWHERE. THE STREET SPECIAL.' },
  { id:'unity',      name:'UNITY',              cls:'pistol',  kind:'power', rar:1, dmg:10, rof:5.5, mag:14, rel:0.9, spd:400, spread:5,  price:900,   lvl:2,  desc:'RELIABLE NOMAD FAVORITE. NEVER JAMS.' },
  { id:'nue',        name:'HJKE-11 NUE',        cls:'pistol',  kind:'power', rar:2, dmg:17, rof:3.6, mag:10, rel:1.0, spd:440, spread:4,  price:2600,  lvl:5,  desc:'CORPO-GRADE HAND CANNON. CLEAN AND MEAN.' },
  { id:'omaha',      name:'JKE-X2 OMAHA',       cls:'pistol',  kind:'tech',  rar:2, dmg:14, rof:4,   mag:12, rel:1.0, spd:520, spread:3,  pierce:1, price:3400, lvl:7, desc:'TECH ROUNDS PUNCH STRAIGHT THROUGH BODY ARMOR.' },
  { id:'overture',   name:'DR5 NOVA OVERTURE',  cls:'revolver',kind:'power', rar:1, dmg:30, rof:1.6, mag:6,  rel:1.6, spd:460, spread:3,  kb:120, price:1900, lvl:4, desc:'SIX CHAMBERS OF PURE ARGUMENT.' },
  { id:'burya',      name:'RT-46 BURYA',        cls:'revolver',kind:'tech',  rar:3, dmg:44, rof:1.2, mag:5,  rel:1.8, spd:560, spread:2,  pierce:1, kb:160, price:7800, lvl:11, desc:'RAILGUN IN A REVOLVER FRAME. SOVOIL ENGINEERING.' },
  // ---- SMG ----
  { id:'saratoga',   name:'G-58 DIAN SARATOGA', cls:'smg',     kind:'power', rar:1, dmg:6,  rof:11,  mag:28, rel:1.2, spd:360, spread:9,  price:1400,  lvl:3,  desc:'SPRAY AND PRAY, GONK-PROOF DESIGN.' },
  { id:'pulsar',     name:'M2038 TACTICIAN PULSAR', cls:'smg', kind:'power', rar:2, dmg:7,  rof:14,  mag:36, rel:1.3, spd:380, spread:8,  price:5200,  lvl:9,  desc:'MILITECH BULLET HOSE. KEEP THE TRIGGER WARM.' },
  { id:'shingen',    name:'TKI-20 SHINGEN',     cls:'smg',     kind:'smart', rar:3, dmg:6,  rof:12,  mag:30, rel:1.3, spd:300, spread:10, homing:5, price:9800, lvl:12, desc:'ARASAKA SMART-SMG. ROUNDS HUNT WARM BODIES. NEEDS SMART LINK.' },
  // ---- rifles ----
  { id:'copperhead', name:'D5 COPPERHEAD',      cls:'rifle',   kind:'power', rar:1, dmg:9,  rof:8,   mag:24, rel:1.4, spd:440, spread:6,  price:2200,  lvl:4,  desc:'NOMAD WORKHORSE. EATS DUST, SPITS LEAD.' },
  { id:'ajax',       name:'D5 SIDEWINDER AJAX', cls:'rifle',   kind:'power', rar:2, dmg:11, rof:8,   mag:28, rel:1.4, spd:460, spread:5,  price:4400,  lvl:8,  desc:'MILITECH STANDARD ASSAULT PLATFORM.' },
  { id:'sidewinder', name:'D5 SIDEWINDER SMART',cls:'rifle',   kind:'smart', rar:3, dmg:8,  rof:10,  mag:32, rel:1.4, spd:320, spread:9,  homing:5, price:8400, lvl:11, desc:'FIRE-AND-FORGET. THE GUN DOES THE AIMING. NEEDS SMART LINK.' },
  { id:'masamune',   name:'HJSH-18 MASAMUNE',   cls:'rifle',   kind:'power', rar:3, dmg:13, rof:10,  mag:30, rel:1.4, spd:480, spread:4,  price:12500, lvl:14, desc:'ARASAKA PRECISION AUTOMATIC. KOROSHI APPROVED.' },
  { id:'kyubi',      name:'TKI-30 KYUBI',       cls:'rifle',   kind:'power', rar:4, dmg:18, rof:7,   mag:22, rel:1.3, spd:520, spread:3,  price:21000, lvl:17, desc:'NINE-TAILED FOX. EVERY ROUND A STATEMENT.' },
  // ---- shotguns ----
  { id:'igla',       name:'TESTERA IGLA',       cls:'shotgun', kind:'power', rar:1, dmg:7,  rof:1.8, mag:6,  rel:1.7, spd:320, spread:14, pellets:6,  kb:90,  price:1700,  lvl:3,  desc:'BUDGET BOOMSTICK. CLOSE ENOUGH COUNTS.' },
  { id:'carnage',    name:'M2038 CARNAGE',      cls:'shotgun', kind:'power', rar:2, dmg:9,  rof:1.3, mag:5,  rel:1.8, spd:340, spread:16, pellets:8,  kb:140, price:6200,  lvl:9,  desc:'CONSTITUTIONAL ARMS\' ANSWER TO EVERY QUESTION.' },
  { id:'tactician',  name:'M2038 TACTICIAN',    cls:'shotgun', kind:'power', rar:3, dmg:8,  rof:2.4, mag:8,  rel:1.8, spd:360, spread:13, pellets:7,  kb:110, price:11000, lvl:13, desc:'SEMI-AUTO SCATTERGUN FOR THE WORKING MERC.' },
  { id:'sovereign',  name:'DB-4 SOVEREIGN',     cls:'shotgun', kind:'power', rar:4, dmg:8,  rof:1.0, mag:2,  rel:1.9, spd:360, spread:20, pellets:14, kb:220, price:19500, lvl:16, desc:'DOUBLE-BARREL APOCALYPSE. BOTH BARRELS, NO REGRETS.' },
  // ---- snipers ----
  { id:'nekomata',   name:'M-179E ACHILLES NEKOMATA', cls:'sniper', kind:'tech', rar:3, dmg:75, rof:0.9, mag:4, rel:2.2, spd:760, spread:0.5, pierce:2, price:14500, lvl:14, desc:'TECH SNIPER. CHARGES RAILS, ERASES PROBLEMS.' },
  { id:'ashura',     name:'ASHURA',             cls:'sniper',  kind:'smart', rar:4, dmg:85, rof:0.8, mag:5,  rel:2.3, spd:600, spread:1,  homing:3, price:36000, lvl:19, desc:'SMART SNIPER RIFLE. DEATH WITH A LOCK-ON TONE. NEEDS SMART LINK.' },
  // ---- LMG ----
  { id:'defender',   name:'L-69 ZHUO DEFENDER', cls:'lmg',     kind:'power', rar:3, dmg:7,  rof:12,  mag:70, rel:2.8, spd:420, spread:8,  price:16500, lvl:15, desc:'SUPPRESSION AS A LIFESTYLE.' },
  // ---- melee (shop) ----
  { id:'knife',      name:'STREET KNIFE',       cls:'blade',   kind:'melee', rar:0, dmg:16, rof:3.2, range:20, arc:100, price:350,  lvl:1, desc:'QUIET, QUICK, PERSONAL.' },
  { id:'bat',        name:'SPIKED BAT',         cls:'blunt',   kind:'melee', rar:0, dmg:26, rof:1.7, range:24, arc:110, kb:200, price:700, lvl:2, desc:'NIGHT CITY DIPLOMACY.' },
  { id:'katana',     name:'KATANA',             cls:'blade',   kind:'melee', rar:2, dmg:40, rof:2.4, range:26, arc:120, price:5600, lvl:8, desc:'EDGE OF THE STREET SAMURAI.' },
  // ---- ICONICS: dropped by cyberpsychos, never sold ----
  { id:'problem_solver', name:'PROBLEM SOLVER', cls:'smg',     kind:'power', rar:5, dmg:7,  rof:16,  mag:60, rel:1.5, spd:380, spread:9, iconic:1, price:24000, lvl:1, desc:'ICONIC. 60 ANSWERS PER MAGAZINE.' },
  { id:'headsman',   name:'THE HEADSMAN',       cls:'shotgun', kind:'power', rar:5, dmg:9,  rof:1.7, mag:6,  rel:1.6, spd:360, spread:14, pellets:9, kb:170, iconic:1, price:26000, lvl:1, desc:'ICONIC. EXECUTIONER\'S SCATTERGUN.' },
  { id:'moron_labe', name:'MORON LABE',         cls:'rifle',   kind:'power', rar:5, dmg:12, rof:11,  mag:35, rel:1.3, spd:480, spread:4, iconic:1, price:30000, lvl:1, desc:'ICONIC. COME AND TAKE IT.' },
  { id:'satori',     name:'SATORI',             cls:'blade',   kind:'melee', rar:5, dmg:48, rof:2.6, range:28, arc:130, crit:0.25, iconic:1, price:32000, lvl:1, desc:'ICONIC KATANA. ENLIGHTENMENT IN ONE CUT.' },
  { id:'overwatch',  name:'OVERWATCH',          cls:'sniper',  kind:'power', rar:5, dmg:110,rof:0.7, mag:5,  rel:2.0, spd:820, spread:0.5, pierce:2, iconic:1, price:38000, lvl:1, desc:'ICONIC SNIPER. A NOMAD\'S PROMISE KEPT.' },
  { id:'errata',     name:'ERRATA',             cls:'blade',   kind:'melee', rar:5, dmg:46, rof:2.2, range:28, arc:120, burn:1, iconic:1, price:34000, lvl:1, desc:'ICONIC THERMAL KATANA. CAUTERIZES AS IT CUTS.' },
  { id:'malorian',   name:'MALORIAN ARMS 3516', cls:'pistol',  kind:'power', rar:5, dmg:60, rof:2.2, mag:6,  rel:1.5, spd:560, spread:1, pierce:1, kb:150, burn:1, iconic:1, price:45000, lvl:1, desc:'ICONIC. A LEGEND\'S HAND CANNON. WAKE UP, SAMURAI.' },
  { id:'breakthrough', name:'BREAKTHROUGH',     cls:'sniper',  kind:'tech',  rar:5, dmg:85, rof:0.8, mag:4,  rel:2.2, spd:820, spread:0.5, pierce:9, wallPierce:1, iconic:1, price:42000, lvl:1, desc:'ICONIC TECH SNIPER. WALLS ARE A SUGGESTION.' },
  { id:'skippy',     name:'SKIPPY',             cls:'pistol',  kind:'smart', rar:5, dmg:11, rof:7,   mag:20, rel:1.0, spd:340, spread:6, homing:8, iconic:1, hidden:1, price:21000, lvl:1, desc:'ICONIC TALKING SMART PISTOL. HE AIMS HIMSELF. HE NEVER SHUTS UP.' },
  // ---- cyberware arm weapons (granted by ripperdoc) ----
  { id:'mantis_blades', name:'MANTIS BLADES',   cls:'mantis',  kind:'melee', rar:4, dmg:38, rof:3.4, range:26, arc:140, granted:1, price:15000, lvl:1, desc:'ARM CYBERWARE. FOLD-OUT MURDER.' },
  { id:'gorilla_arms',  name:'GORILLA ARMS',    cls:'gorilla', kind:'melee', rar:4, dmg:55, rof:1.5, range:22, arc:100, kb:260, granted:1, price:12000, lvl:1, desc:'ARM CYBERWARE. INDUSTRIAL-GRADE HAYMAKERS.' },
  { id:'monowire',      name:'MONOWIRE',        cls:'wire',    kind:'melee', rar:4, dmg:60, rof:2.0, range:46, arc:80, granted:1, price:18000, lvl:1, desc:'ARM CYBERWARE. MOLECULAR FILAMENT WHIP.' },
  { id:'proj_launcher', name:'PROJECTILE LAUNCH SYSTEM', cls:'launcher', kind:'power', rar:4, dmg:85, rof:0.8, mag:4, rel:2.5, spd:300, spread:2, aoe:45, granted:1, price:26000, lvl:1, desc:'ARM CYBERWARE. YOUR ARM IS NOW ARTILLERY.' },
];
const WPN = {}; WEAPONS.forEach(w => WPN[w.id] = w);
const ICONICS = ['problem_solver', 'headsman', 'moron_labe', 'satori', 'overwatch', 'errata', 'malorian', 'breakthrough'];

// ---- vehicles ---- top = px/s, acc = px/s^2
const CARS = [
  { id:'galena',   name:'THORTON GALENA G240',    price:3200,   top:190, acc:150, grip:0.88, hp:250, shape:'sedan',  col:'#b05c1a', col2:'#f9f002' },
  { id:'supron',   name:'MAHIR SUPRON FS3',       price:5500,   top:170, acc:120, grip:0.85, hp:420, shape:'van',    col:'#3d5a66', col2:'#05d9e8' },
  { id:'colby',    name:'THORTON COLBY C125',     price:8000,   top:200, acc:150, grip:0.87, hp:320, shape:'pickup', col:'#6e2f1d', col2:'#cfd6e4' },
  { id:'hella',    name:'ARCHER HELLA EC-D',      price:16000,  top:230, acc:180, grip:0.90, hp:300, shape:'sedan',  col:'#27414f', col2:'#ff9f1c' },
  { id:'alvarado', name:'VILLEFORT ALVARADO',     price:28000,  top:240, acc:185, grip:0.90, hp:340, shape:'muscle', col:'#3a1030', col2:'#ff2a6d' },
  { id:'type66',   name:'QUADRA TYPE-66 640 TS',  price:58000,  top:290, acc:240, grip:0.86, hp:330, shape:'muscle', col:'#23262e', col2:'#f9f002' },
  { id:'shion',    name:'MIZUTANI SHION MZ2',     price:72000,  top:300, acc:250, grip:0.92, hp:300, shape:'sport',  col:'#1b4f72', col2:'#05d9e8' },
  { id:'outlaw',   name:'HERRERA OUTLAW GTS',     price:99000,  top:320, acc:265, grip:0.93, hp:290, shape:'sport',  col:'#5b1020', col2:'#ff9f1c' },
  { id:'turbo',    name:'QUADRA TURBO-R V-TECH',  price:129000, top:330, acc:285, grip:0.94, hp:320, shape:'sport',  col:'#8a1538', col2:'#f9f002' },
  { id:'caliburn', name:'RAYFIELD CALIBURN',      price:157000, top:360, acc:320, grip:0.95, hp:300, shape:'hyper',  col:'#0c0c10', col2:'#f9f002' },
  { id:'kusanagi', name:'YAIBA KUSANAGI CT-3X',   price:22000,  top:310, acc:270, grip:0.90, hp:140, shape:'bike',   col:'#15151c', col2:'#ff2a6d', bike:1 },
  { id:'nazare',   name:'ARCH NAZARE',            price:46000,  top:330, acc:290, grip:0.88, hp:160, shape:'bike',   col:'#26262e', col2:'#ff9f1c', bike:1 },
];
const CARD = {}; CARS.forEach(c => CARD[c.id] = c);

// ---- cyberware ----  tiers: [{price,lvl,...}]; effects read by recalcStats()
const CYBER = [
  { id:'sandevistan', slot:'OPERATING SYSTEM', name:'SANDEVISTAN', os:1, desc:'REFLEX BOOSTER. [Q] SLOWS TIME WHILE YOU MOVE AT SPEED.',
    tiers:[{price:12000,lvl:6,dur:2.6,cd:28,ts:0.35},{price:26000,lvl:12,dur:3.6,cd:24,ts:0.30},{price:48000,lvl:18,dur:4.6,cd:20,ts:0.25}] },
  { id:'berserk', slot:'OPERATING SYSTEM', name:'BERSERK', os:1, desc:'COMBAT STIM OS. [Q] BOOSTS DAMAGE AND ARMOR, MELEE HITS HEAL.',
    tiers:[{price:9000,lvl:5,dur:6,cd:28,dmg:1.25,armor:20},{price:21000,lvl:11,dur:6,cd:26,dmg:1.4,armor:35},{price:40000,lvl:17,dur:7,cd:24,dmg:1.6,armor:50}] },
  { id:'memboost', slot:'FRONTAL CORTEX', name:'MEMORY BOOST', desc:'OPTIMIZED RECALL. EARN MORE XP FROM EVERYTHING.',
    tiers:[{price:3500,lvl:2,xp:1.12},{price:9000,lvl:8,xp:1.25},{price:20000,lvl:14,xp:1.4}] },
  { id:'kiroshi', slot:'OCULAR SYSTEM', name:'KIROSHI OPTICS', desc:'SEE ENEMY VITALS. HIGHER CRIT CHANCE. MK.2+ WIDENS MINIMAP SCAN.',
    tiers:[{price:2500,lvl:1,crit:0.07},{price:8000,lvl:7,crit:0.12},{price:18000,lvl:13,crit:0.18}] },
  { id:'biomonitor', slot:'CIRCULATORY', name:'BIOMONITOR', desc:'AUTO-INJECTS A MAXDOC WHEN HP DROPS BELOW 30%.',
    tiers:[{price:6500,lvl:4}] },
  { id:'second_heart', slot:'CIRCULATORY', name:'SECOND HEART', desc:'CHEAT DEATH. FULLY REVIVE ON FATAL DAMAGE. 180S COOLDOWN.',
    tiers:[{price:46000,lvl:20}] },
  { id:'kerenzikov', slot:'NERVOUS SYSTEM', name:'KERENZIKOV', desc:'TIME DILATES WHILE DASHING. SHOOT MID-DODGE LIKE A LEGEND.',
    tiers:[{price:7500,lvl:3,ts:0.55,dur:0.5},{price:16000,lvl:9,ts:0.45,dur:0.75},{price:30000,lvl:15,ts:0.35,dur:1.0}] },
  { id:'subdermal', slot:'INTEGUMENTARY', name:'SUBDERMAL ARMOR', desc:'ARMOR PLATING UNDER THE SKIN. FLAT DAMAGE REDUCTION.',
    tiers:[{price:4000,lvl:2,armor:18},{price:12000,lvl:8,armor:36},{price:26000,lvl:14,armor:60}] },
  { id:'camo', slot:'INTEGUMENTARY', name:'OPTICAL CAMO', desc:'[F] BEND LIGHT FOR 4S. ENEMIES LOSE YOU COMPLETELY.',
    tiers:[{price:24000,lvl:13,dur:4,cd:26}] },
  { id:'titanium', slot:'SKELETON', name:'TITANIUM BONES', desc:'REINFORCED FRAME. MORE MAX HP.',
    tiers:[{price:3000,lvl:1,hp:30},{price:10000,lvl:7,hp:60},{price:24000,lvl:13,hp:100}] },
  { id:'microrotor', slot:'SKELETON', name:'SYNAPTIC MICROROTORS', desc:'FASTER JOINTS, FASTER TRIGGER. INCREASED FIRE RATE.',
    tiers:[{price:5000,lvl:5,rof:1.08},{price:14000,lvl:11,rof:1.16},{price:28000,lvl:16,rof:1.25}] },
  { id:'smartlink', slot:'HANDS', name:'SMART LINK', desc:'TARGETING INTERFACE. REQUIRED FOR SMART WEAPONS, IMPROVES LOCK.',
    tiers:[{price:4500,lvl:3,turn:4},{price:13000,lvl:9,turn:6},{price:26000,lvl:15,turn:9}] },
  { id:'tendons', slot:'LEGS', name:'REINFORCED TENDONS', desc:'MOVE FASTER. DASH RECOVERS QUICKER.',
    tiers:[{price:4500,lvl:2,spd:1.08,dash:0.85},{price:12500,lvl:8,spd:1.15,dash:0.7},{price:26000,lvl:14,spd:1.22,dash:0.55}] },
  { id:'arm_mantis', slot:'ARMS', name:'MANTIS BLADES', grants:'mantis_blades', desc:'INSTALL FOLD-OUT BLADES. ADDS MANTIS BLADES TO YOUR ARSENAL.',
    tiers:[{price:15000,lvl:10}] },
  { id:'arm_gorilla', slot:'ARMS', name:'GORILLA ARMS', grants:'gorilla_arms', desc:'HYDRAULIC FISTS. ADDS GORILLA ARMS TO YOUR ARSENAL.',
    tiers:[{price:12000,lvl:8}] },
  { id:'arm_wire', slot:'ARMS', name:'MONOWIRE', grants:'monowire', desc:'NANOFILAMENT WHIP. ADDS MONOWIRE TO YOUR ARSENAL.',
    tiers:[{price:18000,lvl:12}] },
  { id:'arm_launcher', slot:'ARMS', name:'PROJECTILE LAUNCH SYSTEM', grants:'proj_launcher', desc:'ARM-MOUNTED ORDNANCE. ADDS LAUNCHER TO YOUR ARSENAL.',
    tiers:[{price:26000,lvl:15}] },
];
const CYB = {}; CYBER.forEach(c => CYB[c.id] = c);
const CYBER_SLOTS = ['OPERATING SYSTEM','FRONTAL CORTEX','OCULAR SYSTEM','CIRCULATORY','NERVOUS SYSTEM','INTEGUMENTARY','SKELETON','HANDS','ARMS','LEGS'];

// ---- districts & gangs ----
const DISTRICTS = {
  center:    { name:'CITY CENTER',   danger:1, fac:'scavs',     col:'#f9f002' },
  watson:    { name:'WATSON',        danger:1, fac:'maelstrom', col:'#05d9e8' },
  westbrook: { name:'WESTBROOK',     danger:2, fac:'tygers',    col:'#ff2a6d' },
  santo:     { name:'SANTO DOMINGO', danger:2, fac:'sixth',     col:'#ff9f1c' },
  pacifica:  { name:'PACIFICA',      danger:3, fac:'voodoo',    col:'#00ff9f' },
  dogtown:   { name:'DOGTOWN',       danger:4, fac:'barghest',  col:'#ff6a00' },
};
const FACTIONS = {
  scavs:     { name:'SCAV',        gun:0.55, pal:{ H:'#3a3a3a', S:'#cfa884', E:'#ff4444', J:'#2c2c2c', T:'#884444', P:'#22222a', B:'#101014' } },
  maelstrom: { name:'MAELSTROM',   gun:0.7,  pal:{ H:'#1a1a1a', S:'#b9b3a8', E:'#ff2a3c', J:'#16161a', T:'#ff2a3c', P:'#1a1a20', B:'#0c0c10' } },
  tygers:    { name:'TYGER CLAW',  gun:0.45, pal:{ H:'#101014', S:'#e0b48c', E:'#ff2a6d', J:'#2a1130', T:'#ff2a6d', P:'#1c1424', B:'#101014' } },
  sixth:     { name:'6TH STREET',  gun:0.65, pal:{ H:'#4a3826', S:'#d8a87c', E:'#f5b83d', J:'#1d2a4a', T:'#f5b83d', P:'#26262e', B:'#14141a' } },
  voodoo:    { name:'VOODOO BOY',  gun:0.6,  pal:{ H:'#0c0c10', S:'#7a5642', E:'#00ff9f', J:'#11281e', T:'#00ff9f', P:'#161e1a', B:'#0c0c10' } },
  barghest:  { name:'BARGHEST',    gun:0.8,  pal:{ H:'#1a1a14', S:'#c8a078', E:'#ff6a00', J:'#262a1c', T:'#ff6a00', P:'#1e2018', B:'#101008' } },
};
const PSYCHO_NAMES = ['BLOODY NOX','SCALPEL','TURBO SAINT','NEON REAPER','DUKE OF NUKES','MISS SHRAPNEL','DR. CHROME','ZERO COUNT'];

const BRANDS = ['KIROSHI','ARASAKA','MILITECH','NICOLA','CHROMANTICORE','ORBITAL AIR','SAMURAI','BUDGET ARMS','ALL FOODS','TRAUMA TEAM','ZETATECH','BIOTECHNICA','KANG TAO','WEST WIND'];

const TIPS = [
  'WASD: MOVE · MOUSE: AIM · LMB: FIRE · SPACE: DASH',
  'HURT? PRESS [C] TO SLAM A MAXDOC. VENDING MACHINES SELL REFILLS',
  'EARN EDDIES: HUNT BOUNTIES MARKED RED ON THE MINIMAP',
  'VISIT 2ND AMENDMENT [G ON MAP] TO EXPAND YOUR ARSENAL',
  'THE RIPPERDOC [R ON MAP] SELLS CHROME. START WITH KIROSHI OPTICS',
  'THE AUTOFIXER [A ON MAP] SELLS RIDES. [V] SUMMONS YOUR CAR',
  'CYBERPSYCHOS DROP ICONIC WEAPONS. COLLECT ALL 8',
  'PRESS [TAB] TO BROWSE YOUR COLLECTION',
  'YELLOW-TAGGED CRATES BREAK OPEN: EDDIES, DOCS, SOMETIMES IRON',
  'DOGTOWN [SW] IS BARGHEST TURF: ★★★★ DANGER, AIRDROPS, BIG PAYOUTS',
  'JIG-JIG STREET [NE] NEVER SLEEPS. CLOUDS CAN FIX YOURS',
  'ENEMIES HAVE EYES. STAY BEHIND THEM OR BREAK LINE OF SIGHT',
  'LIT DOORWAYS CAN BE ENTERED. HIDEOUTS HOLD LOOT — AND GONKS',
  'MELEE AN UNAWARE ENEMY FOR A 2.5X TAKEDOWN',
  'GREENERY IS COVER: STAND IN BUSHES TO DROP OUT OF ENEMY SIGHT',
  'WEATHER SHIFTS. FOG AND STORMS SHORTEN ENEMY VISION — USE THEM',
  'RUMOR: A TALKING PISTOL LIES IN A GUTTER SOMEWHERE...',
];
const FIXER_LINES = [
  'REGINA: STAY SHARP OUT THERE, MERC.',
  'REGINA: HEARD MAELSTROM IS MOVING CHROME THROUGH WATSON.',
  'REGINA: EDDIES TALK. COLLECT BOUNTIES, BUY BETTER IRON.',
  'REGINA: TYGER CLAWS RUN WESTBROOK. BRING A BLADE.',
  'REGINA: PACIFICA IS DANGER ZONE. TRIPLE PAY THOUGH.',
  'REGINA: VIK GIVES DISCOUNTS TO NOBODY. CHROME UP ANYWAY.',
  'REGINA: A CALIBURN? IN THIS ECONOMY? DREAM BIG, V.',
  'REGINA: BARGHEST GUARDS DOGTOWN LIKE A VAULT. BECAUSE IT IS ONE.',
  'REGINA: AIRDROP CHATTER ON MILITECH FREQUENCIES. KEEP AN EYE SOUTH-WEST.',
];
// joytoy / doll dialogue (kept tame — the spice is fade-to-black)
const JOY_GREET = [
  'HEY CHOOM. LOOKING FOR COMPANY?',
  'WELL HELLO, MERC. LONG NIGHT?',
  'NEW FACE ON JIG-JIG! BUY A GIRL A DRINK? OR SKIP TO THE FUN?',
];
const JOY_LINES = [
  'CAREFUL — CHROME LIKE YOURS COULD BREAK A HEART.',
  'YOU TALK CUTE FOR SOMEONE COVERED IN GUN OIL.',
  'FLATTERY GETS YOU A DISCOUNT. KIDDING. IT DOESN\'T.',
  'COME BACK ALIVE, OKAY? I MEAN IT.',
];
const DOLL_GREET = [
  'WELCOME TO CLOUDS. I\'M EVE. I ALREADY KNOW WHAT YOU NEED.',
  'BREATHE, V. IN HERE, THE CITY CAN\'T REACH YOU.',
];
const DOLL_LINES = [
  'YOUR PULSE SAYS YOU HAVEN\'T SLEPT IN DAYS. LET IT GO.',
  'EVERY MERC CARRIES GHOSTS. PUT THEM DOWN FOR AN HOUR.',
  'THE NET REMEMBERS EVERYTHING. PEOPLE? WE CHOOSE WHAT TO KEEP.',
];

const SKIPPY_LINES = [
  'SKIPPY: WHEEE! THAT WAS AWESOME!',
  'SKIPPY: YOU CAN\'T SPELL MASSACRE WITHOUT ME!',
  'SKIPPY: I LOVE YOU, USER!',
  'SKIPPY: ANOTHER ONE BITES THE DUST! PEW PEW!',
  'SKIPPY: ETHICS SUBROUTINE? NEVER INSTALLED!',
  'SKIPPY: YOU ARE MY FAVORITE MEAT-FRIEND!',
];

// new-game random starter kit pools
const STARTER_WPNS = ['liberty', 'lexington', 'unity', 'knife', 'bat'];
const STARTER_CARS = ['galena', 'supron', 'colby'];

// weather: density = raindrop count, range = enemy view-range multiplier
const WEATHERS = {
  clear:   { name: 'CLEAR NIGHT',  density: 0,   thunder: 0,   range: 1 },
  drizzle: { name: 'DRIZZLE',      density: 55,  thunder: 0.1, range: 1 },
  storm:   { name: 'STORM',        density: 160, thunder: 1,   range: 0.85, tint: 'rgba(40,60,110,0.07)' },
  acid:    { name: 'ACID DRIZZLE', density: 90,  thunder: 0.2, range: 1,    tint: 'rgba(120,255,80,0.045)', rainCol: 'rgba(150,230,110,0.22)' },
  fog:     { name: 'FOG',          density: 0,   thunder: 0,   range: 0.7,  tint: 'rgba(170,180,200,0.05)', fog: 1 },
  smog:    { name: 'SMOG',         density: 0,   thunder: 0,   range: 0.85, tint: 'rgba(255,140,60,0.05)',  fog: 0.6, fogCol: '#cf8a4a' },
};
const WEATHER_POOL = ['clear', 'clear', 'drizzle', 'drizzle', 'drizzle', 'storm', 'storm', 'fog', 'fog', 'acid', 'acid', 'smog'];

function xpFor(lvl) { return Math.floor(70 * Math.pow(lvl, 1.45)); }
function dpsOf(w) { return Math.round(w.dmg * (w.pellets || 1) * w.rof); }
