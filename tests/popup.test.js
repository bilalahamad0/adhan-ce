/**
 * @jest-environment jsdom
 */
// popup.js is an ES module that wires DOM listeners and runs start() at import.
// We mount the real popup.html body first, install a chrome + fetch mock, import
// the module fresh, then assert it renders GET_STATE into the UI, validates the
// location before saving, relays button actions, and switches language/direction.
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeChrome } from './helpers/chrome-mock.js';
import { makeFetch } from './helpers/fetch-mock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BODY = readFileSync(join(ROOT, 'popup.html'), 'utf8').match(/<body>([\s\S]*)<\/body>/)[1].replace(/<script[\s\S]*?<\/script>/g, '');
const BASE = 1_750_000_000_000;

const cat = (code) => JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8'));
const EN = cat('en');

let chrome;
let counter = 0;

function defaultState() {
  return {
    settings: { enabled: true, focusMode: true, country: 'United States', state: 'California', city: 'Sunnyvale', lat: 37.36, lon: -122.03, autoResumeMinutes: 5, leadSeconds: 30 },
    schedule: {
      date: '2026-05-23',
      tz: 'America/Los_Angeles',
      fetchedAt: BASE,
      sunrise: { time: '06:01 AM', ts: BASE - 5 * 3600e3 },
      prayers: [
        { name: 'Fajr', time: '04:27 AM', ts: BASE - 6 * 3600e3 },
        { name: 'Dhuhr', time: '01:05 PM', ts: BASE - 1000 },
        { name: 'Asr', time: '04:56 PM', ts: BASE + 3 * 3600e3 },
        { name: 'Maghrib', time: '08:17 PM', ts: BASE + 6 * 3600e3 },
        { name: 'Isha', time: '09:43 PM', ts: BASE + 8 * 3600e3 },
      ],
    },
    nextPrayer: { name: 'Asr', time: '04:56 PM', ts: BASE + 3 * 3600e3 },
    paused: { active: false },
  };
}

const settle = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

async function load({ state = defaultState(), manifest = { version: '1.7.4' }, send } = {}) {
  document.body.innerHTML = BODY;
  const handleSendMessage = send || ((m) => (m.type === 'GET_STATE' ? state : { ok: true }));
  chrome = makeChrome({ initialStorage: {}, manifest, handleSendMessage });
  globalThis.chrome = chrome;
  globalThis.fetch = makeFetch([
    ['locales/', (url) => cat(url.match(/locales\/(\w+)\.json/)[1])],
    [
      'geocoding-api.open-meteo.com',
      {
        results: [
          { name: 'London', admin1: 'England', country: 'United Kingdom', country_code: 'GB', latitude: 51.5, longitude: -0.12 },
          { name: 'London', admin1: 'Ontario', country: 'Canada', country_code: 'CA', latitude: 42.98, longitude: -81.24 },
        ],
      },
    ],
  ]);
  await import(`../popup.js?t=${++counter}`);
  await settle();
}

const $ = (id) => document.getElementById(id);
const sentTypes = () => chrome.__.sent.map((m) => m.type);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(BASE);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  delete globalThis.chrome;
  delete globalThis.fetch;
});

describe('initial render from GET_STATE', () => {
  it('fills the next-prayer card, schedule list, clock and settings', async () => {
    await load();
    expect($('nextName').textContent).toBe('Asr');
    expect($('nextTime').textContent).toBe('04:56 PM');
    expect($('nextCountdown').textContent).toMatch(/in /);
    expect($('clock').textContent).toMatch(/^🕐 /);

    // Five prayer rows + one sunrise row, with the next prayer marked.
    const rows = $('list').querySelectorAll('.row');
    expect(rows).toHaveLength(6);
    expect($('list').querySelector('.row.sunrise')).not.toBeNull();
    expect($('list').querySelector('.row.next .pname').textContent).toBe('Asr');

    expect($('enabled').checked).toBe(true);
    expect($('focusMode').checked).toBe(true);
    expect($('city').value).toBe('Sunnyvale, California, United States');
    expect($('resumeMin').value).toBe('5');
  });

  it('shows the paused banner and hides Focus once focus is already on', async () => {
    const state = defaultState();
    state.paused = { active: true, prayer: 'Asr', focus: true };
    await load({ state });
    expect($('pausedBanner').hidden).toBe(false);
    expect($('pausedText').textContent).toContain('Asr');
    expect($('focusBtn').hidden).toBe(true);
  });

  it('renders an empty state when there is no schedule', async () => {
    const state = defaultState();
    state.schedule = null;
    state.nextPrayer = null;
    await load({ state });
    expect($('nextName').textContent).toBe('—');
    expect($('nextTime').textContent).toBe(EN.no_schedule);
    expect($('list').children).toHaveLength(0);
  });
});

describe('saving settings', () => {
  it('blocks the save until a real location is picked', async () => {
    await load();
    $('city').value = 'Some Unverified Text'; // no longer matches the geocoded label
    $('save').click();
    await settle();
    expect(sentTypes()).not.toContain('SAVE_SETTINGS');
    expect($('saveMsg').textContent).toBe(EN.pick_location);
  });

  it('sends the merged settings when the picked location is intact', async () => {
    await load();
    $('enabled').checked = false;
    $('resumeMin').value = '8';
    $('save').click();
    await settle();
    const saved = chrome.__.sent.find((m) => m.type === 'SAVE_SETTINGS');
    expect(saved).toBeTruthy();
    expect(saved.settings).toMatchObject({ enabled: false, city: 'Sunnyvale', country: 'United States', autoResumeMinutes: 8 });
    expect($('saveMsg').textContent).toBe(EN.saved);
  });

  it('populates the calculation-method list and saves the chosen method + Asr school', async () => {
    await load();
    // Stored settings carry no method/school yet → defaults to ISNA (2) / Standard (0).
    expect($('method').options.length).toBe(23);
    expect($('method').value).toBe('2');
    expect($('school').value).toBe('0');
    // Pick MWL + Hanafi and save.
    $('method').value = '3';
    $('school').value = '1';
    $('save').click();
    await settle();
    const saved = chrome.__.sent.find((m) => m.type === 'SAVE_SETTINGS');
    expect(saved.settings).toMatchObject({ method: 3, school: 1 });
  });

  it('shows the Hijri date in the header and saves the toggle + offset', async () => {
    await load();
    // Default (showHijri undefined → shown): header carries a 🌙 Hijri date.
    expect($('showHijri').checked).toBe(true);
    expect($('hijriLabel').hidden).toBe(false);
    expect($('hijriLabel').textContent).toMatch(/^🌙 /);
    // Turn it off, nudge the offset, and save.
    $('showHijri').checked = false;
    $('hijriOffset').value = '1';
    $('save').click();
    await settle();
    const saved = chrome.__.sent.find((m) => m.type === 'SAVE_SETTINGS');
    expect(saved.settings).toMatchObject({ showHijri: false, hijriOffset: 1 });
  });
});

describe('action buttons relay to the worker', () => {
  it('Resume / Focus / Refresh / Test send their messages', async () => {
    await load();
    $('resumeBtn').click();
    $('focusBtn').click();
    $('refresh').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    $('testBtn').click();
    await settle();
    expect(sentTypes()).toEqual(expect.arrayContaining(['RESUME_NOW', 'FOCUS_NOW', 'REFRESH', 'TEST_ADHAN']));
    expect($('testMsg').textContent).toBe(EN.test_started);
  });

  it('the gear toggles the settings panel', async () => {
    await load();
    const before = $('settings').hidden;
    $('gear').click();
    expect($('settings').hidden).toBe(!before);
  });
});

describe('location autocomplete (Open-Meteo geocoding)', () => {
  it('debounces typing, lists real places, and fills the field on pick', async () => {
    await load();
    $('city').value = 'Lon';
    $('city').dispatchEvent(new window.Event('input'));

    jest.advanceTimersByTime(300); // debounce window
    await settle();

    const results = $('cityResults');
    expect(results.hidden).toBe(false);
    expect(results.querySelectorAll('.suggest-item')).toHaveLength(2);
    expect(results.children[0].textContent).toBe('London, England, United Kingdom');

    // Picking a suggestion fills the field and closes the list.
    results.children[0].dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    expect($('city').value).toBe('London, England, United Kingdom');
    expect(results.hidden).toBe(true);
  });

  it('does not search for fewer than two characters', async () => {
    await load();
    $('city').value = 'L';
    $('city').dispatchEvent(new window.Event('input'));
    jest.advanceTimersByTime(300);
    await settle();
    expect($('cityResults').hidden).toBe(true);
  });
});

describe('countdown ticking', () => {
  it('keeps the clock and countdown live on the 1-second interval', async () => {
    await load();
    const first = $('nextCountdown').textContent;
    jest.advanceTimersByTime(1000);
    expect($('clock').textContent).toMatch(/^🕐 /);
    expect($('nextCountdown').textContent).toMatch(/in /);
    expect(typeof first).toBe('string');
  });
});

describe('schedule edge cases', () => {
  it('marks the next prayer as "tomorrow" once today\'s slot has passed', async () => {
    const state = defaultState();
    state.nextPrayer = { name: 'Fajr', time: '04:27 AM', ts: BASE - 6 * 3600e3 }; // rolled over to next day
    await load({ state });
    const fajrRow = [...$('list').querySelectorAll('.row')].find((r) => r.querySelector('.pname').textContent === 'Fajr');
    expect(fajrRow.classList.contains('next')).toBe(true);
    expect(fajrRow.querySelector('.ptime').textContent).toContain(EN.tomorrow);
  });

  it('surfaces a save failure from the worker', async () => {
    const state = defaultState();
    await load({ state, send: (m) => (m.type === 'GET_STATE' ? state : { ok: false, error: 'Aladhan 500' }) });
    $('save').click();
    await settle();
    expect($('saveMsg').textContent).toContain('Aladhan 500');
  });
});

describe('language switching', () => {
  it('persists the choice and flips the document direction to RTL', async () => {
    await load();
    $('lang').value = 'ar';
    $('lang').dispatchEvent(new window.Event('change'));
    await settle();
    expect(chrome.__.store.lang).toBe('ar');
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('ar');
    // Static markup re-translated: the next-prayer label now reads Arabic.
    expect(document.querySelector('[data-i18n="next_prayer"]').textContent).toBe(cat('ar').next_prayer);
  });
});

describe('dev-only affordances', () => {
  it('stamps the version and hides the Test row in store builds (update_url present)', async () => {
    await load({ manifest: { version: '9.9.9', update_url: 'https://clients2.google.com/service/update2/crx' } });
    expect($('version').textContent).toBe('v9.9.9');
    expect(document.querySelector('.dev-row').hidden).toBe(true);
  });

  it('keeps the Test row visible in unpacked/dev builds', async () => {
    await load({ manifest: { version: '1.7.4' } });
    expect(document.querySelector('.dev-row').hidden).toBe(false);
  });
});

describe('prayer tracking', () => {
  it('puts a prayed-checkbox on each prayer row (sunrise gets a spacer) reflecting the log', async () => {
    const state = defaultState();
    state.schedule.date = '2026-05-23';
    state.prayerLog = { '2026-05-23': { Fajr: true } };
    await load({ state });
    const boxes = $('list').querySelectorAll('.row .pcheck input');
    expect(boxes).toHaveLength(5); // 5 prayers; sunrise's .pcheck is an empty spacer
    expect(boxes[0].checked).toBe(true); // Fajr marked
    expect(boxes[1].checked).toBe(false); // Dhuhr not
    // Past/current prayers are markable; still-upcoming prayers today are locked.
    expect(boxes[0].disabled).toBe(false); // Fajr — already passed
    expect(boxes[1].disabled).toBe(false); // Dhuhr — already passed
    expect(boxes[2].disabled).toBe(true); // Asr — still upcoming
    expect(boxes[4].disabled).toBe(true); // Isha — still upcoming
  });

  it('toggling a checkbox sends TOGGLE_PRAYER for that prayer + the shown day', async () => {
    const state = defaultState();
    state.schedule.date = '2026-05-23';
    const sent = [];
    await load({ state, send: (m) => { sent.push(m); return m.type === 'GET_STATE' ? state : { ok: true, prayerLog: {} }; } });
    $('list').querySelector('.row .pcheck input').click();
    await settle();
    expect(sent.find((m) => m.type === 'TOGGLE_PRAYER')).toMatchObject({ date: '2026-05-23', prayer: 'Fajr' });
  });

  it('opens a calendar for the current month with today ringed + heat-mapped days', async () => {
    const state = defaultState();
    state.schedule.date = '2026-05-23';
    state.installedAt = new Date('2026-05-10T12:00:00').getTime();
    state.prayerLog = {
      '2026-05-22': { Fajr: true, Dhuhr: true, Asr: true, Maghrib: true, Isha: true },
      '2026-05-23': { Fajr: true, Asr: true },
    };
    await load({ state });
    expect($('tracker').hidden).toBe(true);

    $('logBtn').click();
    expect($('tracker').hidden).toBe(false);
    expect($('settings').hidden).toBe(true);
    expect($('calLabel').textContent).toMatch(/May 2026/);

    const days = [...$('calGrid').querySelectorAll('.cal-day:not(.empty)')];
    expect(days).toHaveLength(31); // May
    expect($('calGrid').querySelector('.cal-day.today').textContent).toBe('23');
    expect(days.find((c) => c.textContent === '22').className).toContain('lvl-5'); // a full day
    expect(days.find((c) => c.textContent === '24').className).toContain('future'); // after today
  });

  it('disables next in the current month and navigates to the previous month', async () => {
    const state = defaultState();
    state.schedule.date = '2026-05-23';
    state.installedAt = new Date('2026-03-01T12:00:00').getTime();
    await load({ state });
    $('logBtn').click();
    expect($('calNext').disabled).toBe(true); // can't view future months
    expect($('calPrev').disabled).toBe(false);
    $('calPrev').click();
    expect($('calLabel').textContent).toMatch(/April 2026/);
    expect($('calNext').disabled).toBe(false);
  });

  it('selecting a past day shows its detail, and toggling a prayer there logs it', async () => {
    const state = defaultState();
    state.schedule.date = '2026-05-23';
    const sent = [];
    await load({ state, send: (m) => { sent.push(m); return m.type === 'GET_STATE' ? state : { ok: true, prayerLog: {} }; } });
    $('logBtn').click();
    const cell20 = [...$('calGrid').querySelectorAll('.cal-day:not(.empty)')].find((c) => c.textContent === '20');
    cell20.click();
    expect($('dayDetail').hidden).toBe(false);
    expect($('ddDate').textContent).toMatch(/20/);
    $('ddPrayers').querySelectorAll('.dd-p')[0].click(); // Fajr
    await settle();
    expect(sent.find((m) => m.type === 'TOGGLE_PRAYER')).toMatchObject({ date: '2026-05-20', prayer: 'Fajr' });
  });
});
