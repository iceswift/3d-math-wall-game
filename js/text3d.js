// Font loading and 3D number construction shared by the player character and walls.
import * as THREE from 'three';
import { FontLoader } from '../lib/FontLoader.js';
import { TextGeometry } from '../lib/TextGeometry.js';

export const NUMBER_SIZE = 2.5;  // base glyph size shared by the character and the cutout
export const DIGIT_GAP = 0.6;    // fixed tracking between digits (absolute units)
export const HOLE_MARGIN = 0.2;  // absolute clearance around each digit in the wall cutout

export function loadFont() {
  return new Promise((resolve, reject) => {
    new FontLoader().load('./lib/helvetiker_bold.typeface.json', resolve, undefined, reject);
  });
}

// one size formula for both the character and the wall cutout
export function glyphSizeFor(text, base = NUMBER_SIZE) {
  return text.length <= 1 ? base : text.length === 2 ? base * 0.85 : text.length === 3 ? base * 0.66 : base * 0.52;
}

// Shared per-digit layout used by BOTH the player model and the wall cutout,
// so they agree exactly on every digit's size, spacing, and center. Digits are
// laid out by their outline widths with a fixed gap, centered on (0, 0).
export function layoutGlyphs(font, text, size = NUMBER_SIZE) {
  const s = glyphSizeFor(text, size);
  const chars = [...text].map(ch => {
    const extracted = font.generateShapes(ch, s).map(sh => sh.extractPoints(12));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const e of extracted) {
      for (const p of e.shape) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    return { ch, extracted, minY, maxY, w: maxX - minX, ccx: (minX + maxX) / 2, ccy: (minY + maxY) / 2 };
  });
  const totalW = chars.reduce((a, c) => a + c.w, 0) + DIGIT_GAP * (chars.length - 1);
  let unionMinY = Infinity, unionMaxY = -Infinity;
  for (const c of chars) {
    unionMinY = Math.min(unionMinY, c.minY);
    unionMaxY = Math.max(unionMaxY, c.maxY);
  }
  const unionCy = (unionMinY + unionMaxY) / 2;
  let cursor = -totalW / 2;
  for (const c of chars) {
    c.cx = cursor + c.w / 2;   // layout center x of this digit
    c.cyOff = c.ccy - unionCy; // vertical offset of this digit's center from the string center
    cursor += c.w + DIGIT_GAP;
  }
  return { chars, size: s };
}

// The player character: one mesh per digit, positioned by the shared layout.
export function makeNumberGroup(font, text, material, size = NUMBER_SIZE) {
  const { chars, size: s } = layoutGlyphs(font, text, size);
  const group = new THREE.Group();
  for (const c of chars) {
    const geo = new TextGeometry(c.ch, {
      font,
      size: s,
      height: s * 0.38,
      curveSegments: 8,
      bevelEnabled: true,
      bevelThickness: s * 0.045,
      bevelSize: s * 0.035,
      bevelSegments: 3,
    });
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    geo.translate(
      -(bb.max.x + bb.min.x) / 2,
      -(bb.max.y + bb.min.y) / 2,
      -(bb.max.z + bb.min.z) / 2
    );
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.position.set(c.cx, c.cyOff, 0);
    group.add(mesh);
  }
  return group;
}
