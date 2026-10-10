// The location's time — each prayer's instant, the clock and today's date — comes
// from the UTC offsets Aladhan sends with its iso8601 times, not from this
// browser's own tz data, which can be out of date: Morocco moved to permanent +00
// on 2026-09-20 (IANA 2026c), and British Columbia (2026b) and Alberta (2026c)
// stopped falling back on 2026-11-01, but a browser shipping older data reads
// Casablanca as +01 — every prayer fired an hour early and the clock ran an hour
// ahead. simulateStaleTzData makes Intl answer like such a browser whatever tz
// data this Node ships, so these hold on every CI runner.
import {
  parseAladhanIso,
  epochAtOffset,
  locationOffsetMs,
  locationClock,
  locationYmd,
  locationTime12h,
  isNewDay,
  ROLLOVER_BACK_SLACK_MS,
  tzOffsetMs,
  ymd,
  ymdInTz,
  PRAYER_ORDER,
} from '../lib/schedule.js';
import { simulateStaleTzData } from './helpers/stale-icu.js';

const H = 3600e3;
const at = (iso) => Date.parse(iso);

// A schedule stored from an iso8601 answer: `times` maps Fajr..Isha (+ Sunrise) to
// 'HH:MM' on `date`, each carrying `offsetMin` (one value or a per-name map).
function isoSchedule(date, tz, times, offsetMin) {
  const off = (name) => (typeof offsetMin === 'number' ? offsetMin : offsetMin[name]);
  const timed = (name) => ({ time: times[name], ts: epochAtOffset(date, times[name], off(name)), offsetMin: off(name) });
  return {
    date,
    tz,
    prayers: PRAYER_ORDER.map((name) => ({ name, ...timed(name) })),
    sunrise: times.Sunrise ? timed('Sunrise') : null,
    fetchedAt: 0,
  };
}

// Aladhan's live answers (iso8601=true).
const CASA_10_10 = { Fajr: '05:23', Sunrise: '06:31', Dhuhr: '12:17', Asr: '15:35', Maghrib: '18:03', Isha: '19:11' }; // +00:00
const CASA_19_09 = { Fajr: '06:08', Sunrise: '07:16', Dhuhr: '13:24', Asr: '16:54', Maghrib: '19:32', Isha: '20:40' }; // +01:00, the last day on +01
const CASA_20_09 = { Fajr: '05:09', Sunrise: '06:17', Dhuhr: '12:24', Asr: '15:54', Maghrib: '18:30', Isha: '19:39' }; // +00:00
const VAN_02_11 = { Fajr: '06:32', Sunrise: '08:02', Dhuhr: '12:56', Asr: '15:25', Maghrib: '17:49', Isha: '19:19' }; // -07:00
const EDM_02_11 = { Fajr: '06:56', Sunrise: '08:36', Dhuhr: '13:18', Asr: '15:33', Maghrib: '17:59', Isha: '19:38' }; // -06:00
const LA_01_11 = { Fajr: '05:20', Sunrise: '06:33', Dhuhr: '11:52', Asr: '14:48', Maghrib: '17:10', Isha: '18:23' }; // -08:00, US fall-back day

describe('parseAladhanIso', () => {
  it("reads Aladhan's iso8601 times: the wall-clock time and its UTC offset", () => {
    expect(parseAladhanIso('2026-10-10T12:17:00+00:00')).toEqual({ hm: '12:17', offsetMin: 0 }); // Casablanca
    expect(parseAladhanIso('2026-09-19T13:24:00+01:00')).toEqual({ hm: '13:24', offsetMin: 60 });
    expect(parseAladhanIso('2026-11-02T12:56:00-07:00')).toEqual({ hm: '12:56', offsetMin: -420 }); // Vancouver
    expect(parseAladhanIso('2026-10-10T04:43:00+05:45')).toEqual({ hm: '04:43', offsetMin: 345 }); // Kathmandu
    expect(parseAladhanIso('2026-11-02T05:20:00-03:30')).toEqual({ hm: '05:20', offsetMin: -210 }); // St. John's
    expect(parseAladhanIso('2026-10-10T05:05:00+14:00')).toEqual({ hm: '05:05', offsetMin: 840 }); // Kiritimati
    expect(parseAladhanIso('2026-10-10T00:01+02:00')).toEqual({ hm: '00:01', offsetMin: 120 }); // no seconds
    expect(parseAladhanIso('2026-10-10T12:17:00Z')).toEqual({ hm: '12:17', offsetMin: 0 });
    expect(Object.is(parseAladhanIso('2026-10-10T12:17:00-00:00').offsetMin, 0)).toBe(true); // never -0
  });

  it('rejects anything else, including a plain time and a time without an offset', () => {
    for (const bad of [
      '12:17',
      '12:17 (WET)',
      '2026-10-10T24:00:00+00:00',
      '2026-10-10T12:60:00+00:00',
      '2026-10-10T12:17:60+00:00',
      '2026-10-10T12:17:00+14:30',
      '2026-10-10T12:17:00+00:60',
      '2026-10-10T12:17:00',
      '2026-10-10 12:17:00+00:00',
      '2026-10-10T12:17:00+0000',
      '2026-10-10T12:17:00+00:00 ',
      '',
    ]) {
      expect(parseAladhanIso(bad)).toBeNull();
    }
    for (const bad of [undefined, null, 1217, {}]) expect(parseAladhanIso(bad)).toBeNull();
  });
});

describe('epochAtOffset', () => {
  it('is the instant of a wall-clock time at a fixed UTC offset — no tz data involved', () => {
    expect(epochAtOffset('2026-10-10', '12:17', 0)).toBe(at('2026-10-10T12:17:00Z'));
    expect(epochAtOffset('2026-10-10', '04:43', 345)).toBe(at('2026-10-09T22:58:00Z'));
    expect(epochAtOffset('2026-11-02', '05:20', -210)).toBe(at('2026-11-02T08:50:00Z'));
  });
});

describe("with this browser's tz data out of date", () => {
  let restore;
  beforeAll(() => {
    restore = simulateStaleTzData();
  });
  afterAll(() => restore());

  it('(the simulated browser reads the changed zones with their old rules)', () => {
    expect(tzOffsetMs(new Date(at('2026-10-10T12:00:00Z')), 'Africa/Casablanca')).toBe(H);
    expect(tzOffsetMs(new Date(at('2026-11-02T20:00:00Z')), 'America/Vancouver')).toBe(-8 * H);
    expect(tzOffsetMs(new Date(at('2026-11-02T20:00:00Z')), 'America/Edmonton')).toBe(-7 * H);
  });

  it("Casablanca reads +00 from Aladhan's offsets: clock, time and date", () => {
    const casa = isoSchedule('2026-10-10', 'Africa/Casablanca', CASA_10_10, 0);
    const now = at('2026-10-10T10:58:00Z'); // the user's screenshot: 10:58, Saturday 10/10/2026
    expect(locationOffsetMs(casa, now)).toBe(0);
    expect(locationTime12h(casa, now)).toBe('10:58 AM');
    expect(locationClock(casa, now).getUTCHours()).toBe(10);
    expect(locationYmd(casa, now)).toBe('2026-10-10');
    // At 23:30 it is still the 10th (the browser alone would say 00:30 on the 11th).
    expect(locationYmd(casa, at('2026-10-10T23:30:00Z'))).toBe('2026-10-10');
    expect(isNewDay(casa, at('2026-10-10T23:30:00Z'))).toBe(false);
    expect(isNewDay(casa, at('2026-10-11T00:05:00Z'))).toBe(true);
  });

  it('El Aaiun likewise', () => {
    const elAaiun = isoSchedule('2026-10-10', 'Africa/El_Aaiun', { Fajr: '05:46', Dhuhr: '12:40', Asr: '16:01', Maghrib: '18:29', Isha: '19:33' }, 0);
    expect(locationTime12h(elAaiun, at('2026-10-10T12:40:00Z'))).toBe('12:40 PM');
  });

  it('Vancouver and Edmonton read their permanent offsets after 2026-11-01', () => {
    const now = at('2026-11-02T20:00:00Z');
    expect(locationTime12h(isoSchedule('2026-11-02', 'America/Vancouver', VAN_02_11, -420), now)).toBe('01:00 PM');
    expect(locationTime12h(isoSchedule('2026-11-02', 'America/Edmonton', EDM_02_11, -360), now)).toBe('02:00 PM');
  });

  it("the night the offset changed does not flip between days", () => {
    const sep19 = isoSchedule('2026-09-19', 'Africa/Casablanca', CASA_19_09, 60);
    const sep20 = isoSchedule('2026-09-20', 'Africa/Casablanca', CASA_20_09, 0);
    const now = at('2026-09-19T23:30:00Z'); // 00:30 on the 20th, still on +01
    expect(isNewDay(sep19, now)).toBe(true); // the 19th's own offsets: it is the 20th
    // The 20th's offsets (+00) put now at 23:30 on the 19th: within the slack, kept.
    expect(locationYmd(sep20, now)).toBe('2026-09-19');
    expect(isNewDay(sep20, now)).toBe(false);
    // Hours before its day (this machine's clock set back): fetched again.
    expect(isNewDay(sep20, at('2026-09-19T20:00:00Z'))).toBe(true);
    expect(isNewDay(sep20, at('2026-09-20T00:00:00Z') - ROLLOVER_BACK_SLACK_MS - 1)).toBe(true);
    expect(isNewDay(sep20, at('2026-09-20T00:00:00Z') - ROLLOVER_BACK_SLACK_MS)).toBe(false);
  });

  it('a schedule without offsets (older version) still reads the zone through Intl', () => {
    const legacy = { date: '2026-10-10', tz: 'Africa/Casablanca', prayers: [{ name: 'Fajr', time: '05:23 AM', ts: 0 }], sunrise: null };
    expect(locationOffsetMs(legacy, at('2026-10-10T10:58:00Z'))).toBe(H);
  });
});

describe("with this browser's tz data up to date", () => {
  it('follows Intl while it agrees with the offsets — including a DST switch in the night', () => {
    // US fall back on 2026-11-01 at 02:00: Aladhan's times are all after it (-08:00).
    const la = isoSchedule('2026-11-01', 'America/Los_Angeles', LA_01_11, -480);
    const now = at('2026-11-01T07:30:00Z'); // 00:30 PDT, before the switch
    expect(locationOffsetMs(la, now)).toBe(-7 * H);
    expect(locationTime12h(la, now)).toBe('12:30 AM');
    expect(locationYmd(la, now)).toBe('2026-11-01'); // the day's own offsets alone would read Oct 31, 23:30
    expect(isNewDay(la, now)).toBe(false);
    expect(locationTime12h(la, at('2026-11-01T19:52:00Z'))).toBe('11:52 AM'); // Dhuhr, after the switch
  });

  it('reads the same as ymdInTz for an ordinary day', () => {
    const la = isoSchedule('2026-10-03', 'America/Los_Angeles', { Fajr: '05:40', Dhuhr: '12:50', Asr: '16:16', Maghrib: '18:45', Isha: '19:58' }, -420);
    for (const iso of ['2026-10-03T08:00:00Z', '2026-10-03T22:32:00Z', '2026-10-04T06:59:00Z', '2026-10-04T07:00:00Z']) {
      expect(locationYmd(la, at(iso))).toBe(ymdInTz('America/Los_Angeles', new Date(at(iso))));
    }
    expect(locationTime12h(la, at('2026-10-03T22:32:00Z'))).toBe('03:32 PM');
  });

  it("without a zone or offsets it is this machine's time, as before", () => {
    const t = at('2026-10-10T23:30:00Z');
    expect(locationYmd(null, t)).toBe(ymd(new Date(t)));
    expect(locationYmd({ tz: null, prayers: [], sunrise: null }, t)).toBe(ymd(new Date(t)));
    expect(locationOffsetMs(null, t)).toBe(-new Date(t).getTimezoneOffset() * 60000);
  });

  it("a zone Intl can't read falls back to the offsets, then to this machine", () => {
    const bad = isoSchedule('2026-10-10', 'Not/AZone', CASA_10_10, 0);
    expect(locationOffsetMs(bad, at('2026-10-10T10:58:00Z'))).toBe(0);
    const t = at('2026-10-10T10:58:00Z');
    expect(locationOffsetMs({ tz: 'Not/AZone', prayers: [] }, t)).toBe(-new Date(t).getTimezoneOffset() * 60000);
  });

  it('without usable Intl, takes the offset of the latest time at or before the instant', () => {
    const mixed = isoSchedule('2026-09-20', null, CASA_20_09, { Fajr: 60, Sunrise: 60, Dhuhr: 0, Asr: 0, Maghrib: 0, Isha: 0 });
    expect(locationOffsetMs(mixed, at('2026-09-20T01:00:00Z'))).toBe(H); // before them all: the first one's
    expect(locationOffsetMs(mixed, at('2026-09-20T09:00:00Z'))).toBe(H); // after Sunrise
    expect(locationOffsetMs(mixed, at('2026-09-20T12:24:00Z'))).toBe(0); // from Dhuhr
  });

  it('a missing schedule or date is always a new day', () => {
    expect(isNewDay(null)).toBe(true);
    expect(isNewDay({ tz: 'UTC', prayers: [] })).toBe(true);
  });
});
