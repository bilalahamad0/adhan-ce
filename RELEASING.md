# Releasing Adhan Caster Pro

How to publish a new version to the Chrome Web Store.

> **Verified CRX uploads is enabled** on this listing. Every upload must be a
> `.crx` signed with the project's verified-uploads private key. Plain `.zip`
> uploads will be rejected.

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
workflow's tag-vs-manifest check fails fast if they drift):

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

Open a PR, get it reviewed, merge. Tag the merge commit:

```bash
git tag v1.6.4 <merge-commit-sha>
git push origin v1.6.4
```

Pushing the tag fires the [`Release` workflow](.github/workflows/release.yml).
It runs tests, verifies the tag matches `manifest.json`, packs a signed CRX,
and attaches it to a **draft** GitHub Release named after the tag.

If anything fails, the workflow surfaces the error in the run summary —
fix and re-push (`git tag -d v1.6.4 && git push --delete origin v1.6.4 && git tag v1.6.4 <sha> && git push origin v1.6.4`).

### 4. Chrome Web Store submission

**If the CWS OAuth secrets are configured** (see
[`.github/RELEASE_SETUP.md`](.github/RELEASE_SETUP.md) → "Automating CWS
submission"), the tag push already did this: the workflow uploaded the signed
CRX and **submitted it for review** automatically. Check the run's "Submit to
Chrome Web Store" step for the confirmation, then just review/publish the draft
GitHub Release notes. Skip to [Wait for review](#wait-for-review).

**Otherwise, submit manually:**

1. **Releases** tab → draft `v1.6.4` → review the auto-generated notes → **Publish**
2. Download `adhan-caster-pro-1.6.4.crx` from the release's attached assets
3. [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → Adhan Caster Pro → **Package** → **Upload new package** → pick the CRX → **Submit for review**

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

Same as [step 4 above](#4-publish-the-release--upload-to-chrome-web-store) —
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
