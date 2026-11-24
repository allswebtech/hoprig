// A mission's why that names a place gets that place as a code of the page's table of places (web/errorways.js), in
// the report's field `ways`, as the Operator's items do: "accept its plan on Work → Plans", "the role X is off
// (Work → Team)", "no provider is allowed yet (Work → Team)". The codes are worked out from the why's own words when the
// report is built; the mission file keeps the keys it had, so a dashboard on an older build that reads the same Work
// folder still reads it. The mission's screen draws a link only for a code the table knows, and the link only opens the
// place.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome, standInBox } from './helpers.mjs';

const t = missionHome('mission-ways');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { writeProposal } = await import('../../src/work/proposals.mjs');
const { newRunId } = await import('../../src/work/runs.mjs');
const { missionEngine } = await import('../../src/mission/engine.mjs');
const { readMission, checkMission, missionsDir } = await import('../../src/mission/file.mjs');
const { missionReport } = await import('../../src/mission/report.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const OK = [process.execPath, '-e', 'process.exit(0)'];
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' }, missions: {} };
saveConfig(cfg);
const ON = { on: true, projects: { shop: { on: true, test: OK } }, capUsd: 5, providers: ['key'], atOnce: 1 };
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
process.env.FAKE_TOOL_LOG = path.join(t.root, 'tool.log');
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 1 }), minuteMs: 600, killGraceMs: 200 });
const planner = {
  async start(c) {
    const rec = { v: 1, id: newRunId(new Date()), place: 'x', goal: c.goal, project: c.project, state: 'working', reason: null };
    writeProposal(rec);
    return { proposal: rec };
  },
};
const engines = [];
let days = 0;
const engineOf = () => {
  const day = ++days;
  const e = missionEngine({ config: () => cfg, runner, planner, providers: () => [{ name: 'key', kind: 'api' }], slots: () => 1, machine: () => null, box: () => standInBox, reopen: (id) => store().status(id, 'open'), tickMs: 3_600_000, now: () => new Date(Date.now() + day * 86_400_000) });
  engines.push(e);
  return e;
};
test.after(async () => {
  for (const e of engines) await e.close();
  await runner.close();
});
async function accepted(e, goal, by) {
  const g = await e.give({ goal, project: 'shop' });
  assert.equal(g.plain, false, g.why);
  const id = (await store().add({ title: `${goal}: one note`, project: 'shop', by, note: 'Files: note.md' })).item.id;
  await e.accepts.after(g.proposal.id, { plan: 'a-plan', tasks: [id] });
  return { id: g.mission.id, task: id };
}
// The keys a mission file and its tasks had before the codes came (an older dashboard checks exactly these).
const TOP = ['v', 'id', 'writer', 'goal', 'project', 'proposal', 'plan', 'state', 'why', 'createdAt', 'endedAt', 'tasks', 'line'];
const TASK = ['id', 'title', 'role', 'provider', 'model', 'effort', 'state', 'why', 'branch', 'base', 'run', 'runs', 'fixes', 'restarts', 'gateFails', 'gate', 'firstPass', 'verdicts', 'limited', 'claim', 'next', 'points', 'selfTests', 'waitUntil', 'recheck'];
/** The mission as it lies on disk, with no key an older dashboard does not know. */
function onDisk(id) {
  const raw = JSON.parse(fs.readFileSync(path.join(missionsDir(place()), `${id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(raw).filter((k) => !TOP.includes(k)), [], 'no new key in the mission');
  for (const x of raw.tasks) assert.deepEqual(Object.keys(x).filter((k) => !TASK.includes(k)), [], 'no new key in a task');
  return raw;
}

test('planning: the why names Work → Plans, its code is in the report, and the file keeps its old keys', async () => {
  cfg.missions = structuredClone(ON);
  const e = engineOf();
  const g = await e.give({ goal: 'A plan for the shop', project: 'shop' });
  const m = readMission(place(), g.mission.id);
  assert.equal(m.why, 'A session is planning it: accept its plan on Work → Plans, and Tia begins', 'the words are as they were');
  onDisk(g.mission.id);
  assert.deepEqual(missionReport(m).ways, ['work-plans']);
});

test('a role that is off: the task is his, its why names Work → Team with that code', async () => {
  cfg.missions = { ...structuredClone(ON), rolesOff: ['writer'] };
  const e = engineOf();
  const { id, task } = await accepted(e, 'Notes by an off role', 'writer');
  await e.tick();
  const m = readMission(place(), id);
  const x = m.tasks.find((y) => y.id === task);
  assert.equal(x.state, 'his');
  assert.equal(x.why, 'the role writer is off (Work → Team)');
  onDisk(id);
  assert.deepEqual(missionReport(m).tasks.find((y) => y.id === task).ways, ['work-team']);
});

test('no provider allowed yet: the task and the mission wait, both whys name Work → Team with that code', async () => {
  cfg.missions = { ...structuredClone(ON), providers: [] };
  const e = engineOf();
  const { id, task } = await accepted(e, 'Notes with no provider', 'writer');
  await e.tick();
  const m = readMission(place(), id);
  assert.equal(m.why, 'no provider is allowed yet (Work → Team)');
  onDisk(id);
  const r = missionReport(m);
  assert.deepEqual(r.ways, ['work-team']);
  assert.deepEqual(r.tasks.find((y) => y.id === task).ways, ['work-team']);
  assert.equal(t.trapped(), '');
});

test('the report: the codes follow the why it has now; the file\'s schema is as strict as before', () => {
  const m = {
    v: 1, id: 'm-20261122-abcdef', writer: 'aaaaaaaaaaaaaaaa', goal: 'A goal', project: 'shop', proposal: null, plan: null, state: 'running', why: 'no provider is allowed yet (Work → Team)',
    createdAt: '2026-11-22T08:00:00.000Z', endedAt: null, tasks: [], line: [],
  };
  assert.doesNotThrow(() => checkMission(m));
  assert.deepEqual(missionReport(m).ways, ['work-team']);
  m.why = 'You stopped it';
  assert.equal(missionReport(m).ways, undefined, 'a why that names no place gets no code');
  m.why = null;
  assert.equal(missionReport(m).ways, undefined);
  m.why = 'every provider of your order reached its usage limit: it waits until 14:00, then tries again';
  assert.equal(missionReport(m).ways, undefined);
  assert.throws(() => checkMission({ ...m, ways: { why: m.why, codes: ['work-team'] } }), /unknown key "ways"/, 'no key a dashboard on an older build would refuse');
});

// ---------- the mission's screen draws the links (web/mission.js) ----------

class FakeNode {}
class FakeText extends FakeNode {
  constructor(s) {
    super();
    this.text = String(s);
  }
  get textContent() {
    return this.text;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    Object.assign(this, { tag: String(tag).toLowerCase(), className: '', dataset: {}, style: {}, attrs: {}, children: [], listeners: {} });
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
  addEventListener(k, fn) {
    (this.listeners[k] ||= []).push(fn);
  }
  append(...n) {
    for (const x of n) this.children.push(x instanceof FakeNode ? x : new FakeText(x));
  }
  replaceChildren(...n) {
    this.children = [];
    this.append(...n);
  }
  get textContent() {
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.replaceChildren(String(v));
  }
  focus() {}
  scrollIntoView() {}
  contains() {
    return false;
  }
  closest() {
    return null;
  }
  all() {
    return this.children.filter((c) => c instanceof FakeElement).flatMap((c) => [c, ...c.all()]);
  }
  querySelectorAll() {
    return [];
  }
  querySelector() {
    return null;
  }
}
const body = new FakeElement('body');
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: (x) => new FakeElement(x), createElementNS: (ns, x) => new FakeElement(x), createTextNode: (x) => new FakeText(x),
  getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body, activeElement: body, documentElement: new FakeElement('html'),
};
globalThis.window ??= { addEventListener: () => {}, dispatchEvent: () => {} };
const answers = {};
globalThis.fetch = async (u) => {
  const d = answers[u];
  return { ok: d !== undefined, status: d === undefined ? 404 : 200, json: async () => structuredClone(d ?? { error: 'not here' }) };
};

test('the mission\'s screen: a link for each code the table knows, none for an unknown one, every word kept', async () => {
  const { viewMission } = await import('../../web/mission.js');
  const { WAYS } = await import('../../web/errorways.js');
  const task = { id: 'one-note', title: 'One note', role: 'writer', state: 'his', why: 'the role writer is off (Work → Team)', branch: null, tests: null, testsResult: null, tokens: 0, minutes: 0, cost: 0, costUnknown: 0, firstPass: null };
  const mission = (ways, taskWays) => ({
    id: 'm-20261122-abcdef', goal: 'A goal', project: 'shop', state: 'stopped', face: 'stopped', why: 'no provider is allowed yet (Work → Team)', ways, createdAt: '2026-11-22T08:00:00.000Z', endedAt: null,
    tasks: [{ ...task, ways: taskWays }], total: { cost: 0, tokens: 0, minutes: 0, costUnknown: 0, judged: 0, passedFirst: 0 }, counts: {}, lines: [], line: [], mine: true, box: null, plan: null, proposal: null, tasksFull: [],
  });
  answers['/api/work/missions'] = { settings: { on: true, offStops: false }, steps: [], missions: [] };
  const draw = async (m) => {
    answers['/api/work/missions/m-20261122-abcdef'] = { mission: m };
    const content = new FakeElement('div');
    const v = viewMission(content, 'm-20261122-abcdef');
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    v.stop();
    return content;
  };
  // A code the table already has ('interrupted' leads to Work), so the link is proven on what the page knows today.
  assert.ok(Object.hasOwn(WAYS, 'interrupted'));
  const c = await draw(mission(['interrupted'], ['interrupted', 'no-such-place']));
  const links = c.all().filter((x) => x.tag === 'a' && /\bop-way\b/.test(x.className));
  assert.deepEqual(links.map((a) => [a.textContent, a.attrs.href]), [['Open Work', '#/work'], ['Open Work', '#/work']], 'one for the mission\'s why, one for the task\'s; the unknown code drew nothing');
  assert.ok(links.every((a) => !a.listeners.click), 'a link only opens its place');
  assert.match(c.textContent, /no provider is allowed yet \(Work → Team\)/);
  assert.match(c.textContent, /the role writer is off \(Work → Team\)/);
  const none = await draw(mission(['no-such-place'], undefined));
  assert.equal(none.all().filter((x) => x.tag === 'a' && /\bop-way\b/.test(x.className)).length, 0, 'an unknown code draws nothing');
  assert.match(none.textContent, /no provider is allowed yet \(Work → Team\)/, 'the sentence keeps its words');
});
