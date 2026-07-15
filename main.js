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
let studioScene = null;
let studioCamera = null;

// ----- Post-processing: soft bloom on glows -----------------------------------
const composer = new EffectComposer(renderer);
const renderPass = new RenderPass(scene, camera);
composer.addPass(renderPass);
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
  if (studioCamera) {
    studioCamera.aspect = window.innerWidth / window.innerHeight;
    studioCamera.updateProjectionMatrix();
  }
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
  layoutPreviewNumber();
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
// Calm floor: a near-uniform matte surface. The only permanent markings are
// two thin edge strips whose lit segments join into one continuous fuse line
// while a wall approaches — all other floor light is transient (ripples,
// press flashes, crash cracks).
const trackTiles = [];
const trackGroup = new THREE.Group();
{
  const tileGeo = new THREE.BoxGeometry(12.6, 0.14, TRACK_TILE_LEN - 0.35);
  const stripGeo = new THREE.BoxGeometry(0.18, 0.07, TRACK_TILE_LEN - 0.35);
  for (let i = 0; i < TRACK_TILE_COUNT; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: i % 2 ? 0xf1f3f9 : 0xf4f6fb, // barely-there alternation keeps forward motion readable
      roughness: 0.54,
      envMap: envTex,
      envMapIntensity: 0.08,
    });
    const tile = new THREE.Mesh(tileGeo, mat);
    const baseZ = 16 - i * TRACK_TILE_LEN;
    tile.position.set(0, 0.03, baseZ);
    tile.receiveShadow = true;
    trackGroup.add(tile);
    const tickMat = new THREE.MeshStandardMaterial({ color: 0xe0e6f0, emissive: 0x000000 });
    const leftStrip = new THREE.Mesh(stripGeo, tickMat);
    leftStrip.position.set(-5.95, 0.12, baseZ);
    const rightStrip = new THREE.Mesh(stripGeo, tickMat);
    rightStrip.position.set(5.95, 0.12, baseZ);
    trackGroup.add(leftStrip, rightStrip);
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
    const sh = 0; // shimmer retired — the calm surface lets the number own the frame
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
      t.tickMat.emissive.copy(tickColorScratch).multiplyScalar(1.35 * pulse);
      t.tickMat.color.setHex(0xffffff);
    } else {
      t.tickMat.emissive.setRGB(0, 0, 0);
      t.tickMat.color.setHex(0xe0e6f0); // unlit strips nearly vanish into the floor
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
// ground skirt: a vast plane just beneath the displaced terrain, tinted to a
// fog-blended meadow color each frame — the world never shows a "missing
// ground" band at the terrain tiles' far edge or sides
const floorMat = new THREE.MeshStandardMaterial({ color: 0xa8cbaa, roughness: 1 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), floorMat);
floor.rotation.x = -Math.PI / 2;
// below the terrain's deepest possible valley (base -6.5 minus ~6 of relief),
// so the skirt never slices through a dip and reads as a pond
floor.position.set(0, -13, -180);
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
  terrain: new THREE.MeshStandardMaterial({ color: 0xaacfae, roughness: 1, flatShading: true, vertexColors: true }),
  tuft: new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }),
  flower: new THREE.MeshStandardMaterial({ roughness: 0.7 }),
  rock: new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }),
  trunk: new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true }),
  canopy: new THREE.MeshStandardMaterial({ roughness: 0.85, flatShading: true }),
  // two crystal materials pulsing out of phase, so the glow shimmers across
  // the landscape instead of breathing in unison
  crystalA: new THREE.MeshStandardMaterial({
    roughness: 0.3, metalness: 0.1, flatShading: true,
    emissive: 0x9f8fff, emissiveIntensity: 0,
  }),
  crystalB: new THREE.MeshStandardMaterial({
    roughness: 0.3, metalness: 0.1, flatShading: true,
    emissive: 0x9f8fff, emissiveIntensity: 0,
  }),
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

// ----- Wildlife: subtle background animals that come and go with the day --------
// Every species' opacity is driven by a per-period weight, so each time of day
// has its own inhabitants. All of them live outside the lane corridor.
const wildlifeMats = {
  bird: new THREE.MeshStandardMaterial({ color: 0x4a5568, roughness: 0.8, transparent: true, opacity: 0 }),
  deer: new THREE.MeshStandardMaterial({ color: 0x9c7a5b, roughness: 0.9, transparent: true, opacity: 0 }),
  deerDark: new THREE.MeshStandardMaterial({ color: 0x74573f, roughness: 0.9, transparent: true, opacity: 0 }),
  fox: new THREE.MeshStandardMaterial({ color: 0xd97a3e, roughness: 0.85, transparent: true, opacity: 0 }),
  crystalDeer: new THREE.MeshStandardMaterial({
    color: 0xbfe2ff, roughness: 0.3, flatShading: true,
    emissive: 0x8fd0ff, emissiveIntensity: 0,
    transparent: true, opacity: 0,
  }),
};
const wildlife = []; // { type, group, head?, tail?, phase }
const wildlifeWeights = { bird: 0, deer: 0, fox: 0, cdeer: 0 };

function buildDeer(bodyMat, darkMat, scale, antlerLen) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.85, 0.7), bodyMat);
  body.position.y = 1.05;
  const frontLegs = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.05, 0.55), darkMat);
  frontLegs.position.set(0.55, 0.52, 0);
  const backLegs = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.05, 0.55), darkMat);
  backLegs.position.set(-0.55, 0.52, 0);
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.75, 0.3), bodyMat);
  neck.position.set(0.68, 1.75, 0);
  const head = new THREE.Group();
  head.position.set(0.72, 2.15, 0);
  const skull = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.38, 0.4), bodyMat);
  skull.position.x = 0.12;
  head.add(skull);
  for (const side of [-1, 1]) {
    const antler = new THREE.Mesh(new THREE.BoxGeometry(0.07, antlerLen, 0.07), darkMat);
    antler.position.set(-0.05, antlerLen / 2 + 0.15, side * 0.16);
    antler.rotation.z = -0.35;
    antler.rotation.x = side * 0.3;
    head.add(antler);
  }
  g.add(body, frontLegs, backLegs, neck, head);
  g.scale.setScalar(scale);
  return { group: g, head };
}

function buildFox(scale) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.45, 0.4), wildlifeMats.fox);
  body.position.y = 0.5;
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.35, 0.32), wildlifeMats.deerDark);
  legs.position.y = 0.2;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.34, 0.34), wildlifeMats.fox);
  head.position.set(0.6, 0.72, 0);
  const earL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.06), wildlifeMats.fox);
  earL.position.set(0.62, 0.98, 0.1);
  const earR = earL.clone();
  earR.position.z = -0.1;
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.22, 0.22), wildlifeMats.fox);
  tail.geometry = tail.geometry.clone();
  tail.geometry.translate(-0.37, 0, 0); // swing from the base
  tail.position.set(-0.45, 0.55, 0);
  tail.rotation.z = 0.35;
  g.add(body, legs, head, earL, earR, tail);
  g.scale.setScalar(scale);
  return { group: g, tail };
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
  // hand-painted meadow: valleys richer and cooler, hilltops lighter and
  // sun-dried, with soft irregular patches — a multiplier under the period
  // tint, so the variation survives sunset gold and night navy
  {
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const zz = ((pos.getZ(i) + TILE_LEN / 2) % TILE_LEN + TILE_LEN) % TILE_LEN;
      const hn = THREE.MathUtils.clamp((pos.getY(i) + 4.5) / 9, 0, 1);
      const patch = 0.5 + 0.5 * Math.sin(x * 0.35 + Math.sin(zz * 0.21) * 2.0) * Math.sin(zz * 0.17 + x * 0.05);
      const k = THREE.MathUtils.clamp(hn * 0.65 + patch * 0.35, 0, 1);
      colors[i * 3] = THREE.MathUtils.lerp(0.82, 1.08, k);     // r: dried tops warm up
      colors[i * 3 + 1] = THREE.MathUtils.lerp(0.94, 1.02, k); // g: stays lush
      colors[i * 3 + 2] = THREE.MathUtils.lerp(0.9, 0.78, k);  // b: valleys cooler
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const terrain = new THREE.Mesh(geo, envMats.terrain);
  terrain.position.y = -6.5;
  terrain.receiveShadow = true;
  g.add(terrain);

  // pine groves: trunks + two canopy tiers as parallel instanced meshes,
  // planted in clusters so the forest reads as designed, not sprinkled
  const TREES = 60;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.14, 0.2, 1, 5), envMats.trunk, TREES);
  const lowerTier = new THREE.InstancedMesh(new THREE.ConeGeometry(1.15, 2.2, 6), envMats.canopy, TREES);
  const upperTier = new THREE.InstancedMesh(new THREE.ConeGeometry(0.8, 1.7, 6), envMats.canopy, TREES);
  const m = new THREE.Matrix4();
  const col = new THREE.Color();
  const canopyShades = [0x86b892, 0x74a982, 0x93c49b, 0x7fae8a];
  let ti = 0;
  for (let grove = 0; grove < 10 && ti < TREES; grove++) {
    const side = grove % 2 === 0 ? 1 : -1;
    const gx = side * (21 + Math.random() * 44);
    const gz = -TILE_LEN / 2 + Math.random() * TILE_LEN;
    const n = 4 + Math.floor(Math.random() * 5);
    for (let k = 0; k < n && ti < TREES; k++) {
      const x = gx + (Math.random() - 0.5) * 11;
      if (Math.abs(x) < 17) continue; // never inside the lane corridor
      const zL = gz + (Math.random() - 0.5) * 11;
      const zz = ((zL + TILE_LEN / 2) % TILE_LEN + TILE_LEN) % TILE_LEN;
      const s = 1.1 + Math.random() * 1.6;
      const baseY = -6.5 + terrainHeight(x, zz);
      m.makeScale(s, s, s);
      m.setPosition(x, baseY + 0.5 * s, zL);
      trunks.setMatrixAt(ti, m);
      m.setPosition(x, baseY + 2.0 * s, zL);
      lowerTier.setMatrixAt(ti, m);
      m.setPosition(x, baseY + 3.4 * s, zL);
      upperTier.setMatrixAt(ti, m);
      col.setHex(canopyShades[ti % canopyShades.length]);
      lowerTier.setColorAt(ti, col);
      upperTier.setColorAt(ti, col);
      trunks.setColorAt(ti, col.setHex(0x8a7263));
      ti++;
    }
  }
  // park unused instances out of sight
  m.makeScale(0.001, 0.001, 0.001);
  m.setPosition(0, -60, 0);
  for (let k = ti; k < TREES; k++) {
    trunks.setMatrixAt(k, m);
    lowerTier.setMatrixAt(k, m);
    upperTier.setMatrixAt(k, m);
  }
  g.add(trunks, lowerTier, upperTier);

  // crystal formations jutting from the hills — the world grows the same
  // gem language as the number pieces, and they glow after dark
  const CRYSTALS = 14;
  const crysGeo = new THREE.OctahedronGeometry(1, 0);
  crysGeo.scale(0.6, 1.6, 0.6);
  const crystalsA = new THREE.InstancedMesh(crysGeo, envMats.crystalA, CRYSTALS / 2);
  const crystalsB = new THREE.InstancedMesh(crysGeo, envMats.crystalB, CRYSTALS / 2);
  const gemShades = [0xb9a8f5, 0x9fd8ef, 0xf5b8d9, 0xafecd6];
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), e = new THREE.Euler();
  for (let i = 0; i < CRYSTALS; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * (17 + Math.random() * 40);
    const zL = -TILE_LEN / 2 + Math.random() * TILE_LEN;
    const zz = ((zL + TILE_LEN / 2) % TILE_LEN + TILE_LEN) % TILE_LEN;
    const s = 0.9 + Math.random() * 1.7;
    p.set(x, -6.5 + terrainHeight(x, zz) + s * 1.1, zL);
    q.setFromEuler(e.set((Math.random() - 0.5) * 0.5, Math.random() * Math.PI, (Math.random() - 0.5) * 0.5));
    sv.setScalar(s);
    m.compose(p, q, sv);
    const mesh = i % 2 === 0 ? crystalsA : crystalsB;
    const idx = Math.floor(i / 2);
    mesh.setMatrixAt(idx, m);
    mesh.setColorAt(idx, col.setHex(gemShades[i % gemShades.length]));
  }
  g.add(crystalsA, crystalsB);

  // wildlife on the hills: grazing deer (morning/day), foxes (sunset),
  // and one glowing crystal reindeer that only exists at night
  const placeAnimal = (built, type, minX, spanX) => {
    const side = Math.random() < 0.5 ? 1 : -1;
    const x = side * (minX + Math.random() * spanX);
    const zL = -TILE_LEN / 2 + Math.random() * TILE_LEN;
    const zz = ((zL + TILE_LEN / 2) % TILE_LEN + TILE_LEN) % TILE_LEN;
    built.group.position.set(x, -6.5 + terrainHeight(x, zz), zL);
    built.group.rotation.y = Math.random() * Math.PI * 2;
    g.add(built.group);
    wildlife.push({ type, ...built, phase: Math.random() * 6 });
  };
  for (let i = 0; i < 2; i++) {
    placeAnimal(buildDeer(wildlifeMats.deer, wildlifeMats.deerDark, 1.1 + Math.random() * 0.4, 0.5), 'deer', 19, 20);
    placeAnimal(buildFox(1.0 + Math.random() * 0.3), 'fox', 18, 16);
  }
  placeAnimal(buildDeer(wildlifeMats.crystalDeer, wildlifeMats.crystalDeer, 1.6, 0.85), 'cdeer', 18, 14);

  // grass tufts: dense near the track edges where the eye rests, thinning out
  const TUFTS = 220;
  const tufts = new THREE.InstancedMesh(new THREE.ConeGeometry(0.09, 0.6, 4), envMats.tuft, TUFTS);
  const tuftShades = [0x9fd3a0, 0x8cc490, 0xb2dfa8, 0x86b784];
  for (let i = 0; i < TUFTS; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * (7.5 + Math.pow(Math.random(), 1.7) * 30);
    const zL = -TILE_LEN / 2 + Math.random() * TILE_LEN;
    const zz = ((zL + TILE_LEN / 2) % TILE_LEN + TILE_LEN) % TILE_LEN;
    const s = 0.7 + Math.random() * 0.9;
    m.makeScale(s, s * (0.8 + Math.random() * 0.8), s);
    m.setPosition(x, -6.5 + terrainHeight(x, zz) + 0.24 * s, zL);
    tufts.setMatrixAt(i, m);
    tufts.setColorAt(i, col.setHex(tuftShades[i % tuftShades.length]));
  }
  g.add(tufts);

  // meadow flowers: sparse dots of color through the grass band
  const FLOWERS = 60;
  const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.09, 6, 5), envMats.flower, FLOWERS);
  const petalShades = [0xfff6f8, 0xffd9e8, 0xfff3b8, 0xe8d9ff];
  for (let i = 0; i < FLOWERS; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * (8 + Math.random() * 32);
    const zL = -TILE_LEN / 2 + Math.random() * TILE_LEN;
    const zz = ((zL + TILE_LEN / 2) % TILE_LEN + TILE_LEN) % TILE_LEN;
    const s = 0.7 + Math.random() * 0.8;
    m.makeScale(s, s, s);
    m.setPosition(x, -6.5 + terrainHeight(x, zz) + 0.12, zL);
    flowers.setMatrixAt(i, m);
    flowers.setColorAt(i, col.setHex(petalShades[i % petalShades.length]));
  }
  g.add(flowers);

  // scattered boulders, half-sunk into the hills
  const ROCKS = 8;
  const rocks = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.5, 0), envMats.rock, ROCKS);
  for (let i = 0; i < ROCKS; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = side * (10 + Math.random() * 34);
    const zL = -TILE_LEN / 2 + Math.random() * TILE_LEN;
    const zz = ((zL + TILE_LEN / 2) % TILE_LEN + TILE_LEN) % TILE_LEN;
    p.set(x, -6.5 + terrainHeight(x, zz) + 0.15, zL);
    q.setFromEuler(e.set(Math.random() * 3, Math.random() * 3, Math.random() * 3));
    sv.setScalar(0.5 + Math.random() * 0.9);
    m.compose(p, q, sv);
    rocks.setMatrixAt(i, m);
    rocks.setColorAt(i, col.setHex(i % 2 ? 0xb4b9c6 : 0xc4c8d2));
  }
  g.add(rocks);

  return g;
}
const cityTiles = [buildEnvTile(), buildEnvTile()];
cityTiles[0].position.z = 0;
cityTiles[1].position.z = -TILE_LEN;
scene.add(cityTiles[0], cityTiles[1]);

// ----- Far mountain ridges: three silhouette layers fading into the sky ---------
function makeRidgeGeometry(width, maxH, peaks, seedPhase) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  for (let i = 0; i <= peaks; i++) {
    const x = -width / 2 + (i / peaks) * width;
    const y = i === 0 || i === peaks ? 0 :
      Math.max(maxH * (0.35 + 0.65 * Math.abs(Math.sin(i * 2.4 + seedPhase))) * (0.6 + 0.4 * Math.sin(i * 0.9 + seedPhase * 2)), 3);
    shape.lineTo(x, y);
  }
  shape.lineTo(width / 2, 0);
  shape.closePath();
  return new THREE.ShapeGeometry(shape);
}
const mountainMats = [];
{
  const layers = [
    { z: -165, h: 26, w: 520, peaks: 11 },
    { z: -195, h: 34, w: 620, peaks: 9 },
    { z: -225, h: 44, w: 720, peaks: 7 },
  ];
  layers.forEach((L, k) => {
    const mat = new THREE.MeshBasicMaterial({ fog: false }); // tinted per period instead
    const ridge = new THREE.Mesh(makeRidgeGeometry(L.w, L.h, L.peaks, k * 1.7), mat);
    ridge.position.set(0, -6.5, L.z);
    scene.add(ridge);
    mountainMats.push(mat);
  });
}

// ----- Hot-air balloons drifting far off, lanterns after dark --------------------
const balloons = [];
{
  const canopyGeo = new THREE.SphereGeometry(1, 10, 8);
  canopyGeo.scale(1, 1.15, 1);
  const basketGeo = new THREE.BoxGeometry(0.35, 0.3, 0.35);
  const shades = [0xf5a8b8, 0xa8c8f5, 0xf5d8a0];
  for (let i = 0; i < 3; i++) {
    const grp = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: shades[i], roughness: 0.6, emissive: shades[i], emissiveIntensity: 0 });
    const canopy = new THREE.Mesh(canopyGeo, mat);
    const basket = new THREE.Mesh(basketGeo, new THREE.MeshStandardMaterial({ color: 0x8a7263, roughness: 0.9 }));
    basket.position.y = -1.45;
    grp.add(canopy, basket);
    const side = i % 2 === 0 ? 1 : -1;
    grp.position.set(side * (28 + i * 14), 13 + i * 4, -70 - i * 45);
    grp.scale.setScalar(2.2 + i * 0.5);
    grp.userData.baseY = 13 + i * 4;
    grp.userData.mat = mat;
    scene.add(grp);
    balloons.push(grp);
  }
}

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

// ----- Night magic: aurora ribbons + firefly swarms -------------------------------
// Everything here scales with the star opacity, so it vanishes entirely by day
// and lives off to the sides — Night gets its reward without stealing focus.
function makeAuroraTexture() {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  const v = g.createLinearGradient(0, 0, 0, 128);
  v.addColorStop(0, 'rgba(120,255,214,0)');
  v.addColorStop(0.35, 'rgba(120,255,214,0.55)');
  v.addColorStop(0.7, 'rgba(150,120,255,0.4)');
  v.addColorStop(1, 'rgba(150,120,255,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, 256, 128);
  // soften the horizontal ends
  g.globalCompositeOperation = 'destination-in';
  const hMask = g.createLinearGradient(0, 0, 256, 0);
  hMask.addColorStop(0, 'rgba(0,0,0,0)');
  hMask.addColorStop(0.25, 'rgba(0,0,0,1)');
  hMask.addColorStop(0.75, 'rgba(0,0,0,1)');
  hMask.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = hMask;
  g.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const auroras = [];
{
  const tex = makeAuroraTexture();
  const bands = [
    { x: -45, y: 40, z: -205, w: 230, h: 42, tilt: 0.16 },
    { x: 55, y: 48, z: -215, w: 170, h: 34, tilt: -0.12 },
  ];
  for (const b of bands) {
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    mat.fog = false;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(b.w, b.h), mat);
    mesh.position.set(b.x, b.y, b.z);
    mesh.rotation.z = b.tilt;
    mesh.userData.tilt = b.tilt;
    scene.add(mesh);
    auroras.push(mesh);
  }
}

const fireflySwarms = [];
{
  const swarmDefs = [
    { color: 0xa8f5d8, phase: 0.0, speed: 1.1 },
    { color: 0xffe2a0, phase: 2.1, speed: 0.8 },
    { color: 0xcdb8ff, phase: 4.2, speed: 1.4 },
  ];
  for (const def of swarmDefs) {
    const n = 30;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      pos[i * 3] = side * (13 + Math.random() * 38);
      pos[i * 3 + 1] = -4 + Math.random() * 7;
      pos[i * 3 + 2] = 12 - Math.random() * 170;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = new THREE.PointsMaterial({
      color: def.color,
      size: 0.24,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    mat.fog = false;
    const pts = new THREE.Points(geo, mat);
    pts.userData = def;
    scene.add(pts);
    fireflySwarms.push(pts);
  }
}
let nightAmount = 0; // star opacity mirrored for the animation loop

// ----- Birds: small flapping silhouettes crossing the sky (morning/day) ----------
const birds = [];
{
  const bodyGeo = new THREE.ConeGeometry(0.13, 0.6, 5);
  bodyGeo.rotateZ(-Math.PI / 2); // nose along +x
  const wingGeo = new THREE.BoxGeometry(0.95, 0.045, 0.3);
  wingGeo.translate(0.48, 0, 0); // flap from the shoulder
  for (let i = 0; i < 8; i++) {
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(bodyGeo, wildlifeMats.bird));
    const wingL = new THREE.Mesh(wingGeo, wildlifeMats.bird);
    wingL.rotation.y = Math.PI / 2;
    const wingR = new THREE.Mesh(wingGeo, wildlifeMats.bird);
    wingR.rotation.y = -Math.PI / 2;
    grp.add(wingL, wingR);
    const dir = i % 2 === 0 ? 1 : -1;
    grp.position.set((Math.random() - 0.5) * 120, 13 + Math.random() * 10, -40 - Math.random() * 130);
    grp.scale.setScalar(0.8 + Math.random() * 0.5);
    if (dir < 0) grp.rotation.y = Math.PI;
    grp.userData = { dir, speed: 2.2 + Math.random() * 1.6, phase: Math.random() * 6, wingL, wingR };
    scene.add(grp);
    birds.push(grp);
  }
}

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

// ----- Number style: player-customizable materials (lobby CUSTOMIZE studio) ----
// Extruded numbers have two material groups: [0] faces, [1] beveled sides —
// primary colors the face, secondary the edge.
const MATERIAL_TYPES = {
  glossy: { roughness: 0.22, metalness: 0.1,  clearcoat: 0.8, opacity: 1,    iridescence: 0 },
  matte:  { roughness: 0.95, metalness: 0,    clearcoat: 0,   opacity: 1,    iridescence: 0 },
  metal:  { roughness: 0.28, metalness: 0.95, clearcoat: 0.4, opacity: 1,    iridescence: 0 },
  crystal:{ roughness: 0.08, metalness: 0,    clearcoat: 1,   opacity: 0.75, iridescence: 0 },
  neon:   { roughness: 0.52, metalness: 0,    clearcoat: 0.12,opacity: 1,    iridescence: 0 },
  holo:   { roughness: 0.25, metalness: 0.7,  clearcoat: 0.6, opacity: 1,    iridescence: 1 },
  obsidian:{roughness: 0.18, metalness: 0.72, clearcoat: 0.9, opacity: 1,    iridescence: 0, unlock: 'boss_breaker' },
  prismatic:{roughness:0.16, metalness: 0.48, clearcoat: 1,   opacity: 1,    iridescence: 1, unlock: 'combo_master' },
  masterwork:{roughness:0.2, metalness: 0.84, clearcoat: 1,   opacity: 1,    iridescence: 0.65, unlock: 'collection_complete' },
};
const NUMBER_PRESETS = [
  { id: 'classic',  name: 'Classic',  needs: 0,   style: { primary: '#2f6bff', secondary: '#2456d9', material: 'glossy',  glow: false, trail: 'none' } },
  { id: 'gold',     name: 'Gold',     needs: 0,   style: { primary: '#ffd166', secondary: '#e0a83f', material: 'metal',   glow: false, trail: 'none' } },
  { id: 'neon',     name: 'Neon',     needs: 0,   style: { primary: '#8aff5f', secondary: '#5fd93e', material: 'neon',    glow: true,  trail: 'sparkle' } },
  { id: 'ice',      name: 'Ice',      needs: 150, style: { primary: '#bfe6ff', secondary: '#8fc8f0', material: 'crystal', glow: true,  trail: 'none' } },
  { id: 'holo',     name: 'Holo',     needs: 400, style: { primary: '#d9c8f5', secondary: '#b9a8f0', material: 'holo',    glow: false, trail: 'sparkle' } },
  { id: 'midnight', name: 'Midnight', needs: 800, style: { primary: '#2b3a55', secondary: '#141d33', material: 'glossy',  glow: true,  trail: 'sparkle' } },
];
const DEFAULT_NUMBER_STYLE = Object.freeze({
  primary: '#2f6bff', secondary: '#2456d9', material: 'glossy', glow: false, trail: 'none',
});
const COLOR_PALETTES = [
  { id: 'ocean',    name: 'Ocean',    primary: '#2f6bff', secondary: '#2456d9' },
  { id: 'coral',    name: 'Coral',    primary: '#ff7a59', secondary: '#d95a3c' },
  { id: 'mint',     name: 'Mint',     primary: '#3ecf8e', secondary: '#1fa46b' },
  { id: 'solar',    name: 'Solar',    primary: '#ffd166', secondary: '#e0a83f' },
  { id: 'cosmic',   name: 'Cosmic',   primary: '#9a6ff2', secondary: '#7150c6' },
  { id: 'candy',    name: 'Candy',    primary: '#ff5f8f', secondary: '#d83e70' },
  { id: 'frost',    name: 'Frost',    primary: '#f2f5ff', secondary: '#b9c3d8' },
  { id: 'midnight', name: 'Midnight', primary: '#2b3a55', secondary: '#141d33' },
  { id: 'victory',  name: 'Victory',  primary: '#ff9f43', secondary: '#d9652b', unlock: 'first_steps' },
  { id: 'focus',    name: 'Focus',    primary: '#53d8c8', secondary: '#237f86', unlock: 'perfect_form' },
  { id: 'velocity', name: 'Velocity', primary: '#ff4f81', secondary: '#713cff', unlock: 'time_ace' },
  { id: 'daybreak', name: 'Daybreak', primary: '#ffca6a', secondary: '#ee77a8', unlock: 'daily_devotee' },
  { id: 'scholar',  name: 'Scholar',  primary: '#6f7bf7', secondary: '#302d76', unlock: 'classic_scholar' },
  { id: 'champion', name: 'Champion', primary: '#ffe27a', secondary: '#8b5a20', unlock: 'wall_legend' },
];
const TRAIL_TYPES = {
  none:     { name: 'None', icon: '○' },
  sparkle:  { name: 'Sparkle Trail', icon: '⋆' },
  runic:    { name: 'Runic Trail', icon: '◇', unlock: 'perfect_form' },
  comet:    { name: 'Comet Trail', icon: '☄', unlock: 'time_ace' },
  starfall: { name: 'Starfall Trail', icon: '✦', unlock: 'daily_devotee' },
};

const PROGRESSION_DEFAULTS = Object.freeze({
  totalSolved: 0,
  perfects: 0,
  bosses: 0,
  maxCombo: 0,
  dailyCompletes: 0,
  runs: { classic: 0, time: 0, daily: 0 },
  completedDailyDates: [],
});

function loadProgressionStats() {
  try {
    const saved = JSON.parse(localStorage.getItem('mathwall-progression') || '{}');
    const safeNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;
    return {
      totalSolved: safeNumber(saved.totalSolved),
      perfects: safeNumber(saved.perfects),
      bosses: safeNumber(saved.bosses),
      maxCombo: safeNumber(saved.maxCombo),
      dailyCompletes: safeNumber(saved.dailyCompletes),
      runs: {
        classic: safeNumber(saved.runs?.classic),
        time: safeNumber(saved.runs?.time),
        daily: safeNumber(saved.runs?.daily),
      },
      completedDailyDates: Array.isArray(saved.completedDailyDates)
        ? saved.completedDailyDates.filter(value => typeof value === 'string').slice(-60)
        : [],
    };
  } catch {
    return { ...PROGRESSION_DEFAULTS, runs: { ...PROGRESSION_DEFAULTS.runs }, completedDailyDates: [] };
  }
}

const progressionStats = loadProgressionStats();
const ACHIEVEMENTS = [
  { id: 'first_steps', name: 'First Steps', description: 'Clear 10 walls in any mode.', metric: 'totalSolved', target: 10, icon: 'Ⅰ', reward: 'Victory palette' },
  { id: 'perfect_form', name: 'Perfect Form', description: 'Pass 25 walls with perfect timing.', metric: 'perfects', target: 25, icon: '◎', reward: 'Focus palette + Runic Trail' },
  { id: 'boss_breaker', name: 'Boss Breaker', description: 'Defeat 5 boss walls.', metric: 'bosses', target: 5, icon: '◆', reward: 'Obsidian material' },
  { id: 'combo_master', name: 'Combo Master', description: 'Reach an 8-wall combo.', metric: 'maxCombo', target: 8, icon: '×8', reward: 'Prismatic material' },
  { id: 'time_ace', name: 'Time Ace', description: 'Score 250 in Time Attack.', metric: 'bestTime', target: 250, icon: '⏱', reward: 'Velocity palette + Comet Trail' },
  { id: 'daily_devotee', name: 'Daily Devotee', description: 'Complete 3 different Daily Challenges.', metric: 'dailyCompletes', target: 3, icon: '☀', reward: 'Daybreak palette + Starfall Trail' },
  { id: 'classic_scholar', name: 'Classic Scholar', description: 'Score 800 in Classic mode.', metric: 'bestClassic', target: 800, icon: '∑', reward: 'Scholar palette' },
  { id: 'wall_legend', name: 'Wall Legend', description: 'Clear 100 walls across all modes.', metric: 'totalSolved', target: 100, icon: '★', reward: 'Champion palette' },
];

function achievementValue(achievement) {
  if (achievement.metric === 'bestTime') return Number(localStorage.getItem('mathwall-best-time') || 0);
  if (achievement.metric === 'bestClassic') return Number(localStorage.getItem('mathwall-best-classic') || 0);
  return Number(progressionStats[achievement.metric] || 0);
}

function achievementComplete(id) {
  if (id === 'collection_complete') return ACHIEVEMENTS.every(item => achievementValue(item) >= item.target);
  const achievement = ACHIEVEMENTS.find(item => item.id === id);
  return achievement ? achievementValue(achievement) >= achievement.target : true;
}

function saveProgressionStats() {
  localStorage.setItem('mathwall-progression', JSON.stringify(progressionStats));
}

function componentOwned(component) {
  return !component.unlock || achievementComplete(component.unlock);
}
const COLOR_SWATCHES = [
  { name: 'Ocean Blue', hex: '#2f6bff' }, { name: 'Deep Blue', hex: '#2456d9' },
  { name: 'Coral', hex: '#ff7a59' },      { name: 'Mint', hex: '#3ecf8e' },
  { name: 'Forest', hex: '#1fa46b' },     { name: 'Solar', hex: '#ffd166' },
  { name: 'Gold', hex: '#e0a83f' },       { name: 'Cosmic', hex: '#9a6ff2' },
  { name: 'Candy', hex: '#ff5f8f' },      { name: 'Frost', hex: '#f2f5ff' },
  { name: 'Ink', hex: '#2b3a55' },        { name: 'Midnight', hex: '#141d33' },
];

function loadNumberStyle() {
  try {
    const saved = JSON.parse(localStorage.getItem('mathwall-style') || '{}');
    const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    return {
      primary: validColor(saved.primary) ? saved.primary : DEFAULT_NUMBER_STYLE.primary,
      secondary: validColor(saved.secondary) ? saved.secondary : DEFAULT_NUMBER_STYLE.secondary,
      material: MATERIAL_TYPES[saved.material] ? saved.material : DEFAULT_NUMBER_STYLE.material,
      glow: typeof saved.glow === 'boolean' ? saved.glow : DEFAULT_NUMBER_STYLE.glow,
      trail: TRAIL_TYPES[saved.trail] ? saved.trail : 'none',
    };
  } catch {
    return { ...DEFAULT_NUMBER_STYLE };
  }
}

const numberStyle = loadNumberStyle();

const faceMat = new THREE.MeshPhysicalMaterial({ envMap: envTex, envMapIntensity: 0.7, clearcoatRoughness: 0.25, iridescenceIOR: 1.5 });
const sideMat = new THREE.MeshPhysicalMaterial({ envMap: envTex, envMapIntensity: 0.7, clearcoatRoughness: 0.25, iridescenceIOR: 1.5 });
const playerMats = [faceMat, sideMat];

function applyNumberStyle(save = true) {
  const m = MATERIAL_TYPES[numberStyle.material] || MATERIAL_TYPES.glossy;
  const neon = numberStyle.material === 'neon';
  const zones = [
    [faceMat, numberStyle.primary, 0.34],
    [sideMat, numberStyle.secondary, 0.2],
  ];
  for (const [mat, hex, neonEmission] of zones) {
    mat.color.set(hex);
    mat.roughness = m.roughness;
    mat.metalness = m.metalness;
    mat.clearcoat = m.clearcoat;
    mat.iridescence = m.iridescence;
    mat.envMapIntensity = neon ? 0.42 : 0.7;
    mat.transparent = m.opacity < 1;
    mat.opacity = m.opacity;
    if (neon) {
      mat.emissive.set(hex);
      // Self-lit, but below the point where bloom erases the face and bevel detail.
      mat.emissiveIntensity = neonEmission;
    } else if (numberStyle.glow) {
      mat.emissive.set(hex);
      mat.emissiveIntensity = 0.35;
    } else {
      mat.emissive.setRGB(0, 0, 0);
      mat.emissiveIntensity = 0;
    }
    mat.needsUpdate = true;
  }
  if (studioScene && game.state === 'custom') setPreviewLighting(previewLighting);
  if (save) localStorage.setItem('mathwall-style', JSON.stringify(numberStyle));
}
applyNumberStyle(false);
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

// cartoon dizzy stars: orbit the number's head after a crash
const dizzyStars = new THREE.Group();
{
  const starShape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? 0.34 : 0.14;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    if (i === 0) starShape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else starShape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  starShape.closePath();
  const starGeo = new THREE.ShapeGeometry(starShape);
  const starMat = new THREE.MeshBasicMaterial({ color: 0xffd94f, side: THREE.DoubleSide, transparent: true });
  starMat.toneMapped = false;
  starMat.fog = false;
  for (let i = 0; i < 5; i++) {
    const star = new THREE.Mesh(starGeo, starMat);
    star.userData.offset = (i / 5) * Math.PI * 2;
    dizzyStars.add(star);
  }
}
dizzyStars.visible = false;
scene.add(dizzyStars);

let cardPop = 0; // pop animation timer

function setPlayerNumberVisual(n) {
  if (!font) return;
  if (numberMesh) {
    player.remove(numberMesh);
    numberMesh.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  numberMesh = makeNumberGroup(font, String(n), playerMats, NUMBER_SIZE);
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
  dizzy: 0, // stunned wobble + orbiting stars after a crash
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
    sunY: 7,   sunCol: 0xffca8f, sunO: 0.85, moonY: 8,  moonO: 0, starO: 0,
    birdW: 1,    deerW: 1,   foxW: 0,    cdeerW: 0 },
  { name: 'Day',      zenith: 0x2c6fd1, mid: 0x6fb0ea, horizon: 0xd8eefb, fog: 0xdceaf6, terrain: 0x9ccf9f, cloud: 0xffffff,
    sun: 0xfff2dd, sunI: 1.4,  hemiI: 1.1,  lane: 0,
    sunY: 34,  sunCol: 0xfff4da, sunO: 0.7,  moonY: 8,  moonO: 0, starO: 0,
    birdW: 1,    deerW: 0.8, foxW: 0.1,  cdeerW: 0 },
  { name: 'Sunset',   zenith: 0x5b4a9e, mid: 0xb96e93, horizon: 0xff9b4a, fog: 0xeda06b, terrain: 0x9c8f7e, cloud: 0xffc7a0,
    sun: 0xff9a5c, sunI: 1.25, hemiI: 0.85, lane: 0.02,
    sunY: 5.5, sunCol: 0xff8f3d, sunO: 1.0,  moonY: 10, moonO: 0, starO: 0.12,
    birdW: 0.25, deerW: 0.3, foxW: 1,    cdeerW: 0 },
  { name: 'Twilight', zenith: 0x222a58, mid: 0x45487f, horizon: 0xa88bc0, fog: 0x9187b4, terrain: 0x5c6187, cloud: 0x9089b8,
    sun: 0xa48fdc, sunI: 0.9,  hemiI: 0.7,  lane: 0.05,
    sunY: -6,  sunCol: 0xc887b8, sunO: 0.35, moonY: 14, moonO: 0.55, starO: 0.7,
    birdW: 0,    deerW: 0,   foxW: 0.35, cdeerW: 0.45 },
  { name: 'Night',    zenith: 0x080d24, mid: 0x171f44, horizon: 0x2e3763, fog: 0x333b64, terrain: 0x353c63, cloud: 0x3f4a78,
    sun: 0x93a7ff, sunI: 0.65, hemiI: 0.55, lane: 0.09,
    sunY: -20, sunCol: 0x93a7ff, sunO: 0,    moonY: 30, moonO: 1, starO: 1,
    birdW: 0,    deerW: 0,   foxW: 0,    cdeerW: 1 },
];
const PERIOD_DIST = 340; // world units of travel per period (~20s at cruise speed)
let timePhase = 0;       // 0..5, wraps forever
let laneGlow = 0;        // tile self-illumination, rises after dark for readability

// the terrain is the ground now; the flat floor plane stays retired
floor.visible = true; // re-enabled as the ground skirt beneath the terrain

const periodColA = new THREE.Color();
const periodColB = new THREE.Color();
const cloudTint = new THREE.Color();
const crysCol = new THREE.Color();
const crysCol2 = new THREE.Color();
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
  envMats.tuft.color.copy(envMats.terrain.color); // grass follows the meadow hue
  floorMat.color.copy(envMats.terrain.color).lerp(scene.fog.color, 0.4); // skirt recedes into the haze
  cloudTint.copy(lerpHex(a.cloud, b.cloud, t));
  envMats.flower.color.copy(cloudTint);
  envMats.rock.color.copy(cloudTint);
  envMats.canopy.color.copy(cloudTint);
  envMats.trunk.color.copy(cloudTint);
  for (const cl of skyClouds) cl.material.color.copy(cloudTint);
  for (const cl of mistClouds) cl.material.color.copy(cloudTint);
  // mountain layers: zenith-tinted silhouettes dissolving into the fog color
  for (let k = 0; k < mountainMats.length; k++) {
    mountainMats[k].color.copy(skyMat.uniforms.zenith.value).lerp(scene.fog.color, 0.45 + k * 0.22);
  }
  // celestial bodies
  horizonGlow.position.y = L(a.sunY, b.sunY);
  horizonGlow.material.color.copy(lerpHex(a.sunCol, b.sunCol, t));
  horizonGlow.material.opacity = L(a.sunO, b.sunO);
  moon.position.y = L(a.moonY, b.moonY);
  moon.material.opacity = L(a.moonO, b.moonO);
  const starO = L(a.starO, b.starO);
  stars.material.opacity = starO;
  nightAmount = starO;
  // crystal shimmer: two out-of-phase pulses with a slow drift between
  // violet ↔ aqua and violet ↔ pink, so the glow feels alive, not uniform
  const hueT = (Math.sin(elapsed * 0.4) + 1) / 2;
  envMats.crystalA.emissive.copy(crysCol.setHex(0x8f7fff).lerp(crysCol2.setHex(0x6ee0d0), hueT));
  envMats.crystalB.emissive.copy(crysCol.setHex(0x8f7fff).lerp(crysCol2.setHex(0xf59ad0), 1 - hueT));
  envMats.crystalA.emissiveIntensity = starO * (1.1 + Math.sin(elapsed * 1.3) * 0.45);
  envMats.crystalB.emissiveIntensity = starO * (1.1 + Math.sin(elapsed * 1.3 + 2.2) * 0.45);
  for (const bl of balloons) bl.userData.mat.emissiveIntensity = starO * 0.5;
  // wildlife fades in and out with its period
  wildlifeWeights.bird = L(a.birdW, b.birdW);
  wildlifeWeights.deer = L(a.deerW, b.deerW);
  wildlifeWeights.fox = L(a.foxW, b.foxW);
  wildlifeWeights.cdeer = L(a.cdeerW, b.cdeerW);
  wildlifeMats.bird.opacity = wildlifeWeights.bird;
  wildlifeMats.deer.opacity = wildlifeWeights.deer;
  wildlifeMats.deerDark.opacity = Math.max(wildlifeWeights.deer, wildlifeWeights.fox);
  wildlifeMats.fox.opacity = wildlifeWeights.fox;
  wildlifeMats.crystalDeer.opacity = wildlifeWeights.cdeer;
  wildlifeMats.crystalDeer.emissiveIntensity = wildlifeWeights.cdeer * (0.75 + Math.sin(elapsed * 1.6) * 0.3);
  laneGlow = L(a.lane, b.lane);
}
window.__setPhase = p => { timePhase = p; }; // debug: jump the time-of-day clock

function wave() { return waveAt(game.solved); }
function wallInWave() { return (game.solved % WAVE_SIZE) + 1; }
function isBossWall() { return wall ? wall.boss : false; }
// Retain only a barely perceptible distance fade; the lane should read edge to edge.
// Clear over the lane, thick enough at distance to swallow the treadmill
// spawn seam — scenery materializes behind the haze instead of popping in.
scene.fog.near = 110;
scene.fog.far = 265;

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
  if (game.state === 'custom' && e.key === 'Escape') {
    cancelCustomize();
    return;
  }
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
    progressionStats.totalSolved += 1;
    progressionStats.maxCombo = Math.max(progressionStats.maxCombo, game.combo);
    if (perfect) progressionStats.perfects += 1;
    if (wall.boss) progressionStats.bosses += 1;
    saveProgressionStats();
    const progressionUnlocks = syncProgressionUnlocks();
    if (progressionUnlocks.length) setTimeout(() => showBanner('COSMETIC UNLOCKED!'), 260);
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
    game.dizzy = 1; // ...then wobbles around seeing stars, cartoon-style
    sfx.fail();
    sfx.dizzy();
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
    game.betweenTimer = 2.0; // hold the stunned beat so the dizzy show plays out
    updateHUD();
  }
}

// ----- Game flow ---------------------------------------------------------------------
function startGame(mode) {
  if (!font) return; // 3D number font still loading
  ensureAudio();
  game.mode = mode;
  game.rng = mode === 'daily' ? seededRandom(todayKey()) : Math.random;
  progressionStats.runs[mode] += 1;
  saveProgressionStats();
  game.score = 0;
  game.combo = 0;
  game.lives = 3;
  game.solved = 0;
  game.timeLeft = TIME_ATTACK_SECONDS;
  game.power = { slow: 2, undo: 2, skip: 1 };
  game.slowTimer = 0;
  timePhase = 0; // every run begins at Morning and lives a fresh day
  game.dizzy = 0;
  game.knock = 0;
  game.lunge = 0;
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
  if (reason === 'complete' && game.mode === 'daily' && !progressionStats.completedDailyDates.includes(todayKey())) {
    progressionStats.completedDailyDates.push(todayKey());
    progressionStats.completedDailyDates = progressionStats.completedDailyDates.slice(-60);
    progressionStats.dailyCompletes += 1;
  }
  saveProgressionStats();
  const endGameUnlocks = syncProgressionUnlocks();
  $('gameover-title').textContent =
    reason === 'complete' ? 'DAILY COMPLETE!' : reason === 'time' ? "TIME'S UP!" : 'CRASHED!';
  $('final-score').textContent = `Score: ${game.score}`;
  $('best-score').textContent = endGameUnlocks.length
    ? `Best: ${best} · ${endGameUnlocks.length} cosmetic reward${endGameUnlocks.length === 1 ? '' : 's'} unlocked!`
    : `Best: ${best}`;
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

// ----- Customization studio ----------------------------------------------------
const customScreen = $('custom-screen');
let previewNumber = null;
let previewSpin = 0.28;
let previewYaw = -0.2;
let previewPitch = 0;
let previewZoom = 1;
let previewView = null;
let customOriginalStyle = null;
let trailT = 0;
let studioStage = null;
let studioKey = null;
let studioFill = null;
let studioRim = null;
let studioPlatform = null;
let studioAura = null;
let studioTrail = null;
let studioTrailPositions = null;
let studioTrailMaterial = null;
let previewLighting = 'studio';
const studioTrailParticles = [];
const STUDIO_TRAIL_MAX = 56;
const studioColorScratch = new THREE.Color();
let customTab = 'featured';
let customApplying = false;
let equipPulse = 0;
let unlockCelebrationTimer = null;

function bestClassic() { return Number(localStorage.getItem('mathwall-best-classic') || 0); }

function styleMatches(a, b) {
  return a.primary === b.primary && a.secondary === b.secondary &&
    a.material === b.material && a.glow === b.glow && a.trail === b.trail;
}

function styleFingerprint(style) {
  return [style.primary, style.secondary, style.material, style.glow ? 1 : 0, style.trail].join('|');
}

function readStoredArray(key, fallback = []) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(parsed) ? parsed : [...fallback];
  } catch {
    return [...fallback];
  }
}

function validFavoriteStyle(style) {
  return style && typeof style.primary === 'string' && typeof style.secondary === 'string' &&
    Boolean(MATERIAL_TYPES[style.material]) && typeof style.glow === 'boolean' &&
    Boolean(TRAIL_TYPES[style.trail]);
}

let favoriteStyles = readStoredArray('mathwall-favorite-styles').filter(validFavoriteStyle).slice(0, 8);
const seenCosmetics = new Set(readStoredArray('mathwall-cosmetics-seen', ['classic']));
const knownUnlocks = new Set(readStoredArray('mathwall-known-unlocks', ['classic', 'gold', 'neon']));
const unlockedAchievements = new Set(readStoredArray('mathwall-achievements-unlocked'));
let pendingUnlockRewards = readStoredArray('mathwall-pending-unlock-rewards').filter(value => typeof value === 'string');

function syncProgressionUnlocks() {
  const newlyUnlocked = [];
  for (const achievement of ACHIEVEMENTS) {
    if (achievementComplete(achievement.id) && !unlockedAchievements.has(achievement.id)) {
      unlockedAchievements.add(achievement.id);
      newlyUnlocked.push(`${achievement.name} · ${achievement.reward}`);
    }
  }
  if (achievementComplete('collection_complete') && !unlockedAchievements.has('collection_complete')) {
    unlockedAchievements.add('collection_complete');
    newlyUnlocked.push('Collection Complete · Masterwork material');
  }
  if (newlyUnlocked.length) {
    pendingUnlockRewards = [...pendingUnlockRewards, ...newlyUnlocked].slice(-12);
    localStorage.setItem('mathwall-achievements-unlocked', JSON.stringify([...unlockedAchievements]));
    localStorage.setItem('mathwall-pending-unlock-rewards', JSON.stringify(pendingUnlockRewards));
  }
  return newlyUnlocked;
}

syncProgressionUnlocks();

function saveFavorites() {
  localStorage.setItem('mathwall-favorite-styles', JSON.stringify(favoriteStyles));
}

function markCosmeticSeen(id) {
  seenCosmetics.add(id);
  localStorage.setItem('mathwall-cosmetics-seen', JSON.stringify([...seenCosmetics]));
}

function currentFavoriteIndex() {
  const key = styleFingerprint(numberStyle);
  return favoriteStyles.findIndex(style => styleFingerprint(style) === key);
}

function switchCustomTab(tab) {
  const valid = ['featured', 'looks', 'colors', 'materials', 'effects', 'collection', 'progress'];
  customTab = valid.includes(tab) ? tab : 'featured';
  for (const button of document.querySelectorAll('[data-custom-tab]')) {
    const active = button.dataset.customTab === customTab;
    button.classList.toggle('sel', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active) button.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }
  for (const panel of document.querySelectorAll('[data-custom-panel]')) {
    panel.classList.toggle('active', panel.dataset.customPanel === customTab);
  }
  $('custom-scroll').scrollTop = 0;
}

function showUnlockCelebration() {
  const score = bestClassic();
  const unlockedNow = NUMBER_PRESETS.filter(p => p.needs > 0 && score >= p.needs && !knownUnlocks.has(p.id));
  for (const preset of unlockedNow) knownUnlocks.add(preset.id);
  if (unlockedNow.length) localStorage.setItem('mathwall-known-unlocks', JSON.stringify([...knownUnlocks]));
  const rewards = [...unlockedNow.map(preset => `${preset.name} look`), ...pendingUnlockRewards];
  if (!rewards.length) return;
  pendingUnlockRewards = [];
  localStorage.setItem('mathwall-pending-unlock-rewards', '[]');
  $('unlock-name').textContent = rewards.length === 1 ? rewards[0] : `${rewards[0]} + ${rewards.length - 1} more`;
  const celebration = $('unlock-celebration');
  celebration.classList.add('show');
  clearTimeout(unlockCelebrationTimer);
  unlockCelebrationTimer = setTimeout(() => celebration.classList.remove('show'), 2600);
}

function makeStudioBackdrop(top, bottom) {
  const c = document.createElement('canvas');
  c.width = 32; c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, c.height);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, c.width, c.height);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const studioBackdrops = {
  studio: makeStudioBackdrop('#d9e6ff', '#f7e9f2'),
  game: makeStudioBackdrop('#9ec7ef', '#ffe2b8'),
};

function initStudioScene() {
  studioScene = new THREE.Scene();
  studioScene.background = studioBackdrops.studio;
  studioCamera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 80);
  studioCamera.position.set(0, 0.65, 10.5);
  studioCamera.lookAt(0, 0, 0);

  studioStage = new THREE.Group();
  studioScene.add(studioStage);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.MeshStandardMaterial({ color: 0xe8edf7, roughness: 0.96, metalness: 0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.88;
  floor.receiveShadow = true;
  studioScene.add(floor);

  studioPlatform = new THREE.Mesh(
    new THREE.CylinderGeometry(2.55, 2.72, 0.42, 64),
    new THREE.MeshPhysicalMaterial({ color: 0xf9fbff, roughness: 0.32, metalness: 0.05, clearcoat: 0.55 })
  );
  studioPlatform.position.y = -1.66;
  studioPlatform.receiveShadow = true;
  studioStage.add(studioPlatform);

  studioFill = new THREE.HemisphereLight(0xe6f0ff, 0xd9cfe4, 1.55);
  studioScene.add(studioFill);
  studioKey = new THREE.DirectionalLight(0xffffff, 2.1);
  studioKey.position.set(-5, 8, 7);
  studioKey.castShadow = true;
  studioKey.shadow.mapSize.set(1024, 1024);
  studioKey.shadow.camera.left = -7;
  studioKey.shadow.camera.right = 7;
  studioKey.shadow.camera.top = 7;
  studioKey.shadow.camera.bottom = -7;
  studioKey.target = studioStage;
  studioScene.add(studioKey);
  studioRim = new THREE.DirectionalLight(0x9a8cff, 1.15);
  studioRim.position.set(6, 4, -5);
  studioRim.target = studioStage;
  studioScene.add(studioRim);

  studioAura = new THREE.Group();
  for (let i = 0; i < 2; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x2f6bff, transparent: true, opacity: 0.3,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.05 + i * 0.22, 0.035, 8, 72), mat);
    ring.position.z = -0.42 - i * 0.05;
    studioAura.add(ring);
  }
  studioAura.visible = false;
  studioStage.add(studioAura);

  studioTrailPositions = new Float32Array(STUDIO_TRAIL_MAX * 3);
  studioTrailPositions.fill(999);
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(studioTrailPositions, 3));
  const sparkCanvas = document.createElement('canvas');
  sparkCanvas.width = sparkCanvas.height = 64;
  const sparkG = sparkCanvas.getContext('2d');
  const sparkGrad = sparkG.createRadialGradient(32, 32, 0, 32, 32, 32);
  sparkGrad.addColorStop(0, 'rgba(255,255,255,1)');
  sparkGrad.addColorStop(0.28, 'rgba(255,255,255,0.9)');
  sparkGrad.addColorStop(1, 'rgba(255,255,255,0)');
  sparkG.fillStyle = sparkGrad;
  sparkG.fillRect(0, 0, 64, 64);
  const sparkMap = new THREE.CanvasTexture(sparkCanvas);
  sparkMap.colorSpace = THREE.SRGBColorSpace;
  studioTrailMaterial = new THREE.PointsMaterial({
    color: 0x2f6bff, size: 0.16, transparent: true, opacity: 0.9,
    map: sparkMap, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  });
  studioTrail = new THREE.Points(trailGeo, studioTrailMaterial);
  studioTrail.frustumCulled = false;
  studioTrail.visible = false;
  studioStage.add(studioTrail);
  for (let i = 0; i < STUDIO_TRAIL_MAX; i++) {
    studioTrailParticles.push({ life: 0, x: 999, y: 999, z: 999, vx: 0, vy: 0 });
  }
  layoutPreviewNumber();
}

function layoutPreviewNumber() {
  if (!studioStage) return;
  const portrait = window.innerHeight > window.innerWidth;
  const shortLandscape = !portrait && window.innerHeight <= 520;
  studioPlatform.visible = !portrait;
  if (portrait) {
    studioStage.position.set(0, 2.0, 0);
    studioStage.scale.setScalar(0.34 * previewZoom);
  } else if (shortLandscape) {
    studioStage.position.set(-2.55, 0.15, 0);
    studioStage.scale.setScalar(0.72 * previewZoom);
  } else {
    studioStage.position.set(-2.45, 0.2, 0);
    studioStage.scale.setScalar(1.02 * previewZoom);
  }
}

function updatePreviewToolState() {
  for (const [id, active] of [
    ['light-studio', previewLighting === 'studio'], ['light-game', previewLighting === 'game'],
    ['view-front', previewView === 'front'], ['view-angle', previewView === 'angle'], ['view-side', previewView === 'side'],
  ]) {
    const el = $(id);
    el.classList.toggle('sel', active);
    el.setAttribute('aria-pressed', String(active));
  }
}

function setPreviewLighting(mode) {
  previewLighting = mode === 'game' ? 'game' : 'studio';
  const neonPreview = numberStyle.material === 'neon';
  if (previewLighting === 'game') {
    studioScene.background = studioBackdrops.game;
    studioFill.color.setHex(0xd8eaff);
    studioFill.groundColor.setHex(0xe9eef5);
    studioFill.intensity = 1.05;
    studioKey.color.setHex(0xf7fbff);
    studioKey.intensity = 0.95;
    studioKey.position.set(5, 9, 7);
    studioRim.color.setHex(0xa9d8ff);
    studioRim.intensity = 0.48;
    studioPlatform.material.color.setHex(0xe9eef8);
    bloomPass.strength = 0.55;
  } else {
    studioScene.background = studioBackdrops.studio;
    studioFill.color.setHex(0xe6f0ff);
    studioFill.groundColor.setHex(0xd9cfe4);
    studioFill.intensity = neonPreview ? 1.08 : 1.55;
    studioKey.color.setHex(0xffffff);
    studioKey.intensity = neonPreview ? 1.25 : 2.1;
    studioKey.position.set(-5, 8, 7);
    studioRim.color.setHex(0x9a8cff);
    studioRim.intensity = neonPreview ? 0.72 : 1.15;
    studioPlatform.material.color.setHex(0xf9fbff);
    bloomPass.strength = neonPreview ? 0.4 : 0.68;
  }
  updatePreviewToolState();
}

function setPreviewView(view) {
  previewView = view;
  previewSpin = 0;
  if (view === 'front') { previewYaw = 0; previewPitch = 0; }
  if (view === 'angle') { previewYaw = -0.62; previewPitch = -0.08; }
  if (view === 'side') { previewYaw = -Math.PI / 2; previewPitch = 0; }
  updatePreviewToolState();
}

function changePreviewZoom(delta) {
  previewZoom = THREE.MathUtils.clamp(previewZoom + delta, 0.72, 1.32);
  layoutPreviewNumber();
}

function resetPreviewView() {
  previewYaw = -0.2;
  previewPitch = 0;
  previewZoom = 1;
  previewSpin = 0.28;
  previewView = null;
  layoutPreviewNumber();
  updatePreviewToolState();
}

function spawnStudioTrailParticle() {
  const p = studioTrailParticles.find(item => item.life <= 0);
  if (!p) return;
  p.life = 0.75 + Math.random() * 0.45;
  p.x = (Math.random() - 0.5) * 1.1;
  p.y = 0.28 + (Math.random() - 0.5) * 1.55;
  p.z = -0.22 + Math.random() * 0.25;
  p.vx = -0.75 - Math.random() * 0.65;
  p.vy = (Math.random() - 0.5) * 0.45;
}

function clearStudioTrail() {
  for (const p of studioTrailParticles) p.life = 0;
  trailT = 0;
  if (studioTrailPositions) studioTrailPositions.fill(999);
  if (studioTrail) studioTrail.visible = false;
}

function updateStudioPreview(dt) {
  if (!previewNumber) return;
  previewYaw += previewSpin * dt;
  previewNumber.rotation.set(previewPitch, previewYaw, 0);
  previewNumber.position.y = 0.35 + Math.sin(elapsed * 1.5) * 0.08;
  if (equipPulse > 0) {
    equipPulse = Math.max(0, equipPulse - dt * 2.15);
    previewNumber.scale.setScalar(1 + Math.sin((1 - equipPulse) * Math.PI) * 0.16);
  } else {
    previewNumber.scale.setScalar(1);
  }

  const color = studioColorScratch.set(numberStyle.primary);
  const showAura = numberStyle.glow || numberStyle.material === 'neon';
  studioAura.visible = showAura;
  if (showAura) {
    const neonAura = numberStyle.material === 'neon';
    for (let i = 0; i < studioAura.children.length; i++) {
      const ring = studioAura.children[i];
      ring.material.color.copy(color).multiplyScalar(neonAura ? 0.82 : 1.08);
      const baseOpacity = neonAura ? 0.065 : 0.12;
      const pulseOpacity = neonAura ? 0.022 : 0.045;
      ring.material.opacity = baseOpacity + Math.sin(elapsed * 2.4 + i * 1.7) * pulseOpacity;
      const s = 1 + Math.sin(elapsed * 1.8 + i) * 0.045;
      ring.scale.setScalar(s);
      ring.rotation.z += dt * (i ? -0.16 : 0.12);
    }
  }

  const showTrail = numberStyle.trail !== 'none';
  studioTrail.visible = showTrail;
  if (showTrail) {
    const trailVisual = {
      sparkle: { interval: 0.07, size: 0.16, color: numberStyle.primary, count: 2 },
      runic: { interval: 0.1, size: 0.2, color: '#8d7cff', count: 1 },
      comet: { interval: 0.045, size: 0.22, color: '#ff8a4c', count: 3 },
      starfall: { interval: 0.085, size: 0.19, color: '#ffd76a', count: 2 },
    }[numberStyle.trail] || { interval: 0.07, size: 0.16, color: numberStyle.primary, count: 2 };
    trailT += dt;
    if (trailT >= trailVisual.interval) {
      trailT = 0;
      for (let i = 0; i < trailVisual.count; i++) spawnStudioTrailParticle();
    }
    studioTrailMaterial.color.set(trailVisual.color).multiplyScalar(1.35);
    studioTrailMaterial.size = trailVisual.size;
  }
  for (let i = 0; i < studioTrailParticles.length; i++) {
    const p = studioTrailParticles[i];
    const j = i * 3;
    if (showTrail && p.life > 0) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      studioTrailPositions[j] = p.x;
      studioTrailPositions[j + 1] = p.y;
      studioTrailPositions[j + 2] = p.z;
    } else {
      p.life = 0;
      studioTrailPositions[j] = studioTrailPositions[j + 1] = studioTrailPositions[j + 2] = 999;
    }
  }
  studioTrail.geometry.attributes.position.needsUpdate = true;
}

initStudioScene();

function makePaletteDots(primary, secondary) {
  const dots = document.createElement('span');
  dots.className = 'palette-dots';
  for (const color of [primary, secondary]) {
    const dot = document.createElement('span');
    dot.className = 'palette-dot';
    dot.style.background = color;
    dots.appendChild(dot);
  }
  return dots;
}

function applyPresetStyle(preset) {
  markCosmeticSeen(preset.id);
  Object.assign(numberStyle, preset.style);
  applyNumberStyle(false);
  renderCustomControls();
}

function createPresetCard(preset) {
  const score = bestClassic();
  const locked = score < preset.needs;
  const selected = styleMatches(numberStyle, preset.style);
  const isNew = !locked && !seenCosmetics.has(preset.id);
  const el = document.createElement('button');
  el.className = `chip preset-card${selected ? ' sel' : ''}${locked ? ' locked' : ''}`;
  el.disabled = locked;
  el.setAttribute('aria-pressed', String(selected));
  el.setAttribute('aria-label', locked
    ? `${preset.name} preset locked. ${score} of ${preset.needs} Classic score`
    : `${preset.name} preset${selected ? ', selected' : ''}${isNew ? ', new' : ''}`);
  const name = document.createElement('strong');
  name.textContent = locked ? `🔒 ${preset.name}` : selected ? `✓ ${preset.name}` : preset.name;
  const status = document.createElement('small');
  status.textContent = locked
    ? `${Math.min(score, preset.needs)} / ${preset.needs} Classic`
    : selected ? 'Active preset' : preset.style.material;
  el.append(name, status);
  if (isNew) {
    const badge = document.createElement('span');
    badge.className = 'new-badge';
    badge.textContent = 'NEW';
    el.appendChild(badge);
  }
  el.addEventListener('click', () => applyPresetStyle(preset));
  return el;
}

function unlockProgress(unlockId) {
  if (!unlockId) return { owned: true, value: 1, target: 1, label: 'Owned' };
  if (unlockId === 'collection_complete') {
    const complete = ACHIEVEMENTS.filter(item => achievementComplete(item.id)).length;
    return { owned: complete === ACHIEVEMENTS.length, value: complete, target: ACHIEVEMENTS.length, label: `${complete} / ${ACHIEVEMENTS.length} achievements` };
  }
  const achievement = ACHIEVEMENTS.find(item => item.id === unlockId);
  if (!achievement) return { owned: true, value: 1, target: 1, label: 'Owned' };
  const value = achievementValue(achievement);
  return {
    owned: value >= achievement.target,
    value,
    target: achievement.target,
    label: `${Math.min(value, achievement.target)} / ${achievement.target} · ${achievement.name}`,
  };
}

function applyComponentLockState(element, component, label) {
  const progress = unlockProgress(component.unlock);
  if (progress.owned) return progress;
  element.disabled = true;
  element.classList.add('locked');
  element.setAttribute('aria-label', `${label} locked. ${progress.label}`);
  const copy = document.createElement('small');
  copy.className = 'unlock-copy';
  copy.textContent = `🔒 ${progress.label}`;
  element.appendChild(copy);
  return progress;
}

function cosmeticCollectionProgress() {
  const score = bestClassic();
  const presetOwned = NUMBER_PRESETS.filter(preset => score >= preset.needs).length;
  const paletteOwned = COLOR_PALETTES.filter(componentOwned).length;
  const materialEntries = Object.values(MATERIAL_TYPES);
  const materialOwned = materialEntries.filter(componentOwned).length;
  const trailEntries = Object.entries(TRAIL_TYPES).filter(([id]) => id !== 'none');
  const trailOwned = trailEntries.filter(([, trail]) => componentOwned(trail)).length;
  return {
    owned: presetOwned + paletteOwned + materialOwned + trailOwned + 1,
    total: NUMBER_PRESETS.length + COLOR_PALETTES.length + materialEntries.length + trailEntries.length + 1,
  };
}

function renderProgression() {
  const completed = ACHIEVEMENTS.filter(item => achievementComplete(item.id)).length;
  const percent = Math.round((completed / ACHIEVEMENTS.length) * 100);
  const collection = cosmeticCollectionProgress();
  const overview = $('progress-overview');
  overview.innerHTML = '';
  const ring = document.createElement('div');
  ring.className = 'progress-ring';
  ring.style.setProperty('--progress', `${percent}%`);
  ring.textContent = `${percent}%`;
  const overviewCopy = document.createElement('div');
  const eyebrow = document.createElement('small');
  eyebrow.textContent = 'COLLECTION PROGRESS';
  const title = document.createElement('strong');
  title.textContent = `${collection.owned} / ${collection.total} cosmetics owned`;
  const description = document.createElement('p');
  description.textContent = `${completed} achievement${completed === 1 ? '' : 's'} complete · ${progressionStats.totalSolved} lifetime wall clears`;
  overviewCopy.append(eyebrow, title, description);
  overview.append(ring, overviewCopy);

  $('mode-progress-row').innerHTML = '';
  const modeRecords = [
    { label: 'CLASSIC', value: Number(localStorage.getItem('mathwall-best-classic') || 0), runs: progressionStats.runs.classic },
    { label: 'TIME', value: Number(localStorage.getItem('mathwall-best-time') || 0), runs: progressionStats.runs.time },
    { label: 'DAILY', value: progressionStats.dailyCompletes, runs: progressionStats.runs.daily, suffix: ' clears' },
  ];
  for (const record of modeRecords) {
    const card = document.createElement('div');
    card.className = 'mode-progress-card';
    const label = document.createElement('b');
    label.textContent = record.label;
    const value = document.createElement('strong');
    value.textContent = `${record.value}${record.suffix || ' best'}`;
    const runs = document.createElement('small');
    runs.textContent = `${record.runs} run${record.runs === 1 ? '' : 's'}`;
    card.append(label, value, runs);
    $('mode-progress-row').appendChild(card);
  }

  $('achievement-count').textContent = `${completed} / ${ACHIEVEMENTS.length} complete`;
  $('achievement-grid').innerHTML = '';
  for (const achievement of ACHIEVEMENTS) {
    const value = achievementValue(achievement);
    const complete = value >= achievement.target;
    const card = document.createElement('div');
    card.className = `achievement-card${complete ? ' complete' : ''}`;
    const icon = document.createElement('div');
    icon.className = 'achievement-icon';
    icon.textContent = complete ? '✓' : achievement.icon;
    const copy = document.createElement('div');
    copy.className = 'achievement-copy';
    const name = document.createElement('strong');
    name.textContent = achievement.name;
    const description = document.createElement('small');
    description.textContent = achievement.description;
    const reward = document.createElement('span');
    reward.className = 'achievement-reward';
    reward.textContent = complete ? `UNLOCKED · ${achievement.reward}` : `REWARD · ${achievement.reward}`;
    const bar = document.createElement('div');
    bar.className = 'mini-progress';
    const fill = document.createElement('span');
    fill.style.width = `${Math.min(100, (value / achievement.target) * 100)}%`;
    bar.appendChild(fill);
    copy.append(name, description, reward, bar);
    const count = document.createElement('div');
    count.className = 'achievement-count';
    count.textContent = complete ? 'DONE' : `${Math.min(value, achievement.target)} / ${achievement.target}`;
    card.append(icon, copy, count);
    $('achievement-grid').appendChild(card);
  }

  const completion = $('completion-reward');
  const collectionComplete = completed === ACHIEVEMENTS.length;
  completion.innerHTML = '';
  const completionTitle = document.createElement('strong');
  completionTitle.textContent = collectionComplete ? '✓ MASTERWORK MATERIAL UNLOCKED' : '♛ COLLECTION COMPLETION REWARD';
  const completionCopy = document.createElement('p');
  completionCopy.textContent = collectionComplete
    ? 'Your mastery reward is available in the Material category.'
    : `Complete all achievement tracks to earn the exclusive Masterwork material. ${completed} / ${ACHIEVEMENTS.length} complete.`;
  const completionBar = document.createElement('div');
  completionBar.className = 'mini-progress';
  const completionFill = document.createElement('span');
  completionFill.style.width = `${percent}%`;
  completionBar.appendChild(completionFill);
  completion.append(completionTitle, completionCopy, completionBar);
}

function renderStyleSummary() {
  const summary = $('style-summary');
  summary.innerHTML = '';
  const preset = NUMBER_PRESETS.find(p => styleMatches(numberStyle, p.style));
  const palette = COLOR_PALETTES.find(p => numberStyle.primary === p.primary && numberStyle.secondary === p.secondary);
  const eyebrow = document.createElement('small');
  eyebrow.textContent = 'CURRENT MIX';
  const title = document.createElement('strong');
  title.textContent = preset ? preset.name : `${palette?.name || 'Custom'} ${numberStyle.material}`;
  const details = document.createElement('p');
  const effects = [numberStyle.glow ? 'Glow' : '', numberStyle.trail !== 'none' ? TRAIL_TYPES[numberStyle.trail]?.name : ''].filter(Boolean);
  details.textContent = `${palette?.name || 'Custom colors'} · ${numberStyle.material}${effects.length ? ` · ${effects.join(' + ')}` : ''}`;
  summary.append(eyebrow, title, details);
}

function renderCollection() {
  const score = bestClassic();
  const owned = NUMBER_PRESETS.filter(p => score >= p.needs).length;
  const collection = cosmeticCollectionProgress();
  $('collection-progress').textContent = `${collection.owned} / ${collection.total} items`;
  $('collection-owned-label').textContent = `${owned} owned`;
  $('collection-grid').innerHTML = '';
  for (const preset of NUMBER_PRESETS) $('collection-grid').appendChild(createPresetCard(preset));

  $('favorite-row').innerHTML = '';
  if (!favoriteStyles.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-collection';
    empty.textContent = 'Tap ♡ to save a favorite combination.';
    $('favorite-row').appendChild(empty);
  } else {
    favoriteStyles.forEach((style, index) => {
      const selected = styleMatches(numberStyle, style);
      const card = document.createElement('button');
      card.className = `chip favorite-card${selected ? ' sel' : ''}`;
      card.setAttribute('aria-pressed', String(selected));
      card.setAttribute('aria-label', `Favorite ${index + 1}${selected ? ', selected' : ''}`);
      const text = document.createElement('span');
      const title = document.createElement('strong');
      title.textContent = selected ? `✓ Favorite ${index + 1}` : `Favorite ${index + 1}`;
      const detail = document.createElement('small');
      detail.textContent = style.material + (style.glow ? ' · glow' : '');
      text.append(title, detail);
      card.append(makePaletteDots(style.primary, style.secondary), text);
      card.addEventListener('click', () => {
        Object.assign(numberStyle, style);
        applyNumberStyle(false);
        renderCustomControls();
      });
      $('favorite-row').appendChild(card);
    });
  }

  const favoriteIndex = currentFavoriteIndex();
  const favoriteButton = $('custom-favorite');
  favoriteButton.classList.toggle('sel', favoriteIndex >= 0);
  favoriteButton.textContent = favoriteIndex >= 0 ? '♥' : '♡';
  favoriteButton.setAttribute('aria-pressed', String(favoriteIndex >= 0));
  favoriteButton.setAttribute('aria-label', favoriteIndex >= 0 ? 'Remove current style from favorites' : 'Add current style to favorites');

  const newCount = NUMBER_PRESETS.filter(p => score >= p.needs && !seenCosmetics.has(p.id)).length;
  const badge = $('looks-new-count');
  badge.textContent = String(newCount);
  badge.classList.toggle('visible', newCount > 0);
}

function renderCustomControls() {
  for (const id of ['featured-row', 'preset-row', 'palette-row', 'primary-row', 'secondary-row', 'material-row', 'fx-row']) $(id).innerHTML = '';

  renderStyleSummary();
  const featuredPresets = NUMBER_PRESETS.filter(p => bestClassic() >= p.needs).slice(0, 3);
  for (const preset of featuredPresets) $('featured-row').appendChild(createPresetCard(preset));
  for (const preset of NUMBER_PRESETS) $('preset-row').appendChild(createPresetCard(preset));

  for (const palette of COLOR_PALETTES) {
    const selected = numberStyle.primary === palette.primary && numberStyle.secondary === palette.secondary;
    const el = document.createElement('button');
    el.className = `chip palette-card${selected ? ' sel' : ''}`;
    el.setAttribute('aria-pressed', String(selected));
    el.setAttribute('aria-label', `${palette.name} palette${selected ? ', selected' : ''}`);
    const name = document.createElement('strong');
    name.textContent = selected ? `✓ ${palette.name}` : palette.name;
    el.append(makePaletteDots(palette.primary, palette.secondary), name);
    applyComponentLockState(el, palette, `${palette.name} palette`);
    el.addEventListener('click', () => {
      numberStyle.primary = palette.primary;
      numberStyle.secondary = palette.secondary;
      applyNumberStyle(false);
      renderCustomControls();
    });
    $('palette-row').appendChild(el);
  }

  for (const zone of [
    { id: 'primary-row', key: 'primary', label: 'face' },
    { id: 'secondary-row', key: 'secondary', label: 'edge' },
  ]) {
    for (const swatch of COLOR_SWATCHES) {
      const selected = numberStyle[zone.key] === swatch.hex;
      const el = document.createElement('button');
      el.className = `swatch${selected ? ' sel' : ''}`;
      el.style.background = swatch.hex;
      el.title = `${swatch.name} ${zone.label}`;
      el.setAttribute('aria-label', `${swatch.name} ${zone.label}${selected ? ', selected' : ''}`);
      el.setAttribute('aria-pressed', String(selected));
      el.addEventListener('click', () => {
        numberStyle[zone.key] = swatch.hex;
        applyNumberStyle(false);
        renderCustomControls();
      });
      $(zone.id).appendChild(el);
    }
  }

  for (const key of Object.keys(MATERIAL_TYPES)) {
    const material = MATERIAL_TYPES[key];
    const selected = numberStyle.material === key;
    const el = document.createElement('button');
    el.className = `chip material-card${selected ? ' sel' : ''}`;
    el.dataset.material = key;
    el.style.setProperty('--orb', numberStyle.primary);
    el.setAttribute('aria-pressed', String(selected));
    el.setAttribute('aria-label', `${key} material${selected ? ', selected' : ''}`);
    const orb = document.createElement('span');
    orb.className = 'material-orb';
    const label = document.createElement('strong');
    label.textContent = selected ? `✓ ${key.toUpperCase()}` : key.toUpperCase();
    el.append(orb, label);
    applyComponentLockState(el, material, `${key} material`);
    el.addEventListener('click', () => {
      numberStyle.material = key;
      applyNumberStyle(false);
      renderCustomControls();
    });
    $('material-row').appendChild(el);
  }

  const effects = [
    { label: 'GLOW', icon: '✦', selected: numberStyle.glow, component: {}, toggle: () => { numberStyle.glow = !numberStyle.glow; } },
    ...Object.entries(TRAIL_TYPES)
      .filter(([id]) => id !== 'none')
      .map(([id, trail]) => ({
        label: trail.name.toUpperCase(), icon: trail.icon, component: trail,
        selected: numberStyle.trail === id,
        toggle: () => { numberStyle.trail = numberStyle.trail === id ? 'none' : id; },
      })),
  ];
  for (const effect of effects) {
    const el = document.createElement('button');
    el.className = `chip effect-card${effect.selected ? ' sel' : ''}`;
    el.setAttribute('aria-pressed', String(effect.selected));
    el.setAttribute('aria-label', `${effect.label} effect, ${effect.selected ? 'on' : 'off'}`);
    const icon = document.createElement('span');
    icon.className = 'effect-icon';
    icon.textContent = effect.icon;
    const label = document.createElement('strong');
    label.textContent = effect.selected ? `✓ ${effect.label}` : effect.label;
    el.append(icon, label);
    applyComponentLockState(el, effect.component, `${effect.label} effect`);
    el.addEventListener('click', () => {
      effect.toggle();
      applyNumberStyle(false);
      renderCustomControls();
    });
    $('fx-row').appendChild(el);
  }

  renderCollection();
  renderProgression();
}

function randomizeCustomize() {
  const palettes = COLOR_PALETTES.filter(componentOwned);
  const materials = Object.keys(MATERIAL_TYPES).filter(key => componentOwned(MATERIAL_TYPES[key]));
  const trails = Object.keys(TRAIL_TYPES).filter(key => componentOwned(TRAIL_TYPES[key]));
  const palette = palettes[Math.floor(Math.random() * palettes.length)];
  numberStyle.primary = palette.primary;
  numberStyle.secondary = palette.secondary;
  numberStyle.material = materials[Math.floor(Math.random() * materials.length)];
  numberStyle.glow = Math.random() < 0.38;
  numberStyle.trail = Math.random() < 0.34 ? trails[Math.floor(Math.random() * trails.length)] : 'none';
  previewSpin = 0.52;
  previewView = null;
  applyNumberStyle(false);
  renderCustomControls();
  updatePreviewToolState();
  const button = $('custom-randomize');
  button.classList.remove('rolling');
  void button.offsetWidth;
  button.classList.add('rolling');
}

function toggleCurrentFavorite() {
  const index = currentFavoriteIndex();
  if (index >= 0) {
    favoriteStyles.splice(index, 1);
  } else {
    favoriteStyles.unshift({ ...numberStyle });
    favoriteStyles = favoriteStyles.slice(0, 8);
  }
  saveFavorites();
  renderCustomControls();
}

function openCustomize() {
  if (!font || game.state !== 'menu') return;
  customOriginalStyle = { ...numberStyle };
  customApplying = false;
  equipPulse = 0;
  game.state = 'custom';
  menuScreen.classList.add('hidden');
  customScreen.classList.add('visible');
  player.visible = false;
  blob.visible = false;
  previewNumber = makeNumberGroup(font, '42', playerMats, NUMBER_SIZE);
  previewNumber.position.set(0, 0.35, 0);
  studioStage.add(previewNumber);
  renderPass.scene = studioScene;
  renderPass.camera = studioCamera;
  resetPreviewView();
  setPreviewLighting(previewLighting);
  clearStudioTrail();
  $('advanced-colors').open = false;
  $('custom-apply').textContent = 'APPLY';
  $('custom-apply').disabled = false;
  $('custom-cancel').disabled = false;
  $('custom-reset').disabled = false;
  switchCustomTab('featured');
  renderCustomControls();
  showUnlockCelebration();
}

function closeCustomize() {
  customScreen.classList.remove('visible');
  customScreen.classList.remove('equipping');
  $('unlock-celebration').classList.remove('show');
  if (previewNumber) {
    studioStage.remove(previewNumber);
    previewNumber.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    previewNumber = null;
  }
  clearStudioTrail();
  studioAura.visible = false;
  renderPass.scene = scene;
  renderPass.camera = camera;
  bloomPass.strength = 0.55;
  game.state = 'menu';
  player.visible = true;
  blob.visible = true;
  menuScreen.classList.remove('hidden');
}

function applyCustomize() {
  if (customApplying) return;
  customApplying = true;
  applyNumberStyle(true);
  const activePreset = NUMBER_PRESETS.find(p => styleMatches(numberStyle, p.style));
  if (activePreset) markCosmeticSeen(activePreset.id);
  customOriginalStyle = null;
  equipPulse = 1;
  customScreen.classList.add('equipping');
  $('custom-apply').textContent = 'EQUIPPED ✓';
  $('custom-apply').disabled = true;
  $('custom-cancel').disabled = true;
  $('custom-reset').disabled = true;
  setTimeout(() => {
    customApplying = false;
    closeCustomize();
  }, 540);
}

function cancelCustomize() {
  if (customApplying) return;
  if (customOriginalStyle) Object.assign(numberStyle, customOriginalStyle);
  applyNumberStyle(false);
  customOriginalStyle = null;
  closeCustomize();
}

function resetCustomize() {
  if (customApplying) return;
  Object.assign(numberStyle, DEFAULT_NUMBER_STYLE);
  applyNumberStyle(false);
  renderCustomControls();
}

$('customize-btn').addEventListener('click', openCustomize);
$('custom-apply').addEventListener('click', applyCustomize);
$('custom-cancel').addEventListener('click', cancelCustomize);
$('custom-reset').addEventListener('click', resetCustomize);
$('custom-randomize').addEventListener('click', randomizeCustomize);
$('custom-favorite').addEventListener('click', toggleCurrentFavorite);
for (const tab of document.querySelectorAll('[data-custom-tab]')) {
  tab.addEventListener('click', () => switchCustomTab(tab.dataset.customTab));
  tab.addEventListener('keydown', event => {
    const tabs = [...document.querySelectorAll('[data-custom-tab]')];
    const current = tabs.indexOf(tab);
    let next = current;
    if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    switchCustomTab(tabs[next].dataset.customTab);
    tabs[next].focus();
  });
}

let previewDragging = false;
let previewLastX = 0;
let previewLastY = 0;
canvas.addEventListener('pointerdown', e => {
  if (game.state === 'custom') {
    previewDragging = true;
    previewLastX = e.clientX;
    previewLastY = e.clientY;
    previewSpin = 0;
    previewView = null;
    updatePreviewToolState();
    canvas.setPointerCapture?.(e.pointerId);
  }
});
window.addEventListener('pointermove', e => {
  if (previewDragging && previewNumber) {
    previewYaw += (e.clientX - previewLastX) * 0.012;
    previewPitch = THREE.MathUtils.clamp(previewPitch + (e.clientY - previewLastY) * 0.007, -0.42, 0.42);
    previewLastX = e.clientX;
    previewLastY = e.clientY;
  }
});
window.addEventListener('pointerup', e => {
  if (!previewDragging) return;
  previewDragging = false;
  canvas.releasePointerCapture?.(e.pointerId);
});
canvas.addEventListener('wheel', e => {
  if (game.state !== 'custom') return;
  e.preventDefault();
  changePreviewZoom(e.deltaY > 0 ? -0.08 : 0.08);
}, { passive: false });

$('light-studio').addEventListener('click', () => setPreviewLighting('studio'));
$('light-game').addEventListener('click', () => setPreviewLighting('game'));
$('view-front').addEventListener('click', () => setPreviewView('front'));
$('view-angle').addEventListener('click', () => setPreviewView('angle'));
$('view-side').addEventListener('click', () => setPreviewView('side'));
$('view-zoom-out').addEventListener('click', () => changePreviewZoom(-0.1));
$('view-zoom-in').addEventListener('click', () => changePreviewZoom(0.1));
$('view-reset').addEventListener('click', resetPreviewView);

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

  // The customization studio renders its own lightweight scene. Returning here
  // freezes the runway, wildlife, shadows, particles, and game simulation while
  // the player compares cosmetics.
  if (game.state === 'custom') {
    updateStudioPreview(dt);
    composer.render();
    return;
  }

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
  // balloons drift lazily with gentle bobbing, far off to the sides
  for (let i = 0; i < balloons.length; i++) {
    const bl = balloons[i];
    bl.position.z += flow * dt * 0.12;
    bl.position.y = bl.userData.baseY + Math.sin(elapsed * 0.5 + i * 2.1) * 0.9;
    if (bl.position.z > 20) bl.position.z -= 260;
  }
  // wildlife: birds cross the sky; ground animals idle quietly on the hills
  const birdsOut = wildlifeWeights.bird > 0.02;
  for (const bird of birds) {
    bird.visible = birdsOut;
    if (!birdsOut) continue;
    const u = bird.userData;
    bird.position.x += u.dir * u.speed * dt;
    bird.position.z += flow * dt * 0.12;
    bird.position.y += Math.sin(elapsed * 1.3 + u.phase) * dt * 0.4;
    if (Math.abs(bird.position.x) > 85) bird.position.x = -u.dir * 85;
    if (bird.position.z > 15) bird.position.z -= 160;
    const flap = Math.sin(elapsed * 9 + u.phase) * 0.55 + 0.15;
    u.wingL.rotation.x = -flap;
    u.wingR.rotation.x = flap;
  }
  for (const w of wildlife) {
    const weight = w.type === 'deer' ? wildlifeWeights.deer
      : w.type === 'fox' ? wildlifeWeights.fox
      : wildlifeWeights.cdeer;
    w.group.visible = weight > 0.02;
    if (!w.group.visible) continue;
    if (w.type === 'deer') {
      // graze: head dips down, holds, lifts to look around
      w.head.rotation.z = -Math.max(0, Math.sin(elapsed * 0.5 + w.phase)) * 0.7;
    } else if (w.type === 'fox') {
      w.tail.rotation.z = 0.35 + Math.sin(elapsed * 3 + w.phase) * 0.25;
      w.group.rotation.y += Math.sin(elapsed * 0.23 + w.phase) * dt * 0.15; // slow wander turn
    } else {
      w.head.rotation.y = Math.sin(elapsed * 0.35 + w.phase) * 0.4; // majestic look-around
    }
  }

  // night magic: breathing aurora + twinkling firefly swarms, gone by day
  for (let i = 0; i < auroras.length; i++) {
    const au = auroras[i];
    au.material.opacity = nightAmount * (0.28 + Math.sin(elapsed * 0.45 + i * 1.8) * 0.12);
    au.rotation.z = au.userData.tilt + Math.sin(elapsed * 0.1 + i) * 0.025;
  }
  for (const swarm of fireflySwarms) {
    const d = swarm.userData;
    swarm.material.opacity = nightAmount * (0.25 + 0.75 * Math.max(0, Math.sin(elapsed * d.speed + d.phase)));
    if (nightAmount > 0.01) {
      const arr = swarm.geometry.attributes.position.array;
      for (let k = 0; k < arr.length; k += 3) {
        arr[k + 2] += flow * dt * 0.85;
        if (arr[k + 2] > 14) arr[k + 2] -= 180;
      }
      swarm.geometry.attributes.position.needsUpdate = true;
    }
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
    zOff = Math.sin(Math.min(p * 1.4, 1) * Math.PI) * 3.4;  // thrown backward, then recover
    const spinEase = 1 - Math.pow(1 - Math.min(p * 1.15, 1), 3);
    ySpin = spinEase * Math.PI * 6;                          // three wild spins off the impact
    xTumble = -Math.sin(p * Math.PI) * 0.5;
  }
  // stunned wobble: drunken sway while little stars circle the head
  let wobbleZ = 0;
  if (game.dizzy > 0) {
    game.dizzy = Math.max(0, game.dizzy - dt * 0.42); // ~2.4s stunned
    const d = game.dizzy;
    wobbleZ = Math.sin(elapsed * 9) * 0.38 * d;
    xTumble += Math.sin(elapsed * 7.3) * 0.16 * d;
    dizzyStars.visible = true;
    dizzyStars.position.set(player.position.x, player.position.y + 1.7, player.position.z);
    const fade = Math.min(d * 3, 1);
    dizzyStars.children[0].material.opacity = fade;
    for (let i = 0; i < dizzyStars.children.length; i++) {
      const st = dizzyStars.children[i];
      const a = elapsed * 5.5 + st.userData.offset;
      st.position.set(Math.cos(a) * 2.1, Math.sin(a * 2) * 0.15, Math.sin(a) * 0.95);
      st.rotation.z = elapsed * 4 + i;
      st.scale.setScalar(fade * (0.85 + Math.sin(a * 3) * 0.2));
    }
  } else if (dizzyStars.visible) {
    dizzyStars.visible = false;
  }
  // bob and sway settle to zero while a wall is near, so the number lines up
  // with the cutout and threads it dead-center
  const settleTarget = wall ? THREE.MathUtils.clamp(((PLAYER_Z - wall.z) - 4) / 10, 0, 1) : 1;
  settle += (settleTarget - settle) * Math.min(dt * 6, 1);
  player.position.y = PLAYER_Y + Math.sin(elapsed * 2.2) * 0.15 * settle;
  player.position.z = PLAYER_Z + zOff;
  player.rotation.set(xTumble, ySpin, Math.sin(elapsed * 1.6) * 0.05 * settle + wobbleZ);
  blob.position.set(player.position.x, 0.02, player.position.z);
  blob.scale.setScalar(1 - Math.sin(elapsed * 2.2) * 0.08);
  if (cardPop > 0) {
    cardPop = Math.max(0, cardPop - dt * 4);
    const s = 1 + Math.sin(cardPop * Math.PI) * 0.35;
    player.scale.setScalar(s);
  } else {
    player.scale.setScalar(1);
  }

  // Equipped cosmetic trails stream behind the number during runs.
  if (game.state === 'playing' && numberStyle.trail !== 'none') {
    const trailVisual = {
      sparkle: { interval: 0.13, color: numberStyle.primary, count: 2, speed: 1.6 },
      runic: { interval: 0.16, color: '#8d7cff', count: 2, speed: 1.25 },
      comet: { interval: 0.08, color: '#ff8a4c', count: 3, speed: 2.15 },
      starfall: { interval: 0.14, color: '#ffd76a', count: 3, speed: 1.45 },
    }[numberStyle.trail];
    trailT += dt;
    if (trailT > trailVisual.interval) {
      trailT = 0;
      spawnBurst(
        new THREE.Vector3(player.position.x + (Math.random() - 0.5), player.position.y + (Math.random() - 0.5) * 1.4, player.position.z + 1.3),
        parseInt(trailVisual.color.slice(1), 16),
        trailVisual.count, trailVisual.speed
      );
    }
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
