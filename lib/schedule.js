// Pure, dependency-free helpers shared by the service worker and popup.
// No chrome.* or DOM access here so this module is unit-testable under Node/Jest.

export const PRAYER_ORDER = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
export const DAY_MS = 24 * 60 * 60 * 1000;

// Local date as YYYY-MM-DD.
export function ymd(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 'YYYY-MM-DD' of `date` as read in IANA `tz` (falls back to machine-local).
export function ymdInTz(tz, date = new Date()) {
  if (!tz) return ymd(date);
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  } catch (_) {
    return ymd(date);
  }
}

// Offset (ms) of `tz` at the instant `date` by this browser's tz data, or NaN when
// Intl can't read the zone.
function zoneOffsetMs(date, tz) {
  try {
    const p = {};
    for (const part of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date)) {
      p[part.type] = part.value;
    }
    const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return asUTC - date.getTime();
  } catch (_) {
    return NaN;
  }
}

// Offset (ms) of `tz` at the instant `date`: (wall-clock read as UTC) - actual UTC.
// e.g. for America/Los_Angeles in summer this is -7h. Pure (Intl only). 0 when
// Intl can't read the zone.
export function tzOffsetMs(date, tz) {
  const off = zoneOffsetMs(date, tz);
  return Number.isFinite(off) ? off : 0;
}

// Epoch (ms) for the wall-clock Y-M-D H:M in IANA `tz`. Two passes settle DST edges.
export function zonedToEpoch(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let epoch = guess - tzOffsetMs(new Date(guess), tz);
  epoch = guess - tzOffsetMs(new Date(epoch), tz);
  return epoch;
}

// "06:30 PM" -> epoch ms for that wall-clock time on `base`'s date. When `tz` is
// given the time is anchored to THAT zone (so prayer times for a remote city are
// correct regardless of the machine's timezone); otherwise machine-local. null if
// unparseable.
export function parseTimeToday(timeStr, base = new Date(), tz = null) {
  const m = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (/PM/i.test(m[3])) h += 12;
  const mi = parseInt(m[2], 10);
  if (tz) {
    const [Y, M, D] = ymdInTz(tz, base).split('-').map(Number);
    return zonedToEpoch(Y, M, D, h, mi, tz);
  }
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, mi, 0, 0).getTime();
}

// "20:24" (24h) -> "08:24 PM". Returns the input unchanged if it isn't HH:mm
// (e.g. it's already "hh:mm a"), so it's safe to pass either format.
export function hhmmTo12h(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return s;
  let h = parseInt(m[1], 10);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${m[2]} ${ap}`;
}

// Build {name,time,ts} entries for today from an all_prayers map ("hh:mm a" strings).
// Pass the location's IANA `tz` so each ts is the real epoch of that prayer there.
export function buildPrayers(allPrayers, base = new Date(), tz = null) {
  const all = allPrayers || {};
  return PRAYER_ORDER.filter((n) => all[n]).map((n) => ({
    name: n,
    time: all[n],
    ts: parseTimeToday(all[n], base, tz),
  }));
}

// First prayer strictly after fromTs. When the stored prayers are all at or before
// fromTs, each is moved forward by whole days to its first time strictly after
// fromTs and the earliest of those is next: after today's Isha that is tomorrow's
// Fajr. With a schedule left over from an earlier day (the day-start fetch keeps
// failing) it is the next of TODAY's prayers at the stored day's times, which are
// within a minute or two — rather than the same Fajr again (a single "+1 day" can
// land on or before fromTs, and the prayer alarm would fire it again and again) or
// only Fajr, which would skip the rest of the day.
export function computeNext(prayers, fromTs) {
  const list = (prayers || []).filter((p) => p && Number.isFinite(p.ts));
  for (const p of list) {
    if (p.ts > fromTs) return { name: p.name, time: p.time, ts: p.ts };
  }
  let next = null;
  for (const p of list) {
    const ts = p.ts + (Math.floor((fromTs - p.ts) / DAY_MS) + 1) * DAY_MS;
    if (!next || ts < next.ts) next = { name: p.name, time: p.time, ts };
  }
  return next;
}

// Aladhan's 24h 'H:MM' / 'HH:MM', optionally followed by one ' (ZONE)' label (e.g.
// "05:40" or "05:40 (PDT)"), normalized to 'HH:MM'. null for anything else — a 12h
// time, an out-of-range hour/minute, extra text, a non-string.
const ALADHAN_TIME_RE = /^(\d{1,2}):(\d{2})(?: \([^()]+\))?$/;
export function parseAladhanTime(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(ALADHAN_TIME_RE);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

// ---------- the location's UTC offset ----------
// Browsers ship their own copy of the IANA tz database, and it can lag the real
// rules by months: Morocco moved to permanent +00 on 2026-09-20 (tzdata 2026c),
// and British Columbia (2026b) and Alberta (2026c) no longer fall back on
// 2026-11-01, yet a browser on older data still applies the old rules. So a
// prayer's instant never comes from Intl: Aladhan is asked for iso8601 timings,
// each carrying the UTC offset Aladhan's own tz data used, and that offset turns
// the wall-clock time into the exact instant. The location's clock and date
// follow Intl only while it agrees with those offsets.

// Aladhan's iso8601 timing 'YYYY-MM-DDTHH:MM[:SS]±HH:MM' (or 'Z') -> { hm: 'HH:MM',
// offsetMin } (minutes east of UTC); null for anything else. The date part is not
// returned: Aladhan writes the requested day even for an Isha past midnight, so
// only the time of day and the offset are reliable.
const ALADHAN_ISO_RE = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;
export function parseAladhanIso(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(ALADHAN_ISO_RE);
  if (!m) return null;
  if (+m[1] > 23 || +m[2] > 59 || (m[3] !== undefined && +m[3] > 59)) return null;
  const offsetMin = m[4] ? (m[4] === '-' ? -1 : 1) * (+m[5] * 60 + +m[6]) : 0;
  if (+m[6] > 59 || Math.abs(offsetMin) > 14 * 60) return null;
  return { hm: `${m[1]}:${m[2]}`, offsetMin: offsetMin || 0 };
}

// Epoch (ms) of the wall-clock 'HH:MM' on the 'YYYY-MM-DD' `day` at a UTC offset of
// `offsetMin` minutes. Pure arithmetic: no tz data involved.
export function epochAtOffset(day, hm, offsetMin) {
  const [y, mo, d] = String(day).split('-').map(Number);
  const [h, mi] = String(hm).split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) - offsetMin * 60000;
}

// The stored times (prayers and Sunrise) that carry Aladhan's UTC offset, earliest
// first. Schedules stored from plain 'H:MM' answers (or by an older version) have none.
function offsetMarks(schedule) {
  if (!schedule) return [];
  return [...(schedule.prayers || []), schedule.sunrise]
    .filter((p) => p && Number.isFinite(p.ts) && Number.isInteger(p.offsetMin))
    .sort((a, b) => a.ts - b.ts);
}

// The location's UTC offset (ms) at `epoch`, for the stored `schedule`. When the
// schedule carries Aladhan's offsets, this browser's tz data for `schedule.tz` is
// used only if it agrees with every one of them (it then also gets a DST switch
// in the night right); otherwise its data is out of date for that zone, and the
// offset of the latest stored time at or before `epoch` is used (the earliest
// one's before them all). Without offsets the zone is read through Intl, and
// without a zone this machine's own offset is used — as before.
export function locationOffsetMs(schedule, epoch = Date.now()) {
  const tz = schedule && schedule.tz;
  const marks = offsetMarks(schedule);
  if (tz && marks.every((p) => zoneOffsetMs(new Date(p.ts), tz) === p.offsetMin * 60000)) {
    const off = zoneOffsetMs(new Date(epoch), tz);
    if (Number.isFinite(off)) return off;
  }
  if (marks.length) {
    let pick = marks[0];
    for (const p of marks) if (p.ts <= epoch) pick = p;
    return pick.offsetMin * 60000;
  }
  return -new Date(epoch).getTimezoneOffset() * 60000;
}

// The location's wall clock at `epoch` as a Date whose UTC fields read it: format
// it with timeZone 'UTC' (or read getUTC*), never with the location's zone.
export function locationClock(schedule, epoch = Date.now()) {
  return new Date(epoch + locationOffsetMs(schedule, epoch));
}

// 'YYYY-MM-DD' at the location at `epoch` (see locationOffsetMs).
export function locationYmd(schedule, epoch = Date.now()) {
  return locationClock(schedule, epoch).toISOString().slice(0, 10);
}

// The location's wall-clock time at `epoch` as 'hh:mm AM', the format of the
// stored prayer times.
export function locationTime12h(schedule, epoch = Date.now()) {
  return hhmmTo12h(locationClock(schedule, epoch).toISOString().slice(11, 16));
}

// How long a schedule dated after the location's today is kept as today's (see
// isNewDay).
export const ROLLOVER_BACK_SLACK_MS = 2 * 60 * 60 * 1000;

// True when the stored schedule is no longer for the location's today, so the day
// is fetched again: the location's date has moved past schedule.date, or is still
// before it ROLLOVER_BACK_SLACK_MS from now (this machine's clock was set back).
// The first hours of the stored day can read as the day before: when the UTC
// offset changed in the night and this browser's tz data is out of date, the new
// day's own offsets are the post-change ones, and refetching the day before would
// flip back and forth until the day's first time.
export function isNewDay(schedule, now = Date.now()) {
  if (!schedule || !schedule.date) return true;
  const today = locationYmd(schedule, now);
  if (today > schedule.date) return true;
  return today < schedule.date && locationYmd(schedule, now + ROLLOVER_BACK_SLACK_MS) < schedule.date;
}

// ---------- pre-prayer revalidation ----------
// Aladhan geocodes the city string server-side, and its answer for the SAME request
// can drift by a minute during the day. Fetching only once a day left the morning
// answer in place until the user pressed Refresh, so today's timings are sampled
// again 45 minutes before each prayer. Any other client sending the same Aladhan
// request should follow this rule too, so all of them sample at the same moment and
// converge on the same answer:
//   - a timer is armed for P - 45 min, P being the next prayer. A re-fetch is due
//     when now is in [P - 45 min, P - 30 min), today's timings were last fetched
//     before P - 50 min (so a fetch just made, or a check re-armed after P itself
//     moved a minute or two, does not fetch again), and no prayer is in the 10
//     minutes after its time. Any later trigger (a periodic tick, a browser start,
//     opening the popup) applies the same check, so a missed timer is caught up
//     any time before P - 30 min;
//   - the request is the daily one (city, country, method, school, state when
//     set, iso8601=true) with the date pinned to the location's today. The answer
//     must carry the five prayers as iso8601 times with their UTC offset (or, from
//     an answer without offsets, all as 24h 'H:MM' with an optional ' (ZONE)'
//     label), Sunrise likewise if present, the expected timezone and the requested
//     date; otherwise it is malformed and the stored times stay;
//   - an identical answer only records the fetch time. A different one replaces
//     the stored times and every alarm is re-armed — unless it would move any of
//     the five prayers across "now" (see revalidationCrossesNow): then the whole
//     answer is rejected, nothing is stored and the armed times stay;
//   - a failed, malformed or rejected attempt is retried once, still before
//     P - 30 min;
//   - a check whose P - 45 min moment falls in the 10 minutes after a prayer (P
//     comes 45 to 55 min after the one before it) is tried again at P - 35 min,
//     the moment other clients retry a check that was held then.
// Consecutive prayers can be less than an hour apart (e.g. Maghrib -> Isha under
// the Jafari or Tehran methods), so the window alone does not keep a changed time
// from crossing "now": the crossing check does, so a prayer never fires twice or
// gets skipped.
export const REVALIDATE_AT_MS = 45 * 60 * 1000;
export const REVALIDATE_FRESH_MS = 50 * 60 * 1000;
export const REVALIDATE_WINDOW_END_MS = 30 * 60 * 1000;
export const REVALIDATE_QUIET_AFTER_MS = 10 * 60 * 1000;
// The one retry of a failed or rejected attempt, and of a check held at P - 45 min
// by the quiet period after a prayer, runs at P - 35 min (see revalidationRetryAt
// and revalidationAlarmAt).
export const REVALIDATE_RETRY_AT_MS = 35 * 60 * 1000;
// Minimum spacing between two attempts (a popup open right after a failed attempt
// doesn't hit the network again).
export const REVALIDATE_MIN_GAP_MS = 2 * 60 * 1000;

// End of the quiet period after one of `prayers` (ts <= now < ts + QUIET), or null
// when none is in it.
export function revalidationQuietUntil(prayers, now = Date.now()) {
  let until = null;
  for (const p of prayers || []) {
    if (!p || !Number.isFinite(p.ts)) continue;
    const end = p.ts + REVALIDATE_QUIET_AFTER_MS;
    if (p.ts <= now && now < end) until = Math.max(until || 0, end);
  }
  return until;
}

// True when `schedule` should be re-fetched for the upcoming `nextPrayer` (see the
// rule above): now is in [ts - AT, ts - WINDOW_END), today's timings were fetched
// before ts - FRESH, and no prayer of `schedule` is in its quiet period. Never for
// a dev test fire.
export function isRevalidationDue(schedule, nextPrayer, now = Date.now()) {
  if (!schedule || !nextPrayer || nextPrayer.test || !Number.isFinite(nextPrayer.ts)) return false;
  if (now < nextPrayer.ts - REVALIDATE_AT_MS || now >= nextPrayer.ts - REVALIDATE_WINDOW_END_MS) return false;
  if ((schedule.fetchedAt || 0) >= nextPrayer.ts - REVALIDATE_FRESH_MS) return false;
  return revalidationQuietUntil(schedule.prayers, now) === null;
}

// When to arm the revalidation timer for `nextPrayer`: ts - AT while that is still
// ahead. Once it has passed, ts - RETRY_AT when the ts - AT moment fell in the
// quiet period after one of `schedule`'s prayers, no attempt was made since then
// (`attemptAt`, the last attempt's time), and the check would be due at ts -
// RETRY_AT. null otherwise, or for a dev test fire. Derived from the stored state
// alone, so re-arming at any time gives the same answer.
export function revalidationAlarmAt(schedule, nextPrayer, now = Date.now(), attemptAt = null) {
  if (!nextPrayer || nextPrayer.test || !Number.isFinite(nextPrayer.ts)) return null;
  const at = nextPrayer.ts - REVALIDATE_AT_MS;
  if (at > now) return at;
  const retryAt = nextPrayer.ts - REVALIDATE_RETRY_AT_MS;
  if (retryAt <= now || !schedule) return null;
  if (revalidationQuietUntil(schedule.prayers, at) === null) return null;
  if (typeof attemptAt === 'number' && attemptAt >= at) return null;
  return isRevalidationDue(schedule, nextPrayer, retryAt) ? retryAt : null;
}

// True when two stored schedules carry the same timings (prayers, Sunrise, date,
// tz). fetchedAt is deliberately ignored.
export function sameTimings(a, b) {
  if (!a || !b || a.date !== b.date || a.tz !== b.tz) return false;
  const pa = a.prayers || [];
  const pb = b.prayers || [];
  if (pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i].name !== pb[i].name || pa[i].time !== pb[i].time || pa[i].ts !== pb[i].ts) return false;
  }
  const sa = a.sunrise || null;
  const sb = b.sunrise || null;
  if (!sa || !sb) return sa === sb;
  return sa.time === sb.time && sa.ts === sb.ts;
}

// Names of the prayers a same-day re-fetch (`next`) would move across `now`
// relative to the stored prayers (`prev`): upcoming (ts >= now) on one side and
// passed on the other. A prayer missing on either side counts as crossing; Sunrise
// is not a prayer and never counts. Any result means the answer is rejected whole
// (see the rule above).
export function revalidationCrossesNow(prev, next, now = Date.now()) {
  const byName = (list) => new Map((list || []).map((p) => [p.name, p]));
  const a = byName(prev);
  const b = byName(next);
  return PRAYER_ORDER.filter((name) => {
    const o = a.get(name);
    const n = b.get(name);
    if (!o || !n || !Number.isFinite(o.ts) || !Number.isFinite(n.ts)) return true;
    return o.ts >= now !== n.ts >= now;
  });
}

// When to retry a failed or rejected revalidation for the prayer at `prayerTs`:
// once, at T-35 (REVALIDATE_RETRY_AT_MS) — the same moment every client using
// this rule retries — or null when the attempt was already at or after T-35.
export function revalidationRetryAt(prayerTs, now = Date.now()) {
  if (!Number.isFinite(prayerTs)) return null;
  const at = prayerTs - REVALIDATE_RETRY_AT_MS;
  return at > now ? at : null;
}

// How late a prayer alarm may fire and still count as "on time". When the device
// sleeps through prayer time, Chrome doesn't run the alarm on schedule — it
// delivers the missed alarm on wake, sometimes many minutes late. Pausing every
// tab and throwing up the full-screen focus overlay (with a fresh auto-resume
// countdown) for a moment that has clearly passed is jarring, so a fire later
// than this is treated as missed. Kept equal to the lateness bound content.js
// uses for its own per-tab fallback pause, so both paths agree on "too late".
export const STALE_FIRE_MS = 90 * 1000;

// True when an alarm scheduled for `scheduledTs` is firing so far past its time
// that it should be treated as missed rather than acted on (see STALE_FIRE_MS).
export function isStaleFire(scheduledTs, now = Date.now(), graceMs = STALE_FIRE_MS) {
  return now - scheduledTs >= graceMs;
}

// A small lead grace below which "early" is just jitter. A correctly-armed alarm
// only ever fires at/after its scheduled time, so this absorbs sub-second skew.
export const PREMATURE_FIRE_MS = 2 * 1000;

// True when an alarm for `scheduledTs` is firing meaningfully BEFORE its time —
// the signature of a spurious delivery: a delayed/duplicate ALARM_PRAYER for a
// prayer that a prior fire (or the content-script fallback) already handled and
// advanced `nextPrayer` past, so the stored nextPrayer now points at a future
// prayer. Never rejects a real fire, whose scheduledTs is <= now.
export function isPrematureFire(scheduledTs, now = Date.now(), leadMs = PREMATURE_FIRE_MS) {
  return scheduledTs - now > leadMs;
}

// Human countdown: "3h 12m" / "5m 30s" / "45s". Clamps negatives to 0.
export function formatCountdown(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Short badge countdown (max 4 chars) for extension toolbar icon:
// "3h", "45m", "1m", "<1m". Clamps <= 0 to empty string.
export const PRAYER_BADGE_COLORS = {
  Fajr: '#1d4ed8',     // Dawn Blue
  Dhuhr: '#eab308',    // Midday Yellow
  Asr: '#d97706',      // Afternoon Amber
  Maghrib: '#be123c',  // Sunset Crimson
  Isha: '#4338ca',     // Night Indigo
};

export const PRAYER_BADGE_TEXT_COLORS = {
  Fajr: '#ffffff',
  Dhuhr: '#000000',
  Asr: '#ffffff',
  Maghrib: '#ffffff',
  Isha: '#ffffff',
};

export function formatBadgeCountdown(ms, { mode = 'auto', manualHours = 2 } = {}) {
  if (ms <= 0) return '';
  if (mode === 'manual' && ms > (manualHours || 2) * 3600 * 1000) return '';
  if (ms < 60 * 1000) return '<1m';
  const m = Math.round(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

// Clean tooltip countdown for hover: "1h 45m" / "45m" / "<1m".
export function formatTooltipCountdown(ms) {
  if (ms <= 0) return '';
  if (ms < 60 * 1000) return '<1m';
  const totalM = Math.round(ms / 60000);
  const h = Math.floor(totalM / 60);
  const m = totalM % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}


