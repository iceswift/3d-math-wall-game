// Font loading and 3D number geometry shared by the player character and walls.
import * as THREE from 'three';
import { FontLoader } from '../lib/FontLoader.js';
import { TextGeometry } from '../lib/TextGeometry.js';

export const NUMBER_SIZE = 2.2; // base glyph size shared by the character and the cutout
export const HOLE_SCALE = 1.22; // cutout is slightly larger than the number for clearance

export function loadFont() {
  return new Promise((resolve, reject) => {
    new FontLoader().load('./lib/helvetiker_bold.typeface.json', resolve, undefined, reject);
  });
}

// one size formula for both the character and the wall cutout, so a correct
// answer is always geometrically identical to the hole it must pass through
export function glyphSizeFor(text, base = NUMBER_SIZE) {
  return text.length <= 1 ? base : text.length === 2 ? base * 0.85 : text.length === 3 ? base * 0.66 : base * 0.52;
}

export function makeNumberGeometry(font, text, size = NUMBER_SIZE) {
  const s = glyphSizeFor(text, size);
  const geo = new TextGeometry(text, {
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
  return geo;
}
