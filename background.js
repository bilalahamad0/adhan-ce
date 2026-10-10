// Adhan Focus — background service worker (MV3)
// Fetches the prayer schedule, fires the desktop notification + cross-tab media
// pause at prayer time, and arms auto-resume. The per-second T-15 countdown and
// the actual pausing/resuming of <video>/<audio> happen in content.js.

import { ymd, ymdInTz, zonedToEpoch, computeNext, buildPrayers, isStaleFire, isPrematureFire, parseTimeToday, hhmmTo12h, PRAYER_ORDER, formatBadgeCountdown, formatCountdown, formatTooltipCountdown, PRAYER_BADGE_COLORS, PRAYER_BADGE_TEXT_COLORS, isRevalidationDue, revalidationAlarmAt, parseAladhanTime, parseAladhanIso, epochAtOffset, locationYmd, locationTime12h, isNewDay, dayBeforeMark, prayerAdjustments, shiftHm, sameTimings, revalidationCrossesNow, revalidationRetryAt, REVALIDATE_MIN_GAP_MS, REVALIDATE_AT_MS, REVALIDATE_WINDOW_END_MS } from './lib/schedule.js';
import { getCatalog, interpolate, isRTLLang, resolveLang } from './lib/i18n.js';
import { emptyUsage, bump, prune } from './lib/usage.js';
import { DEV } from './lib/buildinfo.js';
import { playChime } from './lib/audio.js';

// Call Aladhan directly (CORS-open). Calculation method + Asr school come from
// settings (defaults method=2 ISNA, school=0 Standard — unchanged from before);
// we additionally get Sunrise + the location's IANA timezone (data.meta.timezone).
// Times are asked for in iso8601 form so each carries its UTC offset: the browser's
// own tz data can be out of date (see "the location's UTC offset" in lib/schedule.js).
const ALADHAN_BASE = 'https://api.aladhan.com/v1/timingsByCity';

// Aladhan's optional date path segment is DD-MM-YYYY.
function ddmmyyyy(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}

// 'YYYY-MM-DD' -> Aladhan's 'DD-MM-YYYY'.
function ymdToAladhan(s) {
  const [y, m, d] = String(s).split('-');
  return `${d}-${m}-${y}`;
}

// Aladhan's 'DD-MM-YYYY' -> 'YYYY-MM-DD'.
function ymdFromAladhan(s) {
  const [d, m, y] = String(s).split('-');
  return `${y}-${m}-${d}`;
}

const DEFAULT_SETTINGS = {
  enabled: true,
  country: 'United States',
  state: 'California',
  city: 'Sunnyvale',
  autoResumeMinutes: 5,
  leadSeconds: 30,
  focusMode: true,
  strictFocus: false, // freeze fullscreen on browser pages until auto-resume timeout
  adhanChime: true, // play notification chime when prayer time arrives
  badgeCountdown: true, // show next prayer countdown on toolbar icon badge
  badgeMode: 'auto', // 'auto' (always active) or 'manual' (hold-off threshold)
  badgeManualHours: 2, // hours before prayer to show badge countdown when in manual mode
  method: 2, // Aladhan calculation method id; 2 = ISNA (preserves prior times)
  school: 0, // Asr juristic method: 0 = Standard (Shafi/Maliki/Hanbali), 1 = Hanafi
  showHijri: true, // show the Hijri (Islamic) date in the popup header
  hijriOffset: 0, // ±days moon-sighting correction applied to the displayed Hijri date
  adjustMinutes: { Fajr: 0, Dhuhr: 0, Asr: 0, Maghrib: 0, Isha: 0 }, // ±3 min per prayer, to match a local mosque (see prayerAdjustments)
};

const ALARM_PRAYER = 'adhan-prayer-fire';
const ALARM_RESUME = 'adhan-auto-resume';
const ALARM_TICK = 'adhan-tick';
const ALARM_BADGE = 'adhan-badge-tick';
// Pre-prayer revalidation (see REVALIDATE_* in lib/schedule.js): a one-shot timer at
// T-45 for the next prayer (or T-35 after a T-45 held by the quiet period after a
// prayer), re-armed by armAlarms(), and a one-shot retry after a failed attempt.
const ALARM_REVALIDATE = 'adhan-revalidate';
const ALARM_REVALIDATE_RETRY = 'adhan-revalidate-retry';

// ---------- storage helpers ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
async function getState() {
  const data = await chrome.storage.local.get([
    'settings',
    'schedule',
    'nextPrayer',
    'paused',
    'prayerLog',
    'installedAt',
    'usage',
  ]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    schedule: data.schedule || null,
    nextPrayer: data.nextPrayer || null,
    paused: data.paused || { active: false },
    prayerLog: data.prayerLog || {},
    installedAt: data.installedAt || null,
    usage: data.usage || null,
  };
}

// ---------- local-only usage counters (never transmitted) ----------
// Bump a small set of activity counts kept in chrome.storage.local and shown only
// in the popup — see lib/usage.js. Writes are serialized through one promise chain
// because chrome.storage get/set isn't atomic and several worker events can fire
// close together; without this, concurrent read-modify-writes would lose counts.
// Errors are swallowed so a telemetry hiccup can never break a real action.
// `pauses`/`resumes` are recorded from the `paused` state transition (see the
// storage.onChanged listener) rather than here, so they're counted once per prayer
// even when both pause paths fire; `notifications`/`focusUsed` are recorded inline.
let usageWrite = Promise.resolve();
function recordUsage(event) {
  usageWrite = usageWrite
    .then(async () => {
      const { usage } = await chrome.storage.local.get('usage');
      await chrome.storage.local.set({ usage: prune(bump(usage || emptyUsage(), event)) });
    })
    .catch(() => {});
  return usageWrite;
}

// ---------- schedule fetch ----------
// The settings that make up the Aladhan request, plus the minute adjustments
// applied to its answer. A fetched schedule belongs to these.
const REQUEST_KEYS = ['city', 'country', 'state', 'method', 'school'];
const adjustKey = (s) => Object.values(prayerAdjustments(s && s.adjustMinutes)).join(',');
function sameRequest(a, b) {
  return REQUEST_KEYS.every((k) => (a && a[k]) === (b && b[k])) && adjustKey(a) === adjustKey(b);
}

// Revalidation fetches give up after this long, so a hung connection never holds
// the popup or the retry logic hostage.
const REVALIDATE_FETCH_TIMEOUT_MS = 10 * 1000;
// How long opening the popup waits for an in-window revalidation before answering
// from storage (the revalidation carries on, and re-arms if the times moved).
const POPUP_REVALIDATION_WAIT_MS = 2500;

function timeoutSignal(ms) {
  try {
    return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
  } catch (_) {
    return undefined;
  }
}

// Resolves with `promise`'s value, or undefined once `ms` elapsed first.
function waitAtMost(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Noon of the 'YYYY-MM-DD' `day` in IANA `zone` (machine-local without one): a base
// date that buildPrayers / parseTimeToday read as that day.
function noonOf(day, zone) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(zone ? zonedToEpoch(y, m, d, 12, 0, zone) : new Date(y, m - 1, d, 12).getTime());
}

// Fetch + parse one day's timings for `settings` into the stored schedule shape
// ({date, prayers, sunrise, tz, fetchedAt}) without writing anything, so callers
// can check the answer is still wanted before committing it. Throws unless each of
// the five prayers (and Sunrise, when present) is an iso8601 time carrying its UTC
// offset (see parseAladhanIso) or — all of them, from an answer without offsets —
// a strict 24h 'H:MM' time (see parseAladhanTime). `day` ('YYYY-MM-DD') pins the
// requested date — the answer must then be for that date, and is stored as that
// day's times; omitted, it is this machine's local date, and when the location's
// today (read from the answer's offsets) is another date, that date is asked for
// in turn (an answer without offsets is stored under the location's today as it
// is). `tz`, when given, is the timezone the answer must carry.
async function fetchSchedule(settings, { day, tz, timeoutMs } = {}) {
  const date = day ? ymdToAladhan(day) : ddmmyyyy(new Date());
  let url = `${ALADHAN_BASE}/${date}?city=${encodeURIComponent(settings.city)}&country=${encodeURIComponent(
    settings.country
  )}&method=${settings.method}&school=${settings.school}`;
  if (settings.state) url += `&state=${encodeURIComponent(settings.state)}`;
  url += '&iso8601=true';
  const init = { cache: 'no-store' };
  const signal = timeoutMs ? timeoutSignal(timeoutMs) : undefined;
  if (signal) init.signal = signal;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Aladhan ${res.status}`);
  const json = await res.json();
  const data = json && json.data;
  if (!data || !data.timings) throw new Error('Aladhan: malformed response');
  const tmg = data.timings;
  // The LOCATION's timezone (data.meta.timezone): the answer's identity, and the
  // zone its times are read in, even when the chosen city is in a different
  // timezone than this machine.
  const zone = (data.meta && data.meta.timezone) || null;
  if (day) {
    const answered = data.date && data.date.gregorian && data.date.gregorian.date;
    if (answered !== date) throw new Error(`Aladhan: answer is for ${answered}, expected ${date}`);
  }
  if (tz !== undefined && zone !== tz) throw new Error(`Aladhan: timezone ${zone}, expected ${tz}`);
  // Each time as 24h 'HH:MM' plus the UTC offset it carries (null in an answer
  // without offsets). Displayed as the "hh:mm a" the app has always shown.
  const names = tmg.Sunrise != null ? [...PRAYER_ORDER, 'Sunrise'] : PRAYER_ORDER;
  const read = {};
  for (const name of names) {
    const iso = parseAladhanIso(tmg[name]);
    const hm = iso ? iso.hm : parseAladhanTime(tmg[name]);
    if (!hm) throw new Error(`Aladhan: unreadable ${name} time`);
    read[name] = { hm, offsetMin: iso ? iso.offsetMin : null };
  }
  const withOffset = names.filter((name) => read[name].offsetMin !== null).length;
  if (withOffset && withOffset !== names.length) throw new Error('Aladhan: mixed time formats');
  // The user's minute adjustments (see prayerAdjustments), applied to a prayer's
  // time and instant alike. Sunrise is never adjusted.
  const adjust = prayerAdjustments(settings.adjustMinutes);
  const tune = (p) => {
    const min = adjust[p.name];
    return min ? { ...p, time: hhmmTo12h(shiftHm(read[p.name].hm, min)), ts: p.ts + min * 60000, adjustMin: min } : p;
  };
  if (withOffset) {
    // Each instant from the UTC offset Aladhan's tz data gives that time — never
    // from this browser's, which can be out of date (Morocco's +00 since
    // 2026-09-20 read as +01 put every prayer an hour early).
    const asked = day || ymdFromAladhan(date);
    const timed = (name) => ({
      time: hhmmTo12h(read[name].hm),
      ts: epochAtOffset(asked, read[name].hm, read[name].offsetMin),
      offsetMin: read[name].offsetMin,
    });
    const prayers = PRAYER_ORDER.map((name) => tune({ name, ...timed(name) }));
    const sunrise = read.Sunrise ? timed('Sunrise') : null;
    // This machine's date was asked for, and it is another day at the location:
    // ask for that day's own times (its offsets can differ, e.g. across a DST night).
    const today = day || locationYmd({ tz: zone, prayers, sunrise });
    if (today !== asked) return fetchSchedule(settings, { day: today, tz: zone, timeoutMs });
    return { date: asked, prayers, sunrise, tz: zone, fetchedAt: Date.now() };
  }
  // An answer without offsets: anchor every prayer's epoch to the location's
  // timezone through this browser's tz data, as before iso8601 was asked for.
  const base = day ? noonOf(day, zone) : new Date();
  const five = {};
  for (const name of PRAYER_ORDER) five[name] = hhmmTo12h(read[name].hm);
  const prayers = buildPrayers(five, base, zone);
  // An unreadable time would be stored with ts:null and break "next prayer".
  if (prayers.length !== PRAYER_ORDER.length || !prayers.every((p) => Number.isFinite(p.ts))) {
    throw new Error('Aladhan: unreadable prayer time');
  }
  // Sunrise is informational only (no pause/notification), shown greyed in the
  // popup. It is optional, but when present it must parse like the prayers.
  let sunrise = null;
  if (read.Sunrise) {
    const time = hhmmTo12h(read.Sunrise.hm);
    sunrise = { time, ts: parseTimeToday(time, base, zone) };
    if (!Number.isFinite(sunrise.ts)) throw new Error('Aladhan: unreadable Sunrise time');
  }
  return { date: ymdInTz(zone, base), prayers: prayers.map(tune), sunrise, tz: zone, fetchedAt: Date.now() };
}

// Schedule commits (the check-then-write after a fetch) run one at a time, so a
// commit's check can't be invalidated by another writer landing between its read
// and its write. Fetches themselves run outside it.
let scheduleCommit = Promise.resolve();
function commitSchedule(fn) {
  const run = scheduleCommit.then(fn);
  scheduleCommit = run.catch(() => {});
  return run;
}

async function storedScheduleState(extra = {}) {
  const { schedule, nextPrayer } = await chrome.storage.local.get(['schedule', 'nextPrayer']);
  return { schedule: schedule || null, nextPrayer: nextPrayer || null, ...extra };
}

// The day's fetch: the rollover to a new day, Refresh, an update, a settings save.
// With `prev` — the stored schedule, whenever it may be for the same location —
// it asks for THAT location's today (see locationYmd), the date the answer is
// stored under (this machine can be in another timezone, so its own date can be a
// day off); the answer must then be for that date. The stored schedule can be for
// an earlier location (a settings save whose fetch failed), so an answer in another
// timezone is accepted when that zone's today is the date asked for; when it is
// not, the request is made again for that zone's today, and that answer must match
// both. Without a stored schedule with a timezone (first install, a new city) it
// asks for this machine's date first (see fetchSchedule). The new schedule keeps
// `prev`'s last time of the day before (see dayBeforeMark), and a committed answer
// settles a day fetch still owed (`scheduleRefetch`).
async function fetchAndStoreSchedule({ prev } = {}) {
  const settings = await getSettings();
  let schedule;
  if (prev && prev.tz) {
    const day = locationYmd(prev);
    schedule = await fetchSchedule(settings, { day });
    const zoneDay = locationYmd(schedule);
    if (schedule.tz !== prev.tz && zoneDay !== day) {
      schedule = await fetchSchedule(settings, { day: zoneDay, tz: schedule.tz });
    }
  } else {
    schedule = await fetchSchedule(settings);
  }
  return commitSchedule(async () => {
    // The location/calculation changed while this was in flight: the answer is for
    // the old settings, and whoever changed them fetches for the new ones.
    if (!sameRequest(await getSettings(), settings)) return storedScheduleState({ superseded: true });
    const dayBefore = dayBeforeMark(prev, schedule);
    if (dayBefore) schedule = { ...schedule, dayBefore };
    const nextPrayer = computeNext(schedule.prayers, Date.now());
    await chrome.storage.local.set({ schedule, nextPrayer, scheduleRefetch: false });
    return { schedule, nextPrayer };
  });
}

// What identifies a pause for the revalidation commit: a prayer that fires while
// the re-fetch is in flight changes it; a focus toggle does not.
function pauseMark(paused) {
  return paused && paused.active ? `${paused.prayer}|${paused.since}` : 'none';
}

// Pre-prayer revalidation (see REVALIDATE_* in lib/schedule.js): re-fetch TODAY's
// timings with the same request and let the freshest Aladhan answer win. The date
// is pinned to the stored schedule's (location) day, which is always "today" here;
// the answer must be for that day and timezone. Nothing is written when the stored
// schedule or the request settings changed during the fetch (a settings save or
// Refresh got there first), a prayer fired meanwhile (a new pause started), or the
// answer landed at or after the window's end, T-30 ({superseded}). A pause that
// was already running when the fetch started — or that ends during it — does not
// block it: a long auto-resume window would otherwise skip the next prayer's check. Identical answer → only fetchedAt is recorded. Different answer
// → stored, unless it would move a prayer across "now" (revalidationCrossesNow):
// then nothing is written ({held}) and the attempt is retried, so a prayer never
// fires twice or gets skipped. Throws — leaving the stored schedule untouched —
// when the fetch fails or the answer is malformed.
async function revalidateSchedule(old, pausedAtStart, pendingTs) {
  const settings = await getSettings();
  const fresh = await fetchSchedule(settings, { day: old.date, tz: old.tz || undefined, timeoutMs: REVALIDATE_FETCH_TIMEOUT_MS });
  return commitSchedule(async () => {
    const cur = await chrome.storage.local.get(['schedule', 'settings', 'paused']);
    if (
      !cur.schedule ||
      cur.schedule.date !== old.date ||
      cur.schedule.fetchedAt !== old.fetchedAt ||
      !sameRequest({ ...DEFAULT_SETTINGS, ...(cur.settings || {}) }, settings) ||
      (cur.paused && cur.paused.active && pauseMark(cur.paused) !== pauseMark(pausedAtStart)) ||
      Date.now() >= pendingTs - REVALIDATE_WINDOW_END_MS
    ) {
      return storedScheduleState({ changed: false, superseded: true });
    }
    if (fresh.date !== old.date) throw new Error(`Aladhan: answer is for ${fresh.date}, expected ${old.date}`);
    const now = Date.now();
    if (sameTimings(old, fresh)) {
      const kept = { ...old, fetchedAt: fresh.fetchedAt };
      const nextPrayer = computeNext(kept.prayers, now);
      await chrome.storage.local.set({ schedule: kept, nextPrayer });
      return { schedule: kept, nextPrayer, changed: false };
    }
    const crossing = revalidationCrossesNow(old.prayers, fresh.prayers, now);
    if (crossing.length) {
      console.warn(`Adhan: revalidated times would move ${crossing.join(', ')} across now; keeping current times`);
      return storedScheduleState({ changed: false, held: true });
    }
    const stored = old.dayBefore ? { ...fresh, dayBefore: old.dayBefore } : fresh;
    const nextPrayer = computeNext(stored.prayers, now);
    await chrome.storage.local.set({ schedule: stored, nextPrayer });
    return { schedule: stored, nextPrayer, changed: true };
  });
}

// The one retry, at T-35 (see revalidationRetryAt).
function armRevalidationRetry(prayerTs) {
  const retryAt = revalidationRetryAt(prayerTs, Date.now());
  if (retryAt) chrome.alarms.create(ALARM_REVALIDATE_RETRY, { when: retryAt });
}

// Runs one revalidation for the upcoming prayer `pending`, first recording the
// attempt (and the recomputed nextPrayer). Never throws: a failure keeps the
// stored times and warns. A failed or held attempt arms one retry, unless it was
// that retry.
async function runRevalidation(old, pending, { nextPrayer, now, paused, retry }) {
  let r;
  try {
    await chrome.storage.local.set({ nextPrayer, revalidateAttemptAt: now });
    r = await revalidateSchedule(old, paused, pending.ts);
  } catch (e) {
    console.warn('Adhan: pre-prayer revalidation failed; keeping current times', e);
    if (!retry) armRevalidationRetry(pending.ts);
    return storedScheduleState({ changed: false, failed: true }).catch(() => ({ changed: false, failed: true }));
  }
  if (r.held) {
    if (!retry) armRevalidationRetry(pending.ts);
  } else if (!r.superseded) {
    await chrome.alarms.clear(ALARM_REVALIDATE_RETRY);
  }
  return r;
}

// The revalidation / day-rollover fetch in flight, if any. Concurrent triggers (a
// browser start and a missed tick, the popup and a tick, the retry and a tick)
// share it instead of sending a second Aladhan request.
let revalidationInFlight = null;
let rolloverInFlight = null;

// Recompute "next" from the stored schedule; refetch if the day rolled over, and
// revalidate today's timings before each prayer (see REVALIDATE_* in
// lib/schedule.js). With `background`, a revalidation is not awaited: the result
// carries it as `revalidation` (a promise that never rejects). `retry` marks the
// call made by the retry alarm, which does not arm another retry.
async function refreshNext({ background = false, retry = false } = {}) {
  const data = await chrome.storage.local.get(['settings', 'schedule', 'nextPrayer', 'paused', 'revalidateAttemptAt', 'scheduleRefetch']);
  const schedule = data.schedule || null;
  // Rolled over to a new day *at the location* (see isNewDay), or a day fetch is
  // still owed (an update's or a settings save's failed) → fetch the day.
  if (!schedule || isNewDay(schedule) || data.scheduleRefetch) {
    if (!rolloverInFlight) {
      const run = fetchAndStoreSchedule({ prev: schedule || undefined });
      const done = () => {
        if (rolloverInFlight === run) rolloverInFlight = null;
      };
      rolloverInFlight = run;
      run.then(done, done);
    }
    return rolloverInFlight;
  }
  const now = Date.now();
  const nextPrayer = computeNext(schedule.prayers, now);
  // A revalidation is already in flight: share it. It records nextPrayer itself.
  if (revalidationInFlight) {
    return background ? { schedule, nextPrayer, revalidation: revalidationInFlight } : revalidationInFlight;
  }
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  const enabled = settings.enabled !== false; // a disabled install never re-fetches
  // A pending dev test fire blocks it (isRevalidationDue rejects test fires).
  // Attempts are spaced REVALIDATE_MIN_GAP_MS apart, so a failure isn't retried on
  // every popup open.
  const pending = data.nextPrayer && data.nextPrayer.test ? data.nextPrayer : nextPrayer;
  const sinceAttempt = typeof data.revalidateAttemptAt === 'number' ? now - data.revalidateAttemptAt : Infinity;
  // One attempt per window (the T-45 alarm, or the first catch-up after it), then
  // the one retry alarm at T-35 — the same two sampling moments as any other
  // client using this rule.
  const attempted =
    !retry && typeof data.revalidateAttemptAt === 'number' && data.revalidateAttemptAt >= pending.ts - REVALIDATE_AT_MS;
  const due =
    enabled &&
    !attempted &&
    isRevalidationDue(schedule, pending, now) &&
    !(sinceAttempt >= 0 && sinceAttempt < REVALIDATE_MIN_GAP_MS);
  if (!due) {
    // (A T-45 check held by the quiet period after a prayer is tried again at T-35:
    // armAlarms arms ALARM_REVALIDATE for it — see revalidationAlarmAt.)
    await chrome.storage.local.set({ nextPrayer });
    return { schedule, nextPrayer };
  }
  const run = runRevalidation(schedule, pending, { nextPrayer, now, paused: data.paused || { active: false }, retry });
  const done = () => {
    if (revalidationInFlight === run) revalidationInFlight = null;
  };
  revalidationInFlight = run;
  run.then(done, done);
  return background ? { schedule, nextPrayer, revalidation: run } : run;
}

// ---------- alarms ----------
async function armAlarms() {
  const { settings, nextPrayer, schedule } = await getState();
  await chrome.alarms.clear(ALARM_PRAYER);
  if (settings.enabled && nextPrayer) {
    chrome.alarms.create(ALARM_PRAYER, { when: Math.max(Date.now() + 500, nextPrayer.ts) });
  }
  // Pre-prayer revalidation timer for the next prayer: T-45 whenever that moment is
  // still ahead, or T-35 after a T-45 that fell in the quiet period after a prayer
  // (see revalidationAlarmAt). Either runs as a first attempt, so its own failure
  // gets the one retry. The tick, startup and popup catch up on a missed one.
  await chrome.alarms.clear(ALARM_REVALIDATE);
  const { revalidateAttemptAt } = await chrome.storage.local.get('revalidateAttemptAt');
  const revalidateAt = settings.enabled ? revalidationAlarmAt(schedule, nextPrayer, Date.now(), revalidateAttemptAt) : null;
  if (revalidateAt) chrome.alarms.create(ALARM_REVALIDATE, { when: revalidateAt });
  if (!settings.enabled) await chrome.alarms.clear(ALARM_REVALIDATE_RETRY);
  await chrome.alarms.clear(ALARM_BADGE);
  if (settings.enabled && settings.badgeCountdown !== false && nextPrayer) {
    chrome.alarms.create(ALARM_BADGE, {
      when: Math.ceil(Date.now() / 60000) * 60000,
      periodInMinutes: 1,
    });
  }
  // Self-healing heartbeat: recompute / refetch and re-arm periodically.
  chrome.alarms.create(ALARM_TICK, { periodInMinutes: 15 });
  await updateBadge();
}

// ---------- broadcast to tabs ----------
async function broadcast(message) {
  // No "tabs" permission is requested: the query's url filter is honored because
  // the broad host_permissions grant tab-URL access. If host_permissions are ever
  // narrowed (e.g. moved to optional), re-add "tabs" or this filter is ignored.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.all(
    tabs.map(async (t) => {
      if (t.id == null) return;
      try {
        await chrome.tabs.sendMessage(t.id, message);
      } catch (_) {
        // No live content script in this tab — almost always a tab that was open
        // before the extension loaded/updated (common in dev, and after a browser
        // restart). Inject it, then retry, so its media still pauses/resumes at
        // prayer time. (A video in Picture-in-Picture pauses once its source tab's
        // <video> is paused.) Restricted pages (chrome://, the Web Store, the PDF
        // viewer) reject injection — ignored.
        try {
          await chrome.scripting.insertCSS({ target: { tabId: t.id, allFrames: true }, files: ['content.css'] });
          await chrome.scripting.executeScript({ target: { tabId: t.id, allFrames: true }, files: ['content.js'] });
          await chrome.tabs.sendMessage(t.id, message).catch(() => {});
        } catch (_) {}
      }
    })
  );
}

async function updateBadge(providedState) {
  try {
    const { settings, nextPrayer, paused } = providedState || (await getState());
    if (!settings.enabled || settings.badgeCountdown === false) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Adhan Focus — Muslim Prayer Times' });
      return;
    }

    if (paused && paused.active) {
      await chrome.action.setBadgeText({ text: '❚❚' });
      const p = paused.prayer || (nextPrayer && nextPrayer.name) || 'Prayer';
      const color = (p && PRAYER_BADGE_COLORS[p]) || '#0b6b43';
      const textColor = (p && PRAYER_BADGE_TEXT_COLORS[p]) || '#ffffff';
      await chrome.action.setBadgeBackgroundColor({ color });
      try {
        await chrome.action.setBadgeTextColor({ color: textColor });
      } catch (_) {}
      await chrome.action.setTitle({ title: `${p} Adhan · Media paused` });
      return;
    }

    if (!nextPrayer || !nextPrayer.ts) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Adhan Focus — Muslim Prayer Times' });
      return;
    }

    const now = Date.now();
    const diff = nextPrayer.ts - now;
    const mode = settings.badgeMode || 'auto';
    const manualHours = settings.badgeManualHours != null ? settings.badgeManualHours : 2;
    const text = formatBadgeCountdown(diff, { mode, manualHours });
    await chrome.action.setBadgeText({ text });
    if (text) {
      const color = (nextPrayer.name && PRAYER_BADGE_COLORS[nextPrayer.name]) || '#0b6b43';
      const textColor = (nextPrayer.name && PRAYER_BADGE_TEXT_COLORS[nextPrayer.name]) || '#ffffff';
      await chrome.action.setBadgeBackgroundColor({ color });
      try {
        await chrome.action.setBadgeTextColor({ color: textColor });
      } catch (_) {}
    }

    const countdownStr = formatTooltipCountdown(diff) || formatBadgeCountdown(diff);
    await chrome.action.setTitle({
      title: `Next: ${nextPrayer.name} in ${countdownStr} (${nextPrayer.time})`,
    });
  } catch (_) {}
}

async function setPausedBadge(on) {
  await updateBadge();
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

  // The mirror of the stale check: a fire whose prayer time is still in the FUTURE
  // is spurious — a delayed/duplicate ALARM_PRAYER for a prayer that a prior fire
  // (or the content-script fallback in handleFallbackPause) already handled and
  // advanced `nextPrayer` past. Acting on it would pause/notify/advance for the
  // WRONG (upcoming) prayer and clobber an in-progress pause, so skip it; re-arm so
  // the real upcoming alarm still stands. A blanket `paused.active` guard would
  // instead wrongly swallow a genuine new prayer that fires while a previous
  // prayer's pause is still open under a long auto-resume window. Test fires
  // (scheduled for "now") are exempt.
  if (!nextPrayer.test && isPrematureFire(firedTs)) {
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
    // Chrome supports notification action buttons (+ priority); Firefox's
    // WebExtensions schema rejects the `buttons` property and ignores `priority`.
    // create() can fail synchronously (Firefox throws on schema validation) or
    // asynchronously (rejected promise), so attempt the rich Chrome notification
    // and on ANY failure retry a plain toast — behavior detection, not UA
    // sniffing — so Firefox shows the alert instead of nothing. The
    // onButtonClicked listener is a harmless no-op stub on Firefox, left as-is.
    const base = {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: interpolate(M.notif_title, { prayer: pname }),
      message: interpolate(M.notif_body, { prayer: pname, time: nextPrayer.time }),
    };
    try {
      await chrome.notifications.create(`adhan-${firedTs}`, {
        ...base,
        priority: 2,
        buttons: [{ title: M.btn_focus }, { title: M.btn_resume }],
      });
    } catch (_) {
      await chrome.notifications.create(`adhan-${firedTs}`, base);
    }
    // Counted once a toast was shown (either variant). Kept after the retry so a
    // Firefox buttons-throw can't zero the popup's Alerts stat.
    await recordUsage('notifications');
  } catch (_) {}

  await broadcast({ type: 'PRAYER_NOW', prayer: nextPrayer.name, time: nextPrayer.time, focus, since: paused.since });
  await setPausedBadge(true);

  if (settings.adhanChime !== false) {
    try {
      await playChime();
    } catch (_) {}
  }

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
  if (settings.adhanChime !== false) {
    try {
      await playChime();
    } catch (_) {}
  }
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
  const { paused, settings } = await getState();
  // If strict screen freeze is active, manual resume is disabled until autoResume timeout
  if (paused && paused.active && settings && settings.strictFocus) {
    return false;
  }
  await chrome.alarms.clear(ALARM_RESUME);
  await chrome.storage.local.set({ paused: { active: false } });
  await broadcast({ type: 'RESUME' });
  await setPausedBadge(false);
  return true;
}

async function enableFocus() {
  const { paused } = await getState();
  if (!paused.active) return;
  await chrome.storage.local.set({ paused: { ...paused, focus: true } });
  await recordUsage('focusUsed');
  await broadcast({ type: 'FOCUS_ON', prayer: paused.prayer, time: paused.time, since: paused.since });
}

async function disableFocus() {
  const { paused, settings } = await getState();
  if (!paused.active) return;
  if (settings && settings.strictFocus) return; // Frozen: cannot turn focus off intermittently
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
  const { nextPrayer, schedule } = await getState();
  const ts = Date.now() + seconds * 1000;
  const name = (nextPrayer && nextPrayer.name) || 'Test';
  const time = locationTime12h(schedule, ts);
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
chrome.runtime.onInstalled.addListener(async (details) => {
  const isFreshInstall = details && details.reason === 'install';
  const stored = await chrome.storage.local.get(['settings', 'paused', 'installedAt', 'onboardingCompleted', 'schedule']);
  if (!stored.settings) await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
  if (!stored.paused) await chrome.storage.local.set({ paused: { active: false } });
  // Anchor the prayer-tracking history. For an existing user updating into this
  // version we can't know the true install date, so "since installation" starts now.
  if (!stored.installedAt) await chrome.storage.local.set({ installedAt: Date.now() });
  if (stored.onboardingCompleted === undefined) {
    await chrome.storage.local.set({ onboardingCompleted: !isFreshInstall });
  }
  try {
    // An update keeps the location: ask for its today (see fetchAndStoreSchedule).
    await fetchAndStoreSchedule({ prev: stored.schedule || undefined });
  } catch (e) {
    console.warn('Adhan: initial schedule fetch failed', e);
    // The stored times may be an older version's (read through out-of-date tz
    // data): fetch the day again on the next tick, startup or popup open.
    if (stored.schedule) await chrome.storage.local.set({ scheduleRefetch: true });
  }
  await armAlarms();
  // Don't blindly clear an in-progress pause: a reload/update mid-Adhan should
  // keep media paused and still auto-resume.
  await reconcilePaused();
  await injectExistingTabs();
  if (isFreshInstall) {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    } catch (_) {}
  }
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
  else if (alarm.name === ALARM_BADGE) updateBadge();
  else if (alarm.name === ALARM_TICK || alarm.name === ALARM_REVALIDATE || alarm.name === ALARM_REVALIDATE_RETRY) {
    (async () => {
      try {
        await refreshNext({ retry: alarm.name === ALARM_REVALIDATE_RETRY });
        await armAlarms();
        await reconcilePaused();
      } catch (e) {
        console.warn('Adhan: tick failed', e);
      }
    })();
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

// Count pause/resume activity from the single source of truth — the `paused` state
// transition — rather than at each call site. background.js is the only writer of
// `paused`, and the two pause paths (the alarm in handlePrayerFire and the
// content-script fallback in handleFallbackPause) can both fire for one prayer;
// counting the false→true edge means the second (true→true) write is a no-op, so a
// prayer is counted exactly once. Resumes count on the true→false edge.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.paused) return;
  const was = !!(changes.paused.oldValue && changes.paused.oldValue.active);
  const now = !!(changes.paused.newValue && changes.paused.newValue.active);
  if (!was && now) recordUsage('pauses');
  else if (was && !now) recordUsage('resumes');
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Defense-in-depth: only act on messages from this extension's own contexts
  // (its content scripts and popup, whose sender.id is our own runtime id). No
  // externally_connectable is declared, so web pages / other extensions can't
  // reach this today — this guards the state-mutating handlers (SAVE_SETTINGS,
  // TOGGLE_PRAYER, RESUME_NOW, …) against a future manifest change accidentally
  // exposing them. Missing sender.id (shouldn't happen for internal messages) is
  // allowed through so legitimate traffic never breaks.
  if (sender && sender.id && sender.id !== chrome.runtime.id) return;
  (async () => {
    switch (msg && msg.type) {
      case 'GET_STATE':
        // Self-heal on open: if the day rolled over (location tz) refetch; otherwise
        // just recompute nextPrayer (revalidating in the pre-prayer window). The
        // popup waits for a revalidation at most POPUP_REVALIDATION_WAIT_MS, then
        // answers from storage while it carries on. One that moved today's times
        // re-arms the prayer alarm here — the tick/startup paths re-arm on their
        // own. Failures fall back to the stored state.
        try {
          const r = await refreshNext({ background: true });
          if (r && r.revalidation) {
            const rearmed = r.revalidation.then((v) => (v && v.changed ? armAlarms() : undefined)).catch(() => {});
            await waitAtMost(rearmed, POPUP_REVALIDATION_WAIT_MS);
          }
        } catch (_) {}
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
      case 'RESUME_NOW': {
        const ok = await resumeNow();
        sendResponse({ ok: ok !== false, error: ok === false ? 'strict_focus_locked' : undefined });
        break;
      }
      case 'FOCUS_NOW':
        await enableFocus();
        sendResponse({ ok: true });
        break;
      case 'PRAYER_FALLBACK':
        await handleFallbackPause(msg);
        sendResponse({ ok: true });
        break;
      case 'PLAY_CHIME':
        // Targeted at offscreen document; no-op in background worker
        break;
      case 'CHIME_FINISHED': {
        const offscreen = typeof chrome !== 'undefined' ? chrome['offscreen'] : null;
        if (offscreen && typeof offscreen.closeDocument === 'function') {
          offscreen.closeDocument().catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case 'PLAY_CHIME_PREVIEW':
        await playChime();
        sendResponse({ ok: true });
        break;
      case 'TEST_ADHAN':
        if (!DEV) {
          sendResponse({ ok: false, error: 'dev only' });
          break;
        }
        await testAdhan(msg.seconds || 30);
        sendResponse({ ok: true });
        break;
      case 'TEST_PAUSE_DEMO': {
        const prayer = msg.prayer || 'Maghrib';
        const seconds = Math.min(60, Math.max(5, msg.seconds || 10));
        const { schedule } = await chrome.storage.local.get('schedule');
        const since = Date.now();
        const time = locationTime12h(schedule || null, since);
        await broadcast({ type: 'PRAYER_NOW', prayer, time, focus: true, since, isDemo: true });
        const s = await getSettings();
        if (s.adhanChime !== false) {
          try { await playChime(); } catch (_) {}
        }
        setTimeout(async () => {
          await broadcast({ type: 'RESUME', isDemo: true });
        }, seconds * 1000);
        sendResponse({ ok: true });
        break;
      }
      case 'RESUME_DEMO': {
        await broadcast({ type: 'RESUME', isDemo: true });
        sendResponse({ ok: true });
        break;
      }
      case 'PATCH_SETTINGS':
      case 'SAVE_SETTINGS': {
        const current = await getSettings();
        const { paused } = await getState();
        const incoming = { ...(msg.settings || {}) };
        // If strict focus is currently active during prayer freeze, prevent turning
        // strictFocus, focusMode, or enabled off intermittently!
        if (paused && paused.active && current.strictFocus) {
          incoming.strictFocus = true;
          incoming.focusMode = true;
          incoming.enabled = true;
        }
        if (incoming.adjustMinutes !== undefined) incoming.adjustMinutes = prayerAdjustments(incoming.adjustMinutes);
        const settings = { ...current, ...incoming };
        await chrome.storage.local.set({ settings });
        const { schedule } = await chrome.storage.local.get('schedule');
        const locationChanged =
          settings.city !== current.city || settings.country !== current.country || settings.state !== current.state;
        const locationOrCalcChanged =
          !schedule ||
          locationChanged ||
          settings.method !== current.method ||
          settings.school !== current.school ||
          adjustKey(settings) !== adjustKey(current);
        if (locationOrCalcChanged) {
          try {
            // A new city may be in another timezone: ask for this machine's date, as
            // before. A calculation change keeps the location's timezone.
            await fetchAndStoreSchedule({ prev: (!locationChanged && schedule) || undefined });
          } catch (e) {
            // The stored times are for the previous settings: fetch the day again
            // on the next tick, startup or popup open.
            await chrome.storage.local.set({ scheduleRefetch: true });
            await armAlarms();
            sendResponse({ ok: false, error: String(e.message || e) });
            return;
          }
        }
        await armAlarms();
        sendResponse({ ok: true });
        break;
      }
      case 'REFRESH':
        try {
          const { schedule } = await chrome.storage.local.get('schedule');
          await fetchAndStoreSchedule({ prev: schedule || undefined });
          await armAlarms();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: String(e.message || e) });
        }
        break;
      case 'TOGGLE_PRAYER': {
        // Mark/unmark one prayer as prayed on a given day (YYYY-MM-DD). Stores only
        // the marked prayers; an emptied day is dropped so the log stays compact.
        // Prayers cannot be marked in advance (neither future dates nor future prayer times).
        if (!msg.date || !PRAYER_ORDER.includes(msg.prayer)) {
          sendResponse({ ok: false, error: 'bad prayer' });
          break;
        }
        const { schedule } = await chrome.storage.local.get('schedule');
        const today = (schedule && schedule.date) || ymd();
        if (msg.date > today) {
          sendResponse({ ok: false, error: 'cannot mark future prayer' });
          break;
        }
        if (msg.date === today && schedule && Array.isArray(schedule.prayers)) {
          const p = schedule.prayers.find((x) => x.name === msg.prayer);
          if (p && p.ts && p.ts > Date.now()) {
            sendResponse({ ok: false, error: 'prayer time has not passed yet' });
            break;
          }
        }
        const { prayerLog } = await chrome.storage.local.get('prayerLog');
        const log = prayerLog || {};
        const day = { ...(log[msg.date] || {}) };
        if (day[msg.prayer]) delete day[msg.prayer];
        else day[msg.prayer] = true;
        if (Object.keys(day).length) log[msg.date] = day;
        else delete log[msg.date];
        await chrome.storage.local.set({ prayerLog: log });
        sendResponse({ ok: true, prayerLog: log });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async response
});
