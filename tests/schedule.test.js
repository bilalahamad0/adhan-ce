import {
  ymd,
  parseTimeToday,
  buildPrayers,
  computeNext,
  formatCountdown,
  hhmmTo12h,
  isStaleFire,
  STALE_FIRE_MS,
  PRAYER_ORDER,
  DAY_MS,
} from '../lib/schedule.js';

const ALL = { Fajr: '04:27 AM', Dhuhr: '01:05 PM', Asr: '04:56 PM', Maghrib: '08:17 PM', Isha: '09:43 PM' };
const BASE = new Date(2026, 4, 23); // 2026-05-23, local

describe('ymd', () => {
  it('formats local date as zero-padded YYYY-MM-DD', () => {
    expect(ymd(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(ymd(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('parseTimeToday', () => {
  it('parses AM and PM', () => {
    expect(new Date(parseTimeToday('05:00 AM', BASE)).getHours()).toBe(5);
    expect(new Date(parseTimeToday('06:30 PM', BASE)).getHours()).toBe(18);
    expect(new Date(parseTimeToday('06:30 PM', BASE)).getMinutes()).toBe(30);
  });
  it('treats 12 AM as midnight and 12 PM as noon', () => {
    expect(new Date(parseTimeToday('12:00 AM', BASE)).getHours()).toBe(0);
    expect(new Date(parseTimeToday('12:00 PM', BASE)).getHours()).toBe(12);
  });
  it('is case-insensitive and tolerant of spacing', () => {
    expect(new Date(parseTimeToday('7:05 pm', BASE)).getHours()).toBe(19);
  });
  it('anchors to the base date', () => {
    const d = new Date(parseTimeToday('01:05 PM', BASE));
    expect(ymd(d)).toBe('2026-05-23');
  });
  it('returns null for malformed input', () => {
    expect(parseTimeToday('not a time', BASE)).toBeNull();
    expect(parseTimeToday('13:00', BASE)).toBeNull(); // missing AM/PM
    expect(parseTimeToday('', BASE)).toBeNull();
  });
});

describe('buildPrayers', () => {
  it('builds ordered, timestamped entries', () => {
    const p = buildPrayers(ALL, BASE);
    expect(p.map((x) => x.name)).toEqual(PRAYER_ORDER);
    expect(p[0].ts).toBeLessThan(p[4].ts);
    expect(p[0].time).toBe('04:27 AM');
  });
  it('skips missing prayers and tolerates empty input', () => {
    expect(buildPrayers({ Fajr: '04:27 AM' }, BASE).map((x) => x.name)).toEqual(['Fajr']);
    expect(buildPrayers(undefined, BASE)).toEqual([]);
    expect(buildPrayers({}, BASE)).toEqual([]);
  });
});

describe('computeNext', () => {
  const prayers = buildPrayers(ALL, BASE);
  it('returns the first prayer strictly after the reference time', () => {
    const noon = new Date(2026, 4, 23, 12, 0).getTime();
    expect(computeNext(prayers, noon).name).toBe('Dhuhr');
    const earlyMorning = new Date(2026, 4, 23, 1, 0).getTime();
    expect(computeNext(prayers, earlyMorning).name).toBe('Fajr');
  });
  it('rolls over to tomorrow Fajr after the last prayer', () => {
    const lateNight = new Date(2026, 4, 23, 23, 0).getTime();
    const next = computeNext(prayers, lateNight);
    expect(next.name).toBe('Fajr');
    expect(next.ts).toBe(prayers[0].ts + DAY_MS);
  });
  it('returns null for an empty schedule', () => {
    expect(computeNext([], Date.now())).toBeNull();
  });
});

describe('isStaleFire', () => {
  const t = 1_700_000_000_000; // fixed reference instant
  it('treats an on-time or slightly-late fire as fresh', () => {
    expect(isStaleFire(t, t)).toBe(false); // exactly on time
    expect(isStaleFire(t, t + 1000)).toBe(false); // 1s late
    expect(isStaleFire(t, t + STALE_FIRE_MS - 1)).toBe(false); // just under the bound
  });
  it('treats a fire well past its scheduled time as stale (device woke from sleep)', () => {
    expect(isStaleFire(t, t + STALE_FIRE_MS)).toBe(true); // at the bound
    expect(isStaleFire(t, t + 11 * 60 * 1000)).toBe(true); // reported 11-min sleep
  });
  it('honors a custom grace window', () => {
    expect(isStaleFire(0, 5000, 10000)).toBe(false);
    expect(isStaleFire(0, 15000, 10000)).toBe(true);
  });
});

describe('default base date', () => {
  it('falls back to "now" when base is omitted', () => {
    expect(typeof ymd()).toBe('string');
    expect(parseTimeToday('12:00 PM')).toEqual(expect.any(Number));
    expect(buildPrayers(ALL).length).toBe(5);
  });
});

describe('formatCountdown', () => {
  it('formats h/m/s buckets', () => {
    expect(formatCountdown(3 * 3600e3 + 12 * 60e3)).toBe('3h 12m');
    expect(formatCountdown(5 * 60e3 + 30e3)).toBe('5m 30s');
    expect(formatCountdown(45e3)).toBe('45s');
  });
  it('clamps negatives to 0s', () => {
    expect(formatCountdown(-5000)).toBe('0s');
  });
});

describe('hhmmTo12h', () => {
  it('converts 24h HH:mm to 12h hh:mm a (matches live Aladhan values)', () => {
    expect(hhmmTo12h('04:20')).toBe('04:20 AM');
    expect(hhmmTo12h('05:49')).toBe('05:49 AM');
    expect(hhmmTo12h('13:06')).toBe('01:06 PM');
    expect(hhmmTo12h('20:24')).toBe('08:24 PM');
    expect(hhmmTo12h('21:53')).toBe('09:53 PM');
  });
  it('handles midnight and noon boundaries', () => {
    expect(hhmmTo12h('00:00')).toBe('12:00 AM');
    expect(hhmmTo12h('00:06')).toBe('12:06 AM');
    expect(hhmmTo12h('12:00')).toBe('12:00 PM');
  });
  it('passes through non-HH:mm input unchanged (already 12h or invalid)', () => {
    expect(hhmmTo12h('08:24 PM')).toBe('08:24 PM');
    expect(hhmmTo12h('not a time')).toBe('not a time');
  });
  it('round-trips through parseTimeToday for scheduling', () => {
    const ts = parseTimeToday(hhmmTo12h('20:24'), BASE);
    expect(new Date(ts).getHours()).toBe(20);
    expect(new Date(ts).getMinutes()).toBe(24);
  });
});
