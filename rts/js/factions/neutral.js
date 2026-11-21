'use strict';
// NEON TURF — neutral turf (HEADLESS-SAFE data file).
// Street businesses scattered over every map. Nobody builds them: gangs CLAIM
// them with a `capturer` unit (Enter order) and keep the perk while they hold
// the block. Beaten down to 0 hp a turf structure is not destroyed — it flips
// back to neutral (capturable.revert), ready to be claimed again.
// meta.mapWeight = how often mapgen picks it; meta.central = prefers the
// contested middle of the map.
NT.defineFaction({
  id: 'neutral',
  playable: false,
  name: { en: 'Neutral Turf', zh: '中立地盘' },
  desc: { en: 'Street businesses that pay whoever holds the block.', zh: '谁占住街区，街上的生意就向谁交钱。' },
  color: '#8d97ad',
  buildings: {
    noodlebar: {
      name: { en: 'Noodle Bar', zh: '面馆' },
      desc: { en: 'Pays protection money: a steady trickle of Glint.', zh: '按时交保护费：稳定的小额碎金收入。' },
      role: 'turf', tags: ['turf'], hp: 900, size: [2, 2], sight: 4,
      traits: { capturable: {}, income: { amount: 30, every: 6 } },
      meta: { mapWeight: 4 },
    },
    pawnshop: {
      name: { en: 'Pawn Shop', zh: '当铺' },
      desc: { en: 'Fences everything. Pays better than noodles.', zh: '什么都收，什么都卖。收入比面馆高。' },
      role: 'turf', tags: ['turf'], hp: 1000, size: [2, 2], sight: 4,
      traits: { capturable: {}, income: { amount: 45, every: 6 } },
      meta: { mapWeight: 2 },
    },
    nightmarket: {
      name: { en: 'Night Market', zh: '夜市' },
      desc: { en: 'The richest block in the district. Everyone wants it.', zh: '全区最肥的一块地盘，人人都想要。' },
      role: 'turf', tags: ['turf'], hp: 1600, size: [3, 3], sight: 5,
      traits: { capturable: {}, income: { amount: 90, every: 6 } },
      meta: { mapWeight: 1, central: true },
    },
    cornerbar: {
      name: { en: 'Corner Bar', zh: '街角酒吧' },
      desc: { en: 'Regulars who owe you a favour sign up: every so often a local joins your gang here.', zh: '欠你人情的熟客会来入伙：每隔一阵就有一名街坊在此加入你的帮派。' },
      role: 'turf', tags: ['turf'], hp: 900, size: [2, 2], sight: 4,
      traits: { capturable: {}, recruit: { every: 45 } },
      meta: { mapWeight: 2 },
    },
    clinic: {
      name: { en: 'Back-Alley Clinic', zh: '黑诊所' },
      desc: { en: 'Patches up your people (and beasts) nearby.', zh: '为附近的己方人员（和野兽）疗伤。' },
      role: 'turf', tags: ['turf'], hp: 900, size: [2, 2], sight: 5,
      traits: { capturable: {}, aura: { radius: 5, affects: 'allies', tags: ['organic'], mods: { regen: 0.04 } } },
      meta: { mapWeight: 2 },
    },
    adtower: {
      name: { en: 'Ad Tower', zh: '广告塔' },
      desc: { en: 'Hijacked billboard cameras watch a huge area.', zh: '劫持广告牌上的摄像头，监视大片区域。' },
      role: 'turf', tags: ['turf'], hp: 700, size: [1, 1], sight: 13,
      traits: { capturable: {} },
      meta: { mapWeight: 2, central: true },
    },
  },
});
