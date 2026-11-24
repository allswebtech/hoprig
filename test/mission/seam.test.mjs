// A mission's choice points through the one decision door (src/mission/seam.mjs): a provider at its usage limit, a task
// that waits until a named time, a task sent back twice. The engine runs with the stand-in coding tool and a stand-in
// door: with no door (or a door that is off) it does exactly what it did before; a step of the door's is done with who
// chose it on the mission's line; what is his waits with one line why.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FAKE, missionHome, standInBox } from './helpers.mjs';

const t = missionHome('mission-seam');
test.after(() => t.cleanup());
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { writeProposal } = await import('../../src/work/proposals.mjs');
const { newRunId } = await import('../../src/work/runs.mjs');
const { missionEngine } = await import('../../src/mission/engine.mjs');
const { readMission } = await import('../../src/mission/file.mjs');
const { OWNER_OF, engineOwns, mayDo, missionItem } = await import('../../src/mission/seam.mjs');
const { MISSION_OWNS, ruleFor } = await import('../../src/operator/rules.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
t.arm();
const OK = [process.execPath, '-e', 'process.exit(0)'];
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' }, missions: {} };
saveConfig(cfg);
const ON = { on: true, projects: { shop: { on: true, test: OK } }, capUsd: 5, providers: ['key', 'key2'], atOnce: 1 };
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
process.env.FAKE_TOOL_LOG = path.join(t.root, 'tool.log');
const verdicts = path.join(t.root, 'verdicts');
process.env.FAKE_VERDICTS = verdicts;
const runner = aloneRunner({ config: () => cfg, command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), settings: () => ({ atOnce: 2 }), minuteMs: 600, killGraceMs: 200 });
const planner = {
  async start(c) {
    const rec = { v: 1, id: newRunId(new Date()), place: 'x', goal: c.goal, project: c.project, state: 'working', reason: null };
    writeProposal(rec);
    return { proposal: rec };
  },
};
const engines = [];
let days = 0;
/** An engine on a day of its own, with a door (or none) and a clock that can be moved on. */
function engineOf(door, providers = [{ name: 'key', kind: 'api' }, { name: 'key2', kind: 'api' }]) {
  const clock = { shift: 0 };
  const base = Date.now() + ++days * 86_400_000;
  const e = missionEngine({ config: () => cfg, runner, planner, providers: () => providers, slots: () => 2, machine: () => null, box: () => standInBox, reopen: (id) => store().status(id, 'open'), tickMs: 3_600_000, now: () => new Date(base + clock.shift), ...(door ? { door } : {}) });
  e.clock = clock;
  engines.push(e);
  return e;
}
test.after(async () => {
  for (const e of engines) await e.close();
  await runner.close();
});
async function mission(e, goal, tasks) {
  const g = await e.give({ goal, project: 'shop' });
  assert.equal(g.plain, false, g.why);
  const ids = [];
  for (const x of tasks) ids.push((await store().add({ title: x.title, project: 'shop', by: x.by || 'writer', note: x.note })).item.id);
  await e.accepts.after(g.proposal.id, { plan: 'a-plan', tasks: ids });
  return { id: g.mission.id, ids };
}
async function until(e, id, ok, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    await e.tick();
    const m = readMission(place(), id);
    if (ok(m) || Date.now() > end) return m;
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function quiet() {
  for (let i = 0; i < 300 && runner.running().length; i++) await new Promise((r) => setTimeout(r, 100));
}
/** A stand-in door: answers `answer(item)` and keeps every item it was asked about. */
const doorOf = (answer) => {
  const asked = [];
  const door = async (item) => {
    asked.push(item);
    return answer(item);
  };
  door.asked = asked;
  return door;
};
const words = (m) => m.line.map((l) => l.words).join('\n');

test('one table says which loop owns each kind of a mission\'s item, and the Operator\'s rules read the same list', () => {
  assert.deepEqual(Object.entries(OWNER_OF).filter(([, v]) => v === 'mission').map(([k]) => k).sort(), [...MISSION_OWNS].sort());
  const limit = { kind: 'limit', acts: [{ id: 'switch' }], recommended: 'switch', target: { session: 's', to: 'b', hook: true, mission: true } };
  assert.equal(engineOwns(limit), true);
  assert.equal(ruleFor(limit), null, 'no rule of the Operator\'s acts on a limit of a mission\'s session');
  const plain = { ...limit, target: { ...limit.target, mission: undefined } };
  assert.equal(ruleFor(plain).id, 'limit', 'a session of his own: the limit rule as before');
  assert.equal(engineOwns({ kind: 'machine', target: { mission: true } }), false, 'the computer is the Operator\'s');
  // What nobody can explain is the Operator's (its look only reads), also for a mission's run or check.
  assert.equal(OWNER_OF.unknown, 'operator');
  assert.equal(engineOwns({ kind: 'unknown', target: { case: 'check', mission: true } }), false);
});

test('the item of a choice: its kind, its prepared steps, and the same picture decided once', async () => {
  const c = { kind: 'mission-limit', mission: 'm-20260101-abcdef', task: 'shop-1', title: 'Add the search', project: 'shop', provider: 'key', to: 'key2', waitMs: 30 * 60_000, at: '2026-01-01T10:00:00.000Z' };
  const it = missionItem(c);
  assert.deepEqual(it.steps, ['next-provider', 'wait']);
  assert.equal(missionItem(c).rev, it.rev);
  assert.notEqual(missionItem({ ...c, at: '2026-01-01T11:00:00.000Z' }).rev, it.rev, 'a new limit is a new picture');
  assert.deepEqual(missionItem({ ...c, to: null, waitMs: 3 * 3600_000 }).steps, [], 'no free provider and a wait past the hour: his');
  assert.deepEqual(missionItem({ ...c, kind: 'mission-sent-back' }).steps, [], 'sent back twice: no step but his');
  assert.deepEqual(missionItem({ ...c, kind: 'mission-waits' }).steps, ['wait']);
  // The provider is named as the Providers page names it: its label, the short name without one, Auto mode.
  assert.ok(it.facts.includes('provider key'), it.facts.join('|'));
  assert.ok(missionItem({ ...c, providerLabel: 'Shop Key Plan' }).facts.includes('provider Shop Key Plan'));
  assert.ok(missionItem({ ...c, provider: 'auto', providerLabel: 'Auto' }).facts.includes('provider Auto mode'));
  // A door that answers a step the item does not offer: his.
  assert.equal((await mayDo({ ...c, kind: 'mission-sent-back' }, async () => ({ act: 'next-provider', by: 'Tia decides' }))).ask, true);
  assert.equal(await mayDo(c, null), null, 'no door: the engine as before');
  assert.equal(await mayDo(c, async () => null), null, 'the door is off: the engine as before');
});

test('with the door off, a limit goes on with the next provider of his order exactly as before', async () => {
  cfg.missions = structuredClone(ON);
  const door = doorOf(() => null);
  const e = engineOf(door, [{ name: 'key', kind: 'api', label: 'Shop Key Plan' }, { name: 'key2', kind: 'api', label: null }]);
  const { id } = await mission(e, 'A goal at a limit, door off', [{ title: 'Limited note', note: 'DO:limit' }]);
  const m = await until(e, id, (x) => x.tasks[0].runs.length >= 1 && x.tasks[0].state !== 'running');
  assert.ok(m.line.some((l) => l.words === 'key reached its usage limit: it goes on with key2, the next provider of your order'), words(m));
  assert.equal(door.asked[0].kind, 'mission-limit', 'the door was asked');
  assert.ok(door.asked[0].facts.includes('provider Shop Key Plan'), `the item names the provider by its label: ${door.asked[0].facts.join('|')}`);
  await e.stop(id).catch(() => {});
  await quiet();
});

test('a rule of his answers the limit: the task goes on with the next provider, the rule\'s name on the mission\'s line', async () => {
  cfg.missions = structuredClone(ON);
  const door = doorOf((it) => (it.kind === 'mission-limit' ? { act: 'next-provider', by: 'the limit rule', why: '' } : null));
  const e = engineOf(door);
  const { id } = await mission(e, 'A goal at a limit, by the rule', [{ title: 'Limited note', note: 'DO:limit' }]);
  const m = await until(e, id, (x) => x.tasks[0].runs.length >= 1 && x.tasks[0].state !== 'running');
  assert.ok(m.line.some((l) => /key reached its usage limit: it goes on with key2, the next provider of your order \(the limit rule\)/.test(l.words)), words(m));
  await e.stop(id).catch(() => {});
  await quiet();
});

test('Tia decides to wait: the task starts again only at the named time, and the line says she chose it and why', async () => {
  cfg.missions = structuredClone(ON);
  const door = doorOf((it) => (it.steps.includes('wait') ? { act: 'wait', by: 'Tia decides', why: 'his note says to wait for a short reset' } : null));
  const e = engineOf(door);
  const { id } = await mission(e, 'A goal that waits', [{ title: 'Limited note', note: 'DO:limit' }]);
  const m = await until(e, id, (x) => x.tasks[0].runs.length === 1 && x.tasks[0].state === 'queued');
  assert.ok(m.tasks[0].waitUntil, 'the time it waits for is kept on the task');
  assert.ok(m.line.some((l) => /it waits until \d\d:\d\d for key, then goes on \(Tia decides: his note says to wait for a short reset\)/.test(l.words)), words(m));
  for (let i = 0; i < 3; i++) await e.tick();
  assert.equal(readMission(place(), id).tasks[0].runs.length, 1, 'not started again before its time');
  e.clock.shift = 61 * 60_000;
  const m2 = await until(e, id, (x) => x.tasks[0].runs.length >= 2);
  assert.ok(m2.tasks[0].runs.length >= 2, 'started again once its time came');
  assert.equal(m2.tasks[0].runs[1].provider === null || m2.tasks[0].runs[1].provider === 'key', true, 'on the provider it waited for');
  await e.stop(id).catch(() => {});
  await quiet();
});

test('what is his waits with one line why: a limit the door leaves to him, and a task sent back twice', async () => {
  cfg.missions = structuredClone(ON);
  const door = doorOf(() => ({ ask: true, why: 'Tia did not pick a step (his note says to ask him)' }));
  const e = engineOf(door);
  const { id } = await mission(e, 'A goal left to him', [{ title: 'Limited note', note: 'DO:limit' }]);
  const m = await until(e, id, (x) => x.tasks[0].state === 'his');
  assert.equal(m.tasks[0].state, 'his', words(m));
  assert.match(m.tasks[0].why, /key reached its usage limit; Tia did not pick a step \(his note says to ask him\)/);
  assert.equal(m.tasks[0].runs.length, 1, 'nothing more was started');
  fs.writeFileSync(verdicts, 'FIX One\nFIX Two\nFIX Three\n');
  const { id: id2 } = await mission(e, 'A goal nobody agrees on', [{ title: 'Add the search', by: 'developer', note: 'Files: search.js' }]);
  const m2 = await until(e, id2, (x) => x.tasks[0].state === 'his', 60_000);
  assert.equal(m2.tasks[0].state, 'his', words(m2));
  assert.match(m2.tasks[0].why, /after two fixes \(Tia did not pick a step/);
  assert.ok(door.asked.some((it) => it.kind === 'mission-sent-back' && it.steps.length === 0), 'the door was asked, with no step but his');
  assert.equal(t.trapped(), '', 'no trapped program was called');
});
