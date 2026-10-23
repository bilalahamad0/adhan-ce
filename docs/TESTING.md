# Testing & Chrome Web Store qualification

How to verify Adhan Focus before publishing a production build.

## Automated tests

Logic, behavior and packaging are covered by Jest (run from the repo root). The
suite loads the **real** `background.js`, `content.js` and `popup.js` against an
in-memory `chrome.*` mock (`tests/helpers/chrome-mock.js`), a `fetch` router
(`tests/helpers/fetch-mock.js`) and a jsdom DOM — so it exercises shipping code,
not re-implementations.

```bash
npm install                 # one-time: installs Jest + jsdom
npm test                    # run everything
npm run test:cov            # with coverage + enforced thresholds (~96% statements, ~98% lines)
npm run pack                # runs the tests, then zips a clean build only if they pass
```

| Suite | File | Covers |
| :--- | :--- | :--- |
| Unit | `tests/schedule.test.js` | `lib/schedule.js` — time parsing (AM/PM, midnight/noon, bad input), next-prayer selection incl. tomorrow-Fajr rollover, stale-fire guard, countdown formatting. |
| Unit | `tests/location-time.test.js` | `lib/schedule.js` location time — Aladhan's iso8601 times and their UTC offsets, the location's clock / date / day rollover with the browser's tz data out of date (Morocco +00 since 2026-09-20, British Columbia / Alberta after 2026-11-01; simulated by `tests/helpers/stale-icu.js`) and up to date (a DST switch in the night). |
| Unit | `tests/geocode.test.js` | `lib/geocode.js` — parsing Open-Meteo results (region/no-region, empty payloads), the `searchPlaces` fetch wrapper (mocked), and IP detection (coordinates rounded to 5 decimals, so the outbound guard lets them through). |
| Unit | `tests/i18n.test.js` | `lib/i18n.js` pure helpers + locale-catalog integrity (every language has the English key set and the same `{placeholders}`; Latin digits; Arabic and Urdu name a UI path in words, with no angle quote). |
| Unit | `tests/i18n.runtime.test.js` | `lib/i18n.js` runtime — catalog fetch/cache/merge, `initI18n` language resolution, `setLang` persistence (chrome + fetch mocked). |
| Integration | `tests/background.test.js` | The MV3 service worker driven through its own listeners: install/seed/fetch, prayer fire, **stale (slept-through) fire**, fallback-pause idempotency, auto-resume + reconcile-after-reload, broadcast inject-then-retry, alarm arming, notification/command handlers, the full message router, the dev-only test-Adhan gate, and the first-run gate (`locationConfirmed`: false on a new install, worked out on an update from finished setup or saved coordinates; while false no prayer/revalidation/badge alarm, a late prayer alarm or a tab's fallback pause does nothing, no pre-prayer re-fetch, and the tooltip says how to turn alerts on; a save carrying a place turns them on without catching up a prayer that passed meanwhile, a toggle's does not; another place than the default leaves nothing of the default's day to arm or recompute while its own is fetched, nor when that fetch fails, until the owed re-fetch lands). |
| Integration | `tests/content.test.js` | The content script in jsdom: cross-tab pause/resume, the in-window vs. stale per-tab fallback, the pause demo (never over a real pause, and leaving the fallback armed), no heads-up card or fallback pause before a place is chosen (both back once it is; broadcasts and dev test fires unaffected), client-side auto-resume, countdown + full-screen focus overlays (Trusted-Types-safe build), scroll lock, and single-instance teardown on reload/takeover. |
| Integration | `tests/popup.test.js` | The popup in jsdom: render from `GET_STATE`, location autocomplete + save validation, action buttons, language/RTL switching, the dev-row/version build gate, the location clock/date with out-of-date tz data, and before a place is chosen the Home notice (shown and hidden live, its **Choose city** button), an empty location search so no Save sends the default place, and the guide's "Not chosen yet". |
| Integration | `tests/welcome.test.js` | The onboarding page in jsdom: a searched or detected place is saved through the worker (so it fetches that place's schedule), translations and language switching, the pause demo labelled with the picked or detected place's next prayer (its chime played by the worker alone; off until that place's times are in, saying why; never an earlier place's; turned down during a prayer pause), the pin guidance per browser (Opera's cube), and finishing with no place (Skip, or Get Started with none picked): no place sent, setup done, the success view saying alerts are off until a city is chosen and where (in the page language), a place chosen elsewhere meanwhile (the popup's guide or Settings, before or after the success view shows) named there rather than said to be missing, and, through the real worker, alerts left off — or on, for a picked place or one chosen in the popup before Skip. |
| Platform | `tests/platform.test.js` | Cross-OS robustness: the macOS vs. default keyboard shortcut, DST-day scheduling (spring-forward/fall-back), date rollover, and OS-independent formatting. |
| Qualification | `tests/manifest.test.js` | MV3, semver version, ≤132-char description, module SW exists, icons exist + are real PNGs, popup/content files exist, permission set has no scope creep, host permissions (all sites, none already covered by another), web-accessible resources limited to what `content.js` loads (`icons/icon48.png`), command defined, no leftover `index.html`, popup links resolve, popup is an ES module. |

`npm run pack` is the gate: it refuses to build the `.zip` if any test fails, and includes only the runtime files (`manifest.json`, scripts, styles, `icons/icon*.png`, `lib/`). CI (`.github/workflows/ci.yml`) runs the coverage suite on Ubuntu, Windows and macOS on every push/PR; the release workflow runs it again before signing a build.

## Manual QA checklist (per release)

Load unpacked from `chrome://extensions` (Developer mode) and verify:

### Install & permissions
- [ ] Loads with no errors on the extension card; "Inspect service worker" console is clean.
- [ ] Permission prompt lists only storage/alarms/notifications/scripting + site access.

### First run (a new profile, or the extension removed and added again)
- [ ] The welcome page opens. Close it, or click **Skip**: no prayer pauses media, notifies, chimes or shows the heads-up card at the default city's (Sunnyvale's) times, the toolbar badge shows no countdown and its tooltip says to choose your city, and the popup's Home says alerts are off with a **Choose city** button.
- [ ] **Skip** (or **Get Started** with no city picked) says on the success view that prayer alerts are off until a city is chosen, and where; with a city picked or detected it names that city.
- [ ] **Choose city** opens Settings at an empty location search; pick a city and **Save**: the notice goes, the badge counts down, and that city's next prayer fires.
- [ ] **Test prayer pause (10s)** still works before a city is chosen.

### Schedule & location
- [ ] Popup shows 5 prayers; next is highlighted; past ones are checked/dimmed.
- [ ] Location search returns real places ("City, Region, Country"); picking one resolves region + country and reloads the schedule.
- [ ] Save is blocked unless a real geocoded place is selected (free-typed text is rejected).
- [ ] Countdown in the popup ticks down each second.
- [ ] Settings → **Adjust prayer times**: **All prayers** to +5 sets all five boxes (and shows "—" once one is changed on its own); set Dhuhr to +2 and Save — the list shows Dhuhr 2 minutes later with a `+2` mark, and the countdown/auto-pause follow it; set it back to 0 and the mark goes.
- [ ] Pick **Casablanca, Morocco**: the popup clock reads GMT+0 (the real time in Morocco, not an hour ahead), the times match aladhan.com, and the next prayer fires at its listed time.

### Heads-up + pause flow (use **Run test Adhan (30s)** in dev)
- [ ] Bottom-right heads-up notification appears within the lead window and counts down. **No Resume button on it.**
- [ ] At zero, media pauses in the active tab **and** other tabs (test a 2nd tab + a same-site iframe).
- [ ] Desktop notification fires (OS must allow notifications for Chrome).
- [ ] Lead time honors the **Banner Heads-up before Adhan** setting (15/30/60s).

### Focus mode
- [ ] With focus on, the full-screen focus screen takes over at Adhan time (no Resume-card flash beforehand).
- [ ] **Resume** button and **Esc** both dismiss it and resume media; page scroll is locked while it's up.
- [ ] `Ctrl/Cmd+Shift+Y` toggles the focus screen during an active Adhan.
- [ ] Auto-resume restores media after the configured delay.

### Build gating & theme
- [ ] **Run test Adhan** is visible when unpacked; confirm it's hidden in a packed/store build.
- [ ] Popup matches OS dark/light theme.

### Edge cases
- [ ] Restricted pages (`chrome://`, Web Store, PDF viewer) don't error — media there simply isn't paused.
- [ ] Day rollover: after the last prayer, "next" becomes tomorrow's Fajr.
- [ ] Toggling **Enable Adhan Focus** off stops notifications/pausing.

### Web Store listing requirements
- [ ] `version` bumped beyond the published one.
- [ ] Single-purpose description; broad host permission justified ("pause media in any tab").
- [ ] Privacy policy URL set; data-use disclosures completed.
- [ ] ≥1 screenshot (1280×800 or 640×400); 128px store icon.
- [ ] `npm run pack` passes and the zip contains no dev files.
