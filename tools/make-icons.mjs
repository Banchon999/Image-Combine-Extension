/**
 * Generate the extension icons.
 *
 * Committed as a generator rather than as opaque binaries so the artwork can be
 * reviewed and regenerated from source. Run with:  node tools/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');

const BG = [79, 140, 255]; // matches --accent in the panel stylesheet
const FG = [255, 255, 255];

/** Minimal PNG encoder: 8-bit RGBA, one IDAT, no interlacing. */
function encodePng(width, height, rgba) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // Each scanline is prefixed with a filter byte; 0 means "no filter".
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Draw a rounded square with a downward arrow.
 *
 * Sampled at 3x and averaged down, which is cheaper than implementing proper
 * coverage-based antialiasing and looks the same at these sizes.
 */
function drawIcon(size) {
  const SS = 3;
  const dim = size * SS;
  const radius = dim * 0.22;
  const buffer = Buffer.alloc(size * size * 4);

  const insideRounded = (x, y) => {
    const inset = dim * 0.06;
    const lo = inset;
    const hi = dim - inset;
    if (x < lo || x > hi || y < lo || y > hi) return false;
    const cx = Math.min(Math.max(x, lo + radius), hi - radius);
    const cy = Math.min(Math.max(y, lo + radius), hi - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2 || (x >= lo + radius && x <= hi - radius) || (y >= lo + radius && y <= hi - radius);
  };

  // Arrow: a vertical shaft above a triangular head, both centred.
  const inArrow = (x, y) => {
    const cx = dim / 2;
    const shaftW = dim * 0.11;
    const shaftTop = dim * 0.26;
    const shaftBottom = dim * 0.55;
    if (Math.abs(x - cx) <= shaftW / 2 && y >= shaftTop && y <= shaftBottom) return true;
    const headTop = dim * 0.5;
    const headBottom = dim * 0.72;
    const headHalf = dim * 0.22;
    if (y >= headTop && y <= headBottom) {
      const t = (y - headTop) / (headBottom - headTop);
      if (Math.abs(x - cx) <= headHalf * (1 - t)) return true;
    }
    // Baseline under the arrow, the usual "save to disk" cue.
    return y >= dim * 0.78 && y <= dim * 0.86 && Math.abs(x - cx) <= dim * 0.26;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x * SS + sx + 0.5;
          const py = y * SS + sy + 0.5;
          if (!insideRounded(px, py)) continue;
          const colour = inArrow(px, py) ? FG : BG;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          a += 255;
        }
      }
      const samples = SS * SS;
      const i = (y * size + x) * 4;
      if (a > 0) {
        const covered = a / 255;
        buffer[i] = Math.round(r / covered);
        buffer[i + 1] = Math.round(g / covered);
        buffer[i + 2] = Math.round(b / covered);
        buffer[i + 3] = Math.round(a / samples);
      }
    }
  }
  return encodePng(size, size, buffer);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of [16, 32, 128]) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, drawIcon(size));
  console.log(`wrote ${file}`);
}
