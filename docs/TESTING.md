# Testing & Chrome Web Store qualification

How to verify Adhan Caster Pro before publishing a production build.

## Automated tests

Pure logic and packaging are covered by Jest (run from the repo root):

```bash
npm install                 # one-time: installs Jest
npm test                    # unit + manifest qualification tests
npm run test:cov            # with coverage on lib/
npm run pack                # runs the tests, then zips a clean build only if they pass
```

| Suite | File | Covers |
| :--- | :--- | :--- |
| Unit | `tests/schedule.test.js` | `lib/schedule.js` — time parsing (AM/PM, midnight/noon, bad input), next-prayer selection incl. tomorrow-Fajr rollover, countdown formatting. |
| Unit | `tests/geocode.test.js` | `lib/geocode.js` — parsing Open-Meteo results (region/no-region, empty payloads) and the `searchPlaces` fetch wrapper (mocked). |
| Qualification | `tests/manifest.test.js` | MV3, semver version, ≤132-char description, module SW exists, icons exist + are real PNGs, popup/content files exist, permission set has no scope creep, host permissions, command defined, no leftover `index.html`, popup links resolve, popup is an ES module. |

`npm run pack` is the gate: it refuses to build the `.zip` if any test fails, and includes only the runtime files (`manifest.json`, scripts, styles, `icons/icon*.png`, `lib/`).

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
