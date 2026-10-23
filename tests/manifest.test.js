// Pre-publish qualification checks for the packaged extension.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { auditManifestPrivacy } from '../lib/privacy-guard.js';

const EXT = join(dirname(fileURLToPath(import.meta.url)), '..');

const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const exists = (p) => existsSync(join(EXT, p));

describe('manifest qualification', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  it('has name, semver version, and a store-length description', () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeLessThanOrEqual(132); // Web Store limit
  });

  it('declares a module service worker that exists', () => {
    expect(manifest.background.type).toBe('module');
    expect(exists(manifest.background.service_worker)).toBe(true);
  });

  it('references action popup + icons that exist and are real PNGs', () => {
    expect(exists(manifest.action.default_popup)).toBe(true);
    for (const size of ['16', '48', '128']) {
      const p = manifest.icons[size];
      expect(p).toBeTruthy();
      expect(exists(p)).toBe(true);
      expect(readFileSync(join(EXT, p)).subarray(0, 4)).toEqual(PNG_MAGIC);
    }
  });

  it('content scripts reference existing js/css', () => {
    for (const cs of manifest.content_scripts) {
      for (const f of [...(cs.js || []), ...(cs.css || [])]) {
        expect(exists(f)).toBe(true);
      }
    }
  });

  it('requests only the expected permissions (no scope creep)', () => {
    expect(new Set(manifest.permissions)).toEqual(
      new Set(['storage', 'alarms', 'notifications', 'scripting', 'offscreen'])
    );
  });

  it('does not request the redundant "tabs" permission', () => {
    // chrome.tabs.query({url})/sendMessage work without "tabs" because the broad
    // host_permissions already grant tab-URL access; requesting it too would only
    // widen the review surface. Keep it out unless host_permissions are narrowed.
    expect(manifest.permissions).not.toContain('tabs');
  });

  it('passes privacy audit (no identity, cookies, webRequest, or externally_connectable)', () => {
    const audit = auditManifestPrivacy(manifest);
    expect(audit.valid).toBe(true);
    expect(audit.errors).toEqual([]);
    expect(manifest.permissions).not.toContain('identity');
    expect(manifest.permissions).not.toContain('identity.email');
    expect(manifest.permissions).not.toContain('cookies');
    expect(manifest.permissions).not.toContain('webRequest');
    expect(manifest.externally_connectable).toBeUndefined();
  });


  it('host permissions are all http/https sites, and nothing they already cover', () => {
    // All sites, for pausing media in any tab; that covers the prayer-times API
    // (api.aladhan.com) too. Opera's review rejects a host listed beside a pattern
    // that already grants it, as "https://api.aladhan.com/*" was.
    expect(manifest.host_permissions).toEqual(['http://*/*', 'https://*/*']);
    // No entry is granted by another (scheme, host with "*." wildcard, path "/*").
    const parts = (p) => p.match(/^(\*|https?):\/\/([^/]+)(\/.*)$/).slice(1);
    const covers = (a, b) => {
      const [sa, ha, pa] = parts(a);
      const [sb, hb, pb] = parts(b);
      return (sa === '*' || sa === sb) && (ha === '*' || ha === hb || (ha.startsWith('*.') && hb.endsWith(ha.slice(1)))) && (pa === '/*' || pa === pb);
    };
    for (const p of manifest.host_permissions) {
      expect(manifest.host_permissions.filter((q) => q !== p && covers(q, p))).toEqual([]);
    }
    // The retired companion proxy host must no longer be requested.
    expect(manifest.host_permissions).not.toContain('https://adhan-api-mauve.vercel.app/*');
  });

  it('exposes to web pages only what the content script loads in them', () => {
    // content.js shows the toolbar icon (48 px) in its overlays; nothing else of the
    // package is loaded from a page (the chime plays in the worker's offscreen
    // document or the popup, the 16/128 px icons only in the browser's own UI).
    expect(manifest.web_accessible_resources).toEqual([
      { resources: ['icons/icon48.png'], matches: ['http://*/*', 'https://*/*'], use_dynamic_url: true },
    ]);
    const content = readFileSync(join(EXT, 'content.js'), 'utf8');
    const loaded = new Set([...content.matchAll(/getURL\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]));
    expect([...loaded]).toEqual(manifest.web_accessible_resources[0].resources);
    for (const r of loaded) expect(exists(r)).toBe(true);
  });

  it('defines the toggle-focus command with a suggested key', () => {
    const cmd = manifest.commands['toggle-focus'];
    expect(cmd).toBeTruthy();
    expect(cmd.suggested_key.default).toBeTruthy();
  });

  it('configures MV3 service worker without invalid MV2 background.scripts', () => {
    // Chrome / MV3 service worker
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background.type).toBe('module');
    expect(manifest.background.scripts).toBeUndefined();
    expect(manifest.minimum_chrome_version).toBe('121');
    // AMO requirements: a stable add-on id, a min version that grants host
    // permissions at install, and the mandatory data-collection disclosure.
    // We declare "locationInfo" because the chosen city (→ aladhan) and the
    // typed location-search text (→ Open-Meteo geocoding) are transmitted
    // off-device; declaring "none" would be inaccurate for that transmission.
    const gecko = manifest.browser_specific_settings.gecko;
    expect(gecko.id).toBe('adhan-caster@bilalahamad.com');
    expect(gecko.strict_min_version).toBe('140.0');
    expect(gecko.data_collection_permissions.required).toEqual(['locationInfo']);
  });

  it('configures Firefox for Android compatibility (gecko_android)', () => {
    const geckoAndroid = manifest.browser_specific_settings.gecko_android;
    expect(geckoAndroid).toBeDefined();
    expect(geckoAndroid.strict_min_version).toBe('142.0');
  });
});

describe('package hygiene (pre-publish)', () => {
  it('has no leftover dev preview file in the extension root', () => {
    expect(exists('index.html')).toBe(false);
  });

  it('popup only references files that exist (no dead links)', () => {
    const html = readFileSync(join(EXT, manifest.action.default_popup), 'utf8');
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((r) => !r.startsWith('http') && !r.startsWith('data:') && !r.startsWith('#'));
    for (const r of refs) expect(exists(r.split('?')[0])).toBe(true);
  });

  it('the popup loads as an ES module (so lib imports resolve)', () => {
    const html = readFileSync(join(EXT, manifest.action.default_popup), 'utf8');
    expect(html).toMatch(/<script[^>]+type="module"[^>]+popup\.js/);
  });
});
