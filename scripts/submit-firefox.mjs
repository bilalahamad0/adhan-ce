#!/usr/bin/env node
// Submit the Firefox XPI to Mozilla Add-ons (AMO) for signing and publishing.
//
// Usage:
//   node scripts/submit-firefox.mjs [--dry-run]
//
// Environment Variables (from .env or process.env):
//   AMO_JWT_ISSUER or WEB_EXT_API_KEY       (JWT Issuer from AMO API keys)
//   AMO_JWT_SECRET or WEB_EXT_API_SECRET   (JWT Secret from AMO API keys)

import { stageExtension, REPO } from './runtime-files.mjs';
import { packXpi, FIREFOX_NAME } from './pack-xpi.mjs';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

// Minimal .env loader
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

  const manifest = JSON.parse(await readFile(join(REPO, 'manifest.json'), 'utf8'));
  const version = manifest.version;

  console.log('================================================================');
  console.log('🦊 MOZILLA FIREFOX (AMO) AUTOMATED RELEASE PIPELINE');
  console.log('================================================================');
  console.log(`• Target Version:  v${version}`);
  console.log(`• Add-on Name:     ${FIREFOX_NAME}`);
  console.log(`• Add-on ID:       ${manifest.browser_specific_settings?.gecko?.id}`);
  console.log(`• Android Min:     Firefox Android ${manifest.browser_specific_settings?.gecko_android?.strict_min_version}`);
  console.log('----------------------------------------------------------------');

  // Step 1: Pack & lint
  console.log('▶ Staging and linting package...');
  const { xpiPath, size, stageDir } = await packXpi();
  console.log(`✓ Staged: ${stageDir} -> ${(size / 1024).toFixed(2)} KB (${xpiPath})`);

  try {
    execSync(`npx --yes addons-linter "${stageDir}"`, { stdio: 'inherit' });
    console.log('✓ Mozilla Add-ons linter passed: 0 errors');
  } catch (err) {
    console.error('❌ addons-linter found issues. Aborting.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('✓ Dry-run completed successfully. Package is ready for AMO.');
    return;
  }

  const apiKey = process.env.AMO_JWT_ISSUER || process.env.WEB_EXT_API_KEY;
  const apiSecret = process.env.AMO_JWT_SECRET || process.env.WEB_EXT_API_SECRET;

  if (!apiKey || !apiSecret) {
    console.log('\n⚠️ AMO API credentials (AMO_JWT_ISSUER / AMO_JWT_SECRET) not set in .env.');
    console.log('To automate zero-click terminal publishing:');
    console.log('1. Go to https://addons.mozilla.org/en-US/developers/addon/api/key/');
    console.log('2. Copy JWT Issuer and JWT Secret into .env:');
    console.log('   AMO_JWT_ISSUER=user:xxxxx:xxx');
    console.log('   AMO_JWT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    console.log('\nAlternatively, push a git tag to let GitHub Actions publish automatically:');
    console.log(`   git tag firefox-v${version}`);
    console.log(`   git push origin firefox-v${version}`);
    return;
  }

  console.log('\n📡 Submitting to Mozilla AMO API via web-ext...');
  try {
    const cmd = [
      'npx --yes web-ext@10 sign',
      '--channel listed',
      `--source-dir "${stageDir}"`,
      '--artifacts-dir web-ext-artifacts',
      `--api-key "${apiKey}"`,
      `--api-secret "${apiSecret}"`,
      '--approval-timeout 0',
    ].join(' ');

    execSync(cmd, { stdio: 'inherit' });
    console.log(`\n🎉 Successfully submitted v${version} to Mozilla AMO!`);
    console.log('• Desktop Store: https://addons.mozilla.org/en-US/firefox/addon/adhan-caster-prayer-times/');
    console.log('• Android Store: https://addons.mozilla.org/en-US/android/addon/adhan-caster-prayer-times/');
  } catch (err) {
    console.error(`❌ Submission failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
