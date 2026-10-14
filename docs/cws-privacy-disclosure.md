# Chrome Web Store — Privacy practices disclosure

Copy-paste source for the **Privacy practices** tab in the CWS developer console
(Store listing → Privacy). Keep this in sync with `docs/privacy-policy.html` and
the `permissions` / `host_permissions` in `manifest.json` on every submission.

> **Core claim: no analytics.** This extension contains no analytics, advertising,
> tracking, or fingerprinting code, and no third-party SDKs. It transmits no
> telemetry: the only data that ever leaves the device is the user's chosen location (with the
> calculation method and Asr school) and search text, sent to the prayer-times API (`api.aladhan.com`) and the place-search API
> (`geocoding-api.open-meteo.com`), plus, only when the user clicks "Detect location", an
> IP-based location lookup (`api.bigdatacloud.net`, falling back to `ipapi.co`). (It does keep a few simple
> usage counts — e.g. how many times media was auto-paused — but these live only in
> `chrome.storage.local`, are shown only to the user in the popup, and are never
> sent anywhere, so they are not "data collection" under CWS rules.) The GA4
> property `G-KDEFZ86L89` linked in the dev console receives nothing and can be
> ignored.

---

## Single purpose

> Adhan Focus shows Muslim prayer times with a live countdown and automatically
> pauses video and audio playback in every open browser tab when each prayer time
> begins, then resumes playback afterward.

## Permission justifications

| Field in console | Paste this |
|---|---|
| `storage` | Persists the user's settings (location, calculation method, heads-up lead time, auto-resume delay, focus mode) and the fetched prayer schedule locally via `chrome.storage.local`. The storage permission itself sends nothing anywhere. |
| `alarms` | Fires the countdown and triggers the media-pause precisely at each of the five daily prayer times, even when the popup is closed. |
| `notifications` | Shows a desktop notification at prayer time so the user knows the Adhan has begun. |
| `offscreen` | Plays the subtle Adhan chime audio notification from the background service worker using the Chrome MV3 Offscreen API. No DOM or external content is loaded. |
| `scripting` | Injects the pause/resume logic into tabs that are already open at install/update time (newly opened tabs are covered by the declared content script). |
| Host access (`http://*/*`, `https://*/*`) | Required so `<video>`/`<audio>` can be paused and resumed in **any** tab the user has open at prayer time — the cross-tab auto-pause that is the extension's single purpose. Page content is never read, stored, or transmitted. Also reaches `api.aladhan.com` (prayer times), `geocoding-api.open-meteo.com` (place lookup) and, only when the user clicks "Detect location", `api.bigdatacloud.net` / `ipapi.co` (approximate location from the IP address). |
| Remote code | **No.** The extension executes no remotely-hosted code; every script ships inside the package. |

## Data usage — what to declare

Check **only** the data type that actually leaves the device:

- ☑ **Location** — see explanation below.
- ☐ Personally identifiable information
- ☐ Health information
- ☐ Financial and payment information
- ☐ Authentication information
- ☐ Personal communications
- ☐ **Web history** — *intentionally left unchecked; not collected.*
- ☐ **User activity** — *intentionally left unchecked; not collected.*
- ☐ **Website content** — *intentionally left unchecked; not collected.*

**Location — explanation to paste:**

> The user chooses a location (city / region / country) by searching or by clicking
> "Detect location". That city/region/country is sent to the public AlAdhan
> prayer-times API (`api.aladhan.com`) for its daily prayer times; on the welcome
> page shown after install, the chosen place's latitude/longitude is also sent to
> AlAdhan, to preview that day's times. The location-search text the user types is
> sent to the Open-Meteo geocoding API (`geocoding-api.open-meteo.com`) to find
> places. Only if the user clicks "Detect location", the extension requests an
> approximate city and coordinates from an IP-based location service
> (`api.bigdatacloud.net`, falling back to `ipapi.co`); the request carries no
> extension data, and the service sees the user's IP address. The chosen location
> is stored only on the user's device (`chrome.storage.local`), is never stored on
> our servers or linked to an identity, and is used only for prayer times. The
> extension attaches no identifier of its own to any request.

> *Note:* "Location" is the location the user types/picks, or the approximate city
> returned by the optional IP-based "Detect location" button. The extension never
> uses device GPS or the browser geolocation API. We declare it because the
> location is transmitted off-device.

> *On-device usage counts are NOT declared.* The extension keeps a few activity
> counts (media auto-paused, prayer alerts, active days) in `chrome.storage.local`,
> shown only to the user in the popup. Because they are never transmitted or shared,
> they are not "user data collection" under CWS and don't belong in this section.

## Certifications (all three apply)

- ☑ I do not sell or transfer user data to third parties, apart from the approved use cases.
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes.

## Optional "no analytics" remark (data-use notes / review remarks field)

> This extension contains no analytics, advertising, tracking, or fingerprinting
> of any kind, and includes no third-party SDKs. It transmits no telemetry. It does
> not collect browsing history, user activity, page content, cookies, or any
> personally identifying information — which is why "Web history", "User activity",
> and "Website content" are left unselected. The only off-device transmissions are
> the user's chosen location and search text, sent to the prayer-times and
> place-search APIs, and, only on a "Detect location" click, an IP-based location
> lookup, all named in the Location explanation. All local state — settings, schedule, prayer log, and a
> few on-device usage counts shown to the user in the popup — is held in
> `chrome.storage.local` and never transmitted.

---

## Privacy policy URL

`https://adhan.bilalahamad.com/privacy-policy.html` (source: `docs/privacy-policy.html`).

> **Naming:** the manifest and the Chrome/Edge listings use the full title
> "Adhan Focus: Muslim Prayer Times & Auto-Pause"; the Firefox (AMO) listing still
> carries the earlier title "Adhan Caster: Prayer Times", which the privacy policy
> names. The privacy policy and landing page otherwise use the short name "Adhan
> Focus". Legacy "Adhan Caster" branding otherwise survives only in internal IDs
> where required for compatibility (such as Firefox's immutable gecko.id).
