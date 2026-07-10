// Particle bursts and wall-shatter debris.
import * as THREE from 'three';

let scene = null;
const bursts = [];
const debris = [];
let debrisMat, frameDebrisMat, dotTex;

// soft radial sprite so particles render as glowing orbs, not hard squares
function makeDotTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function initFX(sceneRef, wallColor, edgeColor) {
  scene = sceneRef;
  debrisMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.85 });
  frameDebrisMat = new THREE.MeshStandardMaterial({ color: edgeColor, roughness: 0.5 });
  dotTex = makeDotTexture();
}

export function spawnBurst(pos, colorHex, count = 60, power = 9) {
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const velocities = [];
  for (let i = 0; i < count; i++) {
    positions[i * 3] = pos.x;
    positions[i * 3 + 1] = pos.y;
    positions[i * 3 + 2] = pos.z;
    const dir = new THREE.Vector3(
      Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5
    ).normalize().multiplyScalar(power * (0.4 + Math.random() * 0.6));
    velocities.push(dir);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: colorHex,
    size: 0.55,
    map: dotTex,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  mat.color.multiplyScalar(1.5); // push past the bloom threshold so bursts radiate
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  bursts.push({ points, velocities, life: 1 });
}

export function spawnWallDebris(wallZ, holeY, wallHeight, colorHex) {
  const tintMat = colorHex !== undefined
    ? new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.75 })
    : debrisMat;
  for (let i = 0; i < 46; i++) {
    const s = 0.35 + Math.random() * 0.9;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(s, s, s * 0.6),
      Math.random() < 0.12 ? frameDebrisMat : tintMat
    );
    // spawn across the wall, denser near the hole where the impact happened
    const nearHole = Math.random() < 0.5;
    const x = nearHole ? (Math.random() - 0.5) * 7 : (Math.random() - 0.5) * 13;
    const y = nearHole ? holeY + (Math.random() - 0.5) * 4 : Math.random() * wallHeight;
    mesh.position.set(x, Math.max(y, 0.3), wallZ);
    mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    mesh.castShadow = true;
    scene.add(mesh);
    // pieces burst outward from the impact point, biased up and toward the camera
    const v = new THREE.Vector3(
      x * 0.35 + (Math.random() - 0.5) * 3,
      3 + Math.random() * 6,
      4 + Math.random() * 7
    );
    debris.push({
      mesh, v,
      av: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
      life: 1.6 + Math.random() * 0.5,
    });
  }
}

export function updateFX(dt) {
  for (let i = bursts.length - 1; i >= 0; i--) {
    const b = bursts[i];
    b.life -= dt * 1.1;
    const arr = b.points.geometry.attributes.position.array;
    for (let j = 0; j < b.velocities.length; j++) {
      const v = b.velocities[j];
      v.y -= 18 * dt; // gravity
      arr[j * 3] += v.x * dt;
      arr[j * 3 + 1] += v.y * dt;
      arr[j * 3 + 2] += v.z * dt;
    }
    b.points.geometry.attributes.position.needsUpdate = true;
    b.points.material.opacity = Math.max(b.life, 0);
    if (b.life <= 0) {
      scene.remove(b.points);
      b.points.geometry.dispose();
      b.points.material.dispose();
      bursts.splice(i, 1);
    }
  }

  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.life -= dt;
    d.v.y -= 22 * dt;
    d.mesh.position.addScaledVector(d.v, dt);
    d.mesh.rotation.x += d.av.x * dt;
    d.mesh.rotation.y += d.av.y * dt;
    d.mesh.rotation.z += d.av.z * dt;
    // bounce once off the ground
    if (d.mesh.position.y < 0.2 && d.v.y < 0) {
      d.mesh.position.y = 0.2;
      d.v.y *= -0.35;
      d.v.x *= 0.7;
      d.v.z *= 0.7;
    }
    if (d.life < 0.4) d.mesh.scale.setScalar(Math.max(d.life / 0.4, 0.001));
    if (d.life <= 0) {
      scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      debris.splice(i, 1);
    }
  }
}
