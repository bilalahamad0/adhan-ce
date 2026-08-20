# Releasing Adhan Caster

How to publish a new version to the Chrome Web Store, Firefox/AMO, and Microsoft
Edge Add-ons.

> **⚠️ Tag namespaces decide the store.** Releases are triggered by **prefixed**
> tags, never a bare `v*`:
> - **`chrome-v<version>`** → [`Release (Chrome)`](.github/workflows/release.yml):
>   signs the CRX and submits to the **live Chrome Web Store**.
> - **`firefox-v<version>`** → [`Release (Firefox)`](.github/workflows/release-firefox.yml):
>   builds + AMO-signs the XPI and submits to **addons.mozilla.org**.
> - **`edge-v<version>`** → [`Release (Edge)`](.github/workflows/release-edge.yml):
>   builds the ZIP and submits to **Microsoft Edge Add-ons**.
>
> A bare `v<version>` tag is **retired** — it triggers no release and
> [`release-tag-guard.yml`](.github/workflows/release-tag-guard.yml) fails it on
> purpose. This keeps one store's release from ever touching another. All three
> stores share one `manifest.json` version, so you can tag the same commit
> `chrome-v2.1.0`, `firefox-v2.1.0` and `edge-v2.1.0`.

> **Verified CRX uploads is enabled** on the Chrome listing. Every CWS upload
> must be a `.crx` signed with the project's verified-uploads private key. Plain
> `.zip` uploads will be rejected. (Firefox is different — AMO signs the XPI
> server-side, so there is no local Firefox key.)

There are two release paths:

- **[Automated (default)](#automated-release-via-github-actions)** — push a tag,
  GitHub Actions builds + attaches the signed CRX to a draft release. Requires
  one-time setup of the `CRX_PRIVATE_KEY_B64` secret (see
  [`.github/RELEASE_SETUP.md`](.github/RELEASE_SETUP.md)).
- **[Manual fallback](#manual-fallback-pack-locally)** — pack on your own
  machine with Chrome's GUI or `npm run pack:crx`. Use when CI is broken or
  the key secret isn't configured.

## Prerequisites (one-time)

You need the verified-uploads private key: `adhan-caster-private.pem`.

- It is **not in this repo** (and never should be — `*.pem` is gitignored).
- Stored in: _\<password manager entry name + offline backup location\>_ —
  fill this in with your actual backup locations and keep it private.
- **Losing this key means you cannot ship updates.** Recovery requires a
  Chrome Web Store support escalation with no guaranteed outcome. Back it
  up in at least two places before doing anything else.

## Automated release via GitHub Actions

### 1. Bump the version

Update `version` in **all three** files (they must stay in sync — the release
workflow verifies the tag against all three, including both `package-lock.json`
fields, and fails fast if any of them drift):

- `manifest.json` — source of truth for the extension
- `package.json` — npm tooling
- `package-lock.json` — both top-level `version` and `packages."".version`

Use [semver](https://semver.org/): patch for bugfixes, minor for new
features, major for breaking changes.

### 2. Run tests

```bash
npm test
```

All tests must pass. The manifest qualification test catches common
mistakes (missing icons, bad permissions, etc.).

### 3. Commit and merge to `main`

Open a PR, get it reviewed, merge. Tag the merge commit with the **`chrome-v`**
prefix (for Firefox, see [§6](#6-firefox--amo-release) — usually the same commit
tagged `firefox-v<version>`):

```bash
git tag chrome-v1.6.4 <merge-commit-sha>
git push origin chrome-v1.6.4
```

Pushing the tag fires the [`Release (Chrome)` workflow](.github/workflows/release.yml).
It runs tests, verifies the tag matches `manifest.json`/`package.json`/the
lockfile, packs a signed CRX, and attaches it to a **draft** GitHub Release named
after the tag.

If anything fails, the workflow surfaces the error in the run summary —
fix and re-push (`git tag -d chrome-v1.6.4 && git push --delete origin chrome-v1.6.4 && git tag chrome-v1.6.4 <sha> && git push origin chrome-v1.6.4`).

### 4. Chrome Web Store submission

**The CWS OAuth secrets are configured** (see
[`.github/RELEASE_SETUP.md`](.github/RELEASE_SETUP.md) → "Automating CWS
submission"), so the tag push already did this: the workflow uploaded the signed
CRX and **submitted it for review** automatically. Check the run's "Submit to
Chrome Web Store" step for the confirmation, then just review/publish the draft
GitHub Release notes. Skip to [Wait for review](#wait-for-review).

**Otherwise, submit manually:**

1. **Releases** tab → draft `chrome-v1.6.4` → review the auto-generated notes → **Publish**
2. Download `adhan-caster-1.6.4.crx` from the release's attached assets
3. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → Adhan Caster → **Package** → **Upload new package** → pick the CRX → **Submit for review**

   Or from your machine, with the OAuth `.env` set up:
   ```bash
   npm run submit:cws -- adhan-caster-1.6.4.crx
   ```

## Manual fallback (pack locally)

Use when GitHub Actions is down, or you need to test a build before tagging.

### Option A — `npm run pack:crx` (recommended)

```bash
npm ci
npm run pack:crx /path/to/adhan-caster-private.pem
```

Drops `adhan-caster-<manifest.version>.crx` at the repo root. Same
[`scripts/pack-crx.mjs`](scripts/pack-crx.mjs) the CI workflow uses, so the
output is byte-identical to what CI would produce.

### Option B — Chrome's "Pack extension" GUI

1. `chrome://extensions` → **Developer mode** on (top right)
2. **Pack extension**
3. **Extension root directory**: the repo folder (`/path/to/adhan-ce`)
4. **Private key file**: path to `adhan-caster-private.pem`
5. **Pack extension**

Produces `adhan-ce.crx` next to the repo folder. **Do not** use the
auto-generated `.pem` Chrome offers when no key is provided — that's a fresh
keypair and will fail signature verification against the registered public
key.

### Upload to the Chrome Web Store

Same as [step 4 above](#4-chrome-web-store-submission) —
upload the CRX through the Developer Dashboard.

## Wait for review

- Typical turnaround: a few hours to ~3 days.
- Because the extension declares broad host permissions
  (`http://*/*`, `https://*/*`), in-depth review is triggered — expect
  the longer end.
- You'll get an email on approval or rejection.

## After approval

- The new version replaces the published one for all users automatically.
- Verify the listing shows the new version number.
- Smoke-test by installing/updating from the store.

## 6. Firefox / AMO release

The Firefox build shares this repo and `manifest.json`. Differences from Chrome:
no local signing key (AMO signs server-side), a separate `firefox-v*` tag, and a
shorter listing name (AMO caps it at 45 chars — handled automatically by the XPI
packer; the Chrome name is untouched).

> **The listing already exists — this step is done.** It was created manually on
> 2026-08-13 with v2.0.3 (AMO won't auto-create a *listed* add-on from the API, so
> the first submission had to be by hand). That upload permanently locked in the
> add-on id `adhan-caster@bilalahamad.com`
> (`browser_specific_settings.gecko.id`) and the slug
> [`adhan-caster-prayer-times`](https://addons.mozilla.org/en-US/firefox/addon/adhan-caster-prayer-times/).
> Nothing below needs repeating — it is kept only as the record of how the
> listing came to exist, and as the recipe if the add-on is ever re-created from
> scratch or forked:
>
> 1. Build the XPI locally: `npm run pack:xpi` → `adhan-caster-<version>.xpi`.
>    Lint it first with `npm run lint:firefox` (0 errors required; warnings are OK).
> 2. At [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) →
>    **Submit a New Add-on** → choose **"On this site"** (the listed channel — the
>    unlisted one would break `web-ext sign --channel listed` forever) → upload the
>    XPI → fill in the listing (reuse the store description and `docs/store/`
>    screenshots; privacy policy URL
>    `https://adhan.bilalahamad.com/privacy-policy.html`).
> 3. Answer **Yes** to "Do you need to submit source code?" — `stageExtension()`
>    generates two of the files that ship (`lib/buildinfo.js` and the rewritten
>    `manifest.json`), which is exactly what that question asks about.

**Every version — just tag it.** The AMO API secrets are configured (see
[`RELEASE_SETUP.md`](.github/RELEASE_SETUP.md) → "Automating AMO submission") and
the listing exists, so a tag is all it takes:

```bash
git tag firefox-v1.6.4 <merge-commit-sha>
git push origin firefox-v1.6.4
```

The [`Release (Firefox)` workflow](.github/workflows/release-firefox.yml) tests,
verifies the tag matches the version, lints + builds the XPI, **AMO-signs and
submits it for review** via `web-ext sign`, and attaches the XPI to a draft
GitHub Release. Were the AMO secrets ever unset, the sign step no-ops instead and
you upload the XPI from the draft release manually. AMO review is publish-first
(often minutes);
**AMO version numbers are immutable** — a botched upload burns that number, so
bump and re-tag rather than re-pushing.

## 7. Edge Add-ons release

Edge is Chromium, so the package is the Chrome one: same MV3 manifest, same
`background.service_worker`, same runtime files. Two differences from Chrome:

- **No signing key.** Edge takes a plain ZIP. There is nothing to sign locally
  (no CRX key) and nothing signed server-side (unlike AMO).
- **Two manifest keys are stripped.** `scripts/pack-edge.mjs` passes `stripGecko`
  and `stripBackgroundScripts` to `stageExtension()`. The first removes
  `browser_specific_settings` (cosmetic — Chromium ignores it). The second is
  **required**: Edge validates MV3 strictly and rejects the upload with *"The
  background.scripts field cannot be used with manifest version 3"* if `scripts`
  rides along with `service_worker`. Chrome tolerates both keys and Firefox needs
  `scripts`, so this is the exact mirror of the Firefox strip. Chrome's own build
  keeps both.

**Tag it.** The version-bump, test and merge steps are identical to Chrome
(sections 1–3) — only the tag prefix differs:

```bash
git tag edge-v1.6.4 <merge-commit-sha>
git push origin edge-v1.6.4
```

The [`Release (Edge)` workflow](.github/workflows/release-edge.yml) tests,
verifies the tag matches the version, builds the ZIP, attaches it to a draft
GitHub Release, and **submits it to Edge Add-ons for review** via
`scripts/submit-edge.mjs`. Were the Edge secrets ever unset, the submit step
no-ops instead and you upload the ZIP from the draft release manually at
[Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/).

Microsoft's review is slower than Google's for a new listing — hours to about a
week. Unlike AMO, a rejected Edge submission does **not** burn the version
number: you can fix and re-submit the same version.

**First time only — create the listing.** Like AMO, Edge won't create a new
product from the API. Register once at
[Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/) (free —
no developer fee, unlike Chrome's one-time $5), upload
`npm run pack:edge`'s ZIP by hand to create the product, then copy its **product
ID** (a GUID on the extension's Overview page — not the storefront URL slug) into
the `EDGE_PRODUCT_ID` secret. After that every version is tag-driven.

## Common upload errors

| Error | Cause | Fix |
| --- | --- | --- |
| "Invalid version number in manifest" | New version ≤ published version | Bump `manifest.json`, `package.json`, and `package-lock.json` higher |
| "CRX signature doesn't match" | Packed with the wrong `.pem` | Re-pack with `adhan-caster-private.pem` |
| "Invalid CRX format" | Wrong packer / corrupted file | Re-pack via `npm run pack:crx` or Chrome's GUI |
| Upload only accepts ZIP | Verified CRX uploads not opted in | Already opted in on this listing — should not happen |
| CI: "Tag … does not match manifest.json version …" | Tag pushed before version bump landed on main | Delete the tag, land the bump, re-tag the merge commit |
| CI: "Required secret CRX_PRIVATE_KEY_B64 is not set" | One-time setup skipped | Follow [`.github/RELEASE_SETUP.md`](.github/RELEASE_SETUP.md) |

## Key rotation (emergency only)

If the private key is lost or compromised:

1. Generate a new keypair (`openssl genrsa -out new-private.pem 2048`
   and `openssl rsa -in new-private.pem -pubout -out new-public.pem`).
2. Contact [Chrome Web Store support](https://support.google.com/chrome_webstore/contact/dev_support)
   to opt out of Verified CRX uploads on the listing.
3. Once opted out, opt back in with the new public key.
4. Update the backup locations documented in this file.
5. Re-encode the new key and update the `CRX_PRIVATE_KEY_B64` secret (see
   [`.github/RELEASE_SETUP.md`](.github/RELEASE_SETUP.md) → "Rotating the secret").
