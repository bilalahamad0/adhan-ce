#!/usr/bin/env node
// Upload a signed CRX to the Chrome Web Store and submit it for review.
//
// This is the last mile of the release pipeline. The Release workflow already
// builds + signs the CRX with the verified-uploads key; this script takes that
// CRX and (1) checks the item's status, (2) uploads it as a new package, then
// (3) publishes it (submits for review). On approval Google auto-publishes it
// to all users.
//
// Usage:
//   node scripts/submit-cws.mjs <path-to.crx> [--dry-run] [--no-publish]
//
//   <path-to.crx>   the signed CRX to ship. Defaults to
//                   ./adhan-focus-<manifest.version>.crx (repo root).
//   --dry-run       validate the CRX + config and exit. Makes NO network calls
//                   and needs NO credentials — safe to run anywhere, including
//                   CI smoke tests. This is the only path that can be exercised
//                   without a live OAuth token.
//   --no-publish    check status + upload the package, but skip the
//                   publish/submit-for-review step (leaves it staged as a draft
//                   in the dashboard).
//
// Required env (for a real run — not needed for --dry-run):
//   CWS_CLIENT_ID        OAuth2 client ID (Google Cloud, Web application type)
//   CWS_CLIENT_SECRET    OAuth2 client secret
//   CWS_REFRESH_TOKEN    OAuth2 refresh token with the chromewebstore scope
// Optional env:
//   CWS_EXTENSION_ID     the published item's ID
//                        (defaults to the known Adhan Focus ID below)
//   CWS_PUBLISHER_ID     the developer account's publisher ID
//                        (defaults to the Adhan Focus publisher below)
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

// Published Adhan Focus item ID (public — it's in the store URL/README).
// Overridable via env so this script isn't hard-wired to one listing.
export const DEFAULT_EXTENSION_ID = 'jfjknglldcdminelckmmfdbnlikiogia';

// Publisher ID of the developer account that owns the item: the UUID in the
// Developer Dashboard URL (chrome.google.com/webstore/devconsole/<id>/...) and
// under Account → Publisher ID. Not a secret. Overridable via CWS_PUBLISHER_ID.
export const DEFAULT_PUBLISHER_ID = '1441ca88-135b-4f7f-8ea0-a310657241d9';

// Chrome Web Store API v2. v1.1 is unsupported after 2026-10-15.
// https://developer.chrome.com/docs/webstore/api
export const API_ROOT = 'https://chromewebstore.googleapis.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UPLOAD_HINT =
  '  A version-number error means manifest.json was not bumped above the published version.\n' +
  "  A signature or package-format error means the CRX wasn't signed with the verified-uploads key.";

export class CwsError extends Error {
  constructor(message, code = 1) {
    super(message);
    this.code = code;
  }
}

function fail(msg, code = 1) {
  throw new CwsError(msg, code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function resolvePublisherId(value) {
  const id = (value || '').trim() || DEFAULT_PUBLISHER_ID;
  if (/[/?#%\s]/.test(id)) {
    fail(`Invalid CWS_PUBLISHER_ID '${id}'. Copy it from Developer Dashboard → Account → Publisher ID.`);
  }
  return id;
}

export const itemName = (publisherId, extId) => `publishers/${publisherId}/items/${extId}`;

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const channelVersions = (revision) =>
  (revision?.distributionChannels || []).map((c) => c.crxVersion).filter(Boolean);

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
    signal: AbortSignal.timeout(30_000),
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

// API errors are a JSON google.rpc.Status envelope, but Google's front end
// answers some failures (bad path, 411, bad upload protocol) in plain text, so
// keep the raw body as a fallback.
async function call(url, { token, method = 'GET', headers = {}, body, timeoutMs = 60_000 }) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    // not JSON — describeError falls back to the text
  }
  return { res, json: json && typeof json === 'object' ? json : {}, text };
}

function describeError({ res, json, text }) {
  const e = json.error;
  if (e && typeof e === 'object') {
    const details = Array.isArray(e.details) && e.details.length ? ` ${JSON.stringify(e.details)}` : '';
    return `HTTP ${res.status}${e.status ? ` ${e.status}` : ''}: ${e.message || ''}${details}`;
  }
  return `HTTP ${res.status}: ${(text || '').trim().slice(0, 500) || 'no response body'}`;
}

const statusUrl = (name) => `${API_ROOT}/v2/${name}:fetchStatus`;

// Read-only check before touching the item. Catches a wrong publisher ID, a
// submission already in review (which the store refuses to edit) and an
// unbumped version, all before anything is uploaded.
export async function preflight({ token, name, version }) {
  const r = await call(statusUrl(name), { token });
  if (!r.res.ok) {
    const hint =
      r.res.status === 401
        ? 'The access token was rejected. Regenerate CWS_REFRESH_TOKEN (see .github/RELEASE_SETUP.md).'
        : r.res.status === 403 || r.res.status === 404
          ? 'Check CWS_PUBLISHER_ID (Developer Dashboard → Account → Publisher ID) and CWS_EXTENSION_ID,\n' +
            '  and that the refresh token belongs to an account that manages this item.'
          : 'This may be transient; re-run the job.';
    fail(`Item status check failed for ${name} (${describeError(r)}).\n  ${hint}\n  Nothing was uploaded.`);
  }
  const s = r.json;
  if (s.name && s.name !== name) {
    fail(`Item status check returned ${s.name}, expected ${name}. Nothing was uploaded.`);
  }
  if (s.takenDown) {
    fail('The item is taken down for a policy violation. Resolve it in the Developer Dashboard first. Nothing was uploaded.');
  }
  if (s.warned) {
    console.warn('::warning::The item has a policy warning in the Developer Dashboard; it will be taken down if unresolved.');
  }
  const submitted = s.submittedItemRevisionStatus?.state;
  if (submitted === 'PENDING_REVIEW') {
    fail(
      'A previous submission is still in review, and an item in review cannot be edited.\n' +
        '  Wait for the review to finish, or cancel it in the Developer Dashboard, then re-run. Nothing was uploaded.'
    );
  }
  if (submitted === 'STAGED') {
    fail(
      'A previous submission is approved and staged. Publish or cancel it in the Developer Dashboard first.\n' +
        '  Nothing was uploaded.'
    );
  }
  const publishedVersions = channelVersions(s.publishedItemRevisionStatus);
  if (version) {
    const notOlder = publishedVersions.filter((v) => compareVersions(version, v) <= 0);
    if (notOlder.length) {
      fail(
        `manifest.json version ${version} is not above the published version ${notOlder.join(', ')}.\n` +
          '  Bump manifest.json, package.json and the lockfile, then re-tag. Nothing was uploaded.'
      );
    }
  }
  return { publishedVersions, submittedState: submitted || null };
}

export async function uploadCrx({ token, name, crx, version, pollIntervalMs = 5_000, pollTimeoutMs = 300_000 }) {
  const r = await call(`${API_ROOT}/upload/v2/${name}:upload`, {
    token,
    method: 'POST',
    headers: {
      // A verified-CRX listing must receive the signed CRX itself; these tell
      // the upload service the body is a raw .crx rather than a ZIP.
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': 'adhan-focus.crx',
      'Content-Type': 'application/octet-stream',
    },
    body: crx.buf,
    timeoutMs: 180_000,
  });
  if (!r.res.ok) fail(`Upload failed (${describeError(r)}).\n${UPLOAD_HINT}`);

  const { uploadState, crxVersion } = r.json;
  if (uploadState === 'SUCCEEDED') {
    if (version && crxVersion && crxVersion !== version) {
      fail(
        `The uploaded package reports version ${crxVersion}, but manifest.json is ${version}.\n` +
          '  Not submitting. Check which CRX was passed; the dashboard draft now holds that package.'
      );
    }
    return { uploadState, crxVersion: crxVersion || null };
  }
  // The docs call this UPLOAD_IN_PROGRESS in prose, but the enum value is IN_PROGRESS.
  if (uploadState === 'IN_PROGRESS' || uploadState === 'UPLOAD_IN_PROGRESS') {
    console.log('  upload is processing; waiting for it to finish…');
    const finalState = await waitForUpload({ token, name, pollIntervalMs, pollTimeoutMs });
    return { uploadState: finalState, crxVersion: null };
  }
  fail(`Upload failed (HTTP ${r.res.status}, state ${uploadState || 'missing'}): ${r.text || 'no response body'}\n${UPLOAD_HINT}`);
}

async function waitForUpload({ token, name, pollIntervalMs, pollTimeoutMs }) {
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let r;
    try {
      r = await call(statusUrl(name), { token });
    } catch (_) {
      continue; // network blip or per-request timeout: retry until the deadline
    }
    if (r.res.status === 429 || r.res.status >= 500) continue;
    if (!r.res.ok) {
      fail(
        `Upload status check failed (${describeError(r)}).\n` +
          '  The package may still be processing. Check the Developer Dashboard and Submit for review there.'
      );
    }
    const state = r.json.lastAsyncUploadState;
    if (state === 'SUCCEEDED') return state;
    if (state === 'FAILED' || state === 'NOT_FOUND') {
      fail(`Upload processing ended with state ${state}.\n${UPLOAD_HINT}`);
    }
  }
  fail(
    `Upload was still processing after ${Math.round(pollTimeoutMs / 1000)}s. Nothing was submitted.\n` +
      '  Check the Developer Dashboard and Submit for review there once the package has processed.'
  );
}

export async function publishItem({ token, name }) {
  const r = await call(`${API_ROOT}/v2/${name}:publish`, {
    token,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }),
  });
  // A 400 is the store refusing the submission (e.g. "Publish condition not met"
  // for an incomplete Privacy practices tab). The package is already uploaded,
  // so leave it as a draft for a manual Submit for review instead of failing.
  if (r.res.status === 400) {
    console.warn(
      `::warning::Publish notice (${describeError(r)})\n` +
        '  The package was uploaded successfully to Chrome Web Store as a draft.\n' +
        '  Complete any pending declarations on the Privacy practices tab in Developer Dashboard\n' +
        '  (https://chrome.google.com/webstore/devconsole), make sure visibility was not changed there since the\n' +
        '  last publish, and click Submit for review.'
    );
    return { state: 'UPLOADED_AS_DRAFT', warning: r.json.error || r.text };
  }
  if (!r.res.ok) {
    fail(
      `Publish failed (${describeError(r)}).\n` +
        '  The package is uploaded as a draft. Submit it for review in the Developer Dashboard.'
    );
  }
  for (const w of r.json.warningInfo?.warnings || []) {
    console.warn(`::warning::Chrome Web Store warning: ${[w.reason, w.description].filter(Boolean).join(' — ')}`);
  }
  if (r.json.state === 'REJECTED' || r.json.state === 'CANCELLED') {
    fail(`Publish returned state ${r.json.state}. Check the item in the Developer Dashboard.`);
  }
  return r.json;
}

// Best-effort: confirm the revision now in review carries this version. The
// async-upload path can't tie its SUCCEEDED state to this exact CRX, so this is
// the cross-check. Never fails the run.
export async function verifySubmission({ token, name, version }) {
  try {
    const r = await call(statusUrl(name), { token });
    if (!r.res.ok) {
      console.warn(`::warning::Could not confirm the submission (${describeError(r)}). Check the Developer Dashboard.`);
      return;
    }
    const versions = channelVersions(r.json.submittedItemRevisionStatus);
    if (version && versions.length && !versions.includes(version)) {
      console.warn(
        `::warning::The submission in review reports version ${versions.join(', ')}, not ${version}.\n` +
          '  Check the Developer Dashboard and cancel the submission there if it is the wrong package.'
      );
    }
  } catch (e) {
    console.warn(`::warning::Could not confirm the submission: ${e.message || e}`);
  }
}

export async function main(args = process.argv.slice(2)) {
  const dryRun = args.includes('--dry-run');
  const noPublish = args.includes('--no-publish');
  const positional = args.filter((a) => !a.startsWith('--'));

  loadDotEnv();

  const version = await manifestVersion();
  const crxPath = resolve(
    positional[0] || join(REPO, `adhan-focus-${version}.crx`)
  );
  const extId = process.env.CWS_EXTENSION_ID || DEFAULT_EXTENSION_ID;
  const publisherId = resolvePublisherId(process.env.CWS_PUBLISHER_ID);
  const name = itemName(publisherId, extId);

  const crx = await validateCrx(crxPath);
  console.log(`• CRX:       ${crxPath} (${crx.size} bytes${version ? `, manifest v${version}` : ''})`);
  console.log(`• Extension: ${extId}`);
  console.log(`• Publisher: ${publisherId}${(process.env.CWS_PUBLISHER_ID || '').trim() ? '' : ' (default)'}`);
  if (!UUID_RE.test(publisherId)) {
    console.warn(`::warning::CWS_PUBLISHER_ID '${publisherId}' is not a UUID; Chrome Web Store publisher IDs normally are.`);
  }

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

  console.log('• Checking item status…');
  const pre = await preflight({ token, name, version });
  console.log(`  published: ${pre.publishedVersions.join(', ') || 'none'}; pending submission: ${pre.submittedState || 'none'}`);

  console.log('• Uploading signed CRX…');
  const up = await uploadCrx({ token, name, crx, version });
  console.log(`  upload state: ${up.uploadState}${up.crxVersion ? ` (v${up.crxVersion})` : ''}`);

  if (noPublish) {
    console.log('✓ Uploaded. Skipping publish (--no-publish). Submit for review in the dashboard when ready.');
    return;
  }

  console.log('• Submitting for review…');
  const pub = await publishItem({ token, name });
  console.log(`✓ Submitted for review. Status: ${pub.state || 'unknown'}`);
  if (pub.state !== 'UPLOADED_AS_DRAFT') {
    await verifySubmission({ token, name, version });
    console.log('  Google review (in-depth, due to broad host permissions) typically takes hours to ~3 days.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`✗ ${e.message || String(e)}`);
    process.exit(e instanceof CwsError ? e.code : 1);
  });
}
