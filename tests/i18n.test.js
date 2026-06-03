// i18n: pure-helper unit tests + locale-catalog integrity (key + placeholder parity).
import { interpolate, makeT, resolveLang, isRTLLang, SUPPORTED } from '../lib/i18n.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOC = join(ROOT, 'locales');

describe('i18n core helpers', () => {
  it('interpolates {placeholders}, leaving unknown tokens intact', () => {
    expect(interpolate('in {time}', { time: '5m' })).toBe('in 5m');
    expect(interpolate('{a} and {b}', { a: 'x' })).toBe('x and {b}');
    expect(interpolate('no params', null)).toBe('no params');
    expect(interpolate(undefined, { a: 1 })).toBe(undefined);
  });

  it('t() prefers the active catalog, then English, then the key itself', () => {
    const t = makeT({ a: 'A-fr' }, { a: 'A-en', b: 'B-en' });
    expect(t('a')).toBe('A-fr'); // active wins
    expect(t('b')).toBe('B-en'); // english fallback
    expect(t('missing')).toBe('missing'); // key fallback (never blank)
    expect(t('a', null)).toBe('A-fr');
  });

  it('resolveLang prefers a saved supported lang, else maps the browser UI locale', () => {
    expect(resolveLang('ar', 'en-US')).toBe('ar');
    expect(resolveLang(null, 'ar-EG')).toBe('ar'); // region suffix stripped
    expect(resolveLang(null, 'tr')).toBe('tr');
    expect(resolveLang('zz', 'fr')).toBe('fr'); // unsupported saved -> fall through to UI
    expect(resolveLang(null, 'xx')).toBe('en'); // unknown UI -> English
    expect(resolveLang(undefined, undefined)).toBe('en');
  });

  it('flags RTL languages', () => {
    expect(isRTLLang('ar')).toBe(true);
    expect(isRTLLang('ur')).toBe(true);
    expect(isRTLLang('en')).toBe(false);
    expect(isRTLLang('fr')).toBe(false);
  });
});

describe('locale catalogs', () => {
  const files = readdirSync(LOC).filter((f) => f.endsWith('.json'));
  const cats = Object.fromEntries(
    files.map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(join(LOC, f), 'utf8'))])
  );
  const enKeys = Object.keys(cats.en).sort();
  const placeholders = (s) => (String(s).match(/\{\w+\}/g) || []).sort();

  it('ships a catalog for every SUPPORTED language', () => {
    for (const code of SUPPORTED) expect(cats[code]).toBeTruthy();
  });

  it('every catalog has exactly the English key set (no missing or extra keys)', () => {
    for (const cat of Object.values(cats)) {
      expect(Object.keys(cat).sort()).toEqual(enKeys);
    }
  });

  it('every translated string keeps the same {placeholders} as English', () => {
    for (const [code, cat] of Object.entries(cats)) {
      if (code === 'en') continue;
      for (const k of enKeys) {
        expect({ code, k, ph: placeholders(cat[k]) }).toEqual({ code, k, ph: placeholders(cats.en[k]) });
      }
    }
  });
});
