# Testing & Chrome Web Store qualification

How to verify Adhan Caster Pro before publishing a production build.

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
| Unit | `tests/geocode.test.js` | `lib/geocode.js` — parsing Open-Meteo results (region/no-region, empty payloads) and the `searchPlaces` fetch wrapper (mocked). |
| Unit | `tests/i18n.test.js` | `lib/i18n.js` pure helpers + locale-catalog integrity (every language has the English key set and the same `{placeholders}`). |
| Unit | `tests/i18n.runtime.test.js` | `lib/i18n.js` runtime — catalog fetch/cache/merge, `initI18n` language resolution, `setLang` persistence (chrome + fetch mocked). |
| Integration | `tests/background.test.js` | The MV3 service worker driven through its own listeners: install/seed/fetch, prayer fire, **stale (slept-through) fire**, fallback-pause idempotency, auto-resume + reconcile-after-reload, broadcast inject-then-retry, alarm arming, notification/command handlers, the full message router, and the dev-only test-Adhan gate. |
| Integration | `tests/content.test.js` | The content script in jsdom: cross-tab pause/resume, the in-window vs. stale per-tab fallback, client-side auto-resume, countdown + full-screen focus overlays (Trusted-Types-safe build), scroll lock, and single-instance teardown on reload/takeover. |
| Integration | `tests/popup.test.js` | The popup in jsdom: render from `GET_STATE`, location autocomplete + save validation, action buttons, language/RTL switching, and the dev-row/version build gate. |
| Platform | `tests/platform.test.js` | Cross-OS robustness: the macOS vs. default keyboard shortcut, DST-day scheduling (spring-forward/fall-back), date rollover, and OS-independent formatting. |
| Qualification | `tests/manifest.test.js` | MV3, semver version, ≤132-char description, module SW exists, icons exist + are real PNGs, popup/content files exist, permission set has no scope creep, host permissions, command defined, no leftover `index.html`, popup links resolve, popup is an ES module. |

`npm run pack` is the gate: it refuses to build the `.zip` if any test fails, and includes only the runtime files (`manifest.json`, scripts, styles, `icons/icon*.png`, `lib/`). CI (`.github/workflows/ci.yml`) runs the coverage suite on Ubuntu, Windows and macOS on every push/PR; the release workflow runs it again before signing a build.

## Manual QA checklist (per release)

Load unpacked from `chrome://extensions` (Developer mode) and verify:

### Install & permissions
- [ ] Loads with no errors on the extension card; "Inspect service worker" console is clean.
- [ ] Permission prompt lists only storage/alarms/notifications/scripting/tabs + site access.

### Schedule & location
- [ ] Popup shows 5 prayers; next is highlighted; past ones are checked/dimmed.
- [ ] Location search returns real places ("City, Region, Country"); picking one resolves region + country and reloads the schedule.
- [ ] Save is blocked unless a real geocoded place is selected (free-typed text is rejected).
- [ ] Countdown in the popup ticks down each second.

### Heads-up + pause flow (use **Run test Adhan (30s)** in dev)
- [ ] Bottom-right heads-up notification appears within the lead window and counts down. **No Resume button on it.**
- [ ] At zero, media pauses in the active tab **and** other tabs (test a 2nd tab + a same-site iframe).
- [ ] Desktop notification fires (OS must allow notifications for Chrome).
- [ ] Lead time honors the **Heads-up before Adhan** setting (15/30/60s).

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
- [ ] Toggling **Enable Adhan Caster** off stops notifications/pausing.

### Web Store listing requirements
- [ ] `version` bumped beyond the published one.
- [ ] Single-purpose description; broad host permission justified ("pause media in any tab").
- [ ] Privacy policy URL set; data-use disclosures completed.
- [ ] ≥1 screenshot (1280×800 or 640×400); 128px store icon.
- [ ] `npm run pack` passes and the zip contains no dev files.
