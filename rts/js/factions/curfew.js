'use strict';
// NEON TURF — faction data: CURFEW COMPANY / 宵禁连   (HEADLESS-SAFE; pure data)
// The block itself goes to war. When the city cut the district loose, its
// civil-defence volunteers — old soldiers, firefighters, bus mechanics —
// declared a curfew and never lifted it. Their kit is whatever the block
// already owned, plated and drilled: a fire engine, a garbage truck, drones
// from the pigeon loft and the memorial tank from the square.
// Identity: STAND STILL. Fighters brace after two seconds without moving
// (longer reach, tougher); the big guns need power and a spotter; hoses and
// machine guns slow whatever charges the line.
// Authoring contract: see the header of js/rules.js.
NT.defineFaction({
  id: 'curfew',
  name: { en: 'Curfew Company', zh: '宵禁连' },
  tagline: { en: 'Lights out. Doors locked. We hold the street.', zh: '熄灯，锁门，这条街我们守。' },
  desc: {
    en: 'Positional combined arms. Fragile on the move, lethal once braced: out-range the enemy, slow the charge, shell what stops, then walk the line forward one block at a time.',
    zh: '阵地化的多兵种协同。行军时脆弱，站稳据守后致命：比敌人打得更远，迟滞冲锋，炮击停下的目标，再一个街区一个街区地向前推进。',
  },
  color: '#ffb000',
  palette: { drab: '#5d6b3a', drabDark: '#3b4526', concrete: '#8a8f98', steel: '#4a505c', canvas: '#b9a77a', hazard: '#ffd23f', lamp: '#ffe9b0', tyre: '#1b1d22', engine: '#c0392b' },
  powerName: { en: 'Power', zh: '电力' },
  queues: [
    { id: 'structure', name: { en: 'Works', zh: '工事' }, kind: 'building' },
    { id: 'defense', name: { en: 'Defences', zh: '防务' }, kind: 'building' },
    { id: 'infantry', name: { en: 'Muster', zh: '兵员' }, kind: 'unit' },
    { id: 'heavy', name: { en: 'Motor Pool', zh: '车场' }, kind: 'unit' },
  ],
  start: { buildings: [{ def: 'command' }], units: [{ def: 'picket', n: 4 }] },
  // Skirmish AI hints (shape: rules.js contract header): relative share of army value per unit.
  ai: { army: { picket: 1, stovepipe: 1, sweeper: 0.5, hydrant: 1, doorman: 1.4, mailman: 0.9, monument: 2 } },

  buildings: {
    command: {
      name: { en: 'Ward Command', zh: '街坊司令部' },
      desc: { en: 'A requisitioned fire station with maps taped over the windows. Every structure order starts here; block dues trickle in.', zh: '征用的消防站，窗户上贴满地图。一切建造命令从这里发出，街坊的份子钱也在此缓缓入账。' },
      role: 'hq', tier: 1, cost: 3000, hp: 3000, size: [3, 3], power: 50, sight: 7,
      traits: { producer: { queues: ['structure', 'defense'] }, income: { amount: 15, every: 5 } },
    },
    genny: {
      name: { en: 'Genny Shed', zh: '油机棚' },
      desc: { en: 'Diesel generators chained under a tin roof. Cheap power — and a fuel blast when it dies.', zh: '铁皮棚下拴着的柴油发电机。电力便宜，被毁时油料会爆炸。' },
      role: 'power', tier: 1, queue: 'structure', cost: 300, hp: 500, size: [2, 2], power: 100,
      traits: { explodeOnDeath: { dmg: 80, radius: 1.5, warhead: 'he' } },
    },
    drillhall: {
      name: { en: 'Drill Hall', zh: '操练堂' },
      desc: { en: 'A community gym turned parade square. Trains infantry and patches up those resting nearby.', zh: '社区体育馆改成的操场。训练步兵，并为在附近休整的步兵疗伤。' },
      role: 'producer', tier: 1, queue: 'structure', cost: 450, hp: 800, size: [3, 2], power: -10, requires: ['genny'],
      traits: { producer: { queues: ['infantry'] }, aura: { radius: 3, affects: 'allies', tags: ['infantry'], mods: { regen: 0.03 } } },
    },
    qmyard: {
      name: { en: 'Quartermaster Yard', zh: '军需场' },
      desc: { en: 'A fenced school car park where Glint is weighed and logged. Arrives with one Requisition Rig; can be set up beside any heap you can see.', zh: '用铁丝网围起的学校停车场，碎金在此过磅入账。自带一辆征收车；可建在视野内任何碎金堆旁。' },
      role: 'dropoff', tier: 1, queue: 'structure', cost: 1900, hp: 1200, size: [3, 2], power: -30, requires: ['genny'],
      placement: 'free',
      traits: { dropoff: { freeUnit: 'rig' } },
    },
    motorpool: {
      name: { en: 'Motor Pool', zh: '车场' },
      desc: { en: 'A bus depot with welding rigs. Civilian vehicles roll in, plated ones roll out; repairs any parked nearby.', zh: '配有焊机的公交车库。民用车开进来，装甲车开出去；并维修停在附近的载具。' },
      role: 'producer', tier: 2, queue: 'structure', cost: 1900, hp: 1400, size: [3, 3], power: -30, requires: ['qmyard'],
      traits: { producer: { queues: ['heavy'] }, aura: { radius: 3, affects: 'allies', tags: ['vehicle', 'drone'], mods: { regen: 0.025 } } },
    },
    loft: {
      name: { en: 'Signal Loft', zh: '信号阁' },
      desc: { en: 'A rooftop pigeon loft strung with antennas. Gives the minimap, unlocks the heavier vehicles, charges Block Watch.', zh: '架满天线的屋顶鸽舍。提供小地图，解锁更重型的车辆，并为“街坊眼线”充能。' },
      role: 'radar', tier: 2, queue: 'structure', cost: 1000, hp: 700, size: [2, 2], power: -40, requires: ['qmyard'],
      traits: { radar: {} },
    },
    arsenal: {
      name: { en: 'Surplus Arsenal', zh: '军械库' },
      desc: { en: 'A flooded garage full of crates with scrubbed serial numbers. Unlocks the Pigeon, the Monument and the Curfew Siren.', zh: '积水车库里一箱箱磨掉编号的军火。解锁信鸽、纪念碑与宵禁警报塔。' },
      role: 'tech', tier: 3, queue: 'structure', cost: 1700, hp: 1000, size: [3, 2], power: -50, requires: ['motorpool', 'loft'],
    },
    siren: {
      name: { en: 'Curfew Siren', zh: '宵禁警报塔' },
      desc: { en: 'An air-raid horn on a water tower. When it wails, every gun on the block fires at one grid. Charges Lights Out.', zh: '水塔上的防空警报器。它一响，全街区的炮都朝同一个坐标开火。为“熄灯号”充能。' },
      role: 'super', tier: 3, queue: 'structure', cost: 2700, hp: 1000, size: [3, 3], power: -100, requires: ['arsenal'], limit: 1,
    },
    nest: {
      name: { en: 'Sandbag Nest', zh: '沙袋枪巢' },
      desc: { en: 'A machine gun on a stoop behind sandbags. Shreds infantry and flyers, slows chargers. Needs no power.', zh: '门廊沙袋后的重机枪。扫射步兵与飞行单位，并迟滞冲锋者。无需电力。' },
      role: 'defense', tier: 1, queue: 'defense', cost: 500, hp: 600, size: [1, 1], power: 0, sight: 7, requires: ['drillhall'],
      weapons: [{ name: { en: 'Heavy MG', zh: '重机枪' }, dmg: 12, range: 5.5, cooldown: 0.3, proj: 'bullet', warhead: 'small', air: true, turret: true,
        onHit: { slow: { mult: 0.75, dur: 1.5 } } }],
    },
    duggun: {
      name: { en: 'Dug-In Gun', zh: '坐地炮' },
      desc: { en: 'A tank turret sunk in concrete. Long-range armour killer that anchors a street; goes dark without power, cannot hit flyers.', zh: '埋进混凝土的坦克炮塔。镇守整条街的远程反装甲火力；断电即瘫痪，无法对空。' },
      role: 'defense', tier: 2, queue: 'defense', cost: 1100, hp: 1000, size: [2, 2], power: -40, sight: 8, requires: ['loft'],
      weapons: [{ name: { en: '105 mm gun', zh: '105毫米炮' }, dmg: 120, range: 7, cooldown: 2.4, proj: 'shell', warhead: 'ap', splash: 0.4, turret: true }],
    },
  },

  units: {
    rig: {
      name: { en: 'Requisition Rig', zh: '征收车' },
      desc: { en: 'A plated garbage truck with a crane claw. Slow and stubborn; hauls big loads of Glint home.', zh: '加装钢板、带抓斗的垃圾车。又慢又倔，一趟能拉回大量碎金。' },
      tags: ['vehicle'], tier: 1, queue: 'heavy', cost: 1200, hp: 700, armor: 'heavy',
      move: { type: 'wheel', speed: 1.9 }, sight: 4, requires: ['qmyard'],
      traits: { harvester: { capacity: 700, loadTime: 19, unloadTime: 4 } },
    },
    picket: {
      name: { en: 'Picket', zh: '街哨' },
      desc: { en: 'A neighbour with a service rifle and an armband. Two seconds standing still and he is braced: longer reach, tougher.', zh: '戴袖标、持步枪的街坊。原地站定两秒即据守：射程更远、更耐打。' },
      tags: ['infantry', 'antiInfantry'], tier: 1, queue: 'infantry', cost: 110, hp: 65, armor: 'infantry',
      move: { type: 'foot', speed: 2.0 }, sight: 6,
      weapons: [{ name: { en: 'Service rifle', zh: '制式步枪' }, dmg: 12, range: 4.5, cooldown: 0.8, proj: 'bullet', warhead: 'small' }],
      traits: { brace: { delay: 2, mods: { range: 1.2, taken: 0.7 }, uncrushable: false } },
    },
    stovepipe: {
      name: { en: 'Stovepipe', zh: '老炮' },
      desc: { en: 'A grey-haired vet with a rocket tube older than his knees. Cracks vehicles, beasts and flyers; braces like a Picket.', zh: '扛着比膝盖还老的火箭筒的白发老兵。专打车辆、巨兽和飞行单位；同样会原地据守。' },
      tags: ['infantry', 'antiArmor', 'antiAir'], tier: 1, queue: 'infantry', cost: 280, hp: 65, armor: 'infantry',
      move: { type: 'foot', speed: 2.0 }, sight: 6,
      weapons: [{ name: { en: 'Rocket tube', zh: '火箭筒' }, dmg: 48, range: 5.5, cooldown: 2.5, proj: 'rocket', warhead: 'ap', air: true, homing: true }],
      traits: { brace: { delay: 2, mods: { range: 1.2, taken: 0.7 }, uncrushable: false } },
    },
    groundskeeper: {
      name: { en: 'Groundskeeper', zh: '地头蛇' },
      desc: { en: 'Knows every alley and every landlord. Claims turf for the Company and patches up people and vehicles. Unarmed.', zh: '认得每条巷子，也认得每个房东。为连队占领地盘，顺手救治人员、修理车辆。没有武器。' },
      tags: ['infantry', 'support', 'healer'], tier: 1, queue: 'infantry', cost: 300, hp: 100, armor: 'infantry',
      move: { type: 'foot', speed: 2.5 }, sight: 5,
      weapons: [{ name: { en: 'Toolbox and first-aid kit', zh: '工具箱与急救包' }, dmg: 9, range: 2.5, cooldown: 0.5, proj: 'beam', warhead: 'small', heal: true, healTags: ['infantry', 'vehicle', 'drone'], fx: 'heal' }],
      traits: { capturer: { time: 5 } },
    },
    sweeper: {
      name: { en: 'Streetsweeper', zh: '扫街车' },
      desc: { en: 'A quad-gun pickup. Fast scout that mows down infantry and birds; folds to rebar and horns.', zh: '架着四联机枪的皮卡。高速侦察，横扫步兵与飞禽；怕钢筋和牛角。' },
      tags: ['vehicle', 'scout', 'antiInfantry', 'antiAir'], tier: 2, queue: 'heavy', cost: 550, hp: 250, armor: 'light',
      move: { type: 'wheel', speed: 3.5 }, sight: 8,
      weapons: [{ name: { en: 'Quad MG', zh: '四联机枪' }, dmg: 9, range: 5, cooldown: 0.3, proj: 'bullet', warhead: 'small', air: true, turret: true }],
    },
    hydrant: {
      name: { en: 'Hydrant', zh: '水龙车' },
      desc: { en: 'The block\'s fire engine with its pump overcranked. The jet barely hurts but takes the run out of a charging gang.', zh: '街区的消防车，水泵超压运转。水柱伤害有限，却能让冲锋的对手跑不起来。' },
      tags: ['vehicle', 'support', 'antiInfantry'], tier: 2, queue: 'heavy', cost: 650, hp: 380, armor: 'light',
      move: { type: 'wheel', speed: 2.5 }, sight: 6, requires: ['loft'],
      weapons: [{ name: { en: 'Pressure hose', zh: '高压水炮' }, dmg: 3, range: 4.5, cooldown: 0.25, proj: 'flame', warhead: 'shock', splash: 0.8, turret: true, fx: 'water',
        onHit: { slow: { mult: 0.7, dur: 1.5 } } }],
    },
    doorman: {
      name: { en: 'Doorman', zh: '门神' },
      desc: { en: 'A mothballed tank nobody admits to keeping. Crushes infantry; parked and braced it out-ranges and out-lasts.', zh: '没人承认私藏的封存坦克。可碾压步兵；停稳据守后射程更远、更耐打。' },
      tags: ['vehicle', 'tank', 'antiArmor'], tier: 2, queue: 'heavy', cost: 900, hp: 560, armor: 'heavy',
      move: { type: 'track', speed: 2.3 }, sight: 6, requires: ['loft'],
      weapons: [{ name: { en: '90 mm gun', zh: '90毫米炮' }, dmg: 70, range: 5.5, cooldown: 2.2, proj: 'shell', warhead: 'ap', splash: 0.3, turret: true }],
      traits: { crusher: {}, brace: { delay: 2, mods: { range: 1.18, taken: 0.75 }, uncrushable: false } },
    },
    mailman: {
      name: { en: 'Mailman', zh: '邮差' },
      desc: { en: 'A mortar truck that delivers from nine cells out. Must park and brace to fire, needs a spotter, hates company.', zh: '迫击炮卡车，九格之外使命必达。必须停稳据守才能开火，需要别人提供视野，最怕被近身。' },
      tags: ['vehicle', 'siege', 'antiBuilding'], tier: 2, queue: 'heavy', cost: 1200, hp: 240, armor: 'light',
      move: { type: 'wheel', speed: 2.0 }, sight: 5, requires: ['loft'],
      weapons: [{ name: { en: '120 mm mortar', zh: '120毫米迫击炮' }, dmg: 95, range: 9, minRange: 3, cooldown: 4.5, proj: 'lob', warhead: 'he', splash: 1.5, needsBrace: true }],
      traits: { brace: { delay: 2.5, mods: {}, uncrushable: false } },
    },
    pigeon: {
      name: { en: 'Pigeon', zh: '信鸽' },
      desc: { en: 'A racing drone from the loft with a charge strapped under it. Scouts far and wide, then makes one trip: order an attack and it dives.', zh: '鸽舍放飞的竞速无人机，机腹绑着炸药。视野开阔，但只送一趟：下达攻击命令后俯冲自爆。' },
      tags: ['drone', 'scout', 'antiArmor'], tier: 3, queue: 'heavy', cost: 400, hp: 60, armor: 'light',
      move: { type: 'air', speed: 4.6 }, sight: 9, requires: ['arsenal'], stance: 'passive',
      weapons: [{ name: { en: 'Dive charge', zh: '俯冲炸药' }, dmg: 300, range: 1.2, cooldown: 1, proj: 'instant', warhead: 'ap', splash: 0.8, consume: true, fx: 'dive' }],
    },
    monument: {
      name: { en: 'Monument', zh: '纪念碑' },
      desc: { en: 'The memorial tank from the square, back off its plinth. A slow fortress whose gun breaks walls and whose tracks flatten whatever is left. One only.', zh: '广场上的纪念碑坦克，从基座上开了下来。缓慢的移动堡垒，主炮破墙，履带碾平剩下的一切。仅此一辆。' },
      tags: ['vehicle', 'tank', 'antiArmor', 'antiBuilding'], tier: 3, queue: 'heavy', cost: 1700, hp: 1100, armor: 'heavy',
      move: { type: 'track', speed: 1.6 }, sight: 6, requires: ['arsenal'], limit: 1,
      weapons: [{ name: { en: 'Memorial gun', zh: '纪念主炮' }, dmg: 140, range: 6, cooldown: 2.6, proj: 'shell', warhead: 'ap', splash: 0.8, turret: true, vs: { building: 1.5 } }],
      traits: { crusher: {}, brace: { delay: 2, mods: { range: 1.15, taken: 0.75 }, uncrushable: false } },
    },
  },

  powers: {
    blockwatch: {
      name: { en: 'Block Watch', zh: '街坊眼线' },
      desc: { en: 'The neighbours are watching: lifts the fog over a wide area for 12 seconds. Gives the mortars their eyes.', zh: '街坊都在盯着：在12秒内驱散大片区域的战争迷雾，为迫击炮提供视野。' },
      building: 'loft', cooldown: 90, kind: 'reveal', reveal: { radius: 8, dur: 12 },
    },
    lightsout: {
      name: { en: 'Lights Out', zh: '熄灯号' },
      desc: { en: 'Five seconds of siren, then ten heavy shells scattered over the target area.', zh: '警报鸣响五秒后，十发重炮弹散落在目标区域。' },
      building: 'siren', cooldown: 300, kind: 'strike',
      strike: { radius: 3.5, shells: 10, dmg: 220, splash: 1.5, warhead: 'he', delay: 5, over: 4 },
    },
  },
});
