/* ==========================================================================
   Ωρολόγιο Πρόγραμμα — 7ο ΓΕΛ Ηρακλείου
   Vanilla JS, no build step. Merges a student's section + orientation track +
   elective groups into one timetable and highlights the running period.
   ========================================================================== */
'use strict';

/* -------------------------------------------------------------- configuration */

const APP_VERSION = '1.2.0';

/* Where to look for a newer schedule. Point this at a raw file URL (e.g.
   https://raw.githubusercontent.com/<user>/<repo>/main/data/schedule.json) when
   you want to publish schedule updates without redeploying the app. Leaving it
   as the bundled path simply means updates arrive with each deploy. */
const REMOTE_SCHEDULE_URL = 'data/schedule.json';
const BUNDLED_SCHEDULE_URL = 'data/schedule.json';

const SCHEMA_VERSION = 1;
const KEY_SELECTION = 'gel7.selection.v1';
const KEY_SCHEDULE = 'gel7.schedule.v1';
const KEY_DISMISSED = 'gel7.dismissed.v1';
const KEY_LAST_CHECK = 'gel7.lastcheck.v1';

/* Background checks are cheap (a 304 is header-only) but not free, and a student
   switches back into the app dozens of times a day. Once every half hour is
   plenty for a schedule that changes a handful of times a year. */
const CHECK_INTERVAL_MS = 30 * 60 * 1000;

const DAY_SHORT = ['Δευ', 'Τρί', 'Τετ', 'Πέμ', 'Παρ', 'Σάβ', 'Κυρ'];

/* -------------------------------------------------------------------- state */

const state = {
  schedule: null,
  selection: null,
  grid: null,
  conflicts: [],
  view: 'today',
  weekDay: 0,
  weekDayPinned: false,
  showGrid: false,
  draft: null,
  deferredInstall: null,
};

const $ = (id) => document.getElementById(id);

/* --------------------------------------------------------------------- time */

/* `?now=2026-09-16T10:20` freezes the clock. Without a way to pin the time,
   the live-highlighting logic can only be tested by waiting for the school day. */
const frozen = (() => {
  const raw = new URLSearchParams(location.search).get('now');
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d) ? null : d;
})();

const now = () => (frozen ? new Date(frozen) : new Date());

/** Monday = 0 … Sunday = 6, matching the `d` index used in schedule.json. */
const dayIndex = (date) => (date.getDay() + 6) % 7;

/** "08:15" -> minutes since midnight. */
function hm(text) {
  const [h, m] = String(text).split(':').map(Number);
  return h * 60 + m;
}

function clockText(mins) {
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Greek plural-aware "σε 5 λεπτά" / "σε 1 ώρα και 5 λεπτά". */
function durationText(minutes) {
  const total = Math.max(0, Math.round(minutes));
  if (total < 1) return 'σε λίγο';
  if (total < 60) return `σε ${total} ${total === 1 ? 'λεπτό' : 'λεπτά'}`;
  const h = Math.floor(total / 60), m = total % 60;
  const hp = `${h} ${h === 1 ? 'ώρα' : 'ώρες'}`;
  return m ? `σε ${hp} και ${m} ${m === 1 ? 'λεπτό' : 'λεπτά'}` : `σε ${hp}`;
}

function dateText(date) {
  return date.toLocaleDateString('el-GR', { weekday: 'long', day: 'numeric', month: 'long' });
}

/* ------------------------------------------------------------------ storage */

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    /* Private mode or a full quota — the app still works for this session. */
  }
}

/* --------------------------------------------------- schedule load + validate */

const TIME_PATTERN = /^\d{2}:\d{2}$/;

/** Throws if the payload could not safely drive the UI. Never adopt unvalidated
    data: a truncated or wrong-schema fetch would otherwise blank the timetable. */
function validateSchedule(data) {
  const fail = (why) => { throw new Error(`Μη έγκυρο πρόγραμμα: ${why}`); };

  if (!data || typeof data !== 'object') fail('δεν είναι αντικείμενο');
  if (data.schemaVersion !== SCHEMA_VERSION) {
    fail(`schemaVersion ${data.schemaVersion} αντί για ${SCHEMA_VERSION}`);
  }
  if (!Array.isArray(data.days) || !data.days.length) fail('λείπουν οι ημέρες');
  if (!Array.isArray(data.periods) || !data.periods.length) fail('λείπουν οι ώρες');
  for (const p of data.periods) {
    if (!TIME_PATTERN.test(p.start) || !TIME_PATTERN.test(p.end)) {
      fail(`κακή ώρα «${p.start}–${p.end}»`);
    }
  }
  if (!data.groups || typeof data.groups !== 'object') fail('λείπουν τα τμήματα');
  const names = Object.keys(data.groups);
  if (!names.length) fail('κανένα τμήμα');
  for (const name of names) {
    const g = data.groups[name];
    if (!g || !Array.isArray(g.lessons)) fail(`το τμήμα «${name}» δεν έχει μαθήματα`);
    for (const l of g.lessons) {
      if (typeof l.d !== 'number' || typeof l.p !== 'number' || !l.subject) {
        fail(`χαλασμένο μάθημα στο «${name}»`);
      }
    }
  }
  if (!names.some((n) => data.groups[n].lessons.length)) fail('όλα τα τμήματα είναι άδεια');
  return data;
}

/** Sort key for "which of these two schedules is the newer one". */
function stamp(schedule) {
  if (!schedule) return '';
  return `${schedule.version || ''}|${schedule.generatedAt || ''}`;
}

function isNewer(candidate, current) {
  if (!current) return true;
  const a = Date.parse(candidate.generatedAt), b = Date.parse(current.generatedAt);
  if (!isNaN(a) && !isNaN(b) && a !== b) return a > b;
  return String(candidate.version) > String(current.version);
}

/** Errors carry `kind` so callers can tell "you're offline" from "the file the
    school published is broken" — very different things to tell a student. */
function tagged(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

async function fetchSchedule(url) {
  let res;
  try {
    // 'no-cache' still revalidates on every call, but sends If-None-Match, so an
    // unchanged schedule comes back as a 304 with no body instead of ~7 KB.
    // 'no-store' would skip the validator entirely and re-download every time.
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw tagged('network', err.message);
  }
  if (!res.ok) throw tagged('network', `HTTP ${res.status}`);

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    throw tagged('data', 'το αρχείο δεν είναι έγκυρο JSON');
  }
  try {
    return validateSchedule(payload);
  } catch (err) {
    throw tagged('data', err.message);
  }
}

/** The schedule to start from, and whether that already cost a network round
    trip to REMOTE_SCHEDULE_URL (so boot can skip an immediate duplicate check).

    A stored copy is used as-is: it renders instantly with no network at all, and
    the background update check picks up anything newer a moment later. */
async function loadInitialSchedule() {
  try {
    const raw = load(KEY_SCHEDULE, null);
    if (raw) return { schedule: validateSchedule(raw), fetchedRemote: false };
  } catch (err) {
    localStorage.removeItem(KEY_SCHEDULE);
  }

  const bundled = await fetchSchedule(BUNDLED_SCHEDULE_URL);
  save(KEY_SCHEDULE, bundled);
  return {
    schedule: bundled,
    fetchedRemote: BUNDLED_SCHEDULE_URL === REMOTE_SCHEDULE_URL,
  };
}

/* ------------------------------------------------------------------- merging */

/** Union the selected groups into a [day][period] grid, recording any slot
    where two of them collide instead of letting one silently win. */
function buildGrid(schedule, selection) {
  const ids = selectedGroupIds(selection).filter((id) => schedule.groups[id]);
  const grid = schedule.days.map(() => schedule.periods.map(() => null));
  const conflicts = [];

  for (const id of ids) {
    for (const lesson of schedule.groups[id].lessons) {
      const row = grid[lesson.d];
      if (!row || lesson.p < 1 || lesson.p > schedule.periods.length) continue;
      const entry = { ...lesson, group: id };
      const existing = row[lesson.p - 1];
      if (!existing) {
        row[lesson.p - 1] = entry;
      } else if (existing.subject === entry.subject && existing.teacher === entry.teacher) {
        continue;
      } else {
        (existing.clash = existing.clash || []).push(entry);
        conflicts.push({ d: lesson.d, p: lesson.p, a: existing, b: entry });
      }
    }
  }
  return { grid, conflicts };
}

function selectedGroupIds(selection) {
  if (!selection) return [];
  return [selection.section, selection.track, selection.kontra]
    .concat(selection.extras || [])
    .filter(Boolean);
}

/** Last period of a day that actually has a lesson (so we don't render 7 empty rows). */
function lastUsedPeriod(row) {
  for (let i = row.length - 1; i >= 0; i--) if (row[i]) return i;
  return -1;
}

/** First lesson at or after (fromDay, fromPeriod), wrapping into next week.
    `step === days` revisits the starting day from its first period, which is what
    makes "Friday afternoon → Monday morning" work. */
function findNext(grid, fromDay, fromPeriod) {
  const days = grid.length;
  for (let step = 0; step <= days; step++) {
    const d = (fromDay + step) % days;
    const start = step === 0 ? fromPeriod : 0;
    for (let p = start; p < grid[d].length; p++) {
      if (grid[d][p]) return { d, p, lesson: grid[d][p], daysAhead: step };
    }
  }
  return null;
}

/* --------------------------------------------------------------- clock status */

/** Where the wall clock sits relative to today's periods. */
function clockStatus(schedule, date) {
  const di = dayIndex(date);
  const mins = date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  const bounds = schedule.periods.map((p) => ({ start: hm(p.start), end: hm(p.end) }));

  if (di >= schedule.days.length) {
    return { schoolDay: false, dayIdx: di, mins, bounds, current: -1, next: -1 };
  }
  let current = -1, next = -1;
  for (let i = 0; i < bounds.length; i++) {
    if (mins >= bounds[i].start && mins < bounds[i].end) current = i;
    if (next === -1 && mins < bounds[i].start) next = i;
  }
  return { schoolDay: true, dayIdx: di, mins, bounds, current, next };
}

/** Per-slot label used by both the day list and the week grid. */
function slotStatus(status, dayIdx, periodIdx) {
  if (!status.schoolDay || dayIdx !== status.dayIdx) return 'idle';
  if (periodIdx === status.current) return 'now';
  if (periodIdx === status.next) return 'next';
  return status.bounds[periodIdx].end <= status.mins ? 'past' : 'idle';
}

/* -------------------------------------------------------------------- render */

function render() {
  if (!state.schedule || !state.selection) return;
  const built = buildGrid(state.schedule, state.selection);
  state.grid = built.grid;
  state.conflicts = built.conflicts;

  const date = now();
  const status = clockStatus(state.schedule, date);

  // Once the last lesson of the day is over there is nothing left to look up in
  // it, so the "today" tab rolls on to the next day that has lessons. Same on a
  // weekend. Either way the list gets a heading saying which day it is showing.
  const rolled = dayIsOver(status);
  const listedDay = rolled ? nextLessonDay(status) : status.dayIdx;
  if (!state.weekDayPinned) state.weekDay = listedDay;

  renderBar();
  renderStatusCard(date, status, rolled, listedDay);
  renderDayList($('todayList'), listedDay, status, rolled);
  renderDayStrip(status);
  renderDayList($('weekList'), state.weekDay, status);
  renderWeekGrid(status);
  renderFooter();
}

/** True when today holds nothing further — the last lesson has ended, the day
    has no lessons at all, or it is not a school day. */
function dayIsOver(status) {
  if (!status.schoolDay) return true;
  const last = lastUsedPeriod(state.grid[status.dayIdx]);
  if (last < 0) return true;
  return status.mins >= status.bounds[last].end;
}

/** The next day that actually has a lesson, starting after today. */
function nextLessonDay(status) {
  const days = state.grid.length;
  const from = status.schoolDay ? (status.dayIdx + 1) % days : 0;
  const next = findNext(state.grid, from, 0);
  return next ? next.d : from;
}

function renderBar() {
  const parts = selectedGroupIds(state.selection);
  $('barSub').textContent = parts.length ? parts.join(' · ') : (state.schedule.school || '');
}

function renderStatusCard(date, status, rolled, listedDay) {
  const card = $('statusCard');
  const grid = state.grid;
  card.className = 'status';

  const dayLine = `<p class="status__day">${dateText(date)}</p>`;
  const headline = (text) => `<p class="status__headline">${esc(text)}</p>`;
  const detail = (text) => (text ? `<p class="status__detail">${esc(text)}</p>` : '');

  // Weekend, or a day beyond the timetable — point at the next school day.
  if (!status.schoolDay) {
    const upcoming = findNext(grid, listedDay, 0);
    card.innerHTML = dayLine + headline('Δεν έχει μάθημα σήμερα')
      + detail(upcoming
        ? `${state.schedule.days[upcoming.d]}: ${upcoming.lesson.subject} στις ${state.schedule.periods[upcoming.p].start}`
        : 'Δεν υπάρχουν μαθήματα στο πρόγραμμα.');
    return;
  }

  // School day, but everything is finished — the list below has already rolled
  // on to the next day, so the card names it rather than dwelling on today.
  if (rolled) {
    const upcoming = findNext(grid, listedDay, 0);
    card.innerHTML = dayLine
      + headline('Τελείωσαν τα μαθήματα')
      + detail(upcoming
        ? `${state.schedule.days[upcoming.d]}: ${upcoming.lesson.subject} στις ${state.schedule.periods[upcoming.p].start}`
        : 'Δεν υπάρχει επόμενο μάθημα στο πρόγραμμα.');
    return;
  }

  const today = grid[status.dayIdx];
  const live = status.current >= 0 ? today[status.current] : null;

  if (live) {
    const bound = status.bounds[status.current];
    const pct = Math.min(100, Math.max(0, ((status.mins - bound.start) / (bound.end - bound.start)) * 100));
    card.className = 'status status--now';
    // A clashing slot must not look like a single settled lesson on the card.
    const alsoNow = live.clash
      ? `<p class="conflict">⚠ Και ταυτόχρονα: ${esc(live.clash.map((c) => c.subject).join(', '))}</p>`
      : '';
    card.innerHTML = dayLine
      + headline(live.subject)
      + detail(`${status.current + 1}η ώρα · λήγει ${durationText(bound.end - status.mins)}`
        + (live.teacher ? ` · ${live.teacher}` : '')
        + (lessonRoom(live) ? ` · ${lessonRoom(live)}` : ''))
      + `<div class="bar"><div class="bar__fill" style="width:${pct.toFixed(1)}%"></div></div>`
      + alsoNow;
    return;
  }

  // Mid-day with no lesson running: a free period, a break, or before the bell.
  const upcoming = findNext(grid, status.dayIdx, status.next >= 0 ? status.next : today.length);
  const startMins = hm(state.schedule.periods[upcoming.p].start);
  const head = status.current >= 0
    ? 'Κενό'
    : (status.mins < status.bounds[0].start ? 'Πριν το πρώτο μάθημα' : 'Διάλειμμα');
  card.innerHTML = dayLine + headline(head)
    + detail(`${upcoming.lesson.subject} ${durationText(startMins - status.mins)}`
      + ` (${state.schedule.periods[upcoming.p].start})`);
}

function renderDayList(target, dayIdx, status, withHeading) {
  const row = state.grid[dayIdx];
  const last = lastUsedPeriod(row);
  target.innerHTML = '';

  if (withHeading) {
    const head = document.createElement('li');
    head.className = 'daylabel';
    const tomorrow = (dayIndex(now()) + 1) % 7;
    head.textContent = dayIdx === tomorrow
      ? `Αύριο · ${state.schedule.days[dayIdx]}`
      : state.schedule.days[dayIdx];
    target.appendChild(head);
  }

  if (last < 0) {
    target.insertAdjacentHTML('beforeend',
      `<li class="empty">Καμία ώρα για ${esc(state.schedule.days[dayIdx])}.</li>`);
    return;
  }

  for (let p = 0; p <= last; p++) {
    const lesson = row[p];
    const period = state.schedule.periods[p];
    const kind = slotStatus(status, dayIdx, p);
    const classes = ['slot'];
    if (!lesson) classes.push('slot--free');
    if (kind === 'past') classes.push('slot--past');
    if (kind === 'now') classes.push('slot--now');
    else if (kind === 'next' && lesson) classes.push('slot--next');

    const meta = lesson
      ? [lesson.teacher, lessonRoom(lesson), lesson.group].filter(Boolean)
      : [];

    let tag = '';
    if (kind === 'now') tag = '<span class="tag tag--now">Τώρα</span>';
    else if (kind === 'next' && lesson) tag = '<span class="tag tag--next">Επόμενο</span>';

    let clash = '';
    if (lesson && lesson.clash) {
      const others = lesson.clash.map((c) => `${c.subject} (${c.group})`).join(', ');
      clash = `<p class="conflict">⚠ Σύγκρουση με: ${esc(others)}. Έλεγξε την επιλογή τμήματος.</p>`;
    }

    const li = document.createElement('li');
    li.className = classes.join(' ');
    li.innerHTML = `
      <div class="slot__when">
        <span class="slot__no">${p + 1}η ώρα</span>
        <span class="slot__time">${period.start}<span>${period.end}</span></span>
      </div>
      <div class="slot__body">
        <p class="slot__subject">${esc(lesson ? lesson.subject : 'Κενό')}</p>
        ${meta.length ? `<p class="slot__meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</p>` : ''}
        ${tag}${clash}
      </div>`;
    target.appendChild(li);
  }
}

function renderDayStrip(status) {
  const strip = $('dayStrip');
  strip.innerHTML = '';
  state.schedule.days.forEach((name, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'daystrip__btn'
      + (i === state.weekDay ? ' is-active' : '')
      + (status.schoolDay && i === status.dayIdx ? ' is-today' : '');
    // Short names keep all five days on screen at 375px without scrolling.
    btn.textContent = DAY_SHORT[i] || name;
    btn.setAttribute('aria-label', name);
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(i === state.weekDay));
    btn.addEventListener('click', () => focusWeekDay(i));
    strip.appendChild(btn);
  });
}

/** Move the week view to a day, whichever of its two layouts is showing.

    In the list layout that swaps the lessons underneath. The grid layout shows
    all five days at once, so there is nothing to swap — but it is 560px wide on
    a 375px screen, so the day still has somewhere to go: its column gets
    highlighted and scrolled into view. Without that the buttons look broken. */
function focusWeekDay(i) {
  state.weekDay = i;
  state.weekDayPinned = true;
  render();
  if (state.showGrid) scrollWeekDayIntoView();
}

function scrollWeekDayIntoView() {
  const wrap = $('weekGrid');
  const head = wrap.querySelector(`thead th[data-day="${state.weekDay}"]`);
  if (!head || wrap.scrollWidth <= wrap.clientWidth) return;
  // Measure against the scroller itself. offsetLeft would be relative to
  // whatever the offsetParent happens to be — the body here — and scrollIntoView
  // would drag the whole page sideways on iOS to reach an element inside a
  // horizontal scroller. Centre the column between the sticky time stub and the
  // right edge and jump straight to it: smooth scrolling is silently a no-op in
  // some embedded webviews, and a column that does not move at all is the very
  // bug this is here to fix.
  const stub = wrap.querySelector('thead th').offsetWidth;
  const offset = head.getBoundingClientRect().left - wrap.getBoundingClientRect().left;
  const slack = Math.max(0, (wrap.clientWidth - stub - head.offsetWidth) / 2);
  wrap.scrollLeft = Math.max(0, wrap.scrollLeft + offset - stub - slack);
}

function renderWeekGrid(status) {
  const wrap = $('weekGrid');
  wrap.hidden = !state.showGrid;
  $('weekList').hidden = state.showGrid;
  $('gridToggle').setAttribute('aria-pressed', String(state.showGrid));
  if (!state.showGrid) return;

  const days = state.schedule.days;
  const maxPeriod = Math.max(...state.grid.map(lastUsedPeriod), 0);

  let html = '<table class="grid"><thead><tr><th scope="col">Ώρα</th>';
  html += days.map((d, i) => `<th scope="col" data-day="${i}"`
    + `${i === state.weekDay ? ' class="is-picked"' : ''}>${esc(DAY_SHORT[i] || d)}</th>`).join('');
  html += '</tr></thead><tbody>';

  for (let p = 0; p <= maxPeriod; p++) {
    const period = state.schedule.periods[p];
    html += `<tr><th scope="row">${p + 1}η<br>${period.start}</th>`;
    for (let d = 0; d < days.length; d++) {
      const lesson = state.grid[d][p];
      const cls = [];
      if (d === state.weekDay) cls.push('is-picked');
      if (slotStatus(status, d, p) === 'now') cls.push('is-now');
      if (lesson && lesson.clash) cls.push('is-conflict');
      html += `<td${cls.length ? ` class="${cls.join(' ')}"` : ''}>`;
      if (lesson) {
        html += `<div class="grid__subject">${esc(shortSubject(lesson.subject))}</div>`;
        if (lesson.teacher) html += `<div class="grid__teacher">${esc(lesson.teacher)}</div>`;
        const where = lessonRoom(lesson);
        if (where) html += `<div class="grid__room">${esc(where)}</div>`;
      }
      html += '</td>';
    }
    html += '</tr>';
  }
  wrap.innerHTML = html + '</tbody></table>';
}

function renderFooter() {
  const s = state.schedule;
  const range = s.validFrom && s.validTo
    ? ` · ισχύει ${formatDay(s.validFrom)}–${formatDay(s.validTo)}`
    : '';
  $('footMeta').innerHTML =
    `${esc(s.school || '')}<br>Πρόγραμμα έκδοσης <strong>${esc(s.version)}</strong>${esc(range)}`
    + `<br>Εφαρμογή v${APP_VERSION}${frozen ? ' · <strong>δοκιμαστική ώρα</strong>' : ''}`;
}

function formatDay(iso) {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString('el-GR', { day: 'numeric', month: 'short' });
}

function shortSubject(name) {
  return (state.schedule.subjectShort && state.schedule.subjectShort[name]) || name;
}

function roomName(code) {
  if (!code) return '';
  return (state.schedule.rooms && state.schedule.rooms[code]) || code;
}

/** Where a lesson actually takes place.

    A lesson only names a room when it is somewhere other than usual (a lab).
    Otherwise the student is in the home classroom of whichever group the
    lesson came from — which for Γ' changes between the general hours and the
    orientation hours, so it is worth showing on every row. */
function lessonRoom(lesson) {
  if (!lesson) return '';
  if (lesson.room) return roomName(lesson.room);
  const group = state.schedule.groups[lesson.group];
  return (group && group.room) || '';
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* -------------------------------------------------------------------- picker */

/** Everything the picker offers, derived from the data — never hardcoded, so a
    new section or track next term shows up without touching this file. */
function pickerModel(grade) {
  const all = Object.values(state.schedule.groups);
  // `hidden` is the converter's call and the only one: it already knows that an
  // empty page is usually a class exported by mistake, but that an empty
  // «κόντρα» elective is a real class that just has no hour this week. Second-
  // guessing it here is how a valid group silently disappears from the picker.
  const offered = (g) => !g.hidden;
  const byTrack = (kind) => {
    const map = new Map();
    all.filter((g) => g.kind === kind && g.grade === grade && offered(g))
      .forEach((g) => {
        const key = g.track || g.name || g.label;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(g);
      });
    return map;
  };
  return {
    grades: [...new Set(all.filter((g) => g.kind === 'section' && offered(g))
      .map((g) => g.grade))].filter(Boolean).sort(),
    sections: all.filter((g) => g.kind === 'section' && g.grade === grade && offered(g))
      .sort((a, b) => a.label.localeCompare(b.label, 'el')),
    tracks: byTrack('track'),
    kontra: byTrack('kontra'),
    extras: all.filter((g) => g.kind === 'extra' && offered(g) && g.grade === grade),
  };
}

function openPicker() {
  state.draft = state.selection
    ? { ...state.selection, extras: [...(state.selection.extras || [])] }
    : { grade: null, section: null, track: null, kontra: null, extras: [] };
  renderPicker();
  $('picker').showModal();
}

function renderPicker() {
  const draft = state.draft;
  const model = pickerModel(draft.grade);
  const body = $('pickerBody');
  body.innerHTML = '';

  body.appendChild(field('Τάξη', null, model.grades.map((g) => chip({
    text: `${g}΄ Λυκείου`,
    on: draft.grade === g,
    onClick: () => {
      if (draft.grade === g) return;
      Object.assign(draft, { grade: g, section: null, track: null, kontra: null, extras: [] });
      renderPicker();
    },
  }))));

  if (!draft.grade) return finishPicker('Διάλεξε πρώτα τάξη.');

  body.appendChild(field('Τμήμα', null, model.sections.map((s) => chip({
    text: s.label,
    on: draft.section === s.label,
    onClick: () => { draft.section = s.label; renderPicker(); },
  }))));

  if (model.tracks.size) {
    const chips = [];
    for (const [track, groups] of model.tracks) {
      groups.forEach((g) => chips.push(chip({
        text: g.label,
        sub: track,
        on: draft.track === g.label,
        onClick: () => { draft.track = draft.track === g.label ? null : g.label; renderPicker(); },
      })));
    }
    body.appendChild(field('Ομάδα προσανατολισμού',
      'Διάλεξε την ομάδα που γράφει το πρόγραμμα της σχολής σου.', chips));
  }

  if (model.kontra.size) {
    const chips = [];
    for (const [subject, groups] of model.kontra) {
      groups.forEach((g) => chips.push(chip({
        text: g.label,
        sub: subject,
        on: draft.kontra === g.label,
        onClick: () => { draft.kontra = draft.kontra === g.label ? null : g.label; renderPicker(); },
      })));
    }
    body.appendChild(field('Μάθημα επιλογής («Κόντρα»)', 'Προαιρετικό.', chips));
  }

  if (model.extras.length) {
    body.appendChild(field('Επιπλέον ομάδες', 'Προαιρετικό — π.χ. δεύτερη ξένη γλώσσα.',
      model.extras.map((g) => chip({
        text: g.label,
        sub: g.name || g.track,
        on: draft.extras.includes(g.label),
        onClick: () => {
          const i = draft.extras.indexOf(g.label);
          if (i >= 0) draft.extras.splice(i, 1); else draft.extras.push(g.label);
          renderPicker();
        },
      }))));
  }

  finishPicker(draft.section ? '' : 'Διάλεξε τμήμα για να συνεχίσεις.');
}

function finishPicker(hint) {
  $('pickerHint').textContent = hint;
  $('pickerSave').disabled = !state.draft.section;
}

function field(label, note, children) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  wrap.innerHTML = `<p class="field__label">${esc(label)}</p>`
    + (note ? `<p class="field__note">${esc(note)}</p>` : '');
  const chips = document.createElement('div');
  chips.className = 'chips'
    + (children.some((c) => c.querySelector('small')) ? ' chips--grid' : '');
  children.forEach((c) => chips.appendChild(c));
  wrap.appendChild(chips);
  return wrap;
}

function chip({ text, sub, on, onClick }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'chip' + (on ? ' is-on' : '');
  btn.setAttribute('aria-pressed', String(!!on));
  btn.innerHTML = esc(text) + (sub ? `<small>${esc(sub)}</small>` : '');
  btn.addEventListener('click', onClick);
  return btn;
}

/** Drop references to groups an updated schedule no longer contains. */
function pruneSelection(selection, schedule) {
  if (!selection) return null;
  const alive = (id) => id && schedule.groups[id];
  const next = {
    grade: selection.grade,
    section: alive(selection.section) ? selection.section : null,
    track: alive(selection.track) ? selection.track : null,
    kontra: alive(selection.kontra) ? selection.kontra : null,
    extras: (selection.extras || []).filter(alive),
  };
  return next.section ? next : null;
}

/* ------------------------------------------------------------------ banners */

function banner({ id, text, actionText, onAction, tone }) {
  if (document.querySelector(`[data-banner="${id}"]`)) return;
  const el = document.createElement('div');
  el.className = 'banner' + (tone === 'warn' ? ' banner--warn' : '');
  el.dataset.banner = id;
  el.innerHTML = `<p>${esc(text)}</p>`;
  if (actionText) {
    const act = document.createElement('button');
    act.type = 'button';
    act.className = 'banner__act';
    act.textContent = actionText;
    act.addEventListener('click', () => { el.remove(); onAction(); });
    el.appendChild(act);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'banner__dismiss';
  close.setAttribute('aria-label', 'Απόρριψη');
  close.textContent = '✕';
  close.addEventListener('click', () => el.remove());
  el.appendChild(close);
  $('banners').appendChild(el);
}

/* ------------------------------------------------------------ update checking */

let checking = false;

async function checkForUpdate({ silent }) {
  if (checking) return;
  if (silent) {
    const last = Number(load(KEY_LAST_CHECK, 0)) || 0;
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
  }
  checking = true;
  try {
    const candidate = await fetchSchedule(REMOTE_SCHEDULE_URL);
    save(KEY_LAST_CHECK, Date.now());
    if (!isNewer(candidate, state.schedule)) {
      if (!silent) banner({ id: 'uptodate', text: 'Το πρόγραμμα είναι ενημερωμένο.' });
      return;
    }
    if (load(KEY_DISMISSED, null) === stamp(candidate)) return;

    // Same version stamp, newer file: the school's timetable has not changed,
    // the import of it has been corrected. Saying «νέο πρόγραμμα» next to a
    // version the student can already see in the footer just reads as a bug.
    const corrected = String(candidate.version) === String(state.schedule.version);
    banner({
      id: 'newdata',
      text: corrected
        ? 'Διορθωμένο πρόγραμμα — υπάρχει ενημερωμένη έκδοση των ίδιων ωρών.'
        : `Νέο πρόγραμμα (έκδοση ${candidate.version}).`,
      actionText: 'Ενημέρωση',
      onAction: () => applySchedule(candidate),
    });
  } catch (err) {
    if (err.kind === 'data') {
      // A broken published file is worth surfacing even on a background check:
      // the student would otherwise sit on a stale schedule with no explanation.
      banner({
        id: 'baddata',
        tone: 'warn',
        text: `Το νέο πρόγραμμα αγνοήθηκε (${err.message}). Κρατήθηκε το προηγούμενο.`,
      });
    } else if (!silent) {
      // Being offline is the normal case, so only mention it when asked directly.
      banner({ id: 'nocheck', tone: 'warn', text: 'Δεν έγινε έλεγχος — δεν υπάρχει σύνδεση.' });
    }
  } finally {
    checking = false;
  }
}

function applySchedule(schedule) {
  state.schedule = schedule;
  save(KEY_SCHEDULE, schedule);
  save(KEY_DISMISSED, stamp(schedule));

  const pruned = pruneSelection(state.selection, schedule);
  if (!pruned) {
    state.selection = null;
    banner({ id: 'repick', tone: 'warn', text: 'Το τμήμα σου άλλαξε στο νέο πρόγραμμα — διάλεξε ξανά.' });
    openPicker();
    return;
  }
  const lostSomething = JSON.stringify(pruned) !== JSON.stringify(state.selection);
  state.selection = pruned;
  save(KEY_SELECTION, pruned);
  if (lostSomething) {
    banner({ id: 'partial', tone: 'warn', text: 'Κάποιες ομάδες δεν υπάρχουν πια — έλεγξε τις επιλογές σου.' });
  }
  render();
}

/* ------------------------------------------------ service worker + install */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          banner({
            id: 'appupdate',
            text: 'Νέα έκδοση της εφαρμογής.',
            actionText: 'Επαναφόρτωση',
            onAction: () => { sw.postMessage({ type: 'SKIP_WAITING' }); },
          });
        }
      });
    });
  }).catch(() => { /* http:// without a secure context — the app still runs */ });

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
}

function isIOS() {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
}

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function setupInstall() {
  const btn = $('installBtn');

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    btn.hidden = false;
  });

  // iOS Safari never fires beforeinstallprompt, so offer the manual route.
  if (isIOS() && !isStandalone()) btn.hidden = false;

  btn.addEventListener('click', async () => {
    if (state.deferredInstall) {
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      btn.hidden = true;
    } else {
      $('iosSheet').showModal();
    }
  });

  window.addEventListener('appinstalled', () => { btn.hidden = true; });
}

/* --------------------------------------------------------------------- ticking */

let tickTimer = null;

function startTicking() {
  if (frozen) return;               // a pinned clock never advances
  clearTimeout(tickTimer);
  const d = new Date();
  const delay = 60000 - (d.getSeconds() * 1000 + d.getMilliseconds()) + 50;
  tickTimer = setTimeout(() => { render(); startTicking(); }, delay);
}

/* ------------------------------------------------------------------- wiring */

function setView(view) {
  state.view = view;
  $('view-today').hidden = view !== 'today';
  $('view-week').hidden = view !== 'week';
  document.querySelectorAll('.tabs__btn').forEach((btn) => {
    const on = btn.dataset.view === view;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  });
}

function wire() {
  document.querySelectorAll('.tabs__btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  $('settingsBtn').addEventListener('click', openPicker);
  $('pickerClose').addEventListener('click', () => $('picker').close());
  $('iosClose').addEventListener('click', () => $('iosSheet').close());

  $('pickerSave').addEventListener('click', () => {
    if (!state.draft.section) return;
    state.selection = state.draft;
    save(KEY_SELECTION, state.selection);
    $('picker').close();
    render();
  });

  // Closing the picker with Esc or the backdrop must not leave a blank app.
  $('picker').addEventListener('close', () => {
    if (!state.selection) openPicker();
  });

  $('gridToggle').addEventListener('click', () => {
    state.showGrid = !state.showGrid;
    render();
    // Switching layouts keeps the day the student was looking at, so bring its
    // column along rather than dropping them at Monday.
    if (state.showGrid) scrollWeekDayIntoView();
  });

  $('checkBtn').addEventListener('click', () => checkForUpdate({ silent: false }));

  // iOS suspends timers while the app is backgrounded, so the highlight would be
  // stale at exactly the moment a student reopens it. Recompute on every return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    render();
    startTicking();
    checkForUpdate({ silent: true });
  });

  // Swipe between days in the week view.
  let touchX = null, touchY = null;
  const week = $('view-week');
  week.addEventListener('touchstart', (e) => {
    touchX = e.changedTouches[0].clientX;
    touchY = e.changedTouches[0].clientY;
  }, { passive: true });
  week.addEventListener('touchend', (e) => {
    if (touchX === null || state.showGrid) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    touchX = null;
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
    const count = state.schedule.days.length;
    focusWeekDay((state.weekDay + (dx < 0 ? 1 : -1) + count) % count);
  }, { passive: true });
}

/* ---------------------------------------------------------------------- boot */

async function boot() {
  wire();
  setupInstall();
  registerServiceWorker();

  let fetchedRemote = false;
  try {
    const initial = await loadInitialSchedule();
    state.schedule = initial.schedule;
    fetchedRemote = initial.fetchedRemote;
  } catch (err) {
    $('main').innerHTML =
      `<p class="empty">Δεν ήταν δυνατή η φόρτωση του προγράμματος.<br>${esc(err.message)}</p>`;
    return;
  }

  state.selection = pruneSelection(load(KEY_SELECTION, null), state.schedule);

  if (!state.selection) {
    openPicker();
  } else {
    render();
  }

  setView('today');
  startTicking();
  // Skip the check when the bundle we just fetched *is* the remote file.
  if (!fetchedRemote) checkForUpdate({ silent: true });
}

boot();
