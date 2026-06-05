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

import { readdir } from 'node:fs/promises';
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
