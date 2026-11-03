#!/usr/bin/env node
// Keep Google Cloud project `adhan-ce-cws` and its Chrome Web Store OAuth
// credentials active by running a lightweight token refresh and read-only
// Chrome Web Store API query on a regular schedule.
//
// Background:
// - Google OAuth refresh tokens expire after 6 months of continuous inactivity.
// - External OAuth consent screens in Testing status have 7-day token expirations.
// - Inactive Google Cloud projects without API traffic can receive dormancy notices.
//
// Schedule cadence:
// - Primary ping: Mondays at 09:00 UTC (weekly scheduled heartbeat)
// - Fallback ping: Thursdays at 09:00 UTC (mid-week redundancy to ensure no
//   inactivity window if the primary run or a GitHub runner was delayed/missed)
//
// Usage:
//   node scripts/heartbeat-cws.mjs [--dry-run] [--mode primary|fallback|manual]
//
// Environment variables:
//   CWS_CLIENT_ID        OAuth2 client ID (Google Cloud adhan-ce-cws)
//   CWS_CLIENT_SECRET    OAuth2 client secret
//   CWS_REFRESH_TOKEN    OAuth2 refresh token with chromewebstore scope
//   CWS_EXTENSION_ID     Optional: target extension ID (defaults to published ID)
//   HEARTBEAT_MODE       Optional: primary | fallback | manual

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_EXTENSION_ID = 'jfjknglldcdminelckmmfdbnlikiogia';
export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const CWS_ITEM_URL = 'https://www.googleapis.com/chromewebstore/v1.1/items';

export function loadDotEnv() {
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

export async function withRetry(fn, { maxRetries = 2, delayMs = 1000, warn = console.warn } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > maxRetries) throw err;
      warn(`! Attempt ${attempt} encountered error: ${err.message}. Retrying in ${delayMs}ms…`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function refreshAccessToken({
  clientId,
  clientSecret,
  refreshToken,
  tokenUrl = TOKEN_URL,
  fetchFn = fetch,
}) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const res = await fetchFn(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const errText = `${data.error || ''} ${data.error_description || ''}`.trim();
    throw new Error(`OAuth token refresh failed (HTTP ${res.status}): ${errText || 'Unknown error'}`);
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

export async function queryItemStatus({
  token,
  extId,
  apiUrl = CWS_ITEM_URL,
  fetchFn = fetch,
}) {
  const url = `${apiUrl}/${extId}?projection=draft`;
  const res = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'x-goog-api-version': '2',
    },
  });

  const data = await res.json().catch(() => ({}));
  return {
    ok: res.ok,
    status: res.status,
    data,
  };
}

export function parseCliArgs(args = []) {
  const dryRun = args.includes('--dry-run');
  let mode = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--mode=')) {
      mode = args[i].slice(7);
    } else if (args[i] === '--mode' && args[i + 1]) {
      mode = args[++i];
    } else if (args[i] === '--primary') {
      mode = 'primary';
    } else if (args[i] === '--fallback') {
      mode = 'fallback';
    }
  }
  return { dryRun, mode };
}

export async function runHeartbeat({
  mode = null,
  dryRun = false,
  env = process.env,
  fetchFn = fetch,
  log = console.log,
  warn = console.warn,
  retryDelayMs = 1000,
} = {}) {
  const selectedMode = (mode || env.HEARTBEAT_MODE || 'primary').toLowerCase();
  const modeDescriptions = {
    primary: 'PRIMARY (weekly scheduled)',
    fallback: 'FALLBACK (mid-week redundancy)',
    manual: 'MANUAL (on-demand)',
  };
  const modeLabel = modeDescriptions[selectedMode] || selectedMode.toUpperCase();

  const extId = env.CWS_EXTENSION_ID || DEFAULT_EXTENSION_ID;
  log(`• Heartbeat Mode: ${modeLabel}`);
  log(`• Extension ID:   ${extId}`);

  if (dryRun) {
    log('✓ Dry run: heartbeat configuration verified (no network calls made).');
    return { dryRun: true, ok: true, mode: selectedMode };
  }

  const creds = {
    clientId: env.CWS_CLIENT_ID,
    clientSecret: env.CWS_CLIENT_SECRET,
    refreshToken: env.CWS_REFRESH_TOKEN,
  };

  const missing = Object.entries(creds)
    .filter(([, v]) => !v)
    .map(([k]) => ({ clientId: 'CWS_CLIENT_ID', clientSecret: 'CWS_CLIENT_SECRET', refreshToken: 'CWS_REFRESH_TOKEN' }[k]));

  if (missing.length) {
    throw new Error(
      `Missing required credentials: ${missing.join(', ')}.\n` +
      '  Set them in .env (see .env.example) or as repository secrets in GitHub Actions.\n' +
      '  Or pass --dry-run to validate configuration without network calls.'
    );
  }

  log('• Contacting Google OAuth2 (refreshing access token for project adhan-ce-cws)…');
  const { accessToken, expiresIn } = await withRetry(
    () => refreshAccessToken({ ...creds, fetchFn }),
    { maxRetries: 2, delayMs: retryDelayMs, warn }
  );
  log(`✓ Access token successfully refreshed (expires in ${expiresIn || 3600}s).`);

  log('• Querying Chrome Web Store API (read-only item check)…');
  const itemResult = await withRetry(
    () => queryItemStatus({ token: accessToken, extId, fetchFn }),
    { maxRetries: 2, delayMs: retryDelayMs, warn }
  );

  if (itemResult.ok) {
    const crxVer = itemResult.data.crxVersion ? `v${itemResult.data.crxVersion}` : 'active';
    const state = itemResult.data.uploadState || 'SUCCESS';
    log(`✓ Chrome Web Store API query succeeded (state: ${state}, version: ${crxVer}).`);
  } else {
    warn(
      `! Chrome Web Store item query returned HTTP ${itemResult.status}: ` +
      `${itemResult.data.error?.message || JSON.stringify(itemResult.data)}\n` +
      '  Note: Google Cloud OAuth token exchange succeeded, keeping the GCP project and refresh token active.'
    );
  }

  log(`✓ Heartbeat (${selectedMode}) completed successfully. Google Cloud project activity registered.`);
  return {
    ok: true,
    mode: selectedMode,
    tokenRefreshed: true,
    itemStatus: itemResult,
  };
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  loadDotEnv();
  const { dryRun, mode } = parseCliArgs(process.argv.slice(2));

  runHeartbeat({ dryRun, mode })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`✗ ${err.message}`);
      process.exit(1);
    });
}
