# Get the landing page indexed — Google Search Console runbook

Target page: **`https://adhan.bilalahamad.com/`** — the landing page (`docs/`) served by
**Vercel** on a subdomain of your own domain `bilalahamad.com` (DNS + the apex site are
managed in the **`bilalahamad0/profile`** Vercel setup). `docs/sitemap.xml` and
`docs/robots.txt` ship with it.

> TL;DR: Put the page on `adhan.bilalahamad.com` (Vercel, Root Directory = `docs`), then add a
> **Domain** property for `bilalahamad.com` in Search Console, verify with **one DNS TXT record**
> (added in Vercel DNS), submit the sitemap, and **Request indexing**. Because you own the domain,
> the Domain property — which the old `github.io` host couldn't use — is now the clean choice.

---

## 0. Why this is now the *better* setup

Previously the page lived on `bilalahamad0.github.io`, which is on the **Public Suffix List** — you
don't control its DNS, so a Domain property was impossible and you were stuck with a URL-prefix
property. Now the page is on **your** domain, so:

- You **can** create a **Domain** property for `bilalahamad.com` (verifies by **DNS TXT**, which you
  fully control in Vercel).
- **One** verification covers **every** subdomain (`adhan.`, `www.`, the apex) over **both** http and
  https — and it survives even if you change hosts later.
- It also gives you Search Console data for your personal apex site in the same property.

A Domain property reports on the whole domain; the canonical landing URL within it is
`https://adhan.bilalahamad.com/`.

---

## 1. Stand up the subdomain on Vercel (prerequisite)

The page must actually be served from your domain before the property is useful.

1. **Vercel → Add New… → Project → Import** the `bilalahamad0/adhan-ce` repo.
2. **Set Root Directory = `docs`** (critical — this serves `docs/index.html` at the site root, exactly
   like GitHub Pages did). Framework preset: **Other**. No build command, no install command.
3. Deploy. You'll get a `*.vercel.app` preview — confirm the page renders (logo, hero, screenshots).
4. **Project → Settings → Domains → add `adhan.bilalahamad.com`.** Since `bilalahamad.com`'s DNS is in
   the same Vercel account, Vercel auto-creates the CNAME and provisions HTTPS in a minute or two.
   (The apex stays on your `profile` project — subdomains attach to projects independently.)
5. Open `https://adhan.bilalahamad.com/` and confirm HTTP 200 + valid cert.

`docs/vercel.json` adds light security headers + asset caching; `docs/.vercelignore` keeps internal
docs/scripts off the public domain.

> **Duplicate-content note.** The old `bilalahamad0.github.io/adhan-ce/` mirror stays live (GitHub
> Pages is untouched) so the CWS v1.7.4 privacy URL keeps working during review. Both copies now carry
> `<link rel="canonical" href="https://adhan.bilalahamad.com/">`, so Google consolidates ranking
> signals onto the new domain. No redirect needed; don't add one (both hosts serve the same file).

---

## 2. Add the Domain property

1. Open **[Google Search Console](https://search.google.com/search-console)** → **Add property**.
2. Choose **Domain** (the left-hand box).
3. Enter exactly: `bilalahamad.com` (no `https://`, no subdomain, no path).
4. GSC shows a **TXT record** like `google-site-verification=XXXXXXXX`. Copy it.

## 3. Verify by DNS TXT (in Vercel)

1. **Vercel dashboard → Domains → `bilalahamad.com` → DNS Records** (or the project's Domains tab).
2. Add a record: **Type = TXT**, **Name/Host = `@`** (the apex), **Value =** the
   `google-site-verification=…` string GSC gave you. TTL: default.
3. Save. DNS on Vercel propagates fast (usually < 1–2 min).
4. Back in GSC, click **Verify**. If it says "not found," wait a couple minutes and retry —
   propagation lag, not a mistake.
5. **Leave the TXT record in place forever** — removing it loses verification.

> Keep the verification you may already have created for `https://bilalahamad0.github.io/adhan-ce/`
> (URL-prefix) or just delete it — harmless either way. The Domain property is now your primary.

---

## 4. Submit the sitemap

1. In GSC (the `bilalahamad.com` property) → **Indexing → Sitemaps**.
2. Enter the full URL: `https://adhan.bilalahamad.com/sitemap.xml` → **Submit**.

`robots.txt` already has `Allow: /` and the `Sitemap:` line, and every `<loc>` is now under
`adhan.bilalahamad.com` — so it should fetch cleanly.

**If it says "Couldn't fetch":** open the sitemap URL in a browser (must be HTTP 200 + valid XML), run
**URL Inspection** on it, and re-submit. Status often just lags a day.

---

## 5. Inspect the homepage + request indexing

1. Paste `https://adhan.bilalahamad.com/` into the **"Inspect any URL"** bar.
2. **Test live URL** → confirm fetchable + indexable (200, no `noindex`).
3. **Request indexing.**

**Honest expectations:**
- Crawling takes **days to weeks**; indexing is **never guaranteed**.
- Re-clicking "Request indexing" doesn't speed it up (daily quota).
- `Discovered / Crawled – currently not indexed` on a new low-authority page means "not enough signal
  yet," not a bug. The fix is **backlinks + substance**, not config (see §7).

---

## 6. Bing + others (free, ~10 min)

### Bing Webmaster Tools — import from Google (no re-verification)
[bing.com/webmasters](https://www.bing.com/webmasters/) → **My Sites → Import** → sign in with Google →
**Allow**. Pulls the verified property + sitemap straight from GSC. Bing also powers
DuckDuckGo/Ecosia, so it's worth it.

### IndexNow (optional — Bing/Yandex, NOT Google)
Vercel can serve the static key file: save a hex key as `docs/<key>.txt`, then ping
`https://www.bing.com/indexnow?url=https://adhan.bilalahamad.com/&key=YOUR_KEY&keyLocation=https://adhan.bilalahamad.com/YOUR_KEY.txt`.

---

## 7. The real lever for a new page

A brand-new domain has near-zero authority. Give Google reasons to crawl and index:
- **Link to it from places you control:** the Chrome Web Store "Website" field (update **after** v1.7.4
  is approved — see the timing note in `store-listing.md`), the GitHub README (done), your social posts,
  and a link/iframe from your `bilalahamad.com` personal site.
- Earn 1–2 genuine inbound links (a directory, a relevant forum, a Product Hunt page).
- Keep the page substantive (feature copy + FAQ + schema markup — it already is).
- **Don't** block it in `robots.txt` to "save crawl budget" — blocking *prevents* indexing.

---

## 8. One-screen checklist

- [ ] Vercel project from `adhan-ce`, **Root Directory = `docs`**, deployed
- [ ] `adhan.bilalahamad.com` added to the Vercel project (HTTPS green)
- [ ] Add **Domain** property `bilalahamad.com` in GSC
- [ ] Verify via **TXT** record in Vercel DNS (leave it forever)
- [ ] Submit `https://adhan.bilalahamad.com/sitemap.xml`
- [ ] Inspect homepage → **Test live URL** → **Request indexing**
- [ ] Import into Bing Webmaster Tools
- [ ] After v1.7.4 is approved: swap the CWS Website + privacy URLs to `adhan.bilalahamad.com`
- [ ] Add a couple of real backlinks; then monitor the Page Indexing report over days–weeks

---

### Sources
- [Add a property](https://support.google.com/webmasters/answer/34592) · [Domain property + DNS verification](https://support.google.com/webmasters/answer/9008080) · [Sitemaps report](https://support.google.com/webmasters/answer/7451001) · [Ask Google to recrawl](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl) · [URL Inspection](https://support.google.com/webmasters/answer/9012289) · [Page indexing report](https://support.google.com/webmasters/answer/7440203)
- [Vercel: add a domain](https://vercel.com/docs/projects/domains/add-a-domain) · [Vercel: managing DNS records](https://vercel.com/docs/projects/domains/managing-dns-records) · [rel=canonical & consolidation](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
- [Bing: Import from Search Console](https://blogs.bing.com/webmaster/september-2019/Import-sites-from-Search-Console-to-Bing-Webmaster-Tools) · [IndexNow](https://www.indexnow.org/faq)
