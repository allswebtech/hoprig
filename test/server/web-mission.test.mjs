// Tia's missions on the page (web/mission.js), with a small stand-in for the browser DOM and for the server's answers
// (made by the server's own report functions): the badge says what a mission does now, a mission of another dashboard
// offers no Stop, a running session shows what it may spend, a row has one name, the switches keep the keyboard's place.
import assert from 'node:assert/strict';
import test from 'node:test';

class FakeNode {}
class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.text = String(t);
    this.parent = null;
  }
  get textContent() {
    return this.text;
  }
}
function matches(el, sel) {
  const m = /^([a-z]*)((?:\.[\w-]+)*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(sel.trim());
  if (!m) return false;
  const [, tag, cls, attr, val] = m;
  if (tag && el.tag !== tag) return false;
  const have = el.className.split(/\s+/);
  if (cls && !cls.slice(1).split('.').every((c) => have.includes(c))) return false;
  if (attr) {
    const v = attr.startsWith('data-') ? el.dataset[attr.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] : el.attrs[attr] ?? (el[attr] === true ? '' : undefined);
    if (v === undefined || v === null) return false;
    if (val !== undefined && String(v) !== val) return false;
  }
  return true;
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag: String(tag).toLowerCase(), className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {}, parent: null });
    this.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type) {
    for (const fn of this.listeners[type] || []) fn({ target: this, currentTarget: this, preventDefault() {} });
  }
  append(...n) {
    for (const x of n) {
      const c = x instanceof FakeNode ? x : new FakeText(x);
      c.parent = this;
      this.children.push(c);
    }
  }
  replaceChildren(...n) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...n);
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.replaceChildren(String(v));
  }
  focus() {
    document.activeElement = this;
  }
  scrollIntoView() {}
  contains(el) {
    for (let x = el; x; x = x.parent) if (x === this) return true;
    return false;
  }
  closest(sel) {
    for (let x = this; x instanceof FakeElement; x = x.parent) if (matches(x, sel)) return x;
    return null;
  }
  all() {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c instanceof FakeElement) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
  querySelectorAll(sel) {
    return this.all().filter((c) => sel.split(',').some((s) => matches(c, s)));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
}
const body = new FakeElement('body');
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (t) => new FakeElement(t), createElementNS: (ns, t) => new FakeElement(t), createTextNode: (t) => new FakeText(t),
  getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body, activeElement: body, documentElement: new FakeElement('html'),
};
globalThis.window ??= { addEventListener: () => {}, dispatchEvent: () => {} };

// The server: answers by path, made from mission files by the server's own report functions.
const answers = {};
const posted = [];
globalThis.fetch = async (u, o = {}) => {
  if (o.method === 'POST') posted.push([u, JSON.parse(o.body)]);
  const f = answers[u];
  const data = typeof f === 'function' ? f() : f;
  return { ok: data !== undefined, status: data === undefined ? 404 : 200, json: async () => (data === undefined ? { error: 'not here' } : structuredClone(data)) };
};
const R = await import('../../src/mission/report.mjs');
const SET = await import('../../src/mission/settings.mjs');
const { paintTeam, viewMission } = await import('../../web/mission.js');

const ON = { on: true, projects: { shop: { on: true, test: null } }, capUsd: 2, providers: ['key'], atOnce: 1 };
const taskOf = (x = {}) => ({
  id: 'add-the-cart', title: 'Add the cart', role: 'developer', provider: 'key', model: 'opus', effort: 'medium', state: 'queued', why: null, branch: null, base: null, run: null, runs: [],
  fixes: 0, restarts: 0, gateFails: 0, gate: null, firstPass: null, verdicts: [], limited: [], claim: null, next: 'work', points: [], ...x,
});
const missionOf = (x = {}) => ({
  v: 1, id: 'm-20261119-abcdef', writer: 'aaaaaaaaaaaaaaaa', goal: 'A cart for the shop', project: 'shop', proposal: null, plan: 'cart', state: 'running', why: null,
  createdAt: '2026-11-19T08:00:00.000Z', endedAt: null, tasks: [taskOf()], line: [], ...x,
});
/** The server's answers for these missions under these settings (`mine`: this dashboard runs them). */
function serve(missions, cfg = ON, { mine = true, slots = 1, box = null } = {}) {
  const s = SET.missionSettings({ missions: cfg });
  const view = (m) => ({ ...R.missionReport(m), face: R.faceOf ? R.faceOf(m, { on: s.on, mine }) : undefined, mine });
  answers['/api/work/missions'] = () => ({
    settings: s, providers: [{ name: 'key', kind: 'api' }, { name: 'other', kind: 'api' }], slots, projects: ['shop'], missions: missions.map((m) => ({ ...view(m), line: [] })), broken: [],
    team: R.teamView(missions, s.rolesOff), brief: R.morningBrief(missions, { from: '2026-11-18' }), today: '2026-11-19', steps: SET.stepsOf ? SET.stepsOf(s) : undefined,
  });
  for (const m of missions) {
    answers[`/api/work/missions/${m.id}`] = () => ({ mission: { ...view(m), line: m.line, plan: m.plan, proposal: m.proposal, box: typeof box === 'function' ? box() : box, tasksFull: m.tasks.map((t) => ({
      id: t.id, provider: t.provider, model: t.model, effort: t.effort, fixes: t.fixes, restarts: t.restarts, gate: t.gate, selfTests: t.selfTests || null, verdicts: [], run: t.run ? { kind: t.run.kind, budget: t.run.budget, startedAt: t.run.startedAt || null } : null,
    })) } });
  }
  answers['/api/work/missions/settings'] = { settings: s };
  answers['/api/work/missions/off'] = { settings: s };
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const RUN = { id: '20261119-100000-aaaaaaaa', kind: 'work', budget: 0.4 };
const GATE_AT = '2026-11-19T09:00:00.000Z'; // a check that ran after the session's own test runs of these cards

test('the badge: Working only while a session runs; Waiting when none does; Paused under Tia OFF', async () => {
  const content = new FakeElement('div');
  serve([missionOf({ why: 'the spend cap of today is reached ($2.00 of $2.00)' })]);
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  assert.match(content.textContent, /Waiting/);
  assert.doesNotMatch(content.textContent, /Working/, 'nothing of it runs: it is not "Working"');
  serve([missionOf({ tasks: [taskOf({ state: 'running', run: RUN })] })]);
  await p.refresh();
  assert.match(content.textContent, /Working/);
  serve([missionOf({ tasks: [taskOf({ state: 'running', run: RUN })] })], { ...ON, on: false });
  await p.refresh();
  assert.match(content.textContent, /Paused: Tia OFF/);
  serve([missionOf()], { ...ON, on: false }, { mine: false });
  await p.refresh();
  assert.doesNotMatch(content.textContent, /Paused/, 'another dashboard\'s mission is not held by this one\'s switch');
  p.stop();
});

test('a mission of another dashboard offers no Stop here and says where it is stopped', async () => {
  const content = new FakeElement('div');
  serve([missionOf({ tasks: [taskOf({ state: 'running', run: RUN })] })], ON, { mine: false });
  const p = viewMission(content, 'm-20261119-abcdef');
  await settle();
  assert.doesNotMatch(content.textContent, /Stop this mission/);
  assert.match(content.textContent, /Started by another dashboard on this computer; stop it there\./);
  serve([missionOf({ tasks: [taskOf({ state: 'running', run: RUN })] })], ON, { mine: true });
  await p.refresh();
  assert.match(content.textContent, /Stop this mission/);
  p.stop();
});

test('a session that runs shows for how long and what it may spend, not "0 tokens, 0 min, $0"', async () => {
  const content = new FakeElement('div');
  const startedAt = new Date(Date.now() - 25 * 60_000).toISOString();
  serve([missionOf({ tasks: [taskOf({ state: 'running', run: { ...RUN, startedAt } })] })]);
  const p = viewMission(content, 'm-20261119-abcdef');
  await settle();
  assert.match(content.textContent, /Its session runs for 25 min, may spend up to \$0\.40/);
  assert.doesNotMatch(content.textContent, /0 tokens · 0 min · \$0/);
  p.stop();
});

test('a mission\'s row has one name with its parts apart', async () => {
  const content = new FakeElement('div');
  serve([missionOf({ why: 'outside your working hours (09:00 to 18:00)' })]);
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  const row = content.querySelector('a.ms-row');
  assert.equal(row.getAttribute('aria-label'), 'A cart for the shop, Waiting, shop, 1 task · $0. outside your working hours (09:00 to 18:00)');
  p.stop();
});

test('"Sessions at once" shows the number that holds here, and says so when his is higher', async () => {
  const content = new FakeElement('div');
  serve([], { ...ON, atOnce: 2 }, { slots: 1 });
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  const input = content.all().find((x) => x.getAttribute('aria-label') === 'Sessions at once');
  assert.equal(input.value, '1');
  assert.equal(input.getAttribute('max'), '1');
  assert.match(input.parent.textContent, /You set 2; this computer runs 1 by itself at once, so 1 here\./);
  assert.ok(content.all().some((x) => x.getAttribute('aria-label') === 'Time limit (minutes)'), 'a label short enough for one line, so the inputs stand in a row');
  p.stop();
});

test('with Tia OFF the bar says what is still to be set and opens her switches at the first step', async () => {
  const content = new FakeElement('div');
  serve([], { ...ON, on: false, capUsd: 0, providers: [] });
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  const bar = content.querySelector('div.ms-offbar');
  assert.match(bar.textContent, /To turn her on: turn on "Tia works by herself"; set a spend cap per day above \$0; allow a provider\./);
  const go = bar.all().find((x) => x.tag === 'button' && /Turn Tia on/.test(x.textContent));
  assert.ok(go, 'a way to turn her on from the bar');
  go.fire('click');
  assert.equal(content.querySelector('details.ms-settings').open, true, 'her switches are open');
  assert.equal(document.activeElement.dataset.step, 'on', 'the focus is on the master switch');
  p.stop();
});

test('a save on Team keeps the keyboard on its control; after Tia OFF it is on the line that says she is OFF', async () => {
  const content = new FakeElement('div');
  serve([missionOf()]);
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  const sw = content.all().find((x) => x.dataset.key === 'offStops');
  assert.ok(sw, 'the switch "Tia OFF stops what runs" has its key');
  sw.focus();
  sw.checked = true;
  sw.fire('change');
  await settle();
  assert.ok(content.contains(document.activeElement), 'the focus is in the tab, not on the page\'s body');
  assert.equal(document.activeElement.dataset.key, 'offStops');
  const cap = content.all().find((x) => x.dataset.key === 'capUsd');
  cap.focus();
  cap.value = '3';
  cap.fire('change');
  await settle();
  assert.equal(document.activeElement.dataset.key, 'capUsd');
  const off = content.all().find((x) => x.dataset.key === 'tia-off');
  off.focus();
  serve([missionOf()], { ...ON, on: false });
  off.fire('click');
  await settle();
  assert.ok(content.contains(document.activeElement));
  assert.equal(document.activeElement.dataset.key, 'offbar', 'on the line "Tia is OFF"');
  p.stop();
});

test('a mission\'s screen is not drawn again for the same answer, and keeps the focus when it is', async () => {
  const content = new FakeElement('div');
  const m = missionOf({ tasks: [taskOf({ state: 'running', run: RUN })] });
  serve([m]);
  const p = viewMission(content, m.id);
  await settle();
  const back = content.all().find((x) => x.tag === 'a' && /Plans/.test(x.textContent));
  back.focus();
  await p.refresh();
  assert.equal(document.activeElement, back, 'the same answer: the same link, nothing drawn again');
  assert.ok(content.contains(back));
  serve([{ ...m, line: [{ at: '2026-11-19T09:00:00.000Z', task: null, words: 'Something happened' }] }]);
  await p.refresh();
  assert.match(content.textContent, /Something happened/);
  assert.ok(content.contains(document.activeElement), 'drawn again: the focus is on the new Plans link');
  assert.equal(document.activeElement.dataset.key, 'back');
  p.stop();
});

// ---------- a task's tests on its card ----------
const waitingTask = (gate) => taskOf({ state: 'review', branch: 'work/add-the-cart', gate });
const buttons = (content) => content.all().filter((x) => x.tag === 'button').map((x) => x.textContent);

test('with no box on this computer the card says so, with the box\'s step, and offers only the run outside it', async () => {
  const content = new FakeElement('div');
  const m = missionOf({ state: 'waits', tasks: [waitingTask({ ok: true, words: ['tests not run: yours to check (no box on this computer: bubblewrap is not installed)'], testsNotRun: true, noBox: true, notRunWhy: 'no box on this computer: bubblewrap is not installed', step: 'install bubblewrap' })] });
  serve([m]);
  const full = answers[`/api/work/missions/${m.id}`];
  answers[`/api/work/missions/${m.id}`] = () => ({ mission: { ...full().mission, box: { ok: false, why: 'no box on this computer: bubblewrap is not installed', step: 'install bubblewrap' } } });
  const p = viewMission(content, m.id);
  await settle();
  assert.match(content.textContent, /This computer has no box \(bubblewrap is not installed: install bubblewrap, to run the tests safely\)\. You can run them outside the box, as you\./);
  assert.ok(!buttons(content).some((b) => /in the box/.test(b)), `no press that cannot work: ${buttons(content).join(' | ')}`);
  assert.ok(buttons(content).includes('Run them outside the box…'));
  assert.doesNotMatch(content.textContent, /In the box the tests have no network/, 'nothing about what the absent box does');
  p.stop();
});

test('the card tells a timeout from a failure, and a failure says a test that needs the network fails in the box', async () => {
  const content = new FakeElement('div');
  const slow = { ...waitingTask({ ok: false, words: ['x'], boxed: true, tests: { result: 'timeout', limit: '3 seconds' } }), id: 'slow-one', title: 'Slow one', state: 'his' };
  const red = { ...waitingTask({ ok: false, words: ['x'], boxed: true, tests: { result: 'failed' } }), id: 'red-one', title: 'Red one', state: 'his' };
  const m = missionOf({ state: 'waits', tasks: [slow, red] });
  serve([m]);
  const p = viewMission(content, m.id);
  await settle();
  assert.match(content.textContent, /The tests ran in the box and were stopped after 3 seconds: they did not end in time\./);
  assert.match(content.textContent, /did not pass \(a test that needs the network fails there\)\./);
  assert.doesNotMatch(content.textContent, /exit code/);
  p.stop();
});

test('while the tests run in the box, both presses say they are busy, and "outside" opens no sheet and says why', async () => {
  const content = new FakeElement('div');
  const m = missionOf({ state: 'waits', tasks: [waitingTask({ ok: true, words: ['tests not run: yours to check (the box did not start)'], testsNotRun: true, notRunWhy: 'the box did not start' })] });
  serve([m]);
  const p = viewMission(content, m.id);
  await settle();
  assert.match(content.textContent, /The tests were not run: the box did not start\. They are yours to check\./);
  const before = globalThis.fetch;
  let pending = 0;
  globalThis.fetch = async (u, o) => (/run-tests$/.test(u) ? (pending += 1, new Promise(() => {})) : before(u, o));
  try {
    const find = (re) => content.all().find((x) => x.tag === 'button' && re.test(x.textContent));
    const inBox = find(/Run the tests in the box/);
    const out = find(/Run them outside the box/);
    inBox.fire('click');
    await settle();
    assert.equal(pending, 1);
    assert.equal(out.getAttribute('aria-disabled'), 'true', 'the other press looks busy too');
    out.fire('click');
    await settle();
    const status = content.all().find((x) => x.attrs.role === 'status');
    assert.equal(status.textContent, 'The tests are running in the box now; press again once this ends.');
    assert.equal(pending, 1, 'nothing more was sent');
  } finally {
    globalThis.fetch = before;
  }
  p.stop();
});

test('the tests\' status line stays in the accessibility tree while empty, so its first words are announced', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../../web/page-mission.css', import.meta.url), 'utf8');
  const rules = [...css.matchAll(/([^{}]*\.ms-tests-status[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length, 'its rules are there');
  for (const [, sel, body] of rules) assert.doesNotMatch(body, /display:\s*none|visibility:\s*hidden/, `${sel.trim()} hides it`);
});

test('the card puts the session\'s own test count inside the tests block, after the check\'s line and short', async () => {
  const content = new FakeElement('div');
  const many = { ...waitingTask({ ok: true, words: ['x'], boxed: true, tests: { result: 'passed' }, at: GATE_AT }), selfTests: { runs: 3, last: 'passed', at: '2026-11-19T08:10:00.000Z' } };
  const once = { ...waitingTask({ ok: false, words: ['x'], boxed: true, tests: { result: 'failed' }, at: GATE_AT }), id: 'red-one', title: 'Red one', state: 'his', selfTests: { runs: 1, last: 'failed', at: '2026-11-19T08:20:00.000Z' } };
  const never = { ...waitingTask({ ok: true, words: ['x'], boxed: true, tests: { result: 'passed' } }), id: 'plain-one', title: 'Plain one' };
  const m = missionOf({ state: 'waits', tasks: [many, once, never] });
  serve([m]);
  const p = viewMission(content, m.id);
  await settle();
  const selfs = content.all().filter((x) => /\bms-self-tests\b/.test(x.className));
  assert.deepEqual(selfs.map((x) => x.textContent), [
    'Before that, its session ran the tests itself 3 times (last: passed). Only the run above counts.',
    'Before that, its session ran the tests itself once (last: failed). Only the run above counts.',
  ], 'one short line per task whose session ran them, none for a task whose session did not');
  for (const el of selfs) {
    const block = el.closest('.ms-tests');
    assert.ok(block, 'the line sits inside the tests block, not above it as a role/branch-style row');
    const testLines = block.children.filter((c) => /\bms-tests-line\b/.test(c.className));
    assert.ok(testLines.indexOf(el) > 0, 'it comes after the check\'s own line');
    assert.doesNotMatch(el.textContent, /That is not the check|run again after the session ends/, 'it does not repeat the long sentence');
  }
  p.stop();
});

test('the session\'s own count while a session runs, and when the check failed before the tests ran', async () => {
  const content = new FakeElement('div');
  // A fix runs; the check before it failed in the box; the count is the fix session's own (reset at its start).
  const fix = taskOf({ state: 'running', run: { ...RUN, kind: 'fix' }, branch: 'work/add-the-cart', gate: { ok: false, words: ['x'], boxed: true, tests: { result: 'failed' }, at: '2026-11-19T08:00:00.000Z' }, selfTests: { runs: 2, last: 'passed', at: '2026-11-19T08:10:00.000Z' } });
  // The first work session runs: no check yet.
  const first = taskOf({ id: 'first-one', title: 'First one', state: 'running', run: RUN, branch: 'work/first-one', gate: null, selfTests: { runs: 3, last: 'failed', at: '2026-11-19T08:10:00.000Z' } });
  // The check after the session failed before its tests ran (a file left uncommitted): it has no line of its own.
  const early = taskOf({ id: 'early-one', title: 'Early one', state: 'queued', branch: 'work/early-one', gate: { ok: false, words: ['files were left uncommitted: x.txt'], at: GATE_AT }, selfTests: { runs: 1, last: 'passed', at: '2026-11-19T08:10:00.000Z' } });
  const m = missionOf({ tasks: [fix, first, early] });
  serve([m]);
  const p = viewMission(content, m.id);
  await settle();
  const selfs = content.all().filter((x) => /\bms-self-tests\b/.test(x.className));
  assert.deepEqual(selfs.map((x) => x.textContent), [
    'This session has run the tests itself 2 times so far (last: passed). The check runs them again after it ends.',
    'This session has run the tests itself 3 times so far (last: failed). The check runs them again after it ends.',
    'Its session ran the tests itself once (last: passed). The check after it did not run them: only the check\'s own run counts.',
  ], 'each card shows its session\'s count, in words true for where the task is');
  for (const el of selfs) assert.ok(el.closest('.ms-tests'), 'inside the tests part');
  assert.doesNotMatch(content.textContent, /Before that, its session ran the tests itself 2 times/, 'the fix\'s runs came after the failed check, not before it');
  p.stop();
});

test('the card shows when a session stopped at a limit, apart from one that simply ran its last run', async () => {
  const content = new FakeElement('div');
  const atRuns = { ...waitingTask({ ok: true, words: ['x'], boxed: true, tests: { result: 'passed' }, at: GATE_AT }), selfTests: { runs: 12, last: 'passed', at: '2026-11-19T08:10:00.000Z', limit: 'runs' } };
  const atTime = { ...waitingTask({ ok: true, words: ['x'], boxed: true, tests: { result: 'passed' }, at: GATE_AT }), id: 'time-one', title: 'Time one', selfTests: { runs: 4, last: 'passed', at: '2026-11-19T08:20:00.000Z', limit: 'time' } };
  const m = missionOf({ state: 'waits', tasks: [atRuns, atTime] });
  serve([m]);
  const p = viewMission(content, m.id);
  await settle();
  const lines = content.all().filter((x) => /\bms-self-tests\b/.test(x.className)).map((x) => x.textContent);
  assert.deepEqual(lines, [
    'Before that, its session ran the tests itself 12 times (last: passed), then reached its run limit. Only the run above counts.',
    'Before that, its session ran the tests itself 4 times (last: passed), then reached its time limit. Only the run above counts.',
  ], 'the line says it reached its run limit or its time limit');
  p.stop();
});

test('while the box is being checked the card says so, and reads again soon for the answer', async () => {
  const content = new FakeElement('div');
  const t1 = waitingTask({ ok: true, words: ['tests not run: yours to check (x)'], testsNotRun: true, notRunWhy: 'x' });
  const m = missionOf({ state: 'waits', tasks: [t1] });
  let answer = { checking: true };
  serve([m], ON, { box: () => answer });
  const p = viewMission(content, m.id);
  await settle();
  assert.match(content.textContent, /Checking whether this computer has a box \(a safe place to run tests, with no network\)…/);
  answer = { ok: false, why: 'no box on this computer: bubblewrap is not installed', step: 'install bubblewrap' };
  await new Promise((r) => setTimeout(r, 1700));
  await settle();
  assert.doesNotMatch(content.textContent, /Checking whether/);
  assert.match(content.textContent, /This computer has no box \(bubblewrap is not installed: install bubblewrap, to run the tests safely\)/);
  p.stop();
});

// The gate's reason may be "no box on this computer: …" (src/mission/gate.mjs). While the page still checks for a
// box, the line does not say "no box" and "checking" at once: that reason waits for the check's answer.
test('while the box is being checked the line leaves out a reason that says there is no box', async () => {
  const { testsLine } = await import('../../web/mission.js');
  for (const why of ['no box on this computer: bubblewrap is not installed', 'no box on this computer']) {
    const line = testsLine({ testsNotRun: true, notRunWhy: why }, { checking: true });
    assert.equal(line, 'The tests were not run. Checking whether this computer has a box (a safe place to run tests, with no network)…', why);
  }
  const other = testsLine({ testsNotRun: true, notRunWhy: 'the project names no test command' }, { checking: true });
  assert.equal(other, 'The tests were not run: the project names no test command. Checking whether this computer has a box (a safe place to run tests, with no network)…', 'another reason stays');
});

/** The overview as the server gives it, with the box's answer (feature.mjs overview). */
function serveTeam(cfg, box) {
  serve([], cfg);
  const was = answers['/api/work/missions'];
  answers['/api/work/missions'] = () => ({ ...was(), box });
}

test('Work → Team says per role what it may run, in plain words; with no box it says that nothing runs while they work', async () => {
  const content = new FakeElement('div');
  serveTeam(ON, { ok: true });
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  const card = (role) => content.all().find((x) => /\bms-role\b/.test(x.className) && x.textContent.startsWith(role));
  assert.match(card('Developer').textContent, /May run: the project's tests, its build and its scripts, in a box: no network, only its own folder\./);
  assert.match(card('Tester').textContent, /May run: the project's tests, its build and its scripts, in a box/);
  assert.match(card('Writer').textContent, /Runs nothing: it has the file tools only\./);
  assert.match(card('Reviewer').textContent, /Runs nothing/);
  assert.doesNotMatch(card('Tester').textContent, /cannot run them/, 'no word that is not true any more');
  assert.doesNotMatch(content.textContent, /This computer has no box/);
  serveTeam(ON, { ok: false, why: 'no box on this computer: bubblewrap is not installed', step: 'install bubblewrap' });
  await p.refresh();
  assert.match(content.textContent, /This computer has no box \(bubblewrap is not installed: install bubblewrap\), so no role runs anything while it works; the check runs the tests where a box is\./);
  p.stop();
});

test('a project\'s build command stands beside its test command and is saved with it', async () => {
  const content = new FakeElement('div');
  serveTeam({ ...ON, projects: { shop: { on: true, test: ['npm', 'test'], build: ['npm', 'run', 'build'] } } }, { ok: true });
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  const build = content.all().find((x) => x.dataset.key === 'build:shop');
  assert.ok(build, 'the build command\'s field');
  assert.equal(build.value, 'npm run build');
  assert.equal(build.getAttribute('aria-label'), 'The build command of shop');
  build.value = 'make all';
  posted.length = 0;
  content.all().find((x) => x.dataset.key === 'save:shop').fire('click');
  await settle();
  assert.deepEqual(posted, [['/api/work/missions/settings', { projects: { shop: { on: true, test: ['npm', 'test'], build: ['make', 'all'] } } }]]);
  p.stop();
});

test('Auto: shown only beside her switch for a project that is on, off on a fresh home, its sentence says what she starts', async () => {
  const content = new FakeElement('div');
  serve([], { ...ON, projects: { shop: { on: false } } });
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  assert.equal(content.all().find((x) => x.dataset.key === 'auto:shop'), undefined, 'her switch for shop is off: no Auto switch');
  serve([], ON);
  await p.refresh();
  await settle();
  const sw = content.all().find((x) => x.dataset.key === 'auto:shop');
  assert.ok(sw, 'beside her switch for shop');
  assert.equal(sw.getAttribute('checked'), null, 'off until he turns it on');
  assert.match(sw.parent.textContent, /Tia starts this project's ready tasks by herself/);
  assert.match(sw.parent.textContent, /Off: she starts only the tasks of plans you accept\./);
  posted.splice(0);
  sw.checked = true;
  sw.fire('change');
  await settle();
  assert.deepEqual(posted.find(([u]) => u === '/api/work/missions/settings')[1], { projects: { shop: { on: true, auto: true, test: null } } });
  serve([], { ...ON, projects: { shop: { on: true, auto: true, test: null } } });
  await p.refresh();
  await settle();
  const on = content.all().find((x) => x.dataset.key === 'auto:shop');
  assert.equal(on.getAttribute('checked'), '', 'on');
  assert.match(on.parent.textContent, /is started by her as a mission of its own, one at a time, within your limits below\. Each start is in Work → Activity; End on its mission stops it, and she never takes that task by herself again\./);
  p.stop();
});

test('a mission Tia started by herself says so on its row and its screen, and offers End', async () => {
  const content = new FakeElement('div');
  const m = missionOf({ auto: true, plan: null, goal: 'Add the cart', tasks: [taskOf({ state: 'running', run: RUN })] });
  serve([m]);
  const p = paintTeam(content, { onGoal: () => {} });
  await settle();
  const row = content.querySelector('a.ms-row');
  assert.match(row.textContent, /Started by Tia \(Auto\)/);
  assert.match(row.getAttribute('aria-label'), /\. Started by Tia \(Auto\)/);
  p.stop();
  const screen = new FakeElement('div');
  const v = viewMission(screen, m.id);
  await settle();
  assert.match(screen.textContent, /Started by Tia \(Auto\): it was a ready task of shop\. End stops it, and she never takes this task by herself again\./);
  const end = screen.all().find((x) => x.dataset.key === 'stop');
  assert.equal(end.textContent.trim(), 'End');
  assert.doesNotMatch(screen.textContent, /Stop this mission/);
  v.stop();
  const plain = new FakeElement('div');
  serve([missionOf({ tasks: [taskOf({ state: 'running', run: RUN })] })]);
  const w = viewMission(plain, 'm-20261119-abcdef');
  await settle();
  assert.doesNotMatch(plain.textContent, /Started by Tia \(Auto\)/, 'a mission of a plan he accepted is not marked');
  assert.match(plain.textContent, /Stop this mission/);
  w.stop();
});
