// Save with two computers (two clones of one bare "server" repository): when the server changed the Work file too,
// the lists are merged by item, shown first ("changes of yours, from another computer, to decide"), and on the yes
// committed and sent; a conflict waits for the owner's choice; commits this computer has and the server lacks are
// never moved, and the message gives commands that work; a step that fails says what was done and how the repository
// stands; a server branch that was rewritten changes nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempWork, write } from './helpers.mjs';

const t = tempWork('work-merge');
test.after(() => t.cleanup());
const { savePlan, saveWork } = await import('../../src/work/save.mjs');
const journals = () => {
  try {
    return fs.readdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'work-journal'));
  } catch {
    return [];
  }
};
const { workStore } = await import('../../src/work/store.mjs');

const SUBJECT = 'Update work items';
const settings = { timeZone: '', ownerId: 'me', saveSubject: SUBJECT };
const item = (id, extra = {}) => ({ id, date: null, approx: false, title: `Task ${id}`, kind: 'task', by: 'me', status: 'open', source: 'me', ...extra });
const listText = (items) => `${JSON.stringify({ items }, null, 2)}\n`;
let n = 0;

/** A server and two computers, A (this one) and B (another), each with the list of `items` committed. */
function twoComputers(items = [item('a'), item('b'), item('c')]) {
  const here = path.join(t.root, `a${++n}`);
  const bare = t.repo(here, { 'README.md': '# brain\n', 'work/tasks.json': listText(items), 'notes.md': 'notes\n' });
  const other = t.otherClone(bare);
  const place = { file: path.join(here, 'work', 'tasks.json'), folder: path.join(here, 'work'), base: here, label: 'brain/work', fileName: 'tasks.json', kind: 'project', settings };
  const store = workStore(place);
  /** B changes its list with `fn(doc)`, commits and sends. */
  const otherChanges = (fn, subject = SUBJECT) => {
    t.git(other, 'pull', '-q', '--ff-only');
    const f = path.join(other, 'work', 'tasks.json');
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    fn(doc);
    fs.writeFileSync(f, listText(doc.items));
    t.git(other, 'commit', '-q', '-am', subject);
    t.git(other, 'push', '-q');
  };
  const items_ = (dir = here) => JSON.parse(fs.readFileSync(path.join(dir, 'work', 'tasks.json'), 'utf8')).items;
  return { here, bare, other, place, store, otherChanges, items: items_ };
}

test('the server changed the list too: merged by item, shown first, committed and sent; other files stay as they were', async () => {
  const c = twoComputers();
  c.otherChanges((doc) => {
    doc.items.push(item('from-b', { title: 'Added on the other computer' }));
    doc.items.find((x) => x.id === 'b').status = 'done';
  });
  await c.store.status('a', 'done');
  await c.store.add({ title: 'Added on this computer' });
  write(c.here, { 'notes.md': 'changed, not staged\n', 'staged.txt': 'staged\n' });
  t.git(c.here, 'add', 'staged.txt');
  const before = t.git(c.here, 'rev-parse', 'HEAD');

  const plan = await savePlan(c.place, { fetch: true });
  assert.equal(plan.remote.mode, 'merge');
  assert.deepEqual(plan.remote.mine.map((x) => [x.id, x.what]).sort(), [['a', 'done'], ['added-on-this-computer', 'added']]);
  assert.deepEqual(plan.remote.theirs.map((x) => [x.id, x.what]).sort(), [['b', 'done'], ['from-b', 'added']]);
  assert.equal(plan.remote.undecided, 0);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), before, 'looking changes nothing');

  const r = await saveWork(c.place, { subject: SUBJECT, expect: { hash: plan.hash, upstream: plan.remote.upstream } });
  assert.equal(r.sent, true, r.message);
  assert.match(r.message, /^Merged 2 changes of yours with 2 changes from another computer and sent it to origin\/main\./);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), t.git(c.bare, 'rev-parse', 'main'));
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD~1'), plan.remote.upstream, 'one commit on top of the server\'s, no merge commit');
  assert.deepEqual(c.items().map((x) => [x.id, x.status]), [['a', 'done'], ['b', 'done'], ['c', 'open'], ['from-b', 'open'], ['added-on-this-computer', 'open']]);
  assert.equal(fs.readFileSync(path.join(c.here, 'notes.md'), 'utf8'), 'changed, not staged\n');
  assert.deepEqual(t.git(c.here, 'diff', '--cached', '--name-only').split('\n'), ['staged.txt']);
  assert.deepEqual(journals(), [], 'the journal went with the success');
  t.git(c.other, 'pull', '-q', '--ff-only');
  assert.deepEqual(c.items(c.other), c.items(), 'the other computer gets the same list');
});

test('a task changed differently on both computers waits for the owner\'s choice; nothing changes before it', async () => {
  const c = twoComputers();
  c.otherChanges((doc) => {
    doc.items[0].title = 'Renamed on the other computer';
  });
  await c.store.edit('a', { title: 'Renamed on this computer' });
  const head = t.git(c.here, 'rev-parse', 'HEAD');
  const mine = fs.readFileSync(c.place.file, 'utf8');
  const plan = await savePlan(c.place, { fetch: true });
  assert.deepEqual(plan.remote.conflicts.map((x) => [x.key, x.mine.title, x.theirs.title]), [['a#0', 'Renamed on this computer', 'Renamed on the other computer']]);
  const wait = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(wait.code, 'decide');
  assert.equal(wait.ok, false);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), mine);
  const r = await saveWork(c.place, { subject: SUBJECT, decisions: { 'a#0': 'mine' } });
  assert.equal(r.sent, true, r.message);
  assert.match(r.message, /1 task decided by you/);
  assert.equal(c.items()[0].title, 'Renamed on this computer');
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), t.git(c.bare, 'rev-parse', 'main'));
  // The other's version chosen: the server's list is the result, nothing new to commit or send.
  c.otherChanges((doc) => {
    doc.items[1].title = 'B on the other computer';
  });
  await c.store.edit('b', { title: 'B on this computer' });
  const t2 = await saveWork(c.place, { subject: SUBJECT, decisions: { 'b#0': 'theirs' } });
  assert.equal(t2.ok, true, t2.message);
  assert.match(t2.message, /the server's version is the result, so there is nothing to send/);
  assert.equal(c.items()[1].title, 'B on the other computer');
  assert.equal(t.git(c.here, 'status', '--porcelain'), '');
});

test('an earlier commit of the Work file not on the server and a moved server: nothing is touched, and the command given works', async () => {
  const c = twoComputers();
  // A commit of the Work file alone that an older version (or the owner's hand) left unsent.
  await c.store.add({ title: 'Saved here, not sent' });
  t.git(c.here, 'commit', '-q', '-m', SUBJECT, '--', 'work/tasks.json');
  c.otherChanges((doc) => doc.items.push(item('from-b')));
  await c.store.add({ title: 'And a new one here' });
  write(c.here, { 'staged.txt': 'staged\n' });
  t.git(c.here, 'add', 'staged.txt');
  const head = t.git(c.here, 'rev-parse', 'HEAD');
  const mine = fs.readFileSync(c.place.file, 'utf8');
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.code, 'blocked', r.message);
  const m = /In a terminal in (\S+): (git reset --soft [0-9a-f]{12}) \(it makes that commit a change in the file again and changes nothing else\), then Save again/.exec(r.message);
  assert.ok(m, r.message);
  assert.match(r.message, /^Not saved to git: a\d+ has 1 new commit on the server, and this computer has 1 earlier commit of the Work file that is not on the server \([0-9a-f]+ "Update work items"\)\. Nothing was changed\./);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), mine);
  // The command, as the message gives it; then Save merges by task and sends.
  t.git(c.here, ...m[2].split(' ').slice(1));
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), mine, 'the file as it was');
  const after = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(after.sent, true, after.message);
  assert.deepEqual(c.items().map((x) => x.id), ['a', 'b', 'c', 'from-b', 'saved-here-not-sent', 'and-a-new-one-here']);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), t.git(c.bare, 'rev-parse', 'main'));
  assert.equal(t.git(c.here, 'diff', '--cached', '--name-only'), 'staged.txt', 'a staged file stays staged');
});

test('the server\'s branch was rewritten (another computer forced it): nothing is touched, and the save says so', async () => {
  const c = twoComputers();
  // A real commit of the owner's, of another file, that is on the server already.
  write(c.here, { 'notes.md': 'pushed earlier from here, a real commit\n' });
  t.git(c.here, 'commit', '-q', '-am', 'My notes');
  t.git(c.here, 'push', '-q');
  const mineCommit = t.git(c.here, 'rev-parse', 'HEAD');
  await c.store.add({ title: 'Not yet saved' });
  // The other computer drops "My notes" from the server and changes the list.
  t.git(c.other, 'pull', '-q', '--ff-only');
  t.git(c.other, 'reset', '-q', '--hard', 'HEAD~1');
  const f = path.join(c.other, 'work', 'tasks.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  d.items[1].status = 'done';
  fs.writeFileSync(f, listText(d.items));
  t.git(c.other, 'commit', '-q', '-am', 'Rewritten');
  t.git(c.other, 'push', '-q', '-f');
  const mine = fs.readFileSync(c.place.file, 'utf8');
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.code, 'rewritten', r.message);
  assert.match(r.message, /^Not saved to git: the server's branch of a\d+ was rewritten \(commits it had are gone from it\), so a save changes nothing\. Your changes are kept in the file\./);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), mineCommit, 'his commit is still on his branch');
  assert.equal(fs.readFileSync(path.join(c.here, 'notes.md'), 'utf8'), 'pushed earlier from here, a real commit\n');
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), mine);
});

test('the owner\'s own commits and a moved server: nothing is touched, and the commands given work', async () => {
  const c = twoComputers();
  write(c.other, { 'README.md': '# brain, changed elsewhere\n' });
  t.git(c.other, 'commit', '-q', '-am', 'Readme elsewhere');
  t.git(c.other, 'push', '-q');
  write(c.here, { 'mine.txt': 'his own\n' });
  t.git(c.here, 'add', 'mine.txt');
  t.git(c.here, 'commit', '-q', '-m', 'His own work');
  await c.store.add({ title: 'Waiting for his pull' });
  const head = t.git(c.here, 'rev-parse', 'HEAD');
  const mine = fs.readFileSync(c.place.file, 'utf8');
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.code, 'blocked');
  assert.match(r.message, /^Not saved to git: a\d+ has 1 new commit on the server, and this computer has 1 commit of yours that changes other files \([0-9a-f]{7,} "His own work"\)\. Nothing was changed\./);
  assert.match(r.message, /git stash push -- work\/tasks\.json, then git pull --no-rebase, then git stash pop; then Save again/);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), mine);
  // The commands, as the message gives them.
  t.git(c.here, 'stash', 'push', '-q', '--', 'work/tasks.json');
  t.git(c.here, 'pull', '-q', '--no-rebase', '--no-edit');
  t.git(c.here, 'stash', 'pop', '-q');
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), mine);
  const after = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(after.code, 'held', 'his commits are his to send first');
  assert.equal(after.saved, false, after.message);
});

test('a clash: nothing is touched, a Work file he had staged stays staged, and nothing is left behind', async () => {
  // The server's commits change a file that is changed here: seen before anything changes.
  const c = twoComputers();
  write(c.other, { 'notes.md': 'changed elsewhere\n' });
  c.otherChanges((doc) => doc.items.push(item('from-b')));
  write(c.here, { 'notes.md': 'changed here too\n' });
  await c.store.add({ title: 'Kept through a clash' });
  t.git(c.here, 'add', 'work/tasks.json');
  await c.store.add({ title: 'Not staged yet' });
  const head = t.git(c.here, 'rev-parse', 'HEAD');
  const mine = fs.readFileSync(c.place.file, 'utf8');
  const staged = t.git(c.here, 'diff', '--cached');
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.code, 'clash', r.message);
  assert.match(r.message, /^Not saved to git: the server's 1 new commit changes files that are changed here too, or are here as files git does not keep \(notes\.md\)\. Nothing was changed/);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), mine);
  assert.equal(t.git(c.here, 'diff', '--cached'), staged, 'the staged Work file as it was');
  assert.equal(fs.readFileSync(path.join(c.here, 'notes.md'), 'utf8'), 'changed here too\n');
  assert.deepEqual(journals(), []);
  assert.doesNotMatch(r.message, new RegExp(t.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'no path in the message');
  // A file the server adds that is here, ignored by git: a fast-forward would overwrite it; never.
  const e = twoComputers();
  write(e.here, { '.git/info/exclude': 'new.txt\n', 'new.txt': 'MY OWN IGNORED\n' });
  e.otherChanges((doc) => doc.items.push(item('from-b')));
  write(e.other, { 'new.txt': 'server version\n' });
  t.git(e.other, 'add', 'new.txt');
  t.git(e.other, 'commit', '-q', '-m', 'Add new.txt');
  t.git(e.other, 'push', '-q');
  await e.store.add({ title: 'Here' });
  const ri = await saveWork(e.place, { subject: SUBJECT });
  assert.equal(ri.code, 'clash', ri.message);
  assert.equal(fs.readFileSync(path.join(e.here, 'new.txt'), 'utf8'), 'MY OWN IGNORED\n');
});

test('git refuses the fast-forward after the file was put back: his file and its staged state come back, nothing is left', async () => {
  const c = twoComputers();
  c.otherChanges((doc) => doc.items.push(item('from-b')));
  await c.store.add({ title: 'Staged here' });
  t.git(c.here, 'add', 'work/tasks.json');
  await c.store.add({ title: 'Changed after' });
  const head = t.git(c.here, 'rev-parse', 'HEAD');
  const mine = fs.readFileSync(c.place.file, 'utf8');
  const staged = t.git(c.here, 'diff', '--cached');
  const { capture } = await import('../../src/setup/system.mjs');
  const refuse = (args, o) => (args.includes('--ff-only') ? { ok: false, code: 128, stdout: '', stderr: 'fatal: refused for the test' } : capture(args, o));
  const r = await saveWork(c.place, { subject: SUBJECT, run: refuse });
  assert.equal(r.code, 'clash', r.message);
  assert.match(r.message, /^Not saved to git: the server's 1 new commit could not be brought in .*\. Nothing was changed; your changes are kept in the file\./);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), mine);
  assert.equal(t.git(c.here, 'diff', '--cached'), staged, 'staged as he had it');
  assert.deepEqual(journals(), [], 'what it wrote is deleted');
});

test('a step that fails after the branch moved says so: the commit refused, the merged list not writable', async () => {
  // The commit fails after the server's commits came in: the merged list is in the file, not committed, and said so.
  const d = twoComputers();
  d.otherChanges((doc) => doc.items.push(item('from-b')));
  await d.store.add({ title: 'Kept in the file' });
  fs.writeFileSync(path.join(d.here, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const f = await saveWork(d.place, { subject: SUBJECT });
  assert.equal(f.code, 'failed', f.message);
  assert.match(f.message, /^Not saved to git: the commit did not go through \(git refused it: a hook of the repository, or another git program working in it\)\. The server's 1 new commit is here now, and your changes, merged with the other computer's, are in the Work file, not committed\./);
  assert.deepEqual(d.items().map((x) => x.id), ['a', 'b', 'c', 'from-b', 'kept-in-the-file']);
  assert.equal(t.git(d.here, 'rev-parse', 'HEAD'), t.git(d.bare, 'rev-parse', 'main'), 'the branch is at the server\'s commit');
  assert.deepEqual(journals(), []);
  fs.rmSync(path.join(d.here, '.git', 'hooks', 'pre-commit'));
  const again = await saveWork(d.place, { subject: SUBJECT });
  assert.equal(again.sent, true, again.message);

  // The merged list cannot be written after the fast-forward: the message says where the branch is and where the
  // list is kept; the next look at the list, once the file can be written, writes it.
  if (process.platform === 'win32' || process.getuid?.() === 0) return; // a folder's mode does not stop the owner there
  const e = twoComputers();
  e.otherChanges((doc) => doc.items.push(item('from-b')));
  await e.store.add({ title: 'Kept in the journal' });
  const { capture } = await import('../../src/setup/system.mjs');
  const dir = path.dirname(e.place.file);
  const lockAfterFf = async (args, o) => {
    const res = await capture(args, o);
    if (args.includes('--ff-only')) fs.chmodSync(dir, 0o555);
    return res;
  };
  const w = await saveWork(e.place, { subject: SUBJECT, run: lockAfterFf });
  fs.chmodSync(dir, 0o755);
  assert.equal(w.code, 'failed', w.message);
  assert.match(w.message, /^Not saved to git: the server's 1 new commit is here now \(the branch is on the server's commit\), but the merged list could not be written to the Work file \(no permission\)\. It is kept in Hoprig's state folder, work-journal\/[0-9a-f]{24}\.json \(its "merged" value\)/);
  assert.equal(journals().length, 1);
  const plan = await savePlan(e.place);
  assert.match(plan.recovered, /interrupted after it brought in the server's commits/);
  assert.deepEqual(e.items().map((x) => x.id), ['a', 'b', 'c', 'from-b', 'kept-in-the-journal']);
  assert.deepEqual(journals(), []);
  const sent = await saveWork(e.place, { subject: SUBJECT });
  assert.equal(sent.sent, true, sent.message);
});

test('a commit made here while the save ran (in a terminal) is never sent along: the save commits nothing on it and says why', async () => {
  const c = twoComputers();
  c.otherChanges((doc) => doc.items.push(item('from-b')));
  await c.store.add({ title: 'Saved around his commit' });
  const { capture } = await import('../../src/setup/system.mjs');
  const his = async (args, o) => {
    const res = await capture(args, o);
    if (args.includes('--ff-only')) {
      write(c.here, { 'his.txt': 'his own\n' });
      await capture(['git', '-C', c.here, 'add', '--', 'his.txt']);
      await capture(['git', '-C', c.here, 'commit', '-q', '-m', 'His own commit', '--', 'his.txt']);
    }
    return res;
  };
  const before = t.git(c.bare, 'rev-parse', 'main');
  const r = await saveWork(c.place, { subject: SUBJECT, run: his });
  assert.equal(r.code, 'moved-here', r.message);
  assert.match(r.message, /^Not saved to git: your commit [0-9a-f]{7,} "His own commit" came in while the save ran, so nothing was committed\. The server's 1 new commit is here now, and your changes, merged with the other computer's, are in the Work file, not committed\. Save again\.$/);
  assert.equal(t.git(c.bare, 'rev-parse', 'main'), before, 'nothing sent');
  assert.equal(t.git(c.here, 'log', '-1', '--format=%s'), 'His own commit', 'his commit stays, and nothing of the save is on it');
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD^'), before, 'his commit is on the server\'s, the save made none');
  assert.equal(t.git(c.here, 'for-each-ref', 'refs/hoprig'), '', 'the list kept during the merge is gone with the save');
  assert.deepEqual(c.items().map((x) => x.id), ['a', 'b', 'c', 'from-b', 'saved-around-his-commit']);
  assert.deepEqual(journals(), []);
});

test('the server moved after the plan the owner saw: nothing is committed, the new plan comes back', async () => {
  const c = twoComputers();
  await c.store.add({ title: 'Seen in the plan' });
  const plan = await savePlan(c.place, { fetch: true });
  c.otherChanges((doc) => doc.items.push(item('later-on-b')));
  const head = t.git(c.here, 'rev-parse', 'HEAD');
  const r = await saveWork(c.place, { subject: SUBJECT, expect: { hash: plan.hash, upstream: plan.remote.upstream } });
  assert.equal(r.code, 'moved');
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD'), head);
  assert.equal(r.plan.remote.mode, 'merge');
  assert.deepEqual(r.plan.remote.theirs.map((x) => x.id), ['later-on-b']);
});
