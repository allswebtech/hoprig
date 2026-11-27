// The AI brain stays in step between two computers on the DEFAULT switches (the map saved in the brain's history, no
// "push" switch): Hoprig's own map commits go up by themselves, never anything else of the owner's, and a brain that
// moved on the git server is brought in. And the rule asks for the map's round in every round that syncs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-instep-brain');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const C = await import('../../src/workspace/computer.mjs');
const rule = await import('../../src/automation/workspacesync.mjs');

let n = 0;
async function two() {
  n++;
  const brainUrl = w.bare(`brain${n}`, { empty: true });
  const server = path.join(w.server, 'team', `brain${n}.git`);
  const A = w.computer(`a${n}`);
  A.use();
  A.brain = path.join(A.ws, 'ai_brain');
  fs.mkdirSync(A.projects, { recursive: true });
  w.sh(A.ws, 'clone', '-q', brainUrl, A.brain);
  w.commit(A.brain, 'BRAIN.md', '# brain\n', 'Start the brain');
  await M.updateMap({ dir: A.ws, projects: A.projects });
  w.sh(A.brain, 'add', '-A');
  w.sh(A.brain, 'commit', '-q', '-m', 'Add the map');
  w.sh(A.brain, 'push', '-q', '-u', 'origin', 'main');
  await C.setLabel('boxa', { dir: A.ws, projects: A.projects });
  const B = w.computer(`b${n}`);
  B.use();
  B.brain = path.join(B.ws, 'ai_brain');
  w.clone(brainUrl, B.brain);
  fs.mkdirSync(B.projects, { recursive: true });
  await C.setLabel('boxb', { dir: B.ws, projects: B.projects });
  return { A, B, server };
}
/** A round on the default switches: the map is saved in the brain, the "push" switch is off. */
const round = async (c) => {
  c.use();
  return upkeepMap({ dir: c.ws, projects: c.projects, commit: true, push: false });
};
const state = (c) => {
  w.sh(c.brain, 'fetch', '-q');
  return w.sh(c.brain, 'rev-list', '--left-right', '--count', 'HEAD...@{u}').split(/\s+/).map(Number);
};
const newProject = (c, name) => w.clone(w.bare(name), path.join(c.projects, name));

test('two computers on the default switches never part in the brain', async () => {
  const { A, B, server } = await two();
  await round(A);
  await round(B);
  await round(A);
  await round(B);
  newProject(A, 'shop');
  await round(A);
  await round(B);
  await round(A);
  assert.deepEqual(state(A), [0, 0], 'a is not ahead or behind');
  assert.deepEqual(state(B), [0, 0], 'b is not ahead or behind');
  assert.equal(w.sh(A.brain, 'rev-parse', 'HEAD'), w.sh(server, 'rev-parse', 'main'));
  assert.ok(fs.existsSync(path.join(A.brain, 'computers', 'boxb.json')), 'a has the file of b');
  assert.ok(fs.existsSync(path.join(B.brain, 'computers', 'boxa.json')), 'b has the file of a');
  assert.ok(M.readMap(B.ws).map.projects.some((p) => p.name === 'shop'), 'b has the map entry a added');
});

test('a commit of the owner\'s own is never pushed by the map\'s rule while the push switch is off', async () => {
  const { A, server } = await two();
  await round(A);
  A.use();
  w.commit(A.brain, 'notes.md', 'my own words', 'My own notes');
  newProject(A, 'blog');
  const before = w.sh(server, 'rev-parse', 'main');
  await round(A);
  assert.equal(w.sh(server, 'rev-parse', 'main'), before, 'nothing went up: the owner\'s commit rides on the map\'s');
  assert.deepEqual(state(A).map((x) => x > 0), [true, false], 'still ahead, not diverged');
});

test('the rule asks for the map\'s round in every round that syncs, even a recent one', () => {
  const H = 3600_000;
  const s = { map: true, commitMap: true, sync: true, push: false, everyHours: 6 };
  const d = rule.decide({ data: { lastMapAt: 9.9 * H }, now: 10 * H, settings: { ...s, sync: false } });
  assert.deepEqual(d.actions, [], 'the map\'s own round is not due');
  const e = rule.decide({ data: { lastMapAt: 99 * H, lastAt: 0 }, now: 100 * H, settings: s });
  assert.deepEqual(e.actions.map((a) => a.type), ['sync', 'map'], 'sync is due: the map goes with it');
  assert.equal(e.actions[0].mapRule, true, 'the rule is on with push off too');
});

test('the look: every 30 minutes and at start, only while some place has its switch on', () => {
  const MIN = 60_000;
  const s = { map: false, sync: false, everyHours: 6, ffProjects: { projects: true } };
  const first = rule.decide({ data: {}, now: 100 * MIN, boot: true, settings: s });
  assert.deepEqual(first.actions, [{ type: 'look', ff: { projects: true } }]);
  assert.deepEqual(rule.decide({ data: first.data, now: 120 * MIN, settings: s }).actions, [], 'not yet');
  assert.deepEqual(rule.decide({ data: first.data, now: 130 * MIN, settings: s }).actions.map((a) => a.type), ['look']);
  assert.deepEqual(rule.decide({ data: {}, now: 100 * MIN, boot: true, settings: { ...s, ffProjects: { projects: false } } }).actions, [], 'all places off: no look at all');
  assert.deepEqual(rule.decide({ data: {}, now: 100 * MIN, boot: true, settings: { ...s, ffProjects: undefined } }).actions, []);
});

test('the look is one line of the activity per moved repository, none when nothing moved', async () => {
  const records = [];
  const ctx = { record: (e) => records.push(e), notify: () => {}, data: {}, save: () => {}, workspaceLook: async () => ({ items: [], moved: [{ label: 'shop/code/shop-api', n: 2 }] }) };
  await rule.apply([{ type: 'look', ff: { projects: true } }], ctx);
  assert.equal(records.length, 1);
  assert.match(records[0].did, /shop\/code\/shop-api: pulled 2/);
  await rule.apply([{ type: 'look', ff: { projects: true } }], { ...ctx, workspaceLook: async () => ({ items: [], moved: [] }) });
  assert.equal(records.length, 1, 'nothing moved: no line');
  await rule.apply([{ type: 'look', ff: { projects: true } }], { ...ctx, workspaceLook: async () => { throw new Error('offline'); } });
  assert.match(records.at(-1).outcome, /failed: offline/);
});
