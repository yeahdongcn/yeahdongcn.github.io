'use strict';
// ============ HUD + menus (immediate mode, canvas-drawn) ============

function press(code) { if (G.pressed.has(code)) { G.pressed.delete(code); return true; } return false; }
function navUp()   { return press('KeyW') || press('ArrowUp'); }
function navDown() { return press('KeyS') || press('ArrowDown'); }
function navLeft() { return press('KeyA') || press('ArrowLeft'); }
function navRight(){ return press('KeyD') || press('ArrowRight'); }
function uiAct()   { return press('Enter') || press('KeyE') || (G.mouse.click ? (G.mouse.click = false, true) : false); }
function uiHot(x, y, w, h) {
  const m = G.mouse;
  const sx = TOUCH.on ? 4 : 0, sy = TOUCH.on ? 3 : 0; // touch slop: fingers aren't cursors
  return m.sx >= x - sx && m.sx < x + w + sx && m.sy >= y - sy && m.sy < y + h + sy;
}
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…'.replace('…', '.') : s; }

function uiPanel(c, x, y, w, h, title, col) {
  col = col || '#05d9e8';
  c.fillStyle = 'rgba(6,8,14,0.94)'; c.fillRect(x, y, w, h);
  c.fillStyle = col; c.fillRect(x, y, w, 1); c.fillRect(x, y + h - 1, w, 1);
  c.fillRect(x, y, 1, h); c.fillRect(x + w - 1, y, 1, h);
  c.fillRect(x, y, 14, 3); c.fillRect(x + w - 14, y, 14, 3);
  if (title) {
    c.fillStyle = 'rgba(255,255,255,0.05)'; c.fillRect(x + 1, y + 1, w - 2, 16);
    drawText(c, title, x + 8, y + 6, col, 1);
    drawTextR(c, '€$' + fmt(G.eddies), x + w - 8, y + 6, '#f9f002', 1);
  }
}

function uiBar(c, x, y, w, h, frac, col, bg) {
  c.fillStyle = bg || 'rgba(255,255,255,0.08)'; c.fillRect(x, y, w, h);
  c.fillStyle = col; c.fillRect(x, y, Math.round(w * Math.max(0, Math.min(1, frac))), h);
}

// generic list nav; returns sel
function navList(n, viewRows) {
  const s = G.uiS;
  if (navUp()) { s.sel = (s.sel - 1 + n) % n; SFX.ui(); }
  if (navDown()) { s.sel = (s.sel + 1) % n; SFX.ui(); }
  if (G.uiWheel) { s.sel = Math.max(0, Math.min(n - 1, s.sel + G.uiWheel)); G.uiWheel = 0; }
  s.sel = Math.max(0, Math.min(n - 1, s.sel));
  if (viewRows) {
    if (s.sel < s.scroll) s.scroll = s.sel;
    if (s.sel >= s.scroll + viewRows) s.scroll = s.sel - viewRows + 1;
  }
  return s.sel;
}

// =================== TITLE (Diablo-style landing) ===================
function drawTitle(c) {
  // atmospheric gradient sky
  const bg = c.createLinearGradient(0, 0, 0, VIEW_H);
  bg.addColorStop(0, '#04050b'); bg.addColorStop(0.55, '#070912'); bg.addColorStop(1, '#0b1018');
  c.fillStyle = bg; c.fillRect(0, 0, VIEW_W, VIEW_H);
  // distant neon haze glow behind the skyline
  c.globalCompositeOperation = 'lighter';
  c.globalAlpha = 0.10; c.drawImage(SPR.glowS('#ff2a6d', 120), VIEW_W / 2 - 200, VIEW_H - 200, 240, 240);
  c.globalAlpha = 0.08; c.drawImage(SPR.glowS('#05d9e8', 120), VIEW_W / 2 - 40, VIEW_H - 190, 240, 220);
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  // skyline silhouette (built once)
  if (!G._titleSky) {
    const r = mulberry32(7777), b = []; let x = -12;
    while (x < VIEW_W + 12) {
      const w = 16 + (r() * 30 | 0), h = 46 + (r() * 96 | 0), wins = [];
      for (let wy = VIEW_H - h + 6; wy < VIEW_H - 8; wy += 7) for (let wx = x + 3; wx < x + w - 3; wx += 6) if (r() < 0.28) wins.push([wx, wy, r() < 0.5 ? '#ffd27a' : '#7ad7ff']);
      b.push({ x, w, h, wins, col: ['#0a0c14', '#0c0e18', '#0e101a'][r() * 3 | 0] });
      x += w + (r() * 5 | 0);
    }
    G._titleSky = b;
  }
  for (const b of G._titleSky) {
    c.fillStyle = b.col; c.fillRect(b.x, VIEW_H - b.h, b.w, b.h);
    c.fillStyle = '#171b28'; c.fillRect(b.x, VIEW_H - b.h, b.w, 1);
    for (const w of b.wins) { c.globalAlpha = 0.45 + 0.3 * Math.sin(G.rt * 2 + w[0]); c.fillStyle = w[2]; c.fillRect(w[0], w[1], 2, 2); }
    c.globalAlpha = 1;
  }
  const hz = c.createLinearGradient(0, VIEW_H - 140, 0, VIEW_H);
  hz.addColorStop(0, 'rgba(7,9,16,0)'); hz.addColorStop(1, 'rgba(7,10,18,0.5)');
  c.fillStyle = hz; c.fillRect(0, VIEW_H - 140, VIEW_W, 140);
  // drifting neon embers (additive)
  if (!G._embers) { G._embers = []; for (let i = 0; i < 24; i++) G._embers.push({ x: Math.random() * VIEW_W, y: Math.random() * VIEW_H, vy: -(5 + Math.random() * 13), vx: (Math.random() - 0.5) * 5, col: NEON[Math.random() * NEON.length | 0] }); }
  c.globalCompositeOperation = 'lighter';
  for (const e of G._embers) { e.y += e.vy * 0.016; e.x += e.vx * 0.016; if (e.y < -4) { e.y = VIEW_H + 4; e.x = Math.random() * VIEW_W; } c.globalAlpha = 0.3 + 0.3 * Math.sin(G.rt * 3 + e.x); c.drawImage(SPR.glowS(e.col, 4), e.x - 4, e.y - 4); }
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  drawRain(c);

  // ---- logo with glow ----
  c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.5;
  c.drawImage(SPR.glowS('#ff2a6d', 90), VIEW_W / 2 - 90, 18, 180, 90);
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  const gx = Math.random() < 0.06 ? (Math.random() * 5 - 2.5) | 0 : 0;
  drawTextC(c, 'NIGHT CITY', VIEW_W / 2 - 3 + gx, 44, '#ff2a6d', 5);
  drawTextC(c, 'NIGHT CITY', VIEW_W / 2 + 3 + gx, 44, '#05d9e8', 5);
  drawTextC(c, 'NIGHT CITY', VIEW_W / 2 + gx, 44, '#f4f8ff', 5);
  // ornamental divider
  c.fillStyle = '#3a2a14'; c.fillRect(VIEW_W / 2 - 150, 86, 300, 1);
  c.fillStyle = '#f9c84a'; c.globalAlpha = 0.7;
  for (const dx of [-150, 150]) { c.save(); c.translate(VIEW_W / 2 + dx, 86); c.rotate(0.785); c.fillRect(-2, -2, 4, 4); c.restore(); }
  c.globalAlpha = 1;
  drawTextC(c, 'I S O M E T R I C   E D I T I O N', VIEW_W / 2, 92, '#f9c84a', 1);
  drawTextC(c, 'COLLECT IRON · BUY CHROME · OWN THE STREETS', VIEW_W / 2, 106, '#6a7286', 1);

  if (G.titleMode === 'gender') { titleGender(c); drawCursorSpr(c); return; }

  // ---- Diablo-style menu plates ----
  const items = [];
  if (hasSave()) items.push('CONTINUE');
  items.push('NEW GAME');
  items.push('SOUND: ' + (SFX.muted ? 'OFF' : 'ON'));
  const sel = navList(items.length), top = 150 + (3 - items.length) * 8;
  for (let i = 0; i < items.length; i++) {
    const y = top + i * 30, on = sel === i, hot = uiHot(VIEW_W / 2 - 150, y - 6, 300, 22);
    if (hot && G.mouse.moved) G.uiS.sel = i;
    if (on) {
      const g = c.createLinearGradient(VIEW_W / 2 - 150, 0, VIEW_W / 2 + 150, 0);
      g.addColorStop(0, 'rgba(249,159,28,0)'); g.addColorStop(0.5, 'rgba(249,159,28,0.20)'); g.addColorStop(1, 'rgba(249,159,28,0)');
      c.fillStyle = g; c.fillRect(VIEW_W / 2 - 150, y - 4, 300, 19);
      c.strokeStyle = 'rgba(249,200,74,0.4)'; c.beginPath(); c.moveTo(VIEW_W / 2 - 120, y + 13); c.lineTo(VIEW_W / 2 + 120, y + 13); c.stroke();
      c.fillStyle = '#f9c84a';
      for (const dx of [-128, 124]) { c.save(); c.translate(VIEW_W / 2 + dx, y + 5); c.rotate(0.785); c.fillRect(-2.5, -2.5, 5, 5); c.restore(); }
      drawTextC(c, items[i], VIEW_W / 2, y, '#f9e6b4', 2);
    } else {
      drawTextC(c, items[i], VIEW_W / 2, y + 2, '#5a6276', 1);
    }
    if (hot && G.mouse.click) { G.mouse.click = false; titleSelect(i); return; }
  }
  if (press('Enter') || press('Space')) titleSelect(G.uiS.sel);

  drawTextC(c, 'WASD MOVE · MOUSE FIRE · SPACE DASH · E INTERACT · V VEHICLE · TAB GEAR', VIEW_W / 2, VIEW_H - 22, '#46506a', 1);
  drawTextC(c, 'UNOFFICIAL FAN TRIBUTE · NOT AFFILIATED WITH CD PROJEKT RED', VIEW_W / 2, VIEW_H - 11, '#2e3548', 1);
  drawCursorSpr(c);
}

function titleSelect(i) {
  SFX.init(); SFX.buy();
  const hasC = hasSave();
  if (hasC && i === 0) { startGame(true); return; }
  if ((hasC && i === 1) || (!hasC && i === 0)) { G.titleMode = 'gender'; G.uiS.sel = 0; return; }
  SFX.toggleMute();
}

function titleGender(c) {
  drawTextC(c, 'CHOOSE YOUR V', VIEW_W / 2, 128, '#f9c84a', 2);
  if (navLeft() || navRight()) { G.uiS.sel = G.uiS.sel ? 0 : 1; SFX.ui(); }
  G.uiS.sel = G.uiS.sel ? 1 : 0;
  const frame = (G.rt * 3 | 0) % 2, fy = 150, fw = 92, fh = 116;
  for (let i = 0; i < 2; i++) {
    const cx = VIEW_W / 2 + (i ? 88 : -88), sel = G.uiS.sel === i;
    const hot = uiHot(cx - fw / 2, fy, fw, fh);
    if (hot && G.mouse.moved) G.uiS.sel = i;
    if (sel) { c.globalCompositeOperation = 'lighter'; c.globalAlpha = 0.35; c.drawImage(SPR.glowS('#f9c84a', 72), cx - 72, fy - 8, 144, 144); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'; }
    c.fillStyle = sel ? 'rgba(249,159,28,0.10)' : 'rgba(255,255,255,0.03)'; c.fillRect(cx - fw / 2, fy, fw, fh);
    c.strokeStyle = sel ? '#f9c84a' : 'rgba(255,255,255,0.14)'; c.lineWidth = sel ? 1.5 : 1; c.strokeRect(cx - fw / 2 + 0.5, fy + 0.5, fw - 1, fh - 1); c.lineWidth = 1;
    if (sel) { c.fillStyle = '#f9c84a'; for (const ox of [-fw / 2, fw / 2 - 3]) for (const oy of [0, fh - 3]) c.fillRect(cx + ox, fy + oy, 3, 3); }
    c.imageSmoothingEnabled = false;
    c.drawImage(SPR.player[i ? 'f' : 'm'].down[sel ? frame : 0], cx - 22, fy + 14, 44, 77);
    drawTextC(c, i ? 'FEMALE V' : 'MALE V', cx, fy + fh - 13, sel ? '#f9e6b4' : '#6a7286', 1);
    if (hot && G.mouse.click) { G.mouse.click = false; if (sel) { startGame(false, i ? 'f' : 'm'); return; } G.uiS.sel = i; }
  }
  drawTextC(c, '[A / D] SELECT      [ENTER] JACK IN      [ESC] BACK', VIEW_W / 2, 290, '#5a6276', 1);
  if (press('Enter') || press('Space')) { startGame(false, G.uiS.sel ? 'f' : 'm'); return; }
  if (press('Escape')) { G.titleMode = 'menu'; G.uiS.sel = 0; }
}

// =================== HUD ===================
function diabloOrb(c, cx, cy, r, frac, col, val) {
  frac = Math.max(0, Math.min(1, frac));
  c.save(); c.beginPath(); c.arc(cx, cy, r, 0, 7); c.clip();
  c.fillStyle = '#0c0c12'; c.fillRect(cx - r, cy - r, r * 2, r * 2);
  const fh = r * 2 * frac; c.fillStyle = col; c.fillRect(cx - r, cy + r - fh, r * 2, fh);
  c.fillStyle = shade(col, 40); c.fillRect(cx - r, cy + r - fh, r * 2, 2);
  c.fillStyle = 'rgba(255,255,255,0.10)'; c.beginPath(); c.ellipse(cx - r * 0.35, cy - r * 0.35, r * 0.4, r * 0.25, -0.6, 0, 7); c.fill();
  c.restore();
  c.strokeStyle = shade(col, -30); c.lineWidth = 2; c.beginPath(); c.arc(cx, cy, r, 0, 7); c.stroke(); c.lineWidth = 1;
  drawTextC(c, '' + val, cx, cy - 3, '#fff', 1);
}

function drawHUD(c) {
  const p = G.p;
  // ---- Diablo-style health orb (bottom-left) ----
  diabloOrb(c, 30, VIEW_H - 28, 24, p.hp / p.maxhp, p.hp < p.maxhp * 0.35 ? '#ff2030' : '#c41028', Math.ceil(p.hp));
  // XP ribbon (very bottom) + level + eddies
  c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(0, VIEW_H - 3, VIEW_W, 3);
  c.fillStyle = '#05d9e8'; c.fillRect(0, VIEW_H - 3, VIEW_W * (G.xp / xpFor(G.lvl)), 3);
  drawText(c, 'LV' + G.lvl, 58, VIEW_H - 50, '#05d9e8', 1);
  drawText(c, '€$' + fmt(G.eddies), 8, 8, '#f9f002', 1);
  if (p.armor > 0) drawText(c, 'ARMOR ' + p.armor, 8, 18, '#8a93a6', 1);
  if (G.pHidden && !G.driving) drawText(c, 'CONCEALED', 8, 28, '#00ff9f', 1);
  // ---- Diablo hotbar: cyberware abilities + maxdoc as skill buttons ----
  let sx = 60, sy = VIEW_H - 22;
  const skillBtn = (label, frac, ready, col) => {
    c.fillStyle = 'rgba(8,10,16,0.85)'; c.fillRect(sx, sy, 18, 18);
    c.fillStyle = col; c.globalAlpha = ready ? 0.5 : 0.22; c.fillRect(sx + 1, sy + 1, 16, 16); c.globalAlpha = 1;
    if (frac < 1) { c.fillStyle = 'rgba(0,0,0,0.62)'; c.fillRect(sx + 1, sy + 1, 16, 16 * (1 - frac)); }
    c.strokeStyle = ready ? col : '#2a3340'; c.strokeRect(sx + 0.5, sy + 0.5, 17, 17);
    drawTextC(c, label, sx + 9, sy + 6, ready ? '#06060a' : '#8a93a6', 1);
    sx += 22;
  };
  if (G.os) { const def = CYB[G.os].tiers[G.cyber[G.os] - 1]; skillBtn('Q', p.osT > 0 ? 1 : 1 - Math.max(0, p.osCd) / def.cd, p.osT > 0 || p.osCd <= 0, G.os === 'berserk' ? '#ff2a3c' : '#00ff9f'); }
  if (G.cyber.camo) skillBtn('F', p.camoT > 0 ? 1 : 1 - Math.max(0, p.camoCd) / CYB.camo.tiers[0].cd, p.camoCd <= 0, '#05d9e8');
  skillBtn('C', p.useT > 0 ? 1 - p.useT : 1, G.maxdocs > 0, '#2ecc71');
  if (G.maxdocs > 0) drawText(c, '×' + G.maxdocs, sx - 21, sy + 12, '#2ecc71', 1);
  if (p.joyT > 0) drawText(c, '♥' + Math.ceil(p.joyT), sx + 2, sy + 6, '#ff2a6d', 1);

  drawMinimap(c);

  // weapon card
  const w = curWpn();
  const wx = VIEW_W - 148, wy = VIEW_H - 46;
  c.fillStyle = 'rgba(6,8,14,0.7)'; c.fillRect(wx, wy, 140, 38);
  c.fillStyle = RAR_COL[w ? w.rar : 0]; c.fillRect(wx, wy, 140, 1);
  if (w) {
    c.drawImage(SPR.wicon(w.cls, KIND_COL[w.kind]), wx + 4, wy + 5);
    drawText(c, trunc(w.name, 22), wx + 4, wy + 17, RAR_COL[w.rar], 1);
    if (MELEE_CLS[w.cls]) drawText(c, '—', wx + 32, wy + 26, '#cfd6e4', 1);
    else {
      const st = G.weapons[w.id];
      drawText(c, (p.reloadT > 0 ? '...' : st.mag) + '/' + w.mag, wx + 32, wy + 25, p.reloadT > 0 ? '#ff9f1c' : '#e8f6ff', 1);
      if (p.reloadT > 0) uiBar(c, wx + 32, wy + 33, 40, 2, 1 - p.reloadT / w.rel, '#ff9f1c');
    }
  } else drawText(c, 'UNARMED', wx + 4, wy + 17, '#5a6372', 1);
  for (let i = 0; i < 3; i++) {
    const id = G.loadout[i];
    if (TOUCH.on) { // thumb-sized, tappable slot boxes
      const bx = wx + 78 + i * 21, by = wy + 18;
      c.fillStyle = i === G.slot ? 'rgba(249,240,2,0.22)' : 'rgba(255,255,255,0.07)';
      c.fillRect(bx, by, 20, 18);
      c.strokeStyle = i === G.slot ? '#f9f002' : id ? RAR_COL[WPN[id].rar] : 'rgba(255,255,255,0.2)';
      c.strokeRect(bx + 0.5, by + 0.5, 19, 17);
      drawTextC(c, String(i + 1), bx + 10, by + 6, i === G.slot ? '#f9f002' : id ? '#cfd6e4' : '#5a6372', 1);
    } else {
      c.fillStyle = i === G.slot ? '#f9f002' : id ? RAR_COL[WPN[id].rar] : 'rgba(255,255,255,0.12)';
      c.fillRect(wx + 110 + i * 10, wy + 26, 7, 7);
      drawText(c, String(i + 1), wx + 112 + i * 10, wy + 27, '#06060a', 1);
    }
  }
  // car status
  if (G.driving && G.car) {
    const spd = Math.hypot(G.car.vx, G.car.vy);
    drawTextR(c, (spd * 0.55 | 0) + ' KM/H', VIEW_W - 10, wy - 20, '#05d9e8', 2);
    drawTextR(c, 'RADIO: ' + SFX.stationName(), VIEW_W - 10, wy - 30, '#ff2a6d', 1);
    uiBar(c, wx, wy - 8, 140, 3, G.car.hp / CARD[G.car.id].hp, '#00ff9f');
  }
  // interact prompt
  if (G.prompt) drawTextC(c, G.prompt, VIEW_W / 2, VIEW_H - 84, '#f9f002', 1);
  // psycho health bar
  const ps = G.enemies.find(e => e.psycho);
  if (ps && !ps.dead) {
    drawTextC(c, 'CYBERPSYCHO — ' + ps.name, VIEW_W / 2, 8, '#ff2a3c', 1);
    uiBar(c, VIEW_W / 2 - 90, 16, 180, 5, ps.hp / ps.maxhp, '#bd00ff', 'rgba(80,0,40,0.5)');
  }
  // objective lines under minimap
  if (G.bounty) {
    const d = Math.hypot(G.bounty.x - p.x, G.bounty.y - p.y) / 10 | 0;
    drawTextR(c, (G.bounty.psycho ? 'PSYCHO' : 'BOUNTY') + ': ' + G.bounty.left + ' LEFT · ' + d + 'M', VIEW_W - 8, 78, G.bounty.psycho ? '#bd00ff' : '#ff5a5a', 1);
  }
  if (G.airdrop) {
    const d = Math.hypot(G.airdrop.x - p.x, G.airdrop.y - p.y) / 10 | 0;
    drawTextR(c, 'AIRDROP: ' + (G.airdrop.state === 'falling' ? 'INBOUND' : Math.ceil(G.airdrop.t) + 'S') + ' · ' + d + 'M', VIEW_W - 8, G.bounty ? 88 : 78, '#ff6a00', 1);
  }
  drawTextR(c, WEATHERS[G.weather.kind].name, VIEW_W - 8, 78 + (G.bounty ? 10 : 0) + (G.airdrop ? 10 : 0), '#5a6372', 1);
  drawMsgs(c);
  drawBanner(c);
  // edge markers
  if (G.bounty) edgeArrow(c, G.bounty.x, G.bounty.y, G.bounty.psycho ? '#bd00ff' : '#ff2a3c');
  if (G.airdrop) edgeArrow(c, G.airdrop.x, G.airdrop.y, '#ff6a00');
  if (!G.skippyFound && distPx(p.x, p.y, WORLD.skippySpot.x, WORLD.skippySpot.y) < 700) edgeArrow(c, WORLD.skippySpot.x, WORLD.skippySpot.y, '#f9f002');
}

function drawMinimap(c) {
  const p = G.p, S = 64, mx = VIEW_W - S - 8, my = 8;
  const range = G.cyber.kiroshi >= 2 ? 64 : 44;
  let tx = p.x / TILE - range / 2, ty = p.y / TILE - range / 2;
  tx = Math.max(0, Math.min(WORLD.W - range, tx)); ty = Math.max(0, Math.min(WORLD.H - range, ty));
  c.fillStyle = 'rgba(6,8,14,0.8)'; c.fillRect(mx - 2, my - 2, S + 4, S + 4);
  c.drawImage(WORLD.mini, tx, ty, range, range, mx, my, S, S);
  c.strokeStyle = '#05d9e8'; c.strokeRect(mx - 1.5, my - 1.5, S + 3, S + 3);
  const dot = (wx, wy, col, txt) => {
    const ddx = wx / TILE - tx, ddy = wy / TILE - ty;
    if (ddx < 0 || ddy < 0 || ddx > range || ddy > range) return;
    if (txt) drawText(c, txt, mx + ddx * S / range - 2, my + ddy * S / range - 2, col, 1);
    else { c.fillStyle = col; c.fillRect(mx + ddx * S / range - 1, my + ddy * S / range - 1, 2, 2); }
  };
  dot(WORLD.shops.guns.x, WORLD.shops.guns.y, '#f9f002', 'G');
  dot(WORLD.shops.ripper.x, WORLD.shops.ripper.y, '#05d9e8', 'R');
  dot(WORLD.shops.cars.x, WORLD.shops.cars.y, '#00ff9f', 'A');
  dot(WORLD.shops.bar.x, WORLD.shops.bar.y, '#ff2a6d', 'B');
  for (const e of G.enemies) if (!e.dead && (e.bounty || e.psycho || G.cyber.kiroshi)) dot(e.x, e.y, e.psycho ? '#bd00ff' : '#ff2a3c');
  if (G.bounty && (G.frame / 20 | 0) % 2) dot(G.bounty.x, G.bounty.y, G.bounty.psycho ? '#bd00ff' : '#ff2a3c', '×');
  if (G.airdrop && (G.frame / 14 | 0) % 2) dot(G.airdrop.x, G.airdrop.y, '#ff6a00', '×');
  if (!G.skippyFound && distPx(p.x, p.y, WORLD.skippySpot.x, WORLD.skippySpot.y) < 500) dot(WORLD.skippySpot.x, WORLD.skippySpot.y, '#f9f002', '?');
  // player
  dot(p.x, p.y, '#e8f6ff');
}

function edgeArrow(c, wx, wy, col) {
  const sp = proj(wx, wy, 0), sx = sp.x, sy = sp.y;
  if (sx > 10 && sx < VIEW_W - 10 && sy > 10 && sy < VIEW_H - 10) return;
  const cxx = VIEW_W / 2, cyy = VIEW_H / 2, a = Math.atan2(sy - cyy, sx - cxx);
  const px = Math.max(14, Math.min(VIEW_W - 14, sx)), py = Math.max(28, Math.min(VIEW_H - 28, sy));
  c.save(); c.translate(px, py); c.rotate(a);
  c.fillStyle = col; c.beginPath(); c.moveTo(7, 0); c.lineTo(-4, -5); c.lineTo(-4, 5); c.closePath(); c.fill();
  c.restore();
}

function drawMsgs(c) {
  let y = VIEW_H - 62; // sit above the health orb + skill row, not over them
  for (let i = G.msgs.length - 1; i >= 0 && i >= G.msgs.length - 5; i--) {
    const m = G.msgs[i], a = Math.min(1, m.t);
    c.globalAlpha = a;
    drawText(c, m.text, 8, y, m.col, 1);
    c.globalAlpha = 1;
    y -= 10;
  }
}

function drawBanner(c) {
  const b = G.bannerO;
  if (!b) return;
  const a = Math.min(1, b.t * 2);
  c.globalAlpha = a;
  drawTextC(c, b.text, VIEW_W / 2, 120, b.col, 2);
  if (b.sub) drawTextC(c, b.sub, VIEW_W / 2, 140, '#cfd6e4', 1);
  c.globalAlpha = 1;
}

function drawCrosshair(c) {
  if (TOUCH.on && !TOUCH.aim.act) return; // on touch, crosshair only while aiming
  const m = G.mouse, p = G.p;
  const r = 3 + p.recoil * 10 + (curWpn() && !MELEE_CLS[curWpn().cls] ? curWpn().spread * 0.3 : 0);
  const col = G.lockTarget ? '#ff2a6d' : '#e8f6ff';
  c.strokeStyle = col; c.lineWidth = 1;
  c.beginPath(); c.arc(m.sx, m.sy, r, 0, Math.PI * 2); c.stroke();
  c.fillStyle = col; c.fillRect(m.sx - 0.5, m.sy - 0.5, 1, 1);
  if (G.lockTarget && !G.lockTarget.dead) {
    const ls = proj(G.lockTarget.x, G.lockTarget.y, 0), lx = ls.x, ly = ls.y - 14;
    c.strokeStyle = '#ff2a6d'; c.strokeRect(lx - 6, ly - 6, 12, 12);
    drawText(c, 'LOCK', lx - 7, ly - 14, '#ff2a6d', 1);
  }
}
function drawCursorSpr(c) { if (!TOUCH.on) c.drawImage(SPR.cursor, G.mouse.sx, G.mouse.sy); }

// =================== VIRTUAL TOUCH CONTROLS ===================
function drawTouchControls(c) {
  if (G.state === 'play' && !G.ui) {
    const stick = (s, dx, dy, label, show) => {
      if (!show) return;
      const bx = s.act ? s.bx : dx, by = s.act ? s.by : dy;
      c.globalAlpha = s.act ? 0.3 : 0.12;
      c.strokeStyle = '#8fd6e8'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(bx, by, 28, 0, Math.PI * 2); c.stroke();
      c.fillStyle = '#8fd6e8';
      c.beginPath(); c.arc(s.act ? s.kx : bx, s.act ? s.ky : by, 11, 0, Math.PI * 2); c.fill();
      c.globalAlpha = s.act ? 0.6 : 0.18;
      drawTextC(c, label, bx, by + 36, '#8fd6e8', 1);
      c.globalAlpha = 1; c.lineWidth = 1;
    };
    stick(TOUCH.mv, 70, 290, 'MOVE', true);
    stick(TOUCH.aim, 572, 272, 'AIM+FIRE', !G.driving);
    for (const b of touchButtons()) {
      const hot = TOUCH.held[b.k], pulse = b.k === 'use' && G.prompt;
      c.globalAlpha = hot ? 0.5 : pulse ? 0.3 + 0.15 * Math.sin(G.rt * 6) : 0.16;
      c.fillStyle = pulse ? '#f9f002' : '#8fd6e8';
      c.beginPath(); c.arc(b.x, b.y, b.r, 0, Math.PI * 2); c.fill();
      c.globalAlpha = hot ? 0.95 : 0.6;
      drawTextC(c, b.label, b.x, b.y - 2, pulse ? '#f9f002' : '#dfeaf2', 1);
      c.globalAlpha = 1;
    }
  }
  if (touchCloseVisible()) { // ✕ close — thumb-sized
    c.globalAlpha = 0.65;
    c.fillStyle = '#1a1c26'; c.beginPath(); c.arc(612, 24, 18, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#ff5a5a'; c.lineWidth = 1.5; c.beginPath(); c.arc(612, 24, 18, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 1;
    drawTextC(c, '×', 612, 19, '#ff5a5a', 3);
    c.globalAlpha = 1;
  }
  if (window.innerHeight > window.innerWidth) {
    drawTextC(c, 'ROTATE DEVICE — LANDSCAPE PLAYS BEST', VIEW_W / 2, 2, '#f9f002', 1);
  }
}

// =================== DEATH ===================
function drawDead(c) {
  c.fillStyle = 'rgba(40,0,8,0.55)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  drawTextC(c, 'FLATLINED', VIEW_W / 2, 130, '#ff2a3c', 4);
  drawTextC(c, 'TRAUMA TEAM EXTRACTION FEE: €$' + fmt(G.deathFee || 0), VIEW_W / 2, 170, '#cfd6e4', 1);
  drawTextC(c, 'REBOOTING IN ' + Math.ceil(G.deadT) + '...', VIEW_W / 2, 186, '#8a93a6', 1);
}

// =================== PAUSE ===================
function drawPause(c) {
  c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  uiPanel(c, 200, 60, 240, 226, 'PAUSED', '#f9f002');
  const items = ['RESUME', 'SAVE GAME', 'SOUND: ' + (SFX.muted ? 'OFF' : 'ON'), G.uiS.confirm ? 'CONFIRM WIPE? [ENTER]' : 'NEW GAME'];
  const sel = navList(items.length);
  for (let i = 0; i < items.length; i++) {
    const y = 90 + i * 20, hot = uiHot(210, y - 4, 220, 16);
    if (hot && G.mouse.moved) G.uiS.sel = i;
    drawText(c, (sel === i ? '> ' : '  ') + items[i], 216, y, sel === i ? (i === 3 && G.uiS.confirm ? '#ff2a3c' : '#f9f002') : '#8a93a6', 1);
  }
  if (uiAct()) {
    if (sel === 0) { G.ui = null; }
    else if (sel === 1) { saveGame(); msg('GAME SAVED', '#2ecc71'); SFX.buy(); }
    else if (sel === 2) { SFX.toggleMute(); }
    else if (sel === 3) {
      if (!G.uiS.confirm) G.uiS.confirm = true;
      else { wipeSave(); G.ui = null; G.state = 'title'; G.titleMode = 'gender'; G.uiS = { sel: 0, scroll: 0, tab: 0, confirm: false }; }
    }
  }
  const ctrl = ['WASD MOVE · MOUSE AIM/FIRE', 'SPACE DASH · R RELOAD', 'Q OS ABILITY · F CAMO · C MAXDOC', 'E INTERACT · V VEHICLE · N RADIO', '1/2/3 + WHEEL WEAPON SLOTS', 'TAB INVENTORY · M MUTE · ESC PAUSE'];
  for (let i = 0; i < ctrl.length; i++) drawText(c, ctrl[i], 216, 180 + i * 11, '#5a6372', 1);
  drawTextC(c, 'PROGRESS AUTOSAVES EVERY 12S', VIEW_W / 2, 272, '#3a414e', 1);
  drawCursorSpr(c);
}

// =================== SHOPS ===================
function shopList(c, rows, drawRow, footer, title, col) {
  c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  uiPanel(c, 56, 22, 528, 316, title, col);
  const view = 12, sel = navList(rows.length, view), s = G.uiS;
  for (let i = s.scroll; i < Math.min(rows.length, s.scroll + view); i++) {
    const y = 46 + (i - s.scroll) * 22;
    const hot = uiHot(64, y - 2, 280, 21);
    if (hot && G.mouse.moved) s.sel = i;
    if (sel === i) { c.fillStyle = 'rgba(249,240,2,0.08)'; c.fillRect(62, y - 3, 284, 21); c.fillStyle = '#f9f002'; c.fillRect(62, y - 3, 2, 21); }
    drawRow(c, rows[i], 68, y, sel === i);
    if (hot && G.mouse.click) { G.mouse.click = false; if (s.sel === i) return { act: true, sel }; }
  }
  if (rows.length > view) {
    const sb = 46 + (s.scroll / rows.length) * 264;
    c.fillStyle = 'rgba(255,255,255,0.2)'; c.fillRect(348, sb, 2, Math.max(12, 264 * view / rows.length));
  }
  if (footer) drawTextC(c, footer, VIEW_W / 2, 324, '#5a6372', 1);
  return { act: press('Enter') || press('KeyE'), sel };
}

function statRow(c, x, y, label, frac, col, txt) {
  drawText(c, label, x, y, '#8a93a6', 1);
  uiBar(c, x + 36, y + 1, 110, 4, frac, col);
  if (txt != null) drawTextR(c, String(txt), x + 180, y, '#cfd6e4', 1);
}

function drawShopGuns(c) {
  const stock = WEAPONS.filter(w => !w.iconic && !w.granted && !w.hidden);
  const r = shopList(c, stock, (cc, w, x, y, on) => {
    cc.drawImage(SPR.wicon(w.cls, KIND_COL[w.kind]), x, y + 1);
    drawText(cc, trunc(w.name, 26), x + 28, y + 3, G.weapons[w.id] ? '#5a6372' : RAR_COL[w.rar], 1);
    const right = G.weapons[w.id] ? 'OWNED' : G.lvl < w.lvl ? 'LV' + w.lvl : '€$' + fmt(w.price);
    drawTextR(cc, right, x + 272, y + 3, G.weapons[w.id] ? '#5a6372' : G.lvl < w.lvl ? '#ff5a5a' : G.eddies >= w.price ? '#2ecc71' : '#ff5a5a', 1);
  }, 'ICONIC IRON DROPS FROM CYBERPSYCHOS — GO HUNTING', WORLD.shops.guns.name + ' — WEAPONS', '#f9f002');
  const w = stock[r.sel];
  if (w) {
    const dx = 360, dy = 46;
    drawText(c, w.name, dx, dy, RAR_COL[w.rar], 1);
    drawText(c, RAR_NAME[w.rar] + ' · ' + w.kind.toUpperCase() + ' · ' + w.cls.toUpperCase(), dx, dy + 12, KIND_COL[w.kind], 1);
    statRow(c, dx, dy + 28, 'DMG', w.dmg * (w.pellets || 1) / 120, '#ff5a5a', w.dmg * (w.pellets || 1));
    statRow(c, dx, dy + 40, 'RPS', w.rof / 16, '#f9f002', w.rof);
    statRow(c, dx, dy + 52, 'MAG', (w.mag || 0) / 80, '#05d9e8', w.mag || '—');
    statRow(c, dx, dy + 64, 'DPS', dpsOf(w) / 220, '#bd00ff', dpsOf(w));
    wrapText(w.desc, 40).forEach((ln, i) => drawText(c, ln, dx, dy + 84 + i * 9, '#8a93a6', 1));
    const cur = curWpn();
    if (cur && !G.weapons[w.id]) drawText(c, 'EQUIPPED DPS: ' + dpsOf(cur), dx, dy + 130, '#5a6372', 1);
    let act = G.weapons[w.id] ? 'OWNED' : G.lvl < w.lvl ? 'REQUIRES LEVEL ' + w.lvl : '[ENTER] BUY — €$' + fmt(w.price);
    drawText(c, act, dx, dy + 150, G.weapons[w.id] ? '#5a6372' : '#f9f002', 1);
    if (r.act) buyWeapon(w.id);
  }
  drawCursorSpr(c);
}

// render the SAME iso car used in the world into a UI panel (local projector)
function drawCarThumb(c, cx, cy, sc, id, ang) {
  const pf = (wx, wy, z) => ({ x: cx + (wx - wy) * sc, y: cy + (wx + wy) * 0.5 * sc - z * sc * 0.9 });
  drawCarIso(c, 0, 0, ang == null ? -0.6 : ang, CARD[id], pf);
}

function drawShopCars(c) {
  const r = shopList(c, CARS, (cc, car, x, y, on) => {
    drawCarThumb(cc, x + 13, y + 9, 0.5, car.id, -0.6);
    drawText(cc, trunc(car.name, 24), x + 30, y + 3, G.cars[car.id] ? '#5a6372' : '#cfd6e4', 1);
    const right = G.cars[car.id] ? (G.activeCar === car.id ? 'ACTIVE' : 'OWNED') : '€$' + fmt(car.price);
    drawTextR(cc, right, x + 272, y + 3, G.cars[car.id] ? (G.activeCar === car.id ? '#00ff9f' : '#5a6372') : G.eddies >= car.price ? '#2ecc71' : '#ff5a5a', 1);
  }, '[V] SUMMONS YOUR ACTIVE RIDE · RESUMMON REPAIRS FREE', WORLD.shops.cars.name + ' — VEHICLES', '#00ff9f');
  const car = CARS[r.sel];
  if (car) {
    const dx = 360, dy = 46;
    drawText(c, car.name, dx, dy, '#e8f6ff', 1);
    drawText(c, (car.bike ? 'MOTORCYCLE' : 'CAR') + ' · ' + car.shape.toUpperCase(), dx, dy + 12, '#00ff9f', 1);
    drawCarThumb(c, dx + 90, dy + 48, 1.15, car.id, -0.6);
    statRow(c, dx, dy + 78, 'TOP', car.top / 360, '#f9f002', car.top);
    statRow(c, dx, dy + 90, 'ACC', car.acc / 320, '#ff5a5a', car.acc);
    statRow(c, dx, dy + 102, 'GRIP', (car.grip - 0.8) / 0.16, '#05d9e8', car.grip);
    statRow(c, dx, dy + 114, 'HP', car.hp / 420, '#00ff9f', car.hp);
    let act = G.cars[car.id] ? (G.activeCar === car.id ? 'YOUR ACTIVE RIDE' : '[ENTER] SET ACTIVE') : '[ENTER] BUY — €$' + fmt(car.price);
    drawText(c, act, dx, dy + 140, '#f9f002', 1);
    if (r.act) buyCar(car.id);
  }
  drawCursorSpr(c);
}

function fxDesc(cy, ti) {
  const t = cy.tiers[ti]; if (!t) return '';
  switch (cy.id) {
    case 'sandevistan': return 'TIME ' + (t.ts * 100 | 0) + '% FOR ' + t.dur + 'S · CD ' + t.cd + 'S';
    case 'berserk': return 'DMG ×' + t.dmg + ' +' + t.armor + ' ARMOR · ' + t.dur + 'S';
    case 'memboost': return 'XP ×' + t.xp;
    case 'kiroshi': return 'CRIT +' + (t.crit * 100 | 0) + '%' + (ti >= 1 ? ' · WIDE MINIMAP' : '');
    case 'biomonitor': return 'AUTO-MAXDOC BELOW 30% HP';
    case 'second_heart': return 'REVIVE ON DEATH · CD 180S';
    case 'kerenzikov': return 'DASH SLOWS TIME TO ' + (t.ts * 100 | 0) + '% FOR ' + t.dur + 'S';
    case 'subdermal': return '+' + t.armor + ' ARMOR';
    case 'camo': return 'INVISIBLE ' + t.dur + 'S · CD ' + t.cd + 'S';
    case 'titanium': return '+' + t.hp + ' MAX HP';
    case 'microrotor': return 'FIRE RATE ×' + t.rof;
    case 'smartlink': return 'SMART GUNS TRACK · TURN ' + t.turn;
    case 'tendons': return 'SPEED ×' + t.spd + ' · DASH CD ×' + t.dash;
    default: return 'ADDS ' + (cy.grants ? WPN[cy.grants].name : '') + ' TO ARSENAL';
  }
}

function drawRipper(c) {
  const rows = [];
  for (const slot of CYBER_SLOTS) { rows.push({ hdr: slot }); CYBER.filter(x => x.slot === slot).forEach(x => rows.push({ cy: x })); }
  const r = shopList(c, rows, (cc, row, x, y, on) => {
    if (row.hdr) { drawText(cc, '— ' + row.hdr + ' —', x, y + 3, '#3a5a66', 1); return; }
    const cy = row.cy, tier = G.cyber[cy.id] || 0, max = cy.tiers.length;
    let nm = cy.name;
    drawText(cc, nm, x + 8, y + 3, tier ? '#05d9e8' : '#cfd6e4', 1);
    for (let k = 0; k < max; k++) { cc.fillStyle = k < tier ? '#05d9e8' : 'rgba(255,255,255,0.15)'; cc.fillRect(x + 8 + textW(nm) + 6 + k * 5, y + 4, 3, 3); }
    let right, rcol = '#2ecc71';
    if (cy.os && tier && G.os !== cy.id) { right = 'ACTIVATE'; rcol = '#f9f002'; }
    else if (tier >= max) { right = cy.os && G.os === cy.id ? 'ACTIVE·MAX' : 'MAXED'; rcol = '#5a6372'; }
    else {
      const t = cy.tiers[tier];
      right = (G.lvl < t.lvl ? 'LV' + t.lvl : '€$' + fmt(t.price));
      rcol = G.lvl < t.lvl ? '#ff5a5a' : G.eddies >= t.price ? '#2ecc71' : '#ff5a5a';
    }
    drawTextR(cc, right, x + 272, y + 3, rcol, 1);
  }, 'CHROME UP. EVERYTHING STACKS. OS SLOT: ONE ACTIVE AT A TIME', WORLD.shops.ripper.name + ' — RIPPERDOC', '#05d9e8');
  const row = rows[r.sel];
  if (row && row.cy) {
    const cy = row.cy, tier = G.cyber[cy.id] || 0, dx = 360, dy = 46;
    drawText(c, cy.name, dx, dy, '#05d9e8', 1);
    drawText(c, cy.slot + (cy.os ? ' · OS' : ''), dx, dy + 12, '#5a6372', 1);
    wrapText(cy.desc, 40).forEach((ln, i) => drawText(c, ln, dx, dy + 28 + i * 9, '#8a93a6', 1));
    for (let k = 0; k < cy.tiers.length; k++) {
      const owned = k < tier;
      drawText(c, 'MK.' + (k + 1) + ' ' + fxDesc(cy, k), dx, dy + 66 + k * 11, owned ? '#05d9e8' : '#5a6372', 1);
    }
    let act;
    if (cy.os && tier && G.os !== cy.id) act = '[ENTER] ACTIVATE OS';
    else if (tier >= cy.tiers.length) act = 'FULLY INSTALLED';
    else { const t = cy.tiers[tier]; act = G.lvl < t.lvl ? 'REQUIRES LEVEL ' + t.lvl : '[ENTER] ' + (tier ? 'UPGRADE' : 'INSTALL') + ' — €$' + fmt(t.price); }
    drawText(c, act, dx, dy + 150, '#f9f002', 1);
    if (r.act) buyCyber(cy.id);
  } else if (row && row.hdr && r.act) SFX.ui();
  drawCursorSpr(c);
}

// =================== JOYTOY / DOLL TALK ===================
function drawTalk(c) {
  c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  const n = G.talk.npc;
  uiPanel(c, 110, 218, 420, 116, n.name + (n.kind === 'doll' ? ' — CLOUDS' : ' — JIG-JIG STREET'), '#ff2a6d');
  wrapText(G.talk.text, 66).slice(0, 2).forEach((ln, i) => drawText(c, ln, 122, 242 + i * 10, '#e8f6ff', 1));
  const opts = talkOptions(n);
  const sel = navList(opts.length);
  for (let i = 0; i < opts.length; i++) {
    const y = 272 + i * 16, hot = uiHot(118, y - 4, 404, 14);
    if (hot && G.mouse.moved) G.uiS.sel = i;
    drawText(c, (sel === i ? '> ' : '  ') + opts[i], 124, y, sel === i ? '#f9f002' : '#8a93a6', 1);
    if (hot && G.mouse.click) { G.mouse.click = false; talkSelect(i); return; }
  }
  if (press('Enter') || press('KeyE')) talkSelect(sel);
  drawCursorSpr(c);
}

function drawBar(c) {
  c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  uiPanel(c, 220, 110, 200, 130, 'AFTERLIFE', '#ff2a6d');
  const items = ["'JOHNNY SILVERHAND' — €$100", 'MAXDOC (+1) — €$50', 'LEAVE'];
  const sel = navList(items.length);
  for (let i = 0; i < items.length; i++) {
    const y = 146 + i * 20, hot = uiHot(228, y - 4, 184, 16);
    if (hot && G.mouse.moved) G.uiS.sel = i;
    drawText(c, (sel === i ? '> ' : '  ') + items[i], 230, y, sel === i ? '#f9f002' : '#8a93a6', 1);
    if (hot && G.mouse.click) { G.mouse.click = false; barSelect(i); return; }
  }
  drawText(c, 'FULL HEAL + SPEED BUFF 20S', 230, 210, '#5a6372', 1);
  if (press('Enter') || press('KeyE')) barSelect(sel);
  drawCursorSpr(c);
}

// =================== INVENTORY ===================
const INV_TABS = ['WEAPONS', 'CYBERWARE', 'GARAGE', 'STATS'];
function drawInv(c) {
  c.fillStyle = 'rgba(0,0,0,0.6)'; c.fillRect(0, 0, VIEW_W, VIEW_H);
  uiPanel(c, 56, 22, 528, 316, null, '#bd00ff');
  drawTextR(c, '€$' + fmt(G.eddies), 576, 28, '#f9f002', 1);
  const s = G.uiS;
  if (press('ArrowLeft')) { s.tab = (s.tab + 3) % 4; s.sel = 0; SFX.ui(); }
  if (press('ArrowRight')) { s.tab = (s.tab + 1) % 4; s.sel = 0; SFX.ui(); }
  let tx = 66;
  for (let i = 0; i < 4; i++) {
    const w = textW(INV_TABS[i]) + 12, hot = uiHot(tx, 26, w, 12);
    if (hot && G.mouse.click) { G.mouse.click = false; s.tab = i; s.sel = 0; }
    if (s.tab === i) { c.fillStyle = 'rgba(189,0,255,0.18)'; c.fillRect(tx, 26, w, 11); }
    drawText(c, INV_TABS[i], tx + 6, 28, s.tab === i ? '#bd00ff' : '#5a6372', 1);
    tx += w + 6;
  }
  if (s.tab === 0) invWeapons(c);
  else if (s.tab === 1) invCyber(c);
  else if (s.tab === 2) invGarage(c);
  else invStats(c);
  drawTextC(c, 'ARROW KEYS SWITCH TAB · WASD NAVIGATE · TAB/ESC CLOSE', VIEW_W / 2, 324, '#5a6372', 1);
  drawCursorSpr(c);
}

function invWeapons(c) {
  const all = WEAPONS, s = G.uiS;
  const owned = all.filter(w => G.weapons[w.id]).length;
  drawText(c, 'WEAPON DATABASE: ' + owned + '/' + all.length, 66, 46, '#f9f002', 1);
  uiBar(c, 240, 47, 120, 4, owned / all.length, '#f9f002');
  const cols = 8, cw = 63, ch = 24, gx = 66, gy = 58;
  if (navUp()) { s.sel = Math.max(0, s.sel - cols); SFX.ui(); }
  if (navDown()) { s.sel = Math.min(all.length - 1, s.sel + cols); SFX.ui(); }
  if (press('KeyA')) s.sel = Math.max(0, s.sel - 1);
  if (press('KeyD')) s.sel = Math.min(all.length - 1, s.sel + 1);
  for (let i = 0; i < all.length; i++) {
    const w = all[i], x = gx + (i % cols) * cw, y = gy + ((i / cols) | 0) * ch, have = !!G.weapons[w.id];
    const hot = uiHot(x, y, cw - 3, ch - 3);
    if (hot && G.mouse.moved) s.sel = i;
    if (hot && G.mouse.click) { G.mouse.click = false; s.sel = i; }
    c.fillStyle = s.sel === i ? 'rgba(249,240,2,0.12)' : 'rgba(255,255,255,0.04)';
    c.fillRect(x, y, cw - 3, ch - 3);
    c.fillStyle = have ? RAR_COL[w.rar] : 'rgba(255,255,255,0.1)'; c.fillRect(x, y, cw - 3, 1);
    if (have) c.drawImage(SPR.wicon(w.cls, KIND_COL[w.kind]), x + 18, y + 6);
    else drawTextC(c, w.hidden ? '???' : trunc(w.name.split(' ')[0], 8), x + 30, y + 8, 'rgba(120,130,150,0.5)', 1);
    const li = G.loadout.indexOf(w.id);
    if (li >= 0) drawText(c, String(li + 1), x + 2, y + 2, '#f9f002', 1);
  }
  const w = all[s.sel], have = !!G.weapons[w.id], dy = 196;
  c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(66, dy - 4, 508, 1);
  if (have || !w.hidden) {
    drawText(c, have ? w.name : w.hidden ? '???' : w.name, 66, dy, have ? RAR_COL[w.rar] : '#5a6372', 1);
    drawText(c, RAR_NAME[w.rar] + ' · ' + w.kind.toUpperCase() + ' · ' + w.cls.toUpperCase(), 66, dy + 12, KIND_COL[w.kind], 1);
    drawText(c, 'DMG ' + w.dmg * (w.pellets || 1) + ' · RPS ' + w.rof + ' · DPS ' + dpsOf(w) + (w.mag ? ' · MAG ' + w.mag : ''), 66, dy + 24, '#cfd6e4', 1);
    wrapText(w.desc, 80).forEach((ln, i) => drawText(c, ln, 66, dy + 38 + i * 9, '#8a93a6', 1));
    if (have) drawText(c, 'PRESS [1] [2] [3] TO ASSIGN LOADOUT SLOT', 66, dy + 64, '#f9f002', 1);
    else drawText(c, w.iconic ? 'DROPS FROM CYBERPSYCHOS' : w.granted ? 'INSTALLED BY RIPPERDOC' : 'SOLD AT 2ND AMENDMENT', 66, dy + 64, '#5a6372', 1);
  } else drawText(c, 'UNKNOWN. RUMORS SPEAK OF A VOICE IN A GUTTER...', 66, dy, '#5a6372', 1);
  if (have) {
    if (press('Digit1')) assignSlot(w.id, 0);
    if (press('Digit2')) assignSlot(w.id, 1);
    if (press('Digit3')) assignSlot(w.id, 2);
  }
}

function invCyber(c) {
  let y = 50;
  const ownedN = CYBER.filter(cy => G.cyber[cy.id]).length;
  drawText(c, 'CHROME: ' + ownedN + '/' + CYBER.length, 66, 46, '#05d9e8', 1);
  uiBar(c, 240, 47, 120, 4, ownedN / CYBER.length, '#05d9e8');
  y = 62;
  for (const slot of CYBER_SLOTS) {
    const items = CYBER.filter(x => x.slot === slot && G.cyber[x.id]);
    drawText(c, slot, 66, y, '#3a5a66', 1);
    if (!items.length) drawText(c, '— EMPTY —', 200, y, '#3a414e', 1);
    else drawText(c, items.map(x => x.name + ' MK.' + G.cyber[x.id] + (x.os ? (G.os === x.id ? ' [ACTIVE]' : ' [OFF]') : '')).join(' · '), 200, y, '#cfd6e4', 1);
    y += 13;
  }
  drawText(c, 'VISIT VIK [R ON MAP] TO INSTALL AND UPGRADE', 66, y + 12, '#5a6372', 1);
}

function invGarage(c) {
  const s = G.uiS, ownedN = CARS.filter(car => G.cars[car.id]).length;
  drawText(c, 'GARAGE: ' + ownedN + '/' + CARS.length, 66, 46, '#00ff9f', 1);
  uiBar(c, 240, 47, 120, 4, ownedN / CARS.length, '#00ff9f');
  const cols = 4, cw = 126, ch = 54, gx = 66, gy = 60;
  if (navUp()) s.sel = Math.max(0, s.sel - cols);
  if (navDown()) s.sel = Math.min(CARS.length - 1, s.sel + cols);
  if (press('KeyA')) s.sel = Math.max(0, s.sel - 1);
  if (press('KeyD')) s.sel = Math.min(CARS.length - 1, s.sel + 1);
  for (let i = 0; i < CARS.length; i++) {
    const car = CARS[i], x = gx + (i % cols) * cw, y = gy + ((i / cols) | 0) * ch, have = !!G.cars[car.id];
    const hot = uiHot(x, y, cw - 6, ch - 6);
    if (hot && G.mouse.moved) s.sel = i;
    c.fillStyle = s.sel === i ? 'rgba(0,255,159,0.1)' : 'rgba(255,255,255,0.04)';
    c.fillRect(x, y, cw - 6, ch - 6);
    if (have) {
      drawCarThumb(c, x + 30, y + 24, 0.72, car.id, -0.6);
      drawText(c, trunc(car.name.split(' ').slice(-1)[0], 11), x + 58, y + 8, '#cfd6e4', 1);
      if (G.activeCar === car.id) drawText(c, 'ACTIVE', x + 58, y + 20, '#00ff9f', 1);
      if (hot && G.mouse.click) { G.mouse.click = false; setActiveCar(car.id); }
    } else {
      drawTextC(c, '???', x + (cw - 6) / 2, y + 12, 'rgba(120,130,150,0.4)', 1);
      drawTextC(c, '€$' + fmt(car.price), x + (cw - 6) / 2, y + 26, 'rgba(120,130,150,0.4)', 1);
    }
  }
  const car = CARS[s.sel];
  if (car && G.cars[car.id]) {
    drawText(c, car.name + (G.activeCar === car.id ? ' — ACTIVE' : ' — [ENTER] SET ACTIVE'), 66, 246, '#00ff9f', 1);
    if (press('Enter') || press('KeyE')) setActiveCar(car.id);
  } else if (car) drawText(c, car.name + ' — AVAILABLE AT NC AUTOFIXER', 66, 246, '#5a6372', 1);
}

function invStats(c) {
  const st = G.stats;
  let worth = G.eddies;
  for (const id in G.weapons) worth += WPN[id].price;
  for (const id in G.cars) worth += CARD[id].price;
  for (const id in G.cyber) for (let k = 0; k < G.cyber[id]; k++) worth += CYB[id].tiers[k].price;
  const mins = (st.playT / 60) | 0;
  const lines = [
    ['STREET CRED', 'LV ' + G.lvl + '  (' + G.xp + '/' + xpFor(G.lvl) + ' XP)'],
    ['NET WORTH', '€$' + fmt(worth)],
    ['ENEMIES FLATLINED', st.kills],
    ['CYBERPSYCHOS DOWNED', st.psychos + '/' + ICONICS.length],
    ['BOUNTIES CLEARED', st.bounties],
    ['AIRDROPS SECURED', st.airdrops || 0],
    ['CRATES CRACKED', st.crates],
    ['DISTANCE ROAMED', (st.dist / 1000).toFixed(1) + ' KM'],
    ['TIME IN NIGHT CITY', mins + ' MIN'],
    ['SKIPPY', G.skippyFound ? 'FOUND (HE TALKS)' : 'STILL OUT THERE...'],
  ];
  let y = 52;
  for (const [k, v] of lines) {
    drawText(c, k, 80, y, '#5a6372', 1);
    drawText(c, String(v), 260, y, '#e8f6ff', 1);
    y += 16;
  }
  drawTextC(c, '"WRONG CITY, WRONG PEOPLE."', VIEW_W / 2, y + 18, '#3a414e', 1);
}

function wrapText(s, n) {
  const words = String(s).split(' '), lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > n) { lines.push(cur.trim()); cur = w; }
    else cur += ' ' + w;
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines;
}
