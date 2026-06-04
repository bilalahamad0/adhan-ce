// Adhan Caster Pro — popup UI logic.
import { formatCountdown, ymd, PRAYER_ORDER } from './lib/schedule.js';
import { dayCount, totalLogged, completeStreak, daysInMonth, firstWeekday, addMonths, monthKey } from './lib/tracker.js';
import { searchPlaces } from './lib/geocode.js';
import { initI18n, setLang, t, getLang, applyStaticI18n, applyDir } from './lib/i18n.js';
import { formatHijri } from './lib/hijri.js';

const $ = (id) => document.getElementById(id);
let st = null;
let tickTimer = null;

// Aladhan calculation methods (id → label). Method 6 doesn't exist; 99 (custom)
// is deferred. Default stays 2 (ISNA) so existing users' prayer times don't shift.
const METHODS = [
  { id: 2, name: 'ISNA — Islamic Society of North America' },
  { id: 3, name: 'Muslim World League' },
  { id: 1, name: 'University of Islamic Sciences, Karachi' },
  { id: 4, name: 'Umm al-Qura University, Makkah' },
  { id: 5, name: 'Egyptian General Authority of Survey' },
  { id: 0, name: 'Shia Ithna-Ashari (Jafari)' },
  { id: 7, name: 'University of Tehran' },
  { id: 8, name: 'Gulf Region' },
  { id: 9, name: 'Kuwait' },
  { id: 10, name: 'Qatar' },
  { id: 11, name: 'Singapore (MUIS)' },
  { id: 12, name: 'France (UOIF)' },
  { id: 13, name: 'Turkey (Diyanet)' },
  { id: 14, name: 'Russia' },
  { id: 15, name: 'Moonsighting Committee Worldwide' },
  { id: 16, name: 'Dubai' },
  { id: 17, name: 'Malaysia (JAKIM)' },
  { id: 18, name: 'Tunisia' },
  { id: 19, name: 'Algeria' },
  { id: 20, name: 'Indonesia (Kemenag)' },
  { id: 21, name: 'Morocco' },
  { id: 22, name: 'Portugal (Lisbon)' },
  { id: 23, name: 'Jordan' },
];

// Fill the calculation-method <select> once (labels are proper names, not i18n'd).
function populateMethods() {
  const sel = $('method');
  if (!sel || sel.options.length) return;
  for (const m of METHODS) {
    const opt = document.createElement('option');
    opt.value = String(m.id);
    opt.textContent = m.name;
    sel.appendChild(opt);
  }
}

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
  $('method').value = String(settings.method != null ? settings.method : 2);
  $('school').value = String(settings.school != null ? settings.school : 0);
  $('showHijri').checked = settings.showHijri !== false;
  $('hijriOffset').value = String(settings.hijriOffset || 0);
  const hijriShown = settings.showHijri !== false;
  const hijriTxt = hijriShown ? formatHijri(new Date(), getLang(), settings.hijriOffset || 0) : '';
  $('hijriLabel').textContent = hijriTxt ? '🌙 ' + hijriTxt : '';
  $('hijriLabel').hidden = !hijriTxt;
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
  if (!$('tracker').hidden) renderTracker();
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
    const pcheck = document.createElement('span');
    pcheck.className = 'pcheck';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = prayedToday(p.name);
    // Can't mark a prayer before its time has come — only past/current prayers today.
    cb.disabled = p.ts > Date.now();
    cb.setAttribute('aria-label', t('mark_prayed', { prayer: t('prayer_' + p.name) }));
    cb.addEventListener('change', () => togglePrayer(logToday(), p.name));
    pcheck.appendChild(cb);
    row.appendChild(pcheck);
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
      const ssp = document.createElement('span'); // keep the time column aligned with checkbox rows
      ssp.className = 'pcheck';
      sr.appendChild(ssp);
      wrap.appendChild(sr);
    }
  });
}

// ---- prayer tracking ----
const pad2 = (n) => String(n).padStart(2, '0');
// "Today" for the log = the day the displayed schedule is for (else the local date).
function logToday() {
  return (st && st.schedule && st.schedule.date) || ymd();
}
function ymdParts(year, month, day) {
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}
function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}
function prayedToday(name) {
  const day = ((st && st.prayerLog) || {})[logToday()] || {};
  return !!day[name];
}
// A prayer is "locked" (not yet markable) only while it's still upcoming TODAY,
// judged by the loaded schedule's per-prayer times. Past days are always editable.
function prayerLocked(date, name) {
  if (date !== logToday()) return false;
  const p = st && st.schedule && st.schedule.prayers && st.schedule.prayers.find((x) => x.name === name);
  return !!(p && p.ts > Date.now());
}
async function togglePrayer(date, name) {
  if (prayerLocked(date, name)) return;
  const res = await send({ type: 'TOGGLE_PRAYER', date, prayer: name });
  if (res && res.ok) st.prayerLog = res.prayerLog;
  renderList(); // reflect the stored state (reverts the box if the write failed)
  if (!$('tracker').hidden) renderTracker();
}

function fmtLogDate(date) {
  try {
    return new Date(date + 'T12:00:00').toLocaleDateString(getLang(), { weekday: 'short', month: 'short', day: 'numeric' });
  } catch (_) {
    return date;
  }
}

// ---- calendar view ----
let viewYM = null; // { year, month } currently shown
let selDate = null; // selected day (YYYY-MM-DD) whose detail strip is shown

// Sunday-first narrow weekday initials in the active locale (2023-01-01 = Sunday).
function weekdayLabels() {
  const fmt = new Intl.DateTimeFormat(getLang(), { weekday: 'narrow' });
  const out = [];
  for (let i = 0; i < 7; i++) out.push(fmt.format(new Date(2023, 0, 1 + i)));
  return out;
}
// When switching months, select the latest non-future day of that month.
function defaultSel(ym) {
  const last = ymdParts(ym.year, ym.month, daysInMonth(ym.year, ym.month));
  return last <= logToday() ? last : logToday();
}
function openTracker() {
  const t0 = parseYmd(logToday());
  viewYM = { year: t0.year, month: t0.month };
  selDate = logToday();
  renderTracker();
}
function stepMonth(delta) {
  viewYM = addMonths(viewYM, delta);
  selDate = defaultSel(viewYM);
  renderTracker();
}

function renderTracker() {
  const today = logToday();
  const log = (st && st.prayerLog) || {};
  const tp = parseYmd(today);
  const curYM = { year: tp.year, month: tp.month };
  const ip = parseYmd(st && st.installedAt ? ymd(new Date(st.installedAt)) : today);
  const instYM = { year: ip.year, month: ip.month };
  if (!viewYM) viewYM = curYM;

  const streak = completeStreak(log, today);
  const total = totalLogged(log);
  $('trackerStreak').textContent = streak > 0 ? t('streak_days', { n: streak }) : total > 0 ? t('total_logged', { n: total }) : '';

  $('calLabel').textContent = new Intl.DateTimeFormat(getLang(), { month: 'long', year: 'numeric' }).format(new Date(viewYM.year, viewYM.month, 1));
  $('calPrev').disabled = monthKey(viewYM) <= monthKey(instYM);
  $('calNext').disabled = monthKey(viewYM) >= monthKey(curYM);

  const grid = $('calGrid');
  grid.innerHTML = '';
  for (const w of weekdayLabels()) {
    const wd = document.createElement('div');
    wd.className = 'cal-wd';
    wd.textContent = w;
    grid.appendChild(wd);
  }
  for (let i = 0; i < firstWeekday(viewYM.year, viewYM.month); i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day empty';
    grid.appendChild(blank);
  }
  const dim = daysInMonth(viewYM.year, viewYM.month);
  for (let d = 1; d <= dim; d++) {
    const date = ymdParts(viewYM.year, viewYM.month, d);
    const future = date > today;
    const cell = document.createElement('div');
    cell.className = 'cal-day ' + (future ? 'future' : 'lvl-' + dayCount(log, date));
    if (date === today) cell.classList.add('today');
    if (date === selDate) cell.classList.add('sel');
    cell.textContent = String(d);
    if (!future) cell.addEventListener('click', () => { selDate = date; renderTracker(); });
    grid.appendChild(cell);
  }

  const detail = $('dayDetail');
  detail.hidden = !selDate;
  if (selDate) {
    $('ddDate').textContent = `${fmtLogDate(selDate)} · ${dayCount(log, selDate)}/${PRAYER_ORDER.length}`;
    const wrap = $('ddPrayers');
    wrap.innerHTML = '';
    const day = log[selDate] || {};
    for (const name of PRAYER_ORDER) {
      const locked = prayerLocked(selDate, name);
      const cell = document.createElement('div');
      cell.className = 'dd-p' + (day[name] ? ' on' : '') + (locked ? ' locked' : '');
      cell.textContent = t('prayer_' + name);
      if (!locked) cell.addEventListener('click', () => togglePrayer(selDate, name));
      wrap.appendChild(cell);
    }
  }
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
  const method = parseInt($('method').value, 10);
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
    method: Number.isFinite(method) ? method : 2,
    school: parseInt($('school').value, 10) === 1 ? 1 : 0,
    showHijri: $('showHijri').checked,
    hijriOffset: parseInt($('hijriOffset').value, 10) || 0,
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
  const show = $('settings').hidden;
  $('settings').hidden = !show;
  if (show) $('tracker').hidden = true; // don't stack both panels
});

$('logBtn').addEventListener('click', () => {
  const show = $('tracker').hidden;
  $('tracker').hidden = !show;
  if (show) {
    $('settings').hidden = true;
    openTracker();
  }
});
$('calPrev').addEventListener('click', () => {
  if (!$('calPrev').disabled) stepMonth(-1);
});
$('calNext').addEventListener('click', () => {
  if (!$('calNext').disabled) stepMonth(1);
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
  populateMethods();
  await load();
  startTick();
}
start();
