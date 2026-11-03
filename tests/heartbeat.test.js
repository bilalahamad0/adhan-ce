import { jest } from '@jest/globals';
import {
  refreshAccessToken,
  queryItemStatus,
  runHeartbeat,
  parseCliArgs,
  withRetry,
  DEFAULT_EXTENSION_ID,
  TOKEN_URL,
  CWS_ITEM_URL,
} from '../scripts/heartbeat-cws.mjs';

describe('heartbeat-cws script', () => {
  const dummyCreds = {
    clientId: 'test-client-id.apps.googleusercontent.com',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
  };

  describe('parseCliArgs', () => {
    it('parses defaults when no args passed', () => {
      const res = parseCliArgs([]);
      expect(res.dryRun).toBe(false);
      expect(res.mode).toBe(null);
    });

    it('parses --dry-run and mode flags', () => {
      expect(parseCliArgs(['--dry-run', '--primary'])).toEqual({
        dryRun: true,
        mode: 'primary',
      });
      expect(parseCliArgs(['--fallback'])).toEqual({
        dryRun: false,
        mode: 'fallback',
      });
      expect(parseCliArgs(['--mode=fallback'])).toEqual({
        dryRun: false,
        mode: 'fallback',
      });
      expect(parseCliArgs(['--mode', 'manual'])).toEqual({
        dryRun: false,
        mode: 'manual',
      });
    });
  });

  describe('withRetry', () => {
    it('resolves immediately when first attempt succeeds', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const res = await withRetry(fn);
      expect(res).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and resolves when subsequent attempt succeeds', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce(new Error('transient failure'))
        .mockResolvedValueOnce('recovered');

      const warnings = [];
      const res = await withRetry(fn, {
        maxRetries: 2,
        delayMs: 1,
        warn: (w) => warnings.push(w),
      });

      expect(res).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain('transient failure');
    });

    it('throws error when all retry attempts fail', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('persistent failure'));
      await expect(
        withRetry(fn, { maxRetries: 2, delayMs: 1, warn: () => {} })
      ).rejects.toThrow('persistent failure');
      expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });
  });

  describe('refreshAccessToken', () => {
    it('successfully refreshes access token', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'mock-access-token-123',
          expires_in: 3599,
          token_type: 'Bearer',
        }),
      });

      const res = await refreshAccessToken({
        ...dummyCreds,
        fetchFn: mockFetch,
      });

      expect(res.accessToken).toBe('mock-access-token-123');
      expect(res.expiresIn).toBe(3599);
      expect(mockFetch).toHaveBeenCalledWith(
        TOKEN_URL,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })
      );

      const callBody = mockFetch.mock.calls[0][1].body;
      expect(callBody.get('client_id')).toBe(dummyCreds.clientId);
      expect(callBody.get('client_secret')).toBe(dummyCreds.clientSecret);
      expect(callBody.get('refresh_token')).toBe(dummyCreds.refreshToken);
      expect(callBody.get('grant_type')).toBe('refresh_token');
    });

    it('throws when OAuth endpoint returns an error status', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }),
      });

      await expect(
        refreshAccessToken({
          ...dummyCreds,
          fetchFn: mockFetch,
        })
      ).rejects.toThrow(/OAuth token refresh failed \(HTTP 400\): invalid_grant Token has been expired or revoked\./);
    });
  });

  describe('queryItemStatus', () => {
    it('queries CWS API with bearer token and x-goog-api-version', async () => {
      const mockFetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          id: DEFAULT_EXTENSION_ID,
          crxVersion: '2.0.0',
          uploadState: 'SUCCESS',
        }),
      });

      const result = await queryItemStatus({
        token: 'mock-token',
        extId: DEFAULT_EXTENSION_ID,
        fetchFn: mockFetch,
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.data.id).toBe(DEFAULT_EXTENSION_ID);
      expect(mockFetch).toHaveBeenCalledWith(
        `${CWS_ITEM_URL}/${DEFAULT_EXTENSION_ID}?projection=draft`,
        expect.objectContaining({
          method: 'GET',
          headers: {
            Authorization: 'Bearer mock-token',
            'x-goog-api-version': '2',
          },
        })
      );
    });
  });

  describe('runHeartbeat', () => {
    it('handles dry-run with primary and fallback mode without network calls', async () => {
      const mockFetch = jest.fn();
      const logs = [];

      const resultPrimary = await runHeartbeat({
        mode: 'primary',
        dryRun: true,
        fetchFn: mockFetch,
        log: (msg) => logs.push(msg),
      });

      expect(resultPrimary.dryRun).toBe(true);
      expect(resultPrimary.mode).toBe('primary');

      const resultFallback = await runHeartbeat({
        mode: 'fallback',
        dryRun: true,
        fetchFn: mockFetch,
        log: (msg) => logs.push(msg),
      });

      expect(resultFallback.dryRun).toBe(true);
      expect(resultFallback.mode).toBe('fallback');
      expect(mockFetch).not.toHaveBeenCalled();
      expect(logs.some((l) => l.includes('PRIMARY'))).toBe(true);
      expect(logs.some((l) => l.includes('FALLBACK'))).toBe(true);
    });

    it('throws if required credentials are missing', async () => {
      await expect(
        runHeartbeat({
          dryRun: false,
          env: {},
          log: () => {},
        })
      ).rejects.toThrow(/Missing required credentials: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN/);
    });

    it('executes full heartbeat in fallback mode when credentials are provided', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'fresh-token',
            expires_in: 3600,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: DEFAULT_EXTENSION_ID,
            crxVersion: '2.0.0',
            uploadState: 'SUCCESS',
          }),
        });

      const logs = [];
      const result = await runHeartbeat({
        mode: 'fallback',
        dryRun: false,
        env: {
          CWS_CLIENT_ID: dummyCreds.clientId,
          CWS_CLIENT_SECRET: dummyCreds.clientSecret,
          CWS_REFRESH_TOKEN: dummyCreds.refreshToken,
        },
        fetchFn: mockFetch,
        log: (msg) => logs.push(msg),
        retryDelayMs: 1,
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('fallback');
      expect(result.tokenRefreshed).toBe(true);
      expect(result.itemStatus.ok).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(logs.some((l) => l.includes('FALLBACK (mid-week redundancy)'))).toBe(true);
      expect(logs.some((l) => l.includes('Heartbeat (fallback) completed successfully'))).toBe(true);
    });

    it('warns but succeeds overall if CWS item returns non-200 while token refresh succeeded', async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'fresh-token',
            expires_in: 3600,
          }),
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          json: async () => ({
            error: { message: 'Item not found' },
          }),
        });

      const logs = [];
      const warnings = [];
      const result = await runHeartbeat({
        mode: 'primary',
        dryRun: false,
        env: {
          CWS_CLIENT_ID: dummyCreds.clientId,
          CWS_CLIENT_SECRET: dummyCreds.clientSecret,
          CWS_REFRESH_TOKEN: dummyCreds.refreshToken,
        },
        fetchFn: mockFetch,
        log: (msg) => logs.push(msg),
        warn: (msg) => warnings.push(msg),
        retryDelayMs: 1,
      });

      expect(result.ok).toBe(true);
      expect(result.mode).toBe('primary');
      expect(result.tokenRefreshed).toBe(true);
      expect(result.itemStatus.ok).toBe(false);
      expect(warnings.some((w) => w.includes('Chrome Web Store item query returned HTTP 404'))).toBe(true);
    });
  });
});
