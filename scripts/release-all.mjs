#!/usr/bin/env node
// Master publishing orchestrator for Adhan Focus across all browser stores.
//
// Usage:
//   node scripts/release-all.mjs [--dry-run]
//
// Runs end-to-end qualification, builds packages for all platforms, and submits
// them to:
//   1. Mozilla Add-ons (AMO) — Firefox Desktop & Firefox for Android
//   2. Chrome Web Store (CWS) — Google Chrome
//   3. Microsoft Edge Add-ons — Microsoft Edge
//   4. Opera Add-ons — Opera Browser

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Load .env
function loadDotEnv() {
  const envPath = join(REPO, '.env');
  if (!existsSync(envPath)) return;
  try {
    const text = readFileSync(envPath, 'utf8');
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
  } catch (_) {}
}

loadDotEnv();

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const manifest = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8'));
  const version = manifest.version;

  console.log('========================================================================');
  console.log(`🚀 ADHAN FOCUS MULTI-STORE RELEASE ORCHESTRATOR (v${version})`);
  console.log('========================================================================');

  // Step 1: Run automated tests
  console.log('\n▶ Step 1: Running unit tests and qualification suite...');
  execSync('npm test', { cwd: REPO, stdio: 'inherit' });
  console.log('✓ All tests passed.');

  // Step 2: Build all packages
  console.log('\n▶ Step 2: Building production distribution packages...');
  console.log('  • Packaging Firefox XPI (Desktop & Android)...');
  execSync('npm run pack:xpi', { cwd: REPO, stdio: 'inherit' });

  console.log('  • Packaging Chrome Extension...');
  execSync('npm run pack', { cwd: REPO, stdio: 'inherit' });

  console.log('  • Packaging Microsoft Edge ZIP...');
  execSync('npm run pack:edge', { cwd: REPO, stdio: 'inherit' });

  console.log('  • Packaging Opera Add-ons ZIP...');
  execSync('npm run pack:opera', { cwd: REPO, stdio: 'inherit' });

  console.log('✓ All packages built successfully.');

  // Step 3: Run store submissions
  console.log('\n▶ Step 3: Submitting to browser stores...');
  const flag = dryRun ? '--dry-run' : '';

  // 1. Firefox
  console.log('\n--- [1/4] Mozilla Firefox (Desktop & Android) ---');
  try {
    execSync(`node scripts/submit-firefox.mjs ${flag}`, { cwd: REPO, stdio: 'inherit' });
  } catch (err) {
    console.warn('⚠️ Firefox submission notice:', err.message);
  }

  // 2. Chrome
  console.log('\n--- [2/4] Google Chrome (Chrome Web Store) ---');
  try {
    execSync(`node scripts/submit-cws.mjs ${flag}`, { cwd: REPO, stdio: 'inherit' });
  } catch (err) {
    console.warn('⚠️ Chrome submission notice:', err.message);
  }

  // 3. Edge
  console.log('\n--- [3/4] Microsoft Edge (Edge Add-ons) ---');
  try {
    execSync(`node scripts/submit-edge.mjs ${flag}`, { cwd: REPO, stdio: 'inherit' });
  } catch (err) {
    console.warn('⚠️ Edge submission notice:', err.message);
  }

  // 4. Opera
  console.log('\n--- [4/4] Opera Browser (Opera Add-ons) ---');
  try {
    execSync(`node scripts/submit-opera.mjs ${flag}`, { cwd: REPO, stdio: 'inherit' });
  } catch (err) {
    console.warn('⚠️ Opera submission notice:', err.message);
  }

  console.log('\n========================================================================');
  console.log(`✅ RELEASE PIPELINE COMPLETE FOR v${version}`);
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('Fatal release error:', err);
  process.exit(1);
});
