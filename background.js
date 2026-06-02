// Adhan Caster Pro — background service worker (MV3)
// Fetches the prayer schedule, fires the desktop notification + cross-tab media
// pause at prayer time, and arms auto-resume. The per-second T-15 countdown and
// the actual pausing/resuming of <video>/<audio> happen in content.js.

import { ymd, computeNext, buildPrayers, isStaleFire, parseTimeToday, hhmmTo12h } from './lib/schedule.js';
import { getCatalog, interpolate, isRTLLang, resolveLang } from './lib/i18n.js';

// Call Aladhan directly (CORS-open). method=2 (ISNA) matches the prior companion
// API, so prayer-time values are unchanged; we additionally get Sunrise + the
// location's IANA timezone (data.meta.timezone) for the in-popup clock.
const ALADHAN_BASE = 'https://api.aladhan.com/v1/timingsByCity';

// Aladhan's optional date path segment is DD-MM-YYYY.
function ddmmyyyy(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

const DEFAULT_SETTINGS = {
  enabled: true,
  country: 'United States',
  state: 'California',
  city: 'Sunnyvale',
  autoResumeMinutes: 5,
  leadSeconds: 30,
  focusMode: true,
};

const ALARM_PRAYER = 'adhan-prayer-fire';
const ALARM_RESUME = 'adhan-auto-resume';
const ALARM_TICK = 'adhan-tick';

// Store-installed builds get an `update_url` injected into the manifest;
// unpacked/dev builds do not. Used to keep the test trigger out of production.
function isDevBuild() {
  try {
    return !('update_url' in chrome.runtime.getManifest());
  } catch (_) {
    return false;
  }
}

// ---------- storage helpers ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function getState() {
  const data = await chrome.storage.local.get(['settings', 'schedule', 'nextPrayer', 'paused']);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    schedule: data.schedule || null,
    nextPrayer: data.nextPrayer || null,
    paused: data.paused || { active: false },
  };
}

// ---------- schedule fetch ----------
async function fetchAndStoreSchedule() {
  const settings = await getSettings();
  const date = ddmmyyyy(new Date());
  let url = `${ALADHAN_BASE}/${date}?city=${encodeURIComponent(settings.city)}&country=${encodeURIComponent(
    settings.country
  )}&method=2&school=0`;
  if (settings.state) url += `&state=${encodeURIComponent(settings.state)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Aladhan ${res.status}`);
  const json = await res.json();
  const data = json && json.data;
  if (!data || !data.timings) throw new Error('Aladhan: malformed response');
  const tmg = data.timings;
  const base = new Date();
  // Aladhan returns 24h "HH:mm"; convert to the "hh:mm a" the app already parses
  // and displays, so scheduling/firing is byte-identical to before.
  const five = {
    Fajr: hhmmTo12h(tmg.Fajr),
    Dhuhr: hhmmTo12h(tmg.Dhuhr),
    Asr: hhmmTo12h(tmg.Asr),
    Maghrib: hhmmTo12h(tmg.Maghrib),
    Isha: hhmmTo12h(tmg.Isha),
  };
  const prayers = buildPrayers(five, base);
  // Sunrise is informational only (no pause/notification), shown greyed in the popup.
  const sunriseTime = tmg.Sunrise ? hhmmTo12h(tmg.Sunrise) : null;
  const sunrise = sunriseTime ? { time: sunriseTime, ts: parseTimeToday(sunriseTime, base) } : null;
  const tz = (data.meta && data.meta.timezone) || null;
  const schedule = { date: ymd(base), prayers, sunrise, tz, fetchedAt: Date.now() };
  const nextPrayer = computeNext(prayers, Date.now());
  await chrome.storage.local.set({ schedule, nextPrayer });
  return { schedule, nextPrayer };
}

// Recompute "next" from the stored schedule; refetch if the day rolled over.
async function refreshNext() {
  const { schedule } = await chrome.storage.local.get('schedule');
  if (!schedule || schedule.date !== ymd()) {
    return fetchAndStoreSchedule();
  }
  const nextPrayer = computeNext(schedule.prayers, Date.now());
  await chrome.storage.local.set({ nextPrayer });
  return { schedule, nextPrayer };
}

// ---------- alarms ----------
async function armAlarms() {
  const { settings, nextPrayer } = await getState();
  await chrome.alarms.clear(ALARM_PRAYER);
  if (settings.enabled && nextPrayer) {
    chrome.alarms.create(ALARM_PRAYER, { when: Math.max(Date.now() + 500, nextPrayer.ts) });
  }
  // Self-healing heartbeat: recompute / refetch and re-arm periodically.
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 15 });
}

// ---------- broadcast to tabs ----------
async function broadcast(message) {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map((t) =>
      t.id != null ? chrome.tabs.sendMessage(t.id, message).catch(() => {}) : Promise.resolve()
    )
  );
}

async function setPausedBadge(on) {
  try {
    await chrome.action.setBadgeText({ text: on ? '❚❚' : '' });
    if (on) await chrome.action.setBadgeBackgroundColor({ color: '#0b6b43' });
  } catch (_) {}
}

// ---------- prayer / resume handlers ----------
async function handlePrayerFire() {
  const { settings, nextPrayer } = await getState();
  if (!settings.enabled || !nextPrayer) return;

  const firedTs = nextPrayer.ts;

  // The alarm fired well after prayer time — almost always because the device
  // was asleep at prayer time and Chrome only delivered the (missed) alarm on
  // wake. Interrupting the user now with a frozen, full-screen focus overlay and
  // a fresh auto-resume countdown for a moment that has clearly passed is bad UX,
  // so treat it as missed: skip the pause/notification/focus/auto-resume, jump
  // nextPrayer to the next upcoming one, and re-arm. (computeNext from now, not
  // firedTs, so a long sleep across several prayers lands on a future one rather
  // than firing a burst of catch-up alarms.) Test fires are scheduled for "now",
  // so they're never stale.
  if (!nextPrayer.test && isStaleFire(firedTs)) {
    const { schedule } = await chrome.storage.local.get('schedule');
    if (schedule) {
      await chrome.storage.local.set({ nextPrayer: computeNext(schedule.prayers, Date.now()) });
    }
    await armAlarms();
    return;
  }

  const focus = settings.focusMode === true;
  const paused = { active: true, prayer: nextPrayer.name, time: nextPrayer.time, since: Date.now(), focus };
  await chrome.storage.local.set({ paused });

  try {
    const { lang } = await chrome.storage.local.get('lang');
    const M = await getCatalog(lang || 'en');
    const pname = M['prayer_' + nextPrayer.name] || nextPrayer.name;
    await chrome.notifications.create(`adhan-${firedTs}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: interpolate(M.notif_title, { prayer: pname }),
      message: interpolate(M.notif_body, { prayer: pname, time: nextPrayer.time }),
      priority: 2,
      buttons: [{ title: M.btn_focus }, { title: M.btn_resume }],
    });
  } catch (_) {}

  await broadcast({ type: 'PRAYER_NOW', prayer: nextPrayer.name, time: nextPrayer.time, focus, since: paused.since });
  await setPausedBadge(true);

  // Arm auto-resume.
  chrome.alarms.create(ALARM_RESUME, { when: Date.now() + settings.autoResumeMinutes * 60 * 1000 });

  // Advance to the following prayer and re-arm.
  const { schedule } = await chrome.storage.local.get('schedule');
  if (schedule) {
    const next = computeNext(schedule.prayers, firedTs + 1000);
    await chrome.storage.local.set({ nextPrayer: next });
  }
  await armAlarms();
}

// Fallback entry point: content.js calls this when its own countdown hits zero
// before the (possibly-delayed) ALARM_PRAYER fires. Records the pause centrally
// and arms auto-resume so media never stays paused with no way back. Idempotent
// — a no-op if a pause is already active, so the normal alarm path still owns
// the notification and prayer-advance.
async function handleFallbackPause({ prayer, time, focus }) {
  const { settings, paused, nextPrayer } = await getState();
  if (!settings.enabled || paused.active) return;
  const since = Date.now();
  await chrome.storage.local.set({ paused: { active: true, prayer, time, since, focus: !!focus } });
  await broadcast({ type: 'PRAYER_NOW', prayer, time, focus: !!focus, since });
  await setPausedBadge(true);
  chrome.alarms.create(ALARM_RESUME, { when: since + settings.autoResumeMinutes * 60 * 1000 });

  // Advance nextPrayer past the one that just fired, mirroring handlePrayerFire.
  // Without this, the just-fired prayer stays as nextPrayer; after Resume, the
  // per-tab 90-second fallback window in content.js can re-pause every tab that
  // received PRAYER_NOW via broadcast (their lastHandledTs was never set), and
  // each re-pause re-broadcasts PRAYER_NOW back to all tabs — including the one
  // that just clicked Resume. Advancing here puts np.ts in the future so the
  // fallback condition `now >= np.ts` can't re-trigger.
  const firedTs = (nextPrayer && nextPrayer.ts) || since;
  const { schedule } = await chrome.storage.local.get('schedule');
  if (schedule) {
    const next = computeNext(schedule.prayers, firedTs + 1000);
    await chrome.storage.local.set({ nextPrayer: next });
  }
  await armAlarms();
}

async function handleAutoResume() {
  const { paused } = await getState();
  if (!paused.active) return;
  await chrome.storage.local.set({ paused: { active: false } });
  await broadcast({ type: 'RESUME' });
  await setPausedBadge(false);
}

// On service-worker (re)start — including an extension reload/update that lands
// *during* an Adhan — make sure an in-progress pause still ends. ALARM_RESUME
// doesn't survive a reload, so re-arm it for the time that's left, or resume
// immediately if the auto-resume window already elapsed. Idempotent: it always
// targets the same absolute resume time (since + autoResumeMinutes), so it's
// safe to call repeatedly (install, startup, periodic tick).
async function reconcilePaused() {
  const { settings, paused } = await getState();
  if (!paused.active) return;
  const mins = settings.autoResumeMinutes != null ? settings.autoResumeMinutes : 5;
  const since = paused.since || Date.now();
  const remaining = mins * 60 * 1000 - (Date.now() - since);
  if (remaining > 0) {
    chrome.alarms.create(ALARM_RESUME, { when: Date.now() + remaining });
    await setPausedBadge(true);
  } else {
    await handleAutoResume();
  }
}

async function resumeNow() {
  await chrome.alarms.clear(ALARM_RESUME);
  await chrome.storage.local.set({ paused: { active: false } });
  await broadcast({ type: 'RESUME' });
  await setPausedBadge(false);
}

async function enableFocus() {
  const { paused } = await getState();
  if (!paused.active) return;
  await chrome.storage.local.set({ paused: { ...paused, focus: true } });
  await broadcast({ type: 'FOCUS_ON', prayer: paused.prayer, time: paused.time, since: paused.since });
}

async function disableFocus() {
  const { paused } = await getState();
  if (!paused.active) return;
  await chrome.storage.local.set({ paused: { ...paused, focus: false } });
  await broadcast({ type: 'FOCUS_OFF' });
}

async function toggleFocus() {
  const { paused } = await getState();
  if (!paused.active) return;
  if (paused.focus) await disableFocus();
  else await enableFocus();
}

// Dev/preview: fire a simulated Adhan after a short delay so the full flow
// (countdown → cross-tab pause → focus → auto-resume) can be seen on demand.
// 30s minimum because chrome.alarms clamps shorter delays, which made the
// notification appear to "not fire".
async function testAdhan(seconds = 30) {
  const { nextPrayer } = await getState();
  const ts = Date.now() + seconds * 1000;
  const name = (nextPrayer && nextPrayer.name) || 'Test';
  const time = new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  await chrome.storage.local.set({ nextPrayer: { name, time, ts, test: true } });
  chrome.alarms.create(ALARM_PRAYER, { when: ts });
}

// ---------- inject into already-open tabs (new installs) ----------
async function injectExistingTabs() {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const t of tabs) {
    if (t.id == null) continue;
    try {
      await chrome.scripting.insertCSS({ target: { tabId: t.id, allFrames: true }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] });
    } catch (_) {
      // restricted pages (chrome://, web store, PDF viewer, etc.) — ignore
    }
  }
}

// ---------- event wiring ----------
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(['settings', 'paused']);
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  if (!stored.paused) await chrome.storage.local.set({ paused: { active: false } });
  try {
    await fetchAndStoreSchedule();
  } catch (e) {
    console.warn('Adhan: initial schedule fetch failed', e);
  }
  await armAlarms();
  // Don't blindly clear an in-progress pause: a reload/update mid-Adhan should
  // keep media paused and still auto-resume.
  await reconcilePaused();
  await injectExistingTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  try {
    await refreshNext();
  } catch (e) {
    console.warn('Adhan: startup refresh failed', e);
  }
  await armAlarms();
  await reconcilePaused();
  // Re-prime already-open tabs after a browser restart, exactly like onInstalled
  // does on install/update. Declarative content_scripts only inject on
  // navigation, so tabs Chrome restored-but-didn't-reload have no live content
  // script to receive the Adhan broadcast — leaving the cross-tab pause + focus
  // overlay on the foreground tab only while background tabs stay untouched.
  // (The dev workflow hides this: reloading the unpacked extension fires
  // onInstalled and re-primes every tab; a real user's browser restart never did.)
  await injectExistingTabs();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_PRAYER) handlePrayerFire();
  else if (alarm.name === ALARM_RESUME) handleAutoResume();
  else if (alarm.name === ALARM_TICK) {
    refreshNext()
      .then(armAlarms)
      .then(reconcilePaused)
      .catch((e) => console.warn('Adhan: tick failed', e));
  }
});

chrome.notifications.onClicked.addListener(() => {
  chrome.action.openPopup?.().catch(() => {});
});

chrome.notifications.onButtonClicked.addListener((_id, btnIdx) => {
  if (btnIdx === 0) enableFocus();
  else if (btnIdx === 1) resumeNow();
});

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd === 'toggle-focus') toggleFocus();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg && msg.type) {
      case 'GET_STATE':
        sendResponse(await getState());
        break;
      case 'GET_I18N': {
        // Content scripts can't import the i18n module (classic content script),
        // so the background hands them the merged catalog + direction.
        const { lang } = await chrome.storage.local.get('lang');
        let ui = 'en';
        try {
          ui = chrome.i18n.getUILanguage();
        } catch (_) {}
        const code = resolveLang(lang, ui);
        sendResponse({ lang: code, dir: isRTLLang(code) ? 'rtl' : 'ltr', messages: await getCatalog(code) });
        break;
      }
      case 'RESUME_NOW':
        await resumeNow();
        sendResponse({ ok: true });
        break;
      case 'FOCUS_NOW':
        await enableFocus();
        sendResponse({ ok: true });
        break;
      case 'PRAYER_FALLBACK':
        await handleFallbackPause(msg);
        sendResponse({ ok: true });
        break;
      case 'TEST_ADHAN':
        if (!isDevBuild()) {
          sendResponse({ ok: false, error: 'dev only' });
          break;
        }
        await testAdhan(msg.seconds || 30);
        sendResponse({ ok: true });
        break;
      case 'SAVE_SETTINGS': {
        const current = await getSettings();
        const settings = { ...current, ...(msg.settings || {}) };
        await chrome.storage.local.set({ settings });
        try {
          await fetchAndStoreSchedule();
        } catch (e) {
          await armAlarms();
          sendResponse({ ok: false, error: String(e.message || e) });
          return;
        }
        await armAlarms();
        sendResponse({ ok: true });
        break;
      }
      case 'REFRESH':
        try {
          await fetchAndStoreSchedule();
          await armAlarms();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async response
});
