// Adhan Focus — audio chime playback helper.
// Supports both direct Audio (Firefox event page / popup context) and
// chrome.offscreen (Chromium MV3 service worker).

const CHIME_FILE = 'audio/chime.mp3';
const OFFSCREEN_URL = 'offscreen.html';

async function sendToOffscreen(msg, maxAttempts = 4, delayMs = 80) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res && res.ok) return true;
    } catch (err) {
      if (i === maxAttempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  return false;
}

export async function playChime(file = CHIME_FILE) {
  // 1. Direct Audio element (Firefox event page, popup window)
  if (typeof Audio !== 'undefined') {
    try {
      const url = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL(file) : file;
      const audio = new Audio(url);
      audio.volume = 1.0;
      const p = audio.play();
      if (p && typeof p.catch === 'function') await p.catch(() => {});
      return true;
    } catch (e) {
      console.warn('Adhan: direct audio play failed', e);
    }
  }

  // 2. Offscreen document (Chrome / Edge MV3 service worker)
  const offscreenApi = typeof chrome !== 'undefined' ? chrome['offscreen'] : null;
  if (offscreenApi) {
    try {
      let hasDoc = false;
      if (typeof offscreenApi.hasDocument === 'function') {
        hasDoc = await offscreenApi.hasDocument();
      }

      if (!hasDoc) {
        // Pass play parameter in URL so offscreen document executes playback immediately
        // upon loading without relying on a message-passing race condition.
        const targetUrl = `${OFFSCREEN_URL}?play=${encodeURIComponent(file)}&t=${Date.now()}`;
        await offscreenApi.createDocument({
          url: targetUrl,
          reasons: ['AUDIO_PLAYBACK'],
          justification: 'Play prayer notification chime',
        });
        return true;
      }

      // Document already exists: message it with retry
      await sendToOffscreen({ type: 'PLAY_CHIME', file });
      return true;
    } catch (e) {
      console.warn('Adhan: offscreen chime playback failed', e);
    }
  }

  return false;
}
