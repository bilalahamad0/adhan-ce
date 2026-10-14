/**
 * @jest-environment jsdom
 */
// welcome.js is the onboarding page opened on install. The place picked there must
// reach the worker as a settings change, so the schedule fetched at install for
// the default city is replaced by the chosen city's (a user searching Casablanca
// kept Sunnyvale's prayer times until the next day).
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeChrome } from './helpers/chrome-mock.js';
import { makeFetch, aladhanPayload } from './helpers/fetch-mock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BODY = readFileSync(join(ROOT, 'welcome.html'), 'utf8').match(/<body[^>]*>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const cat = (code) => JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8'));
// What the worker stored on install: its defaults.
const INSTALLED = { enabled: true, city: 'Sunnyvale', state: 'California', country: 'United States', method: 2, school: 0 };

let chrome;
let counter = 0;
const settle = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

async function load({ send, uiLang, storage = {} } = {}) {
  document.body.innerHTML = BODY;
  document.documentElement.lang = 'en';
  document.documentElement.dir = '';
  window.HTMLCanvasElement.prototype.getContext = () => null; // no confetti under jsdom
  chrome = makeChrome({ initialStorage: { settings: INSTALLED, ...storage }, uiLang, handleSendMessage: send || (() => ({ ok: true })) });
  globalThis.chrome = chrome;
  globalThis.fetch = makeFetch([
    ['locales/', (url) => cat(url.match(/locales\/(\w+)\.json/)[1])],
    [
      'geocoding-api.open-meteo.com',
      { results: [{ name: 'Casablanca', admin1: 'Casablanca-Settat', country: 'Morocco', country_code: 'MA', latitude: 33.59, longitude: -7.62 }] },
    ],
    ['api.aladhan.com', aladhanPayload({ meta: { timezone: 'Africa/Casablanca' } })],
    ['reverse-geocode-client', { latitude: 33.59, longitude: -7.62, city: 'Casablanca', principalSubdivision: 'Casablanca-Settat', countryName: 'Morocco' }],
  ]);
  // Run only this import's init: each test's fresh module would otherwise add
  // another DOMContentLoaded listener to the shared document.
  const inits = [];
  const addListener = document.addEventListener;
  document.addEventListener = function (type, fn, ...rest) {
    if (type === 'DOMContentLoaded') inits.push(fn);
    else addListener.call(this, type, fn, ...rest);
  };
  try {
    await import(`../welcome.js?t=${++counter}`);
  } finally {
    document.addEventListener = addListener;
  }
  await Promise.all(inits.map((init) => init()));
  await settle();
}

async function pickCasablanca() {
  const input = document.getElementById('welcomeCity');
  input.value = 'Casablanca';
  input.dispatchEvent(new Event('input'));
  await jest.advanceTimersByTimeAsync(300); // the search debounce
  await settle();
  const item = document.querySelector('#welcomeSuggest .suggest-item');
  expect(item.textContent).toBe('Casablanca, Casablanca-Settat, Morocco');
  item.click();
  await settle();
}

let warnSpy;
beforeEach(() => {
  jest.useFakeTimers();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
  delete globalThis.chrome;
  delete globalThis.fetch;
});

describe('onboarding location', () => {
  it('a searched place is saved through the worker, which then fetches its schedule', async () => {
    await load();
    await pickCasablanca();
    expect(document.getElementById('welcomeCity').value).toBe('Casablanca, Casablanca-Settat, Morocco');
    document.getElementById('finishBtn').click();
    await settle();
    const saves = chrome.__.sent.filter((m) => m.type === 'SAVE_SETTINGS');
    expect(saves).toHaveLength(1);
    expect(saves[0].settings).toMatchObject({ city: 'Casablanca', state: 'Casablanca-Settat', country: 'Morocco', lat: 33.59, lon: -7.62 });
    // Not written ahead of the message: the worker compares it with what it has.
    expect(chrome.__.store.settings).toEqual(INSTALLED);
    expect(chrome.__.store.onboardingCompleted).toBe(true);
  });

  it('keeps the choice in storage itself when the worker cannot be reached', async () => {
    await load({ send: (m) => (m.type === 'SAVE_SETTINGS' ? Promise.reject(new Error('no receiver')) : { ok: true }) });
    await pickCasablanca();
    document.getElementById('finishBtn').click();
    await settle();
    expect(chrome.__.store.settings).toMatchObject({ city: 'Casablanca', country: 'Morocco' });
  });
});

describe('onboarding location field', () => {
  // On install the worker stores its defaults (Sunnyvale) and fetches their times
  // before the page opens: neither is the user's choice yet.
  const INSTALL_SCHEDULE = { prayers: [{ name: 'Fajr', time: '04:27 AM', ts: 1 }] };

  it('starts empty on a fresh install, so typing searches what is typed', async () => {
    await load({ storage: { schedule: INSTALL_SCHEDULE } });
    expect(document.getElementById('welcomeCity').value).toBe('');
    expect(document.getElementById('previewCityLabel').textContent).not.toContain('Sunnyvale');
    const input = document.getElementById('welcomeCity');
    input.value = 'Casab';
    input.dispatchEvent(new Event('input'));
    await jest.advanceTimersByTimeAsync(300);
    await settle();
    expect(globalThis.fetch.calls.find((u) => u.includes('geocoding-api'))).toContain('name=Casab&');
  });

  it('shows the saved place once onboarding is done', async () => {
    await load({ storage: { onboardingCompleted: true, schedule: INSTALL_SCHEDULE } });
    expect(document.getElementById('welcomeCity').value).toBe('Sunnyvale');
    expect(document.getElementById('previewCityLabel').textContent).toContain('Sunnyvale');
  });
});

describe('onboarding page', () => {
  it('Detect location fills in the place, which is saved like a searched one', async () => {
    await load();
    document.getElementById('detectLocBtn').click();
    await settle();
    expect(document.getElementById('welcomeCity').value).toBe('Casablanca, Casablanca-Settat, Morocco');
    document.getElementById('finishBtn').click();
    await settle();
    const saves = chrome.__.sent.filter((m) => m.type === 'SAVE_SETTINGS');
    expect(saves.map((m) => m.settings)).toEqual([expect.objectContaining({ city: 'Casablanca', state: 'Casablanca-Settat', country: 'Morocco' })]);
  });

  // The preview asks AlAdhan the way the worker will (by city, with the method and
  // Asr school), so it shows the times the user then gets, and sends no coordinates.
  it.each([
    ['a searched place', () => pickCasablanca()],
    ['a detected place', async () => {
      document.getElementById('detectLocBtn').click();
      await settle();
    }],
  ])('previews %s by city, without its coordinates', async (_, choose) => {
    await load();
    await choose();
    const asked = globalThis.fetch.calls.filter((u) => u.includes('api.aladhan.com'));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('/v1/timingsByCity/');
    expect(asked[0]).toContain('city=Casablanca&country=Morocco&method=2&school=0&state=Casablanca-Settat');
    expect(asked[0]).not.toMatch(/latitude|longitude/);
    expect(document.getElementById('ppFajr').textContent).not.toBe('--:--');
  });

  it('previews with the stored method and Asr school, and no state when the place has none', async () => {
    await load({ storage: { settings: { ...INSTALLED, method: 0, school: 1 } } });
    globalThis.fetch = makeFetch([
      ['reverse-geocode-client', { latitude: 1.29, longitude: 103.85, city: 'Singapore', principalSubdivision: '', countryName: 'Singapore' }],
      ['api.aladhan.com', aladhanPayload({ meta: { timezone: 'Asia/Singapore' } })],
    ]);
    document.getElementById('detectLocBtn').click();
    await settle();
    const [asked] = globalThis.fetch.calls.filter((u) => u.includes('api.aladhan.com'));
    expect(asked).toMatch(/\?city=Singapore&country=Singapore&method=0&school=1$/);
  });

  it('switches the card to the newly chosen place at once, and drops a late answer for an earlier one', async () => {
    await load();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    globalThis.fetch = makeFetch([
      [
        'geocoding-api.open-meteo.com',
        (url) => ({
          results: [
            url.includes('name=Rabat')
              ? { name: 'Rabat', admin1: 'Rabat-Salé-Kénitra', country: 'Morocco', country_code: 'MA', latitude: 34.02, longitude: -6.84 }
              : { name: 'Casablanca', admin1: 'Casablanca-Settat', country: 'Morocco', country_code: 'MA', latitude: 33.59, longitude: -7.62 },
          ],
        }),
      ],
      ['city=Casablanca', async () => (await gate, aladhanPayload({ meta: { timezone: 'Africa/Casablanca' } }))],
      ['city=Rabat', { status: 503 }], // AlAdhan can't resolve the city
    ]);
    const pick = async (name) => {
      const input = document.getElementById('welcomeCity');
      input.value = name;
      input.dispatchEvent(new Event('input'));
      await jest.advanceTimersByTimeAsync(300);
      await settle();
      document.querySelector('#welcomeSuggest .suggest-item').click();
      await settle();
    };
    await pick('Casablanca'); // its answer is held back
    await pick('Rabat'); // its lookup fails
    const card = () => [document.getElementById('previewCityLabel').textContent, document.getElementById('ppFajr').textContent];
    expect(card()).toEqual(['Rabat, Morocco', '--:--']);
    release();
    await settle();
    expect(card()).toEqual(['Rabat, Morocco', '--:--']);
  });

  it('clears the no-place message once a later Detect location finds one', async () => {
    await load();
    const working = globalThis.fetch;
    globalThis.fetch = makeFetch([['reverse-geocode-client', { status: 500 }]]);
    document.getElementById('detectLocBtn').click();
    await settle();
    expect(document.getElementById('detectMsg').textContent).toBe(cat('en').detect_location_failed);
    globalThis.fetch = working;
    document.getElementById('detectLocBtn').click();
    await settle();
    expect(document.getElementById('detectMsg').textContent).toBe('');
    expect(document.getElementById('welcomeCity').value).toBe('Casablanca, Casablanca-Settat, Morocco');
  });

  it('Detect location says so when no place is detected, and asks no other service', async () => {
    await load();
    globalThis.fetch = makeFetch([['reverse-geocode-client', { status: 500 }]]);
    document.getElementById('detectLocBtn').click();
    await settle();
    expect(document.getElementById('detectMsg').textContent).toBe(cat('en').detect_location_failed);
    expect(globalThis.fetch.calls).toEqual(['https://api.bigdatacloud.net/data/reverse-geocode-client']);
    expect(document.getElementById('welcomeCity').value).toBe('');
  });

  it.each(['en', 'ar'])('says what Detect location does before it is clicked, and credits the place search (%s)', async (lang) => {
    await load({ uiLang: lang });
    const hint = document.getElementById(document.getElementById('detectLocBtn').getAttribute('aria-describedby'));
    expect(hint.textContent).toBe(cat(lang).detect_location_hint);
    expect(hint.closest('[hidden]')).toBeNull();
    expect(document.getElementById('detectMsg').getAttribute('role')).toBe('status');
    expect(document.querySelector('label[for="welcomeCity"]')).not.toBeNull();
    expect(document.querySelector('.geo-credit [data-i18n="geo_credit"]').textContent).toBe(cat(lang).geo_credit);
    const links = [...document.querySelectorAll('.geo-credit a')];
    expect(links.map((a) => a.href)).toEqual([
      'https://open-meteo.com/',
      'https://www.geonames.org/',
      'https://creativecommons.org/licenses/by/4.0/',
    ]);
    expect(links.every((a) => a.target === '_blank' && a.rel.includes('noopener'))).toBe(true);
  });

  it('is translated, and switches language', async () => {
    await load();
    expect(warnSpy).not.toHaveBeenCalled();
    document.querySelector('.lang-chip[data-lang="fr"]').click();
    await settle();
    expect(document.getElementById('skipWelcomeBtn').textContent).toBe(cat('fr').skip_setup);
    expect(document.documentElement.lang).toBe('fr');
  });

  it('opens right to left in an Arabic browser', async () => {
    await load({ uiLang: 'ar' });
    expect(document.getElementById('skipWelcomeBtn').textContent).toBe(cat('ar').skip_setup);
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    document.querySelector('.lang-chip[data-lang="en"]').click();
    await settle();
    expect(document.documentElement.dir).toBe('ltr');
  });
});
