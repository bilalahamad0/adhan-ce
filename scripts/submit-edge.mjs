#!/usr/bin/env node
// Upload the Edge ZIP to Microsoft Edge Add-ons and submit it for review.
//
// The last mile of the Edge pipeline, mirroring scripts/submit-cws.mjs. The
// Release (Edge) workflow builds the ZIP; this script (1) uploads it into the
// product's draft submission, (2) polls until the package is accepted, then
// (3) publishes the draft (submits for review).
//
// Usage:
//   node scripts/submit-edge.mjs <path-to.zip> [--dry-run] [--no-publish]
//
//   <path-to.zip>   the package to ship. Defaults to
//                   ./adhan-caster-pro-<manifest.version>-edge.zip (repo root).
//   --dry-run       validate the ZIP + config and exit. Makes NO network calls
//                   and needs NO credentials — safe anywhere, including CI.
//   --no-publish    upload the package but skip publish, leaving it as a draft
//                   in Partner Center for a human to submit.
//
// Required env (for a real run — not needed for --dry-run):
//   EDGE_PRODUCT_ID   the add-on's product ID (Partner Center → Extension →
//                     Overview; a GUID, not the storefront URL slug)
//   EDGE_CLIENT_ID    API client ID from Partner Center → Publish API
//   EDGE_API_KEY      API key paired with that client ID
//
// Locally these come from a gitignored .env; in CI from repo secrets. See
// .github/RELEASE_SETUP.md → "Automating Edge submission".
//
// API: Edge Add-ons REST v1.1 (ApiKey auth). v1 used Azure AD access tokens and
// was retired at the end of 2024 — v1.1 authenticates with the API key directly,
// so there is no token-refresh step and nothing to expire mid-release.

import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://api.addons.microsoftedge.microsoft.com/v1/products';

// Same minimal .env loader as submit-cws.mjs: never overrides an already-set
// variable, so CI secrets always win over a stale local .env.
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

function fail(msg, code = 1) {
  console.error(`✗ ${msg}`);
  process.exit(code);
}

function headers(cfg, extra = {}) {
  return { Authorization: `ApiKey ${cfg.apiKey}`, 'X-ClientID': cfg.clientId, ...extra };
}

// Both upload and publish are async: they return 202 + an operation id in the
// Location header, and you poll until it leaves InProgress. Anything else is a
// hard failure — a silent partial success here would ship nothing while the
// workflow went green.
async function pollOperation(url, cfg, { label, timeoutMs = 10 * 60 * 1000, intervalMs = 10_000 }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(url, { headers: headers(cfg) });
    const body = await res.text();
    if (!res.ok) fail(`${label} status check failed (HTTP ${res.status}): ${body.slice(0, 400)}`);
    let json;
    try {
      json = JSON.parse(body);
    } catch (_) {
      fail(`${label} status check returned non-JSON: ${body.slice(0, 200)}`);
    }
    const status = json.status;
    if (status === 'Succeeded') return json;
    if (status === 'Failed' || status === 'Cancelled') {
      const detail = json.message || JSON.stringify(json.errors || json).slice(0, 400);
      fail(`${label} ${status.toLowerCase()}: ${detail}`);
    }
    if (Date.now() > deadline) fail(`${label} still ${status} after ${Math.round(timeoutMs / 60000)} min — giving up`);
    process.stdout.write(`  ${label}: ${status}…\n`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const noPublish = args.includes('--no-publish');
  const positional = args.filter((a) => !a.startsWith('--'));

  loadDotEnv();

  const version = JSON.parse(await readFile(join(REPO, 'manifest.json'), 'utf8')).version;
  const zipPath = resolve(positional[0] || join(REPO, `adhan-caster-pro-${version}-edge.zip`));
  if (!existsSync(zipPath)) fail(`package not found: ${zipPath} (run \`npm run pack:edge\` first)`);
  const size = (await stat(zipPath)).size;
  if (size === 0) fail(`package is empty: ${zipPath}`);

  const cfg = {
    productId: process.env.EDGE_PRODUCT_ID,
    clientId: process.env.EDGE_CLIENT_ID,
    apiKey: process.env.EDGE_API_KEY,
  };

  console.log(`• Package:   ${zipPath} (${size} bytes, manifest v${version})`);
  console.log(`• Product:   ${cfg.productId || '(unset)'}`);

  if (dryRun) {
    console.log('✓ Dry run: package and configuration look valid. No network calls made.');
    return;
  }

  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) fail(`missing credentials: ${missing.join(', ')} (see .github/RELEASE_SETUP.md)`);

  const base = `${BASE}/${cfg.productId}/submissions`;

  console.log('• Uploading package…');
  const up = await fetch(`${base}/draft/package`, {
    method: 'POST',
    headers: headers(cfg, { 'Content-Type': 'application/zip' }),
    body: await readFile(zipPath),
  });
  if (up.status !== 202) fail(`upload failed (HTTP ${up.status}): ${(await up.text()).slice(0, 400)}`);
  const uploadOp = up.headers.get('location');
  if (!uploadOp) fail('upload accepted but no operation id was returned (missing Location header)');
  await pollOperation(`${base}/draft/package/operations/${uploadOp}`, cfg, { label: 'upload' });
  console.log('  upload state: SUCCESS');

  if (noPublish) {
    console.log('✓ Uploaded. Skipping publish (--no-publish) — submit it from Partner Center.');
    return;
  }

  console.log('• Submitting for review…');
  const pub = await fetch(base, {
    method: 'POST',
    headers: headers(cfg, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ notes: `Automated submission of v${version}` }),
  });
  if (pub.status !== 202) fail(`publish failed (HTTP ${pub.status}): ${(await pub.text()).slice(0, 400)}`);
  const publishOp = pub.headers.get('location');
  if (!publishOp) fail('publish accepted but no operation id was returned (missing Location header)');
  await pollOperation(`${base}/operations/${publishOp}`, cfg, { label: 'publish' });

  console.log('✓ Submitted for review. Status: OK');
  console.log('  Microsoft review typically takes hours to ~7 days for a new listing.');
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
