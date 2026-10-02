/* ==========================================================================
   Ωρολόγιο Πρόγραμμα — 7ο ΓΕΛ Ηρακλείου
   Vanilla JS, no build step. Merges a student's section + orientation track +
   elective groups into one timetable and highlights the running period.
   ========================================================================== */
'use strict';

/* -------------------------------------------------------------- configuration */

const APP_VERSION = '1.10.1';

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
const KEY_PENDING = 'gel7.pending.v1';
// index.html reads this one too, before anything is drawn — see the <head>.
const KEY_THEME = 'gel7.theme.v1';

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
  theme: null,
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
  // Both are how isNewer() orders two schedules. One without them was offered
  // as «έκδοση undefined», and once taken, nothing published after it ever
  // compared as newer again.
  if (typeof data.version !== 'string' || !data.version.trim()) fail('λείπει η έκδοση');
  if (isNaN(Date.parse(data.generatedAt))) fail('λείπει η ημερομηνία δημιουργίας');
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
  // A copy stored by an older version may have no date. The dated one is the
  // way out of it, never the other way round.
  if (isNaN(a) !== isNaN(b)) return !isNaN(a);
  if (!isNaN(a) && a !== b) return a > b;
  return String(candidate.version || '') > String(current.version || '');
}

/** Errors carry `kind` so callers can tell "you're offline" from "the file the
    school published is broken" — very different things to tell a student. */
function tagged(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

/** `fresh` is for update checks: the service worker answers from its cache
    when the network is down, which is right for a first load and no answer at
    all to «is there anything newer?». */
async function fetchSchedule(url, { fresh = false } = {}) {
  // Marked, so the service worker gives the network longer before answering
  // from its cache: the student is waiting on a real answer. See sw.js.
  const target = fresh ? `${url}${url.includes('?') ? '&' : '?'}check=1` : url;
  let res;
  try {
    // 'no-cache' still revalidates on every call, but sends If-None-Match, so an
    // unchanged schedule comes back as a 304 with no body instead of ~7 KB.
    // 'no-store' would skip the validator entirely and re-download every time.
    res = await fetch(target, { cache: 'no-cache' });
  } catch (err) {
    throw tagged('network', err.message);
  }
  if (!res.ok) throw tagged('network', `HTTP ${res.status}`);
  // sw.js labels its fallback copy; see labelledStale() there.
  if (fresh && res.headers.get('X-Served-From') === 'cache') {
    throw tagged('network', 'χωρίς σύνδεση — απάντησε η αποθηκευμένη έκδοση');
  }

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

  let bundled;
  try {
    bundled = await fetchSchedule(BUNDLED_SCHEDULE_URL);
  } catch (err) {
    // An older version could find a schedule with nothing loaded yet, keep it
    // as pending and fail before ever showing it. It is as good as any.
    try {
      const pending = validateSchedule(load(KEY_PENDING, null));
      localStorage.removeItem(KEY_PENDING);
      save(KEY_SCHEDULE, pending);
      return { schedule: pending, fetchedRemote: false };
    } catch (none) {
      throw err;
    }
  }
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
  const chosen = new Set(ids);
  // A split group stands in for the class it was split off — and only then. Tick
  // Γ1εν without Γ1 and it is just another group, so an overlap is a real clash
  // rather than a licence to delete the other lesson.
  const standsIn = (g) => !!(g.parallel && g.parent && chosen.has(g.parent));

  for (const id of ids) {
    const group = schedule.groups[id];
    // A τμήμα ένταξης adds a name to an hour, never an hour of its own; it is
    // merged in below, once the rest of the week has settled.
    if (group.coteach) continue;
    for (const lesson of group.lessons) {
      const row = grid[lesson.d];
      if (!row || lesson.p < 1 || lesson.p > schedule.periods.length) continue;
      const entry = { ...lesson, group: id, parallel: standsIn(group) };
      const existing = row[lesson.p - 1];
      if (!existing) {
        row[lesson.p - 1] = entry;
      } else if (existing.subject === entry.subject && existing.teacher === entry.teacher) {
        continue;
      } else if (existing.parallel !== entry.parallel) {
        // One of the two splits the class for that subject — ενισχυτική, or the
        // French half of a class whose other half does German. The student sits
        // in one room, not both, so the split group's lesson is the real one.
        const [kept, dropped] = entry.parallel ? [entry, existing] : [existing, entry];
        (kept.replaces = kept.replaces || []).push(dropped);
        row[lesson.p - 1] = kept;
      } else {
        (existing.clash = existing.clash || []).push(entry);
        conflicts.push({ d: lesson.d, p: lesson.p, a: existing, b: entry });
      }
    }
  }

  // Nobody leaves the room for a τμήμα ένταξης: a second teacher walks in for
  // the hour. So these are never picked — they ride along with the class — and
  // mostly all they do is add a name. Three shapes, in the order they are
  // tested: the class has no lesson at all and the hour goes ahead with the
  // ενισχυτική teacher alone; the class has one with no teacher named and they
  // cover it; or the ordinary case, two teachers in the room.
  for (const g of Object.values(schedule.groups)) {
    if (!g.coteach || !g.parent || !chosen.has(g.parent)) continue;
    for (const lesson of g.lessons) {
      const row = grid[lesson.d];
      if (!lesson.teacher || !row || lesson.p < 1 || lesson.p > schedule.periods.length) continue;
      const slot = row[lesson.p - 1];
      if (!slot) {
        // A real hour, just not one the class's own page shows. Dropping it
        // would hide a lesson the student is expected to turn up to.
        row[lesson.p - 1] = { ...lesson, group: g.label, alone: true,
          teacherNote: g.name || '', teacherNoteShort: g.shortName || '' };
      } else if (slot.group !== g.parent) {
        continue;  // another group took this hour — a room this student is not in
      } else if (!slot.teacher) {
        slot.teacher = lesson.teacher;
        slot.teacherNote = g.name || '';
        slot.teacherNoteShort = g.shortName || '';
      } else if (slot.teacher !== lesson.teacher) {
        // Carry the group's own name — «Ενισχυτική Διδ.» — beside the teacher.
        // A second name with nothing to explain it reads like a co-teacher of
        // the same subject, which is not what the student is looking at.
        slot.with = slot.with || [];
        if (!slot.with.some((w) => w.teacher === lesson.teacher)) {
          slot.with.push({ teacher: lesson.teacher, note: g.name || '',
                           noteShort: g.shortName || '' });
        }
      }
    }
  }

  // An orientation or κόντρα the student has not picked still takes its hours.
  // Left empty they read «Κενό», free, to someone who is expected in a
  // classroom. Say what the hour is, and that the group is what's missing.
  for (const hour of unpickedHours(schedule, selection)) {
    const row = grid[hour.d];
    if (row && hour.p >= 1 && hour.p <= schedule.periods.length && !row[hour.p - 1]) {
      row[hour.p - 1] = hour;
    }
  }
  return { grid, conflicts };
}

/** The hours of the orientation groups, or of the «κόντρα», when the student
    has not picked one. Every group of that kind in a grade meets at the same
    hours, so which hours they are is known even though room and teacher are not.
    The κόντρα subject is known too once the orientation is, from
    `kontraByTrack`. */
function unpickedHours(schedule, selection) {
  if (!selection || !selection.grade) return [];
  const mine = Object.values(schedule.groups)
    .filter((g) => g.grade === selection.grade && !g.hidden);
  const hours = [];
  const add = (groups, subject) => {
    for (const g of groups) {
      for (const l of g.lessons) hours.push({ d: l.d, p: l.p, subject, unpicked: true });
    }
  };
  if (!selection.track) add(mine.filter((g) => g.kind === 'track'), 'Ώρα κατεύθυνσης');
  if (!selection.kontra) {
    const track = selection.track && schedule.groups[selection.track];
    const wanted = track && (schedule.kontraByTrack || {})[track.track];
    const kontra = mine.filter((g) => g.kind === 'kontra');
    const theirs = kontra.filter((g) => g.track === wanted);
    // Same fallback as the picker: a mapping that matches nothing means every group.
    if (theirs.length) add(theirs, wanted);
    else add(kontra, 'Μάθημα επιλογής (Κόντρα)');
  }
  return hours;
}

/** Everyone in the room for a lesson: the class's own teacher first, then
    whoever joins them for that hour and what they are there for. */
function teachers(lesson) {
  const named = (name, note) => note ? `${name} (${note})` : name;
  return [lesson.teacher && named(lesson.teacher, lesson.teacherNote)]
    .concat((lesson.with || []).map((w) => named(w.teacher, w.note)))
    .filter(Boolean);
}

/** The same names as HTML, the joining ones set smaller beside the first.
    `compact` is for the week grid, where a full name and a full label wrap one
    cell to four lines and push half the week off the screen. */
function teacherHtml(lesson, compact) {
  const who = (name) => esc(compact ? surname(name) : name);
  const note = (full, short) => {
    const text = compact ? (short || full) : full;
    return text ? ` <em>(${esc(text)})</em>` : '';
  };
  return (lesson.teacher
    ? who(lesson.teacher) + note(lesson.teacherNote, lesson.teacherNoteShort) : '')
    + (lesson.with || []).map((w) =>
      `<small class="with">${who(w.teacher)}${note(w.note, w.noteShort)}</small>`).join('');
}

/** Just the family name. Greek names here run given-name first and the titles
    the school appends are parenthesised, so the last word left after dropping
    those is the name students actually use. */
function surname(name) {
  const parts = String(name || '').replace(/\s*\(.*$/, '').trim().split(/\s+/);
  return parts[parts.length - 1] || String(name || '');
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
  $('tab-today').textContent = todayTabLabel(status, rolled, listedDay);
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

/** What the today tab is called. Once today is over it lists another day, and
    a tab still reading «Σήμερα» above tomorrow's lessons passes them off as
    today's — to a student who has just walked out of school, the wrong ones. */
function todayTabLabel(status, rolled, listedDay) {
  return rolled ? dayHeading(status, listedDay) : 'Σήμερα';
}

/** «Αύριο · Πέμπτη» when the day is tomorrow, otherwise just its name. */
function dayHeading(status, dayIdx) {
  const name = state.schedule.days[dayIdx];
  return dayIdx === (status.dayIdx + 1) % 7 ? `Αύριο · ${name}` : name;
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
    // No teachers here on purpose. The very next row of the list repeats this
    // lesson in full, and on a phone the names wrapped the card to three lines
    // — 44px of duplication between the student and the rest of their day.
    card.innerHTML = dayLine
      + headline(live.subject)
      + detail(`${status.current + 1}η ώρα · λήγει ${durationText(bound.end - status.mins)}`
        + (lessonRoom(live) ? ` · ${lessonRoom(live)}` : ''))
      + `<div class="bar"><div class="bar__fill" style="width:${pct.toFixed(1)}%"></div></div>`
      + alsoNow;
    return;
  }

  // Mid-day with no lesson running: a free period, a break, or before the bell.
  const upcoming = findNext(grid, status.dayIdx, status.next >= 0 ? status.next : today.length);
  const startMins = hm(state.schedule.periods[upcoming.p].start);
  // «Before the first lesson» means the student's own first lesson, not the
  // school's first bell: Α4 starts at 09:00 on Mondays, and at 08:20 they are
  // not sitting through a free period — they have not arrived yet.
  const first = today.findIndex(Boolean);
  const head = status.mins < status.bounds[first].start ? 'Πριν το πρώτο μάθημα'
    : status.current >= 0 ? 'Κενό' : 'Διάλειμμα';
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
    head.textContent = dayHeading(status, dayIdx);
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
      ? [teacherHtml(lesson), esc(lessonRoom(lesson)), esc(lesson.group)].filter(Boolean)
      : [];

    let tag = '';
    if (kind === 'now') tag = '<span class="tag tag--now">Τώρα</span>';
    else if (kind === 'next' && lesson) tag = '<span class="tag tag--next">Επόμενο</span>';

    let clash = '';
    if (lesson && lesson.clash) {
      const others = lesson.clash.map((c) => `${c.subject} (${c.group})`).join(', ');
      clash = `<p class="conflict">⚠ Σύγκρουση με: ${esc(others)}. Έλεγξε την επιλογή τμήματος.</p>`;
    }

    // Say what the split group replaced, but only when it is not the same
    // subject — «Γλώσσα αντί για Γλώσσα» is noise, «Γαλλικά αντί για Γερμανικά»
    // is the whole reason the student ticked that group.
    let instead = '';
    const swapped = (lesson && lesson.replaces || [])
      .filter((r) => r.subject !== lesson.subject)
      .map((r) => `${r.subject} (${r.group})`);
    if (swapped.length) {
      instead = `<p class="slot__instead">αντί για ${esc(swapped.join(', '))}</p>`;
    }

    // The class's own page shows nothing this hour, but the ενισχυτική teacher
    // has it — so it happens, with them. Say so, or the student is left
    // wondering why a lesson appeared out of a group they never picked.
    if (lesson && lesson.alone) {
      instead += '<p class="slot__instead">η ώρα γίνεται με την ενισχυτική διδασκαλία'
        + ` — το ${esc(state.schedule.groups[lesson.group].parent)} δεν έχει άλλο μάθημα</p>`;
    }

    // The hour is theirs; which room and teacher depends on a group they have
    // not picked yet.
    if (lesson && lesson.unpicked) {
      instead += '<p class="slot__instead">δεν έχεις διαλέξει ομάδα</p>';
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
        ${meta.length ? `<p class="slot__meta">${meta.map((m) => `<span>${m}</span>`).join('')}</p>` : ''}
        ${instead}${tag}${clash}
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
        const who = teacherHtml(lesson, true);
        if (who) html += `<div class="grid__teacher">${who}</div>`;
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
  // A revision that runs until further notice has a start but no end date.
  const range = !s.validFrom ? ''
    : s.validTo ? ` · ισχύει ${formatDay(s.validFrom)}–${formatDay(s.validTo)}`
    : ` · ισχύει από ${formatDay(s.validFrom)}`;
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
  // Some lessons have nowhere to name: Γυμναστική is out in the προαύλιο. The
  // class's own room is exactly the wrong answer there, so say nothing rather
  // than send the student indoors. Which subjects those are is the school's to
  // say — `roomlessSubjects`, out of aliases.json.
  if ((state.schedule.roomlessSubjects || []).includes(lesson.subject)) return '';
  if (lesson.room) return roomName(lesson.room);
  const group = state.schedule.groups[lesson.group];
  if (group && group.room) return group.room;
  // A τμήμα ένταξης has no room of its own because nobody moves: the second
  // teacher walks into the class's room, so that is the answer. A split group
  // is the opposite — the French half of Α2 walks out, and the class's room is
  // where the *other* half stayed. Name it only once the school says where they
  // went (groupRooms), and say nothing until then.
  const parent = group && !group.parallel && group.parent
    && state.schedule.groups[group.parent];
  return (parent && parent.room) || '';
}

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* -------------------------------------------------------------------- picker */

/** Everything the picker offers, derived from the data — never hardcoded, so a
    new section or track next term shows up without touching this file. */
function pickerModel(grade, chosen) {
  const all = Object.values(state.schedule.groups);
  // `hidden` is the converter's call and the only one: it already knows that an
  // empty page is usually a class exported by mistake, but that an empty
  // «κόντρα» elective is a real class that just has no hour this week. Second-
  // guessing it here is how a valid group silently disappears from the picker.
  const offered = (g) => !g.hidden;
  // An extra that splits one class — the French half of Α2, its second English
  // group — is only a choice for someone in that class; to anyone else it is a
  // stranger's timetable. A τμήμα ένταξης is never a choice at all: the student
  // stays in the room and a second teacher joins them, so it rides along with
  // the class instead of being ticked.
  const reachable = new Set([chosen && chosen.section, chosen && chosen.track].filter(Boolean));
  const mine = (g) => !g.coteach && (!g.parent || reachable.has(g.parent));
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
    kontra: onlyKontra(byTrack('kontra'), chosen && chosen.track),
    extras: all.filter((g) => g.kind === 'extra' && offered(g) && g.grade === grade && mine(g)),
  };
}

/** The «κόντρα» subject an orientation sits, or null if the school has not said.
    Ανθρωπιστικών sit Μαθηματικά, everyone else Ιστορία — that is the school's
    rule, in `kontraByTrack`, not the student's choice and not a list in here. */
function kontraSubject(trackId) {
  const group = trackId && state.schedule.groups[trackId];
  return (group && (state.schedule.kontraByTrack || {})[group.track]) || null;
}

/** Narrow the κόντρα groups to the subject that goes with the chosen track, so
    a θετική student is not asked to choose between two Ιστορία groups and three
    Μαθηματικά ones when only one subject was ever theirs. An unmapped track, or
    a mapping that matches nothing here, leaves every group on offer rather than
    none — being shown too much beats being shown nothing. */
function onlyKontra(map, trackId) {
  const wanted = kontraSubject(trackId);
  if (!wanted || !map.has(wanted)) return map;
  for (const key of [...map.keys()]) if (key !== wanted) map.delete(key);
  return map;
}

function openPicker() {
  if (!state.schedule) return;   // nothing to pick from until one has loaded
  state.draft = state.selection
    ? { ...state.selection, extras: [...(state.selection.extras || [])] }
    : { grade: null, section: null, track: null, kontra: null, extras: [] };
  renderPicker();
  $('picker').showModal();
}

function renderPicker() {
  const draft = state.draft;
  const model = pickerModel(draft.grade, draft);
  // Moving to another class — or another orientation — takes with it whatever
  // was only ever on offer because of it.
  const onOffer = new Set(model.extras.map((g) => g.label));
  draft.extras = (draft.extras || []).filter((id) => onOffer.has(id));
  const kontraOnOffer = new Set([...model.kontra.values()].flat().map((g) => g.label));
  if (draft.kontra && !kontraOnOffer.has(draft.kontra)) draft.kontra = null;
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
    body.appendChild(field('Μάθημα επιλογής («Κόντρα»)',
      kontraSubject(draft.track)
        ? 'Μόνο οι ομάδες που αντιστοιχούν στην κατεύθυνσή σου.'
        : 'Προαιρετικό.', chips));
  }

  if (model.extras.length) {
    body.appendChild(field(draft.section ? `Ομάδες του ${draft.section}` : 'Επιπλέον ομάδες',
      'Προαιρετικό — τσέκαρέ το μόνο αν ανήκεις σε αυτή την ομάδα.',
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
  const alive = (id) => !!(id && schedule.groups[id] && !schedule.groups[id].hidden);
  const next = {
    grade: selection.grade,
    section: alive(selection.section) ? selection.section : null,
    track: alive(selection.track) ? selection.track : null,
    kontra: alive(selection.kontra) ? selection.kontra : null,
    extras: [],
  };
  // The κόντρα follows the orientation, so one saved against a track the
  // student has since moved off is no longer theirs to keep.
  const wanted = next.track && (schedule.kontraByTrack || {})[schedule.groups[next.track].track];
  if (wanted && next.kontra && schedule.groups[next.kontra].track !== wanted) next.kontra = null;
  // Same rule as the picker, applied to what was saved earlier: an extra tied
  // to a class outlives neither a move to another class nor a version of the
  // app that stopped offering it.
  const reachable = new Set([next.section, next.track].filter(Boolean));
  next.extras = (selection.extras || []).filter((id) => alive(id)
    && !schedule.groups[id].coteach
    && (!schedule.groups[id].parent || reachable.has(schedule.groups[id].parent)));
  return next.section ? next : null;
}

/* ------------------------------------------------------------------- themes */

/** The presets themselves are [data-theme] blocks in app.css. All this file
    needs is what to call them, and the colour of the phone's status bar in
    light and dark mode (`chrome`) — that one is a <meta>, out of the
    stylesheet's reach, so it is kept in step with app.css by hand. */
const THEMES = [
  { id: 'default', name: 'Προεπιλογή', chrome: ['#1d4ed8', '#0b1020'] },
  { id: 'amoled', name: 'AMOLED', chrome: ['#000000', '#000000'] },
  { id: 'pink', name: 'Ροζ', chrome: ['#db2777', '#1a0e14'] },
];
const CUSTOM_THEME = { id: 'custom', name: 'Δικά σου' };

const HEX_COLOUR = /^#[0-9a-f]{6}$/i;

function asHex(value) {
  const text = String(value || '').trim().toLowerCase();
  return HEX_COLOUR.test(text) ? text : null;
}

/** "#1d4ed8" -> [29, 78, 216], and back. */
function rgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

function toHex(channels) {
  return '#' + channels.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('');
}

/** `t` of the way from colour a to colour b. */
function mix(a, b, t) {
  const from = rgb(a), to = rgb(b);
  return toHex(from.map((c, i) => c + (to[i] - c) * t));
}

/** WCAG relative luminance and contrast ratio, 1 to 21. */
function luminance(colour) {
  const [r, g, b] = rgb(colour).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `colour`, pushed toward `toward` only as far as it takes to read at `min`:1
    on every one of `against`. When even `toward` cannot, it is the best there is. */
function readable(colour, toward, against, min) {
  const backs = [].concat(against);
  for (let step = 0; step <= 20; step++) {
    const c = mix(colour, toward, step / 20);
    if (backs.every((b) => contrast(c, b) >= min)) return c;
  }
  return toward;
}

/** Everything app.css takes from a theme, out of the two colours a student
    picked. Only those two are theirs: the cards, borders and soft tints follow
    from them, and every colour that carries text is checked against what it
    sits on. A pale yellow main colour must not leave white letters on the
    buttons, and lessons on a mid-grey background still have to be readable. */
function customPalette(picked, bg) {
  const dark = contrast(bg, '#ffffff') > contrast(bg, '#000000');
  const ink = dark ? '#ffffff' : '#000000';
  const blackOrWhite = (c) => (contrast(c, '#ffffff') >= contrast(c, '#000000') ? '#ffffff' : '#000000');
  // Anything text sits on keeps its distance from the text colour. A pink in
  // the middle of the range barely takes white text as it is, and cards a
  // shade lighter than it — as cards are in a dark theme — would not at all.
  const under = (c) => readable(c, dark ? '#000000' : '#ffffff', ink, 5.5);
  const surface = under(mix(bg, '#ffffff', dark ? 0.05 : 0.7));
  // A selected chip, the day being shown and the «Επόμενο» border are drawn in
  // the main colour and nothing else. Picked close to the background, it left
  // the student unable to see what they had chosen, so there it moves toward
  // the text colour until it stands out at 3:1, WCAG's minimum for anything
  // that is not text. The bar keeps the colour exactly as picked.
  const accent = readable(picked, ink, [bg, surface], 3);
  const surface2 = under(mix(mix(bg, ink, dark ? 0.09 : 0.04), accent, 0.05));
  const accentSoft = under(mix(surface, accent, dark ? 0.2 : 0.13));
  const nowBg = under(mix(surface, '#f59e0b', dark ? 0.16 : 0.12));
  const warnBg = under(mix(surface, '#ef4444', dark ? 0.14 : 0.09));
  const text = readable(mix(ink, bg, 0.1), ink, [bg, surface, surface2, accentSoft, nowBg, warnBg], 7);
  return {
    chrome: dark ? bg : picked,
    vars: {
      'color-scheme': dark ? 'dark' : 'light',
      '--bg': bg,
      '--surface': surface,
      '--surface-2': surface2,
      '--text': text,
      '--muted': readable(mix(text, bg, 0.42), text, [bg, surface, surface2], 4.5),
      '--border': mix(mix(bg, ink, dark ? 0.15 : 0.11), accent, 0.06),
      '--accent': accent,
      '--accent-text': blackOrWhite(accent),
      '--accent-soft': accentSoft,
      '--accent-ink': readable(accent, text, accentSoft, 4.5),
      '--now': readable(dark ? '#fcd34d' : '#b45309', text, nowBg, 4.5),
      '--now-bg': nowBg,
      '--warn': readable(dark ? '#ff9d94' : '#b42318', text, warnBg, 4.5),
      '--warn-bg': warnBg,
      '--bar': picked,
      '--bar-text': blackOrWhite(picked),
      // An installed iPhone app gets its clock and battery drawn in white over
      // the top of the bar, which a pale bar swallows. The strip under them is
      // the bar's colour darkened until white reads on it.
      '--status-strip': readable(picked, '#000000', '#ffffff', 4.5),
      '--shadow': dark
        ? '0 1px 2px rgba(0, 0, 0, .5), 0 8px 24px rgba(0, 0, 0, .35)'
        : '0 1px 2px rgba(16, 24, 40, .06), 0 8px 24px rgba(16, 24, 40, .06)',
    },
  };
}

/** The saved theme, or the default one. Custom colours are remembered while
    a preset is on, so going back to «Δικά σου» finds them where they were. */
function loadTheme() {
  const raw = load(KEY_THEME, null) || {};
  const known = THEMES.concat(CUSTOM_THEME).some((t) => t.id === raw.preset);
  return { preset: known ? raw.preset : 'default', accent: asHex(raw.accent), bg: asHex(raw.bg) };
}

/** Repaint the whole app in `theme`. Returns the custom properties it had to
    set by hand, which is what index.html replays on the next launch. */
function applyTheme(theme) {
  const root = document.documentElement;
  const custom = theme.preset === 'custom' && theme.accent && theme.bg
    ? customPalette(theme.accent, theme.bg) : null;
  root.removeAttribute('style');
  if (custom || THEMES.some((t) => t.id === theme.preset && t.id !== 'default')) {
    root.setAttribute('data-theme', theme.preset);
  } else {
    root.removeAttribute('data-theme');
  }
  if (custom) {
    for (const [name, value] of Object.entries(custom.vars)) root.style.setProperty(name, value);
  }
  const chrome = custom ? [custom.chrome, custom.chrome]
    : (THEMES.find((t) => t.id === theme.preset) || THEMES[0]).chrome;
  document.querySelector('meta[name="theme-color"][media*="light"]').setAttribute('content', chrome[0]);
  document.querySelector('meta[name="theme-color"][media*="dark"]').setAttribute('content', chrome[1]);
  return custom ? custom.vars : null;
}

function setTheme(theme) {
  state.theme = theme;
  const vars = applyTheme(theme);
  save(KEY_THEME, vars ? { ...theme, vars } : theme);
}

function openThemeSheet() {
  renderThemeSheet();
  $('themeSheet').showModal();
}

function renderThemeSheet() {
  const theme = state.theme;
  const body = $('themeBody');
  body.innerHTML = '';

  const options = document.createElement('div');
  options.className = 'themes';
  for (const t of THEMES.concat(CUSTOM_THEME)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-opt' + (theme.preset === t.id ? ' is-on' : '');
    btn.setAttribute('aria-pressed', String(theme.preset === t.id));
    // Each preview is a little copy of the app wearing that theme: the
    // [data-theme] blocks in app.css apply to it as they would to the page.
    btn.innerHTML = `<span class="swatch" data-theme="${t.id}" aria-hidden="true">`
      + '<span class="swatch__bar"></span><span class="swatch__card">'
      + '<span class="swatch__dot"></span><span class="swatch__line"></span></span></span>'
      + esc(t.name);
    btn.addEventListener('click', () => chooseTheme(t.id));
    options.appendChild(btn);
  }
  const presets = document.createElement('div');
  presets.className = 'field';
  presets.innerHTML = '<p class="field__label">Χρώματα</p>'
    + '<p class="field__note">Το AMOLED είναι πάντα μαύρο. Η Προεπιλογή και το Ροζ'
    + ' ακολουθούν το φωτεινό ή σκοτεινό θέμα του κινητού.</p>';
  presets.appendChild(options);
  body.appendChild(presets);
  paintCustomSwatch();

  if (theme.preset !== 'custom') return;
  const own = document.createElement('div');
  own.className = 'field';
  own.innerHTML = '<p class="field__label">Δικά σου χρώματα</p>'
    + '<p class="field__note">Τα γράμματα γίνονται μόνα τους μαύρα ή άσπρα,'
    + ' ώστε να διαβάζονται πάντα.</p>';
  const rows = document.createElement('div');
  rows.className = 'colors';
  rows.appendChild(colourRow('accent', 'Κύριο χρώμα'));
  rows.appendChild(colourRow('bg', 'Φόντο'));
  own.appendChild(rows);
  body.appendChild(own);
}

/** The «Δικά σου» preview shows the student's own colours, once there are any. */
function paintCustomSwatch() {
  const swatch = document.querySelector('.swatch[data-theme="custom"]');
  if (!swatch) return;
  const { accent, bg } = state.theme;
  swatch.removeAttribute('style');
  swatch.classList.toggle('swatch--any', !(accent && bg));
  if (!(accent && bg)) return;
  for (const [name, value] of Object.entries(customPalette(accent, bg).vars)) {
    swatch.style.setProperty(name, value);
  }
}

function chooseTheme(id) {
  const theme = { ...state.theme, preset: id };
  if (id === 'custom' && !(theme.accent && theme.bg)) {
    // Start from whatever is on screen, so the first tap changes nothing and
    // the student adjusts from there instead of from an arbitrary colour.
    const css = getComputedStyle(document.documentElement);
    theme.accent = asHex(css.getPropertyValue('--accent')) || THEMES[0].chrome[0];
    theme.bg = asHex(css.getPropertyValue('--bg')) || '#f4f5f7';
  }
  setTheme(theme);
  renderThemeSheet();
}

/** A colour picker for the look of it, and the hex beside it for an exact
    value — not every phone's picker lets you type one in. */
function colourRow(key, label) {
  const row = document.createElement('div');
  row.className = 'color-row';
  row.innerHTML = `<label class="color-row__name" for="pick-${key}">${esc(label)}</label>`
    + `<input type="text" class="color-row__hex" value="${state.theme[key]}" maxlength="7"`
    + ` spellcheck="false" autocomplete="off" autocapitalize="off" aria-label="${esc(label)} σε hex">`
    + `<input type="color" id="pick-${key}" value="${state.theme[key]}">`;
  const [text, picker] = row.querySelectorAll('input');
  // Not re-rendered on every change: rebuilding the sheet would pull the input
  // out from under a finger that is still dragging across the colour picker.
  const set = (value) => {
    setTheme({ ...state.theme, [key]: value });
    paintCustomSwatch();
  };
  picker.addEventListener('input', () => {
    text.value = picker.value;
    text.removeAttribute('aria-invalid');
    set(picker.value);
  });
  text.addEventListener('input', () => {
    const value = asHex(text.value.trim().replace(/^#?/, '#'));
    text.setAttribute('aria-invalid', String(!value));
    if (!value) return;
    picker.value = value;
    set(value);
  });
  // On leaving the field, show what is actually in use — tidied, or put back
  // if what was typed never became a colour.
  text.addEventListener('change', () => {
    text.value = state.theme[key];
    text.removeAttribute('aria-invalid');
  });
  return row;
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

async function checkForUpdate({ silent, throttled = silent }) {
  // With nothing loaded there is nothing to compare against: whatever arrives
  // is the schedule, and start() is what takes it.
  if (!state.schedule) return start();
  if (checking) return;
  if (throttled) {
    const last = Number(load(KEY_LAST_CHECK, 0)) || 0;
    if (Date.now() - last < CHECK_INTERVAL_MS) return;
  }
  checking = true;
  try {
    const candidate = await fetchSchedule(REMOTE_SCHEDULE_URL, { fresh: true });
    save(KEY_LAST_CHECK, Date.now());
    if (!isNewer(candidate, state.schedule)) {
      if (!silent) banner({ id: 'uptodate', text: 'Το πρόγραμμα είναι ενημερωμένο.' });
      return;
    }
    if (load(KEY_DISMISSED, null) === stamp(candidate)) return;
    save(KEY_PENDING, candidate);
    offerSchedule(candidate);
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

function offerSchedule(candidate) {
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
}

/** A newer schedule found on an earlier visit and not taken yet. Offered again
    on every open, offline too — otherwise closing the app without tapping the
    banner hides it until the next background check is due. */
function offerPendingSchedule() {
  const raw = load(KEY_PENDING, null);
  if (!raw) return;
  let pending = null;
  try {
    pending = validateSchedule(raw);
  } catch (err) { /* fall through and drop it */ }
  if (!pending || !isNewer(pending, state.schedule) || load(KEY_DISMISSED, null) === stamp(pending)) {
    localStorage.removeItem(KEY_PENDING);
    return;
  }
  offerSchedule(pending);
}

function applySchedule(schedule) {
  state.schedule = schedule;
  save(KEY_SCHEDULE, schedule);
  save(KEY_DISMISSED, stamp(schedule));
  localStorage.removeItem(KEY_PENDING);

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
    const offer = () => banner({
      id: 'appupdate',
      text: 'Νέα έκδοση της εφαρμογής.',
      actionText: 'Επαναφόρτωση',
      // Whichever version is waiting by the time of the tap, not the one that
      // raised the banner — a newer deploy may have replaced it since.
      onAction: () => { if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' }); },
    });
    // A version that finished installing on an earlier visit is already waiting,
    // and updatefound will not fire for it again.
    if (reg.waiting && navigator.serviceWorker.controller) offer();
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) offer();
      });
    });
  }).catch(() => { /* http:// without a secure context — the app still runs */ });

  // The very first install also takes control of this page, which fires
  // controllerchange with nothing to replace. Reloading then would throw away
  // whatever the student has already tapped in the picker.
  let controlled = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    const replaced = controlled;
    controlled = true;
    if (!replaced || reloading) return;
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
  if (!state.schedule) return;   // the load error stands in for both views
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
  $('themeBtn').addEventListener('click', openThemeSheet);
  $('pickerClose').addEventListener('click', () => $('picker').close());
  $('themeClose').addEventListener('click', () => $('themeSheet').close());
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
  $('retryBtn').addEventListener('click', start);
  window.addEventListener('online', start);

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
  // index.html has already put the colours up; this catches the status bar,
  // and anything the <head> could not make sense of falls back to the default.
  state.theme = loadTheme();
  applyTheme(state.theme);
  wire();
  setupInstall();
  registerServiceWorker();
  await start();
}

let starting = false;

/** Everything that needs a schedule. A first visit with no connection has
    none yet, and gets another go — from the button, when the phone comes back
    online, or when the app is opened again — instead of an error until it is
    reinstalled. */
async function start() {
  if (starting || state.schedule) return;
  starting = true;
  let fetchedRemote = false;
  try {
    const initial = await loadInitialSchedule();
    state.schedule = initial.schedule;
    fetchedRemote = initial.fetchedRemote;
  } catch (err) {
    showLoadError(err);
    return;
  } finally {
    starting = false;
  }
  $('loadError').hidden = true;

  state.selection = pruneSelection(load(KEY_SELECTION, null), state.schedule);

  if (!state.selection) {
    openPicker();
  } else {
    render();
  }

  setView('today');
  startTicking();
  offerPendingSchedule();
  // Skip the check when the bundle we just fetched *is* the remote file.
  // Otherwise a cold start always checks, throttle or not: it costs one 304,
  // and it is the first thing that runs after an app update — which an older
  // version, one that did not keep the schedule it found, may have been asked
  // for before its «Νέο πρόγραμμα» banner was tapped.
  if (!fetchedRemote) checkForUpdate({ silent: true, throttled: false });
}

/** The views stay where they are, empty, so the moment a schedule arrives
    start() has somewhere to draw it. */
function showLoadError(err) {
  $('view-today').hidden = true;
  $('view-week').hidden = true;
  $('loadErrorText').textContent = err && err.kind === 'data'
    ? 'Δεν ήταν δυνατή η φόρτωση του προγράμματος: το αρχείο του σχολείου δεν είναι έγκυρο.'
    : 'Δεν ήταν δυνατή η φόρτωση του προγράμματος. Έλεγξε τη σύνδεσή σου και δοκίμασε ξανά.';
  $('loadError').hidden = false;
}

boot();
