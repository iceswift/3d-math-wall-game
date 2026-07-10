// Wall construction: a slab with the target number punched clean through it.
import * as THREE from 'three';
import { layoutGlyphs, NUMBER_SIZE, HOLE_MARGIN } from './text3d.js';

export const WALL_WIDTH = 12.5;
export const WALL_HEIGHT = 7.2;
export const HOLE_Y = 3.3; // shares the number character's center line (PLAYER_Y in main.js)

// vivid candy palette — walls cycle through these
export const WALL_TINTS = [0xffa22e, 0xff5f8f, 0x8f6bff, 0x2ec5b6, 0x5b8def];

// physical clearance between a digit's counter island and the model's ring:
// model bevel (~0.09) + island bevel (0.03) + slack — much smaller than the
// outer HOLE_MARGIN so counters keep near-true proportions
const ISLAND_MARGIN = 0.15;

const COLORS = {
  boss: { slab: 0x4c5a86, glow: 0xffd166 },
  glow: 0xff7a59,
  good: 0x3ecf8e,
};

export function buildWall(font, target, { boss = false, tint = WALL_TINTS[0] } = {}) {
  const group = new THREE.Group();
  const D = boss ? 2.0 : 1.2; // boss walls are visibly thicker
  const text = String(target);
  const slabColor = boss ? COLORS.boss.slab : tint;
  const glowColor = boss ? COLORS.boss.glow : COLORS.glow;
  // The cutout uses the exact same per-digit layout as the number model
  // (see layoutGlyphs), so every digit's position and size match by
  // construction. Each digit hole is dilated by an ABSOLUTE margin around its
  // own center — spacing between digits is never scaled, and the fixed
  // DIGIT_GAP guarantees a solid web of wall between adjacent holes.
  const { chars } = layoutGlyphs(font, text, NUMBER_SIZE);

  // rounded-corner slab, like a plush foam block
  const R = 0.8;
  const hw = WALL_WIDTH / 2;
  const wallShape = new THREE.Shape();
  wallShape.moveTo(-hw + R, 0);
  wallShape.lineTo(hw - R, 0);
  wallShape.absarc(hw - R, R, R, -Math.PI / 2, 0, false);
  wallShape.lineTo(hw, WALL_HEIGHT - R);
  wallShape.absarc(hw - R, WALL_HEIGHT - R, R, 0, Math.PI / 2, false);
  wallShape.lineTo(-hw + R, WALL_HEIGHT);
  wallShape.absarc(-hw + R, WALL_HEIGHT - R, R, Math.PI / 2, Math.PI, false);
  wallShape.lineTo(-hw, R);
  wallShape.absarc(-hw + R, R, R, Math.PI, Math.PI * 1.5, false);
  wallShape.closePath();

  const islandShapes = []; // enclosed counters of 0, 4, 6, 8, 9 — float like show-wall styrofoam
  const glowShapes = [];   // silhouette used for the in-hole glow
  for (const c of chars) {
    // Digit hole grows by an absolute margin PER AXIS around its own center:
    // +HOLE_MARGIN on each side horizontally and vertically, independently.
    // A uniform scale would inflate narrow digits (like 1) vertically too,
    // making their holes taller than wide digits' — per-axis expansion keeps
    // every digit hole the same height and the margins visually even.
    const kx = 1 + HOLE_MARGIN / Math.max(c.w / 2, 0.15);
    const ky = 1 + HOLE_MARGIN / Math.max((c.maxY - c.minY) / 2, 0.15);
    for (const e of c.extracted) {
      const outer = e.shape.map(p => new THREE.Vector2(
        c.cx + (p.x - c.ccx) * kx,
        HOLE_Y + c.cyOff + (p.y - c.ccy) * ky
      ));
      wallShape.holes.push(new THREE.Path(outer));
      const glow = new THREE.Shape(outer);
      for (const h of e.holes) {
        // The glow silhouette shows the counter at its TRUE size, so digits
        // like 0/4/6/8/9 read with correct font proportions from any distance.
        const trueCounter = h.map(p => new THREE.Vector2(
          c.cx + (p.x - c.ccx),
          HOLE_Y + c.cyOff + (p.y - c.ccy)
        ));
        glow.holes.push(new THREE.Path(trueCounter));
        // The PHYSICAL island shrinks only as much as the pass-through needs:
        // the model's bevel plus the island's own bevel plus a little slack.
        let hMinX = Infinity, hMaxX = -Infinity, hMinY = Infinity, hMaxY = -Infinity;
        for (const p of h) {
          hMinX = Math.min(hMinX, p.x); hMaxX = Math.max(hMaxX, p.x);
          hMinY = Math.min(hMinY, p.y); hMaxY = Math.max(hMaxY, p.y);
        }
        const hcx = (hMinX + hMaxX) / 2, hcy = (hMinY + hMaxY) / 2;
        const sx = THREE.MathUtils.clamp(1 - ISLAND_MARGIN / Math.max((hMaxX - hMinX) / 2, 0.1), 0.45, 0.88);
        const sy = THREE.MathUtils.clamp(1 - ISLAND_MARGIN / Math.max((hMaxY - hMinY) / 2, 0.1), 0.45, 0.88);
        islandShapes.push(new THREE.Shape(h.map(p => new THREE.Vector2(
          c.cx + (hcx - c.ccx) + (p.x - hcx) * sx,
          HOLE_Y + c.cyOff + (hcy - c.ccy) + (p.y - hcy) * sy
        ))));
      }
      glowShapes.push(glow);
    }
  }

  const wallMat = new THREE.MeshStandardMaterial({ color: slabColor, roughness: boss ? 0.6 : 0.75, metalness: boss ? 0.35 : 0 });
  // soft bevel on every edge — slab rim and cutout rim both read as molded foam
  // (kept small so the web of wall between adjacent digit holes stays solid)
  const extrudeOpts = { depth: D, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.06, bevelSegments: 2, curveSegments: 12 };
  const wallGeo = new THREE.ExtrudeGeometry(wallShape, extrudeOpts);
  wallGeo.translate(0, 0, -D / 2);
  const wallMesh = new THREE.Mesh(wallGeo, wallMat);
  wallMesh.castShadow = true;
  wallMesh.receiveShadow = true;
  group.add(wallMesh);

  // islands get a slimmer bevel than the slab so they eat less of the
  // clearance budget and can stay closer to true counter size
  const islandExtrudeOpts = { depth: D, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.03, bevelSegments: 2, curveSegments: 12 };
  for (const s of islandShapes) {
    const g = new THREE.ExtrudeGeometry(s, islandExtrudeOpts);
    g.translate(0, 0, -D / 2);
    const m = new THREE.Mesh(g, wallMat);
    m.castShadow = true;
    group.add(m);
  }

  // "TARGET" caption above the cutout, like a signpost
  const capShapes = font.generateShapes(boss ? 'BOSS' : 'TARGET', 0.78);
  const capGeo = new THREE.ShapeGeometry(capShapes, 8);
  capGeo.computeBoundingBox();
  const cb = capGeo.boundingBox;
  capGeo.translate(-(cb.max.x + cb.min.x) / 2, 0, 0);
  const capMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 });
  const cap = new THREE.Mesh(capGeo, capMat);
  cap.position.set(0, WALL_HEIGHT - 1.5, D / 2 + 0.14);
  group.add(cap);

  // glowing number silhouette floating in the cutout: readable from afar, green = safe
  const glowMat = new THREE.MeshBasicMaterial({
    color: glowColor,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  glowMat.color.multiplyScalar(1.5); // past the bloom threshold — the cutout radiates
  glowMat.fog = false; // stays vivid at spawn distance so the target is always readable
  const glowMesh = new THREE.Mesh(new THREE.ShapeGeometry(glowShapes, 12), glowMat);
  group.add(glowMesh);

  return { group, target, glowMat, glowBase: 0.5, boss, baseGlow: glowColor, tint: slabColor };
}

export function setWallMatchGlow(wall, matched) {
  if (!wall) return;
  wall.glowMat.color.setHex(matched ? COLORS.good : wall.baseGlow).multiplyScalar(1.5);
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
