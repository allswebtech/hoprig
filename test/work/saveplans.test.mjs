// Plans and Save (save.mjs, saveplan.mjs): a plan and its note are Work's files for a save exactly as run files are
// (committed by name, brought to another computer file by file); a planning tool's own files in the plans folder are
// never committed; a plan changed on two computers is the owner's question, this computer's or the other's; a save with
// such a question killed after each of its steps loses nothing.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork, write } from './helpers.mjs';

const t = tempWork('work-saveplans');
test.after(() => t.cleanup());
const { saveWork, savePlan, STOP_ENV } = await import('../../src/work/save.mjs');
const P = await import('../../src/work/plans.mjs');
const { acceptProposal, editPlan } = await import('../../src/work/planstore.mjs');
const SAVE = new URL('../../src/work/save.mjs', import.meta.url).href;

const SUBJECT = 'Update work items';
const settings = { timeZone: '', ownerId: 'me', saveSubject: SUBJECT };
const listText = (items) => `${JSON.stringify({ items }, null, 2)}\n`;
const ctx = { today: '2026-11-18', ownerId: 'me', projects: ['shop'], now: () => new Date('2026-11-18T10:00:00.000Z') };
const proposal = (title = 'Make the site faster') => ({
  title, goal: 'The home page loads in two seconds.', projects: ['shop'], note: '## Research\n- Big images.',
  milestones: [{ title: 'Images small', date: '2026-12-02' }],
  tasks: [
    { title: 'Measure the page', date: '2026-11-24', milestone: 0, by: 'ai', after: [], brief: 'Measure it.', check: null, project: null },
    { title: 'Shrink the images', date: null, milestone: 0, by: 'ai', after: [0], brief: 'Shrink them.', check: null, project: null },
  ],
});
let n = 0;
/** A server and this computer, Work in brain/work; `other`: another computer's clone of the same server. */
function setup() {
  const here = path.join(t.root, `c${++n}`);
  const bare = t.repo(here, { 'README.md': '# brain\n', 'work/tasks.json': listText([]), 'work/plans/roadmap.md': '# The planning tool\'s own note\n' });
  const place = { file: path.join(here, 'work', 'tasks.json'), folder: path.join(here, 'work'), base: here, label: 'brain/work', fileName: 'tasks.json', kind: 'project', settings };
  const otherPlace = (dir) => ({ ...place, file: path.join(dir, 'work', 'tasks.json'), folder: path.join(dir, 'work'), base: dir });
  return { here, bare, place, otherPlace };
}
const committed = (dir, rev = 'HEAD') => t.git(dir, 'show', '--name-only', '--format=', rev).split('\n').filter(Boolean).sort();

test('an accepted plan is saved with only Work\'s files, and another computer gets it file by file', async () => {
  const c = setup();
  const a = await acceptProposal(c.place, proposal(), ctx);
  // The planning tool changes its own note and adds a file of a plan's name: neither is Work's.
  write(c.here, { 'work/plans/roadmap.md': '# Changed by the planning tool\n', 'work/plans/phases.json': '{"phases":[]}\n' });
  const plan = await savePlan(c.place);
  assert.deepEqual(plan.files.map((f) => f.path).sort(), [`work/plans/${a.plan}.json`, `work/plans/${a.plan}.md`, 'work/tasks.json']);
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /and 2 plan files and uploaded it to your git server/);
  assert.deepEqual(committed(c.here), [`work/plans/${a.plan}.json`, `work/plans/${a.plan}.md`, 'work/tasks.json']);
  assert.match(t.git(c.here, 'status', '--porcelain'), /work\/plans\/roadmap\.md/, 'the planning tool\'s note is left as it was, not committed');
  // Another computer: its Save brings the plan, its note and the tasks in by fast-forward, each file whole.
  const other = t.otherClone(c.bare);
  const op = c.otherPlace(other);
  assert.equal(P.readPlan(op, a.plan).title, 'Make the site faster');
  assert.equal(P.readNote(op, P.readPlan(op, a.plan)), '## Research\n- Big images.');
  const items = JSON.parse(fs.readFileSync(op.file, 'utf8')).items;
  assert.deepEqual(items.map((x) => [x.id, x.plan, x.after || []]), [['measure-the-page', a.plan, []], ['shrink-the-images', a.plan, ['measure-the-page']]]);
});

test('a plan file changed by hand so that it no longer reads is named and left alone', async () => {
  const c = setup();
  const a = await acceptProposal(c.place, proposal(), ctx);
  assert.equal((await saveWork(c.place, { subject: SUBJECT })).ok, true);
  const f = path.join(c.place.folder, 'plans', `${a.plan}.json`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"active"', '"paused"'));
  const plan = await savePlan(c.place);
  assert.deepEqual(plan.notPlans, [`work/plans/${a.plan}.json`]);
  assert.ok(plan.nothing);
});

test('a commit not sent yet that holds a planning tool\'s file of a plan\'s name is the owner\'s: Save does not send it', async () => {
  const c = setup();
  write(c.here, { 'work/plans/phases.json': '{"phases":[1]}\n' });
  t.git(c.here, 'add', 'work/plans/phases.json');
  t.git(c.here, 'commit', '-q', '-m', 'The planning tool\'s phases');
  await acceptProposal(c.place, proposal(), ctx);
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'held');
  assert.match(r.message, /The planning tool's phases/);
});

/** Both computers change the plan's title after it was saved once. → { c, other, planId }. */
async function bothChanged() {
  const c = setup();
  const a = await acceptProposal(c.place, proposal(), ctx);
  assert.equal((await saveWork(c.place, { subject: SUBJECT })).ok, true);
  const other = t.otherClone(c.bare);
  await editPlan(c.otherPlace(other), a.plan, { title: 'Faster, as the other computer says' }, ctx);
  t.git(other, 'commit', '-q', '-am', 'From the other computer');
  t.git(other, 'push', '-q');
  await editPlan(c.place, a.plan, { title: 'Faster, as this computer says' }, ctx);
  return { c, other, planId: a.plan };
}

test('a plan changed on both computers: the owner chooses this computer\'s or the other\'s, and nothing goes before he does', async () => {
  for (const choice of ['theirs', 'mine']) {
    const { c, planId } = await bothChanged();
    const plan = await savePlan(c.place, { fetch: true });
    assert.equal(plan.remote.mode, 'merge');
    const key = `file:work/plans/${planId}.json`;
    assert.deepEqual(plan.remote.conflicts.map((x) => [x.key, x.mine.title, x.theirs.title]), [[key, 'Faster, as this computer says', 'Faster, as the other computer says']]);
    const head = t.git(c.here, 'rev-parse', 'HEAD');
    const r0 = await saveWork(c.place, { subject: SUBJECT });
    assert.equal(r0.code, 'decide');
    assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), head, 'nothing moved before the choice');
    const r = await saveWork(c.place, { subject: SUBJECT, decisions: { [key]: choice } });
    assert.equal(r.ok, true, r.message);
    const want = choice === 'mine' ? 'Faster, as this computer says' : 'Faster, as the other computer says';
    assert.equal(P.readPlan(c.place, planId).title, want);
    assert.equal(t.git(c.here, 'status', '--porcelain', '--', `work/plans/${planId}.json`), '');
    const server = t.otherClone(c.bare);
    assert.equal(P.readPlan(c.otherPlace(server), planId).title, want, `the server has the version chosen (${choice})`);
  }
});

test('the same plan title accepted on two computers is two plans: each keeps its own goal, milestones, note and tasks', async () => {
  const c = setup();
  const other = t.otherClone(c.bare);
  const op = c.otherPlace(other);
  const theirs = { ...proposal(), note: '## Research on the other computer\n- The CDN is slow.', milestones: [{ title: 'CDN moved', date: '2026-12-09' }], tasks: proposal().tasks.map((x, i) => ({ ...x, title: `${x.title} there`, milestone: 0, after: i ? [0] : [] })) };
  const a1 = await acceptProposal(op, theirs, { ...ctx, now: () => new Date('2026-11-18T09:00:00.000Z') });
  assert.equal((await saveWork(op, { subject: SUBJECT })).ok, true);
  const a2 = await acceptProposal(c.place, proposal(), ctx);
  assert.notEqual(a1.plan, a2.plan, 'two plans, two ids');
  const plan = await savePlan(c.place, { fetch: true });
  assert.deepEqual((plan.remote.conflicts || []).filter((x) => x.key.startsWith('file:')), [], 'no question about a plan: each is its own');
  const r = await saveWork(c.place, { subject: SUBJECT, decisions: Object.fromEntries((plan.remote.conflicts || []).map((x) => [x.key, 'mine'])) });
  assert.equal(r.ok, true, r.message);
  const mine = P.readPlan(c.place, a2.plan);
  const kept = P.readPlan(c.place, a1.plan);
  assert.deepEqual([mine.milestones.map((m) => m.title), P.readNote(c.place, mine)], [['Images small'], '## Research\n- Big images.']);
  assert.deepEqual([kept.milestones.map((m) => m.title), P.readNote(c.place, kept)], [['CDN moved'], '## Research on the other computer\n- The CDN is slow.']);
  const items = JSON.parse(fs.readFileSync(c.place.file, 'utf8')).items;
  assert.equal(items.filter((x) => x.plan === a2.plan).length, 2);
  assert.equal(items.filter((x) => x.plan === a1.plan).length, 2);
  for (const x of items) assert.ok((x.plan === a2.plan ? mine : kept).milestones.some((m) => m.id === x.milestone), `${x.id}: in a milestone of its own plan`);
});

test('a plan whose file and note both changed on two computers is one question: the plan and its note go together', async () => {
  const c = setup();
  const a = await acceptProposal(c.place, proposal(), ctx);
  assert.equal((await saveWork(c.place, { subject: SUBJECT })).ok, true);
  const other = t.otherClone(c.bare);
  const note = (dir) => path.join(dir, 'work', 'plans', `${a.plan}.md`);
  await editPlan(c.otherPlace(other), a.plan, { title: 'Faster, as the other computer says' }, ctx);
  fs.appendFileSync(note(other), '- The other computer\'s finding.\n');
  t.git(other, 'commit', '-q', '-am', 'From the other computer');
  t.git(other, 'push', '-q');
  await editPlan(c.place, a.plan, { title: 'Faster, as this computer says' }, ctx);
  fs.appendFileSync(note(c.here), '- This computer\'s finding.\n');
  const plan = await savePlan(c.place, { fetch: true });
  const key = `file:work/plans/${a.plan}.json`;
  assert.deepEqual(plan.remote.conflicts.map((x) => x.key), [key], 'one question for the plan and its note');
  assert.match(plan.remote.conflicts[0].title, /and its note/);
  const r = await saveWork(c.place, { subject: SUBJECT, decisions: { [key]: 'mine' } });
  assert.equal(r.ok, true, r.message);
  assert.equal(P.readPlan(c.place, a.plan).title, 'Faster, as this computer says');
  assert.match(fs.readFileSync(note(c.here), 'utf8'), /This computer's finding/);
  assert.doesNotMatch(fs.readFileSync(note(c.here), 'utf8'), /other computer's finding/, 'the note of the same side');
});

const STEPS = ['journal', 'kept', 'putback', 'ff', 'write', 'commit', 'push'];
for (const step of STEPS) {
  test(`a save with a plan changed on both computers, killed after "${step}": the next look and Save lose nothing`, async () => {
    const { c, planId } = await bothChanged();
    const key = `file:work/plans/${planId}.json`;
    const code = `import { saveWork } from ${JSON.stringify(SAVE)};
      await saveWork(${JSON.stringify(c.place)}, { subject: ${JSON.stringify(SUBJECT)}, decisions: ${JSON.stringify({ [key]: 'mine' })} });`;
    const k = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, [STOP_ENV]: step }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(k.signal, 'SIGKILL', `${step}: ${k.stderr}`);
    const look = await savePlan(c.place);
    assert.match(look.recovered || '', /^A save of the Work list was interrupted/, `${step}: ${JSON.stringify(look.problem || look.recovered)}`);
    // Before the server's commits came in, his own title is back; after, the one he chose (his own as well).
    assert.equal(P.readPlan(c.place, planId).title, 'Faster, as this computer says', step);
    const r = await saveWork(c.place, { subject: SUBJECT, decisions: { [key]: 'mine' } });
    assert.equal(r.ok, true, `${step}: ${r.message}`);
    const server = t.otherClone(c.bare);
    assert.equal(P.readPlan(c.otherPlace(server), planId).title, 'Faster, as this computer says', step);
    assert.equal(t.git(c.here, 'status', '--porcelain', '--', 'work'), '', `${step}: nothing of Work left changed`);
  });
}
