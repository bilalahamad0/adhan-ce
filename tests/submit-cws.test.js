// Chrome Web Store API v2 client in scripts/submit-cws.mjs, exercised against a
// fake fetch. Guards the v1.1 → v2 migration (v1.1 is unsupported after
// 2026-10-15): endpoint shapes, the renamed upload states, async-upload polling
// and the publish-refused-but-uploaded fallback.
import {
  API_ROOT,
  DEFAULT_PUBLISHER_ID,
  CwsError,
  compareVersions,
  itemName,
  preflight,
  publishItem,
  resolvePublisherId,
  uploadCrx,
  verifySubmission,
} from '../scripts/submit-cws.mjs';

const EXT = 'jfjknglldcdminelckmmfdbnlikiogia';
const NAME = itemName(DEFAULT_PUBLISHER_ID, EXT);
const TOKEN = 'test-token';
const crx = { buf: Buffer.from('Cr24fake-crx-bytes'), size: 18 };

const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
});

let calls;
let origFetch;
let origWarn;
let origLog;
let warnings;

// Each queued responder answers one fetch call, in order.
function fakeFetch(...responders) {
  global.fetch = async (url, init = {}) => {
    calls.push({ url, ...init });
    const next = responders.shift();
    if (!next) throw new Error(`unexpected fetch: ${init.method || 'GET'} ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
}

beforeEach(() => {
  calls = [];
  warnings = [];
  origFetch = global.fetch;
  origWarn = console.warn;
  origLog = console.log;
  console.warn = (m) => warnings.push(String(m));
  console.log = () => {};
});

afterEach(() => {
  global.fetch = origFetch;
  console.warn = origWarn;
  console.log = origLog;
});

describe('config helpers', () => {
  it('defaults the publisher ID and accepts an override', () => {
    expect(resolvePublisherId(undefined)).toBe(DEFAULT_PUBLISHER_ID);
    expect(resolvePublisherId('   ')).toBe(DEFAULT_PUBLISHER_ID);
    expect(resolvePublisherId(' abc-123 ')).toBe('abc-123');
  });

  it('rejects a publisher ID that would break the URL path', () => {
    for (const bad of ['a/b', 'a?b', 'a#b', 'a%2Fb', 'a b']) {
      expect(() => resolvePublisherId(bad)).toThrow(CwsError);
    }
  });

  it('builds the v2 item resource name', () => {
    expect(NAME).toBe(`publishers/${DEFAULT_PUBLISHER_ID}/items/${EXT}`);
  });

  it('compares dotted versions numerically', () => {
    expect(compareVersions('2.1.1', '2.1.0')).toBe(1);
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
    expect(compareVersions('2.0.9', '2.1')).toBe(-1);
  });
});

describe('preflight (fetchStatus)', () => {
  const published = (v) => ({ name: NAME, publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ deployPercentage: 100, crxVersion: v }] } });

  it('GETs the v2 fetchStatus endpoint with the bearer token', async () => {
    fakeFetch(reply(200, published('2.1.0')));
    const out = await preflight({ token: TOKEN, name: NAME, version: '2.1.1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${API_ROOT}/v2/${NAME}:fetchStatus`);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(out.publishedVersions).toEqual(['2.1.0']);
  });

  it('tolerates an item with no revisions yet', async () => {
    fakeFetch(reply(200, {}));
    await expect(preflight({ token: TOKEN, name: NAME, version: '2.1.1' })).resolves.toEqual({ publishedVersions: [], submittedState: null });
  });

  it('stops before uploading on a wrong publisher ID (403) and points at CWS_PUBLISHER_ID', async () => {
    fakeFetch(reply(403, { error: { code: 403, status: 'PERMISSION_DENIED', message: "Permission denied on resource (or it might not exist)" } }));
    await expect(preflight({ token: TOKEN, name: NAME, version: '2.1.1' })).rejects.toThrow(/PERMISSION_DENIED[\s\S]*CWS_PUBLISHER_ID[\s\S]*Nothing was uploaded/);
  });

  it('refuses to touch an item whose previous submission is still in review', async () => {
    fakeFetch(reply(200, { ...published('2.1.0'), submittedItemRevisionStatus: { state: 'PENDING_REVIEW' } }));
    await expect(preflight({ token: TOKEN, name: NAME, version: '2.1.1' })).rejects.toThrow(/still in review/);
  });

  it('refuses when the manifest version is not above the published one', async () => {
    fakeFetch(reply(200, published('2.1.1')));
    await expect(preflight({ token: TOKEN, name: NAME, version: '2.1.1' })).rejects.toThrow(/not above the published version 2\.1\.1/);
  });

  it('refuses a taken-down item and warns on a policy warning', async () => {
    fakeFetch(reply(200, { name: NAME, takenDown: true }));
    await expect(preflight({ token: TOKEN, name: NAME, version: '2.1.1' })).rejects.toThrow(/taken down/);
    fakeFetch(reply(200, { name: NAME, warned: true }));
    await preflight({ token: TOKEN, name: NAME, version: '2.1.1' });
    expect(warnings.join('\n')).toMatch(/policy warning/);
  });

  it('rejects a response for a different item', async () => {
    fakeFetch(reply(200, { name: 'publishers/other/items/x' }));
    await expect(preflight({ token: TOKEN, name: NAME, version: '2.1.1' })).rejects.toThrow(/expected publishers\//);
  });
});

describe('uploadCrx', () => {
  const fast = { pollIntervalMs: 1, pollTimeoutMs: 200 };

  it('POSTs the raw CRX to the v2 media upload URL with the verified-CRX headers', async () => {
    fakeFetch(reply(200, { name: NAME, itemId: EXT, uploadState: 'SUCCEEDED', crxVersion: '2.1.1' }));
    const out = await uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1' });
    expect(out).toEqual({ uploadState: 'SUCCEEDED', crxVersion: '2.1.1' });
    const [c] = calls;
    expect(c.url).toBe(`${API_ROOT}/upload/v2/${NAME}:upload`);
    expect(c.method).toBe('POST');
    expect(c.body).toBe(crx.buf);
    expect(c.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-File-Name': 'adhan-focus.crx',
    });
  });

  it('fails on the v2 FAILED state (v1.1 called it FAILURE)', async () => {
    fakeFetch(reply(200, { uploadState: 'FAILED' }));
    await expect(uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1' })).rejects.toThrow(/state FAILED/);
  });

  it('fails on a missing or unknown upload state instead of publishing', async () => {
    fakeFetch(reply(200, {}));
    await expect(uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1' })).rejects.toThrow(/state missing/);
    fakeFetch(reply(200, { uploadState: 'SUCCESS' }));
    await expect(uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1' })).rejects.toThrow(/state SUCCESS/);
  });

  it('fails when the uploaded package version differs from manifest.json', async () => {
    fakeFetch(reply(200, { uploadState: 'SUCCEEDED', crxVersion: '2.1.0' }));
    await expect(uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1' })).rejects.toThrow(/reports version 2\.1\.0/);
  });

  it('surfaces a JSON error envelope and a plain-text front-end error', async () => {
    fakeFetch(reply(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Bad package' } }));
    await expect(uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1' })).rejects.toThrow(/HTTP 400 INVALID_ARGUMENT: Bad package/);
    fakeFetch(reply(404, 'Could not find handler for this request.'));
    await expect(uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1' })).rejects.toThrow(/HTTP 404: Could not find handler/);
  });

  it('polls fetchStatus after IN_PROGRESS until the upload succeeds, riding out a 503', async () => {
    fakeFetch(
      reply(200, { uploadState: 'IN_PROGRESS' }),
      reply(200, { lastAsyncUploadState: 'IN_PROGRESS' }),
      reply(503, 'unavailable'),
      reply(200, { lastAsyncUploadState: 'SUCCEEDED' })
    );
    const out = await uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1', ...fast });
    expect(out.uploadState).toBe('SUCCEEDED');
    expect(calls.slice(1).every((c) => c.url === `${API_ROOT}/v2/${NAME}:fetchStatus`)).toBe(true);
  });

  it('accepts the UPLOAD_IN_PROGRESS spelling from the docs and fails if processing fails', async () => {
    fakeFetch(reply(200, { uploadState: 'UPLOAD_IN_PROGRESS' }), reply(200, { lastAsyncUploadState: 'FAILED' }));
    await expect(uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1', ...fast })).rejects.toThrow(/ended with state FAILED/);
  });

  it('gives up after the poll deadline without submitting', async () => {
    fakeFetch(reply(200, { uploadState: 'IN_PROGRESS' }), ...Array.from({ length: 500 }, () => reply(200, { lastAsyncUploadState: 'IN_PROGRESS' })));
    await expect(uploadCrx({ token: TOKEN, name: NAME, crx, version: '2.1.1', pollIntervalMs: 5, pollTimeoutMs: 30 })).rejects.toThrow(/still processing/);
  });
});

describe('publishItem', () => {
  it('POSTs DEFAULT_PUBLISH as JSON to the v2 publish endpoint', async () => {
    fakeFetch(reply(200, { name: NAME, itemId: EXT, state: 'PENDING_REVIEW' }));
    const out = await publishItem({ token: TOKEN, name: NAME });
    expect(out.state).toBe('PENDING_REVIEW');
    const [c] = calls;
    expect(c.url).toBe(`${API_ROOT}/v2/${NAME}:publish`);
    expect(c.method).toBe('POST');
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(c.body)).toEqual({ publishType: 'DEFAULT_PUBLISH' });
  });

  it('leaves the upload as a draft with a warning when the store refuses the submission (400)', async () => {
    fakeFetch(reply(400, { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'Publish condition not met: mandatory privacy information' } }));
    const out = await publishItem({ token: TOKEN, name: NAME });
    expect(out.state).toBe('UPLOADED_AS_DRAFT');
    expect(warnings.join('\n')).toMatch(/::warning::Publish notice[\s\S]*Privacy practices/);
  });

  it('fails on other HTTP errors and on a REJECTED state', async () => {
    fakeFetch(reply(500, 'backend error'));
    await expect(publishItem({ token: TOKEN, name: NAME })).rejects.toThrow(/Publish failed \(HTTP 500/);
    fakeFetch(reply(200, { state: 'REJECTED' }));
    await expect(publishItem({ token: TOKEN, name: NAME })).rejects.toThrow(/state REJECTED/);
  });

  it('logs non-blocking store warnings', async () => {
    fakeFetch(reply(200, { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'BROAD_HOST_PERMISSIONS', description: 'In-depth review' }] } }));
    await publishItem({ token: TOKEN, name: NAME });
    expect(warnings.join('\n')).toMatch(/BROAD_HOST_PERMISSIONS — In-depth review/);
  });
});

describe('verifySubmission', () => {
  it('warns, without throwing, when the revision in review has another version', async () => {
    fakeFetch(reply(200, { submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '2.1.0' }] } }));
    await verifySubmission({ token: TOKEN, name: NAME, version: '2.1.1' });
    expect(warnings.join('\n')).toMatch(/reports version 2\.1\.0, not 2\.1\.1/);
  });

  it('stays quiet when the versions match and never throws on network errors', async () => {
    fakeFetch(reply(200, { submittedItemRevisionStatus: { distributionChannels: [{ crxVersion: '2.1.1' }] } }));
    await verifySubmission({ token: TOKEN, name: NAME, version: '2.1.1' });
    expect(warnings).toEqual([]);
    fakeFetch(() => {
      throw new Error('socket hang up');
    });
    await expect(verifySubmission({ token: TOKEN, name: NAME, version: '2.1.1' })).resolves.toBeUndefined();
    expect(warnings.join('\n')).toMatch(/Could not confirm the submission: socket hang up/);
  });
});
