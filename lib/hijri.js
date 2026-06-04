// Localized Hijri (Islamic) date for the popup header.
//
// Computed on-device via Intl's Umm al-Qura calendar — the de-facto standard
// (used by Saudi Arabia and most software), so it matches what users and other
// prayer apps expect. Pure + offline: no network and no dependency on the Aladhan
// response. The optional ±day offset shifts the Gregorian anchor before
// conversion, so month/year rollovers stay correct (Intl knows month lengths) and
// a community whose local moon-sighting differs by a day can realign the date.
//
// Intl supplies localized month names, native digits, and the era marker for
// every UI language we ship (en/ar/ur/id/tr/fr), e.g.:
//   en → "Dhuʻl-Hijjah 18, 1447 AH"   ar → "١٨ ذو الحجة ١٤٤٧ هـ"

export function formatHijri(date, lang = 'en', offsetDays = 0) {
  try {
    const d = new Date(date);
    d.setDate(d.getDate() + (Number(offsetDays) || 0));
    return new Intl.DateTimeFormat(`${lang || 'en'}-u-ca-islamic-umalqura`, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d);
  } catch (_) {
    // Invalid date, or a (very old) engine without the Islamic calendar.
    return '';
  }
}
