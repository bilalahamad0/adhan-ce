# Feature spec — Calculation method, Asr school, & Hijri date

Status: **proposed** · Author: engineering · Scope: `background.js`, `popup.html/js`, `lib/`, `manifest.json`, tests

## 1. Why

Competing prayer apps (incl. FivePrayer) let users pick a **calculation method** (15+ options) and show the **Hijri date**. We currently:
- **Hardcode method = 2 (ISNA)** — our companion API (`adhan-api/api/prayerTimes.js`) forces `method=2` and never exposes it.
- Ship **no Asr school** option (Hanafi users get wrong Asr times).
- Show **no Hijri date** — the companion strips `data.date.hijri` from the Aladhan response.

These are table-stakes features and each adds real, searchable value (and honest new store keywords: "calculation method", "Hanafi", "Hijri date").

## 2. Background — what Aladhan gives us (verified live 2026-06-02)

- **Methods**: `method=0..23, 99` (e.g. 2=ISNA, 3=MWL [Aladhan default], 1=Karachi, 4=Umm al-Qura, 5=Egypt, 13=Diyanet/Turkey, 17=JAKIM/Malaysia, 20=Kemenag/Indonesia, 15=Moonsighting, 99=custom). **Method 6 does not exist** — skip it.
- **Asr school**: `school=0` (Shafi/Standard, default) or `school=1` (Hanafi).
- **Hijri date**: returned at `data.date.hijri` → `{ date:"DD-MM-1447", day, weekday{en,ar}, month{number,en,ar,days}, year, designation{abbreviated:"AH"}, holidays[] }`.
- **CORS is fully open**: `Access-Control-Allow-Origin: *` (verified). A browser extension can call `api.aladhan.com` **directly** — the historical reason for our proxy (CORS) no longer applies.
- **Rate limit** 12 req/sec/IP; **free, no key**; server sends `Cache-Control: max-age=3600` + ETag. Prayer times for a date never change → cache once/day.
- **Hijri-only endpoint** (no prayer call): `GET https://api.aladhan.com/v1/gToH/{DD-MM-YYYY}` → `data.hijri`.

Endpoint we'd use (keeps our existing city/country data): 
`GET https://api.aladhan.com/v1/timingsByCity/{DD-MM-YYYY}?city={city}&country={country}&state={state}&method={m}&school={s}` → read `data.timings`, `data.date.hijri`, and `data.meta.timezone`.

## 3. Decision — call Aladhan directly (Option B)

| | (A) Extend companion `adhan-api` | (B) Call Aladhan directly ✅ |
|---|---|---|
| CORS | Works but unnecessary | Works (`ACAO: *` verified) |
| method/school/Hijri | Edit proxy: forward params, stop stripping Hijri, drop hardcoded `method=2` | Pass params in URL; read Hijri straight from response — **zero backend work** |
| Caching/offline | Needs Vercel KV/edge | Cache per (city,date,method,school) in `chrome.storage`; lean on server `max-age` |
| Failure points | extension→Vercel→Aladhan (2 hops, cold starts) | 1 hop |
| Known bugs | Proxy uses `ADHAN_TIMEZONE` env → "next prayer" wrong outside that zone | Use `data.meta.timezone` from Aladhan → correct everywhere |

**Recommendation: B.** It removes a hop and a maintenance burden, fixes the timezone bug, and gives method/school/Hijri for free. **Keep the companion only if** you later need a server choke-point (analytics, paid geocoding key, multi-provider fallback). If you keep it, the minimal change is: forward `method`/`school` (default 3/0, not hardcoded 2) and include `data.date.hijri` + `data.meta.timezone` in the JSON.

> Migration note: Option B introduces a behavioral change — switching the default method from **2 (ISNA)** to **3 (MWL, Aladhan's default)** would shift some users' times. To avoid surprising existing users, **default `method` to 2** in settings (preserving current behavior) and let users opt into others.

## 4. Settings / storage schema

Extend `DEFAULT_SETTINGS` in `background.js`:

```js
const DEFAULT_SETTINGS = {
  enabled: true,
  country: 'United States', state: 'California', city: 'Sunnyvale',
  autoResumeMinutes: 5, leadSeconds: 30, focusMode: true,
  // NEW:
  method: 2,        // Aladhan calculation method id; 2 = ISNA (current behavior)
  school: 0,        // 0 = Shafi/Standard, 1 = Hanafi
  showHijri: true,  // show the Hijri date in the popup header
  hijriOffset: 0,   // -1 | 0 | +1 days, user moon-sighting correction (see §6)
};
```

Schedule storage gains the Hijri block:

```js
schedule = {
  date: 'YYYY-MM-DD',
  prayers: [ { name, time, ts }, ... ],
  hijri: { day:'16', month:{ number:12, en:'Dhū al-Ḥijjah', ar:'ذوالحجة' }, year:'1447', weekday:{en,ar} },
  tz: 'America/Los_Angeles',  // from data.meta.timezone — used for next-prayer math
  fetchedAt: <ms>,
  key: '<city>|<country>|<date>|<method>|<school>'  // cache key; refetch when it changes
};
```

## 5. Code changes

### 5.1 `background.js` — fetch
Replace `API_BASE`/`fetchAndStoreSchedule` to call Aladhan directly:

```js
const ALADHAN = 'https://api.aladhan.com/v1/timingsByCity';

function ddmmyyyy(d){ const p=n=>String(n).padStart(2,'0'); return `${p(d.getDate())}-${p(d.getMonth()+1)}-${d.getFullYear()}`; }

async function fetchAndStoreSchedule() {
  const s = await getSettings();
  const date = ddmmyyyy(new Date());
  const key = `${s.city}|${s.country}|${date}|${s.method}|${s.school}`;
  const cached = (await chrome.storage.local.get('schedule')).schedule;
  if (cached && cached.key === key && cached.date === ymd(new Date())) {
    return { schedule: cached, nextPrayer: computeNext(cached.prayers, Date.now()) };
  }
  let url = `${ALADHAN}/${date}?city=${encodeURIComponent(s.city)}&country=${encodeURIComponent(s.country)}`
          + `&method=${s.method}&school=${s.school}`;
  if (s.state) url += `&state=${encodeURIComponent(s.state)}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Aladhan ${res.status}`);
  const { data } = await res.json();
  const base = new Date();
  const prayers = buildPrayers(pick5(data.timings), base);   // pick5: {Fajr,Dhuhr,Asr,Maghrib,Isha}
  const schedule = { date: ymd(base), prayers, hijri: simplifyHijri(data.date.hijri, s.hijriOffset),
                     tz: data.meta && data.meta.timezone, fetchedAt: Date.now(), key };
  const nextPrayer = computeNext(prayers, Date.now());
  await chrome.storage.local.set({ schedule, nextPrayer });
  return { schedule, nextPrayer };
}
```

`pick5(timings)` maps Aladhan's 24h `"HH:mm"` → our `buildPrayers` input. **Important:** Aladhan returns `"HH:mm"` (e.g. `"04:11"`), not `"hh:mm a"`. Either (a) extend `parseTimeToday` in `lib/schedule.js` to also accept 24h `"HH:mm"`, or (b) convert to `"hh:mm a"` before `buildPrayers`. **(a) is cleaner and keeps display flexible** — add a 24h branch to the regex.

### 5.2 `lib/schedule.js` — accept 24h times
```js
export function parseTimeToday(timeStr, base = new Date()) {
  let m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(timeStr);     // existing 12h
  if (m) { /* ...existing... */ }
  m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);                    // NEW 24h "HH:mm"
  if (m) { const d=new Date(base); d.setHours(+m[1], +m[2], 0, 0); return d.getTime(); }
  return null;
}
```
Add a `formatTime(ts, locale, hour12)` display helper so the popup can render either 12h or 24h (and localized digits — see i18n). Keep `formatCountdown` pure.

### 5.3 `lib/hijri.js` (new) — formatting
```js
export function simplifyHijri(h, offsetDays = 0) {
  if (!h) return null;
  // offset is applied at display via Intl OR by shifting day; simplest: keep raw + offset
  return { day: h.day, month: h.month, year: h.year, weekday: h.weekday, offset: offsetDays };
}
export function formatHijri(h, lang='en') {
  if (!h) return '';
  const mon = lang === 'ar' ? h.month.ar : h.month.en;
  return `${h.day} ${mon} ${h.year} AH`;   // localize digits via Intl at call site
}
```
(Or skip storing raw and use `Intl.DateTimeFormat('…-u-ca-islamic-umalqura', …)` on the Gregorian date — but Aladhan's value already encodes the official Saudi/HJCoSA sighting, so prefer Aladhan's `data.date.hijri` for accuracy and add the user `hijriOffset` for ±1 correction.)

### 5.4 `popup.html` — UI
Add to the settings panel (mirrors existing `<label class="field">` rows):
```html
<label class="field">
  <span data-i18n="calc_method">Calculation method</span>
  <select id="method"><!-- options injected from a METHODS list in popup.js --></select>
</label>
<label class="field">
  <span data-i18n="asr_school">Asr (juristic) method</span>
  <select id="school">
    <option value="0" data-i18n="asr_standard">Standard (Shafi, Maliki, Hanbali)</option>
    <option value="1" data-i18n="asr_hanafi">Hanafi</option>
  </select>
</label>
<label class="field toggle">
  <span data-i18n="show_hijri">Show Hijri date</span>
  <input type="checkbox" id="showHijri" />
</label>
```
And a Hijri line in the header next to `#locLabel`:
```html
<span id="hijriLabel" class="hijri"></span>
```

### 5.5 `popup.js`
- A `METHODS` array `[{id, name}]` (the 23 + custom) to populate `#method`.
- Read/write `method`, `school`, `showHijri`, `hijriOffset` in load/save.
- On save, **invalidate the cache** (the new `key` differs) and refetch.
- Render `#hijriLabel` from `schedule.hijri` when `showHijri`.

### 5.6 `manifest.json`
Add an explicit host permission for the direct calls (the broad `https://*/*` already covers it, but explicit is better for review and lets you later tighten):
```json
"host_permissions": ["https://api.aladhan.com/*", "http://*/*", "https://*/*"]
```
You may **remove** `https://adhan-api-mauve.vercel.app/*` once the companion is no longer called (and update `tests/manifest.test.js`, which currently asserts that host is present).

## 6. Edge cases & decisions
- **Default method = 2 (ISNA)** to preserve current users' times; document that 3 (MWL) is Aladhan's own default.
- **Hijri ±1 correction**: many communities' sighting differs from the computed date. Offer `hijriOffset ∈ {-1,0,+1}`. (Aladhan's default `HJCoSA` already encodes the official Saudi sighting; the offset is a user nicety. A true Aladhan-side shift needs `calendarMethod=MATHEMATICAL&adjustment=±1`, but a local ±day on the displayed number is simpler and offline-friendly.)
- **Timezone**: use `schedule.tz` (`data.meta.timezone`) for any cross-timezone correctness; today we parse in the browser's local zone, which is right only when the machine zone matches the city. Low priority unless users pick remote cities.
- **Offline/failure**: if the fetch fails, keep showing the last cached `schedule` (don't blank). Show a subtle "offline — showing last known times" note.
- **Custom method (99)**: out of scope for v1; add later behind an "Advanced" expander with Fajr/Isha angle inputs.

## 7. Tests
- `lib/schedule.test.js`: add cases for 24h `"HH:mm"` parsing (e.g. `'04:11'`, `'23:59'`, invalid `'24:01'`).
- New `lib/hijri.test.js`: `simplifyHijri`/`formatHijri` (en + ar month names, offset).
- `tests/manifest.test.js`: update host-permission assertion if you drop the Vercel host / add aladhan.
- Network is mocked in tests already (geocode pattern) — mock the Aladhan response shape (`{ data: { timings, date:{hijri}, meta:{timezone} } }`).

## 8. Rollout
1. Land schedule/parse changes (24h support) + Hijri storage behind `showHijri` (default off in a canary, on in release).
2. Add method/school selectors; keep default method=2.
3. Update store listing copy (`docs/store-listing.md`) to mention "15+ calculation methods, Hanafi/Shafi, Hijri date".
4. Optional follow-up: retire the companion API or reduce it to a thin analytics layer.

## Sources
- Aladhan: [methods](https://api.aladhan.com/v1/methods) · [prayer-times API](https://aladhan.com/prayer-times-api) · [calculation methods](https://aladhan.com/calculation-methods) · [Islamic calendar API](https://aladhan.com/islamic-calendar-api) · live header/JSON capture 2026-06-02
- Companion source: [adhan-api/api/prayerTimes.js](https://raw.githubusercontent.com/bilalahamad0/adhan-api/main/api/prayerTimes.js)
- Rate limit: [islamic.network community](https://community.islamic.network/d/2-is-there-a-rate-limit-on-the-apis)
