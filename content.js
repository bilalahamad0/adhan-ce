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

  // Tiny DOM builder. We construct the overlays with createElement/textContent
  // (never innerHTML) so they also render on sites that enforce Trusted Types via
  // CSP (Google Search, Gmail, …) — there, a content script's innerHTML assignment
  // throws, which previously left the overlay invisible on those tabs.
  function mk(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style') e.style.cssText = v;
        else e.setAttribute(k, v);
      }
    }
    for (const c of kids) if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return e;
  }

  function ensureUI() {
    if (host || !isTop) return;
    host = document.createElement('div');
    host.id = 'adhan-ccp-host';
    host.style.cssText =
      'position:fixed!important;right:16px!important;bottom:16px!important;top:auto!important;left:auto!important;z-index:2147483647!important;pointer-events:none!important;margin:0!important;padding:0!important;border:0!important;';
    const root = host.attachShadow({ mode: 'open' });
    const css = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .card {
        position: relative; display: flex; flex-direction: column; gap: 10px; overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: #fff; text-align: start;
        background: linear-gradient(135deg, #128a5f, #0a5240);
        padding: 13px 15px 14px; border-radius: 16px; min-width: 228px; max-width: 320px;
        box-shadow: 0 14px 38px rgba(0,0,0,.34); border: 1px solid rgba(255,255,255,.16);
        pointer-events: none; opacity: 0; transform: translateY(10px) scale(.98);
        transition: opacity .24s ease, transform .24s ease;
      }
      .card.show { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
      .card.paused { background: linear-gradient(135deg, #c25a23, #7c3312); }
      .crow { display: flex; align-items: center; gap: 12px; }
      .badge { flex: 0 0 auto; width: 38px; height: 38px; border-radius: 11px; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.16); box-shadow: inset 0 0 0 1px rgba(255,255,255,.18); }
      .badge img { width: 26px; height: 26px; border-radius: 7px; display: block; }
      .body { flex: 1 1 auto; min-width: 0; }
      .cbname { font-size: 10px; font-weight: 800; letter-spacing: 1.4px; text-transform: uppercase; opacity: .72; }
      .title { font-weight: 800; font-size: 15px; letter-spacing: .2px; margin-top: 2px; }
      .sub { font-size: 12px; opacity: .9; margin-top: 1px; }
      .resume { flex: 0 0 auto; align-self: center; font: 700 12px/1 inherit; color: #0a5240; background: #fff; border: 0; border-radius: 999px; padding: 9px 16px; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,.18); }
      .card.paused .resume { color: #7c3312; }
      .resume:hover { filter: brightness(.96); }
      .bar { height: 4px; border-radius: 999px; background: rgba(255,255,255,.22); overflow: hidden; }
      .bar > i { display: block; height: 100%; width: 100%; background: #fff; border-radius: 999px; transition: width .9s linear; }
      .pulse { animation: pulse 1s ease-in-out infinite; }
      @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .55 } }
    `;
    const barfill = mk('i');
    const bar = mk('div', { class: 'bar' }, barfill);
    const title = mk('div', { class: 'title', text: 'Prayer' });
    const sub = mk('div', { class: 'sub' });
    const cbname = mk('div', { class: 'cbname', text: 'Adhan Caster' });
    const cbicon = mk('img', { class: 'cbicon', alt: '' });
    const resume = mk('button', { class: 'resume' }, 'Resume');
    resume.hidden = true;
    const card = mk('div', { class: 'card' },
      mk('div', { class: 'crow' },
        mk('div', { class: 'badge' }, cbicon),
        mk('div', { class: 'body' }, cbname, title, sub),
        resume),
      bar);
    root.appendChild(mk('style', { text: css }));
    root.appendChild(card);
    (document.documentElement || document.body).appendChild(host);
    els = { card, cbname, title, sub, bar, barfill, resume };
    try { cbicon.src = chrome.runtime.getURL('icons/icon48.png'); } catch (_) {}
    resume.addEventListener('click', onResumeClick);
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
    const css = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .scrim { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #062a20; -webkit-backdrop-filter: blur(9px); backdrop-filter: blur(9px); opacity: 0; transition: opacity .35s ease; pointer-events: none; }
      .scrim.show { opacity: 1; pointer-events: auto; }
      .bg { position: absolute; inset: -25%; z-index: 0; pointer-events: none; background: radial-gradient(55% 55% at 50% 40%, rgba(20,160,111,.98), rgba(11,94,67,.92) 55%, rgba(6,42,32,1) 100%); animation: ccpBg 12s ease-in-out infinite; }
      .stars { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
      .star { position: absolute; border-radius: 50%; background: #fff; box-shadow: 0 0 6px rgba(255,255,255,.85); opacity: 0; animation-name: ccpFloat, ccpTwinkle; animation-timing-function: linear, ease-in-out; animation-iteration-count: infinite, infinite; }
      .fbrand { position: absolute; top: 46px; left: 50%; transform: translateX(-50%); z-index: 3; display: flex; align-items: center; gap: 10px; color: #fff; padding: 9px 16px 9px 11px; border-radius: 999px; background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.16); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); animation: ccpRise .6s ease both; }
      .fbrand img { width: 24px; height: 24px; border-radius: 7px; display: block; }
      .fbrand .fbname { font-size: 15px; font-weight: 700; letter-spacing: .3px; }
      .panel { position: relative; z-index: 2; text-align: center; color: #fff; padding: 28px; max-width: 480px; }
      .scrim.show .panel { animation: ccpRise .6s cubic-bezier(.2, .7, .2, 1) both; }
      .crescent-wrap { position: relative; display: inline-block; }
      .halo { position: absolute; top: 50%; left: 50%; width: 210px; height: 210px; pointer-events: none; transform: translate(-50%, -50%); border-radius: 50%; background: conic-gradient(from 0deg, rgba(255,255,255,0), rgba(255,255,255,.30), rgba(255,255,255,0) 50%, rgba(255,255,255,.22), rgba(255,255,255,0)); animation: ccpSpin 24s linear infinite; }
      .glow { position: absolute; top: 50%; left: 50%; width: 160px; height: 160px; pointer-events: none; transform: translate(-50%, -50%); border-radius: 50%; background: radial-gradient(circle, rgba(255,255,255,.5), rgba(255,255,255,0) 70%); animation: ccpGlow 5s ease-in-out infinite; }
      .crescent { position: relative; display: inline-block; font-size: 64px; line-height: 1; animation: ccpBreathe 5s ease-in-out infinite; }
      @keyframes ccpBg { 0%,100% { transform: scale(1); opacity: .92; } 50% { transform: scale(1.14); opacity: 1; } }
      @keyframes ccpFloat { from { transform: translateY(22px); } to { transform: translateY(-50px); } }
      @keyframes ccpTwinkle { 0%,100% { opacity: 0; } 50% { opacity: .92; } }
      @keyframes ccpSpin { to { transform: translate(-50%, -50%) rotate(360deg); } }
      @keyframes ccpGlow { 0%,100% { opacity: .35; transform: translate(-50%, -50%) scale(.9); } 50% { opacity: .7; transform: translate(-50%, -50%) scale(1.3); } }
      @keyframes ccpBreathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.08); } }
      @keyframes ccpRise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: translateY(0); } }
      @media (prefers-reduced-motion: reduce) {
        .bg, .halo, .glow, .crescent, .fbrand, .scrim.show .panel { animation: none !important; }
        .star { animation-name: ccpTwinkle !important; }
      }
      .ftitle { font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; opacity: .8; margin-top: 18px; }
      .fname { font-size: 44px; font-weight: 800; margin-top: 4px; }
      .ftime { font-size: 18px; opacity: .9; margin-top: 2px; }
      .fmsg { font-size: 15px; opacity: .85; margin-top: 16px; }
      .fauto { font-size: 13px; opacity: .7; margin-top: 18px; font-variant-numeric: tabular-nums; }
      .fresume { margin-top: 18px; border: 0; border-radius: 12px; cursor: pointer; font: 700 15px/1 inherit; color: #0a5c47; background: #fff; padding: 14px 30px; box-shadow: 0 8px 22px rgba(0,0,0,.22); }
      .fresume:hover { background: #eafaf2; }
      .fhint { font-size: 12px; opacity: .6; margin-top: 13px; }
    `;
    const fbicon = mk('img', { class: 'fbicon', alt: '' });
    const fbname = mk('span', { class: 'fbname', text: 'Adhan Caster' });
    const ftitle = mk('div', { class: 'ftitle', text: 'Time for prayer' });
    const fname = mk('div', { class: 'fname', text: 'Prayer' });
    const ftime = mk('div', { class: 'ftime' });
    const fmsg = mk('div', { class: 'fmsg', text: 'Media is paused. Take a moment for your prayer.' });
    const fauto = mk('div', { class: 'fauto' });
    const fresume = mk('button', { class: 'fresume' }, 'Resume');
    const fhint = mk('div', { class: 'fhint', text: 'Press Esc to resume' });
    const stars = mk('div', { class: 'stars' });
    const scrim = mk('div', { class: 'scrim', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Prayer focus' },
      mk('div', { class: 'bg' }),
      stars,
      mk('div', { class: 'fbrand' }, fbicon, fbname),
      mk('div', { class: 'panel' },
        mk('div', { class: 'crescent-wrap' }, mk('span', { class: 'halo' }), mk('span', { class: 'glow' }), mk('span', { class: 'crescent', text: '🕌' })),
        ftitle, fname, ftime, fmsg, fauto, fresume, fhint));
    root.appendChild(mk('style', { text: css }));
    root.appendChild(scrim);
    (document.documentElement || document.body).appendChild(fhost);
    // Scatter drifting, twinkling stars across the full screen.
    for (let i = 0; i < 36; i++) {
      const size = 1.5 + Math.random() * 3;
      const floatDur = 7 + Math.random() * 10;
      const twkDur = 3 + Math.random() * 4;
      stars.appendChild(
        mk('span', {
          class: 'star',
          style:
            `left:${(Math.random() * 100).toFixed(2)}%;top:${(Math.random() * 100).toFixed(2)}%;` +
            `width:${size.toFixed(1)}px;height:${size.toFixed(1)}px;` +
            `animation-duration:${floatDur.toFixed(1)}s,${twkDur.toFixed(1)}s;` +
            `animation-delay:${(-Math.random() * floatDur).toFixed(1)}s,${(-Math.random() * twkDur).toFixed(1)}s;`,
        })
      );
    }
    fels = { scrim, fbname, ftitle, fname, ftime, fmsg, fauto, fresume, fhint };
    try { fbicon.src = chrome.runtime.getURL('icons/icon48.png'); } catch (_) {}
    fresume.addEventListener('click', onFocusResume);
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
      els.title.textContent = name;
      els.sub.textContent = rem > 0 ? ti('auto_resumes_in', { time: fmtMMSS(rem) }) : ti('adhan_paused');
      els.sub.classList.remove('pulse');
      els.bar.style.display = 'none';
      els.resume.hidden = false;
    } else {
      els.card.classList.remove('paused');
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
