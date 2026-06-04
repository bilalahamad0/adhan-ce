// Runtime i18n: the chrome.storage + fetch-backed half of lib/i18n.js that the
// pure-helper suite (i18n.test.js) doesn't reach — catalog fetching/caching/merge,
// initI18n language resolution, and setLang persistence.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { initI18n, setLang, getCatalog, t, getLang, isRTL, dir } from '../lib/i18n.js';
import { makeChrome } from './helpers/chrome-mock.js';
import { makeFetch } from './helpers/fetch-mock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cat = (code) => JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8'));

function setup({ storage = {}, uiLang = 'en-US' } = {}) {
  const chrome = makeChrome({ initialStorage: storage, uiLang });
  const fetch = makeFetch([
    [
      'locales/',
      (url) => {
        const m = url.match(/locales\/(\w+)\.json/);
        const code = m[1];
        if (!['en', 'ar', 'ur', 'id', 'tr', 'fr'].includes(code)) return { status: 404 };
        return cat(code);
      },
    ],
  ]);
  globalThis.chrome = chrome;
  globalThis.fetch = fetch;
  return { chrome, fetch };
}

afterEach(() => {
  delete globalThis.chrome;
  delete globalThis.fetch;
});

describe('getCatalog', () => {
  it('returns the English base for en / no code', async () => {
    setup();
    const en = cat('en');
    expect(await getCatalog('en')).toEqual(en);
    expect(await getCatalog()).toEqual(en);
  });

  it('overlays the requested language on top of English (translations win)', async () => {
    setup();
    const merged = await getCatalog('ar');
    expect(merged.prayer_Fajr).toBe(cat('ar').prayer_Fajr);
    // Every English key is present even if a translation were ever missing.
    for (const k of Object.keys(cat('en'))) expect(k in merged).toBe(true);
  });

  it('falls back to English-only when a catalog fetch fails', async () => {
    setup();
    expect(await getCatalog('xx')).toEqual(cat('en')); // 404 → {} merge
  });

  it('caches catalogs (a second read makes no new request)', async () => {
    const { fetch } = setup();
    await getCatalog('tr');
    await getCatalog('tr');
    expect(fetch.calls.filter((u) => u.includes('tr.json'))).toHaveLength(1);
  });
});

describe('initI18n', () => {
  it('prefers the saved language and binds t()/dir() to it', async () => {
    setup({ storage: { lang: 'ar' } });
    expect(await initI18n()).toBe('ar');
    expect(getLang()).toBe('ar');
    expect(t('prayer_Fajr')).toBe(cat('ar').prayer_Fajr);
    expect(isRTL()).toBe(true);
    expect(dir()).toBe('rtl');
  });

  it('falls back to the browser UI locale when nothing is saved', async () => {
    setup({ uiLang: 'fr-FR' });
    expect(await initI18n()).toBe('fr');
    expect(t('save')).toBe(cat('fr').save);
    expect(dir()).toBe('ltr');
  });

  it('lands on English for an unsupported UI locale', async () => {
    setup({ uiLang: 'xx-YY' });
    expect(await initI18n()).toBe('en');
  });
});

describe('setLang', () => {
  it('switches the active catalog and persists the choice', async () => {
    const { chrome } = setup();
    await initI18n();
    expect(await setLang('tr')).toBe('tr');
    expect(getLang()).toBe('tr');
    expect(t('save')).toBe(cat('tr').save);
    expect(chrome.__.store.lang).toBe('tr'); // persisted for next launch
  });

  it('coerces an unsupported code to English', async () => {
    setup();
    expect(await setLang('zz')).toBe('en');
    expect(getLang()).toBe('en');
  });
});
