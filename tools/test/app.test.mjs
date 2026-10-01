/* Exercises app.js's merge and clock logic without a browser.

   app.js is loaded into a sandbox with just enough of a DOM to satisfy it, and
   the functions students actually depend on — buildGrid, lessonRoom, the
   status card, the update check — are called directly against the real
   data/schedule.json and against a small hand-made timetable.

     node tools/test/app.test.mjs

   Everything that reads the real schedule is written as an invariant over it,
   not as «Α2 has Γαλλικά on Wednesday», so a new PDF import does not break it.
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEDULE_TEXT = readFileSync(resolve(root, 'data/schedule.json'), 'utf8');
const SCHEDULE = JSON.parse(SCHEDULE_TEXT);

/* ------------------------------------------------------------ minimal DOM */

function element() {
  return {
    innerHTML: '', className: '', textContent: '', hidden: false, disabled: false,
    style: {}, dataset: {}, children: [],
    setAttribute() {}, addEventListener() {}, remove() {},
    insertAdjacentHTML() {},
    appendChild(child) { this.children.push(child); return child; },
    querySelector: () => null, querySelectorAll: () => [],
  };
}

const elements = new Map();
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  createElement: element,
  querySelector: () => null,
  querySelectorAll: () => [],
};

const storage = new Map();
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

/* ---------------------------------------------------------------- load app */

const source = readFileSync(resolve(root, 'app.js'), 'utf8');
const withoutBoot = source.replace(/\nboot\(\);\s*$/, '\n');
assert.notEqual(withoutBoot, source, 'app.js no longer ends with boot(); — update this test');

const sandbox = {
  document, localStorage, location: { search: '' }, navigator: {},
  URLSearchParams, Response, Headers, Date, Math, JSON, Promise, Error, console,
  setTimeout, clearTimeout,
  fetch: async () => { throw new TypeError('no fetch stubbed'); },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(withoutBoot, sandbox, { filename: 'app.js' });

// Top-level const/function declarations live in the context's script scope.
const app = (name) => vm.runInContext(name, sandbox);
const state = app('state');

/* ----------------------------------------------------------------- helpers */

/** Every selection the picker can produce, built by asking the picker itself
    what it offers at each step — so this follows the app, not a copy of it. */
function everySelection(schedule) {
  state.schedule = schedule;
  const pickerModel = app('pickerModel');
  const out = [];
  for (const grade of pickerModel(null, {}).grades) {
    for (const section of pickerModel(grade, {}).sections.map((g) => g.label)) {
      const tracks = [...pickerModel(grade, { section }).tracks.values()].flat().map((g) => g.label);
      for (const track of [null, ...tracks]) {
        const model = pickerModel(grade, { section, track });
        const kontra = [...model.kontra.values()].flat().map((g) => g.label);
        for (const k of [null, ...kontra]) {
          const base = { grade, section, track, kontra: k, extras: [] };
          out.push(base);
          for (const extra of model.extras) out.push({ ...base, extras: [extra.label] });
        }
      }
    }
  }
  return out;
}

const describe = (sel) => [sel.section, sel.track, sel.kontra, ...sel.extras].filter(Boolean).join('+');

/** Render just the status card at a given local time and return its headline. */
function headline(schedule, selection, iso) {
  state.schedule = schedule;
  state.selection = selection;
  state.grid = app('buildGrid')(schedule, selection).grid;
  const date = new Date(iso);
  const status = app('clockStatus')(schedule, date);
  const rolled = app('dayIsOver')(status);
  const listed = rolled ? app('nextLessonDay')(status) : status.dayIdx;
  app('renderStatusCard')(date, status, rolled, listed);
  const m = /status__headline">([^<]*)</.exec(document.getElementById('statusCard').innerHTML);
  return m && m[1];
}

/* ---------------------------------------------------------------- the tests */

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', `${name} — ${err.message}`]); }
}

const selections = everySelection(SCHEDULE);

await test('the picker offers a selection for every visible section', async () => {
  const sections = new Set(selections.map((s) => s.section));
  const visible = Object.values(SCHEDULE.groups)
    .filter((g) => g.kind === 'section' && !g.hidden).map((g) => g.label);
  for (const label of visible) assert.ok(sections.has(label), `${label} cannot be picked`);
});

await test('no selection a student can make ends in a «Σύγκρουση»', async () => {
  const bad = [];
  for (const sel of selections) {
    const { conflicts } = app('buildGrid')(SCHEDULE, sel);
    if (conflicts.length) {
      const c = conflicts[0];
      bad.push(`${describe(sel)} at ${SCHEDULE.days[c.d]} ${c.p}η (${c.a.subject} vs ${c.b.subject})`);
    }
  }
  assert.equal(bad.length, 0, `${bad.length} of ${selections.length}: ${bad.slice(0, 3).join('; ')}`);
});

await test('no lesson of a picked group disappears from the week', async () => {
  // A slot may be taken over by a split group (Γαλλικά for Γερμανικά), but
  // then the dropped lesson is recorded in `replaces`. Anything else missing
  // is a lesson the student would never be told about.
  const buildGrid = app('buildGrid');
  for (const sel of selections) {
    const { grid } = buildGrid(SCHEDULE, sel);
    for (const id of [sel.section, sel.track, sel.kontra, ...sel.extras].filter(Boolean)) {
      for (const l of SCHEDULE.groups[id].lessons) {
        const slot = grid[l.d][l.p - 1];
        assert.ok(slot, `${describe(sel)}: ${id} ${SCHEDULE.days[l.d]} ${l.p}η is empty`);
        const accounted = slot.subject === l.subject
          || (slot.replaces || []).some((r) => r.group === id && r.subject === l.subject)
          || (slot.clash || []).some((c) => c.group === id);
        assert.ok(accounted,
          `${describe(sel)}: ${id}'s ${l.subject} on ${SCHEDULE.days[l.d]} ${l.p}η vanished under ${slot.subject}`);
      }
    }
  }
});

await test('a split group takes its class\'s hour only when that class is picked', async () => {
  const buildGrid = app('buildGrid');
  const split = Object.values(SCHEDULE.groups).filter((g) => g.parallel && g.lessons.length && !g.hidden);
  for (const g of split) {
    const parent = SCHEDULE.groups[g.parent];
    const withClass = buildGrid(SCHEDULE, { section: g.parent, extras: [g.label] }).grid;
    for (const l of g.lessons) {
      assert.equal(withClass[l.d][l.p - 1].group, g.label,
        `${g.label} should replace ${g.parent} on ${SCHEDULE.days[l.d]} ${l.p}η`);
    }
    // Picked beside some other class, an overlap is a real clash, not a
    // licence to delete that class's lesson.
    const other = Object.values(SCHEDULE.groups).find((o) => o.kind === 'section' && !o.hidden
      && o.label !== parent.label
      && g.lessons.some((l) => o.lessons.some((ol) => ol.d === l.d && ol.p === l.p)));
    if (other) {
      const { conflicts } = buildGrid(SCHEDULE, { section: other.label, extras: [g.label] });
      assert.ok(conflicts.length, `${g.label} silently replaced ${other.label}'s lesson`);
    }
  }
});

await test('a τμήμα ένταξης adds its teacher to the class, never a clash', async () => {
  const buildGrid = app('buildGrid');
  const teachers = app('teachers');
  const coteach = Object.values(SCHEDULE.groups).filter((g) => g.coteach && g.lessons.length);
  assert.ok(coteach.length, 'no τμήμα ένταξης in the data to check');
  for (const g of coteach) {
    const parent = SCHEDULE.groups[g.parent];
    const sel = parent.kind === 'section'
      ? { section: parent.label, extras: [] }
      : { section: Object.values(SCHEDULE.groups).find((s) => s.kind === 'section' && s.grade === parent.grade && !s.hidden).label,
          track: parent.label, extras: [] };
    const { grid, conflicts } = buildGrid(SCHEDULE, sel);
    assert.equal(conflicts.length, 0, `${g.label} caused a clash`);
    for (const l of g.lessons.filter((x) => x.teacher)) {
      const slot = grid[l.d][l.p - 1];
      if (slot.group !== g.parent && slot.group !== g.label) continue;  // someone else's room
      assert.ok(teachers(slot).some((t) => t.startsWith(l.teacher)),
        `${l.teacher} (${g.label}) missing from ${SCHEDULE.days[l.d]} ${l.p}η`);
    }
  }
});

await test('a lesson held outside names no room; every classroom lesson names one', async () => {
  const buildGrid = app('buildGrid');
  const lessonRoom = app('lessonRoom');
  const outside = new Set(SCHEDULE.roomlessSubjects || []);
  state.schedule = SCHEDULE;
  for (const sel of selections) {
    for (const row of buildGrid(SCHEDULE, sel).grid) {
      for (const l of row) {
        if (!l) continue;
        const room = lessonRoom(l);
        if (outside.has(l.subject)) {
          assert.equal(room, '', `${describe(sel)}: ${l.subject} sent to ${room}`);
        } else if (!SCHEDULE.groups[l.group].parallel) {
          // Split groups are allowed a blank until the school says where they
          // go; the import report lists them.
          assert.ok(room, `${describe(sel)}: ${l.subject} (${l.group}) has no room`);
        }
      }
    }
  }
});

/* A hand-made week, so the clock tests do not depend on any real class.
   Monday: nothing 1st, lessons 2nd and 4th, free 3rd. Tuesday–Friday: 1st only. */
const TINY = {
  schemaVersion: 1, version: 't', generatedAt: '2026-01-01T00:00:00Z',
  days: ['Δευτέρα', 'Τρίτη', 'Τετάρτη', 'Πέμπτη', 'Παρασκευή'],
  periods: [
    { n: 1, start: '08:10', end: '08:55' }, { n: 2, start: '09:00', end: '09:45' },
    { n: 3, start: '09:55', end: '10:40' }, { n: 4, start: '10:50', end: '11:35' },
  ],
  groups: {
    Χ1: { label: 'Χ1', grade: 'Α', kind: 'section', room: 'Αίθ. 1', lessons: [
      { d: 0, p: 2, subject: 'Ιστορία' }, { d: 0, p: 4, subject: 'Φυσική' },
      { d: 1, p: 1, subject: 'Χημεία' }, { d: 2, p: 1, subject: 'Χημεία' },
      { d: 3, p: 1, subject: 'Χημεία' }, { d: 4, p: 1, subject: 'Χημεία' },
    ] },
  },
};
const X1 = { section: 'Χ1', extras: [] };

// 2026-10-05 is a Monday.
await test('status card: the right headline at each point of the day', async () => {
  const cases = [
    ['2026-10-05T07:30', 'Πριν το πρώτο μάθημα'],
    // The school's 1st period is running, but this student starts 2nd.
    ['2026-10-05T08:20', 'Πριν το πρώτο μάθημα'],
    ['2026-10-05T08:57', 'Πριν το πρώτο μάθημα'],
    ['2026-10-05T09:10', 'Ιστορία'],
    ['2026-10-05T09:50', 'Διάλειμμα'],
    ['2026-10-05T10:00', 'Κενό'],
    ['2026-10-05T11:00', 'Φυσική'],
    ['2026-10-05T12:00', 'Τελείωσαν τα μαθήματα'],
    ['2026-10-10T12:00', 'Δεν έχει μάθημα σήμερα'],
  ];
  for (const [iso, want] of cases) {
    assert.equal(headline(TINY, X1, iso), want, `at ${iso}`);
  }
});

await test('the today tab names the day it shows once today is over', async () => {
  const label = (iso) => {
    state.schedule = TINY;
    state.grid = app('buildGrid')(TINY, X1).grid;
    const status = app('clockStatus')(TINY, new Date(iso));
    const rolled = app('dayIsOver')(status);
    const listed = rolled ? app('nextLessonDay')(status) : status.dayIdx;
    return app('todayTabLabel')(status, rolled, listed);
  };
  const cases = [
    ['2026-10-05T07:30', 'Σήμερα'],
    ['2026-10-05T11:00', 'Σήμερα'],
    ['2026-10-05T12:00', 'Αύριο · Τρίτη'],
    // Friday afternoon and Saturday both list Monday, which is not tomorrow.
    ['2026-10-09T12:00', 'Δευτέρα'],
    ['2026-10-10T12:00', 'Δευτέρα'],
    ['2026-10-11T12:00', 'Αύριο · Δευτέρα'],
  ];
  for (const [iso, want] of cases) assert.equal(label(iso), want, `at ${iso}`);
});

await test('custom colours always leave text readable', async () => {
  const customPalette = app('customPalette');
  const contrast = app('contrast');
  // Every pairing a student could plausibly pick, and the ones that are hard:
  // pure white and black, a mid grey that sits between them, pale accents on
  // pale backgrounds and dark on dark.
  const colours = ['#ffffff', '#000000', '#808080', '#767676', '#f4f5f7', '#ffd000',
    '#ffff00', '#1d4ed8', '#7d9dff', '#db2777', '#ff69b4', '#1db954', '#003366',
    '#3b0764', '#fef3c7', '#e11d48', '#0b1020', '#9ca3af'];
  const bad = [];
  for (const accent of colours) {
    for (const bg of colours) {
      const v = customPalette(accent, bg).vars;
      const pairs = [
        ['text on background', v['--text'], v['--bg'], 4.5],
        ['text on cards', v['--text'], v['--surface'], 4.5],
        ['grey text on cards', v['--muted'], v['--surface'], 4.5],
        ['button text', v['--accent-text'], v['--accent'], 4.5],
        ['«Επόμενο» tag', v['--accent-ink'], v['--accent-soft'], 4.5],
        ['running lesson', v['--now'], v['--now-bg'], 4.5],
        ['warning', v['--warn'], v['--warn-bg'], 4.5],
      ];
      for (const [what, fg, back, min] of pairs) {
        const ratio = contrast(fg, back);
        if (ratio < min) bad.push(`${accent} on ${bg}: ${what} ${fg}/${back} is ${ratio.toFixed(2)}:1`);
      }
    }
  }
  assert.equal(bad.length, 0, `${bad.length} unreadable: ${bad.slice(0, 4).join('; ')}`);
});

await test('every theme app.js offers is one index.html and app.css know', async () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const css = readFileSync(resolve(root, 'app.css'), 'utf8');
  const themes = app('THEMES');
  // The <head> applies the saved theme before app.js has loaded, from the
  // same storage key and for the same set of names.
  assert.ok(html.includes(`'${app('KEY_THEME')}'`), 'index.html reads a different key');
  const listed = /\^\(([a-z|]+)\)\$/.exec(html);
  assert.ok(listed, 'no theme list found in index.html');
  assert.deepEqual(listed[1].split('|').sort(),
    Array.from(themes.filter((t) => t.id !== 'default'), (t) => t.id).concat('custom').sort());
  for (const t of themes) {
    if (t.id !== 'default') assert.ok(css.includes(`[data-theme="${t.id}"]`), `app.css has no ${t.id}`);
    for (const c of t.chrome) assert.ok(css.includes(c), `${t.id}'s status bar ${c} is in no theme`);
  }
});

await test('a saved theme that makes no sense falls back to the default', async () => {
  storage.clear();
  storage.set(app('KEY_THEME'), JSON.stringify({ preset: 'neon', accent: 'red', bg: '#12345' }));
  assert.deepEqual({ ...app('loadTheme')() }, { preset: 'default', accent: null, bg: null });
  storage.set(app('KEY_THEME'), '{not json');
  assert.equal(app('loadTheme')().preset, 'default');
  storage.set(app('KEY_THEME'), JSON.stringify({ preset: 'pink', accent: '#ABCDEF', bg: '#000000' }));
  assert.deepEqual({ ...app('loadTheme')() }, { preset: 'pink', accent: '#abcdef', bg: '#000000' });
  storage.clear();
});

await test('an update check with no connection says so, and is not counted', async () => {
  // The service worker answers from its cache when offline and labels the
  // copy. Taken at face value it read as «Το πρόγραμμα είναι ενημερωμένο».
  state.schedule = JSON.parse(SCHEDULE_TEXT);
  state.selection = null;
  sandbox.fetch = async () => new Response(SCHEDULE_TEXT, {
    status: 200, headers: { 'X-Served-From': 'cache' },
  });
  storage.clear();
  const shown = document.getElementById('banners').children;
  shown.length = 0;
  await app('checkForUpdate')({ silent: false });
  assert.deepEqual(shown.map((b) => b.dataset.banner), ['nocheck']);
  assert.equal(localStorage.getItem(app('KEY_LAST_CHECK')), null,
    'an offline check must not throttle the next real one');
});

await test('the same cached copy is still good enough for a first load', async () => {
  sandbox.fetch = async () => new Response(SCHEDULE_TEXT, {
    status: 200, headers: { 'X-Served-From': 'cache' },
  });
  const got = await app('fetchSchedule')('data/schedule.json');
  assert.equal(got.version, SCHEDULE.version);
});

await test('a real answer with nothing newer says the schedule is current', async () => {
  state.schedule = JSON.parse(SCHEDULE_TEXT);
  sandbox.fetch = async () => new Response(SCHEDULE_TEXT, { status: 200 });
  storage.clear();
  const shown = document.getElementById('banners').children;
  shown.length = 0;
  await app('checkForUpdate')({ silent: false });
  assert.deepEqual(shown.map((b) => b.dataset.banner), ['uptodate']);
  assert.ok(localStorage.getItem(app('KEY_LAST_CHECK')), 'a real check is recorded');
});

/* ------------------------------------------------------------------- report */

let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed++;
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed · ${selections.length} selections checked`);
process.exit(failed ? 1 : 0);
