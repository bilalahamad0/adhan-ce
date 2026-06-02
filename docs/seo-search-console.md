# Get the landing page indexed — Google Search Console runbook

Target page: **`https://bilalahamad0.github.io/adhan-ce/`** (a GitHub Pages *project* site served from `main` → `/docs`). You already have `docs/sitemap.xml` and `docs/robots.txt`.

> TL;DR: Add a **URL-prefix** property, verify with an **HTML file or meta tag placed in `docs/`**, submit `sitemap.xml`, then **Request indexing**. DNS/Domain verification is impossible for `github.io` — don't try it.

---

## 0. Why this is slightly special

`github.io` is on the **Public Suffix List**, so `bilalahamad0.github.io` is a separate site you don't own at the DNS level. Two consequences:
- You **cannot** create a "Domain" property (those verify by DNS TXT only, and you can't edit `github.io`'s DNS).
- You **must** use a **URL-prefix** property and verify by serving a file/tag on your own subpath.

A URL-prefix property for `https://bilalahamad0.github.io/adhan-ce/` covers everything under `/adhan-ce/` (your homepage, `privacy-policy.html`, etc.) and nothing else on the host. That's exactly what you want.

---

## 1. Add the property

1. Open **[Google Search Console](https://search.google.com/search-console)** → **Add property**.
2. Choose **URL prefix** (the right-hand box).
3. Paste exactly: `https://bilalahamad0.github.io/adhan-ce/` (with the trailing slash).

## 2. Verify ownership — pick ONE

### Option A — HTML file (recommended for static Pages)
1. GSC gives you a file named like `google1234abcd.html`. Download it.
2. Put it in the repo's **`docs/`** folder (since Pages serves `/docs` at the site root, it resolves at `https://bilalahamad0.github.io/adhan-ce/google1234abcd.html`).
3. Commit + push to `main`, wait ~1–2 min for the Pages build.
4. Open that URL in a browser and confirm it loads (HTTP 200, no redirect — Google does **not** follow redirects for this file).
5. Click **Verify** in GSC.
6. **Leave the file in place forever** — deleting it loses verification.

### Option B — HTML meta tag
1. GSC gives you `<meta name="google-site-verification" content="TOKEN" />`.
2. Paste it into the `<head>` of **`docs/index.html`** (a `<!-- google-site-verification placeholder -->` line is already there — replace it).
3. Commit + push, wait for the build, click **Verify**. Keep it in place permanently.

### Option C — Google Analytics / Tag Manager
Only if you later add GA4/GTM to the page. Must be in `<head>`, and you must use the **same Google account** for GSC and GA/GTM. (Your page currently has no analytics, so use A or B.)

### ❌ Not available: DNS TXT
DNS verification is for Domain properties only, and you can't edit `github.io` DNS. Skip it.

---

## 3. Submit the sitemap

1. In GSC → **Indexing → Sitemaps**.
2. The box is prefilled with your property prefix; type just the relative path:
   ```
   sitemap.xml
   ```
   (resolves to `https://bilalahamad0.github.io/adhan-ce/sitemap.xml`).
3. Click **Submit**.

Your `robots.txt` already has `Allow: /` and a `Sitemap:` line, and every `<loc>` is under the property prefix — so it should fetch cleanly.

**If it says "Couldn't fetch":**
- Open `…/adhan-ce/sitemap.xml` in a browser — must be HTTP 200 and valid XML.
- Make sure `robots.txt` doesn't `Disallow` it (yours doesn't).
- Run **URL Inspection** on the sitemap URL; if Googlebot can fetch it, re-submit. The status often just lags — give it a day.

---

## 4. Inspect the homepage + request indexing

1. Click the **"Inspect any URL"** bar at the top of GSC and paste `https://bilalahamad0.github.io/adhan-ce/`.
2. Click **Test live URL** → confirm it's fetchable and indexable (returns 200, no `noindex`).
3. Click **Request indexing**.

**Expectations (be honest with yourself):**
- Crawling takes **a few days to a few weeks**; indexing is **never guaranteed**.
- Re-clicking "Request indexing" does **not** make it faster (there's a daily quota).
- `Discovered/Crawled – currently not indexed` for a brand-new, low-authority page usually means "not enough signal yet," not a bug. The fix is **backlinks + substance**, not config.

---

## 5. Help discovery (this is the real lever for a new page)

A brand-new `github.io` subpath has near-zero authority. Give Google reasons to crawl and index:
- **Link to it from places you control:** your Chrome Web Store listing ("Website" field), your GitHub repo README (already done), your social posts.
- Get even 1–2 genuine inbound links (a directory, a relevant forum/comment, the Product Hunt page).
- Keep the page substantive (it is — feature copy + FAQ + schema markup).
- **Do not** block it in `robots.txt` to "save crawl budget" — blocking *prevents* indexing.

---

## 6. Bonus channels (free, ~10 min)

### Bing Webmaster Tools — import from Google (no re-verification)
[bing.com/webmasters](https://www.bing.com/webmasters/) → **My Sites → Import** → sign in with Google → **Allow**. Pulls your verified property + sitemap straight from GSC. Bing also powers DuckDuckGo/Ecosia, so this is worthwhile.

### IndexNow (optional — Bing/Yandex/etc., NOT Google)
GitHub Pages can support it because it only needs a static key file:
1. Generate a hex key, save it as `docs/<key>.txt` (contents = the key) → served at `…/adhan-ce/<key>.txt`.
2. Ping: `https://www.bing.com/indexnow?url=https://bilalahamad0.github.io/adhan-ce/&key=YOUR_KEY&keyLocation=https://bilalahamad0.github.io/adhan-ce/YOUR_KEY.txt`
Google doesn't participate, so the Bing import above is usually enough.

---

## 7. One-screen checklist

- [ ] Add **URL-prefix** property `https://bilalahamad0.github.io/adhan-ce/`
- [ ] Verify via HTML file in `docs/` **or** the meta tag in `docs/index.html` `<head>`
- [ ] Submit `sitemap.xml`
- [ ] Inspect homepage → **Test live URL** → **Request indexing**
- [ ] Import into Bing Webmaster Tools
- [ ] Add a couple of real backlinks; then wait days–weeks and monitor the Page Indexing report

---

### Sources
- [Add a property](https://support.google.com/webmasters/answer/34592) · [Verify ownership](https://support.google.com/webmasters/answer/9008080) · [Sitemaps report](https://support.google.com/webmasters/answer/7451001) · [Ask Google to recrawl](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl) · [URL Inspection](https://support.google.com/webmasters/answer/9012289) · [Page indexing report](https://support.google.com/webmasters/answer/7440203)
- [GitHub: Configuring a publishing source](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site) · [GitHub blog: github.io + Public Suffix List](https://github.blog/engineering/infrastructure/yummy-cookies-across-domains/)
- [Bing: Import from Search Console](https://blogs.bing.com/webmaster/september-2019/Import-sites-from-Search-Console-to-Bing-Webmaster-Tools) · [IndexNow](https://www.indexnow.org/faq)
