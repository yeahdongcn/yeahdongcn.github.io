'use strict';
// ============ City generation. Deterministic seed so saves stay valid. ============
let WORLD = null;

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const RD = [6, 24, 42, 60, 78, 96, 114]; // road start cols/rows, each 4 wide
const WT = { ROAD: 0, WALK: 1, BLDG: 2, PLAZA: 3, PARK: 4, FLOOR: 5, DOOR: 6 };

function genWorld() {
  const W = 128, H = 128;
  const t = new Uint8Array(W * H).fill(WT.BLDG);
  const rng = mulberry32(20770612);
  const idx = (x, y) => y * W + x;

  // ---- carve roads ----
  const lo = RD[0], hi = RD[RD.length - 1] + 3;
  for (const r of RD) {
    for (let y = lo; y <= hi; y++) for (let x = r; x < r + 4; x++) { t[idx(x, y)] = WT.ROAD; t[idx(y, x)] = WT.ROAD; }
  }

  const bldgs = [], alleys = [], crateSpots = [], vends = [], holos = [], signs = [], lights = [], puddles = [], wrecks = [], trees = [], displays = [], roofs = [], dens = [], npcs = [], obst = [];
  const shops = {};
  let spawnPt = null;

  const setRect = (x0, y0, w, h, v) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) t[idx(x, y)] = v; };

  // ---- 6x6 blocks ----
  for (let bi = 0; bi < 6; bi++) for (let bj = 0; bj < 6; bj++) {
    const bx = RD[bi] + 4, by = RD[bj] + 4; // 14x14 block
    setRect(bx, by, 14, 14, WT.WALK);
    const ix = bx + 1, iy = by + 1; // 12x12 interior
    const distK = _districtOfTile(bx + 7, by + 7);
    const dCol = DISTRICTS[distK].col;

    const isShop = (bi === 1 && bj === 2) ? 'guns' : (bi === 2 && bj === 1) ? 'ripper' : (bi === 3 && bj === 2) ? 'cars' : null;
    if (bi === 2 && bj === 2) { // spawn plaza + bar (enterable)
      setRect(ix, iy, 12, 12, WT.PLAZA);
      setRect(ix + 2, iy, 8, 5, WT.BLDG);
      bldgs.push({ x: ix + 2, y: iy, w: 8, h: 5, roof: '#262430', neon: '#ff2a6d', sign: { text: 'AFTERLIFE', col: '#ff2a6d' }, ent: true, theme: 'bar' });
      shops.bar = { x: (ix + 6) * TILE, y: (iy + 2) * TILE + 8, name: 'AFTERLIFE' };
      spawnPt = { x: (ix + 6) * TILE, y: (iy + 7) * TILE + 8 };
      vends.push({ x: (ix + 1) * TILE + 8, y: (iy + 8) * TILE });
      crateSpots.push({ x: (ix + 10) * TILE, y: (iy + 9) * TILE });
      continue;
    }
    if (isShop) {
      setRect(ix, iy, 12, 12, WT.PLAZA);
      setRect(ix + 1, iy, 10, 6, WT.BLDG);
      const names = { guns: '2ND AMENDMENT', ripper: "VIK'S CLINIC", cars: 'NC AUTOFIXER' };
      const cols = { guns: '#f9f002', ripper: '#05d9e8', cars: '#00ff9f' };
      bldgs.push({ x: ix + 1, y: iy, w: 10, h: 6, roof: '#24242e', neon: cols[isShop], sign: { text: names[isShop], col: cols[isShop] }, ent: true, theme: isShop });
      shops[isShop] = { x: (ix + 6) * TILE, y: (iy + 2) * TILE + 8, name: names[isShop] };
      vends.push({ x: (ix + 1) * TILE + 8, y: (iy + 9) * TILE });
      if (isShop === 'cars') {
        displays.push({ x: (ix + 3) * TILE, y: (iy + 9) * TILE, id: 'type66' });
        displays.push({ x: (ix + 9) * TILE, y: (iy + 9) * TILE, id: 'shion' });
      }
      continue;
    }

    if (bi === 4 && bj === 1) { // Jig-Jig Street: neon pleasure plaza + CLOUDS dollhouse
      setRect(ix, iy, 12, 12, WT.PLAZA);
      setRect(ix + 2, iy, 8, 6, WT.BLDG);
      bldgs.push({ x: ix + 2, y: iy, w: 8, h: 6, roof: '#2a2030', neon: '#bd00ff', sign: { text: 'CLOUDS', col: '#bd00ff' }, ent: true, theme: 'clouds' });
      holos.push({ x: (ix + 6) * TILE, y: (iy + 9) * TILE, text: 'JIG-JIG STREET', col: '#ff2a6d' });
      npcs.push({ x: (ix + 3) * TILE, y: (iy + 8) * TILE + 8, i: 4, name: 'ANGEL', kind: 'joy' });
      npcs.push({ x: (ix + 9) * TILE, y: (iy + 9) * TILE + 8, i: 5, name: 'SKYE', kind: 'joy' });
      obst.push({ x: (ix + 3) * TILE - 4, y: (iy + 8) * TILE + 2, w: 8, h: 9 });
      obst.push({ x: (ix + 9) * TILE - 4, y: (iy + 9) * TILE + 2, w: 8, h: 9 });
      vends.push({ x: (ix + 1) * TILE + 8, y: (iy + 10) * TILE });
      crateSpots.push({ x: (ix + 10) * TILE, y: (iy + 10) * TILE });
      continue;
    }

    const roll = rng();
    if (roll < 0.14) { // plaza
      setRect(ix, iy, 12, 12, WT.PLAZA);
      for (let k = 0; k < 3; k++) crateSpots.push({ x: (ix + 1 + (rng() * 10 | 0)) * TILE + 8, y: (iy + 1 + (rng() * 10 | 0)) * TILE + 8 });
      vends.push({ x: (ix + (rng() * 11 | 0)) * TILE + 8, y: iy * TILE + 8 });
      holos.push({ x: (ix + 6) * TILE, y: (iy + 6) * TILE, text: BRANDS[rng() * BRANDS.length | 0], col: NEON[rng() * NEON.length | 0] });
    } else if (roll < 0.24) { // park
      setRect(ix, iy, 12, 12, WT.PARK);
      for (let k = 0; k < 7; k++) trees.push({ x: (ix + 1 + rng() * 10) * TILE, y: (iy + 1 + rng() * 10) * TILE, r: 5 + rng() * 6, col: rng() < 0.5 ? '#1d4030' : '#3a2a4a' });
      for (let k = 0; k < 2; k++) crateSpots.push({ x: (ix + 1 + (rng() * 10 | 0)) * TILE + 8, y: (iy + 1 + (rng() * 10 | 0)) * TILE + 8 });
    } else if (roll < 0.32) { // parking lot
      setRect(ix, iy, 12, 12, WT.PLAZA);
      for (let k = 0; k < 3; k++) wrecks.push({ x: (ix + 1 + (rng() * 9 | 0)) * TILE, y: (iy + 1 + (rng() * 9 | 0)) * TILE, a: rng() * 6.3 });
      for (let k = 0; k < 2; k++) crateSpots.push({ x: (ix + 1 + (rng() * 10 | 0)) * TILE + 8, y: (iy + 1 + (rng() * 10 | 0)) * TILE + 8 });
    } else { // buildings with alleys
      const pat = rng();
      const rects = [];
      if (pat < 0.2) rects.push([ix, iy, 12, 12]);
      else if (pat < 0.5) { rects.push([ix, iy, 12, 5], [ix, iy + 7, 12, 5]); setRect(ix, iy + 5, 12, 2, WT.WALK); _markAlley(alleys, ix, iy + 5, 12, 2); }
      else if (pat < 0.8) { rects.push([ix, iy, 5, 12], [ix + 7, iy, 5, 12]); setRect(ix + 5, iy, 2, 12, WT.WALK); _markAlley(alleys, ix + 5, iy, 2, 12); }
      else {
        rects.push([ix, iy, 5, 5], [ix + 7, iy, 5, 5], [ix, iy + 7, 5, 5], [ix + 7, iy + 7, 5, 5]);
        setRect(ix + 5, iy, 2, 12, WT.WALK); setRect(ix, iy + 5, 12, 2, WT.WALK);
        _markAlley(alleys, ix + 5, iy, 2, 12); _markAlley(alleys, ix, iy + 5, 12, 2);
      }
      const roofsCol = ['#1c1c26', '#202030', '#24222e', '#1e242c'];
      for (const r of rects) {
        setRect(r[0], r[1], r[2], r[3], WT.BLDG); // buildings are SOLID (the block fill made them sidewalk)
        const b = { x: r[0], y: r[1], w: r[2], h: r[3], roof: roofsCol[rng() * 4 | 0], neon: rng() < 0.4 ? dCol : null, sign: null };
        if (rng() < 0.4) b.sign = { text: BRANDS[rng() * BRANDS.length | 0], col: NEON[rng() * NEON.length | 0] };
        if (rng() < 0.32) { b.ent = true; b.den = rng() < 0.5; b.theme = b.den ? 'den' : 'flat'; }
        bldgs.push(b);
      }
      if (rng() < 0.5 && alleys.length) { const a = alleys[alleys.length - 1]; crateSpots.push({ x: a.x * TILE + 8, y: a.y * TILE + 8 }); }
      if (rng() < 0.45) holos.push({ x: (ix + 3 + rng() * 6) * TILE, y: (iy + 3 + rng() * 6) * TILE, text: BRANDS[rng() * BRANDS.length | 0], col: NEON[rng() * NEON.length | 0] });
    }
  }

  // ---- carve interiors: floors, doors, indoor loot, gang dens ----
  for (const b of bldgs) {
    if (!b.ent) continue;
    setRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2, WT.FLOOR);
    const cx = b.x + (b.w >> 1);
    b.doors = b.w >= 8 ? [cx - 1, cx] : [cx];
    for (const dx of b.doors) t[idx(dx, b.y + b.h - 1)] = WT.DOOR;
    if (b.theme === 'flat' || b.theme === 'den') {
      const n = b.den ? 2 : 1;
      for (let k = 0; k < n; k++)
        crateSpots.push({ x: (b.x + 1 + (rng() * (b.w - 2) | 0)) * TILE + 8, y: (b.y + 1 + (rng() * Math.max(1, b.h - 3) | 0)) * TILE + 8 });
      if (b.den) { b.denId = dens.length; dens.push({ id: dens.length, tx0: b.x, ty0: b.y, tx1: b.x + b.w - 1, ty1: b.y + b.h - 1, done: false, cleared: false, left: 0 }); }
    }
  }

  // ---- street lights at intersections ----
  for (const vx of RD) for (const hy of RD) {
    lights.push({ x: (vx - 1) * TILE + 12, y: (hy - 1) * TILE + 12 }, { x: (vx + 4) * TILE + 4, y: (hy + 4) * TILE + 4 });
  }

  // ---- puddles on roads ----
  for (let y = lo; y <= hi; y++) for (let x = lo; x <= hi; x++) {
    if (t[idx(x, y)] === WT.ROAD && rng() < 0.05)
      puddles.push({ x: x * TILE + rng() * 10, y: y * TILE + rng() * 12, w: 7 + rng() * 12, h: 3 + rng() * 4, col: NEON[rng() * NEON.length | 0] });
  }

  // ---- prerender ground canvas ----
  const cv = mkCanvas(W * TILE, H * TILE), c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = t[idx(x, y)], px = x * TILE, py = y * TILE;
    if (v === WT.ROAD) c.fillStyle = '#14141b';
    else if (v === WT.WALK) c.fillStyle = '#20202a';
    else if (v === WT.PLAZA) c.fillStyle = '#1d1d27';
    else if (v === WT.PARK) c.fillStyle = '#141f19';
    else if (v === WT.FLOOR || v === WT.DOOR) c.fillStyle = '#1c1c22';
    else c.fillStyle = '#16161e';
    c.fillRect(px, py, TILE, TILE);
    const r = mulberry32(x * 1733 + y * 89)();
    if (v <= 4 && v !== WT.BLDG && r < 0.5) { c.fillStyle = 'rgba(0,0,0,0.18)'; c.fillRect(px + (r * 211 % 1) * 14 | 0, py + (r * 137 % 1) * 14 | 0, 2, 1); }
    if (v === WT.WALK) { c.fillStyle = '#262632'; c.fillRect(px, py, TILE, 1); }
    if (v === WT.PARK && r < 0.6) { c.fillStyle = '#1b2a20'; c.fillRect(px + 3, py + 5, 2, 2); c.fillRect(px + 10, py + 11, 2, 2); }
  }
  // lane dashes
  c.fillStyle = '#34344a';
  const inRoadSpan = p => RD.some(r => p >= r && p < r + 4);
  for (const r of RD) {
    const m = (r + 2) * TILE;
    for (let p = lo * TILE; p < (hi + 1) * TILE; p += 12) {
      if (!inRoadSpan(Math.floor(p / TILE))) { c.fillRect(m, p, 1, 6); c.fillRect(p, m, 6, 1); }
    }
  }
  // light pools
  for (const L of lights) {
    const g = c.createRadialGradient(L.x, L.y, 2, L.x, L.y, 26);
    g.addColorStop(0, 'rgba(255,180,90,0.10)'); g.addColorStop(1, 'rgba(255,180,90,0)');
    c.fillStyle = g; c.fillRect(L.x - 26, L.y - 26, 52, 52);
    c.fillStyle = '#3a3a44'; c.fillRect(L.x - 1, L.y - 1, 2, 2);
  }
  // puddles (dark base; neon shimmer drawn live)
  for (const p of puddles) {
    c.fillStyle = '#0d0d15';
    c.beginPath(); c.ellipse(p.x, p.y, p.w / 2, p.h / 2, 0, 0, Math.PI * 2); c.fill();
  }
  // trees
  for (const tr of trees) {
    c.fillStyle = '#0f1410'; c.beginPath(); c.ellipse(tr.x + 2, tr.y + 2, tr.r, tr.r * 0.8, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = tr.col; c.beginPath(); c.ellipse(tr.x, tr.y, tr.r, tr.r * 0.8, 0, 0, Math.PI * 2); c.fill();
    c.fillStyle = shade(tr.col, 18); c.fillRect(tr.x - 2, tr.y - 2, 3, 2);
  }
  // wrecks
  for (const wk of wrecks) {
    c.save(); c.translate(wk.x, wk.y); c.rotate(wk.a);
    c.fillStyle = '#23232b'; c.fillRect(-5, -9, 10, 18);
    c.fillStyle = '#16161c'; c.fillRect(-3, -5, 6, 4); c.fillRect(-3, 3, 6, 3);
    c.restore();
  }
  // buildings: enterable → interior on ground + roof on its own fading layer
  for (const b of bldgs) {
    if (b.ent) {
      const r = { x: b.x * TILE, y: b.y * TILE, w: b.w * TILE, h: b.h * TILE, cv: mkCanvas(b.w * TILE, b.h * TILE), a: 1, tx0: b.x, ty0: b.y, tx1: b.x + b.w - 1, ty1: b.y + b.h - 1, doorTx: b.doors.slice(), doorTy: b.y + b.h - 1, lights: [] };
      _bakeInterior(c, b, r, rng, npcs, obst);
      _bakeExterior(r.cv.getContext('2d'), b, -b.x * TILE, -b.y * TILE, signs, roofs.length);
      roofs.push(r);
    } else {
      _bakeExterior(c, b, 0, 0, signs, null);
    }
  }

  // ---- minimap ----
  const mini = mkCanvas(W, H), mc = mini.getContext('2d');
  const dcol = { center: '#34301c', watson: '#173039', westbrook: '#391726', santo: '#39301c', pacifica: '#173927', dogtown: '#3a2410' };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = t[idx(x, y)];
    mc.fillStyle = v === WT.ROAD ? '#2e2e3e' : v === WT.WALK ? '#191922' : v === WT.PLAZA ? '#1f1f2c' : v === WT.PARK ? '#152018'
      : v === WT.FLOOR ? '#15151e' : v === WT.DOOR ? '#39394a' : dcol[_districtOfTile(x, y)];
    mc.fillRect(x, y, 1, 1);
  }

  // ---- pick skippy's gutter ----
  const spawn = spawnPt;
  let skippySpot = null;
  const far = alleys.filter(a => Math.hypot(a.x * TILE - spawn.x, a.y * TILE - spawn.y) > 1100);
  if (far.length) { const a = far[rng() * far.length | 0]; skippySpot = { x: a.x * TILE + 8, y: a.y * TILE + 8 }; }
  else skippySpot = { x: RD[5] * TILE, y: RD[5] * TILE };

  WORLD = {
    W, H, t, cv, mini, shops, vends, holos, signs, lights, puddles, crateSpots, displays, spawn, skippySpot, roofs, dens, npcs, obst,
    solidAt(tx, ty) { return tx < 0 || ty < 0 || tx >= W || ty >= H || t[ty * W + tx] === WT.BLDG; },
    solidPx(x, y) { return this.solidAt(Math.floor(x / TILE), Math.floor(y / TILE)); },
    // walls + furniture/NPC bodies: blocks movers; bullets use solidPx and fly over furniture
    blockedPx(x, y) {
      if (this.solidPx(x, y)) return true;
      for (let i = 0; i < obst.length; i++) {
        const o = obst[i];
        if (x >= o.x && x < o.x + o.w && y >= o.y && y < o.y + o.h) return true;
      }
      return false;
    },
    tileAt(x, y) {
      const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
      return (tx < 0 || ty < 0 || tx >= W || ty >= H) ? WT.BLDG : t[ty * W + tx];
    },
    losClear(x0, y0, x1, y1) {
      const d = Math.hypot(x1 - x0, y1 - y0), steps = Math.max(1, Math.ceil(d / 8));
      for (let i = 1; i < steps; i++) {
        const f = i / steps;
        if (this.solidPx(x0 + (x1 - x0) * f, y0 + (y1 - y0) * f)) return false;
      }
      return true;
    },
    districtAt(x, y) { return _districtOfTile(Math.floor(x / TILE), Math.floor(y / TILE)); },
  };
  return WORLD;
}

// exterior view: roof, edge shading, clutter, south facade w/ windows + door, neon trim
function _bakeExterior(c, b, ox, oy, signs, roofIdx) {
  const px = b.x * TILE + ox, py = b.y * TILE + oy, pw = b.w * TILE, ph = b.h * TILE;
  c.fillStyle = b.roof; c.fillRect(px, py, pw, ph);
  c.fillStyle = shade(b.roof, 14); c.fillRect(px, py, pw, 2); c.fillRect(px, py, 2, ph);
  c.fillStyle = shade(b.roof, -12); c.fillRect(px, py + ph - 2, pw, 2); c.fillRect(px + pw - 2, py, 2, ph);
  const brng = mulberry32(b.x * 977 + b.y * 31);
  for (let k = 0; k < b.w * b.h / 5; k++) {
    const vx = px + 4 + brng() * (pw - 12), vy = py + 4 + brng() * (ph - 12);
    c.fillStyle = shade(b.roof, brng() < 0.5 ? -16 : 10); c.fillRect(vx | 0, vy | 0, 4 + (brng() * 4 | 0), 3 + (brng() * 3 | 0));
  }
  // south facade w/ lit windows
  const fy = py + ph - 10;
  c.fillStyle = shade(b.roof, -26); c.fillRect(px, fy, pw, 10);
  for (let wx = px + 3; wx < px + pw - 4; wx += 6) {
    const r2 = brng();
    c.fillStyle = r2 < 0.38 ? '#ffd27a' : r2 < 0.66 ? '#7ad7ff' : '#101018';
    c.fillRect(wx, fy + 2, 3, 2);
    const r3 = brng();
    c.fillStyle = r3 < 0.38 ? '#ffd27a' : r3 < 0.66 ? '#7ad7ff' : '#101018';
    c.fillRect(wx, fy + 6, 3, 2);
  }
  // lit doorway for enterable buildings
  if (b.ent && b.doors) {
    for (const dx of b.doors) {
      const dpx = dx * TILE + ox;
      c.fillStyle = '#0c0c12'; c.fillRect(dpx + 2, fy + 1, 12, 9);
      c.fillStyle = '#ffd27a'; c.fillRect(dpx + 4, fy + 2, 8, 8);
      c.fillStyle = '#3a3a46'; c.fillRect(dpx + 2, fy, 12, 1);
    }
  }
  if (b.neon) { c.fillStyle = b.neon; c.globalAlpha = 0.8; c.fillRect(px, py, pw, 1); c.globalAlpha = 1; }
  if (b.sign) {
    const big = shopsHasSign(null, b.sign.text);
    // mounted ABOVE the facade band (windows/door live in the bottom 10px)
    signs.push({ x: b.x * TILE + pw / 2, y: b.y * TILE + ph - (big ? 24 : 17), text: b.sign.text, col: b.sign.col, big, roof: roofIdx });
  }
}

// interior view baked onto the ground canvas (revealed when the roof fades)
// furniture that should block movement registers a rect in `obst` (bullets fly over — it's waist-high)
function _bakeInterior(c, b, r, rng, npcs, obst) {
  const px = b.x * TILE, py = b.y * TILE, pw = b.w * TILE, ph = b.h * TILE;
  const fx = px + TILE, fy = py + TILE, fw = pw - 2 * TILE, fh = ph - 2 * TILE;
  const floorCol = { bar: '#241a14', guns: '#1b1d24', ripper: '#19232a', cars: '#1d1d22', den: '#1d191d', flat: '#211d1a' }[b.theme] || '#1c1c22';
  c.fillStyle = '#0e0e14'; c.fillRect(px, py, pw, ph);                 // walls
  c.fillStyle = floorCol; c.fillRect(fx, fy, fw, fh);                  // floor
  c.fillStyle = 'rgba(0,0,0,0.22)';
  for (let gx = fx + 16; gx < fx + fw; gx += 16) c.fillRect(gx, fy, 1, fh);
  for (let gy = fy + 16; gy < fy + fh; gy += 16) c.fillRect(fx, gy, fw, 1);
  c.fillStyle = '#262634'; c.fillRect(fx, fy, fw, 4);                  // north wall face
  c.fillStyle = '#1a1a24'; c.fillRect(fx, fy + 4, fw, 1);
  // doors: walkable gap with a mat
  for (const dx of b.doors) {
    c.fillStyle = floorCol; c.fillRect(dx * TILE, py + ph - TILE, TILE, TILE);
    c.fillStyle = '#2a3a44'; c.fillRect(dx * TILE + 3, py + ph - 10, 10, 6);
  }
  const cx = fx + fw / 2, NAMES = { guns: 'WILSON', ripper: 'VIKTOR', cars: 'DAKOTA', bar: 'CLAIRE' };
  const solid = (x, y, w, h) => obst.push({ x, y, w, h });
  const counter = col => {
    c.fillStyle = col; c.fillRect(fx + 4, fy + 12, fw - 8, 9);
    c.fillStyle = shade(col, 18); c.fillRect(fx + 4, fy + 12, fw - 8, 2);
    solid(fx + 4, fy + 12, fw - 8, 9);
  };
  switch (b.theme) {
    case 'bar':
      counter('#3a2a20');
      for (let sx = fx + 8; sx < fx + fw - 8; sx += 12) { c.fillStyle = '#15151c'; c.fillRect(sx, fy + 25, 4, 4); }
      for (let bx2 = fx + 6; bx2 < fx + fw - 6; bx2 += 5) { c.fillStyle = NEON[(bx2 / 5 | 0) % NEON.length]; c.fillRect(bx2, fy + 6, 2, 4); }
      r.lights.push({ x: cx, y: fy + 14, col: '#ff2a6d' });
      break;
    case 'guns':
      counter('#2a2e38');
      for (let gy2 = fy + 26; gy2 < fy + fh - 6; gy2 += 9) { c.fillStyle = '#10141c'; c.fillRect(fx + 4, gy2, 14, 6); c.fillStyle = '#8a93a6'; c.fillRect(fx + 6, gy2 + 2, 10, 1); }
      for (let gy2 = fy + 26; gy2 < fy + fh - 6; gy2 += 9) { c.fillStyle = '#10141c'; c.fillRect(fx + fw - 18, gy2, 14, 6); c.fillStyle = '#8a93a6'; c.fillRect(fx + fw - 16, gy2 + 2, 10, 1); }
      solid(fx + 4, fy + 26, 14, Math.max(6, fh - 32));      // west rack column
      solid(fx + fw - 18, fy + 26, 14, Math.max(6, fh - 32)); // east rack column
      r.lights.push({ x: cx, y: fy + 14, col: '#f9f002' });
      break;
    case 'ripper':
      counter('#26303a');
      c.fillStyle = '#30343c'; c.fillRect(cx - 6, fy + 28, 12, 18);    // chair
      c.fillStyle = '#3c424c'; c.fillRect(cx - 4, fy + 26, 8, 4);
      solid(cx - 6, fy + 26, 12, 20);
      c.fillStyle = '#0a4a55'; c.fillRect(fx + 5, fy + 6, 12, 5);      // monitor (wall-mounted)
      r.lights.push({ x: fx + 11, y: fy + 8, col: '#05d9e8' });
      break;
    case 'cars':
      counter('#2c2c34');
      c.strokeStyle = '#3a3e48'; c.strokeRect(cx - 14.5, fy + 27.5, 29, 20); // lift
      solid(cx - 15, fy + 27, 30, 21);
      c.fillStyle = '#7a2020'; c.fillRect(fx + 5, fy + 28, 8, 6);      // toolbox
      solid(fx + 5, fy + 28, 8, 6);
      c.fillStyle = '#0c0c10';
      c.beginPath(); c.ellipse(fx + fw - 12, fy + fh - 10, 5, 3, 0, 0, Math.PI * 2); c.fill();
      c.beginPath(); c.ellipse(fx + fw - 12, fy + fh - 14, 5, 3, 0, 0, Math.PI * 2); c.fill();
      solid(fx + fw - 17, fy + fh - 17, 10, 10);                       // tire stack
      r.lights.push({ x: cx, y: fy + 14, col: '#00ff9f' });
      break;
    case 'clouds': {
      counter('#3a2438'); // reception
      c.fillStyle = '#5a2444'; c.fillRect(fx + 6, fy + 30, 22, 8);          // couches
      c.fillStyle = '#7a3458'; c.fillRect(fx + 8, fy + 31, 4, 3); c.fillRect(fx + 20, fy + 31, 4, 3);
      solid(fx + 6, fy + 30, 22, 8);
      c.fillStyle = '#5a2444'; c.fillRect(fx + fw - 28, fy + 30, 22, 8);
      c.fillStyle = '#7a3458'; c.fillRect(fx + fw - 26, fy + 31, 4, 3); c.fillRect(fx + fw - 14, fy + 31, 4, 3);
      solid(fx + fw - 28, fy + 30, 22, 8);
      for (let bx2 = fx + 8; bx2 < fx + fw - 8; bx2 += 7) { c.fillStyle = bx2 % 14 < 7 ? '#ff2a6d' : '#bd00ff'; c.fillRect(bx2, fy + 6, 2, 3); }
      r.lights.push({ x: cx - 18, y: fy + 33, col: '#ff2a6d' });
      r.lights.push({ x: cx + 18, y: fy + 33, col: '#bd00ff' });
      npcs.push({ x: cx, y: fy + 27, i: 3, name: 'EVE', kind: 'doll' });
      solid(cx - 4, fy + 21, 8, 9);
      break;
    }
    case 'den': {
      c.fillStyle = '#10141c'; c.fillRect(fx + 4, fy + 8, 16, 6);      // weapon rack
      c.fillStyle = '#8a93a6'; c.fillRect(fx + 6, fy + 10, 12, 1);
      solid(fx + 4, fy + 8, 16, 6);
      c.fillStyle = '#2c2620'; c.fillRect(cx - 9, fy + fh / 2 - 5, 18, 10); // table
      solid(cx - 9, fy + fh / 2 - 5, 18, 10);
      const tag = NEON[rng() * NEON.length | 0];
      c.fillStyle = tag;
      for (let k = 0; k < 6; k++) c.fillRect(fx + 4 + rng() * (fw - 10), fy + 6 + rng() * (fh - 12), 2 + (rng() * 3 | 0), 1);
      r.lights.push({ x: cx, y: fy + fh / 2, col: '#ff2a3c' });
      break;
    }
    default: // flat
      c.fillStyle = '#28323e'; c.fillRect(fx + fw - 18, fy + 6, 14, 20); // bed
      c.fillStyle = '#cfd6e4'; c.fillRect(fx + fw - 16, fy + 8, 10, 4);
      solid(fx + fw - 18, fy + 6, 14, 20);
      c.fillStyle = '#2c2620'; c.fillRect(cx - 8, fy + fh / 2, 16, 10);  // table
      solid(cx - 8, fy + fh / 2, 16, 10);
      c.fillStyle = '#0a2a3a'; c.fillRect(fx + 4, fy + 7, 10, 6);        // tv stand
      solid(fx + 4, fy + 7, 10, 6);
      r.lights.push({ x: fx + 9, y: fy + 10, col: '#7ad7ff' });
  }
  if (NAMES[b.theme]) {
    npcs.push({ x: cx, y: fy + 8, i: { guns: 2, ripper: 0, cars: 5, bar: 4 }[b.theme], name: NAMES[b.theme] });
    solid(cx - 4, fy + 2, 8, 9); // the vendor has a body — no walking through them
  }
}

function shopsHasSign(shops, text) {
  return ['2ND AMENDMENT', "VIK'S CLINIC", 'NC AUTOFIXER', 'AFTERLIFE', 'CLOUDS'].includes(text);
}

function _markAlley(alleys, x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) alleys.push({ x, y });
}

function _districtOfTile(tx, ty) {
  if (tx >= 42 && tx <= 81 && ty >= 42 && ty <= 81) return 'center';
  if (tx < 42 && ty >= 78) return 'dogtown'; // walled-off SW corner
  if (tx < 64) return ty < 64 ? 'watson' : 'pacifica';
  return ty < 64 ? 'westbrook' : 'santo';
}
