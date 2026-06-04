// Minimal fetch router for tests. Match by URL substring → handler returning a
// body object (wrapped as an ok JSON Response) or a {status} to simulate failure.
// Records every requested URL on `.calls` for assertions.

export function makeFetch(routes = []) {
  const fn = async (url, init) => {
    fn.calls.push(String(url));
    fn.inits.push(init);
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) {
        const out = typeof handler === 'function' ? await handler(String(url), init) : handler;
        if (out && typeof out.status === 'number' && out.ok === undefined && out.json === undefined) {
          return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => out, ...(out && out.__response) };
      }
    }
    throw new Error(`fetch: no route for ${url}`);
  };
  fn.calls = [];
  fn.inits = [];
  return fn;
}

// A realistic Aladhan timingsByCity payload (24h "HH:mm" strings, like the API).
export function aladhanPayload(overrides = {}) {
  return {
    code: 200,
    status: 'OK',
    data: {
      timings: {
        Fajr: '04:27',
        Sunrise: '06:01',
        Dhuhr: '13:05',
        Asr: '16:56',
        Sunset: '20:17',
        Maghrib: '20:17',
        Isha: '21:43',
        ...overrides.timings,
      },
      meta: { timezone: 'America/Los_Angeles', ...overrides.meta },
      ...overrides.data,
    },
  };
}
