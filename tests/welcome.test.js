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
import { simulateStaleTzData } from './helpers/stale-icu.js';

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

  it('Skip sends no place: neither the default city nor placeholder coordinates', async () => {
    // The page started from Makkah's 21.42/39.83, which a Skip saved with Sunnyvale:
    // the worker's fallback by coordinates would then fetch Makkah's times. Any place
    // sent the worker now takes as chosen (see 'no place chosen' below).
    await load();
    document.getElementById('skipWelcomeBtn').click();
    await settle();
    const [saved] = chrome.__.sent.filter((m) => m.type === 'SAVE_SETTINGS').map((m) => m.settings);
    expect(saved).toMatchObject({ adhanChime: true, focusMode: true });
    for (const k of ['city', 'state', 'country', 'lat', 'lon', 'placeLabel']) expect(saved).not.toHaveProperty(k);
  });

  it('marks setup done only once the place is on its way to the worker', async () => {
    let answer;
    await load({ uiLang: 'ar', routes: [['/v1/get?', () => new Promise((r) => (answer = r))], ['language=en', { results: [] }], ['language=ar', { results: [{ id: 2553604, name: 'الدار البيضاء', admin1: 'الدار البيضاء - سطات', country: 'المغرب', latitude: 33.59, longitude: -7.62 }] }]] });
    const input = document.getElementById('welcomeCity');
    input.value = 'الدار البيضاء';
    input.dispatchEvent(new Event('input'));
    await jest.advanceTimersByTimeAsync(300);
    await settle();
    document.querySelector('#welcomeSuggest .suggest-item').click();
    await settle();
    document.getElementById('finishBtn').click();
    await settle();
    expect(chrome.__.store.onboardingCompleted).not.toBe(true); // closed now, setup is offered again
    answer({ id: 2553604, name: 'Casablanca', admin1: 'Casablanca-Settat', country: 'Morocco', latitude: 33.59, longitude: -7.62 });
    await settle();
    expect(chrome.__.store.onboardingCompleted).toBe(true);
    expect(chrome.__.sent.some((m) => m.type === 'SAVE_SETTINGS')).toBe(true);
  });

  it('Close waits at most 2 s for the worker, which has the settings by then', async () => {
    await load({ send: (m) => (m.type === 'SAVE_SETTINGS' ? new Promise(() => {}) : { ok: true }) });
    window.close = jest.fn();
    await pickCasablanca();
    document.getElementById('finishBtn').click();
    await settle();
    await jest.advanceTimersByTimeAsync(400);
    document.getElementById('closeWelcomeBtn').click();
    await jest.advanceTimersByTimeAsync(1900);
    expect(window.close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(200);
    expect(window.close).toHaveBeenCalled();
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
  const NONE = ['language=en', { results: [] }]; // an Arabic query, asked in English
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
    await load({ uiLang: 'ar', routes: [['/v1/get?', CASABLANCA_EN], NONE, ['language=ar', AR_FOUND]] });
    expect(document.getElementById('welcomeCity').getAttribute('dir')).toBe('auto');
    await pickArabic();
    expect(document.getElementById('welcomeCity').dir).toBe('rtl');
    const searches = globalThis.fetch.calls.filter((u) => u.includes('/v1/search'));
    expect(searches.map((u) => u.match(/language=(\w+)/)[1]).sort()).toEqual(['ar', 'en']);
    expect(document.getElementById('previewCityLabel').textContent).toBe('الدار البيضاء, المغرب');
    const [saved] = await finish();
    expect(saved).toMatchObject({ city: 'Casablanca', state: 'Casablanca-Settat', country: 'Morocco', lat: 33.59, lon: -7.62 });
    expect(saved.placeLabel).toEqual({ lang: 'ar', text: AR_LABEL });
    jest.advanceTimersByTime(400); // the success view
    expect(document.getElementById('completionCity').textContent).toBe('الدار البيضاء');
    expect(document.getElementById('completionCity').dir).toBe('auto'); // isolated in the English sentence
  });

  it('Finish waits for the English names', async () => {
    let answer;
    const later = new Promise((resolve) => (answer = resolve));
    await load({ uiLang: 'ar', routes: [['/v1/get?', () => later], NONE, ['language=ar', AR_FOUND]] });
    await pickArabic();
    expect(await finish()).toEqual([]);
    answer(CASABLANCA_EN);
    await settle();
    const saves = chrome.__.sent.filter((m) => m.type === 'SAVE_SETTINGS').map((m) => m.settings);
    expect(saves).toEqual([expect.objectContaining({ city: 'Casablanca', country: 'Morocco' })]);
  });

  it('asks again at Finish when the English names could not be had at the pick', async () => {
    let calls = 0;
    const flaky = () => (++calls === 1 ? { status: 503 } : CASABLANCA_EN);
    await load({ uiLang: 'ar', routes: [['/v1/get?', flaky], NONE, ['language=ar', AR_FOUND]] });
    await pickArabic();
    const [saved] = await finish();
    expect(calls).toBe(2);
    expect(saved).toMatchObject({ city: 'Casablanca', country: 'Morocco', placeLabel: { lang: 'ar', text: AR_LABEL } });
  });

  it('keeps the names as found when the English ones still cannot be had', async () => {
    await load({ uiLang: 'ar', routes: [['/v1/get?', { status: 503 }], NONE, ['language=ar', AR_FOUND]] });
    await pickArabic();
    const [saved] = await finish();
    expect(saved).toMatchObject({ city: 'الدار البيضاء', country: 'المغرب', placeLabel: null });
  });

  it('a lookup that hangs holds Finish, and Close, only for a bounded time', async () => {
    await load({ uiLang: 'ar', routes: [['/v1/get?', () => new Promise(() => {})], NONE, ['language=ar', AR_FOUND]] });
    window.close = jest.fn();
    await pickArabic();
    expect(await finish()).toEqual([]);
    await jest.advanceTimersByTimeAsync(400); // the success view, with Close
    document.getElementById('closeWelcomeBtn').click();
    await settle();
    expect(window.close).not.toHaveBeenCalled(); // not before the place is handed over
    await jest.advanceTimersByTimeAsync(16000); // the pick's lookup, then Finish's
    const saves = chrome.__.sent.filter((m) => m.type === 'SAVE_SETTINGS').map((m) => m.settings);
    expect(saves).toEqual([expect.objectContaining({ city: 'الدار البيضاء' })]);
    expect(window.close).toHaveBeenCalled();
  });

  it('Detect after a pick whose lookup hangs saves the detected place at once', async () => {
    await load({ uiLang: 'ar', routes: [['/v1/get?', () => new Promise(() => {})], NONE, ['language=ar', AR_FOUND]] });
    await pickArabic();
    document.getElementById('detectLocBtn').click();
    await settle();
    expect(document.getElementById('welcomeCity').dir).toBe('auto');
    const [saved] = await finish();
    expect(saved).toMatchObject({ city: 'Casablanca', country: 'Morocco', placeLabel: null });
  });

  it('names the city on the success view in the page language', async () => {
    await load({ uiLang: 'ar', routes: [['/v1/get?', CASABLANCA_EN], NONE, ['language=ar', AR_FOUND]] });
    await pickArabic();
    document.querySelector('.lang-chip[data-lang="en"]').click();
    await settle();
    await finish();
    jest.advanceTimersByTime(400);
    expect(document.getElementById('completionCity').textContent).toBe('Casablanca');
  });

  it('shows only the answer to what is in the field now', async () => {
    let answerPa;
    const slowPa = new Promise((resolve) => (answerPa = resolve));
    const PAKISTAN = { results: [{ id: 1, name: 'Pakistan Town', admin1: 'X', country: 'Y', latitude: 1, longitude: 1 }] };
    const PARIS = { results: [{ id: 2988507, name: 'Paris', admin1: 'Île-de-France', country: 'France', latitude: 48.85, longitude: 2.35 }] };
    await load({ routes: [['name=Pa&', () => slowPa], ['name=Paris&', PARIS]] });
    const input = document.getElementById('welcomeCity');
    input.value = 'Pa';
    input.dispatchEvent(new Event('input'));
    await jest.advanceTimersByTimeAsync(300);
    input.value = 'Paris';
    input.dispatchEvent(new Event('input'));
    await jest.advanceTimersByTimeAsync(300);
    await settle();
    answerPa(PAKISTAN); // the earlier query's answer comes last
    await settle();
    expect([...document.querySelectorAll('#welcomeSuggest .suggest-item')].map((e) => e.textContent)).toEqual(['Paris, Île-de-France, France']);
  });

  it('a place detected after the pick drops its label', async () => {
    await load({ uiLang: 'ar', routes: [['/v1/get?', CASABLANCA_EN], NONE, ['language=ar', AR_FOUND]] });
    await pickArabic();
    document.getElementById('detectLocBtn').click();
    await settle();
    const [saved] = await finish();
    expect(saved).toMatchObject({ city: 'Casablanca', country: 'Morocco', placeLabel: null });
  });
});

// "Test prayer pause (10s)" on the last step. It was always "Maghrib" — "06:45 PM"
// on this page, and the stored schedule's clock in the tabs, which before setup is
// the install default's (Sunnyvale): a user who picked London read "Maghrib 02:39 AM".
// The chime played here and in the worker at once.
describe('the pause demo', () => {
  // Casablanca's previewed times (aladhanPayload): Fajr 04:27, Dhuhr 13:05, Asr 16:56,
  // Maghrib 20:17, Isha 21:43, at the UTC offset the mock gives them from this Node's
  // tz data — +00 (Morocco's rules since 2026-09-20) or, with older data, +01. The
  // moments are an hour clear of each prayer, so the answer stands either way.
  const AFTERNOON = Date.parse('2026-10-22T14:30:00Z');
  const NIGHT = Date.parse('2026-10-22T22:30:00Z');
  // What the worker stored on install: Sunnyvale's day, and its next prayer.
  const SUNNYVALE = {
    schedule: { tz: 'America/Los_Angeles', prayers: [{ name: 'Fajr', time: '05:49 AM', ts: AFTERNOON - 3 * 3600e3 }, { name: 'Maghrib', time: '06:24 PM', ts: AFTERNOON + 9 * 3600e3 }] },
    nextPrayer: { name: 'Maghrib', time: '06:24 PM', ts: AFTERNOON + 9 * 3600e3 },
  };
  const demos = () => chrome.__.sent.filter((m) => m.type === 'TEST_PAUSE_DEMO');
  const shown = () => [document.getElementById('demoPrayerName').textContent, document.getElementById('demoPrayerTime').textContent];
  let realAudio;
  let made;
  beforeEach(() => {
    realAudio = window.Audio;
    made = jest.fn(function () {
      return { play: () => Promise.resolve() };
    });
    window.Audio = made;
  });
  afterEach(() => {
    window.Audio = realAudio;
  });
  const runDemo = async () => {
    document.getElementById('simPauseBtn').click();
    await settle();
  };

  it("names the picked place's next prayer and its time, here and in every tab", async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: SUNNYVALE });
    await pickCasablanca();
    await runDemo();
    expect(demos()).toEqual([{ type: 'TEST_PAUSE_DEMO', seconds: 10, chime: true, prayer: 'Asr', time: '04:56 PM' }]);
    expect(document.getElementById('welcomeFocusOverlay').hidden).toBe(false);
    expect(shown()).toEqual([cat('en').prayer_Asr, '04:56 PM']);
    expect(made).not.toHaveBeenCalled(); // the worker's chime only
  });

  it("after the place's Isha it is the next day's Fajr, in the page language", async () => {
    jest.setSystemTime(NIGHT);
    await load({ storage: SUNNYVALE });
    await pickCasablanca();
    await runDemo();
    expect(demos()).toEqual([expect.objectContaining({ prayer: 'Fajr', time: '04:27 AM' })]);
    document.querySelector('.lang-chip[data-lang="fr"]').click();
    await settle();
    expect(shown()).toEqual([cat('fr').prayer_Fajr, '04:27 AM']);
  });

  // It asked for this browser's date: on a Los Angeles evening London is already on
  // the next day, whose Fajr is a minute or two later, so the demo named the earlier
  // day's time (the worker asks again for the place's day).
  it("names the time of the place's own day when it is another day there", async () => {
    const now = Date.parse('2026-10-22T12:00:00Z');
    jest.setSystemTime(now);
    const pad = (n) => String(n).padStart(2, '0');
    const local = new Date(now);
    const asked = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
    const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
    // An offset that has the place at 01:00 on another day than this browser's.
    const offsetH = [13, -11].find((h) => utcDay(now + h * 3600e3) !== asked);
    const placeDay = utcDay(now + offsetH * 3600e3);
    const dmy = (ymd) => ymd.split('-').reverse().join('-');
    const isoOffset = `${offsetH < 0 ? '-' : '+'}${pad(Math.abs(offsetH))}:00`;
    const theDay = (url) => aladhanPayload({ isoOffset, timings: url.includes(`/${dmy(placeDay)}?`) ? { Fajr: '04:29' } : {} });
    await load({ storage: SUNNYVALE, routes: [['api.aladhan.com', theDay]] });
    await pickCasablanca();
    const asks = globalThis.fetch.calls.filter((u) => u.includes('api.aladhan.com'));
    expect(asks.map((u) => u.match(/timings\/([\d-]+)\?/)[1])).toEqual([dmy(asked), dmy(placeDay)]);
    expect(document.getElementById('ppFajr').textContent).toBe('04:29 AM');
    await runDemo();
    expect(demos()).toEqual([expect.objectContaining({ prayer: 'Fajr', time: '04:29 AM' })]);
  });

  it('previews with the saved calculation method and Asr school, as the worker fetches', async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: { ...SUNNYVALE, settings: { ...INSTALLED, method: 0, school: 1 } } });
    await pickCasablanca();
    const asks = globalThis.fetch.calls.filter((u) => u.includes('api.aladhan.com'));
    // Once, or twice where this browser is already on another day than the place.
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((u) => u.includes('&method=0&school=1&iso8601=true'))).toBe(true);
  });

  it('asks the worker for the chime as chosen on this page', async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: SUNNYVALE });
    await pickCasablanca();
    const chime = document.getElementById('welcomeChime');
    chime.checked = false;
    chime.dispatchEvent(new Event('change'));
    await runDemo();
    expect(demos()).toEqual([expect.objectContaining({ chime: false, prayer: 'Asr' })]);
    expect(made).not.toHaveBeenCalled();
  });

  // Step 1's Next does not wait for a pick, and until setup is done the worker's next
  // prayer is the install default's: a test run then read "Asr 03:56 PM" (Sunnyvale's)
  // to a user in London, on this page and in every tab.
  it('with no place picked yet, waits for one rather than show the install default\'s prayer', async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: SUNNYVALE });
    const btn = document.getElementById('simPauseBtn');
    const hint = document.getElementById('simHint');
    expect(btn.disabled).toBe(true);
    expect([hint.hidden, hint.textContent]).toEqual([false, cat('en').sim_pick_city_first]);
    await runDemo();
    expect(demos()).toEqual([]);
    expect(document.getElementById('welcomeFocusOverlay').hidden).toBe(true);
    // In the page language.
    document.querySelector('.lang-chip[data-lang="fr"]').click();
    await settle();
    expect(hint.textContent).toBe(cat('fr').sim_pick_city_first);
    // A place's times shown: on, for that place's next prayer.
    await pickCasablanca();
    expect([btn.disabled, hint.hidden]).toEqual([false, true]);
    await runDemo();
    expect(demos()).toEqual([expect.objectContaining({ prayer: 'Asr', time: '04:56 PM' })]);
  });

  // Detected as BigDataCloud really answers: float32's widened, whose ten digits in a
  // row the outbound guard reads as a phone number. The preview was blocked before it
  // was asked for, and the test stayed off, asking for the city the field showed.
  const SAN_FRANCISCO = ['reverse-geocode-client', { latitude: 37.790000915527344, longitude: -122.4000015258789, city: 'San Francisco', principalSubdivision: 'California', countryName: 'United States of America' }];
  // Each place's day by its coordinates (to 5 decimals): San Francisco's in Los
  // Angeles' zone (at AFTERNOON, 07:30 there: Dhuhr 01:05 PM is next), Casablanca's
  // as in load(). `casablanca` answers for Casablanca instead when given.
  const byPlace = (casablanca = aladhanPayload({ meta: { timezone: 'Africa/Casablanca' } })) => [
    'api.aladhan.com',
    (url) => (url.includes('latitude=37.79&longitude=-122.4&') ? aladhanPayload({ meta: { timezone: 'America/Los_Angeles' } }) : typeof casablanca === 'function' ? casablanca(url) : casablanca),
  ];
  const aladhanCalls = () => globalThis.fetch.calls.filter((u) => u.includes('api.aladhan.com'));

  it("a detected place's times load, and the test names its next prayer", async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: SUNNYVALE, routes: [SAN_FRANCISCO, byPlace()] });
    document.getElementById('detectLocBtn').click();
    await settle();
    expect(document.getElementById('welcomeCity').value).toBe('San Francisco, California, United States of America');
    // Once, or twice where this browser is already on another day than the place.
    expect(aladhanCalls().length).toBeGreaterThan(0);
    expect(aladhanCalls().every((u) => u.includes('?latitude=37.79&longitude=-122.4&'))).toBe(true);
    expect(document.getElementById('ppDhuhr').textContent).toBe('01:05 PM');
    expect([document.getElementById('simPauseBtn').disabled, document.getElementById('simHint').hidden]).toEqual([false, true]);
    await runDemo();
    expect(demos()).toEqual([expect.objectContaining({ prayer: 'Dhuhr', time: '01:05 PM' })]);
    expect(shown()).toEqual([cat('en').prayer_Dhuhr, '01:05 PM']);
    // Saved as rounded, so the worker's own requests by them pass the guard too.
    document.getElementById('finishBtn').click();
    await settle();
    expect(chrome.__.sent.find((m) => m.type === 'SAVE_SETTINGS').settings).toMatchObject({ city: 'San Francisco', lat: 37.79, lon: -122.4 });
  });

  it('a picked place whose times cannot be had says so, rather than ask for a place', async () => {
    jest.setSystemTime(AFTERNOON);
    let down = true;
    await load({ storage: SUNNYVALE, routes: [byPlace(() => (down ? { status: 503 } : aladhanPayload({ meta: { timezone: 'Africa/Casablanca' } })))] });
    await pickCasablanca();
    const btn = document.getElementById('simPauseBtn');
    const hint = document.getElementById('simHint');
    expect(btn.disabled).toBe(true);
    expect([hint.hidden, hint.textContent]).toEqual([false, cat('en').sim_times_unavailable]);
    await runDemo();
    expect(demos()).toEqual([]);
    document.querySelector('.lang-chip[data-lang="fr"]').click();
    await settle();
    expect(hint.textContent).toBe(cat('fr').sim_times_unavailable);
    // Picked again once Aladhan answers: on, for its next prayer.
    down = false;
    await pickCasablanca();
    expect([btn.disabled, hint.hidden]).toEqual([false, true]);
    await runDemo();
    expect(demos()).toEqual([expect.objectContaining({ prayer: 'Asr', time: '04:56 PM' })]);
  });

  it("a later place whose times cannot be had never gets the earlier place's prayer", async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: SUNNYVALE, routes: [SAN_FRANCISCO, ['latitude=37.79&', { status: 503 }]] });
    await pickCasablanca();
    expect(document.getElementById('simPauseBtn').disabled).toBe(false);
    document.getElementById('detectLocBtn').click();
    await settle();
    expect(document.getElementById('simPauseBtn').disabled).toBe(true);
    expect(document.getElementById('simHint').textContent).toBe(cat('en').sim_times_unavailable);
    await runDemo();
    expect(demos()).toEqual([]);
  });

  it("once set up, a new place whose times cannot be had does not get the saved place's prayer", async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: { ...SUNNYVALE, onboardingCompleted: true }, routes: [['api.aladhan.com', { status: 503 }]] });
    expect(document.getElementById('simPauseBtn').disabled).toBe(false); // the saved place's day
    await pickCasablanca();
    expect(document.getElementById('simPauseBtn').disabled).toBe(true);
    expect(document.getElementById('simHint').textContent).toBe(cat('en').sim_times_unavailable);
    await runDemo();
    expect(demos()).toEqual([]);
  });

  it("an earlier place's times, come late, are not the later place's", async () => {
    jest.setSystemTime(AFTERNOON);
    let answer;
    await load({ storage: SUNNYVALE, routes: [SAN_FRANCISCO, byPlace(() => new Promise((r) => (answer = r)))] });
    await pickCasablanca();
    // On their way: off, with no word yet (it is neither unpicked nor failed).
    expect([document.getElementById('simPauseBtn').disabled, document.getElementById('simHint').hidden]).toEqual([true, true]);
    document.getElementById('detectLocBtn').click();
    await settle();
    answer(aladhanPayload({ meta: { timezone: 'Africa/Casablanca' } }));
    await settle();
    expect(document.getElementById('previewCityLabel').textContent).toBe('San Francisco, United States of America');
    expect(document.getElementById('ppDhuhr').textContent).toBe('01:05 PM');
    await runDemo();
    expect(demos()).toEqual([expect.objectContaining({ prayer: 'Dhuhr', time: '01:05 PM' })]);
  });

  it('set up, with no stored day to show, labels this page as the worker labels the tabs', async () => {
    jest.setSystemTime(AFTERNOON);
    let reply;
    await load({
      storage: { nextPrayer: SUNNYVALE.nextPrayer, onboardingCompleted: true },
      send: (m) => (m.type === 'TEST_PAUSE_DEMO' ? new Promise((r) => (reply = r)) : { ok: true }),
    });
    expect(document.getElementById('simPauseBtn').disabled).toBe(false);
    await runDemo();
    expect(demos()).toEqual([{ type: 'TEST_PAUSE_DEMO', seconds: 10, chime: true }]); // its own stored next prayer
    expect(shown()).toEqual(['', '']); // never a made-up prayer
    reply({ ok: true, prayer: 'Maghrib', time: '06:24 PM' });
    await settle();
    expect(shown()).toEqual([cat('en').prayer_Maghrib, '06:24 PM']);
    expect(made).not.toHaveBeenCalled();
  });

  it('during a real prayer pause the worker refuses: the page ends its demo and says why', async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: SUNNYVALE, send: (m) => (m.type === 'TEST_PAUSE_DEMO' ? { ok: false, error: 'prayer_in_progress' } : { ok: true }) });
    await pickCasablanca();
    await runDemo();
    expect(document.getElementById('welcomeFocusOverlay').hidden).toBe(true);
    const hint = document.getElementById('simHint');
    expect([hint.hidden, hint.textContent]).toEqual([false, cat('en').sim_prayer_in_progress]);
    // No Resume of its own for the tabs, nor a countdown that would send one.
    await jest.advanceTimersByTimeAsync(10000);
    expect(chrome.__.sent.filter((m) => m.type === 'RESUME_DEMO')).toEqual([]);
    // A later try asks again.
    chrome.__.sent.length = 0;
    await runDemo();
    expect(demos()).toHaveLength(1);
  });

  it("takes each prayer's instant from Aladhan's offset, not this browser's out-of-date tz data", async () => {
    // Aladhan says +00; a browser on tz data from before 2026-09-20 reads Casablanca as
    // +01, so through it Asr (16:56) was past at 16:20Z and the demo named Maghrib.
    const restore = simulateStaleTzData();
    try {
      jest.setSystemTime(Date.parse('2026-10-22T16:20:00Z'));
      await load({ storage: SUNNYVALE, routes: [['api.aladhan.com', aladhanPayload({ meta: { timezone: 'Africa/Casablanca' }, isoOffset: '+00:00' })]] });
      await pickCasablanca();
      expect(globalThis.fetch.calls.find((u) => u.includes('api.aladhan.com'))).toMatch(/[?&]iso8601=true(&|$)/);
      expect(document.getElementById('ppAsr').textContent).toBe('04:56 PM');
      await runDemo();
      expect(demos()).toEqual([expect.objectContaining({ prayer: 'Asr', time: '04:56 PM' })]);
    } finally {
      restore();
    }
  });

  it("once set up, names the saved place's next prayer", async () => {
    jest.setSystemTime(AFTERNOON);
    await load({ storage: { ...SUNNYVALE, onboardingCompleted: true } });
    await runDemo();
    expect(demos()).toEqual([expect.objectContaining({ prayer: 'Maghrib', time: '06:24 PM' })]);
    expect(shown()).toEqual([cat('en').prayer_Maghrib, '06:24 PM']);
  });
});

describe('pin guidance for the browser in use', () => {
  const UA = {
    chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
    opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0',
    firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
  };
  afterEach(() => {
    delete window.navigator.userAgent; // back to jsdom's own
  });

  it.each([
    // Opera's toolbar Extensions button is a cube; it was told to look for Chrome's puzzle piece.
    ['opera', /^Click the Extensions icon \(the cube\) at the right end of the toolbar, then click the pin next to Adhan Focus\.$/],
    ['edge', /"Show in toolbar"/],
    ['firefox', /"Pin to Toolbar"/],
    ['chrome', /puzzle icon 🧩 .* Pin icon next to Adhan Focus/],
  ])('%s', async (browser, text) => {
    Object.defineProperty(window.navigator, 'userAgent', { value: UA[browser], configurable: true });
    await load();
    expect(document.getElementById('browserPinGuidance').textContent).toMatch(text);
    // The step's own line above it names no browser's icon: on Opera it said "the
    // puzzle icon 🧩" right over the cube.
    const lead = document.querySelector('#step3View .step-hero p');
    expect(lead.getAttribute('data-i18n')).toBe('pin_extension_desc');
    expect(lead.textContent).toBe(cat('en').pin_extension_desc);
  });

  it('that line (the popup guide and pin hint use it too) names no browser\'s icon, in any language', () => {
    for (const code of ['en', 'ar', 'fr', 'id', 'tr', 'ur']) {
      expect({ code, text: cat(code).pin_extension_desc }).toEqual({ code, text: expect.not.stringMatching(/🧩|puzzle|پزل/i) });
    }
  });
});

// Skip, or Get Started with no place picked or detected, finished setup with the
// install default (Sunnyvale) as if chosen, said "watching for prayer times in
// Sunnyvale", and its prayers then paused every tab. Setup is still done (the
// tutorial is), but prayer alerts wait for a place, and the page says so and where.
describe('no place chosen', () => {
  const FRESH = { onboardingCompleted: false, locationConfirmed: false };
  const success = () => document.getElementById('stepSuccessView');
  const watching = () => document.getElementById('successWatching');
  const alertsOff = () => document.getElementById('successAlertsOff');
  const finished = async (button) => {
    document.getElementById(button).click();
    await settle();
    jest.advanceTimersByTime(400); // the success view
  };
  const saves = () => chrome.__.sent.filter((m) => m.type === 'SAVE_SETTINGS').map((m) => m.settings);
  const PLACE = ['city', 'state', 'country', 'lat', 'lon', 'placeLabel'];

  it.each(['skipWelcomeBtn', 'finishBtn'])('%s: setup is done, no place is sent, and alerts are said to be off until one is', async (button) => {
    await load({ storage: FRESH });
    const chime = document.getElementById('welcomeChime');
    chime.checked = false;
    chime.dispatchEvent(new Event('change'));
    await finished(button);
    expect(saves()).toHaveLength(1);
    for (const k of PLACE) expect(saves()[0]).not.toHaveProperty(k);
    expect(saves()[0].adhanChime).toBe(false); // the page's choices still saved
    expect(chrome.__.store.onboardingCompleted).toBe(true);
    expect(success().hidden).toBe(false);
    expect([alertsOff().hidden, watching().hidden]).toEqual([false, true]);
    expect(alertsOff().textContent).toBe(cat('en').success_alerts_off);
    expect(success().textContent).not.toContain('Sunnyvale');
    // Not "You're All Set!", and no confetti, while alerts are off.
    expect(document.getElementById('successTitle').textContent).toBe(cat('en').success_title_off);
    expect(document.getElementById('confettiCanvas').hidden).toBe(true);
  });

  it('says so in the page language, and follows a switch', async () => {
    await load({ storage: FRESH, uiLang: 'ar' });
    await finished('skipWelcomeBtn');
    expect(alertsOff().textContent).toBe(cat('ar').success_alerts_off);
    expect(success().querySelector('h1').textContent).toBe(cat('ar').success_title_off);
    expect(document.getElementById('closeWelcomeBtn').textContent).toBe(cat('ar').close_tab);
    document.querySelector('.lang-chip[data-lang="tr"]').click();
    await settle();
    expect(alertsOff().textContent).toBe(cat('tr').success_alerts_off);
  });

  it('with a place picked: sent, and named in the sentence, which follows a language switch', async () => {
    await load({ storage: FRESH });
    await pickCasablanca();
    await finished('finishBtn');
    expect(saves()[0]).toMatchObject({ city: 'Casablanca', country: 'Morocco', lat: 33.59, lon: -7.62 });
    expect([alertsOff().hidden, watching().hidden]).toEqual([true, false]);
    expect(watching().textContent).toBe(cat('en').success_watching.replace('{city}', 'Casablanca'));
    expect(document.getElementById('successTitle').textContent).toBe(cat('en').success_title);
    expect(document.getElementById('confettiCanvas').hidden).toBe(false); // celebrated
    document.querySelector('.lang-chip[data-lang="fr"]').click();
    await settle();
    expect(watching().textContent).toBe(cat('fr').success_watching.replace('{city}', 'Casablanca'));
    expect(document.getElementById('completionCity').textContent).toBe('Casablanca');
  });

  it('reopened after a Skip: the default city is still not the user\'s', async () => {
    await load({ storage: { ...FRESH, onboardingCompleted: true, schedule: { prayers: [{ name: 'Fajr', time: '04:27 AM', ts: 1 }] } } });
    expect(document.getElementById('welcomeCity').value).toBe('');
    expect(document.getElementById('previewCityLabel').textContent).not.toContain('Sunnyvale');
    expect(document.getElementById('simPauseBtn').disabled).toBe(true);
    await finished('finishBtn');
    expect(alertsOff().hidden).toBe(false);
  });

  it('reopened once a place was chosen: it is kept, and named', async () => {
    await load({ storage: { onboardingCompleted: true, locationConfirmed: true } });
    expect(document.getElementById('welcomeCity').value).toBe('Sunnyvale');
    await finished('finishBtn');
    for (const k of PLACE) expect(saves()[0]).not.toHaveProperty(k); // nothing to change
    expect(watching().textContent).toBe(cat('en').success_watching.replace('{city}', 'Sunnyvale'));
  });

  // The popup's guide, open while this tab is, can choose one first (its Detect).
  const SAN_FRANCISCO = { ...INSTALLED, city: 'San Francisco', lat: 37.79, lon: -122.4 };
  it('a place chosen elsewhere since the page opened: named, not said to be missing', async () => {
    await load({ storage: FRESH });
    await chrome.storage.local.set({ locationConfirmed: true, settings: SAN_FRANCISCO });
    await finished('skipWelcomeBtn');
    await settle();
    expect([alertsOff().hidden, watching().hidden]).toEqual([true, false]);
    expect(watching().textContent).toBe(cat('en').success_watching.replace('{city}', 'San Francisco'));
  });

  it('one chosen as the off line advises, the page still open: the line follows', async () => {
    await load({ storage: FRESH });
    await finished('skipWelcomeBtn');
    await settle();
    expect(alertsOff().hidden).toBe(false);
    await chrome.storage.local.set({ settings: { ...INSTALLED, adhanChime: false } }); // a toggle: no place
    await settle();
    expect(alertsOff().hidden).toBe(false);
    await chrome.storage.local.set({ locationConfirmed: true, settings: SAN_FRANCISCO });
    await settle();
    expect([alertsOff().hidden, watching().hidden]).toEqual([true, false]);
    expect(document.getElementById('completionCity').textContent).toBe('San Francisco');
  });

  // The page and the real worker together, from a new install.
  describe('through the worker', () => {
    const drain = async () => {
      for (let i = 0; i < 12; i++) await settle();
    };
    const PRAYER_ALARM = 'adhan-prayer-fire';
    async function installed() {
      // The page's messages go to the worker's own listener.
      await load({ send: (m) => chrome.__.sendRuntimeMessage(m), routes: [['/v1/timingsByCity/', (url) => aladhanPayload({ meta: { timezone: 'Africa/Casablanca' }, data: { date: { gregorian: { date: url.match(/\/(\d{2}-\d{2}-\d{4})\?/)[1] } } } })]] });
      await import(`../background.js?t=${++counter}`);
      await chrome.__.fireInstalled({ reason: 'install' });
      await drain();
      expect(chrome.__.store.locationConfirmed).toBe(false);
      expect(chrome.__.alarms.has(PRAYER_ALARM)).toBe(false);
    }

    it('Skip leaves prayer alerts off', async () => {
      await installed();
      await finished('skipWelcomeBtn');
      await drain();
      expect(chrome.__.store).toMatchObject({ onboardingCompleted: true, locationConfirmed: false });
      expect(chrome.__.store.settings.city).toBe('Sunnyvale'); // still the default, for the popup's preview
      expect(chrome.__.alarms.has(PRAYER_ALARM)).toBe(false);
    });

    it('finishing with a picked place turns them on, for that place', async () => {
      await installed();
      await pickCasablanca();
      await finished('finishBtn');
      await drain();
      expect(chrome.__.store).toMatchObject({ onboardingCompleted: true, locationConfirmed: true });
      expect(chrome.__.store.settings).toMatchObject({ city: 'Casablanca', country: 'Morocco' });
      expect(chrome.__.store.schedule.tz).toBe('Africa/Casablanca');
      expect(chrome.__.alarms.get(PRAYER_ALARM)).toEqual({ when: chrome.__.store.nextPrayer.ts });
    });

    it('Skip after a place was chosen in the popup meanwhile: kept on, and named', async () => {
      await installed();
      await chrome.__.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { city: 'San Francisco', state: 'California', country: 'United States', lat: 37.79, lon: -122.4 } });
      await drain();
      await finished('skipWelcomeBtn');
      await drain();
      expect(chrome.__.store).toMatchObject({ onboardingCompleted: true, locationConfirmed: true });
      expect(chrome.__.store.settings.city).toBe('San Francisco');
      expect(chrome.__.alarms.has(PRAYER_ALARM)).toBe(true);
      expect([alertsOff().hidden, watching().hidden]).toEqual([true, false]);
      expect(document.getElementById('completionCity').textContent).toBe('San Francisco');
    });
  });
});
