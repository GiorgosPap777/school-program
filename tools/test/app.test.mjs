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
import { createHash } from 'node:crypto';
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
    style: {}, dataset: {}, children: [], parent: null,
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    setAttribute() {}, showModal() {}, close() {}, focus() {},
    // Kept, so a test can press a button app.js made.
    addEventListener(type, fn) { (this.on = this.on || {})[type] = fn; },
    insertAdjacentHTML() {},
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    remove() {
      const siblings = this.parent ? this.parent.children : [];
      if (siblings.includes(this)) siblings.splice(siblings.indexOf(this), 1);
      this.parent = null;
    },
    querySelector: () => null, querySelectorAll: () => [],
  };
}

const elements = new Map();
// What wire() hangs on window and document, so a test can fire it.
const listeners = { window: {}, document: {} };
const document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  },
  createElement: element,
  // Only the one lookup app.js does by selector: a banner by its id.
  querySelector(selector) {
    const m = /^\[data-banner="([^"]+)"\]$/.exec(selector);
    return (m && document.getElementById('banners').children
      .find((b) => b.dataset.banner === m[1])) || null;
  },
  querySelectorAll: () => [],
  addEventListener: (type, fn) => { listeners.document[type] = fn; },
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
sandbox.addEventListener = (type, fn) => { listeners.window[type] = fn; };
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
        // An hour of an orientation or κόντρα not picked yet: no group, no room.
        if (!l || l.unpicked) continue;
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

await test('an orientation or κόντρα hour never reads as free before its group is picked', async () => {
  // A Β′ student who saved without an orientation was told «Κενό · Τώρα»
  // through every orientation hour, and could have walked out of school.
  const buildGrid = app('buildGrid');
  state.schedule = SCHEDULE;
  const busy = (sel) => buildGrid(SCHEDULE, sel).grid.map((row) => row.map(Boolean));
  const sameClass = new Map();
  for (const sel of selections) {
    const key = `${sel.section}|${sel.extras.join(',')}`;
    if (!sameClass.has(key)) sameClass.set(key, []);
    sameClass.get(key).push(sel);
  }
  let compared = 0;
  for (const group of sameClass.values()) {
    for (const partial of group.filter((sel) => !sel.track || !sel.kontra)) {
      const shown = busy(partial);
      for (const full of group) {
        if (partial.track && full.track !== partial.track) continue;
        if (partial.kontra && full.kontra !== partial.kontra) continue;
        busy(full).forEach((row, d) => row.forEach((taken, p) => {
          assert.ok(!taken || shown[d][p], `${describe(partial)} shows ${SCHEDULE.days[d]} `
            + `${p + 1}η as free, but ${describe(full)} has a lesson then`);
        }));
        compared++;
      }
    }
  }
  assert.ok(compared > 0, 'no selection without an orientation or κόντρα to compare');
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

await test('an hour of a group not picked yet says what it is', async () => {
  // TINY plus one orientation (Monday 3rd) and one κόντρα (Tuesday 2nd).
  const ORIENTED = {
    ...TINY,
    kontraByTrack: { Θετικών: 'Ιστορία (Κόντρα)' },
    groups: {
      ...TINY.groups,
      Χθ: { label: 'Χθ', grade: 'Α', kind: 'track', track: 'Θετικών', room: 'Αίθ. 2',
        lessons: [{ d: 0, p: 3, subject: 'Φυσική Π' }] },
      Χιστ: { label: 'Χιστ', grade: 'Α', kind: 'kontra', track: 'Ιστορία (Κόντρα)', room: 'Αίθ. 3',
        lessons: [{ d: 1, p: 2, subject: 'Ιστορία' }] },
    },
  };
  const pick = (track, kontra) => ({ grade: 'Α', section: 'Χ1', track, kontra, extras: [] });
  const cases = [
    [pick(null, null), '2026-10-05T10:00', 'Ώρα κατεύθυνσης'],
    [pick('Χθ', null), '2026-10-05T10:00', 'Φυσική Π'],
    // Which κόντρα subject is known from the orientation; without one it is not.
    [pick('Χθ', null), '2026-10-06T09:10', 'Ιστορία (Κόντρα)'],
    [pick(null, null), '2026-10-06T09:10', 'Μάθημα επιλογής (Κόντρα)'],
    [pick('Χθ', 'Χιστ'), '2026-10-06T09:10', 'Ιστορία'],
  ];
  for (const [sel, iso, want] of cases) {
    assert.equal(headline(ORIENTED, sel, iso), want, `${describe(sel)} at ${iso}`);
  }
  // And the row in the list says what is missing.
  const list = document.getElementById('todayList');
  list.children.length = 0;
  state.grid = app('buildGrid')(ORIENTED, pick(null, null)).grid;
  const status = app('clockStatus')(ORIENTED, new Date('2026-10-05T10:00'));
  app('renderDayList')(list, 0, status, false);
  const row = list.children.find((li) => li.innerHTML.includes('Ώρα κατεύθυνσης'));
  assert.ok(row, 'no «Ώρα κατεύθυνσης» row');
  assert.ok(row.innerHTML.includes('δεν έχεις διαλέξει ομάδα'), 'the row does not say why');
});

await test('a schedule with no version or date is refused, and cannot strand anyone', async () => {
  // One like that was offered as «έκδοση undefined», and once taken, no
  // schedule published after it ever compared as newer.
  const validate = app('validateSchedule');
  const isNewer = app('isNewer');
  for (const field of ['version', 'generatedAt']) {
    const broken = JSON.parse(SCHEDULE_TEXT);
    delete broken[field];
    assert.throws(() => validate(broken), /Μη έγκυρο/, `accepted with no ${field}`);
  }
  const real = JSON.parse(SCHEDULE_TEXT);
  const unstamped = JSON.parse(SCHEDULE_TEXT);
  delete unstamped.version;
  delete unstamped.generatedAt;
  assert.equal(isNewer(real, unstamped), true, 'a real schedule must replace an unstamped one');
  assert.equal(isNewer(unstamped, real), false, 'an unstamped one must never replace a real one');
  // Through the real update check, it is a broken file, not a new schedule.
  state.schedule = real;
  sandbox.fetch = async () => new Response(JSON.stringify(unstamped), { status: 200 });
  storage.clear();
  const shown = document.getElementById('banners').children;
  shown.length = 0;
  await app('checkForUpdate')({ silent: true });
  assert.deepEqual(shown.map((b) => b.dataset.banner), ['baddata']);
});

await test('a first load with no connection can be retried, and nothing breaks meanwhile', async () => {
  // It used to replace both views with an English «Failed to fetch»; ⚙ and
  // «Εβδομάδα» then threw, and a later check called a good schedule «no connection».
  storage.clear();
  state.schedule = null;
  state.selection = null;
  sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await app('start')();
  assert.equal(document.getElementById('loadError').hidden, false, 'no error shown');
  assert.doesNotMatch(document.getElementById('loadErrorText').textContent, /Failed/);
  app('openPicker')();
  app('setView')('week');
  sandbox.fetch = async () => new Response(SCHEDULE_TEXT, { status: 200 });
  await app('checkForUpdate')({ silent: false });
  vm.runInContext('clearTimeout(tickTimer)', sandbox);
  assert.equal(state.schedule && state.schedule.version, SCHEDULE.version, 'still no schedule');
  assert.equal(document.getElementById('loadError').hidden, true, 'the error stayed up');
  assert.equal(document.getElementById('view-today').hidden, false, 'the today view stayed hidden');
});

await test('a schedule an older version kept but never showed is used when offline', async () => {
  storage.clear();
  storage.set(app('KEY_PENDING'), SCHEDULE_TEXT);
  state.schedule = null;
  state.selection = null;
  sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await app('start')();
  vm.runInContext('clearTimeout(tickTimer)', sandbox);
  assert.equal(state.schedule && state.schedule.version, SCHEDULE.version);
  assert.equal(storage.has(app('KEY_PENDING')), false, 'and is no longer pending');
});

await test('an update check is marked for the service worker; a first load is not', async () => {
  const asked = [];
  sandbox.fetch = async (url) => {
    asked.push(String(url));
    return new Response(SCHEDULE_TEXT, { status: 200 });
  };
  await app('fetchSchedule')('data/schedule.json');
  await app('fetchSchedule')('data/schedule.json', { fresh: true });
  assert.deepEqual(asked, ['data/schedule.json', 'data/schedule.json?check=1']);
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

await test('custom colours always leave text and selections readable', async () => {
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
        // Drawn in the main colour alone, so it must stand out from what is
        // around it: WCAG's 3:1 for anything that is not text.
        ['selected chip on a card', v['--accent'], v['--surface'], 3],
        ['selected chip on the page', v['--accent'], v['--bg'], 3],
        ['bar text', v['--bar-text'], v['--bar'], 4.5],
        // An installed iPhone app draws its clock in white over the bar.
        ['iPhone clock', '#ffffff', v['--status-strip'], 4.5],
      ];
      if (v['--bar'] !== accent) bad.push(`${accent} on ${bg}: the bar is ${v['--bar']}, not as picked`);
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

await test('every preset keeps selections visible and the iPhone clock readable', async () => {
  const css = readFileSync(resolve(root, 'app.css'), 'utf8');
  const contrast = app('contrast');
  const blocks = (selector) => [...css.matchAll(new RegExp(`${selector} \\{([^}]*)\\}`, 'g'))]
    .map((m) => Object.fromEntries([...m[1].matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\b/gi)]
      .map(([, name, value]) => [name, value.toLowerCase()])));
  const [defaultLight, defaultDark] = blocks(':root, \\[data-theme="default"\\]');
  const [amoled] = blocks('\\[data-theme="amoled"\\]');
  const [pinkLight, pinkDark] = blocks('\\[data-theme="pink"\\]');
  const presets = { defaultLight, defaultDark, amoled, pinkLight, pinkDark };
  for (const [name, v] of Object.entries(presets)) {
    assert.ok(v && v['--accent'], `${name}: block not found in app.css`);
    const strip = v['--status-strip'] || v['--bar'] || v['--accent'];
    assert.ok(contrast('#ffffff', strip) >= 4.5, `${name}: white clock on ${strip}`);
    for (const back of ['--bg', '--surface']) {
      assert.ok(contrast(v['--accent'], v[back]) >= 3, `${name}: ${v['--accent']} on ${back} ${v[back]}`);
    }
  }
});

await test('the security policy allows exactly the script index.html runs inline', async () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');
  const conf = readFileSync(resolve(root, 'docker/default.conf'), 'utf8');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(inline.length, 1, 'expected one inline script, the theme replay');
  const hash = createHash('sha256').update(inline[0], 'utf8').digest('base64');
  assert.ok(conf.includes(`'sha256-${hash}'`),
    `the <head> script changed: docker/default.conf needs 'sha256-${hash}' in script-src`);
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

await test('the next check that gets through replaces «no connection»', async () => {
  // «Έλεγχος» tapped with no signal, then mobile data turned on: the next check
  // found the new schedule, and «Δεν έγινε έλεγχος — δεν υπάρχει σύνδεση»
  // stayed up above its «Νέο πρόγραμμα».
  const newer = { ...JSON.parse(SCHEDULE_TEXT), version: '2099-01-01', generatedAt: '2099-01-01T00:00:00Z' };
  const offline = async () => new Response(SCHEDULE_TEXT, {
    status: 200, headers: { 'X-Served-From': 'cache' },
  });
  const shown = document.getElementById('banners').children;
  const ids = () => shown.map((b) => b.dataset.banner);
  state.schedule = JSON.parse(SCHEDULE_TEXT);
  state.selection = null;
  storage.clear();
  shown.length = 0;
  app('wire')();

  sandbox.fetch = offline;
  await app('checkForUpdate')({ silent: false });
  assert.deepEqual(ids(), ['nocheck']);
  // Back online. A check from just before the signal went must not hold the
  // answer back for half an hour.
  storage.set(app('KEY_LAST_CHECK'), String(Date.now()));
  sandbox.fetch = async () => new Response(JSON.stringify(newer), { status: 200 });
  await listeners.window.online();
  assert.deepEqual(ids(), ['newdata'], 'coming back online answers the check');

  // Nothing newer: the answer is that, even from a background check.
  shown.length = 0;
  storage.clear();
  sandbox.fetch = offline;
  await app('checkForUpdate')({ silent: false });
  sandbox.fetch = async () => new Response(SCHEDULE_TEXT, { status: 200 });
  await app('checkForUpdate')({ silent: true });
  assert.deepEqual(ids(), ['uptodate']);

  // And the other way round.
  sandbox.fetch = offline;
  await app('checkForUpdate')({ silent: false });
  assert.deepEqual(ids(), ['nocheck']);
  shown.length = 0;
  storage.clear();
});

/* ------------------------------------------------- the student's own changes */

await test('a change goes only over the lesson it was made against', async () => {
  const base = app('buildGrid')(TINY, X1).grid;
  const { grid, marks } = app('applyChanges')(base, {
    '0-2': { subject: 'Λογοτεχνία', teacher: 'Κ', room: 'Αίθ. 9', group: '', was: 'Ιστορία' },
    '0-3': { subject: 'Αγγλικά', teacher: '', room: '', group: '', was: '' },
    '0-4': { free: true, was: 'Φυσική' },
    // Made against a lesson that is not there any more: an orientation
    // picked since, say. It must not land on Χημεία.
    '1-1': { subject: 'Μουσική', teacher: '', room: '', group: '', was: 'Γαλλικά' },
    '9-9': { free: true, was: '' },
  });
  assert.equal(grid[0][1].subject, 'Λογοτεχνία');
  assert.equal(grid[0][2].subject, 'Αγγλικά');
  assert.equal(grid[0][3], null);
  assert.equal(grid[1][0].subject, 'Χημεία');
  assert.deepEqual([...marks.keys()].sort(), ['0-2', '0-3', '0-4']);
  assert.equal(base[0][1].subject, 'Ιστορία', 'the timetable itself was changed');
  state.schedule = TINY;
  assert.equal(app('lessonRoom')(grid[0][1]), 'Αίθ. 9');
  assert.equal(app('lessonRoom')(grid[0][2]), '', 'a typed lesson got a room nobody gave it');
});

await test('changes are kept only with the timetable they were made on', async () => {
  storage.clear();
  state.schedule = JSON.parse(SCHEDULE_TEXT);
  const mine = { Α1: { '0-3': { subject: 'Λογοτεχνία', teacher: 'Τ', room: 'Ρ', group: 'Α1', was: 'Γλώσσα / Λογοτεχνία' } } };
  state.changes = JSON.parse(JSON.stringify(mine));
  app('storeChanges')();
  assert.deepEqual(JSON.parse(JSON.stringify(app('loadChanges')(state.schedule))), mine);
  const corrected = { ...state.schedule, generatedAt: '2099-01-01T00:00:00Z' };
  assert.deepEqual({ ...app('loadChanges')(corrected) }, {}, 'kept onto a different timetable');
  storage.set(app('KEY_CHANGES'), '{not json');
  assert.deepEqual({ ...app('loadChanges')(state.schedule) }, {});
  storage.set(app('KEY_CHANGES'), JSON.stringify({ stamp: app('stamp')(state.schedule),
    classes: { Α1: { 'x': { subject: 'Α', was: '' }, '0-1': { subject: ' ', was: '' }, '0-2': { free: true } } } }));
  assert.deepEqual({ ...app('loadChanges')(state.schedule) }, {}, 'malformed changes were kept');
  // Nothing left: nothing stored.
  state.changes = { Α1: {} };
  app('storeChanges')();
  assert.equal(storage.has(app('KEY_CHANGES')), false);
});

/** A class with a «Γλώσσα / Λογοτεχνία» hour in the real data, and that hour. */
function combinedHour() {
  for (const g of Object.values(SCHEDULE.groups)) {
    if (g.kind !== 'section' || g.hidden) continue;
    const l = g.lessons.find((x) => app('halves')(x.subject).length);
    if (l) return { section: g.label, grade: g.grade, d: l.d, p: l.p, lesson: l };
  }
  return null;
}

await test('a half of a combined hour keeps its teacher and room; the timetable\'s own name undoes it', async () => {
  const hour = combinedHour();
  assert.ok(hour, 'no «X / Y» hour in the data to check');
  state.schedule = SCHEDULE;
  const sel = { grade: hour.grade, section: hour.section, track: null, kontra: null, extras: [] };
  const base = app('buildGrid')(SCHEDULE, sel).grid;
  const orig = base[hour.d][hour.p - 1];
  const [first] = app('halves')(orig.subject);
  const defaults = app('lessonDefaults')(base, orig, first);
  assert.equal(defaults.teacher, orig.teacher || '');
  assert.equal(defaults.room, app('lessonRoom')(orig));
  const changeFromEdit = app('changeFromEdit');
  const edit = { orig, free: false, other: false, otherText: '', subject: first, ...defaults };
  assert.deepEqual({ ...changeFromEdit(edit, base) },
    { subject: first, teacher: defaults.teacher, room: defaults.room, group: defaults.group, was: orig.subject });
  const back = { ...edit, subject: orig.subject, ...app('lessonDefaults')(base, orig, orig.subject) };
  assert.equal(changeFromEdit(back, base), null, 'the timetable\'s own lesson saved as a change');
  // Only the room changed: that is a change, for the few who use it.
  assert.equal(changeFromEdit({ ...back, room: 'Βιβλιοθήκη' }, base).room, 'Βιβλιοθήκη');
  // A free hour left free is no change; a lesson made free is.
  assert.equal(changeFromEdit({ orig: null, free: true }, base), null);
  assert.deepEqual({ ...changeFromEdit({ orig, free: true }, base) }, { free: true, was: orig.subject });
  // A typed name brings no teacher, room or group of its own.
  assert.deepEqual({ ...changeFromEdit({ orig, other: true, otherText: ' Θέατρο ', teacher: '', room: '', group: 'Χ' }, base) },
    { subject: 'Θέατρο', teacher: '', room: '', group: '', was: orig.subject });
});

await test('a subject from the week brings the teacher who teaches it', async () => {
  state.schedule = SCHEDULE;
  for (const sel of selections.filter((s) => !s.track && !s.kontra && !s.extras.length)) {
    const base = app('buildGrid')(SCHEDULE, sel).grid;
    for (const subject of app('weekSubjects')(base)) {
      const got = app('lessonDefaults')(base, null, subject);
      const theirs = base.flat().filter((l) => l && !l.unpicked
        && (l.subject === subject || app('halves')(l.subject).includes(subject)));
      assert.ok(theirs.some((l) => (l.teacher || '') === got.teacher && app('lessonRoom')(l) === got.room),
        `${describe(sel)}: ${subject} came with ${got.teacher} / ${got.room}`);
    }
  }
});

await test('outside edit mode a tap on a lesson does nothing', async () => {
  const hour = combinedHour();
  state.schedule = SCHEDULE;
  state.selection = { grade: hour.grade, section: hour.section, track: null, kontra: null, extras: [] };
  state.changes = {};
  state.editing = false;
  app('render')();
  let opened = 0;
  document.getElementById('editSheet').showModal = () => { opened++; };
  const tap = { type: 'click', target: { closest: () => ({ dataset: { d: String(hour.d), p: String(hour.p) } }) } };
  app('onSlotTap')(tap);
  assert.equal(opened, 0, 'a tap outside edit mode opened the editor');
  app('setEditing')(true);
  app('onSlotTap')(tap);
  assert.equal(opened, 1, 'a tap in edit mode did not');
  assert.equal(state.edit.orig.subject, hour.lesson.subject);
  app('setEditing')(false);
  vm.runInContext('clearTimeout(tickTimer)', sandbox);
});

await test('the day list marks a change and keeps a row for an emptied last hour', async () => {
  state.schedule = TINY;
  state.selection = X1;
  state.changes = { Χ1: { '0-4': { free: true, was: 'Φυσική' } } };
  state.editing = false;
  const list = document.getElementById('todayList');
  const rows = () => {
    list.children.length = 0;
    const built = app('buildGrid')(TINY, X1);
    const mine = app('applyChanges')(built.grid, state.changes.Χ1);
    state.baseGrid = built.grid;
    state.grid = mine.grid;
    state.marks = mine.marks;
    return (d) => {
      list.children.length = 0;
      app('renderDayList')(list, d, app('clockStatus')(TINY, new Date('2026-10-04T12:00')), false);
      return list.children;
    };
  };
  const day = rows();
  const monday = day(0);
  assert.equal(monday.length, 4, 'the emptied 4th hour has no row to undo it from');
  assert.match(monday[3].innerHTML, /Κενό/);
  assert.match(monday[3].innerHTML, /στο πρόγραμμα: Φυσική/);
  assert.doesNotMatch(monday[1].innerHTML, /στο πρόγραμμα/, 'an unchanged hour was marked');
  // Edit mode lists every hour of the school day, so one can be added at the end.
  assert.equal(day(1).length, 1);
  state.editing = true;
  assert.equal(day(1).length, TINY.periods.length);
  state.editing = false;
  state.changes = {};
  state.marks = new Map();
});

await test('a new timetable warns before it wipes the changes, then asks for them back', async () => {
  const hour = combinedHour();
  const real = JSON.parse(SCHEDULE_TEXT);
  const newer = { ...JSON.parse(SCHEDULE_TEXT), version: '2099-01-01', generatedAt: '2099-01-01T00:00:00Z' };
  const shown = document.getElementById('banners').children;
  const text = (id) => (shown.find((b) => b.dataset.banner === id) || {}).innerHTML || '';
  storage.clear();
  shown.length = 0;
  state.schedule = real;
  state.selection = { grade: hour.grade, section: hour.section, track: null, kontra: null, extras: [] };
  const [first] = app('halves')(hour.lesson.subject);
  state.changes = { [hour.section]: { [`${hour.d}-${hour.p}`]: {
    subject: first, teacher: '', room: '', group: '', was: hour.lesson.subject } } };
  app('storeChanges')();

  app('offerSchedule')(newer);
  // Warned, and told they are not lost for good — or the update gets put off.
  assert.match(text('newdata'), /δικές σου αλλαγές θα σβηστούν, αλλά θα σου δείξουμε ποιες ήταν/);
  app('applySchedule')(newer);
  vm.runInContext('clearTimeout(tickTimer)', sandbox);
  assert.deepEqual({ ...state.changes }, {});
  assert.equal(storage.has(app('KEY_CHANGES')), false, 'the old changes are still stored');
  assert.match(text('changes'), /^<p>Ήρθε νέο πρόγραμμα, οπότε οι αλλαγές σου σβήστηκαν/);
  const reminder = [{ when: `${real.days[hour.d]} ${hour.p}η`, what: first, how: `αντί για ${hour.lesson.subject}` }];
  assert.deepEqual(JSON.parse(JSON.stringify(state.recall.items)), reminder);
  // It outlives closing the app, for this class only.
  assert.deepEqual(JSON.parse(JSON.stringify(app('loadRecall')().items)), reminder);
  // Waved away, it is gone for good.
  const bar = shown.find((b) => b.dataset.banner === 'changes');
  bar.children.find((c) => c.className === 'banner__dismiss').on.click();
  assert.equal(state.recall, null);
  assert.equal(storage.has(app('KEY_RECALL')), false, 'a dismissed reminder is still stored');
  // Nothing to warn about without changes.
  shown.length = 0;
  app('offerSchedule')({ ...newer, version: '2099-02-01' });
  assert.doesNotMatch(text('newdata'), /αλλαγές/);
  shown.length = 0;
  storage.clear();
});

await test('a corrected timetable says so, and the reminder goes once it has been seen', async () => {
  const hour = combinedHour();
  const real = JSON.parse(SCHEDULE_TEXT);
  const shown = document.getElementById('banners').children;
  storage.clear();
  shown.length = 0;
  state.schedule = real;
  state.selection = { grade: hour.grade, section: hour.section, track: null, kontra: null, extras: [] };
  state.changes = { [hour.section]: { [`${hour.d}-${hour.p}`]: { free: true, was: hour.lesson.subject } } };
  app('applySchedule')({ ...real, generatedAt: '2099-01-01T00:00:00Z' });
  vm.runInContext('clearTimeout(tickTimer)', sandbox);
  const bar = shown.find((b) => b.dataset.banner === 'changes');
  assert.match(bar.innerHTML, /^<p>Το πρόγραμμα διορθώθηκε,/);
  // Another class picked since: not this one's reminder.
  state.selection = { ...state.selection, section: 'κανένα' };
  assert.equal(app('loadRecall')(), null);
  assert.equal(storage.has(app('KEY_RECALL')), false);
  // «Δες τες» opens edit mode with the list; leaving it is done with it.
  state.selection = { grade: hour.grade, section: hour.section, track: null, kontra: null, extras: [] };
  state.recall = { section: hour.section, corrected: true, items: [{ when: 'Δευτέρα 1η', what: 'Κενό', how: '' }] };
  storage.set(app('KEY_RECALL'), JSON.stringify(state.recall));
  bar.children.find((c) => c.className === 'banner__act').on.click();
  assert.equal(state.editing, true);
  assert.match(document.getElementById('editRecall').innerHTML, /Δευτέρα 1η<\/strong> · Κενό/);
  app('setEditing')(false);
  vm.runInContext('clearTimeout(tickTimer)', sandbox);
  assert.equal(state.recall, null);
  assert.equal(storage.has(app('KEY_RECALL')), false);
  shown.length = 0;
  storage.clear();
});

/** Three Φυσική hours with one teacher — one of them in the lab, one with a
    second teacher beside them — and a Ιστορία on its own. */
const LAB = {
  ...TINY, version: 'lab',
  rooms: { ΕΦ: 'Εργ. Φυσικής' },
  groups: {
    Χ1: { label: 'Χ1', grade: 'Α', kind: 'section', room: 'Αίθ. 1', lessons: [
      { d: 0, p: 1, subject: 'Φυσική', teacher: 'Παπαδόπουλος' },
      { d: 1, p: 2, subject: 'Φυσική', teacher: 'Παπαδόπουλος', room: 'ΕΦ' },
      { d: 2, p: 1, subject: 'Ιστορία', teacher: 'Ιωάννου' },
      { d: 3, p: 3, subject: 'Φυσική', teacher: 'Παπαδόπουλος', with: [{ teacher: 'Λαμπρίδου' }] },
    ] },
  },
};
const LAB_SEL = { grade: 'Α', section: 'Χ1', track: null, kontra: null, extras: [] };

await test('a new teacher or room is what the change says, not the lesson', async () => {
  state.schedule = LAB;
  const base = app('buildGrid')(LAB, LAB_SEL).grid;
  const lab = base[1][1];
  const note = (patch) => app('changeNote')({ subject: 'Φυσική', teacher: 'Παπαδόπουλος',
    room: 'Εργ. Φυσικής', group: '', was: 'Φυσική', ...patch }, lab);
  assert.equal(note({ room: 'Αμφιθέατρο' }), 'στο πρόγραμμα: αίθουσα Εργ. Φυσικής');
  assert.equal(note({ teacher: 'Νικολάου' }), 'στο πρόγραμμα: καθηγητής Παπαδόπουλος');
  assert.equal(note({ teacher: 'Νικολάου', room: '' }),
    'στο πρόγραμμα: καθηγητής Παπαδόπουλος, αίθουσα Εργ. Φυσικής');
  // Another lesson altogether: just the lessons, whatever came with it.
  assert.equal(note({ subject: 'Χημεία', teacher: 'Νικολάου' }), 'στο πρόγραμμα: Φυσική');
  assert.equal(app('changeNote')({ free: true, was: 'Φυσική' }, lab), 'στο πρόγραμμα: Φυσική');
  const sum = (patch) => ({ ...app('changeSummary')({ subject: 'Φυσική', teacher: 'Παπαδόπουλος',
    room: 'Εργ. Φυσικής', group: '', was: 'Φυσική', ...patch }, lab) });
  assert.deepEqual(sum({ room: '' }), { what: 'Φυσική', how: 'χωρίς αίθουσα αντί για Εργ. Φυσικής' });
  assert.deepEqual(sum({ subject: 'Θέατρο' }), { what: 'Θέατρο', how: 'αντί για Φυσική' });

  // On the day list, too — and the second teacher stays with the first.
  const changes = { '1-2': { subject: 'Φυσική', teacher: 'Παπαδόπουλος', room: 'Αμφιθέατρο', group: '', was: 'Φυσική' },
    '3-3': { subject: 'Φυσική', teacher: 'Παπαδόπουλος', room: 'Αμφιθέατρο', group: '', was: 'Φυσική' } };
  const mine = app('applyChanges')(base, changes);
  assert.equal(mine.grid[3][2].with[0].teacher, 'Λαμπρίδου', 'a new room sent the second teacher away');
  const other = app('applyChanges')(base, { '3-3': { ...changes['3-3'], teacher: 'Νικολάου' } });
  assert.equal(other.grid[3][2].with, undefined, 'a new teacher kept the old one\'s partner');
  Object.assign(state, { selection: LAB_SEL, editing: false, baseGrid: base, grid: mine.grid, marks: mine.marks });
  const list = document.getElementById('todayList');
  list.children.length = 0;
  app('renderDayList')(list, 1, app('clockStatus')(LAB, new Date('2026-10-04T12:00')), false);
  assert.match(list.children[1].innerHTML, /✎ στο πρόγραμμα: αίθουσα Εργ\. Φυσικής/);
  assert.doesNotMatch(list.children[1].innerHTML, /στο πρόγραμμα: Φυσική/);
  state.marks = new Map();
});

await test('«και στις άλλες ώρες» changes every hour of the lesson, and only what was changed', async () => {
  storage.clear();
  state.schedule = LAB;
  state.selection = LAB_SEL;
  state.changes = {};
  state.editing = true;
  app('render')();
  vm.runInContext('clearTimeout(tickTimer)', sandbox);
  const body = document.getElementById('editBody');
  const open = (d, p) => { body.children.length = 0; app('openEditSheet')(d, p); return state.edit; };
  const offered = () => body.children.some((c) => c.className === 'everyhour');

  // A lesson with one hour a week has no others to offer.
  open(2, 1);
  assert.equal(offered(), false);
  const e = open(0, 1);
  assert.deepEqual(Array.from(e.siblings), ['0-1', '1-2', '3-3']);
  assert.equal(offered(), true);
  assert.equal(e.all, false, 'a first change starts on this hour alone');
  Object.assign(e, { teacher: 'Νικολάου', all: true });
  app('saveEdit')();
  const mine = state.changes.Χ1;
  assert.deepEqual(Object.keys(mine).sort(), ['0-1', '1-2', '3-3']);
  assert.ok(Object.values(mine).every((c) => c.teacher === 'Νικολάου'));
  assert.equal(mine['1-2'].room, 'Εργ. Φυσικής', 'the lab hour was moved with the teacher');
  assert.equal(mine['0-1'].room, 'Αίθ. 1');
  assert.ok(storage.has(app('KEY_CHANGES')));

  // Listed as one change, and opened as one from any of its hours.
  const rows = () => JSON.parse(JSON.stringify(app('changeRows')(state.baseGrid, state.changes.Χ1 || {})));
  assert.deepEqual(rows(), [{ keys: ['0-1', '1-2', '3-3'], when: 'Όλες οι ώρες «Φυσική» (3)',
    what: '', how: 'καθηγητής Νικολάου αντί για Παπαδόπουλος' }]);
  const again = open(1, 2);
  assert.equal(again.all, true);

  // One hour on its own breaks it back into hours.
  Object.assign(again, { all: false, room: 'Αμφιθέατρο' });
  app('saveEdit')();
  assert.equal(state.changes.Χ1['0-1'].room, 'Αίθ. 1');
  const split = rows();
  assert.equal(split.length, 3);
  assert.equal(split[1].how, 'καθηγητής Νικολάου αντί για Παπαδόπουλος · αίθουσα Αμφιθέατρο αντί για Εργ. Φυσικής');
  assert.equal(open(0, 1).all, false);

  // «Επαναφορά» with the box ticked puts every hour back.
  state.edit.all = true;
  app('resetEdit')();
  assert.equal(state.changes.Χ1, undefined);
  assert.equal(storage.has(app('KEY_CHANGES')), false);

  // A whole lesson made free — an exemption, say — reads as one line.
  const free = open(0, 1);
  Object.assign(free, { free: true, all: true });
  app('saveEdit')();
  assert.deepEqual(rows(), [{ keys: ['0-1', '1-2', '3-3'], when: 'Όλες οι ώρες «Φυσική» (3)', what: 'Κενό', how: '' }]);
  state.changes = {};
  app('setEditing')(false);
  vm.runInContext('clearTimeout(tickTimer)', sandbox);
  storage.clear();
});

await test('⚙ opens on a summary once a class is saved, with the class one tap away', async () => {
  state.schedule = SCHEDULE;
  const sel = selections.find((x) => x.track && x.extras.length) || selections.find((x) => x.track);
  const body = document.getElementById('pickerBody');
  const title = document.getElementById('pickerTitle');
  const foot = document.getElementById('pickerFoot');
  const kids = () => body.children;
  const labels = () => kids().map((c) => c.innerHTML.match(/field__label">([^<]*)/)?.[1]).filter(Boolean);

  // Nothing saved yet: straight to picking a class.
  state.selection = null;
  body.children.length = 0;
  app('openPicker')();
  assert.equal(title.textContent, 'Το τμήμα σου');
  assert.equal(foot.hidden, false);
  assert.deepEqual(labels()[0], 'Τάξη');

  state.selection = sel;
  state.changes = {};
  body.children.length = 0;
  app('openPicker')();
  assert.equal(title.textContent, 'Ρυθμίσεις');
  assert.equal(foot.hidden, true, 'the summary has nothing to save');
  assert.deepEqual(labels(), ['Το τμήμα σου', 'Δικές σου αλλαγές']);
  const card = kids()[0].children[0];
  assert.match(card.innerHTML, new RegExp(`<strong>${sel.section}</strong> · ${sel.grade}΄ Λυκείου`));
  assert.match(card.innerHTML, new RegExp(`Προσανατολισμός: ${sel.track}`));
  // Changing the class is the full picker, and only that.
  body.children.length = 0;
  card.children.find((c) => c.textContent === 'Αλλαγή τμήματος').on.click();
  assert.equal(title.textContent, 'Το τμήμα σου');
  assert.equal(foot.hidden, false);
  assert.equal(labels()[0], 'Τάξη');
  assert.ok(!labels().includes('Δικές σου αλλαγές'));
  assert.equal(document.getElementById('pickerSave').disabled, false);
});

/* ------------------------------------------------------------------- report */

let failed = 0;
for (const [status, name] of results) {
  if (status === 'FAIL') failed++;
  console.log(`  ${status === 'PASS' ? '✓' : '✗'} ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} passed · ${selections.length} selections checked`);
process.exit(failed ? 1 : 0);
