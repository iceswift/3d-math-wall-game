// Wall construction: a slab with the target number punched clean through it.
import * as THREE from 'three';
import { glyphSizeFor, NUMBER_SIZE, HOLE_SCALE } from './text3d.js';

export const WALL_WIDTH = 34;
export const WALL_HEIGHT = 9;
export const HOLE_Y = 2.1; // shares the number character's center line

const COLORS = {
  normal: { slab: 0x7f9cf5, glow: 0xff7a59 },
  boss: { slab: 0x4c5a86, glow: 0xffd166 },
  good: 0x3ecf8e,
};

export function buildWall(font, target, { boss = false } = {}) {
  const group = new THREE.Group();
  const D = boss ? 2.0 : 1.2; // boss walls are visibly thicker
  const text = String(target);
  const theme = boss ? COLORS.boss : COLORS.normal;
  // cutout = the answer's own glyph, enlarged just enough to pass through cleanly
  const size = glyphSizeFor(text, NUMBER_SIZE) * HOLE_SCALE;

  // glyph outlines from the font, centered on the hole position
  const extracted = font.generateShapes(text, size).map(s => s.extractPoints(12));
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of extracted) {
    for (const p of e.shape) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
  }
  const ox = -(minX + maxX) / 2;
  const oy = HOLE_Y - (minY + maxY) / 2;
  const shift = pts => pts.map(p => new THREE.Vector2(p.x + ox, p.y + oy));

  const wallShape = new THREE.Shape();
  wallShape.moveTo(-WALL_WIDTH / 2, 0);
  wallShape.lineTo(WALL_WIDTH / 2, 0);
  wallShape.lineTo(WALL_WIDTH / 2, WALL_HEIGHT);
  wallShape.lineTo(-WALL_WIDTH / 2, WALL_HEIGHT);
  wallShape.closePath();

  const islandShapes = []; // enclosed counters of 0, 4, 6, 8, 9 — float like show-wall styrofoam
  const glowShapes = [];   // silhouette used for the in-hole glow
  for (const e of extracted) {
    const outer = shift(e.shape);
    wallShape.holes.push(new THREE.Path(outer));
    const glow = new THREE.Shape(outer);
    for (const h of e.holes) {
      const hp = shift(h);
      glow.holes.push(new THREE.Path(hp));
      islandShapes.push(new THREE.Shape(hp));
    }
    glowShapes.push(glow);
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: theme.slab, roughness: boss ? 0.6 : 0.85, metalness: boss ? 0.35 : 0 });
  const extrudeOpts = { depth: D, bevelEnabled: false, curveSegments: 12 };
  const wallGeo = new THREE.ExtrudeGeometry(wallShape, extrudeOpts);
  wallGeo.translate(0, 0, -D / 2);
  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  group.add(wallMesh);

  for (const s of islandShapes) {
    const g = new THREE.ExtrudeGeometry(s, extrudeOpts);
    g.translate(0, 0, -D / 2);
    const m = new THREE.Mesh(g, wallMat);
    m.castShadow = true;
    group.add(m);
  }

  // glowing number silhouette floating in the cutout: readable from afar, green = safe
  const glowMat = new THREE.MeshBasicMaterial({
    color: theme.glow,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  glowMat.fog = false; // stays vivid at spawn distance so the target is always readable
  const glowMesh = new THREE.Mesh(new THREE.ShapeGeometry(glowShapes, 12), glowMat);
  group.add(glowMesh);

  return { group, target, glowMat, glowBase: 0.5, boss, baseGlow: theme.glow };
}

export function setWallMatchGlow(wall, matched) {
  if (!wall) return;
  wall.glowMat.color.setHex(matched ? COLORS.good : wall.baseGlow);
  wall.glowBase = matched ? 0.8 : 0.5;
}

export function disposeWall(scene, wall) {
  if (!wall) return;
  scene.remove(wall.group);
  wall.group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
}
