# Release workflow — one-time setup

The [`Release` workflow](workflows/release.yml) packs a signed `.crx` and
attaches it to a draft GitHub Release whenever a `v*.*.*` tag is pushed. It
needs one repo secret to do that.

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

## What the workflow does NOT do

- **It does not upload to the Chrome Web Store.** That step still happens
  through the dashboard. Verified CRX uploads makes API-based uploads
  fragile; we'd rather keep the human approval gate.
- **It does not publish the GitHub Release.** Releases are created as drafts
  so the auto-generated notes can be reviewed first.
- **It does not bump versions.** Version bumps still happen in a PR before
  the tag is pushed. The workflow only verifies that the tag matches the
  manifest version and fails fast if they disagree.
