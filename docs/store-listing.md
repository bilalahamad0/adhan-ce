# Chrome Web Store listing — copy/paste source of truth

This is the optimized listing copy for the Chrome Web Store Developer Dashboard.
Goal: rank for the terms people actually search (**prayer times, adhan, azan, muslim, salah, namaz**) and convert browsers into installs.

> **How the fields map**
> - **Title** = `manifest.json` → `name` (already updated to the recommended title). Changing the title requires a re-upload + re-review.
> - **Summary** (the short line under the title) = `manifest.json` → `description` (already updated, 124/132 chars).
> - **Description** (the long body) = entered **only** in the Dashboard. Paste the block below.
> - **Screenshots / category / privacy** = all set in the Dashboard.

---

## 1. Title (≤ 75 chars; ~35 visible in search)

**✅ Live now in manifest:**
```
Adhan Caster: Muslim Prayer Times & Auto-Pause
```
Why: leads with the two highest-volume search terms (**Adhan**, **Muslim Prayer Times**) while keeping the "Adhan Caster" brand. The differentiator ("Auto-Pause") trails because it's not what people *search* — it's what makes you *win the click*.

**Alternates** (if you want to A/B later — only change once you have reviews, since a rename resets some momentum):
- `Muslim Prayer Times & Adhan — Auto-Pause Media` (pure-keyword, drops brand)
- `Prayer Times & Adhan — Auto-Pause Tabs at Salah` (leans into the focus/productivity angle)

> ⚠️ Don't keyword-stuff (e.g. "Prayer Times Adhan Azan Salah Namaz Muslim Islamic"). Google demotes/rejects stuffed titles. Brand + 2–3 real keywords is the safe, effective pattern.

---

## 2. Summary (≤ 132 chars)

**✅ Live now in manifest (124 chars):**
```
Muslim prayer times with a live Adhan countdown that auto-pauses video & audio in every tab at salah. Free, no ads, private.
```

---

## 3. Description (paste into the Dashboard "Description" field)

```
Never let a video or song play through the Adhan again.

Adhan Caster shows accurate Muslim prayer times for Fajr, Dhuhr, Asr, Maghrib, and Isha right in your browser, with a live countdown to the next salah. The moment the Adhan begins, it automatically pauses any video or audio playing in every open Chrome tab — then resumes with one click, or automatically after a delay you choose.

WHAT IT DOES
• All five daily prayer times with a live countdown to the next prayer
• Auto-pauses video & audio across every tab the instant the Adhan starts
• A heads-up countdown 15, 30, or 60 seconds before prayer (your choice)
• Optional full-screen "prayer focus" screen during the Adhan (toggle, notification button, or Ctrl/Cmd+Shift+Y; dismiss with Resume or Esc)
• One-click resume, or auto-resume after a delay you set
• Search any city worldwide — times are calculated for your exact location

PRIVATE & FREE FOREVER
• No ads. No subscriptions. No account. No sign-in.
• No analytics and no tracking of any kind.
• Your location and settings stay on your device (chrome.storage.local).
• The only data sent off your device is the city name / search text needed to look up prayer times and resolve your location.
• Open source and built on the latest Manifest V3.

Prayer times are provided by an Aladhan-based service; city search is powered by Open-Meteo.

Whether you're working, studying, watching lectures, or listening to music, Adhan Caster makes sure your browser pauses — and gently reminds you — when it's time to pray.

Made with care for the Ummah. Feedback and feature requests are always welcome.
```

> The **first paragraph is the most important text on the page** — it's your search snippet and your conversion pitch. It now opens with "Adhan", "Muslim prayer times", and the five prayer names (all searchable) instead of jargon.

---

## 4. Category & language

- **Category:** Workflow & Planning *(current — keep it; it's where productivity/focus tools live and where the competitor sits).*
- **Language:** English. *(Add more later — see the i18n note in launch-kit.md. Arabic, Urdu, Indonesian, Turkish, French, and Bengali would each unlock a large new search surface.)*

---

## 5. Single-purpose description (required field)

```
Adhan Caster shows Muslim prayer times in the browser and automatically pauses audio/video playback in open tabs during the Adhan (call to prayer), then resumes it afterward.
```

---

## 6. Permission justifications (paste into the Privacy tab)

Reviewers (and the Featured-badge team) read these. Be specific — vague justifications slow review.

| Permission | Justification to paste |
|---|---|
| `storage` | Saves your chosen location and preferences (lead time, auto-resume delay, focus mode) on your device via chrome.storage.local. No data leaves your device. |
| `alarms` | Schedules a reliable background timer so the countdown and the Adhan trigger fire at the exact prayer time even when the popup is closed. |
| `notifications` | Shows a desktop notification when it's time to pray. |
| `scripting` | Injects the content script that pauses media and renders the in-page heads-up countdown / focus screen on the page you're viewing. |
| `tabs` | Sends pause/resume messages to media playing in your other open tabs at prayer time. |
| `host_permissions` (`http://*/*`, `https://*/*`) | Required to pause `<video>`/`<audio>` on whatever sites you happen to have open at prayer time. The extension does not read or transmit page content. |
| `host_permissions` (prayer-times API host) | Fetches the daily prayer-time schedule for your chosen city. |

**Data-usage disclosures (check these honestly):**
- ❌ Does NOT collect personally identifiable info, health, financial, authentication, personal communications, location (GPS), web history, or user activity.
- ✅ The only network calls send the **city name / search text** to the prayer-times and geocoding services. Disclose this as "Website content → location query, to provide the core feature."
- ✅ Certify: not sold to third parties; not used for unrelated purposes; not used for creditworthiness.
- Link your privacy policy: `https://bilalahamad0.github.io/adhan-ce/privacy-policy.html`

---

## 7. Screenshot captions (1280×800)

Screenshots are downscaled to 640×400, so use **large text and one idea per image**. Recommended order (first screenshot matters most):

1. **screenshot-1.png** — *"All five prayer times, with a live countdown to the next salah."*
2. **screenshot-2.png** — *"The Adhan starts — every tab's video & audio pauses automatically."*
3. **screenshot-3.png** — *"Optional full-screen Prayer Focus. Resume with one click or Esc."*
4. *(add)* — *"A heads-up countdown 15/30/60s before — never caught off guard."*
5. *(add)* — *"Private & free. No ads, no account, nothing leaves your device."*

> You currently have 8 media items on the live listing but only 3 source screenshots in `docs/store/`. **Open your listing in an incognito window and confirm every image renders** — broken/placeholder images are a silent conversion killer. Regenerate with `npm run shots` if needed.

---

## 8. Pre-publish checklist

- [ ] Title updated (re-upload the new `manifest.json`)
- [ ] Summary updated (comes from the new `manifest.json` description)
- [ ] Long description pasted (section 3)
- [ ] Single-purpose statement pasted (section 5)
- [ ] All permission justifications pasted (section 6)
- [ ] Privacy policy linked + data-usage toggles set
- [ ] All screenshots verified in incognito; first one is the strongest
- [ ] Category = Workflow & Planning
- [ ] After it's polished: self-nominate for the **Featured badge** (Developer Support → "My item" → "I want to nominate"; once per 6 months)
