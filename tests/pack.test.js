// Guards the packaged file set so the extension can never again ship missing a
// runtime module. Regression: v1.9.0 was released without lib/hijri.js +
// lib/tracker.js (the pack list wasn't updated), so popup.js's import graph
// failed to load and the published popup rendered as blank static HTML.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeFiles } from '../scripts/runtime-files.mjs';

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
