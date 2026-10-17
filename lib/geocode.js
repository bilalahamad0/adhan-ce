import { sanitizePlaceQuery, sanitizeLocationField, assertSafeOutboundUrl } from './privacy-guard.js';

// City geocoding via the free, keyless Open-Meteo geocoding API.
// Resolves a typed city to real places with region (admin1) + country + coords,
// so the picker can validate locations and auto-fill the province for any country.

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const GEO_GET_URL = 'https://geocoding-api.open-meteo.com/v1/get';

// Map the API payload to flat place objects. Pure — unit-testable.
export function parseGeoResults(json) {
  const results = (json && json.results) || [];
  return results.map((r) => {
    const city = r.name || '';
    const state = r.admin1 || '';
    const country = r.country || '';
    return {
      id: r.id,
      city,
      state,
      country,
      countryCode: r.country_code || '',
      lat: r.latitude,
      lon: r.longitude,
      label: [city, state, country].filter(Boolean).join(', '),
      // People living there, for a populated place (a city, town or village); -1
      // for anything else (a district, a region, an airport).
      population: /^PPL/.test(r.feature_code || '') ? r.population || 0 : -1,
    };
  });
}

async function search(q, count, lang, signal) {
  const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=${count}&language=${encodeURIComponent(lang)}&format=json`;
  assertSafeOutboundUrl(url);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  return parseGeoResults(await res.json()).map((p) => ({ ...p, lang }));
}


// The two answers as one list: every place once, in the UI language when that
// answer has it (keeping its English names as `en`, which is what is saved), the
// most populous first, else in the English answer's order, then the UI answer's.
// By the English order alone, a city typed in the UI language ("Londres") came
// after the English answer's villages of that name, past the end of the list. Pure.
export function mergeByLang(english, local) {
  const byId = new Map(local.map((p) => [p.id, p]));
  const seen = new Set(english.map((p) => p.id));
  const merged = [
    ...english.map((p) => (byId.has(p.id) ? { ...byId.get(p.id), en: { city: p.city, state: p.state, country: p.country } } : p)),
    ...local.filter((p) => !seen.has(p.id)),
  ];
  const people = (p) => (typeof p.population === 'number' ? p.population : -1);
  return merged
    .map((p, i) => ({ p, i }))
    .sort((a, b) => people(b.p) - people(a.p) || a.i - b.i)
    .map(({ p }) => p);
}

// Places in `lang`, the UI language, as far as Open-Meteo has them. It matches the
// query against the names in the language asked for, so both are asked: in English
// alone "الدار البيضاء" finds nothing, and in French alone "Mecca" loses Mecca,
// Saudi Arabia (Mecca, California comes first). Each place carries `lang`, the
// language its names are in: `lang`, or 'en' for a place only the English answer has.
export async function searchPlaces(query, { count = 8, signal, lang = 'en' } = {}) {
  const q = sanitizePlaceQuery(query);
  if (!q || q.length < 2) return [];
  if (lang === 'en') return search(q, count, 'en', signal);
  const [english, local] = await Promise.allSettled([search(q, count, 'en', signal), search(q, count, lang, signal)]);
  if (signal && signal.aborted) throw new Error('geocode: aborted'); // a later search took over
  if (english.status === 'rejected' && local.status === 'rejected') throw local.reason;
  return mergeByLang(english.status === 'fulfilled' ? english.value : [], local.status === 'fulfilled' ? local.value : []);
}

// How long Save (and the welcome page's Finish) waits for a place's English names.
export const ENGLISH_NAMES_TIMEOUT_MS = 8000;

async function englishNames(id, signal) {
  const url = `${GEO_GET_URL}?id=${encodeURIComponent(id)}&language=en`;
  assertSafeOutboundUrl(url);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  const [en] = parseGeoResults({ results: [await res.json()] });
  if (!en || !en.city || en.id !== id) throw new Error('geocode: place not found');
  return en;
}


// A place as the settings store it. The city, state and country are always in
// English: Aladhan looks the place up by them (see fetchSchedule in background.js),
// and a name in another script may not be found there at all — so a place found in
// another language is saved under the names the English answer gave it (`en`), or,
// found only in that language, asked for again by its id, in English. `placeLabel` keeps the label as it was shown, with
// its language, so the popup can show it again in that language; it is null for a
// place found in English or detected, and carried over for a place already saved.
// The lookup gives up after `timeoutMs`, so a hung request never holds a save.
export async function placeToSave(place, { timeoutMs = ENGLISH_NAMES_TIMEOUT_MS } = {}) {
  let { city, state = '', country = '' } = place;
  const found = place.lang && place.lang !== 'en';
  if (found && place.en) ({ city, state = '', country = '' } = place.en);
  else if (found) {
    const abort = new AbortController();
    let timer;
    try {
      ({ city, state, country } = await Promise.race([
        englishNames(place.id, abort.signal),
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('geocode: no answer')), timeoutMs))),
      ]));
    } finally {
      clearTimeout(timer);
      abort.abort(); // a request still open after the timeout
    }
  }
  const placeLabel = found ? { lang: place.lang, text: place.label } : place.placeLabel || null;
  return { city, state, country, lat: place.lat, lon: place.lon, placeLabel };
}


// IP-based approximate location detection.
// Uses free client-side reverse geocoding endpoints that determine location
// from the caller's IP address. This avoids calling navigator.geolocation,
// eliminating browser permission prompts, user denial errors, and manifest warnings.
export async function detectLocationByIp({ signal } = {}) {
  try {
    const url = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
    assertSafeOutboundUrl(url);
    const res = await fetch(url, { signal });
    if (res.ok) {
      const data = await res.json();
      const lat = data.latitude;
      const lon = data.longitude;
      const city = sanitizeLocationField(data.city || data.locality || '');
      const state = sanitizeLocationField(data.principalSubdivision || '');
      const country = sanitizeLocationField(data.countryName || '');
      if (lat != null && lon != null && city) {
        return {
          city,
          state,
          country,
          lat,
          lon,
          label: [city, state, country].filter(Boolean).join(', '),
        };
      }
    }
  } catch (_) {}

  try {
    const url = 'https://ipapi.co/json/';
    assertSafeOutboundUrl(url);
    const res = await fetch(url, { signal });
    if (res.ok) {
      const data = await res.json();
      if (data.latitude != null && data.longitude != null && data.city) {
        const city = sanitizeLocationField(data.city);
        const state = sanitizeLocationField(data.region || '');
        const country = sanitizeLocationField(data.country_name || '');
        return {
          city,
          state,
          country,
          lat: data.latitude,
          lon: data.longitude,
          label: [city, state, country].filter(Boolean).join(', '),
        };
      }
    }
  } catch (_) {}

  return null;

}
