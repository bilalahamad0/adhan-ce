import { jest } from '@jest/globals';
import { parseGeoResults, searchPlaces, mergeByLang, placeToSave, detectLocationByIp } from '../lib/geocode.js';

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

  // Open-Meteo matches the query against the names in the language asked for.
  const answers = (byLang) => {
    const requested = [];
    global.fetch = async (url) => {
      requested.push(url);
      const lang = url.match(/language=(\w+)/)[1];
      if (byLang[lang] instanceof Error) throw byLang[lang];
      return { ok: true, json: async () => ({ results: byLang[lang] || [] }) };
    };
    return requested;
  };
  const MECCA_SA = { id: 104515, name: 'Mecca', admin1: 'Mecca Region', country: 'Saudi Arabia', latitude: 21.42, longitude: 39.83 };
  const MECCA_CA = { id: 5371965, name: 'Mecca', admin1: 'California', country: 'United States', latitude: 33.57, longitude: -116.08 };
  const MECCA_CA_FR = { ...MECCA_CA, admin1: 'Californie', country: 'États-Unis' };
  const CASA_AR = { id: 2553604, name: 'الدار البيضاء', admin1: 'الدار البيضاء - سطات', country: 'المغرب', latitude: 33.59, longitude: -7.61 };

  it('asks only in English for an English UI', async () => {
    const requested = answers({ en: [MECCA_SA] });
    const places = await searchPlaces('Mecca');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('&language=en&');
    expect(places.map((p) => [p.id, p.lang])).toEqual([[104515, 'en']]);
  });

  it('in another UI language, keeps what English finds, in its order and in that language where it can', async () => {
    // In French alone "Mecca" misses Mecca, Saudi Arabia; in English it comes first.
    const requested = answers({ en: [MECCA_SA, MECCA_CA], fr: [MECCA_CA_FR] });
    const places = await searchPlaces('Mecca', { lang: 'fr' });
    expect(requested.map((u) => u.match(/language=(\w+)/)[1]).sort()).toEqual(['en', 'fr']);
    expect(places.map((p) => [p.id, p.lang, p.label])).toEqual([
      [104515, 'en', 'Mecca, Mecca Region, Saudi Arabia'],
      [5371965, 'fr', 'Mecca, Californie, États-Unis'],
    ]);
  });

  it('finds a name in Arabic script, which only the Arabic answer has', async () => {
    answers({ en: [], ar: [CASA_AR] });
    const [place] = await searchPlaces('الدار البيضاء', { lang: 'ar' });
    expect(place).toMatchObject({ id: 2553604, lang: 'ar', city: 'الدار البيضاء', label: 'الدار البيضاء, الدار البيضاء - سطات, المغرب' });
  });

  it('does with one answer when the other fails, and fails only when both do', async () => {
    answers({ en: new Error('offline'), ar: [CASA_AR] });
    expect((await searchPlaces('الدار', { lang: 'ar' })).map((p) => p.id)).toEqual([2553604]);
    answers({ en: [MECCA_SA], ar: new Error('offline') });
    expect((await searchPlaces('Mecca', { lang: 'ar' })).map((p) => p.lang)).toEqual(['en']);
    answers({ en: new Error('offline'), ar: new Error('offline') });
    await expect(searchPlaces('Mecca', { lang: 'ar' })).rejects.toThrow('offline');
  });
});

describe('mergeByLang', () => {
  const en = (id) => ({ id, lang: 'en' });
  const ar = (id) => ({ id, lang: 'ar' });
  it("takes the English order, each place in the UI language where that answer has it, then the rest", () => {
    expect(mergeByLang([en(1), en(2), en(3)], [ar(3), ar(4), ar(1)])).toEqual([ar(1), en(2), ar(3), ar(4)]);
    expect(mergeByLang([], [ar(4)])).toEqual([ar(4)]);
    expect(mergeByLang([en(1)], [])).toEqual([en(1)]);
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

  it('gives up on a lookup that does not answer', async () => {
    jest.useFakeTimers();
    try {
      let signal;
      global.fetch = (url, init) => {
        signal = init.signal;
        return new Promise(() => {});
      };
      const saving = placeToSave(foundInArabic);
      const failed = expect(saving).rejects.toThrow('geocode: no answer');
      await jest.advanceTimersByTimeAsync(8000);
      await failed;
      expect(signal.aborted).toBe(true); // the request is let go
    } finally {
      jest.useRealTimers();
    }
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
