---
title: "Adhan Caster Pro"
slug: "adhan-caster-pro"
tagline: "A privacy-first Chrome extension that pauses media in every tab at prayer time."
date: "2026-05-24"
status: "In review — Chrome Web Store"
category: "Browser Extension"
role: "Design & engineering (solo)"
tech:
  - "Manifest V3"
  - "JavaScript (ES Modules, no framework)"
  - "Chrome Extension APIs (alarms, storage, notifications, scripting, tabs)"
  - "Shadow DOM"
  - "Jest"
  - "Open-Meteo geocoding"
  - "Vercel (API)"
links:
  extension: "https://github.com/bilalahamad0/adhan-ce"
  api: "https://github.com/bilalahamad0/adhan-api"
  privacy: "https://bilalahamad0.github.io/adhan-ce/privacy-policy.html"
cover: "./demo.gif"
---

> **TL;DR** — Adhan Caster Pro is a Chrome extension that shows a live countdown to
> the next Islamic prayer and, the moment the Adhan begins, **pauses video and audio
> across every open tab** — with an optional full-screen "prayer focus" screen and
> automatic resume afterward. It's built on Manifest V3, ships zero runtime
> dependencies, sends no analytics, and stores everything on your device.

## The problem

If you pray five times a day and also live on the web — lectures, YouTube, a
podcast in a background tab, a video call queued up — the Adhan tends to arrive
while something is playing. The honest options are bad: mute the world manually,
tab by tab, or miss the call to prayer entirely. I wanted the browser to handle
the etiquette for me: when it's time, *everything* pauses; when I'm done, it picks
up where it left off.

That's the whole product in one sentence — and, as usual, the interesting part was
making that one sentence reliable.

## What it does

- **Next-prayer popup** with all five daily prayers, the next one highlighted, and
  a second-accurate countdown.
- **In-page heads-up card** that slides into the corner of whatever tab you're
  looking at shortly before the Adhan (15/30/60s, configurable).
- **Cross-tab auto-pause** — at prayer time every playing `<video>`/`<audio>`,
  including ones inside same- and cross-origin iframes, is paused.
- **Prayer focus mode** — an opt-in, dismissible full-screen overlay during the
  Adhan, triggerable from the notification, the popup, or `Ctrl/⌘+Shift+Y`.
- **Resume + auto-resume** — one button restores playback everywhere, and it
  resumes on its own after a configurable delay (default 5 minutes).
- **Location picker** backed by Open-Meteo geocoding, so you can only save a real,
  resolvable place — no guessing time zones from a free-text box.

## How it works

The extension is deliberately small and framework-free. Four moving parts:

| Piece | Responsibility |
| :--- | :--- |
| `background.js` (MV3 service worker) | Fetches the daily schedule, parses prayer strings into timestamps, arms `chrome.alarms`, fires the desktop notification, broadcasts the cross-tab pause, and arms auto-resume. |
| `content.js` (injected into **all frames**) | A per-second ticker that renders the corner countdown and the full-screen focus overlay (top frame, in Shadow DOM) and pauses/resumes its own frame's media. |
| `popup.*` | Prayer list, live countdown, Resume, the location search, and settings. |
| `lib/schedule.js`, `lib/geocode.js` | Pure, dependency-free helpers (time parsing, next-prayer selection, formatting, geocoding) — the unit-tested core. |

Prayer times come from [**adhan-api**](https://github.com/bilalahamad0/adhan-api), a
small companion service I run on Vercel, and locations resolve through the free,
keyless [Open-Meteo](https://open-meteo.com/) geocoding API. The extension itself
carries no API keys and no third-party SDKs.

## Engineering deep dive

The features are simple to describe. Manifest V3 made them genuinely tricky to get
right — and the bugs I hit are a good tour of what's different about modern
extensions.

### 1. Pausing media you don't control

Pages bury players inside nested, cross-origin iframes, so a single script on the
top document can't reach them. The fix is to run the content script in **every
frame** (`all_frames: true`) and let each frame pause *its own* media, while the
service worker fans out a single "it's prayer time" broadcast to all of them. The
UI (corner card, focus screen) only renders in the top visible frame, so you see
one overlay, not one per iframe.

### 2. The service worker is asleep most of the time

MV3 killed the persistent background page. The service worker is evicted after a
few idle seconds and revived on demand — which means `chrome.alarms` is **not
second-accurate** when the prayer arrives. If I relied on the alarm alone, the
pause could land seconds late.

So the content script keeps its own per-second clock and **self-triggers the
pause** the instant its countdown hits zero, independent of the service worker.
Both paths are idempotent, so whichever fires first wins and the other is a no-op.

That design papered over a subtle bug, though: the content-script fallback pause
only updated *local* state and never told the background, so **auto-resume was
never armed**. If the alarm was delayed (e.g., overnight, when the machine is
mostly idle), media could stay paused indefinitely. The fix was to have the
fallback notify the background, which records the pause centrally and arms the
resume timer — plus a `reconcilePaused()` pass on startup that re-arms (or
immediately fires) resume for any pause already in progress.

The flip side of a late alarm is a *stale* one. When the device sleeps through
prayer time, Chrome doesn't run the alarm on schedule — it delivers the missed
alarm on wake, sometimes many minutes later. Acting on it then meant waking the
laptop to a frozen, full-screen focus overlay and a fresh auto-resume countdown
for a prayer whose moment had already passed. So both fire paths now ignore a
fire delivered more than `STALE_FIRE_MS` (90s) past its scheduled time: the
background treats it as **missed** — no pause, just advance to the next prayer —
and the content-script fallback already bounds itself to the same window.

### 3. When a content script becomes a ghost

Reload or update an extension and any content script already running in an open
tab has its context **invalidated** — but its DOM stays on the page. I hit a case
where a stale overlay was frozen on screen forever: it could no longer receive a
"resume" message, so nothing could dismiss it.

The lifecycle fix has three parts: a fresh instance **removes leftover overlays**
on load; each frame is **claimed by the newest instance** via a token so older
ones stand down; and the ticker **detects a dead context** (`chrome.runtime.id`
gone) and tears its own UI down instead of leaving a corpse on the page. The
invariant I wanted — *exactly one live overlay per frame, and never an
undismissable one* — finally held.

The lesson that kept repeating: in MV3 you can't assume your code is alive, in
sync, or singular. Make every state transition idempotent and self-healing.

## Built to be trusted

A tool that can read and pause media on every site you visit has to earn that
permission. So the data story is deliberately boring:

- **No analytics, no tracking, no account, no cookies.**
- Settings and the schedule live only in `chrome.storage.local` on your device.
- The only data that leaves the browser is the **city you choose** (to fetch prayer
  times) and the **text you type** into the location search (to resolve places).
- The content script touches a page solely to find `<video>`/`<audio>` elements —
  it never reads or transmits page content.

The full [privacy policy](https://bilalahamad0.github.io/adhan-ce/privacy-policy.html)
spells out every permission and why it exists.

## Quality: tests and a reproducible demo

The pure logic — time parsing, next-prayer selection across midnight, countdown
formatting, geocode parsing — is covered by a Jest suite, alongside a **manifest
qualification test** that gates releases: it checks MV3 compliance, real PNG
icons, resolvable popup/content files, and that no permission has crept in beyond
the documented set. `npm run pack` refuses to build the store zip unless all of it
passes.

Even the marketing GIF is reproducible: a script drives headless Chrome over a
deterministic demo page (`demo.html?t=<ms>`), screenshots each frame, and stitches
them with ffmpeg — so the animation in this post is regenerated from source, not
hand-recorded.

## Tech stack

**Vanilla JavaScript (ES modules), Manifest V3, Shadow DOM, Chrome Extension APIs
(alarms · storage · notifications · scripting · tabs), Jest, Open-Meteo geocoding,
and a small Vercel-hosted API.** No frameworks, no bundler, no runtime
dependencies.

## Try it

- **Extension source:** [github.com/bilalahamad0/adhan-ce](https://github.com/bilalahamad0/adhan-ce)
  — clone it, then *Load unpacked* from `chrome://extensions` (Developer mode).
- **Prayer-times API:** [github.com/bilalahamad0/adhan-api](https://github.com/bilalahamad0/adhan-api)
- **Chrome Web Store:** in review — link coming on approval.

## What's next

Multi-calculation-method support (different schools/regions), a weekly schedule
view, and optional Adhan audio. The core stays the same: do the respectful thing,
quietly, and never make you babysit your tabs at prayer time.
