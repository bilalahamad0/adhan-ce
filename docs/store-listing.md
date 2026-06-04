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
🕌 Never miss a prayer because a video, podcast, or playlist pulled you in.

Adhan Caster turns your browser into a calm, reliable prayer companion. It shows accurate Muslim prayer times — Fajr, Sunrise, Dhuhr, Asr, Maghrib, and Isha — with a live countdown to the next salah and a real-time clock for your city. And the instant the Adhan begins, it automatically pauses every video and audio playing across all your open Chrome tabs. No scrambling for the mute button. No realizing an hour later that you prayed late.

When the moment comes, your screen settles: an optional full-screen Prayer Focus gently takes over with a softly animated reminder, so you can step away with intention. One click — or an automatic timer — brings everything back exactly where you left off.

━━━━━━━━━━━━━━━━━━━━━━━━
✨ WHAT MAKES IT SPECIAL
━━━━━━━━━━━━━━━━━━━━━━━━
⏰ Live local clock — the current time for your chosen city, right in the popup. Stop glancing at the system clock.
🕋 Every prayer + Sunrise — Fajr, Dhuhr, Asr, Maghrib, Isha, plus Shuruq (Sunrise), with the next prayer highlighted and a second-by-second countdown.
⏸️ Auto-pause everywhere — YouTube, Netflix, Spotify, podcasts, lecture tabs… all pause the instant the Adhan starts, in every open tab (even embedded players).
🧘 Animated Prayer Focus — a calm, breathing full-screen reminder during the Adhan. On by default, from the notification, or via Ctrl/Cmd+Shift+Y. Dismiss with Resume or Esc.
⏱️ Heads-up countdown — a discreet on-page nudge 15, 30, or 60 seconds before, so the pause never catches you mid-sentence.
▶️ Effortless resume — one click, or auto-resume after a delay you choose. Always in your control.
🌍 Any city on Earth — search and lock to your exact location; times are calculated precisely for you.
🌐 Your language — English, العربية, اردو, Bahasa Indonesia, Türkçe, Français — switch instantly, with full right-to-left support.
📅 Prayer tracking — check off each of the five daily prayers and watch your month fill in on a calendar, with a streak to keep you going. Kept entirely on your device.

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
Racing a deadline. Deep in a lecture playlist. Catching up on a series. Whatever has your attention, Adhan Caster quietly keeps watch and hands the moment back to you when it's time to stand before your Lord — then returns you to exactly where you were. Lightweight, distraction-free, and respectful of both your time and your privacy.

Prayer times are powered by the trusted Aladhan service; city search by Open-Meteo.

Made with care for the Ummah. We read every review and reply to feedback — tell us what would make your salah easier. 🤲

Keywords: Muslim prayer times, Adhan, Azan, Salah, Namaz, prayer reminder, Islamic prayer times, prayer notification, prayer clock, prayer tracker, salah tracker, Fajr, Dhuhr, Asr, Maghrib, Isha, Sunrise, Shuruq.
```

> The **first paragraph is the most important text on the page** — it's your search snippet and your conversion pitch. It now opens with "Adhan", "Muslim prayer times", and the five prayer names (all searchable) instead of jargon.

---

## 4. Category & language

- **Category:** Workflow & Planning *(current — keep it; it's where productivity/focus tools live and where the competitor sits).*
- **Language:** Ships with **English, Arabic, Urdu, Indonesian, Turkish, and French** (in-app switch with full RTL). In the dashboard, add a **localized listing per language** to unlock each language's search surface (see `docs/i18n.md`).

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
- Link your privacy policy: `https://adhan.bilalahamad.com/privacy-policy.html`

> ⏳ **Timing:** the live CWS listing still points to the old `bilalahamad0.github.io/adhan-ce/privacy-policy.html` from the v1.7.4 submission. **Update the Website + privacy-policy fields to the new `adhan.bilalahamad.com` URLs only AFTER v1.7.4 is approved** — editing a listing mid-review is best avoided. The github.io URL stays live (and its `<link rel="canonical">` points to the new domain) until then, so nothing breaks.

---

## 7. Screenshot captions (1280×800)

Screenshots are downscaled to 640×400, so use **large text and one idea per image**. Recommended order (first screenshot matters most):

1. **screenshot-1.png** *(hero)* — *"Pause every tab for prayer"* — with the sites it covers (YouTube, Netflix, Spotify, Twitch, Prime Video).
2. **screenshot-2.png** — *"One Adhan. Every tab stops."* — instant pause + one-click / auto resume.
3. **screenshot-3.png** — *"Five prayers, one glance."* — popup with live clock, Sunrise, any city.
4. **screenshot-4.png** — *"A heads-up before every prayer."* — 15 / 30 / 60s lead time.
5. **screenshot-5.png** — *"Pray in your language."* — 6 languages + full RTL (Arabic shown).
6. **screenshot-6.png** — *"Free, private, and yours."* — no ads, no tracking, no account.
7. **screenshot-7.png** — *"Never miss a prayer."* — the prayer-tracking calendar with streaks.

> Seven retina-rendered 1280×800 screenshots are generated into `docs/store/` by `npm run shots` (editorial layout, Fraunces/Inter web fonts). **Chrome Web Store allows up to 5 screenshots**, so pick your best five — the hero (#1) is essential and the tracker (#7) is a strong differentiator; if you must drop one, #6 (privacy) is the most expendable. Replace old media on the live listing.

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
