#!/usr/bin/env node
// Pack the extension's runtime files into a ZIP for the Microsoft Edge Add-ons
// store.
//
// Usage:
//   node scripts/pack-edge.mjs [outPath]
//   outPath  defaults to ./adhan-caster-pro-<manifest.version>-edge.zip
//
// Edge is Chromium, so the package is the Chrome one — same MV3 manifest, same
// background.service_worker, same runtime files — with two edits to the staged
// manifest: the Firefox-only `browser_specific_settings` block is removed
// (stripGecko), and so is `background.scripts` (stripBackgroundScripts). The
// second is not cosmetic — Edge validates MV3 strictly and REJECTS a package
// declaring background.scripts alongside service_worker, where Chrome simply
// ignores it. Both options live in runtime-files.mjs. Stages via the shared
// stageExtension() (which forces lib/buildinfo.js to DEV=false), then zips the
// STAGED tree so the dev Test trigger can never ship. The staged dir
// (dist/edge) is left in place for inspection. Requires the `zip` CLI, same as
// `npm run pack`.

import { stageExtension, REPO } from './runtime-files.mjs';
import { readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
// A separate stage dir from pack-crx's dist/extension and pack-xpi's
// dist/firefox, so the three packers never clobber each other back to back.
const STAGE = join(REPO, 'dist', 'edge');

export async function packEdge(outPath) {
  const version = JSON.parse(await readFile(join(REPO, 'manifest.json'), 'utf8')).version;
  const zipPath = resolve(outPath || join(REPO, `adhan-caster-pro-${version}-edge.zip`));

  // stripBackgroundScripts: Edge rejects an MV3 package that declares
  // background.scripts alongside service_worker — the mirror of the Firefox strip.
  await stageExtension(STAGE, { stripGecko: true, stripBackgroundScripts: true });
  await rm(zipPath, { force: true });
  // -r recurse, -q quiet, -X strip platform extra-attrs for a reproducible zip.
  await pexec('zip', ['-rqX', zipPath, '.'], { cwd: STAGE });

  if (!existsSync(zipPath)) throw new Error('zip did not produce the Edge package');
  const s = await stat(zipPath);
  return { zipPath, version, size: s.size, stageDir: STAGE };
}

// Run directly (e.g. `node scripts/pack-edge.mjs`); importing must not pack.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packEdge(process.argv[2])
    .then(({ zipPath, version, size }) => console.log(`✓ Packed ${zipPath} (${size} bytes, v${version})`))
    .catch((e) => {
      console.error('Edge pack failed:', e.message);
      process.exit(1);
    });
}
