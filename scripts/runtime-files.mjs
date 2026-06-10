// Single source of truth for the files that ship in the packaged extension.
//
// The lib/ and locales/ directories ship IN FULL — every file in them is a
// runtime dependency (ES modules imported by background.js / popup.js, and the
// i18n JSON catalogs). Listing the directories instead of individual files means
// a newly-added module or locale can never be silently dropped from the build.
//
// Regression context: v1.9.0 added lib/hijri.js + lib/tracker.js but the old
// hardcoded pack list wasn't updated, so the released package lacked them.
// popup.js imports both, so its module graph failed to load and the popup
// rendered as blank static HTML. tests/pack.test.js now guards against this.

import { readdir, readFile, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Explicit top-level runtime files (Chrome needs each of these at root).
export const RUNTIME_FILES = [
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
];

// Directories shipped in full (all files within).
export const RUNTIME_DIRS = ['lib', 'locales'];

// The complete, resolved list of repo-relative paths to package.
export async function runtimeFiles() {
  const files = [...RUNTIME_FILES];
  for (const dir of RUNTIME_DIRS) {
    const entries = await readdir(join(REPO, dir), { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && !e.name.startsWith('.')) files.push(`${dir}/${e.name}`);
    }
  }
  return files;
}

// The one line that defines a packaged (non-dev) build. Both packers write
// exactly this into the staged lib/buildinfo.js so no shipped artifact — Chrome
// CRX/ZIP or a future Firefox XPI — can ever carry DEV=true. See lib/buildinfo.js
// and the store-safety guard in tests/pack.test.js.
export const PACKED_BUILDINFO = 'export const DEV = false;\n';

// Stage every runtime file into `stageDir`, then force the build flag off by
// overwriting the staged lib/buildinfo.js with DEV=false. Source keeps DEV=true
// (so unpacked dev loads show the Test affordance); only the staged copy is
// flipped. This is the single staging path shared by scripts/pack-crx.mjs (CRX),
// docs/pack.sh (ZIP) and scripts/pack-xpi.mjs (Firefox XPI), so the packers can
// never diverge on contents or on the build flag.
//
// opts.manifestName: optionally override the staged manifest.json `name` (the
// shared source is untouched). Firefox/AMO caps the name at 45 chars while the
// Chrome name is longer, so the XPI packer passes a shorter Firefox name here;
// the Chrome packers omit it and keep the full source name. Returns stageDir.
export async function stageExtension(stageDir, { manifestName } = {}) {
  // Fresh dir every run — avoids stale files from a previous pack.
  await rm(stageDir, { recursive: true, force: true });
  for (const rel of await runtimeFiles()) {
    const src = join(REPO, rel);
    const dst = join(stageDir, rel);
    if (!existsSync(src)) throw new Error(`Missing runtime file: ${rel}`);
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
  }
  // Force the build flag off LAST, so this overwrite is unconditional even if
  // lib/ had no other copyable file. Store-safety invariant — do not reorder.
  await mkdir(join(stageDir, 'lib'), { recursive: true });
  await writeFile(join(stageDir, 'lib', 'buildinfo.js'), PACKED_BUILDINFO);
  // Per-target manifest name override (Firefox only) — rewrites the staged copy,
  // never the committed source.
  if (manifestName) {
    const mfPath = join(stageDir, 'manifest.json');
    const mf = JSON.parse(await readFile(mfPath, 'utf8'));
    mf.name = manifestName;
    await writeFile(mfPath, JSON.stringify(mf, null, 2) + '\n');
  }
  return stageDir;
}
