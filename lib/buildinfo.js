// Compile-time build flag — the single source of truth for whether dev-only
// affordances (the hidden "Test Adhan" trigger) are active.
//
// DEV is `true` in source so an UNPACKED developer load (chrome://extensions ->
// Load unpacked, or Firefox about:debugging -> Load Temporary Add-on) keeps the
// Test trigger. The pack pipeline (scripts/pack-crx.mjs and docs/pack.sh, via
// stageExtension() in scripts/runtime-files.mjs) overwrites the STAGED copy of
// this file with `export const DEV = false;` before zipping or signing, so EVERY
// packaged artifact — Chrome CRX/ZIP today and a future Firefox XPI — ships with
// DEV=false regardless of browser.
//
// This replaces the old update_url-sniffing isDevBuild(), which wrongly reported
// dev=true for an AMO-signed Firefox build (those carry no update_url, so the dev
// UI would have shipped to Firefox users). Detection no longer reads the manifest.
//
// tests/pack.test.js asserts the staged copy is DEV=false (store-safety invariant);
// the dev gate must never regress to a runtime/manifest check. Any future packer
// (e.g. an XPI builder) MUST also stage through stageExtension() or otherwise force
// DEV=false, or it will reintroduce the leak.
export const DEV = true;
