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

async function load({ send, uiLang, storage = {}, routes = [] } = {}) {
  document.body.innerHTML = BODY;
  document.documentElement.lang = 'en';
  document.documentElement.dir = '';
  window.HTMLCanvasElement.prototype.getContext = () => null; // no confetti under jsdom
  chrome = makeChrome({ initialStorage: { settings: INSTALLED, ...storage }, uiLang, handleSendMessage: send || (() => ({ ok: true })) });
  globalThis.chrome = chrome;
  globalThis.fetch = makeFetch([
    ...routes,
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

describe('onboarding preview card', () => {
  // Its markup used to name Makkah, which a new user read as already chosen: until
  // a place is picked or detected it asks for one, with no times.
  const label = () => document.getElementById('previewCityLabel').textContent;

  it('names no place on a fresh install, then shows the picked one and its times', async () => {
    await load();
    expect(document.body.textContent).not.toContain('Makkah');
    expect(label()).toBe(cat('en').preview_pick_city);
    expect(document.getElementById('ppFajr').textContent).toBe('--:--');
    await pickCasablanca();
    expect(label()).toBe('Casablanca, Morocco');
    expect(document.getElementById('ppFajr').textContent).toBe('04:27 AM');
    expect(document.getElementById('ppMaghrib').textContent).toBe('08:17 PM');
  });

  it('asks in the page language, and a detected place survives a language switch', async () => {
    await load({ uiLang: 'ar' });
    expect(label()).toBe(cat('ar').preview_pick_city);
    document.getElementById('detectLocBtn').click();
    await settle();
    expect(label()).toBe('Casablanca, Morocco');
    document.querySelector('.lang-chip[data-lang="fr"]').click();
    await settle();
    expect(label()).toBe('Casablanca, Morocco');
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

// In Arabic the search asks for Arabic names (an Arabic query found nothing in
// English); the place is still saved under its English names, which Aladhan is
// asked by, with the label as shown kept for display.
describe('onboarding search in the page language', () => {
  const AR_FOUND = {
    results: [{ id: 2553604, name: 'الدار البيضاء', admin1: 'الدار البيضاء - سطات', country: 'المغرب', country_code: 'MA', latitude: 33.59, longitude: -7.62 }],
  };
  const AR_LABEL = 'الدار البيضاء, الدار البيضاء - سطات, المغرب';
  const CASABLANCA_EN = { id: 2553604, name: 'Casablanca', admin1: 'Casablanca-Settat', country: 'Morocco', country_code: 'MA', latitude: 33.59, longitude: -7.62 };
  const pickArabic = async () => {
    const input = document.getElementById('welcomeCity');
    input.value = 'الدار البيضاء';
    input.dispatchEvent(new Event('input'));
    await jest.advanceTimersByTimeAsync(300);
    await settle();
    const item = document.querySelector('#welcomeSuggest .suggest-item');
    expect(item.textContent).toBe(AR_LABEL);
    item.click();
    await settle();
  };
  const finish = async () => {
    document.getElementById('finishBtn').click();
    await settle();
    return chrome.__.sent.filter((m) => m.type === 'SAVE_SETTINGS').map((m) => m.settings);
  };

  it('shows Arabic names, and saves the English ones with the label as shown', async () => {
    await load({ uiLang: 'ar', routes: [['/v1/get?', CASABLANCA_EN], ['language=ar', AR_FOUND]] });
    expect(document.getElementById('welcomeCity').getAttribute('dir')).toBe('auto');
    await pickArabic();
    expect(globalThis.fetch.calls.find((u) => u.includes('/v1/search'))).toContain('&language=ar&');
    expect(document.getElementById('previewCityLabel').textContent).toBe('الدار البيضاء, المغرب');
    const [saved] = await finish();
    expect(saved).toMatchObject({ city: 'Casablanca', state: 'Casablanca-Settat', country: 'Morocco', lat: 33.59, lon: -7.62 });
    expect(saved.placeLabel).toEqual({ lang: 'ar', text: AR_LABEL });
    jest.advanceTimersByTime(400); // the success view
    expect(document.getElementById('completionCity').textContent).toBe('الدار البيضاء');
  });

  it('Finish waits for the English names', async () => {
    let answer;
    const later = new Promise((resolve) => (answer = resolve));
    await load({ uiLang: 'ar', routes: [['/v1/get?', () => later], ['language=ar', AR_FOUND]] });
    await pickArabic();
    expect(await finish()).toEqual([]);
    answer(CASABLANCA_EN);
    await settle();
    const saves = chrome.__.sent.filter((m) => m.type === 'SAVE_SETTINGS').map((m) => m.settings);
    expect(saves).toEqual([expect.objectContaining({ city: 'Casablanca', country: 'Morocco' })]);
  });

  it('keeps the names as found when the English ones cannot be had', async () => {
    await load({ uiLang: 'ar', routes: [['/v1/get?', { status: 503 }], ['language=ar', AR_FOUND]] });
    await pickArabic();
    const [saved] = await finish();
    expect(saved).toMatchObject({ city: 'الدار البيضاء', country: 'المغرب', placeLabel: null });
  });

  it('a place detected after the pick drops its label', async () => {
    await load({ uiLang: 'ar', routes: [['/v1/get?', CASABLANCA_EN], ['language=ar', AR_FOUND]] });
    await pickArabic();
    document.getElementById('detectLocBtn').click();
    await settle();
    const [saved] = await finish();
    expect(saved).toMatchObject({ city: 'Casablanca', country: 'Morocco', placeLabel: null });
  });
});
