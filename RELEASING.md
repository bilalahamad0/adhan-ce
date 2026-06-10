# Releasing Adhan Caster

How to publish a new version to the Chrome Web Store and to Firefox/AMO.

> **⚠️ Tag namespaces decide the store.** Releases are triggered by **prefixed**
> tags, never a bare `v*`:
> - **`chrome-v<version>`** → [`Release (Chrome)`](.github/workflows/release.yml):
>   signs the CRX and submits to the **live Chrome Web Store**.
> - **`firefox-v<version>`** → [`Release (Firefox)`](.github/workflows/release-firefox.yml):
>   builds + AMO-signs the XPI and submits to **addons.mozilla.org**.
>
> A bare `v<version>` tag is **retired** — it triggers no release and
> [`release-tag-guard.yml`](.github/workflows/release-tag-guard.yml) fails it on
> purpose. This keeps a Firefox release from ever touching the Chrome store and
> vice versa. The two stores share one `manifest.json` version, so you can tag
> the same commit `chrome-v2.1.0` and `firefox-v2.1.0`.

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

You need the verified-uploads private key: `adhan-caster-pro-private.pem`.

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

**If the CWS OAuth secrets are configured** (see
[`.github/RELEASE_SETUP.md`](.github/RELEASE_SETUP.md) → "Automating CWS
submission"), the tag push already did this: the workflow uploaded the signed
CRX and **submitted it for review** automatically. Check the run's "Submit to
Chrome Web Store" step for the confirmation, then just review/publish the draft
GitHub Release notes. Skip to [Wait for review](#wait-for-review).

**Otherwise, submit manually:**

1. **Releases** tab → draft `chrome-v1.6.4` → review the auto-generated notes → **Publish**
2. Download `adhan-caster-pro-1.6.4.crx` from the release's attached assets
3. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → Adhan Caster → **Package** → **Upload new package** → pick the CRX → **Submit for review**

   Or from your machine, with the OAuth `.env` set up:
   ```bash
   npm run submit:cws -- adhan-caster-pro-1.6.4.crx
   ```

## Manual fallback (pack locally)

Use when GitHub Actions is down, or you need to test a build before tagging.

### Option A — `npm run pack:crx` (recommended)

```bash
npm ci
npm run pack:crx /path/to/adhan-caster-pro-private.pem
```

Drops `adhan-caster-pro-<manifest.version>.crx` at the repo root. Same
[`scripts/pack-crx.mjs`](scripts/pack-crx.mjs) the CI workflow uses, so the
output is byte-identical to what CI would produce.

### Option B — Chrome's "Pack extension" GUI

1. `chrome://extensions` → **Developer mode** on (top right)
2. **Pack extension**
3. **Extension root directory**: the repo folder (`/path/to/adhan-ce`)
4. **Private key file**: path to `adhan-caster-pro-private.pem`
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

**First time only — create the AMO listing.** AMO won't auto-create a *listed*
add-on from the API, so the very first submission is manual:

1. Build the XPI locally: `npm run pack:xpi` → `adhan-caster-pro-<version>.xpi`.
   Lint it first with `npm run lint:firefox` (0 errors required; warnings are OK).
2. At [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) →
   **Submit a New Add-on** → upload the XPI → fill in the listing (reuse the
   store description and `docs/store/` screenshots; privacy policy URL
   `https://adhan.bilalahamad.com/privacy-policy.html`).
3. This locks in the add-on id `adhan-caster@bilalahamad.com`
   (`browser_specific_settings.gecko.id`) — **permanent**, can't be changed later.

**Every version after that — tag it.** Once the listing exists and the AMO API
secrets are configured (see [`RELEASE_SETUP.md`](.github/RELEASE_SETUP.md) →
"Automating AMO submission"):

```bash
git tag firefox-v1.6.4 <merge-commit-sha>
git push origin firefox-v1.6.4
```

The [`Release (Firefox)` workflow](.github/workflows/release-firefox.yml) tests,
verifies the tag matches the version, lints + builds the XPI, **AMO-signs and
submits it for review** via `web-ext sign`, and attaches the XPI to a draft
GitHub Release. Without the AMO secrets the sign step no-ops and you upload the
XPI from the draft release manually. AMO review is publish-first (often minutes);
**AMO version numbers are immutable** — a botched upload burns that number, so
bump and re-tag rather than re-pushing.

## Common upload errors

| Error | Cause | Fix |
| --- | --- | --- |
| "Invalid version number in manifest" | New version ≤ published version | Bump `manifest.json`, `package.json`, and `package-lock.json` higher |
| "CRX signature doesn't match" | Packed with the wrong `.pem` | Re-pack with `adhan-caster-pro-private.pem` |
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
