#!/usr/bin/env node
// Pack the extension's runtime files into a ZIP for the Opera Add-ons store.
//
// Usage:
//   node scripts/pack-opera.mjs [outPath]
//   outPath  defaults to ./adhan-focus-<manifest.version>-opera.zip
//
// Opera is Chromium (Blink), so the package is the Chromium one — same MV3
// manifest, same background.service_worker, same runtime files — with the
// Firefox-only `browser_specific_settings` block and `background.scripts`
// stripped, matching the clean Chromium MV3 standard. Stages via the shared
// stageExtension() (which forces lib/buildinfo.js to DEV=false), then zips the
// STAGED tree so the dev Test trigger can never ship. The staged dir
// (dist/opera) is left in place for inspection. Requires the `zip` CLI.

import { stageExtension, REPO } from './runtime-files.mjs';
import { readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
// A separate stage dir from dist/extension, dist/edge and dist/firefox, so
// packers never clobber each other.
const STAGE = join(REPO, 'dist', 'opera');

export async function packOpera(outPath) {
  const version = JSON.parse(await readFile(join(REPO, 'manifest.json'), 'utf8')).version;
  const zipPath = resolve(outPath || join(REPO, `adhan-focus-${version}-opera.zip`));

  // stripGecko + stripBackgroundScripts: Opera is Chromium MV3 and requires a clean
  // service_worker entry point without Gecko browser_specific_settings or background.scripts.
  await stageExtension(STAGE, { stripGecko: true, stripBackgroundScripts: true });
  await rm(zipPath, { force: true });

  // -r recurse, -q quiet, -X strip platform extra-attrs for a reproducible zip.
  await pexec('zip', ['-rqX', zipPath, '.'], { cwd: STAGE });

  if (!existsSync(zipPath)) throw new Error('zip did not produce the Opera package');
  const s = await stat(zipPath);
  return { zipPath, version, size: s.size, stageDir: STAGE };
}

// Run directly (e.g. `node scripts/pack-opera.mjs`); importing must not pack.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packOpera(process.argv[2])
    .then(({ zipPath, version, size }) => console.log(`✓ Packed ${zipPath} (${size} bytes, v${version})`))
    .catch((e) => {
      console.error('Opera pack failed:', e.message);
      process.exit(1);
    });
}
