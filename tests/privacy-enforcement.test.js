import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  containsPii,
  sanitizePlaceQuery,
  sanitizeLocationField,
  ALLOWED_SETTINGS_KEYS,
  sanitizeSettings,
  ALLOWED_OUTBOUND_HOSTS,
  assertSafeOutboundUrl,
  isAllowedOutboundUrl,
  DISALLOWED_PERMISSIONS,
  auditManifestPrivacy,
} from '../lib/privacy-guard.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

describe('PII Detection & Sanitization', () => {
  it('detects email addresses', () => {
    expect(containsPii('user@example.com')).toBe(true);
    expect(containsPii('john.doe+filter@sub.domain.co.uk')).toBe(true);
    expect(containsPii('Please contact me at test@company.org')).toBe(true);
    expect(containsPii('mailto:admin@adhanfocus.com')).toBe(true);
    expect(containsPii('Sunnyvale')).toBe(false);
    expect(containsPii('New York, NY')).toBe(false);
  });

  it('detects telephone numbers', () => {
    expect(containsPii('+1 555-123-4567')).toBe(true);
    expect(containsPii('(555) 123-4567')).toBe(true);
    expect(containsPii('555.123.4567')).toBe(true);
    expect(containsPii('Paris 75001')).toBe(false); // Postal code is not a phone number
  });

  it('detects authentication tokens and credential strings', () => {
    expect(containsPii('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcBQWP')).toBe(true);
    expect(containsPii('password: MySecretPassword123!')).toBe(true);
    expect(containsPii('api_key=ab12cd34ef56ab12cd34ef56ab12cd34')).toBe(true);
    expect(containsPii('4b8259d69188404a9d70be0b2016622b')).toBe(true); // 32-hex token
  });

  it('handles edge cases in containsPii', () => {
    expect(containsPii(null)).toBe(false);
    expect(containsPii(undefined)).toBe(false);
    expect(containsPii('')).toBe(false);
    expect(containsPii('   ')).toBe(false);
    expect(containsPii(12345)).toBe(false);
  });

  it('sanitizePlaceQuery blocks queries containing PII', () => {
    expect(sanitizePlaceQuery('john.doe@gmail.com')).toBe('');
    expect(sanitizePlaceQuery('London user@example.com')).toBe('');
    expect(sanitizePlaceQuery('Bearer 123456789012345678901234')).toBe('');
    expect(sanitizePlaceQuery('San Francisco +1 555-123-4567')).toBe('');
  });

  it('sanitizePlaceQuery cleans and passes valid place names', () => {
    expect(sanitizePlaceQuery('London')).toBe('London');
    expect(sanitizePlaceQuery('  New York, NY  ')).toBe('New York, NY');
    expect(sanitizePlaceQuery('Makkah <script>')).toBe('Makkah script');
    expect(sanitizePlaceQuery('São Paulo')).toBe('São Paulo');
    expect(sanitizePlaceQuery('El-Aaiún')).toBe('El-Aaiún');
  });

  it('sanitizePlaceQuery rejects short or invalid inputs', () => {
    expect(sanitizePlaceQuery('')).toBe('');
    expect(sanitizePlaceQuery('a')).toBe('');
    expect(sanitizePlaceQuery(null)).toBe('');
    expect(sanitizePlaceQuery(undefined)).toBe('');
  });

  it('sanitizeLocationField protects stored location values', () => {
    expect(sanitizeLocationField('Sunnyvale')).toBe('Sunnyvale');
    expect(sanitizeLocationField('user@domain.com', 'FallbackCity')).toBe('FallbackCity');
    expect(sanitizeLocationField('<script>Alert</script>', 'FallbackCity')).toBe('scriptAlert/script');
    expect(sanitizeLocationField(null, 'FallbackCity')).toBe('FallbackCity');
    expect(sanitizeLocationField('', 'FallbackCity')).toBe('FallbackCity');
  });
});

describe('Settings Schema & PII Enforcement', () => {
  it('strictly strips unauthorized keys from incoming settings', () => {
    const malicious = {
      enabled: true,
      city: 'Cairo',
      name: 'John Doe',
      email: 'john@example.com',
      authToken: 'secret_token_123',
      clientId: 'ga4_client_uuid',
      analyticsId: 'G-123456',
      userProfile: { id: 1 },
    };

    const sanitized = sanitizeSettings(malicious);
    expect(sanitized.enabled).toBe(true);
    expect(sanitized.city).toBe('Cairo');
    expect(sanitized).not.toHaveProperty('name');
    expect(sanitized).not.toHaveProperty('email');
    expect(sanitized).not.toHaveProperty('authToken');
    expect(sanitized).not.toHaveProperty('clientId');
    expect(sanitized).not.toHaveProperty('analyticsId');
    expect(sanitized).not.toHaveProperty('userProfile');
  });

  it('drops PII in city, state, or country and uses fallback', () => {
    const current = { city: 'Sunnyvale', country: 'United States', state: 'California' };
    const incoming = {
      city: 'leaked@email.com',
      state: 'phone:+1 555-123-4567',
      country: 'Valid Country',
    };

    const sanitized = sanitizeSettings(incoming, current);
    expect(sanitized.city).toBe('Sunnyvale'); // Fell back to current.city
    expect(sanitized.state).toBe('California'); // Fell back to current.state
    expect(sanitized.country).toBe('Valid Country');
  });

  it('validates types and bounds for numeric settings', () => {
    const sanitized = sanitizeSettings({
      autoResumeMinutes: 999, // Should be clamped to 60
      leadSeconds: -10, // Should be clamped to 0
      method: 99, // Invalid method id, should fallback
      school: 5, // Invalid school, should be 0
      hijriOffset: 10, // Should be clamped to 2
      badgeMode: 'invalid', // Should be 'auto'
      theme: 'hacker', // Should be 'system'
    });

    expect(sanitized.autoResumeMinutes).toBe(60);
    expect(sanitized.leadSeconds).toBe(0);
    expect(sanitized.method).toBe(2);
    expect(sanitized.school).toBe(0);
    expect(sanitized.hijriOffset).toBe(2);
    expect(sanitized.badgeMode).toBe('auto');
    expect(sanitized.theme).toBe('system');

    const withLang = sanitizeSettings({ lang: 'ar' });
    expect(withLang.lang).toBe('ar');
    const withBadLang = sanitizeSettings({ lang: 'not-a-lang-code' });
    expect(withBadLang).not.toHaveProperty('lang');
  });

  it('handles invalid or empty settings objects gracefully', () => {
    expect(sanitizeSettings(null)).toEqual({});
    expect(sanitizeSettings(undefined)).toEqual({});
    expect(sanitizeSettings('string')).toEqual({});
  });
});

describe('Network Firewall & URL Allowlist', () => {
  it('allows all approved outbound APIs and rejects unapproved ones', () => {
    expect(isAllowedOutboundUrl('https://api.aladhan.com/v1/timingsByCity/17-10-2026?city=Sunnyvale&country=United%20States')).toBe(true);
    expect(isAllowedOutboundUrl('https://geocoding-api.open-meteo.com/v1/search?name=Sunnyvale&count=8&language=en&format=json')).toBe(true);
    expect(isAllowedOutboundUrl('https://api.bigdatacloud.net/data/reverse-geocode-client')).toBe(true);
    expect(isAllowedOutboundUrl('https://ipapi.co/json/')).toBe(true);
    expect(isAllowedOutboundUrl('chrome-extension://abc/locales/en.json')).toBe(true);
    expect(isAllowedOutboundUrl('https://www.google-analytics.com/mp/collect')).toBe(false);
    expect(isAllowedOutboundUrl('http://insecure-domain.org')).toBe(false);
  });


  it('blocks Google Analytics, telemetry, and tracking hosts', () => {
    expect(() => assertSafeOutboundUrl('https://www.google-analytics.com/mp/collect?measurement_id=G-123')).toThrow(
      /Unauthorized outbound host blocked/
    );
    expect(() => assertSafeOutboundUrl('https://analytics.google.com/g/collect')).toThrow(
      /Unauthorized outbound host blocked/
    );
    expect(() => assertSafeOutboundUrl('https://www.googletagmanager.com/gtag/js?id=G-123')).toThrow(
      /Unauthorized outbound host blocked/
    );
    expect(() => assertSafeOutboundUrl('https://stats.g.doubleclick.net/r/collect')).toThrow(
      /Unauthorized outbound host blocked/
    );
    expect(() => assertSafeOutboundUrl('https://api.mixpanel.com/track')).toThrow(
      /Unauthorized outbound host blocked/
    );
  });

  it('blocks insecure HTTP protocol for external requests', () => {
    expect(() => assertSafeOutboundUrl('http://api.aladhan.com/v1/timings')).toThrow(
      /Insecure protocol blocked/
    );
  });

  it('blocks outbound requests containing PII in query parameters', () => {
    expect(() =>
      assertSafeOutboundUrl('https://api.aladhan.com/v1/timingsByCity?city=user%40example.com&country=US')
    ).toThrow(/contains potential PII/);

    expect(() =>
      assertSafeOutboundUrl('https://geocoding-api.open-meteo.com/v1/search?name=test%40gmail.com&count=8')
    ).toThrow(/contains potential PII/);
  });

  it('throws on invalid or malformed URLs', () => {
    expect(() => assertSafeOutboundUrl('not-a-valid-url')).toThrow(/Invalid outbound URL/);
  });
});

describe('Manifest Privacy & Permission Audit', () => {
  it('shipped manifest requests zero identity or tracking permissions', () => {
    const audit = auditManifestPrivacy(manifest);
    expect(audit.valid).toBe(true);
    expect(audit.errors).toEqual([]);

    for (const p of DISALLOWED_PERMISSIONS) {
      expect(manifest.permissions).not.toContain(p);
    }
  });

  it('auditManifestPrivacy flags prohibited permissions when injected', () => {
    const badManifest = {
      permissions: ['storage', 'identity', 'cookies', 'webRequest'],
    };
    const audit = auditManifestPrivacy(badManifest);
    expect(audit.valid).toBe(false);
    expect(audit.errors.some((e) => e.includes('identity'))).toBe(true);
    expect(audit.errors.some((e) => e.includes('cookies'))).toBe(true);
    expect(audit.errors.some((e) => e.includes('webRequest'))).toBe(true);
  });

  it('auditManifestPrivacy flags external web connectability', () => {
    const connectableManifest = {
      permissions: ['storage'],
      externally_connectable: {
        matches: ['https://*/*'],
      },
    };
    const audit = auditManifestPrivacy(connectableManifest);
    expect(audit.valid).toBe(false);
    expect(audit.errors.some((e) => e.includes('externally_connectable'))).toBe(true);
  });

  it('auditManifestPrivacy flags loose CSP', () => {
    const looseCspManifest = {
      permissions: ['storage'],
      content_security_policy: {
        extension_pages: "script-src 'self' 'unsafe-eval' https://apis.google.com;",
      },
    };
    const audit = auditManifestPrivacy(looseCspManifest);
    expect(audit.valid).toBe(false);
    expect(audit.errors.some((e) => e.includes('Content Security Policy'))).toBe(true);
  });
});

describe('Static Codebase Audit (Zero Tracker & Data Leak Protection)', () => {
  const runtimeFiles = [
    'background.js',
    'content.js',
    'popup.js',
    'welcome.js',
    'offscreen.js',
    'lib/schedule.js',
    'lib/tracker.js',
    'lib/usage.js',
    'lib/geocode.js',
    'lib/privacy-guard.js',
    'lib/i18n.js',
    'lib/audio.js',
    'lib/buildinfo.js',
  ];

  it('no runtime file references chrome.identity or OAuth token methods in active code', () => {
    for (const file of runtimeFiles) {
      const raw = readFileSync(join(ROOT, file), 'utf8');
      // Strip single-line and block comments to check active code
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
      expect(code).not.toMatch(/chrome\s*\.\s*identity/);
      expect(code).not.toMatch(/getAuthToken/);
      expect(code).not.toMatch(/getProfileUserInfo/);
    }
  });

  it('no runtime file references third-party analytics or tracking endpoints', () => {
    for (const file of runtimeFiles) {
      const raw = readFileSync(join(ROOT, file), 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
      expect(code).not.toMatch(/google-analytics\.com/);
      expect(code).not.toMatch(/analytics\.google\.com/);
      expect(code).not.toMatch(/googletagmanager\.com/);
      expect(code).not.toMatch(/doubleclick\.net/);
      expect(code).not.toMatch(/mixpanel\.com/);
      expect(code).not.toMatch(/segment\.io/);
    }
  });

  it('content.js isolates itself and accesses zero sensitive DOM or browsing data', () => {
    const contentJs = readFileSync(join(ROOT, 'content.js'), 'utf8');

    // Never access cookies or web storage of host sites
    expect(contentJs).not.toMatch(/document\.cookie/);
    expect(contentJs).not.toMatch(/window\.localStorage/);
    expect(contentJs).not.toMatch(/window\.sessionStorage/);

    // Never read form inputs or passwords
    expect(contentJs).not.toMatch(/input\[type=password\]/);
    expect(contentJs).not.toMatch(/document\.forms/);

    // Uses Shadow DOM for overlay isolation from page styles
    expect(contentJs).toMatch(/attachShadow/);

    // Never broadcasts data externally via postMessage
    expect(contentJs).not.toMatch(/window\.postMessage/);
  });


  it('workflow files do not leak personal Gmail addresses', () => {
    const workflowsDir = join(ROOT, '.github', 'workflows');
    const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

    for (const file of files) {
      const content = readFileSync(join(workflowsDir, file), 'utf8');
      expect(content).not.toMatch(/@gmail\.com/);
    }
  });
});
