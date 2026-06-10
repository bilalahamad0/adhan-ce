// Pack the extension's runtime files into an unsigned Firefox XPI (a plain ZIP).
//
// Usage:
//   node scripts/pack-xpi.mjs [outPath]
//   outPath  defaults to ./adhan-caster-pro-<manifest.version>.xpi (repo root)
//
// Unlike the Chrome CRX there is NO local signing key — AMO signs XPIs
// server-side (web-ext sign / the addons.mozilla.org API, wired up in Phase 3).
// Stages via the shared stageExtension() (which forces lib/buildinfo.js to
// DEV=false), then zips the STAGED tree so the dev Test trigger can never ship.
// The staged dir (dist/firefox) is left in place so `npm run lint:firefox` can
// point addons-linter at it. Requires the `zip` CLI, same as `npm run pack`.

import { stageExtension, REPO } from './runtime-files.mjs';
import { readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pexec = promisify(execFile);
// A separate stage dir from pack-crx's dist/extension, so the two packers never
// clobber each other when run back to back.
const STAGE = join(REPO, 'dist', 'firefox');

// Firefox/AMO caps the extension name at 45 chars; the shared (Chrome) name is
// 46. The XPI ships this shorter name; the committed source and the Chrome
// builds keep the full name. Must stay <= 45 (tests/pack.test.js enforces it).
export const FIREFOX_NAME = 'Adhan Caster: Muslim Prayer Times & Autopause';

export async function packXpi(outPath) {
  const version = JSON.parse(await readFile(join(REPO, 'manifest.json'), 'utf8')).version;
  const xpiPath = resolve(outPath || join(REPO, `adhan-caster-pro-${version}.xpi`));

  await stageExtension(STAGE, { manifestName: FIREFOX_NAME });
  await rm(xpiPath, { force: true });
  // -r recurse, -q quiet, -X strip platform extra-attrs for a reproducible zip.
  await pexec('zip', ['-rqX', xpiPath, '.'], { cwd: STAGE });

  if (!existsSync(xpiPath)) throw new Error('zip did not produce the XPI');
  const s = await stat(xpiPath);
  return { xpiPath, version, size: s.size, stageDir: STAGE };
}

// Run directly (e.g. `node scripts/pack-xpi.mjs`); importing must not pack.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packXpi(process.argv[2])
    .then(({ xpiPath, version, size }) => console.log(`✓ Packed ${xpiPath} (${size} bytes, v${version})`))
    .catch((e) => {
      console.error('XPI pack failed:', e.message);
      process.exit(1);
    });
}
