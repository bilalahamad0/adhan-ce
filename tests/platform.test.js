// Cross-OS robustness. The install base spans Windows, macOS, ChromeOS and
// "Other", so the platform-divergent surfaces get explicit coverage:
//   • the toggle-focus keyboard shortcut (Command on macOS, Ctrl elsewhere),
//   • prayer scheduling across Daylight Saving transitions and date rollovers,
//   • time/number formatting that must read identically regardless of host OS.
//
// We pin the timezone to a DST-observing zone for this file so the transition
// cases are real, then restore it so no other suite is affected.
const PREV_TZ = process.env.TZ;
process.env.TZ = 'America/New_York';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ymd, parseTimeToday, buildPrayers, computeNext, hhmmTo12h, formatCountdown, isStaleFire, DAY_MS } from '../lib/schedule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

// True when the active timezone actually shifts between winter and summer.
const OBSERVES_DST = new Date(2026, 0, 1).getTimezoneOffset() !== new Date(2026, 6, 1).getTimezoneOffset();

afterAll(() => {
  if (PREV_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = PREV_TZ;
});

const ALL = { Fajr: '04:27 AM', Dhuhr: '01:05 PM', Asr: '04:56 PM', Maghrib: '08:17 PM', Isha: '09:43 PM' };

describe('cross-OS keyboard shortcut', () => {
  const cmd = manifest.commands['toggle-focus'];

  it('defines a macOS binding distinct from the Windows/Linux/ChromeOS default', () => {
    expect(cmd.suggested_key.default).toBe('Ctrl+Shift+Y');
    expect(cmd.suggested_key.mac).toBe('Command+Shift+Y');
  });

  it('uses key combos Chrome accepts on every platform (modifier + key)', () => {
    for (const combo of Object.values(cmd.suggested_key)) {
      expect(combo).toMatch(/^(Ctrl|Command|MacCtrl|Alt|Option)\+(Shift\+)?[A-Z0-9]$/);
    }
  });
});

describe('content/media coverage spans every site and frame', () => {
  it('injects into all http(s) pages and into sub-frames (iframes)', () => {
    const cs = manifest.content_scripts[0];
    expect(cs.matches).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*']));
    expect(cs.all_frames).toBe(true); // pauses video inside embedded players too
  });
});

describe('Daylight Saving — scheduling stays monotonic and finite', () => {
  // US 2026: spring forward Sun Mar 8 (02:00→03:00), fall back Sun Nov 1 (02:00→01:00).
  const springForward = new Date(2026, 2, 8);
  const fallBack = new Date(2026, 10, 1);

  it('produces finite, strictly increasing times on the spring-forward day', () => {
    const p = buildPrayers(ALL, springForward);
    expect(p).toHaveLength(5);
    for (const x of p) expect(Number.isFinite(x.ts)).toBe(true);
    for (let i = 1; i < p.length; i++) expect(p[i].ts).toBeGreaterThan(p[i - 1].ts);
  });

  it('parses a wall-clock time inside the skipped hour without NaN', () => {
    // 02:30 doesn't exist on this day in a DST zone — JS normalizes it forward.
    const ts = parseTimeToday('02:30 AM', springForward);
    expect(Number.isFinite(ts)).toBe(true);
    if (OBSERVES_DST) expect(new Date(ts).getHours()).toBe(3); // pushed to 03:30
  });

  it('produces finite, strictly increasing times on the fall-back day (repeated hour)', () => {
    const p = buildPrayers(ALL, fallBack);
    for (let i = 1; i < p.length; i++) expect(p[i].ts).toBeGreaterThan(p[i - 1].ts);
    expect(Number.isFinite(parseTimeToday('01:30 AM', fallBack))).toBe(true);
  });

  it('still selects the correct next prayer across a DST day', () => {
    const p = buildPrayers(ALL, springForward);
    const afterDhuhr = new Date(2026, 2, 8, 14, 0).getTime();
    expect(computeNext(p, afterDhuhr).name).toBe('Asr');
  });
});

describe('date rollover (month/year boundaries + after Isha)', () => {
  it('formats local dates without drift at boundaries', () => {
    expect(ymd(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(ymd(new Date(2025, 11, 31))).toBe('2025-12-31');
  });

  it('rolls the schedule over to tomorrow\'s Fajr after the last prayer', () => {
    const p = buildPrayers(ALL, new Date(2026, 11, 31, 0, 0));
    const next = computeNext(p, new Date(2026, 11, 31, 23, 30).getTime());
    expect(next.name).toBe('Fajr');
    expect(next.ts).toBe(p[0].ts + DAY_MS); // next calendar day, even across year-end
  });
});

describe('OS-independent formatting', () => {
  it('12-hour conversion is identical regardless of host locale/OS', () => {
    expect(hhmmTo12h('00:00')).toBe('12:00 AM');
    expect(hhmmTo12h('13:05')).toBe('01:05 PM');
    expect(hhmmTo12h('23:59')).toBe('11:59 PM');
  });

  it('countdown buckets are stable and clamp negatives', () => {
    expect(formatCountdown(3 * 3600e3 + 12 * 60e3)).toBe('3h 12m');
    expect(formatCountdown(-1)).toBe('0s');
  });

  it('the sleep/wake stale-fire guard is a pure time delta (no OS clock quirks)', () => {
    // A device that slept through prayer time delivers the alarm late on wake;
    // the guard is identical on every OS because it is wall-clock arithmetic.
    expect(isStaleFire(1_000_000, 1_000_000 + 89_000)).toBe(false);
    expect(isStaleFire(1_000_000, 1_000_000 + 91_000)).toBe(true);
  });
});
