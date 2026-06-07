# Chrome Web Store — Privacy practices disclosure

Copy-paste source for the **Privacy practices** tab in the CWS developer console
(Store listing → Privacy). Keep this in sync with `docs/privacy-policy.html` and
the `permissions` / `host_permissions` in `manifest.json` on every submission.

> **Core claim: no analytics.** This extension contains no analytics, advertising,
> tracking, or fingerprinting code, and no third-party SDKs. It transmits no
> telemetry: the only data that ever leaves the device is the user-chosen location /
> search text sent to the two prayer-time APIs below. (It does keep a few simple
> usage counts — e.g. how many times media was auto-paused — but these live only in
> `chrome.storage.local`, are shown only to the user in the popup, and are never
> sent anywhere, so they are not "data collection" under CWS rules.) The GA4
> property `G-KDEFZ86L89` linked in the dev console receives nothing and can be
> ignored.

---

## Single purpose

> Adhan Caster shows Muslim prayer times with a live countdown and automatically
> pauses video and audio playback in every open browser tab when each prayer time
> begins, then resumes playback afterward.

## Permission justifications

| Field in console | Paste this |
|---|---|
| `storage` | Persists the user's settings (location, calculation method, heads-up lead time, auto-resume delay, focus mode) and the fetched prayer schedule locally via `chrome.storage.local`. Nothing is sent to a server. |
| `alarms` | Fires the countdown and triggers the media-pause precisely at each of the five daily prayer times, even when the popup is closed. |
| `notifications` | Shows a desktop notification at prayer time so the user knows the Adhan has begun. |
| `scripting` | Injects the pause/resume logic into tabs that are already open at install/update time (newly opened tabs are covered by the declared content script). |
| `tabs` | Sends the pause/resume signal to the user's open tabs so media can be paused across all of them at prayer time. |
| Host access (`http://*/*`, `https://*/*`) | Required so `<video>`/`<audio>` can be paused and resumed in **any** tab the user has open at prayer time — the cross-tab auto-pause that is the extension's single purpose. Page content is never read, stored, or transmitted. Also reaches `api.aladhan.com` (prayer times) and `geocoding-api.open-meteo.com` (place lookup). |
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

> The user chooses a location (city / region / country). That city/region/country
> is sent to the public AlAdhan prayer-times API (`api.aladhan.com`) to retrieve
> that location's daily prayer times, and the location-search text the user types
> is sent to the Open-Meteo geocoding API (`geocoding-api.open-meteo.com`) to
> resolve real places. The chosen location is stored only on the user's device
> (`chrome.storage.local`). It is never stored on any server we control, never
> linked to an identity, and never used for any purpose other than fetching prayer
> times. As with any web request, those third-party APIs automatically receive
> standard technical metadata (e.g. IP address); the extension attaches no
> identifier of its own.

> *Note:* "Location" is the location the user **types/picks**, not device GPS or
> automatic geolocation. We declare it because the city is transmitted off-device.

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
> and "Website content" are left unselected. The only off-device transmission is
> the user-chosen location / search text sent to the two prayer-time APIs named in
> the Location explanation. All local state — settings, schedule, prayer log, and a
> few on-device usage counts shown to the user in the popup — is held in
> `chrome.storage.local` and never transmitted.

---

## Privacy policy URL

`https://<your-pages-domain>/privacy-policy.html` (source: `docs/privacy-policy.html`).

> **Naming consistency check:** the manifest name is "Adhan Caster: Muslim Prayer
> Times & Auto-Pause" while `docs/privacy-policy.html` and `docs/index.html` say
> "Adhan Caster Pro". Pick one and make the store listing, manifest, and docs
> agree before submitting — reviewers flag listing/policy name mismatches.
