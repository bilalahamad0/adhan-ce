// City geocoding via the free, keyless Open-Meteo geocoding API.
// Resolves a typed city to real places with region (admin1) + country + coords,
// so the picker can validate locations and auto-fill the province for any country.

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';

// Map the API payload to flat place objects. Pure — unit-testable.
export function parseGeoResults(json) {
  const results = (json && json.results) || [];
  return results.map((r) => {
    const city = r.name || '';
    const state = r.admin1 || '';
    const country = r.country || '';
    return {
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

export async function searchPlaces(query, { count = 8, signal } = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const url = `${GEO_URL}?name=${encodeURIComponent(q)}&count=${count}&language=en&format=json`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  return parseGeoResults(await res.json());
}

// IP-based approximate location detection, run only when the user clicks
// "Detect location". BigDataCloud's free client-side endpoint, called without
// coordinates, answers from the caller's IP address (its documented IP fallback) —
// so no navigator.geolocation, permission prompt or manifest warning. Its fair-use
// policy is written for device coordinates; if BigDataCloud objects to this
// coordinate-less use, drop the button rather than add another IP service. There is
// deliberately no second service:
// ipapi.co's free tier is not licensed for production use and bars keeping its
// answers past 24 hours, while the detected place is saved as the user's location.
// Null when it gives no usable place; callers then ask the user to search instead.
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

  return null;
}
