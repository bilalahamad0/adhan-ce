// Guards the packaged file set so the extension can never again ship missing a
// runtime module. Regression: v1.9.0 was released without lib/hijri.js +
// lib/tracker.js (the pack list wasn't updated), so popup.js's import graph
// failed to load and the published popup rendered as blank static HTML.
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFiles, stageExtension } from '../scripts/runtime-files.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Every ./lib/... module a runtime script statically imports.
function libImports(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  return [...src.matchAll(/from '\.\/(lib\/[\w.-]+)'/g)].map((m) => m[1]);
}

describe('packaged runtime files', () => {
  it('ships every lib/*.js module', async () => {
    const packaged = new Set(await runtimeFiles());
    const libModules = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js'));
    expect(libModules.length).toBeGreaterThan(0);
    for (const f of libModules) expect(packaged).toContain(`lib/${f}`);
  });

  it('ships every locales/*.json catalog', async () => {
    const packaged = new Set(await runtimeFiles());
    const catalogs = readdirSync(join(ROOT, 'locales')).filter((f) => f.endsWith('.json'));
    expect(catalogs.length).toBe(6);
    for (const f of catalogs) expect(packaged).toContain(`locales/${f}`);
  });

  it('ships every ./lib module imported by popup.js and background.js (the v1.9.0 break)', async () => {
    const packaged = new Set(await runtimeFiles());
    for (const entry of ['popup.js', 'background.js']) {
      const imports = libImports(entry);
      expect(imports.length).toBeGreaterThan(0);
      for (const imp of imports) {
        expect(packaged).toContain(imp); // e.g. lib/hijri.js, lib/tracker.js
      }
    }
  });

  it('ships the core top-level runtime files', async () => {
    const packaged = new Set(await runtimeFiles());
    for (const f of ['manifest.json', 'background.js', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css']) {
      expect(packaged).toContain(f);
    }
  });
});

// Store-safety: the dev-only "Test Adhan" trigger is gated by lib/buildinfo.js's
// DEV flag. Source ships DEV=true (so unpacked dev loads keep the trigger); the
// pack pipeline must flip the STAGED copy to DEV=false. If staging ever fails to
// do that, a packed CRX/ZIP/XPI would expose the dev trigger to real users — so
// this guard runs inside `npm run pack` (pack.sh runs Jest first) and in CI.
describe('build flag (store safety)', () => {
  it('source lib/buildinfo.js is DEV=true (unpacked dev loads keep the Test trigger)', () => {
    const src = readFileSync(join(ROOT, 'lib', 'buildinfo.js'), 'utf8');
    expect(src).toMatch(/export const DEV = true;/);
  });

  it('stageExtension forces the staged lib/buildinfo.js to DEV=false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adhan-pack-'));
    try {
      await stageExtension(dir);
      const staged = await readFile(join(dir, 'lib', 'buildinfo.js'), 'utf8');
      expect(staged).toMatch(/export const DEV = false;/);
      expect(staged).not.toMatch(/DEV\s*=\s*true/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
