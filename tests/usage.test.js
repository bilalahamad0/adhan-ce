// usage: pure local-only usage-counter helpers (bump, prune, recent, activeDays).
import { USAGE_EVENTS, emptyUsage, bump, prune, recent, activeDays } from '../lib/usage.js';

describe('usage helpers', () => {
  it('emptyUsage seeds every event at zero with no per-day buckets', () => {
    const u = emptyUsage();
    expect(u.perDay).toEqual({});
    for (const e of USAGE_EVENTS) expect(u.totals[e]).toBe(0);
  });

  it('bump increments the total + the per-day bucket without mutating the input', () => {
    const u0 = emptyUsage();
    const u1 = bump(u0, 'pauses', '2026-06-04');
    expect(u1.totals.pauses).toBe(1);
    expect(u1.perDay['2026-06-04'].pauses).toBe(1);
    expect(u0.totals.pauses).toBe(0); // original untouched

    const u2 = bump(bump(u1, 'pauses', '2026-06-04'), 'notifications', '2026-06-04');
    expect(u2.totals.pauses).toBe(2);
    expect(u2.totals.notifications).toBe(1);
    expect(u2.perDay['2026-06-04']).toEqual({ pauses: 2, notifications: 1 });
  });

  it('bump tolerates a missing/legacy object and ignores unknown events', () => {
    expect(bump(null, 'pauses', '2026-06-04').totals.pauses).toBe(1);
    expect(bump(undefined, 'bogus', '2026-06-04')).toEqual(emptyUsage()); // unknown event: no-op
    // A partial legacy shape keeps existing counts and fills the rest with zeros.
    const u = bump({ totals: { pauses: 5 } }, 'pauses', '2026-06-04');
    expect(u.totals.pauses).toBe(6);
    expect(u.totals.resumes).toBe(0);
  });

  it('recent sums an event across the trailing window, inclusive of today', () => {
    let u = emptyUsage();
    u = bump(u, 'pauses', '2026-06-04'); // today
    u = bump(u, 'pauses', '2026-05-30'); // within a 7-day window
    u = bump(u, 'pauses', '2026-05-28'); // outside a 7-day window
    expect(recent(u, 'pauses', '2026-06-04', 7)).toBe(2);
    expect(recent(u, 'pauses', '2026-06-04', 30)).toBe(3);
    expect(recent(u, 'notifications', '2026-06-04', 7)).toBe(0);
  });

  it('recent tolerates a corrupt (non-object) day bucket instead of throwing', () => {
    const u = { totals: {}, perDay: { '2026-06-04': null, '2026-06-03': { pauses: 2 } } };
    expect(() => recent(u, 'pauses', '2026-06-04', 7)).not.toThrow();
    expect(recent(u, 'pauses', '2026-06-04', 7)).toBe(2); // bad bucket skipped, good one counted
  });

  it('prune drops per-day buckets older than the cap but keeps cumulative totals', () => {
    let u = emptyUsage();
    u = bump(u, 'pauses', '2026-06-04');
    u = bump(u, 'pauses', '2026-01-01'); // long ago
    const p = prune(u, '2026-06-04', 90);
    expect(p.perDay['2026-06-04']).toBeTruthy();
    expect(p.perDay['2026-01-01']).toBeUndefined(); // pruned out of the window
    expect(p.totals.pauses).toBe(2); // totals are never pruned
  });

  it('prune keeps the day exactly `cap` days old and drops the one beyond it', () => {
    let u = emptyUsage();
    u = bump(u, 'pauses', '2026-06-10'); // today
    u = bump(u, 'pauses', '2026-06-07'); // today - 3 = the floor when cap=3
    u = bump(u, 'pauses', '2026-06-06'); // today - 4 = beyond the cap
    const p = prune(u, '2026-06-10', 3);
    expect(p.perDay['2026-06-10']).toBeTruthy();
    expect(p.perDay['2026-06-07']).toBeTruthy(); // boundary day is retained
    expect(p.perDay['2026-06-06']).toBeUndefined(); // one day beyond is dropped
  });

  it('activeDays counts distinct days that have any activity', () => {
    let u = emptyUsage();
    expect(activeDays(u)).toBe(0);
    u = bump(u, 'pauses', '2026-06-04');
    u = bump(u, 'notifications', '2026-06-04'); // same day
    u = bump(u, 'pauses', '2026-06-03');
    expect(activeDays(u)).toBe(2);
  });
});
