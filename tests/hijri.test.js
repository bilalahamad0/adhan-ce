// hijri: localized Islamic-date formatter (pure; Intl Umm al-Qura calendar).
import { formatHijri } from '../lib/hijri.js';

describe('formatHijri', () => {
  // 2026-06-04 (noon, to dodge any midnight/timezone boundary) is 18 Dhuʻl-Hijjah
  // 1447 — mid-month, so a ±1-day offset stays within the month.
  const day = new Date('2026-06-04T12:00:00');

  it('formats a Gregorian date as a localized Hijri date (English)', () => {
    const s = formatHijri(day, 'en');
    expect(s).toMatch(/1447/);
    expect(s).toMatch(/Hijjah/i);
    expect(s).toMatch(/\b18\b/);
  });

  it('defaults to English when no language is given', () => {
    expect(formatHijri(day)).toBe(formatHijri(day, 'en'));
  });

  it('localizes month names and digits per language', () => {
    expect(formatHijri(day, 'ar')).toMatch(/[٠-٩]/); // Arabic-Indic digits
    expect(formatHijri(day, 'tr')).toMatch(/Zilhicce/i);
  });

  it('applies a ±day offset, shifting the day correctly', () => {
    expect(formatHijri(day, 'en', 1)).toMatch(/\b19\b/);
    expect(formatHijri(day, 'en', -1)).toMatch(/\b17\b/);
  });

  it('returns an empty string for an invalid date (never throws)', () => {
    expect(formatHijri(new Date(NaN), 'en')).toBe('');
    expect(formatHijri('not a date', 'en')).toBe('');
    expect(formatHijri(undefined, 'en')).toBe('');
  });
});
