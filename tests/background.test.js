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
import { simulateStaleTzData } from './helpers/stale-icu.js';
import { ymd, ymdInTz, zonedToEpoch, computeNext, buildPrayers, parseTimeToday, hhmmTo12h, epochAtOffset, tzOffsetMs, PRAYER_ORDER, DAY_MS } from '../lib/schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALARM_PRAYER = 'adhan-prayer-fire';
const ALARM_RESUME = 'adhan-auto-resume';
const ALARM_TICK = 'adhan-tick';
const ALARM_BADGE = 'adhan-badge-tick';
const ALARM_REVALIDATE = 'adhan-revalidate';
const ALARM_REVALIDATE_RETRY = 'adhan-revalidate-retry';

const DEFAULTS = {
  enabled: true,
  country: 'United States',
  state: 'California',
  city: 'Sunnyvale',
  autoResumeMinutes: 5,
  leadSeconds: 30,
  focusMode: true,
  strictFocus: false,
  adhanChime: true,
  badgeCountdown: true,
  badgeMode: 'auto',
  badgeManualHours: 2,
  method: 2,
  school: 0,
  showHijri: true,
  hijriOffset: 0,
  adjustMinutes: { Fajr: 0, Dhuhr: 0, Asr: 0, Maghrib: 0, Isha: 0 },
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

// Real Aladhan answers carry the date they are for: the requested one.
function requestedDay(url) {
  const m = String(url).match(/timingsByCity\/(\d{2}-\d{2}-\d{4})/);
  return m ? { date: { gregorian: { date: m[1] } } } : {};
}

let counter = 0;
async function loadBackground({ storage = {}, fetchRoutes, manifest, uiLang, firefox = false } = {}) {
  const chrome = makeChrome({ initialStorage: storage, manifest, uiLang, firefox });
  // Per-test routes win: they precede the default success routes (first match used).
  const fetch = makeFetch([
    ...(fetchRoutes || []),
    ['api.aladhan.com', (url) => aladhanPayload({ data: requestedDay(url) })],
    localeRoute(),
  ]);
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
  return { date: ymdInTz('America/Los_Angeles', new Date(now)), prayers, sunrise: { time: '06:01 AM', ts: now - 5 * 3600e3 }, tz: 'America/Los_Angeles', fetchedAt: now };
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
    expect(url).toMatch(/&iso8601=true$/); // times carry their UTC offset
    // Each prayer's instant comes from that offset, which is kept with it.
    expect(h.store.schedule.prayers.every((p) => Number.isInteger(p.offsetMin))).toBe(true);
    expect(Number.isInteger(h.store.schedule.sunrise.offsetMin)).toBe(true);
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

  it('on Firefox: retries a plain toast without buttons, and still counts the alert', async () => {
    const now = Date.now();
    const schedule = scheduleAround(now);
    const { h } = await loadBackground({
      firefox: true, // notifications.create throws on the Chrome-only `buttons`
      storage: { settings: DEFAULTS, schedule, nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 }, lang: 'en' },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();

    // The buttons variant was rejected; the retry shows a plain toast (no buttons).
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0].options.title).toContain('Dhuhr');
    expect(h.notifications[0].options.buttons).toBeUndefined();
    expect(h.notifications[0].options.priority).toBeUndefined();
    // And the Alerts counter still increments despite the buttons-throw.
    expect(h.store.usage.totals.notifications).toBe(1);
    // The rest of the prayer flow is unaffected.
    expect(h.store.paused).toMatchObject({ active: true, prayer: 'Dhuhr' });
    expect(h.store.nextPrayer.name).toBe('Asr');
  });

  it('plays chime via offscreen document when adhanChime is true', async () => {
    const now = Date.now();
    const schedule = scheduleAround(now);
    const { h } = await loadBackground({
      storage: { settings: { ...DEFAULTS, adhanChime: true }, schedule, nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 }, lang: 'en' },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();

    expect(h.offscreenDoc.url).toMatch(/^offscreen\.html\?play=audio%2Fchime\.mp3/);
    expect(h.offscreenDoc.reasons).toEqual(['AUDIO_PLAYBACK']);

    // When chime completes, background closes offscreen document
    await h.sendRuntimeMessage({ type: 'CHIME_FINISHED' });
    expect(h.offscreenDoc).toBeNull();
  });

  it('skips chime when adhanChime is false', async () => {
    const now = Date.now();
    const schedule = scheduleAround(now);
    const { h } = await loadBackground({
      storage: { settings: { ...DEFAULTS, adhanChime: false }, schedule, nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 }, lang: 'en' },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();

    expect(h.offscreenDoc).toBeNull();
    const chimeSent = h.sent.filter((s) => s && s.type === 'PLAY_CHIME');
    expect(chimeSent).toHaveLength(0);
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

  it('ignores a premature/duplicate fire for an already-advanced (future) prayer', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: {
        settings: DEFAULTS,
        schedule: scheduleAround(now),
        // A prior fire (or the content fallback) already paused Dhuhr and advanced
        // nextPrayer to Asr, whose time is still hours away.
        paused: { active: true, prayer: 'Dhuhr', time: '01:05 PM', since: now, focus: true },
        nextPrayer: { name: 'Asr', time: '04:56 PM', ts: now + 3 * 3600e3 },
        lang: 'en',
      },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.notifications).toHaveLength(0); // no wrong-prayer notification
    expect(h.broadcasts).toHaveLength(0); // no re-broadcast
    expect(h.store.paused.prayer).toBe('Dhuhr'); // pause state not clobbered to Asr
    expect(h.store.paused.active).toBe(true);
    expect(h.store.nextPrayer.name).toBe('Asr'); // nextPrayer not re-advanced
    expect(h.alarms.has(ALARM_RESUME)).toBe(false); // no fresh auto-resume armed
    expect(h.store.usage).toBeUndefined(); // and nothing counted
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

  it('GET_STATE refetches when the stored day has rolled over (location tz)', async () => {
    const now = Date.now();
    const stale = { ...scheduleAround(now), date: ymdInTz('America/Los_Angeles', new Date(now - 24 * 3600e3)) };
    const { h, fetch } = await loadBackground({ storage: { settings: DEFAULTS, schedule: stale } });
    const before = fetch.calls.filter((u) => u.includes('aladhan')).length;
    await h.sendRuntimeMessage({ type: 'GET_STATE' });
    await flush();
    expect(fetch.calls.filter((u) => u.includes('aladhan')).length).toBeGreaterThan(before); // refetched the new day
    expect(h.store.schedule.date).toBe(ymdInTz('America/Los_Angeles')); // now today's (location) date
  });

  it('GET_STATE recomputes nextPrayer without refetching when the day is current', async () => {
    const now = Date.now();
    const { h, fetch } = await loadBackground({ storage: { settings: DEFAULTS, schedule: scheduleAround(now) } });
    const before = fetch.calls.filter((u) => u.includes('aladhan')).length;
    await h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(fetch.calls.filter((u) => u.includes('aladhan')).length).toBe(before); // no refetch
    expect(h.store.nextPrayer).toBeTruthy();
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

  it('RESUME_NOW is refused while strictFocus screen freeze is active', async () => {
    const { h } = await loadBackground({
      storage: {
        settings: { ...DEFAULTS, strictFocus: true },
        paused: { active: true, prayer: 'Asr', time: '4:56 PM', since: Date.now(), focus: true },
      },
    });
    const res = await h.sendRuntimeMessage({ type: 'RESUME_NOW' });
    expect(res).toEqual({ ok: false, error: 'strict_focus_locked' });
    expect(h.store.paused.active).toBe(true);
  });

  it('SAVE_SETTINGS prevents turning strictFocus or focusMode OFF during an active prayer freeze', async () => {
    const { h } = await loadBackground({
      storage: {
        settings: { ...DEFAULTS, strictFocus: true, focusMode: true },
        paused: { active: true, prayer: 'Asr', time: '4:56 PM', since: Date.now(), focus: true },
      },
    });
    await h.sendRuntimeMessage({
      type: 'SAVE_SETTINGS',
      settings: { strictFocus: false, focusMode: false },
    });
    await flush();
    expect(h.store.settings.strictFocus).toBe(true);
    expect(h.store.settings.focusMode).toBe(true);
  });

  it('an unknown message is answered, not dropped', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS } });
    expect(await h.sendRuntimeMessage({ type: 'NOPE' })).toEqual({ ok: false, error: 'unknown message' });
  });
});

describe('TEST_ADHAN dev gate', () => {
  // The gate is now the compile-time DEV flag from lib/buildinfo.js (DEV=true in
  // source). The DEV=false store-build refusal is covered behaviorally in
  // tests/devgate.test.js (which mocks the flag off), and the guarantee that
  // packed builds ship DEV=false is in tests/pack.test.js.
  it('schedules a simulated Adhan in dev builds (source DEV=true)', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS } });
    const res = await h.sendRuntimeMessage({ type: 'TEST_ADHAN', seconds: 30 });
    expect(res).toEqual({ ok: true });
    expect(h.store.nextPrayer.test).toBe(true);
    expect(h.alarms.has(ALARM_PRAYER)).toBe(true);
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

  it('TOGGLE_PRAYER rejects marking future dates or upcoming prayers on today', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: {
        settings: DEFAULTS,
        schedule: {
          date: '2026-06-04',
          prayers: [
            { name: 'Fajr', time: '04:27 AM', ts: now - 3600e3 },
            { name: 'Dhuhr', time: '01:05 PM', ts: now + 3600e3 },
          ],
        },
      },
    });

    // 1. Future date rejected
    const rFutureDate = await h.sendRuntimeMessage({ type: 'TOGGLE_PRAYER', date: '2026-06-05', prayer: 'Fajr' });
    expect(rFutureDate).toEqual({ ok: false, error: 'cannot mark future prayer' });

    // 2. Upcoming prayer today rejected
    const rFuturePrayer = await h.sendRuntimeMessage({ type: 'TOGGLE_PRAYER', date: '2026-06-04', prayer: 'Dhuhr' });
    expect(rFuturePrayer).toEqual({ ok: false, error: 'prayer time has not passed yet' });

    // 3. Past prayer today allowed
    const rPastPrayer = await h.sendRuntimeMessage({ type: 'TOGGLE_PRAYER', date: '2026-06-04', prayer: 'Fajr' });
    expect(rPastPrayer.ok).toBe(true);
    expect(h.store.prayerLog['2026-06-04']).toEqual({ Fajr: true });
  });
});

describe('usage counters (local-only)', () => {
  it('a fresh fire bumps pauses + notifications; auto-resume bumps resumes', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 }, lang: 'en' },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.usage.totals.pauses).toBe(1);
    expect(h.store.usage.totals.notifications).toBe(1);

    await h.fireAlarm(ALARM_RESUME);
    await flush();
    expect(h.store.usage.totals.resumes).toBe(1);
    // The same day's per-day bucket accumulates each event (keyed by local date).
    const day = Object.values(h.store.usage.perDay)[0];
    expect(day).toMatchObject({ pauses: 1, notifications: 1, resumes: 1 });
  });

  it('counts a pause once when the alarm AND the content fallback fire for one prayer', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 }, paused: { active: false }, lang: 'en' },
    });
    // Both paths handle the same prayer; whichever writes paused second is a
    // true->true edge, so the transition listener counts the pause exactly once.
    await Promise.all([
      h.fireAlarm(ALARM_PRAYER),
      h.sendRuntimeMessage({ type: 'PRAYER_FALLBACK', prayer: 'Dhuhr', time: '01:05 PM', focus: true }),
    ]);
    await flush();
    expect(h.store.usage.totals.pauses).toBe(1);
  });

  it('does not re-count a pause on a duplicate/delayed fire while already paused', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 }, lang: 'en' },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.usage.totals.pauses).toBe(1);
    // A second fire arrives while the pause is still active (true->true edge) → no new pause.
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.usage.totals.pauses).toBe(1);
  });

  it('a missed (stale) fire records nothing', async () => {
    const now = Date.now();
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule: scheduleAround(now), paused: { active: false }, nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 100000 } },
    });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.usage).toBeUndefined();
  });

  it('FOCUS_NOW bumps focusUsed', async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS, paused: { active: true, prayer: 'Asr', time: '4:56 PM', since: Date.now(), focus: false } } });
    await h.sendRuntimeMessage({ type: 'FOCUS_NOW' });
    await flush();
    expect(h.store.usage.totals.focusUsed).toBe(1);
  });

  it('GET_STATE exposes usage (null when absent)', async () => {
    const { h } = await loadBackground({ storage: {} });
    const s = await h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(s.usage).toBeNull();
  });
});

describe('toolbar icon badge countdown', () => {
  it('arms ALARM_BADGE and sets countdown badge and tooltip when enabled', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    sched.prayers[2] = { name: 'Asr', time: '04:56 PM', ts: now + 45 * 60 * 1000 };
    const { h } = await loadBackground({
      storage: {
        settings: DEFAULTS,
        schedule: sched,
        nextPrayer: sched.prayers[2],
        paused: { active: false },
      },
    });
    await h.fireStartup();
    await flush();
    expect(h.alarms.has(ALARM_BADGE)).toBe(true);
    expect(h.badge.text).toBe('45m');
    expect(h.badge.color).toBe('#d97706'); // Asr is Amber
    expect(h.title).toBe('Next: Asr in 45m (04:56 PM)');
  });

  it('sets Crimson badge color (#be123c) when next prayer is Maghrib', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    sched.prayers[2].ts = now - 1000; // Asr in the past
    sched.prayers[3] = { name: 'Maghrib', time: '08:17 PM', ts: now + 50 * 60 * 1000 };
    const { h } = await loadBackground({
      storage: {
        settings: DEFAULTS,
        schedule: sched,
        nextPrayer: sched.prayers[3],
        paused: { active: false },
      },
    });
    await h.fireStartup();
    await flush();
    expect(h.badge.text).toBe('50m');
    expect(h.badge.color).toBe('#be123c'); // Maghrib is Crimson
    expect(h.title).toBe('Next: Maghrib in 50m (08:17 PM)');
  });

  it('sets Yellow badge color (#eab308) and high-contrast text color when next prayer is Dhuhr', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    sched.prayers[0].ts = now - 1000; // Fajr in the past
    sched.prayers[1] = { name: 'Dhuhr', time: '01:05 PM', ts: now + 35 * 60 * 1000 };
    const { h } = await loadBackground({
      storage: {
        settings: DEFAULTS,
        schedule: sched,
        nextPrayer: sched.prayers[1],
        paused: { active: false },
      },
    });
    await h.fireStartup();
    await flush();
    expect(h.badge.text).toBe('35m');
    expect(h.badge.color).toBe('#eab308'); // Dhuhr is Yellow
    expect(h.badge.textColor).toBe('#000000'); // Black text on yellow background
    expect(h.title).toBe('Next: Dhuhr in 35m (01:05 PM)');
  });

  it('ALARM_BADGE alarm tick updates badge countdown', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    sched.prayers[2] = { name: 'Asr', time: '04:56 PM', ts: now + 15 * 60 * 1000 };
    const { h } = await loadBackground({
      storage: {
        settings: DEFAULTS,
        schedule: sched,
        nextPrayer: sched.prayers[2],
        paused: { active: false },
      },
    });
    await h.fireStartup();
    await flush();
    expect(h.badge.text).toBe('15m');
    await h.fireAlarm(ALARM_BADGE);
    await flush();
    expect(h.badge.text).toBe('15m');
  });

  it('clears badge and resets title when badgeCountdown is disabled', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    sched.prayers[2] = { name: 'Asr', time: '04:56 PM', ts: now + 45 * 60 * 1000 };
    const { h } = await loadBackground({
      storage: {
        settings: { ...DEFAULTS, badgeCountdown: false },
        schedule: sched,
        nextPrayer: sched.prayers[2],
        paused: { active: false },
      },
    });
    await h.fireStartup();
    await flush();
    expect(h.alarms.has(ALARM_BADGE)).toBe(false);
    expect(h.badge.text).toBe('');
    expect(h.title).toBe('Adhan Focus — Muslim Prayer Times');
  });

  it('manual timer mode holds off countdown until within configured hours', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    sched.prayers[2].ts = now - 1000; // Asr in the past
    // Maghrib is 3 hours away; manual limit is 2 hours
    sched.prayers[3] = { name: 'Maghrib', time: '08:17 PM', ts: now + 3 * 3600 * 1000 };
    const { h } = await loadBackground({
      storage: {
        settings: { ...DEFAULTS, badgeMode: 'manual', badgeManualHours: 2 },
        schedule: sched,
        nextPrayer: sched.prayers[3],
        paused: { active: false },
      },
    });
    await h.fireStartup();
    await flush();
    // Beyond 2 hours: badge text is suppressed (blank)
    expect(h.badge.text).toBe('');
    // Hover tooltip still shows next prayer and full countdown
    expect(h.title).toBe('Next: Maghrib in 3h (08:17 PM)');

    // Now advance next prayer to within 2 hours (1h 30m)
    sched.prayers[3].ts = now + 90 * 60 * 1000;
    await chrome.storage.local.set({ nextPrayer: sched.prayers[3] });
    await h.fireAlarm(ALARM_BADGE);
    await flush();
    expect(h.badge.text).toBe('1h');
    expect(h.badge.color).toBe('#be123c'); // Crimson
  });

  it('switches to pause badge on prayer fire, then to next prayer countdown on resume', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    const { h } = await loadBackground({
      storage: {
        settings: DEFAULTS,
        schedule: sched,
        nextPrayer: { name: 'Dhuhr', time: '01:05 PM', ts: now - 1000 },
        paused: { active: false },
      },
    });
    // Fire prayer
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.badge.text).toBe('❚❚');
    expect(h.title).toBe('Dhuhr Adhan · Media paused');

    // Resume
    await h.fireAlarm(ALARM_RESUME);
    await flush();
    expect(h.store.paused.active).toBe(false);
    // nextPrayer was advanced in handlePrayerFire to Asr (ts = now + 3h), so badge is now the countdown
    expect(h.badge.text).toBe('3h');
    expect(h.badge.color).toBe('#d97706'); // Asr is Amber
    expect(h.title).toBe('Next: Asr in 3h (04:56 PM)');
  });

  it('handles 5-hour Countdown window between consecutive prayers (Asr -> Maghrib and Maghrib -> Isha) with immediate rollover', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    // Asr fires now:
    // Maghrib is at 8:17 PM (delta = 3h 21m < 5 hours)
    // Isha is at 9:43 PM (delta from Maghrib = 1h 26m < 5 hours)
    sched.prayers[2] = { name: 'Asr', time: '04:56 PM', ts: now - 1000 };
    sched.prayers[3] = { name: 'Maghrib', time: '08:17 PM', ts: now + (3 * 3600 + 21 * 60) * 1000 };
    sched.prayers[4] = { name: 'Isha', time: '09:43 PM', ts: now + (4 * 3600 + 47 * 60) * 1000 };

    const { h } = await loadBackground({
      storage: {
        settings: { ...DEFAULTS, badgeMode: 'manual', badgeManualHours: 5 },
        schedule: sched,
        nextPrayer: sched.prayers[2],
        paused: { active: false },
      },
    });

    // 1. Asr fires: badge shows pause icon ❚❚, nextPrayer advances to Maghrib
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.badge.text).toBe('❚❚');
    expect(h.badge.color).toBe('#d97706'); // Asr Amber
    expect(h.title).toBe('Asr Adhan · Media paused');
    expect(h.store.nextPrayer.name).toBe('Maghrib');

    // 2. Asr concludes / auto-resumes:
    // Delta between Asr and Maghrib is 3h 21m, which is LESS than the 5h manual window.
    // Therefore, Maghrib countdown starts IMMEDIATELY without any hold-off gap!
    await h.fireAlarm(ALARM_RESUME);
    await flush();
    expect(h.store.paused.active).toBe(false);
    expect(h.badge.text).toBe('3h');
    expect(h.badge.color).toBe('#be123c'); // Maghrib Crimson
    expect(h.title).toBe('Next: Maghrib in 3h 21m (08:17 PM)');

    // 3. Maghrib time arrives (8:17 PM): Maghrib fires
    const maghribNow = now + (3 * 3600 + 21 * 60) * 1000;
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(maghribNow);
    try {
      sched.prayers[3].ts = maghribNow - 1000;
      await chrome.storage.local.set({ nextPrayer: sched.prayers[3] });
      await h.fireAlarm(ALARM_PRAYER);
      await flush();
      expect(h.badge.text).toBe('❚❚');
      expect(h.badge.color).toBe('#be123c'); // Maghrib Crimson
      expect(h.title).toBe('Maghrib Adhan · Media paused');
      expect(h.store.nextPrayer.name).toBe('Isha');

      // 4. Maghrib concludes / auto-resumes:
      // Delta between Maghrib (8:17 PM) and Isha (9:43 PM) is 1h 26m (< 5h).
      // Therefore, Isha countdown starts IMMEDIATELY with Night Indigo badge!
      await h.fireAlarm(ALARM_RESUME);
      await flush();
      expect(h.store.paused.active).toBe(false);
      expect(h.badge.text).toBe('1h');
      expect(h.badge.color).toBe('#4338ca'); // Isha Night Indigo
      expect(h.title).toBe('Next: Isha in 1h 26m (09:43 PM)');
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('Firefox profile interoperability: badge countdown and clean hover tooltip work without errors', async () => {
    const now = Date.now();
    const sched = scheduleAround(now);
    sched.prayers[2] = { name: 'Asr', time: '04:56 PM', ts: now + 45 * 60 * 1000 };
    const { h } = await loadBackground({
      firefox: true,
      storage: {
        settings: DEFAULTS,
        schedule: sched,
        nextPrayer: sched.prayers[2],
        paused: { active: false },
      },
    });
    await h.fireStartup();
    await flush();
    expect(h.alarms.has(ALARM_BADGE)).toBe(true);
    expect(h.badge.text).toBe('45m');
    expect(h.badge.color).toBe('#d97706');
    expect(h.title).toBe('Next: Asr in 45m (04:56 PM)');
  });
});

describe('upgrade & historical data preservation', () => {
  it('preserves prayerLog, usage activity, installedAt, and custom settings upon extension upgrade', async () => {
    const historicalInstalledAt = 1_680_000_000_000;
    const historicalPrayerLog = {
      '2026-05-01': { Fajr: true, Dhuhr: true, Asr: true, Maghrib: true, Isha: true },
      '2026-05-02': { Fajr: true, Dhuhr: true },
      '2026-06-15': { Asr: true, Maghrib: true },
    };
    const historicalUsage = {
      totals: { pauses: 42, notifications: 38, resumes: 40 },
      perDay: {
        '2026-06-14': { pauses: 5, notifications: 5 },
        '2026-06-15': { pauses: 4, notifications: 4 },
      },
    };
    const userSettings = {
      ...DEFAULTS,
      city: 'Istanbul',
      country: 'Turkey',
      method: 13,
      school: 1,
      badgeMode: 'manual',
      badgeManualHours: 4,
    };

    // Simulate extension upgrading with pre-existing local storage
    const { h } = await loadBackground({
      storage: {
        settings: userSettings,
        installedAt: historicalInstalledAt,
        prayerLog: historicalPrayerLog,
        usage: historicalUsage,
        paused: { active: false },
      },
    });

    // Fire onInstalled as happens during a version update
    await h.fireInstalled({ reason: 'update', previousVersion: '2.0.3' });
    await flush();

    // 1. Verify installedAt is not overwritten with the upgrade timestamp
    expect(h.store.installedAt).toBe(historicalInstalledAt);

    // 2. Verify prayerLog is 100% intact across all past dates
    expect(h.store.prayerLog).toEqual(historicalPrayerLog);

    // 3. Verify usage counts and activity buckets are 100% intact
    expect(h.store.usage).toEqual(historicalUsage);

    // 4. Verify custom user settings are intact
    expect(h.store.settings.city).toBe('Istanbul');
    expect(h.store.settings.method).toBe(13);
    expect(h.store.settings.school).toBe(1);
    expect(h.store.settings.badgeManualHours).toBe(4);

    // 5. Verify GET_STATE returns the exact historical data
    const state = await h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(state.installedAt).toBe(historicalInstalledAt);
    expect(state.prayerLog).toEqual(historicalPrayerLog);
    expect(state.usage).toEqual(historicalUsage);
    expect(state.settings.city).toBe('Istanbul');

    // 6. Verify logging a new prayer continues seamlessly on top of historical data
    const res = await h.sendRuntimeMessage({
      type: 'TOGGLE_PRAYER',
      date: '2026-06-15',
      prayer: 'Isha',
    });
    expect(res.ok).toBe(true);
    expect(h.store.prayerLog['2026-06-15']).toEqual({ Asr: true, Maghrib: true, Isha: true });
    // Prior history still completely preserved
    expect(h.store.prayerLog['2026-05-01']).toEqual({ Fajr: true, Dhuhr: true, Asr: true, Maghrib: true, Isha: true });
  });
});


describe('pre-prayer revalidation (self-healing schedule)', () => {
  // 15:32 PDT on 2026-10-03 — exactly 45 min before a 16:17 Asr: the sampling
  // moment (T-45). Re-fetches are due in [T-45, T-30). Only Date is faked
  // (setImmediate stays real so flush() works): Date.now() / new Date() are frozen
  // at NOW until jest.setSystemTime.
  const TZ = 'America/Los_Angeles';
  const NOW = Date.parse('2026-10-03T22:32:00Z');
  const ASR = Date.parse('2026-10-03T23:17:00Z'); // 16:17 PDT
  const MIN = 60e3;
  const TIMINGS = { Fajr: '05:40', Sunrise: '07:05', Dhuhr: '12:50', Asr: '16:17', Sunset: '18:45', Maghrib: '18:45', Isha: '19:58' };
  // The daily request with today's (location) date pinned — the same request any
  // other client following the rule sends.
  const TODAY_URL =
    'https://api.aladhan.com/v1/timingsByCity/03-10-2026?city=Sunnyvale&country=United%20States&method=2&school=0&state=California&iso8601=true';

  // The schedule background.js would have stored from a morning fetch of `timings`.
  function morningSchedule(timings = TIMINGS, fetchedAt = NOW - 8 * 3600e3) {
    const base = new Date(NOW);
    const five = Object.fromEntries(PRAYER_ORDER.map((n) => [n, hhmmTo12h(timings[n])]));
    const sunrise = hhmmTo12h(timings.Sunrise);
    return {
      date: ymdInTz(TZ, base),
      prayers: buildPrayers(five, base, TZ),
      sunrise: { time: sunrise, ts: parseTimeToday(sunrise, base, TZ) },
      tz: TZ,
      fetchedAt,
    };
  }
  // Real Aladhan answers carry the day they are for; a re-fetch checks it.
  const DAY = { date: { gregorian: { date: '03-10-2026' } } };
  const payload = (overrides = {}, extra = {}) => aladhanPayload({ timings: { ...TIMINGS, ...overrides }, data: DAY, ...extra });
  const aladhan = (overrides = {}) => ['api.aladhan.com', () => payload(overrides)];
  // A route whose answer waits until release() — to overlap other work with a fetch.
  function gated(match, answer) {
    let release;
    const gate = new Promise((r) => (release = r));
    return { route: [match, async () => (await gate, answer())], release };
  }
  const aladhanCalls = (fetch) => fetch.calls.filter((u) => u.includes('api.aladhan.com'));
  const pick = (p) => ({ name: p.name, time: p.time, ts: p.ts });
  const at = (minutesBeforeAsr) => ASR - minutesBeforeAsr * MIN;

  function load({ schedule = morningSchedule(), timings, fetchRoutes, paused = { active: false }, nextPrayer, settings = DEFAULTS } = {}) {
    return loadBackground({
      storage: { settings, schedule, paused, nextPrayer: nextPrayer || pick(schedule.prayers[2]) },
      fetchRoutes: fetchRoutes || [aladhan(timings)],
    });
  }

  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // ---- the T-45 timer ----
  it('armAlarms arms a T-45 timer for the next prayer, and re-arms it for the following one', async () => {
    jest.setSystemTime(at(60)); // 15:17
    const schedule = morningSchedule();
    const { h, fetch } = await load({ schedule });
    await h.fireStartup();
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(0); // not due yet
    expect(h.alarms.get(ALARM_REVALIDATE)).toEqual({ when: at(45) });

    // Asr fires: the timer moves to Maghrib's T-45.
    jest.setSystemTime(ASR);
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.nextPrayer.name).toBe('Maghrib');
    expect(h.alarms.get(ALARM_REVALIDATE)).toEqual({ when: schedule.prayers[3].ts - 45 * MIN });
  });

  it('does not arm the T-45 timer once that moment passed, while disabled, or for a dev test fire', async () => {
    jest.setSystemTime(at(44));
    const late = await load({ schedule: morningSchedule(TIMINGS, NOW) });
    await late.h.fireStartup();
    await flush();
    expect(late.h.alarms.has(ALARM_REVALIDATE)).toBe(false);
    expect(late.h.alarms.has(ALARM_PRAYER)).toBe(true);

    jest.setSystemTime(at(60));
    const off = await load({ settings: { ...DEFAULTS, enabled: false } });
    await off.h.fireStartup();
    await flush();
    expect(off.h.alarms.has(ALARM_REVALIDATE)).toBe(false);

    const test = await load();
    await test.h.sendRuntimeMessage({ type: 'TEST_ADHAN', seconds: 30 });
    expect(test.h.store.nextPrayer.test).toBe(true);
    await test.h.fireAlarm(ALARM_BADGE);
    await flush();
    expect(test.h.alarms.has(ALARM_REVALIDATE)).toBe(false);
  });

  it('the T-45 timer re-fetches today and re-arms the prayer alarm when Asr moved by a minute', async () => {
    const schedule = morningSchedule();
    const oldAsr = schedule.prayers[2];
    const { h, fetch, chrome } = await load({ schedule, timings: { Asr: '16:16' } });
    // content.js follows nextPrayer through storage.onChanged — capture what it sees.
    const seen = [];
    chrome.storage.onChanged.addListener((c) => c.nextPrayer && seen.push(c.nextPrayer.newValue));

    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();

    expect(aladhanCalls(fetch)).toEqual([TODAY_URL]); // same request, today's date
    const asr = h.store.schedule.prayers[2];
    expect(asr.time).toBe('04:16 PM');
    expect(asr.ts).toBe(oldAsr.ts - MIN);
    expect(h.store.schedule).toMatchObject({ date: schedule.date, tz: TZ, fetchedAt: NOW });
    expect(h.store.nextPrayer).toEqual(pick(asr));
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(asr.ts); // re-armed for the new time
    expect(h.alarms.has(ALARM_REVALIDATE)).toBe(false); // the new T-45 (15:31) already passed
    expect(seen.at(-1)).toEqual(pick(asr));
    expect(warnSpy).not.toHaveBeenCalled();

    // Once per prayer: a later tick inside the window does not re-fetch.
    jest.setSystemTime(at(35));
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(asr.ts);
  });

  it('a prayer that moved later re-arms its T-45 timer, which does not fetch a second time', async () => {
    const schedule = morningSchedule();
    const { h, fetch } = await load({ schedule, timings: { Asr: '16:19' } });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    const moved = h.store.schedule.prayers[2];
    expect(moved.ts).toBe(ASR + 2 * MIN);
    expect(h.alarms.get(ALARM_REVALIDATE)).toEqual({ when: moved.ts - 45 * MIN }); // 15:34

    jest.setSystemTime(moved.ts - 45 * MIN);
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1); // fetched at 15:32, fresh since 15:29
    expect(h.store.schedule.prayers[2]).toEqual(moved);
  });

  // ---- catch-up: the periodic tick, a browser start, the popup ----
  it('a tick anywhere in [T-45, T-30) catches up a missed T-45 timer; outside it does not', async () => {
    const cases = [
      [46, 0], // 15:31: too early
      [44, 1], // 15:33: e.g. a wake from sleep
      [31, 1], // 15:46: last minute of the window
      [30, 0], // 15:47: the window end is exclusive
      [10, 0],
    ];
    for (const [minutesBefore, calls] of cases) {
      jest.setSystemTime(at(minutesBefore));
      const { h, fetch } = await load({ timings: { Asr: '16:16' } });
      await h.fireAlarm(ALARM_TICK);
      await flush();
      expect([minutesBefore, aladhanCalls(fetch).length]).toEqual([minutesBefore, calls]);
      expect(h.store.schedule.prayers[2].time).toBe(calls ? '04:16 PM' : '04:17 PM');
    }
  });

  it('does not re-fetch when today was fetched at or after T-50', async () => {
    for (const fetchedAt of [at(50), at(47), NOW]) {
      const schedule = morningSchedule(TIMINGS, fetchedAt);
      const { h, fetch } = await load({ schedule });
      await h.fireAlarm(ALARM_REVALIDATE);
      await flush();
      expect(aladhanCalls(fetch)).toHaveLength(0);
      expect(h.store.schedule).toEqual(schedule);
    }
  });

  it('an identical answer only records the fetch time', async () => {
    const schedule = morningSchedule();
    const { h, fetch } = await load({ schedule });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();

    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.store.schedule).toEqual({ ...schedule, fetchedAt: NOW });
    expect(h.store.nextPrayer).toEqual(pick(schedule.prayers[2]));
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts);
  });

  it('opening the popup in the window revalidates and re-arms the prayer alarm itself', async () => {
    jest.setSystemTime(at(40));
    const schedule = morningSchedule();
    const oldTs = schedule.prayers[2].ts;
    const { h } = await load({ schedule, timings: { Asr: '16:18' } });
    h.alarms.set(ALARM_PRAYER, { when: oldTs }); // armed for the morning answer

    const state = await h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(state.schedule.prayers[2].time).toBe('04:18 PM');
    expect(state.nextPrayer).toEqual({ name: 'Asr', time: '04:18 PM', ts: oldTs + MIN });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(oldTs + MIN);
  });

  it('opening the popup with an identical answer does not touch the alarms', async () => {
    const { h, fetch } = await load();
    await h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.store.schedule.fetchedAt).toBe(NOW);
    expect(h.alarms.size).toBe(0); // no armAlarms() — the heartbeat tick isn't reset
  });

  it('a browser start inside the window revalidates before arming', async () => {
    jest.setSystemTime(at(38));
    const schedule = morningSchedule();
    const { h } = await load({ schedule, timings: { Asr: '16:16' } });
    await h.fireStartup();
    await flush();
    expect(h.store.schedule.prayers[2].time).toBe('04:16 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts - MIN);
  });

  // ---- one request at a time ----
  it('concurrent triggers share one in-flight Aladhan request', async () => {
    const schedule = morningSchedule();
    const slow = gated('api.aladhan.com', () => payload({ Asr: '16:16' }));
    const { h, fetch } = await load({ schedule, fetchRoutes: [slow.route] });

    const startup = h.fireStartup();
    await h.fireAlarm(ALARM_TICK);
    await h.fireAlarm(ALARM_REVALIDATE);
    const popup = h.sendRuntimeMessage({ type: 'GET_STATE' });
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);

    slow.release();
    await startup;
    const state = await popup;
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(state.schedule.prayers[2].time).toBe('04:16 PM');
    expect(h.store.schedule.prayers[2].time).toBe('04:16 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts - MIN);
  });

  it('concurrent triggers share one in-flight day-rollover request', async () => {
    const stale = { ...morningSchedule(), date: '2026-10-02' };
    const slow = gated('api.aladhan.com', () => payload({}));
    const { h, fetch } = await load({ schedule: stale, fetchRoutes: [slow.route] });
    const startup = h.fireStartup();
    await h.fireAlarm(ALARM_TICK);
    const popup = h.sendRuntimeMessage({ type: 'GET_STATE' });
    await flush();
    expect(aladhanCalls(fetch)).toEqual([TODAY_URL]); // the location's today
    slow.release();
    await startup;
    await popup;
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.store.schedule.date).toBe('2026-10-03');
  });

  // ---- what blocks it ----
  it('never re-fetches for a disabled install', async () => {
    const { h, fetch } = await load({ settings: { ...DEFAULTS, enabled: false } });
    await h.fireAlarm(ALARM_REVALIDATE);
    await h.fireAlarm(ALARM_TICK);
    await flush();
    await h.fireStartup();
    await h.sendRuntimeMessage({ type: 'GET_STATE' });
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(0);
    expect(h.alarms.has(ALARM_REVALIDATE)).toBe(false);
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);
  });

  // Isha 45-55 min after Maghrib (Jafari / Tehran): Isha's T-45 falls in the 10
  // minutes after Maghrib. The check is tried again at T-35 — when other clients
  // following the rule retry it — as a first attempt that keeps its own retry.
  it('a T-45 held by the 10 minutes after a prayer is tried once at T-35, the same moment as the retry', async () => {
    const close = { ...TIMINGS, Isha: '19:35' }; // 50 min after Maghrib
    const schedule = morningSchedule(close);
    const maghrib = schedule.prayers[3];
    const isha = schedule.prayers[4];
    const T = (m) => isha.ts - m * MIN;
    let n = 0;
    const flaky = ['api.aladhan.com', () => (n++ === 0 ? { status: 503 } : payload({ ...close, Isha: '19:36' }))];
    jest.setSystemTime(maghrib.ts);
    const settings = { ...DEFAULTS, autoResumeMinutes: 120 }; // Maghrib's pause outlasts Isha's window
    const { h, fetch } = await load({ schedule, nextPrayer: pick(maghrib), fetchRoutes: [flaky], settings });

    // Maghrib fires: Isha is next, and its T-45 (18:50) is armed.
    jest.setSystemTime(maghrib.ts + 50);
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.nextPrayer.name).toBe('Isha');
    expect(h.alarms.get(ALARM_REVALIDATE)).toEqual({ when: T(45) });

    // 18:50: still within 10 min of Maghrib, so no fetch; tried again at T-35 (19:00).
    jest.setSystemTime(T(45));
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(0);
    expect(h.alarms.get(ALARM_REVALIDATE)).toEqual({ when: T(35) });
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);

    // A tick inside the quiet period changes nothing.
    jest.setSystemTime(maghrib.ts + 8 * MIN);
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(0);
    expect(h.alarms.get(ALARM_REVALIDATE)).toEqual({ when: T(35) });

    // 19:00 (T-35): the attempt runs during Maghrib's pause. It fails, and T-35 is
    // already the retry moment, so nothing more is armed and later ticks don't fetch.
    jest.setSystemTime(T(35));
    h.alarms.delete(ALARM_REVALIDATE); // Chrome drops a one-shot alarm once it fired
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);
    expect(h.alarms.has(ALARM_REVALIDATE)).toBe(false);
    jest.setSystemTime(T(32));
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.store.schedule.prayers[4].time).toBe('07:35 PM'); // kept
    expect(h.store.paused).toMatchObject({ active: true, prayer: 'Maghrib' });
  });

  it('a T-35 attempt during a long pause applies a moved Isha', async () => {
    const close = { ...TIMINGS, Isha: '19:35' };
    const schedule = morningSchedule(close);
    const maghrib = schedule.prayers[3];
    const isha = schedule.prayers[4];
    const settings = { ...DEFAULTS, autoResumeMinutes: 120 };
    jest.setSystemTime(maghrib.ts);
    const { h, fetch } = await load({ schedule, nextPrayer: pick(maghrib), timings: { ...close, Isha: '19:36' }, settings });
    jest.setSystemTime(maghrib.ts + 50);
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    jest.setSystemTime(isha.ts - 45 * MIN);
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(0); // quiet period after Maghrib
    jest.setSystemTime(isha.ts - 35 * MIN);
    h.alarms.delete(ALARM_REVALIDATE);
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.store.schedule.prayers[4].time).toBe('07:36 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(isha.ts + MIN);
    expect(h.store.paused).toMatchObject({ active: true, prayer: 'Maghrib' }); // the pause did not block it
  });

  it('Isha exactly 45 min after Maghrib: the Maghrib fire arms Isha\'s check at T-35, when the quiet period ends', async () => {
    const close = { ...TIMINGS, Isha: '19:30' };
    const schedule = morningSchedule(close);
    const maghrib = schedule.prayers[3];
    const isha = schedule.prayers[4];
    jest.setSystemTime(maghrib.ts);
    const { h, fetch } = await load({ schedule, nextPrayer: pick(maghrib), fetchRoutes: [aladhan({ ...close, Isha: '19:31' })] });

    jest.setSystemTime(maghrib.ts + 50);
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.nextPrayer.name).toBe('Isha');
    // Isha's T-45 is Maghrib's own time, already past: T-35 = Maghrib + 10 instead.
    expect(h.alarms.get(ALARM_REVALIDATE)).toEqual({ when: maghrib.ts + 10 * MIN });

    jest.setSystemTime(maghrib.ts + 5 * MIN);
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(0);

    jest.setSystemTime(maghrib.ts + 10 * MIN);
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.store.schedule.prayers[4].time).toBe('07:31 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(isha.ts + MIN);
  });

  it('arms nothing for a prayer whose T-35 is still in the quiet period of the one before', async () => {
    const close = { ...TIMINGS, Isha: '19:27' }; // 42 min after Maghrib
    const schedule = morningSchedule(close);
    const maghrib = schedule.prayers[3];
    jest.setSystemTime(maghrib.ts + 50);
    const { h } = await load({ schedule, nextPrayer: pick(maghrib) });
    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    expect(h.store.nextPrayer.name).toBe('Isha');
    expect(h.alarms.has(ALARM_REVALIDATE)).toBe(false);
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);
  });

  it('still re-fetches during a long media pause that began before the fetch', async () => {
    // Maghrib's pause runs for up to 120 min, past Isha's whole window (19:13–19:28).
    const schedule = morningSchedule();
    const maghrib = schedule.prayers[3];
    const isha = schedule.prayers[4];
    jest.setSystemTime(isha.ts - 45 * MIN);
    const paused = { active: true, prayer: 'Maghrib', time: '06:45 PM', since: maghrib.ts, focus: true };
    const { h, fetch } = await load({
      schedule,
      paused,
      nextPrayer: pick(isha),
      settings: { ...DEFAULTS, autoResumeMinutes: 120 },
      timings: { Isha: '19:59' },
    });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.store.schedule.prayers[4].time).toBe('07:59 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(isha.ts + MIN);
    expect(h.store.paused).toEqual(paused); // the pause carries on
  });

  it('drops the answer when a prayer fires while the re-fetch is in flight', async () => {
    const schedule = morningSchedule();
    const moved = gated('api.aladhan.com', () => payload({ Asr: '16:16' }));
    const { h, chrome } = await load({ schedule, fetchRoutes: [moved.route] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    await chrome.storage.local.set({ paused: { active: true, prayer: 'Asr', time: '03:32 PM', since: NOW, focus: true } });
    moved.release();
    await flush();
    expect(h.store.schedule).toEqual(schedule); // fetchedAt untouched → a later trigger retries
  });

  it('does not re-fetch while a dev test fire is pending', async () => {
    const test = await load({ nextPrayer: { name: 'Asr', time: '03:32 PM', ts: NOW + 30e3, test: true } });
    await test.h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(aladhanCalls(test.fetch)).toHaveLength(0);
  });

  // ---- failures and retries ----
  it('a failed revalidation keeps the stored times, warns, arms one retry, and does not throw', async () => {
    const schedule = morningSchedule();
    const { h, fetch } = await load({ schedule, fetchRoutes: [['api.aladhan.com', { status: 503 }]] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();

    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(h.store.schedule).toEqual(schedule); // never cleared, fetchedAt untouched
    expect(h.store.nextPrayer).toEqual(pick(schedule.prayers[2]));
    // refreshNext didn't throw: the alarm path went on to arm the (unchanged) prayer alarm.
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts);
    expect(h.alarms.get(ALARM_REVALIDATE_RETRY)).toEqual({ when: at(35) }); // the one retry, at T-35
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('revalidation failed'), expect.any(Error));
    expect(warnSpy).not.toHaveBeenCalledWith('Adhan: tick failed', expect.anything());

    // The popup still opens on the stored schedule, and does not hit the network
    // again: one attempt per window, then the T-35 retry.
    const state = await h.sendRuntimeMessage({ type: 'GET_STATE' });
    expect(state.schedule).toEqual(schedule);
    expect(aladhanCalls(fetch)).toHaveLength(1);
    jest.setSystemTime(NOW + 5 * MIN);
    await h.sendRuntimeMessage({ type: 'GET_STATE' });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
  });

  it('the retry applies a fresh answer and is then cleared', async () => {
    let n = 0;
    const flaky = ['api.aladhan.com', () => (n++ === 0 ? { status: 503 } : payload({ Asr: '16:16' }))];
    const schedule = morningSchedule();
    const { h, fetch } = await load({ schedule, fetchRoutes: [flaky] });

    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(h.store.schedule.prayers[2].time).toBe('04:17 PM');
    expect(h.alarms.get(ALARM_REVALIDATE_RETRY)).toEqual({ when: at(35) });

    jest.setSystemTime(at(35));
    await h.fireAlarm(ALARM_REVALIDATE_RETRY);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(h.store.schedule.prayers[2].time).toBe('04:16 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts - MIN);
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);
  });

  it('a failed retry is not retried again', async () => {
    const schedule = morningSchedule();
    const { h, fetch } = await load({ schedule, fetchRoutes: [['api.aladhan.com', { status: 503 }]] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    h.alarms.delete(ALARM_REVALIDATE_RETRY); // Chrome drops a one-shot alarm once it fired
    jest.setSystemTime(at(40));
    await h.fireAlarm(ALARM_REVALIDATE_RETRY);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);
    expect(h.store.schedule).toEqual(schedule);
  });

  it('a malformed answer is treated as a failure too', async () => {
    const schedule = morningSchedule();
    const { h } = await load({ schedule, fetchRoutes: [['api.aladhan.com', { code: 200, data: {} }]] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(h.store.schedule).toEqual(schedule);
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('revalidation failed'), expect.any(Error));
  });

  it('a catch-up attempt retries at T-35 only when it ran before T-35', async () => {
    const schedule = morningSchedule();
    jest.setSystemTime(at(38)); // 15:39 catch-up: retry at 15:42 (T-35)
    const a = await load({ schedule, fetchRoutes: [['api.aladhan.com', { status: 503 }]] });
    await a.h.fireAlarm(ALARM_TICK);
    await flush();
    expect(a.h.alarms.get(ALARM_REVALIDATE_RETRY)).toEqual({ when: at(35) });

    jest.setSystemTime(at(34)); // 15:43: past T-35, so this attempt was the last
    const b = await load({ schedule, fetchRoutes: [['api.aladhan.com', { status: 503 }]] });
    await b.h.fireAlarm(ALARM_TICK);
    await flush();
    expect(b.h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);
  });

  it('a schedule from another day takes the day-rollover fetch, which still throws on failure', async () => {
    const stale = { ...morningSchedule(), date: '2026-10-02' };
    const { h, fetch } = await load({ schedule: stale, fetchRoutes: [['api.aladhan.com', { status: 503 }]] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith('Adhan: tick failed', expect.any(Error));
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('revalidation'), expect.anything());
    expect(h.store.schedule).toEqual(stale);
  });

  // ---- answers that would move a prayer across "now" ----
  it('rejects an answer that would re-fire a passed prayer, and stores it once nothing crosses now', async () => {
    const schedule = morningSchedule();
    const { h, chrome } = await load({ schedule, timings: { Dhuhr: '15:45', Asr: '16:16' } });
    h.alarms.set(ALARM_PRAYER, { when: schedule.prayers[2].ts });
    const seen = [];
    chrome.storage.onChanged.addListener((c) => c.nextPrayer && seen.push(c.nextPrayer.newValue.name));
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();

    // Nothing stored: Dhuhr (passed at 12:50) would come back at 15:45.
    expect(h.store.schedule).toEqual(schedule);
    expect(h.store.nextPrayer).toEqual(pick(schedule.prayers[2]));
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts);
    expect(h.alarms.get(ALARM_REVALIDATE_RETRY)).toEqual({ when: at(35) });
    expect(seen).not.toContain('Dhuhr');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('across now'));
    expect(h.notifications).toHaveLength(0);

    // Maghrib's T-45: with Dhuhr in the past on both sides, the same answer is stored.
    jest.setSystemTime(Date.parse('2026-10-04T01:00:00Z')); // 18:00 PDT
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(h.store.schedule.prayers[1].time).toBe('03:45 PM');
    expect(h.store.nextPrayer.name).toBe('Maghrib');
    expect(h.notifications).toHaveLength(0);
  });

  it('rejects an answer that would skip the pending prayer, and retries once', async () => {
    const schedule = morningSchedule();
    const { h, fetch } = await load({ schedule, timings: { Asr: '15:00' } });
    h.alarms.set(ALARM_PRAYER, { when: schedule.prayers[2].ts });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();

    expect(h.store.schedule).toEqual(schedule); // Asr stays 04:17 PM, not skipped
    expect(h.store.nextPrayer).toEqual(pick(schedule.prayers[2]));
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts);
    expect(h.store.paused || { active: false }).toMatchObject({ active: false });
    expect(h.notifications).toHaveLength(0);

    // fetchedAt was not advanced, so the retry tries again — and stops there.
    h.alarms.delete(ALARM_REVALIDATE_RETRY);
    jest.setSystemTime(at(40));
    await h.fireAlarm(ALARM_REVALIDATE_RETRY);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(h.store.schedule).toEqual(schedule);
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);
  });

  // ---- a settings save / Refresh that lands while a re-fetch is in flight ----
  it('a settings save during an in-flight revalidation is not overwritten by the old answer', async () => {
    const schedule = morningSchedule();
    const school0 = gated('school=0', () => payload({}));
    const { h, fetch } = await load({
      schedule,
      fetchRoutes: [school0.route, ['school=1', () => payload({ Asr: '17:05' })]],
    });

    await h.fireAlarm(ALARM_REVALIDATE); // 15:32: Asr's T-45 → re-fetch starts
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);

    const saved = await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { school: 1 } });
    expect(saved).toEqual({ ok: true });
    const hanafiAsr = h.store.schedule.prayers[2];
    expect(hanafiAsr.time).toBe('05:05 PM');

    school0.release(); // the stale school=0 answer lands now
    await flush();
    expect(h.store.settings.school).toBe(1);
    expect(h.store.schedule.prayers[2]).toEqual(hanafiAsr);
    expect(h.store.nextPrayer).toEqual(pick(hanafiAsr));
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(hanafiAsr.ts);
  });

  it('a city change during an in-flight revalidation keeps the new city', async () => {
    const sunnyvale = gated('city=Sunnyvale', () => payload({}));
    const { h } = await load({
      fetchRoutes: [sunnyvale.route, ['city=Cupertino', () => payload({ Asr: '17:30' })]],
    });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { city: 'Cupertino' } });
    sunnyvale.release();
    await flush();
    expect(h.store.settings.city).toBe('Cupertino');
    expect(h.store.schedule.prayers[2].time).toBe('05:30 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(h.store.schedule.prayers[2].ts);
  });

  it('a revalidation whose fetch failed after a settings save leaves the new schedule alone', async () => {
    const failing = gated('school=0', () => ({ status: 503 }));
    const { h } = await load({ fetchRoutes: [failing.route, ['school=1', () => payload({ Asr: '17:05' })]] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { school: 1 } });
    failing.release();
    await flush();
    expect(h.store.nextPrayer.time).toBe('05:05 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(h.store.schedule.prayers[2].ts);
  });

  // The two commit guards, each on its own: the stored schedule changed (same
  // settings), and the settings changed (same stored schedule).
  it('a Refresh that lands during an in-flight revalidation is not overwritten by the older answer', async () => {
    const schedule = morningSchedule();
    let release;
    const gate = new Promise((r) => (release = r));
    let n = 0;
    // The same request both times: the revalidation's answer is held back, Refresh's is not.
    const route = ['api.aladhan.com', async () => (n++ === 0 ? (await gate, payload({ Asr: '16:16' })) : payload({ Asr: '16:18' }))];
    const { h, fetch } = await load({ schedule, fetchRoutes: [route] });

    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(await h.sendRuntimeMessage({ type: 'REFRESH' })).toEqual({ ok: true });
    expect(h.store.schedule.prayers[2].time).toBe('04:18 PM');
    const refreshed = h.store.schedule;

    release();
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(h.store.schedule).toEqual(refreshed);
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(refreshed.prayers[2].ts);
  });

  it('a settings save whose own fetch failed still drops the in-flight revalidation\'s answer', async () => {
    const schedule = morningSchedule();
    const school0 = gated('school=0', () => payload({ Asr: '16:16' }));
    const { h } = await load({ schedule, fetchRoutes: [school0.route, ['school=1', { status: 503 }]] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    const saved = await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { school: 1 } });
    expect(saved.ok).toBe(false);
    expect(h.store.schedule).toEqual(schedule); // untouched by the failed save

    school0.release(); // the school=0 answer must not be stored under school=1
    await flush();
    expect(h.store.settings.school).toBe(1);
    expect(h.store.schedule).toEqual(schedule);
  });

  it('the day-rollover fetch drops its answer when the settings changed while it was in flight', async () => {
    const stale = { ...morningSchedule(), date: '2026-10-02' };
    const school0 = gated('school=0', () => payload({}));
    const { h } = await load({ schedule: stale, fetchRoutes: [school0.route, ['school=1', () => payload({ Asr: '17:05' })]] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { school: 1 } });
    school0.release();
    await flush();
    expect(h.store.schedule.prayers[2].time).toBe('05:05 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(h.store.schedule.prayers[2].ts);
  });

  it('a pause that ends during the re-fetch does not drop its answer', async () => {
    const schedule = morningSchedule();
    const paused = { active: true, prayer: 'Dhuhr', time: '12:50 PM', since: NOW - 5 * MIN, focus: false };
    const slow = gated('api.aladhan.com', () => payload({ Asr: '16:16' }));
    const { h, fetch } = await load({ schedule, paused, fetchRoutes: [slow.route] });
    const run = h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    await h.sendRuntimeMessage({ type: 'RESUME_NOW' }); // the user resumes mid-fetch
    slow.release();
    await run;
    await flush();
    expect(h.store.paused.active).toBe(false);
    expect(h.store.schedule.prayers[2].time).toBe('04:16 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts - MIN);
  });

  it('an answer that lands at or after T-30 is dropped, like a window that closed', async () => {
    const schedule = morningSchedule();
    const slow = gated('api.aladhan.com', () => payload({ Asr: '16:16' }));
    jest.setSystemTime(at(31));
    const { h } = await load({ schedule, fetchRoutes: [slow.route] });
    const run = h.fireAlarm(ALARM_TICK);
    await flush();
    jest.setSystemTime(at(30)); // the answer arrives exactly at T-30
    slow.release();
    await run;
    await flush();
    expect(h.store.schedule).toEqual(schedule);
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts);
    expect(h.alarms.has(ALARM_REVALIDATE_RETRY)).toBe(false);
  });

  // ---- the popup never hangs on a re-fetch ----
  it('passes a timeout signal on the re-fetch', async () => {
    const { h, fetch } = await load();
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(fetch.inits.at(-1).signal).toBeInstanceOf(AbortSignal);
  });

  it('opening the popup answers from storage when a re-fetch is slow, then applies it', async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'hrtime', 'performance'] });
    const schedule = morningSchedule();
    const slow = gated('api.aladhan.com', () => payload({ Asr: '16:16' }));
    const { h } = await load({ schedule, fetchRoutes: [slow.route] });

    let state;
    h.sendRuntimeMessage({ type: 'GET_STATE' }).then((s) => (state = s));
    await flush();
    expect(state).toBeUndefined(); // still waiting, briefly
    await jest.advanceTimersByTimeAsync(2500);
    await flush();
    expect(state.schedule).toEqual(schedule); // answered with the stored times

    slow.release();
    await flush();
    expect(h.store.schedule.prayers[2].time).toBe('04:16 PM');
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(schedule.prayers[2].ts - MIN); // re-armed in the background
  });

  // ---- answer validation ----
  it.each([
    ['an unreadable prayer time', () => payload({ Fajr: '--:--' })],
    ['a missing prayer time', () => payload({ Isha: undefined })],
    ['a 12-hour time', () => payload({ Asr: '4:16 PM' })],
    ['an out-of-range hour', () => payload({ Isha: '24:10' })],
    ['an out-of-range minute', () => payload({ Dhuhr: '12:60' })],
    ['text after the zone label', () => payload({ Asr: '16:16 (PDT) approx' })],
    ['a number instead of a string', () => payload({ Maghrib: 1845 })],
    ['an unreadable Sunrise', () => payload({ Sunrise: 'soon' })],
    ['an iso8601 time without its offset', () => payload({ Asr: '2026-10-03T16:16:00' })],
    ['an iso8601 time with an out-of-range hour', () => payload({ Isha: '2026-10-03T24:10:00-07:00' })],
    ['an iso8601 time with an out-of-range offset', () => payload({ Asr: '2026-10-03T16:16:00-15:00' })],
    ['iso8601 and plain times mixed', () => ({ ...payload({ Asr: '2026-10-03T16:16:00-07:00' }), __plain: true })],
    ['another timezone', () => payload({}, { meta: { timezone: 'America/Phoenix' } })],
    ['another day', () => aladhanPayload({ timings: TIMINGS, data: { date: { gregorian: { date: '04-10-2026' } } } })],
    ['no day at all', () => aladhanPayload({ timings: TIMINGS })],
  ])('refuses %s', async (_label, answer) => {
    const schedule = morningSchedule();
    const { h } = await load({ schedule, fetchRoutes: [['api.aladhan.com', answer]] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(h.store.schedule).toEqual(schedule);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('revalidation failed'), expect.any(Error));
  });

  it('accepts times carrying a zone label, like "05:40 (PDT)"', async () => {
    const schedule = morningSchedule();
    const labelled = Object.fromEntries(Object.entries(TIMINGS).map(([k, v]) => [k, `${v} (PDT)`]));
    const { h } = await load({ schedule, fetchRoutes: [['api.aladhan.com', () => payload(labelled)]] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(h.store.schedule).toEqual({ ...schedule, fetchedAt: NOW });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('accepts an answer without Sunrise (it is optional)', async () => {
    const schedule = morningSchedule();
    const { h } = await load({ schedule, fetchRoutes: [['api.aladhan.com', () => payload({ Sunrise: undefined, Asr: '16:16' })]] });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(h.store.schedule.prayers[2].time).toBe('04:16 PM');
    expect(h.store.schedule.sunrise).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('the daily fetch refuses an unreadable time instead of storing ts:null', async () => {
    const schedule = morningSchedule();
    const { h } = await load({ schedule, fetchRoutes: [['api.aladhan.com', () => payload({ Fajr: '--:--' })]] });
    const res = await h.sendRuntimeMessage({ type: 'REFRESH' });
    expect(res.ok).toBe(false);
    expect(h.store.schedule).toEqual(schedule);
  });
});

describe('a day-start fetch that keeps failing', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fires Fajr once, not again and again, on the previous day\'s schedule', async () => {
    // Yesterday's (2026-10-02) schedule is all there is: every Aladhan request fails.
    const TZ = 'America/Los_Angeles';
    const yesterday = new Date(Date.parse('2026-10-02T19:00:00Z'));
    const five = { Fajr: '05:40 AM', Dhuhr: '12:50 PM', Asr: '04:17 PM', Maghrib: '06:45 PM', Isha: '07:58 PM' };
    const schedule = { date: '2026-10-02', prayers: buildPrayers(five, yesterday, TZ), sunrise: null, tz: TZ, fetchedAt: yesterday.getTime() };
    // Isha's fire rolled nextPrayer over to "today's" Fajr: yesterday's Fajr + 1 day.
    const fajr = schedule.prayers[0].ts + DAY_MS;
    jest.useFakeTimers({
      now: fajr,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'],
    });
    const { h } = await loadBackground({
      storage: { settings: DEFAULTS, schedule, paused: { active: false }, nextPrayer: { name: 'Fajr', time: '05:40 AM', ts: fajr }, lang: 'en' },
      fetchRoutes: [['api.aladhan.com', { status: 503 }]],
    });

    await h.fireAlarm(ALARM_PRAYER);
    await flush();
    // Drive the worker the way Chrome would: the periodic tick retries the day-start
    // fetch (and fails), and a prayer alarm armed for "now" fires ~30 s later
    // (Chrome's minimum alarm delay).
    for (let i = 0; i < 5; i++) {
      await h.fireAlarm(ALARM_TICK);
      await flush();
      const armed = h.alarms.get(ALARM_PRAYER);
      if (!armed || armed.when > Date.now() + 60e3) break;
      jest.setSystemTime(Math.max(Date.now() + 30e3, armed.when));
      await h.fireAlarm(ALARM_PRAYER);
      await flush();
    }

    expect(h.notifications).toHaveLength(1);
    expect(h.store.usage.totals.pauses).toBe(1);
    // The rest of today stays scheduled, at yesterday's times (a minute or two off
    // at most): Dhuhr is next, not tomorrow's Fajr.
    const today = (i) => schedule.prayers[i].ts + DAY_MS;
    expect(h.store.nextPrayer).toEqual({ name: 'Dhuhr', time: '12:50 PM', ts: today(1) });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(today(1));

    // Each of today's prayers fires once, on time, while the fetch keeps failing.
    for (const i of [1, 2, 3, 4]) {
      jest.setSystemTime(today(i));
      await h.fireAlarm(ALARM_PRAYER);
      await flush();
      await h.fireAlarm(ALARM_TICK);
      await flush();
    }
    expect(h.notifications.map((n) => n.id)).toEqual([0, 1, 2, 3, 4].map((i) => `adhan-${today(i)}`));
    expect(h.store.nextPrayer).toEqual({ name: 'Fajr', time: '05:40 AM', ts: fajr + DAY_MS });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(fajr + DAY_MS);
  });
});

describe('day-start fetch date: the location\'s, not this machine\'s', () => {
  // At NOW (04:05 UTC on Oct 4) this machine's date is Oct 3 or Oct 4, depending on
  // its timezone (UTC-12 to UTC+14). The chosen city, LOC, is one whose date then
  // differs from it — New York (00:05 Oct 4) on a machine still on Oct 3, Los
  // Angeles (21:05 Oct 3) on one already on Oct 4 — so these prove the location's
  // date is asked for on any host. OTHER, the other city, shares this machine's date.
  const NOW = Date.parse('2026-10-04T04:05:00Z');
  const MACHINE_DAY = ymd(new Date(NOW));
  const LOC = MACHINE_DAY === '2026-10-04' ? 'America/Los_Angeles' : 'America/New_York';
  const OTHER = LOC === 'America/New_York' ? 'America/Los_Angeles' : 'America/New_York';
  const LOC_DAY = ymdInTz(LOC, new Date(NOW));
  const CITY = { 'America/New_York': { city: 'New York', state: 'New York' }, 'America/Los_Angeles': { city: 'Los Angeles', state: 'California' } };
  const LOC_SETTINGS = { ...DEFAULTS, ...CITY[LOC] };
  const FIVE = { Fajr: '05:40 AM', Dhuhr: '12:50 PM', Asr: '04:17 PM', Maghrib: '06:45 PM', Isha: '07:58 PM' };
  const aladhanDay = (day) => day.split('-').reverse().join('-'); // 'YYYY-MM-DD' -> 'DD-MM-YYYY'
  const dayBefore = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  const noonOf = (day, zone) => new Date(zonedToEpoch(...day.split('-').map(Number), 12, 0, zone));
  const aladhanCalls = (fetch) => fetch.calls.filter((u) => u.includes('api.aladhan.com'));
  const answerIn = (zone, day) => ['api.aladhan.com', (url) => aladhanPayload({ meta: { timezone: zone }, data: day ? { date: { gregorian: { date: day } } } : requestedDay(url) })];
  const scheduleFor = (zone, date) => ({ date, prayers: buildPrayers(FIVE, noonOf(date, zone), zone), sunrise: null, tz: zone, fetchedAt: NOW - 12 * 3600e3 });
  // Fajr 04:27 (aladhanPayload's) on `day` in `zone`.
  const fajrOn = (day, zone) => zonedToEpoch(...day.split('-').map(Number), 4, 27, zone);

  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('the rollover asks for the location\'s today and stores it under that date', async () => {
    expect(LOC_DAY).not.toBe(MACHINE_DAY);
    const yesterday = scheduleFor(LOC, dayBefore(LOC_DAY));
    const { h, fetch } = await loadBackground({ storage: { settings: LOC_SETTINGS, schedule: yesterday }, fetchRoutes: [answerIn(LOC)] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(aladhanCalls(fetch)[0]).toContain(`/timingsByCity/${aladhanDay(LOC_DAY)}?city=${encodeURIComponent(CITY[LOC].city)}`);
    expect(h.store.schedule.date).toBe(LOC_DAY);
    expect(h.store.schedule.tz).toBe(LOC);
    expect(h.store.schedule.prayers[0].ts).toBe(fajrOn(LOC_DAY, LOC));
  });

  it('Refresh asks for the location\'s today too', async () => {
    const today = scheduleFor(LOC, LOC_DAY);
    const { h, fetch } = await loadBackground({ storage: { settings: LOC_SETTINGS, schedule: today }, fetchRoutes: [answerIn(LOC)] });
    expect(await h.sendRuntimeMessage({ type: 'REFRESH' })).toEqual({ ok: true });
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(aladhanCalls(fetch)[0]).toContain(`/timingsByCity/${aladhanDay(LOC_DAY)}?`);
  });

  it('a calculation change asks for the location\'s today too', async () => {
    const today = scheduleFor(LOC, LOC_DAY);
    const { h, fetch } = await loadBackground({ storage: { settings: LOC_SETTINGS, schedule: today }, fetchRoutes: [answerIn(LOC)] });
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { method: 3 } })).toEqual({ ok: true });
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(aladhanCalls(fetch)[0]).toContain(`/timingsByCity/${aladhanDay(LOC_DAY)}?`);
    expect(aladhanCalls(fetch)[0]).toContain('method=3');
    expect(h.store.schedule.date).toBe(LOC_DAY);
  });

  it('an extension update asks for the location\'s today too', async () => {
    const today = scheduleFor(LOC, LOC_DAY);
    const { h, fetch } = await loadBackground({
      storage: { settings: LOC_SETTINGS, schedule: today, paused: { active: false }, installedAt: 1, onboardingCompleted: true },
      fetchRoutes: [answerIn(LOC)],
    });
    await h.fireInstalled({ reason: 'update', previousVersion: '2.1.0' });
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(aladhanCalls(fetch)[0]).toContain(`/timingsByCity/${aladhanDay(LOC_DAY)}?`);
    expect(h.store.schedule.date).toBe(LOC_DAY);
  });

  it('the rollover refuses an answer for another date', async () => {
    const yesterday = scheduleFor(LOC, dayBefore(LOC_DAY));
    const { h } = await loadBackground({ storage: { settings: LOC_SETTINGS, schedule: yesterday }, fetchRoutes: [answerIn(LOC, aladhanDay(MACHINE_DAY))] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(h.store.schedule).toEqual(yesterday);
    expect(warnSpy).toHaveBeenCalledWith('Adhan: tick failed', expect.any(Error));
  });

  it('a new city asks for this machine\'s date, then for the city\'s own today, and takes its timezone', async () => {
    const other = scheduleFor(OTHER, MACHINE_DAY);
    const { h, fetch } = await loadBackground({ storage: { settings: { ...DEFAULTS, ...CITY[OTHER] }, schedule: other }, fetchRoutes: [answerIn(LOC)] });
    const res = await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: CITY[LOC] });
    expect(res).toEqual({ ok: true });
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(aladhanCalls(fetch)[0]).toContain(`/timingsByCity/${aladhanDay(MACHINE_DAY)}?city=${encodeURIComponent(CITY[LOC].city)}`);
    expect(aladhanCalls(fetch)[1]).toContain(`/timingsByCity/${aladhanDay(LOC_DAY)}?city=${encodeURIComponent(CITY[LOC].city)}`);
    expect(h.store.schedule).toMatchObject({ tz: LOC, date: LOC_DAY });
    expect(h.store.schedule.prayers[0].ts).toBe(fajrOn(LOC_DAY, LOC)); // that day's own times
  });

  // The save to LOC failed, so the stored schedule is still OTHER's: the rollover
  // asks for OTHER's today, which is not LOC's.
  it('a rollover on a schedule left from an earlier city asks again for the new city\'s today', async () => {
    const other = scheduleFor(OTHER, dayBefore(MACHINE_DAY));
    const { h, fetch } = await loadBackground({ storage: { settings: LOC_SETTINGS, schedule: other }, fetchRoutes: [answerIn(LOC)] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(aladhanCalls(fetch)[0]).toContain(`/timingsByCity/${aladhanDay(MACHINE_DAY)}?`); // OTHER's today
    expect(aladhanCalls(fetch)[1]).toContain(`/timingsByCity/${aladhanDay(LOC_DAY)}?`); // LOC's today
    expect(h.store.schedule.tz).toBe(LOC);
    expect(h.store.schedule.date).toBe(LOC_DAY);
    expect(h.store.schedule.prayers[0].ts).toBe(fajrOn(LOC_DAY, LOC)); // that day's times, on that day
    // Settled: the next tick does not fetch again.
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
  });

  it('...and takes the new city\'s answer at once when its today is the date asked for', async () => {
    jest.setSystemTime(Date.parse('2026-10-04T18:00:00Z')); // Oct 4 in both cities
    const other = scheduleFor(OTHER, '2026-10-03');
    const { h, fetch } = await loadBackground({ storage: { settings: LOC_SETTINGS, schedule: other }, fetchRoutes: [answerIn(LOC)] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(aladhanCalls(fetch)[0]).toContain('/timingsByCity/04-10-2026?');
    expect(h.store.schedule).toMatchObject({ tz: LOC, date: '2026-10-04' });
    expect(h.store.schedule.prayers[0].ts).toBe(fajrOn('2026-10-04', LOC));
  });

  it('an answer that lands after midnight is stored as the day it was asked for', async () => {
    const day = dayBefore(LOC_DAY);
    const midnight = zonedToEpoch(...LOC_DAY.split('-').map(Number), 0, 0, LOC);
    jest.setSystemTime(midnight - 1000); // 23:59:59 on `day` there
    let release;
    const gate = new Promise((r) => (release = r));
    let n = 0;
    const route = ['api.aladhan.com', async (url) => (n++ === 0 && (await gate), aladhanPayload({ meta: { timezone: LOC }, data: requestedDay(url) }))];
    const { h, fetch } = await loadBackground({ storage: { settings: LOC_SETTINGS, schedule: scheduleFor(LOC, day) }, fetchRoutes: [route] });
    const refreshed = h.sendRuntimeMessage({ type: 'REFRESH' });
    await flush();
    jest.setSystemTime(midnight + 1000);
    release();
    expect(await refreshed).toEqual({ ok: true });
    expect(aladhanCalls(fetch)[0]).toContain(`/timingsByCity/${aladhanDay(day)}?`);
    expect(h.store.schedule.date).toBe(day);
    expect(h.store.schedule.prayers[0].ts).toBe(fajrOn(day, LOC)); // not that day's times on the new day
    // So the next tick takes the new day's fetch.
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(aladhanCalls(fetch)[1]).toContain(`/timingsByCity/${aladhanDay(LOC_DAY)}?`);
    expect(h.store.schedule.date).toBe(LOC_DAY);
  });

  it('refuses the second answer when it is in yet another timezone', async () => {
    const other = scheduleFor(OTHER, dayBefore(MACHINE_DAY));
    let n = 0;
    const route = ['api.aladhan.com', (url) => aladhanPayload({ meta: { timezone: n++ === 0 ? LOC : 'Asia/Tokyo' }, data: requestedDay(url) })];
    const { h, fetch } = await loadBackground({ storage: { settings: LOC_SETTINGS, schedule: other }, fetchRoutes: [route] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(h.store.schedule).toEqual(other);
    expect(warnSpy).toHaveBeenCalledWith('Adhan: tick failed', expect.any(Error));
  });
});

describe("prayer instants come from Aladhan's UTC offsets, not this browser's tz data", () => {
  // Morocco moved to permanent +00 on 2026-09-20 (IANA tzdata 2026c); a browser
  // shipping older data still reads Africa/Casablanca as +01, and every prayer was
  // armed an hour early. British Columbia (2026b) and Alberta (2026c) stopped
  // falling back on 2026-11-01: an hour late there. simulateStaleTzData makes Intl
  // answer like such a browser on any CI runner.
  const NOW = Date.parse('2026-10-10T10:58:00Z'); // the report: 10:58, Saturday 10/10/2026
  const utc = (hm, day = '2026-10-10') => Date.parse(`${day}T${hm}:00Z`);
  // Aladhan's live answer for Casablanca on 2026-10-10 (iso8601=true: all +00:00).
  const CASA = { Fajr: '05:23', Sunrise: '06:31', Dhuhr: '12:17', Asr: '15:35', Sunset: '18:03', Maghrib: '18:03', Isha: '19:11' };
  const CASA_SETTINGS = { ...DEFAULTS, city: 'Casablanca', state: 'Casablanca-Settat', country: 'Morocco', method: 21 };
  const answer = (timings, timezone, isoOffset) => [
    'api.aladhan.com',
    (url) => aladhanPayload({ timings, meta: { timezone }, data: requestedDay(url), isoOffset }),
  ];
  const casaAnswer = answer(CASA, 'Africa/Casablanca', '+00:00');
  const aladhanCalls = (fetch) => fetch.calls.filter((u) => u.includes('api.aladhan.com'));
  // The schedule stored from that answer.
  const casaSchedule = (day = '2026-10-10') => ({
    date: day,
    prayers: PRAYER_ORDER.map((name) => ({ name, time: hhmmTo12h(CASA[name]), ts: utc(CASA[name], day), offsetMin: 0 })),
    sunrise: { time: hhmmTo12h(CASA.Sunrise), ts: utc(CASA.Sunrise, day), offsetMin: 0 },
    tz: 'Africa/Casablanca',
    fetchedAt: NOW,
  });

  // Intl stays real under the fake clock: faking it would swap in a copy of the
  // native Intl taken before the stub, and the runner's own tz data would answer.
  const DO_NOT_FAKE = ['Intl', 'nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'];
  let restore;
  beforeEach(() => {
    restore = simulateStaleTzData();
    jest.useFakeTimers({ now: NOW, doNotFake: DO_NOT_FAKE });
    expect(tzOffsetMs(new Date(NOW), 'Africa/Casablanca')).toBe(3600e3); // the out-of-date reading is in force
  });
  afterEach(() => {
    jest.useRealTimers();
    restore();
  });
  // A failing Aladhan until `up()`.
  function flaky(route) {
    let ok = false;
    return { route: [route[0], (url) => (ok ? route[1](url) : { status: 503 })], up: () => (ok = true) };
  }

  it('Casablanca: each prayer is armed at its +00 time', async () => {
    const { h, fetch } = await loadBackground({ storage: { settings: DEFAULTS }, fetchRoutes: [casaAnswer] });
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: CASA_SETTINGS })).toEqual({ ok: true });
    expect(aladhanCalls(fetch)[0]).toContain('city=Casablanca');
    expect(aladhanCalls(fetch)[0]).toMatch(/&iso8601=true$/);
    expect(h.store.schedule).toEqual(casaSchedule());
    // Dhuhr at 12:17 — not 11:17, where this browser's +01 would put it.
    expect(h.store.nextPrayer).toEqual({ name: 'Dhuhr', time: '12:17 PM', ts: utc('12:17') });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc('12:17'));
  });

  it("the day rolls over at Casablanca's midnight, not an hour before it", async () => {
    jest.setSystemTime(Date.parse('2026-10-10T23:30:00Z')); // this browser alone reads 00:30 on the 11th
    const { h, fetch } = await loadBackground({ storage: { settings: CASA_SETTINGS, schedule: casaSchedule() }, fetchRoutes: [casaAnswer] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(0);
    expect(h.store.schedule.date).toBe('2026-10-10');
    jest.setSystemTime(Date.parse('2026-10-11T00:05:00Z'));
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(1);
    expect(aladhanCalls(fetch)[0]).toContain('/timingsByCity/11-10-2026?');
    expect(h.store.schedule).toMatchObject({ date: '2026-10-11', tz: 'Africa/Casablanca' });
    expect(h.store.schedule.prayers[0].ts).toBe(utc('05:23', '2026-10-11'));
    // The 10th's Isha stays with it: Aladhan's offset for the night before Fajr.
    expect(h.store.schedule.dayBefore).toEqual({ ts: utc('19:11'), offsetMin: 0 });
  });

  it('a pre-prayer re-check that moves a time keeps the day before\'s offset', async () => {
    jest.setSystemTime(utc('14:52')); // Asr (15:35) - 43 min
    const schedule = { ...casaSchedule(), fetchedAt: utc('06:00'), dayBefore: { ts: utc('19:11', '2026-10-09'), offsetMin: 0 } };
    const { h } = await loadBackground({
      storage: { settings: CASA_SETTINGS, schedule, nextPrayer: { name: 'Asr', time: '03:35 PM', ts: utc('15:35') }, paused: { active: false } },
      fetchRoutes: [answer({ ...CASA, Asr: '15:36' }, 'Africa/Casablanca', '+00:00')],
    });
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(h.store.schedule.prayers[2]).toEqual({ name: 'Asr', time: '03:36 PM', ts: utc('15:36'), offsetMin: 0 });
    expect(h.store.schedule.dayBefore).toEqual(schedule.dayBefore);
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc('15:36'));
  });

  it("Refresh at 23:30 asks for Casablanca's today, the 10th", async () => {
    jest.setSystemTime(Date.parse('2026-10-10T23:30:00Z'));
    const { h, fetch } = await loadBackground({ storage: { settings: CASA_SETTINGS, schedule: casaSchedule() }, fetchRoutes: [casaAnswer] });
    expect(await h.sendRuntimeMessage({ type: 'REFRESH' })).toEqual({ ok: true });
    expect(aladhanCalls(fetch)).toEqual([expect.stringContaining('/timingsByCity/10-10-2026?')]);
    expect(h.store.schedule.date).toBe('2026-10-10');
  });

  it('an update replaces the schedule an older version stored an hour early', async () => {
    // What 2.1.1 stored under this browser's +01: every ts an hour early, no offsets.
    const early = {
      ...casaSchedule(),
      prayers: casaSchedule().prayers.map(({ offsetMin, ...p }) => ({ ...p, ts: p.ts - 3600e3 })),
      sunrise: { time: '06:31 AM', ts: utc('06:31') - 3600e3 },
      fetchedAt: NOW - 3600e3,
    };
    const { h, fetch } = await loadBackground({
      storage: { settings: CASA_SETTINGS, schedule: early, nextPrayer: { name: 'Dhuhr', time: '12:17 PM', ts: utc('11:17') }, paused: { active: false }, installedAt: 1, onboardingCompleted: true },
      fetchRoutes: [casaAnswer],
    });
    await h.fireInstalled({ reason: 'update', previousVersion: '2.1.1' });
    await flush();
    expect(aladhanCalls(fetch)).toEqual([expect.stringContaining('/timingsByCity/10-10-2026?')]);
    expect(h.store.schedule.prayers.find((p) => p.name === 'Dhuhr')).toEqual({ name: 'Dhuhr', time: '12:17 PM', ts: utc('12:17'), offsetMin: 0 });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc('12:17'));
  });

  it('...and when the update cannot reach Aladhan, the next tick fetches the day again', async () => {
    const early = { ...casaSchedule(), prayers: casaSchedule().prayers.map(({ offsetMin, ...p }) => ({ ...p, ts: p.ts - 3600e3 })), sunrise: null };
    const aladhan = flaky(casaAnswer);
    const { h, fetch } = await loadBackground({
      storage: { settings: CASA_SETTINGS, schedule: early, paused: { active: false }, installedAt: 1, onboardingCompleted: true },
      fetchRoutes: [aladhan.route],
    });
    await h.fireInstalled({ reason: 'update', previousVersion: '2.1.1' });
    await flush();
    expect(h.store.schedule).toEqual(early);
    expect(h.store.scheduleRefetch).toBe(true);
    aladhan.up();
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
    expect(h.store.schedule).toEqual({ ...casaSchedule(), fetchedAt: NOW });
    expect(h.store.scheduleRefetch).toBe(false);
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc('12:17'));
    // Settled: the next tick does not fetch again.
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(2);
  });

  it('a new city whose fetch failed is fetched on the next tick, not the next day', async () => {
    let down = false;
    const route = [
      'api.aladhan.com',
      (url) => (down ? { status: 503 } : url.includes('city=Casablanca') ? casaAnswer[1](url) : aladhanPayload({ data: requestedDay(url) })),
    ];
    const { h } = await loadBackground({ storage: { settings: DEFAULTS }, fetchRoutes: [route] });
    await h.fireInstalled({ reason: 'install' });
    await flush();
    expect(h.store.schedule.tz).toBe('America/Los_Angeles');
    // Onboarding picks Casablanca while Aladhan is down…
    down = true;
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: CASA_SETTINGS })).toMatchObject({ ok: false });
    expect(h.store.settings).toMatchObject({ city: 'Casablanca' });
    expect(h.store.schedule.tz).toBe('America/Los_Angeles');
    // …and it is back for the next tick.
    down = false;
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(h.store.schedule).toMatchObject({ tz: 'Africa/Casablanca', date: '2026-10-10' });
    expect(h.store.nextPrayer).toMatchObject({ name: 'Dhuhr', ts: utc('12:17') });
    expect(h.store.scheduleRefetch).toBe(false);
  });

  it.each([
    ['Vancouver', 'America/Vancouver', '-07:00', 'British Columbia', { Fajr: '06:32', Sunrise: '08:02', Dhuhr: '12:56', Asr: '15:25', Maghrib: '17:49', Isha: '19:19' }, '19:56'],
    ['Edmonton', 'America/Edmonton', '-06:00', 'Alberta', { Fajr: '06:56', Sunrise: '08:36', Dhuhr: '13:18', Asr: '15:33', Maghrib: '17:59', Isha: '19:38' }, '19:18'],
  ])('%s keeps its permanent offset after 2026-11-01', async (city, zone, isoOffset, state, timings, dhuhrUtc) => {
    jest.setSystemTime(Date.parse('2026-11-02T18:00:00Z')); // late morning there
    const { h } = await loadBackground({ storage: { settings: DEFAULTS }, fetchRoutes: [answer(timings, zone, isoOffset)] });
    const settings = { city, state, country: 'Canada' };
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings })).toEqual({ ok: true });
    expect(h.store.schedule).toMatchObject({ date: '2026-11-02', tz: zone });
    // An hour earlier than this browser's falling-back rules would arm it.
    expect(h.store.nextPrayer).toMatchObject({ name: 'Dhuhr', ts: utc(dhuhrUtc, '2026-11-02') });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc(dhuhrUtc, '2026-11-02'));
  });

  // Kathmandu (+05:45): its time reads differently from this machine's on any CI runner.
  const ktm = () => ({
    ...casaSchedule(),
    tz: 'Asia/Kathmandu',
    prayers: casaSchedule().prayers.map((p) => ({ ...p, ts: epochAtOffset('2026-10-10', p.time.slice(0, 5), 345), offsetMin: 345 })),
    sunrise: null,
  });

  it("a dev test fire is labelled with the location's time", async () => {
    const { h } = await loadBackground({ storage: { settings: DEFAULTS, schedule: ktm() } });
    expect(await h.sendRuntimeMessage({ type: 'TEST_ADHAN', seconds: 30 })).toEqual({ ok: true });
    expect(h.store.nextPrayer).toMatchObject({ time: '04:43 PM', ts: NOW + 30e3, test: true }); // 10:58:30Z + 5:45
  });

  it("the onboarding pause demo is labelled with the location's time", async () => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['Intl', 'nextTick', 'setImmediate', 'clearImmediate', 'queueMicrotask'] });
    const { h } = await loadBackground({ storage: { settings: { ...DEFAULTS, adhanChime: false }, schedule: ktm() } });
    expect(await h.sendRuntimeMessage({ type: 'TEST_PAUSE_DEMO', prayer: 'Asr', seconds: 5 })).toEqual({ ok: true });
    const shown = h.broadcasts.map((b) => b.message).filter((m) => m.type === 'PRAYER_NOW');
    expect(shown.map((m) => m.time)).toEqual(['04:43 PM', '04:43 PM']); // 10:58Z + 5:45, to both tabs
    jest.clearAllTimers();
  });

  it('an answer without offsets is still read in the zone through Intl, as before', async () => {
    const plain = ['api.aladhan.com', (url) => aladhanPayload({ timings: CASA, meta: { timezone: 'Africa/Casablanca' }, data: requestedDay(url), plain: true })];
    const { h } = await loadBackground({ storage: { settings: DEFAULTS }, fetchRoutes: [plain] });
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: CASA_SETTINGS })).toEqual({ ok: true });
    const dhuhr = h.store.schedule.prayers.find((p) => p.name === 'Dhuhr');
    expect(dhuhr).toEqual({ name: 'Dhuhr', time: '12:17 PM', ts: zonedToEpoch(2026, 10, 10, 12, 17, 'Africa/Casablanca') });
    expect(dhuhr.offsetMin).toBeUndefined();
  });
});

describe('per-prayer minute adjustments (±3, Settings)', () => {
  // Aladhan's answer for Casablanca on 2026-10-10 (+00:00), at 06:00Z.
  const NOW = Date.parse('2026-10-10T06:00:00Z');
  const utc = (hm) => Date.parse(`2026-10-10T${hm}:00Z`);
  const CASA = { Fajr: '05:23', Sunrise: '06:31', Dhuhr: '12:17', Asr: '15:35', Sunset: '18:03', Maghrib: '18:03', Isha: '19:11' };
  const CASA_SETTINGS = { ...DEFAULTS, city: 'Casablanca', state: 'Casablanca-Settat', country: 'Morocco', method: 21 };
  const ADJUSTED = { ...CASA_SETTINGS, adjustMinutes: { Fajr: 0, Dhuhr: 2, Asr: 0, Maghrib: -1, Isha: 3 } };
  const casa = (opts = {}) => ['api.aladhan.com', (url) => aladhanPayload({ timings: CASA, meta: { timezone: 'Africa/Casablanca' }, data: requestedDay(url), isoOffset: '+00:00', ...opts })];
  const aladhanCalls = (fetch) => fetch.calls.filter((u) => u.includes('api.aladhan.com'));
  const timeOf = (h, name) => h.store.schedule.prayers.find((p) => p.name === name);

  beforeEach(() => {
    jest.useFakeTimers({
      now: NOW,
      doNotFake: ['Intl', 'nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'hrtime', 'performance'],
    });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each([
    ['an answer with offsets', {}],
    // (read through Intl: a zone whose rules never changed, unlike Casablanca's)
    ['an answer without offsets', { plain: true, meta: { timezone: 'Africa/Abidjan' } }],
  ])('moves each prayer\'s time and instant alike (%s); Sunrise and the rest stay', async (_label, opts) => {
    const { h } = await loadBackground({ storage: { settings: ADJUSTED }, fetchRoutes: [casa(opts)] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(timeOf(h, 'Dhuhr')).toMatchObject({ time: '12:19 PM', ts: utc('12:19'), adjustMin: 2 });
    expect(timeOf(h, 'Maghrib')).toMatchObject({ time: '06:02 PM', ts: utc('18:02'), adjustMin: -1 });
    expect(timeOf(h, 'Isha')).toMatchObject({ time: '07:14 PM', ts: utc('19:14'), adjustMin: 3 });
    expect(timeOf(h, 'Asr')).toMatchObject({ time: '03:35 PM', ts: utc('15:35') });
    expect(timeOf(h, 'Asr').adjustMin).toBeUndefined();
    expect(h.store.schedule.sunrise).toMatchObject({ time: '06:31 AM', ts: utc('06:31') });
    // The Adhan itself fires at the adjusted moment.
    expect(h.store.nextPrayer).toEqual({ name: 'Dhuhr', time: '12:19 PM', ts: utc('12:19') });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc('12:19'));
  });

  it('saving new adjustments re-reads the day with them, kept within ±3', async () => {
    const { h, fetch } = await loadBackground({ storage: { settings: CASA_SETTINGS }, fetchRoutes: [casa()] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    // (two requests when this machine's date is not Casablanca's: see fetchSchedule)
    const fetched = aladhanCalls(fetch).length;
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { adjustMinutes: { Dhuhr: 9, Isha: '-2', Fajr: 'x' } } })).toEqual({ ok: true });
    expect(h.store.settings.adjustMinutes).toEqual({ Fajr: 0, Dhuhr: 3, Asr: 0, Maghrib: 0, Isha: -2 });
    expect(aladhanCalls(fetch)).toHaveLength(fetched + 1);
    expect(aladhanCalls(fetch).at(-1)).toContain('/timingsByCity/10-10-2026?');
    expect(timeOf(h, 'Dhuhr')).toMatchObject({ time: '12:20 PM', ts: utc('12:20'), adjustMin: 3 });
    expect(timeOf(h, 'Isha')).toMatchObject({ time: '07:09 PM', ts: utc('19:09'), adjustMin: -2 });
    // The same adjustments again: nothing to re-read.
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { adjustMinutes: { Dhuhr: 3, Isha: -2 } } })).toEqual({ ok: true });
    expect(aladhanCalls(fetch)).toHaveLength(fetched + 1);
  });

  it('a pre-prayer re-check applies them the same way, so an unchanged answer is unchanged', async () => {
    const { h, fetch } = await loadBackground({ storage: { settings: ADJUSTED }, fetchRoutes: [casa()] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    const morning = h.store.schedule;
    const fetched = aladhanCalls(fetch).length;
    jest.setSystemTime(utc('18:02') - 43 * 60e3); // adjusted Maghrib - 43 min
    await h.fireAlarm(ALARM_REVALIDATE);
    await flush();
    expect(aladhanCalls(fetch)).toHaveLength(fetched + 1);
    expect(h.store.schedule).toEqual({ ...morning, fetchedAt: utc('18:02') - 43 * 60e3 });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc('18:02'));
  });

  it('never moves a prayer across the day\'s midnight, where the next day takes over', async () => {
    const late = ['api.aladhan.com', (url) => aladhanPayload({ timings: { ...CASA, Fajr: '00:01', Isha: '23:58' }, meta: { timezone: 'Africa/Casablanca' }, data: requestedDay(url), isoOffset: '+00:00' })];
    const { h } = await loadBackground({ storage: { settings: { ...CASA_SETTINGS, adjustMinutes: { Fajr: -3, Isha: 3 } } }, fetchRoutes: [late] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(timeOf(h, 'Isha')).toMatchObject({ time: '11:59 PM', ts: utc('23:59'), adjustMin: 1 });
    expect(timeOf(h, 'Fajr')).toMatchObject({ time: '12:00 AM', ts: utc('00:00'), adjustMin: -1 });
  });

  it('saved just after a prayer, a later time does not bring it again today', async () => {
    const { h } = await loadBackground({ storage: { settings: CASA_SETTINGS }, fetchRoutes: [casa()] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    jest.setSystemTime(utc('12:18')); // Dhuhr (12:17) has just come
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { adjustMinutes: { Dhuhr: 3 } } })).toEqual({ ok: true });
    expect(timeOf(h, 'Dhuhr')).toEqual({ name: 'Dhuhr', time: '12:17 PM', ts: utc('12:17'), offsetMin: 0 }); // today's, kept
    expect(h.store.nextPrayer).toMatchObject({ name: 'Asr', ts: utc('15:35') });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc('15:35'));
  });

  it('saved just before a prayer, an earlier time does not skip it today', async () => {
    const { h } = await loadBackground({ storage: { settings: CASA_SETTINGS }, fetchRoutes: [casa()] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    jest.setSystemTime(utc('12:16')); // Dhuhr (12:17) is a minute away; -3 would put it at 12:14
    expect(await h.sendRuntimeMessage({ type: 'SAVE_SETTINGS', settings: { adjustMinutes: { Dhuhr: -3 } } })).toEqual({ ok: true });
    expect(h.store.nextPrayer).toMatchObject({ name: 'Dhuhr', ts: utc('12:17') });
    expect(h.alarms.get(ALARM_PRAYER).when).toBe(utc('12:17'));
  });

  it("applies them to the location's own day when this machine's date is another (Kiritimati, +14)", async () => {
    jest.setSystemTime(Date.parse('2026-10-10T12:00:00Z')); // 02:00 on the 11th there
    const kiri = ['api.aladhan.com', (url) => aladhanPayload({ timings: CASA, meta: { timezone: 'Pacific/Kiritimati' }, data: requestedDay(url), isoOffset: '+14:00' })];
    const { h } = await loadBackground({ storage: { settings: { ...ADJUSTED, city: 'Kiritimati', state: '', country: 'Kiribati' } }, fetchRoutes: [kiri] });
    await h.fireAlarm(ALARM_TICK);
    await flush();
    expect(h.store.schedule.date).toBe('2026-10-11');
    expect(timeOf(h, 'Dhuhr')).toMatchObject({ time: '12:19 PM', ts: Date.parse('2026-10-10T22:19:00Z'), adjustMin: 2 });
  });

  it('an answer fetched with the old adjustments is not stored once they change', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = ['api.aladhan.com', async (url) => (await gate, casa()[1](url))];
    const { h, chrome } = await loadBackground({ storage: { settings: CASA_SETTINGS }, fetchRoutes: [slow] });
    const refreshed = h.sendRuntimeMessage({ type: 'REFRESH' });
    await flush();
    await chrome.storage.local.set({ settings: ADJUSTED });
    release();
    await refreshed;
    await flush();
    expect(h.store.schedule).toBeUndefined();
  });
});
