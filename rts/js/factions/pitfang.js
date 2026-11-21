'use strict';
// NEON TURF — faction data: PITFANG / 獠牙帮   (HEADLESS-SAFE; pure data)
// A prize-fight circuit that outgrew its basements. Rank is settled in the
// ring, bodies are built in the Sweatbox and the Cookhouse, and the kennels
// under the arena breed animals to match. Everything is a bout: weigh-ins,
// purses, a main event.
// Identity: NEVER STOP. Every body regenerates between fights, fighters get
// their blood up as they close (a rush, then a comedown), kills pay a purse,
// cats pounce and bulls charge. Nothing here out-ranges a thrown rebar —
// until the Hammer Throwers arrive.
// Authoring contract: see the header of js/rules.js.
NT.defineFaction({
  id: 'pitfang',
  name: { en: 'Pitfang', zh: '獠牙帮' },
  tagline: { en: 'Top of the food chain.', zh: '弱肉强食，拳头说话。' },
  desc: {
    en: 'Tempo and momentum. Cheap, fast, self-healing bodies flood in from several angles; kills pay cash and wounds make them meaner. Close the distance, starve the enemy, overrun the guns — or stall at range and lose.',
    zh: '节奏与冲劲。廉价、迅捷、会自愈的肉体从多个方向涌入；击杀换赏金，受伤更凶狠。拉近距离、掐断对手财路、冲垮炮位——否则就会被远程火力拖死。',
  },
  color: '#ff3b6b',
  palette: { hide: '#3a1620', meat: '#b3263c', bone: '#e9e2cf', bruise: '#5b2a6e', rush: '#9dff3a', rust: '#8a4b2a', tarp: '#6b5a45', skin: '#c98d6b', fur: '#2b2530' },
  powerName: { en: 'Feed', zh: '口粮' },
  queues: [
    { id: 'structure', name: { en: 'Dens', zh: '窝点' }, kind: 'building' },
    { id: 'defense', name: { en: 'Guards', zh: '看守' }, kind: 'building' },
    { id: 'infantry', name: { en: 'Fighters', zh: '斗士' }, kind: 'unit' },
    { id: 'heavy', name: { en: 'Beasts', zh: '猛兽' }, kind: 'unit' },
  ],
  start: { buildings: [{ def: 'cage' }], units: [{ def: 'scrapper', n: 4 }] },
  // Skirmish AI hints (shape: rules.js contract header): relative share of army value per unit.
  ai: { army: { scrapper: 1, skewer: 0.8, strongarm: 0.3, canopener: 0.9, thrower: 0.7, champion: 2, alleycat: 0.8, bull: 1, butcherbird: 0.6 } },

  buildings: {
    cage: {
      name: { en: 'Broken Cage', zh: '破笼堂' },
      desc: { en: 'The first pit the gang ever held, its bars bent outward. Every den is ordered from here; the door money trickles in.', zh: '帮派拿下的第一座斗坑，铁栏朝外掰弯。所有窝点由此下令兴建，门票钱也在此缓缓入账。' },
      role: 'hq', tier: 1, cost: 3000, hp: 3200, size: [3, 3], power: 50, sight: 7,
      traits: { producer: { queues: ['structure', 'defense'] }, income: { amount: 15, every: 5 } },
    },
    locker: {
      name: { en: 'Meat Locker', zh: '冻肉库' },
      desc: { en: 'A cold store stacked with vat-grown carcasses. Supplies Feed; a hungry gang trains slowly.', zh: '堆满培养肉的冷库。供应口粮；饿着肚子的帮众练得慢。' },
      role: 'power', tier: 1, queue: 'structure', cost: 300, hp: 450, size: [2, 2], power: 100,
    },
    sweatbox: {
      name: { en: 'Sweatbox', zh: '撸铁馆' },
      desc: { en: 'A cage gym with rusted plates and no mirrors. Recruits train until they can take a punch.', zh: '只有生锈杠铃、没有镜子的铁笼健身房。新人练到扛得住拳头为止。' },
      role: 'producer', tier: 1, queue: 'structure', cost: 450, hp: 850, size: [2, 2], power: -10, requires: ['locker'],
      traits: { producer: { queues: ['infantry'] } },
    },
    weighin: {
      name: { en: 'Weigh-In', zh: '过磅处' },
      desc: { en: 'Hauls are weighed here and sold to the fences. Arrives with one Gorge Hog; can be set up beside any heap you can see.', zh: '收来的货在此过磅，转手卖给销赃人。自带一头吞金兽；可建在视野内任何碎金堆旁。' },
      role: 'dropoff', tier: 1, queue: 'structure', cost: 1900, hp: 1300, size: [3, 2], power: -20, requires: ['locker'],
      placement: 'free',
      traits: { dropoff: { freeUnit: 'hog' } },
    },
    pens: {
      name: { en: 'Beast Pens', zh: '兽栏' },
      desc: { en: 'Rows of reinforced stalls under a tarp. The gang\'s four-legged and winged fighters are bred and fed here; beasts resting nearby heal faster.', zh: '篷布下一排排加固的兽栏。帮派的四足与飞行斗士在此繁育喂养；在旁休息的野兽恢复更快。' },
      role: 'producer', tier: 2, queue: 'structure', cost: 1900, hp: 1400, size: [3, 3], power: -30, requires: ['weighin'],
      traits: { producer: { queues: ['heavy'] }, aura: { radius: 3, affects: 'allies', tags: ['beast'], mods: { regen: 0.02 } } },
    },
    crowsnest: {
      name: { en: 'Crow\'s Nest', zh: '鸦巢' },
      desc: { en: 'A rooftop loft of trained crows whose handlers read the streets. Gives the minimap, unlocks the big fighters, charges Open the Cages.', zh: '屋顶的驯鸦阁，驯鸦人借群鸦看清街面。提供小地图，解锁大块头，并为“开笼”充能。' },
      role: 'radar', tier: 2, queue: 'structure', cost: 900, hp: 700, size: [2, 2], power: -30, requires: ['weighin'],
      traits: { radar: {} },
    },
    cookhouse: {
      name: { en: 'Cookhouse', zh: '药膳房' },
      desc: { en: 'A noodle kitchen that now simmers growth serum. Unlocks the Hammer Thrower, the Pit Champion and the Prize Pit.', zh: '如今熬着生长血清的面馆后厨。解锁链球手、擂主与擂台。' },
      role: 'tech', tier: 3, queue: 'structure', cost: 1500, hp: 1000, size: [3, 2], power: -40, requires: ['pens', 'crowsnest'],
    },
    prizepit: {
      name: { en: 'Prize Pit', zh: '擂台' },
      desc: { en: 'The championship ring under stadium lights. When the crowd roars, the whole gang answers. Charges Main Event.', zh: '体育场灯光下的冠军擂台。全场一吼，整个帮派应声而起。为“压轴好戏”充能。' },
      role: 'super', tier: 3, queue: 'structure', cost: 2600, hp: 1300, size: [3, 3], power: -80, requires: ['cookhouse'], limit: 1,
    },
    chainpost: {
      name: { en: 'Chain Post', zh: '拴兽桩' },
      desc: { en: 'A starved fighting beast staked on a short chain. Anything on the ground inside its circle is torn apart. Needs no Feed.', zh: '用短链拴在桩上的饿兽。踏进它那一圈的地面目标都会被撕碎。无需口粮。' },
      role: 'defense', tier: 1, queue: 'defense', cost: 350, hp: 700, size: [1, 1], power: 0, sight: 5, requires: ['sweatbox'],
      weapons: [{ name: { en: 'Chained bite', zh: '链上撕咬' }, dmg: 50, range: 2.2, cooldown: 0.9, proj: 'melee', warhead: 'melee', splash: 0.5, turret: true }],
      traits: { enrage: { below: 0.5, mods: { dmg: 1.4 } } },
    },
    perch: {
      name: { en: 'Brick Perch', zh: '板砖台' },
      desc: { en: 'A scaffold where a bruiser hurls cinder blocks. Splash damage against infantry. Needs no Feed.', zh: '脚手架上的壮汉往下砸水泥砖。对步兵造成溅射伤害。无需口粮。' },
      role: 'defense', tier: 1, queue: 'defense', cost: 450, hp: 500, size: [1, 1], power: 0, sight: 7, requires: ['sweatbox'],
      weapons: [{ name: { en: 'Cinder blocks', zh: '水泥砖' }, dmg: 40, range: 5, cooldown: 1.8, proj: 'lob', warhead: 'he', splash: 1.0, fx: 'brick' }],
    },
    ballista: {
      name: { en: 'Rebar Ballista', zh: '钢筋弩' },
      desc: { en: 'A hand-cranked leaf-spring ballista. Pins vehicles and drops flyers at long range; weak against infantry. Needs no Feed.', zh: '手摇钢板弹簧弩。远距离钉住车辆、射落飞行单位；对步兵乏力。无需口粮。' },
      role: 'defense', tier: 2, queue: 'defense', cost: 900, hp: 650, size: [1, 1], power: 0, sight: 8, requires: ['crowsnest'],
      weapons: [{ name: { en: 'Rebar bolt', zh: '钢筋弩箭' }, dmg: 80, range: 6.5, cooldown: 2.6, proj: 'bullet', warhead: 'ap', speed: 16, air: true, turret: true, fx: 'rebar',
        onHit: { slow: { mult: 0.6, dur: 2, armor: ['light', 'heavy'] } } }],
    },
  },

  units: {
    hog: {
      name: { en: 'Gorge Hog', zh: '吞金兽' },
      desc: { en: 'A car-sized boar that eats e-waste and coughs up Glint. Smaller loads, quicker trips, heals on its own.', zh: '轿车大小的野猪，吞下电子垃圾再吐出碎金。载量小、往返快，还会自愈。' },
      tags: ['beast'], tier: 1, queue: 'heavy', cost: 1200, hp: 600, armor: 'heavy',
      move: { type: 'beast', speed: 2.5 }, sight: 4, requires: ['weighin'],
      traits: { harvester: { capacity: 500, loadTime: 15, unloadTime: 3 }, selfHeal: { rate: 0.02, delay: 5 } },
    },
    scrapper: {
      name: { en: 'Scrapper', zh: '打仔' },
      desc: { en: 'A recruit with taped fists and something to prove. Cheap, quick, self-healing, paid by the scalp; gets his blood up as he closes.', zh: '缠着拳带、急于证明自己的新人。便宜、敏捷、会自愈，按人头领赏；逼近时会“上头”。' },
      tags: ['infantry', 'melee', 'antiInfantry'], tier: 1, queue: 'infantry', cost: 100, hp: 70, armor: 'infantry',
      move: { type: 'foot', speed: 3.0 }, sight: 6,
      weapons: [{ name: { en: 'Taped fists', zh: '缠带铁拳' }, dmg: 15, range: 1.5, cooldown: 0.7, proj: 'melee', warhead: 'melee' }],
      traits: {
        surge: { cooldown: 20, dur: 6, range: 5, mods: { speed: 1.35, rof: 1.25 }, crash: 4, crashMods: { speed: 0.8, rof: 0.8 } },
        selfHeal: { rate: 0.03, delay: 5 }, bounty: { frac: 0.1 },
      },
    },
    skewer: {
      name: { en: 'Skewer', zh: '钢筋投手' },
      desc: { en: 'Hurls sharpened rebar hard enough to pin a truck door. Slows vehicles; the only fighter that reaches flyers.', zh: '投出的钢筋能把卡车门钉穿。命中使车辆减速；唯一够得着飞行单位的斗士。' },
      tags: ['infantry', 'antiArmor', 'antiAir'], tier: 1, queue: 'infantry', cost: 220, hp: 70, armor: 'infantry',
      move: { type: 'foot', speed: 2.3 }, sight: 6,
      weapons: [{ name: { en: 'Sharpened rebar', zh: '磨尖钢筋' }, dmg: 34, range: 4.5, cooldown: 1.8, proj: 'bullet', warhead: 'ap', speed: 14, air: true, fx: 'rebar',
        onHit: { slow: { mult: 0.6, dur: 2, armor: ['light', 'heavy'] } } }],
      traits: { selfHeal: { rate: 0.03, delay: 5 }, bounty: { frac: 0.1 } },
    },
    strongarm: {
      name: { en: 'Strongarm', zh: '收账佬' },
      desc: { en: 'A collector who walks in and explains the new ownership. Claims turf for the gang and pockets a fee on the spot; a middling brawler otherwise.', zh: '上门“讲道理”的收账人，三言两语就让店面换了东家。为帮派占领地盘并当场收一笔账；打架只算一般。' },
      tags: ['infantry', 'melee', 'support'], tier: 1, queue: 'infantry', cost: 350, hp: 130, armor: 'infantry',
      move: { type: 'foot', speed: 2.4 }, sight: 5,
      weapons: [{ name: { en: 'Brass knuckles', zh: '指虎' }, dmg: 14, range: 1.5, cooldown: 0.9, proj: 'melee', warhead: 'melee' }],
      traits: { capturer: { time: 5, payout: 100 }, selfHeal: { rate: 0.03, delay: 5 } },
    },
    canopener: {
      name: { en: 'Can Opener', zh: '开罐手' },
      desc: { en: 'A giant with a breaching bar. Peels tanks, turrets and walls open; too big to run over, meaner when hurt.', zh: '拎着破门撬棍的巨汉。把坦克、炮塔和墙壁像罐头一样撬开；块头太大碾不动，越受伤越凶。' },
      tags: ['infantry', 'melee', 'antiArmor', 'antiBuilding', 'uncrushable'], tier: 2, queue: 'infantry', cost: 500, hp: 340, armor: 'infantry',
      move: { type: 'foot', speed: 2.2 }, sight: 5, requires: ['crowsnest'],
      weapons: [{ name: { en: 'Breaching bar', zh: '破门撬棍' }, dmg: 55, range: 1.5, cooldown: 1.1, proj: 'melee', warhead: 'smash' }],
      traits: {
        surge: { cooldown: 20, dur: 6, range: 5, mods: { speed: 1.3, rof: 1.25 }, crash: 4, crashMods: { speed: 0.8, rof: 0.8 } },
        enrage: { below: 0.5, mods: { dmg: 1.4, speed: 1.2 } },
        selfHeal: { rate: 0.025, delay: 5 }, bounty: { frac: 0.1 },
      },
    },
    thrower: {
      name: { en: 'Hammer Thrower', zh: '链球手' },
      desc: { en: 'Hurls chained gas cylinders like a track-and-field star. Slow living artillery that out-ranges most guns.', zh: '像田径明星一样甩出拴着铁链的煤气罐。行动迟缓的人肉火炮，射程压过大多数炮位。' },
      tags: ['infantry', 'siege', 'antiBuilding', 'uncrushable'], tier: 3, queue: 'infantry', cost: 800, hp: 220, armor: 'infantry',
      move: { type: 'foot', speed: 1.7 }, sight: 5, requires: ['cookhouse'],
      weapons: [{ name: { en: 'Chained gas cylinder', zh: '链球煤气罐' }, dmg: 100, range: 8, minRange: 2.5, cooldown: 5, proj: 'lob', warhead: 'he', splash: 1.5, fx: 'cylinder' }],
      traits: { selfHeal: { rate: 0.02, delay: 5 }, bounty: { frac: 0.1 } },
    },
    champion: {
      name: { en: 'Pit Champion', zh: '擂主' },
      desc: { en: 'Undefeated on the arena floor. Leaps into the line and makes every gang member nearby hit harder. One at a time.', zh: '擂台上的不败者。跃入敌阵，并让附近的帮众下手更狠。同时只能有一位。' },
      tags: ['infantry', 'melee', 'hero', 'antiInfantry', 'uncrushable'], tier: 3, queue: 'infantry', cost: 1400, hp: 800, armor: 'infantry',
      move: { type: 'foot', speed: 2.7 }, sight: 6, requires: ['cookhouse'], limit: 1,
      weapons: [{ name: { en: 'Title-belt swing', zh: '金腰带横扫' }, dmg: 80, range: 1.6, cooldown: 1.3, proj: 'melee', warhead: 'melee', splash: 0.9 }],
      traits: {
        leap: { range: 5, minRange: 2, cooldown: 12, dmg: 60, warhead: 'melee' },
        aura: { radius: 4, affects: 'allies', mods: { dmg: 1.15, speed: 1.1 } },
        selfHeal: { rate: 0.02, delay: 5 }, bounty: { frac: 0.1 },
      },
    },
    alleycat: {
      name: { en: 'Alley Cat', zh: '巷豹' },
      desc: { en: 'A quarter-ton engineered jaguar. Scout and raider that pounces past the front line onto gunners, mortars and harvesters.', zh: '四分之一吨重的改造美洲豹。侦察兼突袭，越过前排直扑炮手、迫击炮与采集者。' },
      tags: ['beast', 'melee', 'scout', 'antiInfantry'], tier: 2, queue: 'heavy', cost: 450, hp: 240, armor: 'light',
      move: { type: 'beast', speed: 4.4 }, sight: 8,
      weapons: [{ name: { en: 'Claws', zh: '利爪' }, dmg: 30, range: 1.5, cooldown: 0.8, proj: 'melee', warhead: 'melee' }],
      traits: { leap: { range: 4.5, minRange: 2, cooldown: 7, dmg: 40, warhead: 'melee' }, selfHeal: { rate: 0.03, delay: 5 }, bounty: { frac: 0.1 } },
    },
    bull: {
      name: { en: 'Wrecking Bull', zh: '拆迁牛' },
      desc: { en: 'A serum-swollen fighting bull. Its charge flips trucks and caves in walls; wound it and it only gets angrier.', zh: '被血清催得膀大腰圆的斗牛。一次冲锋能掀翻卡车、撞塌墙壁；受了伤只会更暴躁。' },
      tags: ['beast', 'melee', 'tank', 'antiArmor', 'antiBuilding'], tier: 2, queue: 'heavy', cost: 900, hp: 720, armor: 'heavy',
      move: { type: 'beast', speed: 2.5 }, sight: 5, requires: ['crowsnest'],
      weapons: [{ name: { en: 'Horn ram', zh: '牛角冲撞' }, dmg: 80, range: 1.5, cooldown: 1.6, proj: 'melee', warhead: 'smash' }],
      traits: {
        leap: { range: 5, minRange: 2, cooldown: 12, dmg: 100, warhead: 'smash', slow: { mult: 0.5, dur: 2 }, style: 'dash' },
        enrage: { below: 0.4, mods: { dmg: 1.4, speed: 1.2 } },
        selfHeal: { rate: 0.02, delay: 5 }, bounty: { frac: 0.1 },
      },
    },
    butcherbird: {
      name: { en: 'Butcherbird', zh: '屠夫鸟' },
      desc: { en: 'A condor-sized raptor from the Crow\'s Nest. Rips drones out of the sky, stalks lone harvesters and mortar crews.', zh: '鸦巢放出的秃鹰大小的猛禽。把无人机撕下天空，尾随落单的采集者与迫击炮组。' },
      tags: ['beast', 'scout', 'antiAir'], tier: 2, queue: 'heavy', cost: 550, hp: 150, armor: 'light',
      move: { type: 'air', speed: 4.4 }, sight: 9, requires: ['crowsnest'],
      weapons: [{ name: { en: 'Talons', zh: '利爪' }, dmg: 28, range: 1.5, cooldown: 0.9, proj: 'melee', warhead: 'melee', air: true }],
      traits: { lifesteal: { frac: 0.3 }, selfHeal: { rate: 0.02, delay: 5 }, bounty: { frac: 0.1 } },
    },
  },

  powers: {
    uncage: {
      name: { en: 'Open the Cages', zh: '开笼' },
      desc: { en: 'Two seconds of rattling grates, then three Alley Cats burst out anywhere you can see. They stay for 45 seconds.', zh: '铁栅咣当作响两秒后，三头巷豹冲出——可指定视野内任意位置。它们只停留45秒。' },
      building: 'crowsnest', cooldown: 180, kind: 'spawn', spawn: { def: 'alleycat', count: 3, delay: 2, lifetime: 45 },
    },
    mainevent: {
      name: { en: 'Main Event', zh: '压轴好戏' },
      desc: { en: 'The gang in the target area hits harder and moves faster for 12 seconds — then comes down hard for 6.', zh: '目标区域内的帮众在12秒内攻击更狠、移动更快——随后是6秒的脱力期。' },
      building: 'prizepit', cooldown: 240, kind: 'buff',
      buff: { radius: 5, dur: 12, affects: 'allies', mods: { dmg: 1.4, speed: 1.25, rof: 1.15 }, after: { dur: 6, mods: { dmg: 0.8, speed: 0.75 } } },
    },
  },
});
