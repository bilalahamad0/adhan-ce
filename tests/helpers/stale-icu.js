// Simulate a browser whose bundled tz data predates IANA 2026b/2026c — the
// user-visible bug: Morocco moved to permanent +00 on 2026-09-20, and British
// Columbia and Alberta stopped falling back on 2026-11-01, but such a browser
// still reads Africa/Casablanca as +01 and falls back in Vancouver and Edmonton.
// Each changed zone is read with the rules of a zone that still has the old ones,
// so the tests behave the same whatever tz data this Node ships. Covers
// Intl.DateTimeFormat and Date#toLocale{Time,Date,}String (they take a timeZone
// option without going through the constructor). Machine-local getters
// (getHours, new Date(y, m, d)) follow the process TZ and can't be stubbed here.
export const STALE_ZONES = {
  'Africa/Casablanca': 'Etc/GMT-1', // +01 all year (POSIX sign is inverted)
  'Africa/El_Aaiun': 'Etc/GMT-1',
  'America/Vancouver': 'America/Los_Angeles', // -07/-08, still falling back
  'America/Edmonton': 'America/Denver', // -06/-07, still falling back
};

export function simulateStaleTzData(map = STALE_ZONES) {
  const Real = Intl.DateTimeFormat;
  const fix = (o) => (o && o.timeZone && map[o.timeZone] ? { ...o, timeZone: map[o.timeZone] } : o);
  function Stale(locales, options) {
    return new Real(locales, fix(options));
  }
  Stale.prototype = Real.prototype;
  Stale.supportedLocalesOf = Real.supportedLocalesOf.bind(Real);
  Intl.DateTimeFormat = Stale;
  const saved = {};
  for (const k of ['toLocaleTimeString', 'toLocaleDateString', 'toLocaleString']) {
    saved[k] = Date.prototype[k];
    Date.prototype[k] = function (locales, options) {
      return saved[k].call(this, locales, fix(options));
    };
  }
  return () => {
    Intl.DateTimeFormat = Real;
    Object.assign(Date.prototype, saved);
  };
}
