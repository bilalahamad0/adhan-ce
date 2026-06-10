# Release workflow — one-time setup

Releases are triggered by **prefixed** tags (a bare `v*` is retired):
`chrome-v<version>` → Chrome Web Store, `firefox-v<version>` → Firefox/AMO. See
[RELEASING.md](../RELEASING.md) for the full flow.

The [`Release (Chrome)` workflow](workflows/release.yml) packs a signed `.crx`
and attaches it to a draft GitHub Release whenever a `chrome-v*.*.*` tag is
pushed. It needs one repo secret to do that. (Firefox/AMO setup is a separate
section at the bottom of this file.)

## 1. Encode the private key

Locally, with `adhan-caster-pro-private.pem` accessible:

```bash
# macOS — copies the base64 string to your clipboard
base64 -i adhan-caster-pro-private.pem | pbcopy

# Linux
base64 -w 0 adhan-caster-pro-private.pem
```

The output is a single long base64 string. Anything in it can recreate the
private key, so treat it like the key itself.

## 2. Add it as a repo secret

1. **Settings → Secrets and variables → Actions → New repository secret**
2. **Name:** `CRX_PRIVATE_KEY_B64`
3. **Secret:** paste the base64 string from step 1
4. **Add secret**

That's it for setup. The workflow now has what it needs.

## 3. Smoke-test the workflow without cutting a release

**Actions → Release → Run workflow** (you can leave `ref` blank to use the
current branch). The workflow runs end-to-end but skips the release step, and
uploads the resulting `.crx` as a workflow artifact under the run page. Download
it, try installing it in Chrome unpacked-mode, and confirm it loads cleanly.

If the run fails at "Decode private key" with `does not look like a PEM file`,
the secret was probably pasted with surrounding whitespace or with line wraps.
Re-encode with `base64 -i ... | pbcopy` (macOS) or `base64 -w 0` (Linux) so the
output is one contiguous line, and update the secret.

## 4. Cut a release

```bash
# bump manifest.json AND package.json + lockfile to the new version,
# commit, merge to main, then:
git tag v1.6.4 <merge-commit-sha>
git push origin v1.6.4
```

The workflow fires on the tag push. When it finishes:

- **Releases** tab → a draft release named `v1.6.4` with `adhan-caster-pro-1.6.4.crx` attached.
- Review the auto-generated notes, edit if needed, click **Publish**.
- Upload the same `.crx` to the [Chrome Web Store dashboard](https://chrome.google.com/webstore/devconsole) → Adhan Caster Pro → Package → Upload new package → Submit for review.

## Rotating the secret

If the private key is rotated (see "Key rotation" in [RELEASING.md](../RELEASING.md)):

1. Re-encode the new key (step 1)
2. Edit the existing `CRX_PRIVATE_KEY_B64` secret with the new value
3. No workflow changes needed

## Automating CWS submission (optional)

By default the workflow stops at a signed CRX on a draft GitHub Release, and you
upload it through the dashboard. If you set the four secrets below, the workflow
will instead **upload the CRX to the Chrome Web Store and submit it for review
automatically** on every tag push. (Verified CRX uploads is fully compatible
with the API: the upload must be the signed CRX, which is exactly what this
pipeline produces.)

If these secrets are absent, the step **no-ops** — the build/sign/release still
runs, you just submit manually. So you can configure this whenever you like.

### One-time OAuth setup

You need an OAuth2 client and a long-lived refresh token scoped to the Chrome
Web Store API, generated while signed in as the developer-account owner.

1. **Enable the API.** In the [Google Cloud Console](https://console.cloud.google.com/),
   create (or pick) a project → **APIs & Services → Library** → enable
   **Chrome Web Store API**.
2. **Configure the consent screen.** **APIs & Services → OAuth consent screen** →
   External → fill the minimum fields → add your Google account as a **Test user**
   (a test-mode app is fine; tokens for test users don't expire as quickly and
   this is a personal tool).
3. **Create the client.** **Credentials → Create credentials → OAuth client ID** →
   **Web application**. Under **Authorized redirect URIs** add
   `https://developers.google.com/oauthplayground`. Save the **client ID** and
   **client secret**.
4. **Mint a refresh token.** Open the
   [OAuth 2.0 Playground](https://developers.google.com/oauthplayground/) →
   gear icon (top right) → check **Use your own OAuth credentials** → paste the
   client ID + secret. In the left scope box enter
   `https://www.googleapis.com/auth/chromewebstore` → **Authorize APIs** → sign
   in as the developer account → **Exchange authorization code for tokens**.
   Copy the **refresh token**.

### Add the secrets

**Settings → Secrets and variables → Actions → New repository secret**, three
required + one optional:

| Secret | Value |
| --- | --- |
| `CWS_CLIENT_ID` | OAuth client ID from step 3 |
| `CWS_CLIENT_SECRET` | OAuth client secret from step 3 |
| `CWS_REFRESH_TOKEN` | Refresh token from step 4 |
| `CWS_EXTENSION_ID` | _(optional)_ item ID — defaults to the published Adhan Caster Pro ID |

### Test it without cutting a release

Locally, copy `.env.example` → `.env`, fill in the same four values, then:

```bash
npm run submit:cws -- adhan-caster-pro-<version>.crx --dry-run   # validate, no network
npm run submit:cws -- adhan-caster-pro-<version>.crx --no-publish # upload only, you submit in the dashboard
npm run submit:cws -- adhan-caster-pro-<version>.crx              # upload + submit for review
```

`.env` is gitignored. A refresh token is as sensitive as a password — anyone
with it can publish to your listing.

### If the refresh token stops working

Refresh tokens can be revoked or (for a test-mode consent screen) expire. The
script fails with `OAuth token refresh failed (HTTP 401)`. Regenerate it
(step 4) and update the `CWS_REFRESH_TOKEN` secret. No code change needed.

## Automating AMO submission (Firefox, optional)

The [`Release (Firefox)` workflow](workflows/release-firefox.yml) fires on a
`firefox-v*.*.*` tag: it lints + builds the XPI, attaches it to a draft GitHub
Release, and — if the two secrets below are set — **AMO-signs and submits it for
review** via `web-ext sign`. Without them the sign step **no-ops** (the XPI is on
the GitHub Release for a manual upload), so you can configure this whenever.

> **First submission is manual.** AMO won't create a *listed* add-on from the
> API, so the very first version must be uploaded once at
> [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) to
> create the listing (this locks in the add-on id
> `adhan-caster@bilalahamad.com`). After that, tagging automates new versions.

### One-time AMO API credentials

1. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/)
   as the add-on owner.
2. **Manage API Keys** (under your account/tools) → **Generate new credentials**.
3. Copy the **JWT issuer** (looks like `user:12345:67`) and the **JWT secret**
   (a long hex string — shown only once).

### Add the secrets

**Settings → Secrets and variables → Actions → New repository secret:**

| Secret | Value |
| --- | --- |
| `AMO_JWT_ISSUER` | JWT issuer from step 3 (web-ext reads it as `--api-key`) |
| `AMO_JWT_SECRET` | JWT secret from step 3 (web-ext reads it as `--api-secret`) |

The workflow passes these to `web-ext sign` via `WEB_EXT_API_KEY` /
`WEB_EXT_API_SECRET`, so they never appear on a command line. The extension ships
unminified, so AMO needs no separate source-code upload. A JWT secret is as
sensitive as a password — anyone with it can publish to your AMO listing.

### Test it without cutting a release

**Actions → Release (Firefox) → Run workflow** (leave `ref` blank). It builds and
lints the XPI and uploads it as an artifact — no release, no AMO submission.

## What the workflows do NOT do

- **They do not publish the GitHub Release.** Releases are created as drafts
  so the auto-generated notes can be reviewed first.
- **They do not bump versions.** Version bumps still happen in a PR before
  the tag is pushed. The workflows only verify that the tag matches the
  manifest/package/lock version and fail fast if they disagree.
- **Store submission is opt-in.** Without the OAuth secrets (Chrome) or the
  `AMO_JWT_*` secrets (Firefox), the workflows don't touch the stores — the
  signed CRX / built XPI is on the GitHub Release for a manual upload.
- **A bare `v*` tag does nothing** except fail the
  [tag guard](workflows/release-tag-guard.yml). Use `chrome-v*` or `firefox-v*`.
