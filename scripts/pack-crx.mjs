#!/usr/bin/env node
// Pack the extension's runtime files into a signed CRX3.
//
// Usage:
//   node scripts/pack-crx.mjs [keyPath] [outPath]
//
//   keyPath  defaults to ./adhan-caster-pro-private.pem (repo root)
//   outPath  defaults to ./adhan-caster-pro-<manifest.version>.crx (repo root)
//
// Used by both the GitHub Actions release workflow and a local manual pack
// (`npm run pack:crx`). Stages only the files Chrome needs at runtime into
// dist/extension/, then invokes crx3 against the staged directory so the
// resulting CRX never contains dev-only files (tests, docs, package.json).

import crx3 from 'crx3';
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(REPO, 'dist', 'extension');

// Runtime file manifest — kept in sync with docs/pack.sh's ZIP build.
// IMPORTANT: keep these two lists aligned or `npm run pack` and
// `npm run pack:crx` will disagree on what ships.
const RUNTIME_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.js',
  'popup.css',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
  'lib/schedule.js',
  'lib/geocode.js',
];

async function readManifestVersion() {
  const txt = await readFile(join(REPO, 'manifest.json'), 'utf8');
  return JSON.parse(txt).version;
}

async function stage() {
  // Fresh dir every run — avoids stale files from a previous pack.
  await rm(STAGE, { recursive: true, force: true });
  for (const rel of RUNTIME_FILES) {
    const src = join(REPO, rel);
    const dst = join(STAGE, rel);
    if (!existsSync(src)) {
      throw new Error(`Missing runtime file: ${rel}`);
    }
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
}

async function main() {
  const version = await readManifestVersion();
  const keyPath = resolve(process.argv[2] || join(REPO, 'adhan-caster-pro-private.pem'));
  const crxPath = resolve(process.argv[3] || join(REPO, `adhan-caster-pro-${version}.crx`));

  if (!existsSync(keyPath)) {
    console.error(`ERROR: private key not found at ${keyPath}`);
    console.error('Pass an explicit path: node scripts/pack-crx.mjs <key.pem> [out.crx]');
    process.exit(2);
  }

  await stage();

  // crx3 walks the directory containing the manifest.json passed to it.
  await crx3([join(STAGE, 'manifest.json')], {
    keyPath,
    crxPath,
  });

  // Verify CRX3 magic header so a corrupted output fails loudly, not silently.
  const head = (await readFile(crxPath)).subarray(0, 4).toString('ascii');
  if (head !== 'Cr24') {
    throw new Error(`Output is not a CRX file (magic header was '${head}', expected 'Cr24')`);
  }

  const s = await stat(crxPath);
  console.log(`✓ Packed ${crxPath} (${s.size} bytes, v${version})`);
}

main().catch((e) => {
  console.error('Pack failed:', e.message);
  process.exit(1);
});
