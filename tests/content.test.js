/**
 * @jest-environment jsdom
 */
// content.js is a classic IIFE content script. We load the REAL file into a jsdom
// page via a cache-busted dynamic import (so Istanbul instruments it and the IIFE
// re-runs fresh each test, exactly as a <script> would), give it a chrome mock and
// fake media elements, then drive the two inputs it reacts to — runtime messages
// (PRAYER_NOW / RESUME / FOCUS_*) and storage.onChanged — plus the 1-second tick,
// asserting media pause/resume, the overlay, and the self-healing fallbacks.
import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { makeChrome } from './helpers/chrome-mock.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EN = JSON.parse(readFileSync(join(ROOT, 'locales', 'en.json'), 'utf8'));
const BASE = 1_750_000_000_000; // fixed instant; ts values are absolute (TZ-agnostic)

let chrome;
let counter = 0;

function settings(over = {}) {
  return { enabled: true, focusMode: false, autoResumeMinutes: 5, leadSeconds: 30, ...over };
}

// A media element whose play/pause are observable (jsdom doesn't implement them).
function addVideo(playing = true) {
  const v = document.createElement('video');
  let paused = !playing;
  Object.defineProperty(v, 'paused', { get: () => paused, configurable: true });
  Object.defineProperty(v, 'ended', { get: () => false, configurable: true });
  v.pause = jest.fn(() => {
    paused = true;
  });
  v.play = jest.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  document.body.appendChild(v);
  return v;
}

async function load({ storage = {}, i18n = { messages: EN, dir: 'ltr' } } = {}) {
  chrome = makeChrome({ initialStorage: storage, handleSendMessage: (m) => (m.type === 'GET_I18N' ? i18n : { ok: true }) });
  globalThis.chrome = chrome;
  await import(`../content.js?t=${++counter}`); // runs the IIFE against the jsdom globals
}

const dispatch = (msg) => chrome.__.onMessage.emit(msg);
const host = () => document.getElementById('adhan-ccp-host');
const focusHost = () => document.getElementById('adhan-ccp-focus-host');
const sent = (type) => chrome.__.sent.filter((m) => m.type === type);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(BASE);
  document.body.innerHTML = '';
  document.documentElement.style.overflow = '';
});
afterEach(() => {
  // jsdom's window persists across tests, so each eval'd instance leaves its
  // window-level listeners (keydown/wheel/visibilitychange) attached. Flip the
  // instance token and run one tick: every live instance sees it's been superseded
  // and tears down — clearing its interval and unlocking scroll (focusLocked→false)
  // — so those leftover listeners go inert instead of bleeding into the next test.
  try {
    window.__adhanCasterInstance = '__dead__';
    jest.advanceTimersByTime(1000);
  } catch (_) {}
  jest.clearAllTimers();
  jest.useRealTimers();
  delete globalThis.chrome;
  delete window.__adhanCasterInstance;
});

describe('cross-tab pause/resume via broadcast', () => {
  it('PRAYER_NOW pauses playing media; RESUME plays it again', async () => {
    const v = addVideo();
    await load({ storage: { settings: settings(), nextPrayer: { name: 'Asr', time: '4:56 PM', ts: BASE + 3600e3 }, paused: { active: false } } });

    dispatch({ type: 'PRAYER_NOW', prayer: 'Asr', time: '4:56 PM', focus: false, since: BASE });
    expect(v.pause).toHaveBeenCalledTimes(1);
    expect(v.paused).toBe(true);

    dispatch({ type: 'RESUME' });
    expect(v.play).toHaveBeenCalledTimes(1);
    expect(v.paused).toBe(false);
  });

  it('reacts to storage.onChanged the background writes (pause then auto-resume)', async () => {
    const v = addVideo();
    await load({ storage: { settings: settings(), nextPrayer: { name: 'Asr', ts: BASE + 3600e3 }, paused: { active: false } } });

    await chrome.storage.local.set({ paused: { active: true, prayer: 'Asr', since: BASE } });
    expect(v.paused).toBe(true);

    await chrome.storage.local.set({ paused: { active: false } });
    expect(v.play).toHaveBeenCalled();
    expect(v.paused).toBe(false);
  });
});

describe('per-tab fallback pause (background alarm delayed)', () => {
  it('pauses and notifies the background when prayer time arrives in-window', async () => {
    const v = addVideo();
    await load({ storage: { settings: settings(), nextPrayer: { name: 'Asr', time: '4:56 PM', ts: BASE }, paused: { active: false } } });

    jest.advanceTimersByTime(1000); // one tick, now just past np.ts
    expect(v.paused).toBe(true);
    expect(sent('PRAYER_FALLBACK')).toHaveLength(1);
    expect(sent('PRAYER_FALLBACK')[0]).toMatchObject({ prayer: 'Asr' });
  });

  it('does NOT pause when the prayer moment is stale (device woke from sleep)', async () => {
    const v = addVideo();
    await load({ storage: { settings: settings(), nextPrayer: { name: 'Asr', ts: BASE - 100000 }, paused: { active: false } } });

    jest.advanceTimersByTime(1000);
    expect(v.pause).not.toHaveBeenCalled();
    expect(sent('PRAYER_FALLBACK')).toHaveLength(0);
  });

  it('does not re-pause for a prayer already handled (lastHandledTs pinned on RESUME)', async () => {
    const v = addVideo();
    await load({ storage: { settings: settings(), nextPrayer: { name: 'Asr', ts: BASE }, paused: { active: false } } });

    dispatch({ type: 'RESUME' }); // pins lastHandledTs to the current prayer
    jest.advanceTimersByTime(1000);
    expect(v.pause).not.toHaveBeenCalled();
    expect(sent('PRAYER_FALLBACK')).toHaveLength(0);
  });
});

describe('client-side auto-resume safety net', () => {
  it('self-resumes and tells the background when the window has elapsed', async () => {
    const v = addVideo();
    await load({ storage: { settings: settings({ autoResumeMinutes: 5 }), nextPrayer: { name: 'Asr', ts: BASE + 3600e3 }, paused: { active: false } } });

    // This tab paused its own media (via the broadcast), with the pause having
    // begun 6 minutes ago — past the 5-minute auto-resume window.
    dispatch({ type: 'PRAYER_NOW', prayer: 'Asr', time: '4:56 PM', focus: false, since: BASE - 6 * 60000 });
    expect(v.paused).toBe(true);

    jest.advanceTimersByTime(1000); // next tick notices the window elapsed
    expect(v.play).toHaveBeenCalled();
    expect(sent('RESUME_NOW')).toHaveLength(1);
  });
});

describe('overlay rendering (top frame, shadow DOM)', () => {
  it('shows the countdown card inside the lead window', async () => {
    await load({ storage: { settings: settings({ leadSeconds: 30 }), nextPrayer: { name: 'Asr', time: '4:56 PM', ts: BASE + 10000 }, paused: { active: false } } });
    jest.advanceTimersByTime(1000);

    const card = host().shadowRoot.querySelector('.card');
    expect(card.classList.contains('show')).toBe(true);
    expect(card.querySelector('.title').textContent).toContain('Asr');
    expect(card.querySelector('.sub').textContent).toMatch(/Starting in \d+s/);
  });

  it('raises the full-screen focus overlay and locks scrolling when focus is on', async () => {
    await load({ storage: { settings: settings({ focusMode: true }), nextPrayer: { name: 'Asr', ts: BASE + 3600e3 }, paused: { active: false } } });

    dispatch({ type: 'PRAYER_NOW', prayer: 'Asr', time: '4:56 PM', focus: true, since: BASE });

    const scrim = focusHost().shadowRoot.querySelector('.scrim');
    expect(scrim.classList.contains('show')).toBe(true);
    expect(scrim.getAttribute('role')).toBe('dialog'); // accessible modal
    expect(document.documentElement.style.overflow).toBe('hidden');
  });

  it('builds overlays without innerHTML (renders on Trusted-Types sites)', async () => {
    await load({ storage: { settings: settings({ focusMode: true }), nextPrayer: { name: 'Asr', ts: BASE + 3600e3 }, paused: { active: false } } });
    dispatch({ type: 'PRAYER_NOW', prayer: 'Asr', time: '4:56 PM', focus: true, since: BASE });
    // 36 scattered star nodes prove the createElement loop ran (innerHTML would throw under TT).
    expect(focusHost().shadowRoot.querySelectorAll('.star')).toHaveLength(36);
  });

  it('Esc resumes from the focus overlay', async () => {
    const v = addVideo();
    await load({ storage: { settings: settings({ focusMode: true }), nextPrayer: { name: 'Asr', ts: BASE + 3600e3 }, paused: { active: false } } });
    dispatch({ type: 'PRAYER_NOW', prayer: 'Asr', time: '4:56 PM', focus: true, since: BASE });

    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(v.play).toHaveBeenCalled();
    expect(sent('RESUME_NOW')).toHaveLength(1);
  });
});

describe('corner card + focus toggles', () => {
  it('the corner card Resume button resumes media and tells the background', async () => {
    const v = addVideo();
    await load({ storage: { settings: settings(), nextPrayer: { name: 'Asr', ts: BASE + 3600e3 }, paused: { active: false } } });

    dispatch({ type: 'PRAYER_NOW', prayer: 'Asr', time: '4:56 PM', focus: false, since: BASE }); // corner (non-focus) pause
    const btn = host().shadowRoot.querySelector('.resume');
    expect(btn.hidden).toBe(false);
    btn.click();

    expect(v.play).toHaveBeenCalled();
    expect(sent('RESUME_NOW')).toHaveLength(1);
  });

  it('FOCUS_ON raises the overlay and FOCUS_OFF dismisses it', async () => {
    await load({ storage: { settings: settings(), nextPrayer: { name: 'Asr', ts: BASE + 3600e3 }, paused: { active: true, prayer: 'Asr', time: '4:56 PM', since: BASE } } });

    dispatch({ type: 'FOCUS_ON', prayer: 'Asr', time: '4:56 PM', since: BASE });
    expect(focusHost().shadowRoot.querySelector('.scrim').classList.contains('show')).toBe(true);

    dispatch({ type: 'FOCUS_OFF' });
    expect(focusHost().shadowRoot.querySelector('.scrim').classList.contains('show')).toBe(false);
  });

  it('locks scroll and swallows navigation keys/wheel while the focus overlay is up', async () => {
    await load({ storage: { settings: settings({ focusMode: true }), nextPrayer: { name: 'Asr', ts: BASE + 3600e3 }, paused: { active: false } } });
    dispatch({ type: 'PRAYER_NOW', prayer: 'Asr', time: '4:56 PM', focus: true, since: BASE });

    const wheel = new window.WheelEvent('wheel', { cancelable: true });
    window.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);

    const pageDown = new window.KeyboardEvent('keydown', { key: 'PageDown', cancelable: true });
    window.dispatchEvent(pageDown);
    expect(pageDown.defaultPrevented).toBe(true);
  });
});

describe('single-instance lifecycle', () => {
  it('tears down when a newer instance claims the frame', async () => {
    await load({ storage: { settings: settings({ leadSeconds: 30 }), nextPrayer: { name: 'Asr', ts: BASE + 10000 }, paused: { active: false } } });
    jest.advanceTimersByTime(1000);
    expect(host()).not.toBeNull();

    window.__adhanCasterInstance = 'someone-else'; // a fresh injection took over
    jest.advanceTimersByTime(1000);
    expect(host()).toBeNull(); // old instance removed its UI
  });

  it('tears down when the extension context is invalidated (reload/disable)', async () => {
    await load({ storage: { settings: settings({ leadSeconds: 30 }), nextPrayer: { name: 'Asr', ts: BASE + 10000 }, paused: { active: false } } });
    jest.advanceTimersByTime(1000);
    expect(host()).not.toBeNull();

    chrome.runtime.id = undefined; // contextAlive() → false
    jest.advanceTimersByTime(1000);
    expect(host()).toBeNull();
  });
});
