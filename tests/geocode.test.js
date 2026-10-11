import { parseGeoResults, searchPlaces, detectLocationByIp } from '../lib/geocode.js';

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

  // No second service: ipapi.co's free tier is not licensed for production use and
  // bars keeping its answers past 24 hours (the detected place is saved). A failed
  // or empty BigDataCloud answer must end in null, after that one request.
  it.each([
    ['cannot be reached', () => {
      throw new Error('Network offline');
    }],
    ['answers with an error', () => ({ ok: false })],
    ['answers without a city', () => ({ ok: true, json: async () => ({ latitude: 51.5, longitude: -0.12, city: '', locality: '' }) })],
    ['answers without coordinates', () => ({ ok: true, json: async () => ({ city: 'London', countryName: 'United Kingdom' }) })],
  ])('returns null, asking no other service, when BigDataCloud %s', async (_, answer) => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      return answer();
    };

    expect(await detectLocationByIp()).toBeNull();
    expect(calls).toEqual(['https://api.bigdatacloud.net/data/reverse-geocode-client']);
  });
});
