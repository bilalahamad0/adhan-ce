// Adhan Caster Pro — popup UI logic.
import { formatCountdown } from './lib/schedule.js';
import { searchPlaces } from './lib/geocode.js';
import { initI18n, setLang, t, getLang, applyStaticI18n, applyDir } from './lib/i18n.js';

const $ = (id) => document.getElementById(id);
let st = null;
let tickTimer = null;

// Live clock for the selected location (uses the location's timezone when known,
// so it reads the local time *there*, not just the machine clock).
function fmtClockNow(tz) {
  const opts = { hour: 'numeric', minute: '2-digit', second: '2-digit' };
  if (tz) opts.timeZone = tz;
  try {
    return new Date().toLocaleTimeString([], opts);
  } catch (_) {
    return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }
}
function updateClock() {
  const el = $('clock');
  if (el) el.textContent = '🕐 ' + fmtClockNow(st && st.schedule && st.schedule.tz);
}

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

// ---- location search (Open-Meteo geocoding) ----
// One field resolves city + state/province + country from a real place.
let selectedPlace = null; // {city,state,country,lat,lon,label} or null until a real place is picked
let searchTimer = null;
let searchAbort = null;

function placeLabel(p) {
  return [p.city, p.state, p.country].filter(Boolean).join(', ');
}

function renderCityResults(items) {
  const box = $('cityResults');
  box.innerHTML = '';
  if (!items.length) {
    box.hidden = true;
    return;
  }
  for (const p of items) {
    const div = document.createElement('div');
    div.className = 'suggest-item';
    div.textContent = p.label;
    div.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep focus so blur doesn't close before the click
      choosePlace(p);
    });
    box.appendChild(div);
  }
  box.hidden = false;
}

function choosePlace(p) {
  selectedPlace = p;
  $('city').value = p.label;
  $('locLabel').textContent = p.label;
  $('cityResults').hidden = true;
}

async function doCitySearch() {
  const q = $('city').value;
  selectedPlace = null; // typing invalidates a prior pick (forces re-validation)
  if (q.trim().length < 2) {
    $('cityResults').hidden = true;
    return;
  }
  try {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    const items = await searchPlaces(q, { signal: searchAbort.signal });
    renderCityResults(items.slice(0, 8));
  } catch (_) {
    /* aborted or offline — leave prior results */
  }
}

async function load() {
  st = await send({ type: 'GET_STATE' });
  renderAll();
}

function renderAll() {
  if (!st) return;
  const { settings, schedule, nextPrayer, paused } = st;

  updateClock();
  $('enabled').checked = settings.enabled !== false;
  $('focusMode').checked = settings.focusMode === true;
  // Treat the saved location as already selected so Save works without re-picking.
  const place = settings.city
    ? {
        city: settings.city,
        state: settings.state || '',
        country: settings.country || '',
        lat: settings.lat,
        lon: settings.lon,
      }
    : null;
  if (place) place.label = placeLabel(place);
  selectedPlace = place;
  $('city').value = place ? place.label : '';
  $('resumeMin').value = settings.autoResumeMinutes != null ? settings.autoResumeMinutes : 5;
  $('leadSeconds').value = String(settings.leadSeconds || 30);
  $('locLabel').textContent = place ? place.label : '—';

  if (paused && paused.active) {
    $('pausedBanner').hidden = false;
    $('pausedText').textContent = t('media_paused_for', {
      prayer: paused.prayer ? t('prayer_' + paused.prayer) : t('prayer_generic'),
    });
    $('focusBtn').hidden = paused.focus === true;
  } else {
    $('pausedBanner').hidden = true;
  }

  renderNext();
  renderList();

  $('updated').textContent =
    schedule && schedule.fetchedAt
      ? t('updated', {
          time: new Date(schedule.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })
      : '';
}

function renderNext() {
  const np = st.nextPrayer;
  if (!np) {
    $('nextName').textContent = '—';
    $('nextTime').textContent = t('no_schedule');
    $('nextCountdown').textContent = '';
    return;
  }
  $('nextName').textContent = t('prayer_' + np.name);
  $('nextTime').textContent = np.time;
  $('nextCountdown').textContent = t('next_in', { time: formatCountdown(np.ts - Date.now()) });
}

function renderList() {
  const wrap = $('list');
  wrap.innerHTML = '';
  const sched = st.schedule;
  if (!sched || !sched.prayers) return;
  const now = Date.now();
  const nextName = st.nextPrayer && st.nextPrayer.name;
  sched.prayers.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'row';
    const past = p.ts < now;
    if (past) row.classList.add('past');
    if (p.name === nextName) row.classList.add('next');
    const tomorrow = p.name === nextName && past;
    const pname = document.createElement('span');
    pname.className = 'pname';
    pname.textContent = t('prayer_' + p.name);
    const ptime = document.createElement('span');
    ptime.className = 'ptime';
    ptime.textContent = p.time;
    if (tomorrow) {
      const em = document.createElement('em');
      em.textContent = t('tomorrow');
      ptime.appendChild(document.createTextNode(' '));
      ptime.appendChild(em);
    }
    row.appendChild(pname);
    row.appendChild(ptime);
    wrap.appendChild(row);
    // Sunrise (Shuruq) — informational only, shown greyed right after Fajr.
    if (p.name === 'Fajr' && sched.sunrise) {
      const sr = document.createElement('div');
      sr.className = 'row sunrise';
      const sn = document.createElement('span');
      sn.className = 'pname';
      sn.textContent = t('sunrise');
      const stime = document.createElement('span');
      stime.className = 'ptime';
      stime.textContent = sched.sunrise.time;
      sr.appendChild(sn);
      sr.appendChild(stime);
      wrap.appendChild(sr);
    }
  });
}

function startTick() {
  stopTick();
  tickTimer = setInterval(() => {
    updateClock();
    if (st && st.nextPrayer) {
      $('nextCountdown').textContent = t('next_in', { time: formatCountdown(st.nextPrayer.ts - Date.now()) });
    }
  }, 1000);
}
function stopTick() {
  if (tickTimer) clearInterval(tickTimer);
}

$('resumeBtn').addEventListener('click', async () => {
  await send({ type: 'RESUME_NOW' });
  await load();
});

$('focusBtn').addEventListener('click', async () => {
  await send({ type: 'FOCUS_NOW' });
  await load();
});

$('testBtn').addEventListener('click', async () => {
  $('testMsg').textContent = '';
  const res = await send({ type: 'TEST_ADHAN', seconds: 30 });
  if (res && res.ok) {
    $('testMsg').textContent = t('test_started');
    setTimeout(() => ($('testMsg').textContent = ''), 6000);
  } else {
    $('testMsg').textContent = (res && res.error) || t('unavailable');
  }
});

$('save').addEventListener('click', async () => {
  // Require a real, geocoded place — blocks invalid combos like "Sunnyvale, Morocco".
  if (!selectedPlace || $('city').value.trim() !== selectedPlace.label) {
    $('saveMsg').textContent = t('pick_location');
    $('city').focus();
    setTimeout(() => ($('saveMsg').textContent = ''), 3000);
    return;
  }
  const settings = {
    enabled: $('enabled').checked,
    focusMode: $('focusMode').checked,
    country: selectedPlace.country || 'United States',
    state: selectedPlace.state || '',
    city: selectedPlace.city,
    lat: selectedPlace.lat,
    lon: selectedPlace.lon,
    autoResumeMinutes: Math.max(0, parseInt($('resumeMin').value, 10) || 5),
    leadSeconds: parseInt($('leadSeconds').value, 10) || 30,
  };
  $('save').disabled = true;
  $('save').textContent = t('saving');
  const res = await send({ type: 'SAVE_SETTINGS', settings });
  $('save').disabled = false;
  $('save').textContent = t('save');
  if (res && res.ok) {
    $('saveMsg').textContent = t('saved');
    await load();
  } else {
    $('saveMsg').textContent = res && res.error ? t('error_detail', { msg: res.error }) : t('error');
  }
  setTimeout(() => ($('saveMsg').textContent = ''), 2500);
});

$('gear').addEventListener('click', () => {
  $('settings').hidden = !$('settings').hidden;
});

$('refresh').addEventListener('click', async (e) => {
  e.preventDefault();
  $('refresh').textContent = t('refreshing');
  await send({ type: 'REFRESH' });
  await load();
  $('refresh').textContent = t('refresh');
});

// The Test Adhan trigger is a dev-only affordance; hidden in store-installed builds.
// Also stamp the footer with the running release version straight from the manifest.
try {
  const mf = chrome.runtime.getManifest();
  document.querySelector('.dev-row').hidden = 'update_url' in mf;
  $('version').textContent = 'v' + mf.version;
} catch (_) {}

// Debounced location autocomplete (Open-Meteo geocoding).
$('city').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doCitySearch, 300);
});
$('city').addEventListener('focus', (e) => {
  e.target.select(); // select the resolved label so typing replaces it
  if ($('cityResults').children.length) $('cityResults').hidden = false;
});
$('city').addEventListener('blur', () => setTimeout(() => ($('cityResults').hidden = true), 150));

// Language picker: switch + persist, flip RTL/LTR, re-translate static + dynamic.
$('lang').addEventListener('change', async (e) => {
  await setLang(e.target.value);
  applyDir(document);
  applyStaticI18n(document);
  renderAll();
});

async function start() {
  await initI18n();
  applyDir(document);
  applyStaticI18n(document);
  $('lang').value = getLang();
  await load();
  startTick();
}
start();
