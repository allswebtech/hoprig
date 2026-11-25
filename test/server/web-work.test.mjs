// The Work page's runs (web/workitems.js, web/workdo.js, web/work.js), with a small stand-in for the browser DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = t;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag, className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
    this.classList = { toggle: () => {}, contains: () => false, add: () => {}, remove: () => {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn({ target: this });
  }
  // A sheet's dialog: it opens, and a close is reported as a browser does.
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.fire('close');
  }
  querySelector() {
    return null;
  }
  remove() {}
  append(...n) {
    for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x)));
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
  }
}
globalThis.Node = FakeNode;
globalThis.document ??= {
  createElement: (t) => new FakeElement(t),
  createElementNS: (ns, t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
};
const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const links = (n) => (n instanceof FakeText ? [] : [...(n.attrs && n.attrs.href ? [n.attrs.href] : []), ...(n.children || []).flatMap(links)]);

const { machine } = await import('../../web/lib.js');
const { canDoIt, runLineKind } = await import('../../web/workitems.js');
const { RUN_WORDS, keepFocus, runCard, sessionLink } = await import('../../web/workdo.js');
const { unsavedText, watching } = await import('../../web/work.js');

const run = (x = {}) => ({
  id: '20261117-100000-aaaaaaaa', item: 'renew', title: 'Renew', startedAt: '2026-11-17T10:00:00.000Z', endedAt: null, project: 'shop', folder: '.',
  tool: 'claude', provider: 'sub', providerLabel: 'Main', model: null, session: '0b6c3c1e-1111-4222-8333-444455556666', state: 'running', reason: null,
  answer: '', commits: [], changed: [], more: 0, statusError: null, here: true, ...x,
});

const task = (status) => ({ id: 'renew', at: 0, status, editable: true, title: 'Renew' });

test('the line under a task: a status that could not be written, a run that ended while the task is doing, another computer, open again', () => {
  assert.equal(runLineKind(task('doing'), run()), 'working');
  assert.equal(runLineKind(task('doing'), run({ here: false })), 'elsewhere', 'another computer\'s session is not offered here');
  assert.equal(runLineKind(task('review'), run({ state: 'done' })), 'review');
  assert.equal(runLineKind(task('doing'), run({ state: 'done', statusError: 'The task\'s status could not be changed: 2 items share the id' })), 'ended', 'the row says why and offers Do it again');
  assert.equal(runLineKind(task('doing'), run({ state: 'failed', reason: 'x' })), 'ended');
  assert.equal(runLineKind(task('open'), run({ state: 'done', statusError: 'could not' })), 'refused');
  assert.equal(runLineKind(task('open'), run({ state: 'failed', reason: 'The session ended in an error' })), 'why');
  assert.equal(runLineKind(task('waiting'), run({ state: 'limit', reason: 'limit' })), 'why');
  assert.equal(runLineKind(task('open'), run({ state: 'done' })), 'sentback', 'a task open again keeps a sign of its runs');
  assert.equal(runLineKind(task('done'), run({ state: 'done' })), null);
  assert.equal(runLineKind(task('open'), undefined), null);
});

test('Do it is offered alike on the row and in More: never in review, and again for a task left doing by a run that ended', () => {
  const ctx = (r) => ({ doIt: true, runs: r ? { renew: r } : {} });
  assert.equal(canDoIt(task('open'), ctx()), true);
  assert.equal(canDoIt(task('review'), ctx(run({ state: 'done' }))), false);
  assert.equal(canDoIt(task('doing'), ctx(run())), false, 'a session of this computer works on it');
  assert.equal(canDoIt(task('doing'), ctx(run({ state: 'done' }))), true, 'its run ended: Do it again');
  assert.equal(canDoIt(task('doing'), ctx(run({ here: false }))), true, 'another computer\'s run does not block it here');
  assert.equal(canDoIt(task('done'), ctx()), false);
  assert.equal(canDoIt(task('open'), { doIt: false, runs: {} }), false);
});

test('a run of another computer: no session to open here; a session link keeps the computer whose page is open', () => {
  assert.ok(texts(runCard(run({ state: 'done' }))).includes('Open the session'));
  const there = runCard(run({ here: false }));
  assert.ok(!texts(there).includes('Open the session'), 'nothing that would open a wrong page');
  assert.ok(texts(there).includes('Another computer'));
  // On another computer's Work page, a session link keeps that computer.
  machine.set('laptop');
  try {
    assert.equal(sessionLink('abc'), '#/m/laptop/chat/abc');
    assert.deepEqual(links(runCard(run())).filter((l) => l.includes('chat')), [`#/m/laptop/chat/${run().session}`]);
  } finally {
    machine.set(null);
  }
  assert.equal(sessionLink('abc'), '#/chat/abc');
});

test('the page looks again by itself only while a session of this computer works', () => {
  assert.equal(watching({ runs: { a: run() } }), true);
  assert.equal(watching({ runs: { a: run({ state: 'done' }) }, items: [{ status: 'doing' }] }), false, 'a task left doing does not make the page reload for ever');
  assert.equal(watching({ runs: { a: run({ here: false }) } }), false);
});

test('a repaint puts the keyboard focus back on the control of the same row and label', () => {
  const control = (id, label) => {
    const row = { dataset: { id } };
    const el = { dataset: {}, textContent: label, closest: () => row, getAttribute: (k) => (k === 'aria-label' ? label : null), focus: () => (document.activeElement = el) };
    return el;
  };
  let shown = [control('a', 'Do it: a'), control('b', 'Do it: b')];
  const slot = { contains: (el) => shown.includes(el), querySelectorAll: () => shown };
  document.activeElement = shown[1];
  keepFocus(slot, () => (shown = [control('a', 'Do it: a'), control('b', 'Do it: b')]));
  assert.equal(document.activeElement, shown[1]);
});

test('the review and run actions are big enough for a finger, as the kit\'s own OK actions', () => {
  const css = fs.readFileSync(new URL('../../web/page-work.css', import.meta.url), 'utf8');
  const touch = (css.match(/@media \(pointer: coarse\) \{([\s\S]*?)\n\}/) || [])[1] || '';
  for (const sel of ['.wk-runline-actions .btn', '.wk-review-bar .btn', '.wk-run-actions .btn', '.wk-show-more']) assert.match(touch, new RegExp(`${sel.replace(/\./g, '\\.')}[^{]*\\{ min-height: 44px;`), sel);
  assert.match(touch, /\.wk-link \{ min-height: 44px; min-width: 44px;/);
});

test('a run card in the product\'s words: the provider\'s label, "Limit reached", files past the list counted; Save counts runs apart from changes', () => {
  assert.equal(RUN_WORDS.limit, 'Limit reached');
  const card = texts(runCard(run({ state: 'done', changed: [{ repo: '.', path: 'a.txt', kind: 'new' }], more: 4 }), { onTask: () => {} }));
  assert.ok(card.includes('Main') && !card.includes('sub'), card.join('|'));
  assert.ok(card.includes('5 files changed, not committed'));
  assert.ok(card.includes('and 4 more'));
  assert.ok(card.includes('All runs of the task'), 'the button says what it opens');
  assert.equal(unsavedText({ changes: [{}, {}, {}], runs: 122, files: [] }), '3 changes and 122 runs');
  assert.equal(unsavedText({ changes: [], runs: 1, files: [{}] }), '1 run');
  assert.equal(unsavedText({ changes: [], runs: 0, files: [{}] }), '1 change');
});

test('plans on the page: a note shown as text with each link\'s address, a task that waits offers no Do it, proposals keep the page looking', async () => {
  const { noteView } = await import('../../web/workplans.js');
  const tags = (n) => (n instanceof FakeText ? [] : [n.tag, ...(n.children || []).flatMap(tags)]);
  const v = noteView('## Found\n- See [the guide](https://example.com/a) and <https://example.org/b>.\n- <b>not markup</b>');
  const words = texts(v).join('');
  assert.match(words, /the guide \(https:\/\/example\.com\/a\)/, 'a link is its words and its address');
  assert.match(words, /https:\/\/example\.org\/b/);
  assert.match(words, /<b>not markup<\/b>/, 'anything else is text');
  assert.ok(!tags(v).includes('a') && !tags(v).includes('b'), 'no link element, nothing from the note as markup');
  const ctx = { doIt: true, runs: {} };
  assert.equal(canDoIt({ ...task('open'), waits: [{ id: 'x', title: 'X' }] }, ctx), false);
  assert.equal(canDoIt({ ...task('open'), waits: [] }, ctx), true);
  assert.equal(watching({ proposals: [{ state: 'working' }] }), true);
  assert.equal(watching({ proposals: [{ state: 'ready' }] }), false);
  assert.equal(unsavedText({ changes: [{}], runs: 0, plans: 2, files: [{}, {}, {}] }), '1 change and 2 plan files');
});

test('a task in a plan names its plan on its row, by the title the page was given', async () => {
  const { itemRow } = await import('../../web/workitems.js');
  const row = (ctx) => itemRow({ ...task('open'), plan: 'grow-the-blog', by: 'me', brands: [], waits: [] }, { doIt: false, runs: {}, ...ctx }, () => {});
  assert.match(texts(row({ planTitles: { 'grow-the-blog': 'Grow the blog by spring' } })).join(' '), /Grow the blog by spring/);
  assert.match(texts(row({})).join(' '), /Its plan/, 'a plan whose title the page does not have');
  assert.doesNotMatch(texts(row({ planLinks: false, planTitles: { 'grow-the-blog': 'Grow the blog by spring' } })).join(' '), /Grow the blog/, 'not on the plan\'s own screen');
});

test('the timeline: an open task past its date is overdue, this week is there when empty, a year that is not this one is said, a milestone without a date is listed', async () => {
  const { timeline } = await import('../../web/workplans.js');
  const t = {
    weeks: [
      { start: '2026-11-02', end: '2026-11-08', gap: 0, now: false, entries: [{ kind: 'task', id: 'a', title: 'Measure', date: '2026-11-03', status: 'open', by: 'me', waits: [], late: true }] },
      { start: '2026-11-16', end: '2026-11-22', gap: 1, now: true, entries: [] },
      { start: '2027-01-11', end: '2027-01-17', gap: 6, now: false, entries: [{ kind: 'task', id: 'b', title: 'Launch', date: '2027-01-12', status: 'open', by: 'ai', waits: [], late: false }] },
    ],
    undated: [{ kind: 'milestone', id: 'm', title: 'Someday', date: null, done: 0, all: 0 }],
    later: 0,
  };
  const all = texts(timeline(t, 2026)).join(' | ');
  assert.match(all, /Measure \| overdue/);
  assert.match(all, /This week \| 16 Nov – 22 Nov \| Nothing due this week/);
  assert.match(all, /Week of 11 Jan 2027 \| 11 Jan 2027 – 17 Jan 2027/);
  assert.match(all, /No date .*Someday/);
  const late = (n) => (n instanceof FakeText ? [] : [...(String(n.className).includes('wk-late') ? [n] : []), ...(n.children || []).flatMap(late)]);
  assert.equal(late(timeline(t, 2026)).length, 2, 'the overdue task\'s day and its word');
});

test('a proposal on Today is named by the owner\'s goal, the title is the session\'s; the heading counts only what he can look at', async () => {
  const { proposalRows, proposalSections } = await import('../../web/workpropose.js');
  const ready = { id: '20261118-100000-0a0b0c0d', state: 'ready', goal: 'Make the shop fast on a phone', title: 'Speed plan', tasks: 3, startedAt: '2026-11-18T10:00:00.000Z' };
  const row = proposalRows([ready])[0];
  const [title, sub] = texts(row).filter((x) => x.trim());
  assert.equal(title, 'Make the shop fast on a phone', 'his own words are the row\'s title');
  assert.match(sub, /the session proposed "Speed plan"/);
  const list = [ready, { ...ready, id: 'b', state: 'unreadable' }, { ...ready, id: 'c', state: 'working' }, { ...ready, id: 'd', state: 'failed' }, { ...ready, id: 'e', state: 'failed' }];
  const words = proposalSections(list).map((n) => texts(n).join(' '));
  assert.equal(words.length, 3);
  assert.match(words[0], /^Plans to look at\s*2/);
  assert.match(words[1], /A session is planning "Make the shop fast on a phone"/);
  assert.match(words[2], /^Planning ended without a proposal\s*2/);
  assert.deepEqual(proposalSections([]), []);
});

test('words that mix two alphabets are found, so the proposal screen can say so', async () => {
  const { mixedWords } = await import('../../web/workpropose.js');
  assert.deepEqual(mixedWords('Updаte the pаyment page'), ['Updаte', 'pаyment']);
  assert.deepEqual(mixedWords('Update the payment page, Привет, Ελλάδα, café'), []);
});

test('Stop waiting sends only what the task waits for: the task\'s plan and milestone are not sent, so they are not read again', async () => {
  const { moreActions } = await import('../../web/workitems.js');
  document.body ??= new FakeElement('body');
  const sent = [];
  globalThis.fetch = async (u, o) => {
    sent.push({ u, method: o.method, body: JSON.parse(o.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const it = { id: 'shrink', at: 3, status: 'open', editable: true, title: 'Shrink the images', plan: 'faster-site', milestone: 'images', waits: [{ id: 'measure', title: 'Measure the page' }] };
  let after = 0;
  const done = moreActions(it, { runs: {} }, () => (after += 1));
  const find = (n, ok) => (n instanceof FakeElement ? (ok(n) ? n : n.children.map((c) => find(c, ok)).find(Boolean)) : null);
  const choice = find(document.body, (n) => n.tag === 'button' && texts(n).includes('Stop waiting'));
  assert.ok(choice, 'More offers Stop waiting');
  choice.fire('click');
  await done;
  assert.deepEqual(sent, [{ u: '/api/work/items/shrink/plan', method: 'POST', body: { at: 3, after: [] } }]);
  assert.equal(after, 1);
});

test('a run that ended by itself names its branch; a schedule\'s run offers its schedule and Done with it, never "All runs of the task"', () => {
  const sched = runCard(run({ state: 'done', session: null, item: 'quiet1', schedule: 'quiet1', branch: 'work/quiet1' }), { title: true, onTask: () => {}, onRelease: () => {} });
  const words = texts(sched).join(' ');
  assert.match(words, /on the branch work\/quiet1/);
  assert.ok(!words.includes('All runs of the task'), words);
  assert.match(words, /Done with it: remove its copy of the project/);
  assert.ok(links(sched).includes('#/work/schedules'));
  const item = runCard(run({ state: 'done', branch: 'work/renew' }), { title: true, onTask: () => {} });
  assert.match(texts(item).join(' '), /on the branch work\/renew[\s\S]*All runs of the task/);
});

test('Schedules: a repeating task says when in the Tasks rows\' words, its missed days by name, another computer\'s clock and when it is not connected; the row opens that task', async () => {
  const { repeatRow } = await import('../../web/workschedules.js');
  const opened = [];
  const late = repeatRow({ kind: 'repeat', id: 'photos', title: 'Back up the photos', what: 'every Monday and Thursday', computer: null, here: false, date: '2026-11-16', days: -2, next: null, missed: ['2026-11-09', '2026-11-12'] }, 'UTC', { open: (id) => opened.push(id), thisYear: 2026 });
  const words = texts(late).join(' ');
  assert.match(words, /2 days overdue/);
  assert.ok(!/Next time/.test(words), words);
  assert.match(words, /Missed Mon 9 Nov and Thu 12 Nov/);
  assert.equal(late.attrs['aria-label'], 'Change "Back up the photos"');
  late.fire('click');
  assert.deepEqual(opened, ['photos'], 'the task\'s own sheet, not the whole list');
  const other = repeatRow({ kind: 'repeat', id: 'deps', title: 'Check the dependencies', what: 'run by AI at 07:30', computer: 'b2b2b2b2b2b2b2b2', computerLabel: 'Box B', here: false, date: null, days: null, next: null, missed: [], at: '07:30', daily: true }, 'UTC', { computers: [{ id: 'b2b2b2b2b2b2b2b2', label: 'Box B', reachable: false }] });
  const ow = texts(other).join(' ');
  assert.match(ow, /Every day at 07:30 on Box B's clock/);
  assert.match(ow, /Box B is not connected now: at its time this does not run anywhere/);
  assert.ok(!/No date/.test(ow), ow);
});

test('a schedule that runs by itself offers editing files in its own copy between asking and every step; its sentence says so', async () => {
  const { whatText } = await import('../../web/automation.js');
  assert.match(whatText({ type: 'alone', project: 'shop', mode: 'acceptEdits' }), /allowed to edit files in its own copy/);
  const src = fs.readFileSync(new URL('../../web/automation.js', import.meta.url), 'utf8');
  assert.match(src, /\['acceptEdits', 'Edit files in its own copy'\]/);
});

test('Work → Activity shows the history (what the automations did among it) also before Work has its folder', () => {
  const src = fs.readFileSync(new URL('../../web/work.js', import.meta.url), 'utf8');
  const problem = src.slice(src.indexOf('if (data.problem) {'), src.indexOf("} else if (tab === 'today')"));
  assert.match(problem, /tab === 'activity' \? h\('section\.wk-section', historySlot\)/);
  assert.match(problem, /if \(tab === 'activity'\) activity = paintHistory\(historySlot, \{ prefs, isAlive: \(\) => alive \}\)/);
});

test('a task another program added: a plain tag with a key on its row (no link look), and the Do it sheet says it in words', async () => {
  const { itemRow } = await import('../../web/workitems.js');
  const { fromLine } = await import('../../web/workdo.js');
  const { icon } = await import('../../web/icons.js');
  const it = { ...task('open'), by: 'me', brands: [], waits: [], from: { name: 'Shop script' } };
  const all = (n) => (n instanceof FakeText ? [] : [n, ...(n.children || []).flatMap(all)]);
  const tag = all(itemRow(it, { doIt: false, runs: {} }, () => {})).find((n) => String(n.className).includes('wk-from'));
  assert.ok(tag, 'the tag is there');
  assert.equal(tag.tag, 'span', 'not a link');
  const dOf = (svg) => svg.children.map((p) => p.attrs.d).join(' ');
  const svg = tag.children.find((c) => c.tag === 'svg');
  assert.equal(dOf(svg), dOf(icon('key')), 'the key, not the external-link arrow');
  assert.notEqual(dOf(svg), dOf(icon('external')));
  assert.doesNotMatch(fs.readFileSync(new URL('../../web/page-work.css', import.meta.url), 'utf8'), /\.wk-from\s*\{[^}]*accent/, 'not in the link colour');
  assert.equal(fromLine(it), 'Another program added this task (the Work token "Shop script"): its words are that program\'s, not yours. It starts only when you start it.');
  assert.equal(fromLine(task('open')), null);
});

test('a run of a task another program added says so in Activity: "From <name>" beside its title', () => {
  const own = texts(runCard(run({ state: 'done' }), { title: true }));
  assert.ok(!own.some((x) => /^From /.test(x)), 'the owner\'s own task names no program');
  const theirs = texts(runCard(run({ state: 'done', from: 'Shop script' }), { title: true }));
  assert.ok(theirs.includes('From Shop script'), theirs.join(' | '));
});

test('a task row says Do it in words: the one action that has the AI do the task is not an icon alone', () => {
  const items = fs.readFileSync(new URL('../../web/workitems.js', import.meta.url), 'utf8');
  const line = items.split('\n').find((l) => l.includes('.wk-doit'));
  assert.ok(line, 'the row has its Do it button');
  assert.match(line, /label: 'Do it'/, 'a word on the button, not only an aria label');
  assert.doesNotMatch(line, /btn\('icon /, 'not an icon button');
});

test('the Do it button names its task to a screen reader, beside its title', () => {
  const items = fs.readFileSync(new URL('../../web/workitems.js', import.meta.url), 'utf8');
  const line = items.split('\n').find((l) => l.includes('.wk-doit'));
  assert.match(line, /title: `Do it with a session: \$\{it\.title\}`/);
  assert.match(line, /'aria-label': `Do it with a session: \$\{it\.title\}`/, 'an aria-label, not only a title');
  const lib = fs.readFileSync(new URL('../../web/lib.js', import.meta.url), 'utf8');
  assert.match(lib, /'aria-label': label \? null : title \|\| name, onclick, disabled, \.\.\.rest \}/, 'btn() lets a given aria-label stand');
});

// ---------- Activity: the one history (web/workhistory.js) ----------

const historyPage = (x = {}) => ({ lines: [], more: false, before: null, projects: [], days: [], ...x });
const hline = (x) => ({ at: '2026-11-20T10:00:00.000Z', day: '2026-11-20', project: 'shop', who: null, text: 'x', detail: '', ...x });
const settle = () => new Promise((r) => setTimeout(r, 0));
const memPrefs = () => {
  const m = new Map();
  return { get: (k, d) => (m.has(k) ? m.get(k) : d), set: (k, v) => m.set(k, v), m };
};
const findAll = (n, ok) => (n instanceof FakeElement ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => findAll(c, ok))] : []);

test('Activity paints the history: a mark of each kind, the project, who and the line; a run opens its task, an open App session its chat', async () => {
  const { paintHistory } = await import('../../web/workhistory.js');
  const asked = [];
  globalThis.fetch = async (u) => {
    asked.push(u);
    return { ok: true, status: 200, json: async () => historyPage({ projects: ['blog', 'shop'], days: ['2026-11-20'], lines: [
      hline({ kind: 'session', who: 'tia', text: 'Look at the styles', detail: 'A terminal session · Claude Code on team · ended with an error', project: 'blog' }),
      hline({ kind: 'session', who: 'owner', text: 'Fix the cart', chat: 'c1', open: true, detail: 'An App session · Claude Code on max · is open in the App' }),
      hline({ kind: 'run', who: 'schedule', text: 'Check the deps', item: 'deps', run: '20261120-100000-aaaaaaaa', state: 'done' }),
      hline({ kind: 'commit', text: 'Write the notes', detail: 'shop · abc1234' }),
      hline({ kind: 'save', text: 'Saved the Work list' }),
      hline({ kind: 'error', who: 'owner', text: '"Add a test" failed: the tests did not pass' }),
    ] }) };
  };
  const slot = new FakeElement('div');
  const opened = [];
  paintHistory(slot, { prefs: memPrefs(), today: '2026-11-20', onRun: (l) => opened.push(l.run) });
  await settle();
  assert.deepEqual(asked, ['/api/work/history']);
  const words = texts(slot).join(' | ');
  for (const w of ['Session', 'Run', 'Commit', 'Save', 'Error', 'Today', 'Look at the styles', 'Tia', 'You', 'A schedule', 'blog', 'Saved the Work list', 'ended with an error']) assert.ok(words.includes(w), `"${w}" in ${words}`);
  assert.ok(links(slot).includes('#/chat/c1'), 'the open App session is a link to it');
  const runRow = findAll(slot, (n) => n.tag === 'button' && texts(n).includes('Check the deps'))[0];
  assert.ok(runRow, 'a run line is a button');
  runRow.fire('click');
  assert.deepEqual(opened, ['20261120-100000-aaaaaaaa'], 'a run line opens that run');
  const commitRow = findAll(slot, (n) => n.dataset && n.dataset.kind === 'commit')[0];
  assert.equal(texts(commitRow).filter((x) => x.includes('shop')).join(' ').match(/shop/g).length, 1, 'the project is said once on a commit line');
  const selects = findAll(slot, (n) => n.tag === 'select').map((n) => n.dataset.key);
  assert.deepEqual(selects, ['history-project', 'history-day', 'history-who']);
});

test('Activity with nothing yet: the first-use hint says what will show and that sessions show from this version on', async () => {
  const { paintHistory, FIRST_USE } = await import('../../web/workhistory.js');
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => historyPage() });
  const slot = new FakeElement('div');
  paintHistory(slot, { prefs: memPrefs() });
  await settle();
  const words = texts(slot).join(' ');
  assert.ok(words.includes(FIRST_USE), words);
  assert.match(FIRST_USE, /Sessions show from this version of Hoprig on/);
  assert.equal(findAll(slot, (n) => n.tag === 'select').length, 0, 'no filters over an empty history');
});

test('a filter asks the server with it and is kept; one that matches nothing says so and offers everything again; Show more asks for older lines', async () => {
  const { paintHistory } = await import('../../web/workhistory.js');
  const asked = [];
  globalThis.fetch = async (u) => {
    asked.push(u);
    if (u.includes('who=tia')) return { ok: true, status: 200, json: async () => historyPage({ projects: ['shop'], days: ['2026-11-20'] }) };
    if (u.includes('before=')) return { ok: true, status: 200, json: async () => historyPage({ projects: ['shop'], days: ['2026-11-20'], lines: [hline({ kind: 'commit', text: 'Older one', at: '2026-11-19T10:00:00.000Z', day: '2026-11-19' })] }) };
    return { ok: true, status: 200, json: async () => historyPage({ projects: ['shop'], days: ['2026-11-20'], more: true, before: '2026-11-20T10:00:00.000Z', lines: [hline({ kind: 'commit', text: 'Newer one' })] }) };
  };
  const prefs = memPrefs();
  const slot = new FakeElement('div');
  paintHistory(slot, { prefs, today: '2026-11-20' });
  await settle();
  const more = findAll(slot, (n) => n.dataset && n.dataset.key === 'history-more')[0];
  assert.ok(more, 'Show more is there');
  more.fire('click');
  await settle();
  assert.equal(asked[1], '/api/work/history?before=2026-11-20T10%3A00%3A00.000Z');
  const w1 = texts(slot).join(' ');
  assert.ok(w1.includes('Newer one') && w1.includes('Older one'), 'the older lines are added below');
  const who = findAll(slot, (n) => n.tag === 'select' && n.dataset.key === 'history-who')[0];
  for (const fn of who.listeners.change) fn({ target: { value: 'tia' } });
  await settle();
  assert.equal(asked[asked.length - 1], '/api/work/history?who=tia');
  assert.equal(prefs.m.get('work.history.who'), 'tia', 'kept per device');
  assert.match(texts(slot).join(' '), /Nothing matches this filter/);
  const clear = findAll(slot, (n) => n.dataset && n.dataset.key === 'history-clear')[0];
  clear.fire('click');
  await settle();
  assert.equal(asked[asked.length - 1], '/api/work/history');
  assert.equal(prefs.m.get('work.history.who'), '');
});

test('a run line\'s sheet is the run\'s own card: a schedule\'s run that ended here offers Done with it, which asks the release route', async () => {
  const { runSheet } = await import('../../web/workhistory.js');
  document.body ??= new FakeElement('body');
  const asked = [];
  globalThis.fetch = async (u, o) => {
    asked.push([u, o && o.method]);
    if (u.startsWith('/api/work/runs')) return { ok: true, status: 200, json: async () => ({ runs: [run({ state: 'done', session: null, item: 'quiet1', schedule: 'quiet1', branch: 'work/quiet1', here: true })] }) };
    return { ok: true, status: 200, json: async () => ({ removed: true }) };
  };
  runSheet('20261117-100000-aaaaaaaa', 'Renew');
  await settle();
  assert.deepEqual(asked[0], ['/api/work/runs?id=20261117-100000-aaaaaaaa', 'GET']);
  const done = findAll(document.body, (n) => n.tag === 'button' && texts(n).join('').includes('Done with it'))[0];
  assert.ok(done, 'Done with it is offered');
  done.fire('click');
  await settle();
  assert.deepEqual(asked[1], ['/api/work/alone/release', 'POST']);
});
