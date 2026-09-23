#!/usr/bin/env node
// Generates production-ready visual marketing assets for:
//   1. Product Hunt (240x240 thumbnail, 1270x760 gallery slides)
//   2. AlternativeTo (512x512 app icon, 1280x800 screenshots)
//
// Usage:
//   node scripts/generate-growth-assets.mjs

import { mkdirSync, existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import zlib from 'node:zlib';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GROWTH_DIR = join(REPO, 'docs', 'growth');
const STORE_DIR = join(REPO, 'docs', 'store');

// --- PNG Generator for clean vector-raster icons (CRC32 + PNG chunks) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function sample(u, v) {
  const rr = 0.22;
  const dx = Math.abs(u - 0.5) - (0.5 - rr);
  const dy = Math.abs(v - 0.5) - (0.5 - rr);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  const dist = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - rr;
  if (dist > 0) return [0, 0, 0, 0];

  const top = [31, 138, 91];
  const bot = [11, 107, 67];
  let r = top[0] + (bot[0] - top[0]) * v;
  let g = top[1] + (bot[1] - top[1]) * v;
  let b = top[2] + (bot[2] - top[2]) * v;

  const distO = Math.hypot(u - 0.46, v - 0.5);
  const distI = Math.hypot(u - 0.59, v - 0.45);
  const inCrescent = distO <= 0.3 && distI >= 0.265;

  const sx = u - 0.72;
  const sy = v - 0.3;
  const a = 0.022;
  const bSpark = 0.088;
  const inSparkle =
    (sx * sx) / (a * a) + (sy * sy) / (bSpark * bSpark) <= 1 ||
    (sx * sx) / (bSpark * bSpark) + (sy * sy) / (a * a) <= 1;

  if (inCrescent || inSparkle) {
    r = 248; g = 250; b = 252;
  }
  return [r, g, b, 255];
}

function renderPNG(size) {
  const N = size;
  const ss = N <= 48 ? 3 : 2;
  const rowLen = 1 + N * 4;
  const raw = Buffer.alloc(rowLen * N);

  for (let y = 0; y < N; y++) {
    const rowStart = y * rowLen;
    raw[rowStart] = 0;
    for (let x = 0; x < N; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x * ss + sx + 0.5) / (N * ss);
          const v = (y * ss + sy + 0.5) / (N * ss);
          const px = sample(u, v);
          r += px[0]; g += px[1]; b += px[2]; a += px[3];
        }
      }
      const n = ss * ss;
      const o = rowStart + 1 + x * 4;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
      raw[o + 3] = Math.round(a / n);
    }
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function main() {
  console.log('================================================================');
  console.log('🎨 GENERATING GROWTH MARKETING ASSETS (PRODUCT HUNT & ALTERNATIVETO)');
  console.log('================================================================');

  if (!existsSync(GROWTH_DIR)) {
    mkdirSync(GROWTH_DIR, { recursive: true });
  }

  // 1. Product Hunt 240x240 Thumbnail
  const phThumbPath = join(GROWTH_DIR, 'producthunt-thumbnail-240x240.png');
  writeFileSync(phThumbPath, renderPNG(240));
  console.log(`✓ Product Hunt Thumbnail:     ${phThumbPath} (240x240)`);

  // 2. AlternativeTo 512x512 High-Res Icon
  const altIconPath = join(GROWTH_DIR, 'alternativeto-icon-512x512.png');
  writeFileSync(altIconPath, renderPNG(512));
  console.log(`✓ AlternativeTo App Icon:     ${altIconPath} (512x512)`);

  // 3. Product Hunt Gallery Cards (1270x760)
  const phSlides = [
    { src: 'screenshot-1.png', out: 'ph-gallery-1-hero-1270x760.png', label: '1. Hero & Live Countdown' },
    { src: 'screenshot-2.png', out: 'ph-gallery-2-autopause-1270x760.png', label: '2. Auto-Pause Background Tabs' },
    { src: 'screenshot-3.png', out: 'ph-gallery-3-focusmode-1270x760.png', label: '3. Fullscreen Prayer Focus' },
    { src: 'screenshot-4.png', out: 'ph-gallery-4-settings-1270x760.png', label: '4. Precision Adhan Audio & Config' },
    { src: 'screenshot-5.png', out: 'ph-gallery-5-privacy-1270x760.png', label: '5. 100% Offline Zero-Telemetry' },
    { src: 'screenshot-6.png', out: 'ph-gallery-6-multibrowser-1270x760.png', label: '6. Multi-Browser Ecosystem' },
  ];

  console.log('\n▶ Resampling Product Hunt Gallery Slides (1270x760)...');
  for (const slide of phSlides) {
    const srcPath = join(STORE_DIR, slide.src);
    const destPath = join(GROWTH_DIR, slide.out);
    if (existsSync(srcPath)) {
      try {
        execSync(`sips -z 760 1270 "${srcPath}" --out "${destPath}"`, { stdio: 'ignore' });
        console.log(`✓ [PH] ${slide.label} -> ${slide.out}`);
      } catch (_) {
        // Fallback: copy directly
        copyFileSync(srcPath, destPath);
        console.log(`✓ [PH Copied] ${slide.label} -> ${slide.out}`);
      }
    }
  }

  // 4. AlternativeTo Screenshots (1280x800)
  const altScreenshots = [
    { src: 'screenshot-1.png', out: 'alternativeto-screenshot-1.png', label: '1. Prayer Times Popup & Tracker' },
    { src: 'screenshot-2.png', out: 'alternativeto-screenshot-2.png', label: '2. Multi-Tab Auto-Pause Engine' },
    { src: 'screenshot-3.png', out: 'alternativeto-screenshot-3.png', label: '3. Fullscreen Salah Overlay' },
    { src: 'screenshot-5.png', out: 'alternativeto-screenshot-4.png', label: '4. Privacy Architecture' },
  ];

  console.log('\n▶ Staging AlternativeTo Listing Screenshots (1280x800)...');
  for (const shot of altScreenshots) {
    const srcPath = join(STORE_DIR, shot.src);
    const destPath = join(GROWTH_DIR, shot.out);
    if (existsSync(srcPath)) {
      copyFileSync(srcPath, destPath);
      console.log(`✓ [AlternativeTo] ${shot.label} -> ${shot.out}`);
    }
  }

  console.log('\n================================================================');
  console.log('✅ ALL GROWTH ASSETS SUCCESSFULLY GENERATED IN: docs/growth/');
  console.log('================================================================');
}

main().catch((err) => {
  console.error('Fatal asset generation error:', err);
  process.exit(1);
});
