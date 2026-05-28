# Releasing Adhan Caster Pro

How to publish a new version to the Chrome Web Store.

> **Verified CRX uploads is enabled** on this listing. Every upload must be a
> `.crx` signed with the project's verified-uploads private key. Plain `.zip`
> uploads will be rejected.

## Prerequisites (one-time)

You need the verified-uploads private key: `adhan-caster-pro-private.pem`.

- It is **not in this repo** (and never should be — `*.pem` is gitignored).
- Stored in: _\<password manager entry name + offline backup location\>_ —
  fill this in with your actual backup locations and keep it private.
- **Losing this key means you cannot ship updates.** Recovery requires a
  Chrome Web Store support escalation with no guaranteed outcome. Back it
  up in at least two places before doing anything else.

## Release steps

### 1. Bump the version

Update `version` in **both** files (they should stay in sync):

- `manifest.json` — the source of truth for the extension
- `package.json` — kept in sync for npm tooling

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
git tag v1.6.2
git push origin v1.6.2
```

### 4. Pack the signed CRX

In Chrome:

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Pack extension**
4. **Extension root directory**: the repo folder
   (`/path/to/adhan-ce`)
5. **Private key file**: path to `adhan-caster-pro-private.pem`
6. Click **Pack extension**

This produces `adhan-ce.crx` next to the repo folder. Verify the file
exists and is non-empty.

**Do not** use the auto-generated `.pem` Chrome offers when no key is
provided — that's a fresh keypair and will fail signature verification
against the registered public key.

### 5. Upload to the Chrome Web Store

1. Go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Open the Adhan Caster Pro listing → **Package**
3. Click **Upload new package**
4. Select the `.crx` from step 4
5. If the upload succeeds, the Draft column updates to the new version
6. Click **Submit for review** (top right)

### 6. Wait for review

- Typical turnaround: a few hours to ~3 days.
- Because the extension declares broad host permissions
  (`http://*/*`, `https://*/*`), in-depth review is triggered — expect
  the longer end.
- You'll get an email on approval or rejection.

### 7. After approval

- The new version replaces the published one for all users automatically.
- Verify the listing shows the new version number.
- Smoke-test by installing/updating from the store.

## Common upload errors

| Error | Cause | Fix |
| --- | --- | --- |
| "Invalid version number in manifest" | New version ≤ published version | Bump `manifest.json` and `package.json` higher |
| "CRX signature doesn't match" | Packed with the wrong `.pem` | Re-pack with `adhan-caster-pro-private.pem` |
| "Invalid CRX format" | Wrong packer / corrupted file | Re-pack via Chrome's Pack extension (CRX3) |
| Upload only accepts ZIP | Verified CRX uploads not opted in | Already opted in on this listing — should not happen |

## Key rotation (emergency only)

If the private key is lost or compromised:

1. Generate a new keypair (`openssl genrsa -out new-private.pem 2048`
   and `openssl rsa -in new-private.pem -pubout -out new-public.pem`).
2. Contact [Chrome Web Store support](https://support.google.com/chrome_webstore/contact/dev_support)
   to opt out of Verified CRX uploads on the listing.
3. Once opted out, opt back in with the new public key.
4. Update the backup locations documented in this file.
