import * as THREE from 'three';
import { makePuzzle, applyOp, opValid, opLabel, isExotic, randStart, seededRandom } from './js/puzzle.js';
import { loadFont, makeNumberGroup, NUMBER_SIZE } from './js/text3d.js';
import { buildWall, setWallMatchGlow, disposeWall, WALL_HEIGHT, HOLE_Y, WALL_TINTS } from './js/wall.js';
import { initFX, spawnBurst, spawnWallDebris, updateFX, clearFX } from './js/fx.js';
import { ensureAudio, sfx, isMuted, setMuted } from './js/audio.js';
import { EffectComposer } from './lib/postprocessing/EffectComposer.js';
import { RenderPass } from './lib/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './lib/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './lib/postprocessing/OutputPass.js';
import { RoomEnvironment } from './lib/environments/RoomEnvironment.js';

// ---------------------------------------------------------------------------
// 3D MATH WALL — main: scene, player character, game state machine, UI, loop
// ---------------------------------------------------------------------------

// ----- Tunables -------------------------------------------------------------
const PLAYER_Z = 0;
const PLAYER_Y = 3.3; // high enough that the full glyph clears the bottom UI
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
const QUEUE_AHEAD = 2;          // upcoming walls visible behind the active one
const SLOW_FACTOR = 0.45;       // Slow Time power-up speed multiplier
const SLOW_DURATION = 4;

// ----- Palette --------------------------------------------------------------
const COL = {
  sky: 0xbfe3ff,
  accent: 0xff7a59,
  good: 0x3ecf8e,
  bad: 0xff5a76,
  wall: 0x7f9cf5,
  wallEdge: 0xffffff,
  // desaturated dreamscape pastels: lavender, blush, powder, mint, cream, periwinkle
  city: [0xd9c8f5, 0xf5cfe0, 0xc9e6f2, 0xcdf0dd, 0xf7ead2, 0xd6dcf7],
};

// A calm, warm/cool sky palette keeps the world close to the sunrise reference.
COL.sky = 0xc7e6ff;

// ----- Renderer / scene -----------------------------------------------------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04; // bright, but below the bloom blow-out line
renderer.toneMappingExposure = 1.08; // luminous daylight without washing out gameplay markers
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap; // stable, soft contact shadows
renderer.shadowMap.type = THREE.VSMShadowMap; // blurred, soft shadows — reads as gentle AO

renderer.shadowMap.type = THREE.PCFSoftShadowMap; // retain soft shadows after renderer setup
const scene = new THREE.Scene();
// Bring haze closer to the runway so the distant city dissolves into the sunrise.
scene.fog = new THREE.Fog(COL.sky, 72, 265);
scene.fog = new THREE.Fog(COL.sky, 90, 250); // far + horizon-tinted so the world stays vivid
initFX(scene, COL.wall, COL.wallEdge);
scene.fog = new THREE.Fog(COL.sky, 72, 265);

// PBR environment map for the number character only — a glossy toy-like sheen
// without overexposing the rest of the scene
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;

// ----- Procedural sky dome: zenith → mid → horizon, driven by time of day ------
const skyMat = new THREE.ShaderMaterial({
  uniforms: {
    zenith: { value: new THREE.Color(0x4f92e0) },
    mid: { value: new THREE.Color(0x9ec7ef) },
    horizon: { value: new THREE.Color(0xffe2b8) },
  },
  vertexShader: `
    varying vec3 vWorldPosition;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldPosition = wp.xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 zenith;
    uniform vec3 mid;
    uniform vec3 horizon;
    varying vec3 vWorldPosition;
    void main() {
      float h = clamp(normalize(vWorldPosition).y, -1.0, 1.0);
      vec3 sky = h > 0.22
        ? mix(mid, zenith, smoothstep(0.22, 0.85, h))
        : mix(horizon, mid, smoothstep(-0.02, 0.22, h));
      gl_FragColor = vec4(sky, 1.0);
    }`,
  side: THREE.BackSide,
  depthWrite: false,
  fog: false,
});
const skyDome = new THREE.Mesh(new THREE.SphereGeometry(240, 24, 12), skyMat);
scene.add(skyDome);

// elevated ~45° chase camera: shows the track, the incoming wall, and the queue behind it
const camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 300);
const camBase = new THREE.Vector3(0, 7.5, 10.5);
camera.position.copy(camBase);
camera.lookAt(0, 1.2, -13); // aim low: lifts the whole scene above the bottom UI

// ----- Post-processing: soft bloom on glows -----------------------------------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.55,  // strength — the reference is unapologetically bloomy
  0.4,   // radius
  1.12   // threshold: safely above lit-white surfaces — only boosted glows bloom
);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ----- Lights: high-key, warm, soft -------------------------------------------
const ambientLight = new THREE.HemisphereLight(0xd8eaff, 0xe9eef5, 1.1);
scene.add(ambientLight);
const sun = new THREE.DirectionalLight(0xffe9c4, 1.15);
sun.position.set(8, 18, 10);
sun.castShadow = true;
sun.shadow.camera.left = -20;
sun.shadow.camera.right = 20;
sun.shadow.camera.top = 20;
sun.shadow.camera.bottom = -20;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.radius = 8;       // VSM blur — dreamy soft edges
sun.shadow.blurSamples = 16;
sun.shadow.bias = -0.0001;
scene.add(sun);
// Re-aim the key light at the horizon: warm rims toward the vanishing point,
// cool skylight above, and soft readable shadows beneath the player and walls.
sun.color.setHex(0xffe8c6);
sun.intensity = 1.45;
sun.position.set(-24, 18, -105);
sun.target.position.set(0, 0, -48);
sun.shadow.camera.left = -24;
sun.shadow.camera.right = 24;
sun.shadow.camera.top = 24;
sun.shadow.camera.bottom = -24;
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 150;
sun.shadow.radius = 4;
sun.shadow.bias = -0.00025;
scene.add(sun.target);
const skyFill = new THREE.DirectionalLight(0xa9d8ff, 0.32);
skyFill.position.set(12, 16, 18);
scene.add(skyFill);
// Minimal studio light: neutral surfaces, crisp gameplay silhouettes, no yellow cast.
sun.color.setHex(0xf7fbff);
sun.intensity = 0.9;
sun.position.set(10, 18, 14);
sun.target.position.set(0, 0, -26);
skyFill.intensity = 0.46;

// ----- Reactive ruler-tile runway ----------------------------------------------
// The lane is built from individual tiles so the floor itself reacts to play:
// a shimmer runs down the lane, presses flash under the number, successes send
// a ripple racing ahead, crashes flush the tiles red. Ruler ticks along both
// edges burn like a fuse while a wall approaches — the lit stretch between you
// and the wall is literally the time you have left, and it turns green when
// you're safe or pulses red inside the PERFECT window.
const TRACK_TILE_LEN = 4;
const TRACK_TILE_COUNT = 52;
// square grout grid drawn onto each tile strip, so the lane reads as glossy
// white porcelain tiles like the reference
function makeGroutTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#e4e8f1';
  g.lineWidth = 7;
  g.strokeRect(3, 3, 250, 250);
  for (const x of [85, 171]) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 256); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const trackTiles = [];
const trackGroup = new THREE.Group();
{
  const groutTex = makeGroutTexture();
  const tileGeo = new THREE.BoxGeometry(12.6, 0.14, TRACK_TILE_LEN - 0.35);
  const tickGeoShort = new THREE.BoxGeometry(0.45, 0.08, 0.2);
  const tickGeoLong = new THREE.BoxGeometry(1.0, 0.08, 0.26);
  for (let i = 0; i < TRACK_TILE_COUNT; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: i % 2 ? 0xeef1f7 : 0xf6f8fc,
      roughness: 0.34,
      map: groutTex,
      envMap: envTex,
      envMapIntensity: 0.3,
    });
    const tile = new THREE.Mesh(tileGeo, mat);
    const baseZ = 16 - i * TRACK_TILE_LEN;
    tile.position.set(0, 0.03, baseZ);
    tile.receiveShadow = true;
    tile.material.roughness = 0.27;
    tile.material.metalness = 0.035;
    tile.material.envMapIntensity = 0.42;
    tile.material.roughness = 0.54;
    tile.material.metalness = 0;
    tile.material.envMapIntensity = 0.08;
    trackGroup.add(tile);
    const tickMat = new THREE.MeshStandardMaterial({ color: 0xb9c3d8, emissive: 0x000000 });
    const tickGeo = i % 5 === 0 ? tickGeoLong : tickGeoShort; // long tick every 5, like a ruler
    const leftTick = new THREE.Mesh(tickGeo, tickMat);
    leftTick.position.set(-5.6, 0.14, baseZ);
    const rightTick = new THREE.Mesh(tickGeo, tickMat);
    rightTick.position.set(5.6, 0.14, baseZ);
    trackGroup.add(leftTick, rightTick);
    trackTiles.push({ mat, tickMat, baseZ });
  }
  scene.add(trackGroup);
}
let trackScroll = 0;
const floorFx = []; // { type: 'ripple' | 'flash' | 'crack', t, color }

function floorRipple(colorHex) { floorFx.push({ type: 'ripple', t: 0, color: new THREE.Color(colorHex) }); }
function floorFlash(colorHex) { floorFx.push({ type: 'flash', t: 0, color: new THREE.Color(colorHex) }); }
function floorCrack() { floorFx.push({ type: 'crack', t: 0, color: new THREE.Color(0xff5a76) }); }

const tickColorScratch = new THREE.Color();
function updateFloor(dt, flow) {
  trackScroll = (trackScroll + flow * dt) % TRACK_TILE_LEN;
  trackGroup.position.z = trackScroll;
  for (let i = floorFx.length - 1; i >= 0; i--) {
    const fx = floorFx[i];
    fx.t += dt;
    const life = fx.type === 'ripple' ? 3.2 : fx.type === 'flash' ? 0.35 : 1.2;
    if (fx.t > life) floorFx.splice(i, 1);
  }
  const wallZ = wall ? wall.z : null;
  const matched = game.current === game.target;
  const inPerfectWindow = wall ? (PLAYER_Z - wall.z) / game.spawnDist <= PERFECT_WINDOW : false;
  for (const t of trackTiles) {
    const z = t.baseZ + trackScroll;
    // faint shimmer travelling down the lane keeps the floor alive
    const sh = Math.max(0, Math.sin(z * 0.22 + elapsed * 2.2)) * 0.035;
    // laneGlow: warm self-illumination after dark, so the runway reads as a lit path
    let r = sh + laneGlow, g = sh + laneGlow * 0.92, b = sh * 1.2 + laneGlow * 0.75;
    for (const fx of floorFx) {
      let k = 0;
      if (fx.type === 'ripple') {
        const front = PLAYER_Z - fx.t * 55; // races from the player toward the horizon
        k = Math.max(0, 1 - Math.abs(z - front) / 7) * Math.max(0, 1 - fx.t / 3.2) * 0.9;
      } else if (fx.type === 'flash') {
        k = Math.max(0, 1 - Math.abs(z - PLAYER_Z) / 4) * Math.max(0, 1 - fx.t / 0.35) * 0.7;
      } else { // crack
        k = Math.max(0, 1 - Math.abs(z - PLAYER_Z) / 8) * Math.max(0, 1 - fx.t / 1.2) * 0.8;
      }
      r += fx.color.r * k; g += fx.color.g * k; b += fx.color.b * k;
    }
    t.mat.emissive.setRGB(Math.min(r, 1.2), Math.min(g, 1.2), Math.min(b, 1.2));
    // fuse gauge: ticks between the wall and the player are lit
    if (wallZ !== null && z > wallZ && z < PLAYER_Z + 2) {
      tickColorScratch.setHex(matched ? 0x3ecf8e : inPerfectWindow ? 0xff5a76 : 0xffb14f);
      const pulse = inPerfectWindow && !matched ? 0.75 + Math.sin(elapsed * 10) * 0.35 : 1;
      t.tickMat.emissive.copy(tickColorScratch).multiplyScalar(1.1 * pulse);
      t.tickMat.color.setHex(0xffffff);
    } else {
      t.tickMat.emissive.setRGB(0, 0, 0);
      t.tickMat.color.setHex(0xb9c3d8);
    }
  }
}

const trackBody = new THREE.Mesh(
  new THREE.BoxGeometry(13.6, 1.8, 440),
  new THREE.MeshStandardMaterial({ color: 0xeef1f8, roughness: 0.85 })
);
trackBody.position.set(0, -0.91, -180);
trackBody.material.color.setHex(0xe9eef8);
trackBody.material.roughness = 0.78;
scene.add(trackBody);

// city floor far below the runway — tinted by the wave theme
const floorMat = new THREE.MeshStandardMaterial({ color: 0xf2f5fa, roughness: 1 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(320, 520), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, -1.8, -180);
floor.material.color.setHex(0xe9f0fa);
floor.material.roughness = 0.86;
floor.receiveShadow = true;
scene.add(floor);

// ----- Bright curbs along the lane edges -----------------------------------------
const curbMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.1 });
{
  const curbGeo = new THREE.BoxGeometry(0.55, 0.3, 440);
  for (const side of [-1, 1]) {
    const curb = new THREE.Mesh(curbGeo, curbMat);
    curb.position.set(side * 6.65, 0.14, -180);
    scene.add(curb);
  }
}

// ----- Procedural landscape: rolling terrain + rock spires, treadmill tiles ------
// Real 3D scenery far below the floating runway. The height function is
// periodic over the tile length, so the two recycling tiles join seamlessly.
const TILE_LEN = 120;
const envMats = {
  terrain: new THREE.MeshStandardMaterial({ color: 0xaacfae, roughness: 1, flatShading: true }),
  spire: new THREE.MeshStandardMaterial({ roughness: 0.7, flatShading: true }),
};

function terrainHeight(x, zz) { // zz ∈ [0, TILE_LEN), periodic in z
  const t = (zz / TILE_LEN) * Math.PI * 2;
  const sideMask = THREE.MathUtils.smoothstep(Math.abs(x), 14, 44); // flat corridor under the lane
  return sideMask * (
    Math.sin(t * 3 + x * 0.11) * 1.7 +
    Math.sin(t * 5 + x * 0.045 + 2.1) * 1.2 +
    (Math.sin(x * 0.09) + Math.sin(x * 0.041 + 1.3)) * 1.6
  );
}

function buildEnvTile() {
  const g = new THREE.Group();

  const geo = new THREE.PlaneGeometry(360, TILE_LEN, 72, 24);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const zz = ((pos.getZ(i) + TILE_LEN / 2) % TILE_LEN + TILE_LEN) % TILE_LEN;
    pos.setY(i, terrainHeight(x, zz));
  }
  geo.computeVertexNormals();
  const terrain = new THREE.Mesh(geo, envMats.terrain);
  terrain.position.y = -6.5;
  terrain.receiveShadow = true;
  g.add(terrain);

  // tapered spires standing on the hills
  const spires = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 6), envMats.spire, 46);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  for (let i = 0; i < 46; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * (20 + Math.random() * 58);
    const zLocal = -TILE_LEN / 2 + Math.random() * TILE_LEN;
    const zz = (zLocal + TILE_LEN / 2) % TILE_LEN;
    const r = 1.6 + Math.random() * 3.4;
    const h = 7 + Math.random() * 16;
    m.makeScale(r, h, r);
    m.setPosition(x, -6.5 + terrainHeight(x, zz) + h / 2 - 0.6, zLocal);
    spires.setMatrixAt(i, m);
    spires.setColorAt(i, col.setHex(COL.city[i % COL.city.length]));
  }
  g.add(spires);
  return g;
}
const cityTiles = [buildEnvTile(), buildEnvTile()];
cityTiles[0].position.z = 0;
cityTiles[1].position.z = -TILE_LEN;
scene.add(cityTiles[0], cityTiles[1]);

// ----- Floating decorations (drift above the city) ------------------------------
const decos = [];
{
  const geos = [
    new THREE.IcosahedronGeometry(1, 0),
    new THREE.DodecahedronGeometry(1, 0),
    new THREE.SphereGeometry(0.9, 20, 16),
    new THREE.OctahedronGeometry(1, 0),
    new THREE.BoxGeometry(1.2, 1.2, 1.2),
  ];
  for (let i = 0; i < 16; i++) {
    const mesh = new THREE.Mesh(
      geos[i % geos.length],
      new THREE.MeshStandardMaterial({ color: COL.city[i % COL.city.length], roughness: 0.55 })
    );
    const side = i % 2 === 0 ? 1 : -1;
    mesh.position.set(side * (9 + Math.random() * 16), 5 + Math.random() * 7, -Math.random() * 180);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    mesh.castShadow = true;
    mesh.userData.spin = (Math.random() - 0.5) * 0.8;
    scene.add(mesh);
    decos.push(mesh);
  }
}
decos.forEach(deco => { deco.visible = false; });

// ----- Ethereal atmosphere: horizon glow, clouds, mist, sun streak ----------------
function makeGlowTexture(size = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,244,224,0.55)');
  grad.addColorStop(1, 'rgba(255,244,224,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function makeCloudTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const puffs = [[70, 80, 45], [120, 66, 55], [180, 82, 42], [95, 92, 35], [150, 95, 40], [210, 95, 28], [45, 95, 26]];
  for (const [x, y, r] of puffs) {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.95)');
    grad.addColorStop(0.7, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 128);
  }
  return new THREE.CanvasTexture(c);
}

// "walking into the light": a large additive sun glow at the vanishing point
const horizonGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(),
  transparent: true,
  opacity: 0.95,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
}));
horizonGlow.material.fog = false;
horizonGlow.material.opacity = 0.85;
horizonGlow.material.color.setHex(0xffca8f);
horizonGlow.position.set(0, 7, -228);
horizonGlow.scale.set(85, 55, 1);
scene.add(horizonGlow); // the sun: arcs, tints, and fades with the time of day

// the moon rises off-center as the sun sets
const moon = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(128),
  transparent: true,
  opacity: 0,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
}));
moon.material.fog = false;
moon.material.color.setHex(0xdfe8ff);
moon.position.set(26, 24, -226);
moon.scale.set(22, 22, 1);
scene.add(moon);

// star field on the upper dome, fading in through twilight
const stars = (() => {
  const n = 260;
  const posArr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const az = Math.random() * Math.PI * 2;
    const el = (0.06 + Math.random() * 0.82) * Math.PI / 2;
    const r = 226;
    posArr[i * 3] = r * Math.cos(el) * Math.sin(az);
    posArr[i * 3 + 1] = r * Math.sin(el);
    posArr[i * 3 + 2] = -r * Math.cos(el) * Math.cos(az);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.6,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  mat.fog = false;
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  return pts;
})();

const cloudTex = makeCloudTexture();
const skyClouds = [];
const mistClouds = [];
for (let i = 0; i < 12; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.55 + Math.random() * 0.3, depthWrite: false }));
  const side = i % 2 === 0 ? 1 : -1;
  sp.position.set(side * (12 + Math.random() * 60), 12 + Math.random() * 18, -30 - Math.random() * 200);
  const s = 18 + Math.random() * 26;
  sp.scale.set(s, s * 0.45, 1);
  scene.add(sp);
  sp.material.color.setHex(i % 3 === 0 ? 0xffe8d7 : 0xffffff);
  skyClouds.push(sp);
}
// low cloud sea drifting over the terrain, between the spires
for (let i = 0; i < 10; i++) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.3 + Math.random() * 0.2, depthWrite: false }));
  const side = i % 2 === 0 ? 1 : -1;
  sp.position.set(side * (12 + Math.random() * 34), -3 + Math.random() * 2.4, -Math.random() * 180);
  const s = 14 + Math.random() * 16;
  sp.scale.set(s, s * 0.4, 1);
  scene.add(sp);
  sp.material.color.setHex(0xdcecff);
  mistClouds.push(sp);
}

// glossy sun reflection streak down the middle of the lane
const streak = new THREE.Mesh(
  new THREE.PlaneGeometry(3.4, 100),
  new THREE.MeshBasicMaterial({
    map: makeGlowTexture(128),
    transparent: true,
    opacity: 0.12,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
);
streak.rotation.x = -Math.PI / 2;
streak.position.set(0, 0.12, -55);
scene.add(streak);
streak.visible = false;

// ----- Ambient sparkle field over the lane ---------------------------------------
const sparkles = (() => {
  const count = 130;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 30;
    pos[i * 3 + 1] = 0.5 + Math.random() * 9;
    pos[i * 3 + 2] = 12 - Math.random() * 170;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 0.14,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(geo, mat);
  scene.add(pts);
  return pts;
})();
sparkles.visible = false;

// ----- The player character (a 3D number) --------------------------------------
let font = null;
loadFont().then(f => {
  font = f;
  setPlayerNumberVisual(game.current);
  cardPop = 0;
});

const playerMat = new THREE.MeshPhysicalMaterial({
  color: 0x2f6bff,
  roughness: 0.22,
  metalness: 0.1,
  clearcoat: 0.8,
  clearcoatRoughness: 0.25,
  envMap: envTex,
  envMapIntensity: 0.7,
});
const player = new THREE.Group();
let numberMesh = null;
const blob = new THREE.Mesh(
  new THREE.CircleGeometry(1.3, 32),
  new THREE.MeshBasicMaterial({ color: 0x2b3a55, transparent: true, opacity: 0.11 })
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
    numberMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  numberMesh = makeNumberGroup(font, String(n), playerMat, NUMBER_SIZE);
  player.add(numberMesh);
  cardPop = 1;
}

// ----- HUD / UI refs -----------------------------------------------------------
const $ = id => document.getElementById(id);
const hud = $('hud');
const opsBar = $('ops');
const powersBar = $('powers');
const scoreVal = $('score-val');
const waveChip = $('wave-chip');
const waveFill = $('wave-fill');
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
let wall = null;    // active wall entry: { obj, puzzle, solvedIndex, boss, z }
let queue = [];     // upcoming wall entries, nearest first
let passed = [];    // resolved walls sliding out behind the camera
const opHistory = []; // values before each press, for the Undo power-up

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
  spawnDist: 100,
  matchFrac: 1, // fraction of approach remaining when the match was made
  speed: BASE_SPEED,
  betweenTimer: 0,
  shake: 0,
  lunge: 0,
  knock: 0,
  paused: false,
  power: { slow: 2, undo: 2, skip: 1 },
  slowTimer: 0,
};
window.__game = game; // debug handle

// ----- Time-of-day cycle: Morning → Day → Sunset → Twilight → Night, forever ----
// One keyframe table drives the whole procedural world: sky-dome stops, the
// sun's height/color, moon and stars, cloud and terrain tints, fog, lighting,
// and the night-time lane glow. Phase advances with distance travelled, so
// the sky doubles as a progress clock.
const PERIODS = [
  { name: 'Morning',  zenith: 0x4f92e0, mid: 0x9ec7ef, horizon: 0xffe2b8, fog: 0xf2e0c8, terrain: 0xaacfae, cloud: 0xfff0dc,
    sun: 0xffd9a8, sunI: 1.2,  hemiI: 1.0,  lane: 0,
    sunY: 7,   sunCol: 0xffca8f, sunO: 0.85, moonY: 8,  moonO: 0, starO: 0 },
  { name: 'Day',      zenith: 0x2c6fd1, mid: 0x6fb0ea, horizon: 0xd8eefb, fog: 0xdceaf6, terrain: 0x9ccf9f, cloud: 0xffffff,
    sun: 0xfff2dd, sunI: 1.4,  hemiI: 1.1,  lane: 0,
    sunY: 34,  sunCol: 0xfff4da, sunO: 0.7,  moonY: 8,  moonO: 0, starO: 0 },
  { name: 'Sunset',   zenith: 0x5b4a9e, mid: 0xb96e93, horizon: 0xff9b4a, fog: 0xeda06b, terrain: 0x9c8f7e, cloud: 0xffc7a0,
    sun: 0xff9a5c, sunI: 1.25, hemiI: 0.85, lane: 0.02,
    sunY: 5.5, sunCol: 0xff8f3d, sunO: 1.0,  moonY: 10, moonO: 0, starO: 0.12 },
  { name: 'Twilight', zenith: 0x222a58, mid: 0x45487f, horizon: 0xa88bc0, fog: 0x9187b4, terrain: 0x5c6187, cloud: 0x9089b8,
    sun: 0xa48fdc, sunI: 0.9,  hemiI: 0.7,  lane: 0.05,
    sunY: -6,  sunCol: 0xc887b8, sunO: 0.35, moonY: 14, moonO: 0.55, starO: 0.7 },
  { name: 'Night',    zenith: 0x080d24, mid: 0x171f44, horizon: 0x2e3763, fog: 0x333b64, terrain: 0x353c63, cloud: 0x3f4a78,
    sun: 0x93a7ff, sunI: 0.65, hemiI: 0.55, lane: 0.09,
    sunY: -20, sunCol: 0x93a7ff, sunO: 0,    moonY: 30, moonO: 1, starO: 1 },
];
const PERIOD_DIST = 340; // world units of travel per period (~20s at cruise speed)
let timePhase = 0;       // 0..5, wraps forever
let laneGlow = 0;        // tile self-illumination, rises after dark for readability

// the terrain is the ground now; the flat floor plane stays retired
floor.visible = false;

const periodColA = new THREE.Color();
const periodColB = new THREE.Color();
const cloudTint = new THREE.Color();
function lerpHex(aHex, bHex, t) {
  return periodColA.setHex(aHex).lerp(periodColB.setHex(bHex), t);
}

function updatePeriod(flowDist) {
  timePhase = (timePhase + flowDist / PERIOD_DIST) % PERIODS.length;
  const i = Math.floor(timePhase);
  const j = (i + 1) % PERIODS.length;
  const t = THREE.MathUtils.smoothstep(timePhase - i, 0.72, 1); // hold, then blend into next
  const a = PERIODS[i], b = PERIODS[j];
  const L = (ka, kb) => THREE.MathUtils.lerp(ka, kb, t);

  // sky dome
  skyMat.uniforms.zenith.value.copy(lerpHex(a.zenith, b.zenith, t));
  skyMat.uniforms.mid.value.copy(lerpHex(a.mid, b.mid, t));
  skyMat.uniforms.horizon.value.copy(lerpHex(a.horizon, b.horizon, t));
  // lighting — the scenery itself is lit by the time of day
  sun.color.copy(lerpHex(a.sun, b.sun, t));
  sun.intensity = L(a.sunI, b.sunI);
  ambientLight.intensity = L(a.hemiI, b.hemiI);
  scene.fog.color.copy(lerpHex(a.fog, b.fog, t));
  // scenery tints
  envMats.terrain.color.copy(lerpHex(a.terrain, b.terrain, t));
  cloudTint.copy(lerpHex(a.cloud, b.cloud, t));
  envMats.spire.color.copy(cloudTint);
  for (const cl of skyClouds) cl.material.color.copy(cloudTint);
  for (const cl of mistClouds) cl.material.color.copy(cloudTint);
  // celestial bodies
  horizonGlow.position.y = L(a.sunY, b.sunY);
  horizonGlow.material.color.copy(lerpHex(a.sunCol, b.sunCol, t));
  horizonGlow.material.opacity = L(a.sunO, b.sunO);
  moon.position.y = L(a.moonY, b.moonY);
  moon.material.opacity = L(a.moonO, b.moonO);
  stars.material.opacity = L(a.starO, b.starO);
  laneGlow = L(a.lane, b.lane);
}
window.__setPhase = p => { timePhase = p; }; // debug: jump the time-of-day clock

function wave() { return waveAt(game.solved); }
function wallInWave() { return (game.solved % WAVE_SIZE) + 1; }
function isBossWall() { return wall ? wall.boss : false; }
// Retain only a barely perceptible distance fade; the lane should read edge to edge.
scene.fog.near = 165;
scene.fog.far = 340;

function waveAt(s) { return Math.floor(s / WAVE_SIZE) + 1; }
function bossAt(s) { return game.mode !== 'daily' && s % WAVE_SIZE === WAVE_SIZE - 1; }
function speedAt(w) { return BASE_SPEED + Math.min((w - 1) * 0.9, MAX_EXTRA_SPEED); }
function budgetFor(puzzle, s) {
  return Math.max(MIN_TIME_BUDGET, BASE_TIME_BUDGET - (waveAt(s) - 1) * 0.45)
    + (puzzle.steps - 1) * STEP_BONUS_TIME
    + (bossAt(s) ? 1 : 0);
}

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
    waveFill.style.width = `${Math.round((game.solved / DAILY_WALLS) * 100)}%`;
  } else {
    waveChip.textContent = `WAVE ${wave()}${isBossWall() ? ' · BOSS' : ''}`;
    waveFill.style.width = `${Math.round(((game.solved % WAVE_SIZE) / WAVE_SIZE) * 100)}%`;
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
  setWallMatchGlow(wall ? wall.obj : null, matched);
}

const OP_CLASS = { '+': 'op-add', '−': 'op-sub', '×': 'op-mul', '÷': 'op-div' };

function renderButtons() {
  opsBar.innerHTML = '';
  game.buttons.forEach((op, i) => {
    const btn = document.createElement('button');
    btn.className = 'op-btn ' + (isExotic(op) ? 'gold' : (OP_CLASS[op.sym] || ''));
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

function recordMatchTiming(wasMatched) {
  if (game.current === game.target && wall) {
    game.matchFrac = (PLAYER_Z - wall.z) / game.spawnDist;
    if (!wasMatched) {
      sfx.match();
      spawnBurst(player.position.clone(), COL.good, 24, 5);
    }
  }
}

function pressOp(i) {
  if (game.state !== 'playing' || game.paused) return;
  const op = game.buttons[i];
  if (!op || !opValid(game.current, op)) return;
  ensureAudio();
  const wasMatched = game.current === game.target;
  opHistory.push(game.current);
  if (opHistory.length > 12) opHistory.shift();
  game.current = applyOp(game.current, op);
  if (op.uses !== undefined) op.uses -= 1; // exotic ops are single-use per wall
  setPlayerNumberVisual(game.current);
  sfx.press();
  floorFlash(0x8b7cf8);
  recordMatchTiming(wasMatched);
  const el = opsBar.children[i];
  if (el) { el.classList.add('pressed'); setTimeout(() => el.classList.remove('pressed'), 120); }
  refreshButtonStates();
  updateHUD();
}

// ----- Power-ups ------------------------------------------------------------------
function updatePowerUI() {
  for (const kind of ['slow', 'undo', 'skip']) {
    $(`pw-${kind}-n`).textContent = `×${game.power[kind]}`;
    $(`pw-${kind}`).disabled = game.power[kind] <= 0;
  }
}

function usePower(kind) {
  if (game.state !== 'playing' || game.paused || game.power[kind] <= 0) return;
  ensureAudio();
  if (kind === 'slow') {
    game.power.slow -= 1;
    game.slowTimer = SLOW_DURATION;
    flashScreen('#8fb7ff', 0.2);
    floorRipple(0x8fb7ff);
    sfx.slow();
  } else if (kind === 'undo') {
    if (!opHistory.length) return;
    game.power.undo -= 1;
    const wasMatched = game.current === game.target;
    game.current = opHistory.pop();
    setPlayerNumberVisual(game.current);
    sfx.press();
    recordMatchTiming(wasMatched);
    refreshButtonStates();
    updateHUD();
  } else if (kind === 'skip') {
    if (!wall) return;
    game.power.skip -= 1;
    // safely blow up the incoming wall: no points, no heart lost, combo kept
    spawnWallDebris(wall.z, HOLE_Y, WALL_HEIGHT, wall.obj.tint);
    disposeWall(scene, wall.obj);
    wall = null;
    clearQueue();
    game.shake = 0.7;
    sfx.skip();
    floorRipple(0xffd166);
    flashScreen('#ffd166', 0.25);
    game.state = 'between';
    game.betweenTimer = 0.6;
  }
  updatePowerUI();
}

$('pw-slow').addEventListener('click', () => usePower('slow'));
$('pw-undo').addEventListener('click', () => usePower('undo'));
$('pw-skip').addEventListener('click', () => usePower('skip'));

window.addEventListener('keydown', e => {
  if ((e.key === 'Escape' || e.key === 'p' || e.key === 'P') &&
      (game.state === 'playing' || game.state === 'between')) {
    setPaused(!game.paused);
    return;
  }
  if (game.state === 'playing' && !game.paused) {
    const i = ['1', '2', '3', '4'].indexOf(e.key);
    if (i >= 0) { pressOp(i); return; }
    const pw = { q: 'slow', w: 'undo', e: 'skip' }[e.key.toLowerCase()];
    if (pw) usePower(pw);
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
  clearAllWalls();
  hud.classList.remove('visible');
  opsBar.classList.remove('visible');
  powersBar.classList.remove('visible');
  refreshMenuBests();
  menuScreen.classList.remove('hidden');
});

// ----- Wall queue lifecycle ---------------------------------------------------------
function makeEntry(value, s) {
  const boss = bossAt(s);
  const puzzle = makePuzzle(value, { wave: waveAt(s), boss, rng: game.rng });
  const obj = buildWall(font, puzzle.target, { boss, tint: WALL_TINTS[s % WALL_TINTS.length] });
  return { obj, puzzle, solvedIndex: s, boss, z: 0 };
}

function clearQueue() {
  for (const q of queue) disposeWall(scene, q.obj);
  queue = [];
}

function clearAllWalls() {
  if (wall) { disposeWall(scene, wall.obj); wall = null; }
  clearQueue();
  for (const p of passed) disposeWall(scene, p.obj);
  passed = [];
}

// Build the active wall plus QUEUE_AHEAD upcoming walls. Upcoming puzzles are
// generated from each wall's own target: after a pass the number always equals
// that target, so the future is deterministic until a crash rewrites it.
function spawnWalls() {
  if (wall) { disposeWall(scene, wall.obj); wall = null; }
  clearQueue();
  let value = game.current;
  let z = PLAYER_Z;
  const entries = [];
  for (let k = 0; k <= QUEUE_AHEAD; k++) {
    const s = game.solved + k;
    const e = makeEntry(value, s);
    z -= speedAt(waveAt(s)) * budgetFor(e.puzzle, s);
    e.z = z;
    e.obj.group.position.z = z;
    scene.add(e.obj.group);
    entries.push(e);
    value = e.puzzle.target;
  }
  activate(entries.shift());
  queue = entries;
  game.state = 'playing';
}

function activate(entry) {
  wall = entry;
  game.target = entry.puzzle.target;
  game.buttons = entry.puzzle.buttons;
  game.matchFrac = 1;
  game.spawnDist = Math.max(PLAYER_Z - entry.z, 1);
  game.speed = speedAt(waveAt(entry.solvedIndex));
  opHistory.length = 0;
  if (entry.boss) { showBanner('BOSS WALL!'); sfx.boss(); }
  else if (entry.solvedIndex > 0 && entry.solvedIndex % WAVE_SIZE === 0 && game.mode !== 'daily') {
    showBanner(`WAVE ${waveAt(entry.solvedIndex)}`);
    sfx.wave();
  }
  renderButtons();
  updateHUD();
}

function extendQueue() {
  const tail = queue.length ? queue[queue.length - 1] : wall;
  const s = tail.solvedIndex + 1;
  const e = makeEntry(tail.puzzle.target, s);
  e.z = tail.z - speedAt(waveAt(s)) * budgetFor(e.puzzle, s);
  e.obj.group.position.z = e.z;
  scene.add(e.obj.group);
  queue.push(e);
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
    floorRipple(perfect ? 0xffd166 : 0x3ecf8e); // gold ripple for a PERFECT
    spawnBurst(new THREE.Vector3(0, HOLE_Y, PLAYER_Z), COL.good, 80, 11);
    game.lunge = 1; // the number dives through the hole
    if (game.combo >= 2) {
      comboPop.textContent = `COMBO ×${game.combo}!`;
      comboPop.classList.add('show');
      setTimeout(() => comboPop.classList.remove('show'), 900);
    }
    if (wall.boss) {
      // bosses restock the power-ups
      for (const k of ['slow', 'undo', 'skip']) game.power[k] = Math.min(game.power[k] + 1, 3);
      updatePowerUI();
    }
    passed.push(wall);
    wall = null;
    if (game.mode === 'daily' && game.solved >= DAILY_WALLS) {
      updateHUD();
      endGame('complete');
      return;
    }
    extendQueue();
    activate(queue.shift());
  } else {
    // ---- CRASH ----
    game.combo = 0;
    game.knock = 1; // the number bounces off the wall
    sfx.fail();
    floorCrack();
    flashScreen('#ff5a76', 0.45);
    spawnBurst(player.position.clone(), COL.bad, 90, 13);
    if (wall.boss) {
      // reinforced: it doesn't break — it barrels through and hits harder
      game.shake = 1.4;
      passed.push(wall);
    } else {
      game.shake = 1;
      spawnWallDebris(wall.z, HOLE_Y, WALL_HEIGHT, wall.obj.tint);
      disposeWall(scene, wall.obj);
    }
    wall = null;
    clearQueue(); // the future assumed success; rebuild it from reality
    if (game.mode === 'time') {
      game.timeLeft -= CRASH_TIME_PENALTY;
      if (game.timeLeft <= 0) { updateHUD(); endGame('time'); return; }
    } else {
      game.lives -= 1;
      if (game.lives <= 0) { updateHUD(); endGame('crash'); return; }
    }
    game.state = 'between';
    game.betweenTimer = 1.4;
    updateHUD();
  }
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
  game.power = { slow: 2, undo: 2, skip: 1 };
  game.slowTimer = 0;
  timePhase = 0; // every run begins at Morning and lives a fresh day
  clearFX();     // no leftover debris or particles from the previous run
  floorFx.length = 0; // and no lingering floor ripples/cracks
  game.current = randStart(game.rng);
  setPlayerNumberVisual(game.current);
  cardPop = 0;
  menuScreen.classList.add('hidden');
  gameoverScreen.classList.add('hidden');
  hud.classList.add('visible');
  opsBar.classList.add('visible');
  powersBar.classList.add('visible');
  clearAllWalls();
  spawnWalls();
  updatePowerUI();
  if (mode !== 'daily') { showBanner('WAVE 1'); sfx.wave(); }
}
window.__start = startGame; // debug handle

function endGame(reason) {
  game.state = 'gameover';
  clearAllWalls();
  hud.classList.remove('visible');
  opsBar.classList.remove('visible');
  powersBar.classList.remove('visible');
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
const bubblePos = new THREE.Vector3(); // scratch for the equation speech bubble
let elapsed = 0;
let settle = 1; // 1 = free idle bob, 0 = locked dead-center to thread the cutout
let lastTickSecond = -1;

function animate() {
  requestAnimationFrame(animate);
  // dt = 0 while paused: keep rendering, freeze all motion and timers
  const rawDt = clock.getDelta();
  const dt = game.paused ? 0 : Math.min(rawDt, 0.05);
  elapsed += dt;

  // Slow Time power-up: the whole world drops into bullet-time
  if (game.slowTimer > 0) game.slowTimer = Math.max(0, game.slowTimer - dt);
  const factor = game.slowTimer > 0 ? SLOW_FACTOR : 1;

  // scrolling track + treadmill world sell forward motion
  const running = game.state === 'playing' || game.state === 'between';
  const flow = (running ? game.speed : 6) * factor;
  updateFloor(dt, flow);
  for (const tile of cityTiles) {
    tile.position.z += flow * dt;
    if (tile.position.z > TILE_LEN) tile.position.z -= 2 * TILE_LEN;
  }
  for (const d of decos) {
    d.position.z += flow * dt * 0.9;
    d.rotation.y += d.userData.spin * dt;
    d.rotation.x += d.userData.spin * 0.6 * dt;
    if (d.position.z > 15) d.position.z -= 200;
  }
  // clouds drift past with parallax; mist hugs the ground and moves with the world
  for (const cl of skyClouds) {
    cl.position.z += flow * dt * 0.15;
    if (cl.position.z > 20) cl.position.z -= 260;
  }
  for (const cl of mistClouds) {
    cl.position.z += flow * dt * 0.85;
    if (cl.position.z > 18) cl.position.z -= 200;
  }
  // sparkles drift past with the world
  {
    const arr = sparkles.geometry.attributes.position.array;
    for (let i = 0; i < arr.length; i += 3) {
      arr[i + 2] += flow * dt;
      if (arr[i + 2] > 12) arr[i + 2] -= 170;
    }
    sparkles.geometry.attributes.position.needsUpdate = true;
  }

  // time attack clock
  if (game.mode === 'time' && running) {
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
  const settleTarget = wall ? THREE.MathUtils.clamp(((PLAYER_Z - wall.z) - 4) / 10, 0, 1) : 1;
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

  // conveyor: active wall + queue advance together
  if (game.state === 'playing' && wall) {
    const adv = game.speed * factor * dt;
    wall.z += adv;
    wall.obj.group.position.z = wall.z;
    for (const q of queue) {
      q.z += adv;
      q.obj.group.position.z = q.z;
    }
    // glow reads as a sign from afar, fades so the cutout shows as a real hole up close
    const dist = PLAYER_Z - wall.z;
    wall.obj.glowMat.opacity = wall.obj.glowBase * THREE.MathUtils.clamp((dist - 6) / 24, 0.3, 1);
    if (wall.z >= PLAYER_Z - 0.6) onWallReached();
  } else if (game.state === 'between') {
    game.betweenTimer -= dt;
    if (game.betweenTimer <= 0) spawnWalls();
  }

  // resolved walls keep sliding out behind the camera
  for (let i = passed.length - 1; i >= 0; i--) {
    const p = passed[i];
    p.z += game.speed * factor * dt;
    p.obj.group.position.z = p.z;
    if (p.z > 25) {
      disposeWall(scene, p.obj);
      passed.splice(i, 1);
    }
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

  // equation chip rides above the number's head like a speech bubble,
  // so the character itself is never covered by UI
  bubblePos.set(player.position.x, player.position.y + 2.0, player.position.z).project(camera);
  equation.style.left = `${(bubblePos.x * 0.5 + 0.5) * window.innerWidth}px`;
  equation.style.top = `${(-bubblePos.y * 0.5 + 0.5) * window.innerHeight - 10}px`;

  updatePeriod(flow * dt);
  updateFX(dt);
  composer.render();
}
animate();
