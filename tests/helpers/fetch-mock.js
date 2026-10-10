// Minimal fetch router for tests. Match by URL substring → handler returning a
// body object (wrapped as an ok JSON Response) or a {status} to simulate failure.
// Records every requested URL on `.calls` for assertions. An Aladhan request
// carrying iso8601=true gets its answer in that form (see asAladhanIso).
import { zonedToEpoch, tzOffsetMs } from '../../lib/schedule.js';

export function makeFetch(routes = []) {
  const fn = async (url, init) => {
    fn.calls.push(String(url));
    fn.inits.push(init);
    for (const [match, handler] of routes) {
      if (String(url).includes(match)) {
        let out = typeof handler === 'function' ? await handler(String(url), init) : handler;
        if (out && typeof out.status === 'number' && out.ok === undefined && out.json === undefined) {
          return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => ({}) };
        }
        out = asAladhanIso(out, String(url));
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
// `plain: true` keeps it plain even for an iso8601=true request (an answer
// without offsets); `isoOffset` ('+00:00') pins the UTC offset of its iso8601 form.
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
    ...(overrides.plain ? { __plain: true } : {}),
    ...(overrides.isoOffset ? { __isoOffset: overrides.isoOffset } : {}),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');
function offsetLabel(min) {
  const a = Math.abs(min);
  return `${min < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

// What Aladhan answers to a request carrying iso8601=true: each plain 'H:MM'
// timing becomes 'YYYY-MM-DDTHH:MM:00±HH:MM' on the day answered for, at the UTC
// offset this Node's tz data gives the payload's zone at that time (the fixtures'
// zones have unchanged rules) unless the payload pins one (`isoOffset`). Timings
// already in that form, a `plain` payload, other requests and other bodies pass
// through unchanged.
export function asAladhanIso(body, url) {
  if (!/api\.aladhan\.com/.test(url) || !/[?&]iso8601=true(&|$)/.test(url)) return body;
  const data = body && body.data;
  if (!data || !data.timings || body.__plain) return body;
  const answered = (data.date && data.date.gregorian && data.date.gregorian.date) || (url.match(/\/(\d{2}-\d{2}-\d{4})\?/) || [])[1];
  if (!answered) return body;
  const [d, mo, y] = answered.split('-').map(Number);
  const zone = data.meta && data.meta.timezone;
  const timings = {};
  for (const [name, raw] of Object.entries(data.timings)) {
    const m = typeof raw === 'string' && raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) {
      timings[name] = raw;
      continue;
    }
    const h = Number(m[1]);
    const mi = Number(m[2]);
    let label = body.__isoOffset;
    if (!label) {
      const min = zone
        ? Math.round(tzOffsetMs(new Date(zonedToEpoch(y, mo, d, h, mi, zone)), zone) / 60000)
        : -new Date(y, mo - 1, d, h, mi).getTimezoneOffset();
      label = offsetLabel(min);
    }
    timings[name] = `${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:00${label}`;
  }
  return { ...body, data: { ...data, timings } };
}
