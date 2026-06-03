# Adhan Caster — Launch & Growth Kit

Everything you need to get the extension in front of as many people as possible.
Copy/paste the posts, work the channel table top-to-bottom, and time a bigger push for Ramadan.

**Canonical links (use these everywhere):**
- 🧩 Chrome Web Store: `https://chromewebstore.google.com/detail/jfjknglldcdminelckmmfdbnlikiogia`
- 🌐 Landing page: `https://adhan.bilalahamad.com/`
- 💻 GitHub (open source): `https://github.com/bilalahamad0/adhan-ce`

> Add `?utm_source=reddit` / `?utm_source=producthunt` etc. to the store link per channel so you can see what's working.

---

## The one-line positioning

> **Adhan Caster pauses video & audio in every browser tab the moment the Adhan starts — so you never miss a prayer mid-scroll.** Free, open source, privacy-first.

Three angles, pick per audience:
- **Muslim audience:** "Never let YouTube/Netflix play through the Adhan again."
- **Maker/dev audience:** "MV3 extension, zero runtime deps, pauses media across all tabs — here's how I built it."
- **Productivity audience:** "A focus tool that hard-stops your tabs 5×/day."

---

## Channel plan (work this top-to-bottom)

| Channel | Audience size / fit | Promo tolerance | How to post |
|---|---|---|---|
| **r/chrome_extensions** | Small, perfectly targeted | ✅ Friendly to "I built this" | Full post (template below) |
| **r/SideProject** | Large, makers | ✅ Friendly | "I built this" post |
| **r/IndieHackers / r/indiehackers** | Makers | ✅ With a story | Build/learnings angle |
| **r/coolgithubprojects / r/opensource** | Devs | ✅ Open-source angle | Link + 1-paragraph desc |
| **r/webdev** (Showoff Saturday only) | Large, devs | ⚠️ Weekend thread only | In the weekly thread |
| **Hacker News — Show HN** | Huge, devs | ✅ If technical/honest | Show HN post (below) |
| **Product Hunt** | Large, early adopters | ✅ It's the point | Full launch (below) |
| **Facebook — Muslim community / MSA / local-masjid groups** | **Huge + on-target** | ✅ Often very tolerant of free tools | Short post (below) — *probably your single best channel* |
| **X/Twitter — "Muslim tech" + #buildinpublic** | Medium | ✅ | Thread (below) |
| **Muslim Discord / Telegram servers** | Medium, engaged | ⚠️ Ask a mod first | Share in #resources/#tools |
| **University MSAs (email)** | Medium, perfect | ✅ They amplify free tools | Email template (below) |
| **r/islam** (~1.4M) | Huge, on-target | ❌ **Self-promo removed** | Don't post a promo. Participate genuinely; only share if a relevant thread invites tools. |
| **r/Muslim, r/MuslimLounge, r/MuslimCorner, r/converts** | Medium | ⚠️ Varies — read rules / ask mods | Value-first only |

**Reddit reality:** the site-wide norm is the ~10% rule — your account shouldn't be mostly self-promo, and "download my app" posts get removed/downvoted. **Lead with the story, link in a comment or at the end.** Build a little comment karma first. Never post the same text to many subs the same day (spam filter).

---

## Ready-to-post copy

### 1) Reddit — r/chrome_extensions / r/SideProject

**Title:** I built a free Chrome extension that auto-pauses media in every tab at Muslim prayer time

**Body:**
```
I kept getting caught mid-YouTube when the Adhan (call to prayer) started, so I built Adhan Caster.

What it does:
- Shows the five daily prayer times with a live countdown to the next one
- The moment the Adhan begins, it pauses video & audio in EVERY open tab automatically
- Resumes with one click, or auto-resumes after a delay you set
- Optional full-screen "prayer focus" screen; heads-up countdown 15/30/60s before
- Search any city; times calculated for your location

Tech notes (since this is r/chrome_extensions): Manifest V3, zero runtime
dependencies, service worker + content-script fallback for reliable cross-tab
pausing (incl. cross-origin iframes), everything stored locally, no analytics.
Open source.

It's free, no ads, no account. Would love feedback — especially edge cases
where media doesn't pause.

Store: https://chromewebstore.google.com/detail/jfjknglldcdminelckmmfdbnlikiogia?utm_source=reddit
Code: https://github.com/bilalahamad0/adhan-ce
```

### 2) Hacker News — Show HN

**Title:** `Show HN: Adhan Caster – a Chrome extension that pauses all tabs at prayer time`

**Body:**
```
I'm Muslim and kept missing the Adhan because I was mid-video. Adhan Caster shows
the five daily prayer times with a live countdown, and the instant the Adhan
starts it pauses <video>/<audio> across every open tab — then resumes on click or
after a delay.

Build notes that might interest HN:
- Manifest V3, zero runtime dependencies.
- Cross-tab pausing uses a service worker + content-script fallback so it's
  idempotent and survives the SW being torn down. Handles same-origin and
  cross-origin iframes.
- Stale-fire guard ignores triggers >90s late (e.g. after the laptop sleeps).
- No analytics, no account; settings live in chrome.storage.local. The only
  network calls fetch prayer times for a city you pick.

Free + open source (MIT). Feedback welcome, especially on reliability edge cases.

https://github.com/bilalahamad0/adhan-ce
```
*(Post around 8–10am ET on a weekday. Respond to every comment. Don't ask for upvotes.)*

### 3) Product Hunt

- **Name:** Adhan Caster
- **Tagline (≤60):** `Auto-pause every browser tab at Muslim prayer time`
- **Topics:** Productivity, Chrome Extensions, Religion & Spirituality, Open Source
- **Description:**
```
Adhan Caster shows Muslim prayer times with a live countdown and automatically
pauses video & audio in every Chrome tab the moment the Adhan begins — then
resumes with one click or after a delay. Optional full-screen prayer focus.
Free, open source, no ads, no tracking. Everything stays on your device.
```
- **Maker's first comment:**
```
Hi PH 👋 I built Adhan Caster to solve my own problem: I'd be deep in a video and
miss the Adhan. Now my browser pauses itself 5×/day and nudges me to pray.

It's free and open source (MV3, zero runtime deps, no analytics). I'd love your
feedback — what would make this a daily-driver for you? Multi-language and a
Firefox/Edge build are next on my list.
```
*(Launch 12:01am PT. Line up 10–15 friends to be genuine early supporters. Be online all day to reply.)*

### 4) Facebook (Muslim community / MSA / masjid groups)

```
Asalamu alaikum 🌙 I made a free Chrome extension that automatically pauses
whatever video or audio you're watching the moment the Adhan starts — so you
don't miss salah while working or scrolling. It shows all five prayer times with
a countdown too. No ads, no sign-in, nothing leaves your device.

Free here: https://chromewebstore.google.com/detail/jfjknglldcdminelckmmfdbnlikiogia?utm_source=facebook

Would love your duas and feedback ❤️
```

### 5) X/Twitter thread (#buildinpublic + Muslim tech)

```
1/ I kept missing the Adhan because I was mid-YouTube. So I built Adhan Caster — a
free Chrome extension that pauses video & audio in EVERY tab the moment the Adhan
starts. 🧵

2/ It shows all 5 prayer times with a live countdown, gives a heads-up 15–60s
before, and has an optional full-screen "prayer focus" screen. Resume with one
click or let it auto-resume.

3/ Privacy-first: no ads, no account, no analytics. Everything stays on your
device. Open source, Manifest V3, zero runtime deps.

4/ It's free. If it helps you pray on time, that's the whole reward 🤲
Try it: https://chromewebstore.google.com/detail/jfjknglldcdminelckmmfdbnlikiogia?utm_source=twitter
```

### 6) Email to a university MSA / masjid

```
Subject: A free tool to help students not miss salah while studying online

Asalamu alaikum,

I built a free, open-source Chrome extension called Adhan Caster. When the Adhan
starts, it automatically pauses any video or audio playing in the browser and
shows the prayer times with a countdown — handy for anyone studying or working
online. No ads, no sign-up, nothing leaves the device.

If you think your members would find it useful, I'd be grateful if you shared it:
https://chromewebstore.google.com/detail/jfjknglldcdminelckmmfdbnlikiogia

Jazakum Allahu khayran,
Bilal
```

---

## Getting your first reviews (ethically)

Reviews matter for both ranking and click-through (you have 0; the closest competitor has 7×5.0★).
- Ask people who **genuinely use it** — family, friends, your masjid/MSA WhatsApp groups.
- In the extension or landing page, add a soft "Enjoying it? A quick review helps 🙏" link to the store reviews tab. (Don't nag, don't gate features behind it.)
- **Never** buy reviews or post fake ones — Google detects review rings and will delist you.
- Reply to every review, especially critical ones. It signals an active maintainer (a ranking signal) and converts skeptics.
- Target: **10 genuine reviews in the first 30 days.**

---

## Timing — plan the big push for Ramadan

Prayer-app installs spike enormously around Ramadan. **Ramadan 1448 is expected to begin around February 8–9, 2027** (exact date depends on moon sighting; it moves ~10–11 days earlier each year).

**Pre-Ramadan ramp (start ~6 weeks out, early Jan 2027):**
- Listing fully polished + 10+ reviews already in place ✅
- Coordinate Product Hunt + Reddit + Facebook + X in the **2 weeks before** Ramadan
- Publish a blog post ("Tools to help you pray on time this Ramadan") — see SEO note below
- Reach out to MSAs/masjids before the rush

**Secondary spikes worth a smaller push:** New Year (Jan, "focus/productivity resolutions" angle) and back-to-school (late Aug/Sep, student angle).

---

## Beyond the Chrome listing — the competitor's real growth engine

FivePrayer doesn't win because of one good listing. They win because they're **everywhere**:
they have an iOS app, an Android app, two WordPress plugins, and a website with an SEO blog
(e.g. a "Best Muslim Apps 2026" post). The Chrome listing is just one funnel.

Highest-leverage expansions, in order:

1. **Ship the landing page** (`docs/index.html`, already built in this repo) and submit it to Google Search Console so it gets indexed. It's a free, permanent install funnel that ranks for "adhan chrome extension" etc.
2. **Write 2–3 SEO blog posts** on the same site: "How to never miss the Adhan while working", "Best Chrome extensions for Muslims", "Prayer-time tools for students". These rank for long-tail queries and feed installs for years.
3. **Port to Edge & Firefox.** The Edge Add-ons store accepts Chromium extensions almost as-is and has far less competition — easy extra reach. Firefox needs minor MV3 tweaks.
4. **Add the features users expect from prayer apps** (closes the gap with competitors and earns new keywords): calculation-method selection (your Aladhan API already supports it), a Hijri date, and optionally streaks/stats.
5. **Internationalize (`_locales/`).** Arabic, Urdu, Indonesian, Turkish, French, Bengali. Each localized listing ranks in that language's searches — this is one of the biggest untapped reach levers for a Muslim app.

---

## First-week action checklist

- [ ] Re-upload the extension with the new title/summary (from manifest) + paste the long description, permission justifications, and single-purpose statement (`docs/store-listing.md`)
- [ ] Verify all screenshots render in an incognito window
- [ ] Get 5 genuine reviews from people who'll actually use it
- [ ] Deploy the landing page (commit `docs/` + push) and submit it to Google Search Console
- [ ] Post to r/chrome_extensions and r/SideProject (different days)
- [ ] Post to 2–3 Facebook Muslim/MSA groups
- [ ] Post the X thread
- [ ] Schedule the Product Hunt + Show HN launches for a Tuesday–Thursday
- [ ] After it's polished + has reviews: self-nominate for the Featured badge
