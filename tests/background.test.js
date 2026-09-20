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
import { ymd, ymdInTz, computeNext } from '../lib/schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const ALARM_PRAYER = 'adhan-prayer-fire';
const ALARM_RESUME = 'adhan-auto-resume';
const ALARM_TICK = 'adhan-tick';
const ALARM_BADGE = 'adhan-badge-tick';

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
async function loadBackground({ storage = {}, fetchRoutes, manifest, uiLang, firefox = false } = {}) {
  const chrome = makeChrome({ initialStorage: storage, manifest, uiLang, firefox });
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


