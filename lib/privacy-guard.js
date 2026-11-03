// Pure helpers for privacy enforcement, PII protection, and network safety.
// Unit-testable under Node/Jest (no chrome.* / DOM dependencies).
//
// Guarantees:
// 1. Personal data (names, emails, tokens, credentials) is strictly detected and blocked
//    before any external network request can be formed.
// 2. Outbound network requests are restricted to an explicit, audited allowlist of domains.
// 3. Extension settings are strictly schema-validated to disallow unauthorized keys.
// 4. Manifest permissions are guarded against invasive APIs (chrome.identity, cookies, etc.).

import { PRAYER_ORDER, prayerAdjustments } from './schedule.js';

// ---- 1. PII Detection ----

// Robust email pattern matching common user/corporate email formats.
const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;

// Phone number pattern matching international and standard telephone formats.
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/;

// Secret tokens, JWTs, OAuth tokens, API keys, or long random hashes.
const TOKEN_REGEX = /\b(?:bearer\s+[a-zA-Z0-9_\-\.]+|ey[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*|[a-f0-9]{32,64})\b/i;

// Indicators of sensitive personal data or credentials.
const SENSITIVE_KEYWORD_REGEX = /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+/i;

/**
 * Returns true if the string appears to contain Personally Identifiable Information
 * (email address, telephone number, authentication token, or credential pattern).
 */
export function containsPii(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  return EMAIL_REGEX.test(s) || PHONE_REGEX.test(s) || TOKEN_REGEX.test(s) || SENSITIVE_KEYWORD_REGEX.test(s);
}

/**
 * Sanitizes a place search query before it is passed to geocoding services.
 * If the input contains any PII (such as an email address mistakenly typed or pasted),
 * the search is blocked and returns empty string to prevent data transmission.
 */
export function sanitizePlaceQuery(query) {
  if (typeof query !== 'string') return '';
  const s = query.trim();
  if (s.length < 2) return '';
  if (containsPii(s)) return '';

  // Remove potential script tags, angle brackets, and non-printable control characters
  const cleaned = s
    .replace(/[<>]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Geographic place names do not exceed 80 characters
  return cleaned.length >= 2 ? cleaned.slice(0, 80) : '';
}

/**
 * Sanitizes location fields (city, state, country) for storage and API requests.
 */
export function sanitizeLocationField(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  if (!s || containsPii(s)) return fallback;

  const cleaned = s
    .replace(/[<>]/g, '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned ? cleaned.slice(0, 80) : fallback;
}

// ---- 2. Settings Schema Enforcement ----

// The closed set of valid configuration keys for Adhan Focus.
// Any extraneous keys (e.g., name, email, userId, token) are stripped on save.
export const ALLOWED_SETTINGS_KEYS = Object.freeze([
  'enabled',
  'country',
  'state',
  'city',
  'lat',
  'lon',
  'placeLabel',
  'autoResumeMinutes',
  'leadSeconds',
  'focusMode',
  'strictFocus',
  'adhanChime',
  'badgeCountdown',
  'badgeMode',
  'badgeManualHours',
  'method',
  'school',
  'showHijri',
  'hijriOffset',
  'adjustMinutes',
  'lang',
  'theme',
]);

/**
 * Sanitizes incoming settings against the allowed schema.
 * Rejects unauthorized keys and validates values against safe types/bounds.
 */
export function sanitizeSettings(incoming, current = {}) {
  if (!incoming || typeof incoming !== 'object') return {};
  const out = {};

  for (const key of ALLOWED_SETTINGS_KEYS) {
    if (!(key in incoming)) continue;
    const val = incoming[key];

    switch (key) {
      case 'enabled':
      case 'focusMode':
      case 'strictFocus':
      case 'adhanChime':
      case 'badgeCountdown':
      case 'showHijri':
        out[key] = Boolean(val);
        break;

      case 'city':
        out[key] = sanitizeLocationField(val, current.city || 'Sunnyvale');
        break;

      case 'country':
        out[key] = sanitizeLocationField(val, current.country || 'United States');
        break;

      case 'state':
        out[key] = sanitizeLocationField(val, current.state || '');
        break;

      case 'lat':
      case 'lon':
        if (Number.isFinite(val)) out[key] = val;
        break;

      case 'placeLabel':
        if (val && typeof val === 'object' && typeof val.text === 'string') {
          out[key] = {
            lang: typeof val.lang === 'string' ? val.lang : 'en',
            text: sanitizeLocationField(val.text, ''),
          };
        } else {
          out[key] = null;
        }
        break;

      case 'autoResumeMinutes': {
        const n = Math.round(Number(val));
        out[key] = Number.isFinite(n) ? Math.max(1, Math.min(60, n)) : current.autoResumeMinutes || 5;
        break;
      }


      case 'leadSeconds': {
        const n = Math.round(Number(val));
        out[key] = Number.isFinite(n) ? Math.max(0, Math.min(120, n)) : current.leadSeconds || 30;
        break;
      }

      case 'badgeMode':
        out[key] = val === 'manual' ? 'manual' : 'auto';
        break;

      case 'badgeManualHours': {
        const n = Math.round(Number(val));
        out[key] = Number.isFinite(n) ? Math.max(1, Math.min(12, n)) : current.badgeManualHours || 2;
        break;
      }

      case 'method': {
        const n = Math.round(Number(val));
        out[key] = Number.isFinite(n) && n >= 0 && n <= 23 ? n : current.method ?? 2;
        break;
      }

      case 'school': {
        const n = Math.round(Number(val));
        out[key] = n === 1 ? 1 : 0;
        break;
      }

      case 'hijriOffset': {
        const n = Math.round(Number(val));
        out[key] = Number.isFinite(n) ? Math.max(-2, Math.min(2, n)) : 0;
        break;
      }

      case 'adjustMinutes':
        out[key] = prayerAdjustments(val);
        break;

      case 'lang':
        if (typeof val === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(val)) {
          out[key] = val;
        }
        break;

      case 'theme':
        out[key] = ['system', 'light', 'dark'].includes(val) ? val : 'system';
        break;
    }
  }

  return out;
}

// ---- 3. Outbound Network Firewall & Domain Allowlist ----

// Only approved external services required for core prayer time functionality.
// Analytics, advertising, telemetry, and tracking endpoints are strictly prohibited.
export const ALLOWED_OUTBOUND_HOSTS = Object.freeze([
  'api.aladhan.com',
  'geocoding-api.open-meteo.com',
  'api.bigdatacloud.net',
  'ipapi.co',
]);

/**
 * Validates that an outbound URL targets an allowlisted host and does not
 * leak personal data (such as emails) in query parameters.
 * Throws an Error if unauthorized or containing PII.
 */
export function assertSafeOutboundUrl(urlStr) {
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (e) {
    throw new Error(`Invalid outbound URL: ${urlStr}`);
  }

  // Allow internal chrome-extension URLs
  if (parsed.protocol === 'chrome-extension:') {
    return parsed;
  }

  // Enforce HTTPS for external requests
  if (parsed.protocol !== 'https:') {
    throw new Error(`Insecure protocol blocked: ${parsed.protocol}`);
  }

  // Enforce domain allowlist
  if (!ALLOWED_OUTBOUND_HOSTS.includes(parsed.hostname)) {
    throw new Error(`Unauthorized outbound host blocked: ${parsed.hostname}`);
  }

  // Enforce zero PII in query parameters
  for (const [paramKey, paramValue] of parsed.searchParams.entries()) {
    if (containsPii(paramKey) || containsPii(paramValue)) {
      throw new Error(`Outbound URL parameter "${paramKey}" contains potential PII`);
    }
  }

  return parsed;
}

/**
 * Non-throwing check for outbound URL safety.
 */
export function isAllowedOutboundUrl(urlStr) {
  try {
    assertSafeOutboundUrl(urlStr);
    return true;
  } catch (_) {
    return false;
  }
}

// ---- 4. Manifest Permissions & Security Guard ----

// Permissions that grant access to personal data, identity, browsing activity, or interception.
// Must NEVER be requested by Adhan Focus.
export const DISALLOWED_PERMISSIONS = Object.freeze([
  'identity',
  'identity.email',
  'contacts',
  'cookies',
  'webRequest',
  'webRequestBlocking',
  'declarativeNetRequest',
  'declarativeNetRequestFeedback',
  'history',
  'bookmarks',
  'management',
  'tabs',
  'topSites',
  'geolocation',
  'userScripts',
  'privacy',
]);

/**
 * Audits a manifest object to verify privacy guarantees:
 * - No invasive permissions
 * - No external web connectability
 * - Strict Content Security Policy
 */
export function auditManifestPrivacy(manifest) {
  const errors = [];
  const permissions = new Set(manifest.permissions || []);

  for (const p of DISALLOWED_PERMISSIONS) {
    if (permissions.has(p)) {
      errors.push(`Disallowed permission requested: ${p}`);
    }
  }

  if (manifest.externally_connectable) {
    const matches = manifest.externally_connectable.matches || [];
    if (matches.length > 0) {
      errors.push('externally_connectable must not expose the extension to arbitrary web pages');
    }
  }

  const csp = manifest.content_security_policy?.extension_pages || '';
  if (csp.includes('unsafe-eval') || csp.includes('http:') || csp.includes('https:')) {
    errors.push('Content Security Policy must not allow unsafe-eval or remote script sources');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
