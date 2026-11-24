// Save with mission files (src/mission/file.mjs): a mission is a file of Work, so a save commits the list and the new
// or changed mission files right in missions/ by name, as it does run files — and a commit that changes only Work's
// files (the list, runs/, plans/, missions/) is Work's for the rule of what a save may send. A file of a mission's
// name that is not a plain mission record (a link, or something a session wrote) is named and left alone.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-savemissions');
test.after(() => t.cleanup());
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { savePlan, saveWork } = await import('../../src/work/save.mjs');
const { sortUnsent } = await import('../../src/work/git.mjs');
const { writerId } = await import('../../src/work/runs.mjs');
const { newMissionId, newTask, writeMission } = await import('../../src/mission/file.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n', 'src/app.js': 'one\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const mid = newMissionId(new Date('2026-11-17T10:00:00Z'));
const mission = (id = mid, extra = {}) => writeMission(place(), {
  v: 1, id, writer: writerId(), goal: 'Make the shop faster', project: 'shop', proposal: null, plan: null,
  state: 'running', why: null, createdAt: '2026-11-17T10:00:00.000Z', endedAt: null,
  tasks: [newTask('fix-the-cart', 'Fix the cart', 'developer')], line: [], ...extra,
});

test('the save rule knows missions/: a commit of only a mission file is Work\'s, one with another file beside it is not', () => {
  const c = (files, parents = ['p']) => ({ sha: files.join(), short: 'abc1234', subject: 's', parents, files });
  const o = { rel: 'docs/plans/tasks.json', runsRel: 'docs/plans/runs', plansRel: 'docs/plans/plans', missionsRel: 'docs/plans/missions' };
  const r = sortUnsent([
    c([`docs/plans/tasks.json`, `docs/plans/missions/${mid}.json`]),
    c([`docs/plans/missions/${mid}.json`]),
    c([`docs/plans/missions/${mid}.json`, 'src/app.js']),
    c(['docs/plans/missions/notes.txt']),
    c(['docs/plans/missions/sub/m-20261117-abcdef.json']),
  ], o);
  assert.equal(r.ours.length, 2, 'the list + a mission, and a mission alone, are Work\'s');
  assert.equal(r.theirs.length, 3, 'a file beside a mission, a wrong name, a nested one: the owner\'s');
  assert.equal(sortUnsent([c([`docs/plans/missions/${mid}.json`])], { rel: o.rel }).theirs.length, 1, 'without the missions folder, a mission file is not Work\'s');
});

test('save commits the list and the mission file by name, nothing else, and a stray name is left alone', async () => {
  await store().add({ title: 'Fix the cart' });
  mission();
  // a file of a mission's name that is not a mission record: never committed as Work's
  const strayName = `m-20261118-abcdef.json`;
  const fs = await import('node:fs');
  fs.writeFileSync(path.join(shop, 'docs/plans/missions', strayName), 'not a mission\n');
  const plan = await savePlan(place());
  const paths = plan.files.map((f) => f.path);
  assert.ok(paths.includes('docs/plans/tasks.json'), 'the list');
  assert.ok(paths.includes(`docs/plans/missions/${mid}.json`), paths.join(', '));
  assert.ok(!paths.some((p) => p.includes(strayName)), 'the stray name is not committed as Work\'s');
  assert.ok(plan.notMissions.some((p) => p.includes(strayName)), 'it is named instead');
  await saveWork(place(), { subject: 'Update work items' });
  const tracked = t.git(shop, 'ls-files', 'docs/plans/missions').split('\n').filter(Boolean);
  assert.deepEqual(tracked, [`docs/plans/missions/${mid}.json`], 'only the mission record was committed');
});
