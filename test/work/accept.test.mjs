// Accepting a proposal (src/work/planstore.mjs): the note, the plan and its tasks written as one unit; a kill at each
// step leaves either nothing or everything once the next look at the Work list finishes it; a file changed after the
// kill is never written over; plans made and changed by hand.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { endSignal, tempWork } from './helpers.mjs';

const t = tempWork('work-accept');
test.after(() => t.cleanup());
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { saveConfig } = await import('../../src/config.mjs');
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { readDoc } = await import('../../src/work/store.mjs');
const S = await import('../../src/work/planstore.mjs');
const { finishInterrupted } = await import('../../src/work/resume.mjs');
const { readPlan, readNote, listPlans } = await import('../../src/work/plans.mjs');
const { writeProposal, readProposal } = await import('../../src/work/proposals.mjs');

const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": [\n    {\n      "id": "old-task",\n      "date": null,\n      "title": "An old task",\n      "status": "open",\n      "source": "alex"\n    }\n  ]\n}\n' });
t.repo(path.join(t.projects, 'blog'));
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
saveConfig(cfg);
const place = () => resolvePlace(cfg);
const NOW = '2026-11-18T10:00:00.000Z';
const ctx = () => ({ today: '2026-11-18', ownerId: 'alex', projects: projectNames(), now: () => new Date(NOW) });
const proposal = () => ({
  title: 'Make the shop site faster',
  goal: 'The home page loads in two seconds on a phone.',
  projects: ['shop', 'blog'],
  note: '## What exists\n- Large images in `public/img`.',
  milestones: [{ title: 'Images small', date: '2026-12-02' }, { title: 'Live', date: null }],
  tasks: [
    { title: 'Measure the page', date: '2026-11-24', milestone: 0, by: 'ai', after: [], brief: 'Measure the load time of the home page.', check: 'A table of times.', project: null },
    { title: 'Shrink the images', date: '2026-11-26', milestone: 0, by: 'developer', after: [0], brief: 'Convert the images to WebP.', check: null, project: null },
    { title: 'Approve the images', date: null, milestone: 1, by: 'me', after: [1], brief: null, check: 'You said yes.', project: 'blog' },
  ],
});
const PID = '20261118-100000-0a0b0c0d';
const record = () => writeProposal({ v: 1, id: PID, place: 'x', goal: 'Faster site', project: 'shop', also: [], tool: 'claude', provider: 'sub', model: null, effort: null, session: null, conversation: null, message: null, startedAt: NOW, endedAt: NOW, state: 'ready', reason: null, answer: '', proposal: proposal(), problem: null, cleaned: false });

/** Every file of the project (not .git), path → content: the whole tree. */
function tree(dir = shop) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        out[`${path.relative(dir, p)}/`] = '';
        walk(p);
      } else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}
const reset = () => {
  t.git(shop, 'checkout', '-q', '--', '.');
  t.git(shop, 'clean', '-qfd');
  S.dropAccept(place());
};

test('Accept writes the note, the plan and its tasks: milestones, what waits for what, briefs, and tasks that are dropped not removed', async () => {
  reset();
  record();
  const r = await S.acceptProposal(place(), proposal(), ctx(), { pid: PID });
  assert.match(r.plan, /^make-the-shop-site-faster-[0-9a-f]{6}$/, 'its title and a mark of the moment it was made');
  const plan = readPlan(place(), r.plan);
  assert.deepEqual(plan.milestones, [{ id: 'images-small', title: 'Images small', date: '2026-12-02' }, { id: 'live', title: 'Live', date: null }]);
  assert.deepEqual(plan.made, { at: NOW, how: 'proposal' });
  assert.equal(plan.note, `${r.plan}.md`);
  assert.equal(readNote(place(), plan), '## What exists\n- Large images in `public/img`.');
  const items = readDoc(place().file).doc.items;
  const [measure, shrink, approve] = r.tasks.map((id) => items.find((x) => x.id === id));
  assert.deepEqual([measure.plan, measure.milestone, measure.after, measure.work.brief, measure.note], [r.plan, 'images-small', undefined, 'Measure the load time of the home page.', 'Done when: A table of times.']);
  assert.deepEqual(shrink.after, ['measure-the-page']);
  assert.equal(shrink.by, 'developer');
  assert.deepEqual([approve.project, approve.by, approve.milestone, approve.work], ['blog', 'me', 'live', undefined]);
  assert.equal(measure.source, `plans/${r.plan}.md`, 'made from the note: dropped, never removed');
  assert.equal(readProposal(PID), null, 'the proposal is gone once accepted');
  // A second Accept of the same words makes a plan of its own name; nothing of the first is touched.
  const r2 = await S.acceptProposal(place(), proposal(), ctx());
  assert.equal(r2.plan, `${r.plan}-2`, 'made at the same moment: a name of its own all the same');
  assert.deepEqual(r2.tasks[0], 'measure-the-page-2');
});

test('Accept pressed twice at once (two tabs) writes one plan; the second is told it is gone', async () => {
  reset();
  record();
  const [a, b] = await Promise.allSettled([S.acceptProposal(place(), proposal(), ctx(), { pid: PID }), S.acceptProposal(place(), proposal(), ctx(), { pid: PID })]);
  assert.deepEqual([a.status, b.status].sort(), ['fulfilled', 'rejected']);
  const no = [a, b].find((x) => x.status === 'rejected').reason;
  assert.equal(no.status, 409);
  assert.match(no.message, /accepted or dismissed already/);
  assert.deepEqual(listPlans(place()).plans.map((p) => p.id), [[a, b].find((x) => x.status === 'fulfilled').value.plan]);
  assert.equal(readDoc(place().file).doc.items.filter((x) => x.plan).length, 3, 'its three tasks once');
});

test('Accept refuses a proposal it cannot write whole, and writes nothing then', async () => {
  reset();
  const before = tree();
  await assert.rejects(S.acceptProposal(place(), { ...proposal(), projects: ['shop', 'gone'] }, ctx()), /not a project/);
  await assert.rejects(S.acceptProposal(place(), { ...proposal(), tasks: [{ ...proposal().tasks[0], after: [0] }] }, ctx()), /waits for itself/);
  assert.deepEqual(tree(), before);
});

const STEPS = ['accept-planned', 'accept-journal', 'accept-note', 'accept-plan', 'accept-list', 'accept-proposal'];
test('a kill at each step of Accept leaves nothing, or everything once the next look finishes it', async () => {
  reset();
  const original = tree();
  // What a whole Accept writes (the time and ids fixed, so every run writes the same).
  record();
  await S.acceptProposal(place(), proposal(), ctx(), { pid: PID });
  const full = tree();
  assert.notDeepEqual(full, original);
  const child = `
    const { resolvePlace, projectNames } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/work/place.mjs')).href)});
    const S = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/work/planstore.mjs')).href)});
    const cfg = ${JSON.stringify(cfg)};
    const ctx = { today: '2026-11-18', ownerId: 'alex', projects: projectNames(), now: () => new Date(${JSON.stringify(NOW)}) };
    await S.acceptProposal(resolvePlace(cfg), ${JSON.stringify(proposal())}, ctx, { pid: ${JSON.stringify(PID)} });
    process.exit(0);`;
  for (const step of STEPS) {
    reset();
    record();
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOPRIG_TEST_WORK_STOP_AFTER: step }, encoding: 'utf8' });
    assert.equal(endSignal(r), 'SIGKILL', `${step}: the child was killed there (${r.stderr})`);
    const fin = await finishInterrupted(place());
    const now = tree();
    if (step === 'accept-planned') {
      assert.deepEqual(now, original, `${step}: nothing`);
      assert.deepEqual(fin, {});
      assert.ok(readProposal(PID), `${step}: the proposal still waits`);
    } else {
      assert.deepEqual(now, full, `${step}: everything`);
      assert.match(fin.sentence, /written in full now/);
      assert.equal(readProposal(PID), null, `${step}: the proposal is gone`);
    }
    assert.deepEqual(await finishInterrupted(place()), {}, `${step}: a second look finds nothing to finish`);
  }
});

test('a file changed after a kill is never written over: the owner is told, until he drops the record', async () => {
  reset();
  record();
  const child = `
    const { resolvePlace, projectNames } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/work/place.mjs')).href)});
    const S = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/work/planstore.mjs')).href)});
    await S.acceptProposal(resolvePlace(${JSON.stringify(cfg)}), ${JSON.stringify(proposal())}, { today: '2026-11-18', ownerId: 'alex', projects: projectNames() }, {});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOPRIG_TEST_WORK_STOP_AFTER: 'accept-note' }, encoding: 'utf8' });
  assert.equal(endSignal(r), 'SIGKILL');
  fs.appendFileSync(place().file, ' ');
  const mine = fs.readFileSync(place().file, 'utf8');
  const fin = await finishInterrupted(place());
  assert.equal(fin.code, 'interrupted');
  assert.match(fin.problem, /tasks\.json changed since: nothing was changed/);
  assert.equal(fs.readFileSync(place().file, 'utf8'), mine);
  assert.equal(listPlans(place()).plans.length, 0, 'the plan file was not written either');
  const { dropInterrupted } = await import('../../src/work/resume.mjs');
  assert.equal(await dropInterrupted(place()), true);
  assert.deepEqual(await finishInterrupted(place()), {});
});

test('while an interrupted Accept waits on the owner, no other change of plans is made: its record is never lost', async () => {
  reset();
  record();
  const hand = await S.createPlan(place(), { title: 'Grow the blog', goal: 'Twice the visits.', projects: ['blog'] }, ctx());
  const child = `
    const { resolvePlace, projectNames } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/work/place.mjs')).href)});
    const S = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src/work/planstore.mjs')).href)});
    await S.acceptProposal(resolvePlace(${JSON.stringify(cfg)}), ${JSON.stringify(proposal())}, { today: '2026-11-18', ownerId: 'alex', projects: projectNames() }, { pid: ${JSON.stringify(PID)} });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child], { env: { ...process.env, HOPRIG_TEST_WORK_STOP_AFTER: 'accept-plan' }, encoding: 'utf8' });
  assert.equal(endSignal(r), 'SIGKILL', r.stderr);
  fs.appendFileSync(place().file, ' '); // a hand edit after the kill: the Accept cannot be finished by itself
  assert.equal((await finishInterrupted(place())).code, 'interrupted');
  const before = tree();
  const other = { ...proposal(), title: 'Write the blog', tasks: [{ ...proposal().tasks[0], title: 'Pick the topics', after: [] }] };
  const interrupted = (e) => e.status === 409 && e.details.code === 'interrupted' && /was being written when Hoprig stopped/.test(e.message);
  await assert.rejects(S.acceptProposal(place(), proposal(), ctx(), { pid: PID }), interrupted, 'Accept again on the same proposal');
  await assert.rejects(S.acceptProposal(place(), other, ctx()), interrupted, 'another proposal');
  await assert.rejects(S.createPlan(place(), { title: 'Another plan', goal: 'One more.' }, ctx()), interrupted, 'a plan by hand');
  await assert.rejects(S.editPlan(place(), hand.id, { title: 'Grow the blog more' }, ctx()), interrupted, 'a change of a plan');
  await assert.rejects(S.setTaskPlan(place(), 'old-task', { plan: hand.id }, ctx()), interrupted, 'a task into a plan');
  assert.deepEqual(tree(), before, 'nothing written');
  const still = await finishInterrupted(place());
  assert.equal(still.code, 'interrupted', 'the record is still there and still says so');
  assert.ok(readProposal(PID), 'the proposal still waits');
  // Once he dropped the record (after he looked), plans change again.
  const { dropInterrupted } = await import('../../src/work/resume.mjs');
  assert.equal(await dropInterrupted(place()), true);
  assert.ok(await S.createPlan(place(), { title: 'Another plan', goal: 'One more.' }, ctx()));
});

test('a new plan never takes the id of a plan whose files are gone while its tasks still name it', async () => {
  reset();
  const a = await S.acceptProposal(place(), proposal(), ctx());
  for (const ext of ['json', 'md']) fs.rmSync(path.join(place().folder, 'plans', `${a.plan}.${ext}`));
  const p = await S.createPlan(place(), { title: 'Make the shop site faster', goal: 'Again, by hand.' }, ctx());
  assert.notEqual(p.id, a.plan);
  assert.equal(readDoc(place().file).doc.items.filter((x) => x.plan === p.id).length, 0, 'the old tasks are not the new plan\'s');
});

test('plans made and changed by hand; a milestone with tasks is not taken out; tasks put in and taken out', async () => {
  reset();
  const p = await S.createPlan(place(), { title: 'Grow the blog', goal: 'Twice the visits by spring.', projects: ['blog'], milestones: [{ title: 'Ten posts', date: '2027-01-15' }] }, ctx());
  assert.match(p.id, /^grow-the-blog-[0-9a-f]{6}$/);
  assert.equal(p.made.how, 'hand');
  await S.setTaskPlan(place(), 'old-task', { plan: p.id, milestone: 'ten-posts' }, ctx());
  await assert.rejects(S.editPlan(place(), p.id, { milestones: [] }, ctx()), /still has a task \("An old task"\): move it first/);
  await assert.rejects(S.editPlan(place(), p.id, { status: 'paused' }, ctx()), /status is one of/);
  // A refusal names the title it is about.
  await assert.rejects(S.editPlan(place(), p.id, { milestones: [{ id: 'ten-posts', title: 'Ten posts', date: null }, { title: '', date: '2027-02-01' }] }, ctx()), /^Error: the title of milestone 2 is 3 to 200 characters$/);
  await assert.rejects(S.createPlan(place(), { title: 'No', goal: 'Short.' }, ctx()), /^Error: the title is 3 to 200 characters$/);
  await assert.rejects(S.editPlan(place(), p.id, { title: 'Grown' }, ctx(), { seen: '0000000000000000' }), /changed since it was shown/);
  const e = await S.editPlan(place(), p.id, { title: 'Grow the blog a lot', milestones: [{ id: 'ten-posts', title: 'Ten posts', date: '2027-01-20' }, { title: 'Newsletter', date: null }], status: 'done' }, ctx(), { seen: S.planHash(p) });
  assert.deepEqual(e.milestones.map((m) => m.id), ['ten-posts', 'newsletter']);
  assert.equal(readPlan(place(), p.id).status, 'done');
  await S.setTaskPlan(place(), 'old-task', { plan: null }, ctx());
  assert.equal(readDoc(place().file).doc.items[0].plan, undefined);
  await assert.rejects(S.setTaskPlan(place(), 'old-task', { plan: 'no-such-plan' }, ctx()), /no plan/);
});

test('Stop waiting: a task stops waiting for others, in its plan or in none, and stays where it is', async () => {
  reset();
  const a = await S.acceptProposal(place(), proposal(), ctx());
  const [, shrink] = a.tasks;
  const item = () => readDoc(place().file).doc.items.find((x) => x.id === shrink);
  // In its plan: the plan and the milestone stay, the wait goes.
  await S.setTaskPlan(place(), shrink, { plan: a.plan, milestone: 'images-small', after: [] }, ctx());
  assert.deepEqual([item().plan, item().milestone, item().after], [a.plan, 'images-small', undefined]);
  // Taken out of its plan, a task keeps what it waits for; in no plan it can stop waiting all the same.
  await S.setTaskPlan(place(), shrink, { plan: a.plan, after: [a.tasks[0]] }, ctx());
  await S.setTaskPlan(place(), shrink, { plan: null }, ctx());
  assert.deepEqual([item().plan, item().after], [undefined, [a.tasks[0]]]);
  await S.setTaskPlan(place(), shrink, { plan: null, after: [] }, ctx());
  assert.deepEqual([item().plan, item().after], [undefined, undefined]);
  await assert.rejects(S.setTaskPlan(place(), shrink, { plan: null }, ctx()), /in no plan/);
});

test('Stop waiting changes only the wait: a task whose plan file or milestone is gone can stop waiting and keeps both', async () => {
  reset();
  const a = await S.acceptProposal(place(), proposal(), ctx());
  const [, shrink, approve] = a.tasks;
  const item = (id) => readDoc(place().file).doc.items.find((x) => x.id === id);
  // The plan's milestone "Live" taken out by hand (or by another computer's change a save brought).
  const json = path.join(place().folder, 'plans', `${a.plan}.json`);
  const p = JSON.parse(fs.readFileSync(json, 'utf8'));
  fs.writeFileSync(json, `${JSON.stringify({ ...p, milestones: p.milestones.filter((m) => m.id !== 'live') }, null, 2)}\n`);
  await S.setTaskPlan(place(), approve, { after: [] }, ctx());
  assert.deepEqual([item(approve).plan, item(approve).milestone, item(approve).after], [a.plan, 'live', undefined]);
  // The plan file itself gone.
  fs.rmSync(json);
  await S.setTaskPlan(place(), shrink, { after: [] }, ctx());
  assert.deepEqual([item(shrink).plan, item(shrink).milestone, item(shrink).after], [a.plan, 'images-small', undefined]);
  // What it waits for is still checked; and only a plan named moves it.
  await assert.rejects(S.setTaskPlan(place(), shrink, { after: [shrink] }, ctx()), /does not wait for itself/);
  await assert.rejects(S.setTaskPlan(place(), shrink, {}, ctx()), /say what the task waits for/);
});
