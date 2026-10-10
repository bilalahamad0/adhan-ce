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

async function load({ send, uiLang } = {}) {
  document.body.innerHTML = BODY;
  document.documentElement.lang = 'en';
  document.documentElement.dir = '';
  window.HTMLCanvasElement.prototype.getContext = () => null; // no confetti under jsdom
  chrome = makeChrome({ initialStorage: { settings: INSTALLED }, uiLang, handleSendMessage: send || (() => ({ ok: true })) });
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
