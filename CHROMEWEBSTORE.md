# Chrome Web Store Listing — Adhan Focus

> Last Updated: 2026-09-19

## Store Listing

**Extension Name** [REQUIRED]
Adhan Focus: Muslim Prayer Times & Auto-Pause

**Short Description** [REQUIRED]
Muslim prayer times with a live Adhan countdown that auto-pauses video & audio in every tab at salah. Free, no ads, private.

**Detailed Description** [REQUIRED]
🕌 Never miss a prayer because a video, podcast, or playlist pulled you in.

Adhan Focus turns your browser into a calm, reliable prayer companion. It shows accurate Muslim prayer times — Fajr, Sunrise, Dhuhr, Asr, Maghrib, and Isha — with a live countdown to the next salah and a real-time clock for your city. And the instant the Adhan begins, it automatically pauses every video and audio playing across all your open Chrome tabs. No scrambling for the mute button. No realizing an hour later that you prayed late.

When the moment comes, your screen settles: an optional full-screen Prayer Focus gently takes over with a softly animated reminder, so you can step away with intention. One click — or an automatic timer — brings everything back exactly where you left off.

━━━━━━━━━━━━━━━━━━━━━━━━
✨ WHAT MAKES IT SPECIAL
━━━━━━━━━━━━━━━━━━━━━━━━
⏰ Live local clock — the current time for your chosen city, right in the popup.
🕋 Every prayer + Sunrise — Fajr, Dhuhr, Asr, Maghrib, Isha, plus Shuruq (Sunrise), with the next prayer highlighted and a second-by-second countdown.
⏸️ Auto-pause everywhere — YouTube, Netflix, Spotify, podcasts, lecture tabs… all pause the instant the Adhan starts, in every open tab (even embedded players).
🧘 Animated Prayer Focus — a calm, breathing full-screen reminder during the Adhan. On by default, from the notification, or via Ctrl/Cmd+Shift+Y. Dismiss with Resume or Esc.
⏱️ Heads-up countdown — a discreet on-page nudge 15, 30, or 60 seconds before, so the pause never catches you mid-sentence.
▶️ Effortless resume — one click, or auto-resume after a delay you choose. Always in your control.
🌍 Any city on Earth — search and lock to your exact location; times are calculated precisely for you.
🌐 Your language — English, العربية, اردو, Bahasa Indonesia, Türkçe, Français — switch instantly, with full right-to-left support.
📅 Prayer tracking — check off each of the five daily prayers and watch your month fill in on a calendar, with color-coded prayer indicators and streaks. Kept entirely on your device.

━━━━━━━━━━━━━━━━━━━━━━━━
🔒 PRIVATE BY DESIGN — FREE FOREVER
━━━━━━━━━━━━━━━━━━━━━━━━
• No ads. No subscriptions. No account. No sign-in. Ever.
• Zero analytics. Zero tracking. Zero data harvesting.
• Everything stays on your device — the only thing that ever leaves is the city name needed to look up prayer times.
• Open source and built on the latest, most secure Manifest V3.

━━━━━━━━━━━━━━━━━━━━━━━━
💡 MADE FOR REAL LIFE
━━━━━━━━━━━━━━━━━━━━━━━━
Whatever has your attention, Adhan Focus quietly keeps watch and hands the moment back to you when it's time to stand before your Lord — then returns you to exactly where you were. Lightweight, distraction-free, and respectful of both your time and your privacy.

Prayer times are powered by the trusted Aladhan service; city search by Open-Meteo.

Made with care for the Ummah. We read every review and reply to feedback — tell us what would make your salah easier. 🤲

**Category** [REQUIRED]
Productivity (Workflow & Planning)

**Single Purpose** [REQUIRED]
Adhan Focus shows Muslim prayer times in the browser and automatically pauses audio/video playback in open tabs during the Adhan (call to prayer), then resumes it afterward.

**Primary Language** [REQUIRED]
English

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|---|---|---|---|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 | ✅ Ready | `docs/store/screenshot-1.png` |
| Screenshot 2 [RECOMMENDED] | 1280×800 | ✅ Ready | `docs/store/screenshot-2.png` |
| Screenshot 3 [RECOMMENDED] | 1280×800 | ✅ Ready | `docs/store/screenshot-3.png` |
| Screenshot 4 | 1280×800 | ✅ Ready | `docs/store/screenshot-4.png` |
| Screenshot 5 | 1280×800 | ✅ Ready | `docs/store/screenshot-5.png` |
| Small Promo Tile [RECOMMENDED] | 440×280 | ✅ Ready | `docs/store/promo-small-440x280.png` |
| Marquee Promo Tile | 1400×560 | ✅ Ready | `docs/store/promo-large-1400x560.png` |

### Screenshot Notes
- **Screenshot 1 (Hero)**: "Pause every tab for prayer" — showcase video platforms auto-paused simultaneously.
- **Screenshot 2**: "One Adhan. Every tab stops." — in-browser notification and one-click / auto resume.
- **Screenshot 3**: "Five prayers, one glance." — popup UI with local clock, countdown, and prayer schedule.
- **Screenshot 4**: "A heads-up before every prayer." — subtle in-page countdown overlay (15s/30s/60s).
- **Screenshot 5**: "Pray in your language." — multi-language support (Arabic, Urdu, Indonesian, Turkish, French, English).
- **Screenshot 7 (Alternate)**: "Never miss a prayer." — monthly Salah tracking calendar with color-matched indicators.

---

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Persists user preferences (location, calculation method, heads-up lead time, auto-resume delay, focus mode) and cached prayer schedule locally via `chrome.storage.local`. No data leaves the device. |
| `alarms` | permissions | Schedules reliable background timers to calculate countdowns, update icon badge indicators, and trigger cross-tab media pause precisely at prayer times even when the popup is closed. |
| `notifications` | permissions | Shows a desktop notification when prayer time begins so the user is alerted to the Adhan. |
| `offscreen` | permissions | Plays an audible prayer notification chime (`audio/chime.mp3`) at prayer time via a background audio document, without requiring an active browser tab or user gesture. |
| `scripting` | permissions | Injects media control and overlay logic into open tabs when the extension is first installed or updated, ensuring already-open tabs auto-pause without requiring a manual page reload. |
| `https://api.aladhan.com/*` | host_permissions | Fetches accurate daily prayer times for the user's selected city/coordinates. |
| `http://*/*`, `https://*/*` | host_permissions | Required to detect and pause playing `<video>` and `<audio>` elements across any site open during Adhan (e.g. YouTube, Netflix, podcasts). Page contents and browsing history are never read or stored. |

---

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** Yes (Location query only)

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|---|---|---|---|---|
| Personally identifiable info | No | No | N/A | No |
| Health info | No | No | N/A | No |
| Financial info | No | No | N/A | No |
| Authentication info | No | No | N/A | No |
| Personal communications | No | No | N/A | No |
| Location | Yes (City/Region) | Yes | Fetches prayer times from Aladhan API and city search from Open-Meteo | No (only sent to Aladhan/Open-Meteo for schedule lookup) |
| Web history | No | No | N/A | No |
| User activity | No | No | Stays local on device (`chrome.storage.local`) | No |
| Website content | No | No | N/A | No |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

---

## Privacy Policy

**Privacy Policy URL** [REQUIRED]:
`https://adhan.bilalahamad.com/privacy-policy.html`

---

## Distribution

**Visibility**: Public
**Regions**: All regions
**Pricing**: Free

---

## Developer Info

**Publisher Name**: Bilal Ahamad
**Contact Email**: adhan-caster@bilalahamad.com
**Support URL**: `https://github.com/bilalahamad0/adhan-ce/issues`
**Homepage URL**: `https://adhan.bilalahamad.com`

---

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 2.0.5 | 2026-09-15 | Option 1 (color-matched tracker pills), Option 2 (color-matched schedule badges), future prayer lock, label refreshes, auto-save settings | Submitted |
| 2.0.4 | 2026-08-17 | Multi-store release updates | Published |
| 2.0.0 | 2026-08-10 | Major redesign with Prayer Focus mode, media auto-pause, offline caching | Published |
