// tracker: pure prayer-log helpers (counts, streak, history dates).
import { dayCount, totalLogged, prevYmd, completeStreak, historyDates } from '../lib/tracker.js';

const full = () => ({ Fajr: true, Dhuhr: true, Asr: true, Maghrib: true, Isha: true });

describe('tracker helpers', () => {
  const log = {
    '2026-06-01': full(),
    '2026-06-02': full(),
    '2026-06-03': { Fajr: true, Asr: true }, // partial
    '2026-06-04': full(), // "today"
  };

  it('dayCount counts marked prayers, tolerating missing day/log', () => {
    expect(dayCount(log, '2026-06-01')).toBe(5);
    expect(dayCount(log, '2026-06-03')).toBe(2);
    expect(dayCount(log, '2026-06-09')).toBe(0);
    expect(dayCount(null, '2026-06-01')).toBe(0);
  });

  it('totalLogged sums across all days', () => {
    expect(totalLogged(log)).toBe(5 + 5 + 2 + 5);
    expect(totalLogged({})).toBe(0);
    expect(totalLogged(null)).toBe(0);
  });

  it('prevYmd steps back one calendar day, crossing month/year boundaries', () => {
    expect(prevYmd('2026-06-02')).toBe('2026-06-01');
    expect(prevYmd('2026-06-01')).toBe('2026-05-31');
    expect(prevYmd('2026-01-01')).toBe('2025-12-31');
  });

  it('completeStreak counts consecutive all-five days back from today', () => {
    expect(completeStreak(log, '2026-06-04')).toBe(1); // 06-03 partial breaks it
    expect(completeStreak(log, '2026-06-02')).toBe(2); // 06-02 + 06-01
  });

  it('completeStreak ignores an in-progress today, measuring up to yesterday', () => {
    const l = { '2026-06-01': full(), '2026-06-02': full() }; // 06-03 "today" not logged
    expect(completeStreak(l, '2026-06-03')).toBe(2);
  });

  it('historyDates lists recent-first from today back to install, clamped + capped', () => {
    expect(historyDates('2026-06-02', '2026-06-04')).toEqual(['2026-06-04', '2026-06-03', '2026-06-02']);
    expect(historyDates('2026-06-04', '2026-06-04')).toEqual(['2026-06-04']);
    expect(historyDates('2026-07-01', '2026-06-04')).toEqual(['2026-06-04']); // future install clamps to today
    expect(historyDates('2020-01-01', '2026-06-04', 5)).toHaveLength(5); // cap bounds the list
  });
});
