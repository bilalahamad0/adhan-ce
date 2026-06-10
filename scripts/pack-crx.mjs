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
import { stageExtension } from './runtime-files.mjs';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAGE = join(REPO, 'dist', 'extension');

// The packaged file set and staging logic live in scripts/runtime-files.mjs
// (single source of truth, shared with docs/pack.sh and guarded by
// tests/pack.test.js). lib/ + locales/ ship in full, so a newly-added
// module/locale can never be silently dropped; stageExtension() also forces
// lib/buildinfo.js to DEV=false so no signed CRX ships the dev Test trigger.

async function readManifestVersion() {
  const txt = await readFile(join(REPO, 'manifest.json'), 'utf8');
  return JSON.parse(txt).version;
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

  await stageExtension(STAGE);

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

// Only pack when run directly (e.g. `node scripts/pack-crx.mjs`); importing this
// module (e.g. from tests/pack.test.js) must not kick off a build.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('Pack failed:', e.message);
    process.exit(1);
  });
}
