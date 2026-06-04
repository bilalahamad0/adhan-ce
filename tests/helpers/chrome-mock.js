// A self-contained, in-memory mock of the slice of the `chrome.*` extension API
// that background.js / content.js / popup.js actually touch. It is deliberately
// faithful to two quirks that the real code depends on:
//
//   1. chrome.storage.local.get/set work in BOTH promise form (background/popup,
//      `await chrome.storage.local.get(...)`) and callback form (content.js,
//      `chrome.storage.local.get([...], cb)`).
//   2. set() computes {oldValue,newValue} diffs and fires storage.onChanged with
//      area 'local' — content.js drives most of its state off those events.
//
// Event registrations (onInstalled / onStartup / onAlarm / onMessage / onCommand
// / notification clicks / storage.onChanged) are captured so a test can invoke
// the handler the production code registered, exercising the real code path.
//
// makeChrome() returns the `chrome` object with a non-enumerable `__` test harness
// hanging off it (listeners, recorded calls, and fire* helpers).

function listenerHub() {
  const fns = [];
  return {
    addListener: (fn) => fns.push(fn),
    removeListener: (fn) => {
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    },
    hasListener: (fn) => fns.includes(fn),
    _fns: fns,
    async emit(...args) {
      let last;
      for (const fn of fns.slice()) last = await fn(...args);
      return last;
    },
  };
}

export function makeChrome(opts = {}) {
  const store = { ...(opts.initialStorage || {}) };
  const onChanged = listenerHub();
  const onMessage = listenerHub();
  const onInstalled = listenerHub();
  const onStartup = listenerHub();
  const onAlarm = listenerHub();
  const onCommand = listenerHub();
  const notifClicked = listenerHub();
  const notifButtonClicked = listenerHub();

  const harness = {
    store,
    alarms: new Map(), // name -> options
    notifications: [], // {id, options}
    broadcasts: [], // messages sent via tabs.sendMessage
    injected: [], // tabIds we ran executeScript on
    badge: { text: '', color: null },
    sent: [], // runtime.sendMessage payloads from content/popup
    popupOpened: 0,
    onChanged,
    onMessage,
    onInstalled,
    onStartup,
    onAlarm,
    onCommand,
    notifClicked,
    notifButtonClicked,
    // Tests override these to steer behaviour:
    handleSendMessage: opts.handleSendMessage || (() => ({ ok: true })),
    tabsList: opts.tabs || [{ id: 1 }, { id: 2 }],
    // Set of tabIds with NO live content script — tabs.sendMessage rejects for
    // these (forcing background.js down its inject-then-retry path).
    deadTabs: new Set(opts.deadTabs || []),
  };

  // --- storage.local with promise+callback duality and onChanged diffing ---
  function pick(keys) {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return key(keys);
    if (Array.isArray(keys)) return Object.fromEntries(keys.map((k) => [k, store[k]]).filter(([, v]) => v !== undefined));
    // object form: defaults
    const out = {};
    for (const k of Object.keys(keys)) out[k] = k in store ? store[k] : keys[k];
    return out;
  }
  function key(k) {
    return k in store ? { [k]: store[k] } : {};
  }
  function get(keys, cb) {
    const res = pick(keys);
    if (typeof cb === 'function') {
      cb(res);
      return;
    }
    return Promise.resolve(res);
  }
  async function set(obj, cb) {
    const changes = {};
    for (const k of Object.keys(obj)) {
      const oldValue = store[k];
      const newValue = obj[k];
      store[k] = newValue;
      changes[k] = { oldValue, newValue };
    }
    await onChanged.emit(changes, 'local');
    if (typeof cb === 'function') cb();
    return undefined;
  }
  async function remove(keys, cb) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of arr) {
      if (k in store) {
        changes[k] = { oldValue: store[k], newValue: undefined };
        delete store[k];
      }
    }
    await onChanged.emit(changes, 'local');
    if (typeof cb === 'function') cb();
  }
  async function clear(cb) {
    for (const k of Object.keys(store)) delete store[k];
    if (typeof cb === 'function') cb();
  }

  const chrome = {
    storage: {
      local: { get, set, remove, clear },
      onChanged: { addListener: onChanged.addListener, removeListener: onChanged.removeListener },
    },
    alarms: {
      create: (name, options) => harness.alarms.set(name, options),
      clear: async (name) => harness.alarms.delete(name),
      clearAll: async () => harness.alarms.clear(),
      get: async (name) => (harness.alarms.has(name) ? { name, ...harness.alarms.get(name) } : null),
      getAll: async () => [...harness.alarms.entries()].map(([name, o]) => ({ name, ...o })),
      onAlarm: { addListener: onAlarm.addListener },
    },
    tabs: {
      query: async () => harness.tabsList.slice(),
      sendMessage: async (tabId, message) => {
        if (harness.deadTabs.has(tabId)) throw new Error('Could not establish connection');
        harness.broadcasts.push({ tabId, message });
        return undefined;
      },
    },
    scripting: {
      insertCSS: async () => {},
      executeScript: async ({ target }) => {
        harness.injected.push(target && target.tabId);
        // After injection the tab has a live content script — subsequent sends succeed.
        if (target) harness.deadTabs.delete(target.tabId);
      },
    },
    notifications: {
      create: async (id, options) => {
        harness.notifications.push({ id, options });
        return id;
      },
      onClicked: { addListener: notifClicked.addListener },
      onButtonClicked: { addListener: notifButtonClicked.addListener },
    },
    action: {
      setBadgeText: async ({ text }) => {
        harness.badge.text = text;
      },
      setBadgeBackgroundColor: async ({ color }) => {
        harness.badge.color = color;
      },
      openPopup: async () => {
        harness.popupOpened++;
      },
    },
    commands: { onCommand: { addListener: onCommand.addListener } },
    i18n: { getUILanguage: () => opts.uiLang || 'en-US' },
    runtime: {
      id: opts.runtimeId === undefined ? 'test-extension-id' : opts.runtimeId,
      lastError: null,
      getManifest: () => opts.manifest || { version: '1.7.4' },
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: onMessage.addListener },
      onInstalled: { addListener: onInstalled.addListener },
      onStartup: { addListener: onStartup.addListener },
      // content.js/popup.js send messages OUT; route to the test-controlled handler.
      sendMessage: (message, cb) => {
        harness.sent.push(message);
        const resp = harness.handleSendMessage(message);
        if (typeof cb === 'function') {
          cb(resp);
          return undefined;
        }
        return Promise.resolve(resp);
      },
    },
  };

  // --- test harness: invoke the handlers the production code registered ---
  harness.fireInstalled = (...a) => onInstalled.emit(...a);
  harness.fireStartup = (...a) => onStartup.emit(...a);
  harness.fireAlarm = (name) => onAlarm.emit({ name });
  harness.fireCommand = (cmd) => onCommand.emit(cmd);
  harness.clickNotif = (...a) => notifClicked.emit(...a);
  harness.clickNotifButton = (id, idx) => notifButtonClicked.emit(id, idx);
  harness.fireStorageChange = (changes, area = 'local') => onChanged.emit(changes, area);
  // Dispatch a runtime message through the registered onMessage handler and
  // resolve with whatever it passes to sendResponse (handlers `return true`).
  harness.sendRuntimeMessage = (msg, sender = {}) =>
    new Promise((resolve) => {
      let resolved = false;
      const sendResponse = (r) => {
        resolved = true;
        resolve(r);
      };
      const kept = onMessage._fns.map((fn) => fn(msg, sender, sendResponse)).some((r) => r === true);
      if (!kept && !resolved) resolve(undefined);
    });

  Object.defineProperty(chrome, '__', { value: harness, enumerable: false });
  return chrome;
}

// Drain pending microtasks + macrotasks so async work kicked off by a fire*()
// (e.g. onAlarm → handlePrayerFire(), which the listener does NOT await) settles
// before assertions. No real timers are involved (alarms are mocked), so a few
// setImmediate turns fully flush the chain of awaited storage/fetch promises.
export async function flush(turns = 8) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}
