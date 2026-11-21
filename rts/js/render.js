'use strict';
// ============================================================================
// NEON TURF — render.js : the WORLD RENDERER + minimap  (presentation; Canvas 2D)
//
//   NT.Render.init(canvas) · resize() · frame(dt)
//   NT.Render.pick(sx, sy) -> entity | null     topmost entity under a screen point (CSS px) the local viewer sees
//   NT.Render.drawMinimap(ctx, w, h)            terrain + turf + Glint + entities + remembered buildings + fog + camera box + pings
//   NT.Render.minimapToWorld(mx, my, w, h) -> [wx, wy]      (inverse: worldToMinimap(wx, wy, w, h) -> [mx, my])
//   NT.Render.ping(wx, wy, color)               expanding rings on the map and the minimap
//   NT.Render.shake(amount)                     screen shake in CSS px (render transform only: picking stays exact)
//   NT.Render.setBox(sx0, sy0, sx1, sy1) / setBox(null)     the drag-selection rectangle (screen CSS px), owned by input
//   NT.Render.placeCell(def, wx, wy) -> [cx, cy]            top-left cell of a footprint centred on a world point
//   NT.Render.visibleAt(wx, wy) -> bool         the local viewer sees this spot right now (fx / audio gate)
//   NT.Render.onScreen(wx, wy, margin) -> bool  inside the camera rectangle (+ margin world px)
//   NT.Render.view                              { x0, y0, x1, y1, zoom, dpr, t } of the last frame (world px)
//
// FRAME, back to front (world space unless noted):
//   1 ground -> block shadows -> turf wash -> resources -> decals
//   2 entity shadows -> low props -> rings (selection / hover / brace / boost / capture)
//   3 y-sorted bodies: ground units + buildings + remembered buildings + city blocks
//   4 projectiles + particles          5 air shadows + bodies -> high props
//   6 ADDITIVE lights (terrain, art, fx)        7 fog of war
//   8 overlays ABOVE the fog (bars, chevrons, icons, rally, warnings, markers, pings, placement ghost)
//   9 screen space: selection box, rain, vignette, ?fps
// Engine rule: no faction / unit / building id anywhere in this file — looks come from NT.Art, state from the
// generic entity fields of sim.js. Never mutates the world.
//
// GOTCHAS
//   - This file parses before main.js: NT.Game is only touched inside functions.
//   - Per-entity state that only presentation needs (gait phase, weapon index of the last shot, rise-up time)
//     lives in `recs` keyed by entity id and is dropped on death / despawn.
//   - Grid-shaped layers (fog, turf wash, fallback ground) are tiny canvases upscaled bilinearly: soft edges for
//     free and no per-frame vector work.
// ============================================================================
(function () {
  const TILE = NT.TILE, TAU = Math.PI * 2;
  const R = NT.Render = {};
  const NEUTRAL = '#8d97ad', GLINT = '#c4f6ee', VOID = '#05060a', OWN_SEL = '#eafff2';
  const FONT = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

  let cv = null, ctx = null, W = 0, H = 0;           // canvas + size in device px
  let S = 1, OX = 0, OY = 0;                          // world -> device: X = x * S + OX
  let frameNo = 0, simNow = 0, lastTick = -1;
  let shakeAmt = 0, box = null;
  const view = R.view = { x0: 0, y0: 0, x1: 0, y1: 0, zoom: 1, dpr: 1, t: 0 };

  const recs = new Map();        // entity id -> render record
  const ground = [];             // records of the frame: ground layer (units + buildings)
  const air = [];                //                       flying units
  const sorted = [];             // y-sorted draw items (records + remembered buildings + terrain blocks)
  const memory = new Map();      // enemy / neutral buildings last seen: id -> snapshot
  const dying = [];              // bodies fading out after death
  const pings = [];
  let fogTeam = null;            // team struct the fog is drawn for, or null (spectator / fog off)

  const fog = { cv: null, cx: null, img: null, cur: null, w: 0, h: 0, fresh: true };
  const turf = { cv: null, cx: null, a: null, ax: null, b: null, bx: null, at: -1e9, any: false, sc: 2 };
  const fb = { map: null, ground: null, blocks: [], mini: null };
  const mm = { res: null, rx: null, img: null, at: -1e9, k: 1, ox: 0, oy: 0 };
  let vignette = null, icons = null, rain = null;

  function mk(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); return c; }
  function lerpAng(a, b, t) { return a + NT.angDiff(a, b) * t; }
  function colorOf(world, owner) { const p = world.players[owner]; return p ? p.color : NEUTRAL; }
  function worldT() { ctx.setTransform(S, 0, 0, S, OX, OY); }
  // the city painter, unless it is missing or switched off for debugging (?noterrain): then the flat fallback draws
  function terrain() { const G = NT.Game; return G.params && G.params.has('noterrain') ? null : NT.Terrain || null; }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------
  R.init = function (canvas) {
    cv = canvas;
    ctx = cv.getContext('2d', { alpha: false });
    R.resize();
  };

  R.resize = function () {
    if (!cv) return;
    const G = NT.Game, dpr = G.view.dpr || 1;
    W = Math.max(1, Math.round((G.view.w || window.innerWidth) * dpr));
    H = Math.max(1, Math.round((G.view.h || window.innerHeight) * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    vignette = null;
  };

  function reset() {
    recs.clear(); memory.clear();
    ground.length = air.length = sorted.length = dying.length = pings.length = 0;
    fog.fresh = true; fog.w = 0; turf.at = -1e9; turf.any = false; mm.at = -1e9;
    fb.map = null; lastTick = -1; shakeAmt = 0; box = null; fogTeam = null;
  }
  NT.on('game:start', reset);
  NT.on('game:stop', reset);

  NT.on('sim:fire', function (ev) { const r = recs.get(ev.id); if (r) r.wi = ev.wi; });
  NT.on('sim:placed', function (ev) { rec(ev.id).rise = NT.Game.world.tick * NT.DT; turf.at = -1e9; });
  NT.on('sim:captured', function () { turf.at = -1e9; });
  NT.on('sim:despawn', function (ev) { recs.delete(ev.id); if (ev.kind === 'building') turf.at = -1e9; });
  NT.on('sim:death', function (ev) {
    const r = recs.get(ev.id);
    recs.delete(ev.id);
    if (ev.kind === 'building') turf.at = -1e9;
    if (!r || r.seenF < frameNo - 1 || dying.length > 60) return;       // only bodies that were on screen
    r.st.ghost = 1; r.st.flash = 1; r.st.moving = false;
    r.diedAt = NT.Game.world.tick * NT.DT;
    dying.push(r);
  });

  // --------------------------------------------------------------------------
  // Records
  // --------------------------------------------------------------------------
  function newRec(id) {
    return {
      id: id, e: null, def: null, b: null, air: false, mem: false, draw: null,
      rx: 0, ry: 0, y: 0, lx: NaN, ly: 0, walk: 0, stride: 16, wi: 0, rr: 8,
      seenF: -9, selF: -9, rise: -1, diedAt: 0, bits: 0,
      st: { team: NEUTRAL, facing: 0, aim: 0, t: 0, moving: false, walk: 0, fire: 0, hp: 1, deployed: false, cargo: 0, rank: 0,
        powered: true, active: false, ghost: undefined, flash: 0, seed: id, zoom: 1, weapon: 0 },
    };
  }
  function rec(id) { let r = recs.get(id); if (!r) { r = newRec(id); recs.set(id, r); } return r; }

  // buff marks: 1 = boosted (pulsing outline), 2 = hindered (dimmed), 4 = burning
  function buffBits(e, tick) {
    let bits = 0;
    for (let i = 0; i < e.buffs.length; i++) {
      const b = e.buffs[i];
      if (b.until <= tick || (b.from !== undefined && b.from > tick)) continue;
      if (b.dps) bits |= 4;
      else if (b.dmg > 1 || b.speed > 1 || b.rof > 1 || b.taken < 1) bits |= 1;
      else bits |= 2;
    }
    return bits;
  }
  // 0 = idle, else 1 + progress of the head item of a queue this producer serves
  function producing(world, e) {
    const tr = e.def.traits.producer, p = world.players[e.owner];
    if (!tr || !p || !p.queues) return 0;
    let best = 0;
    for (let i = 0; i < tr.queues.length; i++) {
      const q = p.queues[tr.queues[i]];
      if (q && q.items && q.items.length) best = Math.max(best, 1 + (q.items[0].progress || 0));
    }
    return best;
  }

  function fill(world, r, e, a) {
    const G = NT.Game, st = r.st, def = e.def;
    if (r.def !== def) {
      r.def = def; r.b = NT.Art.bounds(def); r.air = def.layer === 'air';
      r.stride = Math.max(12, def.radius * 2.4);
      r.rr = def.body === 'small' ? def.radius + 1.5 : r.b.w / 2 + 1.5;      // ring radius: infantry share a cell, keep theirs tight
    }
    r.e = e;
    const x = e.px + (e.x - e.px) * a, y = e.py + (e.y - e.py) * a;
    if (r.lx === r.lx) { const d = Math.hypot(x - r.lx, y - r.ly); if (d > 0 && d < 48) r.walk += d / r.stride; }   // a teleport is not a walk
    r.lx = r.rx = x; r.ly = r.ry = y;
    r.bits = e.buffs.length ? buffBits(e, world.tick) : 0;
    st.team = colorOf(world, e.owner);
    st.facing = lerpAng(e.pfacing, e.facing, a); st.aim = lerpAng(e.paim, e.aim, a);
    st.t = G.now; st.zoom = S; st.seed = e.id; st.weapon = r.wi; st.ghost = undefined;
    st.moving = e.kind === 'unit' && (e.hopT >= 0 || e.x !== e.px || e.y !== e.py);
    st.walk = r.walk % 1;
    st.fire = e.recoil > 0 ? Math.max(0, e.recoil - 0.2 * a) : 0;
    st.flash = e.flash > 0 ? Math.max(0, e.flash - 0.25 * a) : 0;
    st.hp = e.hp / e.maxHp; st.rank = e.rank; st.powered = e.powered;
    st.deployed = e.braced || e.deployed;
    const hv = def.traits.harvester;
    st.cargo = hv && hv.capacity ? Math.min(1, e.cargo / hv.capacity) : 0;
    st.active = e.kind === 'building' && producing(world, e) > 0;
  }

  // snapshot of a building the viewer does not own, refreshed while it is in sight
  function remember(world, e, r) {
    let m = memory.get(e.id);
    if (!m) {
      m = newRec(e.id); m.mem = true; m.def = e.def; m.b = r.b;
      m.cx = e.cx; m.cy = e.cy; m.w = e.w; m.h = e.h; m.owner = e.owner;
      m.rx = e.x; m.ry = e.y; m.y = e.y + e.h * TILE / 2 + (e.id % 512) * 1e-4;
      memory.set(e.id, m);
    }
    m.owner = e.owner; m.seenF = frameNo;
    const st = m.st;
    st.team = r.st.team; st.hp = r.st.hp; st.aim = e.aim; st.facing = e.facing; st.powered = e.powered; st.ghost = 0.82;
  }
  function footprintSeen(vis, w, m) {
    for (let y = m.cy; y < m.cy + m.h; y++) for (let x = m.cx; x < m.cx + m.w; x++) if (vis[y * w + x] > 0) return true;
    return false;
  }

  function inView(r) {
    const b = r.b;
    return r.rx + b.x1 > view.x0 - 24 && r.rx + b.x0 < view.x1 + 8 && r.ry + b.y1 > view.y0 - 24 && r.ry + b.y0 < view.y1 + 8;
  }
  function byY(a, b) { return a.y - b.y; }

  function prepare(world) {
    const G = NT.Game, ents = world.ents, a = G.alpha, myTeam = G.team();
    ground.length = air.length = sorted.length = 0;
    frameNo++;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e.alive || e.hidden) continue;
      const foreign = fogTeam !== null && NT.teamOf(world, e.owner) !== myTeam;
      if (foreign && !NT.Fog.canSee(world, myTeam, e)) continue;
      const r = rec(e.id);
      fill(world, r, e, a);
      if (foreign && e.kind === 'building') remember(world, e, r);
      if (!inView(r)) continue;
      r.seenF = frameNo;
      if (r.air) { r.y = r.ry; air.push(r); continue; }
      r.y = (e.kind === 'building' ? r.ry + e.h * TILE / 2 : r.ry) + (e.id % 512) * 1e-4;
      ground.push(r); sorted.push(r);
    }
    if (fogTeam) {
      const vis = fogTeam.vis;
      memory.forEach(function (m, id) {
        if (m.seenF === frameNo) return;
        if (footprintSeen(vis, world.w, m)) { memory.delete(id); turf.at = -1e9; return; }   // looked again: it is gone
        m.st.zoom = S; m.st.t = G.now;
        if (inView(m)) sorted.push(m);
      });
    } else if (memory.size) memory.clear();
    for (let i = 0; i < G.sel.length; i++) { const r = recs.get(G.sel[i]); if (r) r.selF = frameNo; }
    const T = terrain(), blocks = T && T.blocks ? T.blocks(view) : fallbackBlocks();
    if (blocks) for (let i = 0; i < blocks.length; i++) sorted.push(blocks[i]);
    sorted.sort(byY);
    if (air.length > 1) air.sort(byY);
  }

  // --------------------------------------------------------------------------
  // Fallback terrain (only while NT.Terrain is missing): flat cells, plain towers, resource dots
  // --------------------------------------------------------------------------
  const FB_COL = ['#141822', '#1d222e', '#222736', '#2a2a31', '#0b2031', '#0d0f16'];
  function hexRGB(c) { const n = parseInt(c.slice(1, 7), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
  function fallbackBuild(map) {
    fb.map = map;
    const c = fb.ground = mk(map.w, map.h), x = c.getContext('2d'), img = x.createImageData(map.w, map.h), d = img.data;
    for (let i = 0; i < map.w * map.h; i++) {
      const col = hexRGB(FB_COL[map.terrain[i]] || FB_COL[0]), k = ((i % map.w) + ((i / map.w) | 0)) & 1 ? 0 : 3;
      d[i * 4] = col[0] + k; d[i * 4 + 1] = col[1] + k; d[i * 4 + 2] = col[2] + k; d[i * 4 + 3] = 255;
    }
    x.putImageData(img, 0, 0);
    fb.blocks = map.blocks.map(function (b) {
      const hgt = NT.clamp(b.height || 24, 12, 44), x0 = b.x * TILE, y0 = b.y * TILE, w = b.w * TILE, h = b.h * TILE;
      return { y: y0 + h, x0: x0, x1: x0 + w, top: y0 - hgt, draw: function (c2) {
        c2.fillStyle = '#10131c'; c2.fillRect(x0, y0 + h - hgt, w, hgt);
        c2.fillStyle = '#262c3a'; c2.fillRect(x0, y0 - hgt, w, h);
        c2.fillStyle = '#313849'; c2.fillRect(x0, y0 - hgt, w, 2); c2.fillRect(x0, y0 - hgt, 2, h);
      } };
    });
  }
  const fbOut = [];
  function fallbackBlocks() {
    fbOut.length = 0;
    for (let i = 0; i < fb.blocks.length; i++) {
      const b = fb.blocks[i];
      if (b.x1 > view.x0 && b.x0 < view.x1 && b.y > view.y0 && b.top < view.y1) fbOut.push(b);
    }
    return fbOut;
  }
  function fallbackGround(map) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(fb.ground, 0, 0, map.w * TILE, map.h * TILE);
    ctx.imageSmoothingEnabled = true;
  }
  function fallbackResources(map) {
    const x0 = Math.max(0, Math.floor(view.x0 / TILE)), x1 = Math.min(map.w - 1, Math.floor(view.x1 / TILE));
    const y0 = Math.max(0, Math.floor(view.y0 / TILE)), y1 = Math.min(map.h - 1, Math.floor(view.y1 / TILE));
    ctx.fillStyle = GLINT;
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const v = map.res[cy * map.w + cx];
      if (!v) continue;
      const n = 1 + Math.min(4, (v / 150) | 0), h = NT.hash32 ? NT.hash32(cx, cy) : cx * 7919 + cy * 104729;
      for (let k = 0; k < n; k++) {
        const px = (cx + 0.2 + ((h >> (k * 5)) & 15) / 25) * TILE, py = (cy + 0.2 + ((h >> (k * 5 + 2)) & 15) / 25) * TILE;
        ctx.globalAlpha = 0.55 + 0.4 * Math.sin(view.t * 3 + k + cx);
        ctx.fillRect(px - 2, py - 2, 4, 4);
      }
    }
    ctx.globalAlpha = 1;
  }

  // --------------------------------------------------------------------------
  // Turf wash: which ground belongs to whom (2 px per cell, soft rim, upscaled)
  // --------------------------------------------------------------------------
  function rr(c, x, y, w, h, r) { if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h); }
  function turfSources(world, out) {
    out.length = 0;
    const ents = world.ents, myTeam = NT.Game.team();
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (e.kind !== 'building' || e.owner < 0 || !e.alive) continue;
      if (fogTeam && NT.teamOf(world, e.owner) !== myTeam) continue;       // foreign turf comes from memory only
      out.push(e);
    }
    if (fogTeam) memory.forEach(function (m) { if (m.owner >= 0) out.push(m); });
    return out;
  }
  const turfSrc = [];
  function buildTurf(world) {
    const sc = turf.sc, w = world.w * sc, h = world.h * sc, gap = world.rules.buildGap || 3;
    if (!turf.cv || turf.cv.width !== w || turf.cv.height !== h) {
      turf.cv = mk(w, h); turf.cx = turf.cv.getContext('2d');
      turf.a = mk(w, h); turf.ax = turf.a.getContext('2d');
      turf.b = mk(w, h); turf.bx = turf.b.getContext('2d');
    }
    const src = turfSources(world, turfSrc), X = turf.cx, A = turf.ax, B = turf.bx;
    X.clearRect(0, 0, w, h);
    turf.any = false;
    for (let p = 0; p < world.players.length; p++) {
      let n = 0;
      A.globalCompositeOperation = 'source-over'; A.globalAlpha = 1;
      A.clearRect(0, 0, w, h); B.clearRect(0, 0, w, h);
      A.fillStyle = B.fillStyle = world.players[p].color;
      A.beginPath(); B.beginPath();
      for (let i = 0; i < src.length; i++) {
        const s = src[i];
        if (s.owner !== p) continue;
        n++;
        rr(A, (s.cx - gap) * sc, (s.cy - gap) * sc, (s.w + 2 * gap) * sc, (s.h + 2 * gap) * sc, gap * sc * 0.7);
        const g2 = gap - 0.8;
        rr(B, (s.cx - g2) * sc, (s.cy - g2) * sc, (s.w + 2 * g2) * sc, (s.h + 2 * g2) * sc, g2 * sc * 0.7);
      }
      if (!n) continue;
      A.fill(); B.fill();
      A.globalCompositeOperation = 'destination-out'; A.globalAlpha = 0.6;     // hollow the inside: a bright rim, a faint field
      A.drawImage(turf.b, 0, 0);
      X.drawImage(turf.a, 0, 0);
      turf.any = true;
    }
    turf.at = simNow;
  }
  function drawTurf(world) {
    if (simNow - turf.at > 0.5 || simNow < turf.at) buildTurf(world);
    if (!turf.any) return;
    ctx.globalAlpha = 0.2;
    ctx.drawImage(turf.cv, 0, 0, world.w * TILE, world.h * TILE);
    ctx.globalAlpha = 1;
  }

  // --------------------------------------------------------------------------
  // Fog of war: 1 px per cell (+ a clamped 1-cell border), eased over time, blurred 3x3, upscaled
  // --------------------------------------------------------------------------
  const FOG_DARK = 0.965, FOG_DIM = 0.5;
  function updateFog(world, team, dt) {
    const w = world.w, h = world.h, fw = w + 2, fh = h + 2;
    if (fog.w !== fw || fog.h !== fh || !fog.cv) {
      fog.cv = mk(fw, fh); fog.cx = fog.cv.getContext('2d'); fog.img = fog.cx.createImageData(fw, fh);
      fog.cur = new Float32Array(fw * fh); fog.w = fw; fog.h = fh; fog.fresh = true;
      const d = fog.img.data;
      for (let i = 0; i < fw * fh; i++) { d[i * 4] = 4; d[i * 4 + 1] = 5; d[i * 4 + 2] = 11; }
    }
    const cur = fog.cur, vis = team.vis, ex = team.explored, k = fog.fresh ? 1 : Math.min(1, dt * 7);
    for (let y = 0; y < fh; y++) {
      const sy = y < 1 ? 0 : y > h ? h - 1 : y - 1;
      for (let x = 0; x < fw; x++) {
        const sx = x < 1 ? 0 : x > w ? w - 1 : x - 1, i = sy * w + sx;
        const target = vis[i] > 0 ? 0 : ex[i] ? FOG_DIM : FOG_DARK, j = y * fw + x;
        cur[j] += (target - cur[j]) * k;
      }
    }
    fog.fresh = false;
    const d = fog.img.data;
    for (let y = 0; y < fh; y++) {
      const ya = y > 0 ? -fw : 0, yb = y < fh - 1 ? fw : 0;
      for (let x = 0; x < fw; x++) {
        const j = y * fw + x, xa = x > 0 ? -1 : 0, xb = x < fw - 1 ? 1 : 0;
        const v = (cur[j] * 4 + (cur[j + xa] + cur[j + xb] + cur[j + ya] + cur[j + yb]) * 2 +
          cur[j + ya + xa] + cur[j + ya + xb] + cur[j + yb + xa] + cur[j + yb + xb]) / 16;
        d[j * 4 + 3] = v * 255;
      }
    }
    fog.cx.putImageData(fog.img, 0, 0);
  }
  function drawFog(world) {
    // only the visible part of the tiny canvas: source rect in fog px, one extra cell all round
    const fw = fog.w, fh = fog.h;
    const sx0 = NT.clamp(Math.floor(view.x0 / TILE), 0, fw - 1), sy0 = NT.clamp(Math.floor(view.y0 / TILE), 0, fh - 1);
    const sx1 = NT.clamp(Math.ceil(view.x1 / TILE) + 2, 1, fw), sy1 = NT.clamp(Math.ceil(view.y1 / TILE) + 2, 1, fh);
    if (sx1 <= sx0 || sy1 <= sy0) return;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fog.cv, sx0, sy0, sx1 - sx0, sy1 - sy0, (sx0 - 1) * TILE, (sy0 - 1) * TILE, (sx1 - sx0) * TILE, (sy1 - sy0) * TILE);
  }
  // everything beyond the map edge is void
  function drawVoid(world) {
    const mw = world.w * TILE, mh = world.h * TILE, big = 4096;
    ctx.fillStyle = VOID;
    if (view.x0 < 0) ctx.fillRect(-big, -big, big, mh + 2 * big);
    if (view.x1 > mw) ctx.fillRect(mw, -big, big, mh + 2 * big);
    if (view.y0 < 0) ctx.fillRect(0, -big, mw, big);
    if (view.y1 > mh) ctx.fillRect(0, mh, mw, big);
  }

  // --------------------------------------------------------------------------
  // Entity passes
  // --------------------------------------------------------------------------
  function entT(r) {
    let tx = OX + r.rx * S, ty = OY + r.ry * S;
    if (!r.st.moving) { tx = Math.round(tx); ty = Math.round(ty); }
    ctx.setTransform(S, 0, 0, S, tx, ty);
  }
  function drawShadows(list) {
    const A = NT.Art;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (r.draw) continue;
      entT(r);
      A.drawShadow(ctx, r.def, r.st);
    }
  }
  function drawBody(r) {
    const st = r.st, b = r.b;
    entT(r);
    if (r.rise >= 0) {                                   // a freshly placed structure wipes in from the ground up
      const k = (simNow - r.rise) / 0.55;
      if (k >= 0 && k < 1) {
        const full = b.y1 - b.y0;
        ctx.save();
        ctx.beginPath(); ctx.rect(b.x0 - 2, b.y1 - full * k, b.x1 - b.x0 + 4, full * k + 2); ctx.clip();
        st.flash = Math.max(st.flash, 0.7 * (1 - k));
        NT.Art.drawEntity(ctx, r.def, st);
        ctx.restore();
        return;
      }
      r.rise = -1;
    }
    if (r.bits & 2) { ctx.globalAlpha = 0.62; NT.Art.drawEntity(ctx, r.def, st); ctx.globalAlpha = 1; }
    else NT.Art.drawEntity(ctx, r.def, st);
  }
  function drawSorted() {
    let world = false;
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      if (it.draw) { if (!world) { worldT(); world = true; } it.draw(ctx); }
      else { drawBody(it); world = false; }
    }
  }
  function drawDying() {
    let j = 0;
    for (let i = 0; i < dying.length; i++) {
      const r = dying[i], life = r.e && r.e.kind === 'building' ? 0.5 : 0.22, k = (simNow - r.diedAt) / life;
      if (k < 0 || k >= 1) continue;
      r.st.ghost = (1 - k) * (1 - k); r.st.flash = 1 - k; r.st.zoom = S;
      entT(r);
      NT.Art.drawEntity(ctx, r.def, r.st);
      dying[j++] = r;
    }
    dying.length = j;
  }
  function drawLights(list) {
    const A = NT.Art;
    for (let i = 0; i < list.length; i++) { const r = list[i]; entT(r); A.drawLights(ctx, r.def, r.st); }
  }

  // rings under the bodies -----------------------------------------------------
  function ringPath(r, rad) { ctx.moveTo(r.rx + rad, r.ry); ctx.arc(r.rx, r.ry, rad, 0, TAU); }
  function bracketPath(r, pad, len) {
    const x0 = r.rx - r.b.w / 2 - pad, x1 = r.rx + r.b.w / 2 + pad, y0 = r.ry - r.b.h / 2 - pad, y1 = r.ry + r.b.h / 2 + pad;
    ctx.moveTo(x0, y0 + len); ctx.lineTo(x0, y0); ctx.lineTo(x0 + len, y0);
    ctx.moveTo(x1 - len, y0); ctx.lineTo(x1, y0); ctx.lineTo(x1, y0 + len);
    ctx.moveTo(x1, y1 - len); ctx.lineTo(x1, y1); ctx.lineTo(x1 - len, y1);
    ctx.moveTo(x0 + len, y1); ctx.lineTo(x0, y1); ctx.lineTo(x0, y1 - len);
  }
  function selPath(r, isSel) {
    if (r.e.kind === 'building') bracketPath(r, 3, Math.min(12, r.b.w * 0.22));
    else ringPath(r, r.rr + (isSel ? 0 : 1.5));
  }
  function chevronRing(r, rad, t) {                       // braced: a ring of outward chevrons
    const n = 8, rot = t * 0.25;
    for (let i = 0; i < n; i++) {
      const a = rot + i / n * TAU, c = Math.cos(a), s = Math.sin(a), px = -s, py = c;
      ctx.moveTo(r.rx + c * rad + px * 2.6, r.ry + s * rad + py * 2.6);
      ctx.lineTo(r.rx + c * (rad + 2.6), r.ry + s * (rad + 2.6));
      ctx.lineTo(r.rx + c * rad - px * 2.6, r.ry + s * rad - py * 2.6);
    }
  }
  function strokeHalo(col, lw) {                          // dark under-stroke keeps marks readable on any ground
    ctx.lineWidth = lw + 1.6; ctx.strokeStyle = 'rgba(4,5,10,0.7)'; ctx.stroke();
    ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke();
  }
  function drawRings(world) {
    const G = NT.Game, myTeam = G.team(), lw = Math.max(1.2, 1.4 / view.zoom), t = G.now;
    let own = 0, braced = 0;
    worldT();
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    ctx.beginPath();
    for (let pass = 0; pass < 2; pass++) {
      const list = pass ? air : ground;
      for (let i = 0; i < list.length; i++) {
        const r = list[i], e = r.e, sel = r.selF === frameNo;
        if (e.braced) braced++;
        if (!sel) continue;
        if (NT.teamOf(world, e.owner) === myTeam && myTeam >= 0) { selPath(r, true); own++; }
      }
    }
    if (own) strokeHalo(OWN_SEL, lw);
    // foreign selections (inspect) + hover, each in the owner's colour
    for (let pass = 0; pass < 2; pass++) {
      const list = pass ? air : ground;
      for (let i = 0; i < list.length; i++) {
        const r = list[i], e = r.e, sel = r.selF === frameNo, mine = NT.teamOf(world, e.owner) === myTeam && myTeam >= 0;
        if (sel && !mine) { ctx.beginPath(); selPath(r, true); strokeHalo(r.st.team, lw); }
        else if (!sel && e.id === G.hover) {
          ctx.globalAlpha = 0.6; ctx.beginPath(); selPath(r, false); ctx.lineWidth = lw; ctx.strokeStyle = mine ? OWN_SEL : r.st.team; ctx.stroke(); ctx.globalAlpha = 1;
        }
        if (r.bits & 1) {                                 // boosted: pulsing outline
          const k = 0.5 + 0.5 * Math.sin(t * 9 + e.id);
          ctx.globalAlpha = 0.35 + 0.5 * k; ctx.beginPath(); ringPath(r, r.rr + 2 + 2.5 * k);
          ctx.lineWidth = 1.6; ctx.strokeStyle = r.st.team; ctx.stroke(); ctx.globalAlpha = 1;
        }
        if (e.captureT > 0) captureRing(world, r);
      }
    }
    if (braced) {
      ctx.beginPath();
      for (let i = 0; i < ground.length; i++) { const r = ground[i]; if (r.e.braced) chevronRing(r, r.rr + 2, t); }
      ctx.lineJoin = 'round';
      strokeHalo('#f1f4fb', 1.1);
    }
  }
  function captureRing(world, r) {
    const e = r.e, by = world.byId.get(e.captureBy), tr = by && by.def.traits.capturer;
    const k = tr && tr.timeT ? Math.min(1, e.captureT / tr.timeT) : 0.5, rad = Math.max(r.b.w, r.b.h) / 2 + 9;
    ctx.beginPath(); ctx.arc(r.rx, r.ry, rad, 0, TAU);
    ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(4,5,10,0.6)'; ctx.stroke();
    ctx.beginPath(); ctx.arc(r.rx, r.ry, rad, -Math.PI / 2, -Math.PI / 2 + TAU * k);
    ctx.lineWidth = 3; ctx.strokeStyle = by ? colorOf(world, by.owner) : '#fff'; ctx.stroke();
    ctx.setLineDash([2, 5]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath(); ctx.arc(r.rx, r.ry, rad + 4, NT.Game.now, NT.Game.now + TAU); ctx.stroke();
    ctx.setLineDash([]);
  }

  // --------------------------------------------------------------------------
  // Overlays (drawn above the fog)
  // --------------------------------------------------------------------------
  function bakeIcons() {
    icons = {};
    const sc = 4, n = 16;
    let c = icons.unpowered = mk(n * sc, n * sc), x = c.getContext('2d');
    x.scale(sc, sc); x.lineJoin = 'round'; x.lineCap = 'round';
    x.beginPath(); x.arc(8, 8, 7.2, 0, TAU); x.fillStyle = 'rgba(6,7,12,0.82)'; x.fill();
    x.beginPath(); x.moveTo(9.4, 2.4); x.lineTo(4.6, 8.8); x.lineTo(7.6, 8.8); x.lineTo(6.4, 13.6); x.lineTo(11.4, 6.9); x.lineTo(8.4, 6.9); x.closePath();
    x.fillStyle = '#ffd23f'; x.fill();
    x.beginPath(); x.moveTo(3, 13); x.lineTo(13, 3); x.lineWidth = 2.6; x.strokeStyle = 'rgba(6,7,12,0.9)'; x.stroke();
    x.lineWidth = 1.5; x.strokeStyle = '#ff4d5e'; x.stroke();
    x.beginPath(); x.arc(8, 8, 7.2, 0, TAU); x.lineWidth = 1; x.strokeStyle = '#ff4d5e'; x.stroke();
    c = icons.repair = mk(n * sc, n * sc); x = c.getContext('2d');
    x.scale(sc, sc); x.lineJoin = 'round'; x.lineCap = 'round';
    x.beginPath(); x.arc(8, 8, 7.2, 0, TAU); x.fillStyle = 'rgba(6,7,12,0.82)'; x.fill(); x.lineWidth = 1; x.strokeStyle = '#7dffb0'; x.stroke();
    x.translate(8, 8); x.rotate(-Math.PI / 4);
    x.beginPath(); x.moveTo(0, -1.5); x.lineTo(0, 5.2); x.lineWidth = 2.2; x.strokeStyle = '#e8ecf5'; x.stroke();
    x.beginPath(); x.arc(0, -3.2, 2.5, Math.PI * 1.78, Math.PI * 1.22); x.lineWidth = 1.8; x.stroke();
  }
  function hpColor(f) { return f > 0.6 ? '#3dff8b' : f > 0.3 ? '#ffc247' : '#ff4a5c'; }
  function bar(x, y, w, h, f, col) {
    ctx.fillStyle = 'rgba(4,5,10,0.85)'; ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = col; ctx.fillRect(x, y, Math.max(1, w * f), h);
  }
  function drawBars(world, list, uk) {
    const G = NT.Game, myTeam = G.team(), A = NT.Art;
    for (let i = 0; i < list.length; i++) {
      const r = list[i], e = r.e, b = r.b, isB = e.kind === 'building';
      const sel = r.selF === frameNo, hov = e.id === G.hover, mine = myTeam >= 0 && NT.teamOf(world, e.owner) === myTeam;
      const bw = NT.clamp(b.w * (isB ? 0.8 : 1.1), 14, 72) * uk, bh = (isB ? 4 : 3) * uk;
      let top = r.ry - b.h / 2 - b.up - 5 * uk - bh;
      if (sel || hov || e.hp < e.maxHp) {
        const f = e.hp / e.maxHp;
        bar(r.rx - bw / 2, top, bw, bh, f, hpColor(f));
        top -= bh + 2 * uk;
      }
      const hv = e.def.traits.harvester;
      if (hv && (mine || G.me < 0) && (e.cargo > 0 || sel)) {
        bar(r.rx - bw / 2, top, bw, 2 * uk, Math.min(1, e.cargo / hv.capacity), GLINT);
        top -= 4 * uk;
      }
      if (isB && sel && mine) {
        const p = producing(world, e);
        if (p > 0) { bar(r.rx - bw / 2, top, bw, 3 * uk, p - 1, r.st.team); top -= 5 * uk; }
      }
      if (e.rank > 0 && !isB) { ctx.translate(r.rx, r.ry); A.drawRank(ctx, e.rank, b.w / 2 + 1); ctx.translate(-r.rx, -r.ry); }
      if (isB && (e.powered === false || e.repairing)) {
        const sz = 19 * uk, pulse = 0.8 + 0.2 * Math.sin(G.now * 6 + e.id);
        if (e.powered === false) { ctx.globalAlpha = pulse; ctx.drawImage(icons.unpowered, r.rx - sz / 2 - (e.repairing ? sz * 0.6 : 0), r.ry - sz / 2 - b.up * 0.4, sz, sz); ctx.globalAlpha = 1; }
        if (e.repairing) {
          const wob = Math.sin(G.now * 7) * 0.35, cx2 = r.rx + (e.powered === false ? sz * 0.6 : 0), cy2 = r.ry - b.up * 0.4;
          ctx.translate(cx2, cy2); ctx.rotate(wob); ctx.drawImage(icons.repair, -sz / 2, -sz / 2, sz, sz); ctx.rotate(-wob); ctx.translate(-cx2, -cy2);
        }
      }
      if (r.bits & 2) {                                  // hindered: a drooping chevron above the head
        const y0 = top + bh + 1 * uk;
        ctx.beginPath(); ctx.moveTo(r.rx - 3.5 * uk, y0 - 3 * uk); ctx.lineTo(r.rx, y0); ctx.lineTo(r.rx + 3.5 * uk, y0 - 3 * uk);
        ctx.lineWidth = 2.6 * uk; ctx.strokeStyle = 'rgba(4,5,10,0.8)'; ctx.stroke();
        ctx.lineWidth = 1.2 * uk; ctx.strokeStyle = '#9fd0ff'; ctx.stroke();
      }
      if (isB && sel && mine && e.rally) rally(r, e.rally, uk);
    }
  }
  function rally(r, p, uk) {
    const col = r.st.team;
    ctx.setLineDash([5 * uk, 4 * uk]); ctx.lineDashOffset = -NT.Game.now * 14;
    ctx.beginPath(); ctx.moveTo(r.rx, r.ry + r.b.h / 2); ctx.lineTo(p.x, p.y);
    ctx.lineWidth = 2.6 * uk; ctx.strokeStyle = 'rgba(4,5,10,0.55)'; ctx.stroke();
    ctx.lineWidth = 1.2 * uk; ctx.strokeStyle = col; ctx.stroke();
    ctx.setLineDash([]);
    const fl = 9 * uk, wave = Math.sin(NT.Game.now * 5) * 1.5 * uk;
    ctx.beginPath(); ctx.arc(p.x, p.y, 2.4 * uk, 0, TAU); ctx.fillStyle = 'rgba(4,5,10,0.8)'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 15 * uk); ctx.lineWidth = 1.6 * uk; ctx.strokeStyle = '#e8ecf5'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.x, p.y - 15 * uk); ctx.lineTo(p.x + fl, p.y - 12 * uk + wave); ctx.lineTo(p.x, p.y - 8.5 * uk); ctx.closePath();
    ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 0.8 * uk; ctx.strokeStyle = 'rgba(4,5,10,0.8)'; ctx.stroke();
  }

  R.placeCell = function (def, wx, wy) {
    return [Math.round(wx / TILE - def.size[0] / 2), Math.round(wy / TILE - def.size[1] / 2)];
  };
  const ghostSt = { team: NEUTRAL, facing: Math.PI / 2, aim: Math.PI / 2, t: 0, hp: 1, powered: true, ghost: 0.6, seed: 0, zoom: 1 };
  function placementCells(world, p, def, cx, cy) {
    if (NT.Prod && NT.Prod.canPlace) { const res = NT.Prod.canPlace(world, p, def, cx, cy); if (res && res.cells) return res.cells; }
    const out = [];
    for (let y = cy; y < cy + def.size[1]; y++) for (let x = cx; x < cx + def.size[0]; x++) {
      const i = y * world.w + x;
      let ok = NT.Map.buildableTerrain(world.map, x, y) && !world.occ[i];
      for (let k = 0; ok && k < NT.INF_PER_CELL; k++) if (world.inf[i * NT.INF_PER_CELL + k]) ok = false;
      out.push({ cx: x, cy: y, ok: ok });
    }
    return out;
  }
  function drawPlacement(world, uk) {
    const G = NT.Game, m = G.mode, def = m && m.type === 'place' && (typeof m.def === 'string' ? NT.DEFS[m.def] : m.def), p = G.player();
    if (!def || def.kind !== 'building' || !p) return;
    if (m.cx === undefined && !G.pointer.inside) return;
    const c = m.cx === undefined ? R.placeCell(def, G.pointer.wx, G.pointer.wy) : [m.cx, m.cy];
    const cells = placementCells(world, p, def, c[0], c[1]);
    let ok = true;
    for (let i = 0; i < cells.length; i++) {
      const q = cells[i];
      if (!q.ok) ok = false;
      ctx.fillStyle = q.ok ? 'rgba(70,255,150,0.28)' : 'rgba(255,70,90,0.38)';
      ctx.fillRect(q.cx * TILE + 1, q.cy * TILE + 1, TILE - 2, TILE - 2);
      ctx.strokeStyle = q.ok ? 'rgba(120,255,180,0.8)' : 'rgba(255,110,125,0.9)'; ctx.lineWidth = 1;
      ctx.strokeRect(q.cx * TILE + 1.5, q.cy * TILE + 1.5, TILE - 3, TILE - 3);
    }
    const wx = (c[0] + def.size[0] / 2) * TILE, wy = (c[1] + def.size[1] / 2) * TILE;
    let range = 0;
    for (let i = 0; i < def.weapons.length; i++) range = Math.max(range, def.weapons[i].rangePx);
    if (range > 0) {
      ctx.setLineDash([6, 6]); ctx.lineDashOffset = -G.now * 10;
      ctx.beginPath(); ctx.arc(wx, wy, range, 0, TAU);
      ctx.lineWidth = 1.4 * uk; ctx.strokeStyle = ok ? 'rgba(255,255,255,0.55)' : 'rgba(255,110,125,0.6)'; ctx.stroke();
      ctx.setLineDash([]);
    }
    ghostSt.team = p.color; ghostSt.t = G.now; ghostSt.zoom = S; ghostSt.ghost = ok ? 0.66 : 0.4;
    ctx.setTransform(S, 0, 0, S, Math.round(OX + wx * S), Math.round(OY + wy * S));
    NT.Art.drawEntity(ctx, def, ghostSt);
    worldT();
  }

  R.ping = function (wx, wy, color) {
    if (pings.length > 24) pings.shift();
    pings.push({ x: wx, y: wy, col: color || '#ffffff', t0: NT.Game.now });
  };
  function drawPings(uk) {
    const now = NT.Game.now;
    let j = 0;
    for (let i = 0; i < pings.length; i++) {
      const p = pings[i], age = now - p.t0;
      if (age > 2.4) continue;
      pings[j++] = p;
      for (let k = 0; k < 3; k++) {
        const a = age - k * 0.35;
        if (a < 0 || a > 1.2) continue;
        const f = a / 1.2;
        ctx.globalAlpha = (1 - f) * 0.9;
        ctx.beginPath(); ctx.arc(p.x, p.y, (10 + 70 * f * (2 - f)) * uk, 0, TAU);
        ctx.lineWidth = (3 - 2 * f) * uk; ctx.strokeStyle = p.col; ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    pings.length = j;
  }

  // --------------------------------------------------------------------------
  // Screen space
  // --------------------------------------------------------------------------
  function bakeVignette() {
    const w = 320, h = Math.max(64, Math.round(320 * H / W));
    vignette = mk(w, h);
    const x = vignette.getContext('2d'), g = x.createRadialGradient(w / 2, h / 2, h * 0.42, w / 2, h / 2, Math.hypot(w, h) * 0.56);
    g.addColorStop(0, 'rgba(3,4,10,0)'); g.addColorStop(0.6, 'rgba(3,4,10,0.22)'); g.addColorStop(1, 'rgba(3,4,10,0.6)');
    x.fillStyle = g; x.fillRect(0, 0, w, h);
    const m = x.createLinearGradient(0, 0, 0, h);                       // a little mist hanging at the top of the frame
    m.addColorStop(0, 'rgba(90,120,170,0.07)'); m.addColorStop(0.35, 'rgba(90,120,170,0)');
    x.fillStyle = m; x.fillRect(0, 0, w, h);
  }
  function bakeRain() {
    rain = [];
    for (let i = 0; i < 90; i++) rain.push({ x: Math.random(), ph: Math.random(), sp: 0.9 + Math.random() * 0.7, len: 0.018 + Math.random() * 0.03 });
  }
  function drawScreen(t, k) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (!rain) bakeRain();
    ctx.beginPath();
    for (let i = 0; i < rain.length; i++) {
      const d = rain[i], f = (t * d.sp + d.ph) % 1, y = (f * 1.15 - 0.1) * H, x = ((d.x + f * 0.07) % 1) * W, len = d.len * H;
      ctx.moveTo(x, y); ctx.lineTo(x - len * 0.16, y - len);
    }
    ctx.lineWidth = Math.max(1, view.dpr); ctx.strokeStyle = 'rgba(160,195,255,' + (0.085 * k) + ')'; ctx.stroke();
    if (!vignette) bakeVignette();
    ctx.drawImage(vignette, 0, 0, W, H);
  }
  R.setBox = function (sx0, sy0, sx1, sy1) { box = sx0 === null || sx0 === undefined ? null : [sx0, sy0, sx1, sy1]; };
  function drawBox() {
    if (!box) return;
    const d = view.dpr, x = Math.min(box[0], box[2]) * d, y = Math.min(box[1], box[3]) * d, w = Math.abs(box[2] - box[0]) * d, h = Math.abs(box[3] - box[1]) * d;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = 'rgba(120,255,190,0.07)'; ctx.fillRect(x, y, w, h);
    ctx.lineWidth = d; ctx.strokeStyle = 'rgba(4,5,10,0.6)'; ctx.strokeRect(x + 0.5 + d, y + 0.5 + d, w - 2 * d, h - 2 * d);
    ctx.strokeStyle = OWN_SEL; ctx.strokeRect(x + 0.5, y + 0.5, w, h);
  }
  let fpsMs = 0;
  function drawFps(ms) {
    fpsMs += (ms - fpsMs) * 0.05;
    const d = view.dpr, A = NT.Art.stats, FX = NT.FX;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    ctx.font = '12px ui-monospace, monospace'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    const s = NT.Game.fps + ' fps  ' + fpsMs.toFixed(1) + ' ms  ' + (ground.length + air.length) + ' ents  ' + (FX && FX.count ? FX.count() : 0) + ' fx  ' + (A.pixels / 1e6).toFixed(1) + ' Mpx';
    ctx.fillStyle = 'rgba(4,5,10,0.7)'; ctx.fillRect(6, 6, ctx.measureText(s).width + 10, 18);
    ctx.fillStyle = '#9dffcf'; ctx.fillText(s, 11, 9);
  }

  R.shake = function (amount) { shakeAmt = Math.min(14, Math.max(shakeAmt, amount || 0)); };

  // --------------------------------------------------------------------------
  // The frame
  // --------------------------------------------------------------------------
  function camera(dt) {
    const G = NT.Game, c = G.cam, dpr = G.view.dpr || 1;
    S = c.zoom * dpr;
    let sx = 0, sy = 0;
    if (shakeAmt > 0.05) {
      sx = (Math.random() * 2 - 1) * shakeAmt * dpr; sy = (Math.random() * 2 - 1) * shakeAmt * dpr;
      shakeAmt *= Math.exp(-dt * 9);
    } else shakeAmt = 0;
    OX = Math.round(W / 2 - c.x * S + sx); OY = Math.round(H / 2 - c.y * S + sy);
    view.zoom = c.zoom; view.dpr = dpr; view.t = G.now;
    view.x0 = -OX / S; view.y0 = -OY / S; view.x1 = (W - OX) / S; view.y1 = (H - OY) / S;
  }

  R.frame = function (dt) {
    if (!ctx) return;
    const G = NT.Game, world = G.world, FX = NT.FX, T = terrain(), t0 = performance.now();
    if (cv.width !== W || cv.height !== H) R.resize();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = VOID; ctx.fillRect(0, 0, W, H);
    view.dpr = G.view.dpr || 1; view.t = G.now;
    if (!world) { drawScreen(G.now, 1.6); return; }

    camera(dt);
    simNow = (world.tick + G.alpha) * NT.DT;
    fogTeam = G.me >= 0 && world.fogEnabled ? world.teams[G.team()] || null : null;
    if (!icons) bakeIcons();
    if (!T && fb.map !== world.map) fallbackBuild(world.map);
    if (FX && FX.frame) FX.frame(dt, simNow);
    prepare(world);
    lastTick = world.tick;
    const uk = Math.max(1, 0.85 / view.zoom);

    // 1 — ground
    worldT();
    ctx.imageSmoothingEnabled = true;
    if (T && T.drawGround) T.drawGround(ctx, view); else fallbackGround(world.map);
    if (T && T.shadowsFor) { worldT(); T.shadowsFor(ctx, view); }
    worldT(); drawTurf(world);
    if (T && T.drawResources) T.drawResources(ctx, view, world.map); else fallbackResources(world.map);
    worldT(); drawVoid(world);
    if (FX && FX.drawDecals) FX.drawDecals(ctx, view);

    // 2 — shadows, low props, rings
    drawShadows(sorted);
    worldT();
    if (T && T.drawPropsLow) { T.drawPropsLow(ctx, view); worldT(); }
    drawRings(world);

    // 3 — bodies and towers, north to south
    drawSorted();
    drawDying();

    // 4 — shots and particles
    worldT();
    if (FX && FX.burning) {
      for (let i = 0; i < ground.length; i++) {
        const r = ground[i];
        if (r.e.kind === 'building') { if (r.st.hp < 0.5) FX.burning(r.rx, r.ry, r.b, r.st.hp, r.id); }
        else if (r.bits & 4) FX.smolder(r.rx, r.ry);
      }
    }
    if (FX && FX.drawWorld) FX.drawWorld(ctx, view, world);

    // 5 — the air layer
    if (air.length) { drawShadows(air); for (let i = 0; i < air.length; i++) drawBody(air[i]); }
    worldT();
    if (T && T.drawPropsHigh) { T.drawPropsHigh(ctx, view); worldT(); }

    // 6 — additive light
    ctx.globalCompositeOperation = 'lighter';
    if (T && T.drawLights) { T.drawLights(ctx, view); worldT(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'lighter'; }
    drawLights(ground); drawLights(air);
    worldT();
    if (FX && FX.drawGlow) FX.drawGlow(ctx, view, world);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;

    // 7 — fog of war
    worldT();
    if (fogTeam) { updateFog(world, fogTeam, dt); drawFog(world); }

    // 8 — overlays
    ctx.lineCap = 'butt'; ctx.lineJoin = 'miter';
    drawBars(world, ground, uk); drawBars(world, air, uk);
    if (FX && FX.drawOverlay) { FX.drawOverlay(ctx, view, uk); worldT(); }
    drawPings(uk);
    drawPlacement(world, uk);

    // 9 — screen space
    drawBox();
    drawScreen(G.now, 1);
    if (G.params && G.params.has('fps')) drawFps(performance.now() - t0);
    R.ms = performance.now() - t0;
  };

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------
  R.visibleAt = function (wx, wy) {
    const G = NT.Game, w = G.world;
    if (!w) return false;
    if (G.me < 0 || !w.fogEnabled) return true;
    const t = w.teams[G.team()], cx = Math.floor(wx / TILE), cy = Math.floor(wy / TILE);
    return !!t && cx >= 0 && cy >= 0 && cx < w.w && cy < w.h && t.vis[cy * w.w + cx] > 0;
  };
  // While no frame has been drawn for a few ticks (fast-forward at boot) everything counts as on screen: the
  // camera may still be re-aimed, and whatever is alive at the first frame should be there.
  R.onScreen = function (wx, wy, margin) {
    const w = NT.Game.world;
    if (!w || w.tick - lastTick > 3) return true;
    const m = margin === undefined ? 96 : margin;
    return wx > view.x0 - m && wx < view.x1 + m && wy > view.y0 - m && wy < view.y1 + m;
  };

  function hitUnit(r, wx, wy, minR) {
    const rad = Math.max(r.b.w / 2 + 1, minR), dx = wx - r.rx, dy = wy - r.ry, d2 = dx * dx + dy * dy;
    return d2 <= rad * rad ? d2 : -1;
  }
  function hitBuilding(r, wx, wy) {
    const b = r.b;
    return wx >= r.rx - b.w / 2 && wx <= r.rx + b.w / 2 && wy >= r.ry - b.h / 2 - b.up && wy <= r.ry + b.h / 2;
  }
  // Topmost first = reverse draw order: flyers, then the y-sorted pass from south to north. Among bodies
  // stacked under the cursor the nearest centre wins, so crowded infantry stays clickable.
  R.pick = function (sx, sy) {
    const G = NT.Game;
    if (!G.world) return null;
    const p = G.toWorld(sx, sy), wx = p[0], wy = p[1], minR = 9 / G.cam.zoom;
    let best = null, bd = Infinity;
    for (let i = air.length - 1; i >= 0; i--) {
      const r = air[i], d = r.e.alive ? hitUnit(r, wx, wy, minR) : -1;
      if (d >= 0 && d < bd) { bd = d; best = r; }
    }
    if (best) return best.e;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const r = sorted[i];
      if (r.draw || r.mem || !r.e || !r.e.alive) continue;
      if (r.e.kind === 'building') { if (!best && hitBuilding(r, wx, wy)) return r.e; continue; }
      const d = hitUnit(r, wx, wy, minR);
      if (d >= 0 && d < bd) { bd = d; best = r; }
    }
    return best ? best.e : null;
  };

  // --------------------------------------------------------------------------
  // Minimap
  // --------------------------------------------------------------------------
  function fit(w, h) {
    const wd = NT.Game.world, k = Math.min(w / wd.w, h / wd.h);
    mm.k = k; mm.ox = (w - wd.w * k) / 2; mm.oy = (h - wd.h * k) / 2;
    return mm;
  }
  R.minimapToWorld = function (mx, my, w, h) {
    if (!NT.Game.world) return [0, 0];
    const f = fit(w, h);
    return [(mx - f.ox) / f.k * TILE, (my - f.oy) / f.k * TILE];
  };
  R.worldToMinimap = function (wx, wy, w, h) {
    if (!NT.Game.world) return [0, 0];
    const f = fit(w, h);
    return [f.ox + wx / TILE * f.k, f.oy + wy / TILE * f.k];
  };
  function miniBase(map) {
    const T = terrain();
    if (T && T.minimap) return T.minimap(map);
    if (fb.mini && fb.mini._map === map) return fb.mini;
    if (fb.map !== map) fallbackBuild(map);
    const c = fb.mini = mk(map.w, map.h), x = c.getContext('2d');
    x.drawImage(fb.ground, 0, 0);
    x.fillStyle = '#2b3242';
    for (let i = 0; i < map.blocks.length; i++) { const b = map.blocks[i]; x.fillRect(b.x, b.y, b.w, b.h); }
    c._map = map;
    return c;
  }
  function miniRes(map) {
    if (!mm.res || mm.res.width !== map.w || mm.res.height !== map.h) {
      mm.res = mk(map.w, map.h); mm.rx = mm.res.getContext('2d'); mm.img = mm.rx.createImageData(map.w, map.h); mm.at = -1e9;
    }
    if (NT.Game.now - mm.at < 1) return mm.res;
    mm.at = NT.Game.now;
    const d = mm.img.data, res = map.res;
    for (let i = 0; i < res.length; i++) {
      const v = res[i];
      d[i * 4] = 150; d[i * 4 + 1] = 246; d[i * 4 + 2] = 232; d[i * 4 + 3] = v ? 150 + Math.min(105, v / 5) : 0;
    }
    mm.rx.putImageData(mm.img, 0, 0);
    return mm.res;
  }
  R.drawMinimap = function (c, w, h) {
    const G = NT.Game, world = G.world;
    c.save();
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
    c.fillStyle = VOID; c.fillRect(0, 0, w, h);
    if (!world) { c.restore(); return; }
    const f = fit(w, h), k = f.k, mw = world.w * k, mh = world.h * k, myTeam = G.team();
    const team = G.me >= 0 && world.fogEnabled ? world.teams[myTeam] || null : null;
    c.beginPath(); c.rect(f.ox, f.oy, mw, mh); c.clip();
    c.translate(f.ox, f.oy);
    c.imageSmoothingEnabled = k < 1.5;
    c.drawImage(miniBase(world.map), 0, 0, mw, mh);
    c.imageSmoothingEnabled = true;
    if (!turf.cv || G.now - (turf.mmAt || 0) > 1) { turf.mmAt = G.now; if (!fogTeam) fogTeam = team; buildTurf(world); }
    if (turf.any) { c.globalAlpha = 0.55; c.drawImage(turf.cv, 0, 0, mw, mh); c.globalAlpha = 1; }
    c.imageSmoothingEnabled = false;
    c.drawImage(miniRes(world.map), 0, 0, mw, mh);
    // remembered buildings, then live entities (buildings first so units stay on top)
    if (team) memory.forEach(function (m) {
      if (m.seenF === frameNo) return;
      c.fillStyle = m.st.team; c.globalAlpha = 0.6;
      c.fillRect(m.cx * k, m.cy * k, m.w * k, m.h * k);
    });
    c.globalAlpha = 1;
    const ents = world.ents, u = Math.max(2, k * 1.5);
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < ents.length; i++) {
      const e = ents[i], isB = e.kind === 'building';
      if (isB !== (pass === 0) || !e.alive || e.hidden) continue;
      if (team && NT.teamOf(world, e.owner) !== myTeam && !NT.Fog.canSee(world, myTeam, e)) continue;
      c.fillStyle = colorOf(world, e.owner);
      if (isB) c.fillRect(e.cx * k, e.cy * k, Math.max(2, e.w * k), Math.max(2, e.h * k));
      else {
        const x = e.x / TILE * k - u / 2, y = e.y / TILE * k - u / 2;
        if (e.owner === G.me) { c.fillStyle = 'rgba(4,5,10,0.55)'; c.fillRect(x - 0.5, y - 0.5, u + 1, u + 1); c.fillStyle = colorOf(world, e.owner); }
        c.fillRect(x, y, u, u);
      }
    }
    if (team) {
      if (!fog.cv || fog.w !== world.w + 2) updateFog(world, team, 1);
      c.imageSmoothingEnabled = true;
      c.drawImage(fog.cv, 1, 1, world.w, world.h, 0, 0, mw, mh);
    }
    // pings
    for (let i = 0; i < pings.length; i++) {
      const p = pings[i], age = G.now - p.t0, fr = (age % 0.8) / 0.8;
      if (age > 2.4) continue;
      c.globalAlpha = 1 - fr; c.strokeStyle = p.col; c.lineWidth = 1.5;
      c.beginPath(); c.arc(p.x / TILE * k, p.y / TILE * k, 2 + 9 * fr, 0, TAU); c.stroke();
    }
    c.globalAlpha = 1;
    // camera box
    const cam = G.cam, hw = G.view.w / 2 / cam.zoom / TILE * k, hh = G.view.h / 2 / cam.zoom / TILE * k, cx = cam.x / TILE * k, cy = cam.y / TILE * k;
    c.lineWidth = 1; c.strokeStyle = 'rgba(4,5,10,0.7)'; c.strokeRect(Math.round(cx - hw) + 1.5, Math.round(cy - hh) + 1.5, Math.round(2 * hw), Math.round(2 * hh));
    c.strokeStyle = '#f2f6ff'; c.strokeRect(Math.round(cx - hw) + 0.5, Math.round(cy - hh) + 0.5, Math.round(2 * hw), Math.round(2 * hh));
    c.restore();
  };
})();
