// A save killed after each of its steps in turn (the process ends there, as in a crash or a power cut), then Save
// again: every time the owner's done task and his new task are in the result, on this computer and on the server,
// and the next look at the list said what happened to the save that was interrupted. Two computers are two clones of
// one local bare repository; the save runs in a child process that ends itself after the named step
// (HOPRIG_TEST_WORK_STOP_AFTER, save.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork, write } from './helpers.mjs';

const t = tempWork('work-interrupt');
test.after(() => t.cleanup());
const { saveWork, savePlan, STOP_ENV } = await import('../../src/work/save.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const SAVE = new URL('../../src/work/save.mjs', import.meta.url).href;

const SUBJECT = 'Update work items';
const settings = { timeZone: '', ownerId: 'me', saveSubject: SUBJECT };
const item = (id, extra = {}) => ({ id, date: null, approx: false, title: `Task ${id}`, kind: 'task', by: 'me', status: 'open', source: 'me', ...extra });
const listText = (items) => `${JSON.stringify({ items }, null, 2)}\n`;
const ids = (text) => JSON.parse(text).items.map((x) => `${x.id}:${x.status}`);
let n = 0;

/** A server and two computers; this one marks "a" done and adds a task; the other changes what `other` says. */
async function setup(other) {
  const here = path.join(t.root, `c${++n}`);
  const bare = t.repo(here, { 'README.md': '# brain\n', 'work/tasks.json': listText([item('a'), item('b'), item('c')]) });
  const place = { file: path.join(here, 'work', 'tasks.json'), folder: path.join(here, 'work'), base: here, label: 'brain/work', fileName: 'tasks.json', kind: 'project', settings };
  const elsewhere = t.otherClone(bare);
  if (other === 'list') {
    const f = path.join(elsewhere, 'work', 'tasks.json');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    doc.items.push(item('from-b'));
    doc.items[2].title = 'C renamed on the other computer';
    fs.writeFileSync(f, listText(doc.items));
  } else if (other === 'readme') write(elsewhere, { 'README.md': '# brain, from the other computer\n' });
  if (other) {
    t.git(elsewhere, 'commit', '-q', '-am', 'From the other computer');
    t.git(elsewhere, 'push', '-q');
  }
  const store = workStore(place);
  await store.status('a', 'done');
  await store.add({ title: 'New here' });
  return { here, bare, place };
}

/** The save in a child process that ends itself right after `step`. → its exit signal. */
function killedSave(place, step) {
  const code = `import { saveWork } from ${JSON.stringify(SAVE)};
    const r = await saveWork(${JSON.stringify(place)}, { subject: ${JSON.stringify(SUBJECT)} });
    process.stdout.write(JSON.stringify(r.message));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, [STOP_ENV]: step }, encoding: 'utf8', timeout: 60_000 });
  return { signal: r.signal, out: r.stdout, err: r.stderr };
}

const CASES = [
  // The server changed the list too: a merge.
  ...['journal', 'kept', 'putback', 'ff', 'write', 'commit', 'push', 'takeback'].map((step) => ({ other: 'list', step })),
  // The server changed another file: its commits come in first.
  ...['journal', 'ff', 'commit', 'push', 'takeback'].map((step) => ({ other: 'readme', step })),
  // The server has nothing new.
  ...['journal', 'commit', 'push', 'takeback'].map((step) => ({ other: null, step })),
];

for (const { other, step } of CASES) {
  const kind = other === 'list' ? 'a merge' : other ? 'the server\'s commits first' : 'a plain save';
  test(`${kind}, killed after "${step}": the next Save has his done task and his new task, here and on the server`, async (ctx) => {
    const c = await setup(other);
    // The send fails for "takeback" (the server refuses it), so the commit is taken back before the process ends.
    const pre = path.join(c.bare, 'hooks', 'pre-receive');
    if (step === 'takeback') fs.writeFileSync(pre, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const k = killedSave(c.place, step);
    assert.equal(k.signal, 'SIGKILL', `the save ended after ${step}: ${k.out} ${k.err}`);
    fs.rmSync(pre, { force: true });
    const plan = await savePlan(c.place);
    assert.match(plan.recovered || '', /^A save of the Work list was interrupted/, `the look after the kill says so (${step})`);
    const r = await saveWork(c.place, { subject: SUBJECT });
    assert.equal(r.ok, true, r.message);
    const want = ['a:done', 'b:open', 'c:open', ...(other === 'list' ? ['from-b:open'] : []), 'new-here:open'];
    assert.deepEqual(ids(fs.readFileSync(c.place.file, 'utf8')), want, 'this computer');
    assert.deepEqual(ids(t.git(c.bare, 'show', 'main:work/tasks.json')), want, 'the server');
    if (other === 'list') assert.match(t.git(c.bare, 'show', 'main:work/tasks.json'), /C renamed on the other computer/);
    assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), t.git(c.bare, 'rev-parse', 'main'));
    assert.equal(t.git(c.here, 'status', '--porcelain'), '', 'nothing left over in the repository');
    assert.equal(fs.readdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'work-journal')).length, 0, 'the journal is gone');
    ctx.diagnostic(`${kind} / ${step}: ${plan.recovered} → ${r.message}`);
  });
}

test('a repository changed by hand after the kill: nothing is touched, the owner is told where the list is, Drop ends it', async () => {
  const c = await setup('list');
  const k = killedSave(c.place, 'ff');
  assert.equal(k.signal, 'SIGKILL');
  // He changes the file himself before anything looks: the save cannot tell his change from its own.
  fs.writeFileSync(c.place.file, listText([item('his-own-edit')]));
  const head = t.git(c.here, 'rev-parse', 'HEAD');
  const plan = await savePlan(c.place);
  assert.equal(plan.code, 'interrupted');
  assert.match(plan.problem, /^a save of the Work list was interrupted, and the repository is not where that save left it \(the Work file holds a version that save did not write\): nothing was changed\. The list that save was writing is kept in Hoprig's state folder, work-journal\/[0-9a-f]{24}\.json \(its "merged" value\), and your own list as it was before it in c\d+ \(git show refs\/hoprig\/work-save\/[0-9a-f]{12} prints it\); c\d+ is on main at [0-9a-f]{12}\. Put the repository right, then drop the record/);
  const ref = /refs\/hoprig\/work-save\/[0-9a-f]{12}/.exec(plan.problem)[0];
  assert.deepEqual(ids(t.git(c.here, 'show', ref)), ['a:done', 'b:open', 'c:open', 'new-here:open'], 'his own list, kept in the repository');
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), head);
  assert.deepEqual(ids(fs.readFileSync(c.place.file, 'utf8')), ['his-own-edit:open']);
  const kept = JSON.parse(fs.readFileSync(path.join(process.env.HOPRIG_STATE_DIR, /work-journal\/[0-9a-f]{24}\.json/.exec(plan.problem)[0]), 'utf8'));
  assert.deepEqual(ids(kept.merged), ['a:done', 'b:open', 'c:open', 'from-b:open', 'new-here:open'], 'his done and new task are in the kept list');
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.code, 'interrupted', 'a save waits for him');
  const { dropInterrupted } = await import('../../src/work/save.mjs');
  assert.equal(await dropInterrupted(c.place), true);
  assert.equal(t.git(c.here, 'for-each-ref', 'refs/hoprig'), '', 'the drop takes the kept list away too');
  const after = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(after.sent, true, after.message);
});

// What the recovery must never do to commits that are not its own to move. Each fails when the check it names is gone.

test('a save killed after it was sent: the recovery never takes back a commit the server has', async () => {
  const c = await setup(null);
  assert.equal(killedSave(c.place, 'push').signal, 'SIGKILL');
  const sent = t.git(c.bare, 'rev-parse', 'main');
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), sent, 'the send went through before the kill');
  const plan = await savePlan(c.place);
  assert.equal(plan.recovered, 'A save of the Work list was interrupted after it was sent: it is on the server, nothing more to do.');
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), sent, 'the branch stays on the commit the server has');
  assert.doesNotMatch(t.git(c.here, 'reflog', '-3', '--format=%gs'), /taken back/);
  assert.equal(t.git(c.here, 'status', '--porcelain'), '');
});

test('a save killed after its commit, then a commit of his on top (even one that changes nothing): the recovery leaves both alone', async () => {
  const c = await setup(null);
  assert.equal(killedSave(c.place, 'commit').signal, 'SIGKILL');
  t.git(c.here, 'commit', '-q', '--allow-empty', '-m', 'A note of his');
  const his = t.git(c.here, 'rev-parse', 'HEAD');
  const plan = await savePlan(c.place);
  assert.equal(plan.code, 'interrupted');
  assert.match(plan.problem, /\(its branch has commits that save did not make\)/);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), his, 'his commit is still on the branch');
  assert.equal(t.git(c.here, 'log', '-1', '--format=%s', 'HEAD^'), SUBJECT, 'and the save\'s under it');
});

test('a save killed after its commit, then a hand edit of the Work file: the recovery sees it and takes nothing back', async () => {
  const c = await setup(null);
  assert.equal(killedSave(c.place, 'commit').signal, 'SIGKILL');
  const made = t.git(c.here, 'rev-parse', 'HEAD');
  fs.appendFileSync(c.place.file, '\n');
  const plan = await savePlan(c.place);
  assert.equal(plan.code, 'interrupted');
  assert.match(plan.problem, /\(the Work file changed after that save's commit\)/);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), made, 'the save\'s commit stays where it is');
  assert.equal(t.git(c.here, 'status', '--porcelain'), 'M work/tasks.json', 'his edit, not committed');
});
