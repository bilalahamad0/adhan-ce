import { jest } from '@jest/globals';
import { playChime } from '../lib/audio.js';

describe('playChime', () => {
  const origAudio = globalThis.Audio;
  const origChrome = globalThis.chrome;

  afterEach(() => {
    globalThis.Audio = origAudio;
    globalThis.chrome = origChrome;
    jest.restoreAllMocks();
  });

  it('uses direct Audio element when Audio is available in scope', async () => {
    let played = false;
    let urlPassed = '';
    class MockAudio {
      constructor(url) {
        urlPassed = url;
      }
      play() {
        played = true;
        return Promise.resolve();
      }
    }
    globalThis.Audio = MockAudio;
    globalThis.chrome = {
      runtime: {
        getURL: (f) => `chrome-ext://${f}`,
      },
    };

    const res = await playChime('audio/chime.mp3');
    expect(res).toBe(true);
    expect(played).toBe(true);
    expect(urlPassed).toBe('chrome-ext://audio/chime.mp3');
  });

  it('handles direct Audio play() rejection gracefully without throwing', async () => {
    class FailingAudio {
      play() {
        return Promise.reject(new Error('Autoplay blocked'));
      }
    }
    globalThis.Audio = FailingAudio;
    globalThis.chrome = {
      runtime: { getURL: (f) => f },
    };

    const res = await playChime();
    expect(res).toBe(true);
  });

  it('uses chrome.offscreen when Audio is not available in scope', async () => {
    delete globalThis.Audio;
    let created = false;
    let sent = null;
    let hasDoc = false;

    globalThis.chrome = {
      offscreen: {
        hasDocument: async () => hasDoc,
        createDocument: async (opts) => {
          created = true;
          hasDoc = true;
          expect(opts.url).toMatch(/^offscreen\.html\?play=audio%2Fchime\.mp3&t=\d+$/);
          expect(opts.reasons).toEqual(['AUDIO_PLAYBACK']);
        },
      },
      runtime: {
        sendMessage: async (msg) => {
          sent = msg;
          return { ok: true };
        },
      },
    };

    const res = await playChime('audio/chime.mp3');
    expect(res).toBe(true);
    expect(created).toBe(true);
    // On document creation, audio plays immediately from URL query without runtime messaging
    expect(sent).toBeNull();

    // Second call: document already exists (hasDocument is true) -> sends runtime message
    created = false;
    const res2 = await playChime('audio/chime.mp3');
    expect(res2).toBe(true);
    expect(created).toBe(false); // does not re-create
    expect(sent).toEqual({ type: 'PLAY_CHIME', file: 'audio/chime.mp3' });
  });

  it('handles offscreen failure gracefully and returns false', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    delete globalThis.Audio;
    globalThis.chrome = {
      offscreen: {
        hasDocument: async () => {
          throw new Error('offscreen error');
        },
      },
    };

    const res = await playChime();
    expect(res).toBe(false);
  });

  it('returns false when neither Audio nor offscreen is available', async () => {
    delete globalThis.Audio;
    delete globalThis.chrome;

    const res = await playChime();
    expect(res).toBe(false);
  });

  it('handles Audio constructor throwing and logs warning', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    class ThrowingAudio {
      constructor() {
        throw new Error('Audio not allowed');
      }
    }
    globalThis.Audio = ThrowingAudio;
    const res = await playChime();
    expect(res).toBe(false);
  });

  it('retries sendToOffscreen when sendMessage fails initially', async () => {
    delete globalThis.Audio;
    let attempts = 0;
    globalThis.chrome = {
      offscreen: {
        hasDocument: async () => true,
      },
      runtime: {
        sendMessage: async () => {
          attempts++;
          if (attempts < 2) throw new Error('Port closed');
          return { ok: true };
        },
      },
    };

    const res = await playChime('audio/chime.mp3');
    expect(res).toBe(true);
    expect(attempts).toBe(2);
  });
});
