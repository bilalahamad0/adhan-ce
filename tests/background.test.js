// Integration tests for the MV3 service worker. background.js registers its
// chrome.* event listeners at import time, so each test installs a fresh chrome
// mock on globalThis, imports the real file (cache-busted), then drives the exact
// handlers the worker registered — onInstalled, onAlarm, onMessage, onCommand,
// notification clicks — and asserts the resulting storage / alarms / broadcasts.
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeChrome, flush } from './helpers/chrome-mock.js';
import { makeFetch, aladhanPayload } from './helpers/fetch-mock.js';
import { ymd } from '../lib/schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALARM_PRAYER = 'adhan-prayer-fire';
const ALARM_RESUME = 'adhan-auto-resume';
const ALARM_TICK = 'adhan-tick';

const DEFAULTS = {
  enabled: true,
  country: 'United States',
  state: 'California',
  city: 'Sunnyvale',
  autoResumeMinutes: 5,
  leadSeconds: 30,
  focusMode: true,
  method: 2,
  school: 0,
  showHijri: true,
  hijriOffset: 0,
};

// Serve real /locales catalogs to fetch() so the i18n round-trips are faithful.
function localeRoute() {
  return [
    'locales/',
    (url) => {
      const code = url.match(/locales\/(\w+)\.json/)[1];
      return JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8'));
    },
  ];
}

let counter = 0;
async function loadBackground({ storage = {}, fetchRoutes, manifest, uiLang } = {}) {
  const chrome = makeChrome({ initialStorage: storage, manifest, uiLang });
  // Per-test routes win: they precede the default success routes (first match used).
  const fetch = makeFetch([...(fetchRoutes || []), ['api.aladhan.com', () => aladhanPayload()], localeRoute()]);
  globalThis.chrome = chrome;
  globalThis.fetch = fetch;
  await import(`../background.js?t=${++counter}`);
  return { chrome, fetch, h: chrome.__ };
}

// A five-prayer schedule anchored to `now` so "which prayer is next" is deterministic.
function scheduleAround(now) {
  const prayers = [
    { name: 'Fajr', time: '04:27 AM', ts: now - 6 * 3600e3 },
    { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 },
    { name: 'Asr', time: '04:56 PM', ts: now + 3 * 3600e3 },
    { name: 'Maghrib', time: '08:17 PM', ts: now + 6 * 3600e3 },
    { name: 'Isha', time: '09:43 PM', ts: now + 8 * 3600e3 },
  ];
  return { date: ymd(new Date(now)), prayers, sunrise: { time: '06:01 AM', ts: now - 5 * 3600e3 }, tz: 'America/Los_Angeles', fetchedAt: now };
}

let warnSpy;
beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
  delete globalThis.chrome;
  delete globalThis.fetch;
});

describe('onInstalled (first run)', () => {
  it('seeds defaults, fetches the schedule, arms alarms, and injects open tabs', async () => {
    const { h, fetch } = await loadBackground();
    await h.fireInstalled();
    await flush();

    expect(h.store.settings).toEqual(DEFAULTS);
    expect(h.store.paused).toEqual({ active: false });

    // Aladhan timings (24h) become the "hh:mm a" map the app schedules on.
    const names = h.store.schedule.prayers.map((p) => p.name);
    expect(names).toEqual(['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
    expect(h.store.schedule.prayers[0].time).toBe('04:27 AM');
    expect(h.store.schedule.prayers[1].time).toBe('01:05 PM'); // 13:05 → 01:05 PM
    expect(h.store.schedule.sunrise.time).toBe('06:01 AM');
    expect(h.store.schedule.tz).toBe('America/Los_Angeles');
    expect(h.store.nextPrayer).toBeTruthy();

    // Alarms armed; both already-open tabs primed with the content script.
    expect(h.alarms.has(ALARM_PRAYER)).toBe(true);
    expect(h.alarms.has(ALARM_TICK)).toBe(true);
    expect(h.injected.sort()).toEqual([1, 2]);

    // Built the Aladhan request from the default location.
    const url = fetch.calls.find((u) => u.includes('aladhan'));
    expect(url).toContain('city=Sunnyvale');
    expect(url).toContain('country=United%20States');
    expect(url).toContain('state=California');
    expect(url).toContain('method=2');
    expect(url).toContain('school=0');
    expect(url).toMatch(/timingsByCity\/\d{2}-\d{2}-\d{4}\?/); // DD-MM-YYYY date path
  });

  it('does not overwrite settings/paused that already exist', async () => {
    const custom = { ...DEFAULTS, city: 'London', country: 'United Kingdom', state: '' };
    const { h } = await loadBackground({ storage: { settings: custom, paused: { active: true, prayer: 'Asr' } } });
    await h.fireInstalled();
    await flush();
    expect(h.store.settings.city).toBe('London');
    expect(h.store.paused.active).toBe(true); // mid-Adhan reload keeps the pause
  });

  it('survives a failed initial schedule fetch (still seeds + arms tick)', async () => {
    const { h } = await loadBackground({ fetchRoutes: [['api.aladhan.com', { status: 503 }]] });
    await h.fireInstalled();
    await flush();
    expect(h.store.settings).toEqual(DEFAULTS);
    expect(h.store.schedule).toBeUndefined();
    expect(h.alarms.has(ALARM_TICK)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('rejects a malformed Aladhan body (missing timings)', async () => {
    const { h } = await loadBackground({ fetchRoutes: [['api.aladhan.com', { code: 200, data: {} }]] });
    await h.fireInstalled();
    await flush();
    expect(h.store.schedule).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe('handlePrayerFire', () => {
  it('on a fresh fire: pauses tabs, notifies, badges, arms auto-resume, advances next', async () => {
    const now = Date.now();
    const schedule = scheduleAround(now);
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule, nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 }, lang: 'en' },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();

    expect(h.store.paused).toMatchObject({ active: true, prayer: 'Dhuhr', focus: true });
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].options.title).toContain('Dhuhr');
    expect(h.notifications[0].options.buttons).toHaveLength(2);
    const prayerNow = h.broadcasts.filter((b) => b.message.type === 'PRAYER_NOW');
    expect(prayerNow.map((b) => b.tabId).sort()).toEqual([1, 2]);
    expect(h.badge.text).toBe('❚❚');
    expect(h.alarms.has(ALARM_RESUME)).toBe(true);
    expect(h.store.nextPrayer.name).toBe('Asr'); // advanced past Dhuhr
  });

  it('treats a fire long past prayer time as missed (device slept), without pausing', async () => {
    const now = Date.now();
    const schedule = scheduleAround(now);
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule, paused: { active: false }, nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 100000 } },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();

    expect(h.store.paused).toEqual({ active: false });
    expect(h.notifications).toHaveLength(0);
    expect(h.broadcasts).toHaveLength(0);
    expect(h.store.nextPrayer.name).toBe('Asr'); // jumped forward, no catch-up burst
    expect(h.alarms.has(ALARM_RESUME)).toBe(false);
  });

  it('still fires a test Adhan even though its scheduled time has "passed"', async () => {
    const now = Date.now();
    const schedule = scheduleAround(now);
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule, nextPrayer: { name: 'Test', time: '1:00 PM', ts: now - 100000, test: true }, lang: 'en' },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.paused.active).toBe(true);
  });

  it('does nothing when the caster is disabled', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: { ...DEFAULTS, enabled: false }, schedule: scheduleAround(now), paused: { active: false }, nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 } },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.paused).toEqual({ active: false });
  });
});

describe('handleFallbackPause (content-script safety net)', () => {
  it('records the pause, broadcasts, arms resume, and advances next', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 } },
    });
    await h.sendRuntimeMessage({ type: 'PRAYER_FALLBACK', prayer: 'Dhuhr', time: '01:05 PM', focus: true });
    await flush();
    expect(h.store.paused).toMatchObject({ active: true, prayer: 'Dhuhr', focus: true });
    expect(h.alarms.has(ALARM_RESUME)).toBe(true);
    expect(h.store.nextPrayer.name).toBe('Asr');
  });

  it('is a no-op when a pause is already active (alarm path owns it)', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), paused: { active: true, prayer: 'Dhuhr' }, nextPrayer: { name: 'Asr', ts: now + 3600e3 } },
    });
    await h.sendRuntimeMessage({ type: 'PRAYER_FALLBACK', prayer: 'Dhuhr', time: '01:05 PM' });
    await flush();
    expect(h.broadcasts).toHaveLength(0);
    expect(h.alarms.has(ALARM_RESUME)).toBe(false);
  });
});

describe('auto-resume + reconcile', () => {
  it('handleAutoResume clears the pause, broadcasts RESUME, clears the badge', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS, paused: { active: true, prayer: 'Asr', since: Date.now() } } });
    await h.fireAlarm(ALARM_RESUME);
    await flush();
    expect(h.store.paused).toEqual({ active: false });
    expect(h.broadcasts.every((b) => b.message.type === 'RESUME')).toBe(true);
    expect(h.broadcasts).toHaveLength(2);
    expect(h.badge.text).toBe('');
  });

  it('reconcile (onStartup) re-arms auto-resume for the time still left', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), paused: { active: true, prayer: 'Asr', since: now - 60000 } },
    });
    await h.fireStartup();
    await flush();
    expect(h.alarms.has(ALARM_RESUME)).toBe(true); // 5min window, only 1min elapsed
    expect(h.store.paused.active).toBe(true);
    expect(h.badge.text).toBe('❚❚');
  });

  it('reconcile resumes immediately when the auto-resume window already elapsed', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), paused: { active: true, prayer: 'Asr', since: now - 10 * 60000 } },
    });
    await h.fireStartup();
    await flush();
    expect(h.store.paused).toEqual({ active: false });
  });
});

describe('broadcast inject-then-retry', () => {
  it('injects the content script into a tab that has none, then delivers', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 }, lang: 'en' },
    });
    h.deadTabs.add(2); // tab 2 has no live content script yet
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.injected).toContain(2); // re-injected
    // After injection the retry send lands, so tab 2 still gets PRAYER_NOW.
    expect(h.broadcasts.some((b) => b.tabId === 2 && b.message.type === 'PRAYER_NOW')).toBe(true);
  });
});

describe('armAlarms', () => {
  it('does not arm a prayer alarm while disabled, but keeps the heartbeat tick', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: { ...DEFAULTS, enabled: false }, schedule: scheduleAround(now), nextPrayer: { name: 'Asr', ts: now + 3600e3 }, paused: { active: false } },
    });
    await h.fireStartup();
    await flush();
    expect(h.alarms.has(ALARM_PRAYER)).toBe(false);
    expect(h.alarms.has(ALARM_TICK)).toBe(true);
  });
});

describe('notifications + command', () => {
  it('clicking the notification opens the popup', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS } });
    await h.clickNotif('adhan-x');
    await flush();
    expect(h.popupOpened).toBe(1);
  });

  it('notification buttons map to Focus (0) and Resume (1)', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS, paused: { active: true, prayer: 'Asr', time: '4:56 PM', since: Date.now(), focus: false } } });
    await h.clickNotifButton('id', 0);
    await flush();
    expect(h.broadcasts.some((b) => b.message.type === 'FOCUS_ON')).toBe(true);

    await h.clickNotifButton('id', 1);
    await flush();
    expect(h.store.paused).toEqual({ active: false });
    expect(h.broadcasts.some((b) => b.message.type === 'RESUME')).toBe(true);
  });

  it('the toggle-focus command flips focus on/off', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS, paused: { active: true, prayer: 'Asr', time: '4:56 PM', since: Date.now(), focus: false } } });
    await h.fireCommand('toggle-focus');
    await flush();
    expect(h.store.paused.focus).toBe(true);
    expect(h.broadcasts.some((b) => b.message.type === 'FOCUS_ON')).toBe(true);

    await h.fireCommand('toggle-focus');
    await flush();
    expect(h.store.paused.focus).toBe(false);
  });
});

describe('message router', () => {
  it('GET_STATE returns the merged settings + schedule + paused', async () => {
    const now = Date.now();
    const { h } = await loadBackground({ storage: { schedule: scheduleAround(now), paused: { active: false } } });
    const state = await h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(state.settings).toEqual(DEFAULTS); // defaults applied when none stored
    expect(state.schedule.tz).toBe('America/Los_Angeles');
  });

  it('GET_I18N resolves direction from the saved language (Arabic → rtl)', async () => {
    const { h } = await loadBackground({ storage: { lang: 'ar' } });
    const res = await h.sendRuntimeMessage({ type: 'GET_I18N' });
    expect(res.lang).toBe('ar');
    expect(res.dir).toBe('rtl');
    expect(res.messages.prayer_Fajr).toBeTruthy();
  });

  it('SAVE_SETTINGS merges, refetches for the new location, and re-arms', async () => {
    const { h, fetch } = await loadBackground({ storage: { settings: DEFAULTS } });
    const res = await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { city: 'London', country: 'United Kingdom', state: '' } });
    await flush();
    expect(res).toEqual({ ok: true });
    expect(h.store.settings.city).toBe('London');
    expect(fetch.calls.some((u) => u.includes('city=London'))).toBe(true);
    expect(h.alarms.has(ALARM_TICK)).toBe(true);
  });

  it('SAVE_SETTINGS forwards a custom calculation method + Asr school to Aladhan', async () => {
    const { h, fetch } = await loadBackground({ storage: { settings: DEFAULTS } });
    await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { method: 3, school: 1 } });
    await flush();
    expect(h.store.settings.method).toBe(3);
    expect(h.store.settings.school).toBe(1);
    const url = fetch.calls.find((u) => u.includes('aladhan') && u.includes('method=3'));
    expect(url).toContain('school=1');
  });

  it('SAVE_SETTINGS reports the error (and still arms) when the refetch fails', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS }, fetchRoutes: [['api.aladhan.com', { status: 500 }]] });
    const res = await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { city: 'Nowhere' } });
    await flush();
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/500/);
    expect(h.store.settings.city).toBe('Nowhere'); // settings still persisted
  });

  it('REFRESH re-fetches and reports ok / error', async () => {
    const ok = await loadBackground({ storage: { settings: DEFAULTS } });
    expect(await ok.h.sendRuntimeMessage({ type: 'REFRESH' })).toEqual({ ok: true });

    const bad = await loadBackground({ storage: { settings: DEFAULTS }, fetchRoutes: [['api.aladhan.com', { status: 500 }]] });
    const res = await bad.h.sendRuntimeMessage({ type: 'REFRESH' });
    expect(res.ok).toBe(false);
  });

  it('RESUME_NOW / FOCUS_NOW act on the active pause', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS, paused: { active: true, prayer: 'Asr', time: '4:56 PM', since: Date.now(), focus: false } } });
    expect(await h.sendRuntimeMessage({ type: 'FOCUS_NOW' })).toEqual({ ok: true });
    expect(h.store.paused.focus).toBe(true);
    expect(await h.sendRuntimeMessage({ type: 'RESUME_NOW' })).toEqual({ ok: true });
    expect(h.store.paused).toEqual({ active: false });
  });

  it('an unknown message is answered, not dropped', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS } });
    expect(await h.sendRuntimeMessage({ type: 'NOPE' })).toEqual({ ok: false, error: 'unknown message' });
  });
});

describe('TEST_ADHAN dev gate', () => {
  it('schedules a simulated Adhan in unpacked/dev builds (no update_url)', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS }, manifest: { version: '1.7.4' } });
    const res = await h.sendRuntimeMessage({ type: 'TEST_ADHAN', seconds: 30 });
    expect(res).toEqual({ ok: true });
    expect(h.store.nextPrayer.test).toBe(true);
    expect(h.alarms.has(ALARM_PRAYER)).toBe(true);
  });

  it('is refused in store builds (manifest carries update_url)', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS }, manifest: { version: '1.7.4', update_url: 'https://clients2.google.com/service/update2/crx' } });
    const res = await h.sendRuntimeMessage({ type: 'TEST_ADHAN' });
    expect(res).toEqual({ ok: false, error: 'dev only' });
  });
});

describe('prayer tracking', () => {
  it('onInstalled stamps installedAt once, never overwriting an existing one', async () => {
    const fresh = await loadBackground();
    await fresh.h.fireInstalled();
    await flush();
    expect(typeof fresh.h.store.installedAt).toBe('number');

    const prior = 1_700_000_000_000;
    const again = await loadBackground({ storage: { installedAt: prior } });
    await again.h.fireInstalled();
    await flush();
    expect(again.h.store.installedAt).toBe(prior);
  });

  it('GET_STATE exposes prayerLog + installedAt (defaulting when absent)', async () => {
    const withData = await loadBackground({ storage: { prayerLog: { '2026-06-04': { Fajr: true } }, installedAt: 123 } });
    const state = await withData.h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(state.prayerLog).toEqual({ '2026-06-04': { Fajr: true } });
    expect(state.installedAt).toBe(123);

    const empty = await loadBackground({ storage: {} });
    const s2 = await empty.h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(s2.prayerLog).toEqual({});
    expect(s2.installedAt).toBeNull();
  });

  it('TOGGLE_PRAYER marks, accumulates, toggles off, and drops emptied days', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS } });
    const r1 = await h.sendRuntimeMessage({ type: 'TOGGLE_PRAYER', date: '2026-06-04', prayer: 'Asr' });
    expect(r1.ok).toBe(true);
    expect(h.store.prayerLog['2026-06-04']).toEqual({ Asr: true });

    await h.sendRuntimeMessage({ type: 'TOGGLE_PRAYER', date: '2026-06-04', prayer: 'Fajr' });
    expect(h.store.prayerLog['2026-06-04']).toEqual({ Asr: true, Fajr: true });

    await h.sendRuntimeMessage({ type: 'TOGGLE_PRAYER', date: '2026-06-04', prayer: 'Asr' });
    expect(h.store.prayerLog['2026-06-04']).toEqual({ Fajr: true });

    const r4 = await h.sendRuntimeMessage({ type: 'TOGGLE_PRAYER', date: '2026-06-04', prayer: 'Fajr' });
    expect(r4.prayerLog['2026-06-04']).toBeUndefined(); // emptied day removed
  });

  it('TOGGLE_PRAYER rejects an unknown prayer without touching storage', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS } });
    const res = await h.sendRuntimeMessage({ type: 'TOGGLE_PRAYER', date: '2026-06-04', prayer: 'Brunch' });
    expect(res).toEqual({ ok: false, error: 'bad prayer' });
    expect(h.store.prayerLog).toBeUndefined();
  });
});
