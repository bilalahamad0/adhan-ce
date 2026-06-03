// Adhan Caster Pro — content script (runs in every frame).
// Top visible frame: renders the bottom-right T-15s countdown overlay, the
// "media paused" card, and (opt-in) the full-screen prayer focus overlay.
// Every frame: pauses/resumes its own <video>/<audio> when prayer time hits.

(() => {
  const DEFAULT_LEAD_SECONDS = 30; // heads-up window before Adhan (configurable)
  // How late the per-tab fallback pause may trigger. Past this the prayer moment
  // has clearly passed (e.g. the device slept through it), so we don't pause on
  // wake. Mirrors STALE_FIRE_MS in lib/schedule.js — keep the two in sync.
  const STALE_FIRE_MS = 90 * 1000;
  const isTop = window.top === window;

  // A previous instance of this script may have been orphaned (extension
  // reloaded/updated/disabled) leaving frozen overlays in the DOM that it can no
  // longer control. Remove them so this fresh instance is the single source of
  // truth, and restore scrolling in case the orphan left it locked.
  if (isTop) {
    document.getElementById('adhan-ccp-host')?.remove();
    document.getElementById('adhan-ccp-focus-host')?.remove();
    const de = document.documentElement;
    if (de && 'adhanPrevOverflow' in de.dataset) {
      de.style.overflow = de.dataset.adhanPrevOverflow || '';
      delete de.dataset.adhanPrevOverflow;
    }
  }

  // Claim this frame for the newest instance. If another instance loads later
  // (an install-time injection race, or re-injection after a reload), the older
  // one sees the token change on its next tick and tears down — so exactly one
  // instance is ever active per frame.
  const instanceId = `${Date.now()}.${Math.random()}`;
  window.__adhanCasterInstance = instanceId;

  let state = { settings: null, nextPrayer: null, paused: { active: false } };
  let localPaused = false;
  let pausedEls = [];
  let currentPrayer = null;
  let lastHandledTs = 0;
  let tickHandle = null;

  // ---- UI (shadow DOM, top frame only) ----
  let host = null;
  let els = null;
  let fhost = null; // full-screen prayer-focus overlay
  let fels = null;
  let focusLocked = false;

  // ---- i18n ----
  // The catalog comes from the background (GET_I18N). An inline English map is the
  // fallback so overlays always have text even before the round-trip / if it fails,
  // i.e. English behavior is unchanged when no translation is loaded.
  const I18N_EN = {
    app_name: 'Adhan Caster',
    prayer_generic: 'Prayer',
    time_for_prayer: 'Time for prayer',
    media_paused_msg: 'Media is paused. Take a moment for your prayer.',
    press_esc: 'Press Esc to resume',
    resume: 'Resume',
    prayer_adhan: '{prayer} Adhan',
    starting_in: 'Starting in {secs}s',
    starting_now: 'Starting now…',
    auto_resumes_in: 'Auto-resumes in {time}',
    adhan_paused: 'Adhan time · media paused',
    prayer_Fajr: 'Fajr',
    prayer_Dhuhr: 'Dhuhr',
    prayer_Asr: 'Asr',
    prayer_Maghrib: 'Maghrib',
    prayer_Isha: 'Isha',
  };
  let MSG = I18N_EN;
  let DIR = 'ltr';
  function ti(key, params) {
    let s = key in MSG ? MSG[key] : key in I18N_EN ? I18N_EN[key] : key;
    if (params) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
    return s;
  }
  function prayerLabel(name) {
    return name ? ti('prayer_' + name) : ti('prayer_generic');
  }
  // Shadow DOM resets direction to LTR (:host { all: initial }) and RTL does not
  // inherit across the boundary, so set dir explicitly on the overlay wrappers and
  // flip the corner card to the opposite side for RTL.
  function applyHostDir() {
    if (host) {
      host.style.setProperty(DIR === 'rtl' ? 'left' : 'right', '16px', 'important');
      host.style.setProperty(DIR === 'rtl' ? 'right' : 'left', 'auto', 'important');
    }
    if (els) els.card.setAttribute('dir', DIR);
    if (fels) fels.scrim.setAttribute('dir', DIR);
  }
  function applyOverlayI18n() {
    if (els) {
      els.resume.textContent = ti('resume');
      if (els.cbname) els.cbname.textContent = ti('app_name');
    }
    if (fels) {
      if (fels.ftitle) fels.ftitle.textContent = ti('time_for_prayer');
      if (fels.fmsg) fels.fmsg.textContent = ti('media_paused_msg');
      if (fels.fhint) fels.fhint.textContent = ti('press_esc');
      if (fels.fbname) fels.fbname.textContent = ti('app_name');
      fels.fresume.textContent = ti('resume');
    }
  }
  function loadI18n() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_I18N' }, (resp) => {
        if (chrome.runtime.lastError || !resp) return;
        MSG = resp.messages || I18N_EN;
        DIR = resp.dir || 'ltr';
        applyOverlayI18n();
        applyHostDir();
        render();
      });
    } catch (_) {}
  }

  function fmtMMSS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Freeze page scrolling while the focus overlay is up.
  function lockScroll(on) {
    if (on === focusLocked) return;
    focusLocked = on;
    try {
      const el = document.documentElement;
      if (on) {
        el.dataset.adhanPrevOverflow = el.style.overflow || '';
        el.style.setProperty('overflow', 'hidden', 'important');
      } else {
        el.style.overflow = el.dataset.adhanPrevOverflow || '';
        delete el.dataset.adhanPrevOverflow;
      }
    } catch (_) {}
  }

  function ensureUI() {
    if (host || !isTop) return;
    host = document.createElement('div');
    host.id = 'adhan-ccp-host';
    host.style.cssText =
      'position:fixed!important;right:16px!important;bottom:16px!important;top:auto!important;left:auto!important;z-index:2147483647!important;pointer-events:none!important;margin:0!important;padding:0!important;border:0!important;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .card {
          display: flex; flex-direction: column; align-items: stretch; gap: 8px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          font-size: 13px; line-height: 1.3; color: #fff; text-align: start;
          background: linear-gradient(135deg, #0f8a5f, #0a5c47);
          padding: 11px 13px; border-radius: 13px; min-width: 200px; max-width: 300px;
          box-shadow: 0 10px 30px rgba(0,0,0,.30); border: 1px solid rgba(255,255,255,.15);
          pointer-events: none; opacity: 0; transform: translateY(8px);
          transition: opacity .22s ease, transform .22s ease;
        }
        .card.show { opacity: 1; transform: translateY(0); pointer-events: auto; }
        .card.paused { background: linear-gradient(135deg, #b4521f, #7c3312); }
        .cbrand { display: flex; align-items: center; gap: 7px; }
        .cbicon { width: 18px; height: 18px; border-radius: 5px; flex: 0 0 auto; }
        .cbname { font-size: 12px; font-weight: 700; opacity: .9; letter-spacing: .2px; }
        .crow { display: flex; align-items: center; gap: 11px; }
        .icon { font-size: 22px; line-height: 1; flex: 0 0 auto; }
        .body { flex: 1 1 auto; min-width: 0; }
        .title { font-weight: 700; font-size: 13px; letter-spacing: .2px; }
        .sub { font-size: 12px; opacity: .92; margin-top: 1px; }
        .bar { height: 3px; border-radius: 3px; background: rgba(255,255,255,.25); margin-top: 7px; overflow: hidden; }
        .bar > i { display: block; height: 100%; width: 100%; background: #fff; border-radius: 3px; transition: width .9s linear; }
        .resume {
          flex: 0 0 auto; font: 600 12px/1 inherit; color: #7c3312; background: #fff;
          border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer;
        }
        .resume:hover { background: #ffe9dc; }
        .pulse { animation: pulse 1s ease-in-out infinite; }
        @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .55 } }
      </style>
      <div class="card" id="card">
        <div class="cbrand"><img class="cbicon" id="cbicon" alt="" /><span class="cbname" id="cbname">Adhan Caster</span></div>
        <div class="crow">
          <div class="icon" id="icon">🕌</div>
          <div class="body">
            <div class="title" id="title">Prayer</div>
            <div class="sub" id="sub"></div>
            <div class="bar" id="bar"><i id="barfill"></i></div>
          </div>
          <button class="resume" id="resume" hidden>Resume</button>
        </div>
      </div>`;
    (document.documentElement || document.body).appendChild(host);
    els = {
      card: root.querySelector('#card'),
      cbname: root.querySelector('#cbname'),
      icon: root.querySelector('#icon'),
      title: root.querySelector('#title'),
      sub: root.querySelector('#sub'),
      bar: root.querySelector('#bar'),
      barfill: root.querySelector('#barfill'),
      resume: root.querySelector('#resume'),
    };
    const cbicon = root.querySelector('#cbicon');
    if (cbicon) cbicon.src = chrome.runtime.getURL('icons/icon48.png');
    els.resume.addEventListener('click', onResumeClick);
    applyOverlayI18n();
    applyHostDir();
  }

  function hideUI() {
    if (els) els.card.classList.remove('show');
  }

  function ensureFocusUI() {
    if (fhost || !isTop) return;
    fhost = document.createElement('div');
    fhost.id = 'adhan-ccp-focus-host';
    fhost.style.cssText =
      'position:fixed!important;inset:0!important;z-index:2147483646!important;pointer-events:none!important;margin:0!important;';
    const root = fhost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .scrim {
          position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
          background: #062a20;
          -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
          opacity: 0; transition: opacity .35s ease; pointer-events: none;
        }
        .scrim.show { opacity: 1; pointer-events: auto; }
        /* full-screen breathing gradient */
        .bg {
          position: absolute; inset: -25%; z-index: 0; pointer-events: none;
          background: radial-gradient(55% 55% at 50% 38%, rgba(20,160,111,.98), rgba(11,94,67,.92) 55%, rgba(6,42,32,1) 100%);
          animation: ccpBg 12s ease-in-out infinite;
        }
        /* drifting, twinkling stars across the whole screen (positions set per-star in JS) */
        .stars { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
        .star {
          position: absolute; border-radius: 50%; background: #fff;
          box-shadow: 0 0 6px rgba(255,255,255,.85); opacity: 0;
          animation-name: ccpFloat, ccpTwinkle; animation-timing-function: linear, ease-in-out;
          animation-iteration-count: infinite, infinite;
        }
        .panel { position: relative; z-index: 2; text-align: center; color: #fff; padding: 28px; max-width: 460px; }
        .fbrand { display: flex; align-items: center; justify-content: center; gap: 9px; opacity: .92; margin-bottom: 22px; }
        .fbrand .fbicon { width: 26px; height: 26px; border-radius: 7px; }
        .fbrand .fbname { font-size: 16px; font-weight: 700; letter-spacing: .3px; }
        .scrim.show .panel { animation: ccpRise .6s cubic-bezier(.2, .7, .2, 1) both; }
        .crescent-wrap { position: relative; display: inline-block; }
        .halo {
          position: absolute; top: 50%; left: 50%; width: 190px; height: 190px; pointer-events: none;
          transform: translate(-50%, -50%); border-radius: 50%;
          background: conic-gradient(from 0deg, rgba(255,255,255,0), rgba(255,255,255,.28), rgba(255,255,255,0) 50%, rgba(255,255,255,.22), rgba(255,255,255,0));
          animation: ccpSpin 24s linear infinite;
        }
        .glow {
          position: absolute; top: 50%; left: 50%; width: 150px; height: 150px; pointer-events: none;
          transform: translate(-50%, -50%); border-radius: 50%;
          background: radial-gradient(circle, rgba(255, 255, 255, .5), rgba(255, 255, 255, 0) 70%);
          animation: ccpGlow 5s ease-in-out infinite;
        }
        .crescent { position: relative; display: inline-block; font-size: 60px; line-height: 1; animation: ccpBreathe 5s ease-in-out infinite; }
        @keyframes ccpBg { 0%, 100% { transform: scale(1); opacity: .92; } 50% { transform: scale(1.14); opacity: 1; } }
        @keyframes ccpFloat { from { transform: translateY(20px); } to { transform: translateY(-46px); } }
        @keyframes ccpTwinkle { 0%, 100% { opacity: 0; } 50% { opacity: .9; } }
        @keyframes ccpSpin { to { transform: translate(-50%, -50%) rotate(360deg); } }
        @keyframes ccpGlow { 0%, 100% { opacity: .35; transform: translate(-50%, -50%) scale(.9); } 50% { opacity: .7; transform: translate(-50%, -50%) scale(1.3); } }
        @keyframes ccpBreathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.08); } }
        @keyframes ccpRise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
        @media (prefers-reduced-motion: reduce) {
          /* drop all movement, but keep a gentle opacity-only twinkle so it isn't dead */
          .bg, .halo, .glow, .crescent, .scrim.show .panel { animation: none !important; }
          .star { animation-name: ccpTwinkle !important; }
        }
        .ftitle { font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; opacity: .8; margin-top: 16px; }
        .fname { font-size: 42px; font-weight: 800; margin-top: 4px; }
        .ftime { font-size: 17px; opacity: .9; margin-top: 2px; }
        .fmsg { font-size: 14px; opacity: .85; margin-top: 16px; }
        .fauto { font-size: 12px; opacity: .7; margin-top: 18px; font-variant-numeric: tabular-nums; }
        .fresume {
          margin-top: 18px; border: 0; border-radius: 10px; cursor: pointer;
          font: 700 14px/1 inherit; color: #0a5c47; background: #fff; padding: 13px 28px;
        }
        .fresume:hover { background: #eafaf2; }
        .fhint { font-size: 11px; opacity: .6; margin-top: 12px; }
      </style>
      <div class="scrim" id="scrim" role="dialog" aria-modal="true" aria-label="Prayer focus">
        <div class="bg"></div>
        <div class="stars" id="stars"></div>
        <div class="panel">
          <div class="fbrand"><img class="fbicon" id="fbicon" alt="" /><span class="fbname" id="fbname">Adhan Caster</span></div>
          <div class="crescent-wrap"><span class="halo"></span><span class="glow"></span><span class="crescent">🕌</span></div>
          <div class="ftitle" id="ftitle">Time for prayer</div>
          <div class="fname" id="fname">Prayer</div>
          <div class="ftime" id="ftime"></div>
          <div class="fmsg" id="fmsg">Media is paused. Take a moment for your prayer.</div>
          <div class="fauto" id="fauto"></div>
          <button class="fresume" id="fresume">Resume</button>
          <div class="fhint" id="fhint">Press Esc to resume</div>
        </div>
      </div>`;
    (document.documentElement || document.body).appendChild(fhost);
    // Scatter drifting, twinkling stars across the full screen.
    const starsEl = root.querySelector('#stars');
    if (starsEl) {
      for (let i = 0; i < 18; i++) {
        const s = document.createElement('span');
        s.className = 'star';
        const size = 2 + Math.random() * 3;
        const floatDur = 7 + Math.random() * 9;
        const twkDur = 3 + Math.random() * 4;
        s.style.cssText =
          `left:${(Math.random() * 100).toFixed(2)}%;top:${(Math.random() * 100).toFixed(2)}%;` +
          `width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;` +
          `animation-duration:${floatDur.toFixed(1)}s,${twkDur.toFixed(1)}s;` +
          `animation-delay:${(-Math.random() * floatDur).toFixed(1)}s,${(-Math.random() * twkDur).toFixed(1)}s;`;
        starsEl.appendChild(s);
      }
    }
    fels = {
      scrim: root.querySelector('#scrim'),
      fbname: root.querySelector('#fbname'),
      ftitle: root.querySelector('#ftitle'),
      fname: root.querySelector('#fname'),
      ftime: root.querySelector('#ftime'),
      fmsg: root.querySelector('#fmsg'),
      fauto: root.querySelector('#fauto'),
      fresume: root.querySelector('#fresume'),
      fhint: root.querySelector('#fhint'),
    };
    const fbicon = root.querySelector('#fbicon');
    if (fbicon) fbicon.src = chrome.runtime.getURL('icons/icon48.png');
    fels.fresume.addEventListener('click', onFocusResume);
    applyOverlayI18n();
    applyHostDir();
  }

  function hideFocusUI() {
    if (fels) fels.scrim.classList.remove('show');
    lockScroll(false);
  }

  function onFocusResume() {
    resumeMedia();
    state.paused = { active: false };
    hideFocusUI();
    render();
    chrome.runtime.sendMessage({ type: 'RESUME_NOW' }).catch(() => {});
  }

  function render() {
    if (!isTop) return;
    const now = Date.now();
    const np = state.nextPrayer;
    const isPaused = localPaused || (state.paused && state.paused.active);
    const wantFocus = !!(isPaused && state.paused && state.paused.focus);
    const isTest = !!(np && np.test);
    const leadSecs = (state.settings && state.settings.leadSeconds) || DEFAULT_LEAD_SECONDS;
    const windowMs = isTest ? 31000 : leadSecs * 1000;
    const maxSecs = isTest ? 30 : leadSecs;

    let mode = 'hidden';
    let secs = 0;
    if (wantFocus) {
      mode = 'focus';
    } else if (isPaused) {
      mode = 'paused';
    } else if (np && np.ts - now <= windowMs && np.ts - now > -1500) {
      mode = 'countdown';
      secs = Math.max(0, Math.ceil((np.ts - now) / 1000));
    }

    // Full-screen focus overlay (takes precedence over the corner card).
    if (mode === 'focus' && !document.hidden) {
      hideUI();
      ensureFocusUI();
      fels.fname.textContent = prayerLabel((state.paused && state.paused.prayer) || (np && np.name));
      fels.ftime.textContent = (state.paused && state.paused.time) || '';
      const mins = state.settings && state.settings.autoResumeMinutes;
      const since = state.paused && state.paused.since;
      const rem = mins != null && since ? since + mins * 60000 - now : -1;
      fels.fauto.textContent = rem > 0 ? ti('auto_resumes_in', { time: fmtMMSS(rem) }) : '';
      fels.scrim.classList.add('show');
      lockScroll(true);
      return;
    }
    hideFocusUI();

    if (mode === 'hidden' || mode === 'focus' || document.hidden) {
      hideUI();
      return;
    }
    ensureUI();

    if (mode === 'paused') {
      const name = prayerLabel(currentPrayer || (state.paused && state.paused.prayer) || (np && np.name));
      const mins = state.settings && state.settings.autoResumeMinutes;
      const since = state.paused && state.paused.since;
      const rem = mins && since ? since + mins * 60000 - now : -1;
      els.card.classList.add('paused');
      els.icon.textContent = '🕌';
      els.title.textContent = name;
      els.sub.textContent = rem > 0 ? ti('auto_resumes_in', { time: fmtMMSS(rem) }) : ti('adhan_paused');
      els.sub.classList.remove('pulse');
      els.bar.style.display = 'none';
      els.resume.hidden = false;
    } else {
      els.card.classList.remove('paused');
      els.icon.textContent = '🕌';
      els.title.textContent = ti('prayer_adhan', { prayer: prayerLabel(np.name) });
      els.sub.textContent = secs > 0 ? ti('starting_in', { secs }) : ti('starting_now');
      els.sub.classList.toggle('pulse', secs <= 0);
      els.bar.style.display = '';
      els.barfill.style.width = `${Math.min(100, (secs / maxSecs) * 100)}%`;
      els.resume.hidden = true;
    }
    els.card.classList.add('show');
  }

  // ---- media control (every frame) ----
  function pauseMediaFor(prayerName) {
    if (localPaused) return;
    const media = document.querySelectorAll('video, audio');
    pausedEls = [];
    media.forEach((el) => {
      if (!el.paused && !el.ended) {
        try {
          el.pause();
          pausedEls.push(el);
        } catch (_) {}
      }
    });
    localPaused = true;
    currentPrayer = prayerName || currentPrayer;
  }

  function resumeMedia() {
    if (!localPaused) return;
    pausedEls.forEach((el) => {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
    pausedEls = [];
    localPaused = false;
  }

  function onResumeClick() {
    resumeMedia();
    state.paused = { active: false }; // optimistic; background confirms
    render();
    chrome.runtime.sendMessage({ type: 'RESUME_NOW' }).catch(() => {});
  }

  // ---- ticking + sync ----
  // Detect an invalidated extension context (reload / update / disable). An
  // orphaned content script keeps running its page-side timer but can no longer
  // talk to the extension, so it must tear its UI down instead of freezing it
  // on screen (which is what made stale overlays linger forever).
  function contextAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  function teardown() {
    try { if (host) host.remove(); } catch (_) {}
    try { if (fhost) fhost.remove(); } catch (_) {}
    lockScroll(false);
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
  }

  function tick() {
    // Yield if the extension context died or a newer instance took over.
    if (!contextAlive() || window.__adhanCasterInstance !== instanceId) {
      teardown();
      return;
    }
    const now = Date.now();
    const np = state.nextPrayer;
    const alreadyPaused = localPaused || (state.paused && state.paused.active);

    // Self-healing auto-resume. The corner card stays on screen for as long as
    // state.paused.active is true; normally the background's ALARM_RESUME flips
    // it off after autoResumeMinutes. But the MV3 service worker can be evicted
    // and alarms have been observed to silently never fire, leaving the card
    // pinned forever. This client-side timeout makes the active tab self-resume
    // when the window has elapsed and notifies the background so the central
    // state + other tabs catch up via the RESUME broadcast.
    if (alreadyPaused) {
      const mins = state.settings && state.settings.autoResumeMinutes;
      const since = state.paused && state.paused.since;
      if (mins != null && since && now >= since + mins * 60000) {
        resumeMedia();
        // Pin lastHandledTs so the fallback block below can't re-pause for the
        // prayer we just timed out of.
        if (np && np.ts) lastHandledTs = Math.max(lastHandledTs, np.ts);
        state.paused = { active: false };
        hideFocusUI();
        render();
        if (isTop) {
          chrome.runtime.sendMessage({ type: 'RESUME_NOW' }).catch(() => {});
        }
        return;
      }
    }

    // Second-accurate fallback in case the background alarm/message is delayed.
    if (!alreadyPaused && np && now >= np.ts && now - np.ts < STALE_FIRE_MS && lastHandledTs !== np.ts) {
      lastHandledTs = np.ts;
      pauseMediaFor(np.name);
      // Carry focus intent from settings so the full-screen focus takes over
      // immediately, without the corner "Resume" card flashing first.
      const focus = !!(state.settings && state.settings.focusMode);
      state.paused = { active: true, prayer: np.name, time: np.time, focus, since: now };
      // The background alarm can be delayed while the MV3 service worker is
      // asleep. Tell the background to record the pause and arm auto-resume so
      // media can't stay paused forever if handlePrayerFire() never ran. Top
      // frame only — the background broadcasts the pause to the other frames.
      if (isTop) {
        chrome.runtime
          .sendMessage({ type: 'PRAYER_FALLBACK', prayer: np.name, time: np.time, focus })
          .catch(() => {});
      }
    }
    render();
  }

  function loadState() {
    chrome.storage.local.get(['settings', 'nextPrayer', 'paused'], (data) => {
      state.settings = data.settings || null;
      state.nextPrayer = data.nextPrayer || null;
      state.paused = data.paused || { active: false };
      render();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.lang && isTop) loadI18n();
    if (changes.nextPrayer) state.nextPrayer = changes.nextPrayer.newValue || null;
    if (changes.settings) state.settings = changes.settings.newValue || null;
    if (changes.paused) {
      const wasActive = changes.paused.oldValue && changes.paused.oldValue.active;
      state.paused = changes.paused.newValue || { active: false };
      if (state.paused.active && !localPaused) pauseMediaFor(state.paused.prayer);
      else if (!state.paused.active && localPaused) resumeMedia();
      if (!state.paused.active) {
        hideFocusUI();
        // When a pause ends (auto-resume or explicit Resume from any tab/popup),
        // pin lastHandledTs to the current prayer so the 90-second fallback in
        // tick() can't re-pause this tab for the prayer we just resumed from.
        if (wasActive && state.nextPrayer && state.nextPrayer.ts) {
          lastHandledTs = Math.max(lastHandledTs, state.nextPrayer.ts);
        }
      }
    }
    render();
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === 'PRAYER_NOW') {
      pauseMediaFor(msg.prayer);
      state.paused = { active: true, prayer: msg.prayer, time: msg.time, focus: !!msg.focus, since: msg.since };
      // Treat the broadcast as authoritative handling of this prayer so the
      // 90-second fallback in tick() can't re-fire on tabs that didn't trigger
      // the fallback themselves.
      if (state.nextPrayer && state.nextPrayer.ts) {
        lastHandledTs = Math.max(lastHandledTs, state.nextPrayer.ts);
      }
      render();
    } else if (msg.type === 'FOCUS_ON') {
      const prev = state.paused || {};
      state.paused = {
        active: true,
        prayer: msg.prayer || prev.prayer,
        time: msg.time || prev.time,
        focus: true,
        since: msg.since || prev.since,
      };
      render();
    } else if (msg.type === 'FOCUS_OFF') {
      if (state.paused) state.paused.focus = false;
      hideFocusUI();
      render();
    } else if (msg.type === 'RESUME') {
      resumeMedia();
      // Pin lastHandledTs so the per-tab fallback in tick() can't re-pause for
      // the just-resumed prayer within its 90s window.
      if (state.nextPrayer && state.nextPrayer.ts) {
        lastHandledTs = Math.max(lastHandledTs, state.nextPrayer.ts);
      }
      state.paused = { active: false };
      hideFocusUI();
      render();
    }
  });

  document.addEventListener('visibilitychange', render);

  if (isTop) {
    const blockScroll = (e) => {
      if (focusLocked && !document.hidden) e.preventDefault();
    };
    window.addEventListener('wheel', blockScroll, { passive: false, capture: true });
    window.addEventListener('touchmove', blockScroll, { passive: false, capture: true });
    window.addEventListener(
      'keydown',
      (e) => {
        if (!focusLocked || document.hidden) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          onFocusResume();
        } else if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar'].includes(e.key)) {
          e.preventDefault();
        }
      },
      { capture: true }
    );
  }

  loadState();
  if (isTop) loadI18n();
  tickHandle = setInterval(tick, 1000);
})();
