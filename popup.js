// Adhan Caster — popup UI logic.
// A fixed-frame popup with three tabbed views (Home / Tracker / Settings) that
// swap in place (the popup never resizes), an SVG analog clock that ticks in the
// selected location's timezone, an Appearance control (System / Light / Dark), a
// prayer-log Tracker (check-offs + streaks + a month heatmap), and on-device
// Hijri dates. Pure helpers live in ./lib.
import { formatCountdown, ymd, PRAYER_ORDER } from './lib/schedule.js';
import { dayCount, totalLogged, completeStreak, daysInMonth, firstWeekday, addMonths, monthKey } from './lib/tracker.js';
import { searchPlaces } from './lib/geocode.js';
import { initI18n, setLang, t, getLang, applyStaticI18n, applyDir } from './lib/i18n.js';
import { formatHijri } from './lib/hijri.js';

const $ = (id) => document.getElementById(id);
let st = null;
let tickTimer = null;

const send = (msg) => chrome.runtime.sendMessage(msg);
const localeFor = () => getLang() || 'en';

// Aladhan calculation methods (id → label). Default stays 2 (ISNA) so existing
// users' prayer times don't shift.
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

// ───────────────────────────── appearance / theme ─────────────────────────
// Persisted UI prefs (local-only; the worker doesn't need them).
async function getPref(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] != null ? o[key] : fallback;
}
function applyAppearance(mode) {
  document.documentElement.setAttribute('data-theme', mode || 'system');
}
function applyClockStyle(style) {
  const c = $('clock');
  if (!c) return;
  c.classList.toggle('is-digital', style === 'digital');
  c.classList.toggle('is-analog', style !== 'digital');
}

// A segmented control: highlight the active option and slide the pill to it.
function initSeg(id, value, onPick) {
  const seg = $(id);
  if (!seg) return;
  const opts = [...seg.querySelectorAll('.seg-opt')];
  const setActive = (val) => {
    let idx = 0;
    opts.forEach((o, i) => {
      const on = o.dataset.val === val;
      o.classList.toggle('is-active', on);
      o.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) idx = i;
    });
    seg.style.setProperty('--i', String(idx));
  };
  setActive(value);
  opts.forEach((o) =>
    o.addEventListener('click', () => {
      setActive(o.dataset.val);
      onPick(o.dataset.val);
    })
  );
}

// ───────────────────────────── analog clock ───────────────────────────────
function buildClockFace() {
  const el = $('clock');
  if (!el) return;
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const maj = i % 5 === 0;
    const a = (i / 60) * Math.PI * 2;
    const r1 = maj ? 78 : 83;
    const r2 = 88;
    const x1 = (100 + r1 * Math.sin(a)).toFixed(1);
    const y1 = (100 - r1 * Math.cos(a)).toFixed(1);
    const x2 = (100 + r2 * Math.sin(a)).toFixed(1);
    const y2 = (100 - r2 * Math.cos(a)).toFixed(1);
    ticks += `<line class="cf-tick${maj ? ' maj' : ''}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;
  }
  el.innerHTML =
    `<svg class="clock-face" viewBox="0 0 200 200" role="img" aria-label="Clock">` +
    `<circle class="cf-track" cx="100" cy="100" r="92"/>` +
    `<circle class="cf-prog" id="ringFg" cx="100" cy="100" r="92" transform="rotate(-90 100 100)"/>` +
    `<g class="cf-ticks">${ticks}</g>` +
    `<line class="cf-hand cf-hour" id="handHour" x1="100" y1="110" x2="100" y2="52"/>` +
    `<line class="cf-hand cf-min" id="handMin" x1="100" y1="113" x2="100" y2="36"/>` +
    `<line class="cf-hand cf-sec" id="handSec" x1="100" y1="116" x2="100" y2="30"/>` +
    `<circle class="cf-cap" cx="100" cy="100" r="5.5"/>` +
    `<circle class="cf-cap-gold" cx="100" cy="100" r="2.5"/>` +
    `</svg>` +
    `<div class="clock-digital" id="clockDigital"></div>`;
}

function clockParts(tz) {
  const opts = { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };
  if (tz) opts.timeZone = tz;
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(new Date());
  } catch (_) {
    parts = new Intl.DateTimeFormat('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date());
  }
  const g = (type) => Number((parts.find((p) => p.type === type) || {}).value || 0);
  return { h: g('hour') % 12, m: g('minute'), s: g('second') };
}
function fmtDigital(tz, withSeconds) {
  const opts = { hour: 'numeric', minute: '2-digit', hour12: true };
  if (withSeconds) opts.second = '2-digit';
  if (tz) opts.timeZone = tz;
  try {
    return new Date().toLocaleTimeString('en-US', opts);
  } catch (_) {
    return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
}

// Fraction (0..1) of the interval between the previous prayer and the next one.
function nextFraction() {
  if (!st || !st.nextPrayer || !st.schedule || !st.schedule.prayers) return 0;
  const now = Date.now();
  const np = st.nextPrayer;
  let prev = null;
  for (const p of st.schedule.prayers) if (p.ts <= now) prev = p.ts;
  if (prev == null) prev = np.ts - 6 * 3600e3;
  const span = np.ts - prev;
  if (span <= 0) return 0;
  return Math.min(1, Math.max(0, (now - prev) / span));
}

const CIRC = 2 * Math.PI * 92;

function updateClock() {
  const tz = st && st.schedule && st.schedule.tz;
  const digital = $('clock') && $('clock').classList.contains('is-digital');

  const { h, m, s } = clockParts(tz);
  const setHand = (id, deg) => {
    const el = $(id);
    if (el) el.setAttribute('transform', `rotate(${deg.toFixed(2)} 100 100)`);
  };
  setHand('handHour', h * 30 + m * 0.5);
  setHand('handMin', m * 6 + s * 0.1);
  setHand('handSec', s * 6);

  const ring = $('ringFg');
  if (ring) {
    ring.style.strokeDasharray = String(CIRC);
    ring.style.strokeDashoffset = String(CIRC * (1 - nextFraction()));
  }

  const dig = $('clockDigital');
  if (dig) {
    if (digital) {
      const str = fmtDigital(tz, false);
      const mt = str.match(/^(.*?)\s*([AP]M)$/i);
      dig.innerHTML = mt ? `${mt[1]}<span class="ampm">${mt[2]}</span>` : str;
    } else {
      dig.textContent = fmtDigital(tz, true);
    }
  }
}

// ───────────────────────────── view router ────────────────────────────────
const trackerActive = () => $('view-tracker') && $('view-tracker').classList.contains('is-active');

function showView(name) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('is-active', v.dataset.view === name));
  document.querySelectorAll('.tab').forEach((tb) => {
    const on = tb.dataset.tab === name;
    tb.classList.toggle('is-active', on);
    tb.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (name === 'tracker') openTracker();
}

// ───────────────────────────── location search ────────────────────────────
let selectedPlace = null;
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
      e.preventDefault();
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
  selectedPlace = null;
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
    /* aborted or offline */
  }
}

// ───────────────────────────── state + render ─────────────────────────────
async function load() {
  st = await send({ type: 'GET_STATE' });
  renderAll();
}

function renderAll() {
  if (!st) return;
  const { settings, schedule, paused } = st;

  $('enabled').checked = settings.enabled !== false;
  $('focusMode').checked = settings.focusMode === true;
  $('method').value = String(settings.method != null ? settings.method : 2);
  $('school').value = String(settings.school != null ? settings.school : 0);
  $('showHijri').checked = settings.showHijri !== false;
  $('hijriOffset').value = String(settings.hijriOffset || 0);

  const place = settings.city
    ? { city: settings.city, state: settings.state || '', country: settings.country || '', lat: settings.lat, lon: settings.lon }
    : null;
  if (place) place.label = placeLabel(place);
  selectedPlace = place;
  $('city').value = place ? place.label : '';
  $('resumeMin').value = settings.autoResumeMinutes != null ? settings.autoResumeMinutes : 5;
  $('leadSeconds').value = String(settings.leadSeconds || 30);
  $('locLabel').textContent = place ? place.label : '—';

  // Header date (Gregorian) in the location's timezone. The Hijri date lives in
  // the Tracker (not the header).
  try {
    const tz = schedule && schedule.tz;
    $('headDate').textContent = new Intl.DateTimeFormat(localeFor(), {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: tz || undefined,
    }).format(new Date());
  } catch (_) {}

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
  updateClock();
  if (trackerActive()) renderTracker();

  $('updated').textContent =
    schedule && schedule.fetchedAt
      ? t('updated', { time: new Date(schedule.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
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

const SVG_NS = 'http://www.w3.org/2000/svg';
function ico(paths, cls) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'pico ' + (cls || ''));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.innerHTML = paths;
  return svg;
}
const ICO_SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>';
const ICO_DOT = '<circle cx="12" cy="12" r="3.4"/>';

function renderList() {
  const wrap = $('list');
  wrap.innerHTML = '';
  const sched = st.schedule;
  if (!sched || !sched.prayers) return;
  const now = Date.now();
  const nextName = st.nextPrayer && st.nextPrayer.name;

  const makeRow = (cls, icon, name, time, { tomorrow = false, prayer = null } = {}) => {
    const row = document.createElement('div');
    row.className = 'row' + (cls ? ' ' + cls : '');
    row.appendChild(icon);
    const pn = document.createElement('span');
    pn.className = 'pname';
    pn.textContent = name;
    row.appendChild(pn);
    const pt = document.createElement('span');
    pt.className = 'ptime';
    pt.textContent = time;
    if (tomorrow) {
      const em = document.createElement('span');
      em.className = 'em';
      em.textContent = t('tomorrow');
      pt.appendChild(document.createTextNode(' '));
      pt.appendChild(em);
    }
    row.appendChild(pt);
    // Prayed check-off (sunrise gets an empty spacer to keep the columns aligned).
    const pcheck = document.createElement('span');
    pcheck.className = 'pcheck';
    if (prayer) {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = prayedToday(prayer);
      cb.disabled = prayerLocked(logToday(), prayer); // upcoming prayer — not yet markable
      cb.setAttribute('aria-label', t('mark_prayed', { prayer: name }));
      cb.addEventListener('change', () => togglePrayer(logToday(), prayer));
      pcheck.appendChild(cb);
    }
    row.appendChild(pcheck);
    wrap.appendChild(row);
  };

  sched.prayers.forEach((p) => {
    const past = p.ts < now;
    const isNext = p.name === nextName;
    const cls = [past ? 'past' : '', isNext ? 'next' : ''].filter(Boolean).join(' ');
    makeRow(cls, ico(ICO_DOT), t('prayer_' + p.name), p.time, { tomorrow: isNext && past, prayer: p.name });
    if (p.name === 'Fajr' && sched.sunrise) {
      makeRow('sunrise', ico(ICO_SUN), t('sunrise'), sched.sunrise.time, {});
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

// ───────────────────────────── prayer tracking ────────────────────────────
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
  renderList();
  if (trackerActive()) renderTracker();
}

function fmtLogDate(date) {
  try {
    return new Date(date + 'T12:00:00').toLocaleDateString(localeFor(), { weekday: 'short', month: 'short', day: 'numeric' });
  } catch (_) {
    return date;
  }
}
// ───────────────────────────── tracker (month heatmap) ────────────────────
let viewYM = null; // { year, month } currently shown
let selDate = null; // selected day (YYYY-MM-DD) whose detail strip is shown

// Sunday-first narrow weekday initials in the active locale (2023-01-01 = Sunday).
function weekdayLabels() {
  const fmt = new Intl.DateTimeFormat(localeFor(), { weekday: 'narrow' });
  const out = [];
  for (let i = 0; i < 7; i++) out.push(fmt.format(new Date(2023, 0, 1 + i)));
  return out;
}
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
  const showH = !st || !st.settings || st.settings.showHijri !== false;
  const off = (st && st.settings && st.settings.hijriOffset) || 0;
  const tp = parseYmd(today);
  const curYM = { year: tp.year, month: tp.month };
  const ip = parseYmd(st && st.installedAt ? ymd(new Date(st.installedAt)) : today);
  const instYM = { year: ip.year, month: ip.month };
  if (!viewYM) viewYM = curYM;

  const streak = completeStreak(log, today);
  const total = totalLogged(log);
  $('trackerStreak').textContent = streak > 0 ? t('streak_days', { n: streak }) : total > 0 ? t('total_logged', { n: total }) : '';

  $('calLabel').textContent = new Intl.DateTimeFormat(localeFor(), { month: 'long', year: 'numeric' }).format(new Date(viewYM.year, viewYM.month, 1));
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
    $('ddHijri').textContent = showH ? formatHijri(selDate + 'T12:00:00', localeFor(), off) : '';
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

// ───────────────────────────── wiring ─────────────────────────────────────
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
$('refresh').addEventListener('click', async (e) => {
  e.preventDefault();
  $('refresh').textContent = t('refreshing');
  await send({ type: 'REFRESH' });
  await load();
  $('refresh').textContent = t('refresh');
});

// Tabs
document.querySelectorAll('.tab').forEach((tb) => tb.addEventListener('click', () => showView(tb.dataset.tab)));

// Click (or Enter/Space on) the clock to flip analog ↔ digital — routed through
// the Settings control so the two stay in sync and the choice is persisted.
function toggleClock() {
  const next = $('clock').classList.contains('is-digital') ? 'analog' : 'digital';
  const opt = document.querySelector(`#clockStyle [data-val="${next}"]`);
  if (opt) opt.click();
}
$('clock').addEventListener('click', toggleClock);
$('clock').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    toggleClock();
  }
});

// Tracker month navigation
$('calPrev').addEventListener('click', () => {
  if (!$('calPrev').disabled) stepMonth(-1);
});
$('calNext').addEventListener('click', () => {
  if (!$('calNext').disabled) stepMonth(1);
});

// Location autocomplete
$('city').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(doCitySearch, 300);
});
$('city').addEventListener('focus', (e) => {
  e.target.select();
  if ($('cityResults').children.length) $('cityResults').hidden = false;
});
$('city').addEventListener('blur', () => setTimeout(() => ($('cityResults').hidden = true), 150));

// Language picker
$('lang').addEventListener('change', async (e) => {
  await setLang(e.target.value);
  applyDir(document);
  applyStaticI18n(document);
  renderAll();
  if (trackerActive()) renderTracker();
});

// Dev-only test affordance + version stamp.
try {
  const mf = chrome.runtime.getManifest();
  document.querySelector('.dev-row').hidden = 'update_url' in mf;
  $('version').textContent = 'v' + mf.version;
} catch (_) {}

// ───────────────────────────── start ──────────────────────────────────────
async function start() {
  // Theme first to minimize any flash before the rest renders.
  const [appearance, clockStyle] = await Promise.all([getPref('appearance', 'system'), getPref('clockStyle', 'analog')]);
  applyAppearance(appearance);

  await initI18n();
  applyDir(document);
  applyStaticI18n(document);
  $('lang').value = getLang();
  populateMethods();

  // Reveal all views to the router (CSS .is-active controls visibility now).
  document.querySelectorAll('.view[hidden]').forEach((v) => v.removeAttribute('hidden'));

  buildClockFace();
  applyClockStyle(clockStyle);

  initSeg('appearance', appearance, (val) => {
    applyAppearance(val);
    chrome.storage.local.set({ appearance: val });
  });
  initSeg('clockStyle', clockStyle, (val) => {
    applyClockStyle(val);
    chrome.storage.local.set({ clockStyle: val });
    updateClock();
  });

  await load();
  startTick();
}
start();
