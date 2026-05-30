#!/usr/bin/env node
// Upload a signed CRX to the Chrome Web Store and submit it for review.
//
// This is the last mile of the release pipeline. The Release workflow already
// builds + signs the CRX with the verified-uploads key; this script takes that
// CRX and (1) uploads it as a new package, then (2) publishes it (submits for
// review). On approval Google auto-publishes it to all users.
//
// Usage:
//   node scripts/submit-cws.mjs <path-to.crx> [--dry-run] [--no-publish]
//
//   <path-to.crx>   the signed CRX to ship. Defaults to
//                   ./adhan-caster-pro-<manifest.version>.crx (repo root).
//   --dry-run       validate the CRX + config and exit. Makes NO network calls
//                   and needs NO credentials — safe to run anywhere, including
//                   CI smoke tests. This is the only path that can be exercised
//                   without a live OAuth token.
//   --no-publish    upload the package but skip the publish/submit-for-review
//                   step (leaves it staged as a draft in the dashboard).
//
// Required env (for a real run — not needed for --dry-run):
//   CWS_CLIENT_ID        OAuth2 client ID (Google Cloud, Web application type)
//   CWS_CLIENT_SECRET    OAuth2 client secret
//   CWS_REFRESH_TOKEN    OAuth2 refresh token with the chromewebstore scope
//   CWS_EXTENSION_ID     the published item's ID
//                        (defaults to the known Adhan Caster Pro ID below)
//
// Locally these come from a gitignored .env; in CI they come from repo secrets.
// See .github/RELEASE_SETUP.md for how to obtain the OAuth credentials once.

import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (no dependency). Loads KEY=VALUE lines from .env at the
// repo root for local convenience, but never overrides a variable already set
// in the environment — so CI secrets always win and a stale local .env can't
// shadow them. Quotes around values are stripped; blank lines and # comments
// are ignored.
function loadDotEnv() {
  const envPath = join(REPO, '.env');
  if (!existsSync(envPath)) return;
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch (_) {
    return;
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

// Published Adhan Caster Pro item ID (public — it's in the store URL/README).
// Overridable via env so this script isn't hard-wired to one listing.
const DEFAULT_EXTENSION_ID = 'jfjknglldcdminelckmmfdbnlikiogia';

// Chrome Web Store API v1.1. Chosen over v2 because it keys off the item ID
// alone (no separate publisher ID to look up) and is the longest-standing,
// most widely-used endpoint. Verified-CRX listings upload the signed CRX here
// exactly as a ZIP would be uploaded for a non-verified one.
const API = 'https://www.googleapis.com/upload/chromewebstore/v1.1/items';
const PUBLISH = 'https://www.googleapis.com/chromewebstore/v1.1/items';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function fail(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

async function manifestVersion() {
  try {
    return JSON.parse(await readFile(join(REPO, 'manifest.json'), 'utf8')).version;
  } catch (_) {
    return null;
  }
}

// Validate that the file exists and is a real CRX3 ('Cr24' magic). A verified
// listing rejects anything that isn't signed with the registered key, so the
// cheapest early failure is "this isn't even a CRX".
async function validateCrx(crxPath) {
  if (!existsSync(crxPath)) {
    fail(
      `CRX not found: ${crxPath}\n  Build it first (npm run pack:crx) or pass an explicit path.`,
      2
    );
  }
  const buf = await readFile(crxPath);
  const magic = buf.subarray(0, 4).toString('ascii');
  if (magic !== 'Cr24') {
    fail(`Not a CRX file: ${crxPath} (magic '${magic}', expected 'Cr24'). Re-pack with npm run pack:crx.`, 2);
  }
  const size = (await stat(crxPath)).size;
  return { buf, size };
}

// Exchange the long-lived refresh token for a short-lived access token.
// Access tokens expire in ~1h, so we always mint a fresh one per run.
async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    fail(
      `OAuth token refresh failed (HTTP ${res.status}): ${data.error || ''} ${data.error_description || ''}\n` +
        '  Check CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN. A revoked or expired\n' +
        '  refresh token must be regenerated (see .github/RELEASE_SETUP.md).'
    );
  }
  return data.access_token;
}

async function uploadCrx({ token, extId, crx }) {
  // PUT the raw CRX bytes. For a verified listing the upload must be the signed
  // CRX (not a ZIP); these headers tell the upload service it's a raw CRX body.
  const res = await fetch(`${API}/${extId}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-api-version': '2',
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': `adhan-caster-pro.crx`,
      'Content-Type': 'application/octet-stream',
    },
    body: crx.buf,
  });
  const data = await res.json().catch(() => ({}));
  // uploadState: SUCCESS | IN_PROGRESS | FAILURE | NOT_FOUND
  if (!res.ok || data.uploadState === 'FAILURE') {
    const detail = (data.itemError || []).map((e) => e.error_detail || e.errorDetail).join('; ');
    fail(
      `Upload failed (HTTP ${res.status}, state ${data.uploadState || 'unknown'}): ${detail || JSON.stringify(data)}\n` +
        '  A version-number error means manifest.json was not bumped above the published version.\n' +
        "  A signature error means the CRX wasn't signed with the verified-uploads key."
    );
  }
  return data;
}

async function publishItem({ token, extId }) {
  const res = await fetch(`${PUBLISH}/${extId}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-api-version': '2',
      'Content-Length': '0',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    fail(
      `Publish failed (HTTP ${res.status}): ${JSON.stringify(data)}\n` +
        '  The package uploaded but was not submitted for review. You can submit it\n' +
        '  manually in the dashboard, or re-run once the error is resolved.'
    );
  }
  // status: e.g. ["OK"] or ["ITEM_PENDING_REVIEW"]
  return data;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noPublish = args.includes('--no-publish');
  const positional = args.filter((a) => !a.startsWith('--'));

  loadDotEnv();

  const version = await manifestVersion();
  const crxPath = resolve(
    positional[0] || join(REPO, `adhan-caster-pro-${version}.crx`)
  );
  const extId = process.env.CWS_EXTENSION_ID || DEFAULT_EXTENSION_ID;

  const crx = await validateCrx(crxPath);
  console.log(`• CRX:       ${crxPath} (${crx.size} bytes${version ? `, manifest v${version}` : ''})`);
  console.log(`• Extension: ${extId}`);

  if (dryRun) {
    console.log('✓ Dry run: CRX is valid and config resolved. No network calls made.');
    return;
  }

  const creds = {
    clientId: process.env.CWS_CLIENT_ID,
    clientSecret: process.env.CWS_CLIENT_SECRET,
    refreshToken: process.env.CWS_REFRESH_TOKEN,
  };
  const missing = Object.entries(creds)
    .filter(([, v]) => !v)
    .map(([k]) => ({ clientId: 'CWS_CLIENT_ID', clientSecret: 'CWS_CLIENT_SECRET', refreshToken: 'CWS_REFRESH_TOKEN' }[k]));
  if (missing.length) {
    fail(
      `Missing required env: ${missing.join(', ')}.\n` +
        '  Set them in a local .env (see .env.example) or as CI secrets.\n' +
        '  Or pass --dry-run to validate without credentials.'
    );
  }

  console.log('• Refreshing access token…');
  const token = await getAccessToken(creds);

  console.log('• Uploading signed CRX…');
  const up = await uploadCrx({ token, extId, crx });
  console.log(`  upload state: ${up.uploadState}`);

  if (noPublish) {
    console.log('✓ Uploaded. Skipping publish (--no-publish). Submit for review in the dashboard when ready.');
    return;
  }

  console.log('• Submitting for review…');
  const pub = await publishItem({ token, extId });
  const status = Array.isArray(pub.status) ? pub.status.join(', ') : JSON.stringify(pub.status);
  console.log(`✓ Submitted for review. Status: ${status}`);
  console.log('  Google review (in-depth, due to broad host permissions) typically takes hours to ~3 days.');
}

main().catch((e) => fail(e.message || String(e)));
