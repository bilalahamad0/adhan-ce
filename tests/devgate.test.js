/**
 * @jest-environment jsdom
 */
// Behavioral coverage of the DEV=false (packaged store build) path. The dev gate
// is the compile-time DEV flag from lib/buildinfo.js; source ships DEV=true, so
// the other suites only ever exercise the dev-accepts branch. Here we mock the
// flag OFF and prove BOTH consumers honor it: the worker refuses TEST_ADHAN and
// the popup hides the Test row. (tests/pack.test.js separately proves packed
// builds actually stage DEV=false — together they close the store-safety loop.)
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

jest.unstable_mockModule('../lib/buildinfo.js', () => ({ DEV: false }));

const { makeChrome } = await import('./helpers/chrome-mock.js');
const { makeFetch } = await import('./helpers/fetch-mock.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cat = (code) => JSON.parse(readFileSync(join(ROOT, 'locales', `${code}.json`), 'utf8'));
const BODY = readFileSync(join(ROOT, 'popup.html'), 'utf8')
  .match(/<body>([\s\S]*)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, '');

const DEFAULTS = {
  enabled: true, country: 'United States', state: 'California', city: 'Sunnyvale',
  autoResumeMinutes: 5, leadSeconds: 30, focusMode: true, method: 2, school: 0,
  showHijri: true, hijriOffset: 0,
};

const settle = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};

let counter = 0;

it('background refuses TEST_ADHAN in a packaged build (DEV=false)', async () => {
  const chrome = makeChrome({ initialStorage: { settings: DEFAULTS } });
  globalThis.chrome = chrome;
  globalThis.fetch = makeFetch([['api.aladhan.com', () => ({})]]);
  await import(`../background.js?t=devgate-${++counter}`);
  // The gate short-circuits before any scheduling, so no schedule/fetch is needed.
  const res = await chrome.__.sendRuntimeMessage({ type: 'TEST_ADHAN', seconds: 30 });
  expect(res).toEqual({ ok: false, error: 'dev only' });
});

it('popup hides the Test row in a packaged build (DEV=false)', async () => {
  document.body.innerHTML = BODY;
  const state = { settings: DEFAULTS, schedule: null, nextPrayer: null, paused: { active: false }, prayerLog: {}, usage: null };
  const chrome = makeChrome({
    initialStorage: {},
    manifest: { version: '2.0.0' },
    handleSendMessage: (m) => (m.type === 'GET_STATE' ? state : { ok: true }),
  });
  globalThis.chrome = chrome;
  globalThis.fetch = makeFetch([['locales/', (url) => cat(url.match(/locales\/(\w+)\.json/)[1])]]);
  await import(`../popup.js?t=devgate-${++counter}`);
  await settle();
  expect(document.querySelector('.dev-row').hidden).toBe(true);
});
