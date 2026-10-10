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
  REVALIDATE_AT_MS,
  REVALIDATE_FRESH_MS,
  REVALIDATE_WINDOW_END_MS,
  REVALIDATE_QUIET_AFTER_MS,
  isRevalidationDue,
  revalidationAlarmAt,
  revalidationQuietUntil,
  parseAladhanTime,
  prayerAdjustments,
  shiftHm,
  keepCrossingPrayers,
  ADJUST_LIMIT_MIN,
  sameTimings,
  revalidationCrossesNow,
  revalidationRetryAt,
  REVALIDATE_RETRY_AT_MS,
  REVALIDATE_MIN_GAP_MS,
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
    expect(computeNext(null, Date.now())).toBeNull();
    expect(computeNext([{ name: 'Fajr', time: '04:27 AM', ts: null }], Date.now())).toBeNull();
  });

  // A schedule left over from an earlier day (the day-start fetch failed): the
  // rollover must still land strictly after fromTs, or the prayer alarm handler —
  // which asks for the prayer after the one that just fired — gets the same Fajr
  // back and fires it again.
  it('always rolls over to a prayer strictly after fromTs, adding whole days', () => {
    const fajr = prayers[0].ts;
    // Yesterday's schedule, asked right after "today's" Fajr fired (fajr + 1 day).
    const firedTs = fajr + DAY_MS;
    expect(computeNext(prayers, firedTs + 1000).ts).toBeGreaterThan(firedTs + 1000);
    // Exactly at the rolled-over Fajr: strictly after it.
    expect(computeNext(prayers, firedTs).ts).toBeGreaterThan(firedTs);
    // Just before it: that Fajr is still ahead.
    expect(computeNext(prayers, firedTs - 1)).toEqual({ name: 'Fajr', time: '04:27 AM', ts: firedTs });
    for (const from of [firedTs, firedTs + 1, fajr + 4 * DAY_MS + 3 * 3600e3, fajr + 10 * DAY_MS]) {
      expect(computeNext(prayers, from).ts).toBeGreaterThan(from);
    }
  });

  // ...and it must keep the rest of that day: today's Dhuhr..Isha at the stored
  // day's times (a minute or two off at most), not jump to the next day's Fajr.
  it('on a schedule from an earlier day, walks through today\'s prayers at the stored times', () => {
    const at = (i, days) => prayers[i].ts + days * DAY_MS;
    let from = at(0, 1) + 1000; // today's Fajr just fired
    const seen = [];
    for (let i = 0; i < 6; i++) {
      const next = computeNext(prayers, from);
      seen.push([next.name, next.ts]);
      from = next.ts + 1000;
    }
    expect(seen).toEqual([
      ['Dhuhr', at(1, 1)],
      ['Asr', at(2, 1)],
      ['Maghrib', at(3, 1)],
      ['Isha', at(4, 1)],
      ['Fajr', at(0, 2)],
      ['Dhuhr', at(1, 2)],
    ]);
    // A schedule several days old: the next prayer after fromTs, whole days later.
    expect(computeNext(prayers, at(0, 4) + 3 * 3600e3)).toEqual({ name: 'Dhuhr', time: '01:05 PM', ts: at(1, 4) });
    expect(computeNext(prayers, at(4, 4) + 1)).toEqual({ name: 'Fajr', time: '04:27 AM', ts: at(0, 5) });
  });

  it('skips entries without a time when rolling over', () => {
    const partial = [{ name: 'Fajr', time: '04:27 AM', ts: null }, ...prayers.slice(1)];
    const lateNight = new Date(2026, 4, 23, 23, 0).getTime();
    expect(computeNext(partial, lateNight)).toEqual({ name: 'Dhuhr', time: '01:05 PM', ts: prayers[1].ts + DAY_MS });
  });
});

describe('parseAladhanTime', () => {
  it("accepts 24h 'H:MM' / 'HH:MM', with or without a ' (ZONE)' label", () => {
    expect(parseAladhanTime('05:40')).toBe('05:40');
    expect(parseAladhanTime('5:40')).toBe('05:40');
    expect(parseAladhanTime('00:00')).toBe('00:00');
    expect(parseAladhanTime('23:59')).toBe('23:59');
    expect(parseAladhanTime('16:17 (PDT)')).toBe('16:17');
    expect(parseAladhanTime('04:05 (+03)')).toBe('04:05');
  });
  it('rejects anything else', () => {
    for (const bad of ['24:00', '12:60', '4:56 PM', '05:40 ', ' 05:40', '05:40(PDT)', '05:40 (PDT) x', '05:40 ()', '5:4', '0540', '', '--:--', 'soon']) {
      expect(parseAladhanTime(bad)).toBeNull();
    }
    expect(parseAladhanTime(undefined)).toBeNull();
    expect(parseAladhanTime(null)).toBeNull();
    expect(parseAladhanTime(540)).toBeNull();
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

describe('pre-prayer revalidation', () => {
  const MIN = 60 * 1000;
  // Asr at a fixed instant: sampled at Asr - 45m, due in [Asr - 45m, Asr - 30m).
  const ASR = 1_790_000_000_000;
  const asr = { name: 'Asr', time: '04:17 PM', ts: ASR };
  const dhuhr = { name: 'Dhuhr', time: '12:50 PM', ts: ASR - 207 * MIN };
  const morning = { date: '2026-10-03', prayers: [dhuhr, asr], fetchedAt: ASR - 8 * 60 * MIN };

  it('samples at T-45, fresh since T-50, window ends at T-30, quiet for 10 min after a prayer', () => {
    expect(REVALIDATE_AT_MS).toBe(45 * MIN);
    expect(REVALIDATE_FRESH_MS).toBe(50 * MIN);
    expect(REVALIDATE_WINDOW_END_MS).toBe(30 * MIN);
    expect(REVALIDATE_QUIET_AFTER_MS).toBe(10 * MIN);
  });

  describe('isRevalidationDue', () => {
    it('is due from T-45 (inclusive) to T-30 (exclusive)', () => {
      expect(isRevalidationDue(morning, asr, ASR - 45 * MIN)).toBe(true); // the sampling moment
      expect(isRevalidationDue(morning, asr, ASR - 40 * MIN)).toBe(true);
      expect(isRevalidationDue(morning, asr, ASR - 30 * MIN - 1)).toBe(true);
    });

    it('is not due outside the window', () => {
      expect(isRevalidationDue(morning, asr, ASR - 45 * MIN - 1)).toBe(false); // too early
      expect(isRevalidationDue(morning, asr, ASR - 60 * MIN)).toBe(false);
      expect(isRevalidationDue(morning, asr, ASR - 30 * MIN)).toBe(false); // window end is exclusive
      expect(isRevalidationDue(morning, asr, ASR + MIN)).toBe(false); // prayer passed
    });

    it('is not due when today was fetched at or after T-50', () => {
      const now = ASR - 40 * MIN;
      expect(isRevalidationDue({ ...morning, fetchedAt: ASR - 50 * MIN }, asr, now)).toBe(false);
      expect(isRevalidationDue({ ...morning, fetchedAt: ASR - 45 * MIN }, asr, now)).toBe(false); // just fetched
      expect(isRevalidationDue({ ...morning, fetchedAt: ASR - 50 * MIN - 1 }, asr, now)).toBe(true);
      expect(isRevalidationDue({ date: '2026-10-03' }, asr, now)).toBe(true); // no fetchedAt recorded
    });

    it('does not fetch again after a re-fetch moved the prayer by a minute or two', () => {
      // Fetched at T-45 of the old Asr; the answer moved Asr 2 min later, and the
      // re-armed check fires at the new T-45.
      const fetchedAt = ASR - 45 * MIN;
      const moved = { ...asr, ts: ASR + 2 * MIN };
      expect(isRevalidationDue({ ...morning, fetchedAt }, moved, moved.ts - 45 * MIN)).toBe(false);
      const earlier = { ...asr, ts: ASR - 2 * MIN };
      expect(isRevalidationDue({ ...morning, fetchedAt }, earlier, fetchedAt + MIN)).toBe(false);
    });

    it('is not due within 10 minutes after any prayer', () => {
      // Maghrib 45 min before Isha (Tehran-style): Isha's window overlaps Maghrib's quiet period.
      const isha = { name: 'Isha', time: '07:30 PM', ts: ASR + 3 * 60 * MIN };
      const maghrib = { name: 'Maghrib', time: '06:45 PM', ts: isha.ts - 45 * MIN };
      const sched = { date: '2026-10-03', prayers: [dhuhr, asr, maghrib, isha], fetchedAt: ASR - 8 * 60 * MIN };
      expect(isRevalidationDue(sched, isha, maghrib.ts)).toBe(false); // T-45, Maghrib just started
      expect(isRevalidationDue(sched, isha, maghrib.ts + 10 * MIN - 1)).toBe(false);
      expect(isRevalidationDue(sched, isha, maghrib.ts + 10 * MIN)).toBe(true); // quiet over, still before T-30
    });

    it('is never due without a schedule / next prayer, or for a dev test fire', () => {
      const now = ASR - 45 * MIN;
      expect(isRevalidationDue(null, asr, now)).toBe(false);
      expect(isRevalidationDue(morning, null, now)).toBe(false);
      expect(isRevalidationDue(morning, { ...asr, test: true }, now)).toBe(false);
      expect(isRevalidationDue(morning, { name: 'Asr' }, now)).toBe(false); // no ts
    });

    it('defaults now to Date.now()', () => {
      const soon = { name: 'Asr', time: '04:17 PM', ts: Date.now() + 40 * MIN };
      expect(isRevalidationDue({ fetchedAt: 0 }, soon)).toBe(true);
    });
  });

  describe('revalidationQuietUntil', () => {
    it('is the end of the 10 minutes after a prayer, null otherwise', () => {
      expect(revalidationQuietUntil([dhuhr, asr], ASR)).toBe(ASR + 10 * MIN);
      expect(revalidationQuietUntil([dhuhr, asr], ASR + 10 * MIN - 1)).toBe(ASR + 10 * MIN);
      expect(revalidationQuietUntil([dhuhr, asr], ASR + 10 * MIN)).toBeNull();
      expect(revalidationQuietUntil([dhuhr, asr], ASR - 1)).toBeNull();
      expect(revalidationQuietUntil(null, ASR)).toBeNull();
    });
  });

  describe('revalidationAlarmAt', () => {
    it('is T-45 for the next prayer while that is still ahead', () => {
      expect(revalidationAlarmAt(morning, asr, ASR - 60 * MIN)).toBe(ASR - 45 * MIN);
      expect(revalidationAlarmAt(morning, asr, ASR - 45 * MIN - 1)).toBe(ASR - 45 * MIN);
      expect(revalidationAlarmAt(morning, asr, ASR - 45 * MIN)).toBeNull(); // the moment is now: catch-up handles it
      expect(revalidationAlarmAt(morning, asr, ASR - 40 * MIN)).toBeNull();
      expect(revalidationAlarmAt(null, asr, ASR - 60 * MIN)).toBe(ASR - 45 * MIN);
    });
    it('is null without a next prayer, or for a dev test fire', () => {
      expect(revalidationAlarmAt(morning, null, ASR)).toBeNull();
      expect(revalidationAlarmAt(morning, { name: 'Asr' }, ASR)).toBeNull();
      expect(revalidationAlarmAt(morning, { ...asr, test: true }, ASR - 60 * MIN)).toBeNull();
    });

    // Isha 45-55 min after Maghrib (Jafari / Tehran): Isha's T-45 falls in the 10
    // minutes after Maghrib, so the check is tried again at T-35.
    const maghrib = { name: 'Maghrib', time: '06:45 PM', ts: ASR + 148 * MIN };
    const ishaAfter = (gapMin) => ({ name: 'Isha', time: '—', ts: maghrib.ts + gapMin * MIN });
    const evening = (isha, extra = {}) => ({ date: '2026-10-03', prayers: [dhuhr, asr, maghrib, isha], fetchedAt: ASR - 8 * 60 * MIN, ...extra });

    it('after a T-45 held by the quiet period after a prayer, is T-35', () => {
      expect(REVALIDATE_RETRY_AT_MS).toBe(35 * MIN);
      for (const gap of [45, 50, 54]) {
        const isha = ishaAfter(gap);
        const T = (m) => isha.ts - m * MIN;
        // Re-armed anywhere from T-45 to just before T-35 (the T-45 check itself,
        // a tick, a prayer fire), it gives the same T-35.
        for (const now of [T(45), T(45) + 1, maghrib.ts + 9 * MIN, T(35) - 1].filter((n) => n >= T(45))) {
          expect([gap, now - isha.ts, revalidationAlarmAt(evening(isha), isha, now)]).toEqual([gap, now - isha.ts, T(35)]);
        }
        expect(revalidationAlarmAt(evening(isha), isha, T(35))).toBeNull(); // its moment is now
      }
      // Gap exactly 45 min: armed right as Maghrib fires.
      const isha45 = ishaAfter(45);
      expect(revalidationAlarmAt(evening(isha45), isha45, maghrib.ts + 50)).toBe(isha45.ts - 35 * MIN);
    });

    it('is not T-35 when T-45 was not quiet, T-35 is quiet too, an attempt was made, or the times are fresh', () => {
      // T-45 outside any quiet period (gap 60): the catch-up handles a missed one.
      const isha60 = ishaAfter(60);
      expect(revalidationAlarmAt(evening(isha60), isha60, isha60.ts - 40 * MIN)).toBeNull();
      // Gap 42: T-35 (Maghrib + 7) is still quiet; nothing is armed.
      const isha42 = ishaAfter(42);
      expect(revalidationAlarmAt(evening(isha42), isha42, maghrib.ts + 50)).toBeNull();
      const isha50 = ishaAfter(50);
      const T45 = isha50.ts - 45 * MIN;
      // An attempt since T-45 (a catch-up after the quiet period) has its own retry.
      expect(revalidationAlarmAt(evening(isha50), isha50, T45 + 7 * MIN, T45 + 6 * MIN)).toBeNull();
      expect(revalidationAlarmAt(evening(isha50), isha50, T45 + 7 * MIN, T45 - 60 * MIN)).toBe(isha50.ts - 35 * MIN);
      // Fetched at or after T-50: nothing to sample.
      expect(revalidationAlarmAt(evening(isha50, { fetchedAt: isha50.ts - 50 * MIN }), isha50, T45 + MIN)).toBeNull();
      // No schedule to judge the quiet period by.
      expect(revalidationAlarmAt(null, isha50, T45 + MIN)).toBeNull();
    });
  });

  // A day's schedule built the same way background.js builds it.
  const D = new Date('2026-10-03T19:00:00Z'); // 12:00 PDT
  const TZ = 'America/Los_Angeles';
  const TIMES = { Fajr: '05:40 AM', Dhuhr: '12:50 PM', Asr: '04:17 PM', Maghrib: '06:45 PM', Isha: '07:58 PM' };
  const sched = (times = TIMES, extra = {}) => ({
    date: ymdInTz(TZ, D),
    prayers: buildPrayers(times, D, TZ),
    sunrise: { time: '07:05 AM', ts: parseTimeToday('07:05 AM', D, TZ) },
    tz: TZ,
    fetchedAt: 1,
    ...extra,
  });

  describe('sameTimings', () => {
    it('ignores fetchedAt', () => {
      expect(sameTimings(sched(), sched(TIMES, { fetchedAt: 999 }))).toBe(true);
    });
    it('detects a one-minute prayer change', () => {
      expect(sameTimings(sched(), sched({ ...TIMES, Asr: '04:16 PM' }))).toBe(false);
    });
    it('detects Sunrise, tz, date and prayer-count changes', () => {
      expect(sameTimings(sched(), sched(TIMES, { sunrise: { time: '07:06 AM', ts: 1 } }))).toBe(false);
      expect(sameTimings(sched(), sched(TIMES, { sunrise: null }))).toBe(false);
      expect(sameTimings(sched(TIMES, { sunrise: null }), sched(TIMES, { sunrise: null }))).toBe(true);
      expect(sameTimings(sched(), sched(TIMES, { tz: 'America/Denver' }))).toBe(false);
      expect(sameTimings(sched(), sched(TIMES, { date: '2026-10-04' }))).toBe(false);
      const { Isha, ...four } = TIMES;
      expect(sameTimings(sched(), sched(four))).toBe(false);
      expect(sameTimings(null, sched())).toBe(false);
    });
  });

  describe('revalidationCrossesNow', () => {
    const now = new Date('2026-10-03T22:30:00Z').getTime(); // 15:30 PDT: Fajr+Dhuhr passed, Asr pending
    const old = () => sched().prayers;

    it('is empty when a change keeps every prayer on the same side of now', () => {
      const fresh = sched({ ...TIMES, Asr: '04:16 PM', Dhuhr: '12:51 PM' }).prayers;
      expect(revalidationCrossesNow(old(), fresh, now)).toEqual([]);
      expect(revalidationCrossesNow(old(), old(), now)).toEqual([]);
    });

    it('never counts Sunrise', () => {
      const withSunrise = [...old(), { name: 'Sunrise', time: '03:45 PM', ts: now + 15 * MIN }];
      expect(revalidationCrossesNow([...old(), { name: 'Sunrise', time: '07:05 AM', ts: now - 8 * 3600e3 }], withSunrise, now)).toEqual([]);
      expect(revalidationCrossesNow(old(), withSunrise, now)).toEqual([]);
    });

    it('flags a prayer that already passed but would move back into the future (would re-fire)', () => {
      const fresh = sched({ ...TIMES, Dhuhr: '03:45 PM', Asr: '04:16 PM' }).prayers;
      expect(revalidationCrossesNow(old(), fresh, now)).toEqual(['Dhuhr']);
    });

    it('flags a pending prayer that would move into the past (would be skipped)', () => {
      const fresh = sched({ ...TIMES, Asr: '03:00 PM' }).prayers;
      expect(revalidationCrossesNow(old(), fresh, now)).toEqual(['Asr']);
    });

    it('counts a prayer at exactly now as upcoming, like computeNext', () => {
      const fresh = sched({ ...TIMES, Asr: '03:30 PM' }).prayers;
      expect(fresh[2].ts).toBe(now);
      expect(revalidationCrossesNow(old(), fresh, now)).toEqual([]);
    });

    it('treats a prayer missing on either side as crossing', () => {
      const { Isha, ...four } = TIMES;
      expect(revalidationCrossesNow(old(), sched(four).prayers, now)).toEqual(['Isha']);
      expect(revalidationCrossesNow([], old(), now)).toEqual(['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha']);
    });
  });

  describe('revalidationRetryAt', () => {
    it('retries once, at T-35, after an attempt made before T-35', () => {
      expect(REVALIDATE_RETRY_AT_MS).toBe(35 * MIN);
      expect(revalidationRetryAt(ASR, ASR - 45 * MIN)).toBe(ASR - 35 * MIN);
      expect(revalidationRetryAt(ASR, ASR - 40 * MIN)).toBe(ASR - 35 * MIN);
      expect(revalidationRetryAt(ASR, ASR - 35 * MIN - 1)).toBe(ASR - 35 * MIN);
    });

    it('arms nothing after an attempt at or after T-35 (that attempt was the retry)', () => {
      expect(revalidationRetryAt(ASR, ASR - 35 * MIN)).toBeNull();
      expect(revalidationRetryAt(ASR, ASR - 31 * MIN)).toBeNull();
      expect(revalidationRetryAt(undefined, ASR)).toBeNull();
    });
  });
});

describe('per-prayer minute adjustments', () => {
  it('prayerAdjustments keeps whole minutes within ±5 for each of the five prayers', () => {
    expect(ADJUST_LIMIT_MIN).toBe(5);
    expect(prayerAdjustments({ Fajr: 2, Dhuhr: -5, Asr: 9, Maghrib: -7, Isha: 4.6 })).toEqual({ Fajr: 2, Dhuhr: -5, Asr: 5, Maghrib: -5, Isha: 5 });
    expect(prayerAdjustments({ Fajr: '2', Dhuhr: 'x', Sunrise: 3 })).toEqual({ Fajr: 2, Dhuhr: 0, Asr: 0, Maghrib: 0, Isha: 0 });
    for (const none of [undefined, null, {}, 'junk']) expect(prayerAdjustments(none)).toEqual({ Fajr: 0, Dhuhr: 0, Asr: 0, Maghrib: 0, Isha: 0 });
    expect(Object.is(prayerAdjustments({ Fajr: -0.4 }).Fajr, 0)).toBe(true); // never -0
  });

  it('shiftHm moves a 24h time by whole minutes, wrapping around midnight', () => {
    expect(shiftHm('12:17', 2)).toBe('12:19');
    expect(shiftHm('12:59', 3)).toBe('13:02');
    expect(shiftHm('05:01', -3)).toBe('04:58');
    expect(shiftHm('23:59', 3)).toBe('00:02');
    expect(shiftHm('00:01', -3)).toBe('23:58');
    expect(shiftHm('19:11', 0)).toBe('19:11');
  });
});

describe('keepCrossingPrayers (a same-day re-fetch, e.g. a saved adjustment)', () => {
  const at = (hm) => Date.parse(`2026-10-10T${hm}:00Z`);
  const day = (dhuhr, extra = {}) => ({
    date: '2026-10-10',
    tz: 'Africa/Casablanca',
    prayers: [
      { name: 'Fajr', time: '05:23 AM', ts: at('05:23'), offsetMin: 0 },
      { name: 'Dhuhr', time: dhuhr.time, ts: at(dhuhr.hm), offsetMin: 0, ...(dhuhr.adjustMin ? { adjustMin: dhuhr.adjustMin } : {}) },
      { name: 'Asr', time: '03:35 PM', ts: at('15:35'), offsetMin: 0 },
      { name: 'Maghrib', time: '06:03 PM', ts: at('18:03'), offsetMin: 0 },
      { name: 'Isha', time: '07:11 PM', ts: at('19:11'), offsetMin: 0 },
    ],
    ...extra,
  });
  const stored = day({ time: '12:17 PM', hm: '12:17' });
  const plus3 = day({ time: '12:20 PM', hm: '12:20', adjustMin: 3 });
  const minus3 = day({ time: '12:14 PM', hm: '12:14', adjustMin: -3 });

  it('keeps a prayer that already came today from coming again', () => {
    const kept = keepCrossingPrayers(stored, plus3, at('12:18'));
    expect(kept.prayers[1]).toBe(stored.prayers[1]);
    expect(computeNext(kept.prayers, at('12:18')).name).toBe('Asr');
  });
  it('keeps a prayer still to come from being skipped', () => {
    const kept = keepCrossingPrayers(stored, minus3, at('12:16'));
    expect(kept.prayers[1]).toBe(stored.prayers[1]);
    expect(computeNext(kept.prayers, at('12:16'))).toMatchObject({ name: 'Dhuhr', ts: at('12:17') });
  });
  it('takes the new times when nothing crosses now, or for another day, zone or an older version\'s day', () => {
    expect(keepCrossingPrayers(stored, plus3, at('09:00'))).toBe(plus3);
    expect(keepCrossingPrayers({ ...stored, date: '2026-10-09' }, plus3, at('12:18'))).toBe(plus3);
    expect(keepCrossingPrayers({ ...stored, tz: 'Europe/Paris' }, plus3, at('12:18'))).toBe(plus3);
    const older = { ...stored, prayers: stored.prayers.map(({ offsetMin, ...p }) => p) };
    expect(keepCrossingPrayers(older, plus3, at('12:18'))).toBe(plus3);
    expect(keepCrossingPrayers(null, plus3, at('12:18'))).toBe(plus3);
  });
});
