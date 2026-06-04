// hijri: localized Islamic-date formatter (pure; Intl Umm al-Qura calendar).
//
// The exact glyphs of the Hijri output — digit system (Latin vs Arabic-Indic),
// month romanization, era marker — vary by the engine's ICU version (Node 18 vs
// 20/22, and across Chrome releases). So these tests assert only invariants that
// hold on every ICU version, never specific characters.
import { formatHijri } from '../lib/hijri.js';

describe('formatHijri', () => {
  // Mid-month, so a ±1-day offset never crosses a month boundary.
  const day = new Date('2026-06-04T12:00:00'); // Dhuʻl-Hijjah 1447 AH

  it('returns a non-empty date carrying the Hijri year (English uses Latin digits)', () => {
    const s = formatHijri(day, 'en');
    expect(s).toBeTruthy();
    expect(s).toMatch(/1447/);
  });

  it('defaults to English when no language is given', () => {
    expect(formatHijri(day)).toBe(formatHijri(day, 'en'));
  });

  it('localizes per language (Arabic script differs from the English output)', () => {
    const en = formatHijri(day, 'en');
    const ar = formatHijri(day, 'ar');
    expect(ar).toBeTruthy();
    expect(ar).not.toBe(en);
    expect(ar).toMatch(/\p{Script=Arabic}/u); // an Arabic-script month name is present
  });

  it('applies a ±day offset, producing three distinct adjacent dates', () => {
    const minus1 = formatHijri(day, 'en', -1);
    const base = formatHijri(day, 'en', 0);
    const plus1 = formatHijri(day, 'en', 1);
    expect(new Set([minus1, base, plus1]).size).toBe(3);
  });

  it('returns an empty string for an invalid date (never throws)', () => {
    expect(formatHijri(new Date(NaN), 'en')).toBe('');
    expect(formatHijri('not a date', 'en')).toBe('');
    expect(formatHijri(undefined, 'en')).toBe('');
  });
});
