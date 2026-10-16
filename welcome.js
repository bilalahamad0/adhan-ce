// Adhan Focus — Welcome & Onboarding Controller
import { searchPlaces, placeToSave, detectLocationByIp } from './lib/geocode.js';
import { initI18n, setLang, applyDir, getLang, placeDir, t as translate } from './lib/i18n.js';

let t = (k) => k;
let currentStep = 1;
let selectedPlace = null;
// Whether the picked place's English names are in state.settings (see placeToSave):
// Finish waits for it, and asks once more when they could not be had.
let placeSaved = Promise.resolve(true);
// Finish's hand-over of the settings to the worker, and the moment they are on
// their way: Close waits for the first, or 2 s after the second.
let saving = Promise.resolve();
let handedOver = Promise.resolve();
let simTimer = null;
// Until onboarding is done, the stored city is the install default (Sunnyvale), not
// the user's: the location field starts empty and no default-city preview is shown.
let onboarded = false;

// Initial state cache. No place: the stored settings bring the install default's,
// and a placeholder's coordinates (Makkah's, until 2.1.4) were saved beside it.
let state = {
  settings: {
    enabled: true,
    adhanChime: true,
    focusMode: true,
    strictFocus: false,
    autoResumeMinutes: 5,
    leadSeconds: 30,
    method: 2,
    school: 0,
    badgeCountdown: true,
    badgeMode: 'auto',
    badgeManualHours: 1,
    showHijri: true,
    hijriOffset: 0,
  },
};

// Initialize i18n and UI
async function init() {
  let activeLang = 'en';
  try {
    // initI18n resolves to the active language code; lookups go through i18n's t.
    activeLang = await initI18n();
    t = translate;
    applyDir(document); // <html lang/dir>: Arabic and Urdu read right to left
    applyTranslations();
  } catch (err) {
    console.warn('Welcome i18n init error:', err);
  }

  // Load existing settings if available
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    try {
      const stored = await chrome.storage.local.get(['settings', 'schedule', 'onboardingCompleted']);
      onboarded = stored.onboardingCompleted === true;
      if (stored.settings) {
        state.settings = { ...state.settings, ...stored.settings };
        if (stored.settings.lang) activeLang = stored.settings.lang;
      }
      if (onboarded && stored.schedule && stored.schedule.prayers) {
        updatePrayerPreview(stored.schedule.prayers, state.settings.city, state.settings.country);
      }
    } catch (_) {}
  }

  wireLanguageChips(activeLang);
  syncInputsFromSettings();
  wireStepper();
  wireLocationSearch();
  wireGeolocation();
  wirePreferences();
  wireSimulation();
  detectBrowserGuidance();
}

function wireLanguageChips(currentLang) {
  const chips = document.querySelectorAll('.lang-chip');
  const langSelect = document.getElementById('welcomeLang');

  function updateActive(lang) {
    chips.forEach((c) => {
      c.classList.toggle('is-active', c.getAttribute('data-lang') === lang);
    });
    if (langSelect) langSelect.value = lang;
  }

  updateActive(currentLang);

  chips.forEach((chip) => {
    chip.addEventListener('click', async () => {
      const lang = chip.getAttribute('data-lang');
      if (!lang) return;
      state.settings.lang = lang;
      updateActive(lang);
      await setLang(lang);
      t = translate;
      applyDir(document);
      applyTranslations();
    });
  });

  if (langSelect) {
    langSelect.addEventListener('change', async (e) => {
      const lang = e.target.value;
      state.settings.lang = lang;
      updateActive(lang);
      await setLang(lang);
      t = translate;
      applyDir(document);
      applyTranslations();
    });
  }
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const msg = t(key);
    if (msg && msg !== key) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const [attr, key] = el.getAttribute('data-i18n-attr').split(':');
    const msg = t(key);
    if (msg && msg !== key) el.setAttribute(attr, msg);
  });
}

function syncInputsFromSettings() {
  const s = state.settings;
  const cityInput = document.getElementById('welcomeCity');
  const chimeToggle = document.getElementById('welcomeChime');
  const fullscreenToggle = document.getElementById('welcomeFullscreen');
  const strictToggle = document.getElementById('welcomeStrict');

  if (cityInput && s.city && onboarded) cityInput.value = s.city;
  if (chimeToggle) chimeToggle.checked = s.adhanChime !== false;
  if (fullscreenToggle) fullscreenToggle.checked = s.focusMode !== false;
  if (strictToggle) strictToggle.checked = s.strictFocus === true;
}

// Stepper navigation
function goToStep(step) {
  if (step < 1 || step > 3) return;
  currentStep = step;

  // Indicators
  for (let i = 1; i <= 3; i++) {
    const ind = document.getElementById(`stepIndicator${i}`);
    const view = document.getElementById(`step${i}View`);
    if (ind) {
      ind.classList.toggle('is-active', i === currentStep);
      ind.classList.toggle('is-done', i < currentStep);
    }
    if (view) {
      view.classList.toggle('is-active', i === currentStep);
    }
  }
}

function wireStepper() {
  document.getElementById('step1NextBtn')?.addEventListener('click', () => goToStep(2));
  document.getElementById('step2BackBtn')?.addEventListener('click', () => goToStep(1));
  document.getElementById('step2NextBtn')?.addEventListener('click', () => goToStep(3));
  document.getElementById('step3BackBtn')?.addEventListener('click', () => goToStep(2));

  document.getElementById('skipWelcomeBtn')?.addEventListener('click', finishOnboarding);
  document.getElementById('finishBtn')?.addEventListener('click', finishOnboarding);
}

// Location Autocomplete Search
function wireLocationSearch() {
  const input = document.getElementById('welcomeCity');
  const suggest = document.getElementById('welcomeSuggest');
  if (!input || !suggest) return;

  let debounceTimer = null;

  input.addEventListener('input', () => {
    input.dir = 'auto'; // what is typed, from its first letter
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    if (query.length < 2) {
      suggest.hidden = true;
      suggest.replaceChildren();
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const places = await searchPlaces(query, { lang: getLang() || 'en' });
        if (input.value.trim() !== query) return; // a later query's answer is due
        renderSuggestions(places);
      } catch (_) {
        suggest.hidden = true;
      }
    }, 250);
  });

  document.addEventListener('click', (e) => {
    if (!suggest.contains(e.target) && e.target !== input) {
      suggest.hidden = true;
    }
  });

  function renderSuggestions(places) {
    if (!places || !places.length) {
      suggest.hidden = true;
      return;
    }
    suggest.replaceChildren();
    places.slice(0, 5).forEach((p) => {
      const item = document.createElement('div');
      item.className = 'suggest-item';
      // searchPlaces' places are {city, state, country, lat, lon, label}.
      const label = p.label || [p.city, p.state, p.country].filter(Boolean).join(', ');
      item.textContent = label;
      item.addEventListener('click', () => {
        selectPlace(p, label);
      });
      suggest.appendChild(item);
    });
    suggest.hidden = false;
  }

  async function selectPlace(place, label) {
    selectedPlace = place;
    input.value = label;
    input.dir = placeDir(label);
    suggest.hidden = true;

    state.settings.city = place.city;
    state.settings.state = place.state || '';
    state.settings.country = place.country || '';
    state.settings.lat = place.lat;
    state.settings.lon = place.lon;
    state.settings.placeLabel = null;
    placeSaved = englishNamesOf(place);

    // Fetch and preview real prayer times for this location
    await fetchPreviewTimings(place.lat, place.lon, place.city, place.country);
  }
}

// The picked place's English names into state.settings, unless a later choice came
// first; resolves to whether they are there. Should they not come (offline), the
// names as found are kept.
function englishNamesOf(place) {
  return placeToSave(place).then(
    (saved) => {
      if (selectedPlace === place) Object.assign(state.settings, saved);
      return true;
    },
    () => false
  );
}

// Geolocation ("Detect My Location") via IP lookup
function wireGeolocation() {
  const detectBtn = document.getElementById('detectLocBtn');
  const detectText = document.getElementById('detectText');
  const input = document.getElementById('welcomeCity');
  if (!detectBtn) return;

  detectBtn.addEventListener('click', async () => {
    detectText.textContent = t('detecting_location') || 'Detecting…';
    detectBtn.disabled = true;

    try {
      const place = await detectLocationByIp();
      if (place) {
        state.settings.city = place.city;
        state.settings.state = place.state;
        state.settings.country = place.country;
        state.settings.lat = place.lat;
        state.settings.lon = place.lon;
        state.settings.placeLabel = null; // nor one an earlier pick left
        selectedPlace = place;
        placeSaved = Promise.resolve(true); // named in English already

        if (input) {
          input.value = place.label;
          input.dir = placeDir(place.label);
        }
        await fetchPreviewTimings(place.lat, place.lon, place.city, place.country);
      }
    } catch (_) {
    } finally {
      detectText.textContent = t('detect_location') || 'Detect location';
      detectBtn.disabled = false;
    }
  });
}

// Fetch preview timings for selected location
async function fetchPreviewTimings(lat, lon, city, country) {
  try {
    const today = new Date();
    const d = String(today.getDate()).padStart(2, '0');
    const m = String(today.getMonth() + 1).padStart(2, '0');
    const y = today.getFullYear();
    const url = `https://api.aladhan.com/v1/timings/${d}-${m}-${y}?latitude=${lat}&longitude=${lon}&method=${state.settings.method || 2}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const json = await res.json();
    if (!json.data || !json.data.timings) return;

    const tms = json.data.timings;
    const prayers = [
      { name: 'Fajr', time: formatTo12(tms.Fajr) },
      { name: 'Dhuhr', time: formatTo12(tms.Dhuhr) },
      { name: 'Asr', time: formatTo12(tms.Asr) },
      { name: 'Maghrib', time: formatTo12(tms.Maghrib) },
      { name: 'Isha', time: formatTo12(tms.Isha) },
    ];
    updatePrayerPreview(prayers, city, country);
  } catch (err) {
    console.warn('Preview fetch error:', err);
  }
}

function formatTo12(timeStr) {
  if (!timeStr) return '--:--';
  const clean = timeStr.split(' ')[0];
  const [hStr, mStr] = clean.split(':');
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${mStr} ${ampm}`;
}

function updatePrayerPreview(prayers, city, country) {
  const cityLabel = document.getElementById('previewCityLabel');
  if (cityLabel) {
    // Until now the label was the translated "pick your city" prompt; it is the
    // place from here on, which a language switch must not turn back into it.
    cityLabel.removeAttribute('data-i18n');
    cityLabel.textContent = [city, country].filter(Boolean).join(', ');
  }

  prayers.forEach((p) => {
    const el = document.getElementById(`pp${p.name}`);
    if (el) el.textContent = p.time;
  });
}

// Preferences & Audio preview
function wirePreferences() {
  const previewChimeBtn = document.getElementById('previewChimeBtn');
  if (previewChimeBtn) {
    previewChimeBtn.addEventListener('click', () => {
      try {
        const audio = new Audio('audio/chime.mp3');
        audio.play().catch((e) => console.warn('Chime preview blocked:', e));
      } catch (_) {}
    });
  }

  document.getElementById('welcomeChime')?.addEventListener('change', (e) => {
    state.settings.adhanChime = e.target.checked;
  });

  document.getElementById('welcomeFullscreen')?.addEventListener('change', (e) => {
    state.settings.focusMode = e.target.checked;
  });

  document.getElementById('welcomeStrict')?.addEventListener('change', (e) => {
    state.settings.strictFocus = e.target.checked;
  });
}

// Simulation & Live Fullscreen Demo
let demoStarsPopulated = false;

function ensureDemoStars() {
  if (demoStarsPopulated) return;
  const container = document.getElementById('demoStars');
  if (!container) return;
  for (let i = 0; i < 36; i++) {
    const star = document.createElement('div');
    star.className = 'demo-star';
    const size = 1.5 + Math.random() * 3;
    const floatDur = 7 + Math.random() * 10;
    const twinkleDur = 2.5 + Math.random() * 3.5;
    star.style.width = `${size}px`;
    star.style.height = `${size}px`;
    star.style.top = `${Math.random() * 100}%`;
    star.style.left = `${Math.random() * 100}%`;
    star.style.animationDuration = `${floatDur}s, ${twinkleDur}s`;
    star.style.animationDelay = `${Math.random() * 5}s, ${Math.random() * 3}s`;
    container.appendChild(star);
  }
  demoStarsPopulated = true;
}

function wireSimulation() {
  const btn = document.getElementById('simPauseBtn');
  const overlay = document.getElementById('welcomeFocusOverlay');
  const countEl = document.getElementById('demoAutoResumeCount');
  const resumeBtn = document.getElementById('demoResumeBtn');
  if (!btn || !overlay || !countEl) return;

  function dismissDemo() {
    if (simTimer) clearInterval(simTimer);
    simTimer = null;
    overlay.hidden = true;
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({ type: 'RESUME_DEMO' }).catch(() => {});
    }
  }

  resumeBtn?.addEventListener('click', dismissDemo);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) {
      dismissDemo();
    }
  });

  btn.addEventListener('click', () => {
    if (simTimer) clearInterval(simTimer);
    ensureDemoStars();
    overlay.hidden = false;

    // Trigger cross-tab actual media pause demo via background
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'TEST_PAUSE_DEMO',
        seconds: 10,
        prayer: 'Maghrib',
      }).catch(() => {});
    }

    // Play chime locally if enabled
    if (state.settings.adhanChime) {
      try {
        new Audio('audio/chime.mp3').play().catch(() => {});
      } catch (_) {}
    }

    let secondsLeft = 10;
    countEl.textContent = secondsLeft;

    simTimer = setInterval(() => {
      secondsLeft -= 1;
      countEl.textContent = secondsLeft;
      if (secondsLeft <= 0) {
        dismissDemo();
      }
    }, 1000);
  });
}

// Detect browser for specific pinning guidance
function detectBrowserGuidance() {
  const guideText = document.getElementById('browserPinGuidance');
  if (!guideText) return;

  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/')) {
    guideText.textContent = 'Click the Extensions puzzle icon 🧩 in your top-right browser bar, then click "Show in toolbar" next to Adhan Focus.';
  } else if (ua.includes('firefox')) {
    guideText.textContent = 'Click the Extensions puzzle icon 🧩 in your top-right browser bar, then click the gear ⚙️ icon and select "Pin to Toolbar".';
  } else {
    guideText.textContent = 'Click the Extensions puzzle icon 🧩 in your top-right browser bar, then click the Pin icon next to Adhan Focus.';
  }
}

// Celebration Confetti Animation
function triggerCelebration() {
  const canvas = document.getElementById('confettiCanvas');
  if (!canvas) return;
  canvas.hidden = false;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const colors = ['#46d39b', '#5fe0a8', '#e2bd72', '#efce8a', '#ffffff', '#38bdf8'];
  const particles = [];

  for (let i = 0; i < 65; i++) {
    particles.push({
      x: canvas.width / 2 + (Math.random() - 0.5) * 80,
      y: canvas.height / 2 + (Math.random() - 0.5) * 40,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 14 - 4,
      size: Math.random() * 7 + 4,
      color: colors[Math.floor(Math.random() * colors.length)],
      alpha: 1,
      rotation: Math.random() * 360,
      rotSpeed: (Math.random() - 0.5) * 12,
    });
  }

  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let alive = false;
    particles.forEach((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.45;
      p.alpha -= 0.014;
      p.rotation += p.rotSpeed;

      if (p.alpha > 0) {
        alive = true;
        ctx.save();
        ctx.globalAlpha = Math.max(0, p.alpha);
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.7);
        ctx.restore();
      }
    });

    frame++;
    if (alive && frame < 95) {
      requestAnimationFrame(animate);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.hidden = true;
    }
  }
  requestAnimationFrame(animate);
}

// Complete onboarding
async function finishOnboarding() {
  const finishBtn = document.getElementById('finishBtn');
  if (finishBtn) finishBtn.classList.add('is-finishing');

  triggerCelebration();

  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    // Hand the settings to the background, which stores them and — the location
    // or calculation having changed — fetches that place's schedule and re-arms
    // the alarms. Writing them to storage first left it nothing to compare
    // against, so it kept the schedule fetched at install for the default city.
    // Only when it can't be reached are they stored here.
    let sent;
    handedOver = new Promise((resolve) => (sent = resolve));
    saving = (async () => {
      // A lookup that failed at the pick is usually a blip: one more try.
      if (!(await placeSaved) && selectedPlace) await englishNamesOf(selectedPlace);
      const settings = state.settings;
      let reply;
      try {
        // Its failure handled at once: it is awaited only after the flag below is set.
        if (chrome.runtime && chrome.runtime.sendMessage) reply = Promise.resolve(chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings })).catch(() => undefined);
      } catch (_) {}
      // Set up only once the place is on its way: a tab closed before then leaves
      // setup to be finished, rather than the default city kept unasked.
      await chrome.storage.local.set({ onboardingCompleted: true });
      sent();
      let res;
      try {
        res = await reply;
      } catch (_) {}
      if (!res) await chrome.storage.local.set({ settings });
    })()
      .catch(() => {})
      .finally(() => sent());
  }

  setTimeout(() => {
    document.getElementById('step1View')?.classList.remove('is-active');
    document.getElementById('step2View')?.classList.remove('is-active');
    document.getElementById('step3View')?.classList.remove('is-active');
    const stepper = document.querySelector('.welcome-steps');
    if (stepper) stepper.style.display = 'none';

    const successView = document.getElementById('stepSuccessView');
    const citySpan = document.getElementById('completionCity');
    // The city as it was found while the page is still in that language, else as stored.
    const shown = selectedPlace && selectedPlace.lang === getLang() ? selectedPlace.city : state.settings.city;
    if (citySpan) {
      citySpan.textContent = shown || 'your location';
      citySpan.dir = 'auto'; // isolated: an Arabic name keeps the English sentence in order
    }
    if (successView) {
      successView.hidden = false;
      successView.classList.add('is-active');
    }
  }, 350);

  document.getElementById('closeWelcomeBtn')?.addEventListener('click', async () => {
    // The place reaches the worker before the page goes, though not its answer, which
    // waits on Aladhan: the worker has stored the settings by then.
    await Promise.race([saving, handedOver.then(() => new Promise((resolve) => setTimeout(resolve, 2000)))]);
    window.close();
  });
}

document.addEventListener('DOMContentLoaded', init);
