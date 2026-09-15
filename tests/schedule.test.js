import {
  ymd,
  ymdInTz,
  zonedToEpoch,
  parseTimeToday,
  buildPrayers,
  computeNext,
  formatCountdown,
  formatBadgeCountdown,
  formatTooltipCountdown,
  hhmmTo12h,
  isStaleFire,
  STALE_FIRE_MS,
  isPrematureFire,
  PREMATURE_FIRE_MS,
  PRAYER_ORDER,
  DAY_MS,
  PRAYER_BADGE_COLORS,
  PRAYER_BADGE_TEXT_COLORS,
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

describe('isPrematureFire', () => {
  const t = 1_700_000_000_000; // fixed reference instant
  it('never flags an on-time or late fire (scheduledTs <= now)', () => {
    expect(isPrematureFire(t, t)).toBe(false); // exactly on time
    expect(isPrematureFire(t, t + 1000)).toBe(false); // fired late
    expect(isPrematureFire(t, t - PREMATURE_FIRE_MS)).toBe(false); // within the lead grace
  });
  it('flags a fire whose prayer time is still meaningfully in the future', () => {
    expect(isPrematureFire(t, t - PREMATURE_FIRE_MS - 1)).toBe(true); // just past the lead
    expect(isPrematureFire(t + 3 * 3600e3, t)).toBe(true); // an advanced (next) prayer hours away
  });
  it('honors a custom lead grace', () => {
    expect(isPrematureFire(15000, 5000, 10000)).toBe(false); // 10s early == the grace, not over
    expect(isPrematureFire(16000, 5000, 10000)).toBe(true); // 11s early, over the grace
  });
});

describe('default base date', () => {
  it('falls back to "now" when base is omitted', () => {
    expect(typeof ymd()).toBe('string');
    expect(parseTimeToday('12:00 PM')).toEqual(expect.any(Number));
    expect(buildPrayers(ALL).length).toBe(5);
  });
});

describe('timezone-aware scheduling (location tz)', () => {
  it('ymdInTz reads the calendar date in the given zone', () => {
    const t = new Date('2026-06-05T05:00:00Z'); // 22:00 (prev day) in LA, 14:00 in Tokyo
    expect(ymdInTz('America/Los_Angeles', t)).toBe('2026-06-04');
    expect(ymdInTz('Asia/Tokyo', t)).toBe('2026-06-05');
    expect(ymdInTz(null, new Date(2026, 0, 5))).toBe('2026-01-05'); // falls back to local
  });

  it('zonedToEpoch / parseTimeToday anchor wall-clock time to the zone (DST-aware)', () => {
    // 04:30 in Los Angeles on 2026-06-05 is PDT (UTC-7) → 11:30 UTC.
    expect(new Date(zonedToEpoch(2026, 6, 5, 4, 30, 'America/Los_Angeles')).toISOString()).toBe('2026-06-05T11:30:00.000Z');
    const la = parseTimeToday('04:30 AM', new Date('2026-06-05T18:00:00Z'), 'America/Los_Angeles');
    expect(new Date(la).toISOString()).toBe('2026-06-05T11:30:00.000Z');
    // 06:00 in Tokyo (UTC+9, no DST) on 2026-06-05 → 21:00 UTC the day before.
    const tk = parseTimeToday('06:00 AM', new Date('2026-06-05T00:00:00Z'), 'Asia/Tokyo');
    expect(new Date(tk).toISOString()).toBe('2026-06-04T21:00:00.000Z');
  });

  it('picks the correct next prayer for a location in another timezone (regression: remote city)', () => {
    // Machine could be anywhere; the location is in PDT. At 10:00 PDT, Fajr has
    // passed and Dhuhr is next — even if the machine clock reads a different tz.
    const now = new Date('2026-06-05T17:00:00Z'); // 10:00 PDT
    const prayers = buildPrayers(
      { Fajr: '04:19 AM', Dhuhr: '01:07 PM', Asr: '04:59 PM', Maghrib: '08:25 PM', Isha: '09:55 PM' },
      now,
      'America/Los_Angeles'
    );
    expect(computeNext(prayers, now.getTime()).name).toBe('Dhuhr');
    // sanity: Fajr's epoch really is before "now"
    expect(prayers[0].ts).toBeLessThan(now.getTime());
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

describe('formatBadgeCountdown', () => {
  it('formats hours (>= 1h)', () => {
    expect(formatBadgeCountdown(3 * 3600e3 + 12 * 60e3)).toBe('3h');
    expect(formatBadgeCountdown(12 * 3600e3)).toBe('12h');
    expect(formatBadgeCountdown(1 * 3600e3)).toBe('1h');
  });
  it('formats minutes (1m to 59m)', () => {
    expect(formatBadgeCountdown(59 * 60e3)).toBe('59m');
    expect(formatBadgeCountdown(5 * 60e3)).toBe('5m');
    expect(formatBadgeCountdown(1 * 60e3)).toBe('1m');
  });
  it('formats sub-minute (< 1m)', () => {
    expect(formatBadgeCountdown(45e3)).toBe('<1m');
    expect(formatBadgeCountdown(1000)).toBe('<1m');
  });
  it('clamps zero and negatives to empty string', () => {
    expect(formatBadgeCountdown(0)).toBe('');
    expect(formatBadgeCountdown(-5000)).toBe('');
  });
  it('supports manual mode hold-off threshold', () => {
    // 3 hours away with 2-hour manual threshold -> suppressed
    expect(formatBadgeCountdown(3 * 3600e3, { mode: 'manual', manualHours: 2 })).toBe('');
    // 1h 45m away with 2-hour manual threshold -> shows countdown (1h)
    expect(formatBadgeCountdown(1 * 3600e3 + 45 * 60e3, { mode: 'manual', manualHours: 2 })).toBe('1h');
    expect(formatBadgeCountdown(45 * 60e3, { mode: 'manual', manualHours: 2 })).toBe('45m');
    // auto mode never suppresses
    expect(formatBadgeCountdown(3 * 3600e3, { mode: 'auto', manualHours: 2 })).toBe('3h');
  });

  it('handles 5-hour Countdown window for consecutive prayer deltas (Asr -> Maghrib, Maghrib -> Isha)', () => {
    const asrToMaghribMs = (3 * 3600 + 21 * 60) * 1000; // 3h 21m
    const maghribToIshaMs = (1 * 3600 + 26 * 60) * 1000; // 1h 26m
    const ishaToFajrMs = (6 * 3600 + 44 * 60) * 1000;    // 6h 44m

    // Asr -> Maghrib (3h 21m) is within 5h -> immediately active (no gap)
    expect(formatBadgeCountdown(asrToMaghribMs, { mode: 'manual', manualHours: 5 })).toBe('3h');

    // Maghrib -> Isha (1h 26m) is within 5h -> immediately active (no gap)
    expect(formatBadgeCountdown(maghribToIshaMs, { mode: 'manual', manualHours: 5 })).toBe('1h');

    // Isha -> Fajr (6h 44m) exceeds 5h -> held off (blank)
    expect(formatBadgeCountdown(ishaToFajrMs, { mode: 'manual', manualHours: 5 })).toBe('');

    // Once within 5h threshold (e.g. 4h 30m) -> activates
    expect(formatBadgeCountdown(4 * 3600e3 + 30 * 60e3, { mode: 'manual', manualHours: 5 })).toBe('4h');
  });
});

describe('PRAYER_BADGE_COLORS', () => {
  it('defines distinct atmospheric colors with Maghrib as Crimson and Dhuhr as Yellow', () => {
    expect(PRAYER_BADGE_COLORS.Maghrib).toBe('#be123c'); // Crimson
    expect(PRAYER_BADGE_COLORS.Fajr).toBe('#1d4ed8');    // Dawn Blue
    expect(PRAYER_BADGE_COLORS.Dhuhr).toBe('#eab308');   // Midday Yellow
    expect(PRAYER_BADGE_COLORS.Asr).toBe('#d97706');     // Afternoon Amber
    expect(PRAYER_BADGE_COLORS.Isha).toBe('#4338ca');    // Night Indigo

    expect(PRAYER_BADGE_TEXT_COLORS.Dhuhr).toBe('#000000'); // High contrast black on yellow
    expect(PRAYER_BADGE_TEXT_COLORS.Maghrib).toBe('#ffffff');
  });
});

describe('formatTooltipCountdown', () => {
  it('formats hours and minutes', () => {
    expect(formatTooltipCountdown(1 * 3600e3 + 45 * 60e3)).toBe('1h 45m');
    expect(formatTooltipCountdown(2 * 3600e3)).toBe('2h');
  });
  it('formats minutes', () => {
    expect(formatTooltipCountdown(45 * 60e3)).toBe('45m');
    expect(formatTooltipCountdown(5 * 60e3)).toBe('5m');
  });
  it('formats sub-minute', () => {
    expect(formatTooltipCountdown(30e3)).toBe('<1m');
  });
  it('clamps zero and negatives to empty string', () => {
    expect(formatTooltipCountdown(0)).toBe('');
    expect(formatTooltipCountdown(-5000)).toBe('');
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
