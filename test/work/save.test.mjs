// Save on real, temporary git repositories with a local bare "server": only the Work file is committed (other
// changes, staged or not, stay as they were); the plan names the item changes first; a save reaches the server or its
// commit is taken back; the owner's own commits are never sent along; a folder outside git is said plainly. Two
// computers that both changed the list: savemerge.test.mjs; a save killed half way: interrupt.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE, tempWork, write } from './helpers.mjs';

const t = tempWork('work-save');
test.after(() => t.cleanup());
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { savePlan, saveWork } = await import('../../src/work/save.mjs');

const SUBJECT = 'Update work items';
const fixtureText = fs.readFileSync(FIXTURE, 'utf8');
const shop = path.join(t.projects, 'shop');
const bare = t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/deadlines.json': fixtureText, 'docs/plans/numbers.json': '{"metrics":[]}\n', 'src/app.js': 'one\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
const place = () => resolvePlace(cfg);
const store = () => workStore(place(), { projects: projectNames() });
const head = (dir, ref = 'HEAD') => t.git(dir, 'rev-parse', ref);
const subjects = (dir, range) => t.git(dir, 'log', '--format=%s', range).split('\n').filter(Boolean);

test('save commits only the Work file and sends it; other changes, staged or not, stay as they were', async () => {
  await store().status('call-a003', 'done');
  await store().add({ title: 'Renew the domain', date: '2026-12-01' });
  write(shop, { 'src/app.js': 'two\n', 'docs/plans/numbers.json': '{"metrics":[1]}\n', 'notes.txt': 'untracked\n', 'staged.txt': 'staged\n' });
  t.git(shop, 'add', 'staged.txt');

  const plan = await savePlan(place());
  assert.equal(plan.nothing, false);
  assert.deepEqual(plan.files, [{ path: 'docs/plans/deadlines.json', state: 'changed' }]);
  assert.deepEqual(plan.changes.map((c) => [c.id, c.what]).sort(), [['call-a003', 'done'], ['renew-the-domain', 'added']]);
  assert.equal(plan.repo.upstream, 'origin/main');

  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.sent, true);
  assert.match(r.message, /Kept a copy of your list \(2 changes\) and uploaded it to your git server/);
  assert.deepEqual(t.git(shop, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean), [SUBJECT, 'docs/plans/deadlines.json']);
  assert.equal(head(shop), t.git(bare, 'rev-parse', 'main'), 'the server has it');
  // The rest is exactly as it was: changed, untracked and staged.
  const lines = (...args) => t.git(shop, ...args).split('\n').filter(Boolean).sort();
  assert.deepEqual(lines('diff', '--name-only'), ['docs/plans/numbers.json', 'src/app.js'], 'changed, not staged');
  assert.deepEqual(lines('diff', '--cached', '--name-only'), ['staged.txt'], 'staged, still staged');
  assert.deepEqual(lines('ls-files', '--others', '--exclude-standard'), ['notes.txt']);
  assert.equal(fs.readFileSync(path.join(shop, 'src/app.js'), 'utf8'), 'two\n');

  const again = await saveWork(place(), { subject: SUBJECT });
  assert.equal(again.ok, true);
  assert.match(again.message, /^Nothing to keep/);
  t.git(shop, 'reset', '-q', '--', 'staged.txt');
  t.git(shop, 'checkout', '-q', '--', 'src/app.js', 'docs/plans/numbers.json');
  fs.rmSync(path.join(shop, 'notes.txt'));
  fs.rmSync(path.join(shop, 'staged.txt'));
});

test('the server moved elsewhere: its commits come in by fast-forward first, then the save is sent', async () => {
  const other = t.otherClone(bare);
  write(other, { 'README.md': '# shop, from another computer\n' });
  t.git(other, 'commit', '-q', '-am', 'Change the readme elsewhere');
  t.git(other, 'push', '-q');
  await store().edit('npm-pub', { priority: 'high' });
  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.sent, true);
  assert.match(r.message, /and uploaded it to your git server\. Brought in 1 new commit from the server first\./);
  assert.deepEqual(subjects(shop, '-2'), [SUBJECT, 'Change the readme elsewhere']);
  assert.equal(head(shop), t.git(bare, 'rev-parse', 'main'));
});

test('commits of the owner\'s own not on the server: nothing is committed, the save says so, the change stays in the file', async () => {
  // His own commit with the save's very subject, of another file: never sent, named by its short id; the subject plays
  // no part.
  write(shop, { 'private.txt': 'not for the server\n' });
  t.git(shop, 'add', 'private.txt');
  t.git(shop, 'commit', '-q', '-m', SUBJECT);
  const own = t.git(shop, 'rev-parse', '--short', 'HEAD');
  const serverHead = t.git(bare, 'rev-parse', 'main');
  await store().add({ title: 'Book the venue', date: '2026-12-03' });
  const changed = fs.readFileSync(place().file, 'utf8');
  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.saved, false, r.message);
  assert.equal(r.code, 'held');
  assert.match(r.message, new RegExp(`^Not saved to git: shop has 1 commit of yours that changes other files \\(${own} "${SUBJECT}"\\) not yet on the server, and a save sends only commits of the Work file\\. Your changes are kept in the file\\.`));
  assert.equal(t.git(shop, 'rev-parse', '--short', 'HEAD'), own, 'nothing committed');
  assert.equal(fs.readFileSync(place().file, 'utf8'), changed);
  assert.equal(t.git(bare, 'rev-parse', 'main'), serverHead, 'nothing sent');
  // The same with the subject of Hoprig's map commit, in a project: also the owner's.
  t.git(shop, 'reset', '-q', '--hard', 'origin/main');
  write(shop, { 'private.txt': 'still not\n' });
  t.git(shop, 'add', 'private.txt');
  t.git(shop, 'commit', '-q', '-m', 'Update the workspace map');
  await store().add({ title: 'Book the hall', date: '2026-12-04' });
  const r2 = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r2.code, 'held', r2.message);
  assert.equal(t.git(bare, 'rev-parse', 'main'), serverHead);
  t.git(shop, 'reset', '-q', '--hard', 'origin/main');
});

test('what is not on the server is read after the fetch: his commit sent from elsewhere does not hold the save back', async () => {
  // His own commit of another file, sent to the server by its address (so this computer's idea of the server is old).
  write(shop, { 'sent-by-address.txt': 'on the server already\n' });
  t.git(shop, 'add', 'sent-by-address.txt');
  t.git(shop, 'commit', '-q', '-m', 'Sent by its address');
  const before = t.git(shop, 'rev-parse', 'origin/main');
  t.git(shop, 'push', '-q', bare, 'HEAD:main');
  // A newer git also moves the remote-tracking branch when the address is a remote's own: put it back, so that this
  // computer's idea of the server is old on every git.
  t.git(shop, 'update-ref', 'refs/remotes/origin/main', before);
  assert.notEqual(t.git(shop, 'rev-parse', 'origin/main'), head(shop), 'the remote-tracking branch is old');
  await store().add({ title: 'After his own send', date: '2026-12-04' });
  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.sent, true, r.message);
  assert.equal(head(shop), t.git(bare, 'rev-parse', 'main'));
});

test('a send that fails takes its commit back: "Not saved to git", the change stays in the file, the next Save sends it', async () => {
  const pre = path.join(bare, 'hooks', 'pre-receive');
  fs.writeFileSync(pre, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  write(shop, { 'staged.txt': 'staged\n' });
  t.git(shop, 'add', 'staged.txt');
  await store().add({ title: 'Order the chairs', date: '2026-12-05' });
  const head0 = head(shop);
  const changed = fs.readFileSync(place().file, 'utf8');
  const first = await saveWork(place(), { subject: SUBJECT });
  assert.equal(first.ok, false, first.message);
  assert.equal(first.saved, false);
  assert.equal(first.code, 'not-sent');
  assert.match(first.message, /^Not saved to git: the server refused it\. Your changes are kept in the file; Save again\.$/);
  assert.equal(head(shop), head0, 'the commit is taken back');
  assert.equal(fs.readFileSync(place().file, 'utf8'), changed);
  assert.equal(t.git(shop, 'diff', '--name-only'), 'docs/plans/deadlines.json', 'the Work file changed, not staged');
  assert.equal(t.git(shop, 'diff', '--cached', '--name-only'), 'staged.txt', 'the staged file still staged');
  assert.equal((await savePlan(place())).unsent.saves, 0, 'no save waits to be sent');
  fs.rmSync(pre);
  const second = await saveWork(place(), { subject: SUBJECT });
  assert.equal(second.sent, true, second.message);
  assert.equal(head(shop), t.git(bare, 'rev-parse', 'main'));
  t.git(shop, 'reset', '-q', '--', 'staged.txt');
  fs.rmSync(path.join(shop, 'staged.txt'));
});

test('an earlier commit of the Work file left unsent (an older version, or by hand) is sent by the next Save, whatever its subject', async () => {
  // A commit of the Work file alone, made by hand with any subject: sent also when the file has no new change.
  await store().add({ title: 'Send me later', date: '2026-12-09' });
  t.git(shop, 'commit', '-q', '-m', 'Rewritten by a hook', '--', 'docs/plans/deadlines.json');
  const plan = await savePlan(place());
  assert.equal(plan.files.length, 0, 'the file has no new change');
  assert.equal(plan.nothing, false);
  assert.equal(plan.unsent.saves, 1);
  const again = await saveWork(place(), { subject: SUBJECT });
  assert.equal(again.sent, true, again.message);
  assert.match(again.message, /^Uploaded 1 earlier copy of your list to your git server\./);
  assert.equal(head(shop), t.git(bare, 'rev-parse', 'main'));
  // With a new change: committed and sent together.
  await store().add({ title: 'Earlier one', date: '2026-12-09' });
  t.git(shop, 'commit', '-q', '-m', 'By hand', '--', 'docs/plans/deadlines.json');
  await store().add({ title: 'And a new one', date: '2026-12-10' });
  const both = await saveWork(place(), { subject: SUBJECT });
  assert.equal(both.sent, true, both.message);
  assert.match(both.message, /^Kept a copy of your list \(1 change\) with 1 earlier copy of it and uploaded it/);
  assert.equal(head(shop), t.git(bare, 'rev-parse', 'main'));
  // Behind an owner's commit: the plan has nothing to do while the file has no new change.
  await store().add({ title: 'Held back', date: '2026-12-10' });
  t.git(shop, 'commit', '-q', '-m', 'By hand again', '--', 'docs/plans/deadlines.json');
  write(shop, { 'mine.txt': 'his\n' });
  t.git(shop, 'add', 'mine.txt');
  t.git(shop, 'commit', '-q', '-m', 'His own work');
  const held = await savePlan(place());
  assert.equal(held.nothing, true);
  assert.equal(held.unsent.saves, 1);
  assert.deepEqual(held.unsent.others.map((c) => c.subject), ['His own work']);
  t.git(shop, 'reset', '-q', '--hard', 'origin/main');
});

test('the send names exactly one commit and one branch: never the owner\'s tags, never another branch', async () => {
  const g = path.join(t.root, 'gitconfig');
  const was = fs.readFileSync(g, 'utf8');
  fs.appendFileSync(g, '[push]\n\tfollowTags = true\n\tdefault = matching\n');
  t.git(shop, 'tag', '-a', 'private-note', '-m', 'a note of mine', 'HEAD');
  t.git(shop, 'branch', 'side');
  await store().add({ title: 'With tags around', date: '2026-12-11' });
  const r = await saveWork(place(), { subject: SUBJECT });
  fs.writeFileSync(g, was);
  assert.equal(r.sent, true, r.message);
  assert.equal(t.git(bare, 'tag', '-l'), '', 'no tag went along');
  assert.deepEqual(t.git(bare, 'branch', '--format=%(refname:short)').split('\n'), ['main']);
  t.git(shop, 'tag', '-d', 'private-note');
  t.git(shop, 'branch', '-D', 'side');
});

test('a save never starts the repository\'s file-system monitor; a hook that rewrites the file is said', async () => {
  const mark = path.join(t.root, 'fsmonitor-ran');
  const monitor = path.join(t.root, 'fsmonitor.sh');
  fs.writeFileSync(monitor, `#!/bin/sh\ntouch "${mark}"\nexit 1\n`, { mode: 0o755 });
  t.git(shop, 'config', 'core.fsmonitor', monitor);
  await store().add({ title: 'Check the monitor', date: '2026-12-07' });
  const r = await saveWork(place(), { subject: SUBJECT });
  assert.equal(r.sent, true, r.message);
  assert.equal(fs.existsSync(mark), false, 'the monitor never ran');
  t.git(shop, 'config', '--unset', 'core.fsmonitor');
  const hook = path.join(shop, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(hook, '#!/bin/sh\nprintf "{}\\n" > docs/plans/deadlines.json\n', { mode: 0o755 });
  await store().add({ title: 'Rewritten by the hook', date: '2026-12-08' });
  const h = await saveWork(place(), { subject: SUBJECT });
  fs.rmSync(hook);
  assert.equal(h.saved, true, h.message);
  assert.match(h.message, /\. A hook of the repository changed the file while committing/);
  t.git(shop, 'checkout', '-q', '--', 'docs/plans/deadlines.json');
});

test('a merge the owner has begun is his to finish: a save says so and commits nothing', async () => {
  await store().add({ title: 'During a merge', date: '2026-12-11' });
  const head = t.git(shop, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(shop, '.git', 'MERGE_HEAD'), `${head}\n`);
  const r = await saveWork(place(), { subject: SUBJECT });
  fs.rmSync(path.join(shop, '.git', 'MERGE_HEAD'));
  assert.equal(r.ok, false);
  assert.match(r.message, /^The repository shop is in the middle of a merge: finish it first/);
  assert.equal(t.git(shop, 'rev-parse', 'HEAD'), head);
  const after = await saveWork(place(), { subject: SUBJECT });
  assert.equal(after.sent, true, after.message);
});

test('a dry run commits nothing; a folder outside git and a new file are said plainly', async () => {
  fs.mkdirSync(t.brain, { recursive: true });
  const brainPlace = resolvePlace({});
  const none = await saveWork(brainPlace, { subject: SUBJECT });
  assert.equal(none.ok, true);
  assert.match(none.message, /Nothing to keep/);
  await workStore(brainPlace, { projects: projectNames() }).add({ title: 'First thing to do' });
  const nogit = await saveWork(brainPlace, { subject: SUBJECT });
  assert.equal(nogit.ok, false);
  assert.match(nogit.message, /^The folder ai_brain\/work is not in a git repository/);
  const kept = fs.readFileSync(brainPlace.file);
  fs.rmSync(brainPlace.file);
  t.repo(t.brain, { 'README.md': '# brain\n' }); // its first commit must not take the list in
  fs.writeFileSync(brainPlace.file, kept);
  const dry = await saveWork(brainPlace, { subject: SUBJECT, dryRun: true });
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.plan.files, [{ path: 'work/tasks.json', state: 'new' }]);
  assert.equal(subjects(t.brain, '-1')[0], 'Start', 'nothing committed');
  const r = await saveWork(brainPlace, { subject: 'Plan the week' });
  assert.equal(r.sent, true, r.message);
  assert.deepEqual(t.git(t.brain, 'show', '--name-only', '--format=%s', 'HEAD').split('\n').filter(Boolean), ['Plan the week', 'work/tasks.json']);
  assert.ok(!JSON.stringify(r).includes(t.root), 'no full path in what a save returns');
  // In the brain, Hoprig's commit of the workspace map (that file and nothing else) goes along with a save.
  write(t.brain, { 'workspace.json': '{"projects":[]}\n' });
  t.git(t.brain, 'add', 'workspace.json');
  t.git(t.brain, 'commit', '-q', '-m', 'A map commit by any name');
  await workStore(brainPlace, { projects: projectNames() }).add({ title: 'Second thing to do' });
  const along = await saveWork(brainPlace, { subject: SUBJECT });
  assert.equal(along.sent, true, along.message);
  assert.equal(t.git(t.brain, 'rev-parse', 'HEAD'), t.git(path.join(t.server, 'ai_brain.git'), 'rev-parse', 'main'));
});
