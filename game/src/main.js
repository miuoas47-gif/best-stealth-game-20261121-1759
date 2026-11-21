// Shadowline — a top-down stealth game.
// You are a thief in the Marrowgate Museum after dark. Slip past the patrolling
// guards and their vision cones, steal the Moonstone Idol from the vault, and
// reach the exit unseen. Shadows hide you; running makes noise.
// No assets, no network: everything is drawn on one canvas.

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const W = canvas.width;
const H = canvas.height;

// ------------------------------------------------------------------ utilities

/** Deterministic PRNG (mulberry32) so every run of the same seed plays the same. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
const TAU = Math.PI * 2;

/** Smallest signed angle from a to b. */
function angleDiff(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

function circleHitsRect(cx, cy, r, rect) {
  const nx = clamp(cx, rect.x, rect.x + rect.w);
  const ny = clamp(cy, rect.y, rect.y + rect.h);
  return (cx - nx) ** 2 + (cy - ny) ** 2 < r * r;
}

function pointInRect(x, y, rect) {
  return x >= rect.x && x <= rect.x + rect.w && y >= rect.y && y <= rect.y + rect.h;
}

// ------------------------------------------------------------------ the level

// Walls block movement and sight. Crates block both too, but are low cover you
// can crouch behind. Shadows are floor markings: standing in one makes you
// much harder to spot.
const WALLS = [
  { x: 0, y: 0, w: W, h: 24 }, { x: 0, y: H - 24, w: W, h: 24 },
  { x: 0, y: 0, w: 24, h: H }, { x: W - 24, y: 0, w: 24, h: H },
  { x: 300, y: 24, w: 24, h: 200 }, { x: 300, y: 320, w: 24, h: 331 },
  { x: 324, y: 200, w: 280, h: 24 },
  { x: 680, y: 420, w: 376, h: 24 },
  { x: 680, y: 120, w: 24, h: 220 },
  { x: 760, y: 120, w: 296, h: 24 },
];
const CRATES = [
  { x: 420, y: 300, w: 52, h: 52 }, { x: 520, y: 500, w: 52, h: 52 },
  { x: 170, y: 420, w: 52, h: 52 }, { x: 830, y: 300, w: 52, h: 52 },
  { x: 600, y: 84, w: 52, h: 52 }, { x: 130, y: 96, w: 52, h: 52 },
];
const SHADOWS = [
  { x: 96, y: 200, w: 150, h: 84 }, { x: 420, y: 250, w: 130, h: 64 },
  { x: 830, y: 480, w: 160, h: 90 }, { x: 560, y: 330, w: 120, h: 70 },
  { x: 900, y: 180, w: 120, h: 80 },
];
const IDOL = { x: 950, y: 92 };
const EXIT = { x: 40, y: 596, w: 110, h: 55 };
const PLAYER_START = { x: 95, y: 570 };

/** Guard patrol routes: pairs of waypoints the guard walks between. */
const GUARD_ROUTES = [
  [{ x: 370, y: 480 }, { x: 640, y: 480 }],
  [{ x: 750, y: 530 }, { x: 1000, y: 530 }],
  [{ x: 780, y: 170 }, { x: 780, y: 380 }],
];

// ------------------------------------------------------------------ state

const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // start | patrol | alert | win — fixed scenes for screenshots

const game = {
  state: 'title', // title | playing | caught | escaped
  time: 0,
  meter: 0, // 0..100 detection meter
  alarm: false,
  alerts: 0,
  idolTaken: false,
  score: 0,
  noisePulse: 0,
  noiseX: 0,
  noiseY: 0,
  player: { x: PLAYER_START.x, y: PLAYER_START.y, r: 13, sneaking: false, moving: false, face: 0 },
  guards: [],
};

function makeGuards() {
  return GUARD_ROUTES.map((route, i) => ({
    x: route[0].x, y: route[0].y, r: 14,
    route, leg: 0, dir: 1,
    angle: 0, speed: 52 + i * 4,
    mode: 'patrol', // patrol | suspicious | chase | search
    target: null, wait: 0, lastSeen: null, searchT: 0,
  }));
}
game.guards = makeGuards();

const keys = new Set();
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) e.preventDefault();
  keys.add(e.key.toLowerCase());
  if ((e.key === 'Enter' || e.key === ' ') && game.state !== 'playing') startGame();
  if (e.key.toLowerCase() === 'r' && (game.state === 'caught' || game.state === 'escaped')) startGame();
  ensureAudio();
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
canvas.addEventListener('click', () => { if (game.state !== 'playing') startGame(); ensureAudio(); });

function startGame() {
  game.state = 'playing';
  game.time = 0; game.meter = 0; game.alarm = false; game.alerts = 0;
  game.idolTaken = false; game.score = 0;
  game.player.x = PLAYER_START.x; game.player.y = PLAYER_START.y;
  game.guards = makeGuards();
}

// ------------------------------------------------------------------ audio (tiny synth blips, no assets)

let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ } }
}
function blip(freq, dur, type = 'sine', vol = 0.05) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(vol, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
  o.connect(g); g.connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + dur);
}

// ------------------------------------------------------------------ sight & movement

const VISION_RANGE = 235;
const VISION_HALF = 0.62; // radians either side of facing

function losBlocked(ax, ay, bx, by) {
  // Sample the segment; a wall or crate between the two ends blocks sight.
  const steps = Math.ceil(dist(ax, ay, bx, by) / 8);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    for (const w of WALLS) if (pointInRect(x, y, w)) return true;
    for (const c of CRATES) if (pointInRect(x, y, c)) return true;
  }
  return false;
}

function playerHidden() {
  const p = game.player;
  return SHADOWS.some((s) => pointInRect(p.x, p.y, s));
}

/** How strongly a guard can see the player right now, 0 (unseen) to 1 (fully seen). */
function guardSees(g) {
  const p = game.player;
  const d = dist(g.x, g.y, p.x, p.y);
  const range = VISION_RANGE * (playerHidden() ? 0.55 : 1);
  if (d > range) return 0;
  const ang = Math.atan2(p.y - g.y, p.x - g.x);
  if (Math.abs(angleDiff(g.angle, ang)) > VISION_HALF) return 0;
  if (losBlocked(g.x, g.y, p.x, p.y)) return 0;
  const closeness = 1 - d / range; // nearer = seen faster
  return clamp(0.35 + closeness, 0, 1) * (p.sneaking ? 0.55 : 1);
}

function moveCircle(body, dx, dy) {
  // Axis-separated movement so the player slides along walls instead of sticking.
  const nx = body.x + dx;
  if (!WALLS.some((w) => circleHitsRect(nx, body.y, body.r, w)) &&
      !CRATES.some((c) => circleHitsRect(nx, body.y, body.r, c))) body.x = nx;
  const ny = body.y + dy;
  if (!WALLS.some((w) => circleHitsRect(body.x, ny, body.r, w)) &&
      !CRATES.some((c) => circleHitsRect(body.x, ny, body.r, c))) body.y = ny;
}

// ------------------------------------------------------------------ update

let noiseTimer = 0;

function update(dt) {
  if (game.state !== 'playing') return;
  game.time += dt;
  const p = game.player;

  // --- player movement
  let mx = 0, my = 0;
  if (keys.has('w') || keys.has('arrowup')) my -= 1;
  if (keys.has('s') || keys.has('arrowdown')) my += 1;
  if (keys.has('a') || keys.has('arrowleft')) mx -= 1;
  if (keys.has('d') || keys.has('arrowright')) mx += 1;
  p.sneaking = keys.has('shift');
  p.moving = mx !== 0 || my !== 0;
  if (p.moving) {
    const len = Math.hypot(mx, my);
    const speed = p.sneaking ? 78 : 168;
    moveCircle(p, (mx / len) * speed * dt, (my / len) * speed * dt);
    p.face = Math.atan2(my, mx);
    // Running is loud: guards nearby turn to investigate the noise.
    if (!p.sneaking) {
      noiseTimer -= dt;
      if (noiseTimer <= 0) {
        noiseTimer = 0.45;
        game.noisePulse = 1; game.noiseX = p.x; game.noiseY = p.y;
        for (const g of game.guards) {
          if (g.mode === 'patrol' && dist(g.x, g.y, p.x, p.y) < 150) {
            g.mode = 'suspicious'; g.target = { x: p.x, y: p.y };
          }
        }
      }
    }
  }
  if (game.noisePulse > 0) game.noisePulse = Math.max(0, game.noisePulse - dt * 1.6);

  // --- steal the idol
  if (!game.idolTaken && dist(p.x, p.y, IDOL.x, IDOL.y) < 30) {
    game.idolTaken = true;
    blip(880, 0.25, 'sine', 0.07); setTimeout(() => blip(1318, 0.3, 'sine', 0.06), 90);
  }
  // --- reach the exit with the idol
  if (game.idolTaken && pointInRect(p.x, p.y, EXIT)) {
    game.state = 'escaped';
    game.score = Math.max(100, 1000 - Math.floor(game.time) * 5 - game.alerts * 150);
    blip(523, 0.2, 'triangle', 0.07); setTimeout(() => blip(784, 0.35, 'triangle', 0.07), 140);
    return;
  }

  // --- guards: sight, meter, behaviour
  let seen = 0;
  for (const g of game.guards) seen = Math.max(seen, guardSees(g));
  if (seen > 0) {
    game.meter = clamp(game.meter + seen * 95 * dt, 0, 100);
    for (const g of game.guards) if (guardSees(g) > 0) g.lastSeen = { x: p.x, y: p.y };
  } else {
    game.meter = clamp(game.meter - 22 * dt, 0, 100);
  }
  const wasAlarm = game.alarm;
  game.alarm = game.meter >= 100;
  if (game.alarm && !wasAlarm) {
    game.alerts++;
    blip(220, 0.4, 'sawtooth', 0.06);
    for (const g of game.guards) { g.mode = 'chase'; g.target = { x: p.x, y: p.y }; }
  }
  if (!game.alarm && game.meter < 40) {
    for (const g of game.guards) if (g.mode === 'chase') { g.mode = 'search'; g.searchT = 4; }
  }

  for (const g of game.guards) updateGuard(g, dt, seen);

  // --- caught?
  for (const g of game.guards) {
    if (dist(g.x, g.y, p.x, p.y) < g.r + p.r - 2) {
      game.state = 'caught';
      blip(110, 0.5, 'sawtooth', 0.08);
      return;
    }
  }
}

function updateGuard(g, dt, seen) {
  const p = game.player;
  const stepToward = (tx, ty, speed) => {
    const d = dist(g.x, g.y, tx, ty);
    if (d < 4) return true;
    const a = Math.atan2(ty - g.y, tx - g.x);
    g.angle += angleDiff(g.angle, a) * Math.min(1, dt * 8);
    moveCircle(g, Math.cos(a) * speed * dt, Math.sin(a) * speed * dt);
    return false;
  };
  if (g.mode === 'chase') {
    if (seen > 0 || game.alarm) stepToward(p.x, p.y, 118);
    else { g.mode = 'search'; g.searchT = 4; }
    return;
  }
  if (g.mode === 'suspicious') {
    if (g.target && stepToward(g.target.x, g.target.y, 85)) { g.mode = 'search'; g.searchT = 2.5; }
    return;
  }
  if (g.mode === 'search') {
    g.searchT -= dt;
    g.angle += dt * 1.6; // scan the area
    if (g.searchT <= 0) g.mode = 'patrol';
    return;
  }
  // patrol: walk the route, pausing briefly at each waypoint
  if (g.wait > 0) { g.wait -= dt; return; }
  const wp = g.route[g.leg];
  if (stepToward(wp.x, wp.y, g.speed)) {
    g.wait = 0.9;
    g.leg += g.dir;
    if (g.leg >= g.route.length) { g.leg = g.route.length - 2; g.dir = -1; }
    if (g.leg < 0) { g.leg = 1; g.dir = 1; }
  }
}

// ------------------------------------------------------------------ drawing

function drawCone(g) {
  const alerted = g.mode === 'chase' || game.alarm;
  const grad = ctx.createRadialGradient(g.x, g.y, 10, g.x, g.y, VISION_RANGE);
  grad.addColorStop(0, alerted ? 'rgba(255,70,60,0.42)' : 'rgba(255,214,110,0.30)');
  grad.addColorStop(1, 'rgba(255,214,110,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(g.x, g.y);
  ctx.arc(g.x, g.y, VISION_RANGE, g.angle - VISION_HALF, g.angle + VISION_HALF);
  ctx.closePath();
  ctx.fill();
}

function drawWorld() {
  // floor
  ctx.fillStyle = '#191b22';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1d1f28';
  for (let y = 24; y < H - 24; y += 54) {
    for (let x = 24; x < W - 24; x += 54) {
      if (((x + y) / 54) % 2 === 0) ctx.fillRect(x, y, 54, 54);
    }
  }
  // gallery rug down the middle
  ctx.fillStyle = '#2b1f24';
  ctx.fillRect(340, 60, 300, 560);
  ctx.strokeStyle = '#4a2f38';
  ctx.lineWidth = 3;
  ctx.strokeRect(348, 68, 284, 544);

  // shadow zones (hiding spots)
  for (const s of SHADOWS) {
    ctx.fillStyle = 'rgba(4,6,12,0.55)';
    ctx.beginPath();
    ctx.ellipse(s.x + s.w / 2, s.y + s.h / 2, s.w / 2, s.h / 2, 0, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120,140,190,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // exit door
  ctx.fillStyle = game.idolTaken ? '#1d5c33' : '#274a35';
  ctx.fillRect(EXIT.x, EXIT.y, EXIT.w, EXIT.h);
  ctx.strokeStyle = game.idolTaken ? '#58d68d' : '#3f7a55';
  ctx.lineWidth = 3;
  ctx.strokeRect(EXIT.x, EXIT.y, EXIT.w, EXIT.h);
  ctx.fillStyle = game.idolTaken ? '#a9f5c6' : '#7fb894';
  ctx.font = 'bold 15px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('EXIT', EXIT.x + EXIT.w / 2, EXIT.y + EXIT.h / 2 + 5);

  // idol pedestal + the Moonstone Idol
  ctx.fillStyle = '#3a3f4d';
  ctx.fillRect(IDOL.x - 22, IDOL.y - 14, 44, 28);
  ctx.fillStyle = '#565d70';
  ctx.fillRect(IDOL.x - 22, IDOL.y - 18, 44, 6);
  if (!game.idolTaken) {
    const glow = ctx.createRadialGradient(IDOL.x, IDOL.y - 26, 2, IDOL.x, IDOL.y - 26, 42);
    glow.addColorStop(0, 'rgba(120,230,255,0.85)');
    glow.addColorStop(1, 'rgba(120,230,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(IDOL.x, IDOL.y - 26, 42, 0, TAU); ctx.fill();
    ctx.fillStyle = '#9beaff';
    ctx.beginPath();
    ctx.moveTo(IDOL.x, IDOL.y - 44);
    ctx.lineTo(IDOL.x + 11, IDOL.y - 26);
    ctx.lineTo(IDOL.x, IDOL.y - 12);
    ctx.lineTo(IDOL.x - 11, IDOL.y - 26);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#e8fbff';
    ctx.beginPath();
    ctx.moveTo(IDOL.x, IDOL.y - 44);
    ctx.lineTo(IDOL.x + 5, IDOL.y - 26);
    ctx.lineTo(IDOL.x, IDOL.y - 20);
    ctx.lineTo(IDOL.x - 5, IDOL.y - 26);
    ctx.closePath(); ctx.fill();
  }

  // crates
  for (const c of CRATES) {
    ctx.fillStyle = '#4a3823';
    ctx.fillRect(c.x, c.y, c.w, c.h);
    ctx.fillStyle = '#5d4830';
    ctx.fillRect(c.x + 4, c.y + 4, c.w - 8, c.h - 8);
    ctx.strokeStyle = '#2e2113';
    ctx.lineWidth = 2;
    ctx.strokeRect(c.x + 4, c.y + 4, c.w - 8, c.h - 8);
    ctx.beginPath();
    ctx.moveTo(c.x + 4, c.y + 4); ctx.lineTo(c.x + c.w - 4, c.y + c.h - 4);
    ctx.moveTo(c.x + c.w - 4, c.y + 4); ctx.lineTo(c.x + 4, c.y + c.h - 4);
    ctx.stroke();
  }

  // walls
  for (const w of WALLS) {
    ctx.fillStyle = '#333743';
    ctx.fillRect(w.x, w.y, w.w, w.h);
    ctx.fillStyle = '#454b5c';
    ctx.fillRect(w.x, w.y, w.w, 4);
  }

  // noise ring
  if (game.noisePulse > 0) {
    ctx.strokeStyle = `rgba(255,255,255,${0.35 * game.noisePulse})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(game.noiseX, game.noiseY, 26 + (1 - game.noisePulse) * 90, 0, TAU);
    ctx.stroke();
  }

  // guards + cones
  for (const g of game.guards) drawCone(g);
  for (const g of game.guards) {
    ctx.fillStyle = '#232a3d';
    ctx.beginPath(); ctx.arc(g.x, g.y, g.r, 0, TAU); ctx.fill();
    ctx.strokeStyle = g.mode === 'chase' ? '#ff5040' : '#7d8db5';
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // facing tick + helmet brim
    ctx.strokeStyle = '#cdd6ea';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(g.x, g.y);
    ctx.lineTo(g.x + Math.cos(g.angle) * (g.r + 7), g.y + Math.sin(g.angle) * (g.r + 7));
    ctx.stroke();
    ctx.fillStyle = '#cdd6ea';
    ctx.beginPath(); ctx.arc(g.x, g.y, 4, 0, TAU); ctx.fill();
    if (g.mode !== 'patrol') {
      ctx.fillStyle = g.mode === 'chase' ? '#ff5040' : '#ffd66e';
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(g.mode === 'chase' ? '!' : '?', g.x, g.y - g.r - 8);
    }
  }

  // player: hooded thief
  const p = game.player;
  ctx.fillStyle = '#0e1420';
  ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
  ctx.strokeStyle = playerHidden() ? '#5f7fb5' : '#9fb4dd';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.fillStyle = '#dfe7f5';
  ctx.beginPath();
  ctx.moveTo(p.x + Math.cos(p.face) * 10, p.y + Math.sin(p.face) * 10);
  ctx.lineTo(p.x + Math.cos(p.face + 2.4) * 7, p.y + Math.sin(p.face + 2.4) * 7);
  ctx.lineTo(p.x + Math.cos(p.face - 2.4) * 7, p.y + Math.sin(p.face - 2.4) * 7);
  ctx.closePath(); ctx.fill();
  if (game.idolTaken) {
    ctx.fillStyle = '#9beaff';
    ctx.beginPath(); ctx.arc(p.x, p.y - p.r - 6, 4, 0, TAU); ctx.fill();
  }
}

function drawHud() {
  ctx.fillStyle = 'rgba(8,10,16,0.72)';
  ctx.fillRect(0, 0, W, 46);
  ctx.fillStyle = '#e8ecf4';
  ctx.font = 'bold 17px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('SHADOWLINE', 18, 29);
  ctx.font = '15px system-ui, sans-serif';
  ctx.fillStyle = '#b9c1d4';
  const objective = game.idolTaken ? 'Idol stolen — reach the EXIT!' : 'Steal the Moonstone Idol from the vault';
  ctx.fillText(objective, 170, 29);

  // detection meter
  const mx = 620, mw = 200;
  ctx.fillStyle = '#20242e';
  ctx.fillRect(mx, 14, mw, 18);
  const mg = ctx.createLinearGradient(mx, 0, mx + mw, 0);
  mg.addColorStop(0, '#ffd66e'); mg.addColorStop(1, '#ff5040');
  ctx.fillStyle = mg;
  ctx.fillRect(mx, 14, mw * (game.meter / 100), 18);
  ctx.strokeStyle = '#565d70';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(mx, 14, mw, 18);
  ctx.fillStyle = '#e8ecf4';
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillText(game.alarm ? 'SPOTTED!' : 'SEEN', mx + mw + 10, 29);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#b9c1d4';
  const t = Math.floor(game.time);
  ctx.fillText(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}  ·  alerts ${game.alerts}`, W - 18, 29);
  ctx.textAlign = 'left';
}

function overlay(title, lines, color) {
  ctx.fillStyle = 'rgba(5,7,12,0.72)';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';
  ctx.fillStyle = color;
  ctx.font = 'bold 54px Georgia, serif';
  ctx.fillText(title, W / 2, H / 2 - 60);
  ctx.fillStyle = '#dfe4ee';
  ctx.font = '19px system-ui, sans-serif';
  lines.forEach((line, i) => ctx.fillText(line, W / 2, H / 2 - 8 + i * 30));
  ctx.textAlign = 'left';
}

function draw() {
  drawWorld();
  drawHud();
  if (game.state === 'title') {
    overlay('SHADOWLINE', [
      'A stealth game in the Marrowgate Museum after dark.',
      'Sneak past the guards, steal the Moonstone Idol, escape unseen.',
      'WASD / arrows to move · hold Shift to sneak · shadows hide you',
      'Press Enter or click to begin',
    ], '#e8ecf4');
  } else if (game.state === 'caught') {
    overlay('CAUGHT!', [
      'A guard laid hands on you in the dark.',
      `You survived ${Math.floor(game.time)}s with ${game.alerts} alarm${game.alerts === 1 ? '' : 's'}.`,
      'Press R to try again',
    ], '#ff6a5e');
  } else if (game.state === 'escaped') {
    overlay('ESCAPED!', [
      'The Moonstone Idol is yours — and nobody saw a thing.',
      `Time ${Math.floor(game.time)}s · alerts ${game.alerts} · score ${game.score}`,
      'Press R to play again',
    ], '#7be495');
  }
}

// ------------------------------------------------------------------ fixed scenes for screenshots

function setShotScene() {
  const rng = mulberry32(1);
  void rng;
  if (SHOT === 'start') {
    game.state = 'title';
    game.guards = makeGuards();
    game.guards[0].x = 470; game.guards[0].y = 480; game.guards[0].angle = Math.PI;
    game.guards[1].x = 860; game.guards[1].y = 530; game.guards[1].angle = 0;
    game.guards[2].x = 780; game.guards[2].y = 260; game.guards[2].angle = Math.PI / 2;
  } else if (SHOT === 'patrol') {
    game.state = 'playing';
    game.time = 47; game.meter = 34;
    game.player.x = 455; game.player.y = 468; game.player.sneaking = true; game.player.face = Math.PI;
    game.guards = makeGuards();
    game.guards[0].x = 585; game.guards[0].y = 480; game.guards[0].angle = Math.PI;
    game.guards[1].x = 860; game.guards[1].y = 530; game.guards[1].angle = Math.PI;
    game.guards[2].x = 780; game.guards[2].y = 300; game.guards[2].angle = Math.PI / 2;
  } else if (SHOT === 'alert') {
    game.state = 'playing';
    game.time = 83; game.meter = 100; game.alarm = true; game.alerts = 1; game.idolTaken = true;
    game.player.x = 700; game.player.y = 300; game.player.face = -Math.PI / 2;
    game.guards = makeGuards();
    for (const g of game.guards) g.mode = 'chase';
    game.guards[0].x = 620; game.guards[0].y = 380; game.guards[0].angle = Math.atan2(-80, 80);
    game.guards[1].x = 800; game.guards[1].y = 430; game.guards[1].angle = Math.atan2(-130, -100);
    game.guards[2].x = 780; game.guards[2].y = 210; game.guards[2].angle = Math.atan2(90, -80);
  } else if (SHOT === 'win') {
    game.state = 'escaped';
    game.time = 142; game.alerts = 1; game.idolTaken = true;
    game.score = 1000 - 142 * 5 - 150;
    game.player.x = 95; game.player.y = 620; game.player.face = Math.PI / 2;
    game.guards = makeGuards();
    game.guards[0].x = 470; game.guards[0].y = 480; game.guards[0].angle = 0;
    game.guards[1].x = 860; game.guards[1].y = 530; game.guards[1].angle = Math.PI;
    game.guards[2].x = 780; game.guards[2].y = 260; game.guards[2].angle = -Math.PI / 2;
  }
}

// ------------------------------------------------------------------ main loop

let last = performance.now();
function frame(now) {
  const dt = clamp((now - last) / 1000, 0, 0.05);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(frame);
}

if (SHOT) {
  // A fixed scene for a screenshot: draw once, do not advance the game.
  setShotScene();
  draw();
  document.title = `Shadowline — shot ${SHOT}`;
} else {
  requestAnimationFrame(frame);
}
