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

// Offset (ms) of `tz` at the instant `date`: (wall-clock read as UTC) - actual UTC.
// e.g. for America/Los_Angeles in summer this is -7h. Pure (Intl only).
export function tzOffsetMs(date, tz) {
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
    return 0;
  }
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

// First prayer after fromTs; rolls over to tomorrow's Fajr when the day is done.
export function computeNext(prayers, fromTs) {
  for (const p of prayers) {
    if (p.ts > fromTs) return { name: p.name, time: p.time, ts: p.ts };
  }
  const fajr = (prayers || []).find((p) => p.name === 'Fajr');
  return fajr ? { name: 'Fajr', time: fajr.time, ts: fajr.ts + DAY_MS } : null;
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
