// Adhan Caster — runtime i18n with in-app language switching.
//
// Why a custom layer (not chrome.i18n): chrome.i18n.getMessage() resolves against
// the BROWSER UI locale and cannot be switched at runtime, so it can't power an
// in-app language picker. This module loads JSON catalogs from /locales, persists
// the chosen language in chrome.storage.local ('lang'), and falls back to English
// for any missing key. Imported by popup.js and background.js; content.js (a
// classic content script that can't import ES modules) gets its catalog from the
// background via a GET_I18N message and reuses the same JSON.
//
// The pure helpers (interpolate / makeT / resolveLang / isRTLLang) take no chrome
// or DOM deps so they're unit-testable under Node/Jest.

export const FALLBACK = 'en';
export const SUPPORTED = ['en', 'ar', 'ur', 'id', 'tr', 'fr'];
export const RTL = new Set(['ar', 'ur', 'fa', 'he']);

export const isRTLLang = (code) => RTL.has(code);

// Replace {placeholder} tokens. Pure.
export function interpolate(str, params) {
  if (str == null || !params) return str;
  return String(str).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}

// Build a t(key, params) bound to an active catalog + English fallback. Pure.
export function makeT(messages, fallback) {
  const msg = messages || {};
  const fb = fallback || {};
  return (key, params) => {
    const s = key in msg ? msg[key] : key in fb ? fb[key] : key;
    return interpolate(s, params);
  };
}

// Pick the initial language from a saved preference, else the browser UI locale,
// else English. Accepts "ar", "ar-EG", etc. Pure.
export function resolveLang(saved, uiLang) {
  if (saved && SUPPORTED.includes(saved)) return saved;
  const ui = String(uiLang || FALLBACK).toLowerCase();
  if (SUPPORTED.includes(ui)) return ui;
  const base = ui.split('-')[0];
  return SUPPORTED.includes(base) ? base : FALLBACK;
}

// ---- runtime state (chrome + fetch) ----
const _cache = new Map();
let _lang = FALLBACK;
let _messages = {};
let _fallback = {};
let _t = makeT({}, {});

async function fetchCatalog(code) {
  if (_cache.has(code)) return _cache.get(code);
  try {
    const res = await fetch(chrome.runtime.getURL(`locales/${code}.json`));
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    _cache.set(code, data);
    return data;
  } catch (_) {
    return {};
  }
}

// Merged catalog (English base overlaid with the requested language). Handy for
// handing a complete map to the content script over messaging.
export async function getCatalog(code) {
  const fb = await fetchCatalog(FALLBACK);
  if (!code || code === FALLBACK) return { ...fb };
  const c = await fetchCatalog(code);
  return { ...fb, ...c };
}

export async function initI18n() {
  if (!Object.keys(_fallback).length) _fallback = await fetchCatalog(FALLBACK);
  const { lang: saved } = await chrome.storage.local.get('lang');
  let ui = FALLBACK;
  try {
    ui = chrome.i18n.getUILanguage();
  } catch (_) {}
  _lang = resolveLang(saved, ui);
  _messages = _lang === FALLBACK ? _fallback : await fetchCatalog(_lang);
  _t = makeT(_messages, _fallback);
  return _lang;
}

export async function setLang(code) {
  if (!SUPPORTED.includes(code)) code = FALLBACK;
  if (!Object.keys(_fallback).length) _fallback = await fetchCatalog(FALLBACK);
  _messages = code === FALLBACK ? _fallback : await fetchCatalog(code);
  _lang = code;
  _t = makeT(_messages, _fallback);
  await chrome.storage.local.set({ lang: code });
  return code;
}

export const t = (key, params) => _t(key, params);
export const getLang = () => _lang;
export const isRTL = () => RTL.has(_lang);
export const dir = () => (isRTL() ? 'rtl' : 'ltr');

// Apply translations to static markup:
//   data-i18n="key"                      -> textContent
//   data-i18n-attr="placeholder:key;..." -> attributes
export function applyStaticI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const [attr, key] = pair.split(':').map((x) => x && x.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    });
  });
}

// Set <html lang/dir> on a document.
export function applyDir(doc = document) {
  try {
    doc.documentElement.lang = _lang;
    doc.documentElement.dir = dir();
  } catch (_) {}
}
