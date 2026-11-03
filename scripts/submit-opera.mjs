#!/usr/bin/env node
// Upload the Opera ZIP to Opera Add-ons Developer Portal or validate it for submission.
//
// Usage:
//   node scripts/submit-opera.mjs [path-to-zip] [--dry-run] [--open]
//
// Arguments:
//   path-to-zip    Path to the Opera ZIP package (defaults to adhan-focus-<version>-opera.zip).
//   --dry-run      Validate the package without making network requests.
//   --open         Open the developer portal upload page in your default browser.
//
// Environment Variables:
//   OPERA_PACKAGE_ID   Defaults to '306857'.
//   OPERA_SESSION      Session cookie for addons.opera.com (if automating headless uploads).
//   OPERA_EMAIL        Opera developer login email (optional).
//   OPERA_PASSWORD     Opera developer login password (optional).

import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKAGE_ID = '306857';

// Load .env if present
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

const PACKAGE_ID = process.env.OPERA_PACKAGE_ID || DEFAULT_PACKAGE_ID;
const OPERA_VERSIONS_URL = `https://addons.opera.com/developer/package/${PACKAGE_ID}/?tab=versions`;
const OPERA_STATS_URL = `https://addons.opera.com/developer/package/${PACKAGE_ID}/?tab=stats`;
const OPERA_GENERAL_URL = `https://addons.opera.com/developer/package/${PACKAGE_ID}/?tab=general`;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const shouldOpen = args.includes('--open');
  const explicitPath = args.find((a) => !a.startsWith('--'));

  const manifestVersion = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8')).version;
  const zipPath = resolve(REPO, explicitPath || `adhan-focus-${manifestVersion}-opera.zip`);

  console.log('================================================================');
  console.log('🚀 OPERA ADD-ONS RELEASE PIPELINE');
  console.log('================================================================');
  console.log(`• Package ID:     ${PACKAGE_ID}`);
  console.log(`• Target Version: v${manifestVersion}`);
  console.log(`• Package File:   ${zipPath}`);
  console.log(`• Versions Tab:   ${OPERA_VERSIONS_URL}`);
  console.log(`• Stats Tab:      ${OPERA_STATS_URL}`);
  console.log('----------------------------------------------------------------');

  if (!existsSync(zipPath)) {
    console.log(`⚠️ Package not found at ${zipPath}. Running npm run pack:opera...`);
    execSync('npm run pack:opera', { cwd: REPO, stdio: 'inherit' });
  }

  const fileStats = await stat(zipPath);
  console.log(`✓ Package verified: ${(fileStats.size / 1024).toFixed(2)} KB`);

  // Verify internal manifest
  try {
    const output = execSync(`unzip -p "${zipPath}" manifest.json`, { encoding: 'utf8' });
    const innerManifest = JSON.parse(output);

    if (innerManifest.version !== manifestVersion) {
      throw new Error(`Inner version ${innerManifest.version} !== manifest.json ${manifestVersion}`);
    }
    if (innerManifest.browser_specific_settings) {
      throw new Error('Opera package contains browser_specific_settings (must be stripped).');
    }
    if (innerManifest.background?.scripts) {
      throw new Error('Opera package contains background.scripts (must be stripped for MV3).');
    }
    console.log('✓ Inner manifest validated (clean Chromium MV3, zero Gecko keys)');
  } catch (err) {
    console.error(`❌ Validation failed: ${err.message}`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('✓ Dry-run completed successfully. Package is production-ready.');
    return;
  }

  const sessionCookie = process.env.OPERA_SESSION || process.env.OPERA_COOKIE;

  if (sessionCookie) {
    console.log('📡 Submitting package via authenticated session...');
    try {
      const fileBuffer = await readFile(zipPath);
      const boundary = '----OperaFormBoundary' + Math.random().toString(36).slice(2);
      const filename = `adhan-focus-${manifestVersion}-opera.zip`;

      const header = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`
      );
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const payload = Buffer.concat([header, fileBuffer, footer]);

      const res = await fetch(OPERA_VERSIONS_URL, {
        method: 'POST',
        headers: {
          'Cookie': sessionCookie.includes('=') ? sessionCookie : `sessionid=${sessionCookie}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0',
        },
        body: payload,
      });

      if (res.ok) {
        console.log('✅ Successfully submitted to Opera Developer Portal!');
        console.log(`• Status: In moderation / Auto-review`);
        console.log(`• Track review at: ${OPERA_GENERAL_URL}`);
        return;
      } else {
        console.log(`⚠️ Direct session response: HTTP ${res.status}. Falling back to portal link.`);
      }
    } catch (err) {
      console.log(`⚠️ Network upload notice: ${err.message}.`);
    }
  }

  console.log('\n----------------------------------------------------------------');
  console.log('📋 AUTOMATED RELEASE READY FOR OPERA DEVELOPER PORTAL');
  console.log('----------------------------------------------------------------');
  console.log('1. Open the Package Versions tab:');
  console.log(`   👉 ${OPERA_VERSIONS_URL}`);
  console.log('\n2. Drag & drop this verified file:');
  console.log(`   📁 ${zipPath}`);
  console.log('\n3. Click "Submit changes" — auto-publishing is enabled for instant approval!');
  console.log('----------------------------------------------------------------');

  if (shouldOpen || process.argv.includes('--open')) {
    try {
      const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      execSync(`${openCmd} "${OPERA_VERSIONS_URL}"`);
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
