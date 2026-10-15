import { parseGeoResults, searchPlaces, placeToSave, detectLocationByIp } from '../lib/geocode.js';

const sample = {
  results: [
    { name: 'Sunnyvale', admin1: 'California', country: 'United States', country_code: 'US', latitude: 37.36, longitude: -122.03 },
    { name: 'London', country: 'United Kingdom', country_code: 'GB', latitude: 51.5, longitude: -0.12 }, // no admin1
  ],
};

describe('parseGeoResults', () => {
  it('maps API results to flat place objects', () => {
    const [sv] = parseGeoResults(sample);
    expect(sv).toMatchObject({ city: 'Sunnyvale', state: 'California', country: 'United States', countryCode: 'US' });
    expect(sv.lat).toBe(37.36);
    expect(sv.lon).toBe(-122.03);
    expect(sv.label).toBe('Sunnyvale, California, United States');
  });

  it('handles a missing region (no admin1)', () => {
    const place = parseGeoResults(sample)[1];
    expect(place.state).toBe('');
    expect(place.label).toBe('London, United Kingdom');
  });

  it('tolerates empty / missing payloads', () => {
    expect(parseGeoResults({})).toEqual([]);
    expect(parseGeoResults({ results: [] })).toEqual([]);
    expect(parseGeoResults(null)).toEqual([]);
  });
});

describe('searchPlaces', () => {
  const orig = global.fetch;
  afterEach(() => {
    global.fetch = orig;
  });

  it('short-circuits queries under 2 chars without fetching', async () => {
    let called = false;
    global.fetch = () => {
      called = true;
    };
    expect(await searchPlaces('a')).toEqual([]);
    expect(called).toBe(false);
  });

  it('fetches the geocoding endpoint and parses the response', async () => {
    let requested = '';
    global.fetch = async (url) => {
      requested = url;
      return { ok: true, json: async () => sample };
    };
    const r = await searchPlaces('Sunnyvale');
    expect(requested).toContain('name=Sunnyvale');
    expect(r[0].city).toBe('Sunnyvale');
  });

  it('throws on a non-ok response', async () => {
    global.fetch = async () => ({ ok: false, status: 500 });
    await expect(searchPlaces('London')).rejects.toThrow('geocode 500');
  });

  it('asks in English unless told the UI language, and says which on each place', async () => {
    const requested = [];
    global.fetch = async (url) => {
      requested.push(url);
      return { ok: true, json: async () => ({ results: [{ id: 2553604, name: 'الدار البيضاء', admin1: 'الدار البيضاء - سطات', country: 'المغرب', latitude: 33.59, longitude: -7.61 }] }) };
    };
    expect((await searchPlaces('Casablanca'))[0].lang).toBe('en');
    // A name in Arabic script is matched only when Arabic is asked for.
    const [place] = await searchPlaces('الدار البيضاء', { lang: 'ar' });
    expect(requested[0]).toContain('&language=en&');
    expect(requested[1]).toContain(`name=${encodeURIComponent('الدار البيضاء')}&`);
    expect(requested[1]).toContain('&language=ar&');
    expect(place).toMatchObject({ id: 2553604, lang: 'ar', city: 'الدار البيضاء', label: 'الدار البيضاء, الدار البيضاء - سطات, المغرب' });
  });
});

describe('placeToSave', () => {
  const orig = global.fetch;
  afterEach(() => {
    global.fetch = orig;
  });
  // Open-Meteo's /v1/get answer for Casablanca in English (one place, not a list).
  const CASABLANCA_EN = { id: 2553604, name: 'Casablanca', admin1: 'Casablanca-Settat', country: 'Morocco', country_code: 'MA', latitude: 33.58831, longitude: -7.61138 };
  const foundInArabic = { id: 2553604, lang: 'ar', city: 'الدار البيضاء', state: 'الدار البيضاء - سطات', country: 'المغرب', lat: 33.59, lon: -7.61, label: 'الدار البيضاء, الدار البيضاء - سطات, المغرب' };

  it('stores a place found in another language under its English names, and its label as shown', async () => {
    const requested = [];
    global.fetch = async (url) => {
      requested.push(url);
      return { ok: true, json: async () => CASABLANCA_EN };
    };
    expect(await placeToSave(foundInArabic)).toEqual({
      city: 'Casablanca',
      state: 'Casablanca-Settat',
      country: 'Morocco',
      lat: 33.59, // the coordinates as picked
      lon: -7.61,
      placeLabel: { lang: 'ar', text: 'الدار البيضاء, الدار البيضاء - سطات, المغرب' },
    });
    expect(requested).toEqual(['https://geocoding-api.open-meteo.com/v1/get?id=2553604&language=en']);
  });

  it('asks nothing for a place found in English or detected, and clears an earlier label', async () => {
    global.fetch = async () => {
      throw new Error('no request expected');
    };
    const london = { id: 2643743, lang: 'en', city: 'London', state: 'England', country: 'United Kingdom', lat: 51.5, lon: -0.12, label: 'London, England, United Kingdom' };
    expect(await placeToSave(london)).toEqual({ city: 'London', state: 'England', country: 'United Kingdom', lat: 51.5, lon: -0.12, placeLabel: null });
    const detected = { city: 'Paris', state: 'Île-de-France', country: 'France', lat: 48.85, lon: 2.35, label: 'Paris, Île-de-France, France' };
    expect((await placeToSave(detected)).placeLabel).toBeNull();
  });

  it('keeps the label of a place already saved', async () => {
    global.fetch = async () => {
      throw new Error('no request expected');
    };
    const placeLabel = { lang: 'ar', text: 'الدار البيضاء, الدار البيضاء - سطات, المغرب' };
    const saved = { city: 'Casablanca', state: 'Casablanca-Settat', country: 'Morocco', lat: 33.59, lon: -7.61, placeLabel };
    expect(await placeToSave(saved)).toEqual(saved);
  });

  it('fails rather than store names Aladhan may not find', async () => {
    global.fetch = async () => ({ ok: false, status: 503 });
    await expect(placeToSave(foundInArabic)).rejects.toThrow('geocode 503');
    global.fetch = async () => ({ ok: true, json: async () => ({ ...CASABLANCA_EN, id: 1 }) });
    await expect(placeToSave(foundInArabic)).rejects.toThrow('place not found');
    global.fetch = async () => ({ ok: true, json: async () => ({}) });
    await expect(placeToSave(foundInArabic)).rejects.toThrow('place not found');
  });
});

describe('detectLocationByIp', () => {
  const orig = global.fetch;
  afterEach(() => {
    global.fetch = orig;
  });

  it('resolves location from BigDataCloud client IP endpoint', async () => {
    global.fetch = async (url) => {
      if (url.includes('bigdatacloud')) {
        return {
          ok: true,
          json: async () => ({
            latitude: 48.85,
            longitude: 2.35,
            city: 'Paris',
            principalSubdivision: 'Île-de-France',
            countryName: 'France',
          }),
        };
      }
      return { ok: false };
    };

    const place = await detectLocationByIp();
    expect(place).toEqual({
      city: 'Paris',
      state: 'Île-de-France',
      country: 'France',
      lat: 48.85,
      lon: 2.35,
      label: 'Paris, Île-de-France, France',
    });
  });

  it('falls back to ipapi.co if primary service fails', async () => {
    global.fetch = async (url) => {
      if (url.includes('bigdatacloud')) {
        return { ok: false };
      }
      if (url.includes('ipapi.co')) {
        return {
          ok: true,
          json: async () => ({
            latitude: 51.5,
            longitude: -0.12,
            city: 'London',
            region: 'England',
            country_name: 'United Kingdom',
          }),
        };
      }
      return { ok: false };
    };

    const place = await detectLocationByIp();
    expect(place).toEqual({
      city: 'London',
      state: 'England',
      country: 'United Kingdom',
      lat: 51.5,
      lon: -0.12,
      label: 'London, England, United Kingdom',
    });
  });

  it('returns null safely without throwing if all services fail', async () => {
    global.fetch = async () => {
      throw new Error('Network offline');
    };

    const place = await detectLocationByIp();
    expect(place).toBeNull();
  });
});
