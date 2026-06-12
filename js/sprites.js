'use strict';
// ============ Procedural pixel art. Everything drawn at boot, no assets. ============

function shade(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + amt, g = ((n >> 8) & 255) + amt, b = (n & 255) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function mkCanvas(w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return cv;
}

function gridToCanvas(rows, pal) {
  const cv = mkCanvas(rows[0].length, rows.length);
  const c = cv.getContext('2d');
  for (let y = 0; y < rows.length; y++)
    for (let x = 0; x < rows[y].length; x++) {
      const k = rows[y][x];
      if (k !== '.' && pal[k]) { c.fillStyle = pal[k]; c.fillRect(x, y, 1, 1); }
    }
  return cv;
}

// ---- humanoid sprite grids (8x14): H hair S skin E eyes J jacket T trim P pants B boots ----
const PED_DOWN = [
  '..HHHH..', '.HHHHHH.', '.HSSSSH.', '.SESSES.', '..SSSS..',
  '.JJJJJJ.', '.JTJJTJ.', 'SJJJJJJS', '.JJJJJJ.', '.JJJJJJ.',
];
const PED_UP = [
  '..HHHH..', '.HHHHHH.', '.HHHHHH.', '.HHHHHH.', '..SSSS..',
  '.JJJJJJ.', '.JJTTJJ.', 'SJJJJJJS', '.JJJJJJ.', '.JJJJJJ.',
];
const PED_SIDE = [
  '..HHHH..', '.HHHHHH.', '.SSHHHH.', '.ESHHHH.', '..SSHH..',
  '.JJJJJ..', '.TJJJJ..', '.SJJJJ..', '.JJJJJ..', '.JJJJJ..',
];
// female variant: longer framing hair, trailing strands in profile
const PED_DOWN_F = [
  '..HHHH..', '.HHHHHH.', 'HHSSSSHH', 'HSESSESH', 'H.SSSS.H',
  '.JJJJJJ.', '.JTJJTJ.', 'SJJJJJJS', '.JJJJJJ.', '.JJJJJJ.',
];
const PED_UP_F = [
  '..HHHH..', '.HHHHHH.', '.HHHHHH.', 'HHHHHHHH', 'HHHHHHHH',
  '.JJJJJJ.', '.JJTTJJ.', 'SJJJJJJS', '.JJJJJJ.', '.JJJJJJ.',
];
const PED_SIDE_F = [
  '..HHHH..', '.HHHHHH.', '.SSHHHH.', '.ESHHHH.', '..SSHHH.',
  '.JJJJHH.', '.TJJJJH.', '.SJJJJ..', '.JJJJJ..', '.JJJJJ..',
];
const LEGS_DOWN_A = ['.PPPPPP.', '.PP..PP.', '.PP..PP.', '.BB..BB.'];
const LEGS_DOWN_B = ['.PPPPPP.', '..PPPP..', '..PP.PP.', '..BB.BB.'];
const LEGS_SIDE_A = ['.PPPP...', '.PP.PP..', '.B..B...', '.B..B...'];
const LEGS_SIDE_B = ['.PPPP...', '..PPP...', '..BB....', '..BB....'];

function makePed(pal, fem) {
  const [bd, bu, bs] = fem ? [PED_DOWN_F, PED_UP_F, PED_SIDE_F] : [PED_DOWN, PED_UP, PED_SIDE];
  const mk = (body, legs) => gridToCanvas(body.concat(legs), pal);
  return {
    down: [mk(bd, LEGS_DOWN_A), mk(bd, LEGS_DOWN_B)],
    up:   [mk(bu, LEGS_DOWN_A), mk(bu, LEGS_DOWN_B)],
    side: [mk(bs, LEGS_SIDE_A), mk(bs, LEGS_SIDE_B)],
  };
}

const PLAYER_PAL   = { H:'#1b1b28', S:'#e8b88a', E:'#05d9e8', J:'#16323f', T:'#05d9e8', P:'#23232c', B:'#101014' };
const PLAYER_PAL_F = { H:'#4a1738', S:'#e8b88a', E:'#05d9e8', J:'#16323f', T:'#ff2a6d', P:'#23232c', B:'#101014' };
const CIV_PALS = [
  { H:'#2a2a30', S:'#d8a87c', E:'#222', J:'#3a3a44', T:'#4a4a56', P:'#2c2c34', B:'#1a1a20' },
  { H:'#4a3826', S:'#c89060', E:'#222', J:'#44303a', T:'#5a3a4a', P:'#26262e', B:'#15151a' },
  { H:'#101014', S:'#8a6248', E:'#222', J:'#2e3a30', T:'#3c4c3e', P:'#23232a', B:'#101014' },
  { H:'#5a5a64', S:'#e0b48c', E:'#222', J:'#30303c', T:'#bd00ff', P:'#2a2a32', B:'#16161c' },
  { H:'#7a2c4a', S:'#d8a87c', E:'#222', J:'#26323e', T:'#05d9e8', P:'#262630', B:'#14141a' },
  { H:'#c0c0c8', S:'#caa074', E:'#222', J:'#383844', T:'#ff9f1c', P:'#2c2c36', B:'#1a1a22' },
];

// ---- vehicles (16x30, nose up) ----
function carSprite(def) {
  const cv = mkCanvas(16, 30), c = cv.getContext('2d');
  const col = def.col, dk = shade(col, -22), lt = shade(col, 26);
  if (def.shape === 'bike') {
    c.fillStyle = '#0a0a0c'; c.fillRect(6, 1, 4, 6); c.fillRect(6, 23, 4, 6);       // wheels
    c.fillStyle = dk; c.fillRect(6, 7, 4, 16);                                       // frame
    c.fillStyle = col; c.fillRect(5, 9, 6, 8);                                       // tank/fairing
    c.fillStyle = def.col2; c.fillRect(7, 10, 2, 4);                                 // accent
    c.fillStyle = '#101016'; c.fillRect(6, 17, 4, 5);                                // seat
    c.fillStyle = '#3a3a44'; c.fillRect(3, 8, 10, 1);                                // bars
    c.fillStyle = '#ffe9a0'; c.fillRect(7, 6, 2, 1);                                 // headlight
    c.fillStyle = '#ff3344'; c.fillRect(7, 23, 2, 1);                                // tail
    return cv;
  }
  const bw = def.shape === 'van' ? 12 : def.shape === 'muscle' || def.shape === 'pickup' ? 11 : 10;
  const bl = def.shape === 'van' ? 26 : def.shape === 'sedan' ? 22 : 24;
  const x0 = (16 - bw) >> 1, y0 = (30 - bl) >> 1;
  // tires
  c.fillStyle = '#0a0a0c';
  c.fillRect(x0 - 1, y0 + 3, 2, 4); c.fillRect(x0 + bw - 1, y0 + 3, 2, 4);
  c.fillRect(x0 - 1, y0 + bl - 7, 2, 4); c.fillRect(x0 + bw - 1, y0 + bl - 7, 2, 4);
  // body (rounded)
  c.fillStyle = col;
  c.fillRect(x0, y0 + 1, bw, bl - 2); c.fillRect(x0 + 1, y0, bw - 2, bl);
  c.fillStyle = lt; c.fillRect(x0 + 1, y0 + 1, 1, bl - 2);                           // left highlight
  c.fillStyle = dk; c.fillRect(x0 + bw - 2, y0 + 1, 1, bl - 2);                      // right shadow
  // hood shading
  c.fillStyle = dk; c.fillRect(x0 + 2, y0 + 2, bw - 4, 3);
  // windshield + rear glass
  const glass = '#0d2530', glhi = '#1b4f5e';
  if (def.shape === 'van') {
    c.fillStyle = glass; c.fillRect(x0 + 2, y0 + 4, bw - 4, 3);
    c.fillStyle = dk; c.fillRect(x0 + 2, y0 + 9, bw - 4, 1); c.fillRect(x0 + 2, y0 + 14, bw - 4, 1); c.fillRect(x0 + 2, y0 + 19, bw - 4, 1);
  } else {
    c.fillStyle = glass; c.fillRect(x0 + 2, y0 + 6, bw - 4, 4);
    c.fillStyle = glhi; c.fillRect(x0 + 2, y0 + 6, bw - 4, 1);
    c.fillStyle = glass; c.fillRect(x0 + 2, y0 + bl - 9, bw - 4, 3);
  }
  if (def.shape === 'pickup') {                                                      // truck bed
    c.fillStyle = shade(col, -34); c.fillRect(x0 + 1, y0 + bl - 10, bw - 2, 8);
    c.fillStyle = dk; c.fillRect(x0 + 2, y0 + bl - 9, bw - 4, 6);
  }
  if (def.shape === 'hyper') {                                                       // wedge nose
    c.clearRect(x0, y0, 2, 3); c.clearRect(x0 + bw - 2, y0, 2, 3);
    c.fillStyle = def.col2; c.fillRect(x0 + 2, y0 + 1, bw - 4, 1);                   // nose trim
  }
  // accent stripe
  if (def.shape === 'muscle' || def.shape === 'sport' || def.shape === 'hyper') {
    c.fillStyle = def.col2; c.fillRect(7, y0 + 1, 2, 4); c.fillRect(7, y0 + bl - 5, 2, 4);
  } else {
    c.fillStyle = def.col2; c.fillRect(x0, y0 + 11, 1, 4); c.fillRect(x0 + bw - 1, y0 + 11, 1, 4);
  }
  // lights
  c.fillStyle = '#ffe9a0'; c.fillRect(x0 + 1, y0, 2, 1); c.fillRect(x0 + bw - 3, y0, 2, 1);
  c.fillStyle = '#ff3344'; c.fillRect(x0 + 1, y0 + bl - 1, 2, 1); c.fillRect(x0 + bw - 3, y0 + bl - 1, 2, 1);
  return cv;
}

// ---- weapon icons (24x10) ----
function wiconCanvas(cls, col) {
  const cv = mkCanvas(24, 10), c = cv.getContext('2d');
  const body = '#dfe6f2', dark = '#8a93a6';
  c.fillStyle = body;
  switch (cls) {
    case 'pistol':
      c.fillRect(4, 3, 11, 2); c.fillStyle = dark; c.fillRect(11, 5, 3, 4); c.fillStyle = col; c.fillRect(4, 2, 8, 1); break;
    case 'revolver':
      c.fillRect(3, 3, 12, 2); c.fillRect(8, 2, 4, 4); c.fillStyle = dark; c.fillRect(12, 5, 3, 4); c.fillStyle = col; c.fillRect(8, 2, 4, 1); break;
    case 'smg':
      c.fillRect(3, 3, 13, 2); c.fillStyle = dark; c.fillRect(12, 5, 3, 3); c.fillRect(8, 5, 2, 4); c.fillStyle = col; c.fillRect(3, 2, 6, 1); break;
    case 'rifle':
      c.fillRect(1, 3, 17, 2); c.fillStyle = dark; c.fillRect(18, 3, 5, 3); c.fillRect(11, 5, 3, 4); c.fillStyle = col; c.fillRect(1, 2, 9, 1); break;
    case 'shotgun':
      c.fillRect(1, 3, 15, 3); c.fillStyle = dark; c.fillRect(16, 3, 6, 3); c.fillRect(6, 6, 5, 2); c.fillStyle = col; c.fillRect(1, 3, 6, 1); break;
    case 'sniper':
      c.fillRect(0, 4, 18, 2); c.fillStyle = dark; c.fillRect(18, 4, 5, 3); c.fillRect(12, 6, 2, 3); c.fillStyle = col; c.fillRect(7, 1, 6, 2); break;
    case 'lmg':
      c.fillRect(1, 3, 16, 3); c.fillStyle = dark; c.fillRect(17, 3, 5, 4); c.fillRect(7, 6, 4, 4); c.fillStyle = col; c.fillRect(1, 2, 8, 1); break;
    case 'blade':
      for (let i = 0; i < 14; i++) c.fillRect(2 + i, 7 - (i >> 1), 2, 1);
      c.fillStyle = dark; c.fillRect(16, 1, 2, 5); c.fillRect(17, 3, 5, 2); c.fillStyle = col; c.fillRect(2, 7, 2, 1); break;
    case 'blunt':
      c.fillStyle = dark; c.fillRect(16, 5, 6, 2);
      c.fillStyle = body; c.fillRect(3, 3, 13, 4); c.fillStyle = col; c.fillRect(4, 2, 2, 2); c.fillRect(9, 6, 2, 2); break;
    case 'mantis':
      for (let i = 0; i < 10; i++) { c.fillRect(3 + i, 8 - i * 0.6 | 0, 2, 1); }
      c.fillStyle = col; for (let i = 0; i < 8; i++) c.fillRect(10 + i, 8 - i * 0.7 | 0, 2, 1);
      c.fillStyle = dark; c.fillRect(18, 6, 4, 3); break;
    case 'gorilla':
      c.fillRect(6, 2, 12, 7); c.fillStyle = dark; c.fillRect(8, 2, 1, 7); c.fillRect(11, 2, 1, 7); c.fillRect(14, 2, 1, 7);
      c.fillStyle = col; c.fillRect(6, 2, 12, 1); break;
    case 'wire':
      c.fillStyle = col;
      for (let i = 0; i < 18; i++) c.fillRect(2 + i, 5 + Math.round(Math.sin(i * 0.7) * 2), 1, 1);
      c.fillStyle = dark; c.fillRect(19, 4, 4, 4); break;
    case 'launcher':
      c.fillRect(2, 3, 14, 4); c.fillStyle = '#0a0a0c'; c.fillRect(2, 4, 3, 2);
      c.fillStyle = dark; c.fillRect(16, 3, 5, 5); c.fillStyle = col; c.fillRect(6, 2, 8, 1); break;
  }
  return cv;
}

const SPR = {
  _peds: {}, _cars: {}, _glows: {}, _wicons: {}, _skulls: {},
  player: null, civs: [], psycho: null, crate: null, vend: null, scan: null, cursor: null,

  ped(fac) {
    if (!this._peds[fac]) this._peds[fac] = makePed(FACTIONS[fac].pal);
    return this._peds[fac];
  },
  civ(i) { return this.civs[((i % this.civs.length) + this.civs.length) % this.civs.length]; },
  car(id) {
    if (!this._cars[id]) this._cars[id] = carSprite(CARD[id]);
    return this._cars[id];
  },
  glowS(col, r) {
    const k = col + r;
    if (!this._glows[k]) {
      const cv = mkCanvas(r * 2, r * 2), c = cv.getContext('2d');
      const g = c.createRadialGradient(r, r, 1, r, r, r);
      g.addColorStop(0, col); g.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = g; c.fillRect(0, 0, r * 2, r * 2);
      this._glows[k] = cv;
    }
    return this._glows[k];
  },
  wicon(cls, col) {
    const k = cls + col;
    if (!this._wicons[k]) this._wicons[k] = wiconCanvas(cls, col);
    return this._wicons[k];
  },
  skull(col) {
    if (!this._skulls[col]) {
      const rows = ['.XXXX.', 'XXXXXX', 'X.XX.X', 'XXXXXX', '.XXXX.', '.X.X.X'];
      this._skulls[col] = gridToCanvas(rows, { X: col });
    }
    return this._skulls[col];
  },
};

function buildSprites() {
  SPR.player = { m: makePed(PLAYER_PAL), f: makePed(PLAYER_PAL_F, true) };
  SPR.civs = CIV_PALS.map((p, i) => makePed(p, i % 2 === 1));
  SPR.psycho = makePed({ H:'#2a0c10', S:'#b9b3a8', E:'#ff2a3c', J:'#3a0c14', T:'#ff2a3c', P:'#26161a', B:'#0c0c10' });

  // crate
  {
    const cv = mkCanvas(12, 9), c = cv.getContext('2d');
    c.fillStyle = '#4a3a28'; c.fillRect(0, 0, 12, 9);
    c.fillStyle = '#3a2c1e'; c.fillRect(0, 3, 12, 1); c.fillRect(0, 6, 12, 1);
    c.fillStyle = '#6a6a72'; c.fillRect(0, 0, 2, 9); c.fillRect(10, 0, 2, 9);
    c.fillStyle = '#f9f002'; c.fillRect(5, 1, 2, 1);
    SPR.crate = cv;
  }
  // vending machine
  {
    const cv = mkCanvas(12, 14), c = cv.getContext('2d');
    c.fillStyle = '#142830'; c.fillRect(0, 0, 12, 14);
    c.fillStyle = '#0a161c'; c.fillRect(0, 13, 12, 1);
    c.fillStyle = '#0a4a55'; c.fillRect(2, 2, 8, 5);
    c.fillStyle = '#05d9e8'; c.fillRect(3, 3, 6, 1); c.fillRect(3, 5, 4, 1);
    c.fillStyle = '#0a0a0c'; c.fillRect(3, 9, 6, 2);
    c.fillStyle = '#ff2a6d'; c.fillRect(9, 9, 1, 1);
    SPR.vend = cv;
  }
  // CRT scanlines + vignette overlay
  {
    const cv = mkCanvas(VIEW_W, VIEW_H), c = cv.getContext('2d');
    c.fillStyle = 'rgba(0,0,0,0.07)';
    for (let y = 1; y < VIEW_H; y += 2) c.fillRect(0, y, VIEW_W, 1);
    const g = c.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H / 2.6, VIEW_W / 2, VIEW_H / 2, VIEW_W / 1.35);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.42)');
    c.fillStyle = g; c.fillRect(0, 0, VIEW_W, VIEW_H);
    SPR.scan = cv;
  }
  // menu cursor
  {
    const rows = ['X......', 'XX.....', 'XXX....', 'XXXX...', 'XXXXX..', 'XXXXXX.', 'XXXXXXX', 'XXXX...', 'X.XX...', '..XX...'];
    SPR.cursor = gridToCanvas(rows, { X: '#dfe6f2' });
  }
}
buildSprites();
