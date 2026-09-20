// Adhan Focus — offscreen document for audio playback (Chromium MV3).
// Handles prayer notification chime playback without requiring an active tab
// or user gesture.

// 1. Message listener (for when offscreen document was already created)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'PLAY_CHIME') {
    playAudio(msg.file || 'audio/chime.mp3')
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // async response
  }
});

// 2. Query param trigger for immediate autoplay upon document creation
// (eliminates any race condition where messages sent immediately after createDocument are missed)
try {
  const params = new URLSearchParams(window.location.search);
  const autoPlay = params.get('play');
  if (autoPlay) {
    playAudio(autoPlay).catch((err) => {
      console.warn('Adhan offscreen: autoPlay error', err);
    });
  }
} catch (_) {}

function notifyDone() {
  try {
    chrome.runtime.sendMessage({ type: 'CHIME_FINISHED' }).catch(() => {});
  } catch (_) {}
}

function playAudio(path) {
  return new Promise((resolve, reject) => {
    try {
      const url = chrome.runtime.getURL(path);
      let audio = document.getElementById('player');
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = 'player';
        document.body.appendChild(audio);
      }
      audio.src = url;
      audio.volume = 1.0;

      const onDone = () => {
        audio.onended = null;
        audio.onerror = null;
        notifyDone();
        resolve();
      };

      const onError = (err) => {
        audio.onended = null;
        audio.onerror = null;
        // Attempt fallback to Web Audio API
        playWebAudio(url)
          .then(() => {
            notifyDone();
            resolve();
          })
          .catch((webErr) => {
            notifyDone();
            reject(err || webErr);
          });
      };

      audio.onended = onDone;
      audio.onerror = () => onError(new Error('Audio element playback failed'));

      const p = audio.play();
      if (p && typeof p.catch === 'function') {
        p.catch((e) => onError(e));
      }
    } catch (e) {
      notifyDone();
      reject(e);
    }
  });
}

async function playWebAudio(url) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) throw new Error('Web Audio not supported');
  const ctx = new AudioCtx();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  const resp = await fetch(url);
  const buf = await resp.arrayBuffer();
  const audioBuffer = await ctx.decodeAudioData(buf);
  const source = ctx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(ctx.destination);
  return new Promise((resolve, reject) => {
    source.onended = () => {
      ctx.close().catch(() => {});
      resolve();
    };
    try {
      source.start(0);
    } catch (e) {
      reject(e);
    }
  });
}
