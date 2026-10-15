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
    };
  });
}

// Places named in `lang`, the UI language: Open-Meteo matches the query against the
// names in that language too, so "الدار البيضاء" is found only when Arabic is asked
// for. Each place carries `lang`, the language its names are in.
export async function searchPlaces(query, { count = 8, signal, lang = 'en' } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=${count}&language=${encodeURIComponent(lang)}&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  return parseGeoResults(await res.json()).map((p) => ({ ...p, lang }));
}

// A place as the settings store it. The city, state and country are always in
// English: Aladhan looks the place up by them (see fetchSchedule in background.js),
// and a name in another script may not be found there at all — so a place found in
// another language is asked for again, by its id, in English, the names the search
// would have given in English. `placeLabel` keeps the label as it was shown, with
// its language, so the popup can show it again in that language; it is null for a
// place found in English or detected, and carried over for a place already saved.
export async function placeToSave(place, { signal } = {}) {
  let { city, state = '', country = '' } = place;
  const found = place.lang && place.lang !== 'en';
  if (found) {
    const res = await fetch(`${GEO_GET_URL}?id=${encodeURIComponent(place.id)}&language=en`, { signal });
    if (!res.ok) throw new Error(`geocode ${res.status}`);
    const [en] = parseGeoResults({ results: [await res.json()] });
    if (!en || !en.city || en.id !== place.id) throw new Error('geocode: place not found');
    ({ city, state, country } = en);
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
    const res = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client', { signal });
    if (res.ok) {
      const data = await res.json();
      const lat = data.latitude;
      const lon = data.longitude;
      const city = data.city || data.locality || '';
      const state = data.principalSubdivision || '';
      const country = data.countryName || '';
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
    const res = await fetch('https://ipapi.co/json/', { signal });
    if (res.ok) {
      const data = await res.json();
      if (data.latitude != null && data.longitude != null && data.city) {
        const city = data.city;
        const state = data.region || '';
        const country = data.country_name || '';
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
