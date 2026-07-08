import * as THREE from 'three';
import { makePuzzle, applyOp, opValid, opLabel, isExotic, randStart, seededRandom } from './js/puzzle.js';
import { loadFont, makeNumberGeometry, NUMBER_SIZE } from './js/text3d.js';
import { buildWall, setWallMatchGlow, disposeWall, WALL_HEIGHT, HOLE_Y } from './js/wall.js';
import { initFX, spawnBurst, spawnWallDebris, updateFX } from './js/fx.js';
import { ensureAudio, sfx, isMuted, setMuted } from './js/audio.js';

// ---------------------------------------------------------------------------
// 3D MATH WALL — main: scene, player character, game state machine, UI, loop
// ---------------------------------------------------------------------------

// ----- Tunables -------------------------------------------------------------
const PLAYER_Z = 0;
const PLAYER_Y = 2.1;
const BASE_SPEED = 14;
const MAX_EXTRA_SPEED = 10;
const BASE_TIME_BUDGET = 8.0;   // seconds to solve at wave 1
const MIN_TIME_BUDGET = 4.5;
const STEP_BONUS_TIME = 2.5;    // extra seconds per extra solution step
const WAVE_SIZE = 5;            // walls per wave; the 5th is a boss
const PERFECT_WINDOW = 0.3;     // matching in the last 30% of approach = PERFECT
const PERFECT_BONUS = 15;
const DAILY_WALLS = 15;
const TIME_ATTACK_SECONDS = 60;
const CRASH_TIME_PENALTY = 6;

// ----- Palette --------------------------------------------------------------
const COL = {
  sky: 0xbfe3ff,
  stripe: '#c3e6d2',
  accent: 0xff7a59,
  good: 0x3ecf8e,
  bad: 0xff5a76,
  wall: 0x7f9cf5,
  wallEdge: 0xffffff,
  deco: [0xffc6d9, 0xc4b5fd, 0xfde68a, 0xa7f3d0, 0xbae6fd],
};

// ----- Renderer / scene -----------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(COL.sky);
scene.fog = new THREE.Fog(COL.sky, 60, 150);
initFX(scene, COL.wall, COL.wallEdge);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 300);
const camBase = new THREE.Vector3(0, 4.6, 10);
camera.position.copy(camBase);
camera.lookAt(0, 2.2, -20);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ----- Lights ---------------------------------------------------------------
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8d8c8, 0.9));
const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
sun.position.set(8, 18, 10);
sun.castShadow = true;
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 20;
sun.shadow.camera.bottom = -20;
sun.shadow.mapSize.set(1024, 1024);
scene.add(sun);

// ----- Ground with scrolling stripes ----------------------------------------
function makeStripeTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#e4f5ec';
  g.fillRect(0, 0, 64, 256);
  g.fillStyle = COL.stripe;
  g.fillRect(0, 0, 64, 24);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(6, 40);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const groundTex = makeStripeTexture();
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(80, 400),
  new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.z = -150;
ground.receiveShadow = true;
scene.add(ground);

// ----- Floating decorations ---------------------------------------------------
const decos = [];
{
  const geos = [
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.TorusGeometry(0.9, 0.35, 12, 24),
    new THREE.SphereGeometry(0.9, 20, 16),
    new THREE.OctahedronGeometry(1, 0),
  ];
  for (let i = 0; i < 16; i++) {
    const mesh = new THREE.Mesh(
      geos[i % geos.length],
      new THREE.MeshStandardMaterial({ color: COL.deco[i % COL.deco.length], roughness: 0.6 })
    );
    const side = i % 2 === 0 ? 1 : -1;
    mesh.position.set(side * (9 + Math.random() * 14), 1 + Math.random() * 7, -Math.random() * 180);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    mesh.userData.spin = (Math.random() - 0.5) * 0.8;
    scene.add(mesh);
    decos.push(mesh);
  }
}

// ----- The player character (a 3D number) --------------------------------------
let font = null;
loadFont().then(f => {
  font = f;
  setPlayerNumberVisual(game.current);
  cardPop = 0;
});

const playerMat = new THREE.MeshStandardMaterial({ color: 0x4f7cff, roughness: 0.3, metalness: 0.15 });
const player = new THREE.Group();
let numberMesh = null;
const blob = new THREE.Mesh(
  new THREE.CircleGeometry(1.3, 32),
  new THREE.MeshBasicMaterial({ color: 0x2b3a55, transparent: true, opacity: 0.15 })
);
blob.rotation.x = -Math.PI / 2;
scene.add(blob);
player.position.set(0, PLAYER_Y, PLAYER_Z);
scene.add(player);

let cardPop = 0; // pop animation timer

function setPlayerNumberVisual(n) {
  if (!font) return;
  if (numberMesh) {
    player.remove(numberMesh);
    numberMesh.geometry.dispose();
  }
  numberMesh = new THREE.Mesh(makeNumberGeometry(font, String(n), NUMBER_SIZE), playerMat);
  numberMesh.castShadow = true;
  player.add(numberMesh);
  cardPop = 1;
}

// ----- HUD / UI refs -----------------------------------------------------------
const $ = id => document.getElementById(id);
const hud = $('hud');
const opsBar = $('ops');
const scoreVal = $('score-val');
const waveChip = $('wave-chip');
const livesChip = $('lives-chip');
const comboPop = $('combo-pop');
const perfectPop = $('perfect-pop');
const waveBanner = $('wave-banner');
const equation = $('equation');
const eqCurrent = $('eq-current');
const eqTarget = $('eq-target');
const flash = $('flash');
const menuScreen = $('menu-screen');
const gameoverScreen = $('gameover-screen');

function flashScreen(color, strength = 0.5) {
  flash.style.background = color;
  flash.style.transition = 'none';
  flash.style.opacity = String(strength);
  requestAnimationFrame(() => {
    flash.style.transition = 'opacity 0.45s ease';
    flash.style.opacity = '0';
  });
}

function showBanner(text, ms = 1400) {
  waveBanner.textContent = text;
  waveBanner.classList.add('show');
  setTimeout(() => waveBanner.classList.remove('show'), ms);
}

// ----- Game state ----------------------------------------------------------------
let wall = null;

const game = {
  state: 'menu', // menu | playing | between | gameover
  mode: 'classic', // classic | time | daily
  rng: Math.random,
  current: 8,
  target: 24,
  buttons: [],
  score: 0,
  combo: 0,
  lives: 3,
  solved: 0,
  timeLeft: TIME_ATTACK_SECONDS,
  wallZ: -100,
  spawnDist: 100,
  matchFrac: 1, // fraction of approach remaining when the match was made
  speed: BASE_SPEED,
  betweenTimer: 0,
  shake: 0,
  lunge: 0,
  knock: 0,
  paused: false,
};
window.__game = game; // debug handle

function wave() { return Math.floor(game.solved / WAVE_SIZE) + 1; }
function wallInWave() { return (game.solved % WAVE_SIZE) + 1; }
function isBossWall() { return wallInWave() === WAVE_SIZE; }

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function bestKey() {
  return game.mode === 'daily' ? `mathwall-best-daily-${todayKey()}` : `mathwall-best-${game.mode}`;
}

function updateHUD() {
  scoreVal.textContent = String(game.score);
  if (game.mode === 'daily') {
    waveChip.textContent = `WALL ${Math.min(game.solved + 1, DAILY_WALLS)}/${DAILY_WALLS}`;
  } else {
    waveChip.textContent = `WAVE ${wave()}${isBossWall() ? ' · BOSS' : ''}`;
  }
  if (game.mode === 'time') {
    livesChip.textContent = `⏱ ${Math.max(Math.ceil(game.timeLeft), 0)}s`;
  } else {
    livesChip.textContent = '❤'.repeat(game.lives) + '♡'.repeat(3 - game.lives);
  }
  eqCurrent.textContent = String(game.current);
  eqTarget.textContent = String(game.target);
  const matched = game.current === game.target;
  equation.classList.toggle('matched', matched);
  setWallMatchGlow(wall, matched);
}

function renderButtons() {
  opsBar.innerHTML = '';
  game.buttons.forEach((op, i) => {
    const btn = document.createElement('button');
    btn.className = 'op-btn' + (isExotic(op) ? ' gold' : '');
    btn.innerHTML = `${opLabel(op)}<small>${i + 1}</small>`;
    btn.addEventListener('pointerdown', () => pressOp(i));
    opsBar.appendChild(btn);
  });
  refreshButtonStates();
}

function refreshButtonStates() {
  const els = opsBar.children;
  game.buttons.forEach((op, i) => {
    if (els[i]) els[i].disabled = !opValid(game.current, op);
  });
}

function pressOp(i) {
  if (game.state !== 'playing' || game.paused) return;
  const op = game.buttons[i];
  if (!op || !opValid(game.current, op)) return;
  ensureAudio();
  const wasMatched = game.current === game.target;
  game.current = applyOp(game.current, op);
  if (op.uses !== undefined) op.uses -= 1; // exotic ops are single-use per wall
  setPlayerNumberVisual(game.current);
  sfx.press();
  if (game.current === game.target) {
    game.matchFrac = (PLAYER_Z - game.wallZ) / game.spawnDist;
    if (!wasMatched) {
      sfx.match();
      spawnBurst(player.position.clone(), COL.good, 24, 5);
    }
  }
  const el = opsBar.children[i];
  if (el) { el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 120); }
  refreshButtonStates();
  updateHUD();
}

window.addEventListener('keydown', e => {
  if ((e.key === 'Escape' || e.key === 'p' || e.key === 'P') &&
      (game.state === 'playing' || game.state === 'between')) {
    setPaused(!game.paused);
    return;
  }
  if (game.state === 'playing' && !game.paused) {
    const i = ['1', '2', '3', '4'].indexOf(e.key);
    if (i >= 0) pressOp(i);
  } else if (game.state === 'gameover' && (e.key === ' ' || e.key === 'Enter')) {
    startGame(game.mode);
  }
});

// ----- Pause ------------------------------------------------------------------------
const pauseScreen = $('pause-screen');
const soundBtn = $('sound-btn');

function refreshSoundBtn() {
  soundBtn.textContent = `SOUND: ${isMuted() ? 'OFF' : 'ON'}`;
}
refreshSoundBtn();

function setPaused(p) {
  if (game.state !== 'playing' && game.state !== 'between') return;
  game.paused = p;
  pauseScreen.classList.toggle('hidden', !p);
}

$('pause-btn').addEventListener('click', () => setPaused(true));
$('resume-btn').addEventListener('click', () => setPaused(false));
soundBtn.addEventListener('click', () => { setMuted(!isMuted()); refreshSoundBtn(); });
$('quit-btn').addEventListener('click', () => {
  game.paused = false;
  pauseScreen.classList.add('hidden');
  game.state = 'menu';
  if (wall) { disposeWall(scene, wall); wall = null; }
  hud.classList.remove('visible');
  opsBar.classList.remove('visible');
  refreshMenuBests();
  menuScreen.classList.remove('hidden');
});

// ----- Wall lifecycle --------------------------------------------------------------
function spawnWall() {
  const boss = game.mode !== 'daily' && isBossWall();
  const puzzle = makePuzzle(game.current, { wave: wave(), boss, rng: game.rng });
  game.target = puzzle.target;
  game.buttons = puzzle.buttons;
  game.matchFrac = 1;

  const budget = Math.max(MIN_TIME_BUDGET, BASE_TIME_BUDGET - (wave() - 1) * 0.45)
    + (puzzle.steps - 1) * STEP_BONUS_TIME
    + (boss ? 1 : 0);
  game.speed = BASE_SPEED + Math.min((wave() - 1) * 0.9, MAX_EXTRA_SPEED);
  game.wallZ = PLAYER_Z - game.speed * budget;
  game.spawnDist = PLAYER_Z - game.wallZ;

  if (wall) { disposeWall(scene, wall); wall = null; }
  wall = buildWall(font, game.target, { boss });
  wall.group.position.z = game.wallZ;
  scene.add(wall.group);

  if (boss) { showBanner('BOSS WALL!'); sfx.boss(); }
  else if (wallInWave() === 1 && game.mode !== 'daily') { showBanner(`WAVE ${wave()}`); sfx.wave(); }

  renderButtons();
  updateHUD();
  game.state = 'playing';
}

function onWallReached() {
  if (game.current === game.target) {
    // ---- SUCCESS ----
    game.combo += 1;
    const base = wall.boss ? 25 : 10;
    const perfect = game.matchFrac <= PERFECT_WINDOW;
    let gained = Math.round(base * (1 + (game.combo - 1) * 0.5));
    if (perfect) gained += PERFECT_BONUS;
    game.score += gained;
    game.solved += 1;
    if (perfect) {
      sfx.perfect();
      perfectPop.textContent = `PERFECT! +${PERFECT_BONUS}`;
      perfectPop.classList.add('show');
      setTimeout(() => perfectPop.classList.remove('show'), 900);
    } else {
      sfx.success();
    }
    flashScreen('#3ecf8e', 0.25);
    spawnBurst(new THREE.Vector3(0, HOLE_Y, PLAYER_Z), COL.good, 80, 11);
    game.lunge = 1; // the number dives through the hole
    if (game.combo >= 2) {
      comboPop.textContent = `COMBO ×${game.combo}!`;
      comboPop.classList.add('show');
      setTimeout(() => comboPop.classList.remove('show'), 900);
    }
    if (game.mode === 'daily' && game.solved >= DAILY_WALLS) {
      updateHUD();
      endGame('complete');
      return;
    }
    game.state = 'between';
    // longer breather before a new wave starts
    game.betweenTimer = game.solved % WAVE_SIZE === 0 ? 2.2 : 0.9;
  } else {
    // ---- CRASH ----
    game.combo = 0;
    game.knock = 1; // the number bounces off the wall
    sfx.fail();
    flashScreen('#ff5a76', 0.45);
    spawnBurst(player.position.clone(), COL.bad, 90, 13);
    if (wall.boss) {
      // reinforced: it doesn't break — it barrels through and hits harder
      game.shake = 1.4;
    } else {
      game.shake = 1;
      spawnWallDebris(game.wallZ, HOLE_Y, WALL_HEIGHT);
      disposeWall(scene, wall);
      wall = null;
    }
    if (game.mode === 'time') {
      game.timeLeft -= CRASH_TIME_PENALTY;
      if (game.timeLeft <= 0) { updateHUD(); endGame('time'); return; }
    } else {
      game.lives -= 1;
      if (game.lives <= 0) { updateHUD(); endGame('crash'); return; }
    }
    game.state = 'between';
    game.betweenTimer = 1.4;
  }
  updateHUD();
}

// ----- Game flow ---------------------------------------------------------------------
function startGame(mode) {
  if (!font) return; // 3D number font still loading
  ensureAudio();
  game.mode = mode;
  game.rng = mode === 'daily' ? seededRandom(todayKey()) : Math.random;
  game.score = 0;
  game.combo = 0;
  game.lives = 3;
  game.solved = 0;
  game.timeLeft = TIME_ATTACK_SECONDS;
  game.current = randStart(game.rng);
  setPlayerNumberVisual(game.current);
  cardPop = 0;
  menuScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  hud.classList.add('visible');
  opsBar.classList.add('visible');
  if (wall) { disposeWall(scene, wall); wall = null; }
  spawnWall();
}
window.__start = startGame; // debug handle

function endGame(reason) {
  game.state = 'gameover';
  if (wall) { disposeWall(scene, wall); wall = null; }
  hud.classList.remove('visible');
  opsBar.classList.remove('visible');
  const best = Math.max(game.score, Number(localStorage.getItem(bestKey()) || 0));
  localStorage.setItem(bestKey(), String(best));
  $('gameover-title').textContent =
    reason === 'complete' ? 'DAILY COMPLETE!' : reason === 'time' ? "TIME'S UP!" : 'CRASHED!';
  $('final-score').textContent = `Score: ${game.score}`;
  $('best-score').textContent = `Best: ${best}`;
  gameoverScreen.classList.remove('hidden');
  refreshMenuBests();
}

function refreshMenuBests() {
  const get = k => Number(localStorage.getItem(k) || 0);
  $('best-classic').textContent = `best ${get('mathwall-best-classic')}`;
  $('best-time').textContent = `best ${get('mathwall-best-time')}`;
  $('best-daily').textContent = `today's best ${get(`mathwall-best-daily-${todayKey()}`)}`;
}
refreshMenuBests();

$('play-classic').addEventListener('click', () => startGame('classic'));
$('play-time').addEventListener('click', () => startGame('time'));
$('play-daily').addEventListener('click', () => startGame('daily'));
$('retry-btn').addEventListener('click', () => startGame(game.mode));
$('menu-btn').addEventListener('click', () => {
  gameoverScreen.classList.add('hidden');
  menuScreen.classList.remove('hidden');
});

// ----- Main loop ------------------------------------------------------------------------
const clock = new THREE.Clock();
let elapsed = 0;
let settle = 1; // 1 = free idle bob, 0 = locked dead-center to thread the cutout
let lastTickSecond = -1;

function animate() {
  requestAnimationFrame(animate);
  // dt = 0 while paused: keep rendering, freeze all motion and timers
  const rawDt = clock.getDelta();
  const dt = game.paused ? 0 : Math.min(rawDt, 0.05);
  elapsed += dt;

  // scrolling ground + drifting decorations sell forward motion
  const flow = (game.state === 'playing' || game.state === 'between') ? game.speed : 6;
  groundTex.offset.y -= (flow * dt) / 10;
  for (const d of decos) {
    d.position.z += flow * dt * 0.9;
    d.rotation.y += d.userData.spin * dt;
    d.rotation.x += d.userData.spin * 0.6 * dt;
    if (d.position.z > 15) d.position.z -= 200;
  }

  // time attack clock
  if (game.mode === 'time' && (game.state === 'playing' || game.state === 'between')) {
    game.timeLeft -= dt;
    const sec = Math.ceil(game.timeLeft);
    if (sec !== lastTickSecond) {
      lastTickSecond = sec;
      livesChip.textContent = `⏱ ${Math.max(sec, 0)}s`;
      if (sec <= 5 && sec > 0) sfx.tick();
    }
    if (game.timeLeft <= 0) endGame('time');
  }

  // player idle bob + pop animation, plus pass-through / bounce-back moves
  let zOff = 0, xTumble = 0, ySpin = 0;
  if (game.lunge > 0) {
    game.lunge = Math.max(0, game.lunge - dt * 1.4);
    const p = 1 - game.lunge;
    zOff = -Math.sin(p * Math.PI) * 3.2;      // dive forward through the hole, then settle back
    ySpin = Math.sin(p * Math.PI) * Math.PI * 2; // victory spin
  }
  if (game.knock > 0) {
    game.knock = Math.max(0, game.knock - dt * 1.1);
    const p = 1 - game.knock;
    zOff = Math.sin(Math.min(p * 1.4, 1) * Math.PI) * 3.4; // thrown backward, then recover
    xTumble = -Math.sin(p * Math.PI) * 1.1;                 // painful backflip
  }
  // bob and sway settle to zero while a wall is near, so the number lines up
  // with the cutout and threads it dead-center
  const settleTarget = wall ? THREE.MathUtils.clamp(((PLAYER_Z - game.wallZ) - 4) / 10, 0, 1) : 1;
  settle += (settleTarget - settle) * Math.min(dt * 6, 1);
  player.position.y = PLAYER_Y + Math.sin(elapsed * 2.2) * 0.15 * settle;
  player.position.z = PLAYER_Z + zOff;
  player.rotation.set(xTumble, ySpin, Math.sin(elapsed * 1.6) * 0.05 * settle);
  blob.position.set(player.position.x, 0.02, player.position.z);
  blob.scale.setScalar(1 - Math.sin(elapsed * 2.2) * 0.08);
  if (cardPop > 0) {
    cardPop = Math.max(0, cardPop - dt * 4);
    const s = 1 + Math.sin(cardPop * Math.PI) * 0.35;
    player.scale.setScalar(s);
  } else {
    player.scale.setScalar(1);
  }

  // wall approach
  if (game.state === 'playing' && wall) {
    game.wallZ += game.speed * dt;
    wall.group.position.z = game.wallZ;
    // glow reads as a sign from afar, fades so the cutout shows as a real hole up close
    const dist = PLAYER_Z - game.wallZ;
    wall.glowMat.opacity = wall.glowBase * THREE.MathUtils.clamp((dist - 6) / 24, 0.3, 1);
    if (game.wallZ >= PLAYER_Z - 0.6) onWallReached();
  } else if (game.state === 'between') {
    if (wall) { // passed (or boss) wall keeps sliding behind the camera
      game.wallZ += game.speed * dt;
      wall.group.position.z = game.wallZ;
      if (game.wallZ > 25) { disposeWall(scene, wall); wall = null; }
    }
    game.betweenTimer -= dt;
    if (game.betweenTimer <= 0) spawnWall();
  }

  // camera shake decay
  if (game.shake > 0) {
    game.shake = Math.max(0, game.shake - dt * 2.2);
    const a = game.shake * game.shake * 0.6;
    camera.position.set(
      camBase.x + (Math.random() - 0.5) * a,
      camBase.y + (Math.random() - 0.5) * a,
      camBase.z + (Math.random() - 0.5) * a
    );
  } else {
    camera.position.copy(camBase);
  }

  updateFX(dt);
  renderer.render(scene, camera);
}
animate();
