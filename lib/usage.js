// Pure, unit-testable helpers for LOCAL-ONLY usage counters. No chrome.* / DOM /
// network access (mirrors lib/tracker.js), so they run under Node/Jest. Everything
// computed here lives in chrome.storage.local and is shown only to the user in the
// popup — it is NEVER transmitted off the device, so it is not analytics/tracking.
// Shape:
//   { totals: { pauses, resumes, notifications, focusUsed },
//     perDay: { 'YYYY-MM-DD': { pauses?, resumes?, notifications?, focusUsed? } } }
import { ymd } from './schedule.js';

// The closed set of events we count. Keeping it fixed lets the popup map each to a
// known, localized label and keeps unrelated keys out of storage.
export const USAGE_EVENTS = ['pauses', 'resumes', 'notifications', 'focusUsed'];

export function emptyUsage() {
  const totals = {};
  for (const e of USAGE_EVENTS) totals[e] = 0;
  return { totals, perDay: {} };
}

// Normalize a possibly-missing or legacy/partial stored object into a full usage
// shape without dropping any counts it already holds.
function coerce(usage) {
  const base = emptyUsage();
  if (!usage || typeof usage !== 'object') return base;
  return { totals: { ...base.totals, ...(usage.totals || {}) }, perDay: { ...(usage.perDay || {}) } };
}

// Increment one event by `n` (default 1). Returns a NEW object (no mutation), so
// it's trivial to test and reason about. Unknown events are ignored.
export function bump(usage, event, today = ymd(), n = 1) {
  const u = coerce(usage);
  if (!USAGE_EVENTS.includes(event)) return u;
  const day = { ...(u.perDay[today] || {}) };
  day[event] = (day[event] || 0) + n;
  return {
    totals: { ...u.totals, [event]: (u.totals[event] || 0) + n },
    perDay: { ...u.perDay, [today]: day },
  };
}

// Drop per-day buckets older than `cap` days so storage stays bounded; the
// cumulative totals are kept. Keeps `today` plus the previous `cap` days (a day
// exactly `cap` days old is "not older than cap" and is retained). YYYY-MM-DD
// sorts chronologically, so a string compare is enough.
export function prune(usage, today = ymd(), cap = 90) {
  const u = coerce(usage);
  const floor = nDaysAgo(today, cap);
  const perDay = {};
  for (const d in u.perDay) if (d >= floor) perDay[d] = u.perDay[d];
  return { totals: u.totals, perDay };
}

// Sum one event over the trailing `days` days, inclusive of today. Tolerates a
// non-object day bucket (e.g. hand-edited/corrupt storage) by skipping it rather
// than throwing — the recorder swallows errors, but the popup reads this directly.
export function recent(usage, event, today = ymd(), days = 7) {
  const u = coerce(usage);
  const floor = nDaysAgo(today, days - 1);
  let n = 0;
  for (const d in u.perDay) {
    const b = u.perDay[d];
    if (b && typeof b === 'object' && d >= floor && d <= today) n += b[event] || 0;
  }
  return n;
}

// How many distinct days have any recorded activity — an engagement signal.
export function activeDays(usage) {
  return Object.keys(coerce(usage).perDay).length;
}

// `days` calendar days before `today` (YYYY-MM-DD). Anchored at noon so it's
// DST-safe — same convention as lib/tracker.js.
function nDaysAgo(today, days) {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - days);
  return ymd(d);
}
