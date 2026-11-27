// Work, made easier: four tabs, Tasks with what waits for your yes and what is due first, Plans with one button,
// Schedules without the queue, Activity with 20 lines and its filter folded, Go live a closed fold at the end of
// Tasks, and every old address sent on. A small stand-in for the browser DOM.
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
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this }); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  contains() { return false; }
  remove() {}
  append(...n) { for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(String(x))); }
  replaceChildren(...n) { this.children = []; this.append(...n); }
}
globalThis.Node = FakeNode;
globalThis.document ??= { createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible' };
const replaced = [];
globalThis.location ??= { hash: '#/work', pathname: '/', search: '', protocol: 'http:', hostname: 'localhost' };
globalThis.location.replace = (to) => replaced.push(to);
const texts = (n) => (n instanceof FakeText ? [n.text] : (n.children || []).flatMap(texts));
const findAll = (n, ok) => (n instanceof FakeElement ? [...(ok(n) ? [n] : []), ...n.children.flatMap((c) => findAll(c, ok))] : []);
const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');

const { TABS, OLD_ADDRESSES, taskGroups } = await import('../../web/work.js');
const { pageById } = await import('../../web/registry.js');
const settle = () => new Promise((r) => setTimeout(r, 30));

const json = (x) => ({ ok: true, status: 200, json: async () => x });
const task = (id, x = {}) => ({ id, at: 0, status: 'open', editable: true, removable: true, title: id, by: 'me', brands: [], date: null, days: null, inWeek: false, project: null, ...x });
const work = (items) => ({ items, projects: ['shop'], runs: {}, today: '2026-11-21', place: { label: 'ai_brain/work', fileName: 'tasks.json', kind: 'brain' }, proposals: [], settings: { place: 'brain', path: '', project: '', timeZone: '', ownerId: '' }, planner: null });

/** Opens Work at `sub` with the answers `routes` gives by address (anything else is a 404). */
async function open(t, routes, sub = '', query = '') {
  const fetchWas = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const key = Object.keys(routes).find((k) => String(u).split('?')[0] === k);
    return key ? json(typeof routes[key] === 'function' ? routes[key](u) : routes[key]) : { ok: false, status: 404, json: async () => ({ error: 'none' }) };
  };
  t.after(() => (globalThis.fetch = fetchWas));
  const frames = [];
  const stop = pageById('work').render({ frame: (o) => frames.push(o), sub, query: new URLSearchParams(query) });
  t.after(() => stop && stop());
  await settle();
  return frames;
}
const last = (frames) => frames[frames.length - 1];
const heads = (el) => findAll(el, (n) => n.tag === 'h2').map((n) => texts(n).join(''));

test('Work has four tabs: Tasks, Plans, Schedules, Activity', async (t) => {
  assert.deepEqual(TABS.map((x) => x[1]), ['Tasks', 'Plans', 'Schedules', 'Activity']);
  const frames = await open(t, { '/api/work': work([]) });
  assert.deepEqual(findAll(last(frames).body[0], (n) => n.tag === 'a').map((n) => texts(n).join('')), ['Tasks', 'Plans', 'Schedules', 'Activity']);
  assert.equal(last(frames).intro, undefined, 'no intro line under the title');
});

test('every old address of Work lands on its new place', async (t) => {
  assert.deepEqual(OLD_ADDRESSES, { today: 'tasks', golive: 'tasks', team: 'plans' });
  const cases = [['today', '', '#/work/tasks'], ['team', '', '#/work/plans'], ['golive', '', '#/work/tasks?show=golive'], ['golive', 'show=sp-limiter', '#/work/tasks?show=sp-limiter'], ['nonsense', '', '#/work']];
  for (const [sub, query, to] of cases) {
    replaced.length = 0;
    await open(t, { '/api/work': work([]) }, sub, query);
    assert.deepEqual(replaced, [to], `#/work/${sub}${query ? `?${query}` : ''}`);
  }
  // #/work and #/work/tasks are Tasks themselves; a mission of Tia's stays at its own address (under Plans).
  for (const sub of ['', 'tasks', 'plans', 'schedules', 'activity', 'mission/abc', 'plans/p1', 'proposal/x1']) {
    replaced.length = 0;
    await open(t, { '/api/work': work([]), '/api/work/missions': { missions: [] }, '/api/work/plans': { plans: [], unreadable: [], today: '2026-11-21' } }, sub);
    assert.deepEqual(replaced, [], `#/work/${sub} stays`);
  }
});

test('Tasks: what waits for your yes, then what is due this week, then the rest; no progress, no week grid, no kept-in line', async (t) => {
  const items = [
    task('later one', { days: 20, date: '2026-12-10' }),
    task('free one'),
    task('review one', { status: 'review' }),
    task('late one', { days: -2, date: '2026-11-19' }),
    task('soon one', { days: 3, date: '2026-11-24', inWeek: true }),
    task('waiting one', { status: 'waiting' }),
    task('busy one', { status: 'doing' }),
    task('old one', { status: 'done' }),
  ];
  const frames = await open(t, { '/api/work': work(items) });
  const f = last(frames);
  assert.equal(f.primary.label, 'Add task');
  const words = texts(f.body[2]).join(' | ');
  assert.deepEqual(heads(f.body[2]), ['Waits for your yes2', 'A session works on it1', 'Due this week2', 'Later2']);
  for (const gone of ['Progress', 'This week', 'Done lately', 'Needs you', 'Nothing due', 'Add your first']) assert.ok(!words.includes(gone), `"${gone}" is gone`);
  assert.ok(!texts(f.body[3]).join(' ').includes('Kept in'), 'no path under the list');
  const filter = findAll(f.body[2], (n) => n.tag === 'details' && texts(n).join('').startsWith('Filter'));
  assert.equal(filter.length, 1, 'one Filter fold');
  assert.ok(!filter[0].open, 'closed at first');
  assert.equal(findAll(f.body[2], (n) => n.tag === 'details' && n.open).length, 0, 'no fold open on first paint');
});

test('Tasks groups: waiting and review are one, overdue, today and the week are one, in that order', () => {
  const g = taskGroups([task('a', { status: 'review' }), task('b', { status: 'waiting' }), task('c', { days: 0, date: '2026-11-21' }), task('d', { days: -1, date: '2026-11-20' }), task('e', { days: 5, inWeek: true, date: '2026-11-26' }), task('f', { days: 9 }), task('g')]);
  assert.deepEqual(g.map((x) => [x.id, x.items.map((i) => i.id)]), [['yes', ['a', 'b']], ['doing', []], ['week', ['d', 'c', 'e']], ['later', ['f', 'g']], ['done', []], ['dropped', []]]);
});

test('Tasks with no task: one line, and the page\'s own Add task is the one action', async (t) => {
  const frames = await open(t, { '/api/work': work([]) });
  const f = last(frames);
  assert.equal(f.primary.label, 'Add task');
  const buttons = findAll(f.body[2], (n) => n.tag === 'button').map((n) => texts(n).join(''));
  assert.deepEqual(buttons, [], 'no second Add button in the list');
  assert.match(texts(f.body[2]).join(' '), /No tasks of your own yet/);
});

test('Go live is a closed fold at the end of Tasks, with its own id for the old address', async (t) => {
  const frames = await open(t, { '/api/work': work([task('one')]) });
  const foot = last(frames).body[3];
  const fold = findAll(foot, (n) => n.tag === 'details' && texts(n).join('').startsWith('Go live'));
  assert.equal(fold.length, 1);
  assert.equal(fold[0].id, 'golive');
  assert.ok(!fold[0].open, 'closed at first');
  assert.ok(findAll(foot, (n) => n.tag === 'details' && texts(n).join('').startsWith('Work settings')).length, 'Work settings stays, after it');
  assert.match(read('workitems.js'), /value: 'golive', label: 'Go live'/, 'a finished task\'s sheet offers Go live');
});

test('Plans: one button, Plan with AI; the plans and Tia\'s missions in one list, no second Add', async (t) => {
  const plans = { plans: [{ id: 'p1', title: 'Launch', status: 'active', progress: { done: 1, all: 3 }, next: null, overdue: 0, projects: ['shop'] }], unreadable: [], today: '2026-11-21' };
  const missions = { missions: [{ id: 'm1', goal: 'Add a contact page', state: 'running', project: 'shop', tasks: [{}, {}], counts: {} }], brief: { shown: false } };
  const frames = await open(t, { '/api/work/plans': plans, '/api/work/missions': missions, '/api/work': work([]) }, 'plans');
  const f = last(frames);
  assert.equal(f.primary.label, 'Plan with AI');
  const words = texts(f.body[2]).join(' | ');
  assert.ok(words.includes('Launch') && words.includes('Add a contact page'), words);
  for (const gone of ['Give Tia a goal', 'New plan', 'A plan is a goal']) assert.ok(!words.includes(gone), `"${gone}" is not on the page`);
  assert.deepEqual(findAll(f.body[2], (n) => n.tag === 'button').map((n) => texts(n).join('')), [], 'no button in the list');
  // Team's old goal button and the other ways to a plan are inside the sheet of Plan with AI.
  const src = read('workplans.js');
  assert.match(src, /label: 'Write the plan yourself'/);
  assert.match(src, /label: 'Give Tia a goal'/);
  assert.match(read('workpropose.js'), /wk-plan-ways/);
});

test('Schedules: the list first, the switches and the note in a closed Advanced fold, no queue', async (t) => {
  const st = { settings: { schedules: { enabled: true, atOnce: 1, lateHours: 6 }, paused: false, queue: { enabled: true } }, schedules: [], queues: {}, timeZone: 'UTC' };
  const frames = await open(t, { '/api/automation': st, '/api/work/schedules': { rows: [], today: '2026-11-21', timeZone: 'UTC' }, '/api/work/computers': { computers: [] }, '/api/work': work([]) }, 'schedules');
  const f = last(frames);
  assert.equal(f.primary.label, 'Add schedule');
  const words = texts(f.body[2]).join(' | ');
  assert.ok(!words.includes('Queued messages') && !words.includes('Queue a message'), 'the queue is not here');
  const adv = findAll(f.body[2], (n) => n.tag === 'details' && texts(n).join('').startsWith('Advanced'));
  assert.equal(adv.length, 1);
  assert.ok(!adv[0].open);
  assert.ok(texts(adv[0]).join(' ').includes('Run schedules'), 'the switch is inside Advanced');
});

test('Activity: 20 lines, Show more for 20 more, the filter and the costs note in closed folds, Running now only when something runs', async (t) => {
  const many = Array.from({ length: 45 }, (_, i) => ({ at: '2026-11-20T10:00:00.000Z', day: '2026-11-20', project: 'shop', who: 'owner', kind: 'commit', text: `line ${i}`, detail: '' }));
  const hist = { lines: many, more: false, before: null, projects: ['shop'], days: ['2026-11-20'], use: { today: { runs: 0 }, week: { runs: 0 } } };
  const progress = { counts: { running: 1, waiting: 0, done: 0, failed: 0 }, line: 'x', running: [{ id: 'run:1', type: 'run', title: 'Renew', project: 'shop', sinceText: 'since 10:00', eta: { text: 'about 5 min' }, basis: { count: 3, text: 'from 3 runs' } }], waiting: [], done: [], failed: [] };
  const frames = await open(t, { '/api/work/history': hist, '/api/work/progress': progress, '/api/work': work([]) }, 'activity');
  const f = last(frames);
  assert.equal(f.primary, null, 'no button in the head of Activity');
  const body = f.body[2];
  assert.equal(findAll(body, (n) => n.dataset && n.dataset.kind === 'commit').length, 20);
  assert.ok(heads(body).some((x) => x.startsWith('Running now')));
  const folds = findAll(body, (n) => n.tag === 'details').map((n) => texts(n).join('').slice(0, 12));
  assert.ok(folds.some((x) => x.startsWith('Filter')) && folds.some((x) => x.startsWith('About costs')), folds.join());
  assert.equal(findAll(body, (n) => n.tag === 'details' && n.open).length, 0);
  const more = findAll(body, (n) => n.dataset && n.dataset.key === 'history-more')[0];
  assert.ok(more, 'Show more');
  more.fire('click');
  await settle();
  assert.equal(findAll(body, (n) => n.dataset && n.dataset.kind === 'commit').length, 40, 'twenty more, no new request needed');
});

test('Activity with nothing running draws no Running now', async (t) => {
  const progress = { counts: { running: 0, waiting: 0, done: 0, failed: 0 }, line: 'x', running: [], waiting: [], done: [], failed: [] };
  const frames = await open(t, { '/api/work/history': { lines: [], more: false, before: null, projects: [], days: [] }, '/api/work/progress': progress, '/api/work': work([]) }, 'activity');
  assert.ok(!texts(last(frames).body[2]).join(' ').includes('Running now'));
});
