// Pure helpers for the prayer-tracking log. No chrome.* / DOM access, so they're
// unit-testable under Node/Jest. The log shape is
//   { 'YYYY-MM-DD': { Fajr: true, Asr: true, ... } }
// holding only the prayers the user actually marked for each day.
import { PRAYER_ORDER, ymd } from './schedule.js';

// How many of the five prayers are marked for a given day.
export function dayCount(log, date) {
  const d = (log && log[date]) || {};
  return PRAYER_ORDER.reduce((n, p) => (d[p] ? n + 1 : n), 0);
}

// Total prayers marked across every day in the log.
export function totalLogged(log) {
  let n = 0;
  for (const date in log || {}) n += dayCount(log, date);
  return n;
}

// The day before `date` (YYYY-MM-DD). Anchored at noon so it's DST-safe.
export function prevYmd(date) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return ymd(d);
}

// Consecutive days with all five prayers marked, counting back from `today`. A
// not-yet-complete today doesn't break the streak — it's measured up to yesterday
// instead, so the count only grows (never dips mid-day then recovers).
export function completeStreak(log, today = ymd()) {
  const FULL = PRAYER_ORDER.length;
  let date = dayCount(log, today) === FULL ? today : prevYmd(today);
  let streak = 0;
  while (dayCount(log, date) === FULL) {
    streak += 1;
    date = prevYmd(date);
  }
  return streak;
}

// Dates from `today` back to `fromDate` inclusive, most-recent first, capped so a
// long-installed user's history view stays bounded. String compare works because
// YYYY-MM-DD sorts chronologically.
export function historyDates(fromDate, today = ymd(), cap = 90) {
  const floor = fromDate && fromDate <= today ? fromDate : today;
  const out = [];
  let date = today;
  while (date >= floor && out.length < cap) {
    out.push(date);
    date = prevYmd(date);
  }
  return out;
}
