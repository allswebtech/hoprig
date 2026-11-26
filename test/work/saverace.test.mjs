// The owner works in the same repository at the very moment a save runs: a commit in a terminal, a switch of branch,
// an edit of the Work file, a pull. A `git` on PATH runs the real git and then does his action once, right after a
// chosen call of the save (TRIG_MATCH), or right after the call that follows it (TRIG_ARM: the next call after a match).
// Every time: nothing of his is lost or changed, nothing of his reaches the server, and the message says how the
// repository stands. Also: the list a merge keeps in the repository, and a branch git sends to another place.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { endSignal, tempWork, write } from './helpers.mjs';

const t = tempWork('work-race');
test.after(() => t.cleanup());
const skip = process.platform === 'win32' ? 'the stand-in git is a shell script' : false;
const { saveWork, savePlan, STOP_ENV } = await import('../../src/work/save.mjs');
const { workStore } = await import('../../src/work/store.mjs');

const REAL = skip ? 'git' : execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const BIN = path.join(t.root, 'bin');
const CFG = path.join(t.root, 'trig.env');
if (!skip) {
  fs.mkdirSync(BIN, { recursive: true });
  // The action runs once (its mark file); git's own exit code goes back to the save.
  fs.writeFileSync(path.join(BIN, 'git'), `#!/bin/sh
[ -f "${CFG}" ] && . "${CFG}"
"${REAL}" "$@"
rc=$?
if [ -n "$TRIG_CMD" ] && [ ! -e "$TRIG_MARK" ]; then
  fire=0
  if [ -n "$TRIG_ARM" ]; then
    if [ -e "$TRIG_MARK.armed" ]; then fire=1; else case " $* " in *"$TRIG_ARM"*) touch "$TRIG_MARK.armed";; esac; fi
  else
    case " $* " in *"$TRIG_MATCH"*) fire=1;; esac
  fi
  if [ $fire = 1 ]; then touch "$TRIG_MARK"; sh -c "$TRIG_CMD" >>"$TRIG_MARK" 2>&1; fi
fi
exit $rc
`, { mode: 0o755 });
  process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;
}

const SUBJECT = 'Update work items';
const settings = { timeZone: '', ownerId: 'me', saveSubject: SUBJECT };
const item = (id, extra = {}) => ({ id, date: null, approx: false, title: `Task ${id}`, kind: 'task', by: 'me', status: 'open', source: 'me', ...extra });
const listText = (items) => `${JSON.stringify({ items }, null, 2)}\n`;
const ids = (text) => JSON.parse(text).items.map((x) => `${x.id}:${x.status}`);
const journals = () => {
  try {
    return fs.readdirSync(path.join(process.env.HOPRIG_STATE_DIR, 'work-journal'));
  } catch {
    return [];
  }
};
let n = 0;

/** A server and this computer (and another, which changed `other`: "list", "readme" or nothing); his done and new task. */
async function setup(other = null) {
  const here = path.join(t.root, `r${++n}`);
  const bare = t.repo(here, { 'README.md': '# brain\n', 'notes.md': 'notes\n', 'work/tasks.json': listText([item('a'), item('b'), item('c')]) });
  const place = { file: path.join(here, 'work', 'tasks.json'), folder: path.join(here, 'work'), base: here, label: 'brain/work', fileName: 'tasks.json', kind: 'project', settings };
  if (other) {
    const elsewhere = t.otherClone(bare);
    if (other === 'list') {
      const f = path.join(elsewhere, 'work', 'tasks.json');
      const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
      doc.items.push(item('from-b'));
      fs.writeFileSync(f, listText(doc.items));
    } else write(elsewhere, { 'README.md': '# brain, from the other computer\n' });
    t.git(elsewhere, 'commit', '-q', '-am', 'From the other computer');
    t.git(elsewhere, 'push', '-q');
  }
  const store = workStore(place);
  await store.status('a', 'done');
  await store.add({ title: 'New here' });
  const sh = (cmd) => `cd "${here}" && ${cmd.replace(/\bgit\b/g, `"${REAL}"`)}`;
  return { here, bare, place, sh, list: () => ids(fs.readFileSync(place.file, 'utf8')) };
}

/** The save, with his action `cmd` done once by the stand-in git right after the call that matches `match`. */
async function saveWith(c, { match, arm, cmd }) {
  const mark = path.join(t.root, `mark-${n}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(CFG, `TRIG_MARK=${JSON.stringify(mark)}\n${match ? `TRIG_MATCH=${JSON.stringify(match)}\n` : ''}${arm ? `TRIG_ARM=${JSON.stringify(arm)}\n` : ''}TRIG_CMD=${JSON.stringify(c.sh(cmd)).replace(/\$/g, '\\$')}\n`);
  try {
    const r = await saveWork(c.place, { subject: SUBJECT });
    assert.ok(fs.existsSync(mark), `his action ran (${match || arm})`);
    return r;
  } finally {
    fs.rmSync(CFG, { force: true });
  }
}
const HIS_COMMIT = 'echo mine > private.txt && git add private.txt && git commit -q -m "My own work, not to be sent"';
const refuse = (c) => fs.writeFileSync(path.join(c.bare, 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
const serverLog = (c) => t.git(c.bare, 'log', '--format=%s', 'main').split('\n');

test('a commit he makes right after the plan looked is never sent along: the save answers "moved" and says why', { skip }, async () => {
  for (const other of [null, 'readme']) {
    const c = await setup(other);
    const server = serverLog(c);
    const r = await saveWith(c, { match: 'rev-list --left-right --count', cmd: HIS_COMMIT });
    assert.equal(r.code, 'moved', r.message);
    assert.match(r.message, /^Not saved to git: your commit [0-9a-f]{7,} "My own work, not to be sent" came in while the save ran\. Nothing was changed; your changes are kept in the file\. Look at the new plan and save again\.$/);
    assert.deepEqual(serverLog(c), server, 'nothing reached the server');
    assert.equal(t.git(c.here, 'log', '-1', '--format=%s'), 'My own work, not to be sent');
    assert.deepEqual(c.list(), ['a:done', 'b:open', 'c:open', 'new-here:open']);
    assert.equal(t.git(c.here, 'status', '--porcelain', '--', 'work/tasks.json'), 'M work/tasks.json', 'his list stays a change in the file');
    assert.deepEqual(journals(), []);
  }
});

test('only sending earlier saves: a commit he makes meanwhile is not sent with them (the send names the judged commit)', { skip }, async () => {
  const c = await setup();
  t.git(c.here, 'commit', '-q', '-m', 'An earlier save', '--', 'work/tasks.json');
  const r = await saveWith(c, { match: 'rev-list --left-right --count', cmd: HIS_COMMIT });
  assert.equal(r.code, 'moved', r.message);
  assert.deepEqual(serverLog(c), ['Start'], 'neither his commit nor the earlier save went');
  assert.equal(t.git(c.here, 'log', '-1', '--format=%s'), 'My own work, not to be sent');
});

test('a commit he makes right after the save\'s commit stays on his branch: nothing more is touched, the message says how it stands', { skip }, async () => {
  const c = await setup();
  const r = await saveWith(c, { match: `commit --quiet -m ${SUBJECT}`, cmd: HIS_COMMIT });
  assert.equal(r.code, 'moved-here', r.message);
  const save = t.git(c.here, 'rev-parse', 'HEAD^');
  assert.equal(r.message, `Not saved to git: your commit ${t.git(c.here, 'rev-parse', '--short', 'HEAD')} "My own work, not to be sent" came in while the save ran; the save's commit ${save.slice(0, 12)} is under it, not sent: it goes to the server with yours when you send them (git push in r${n}).`);
  assert.equal(t.git(c.here, 'log', '-1', '--format=%s'), 'My own work, not to be sent', 'his commit is still on main');
  assert.equal(t.git(c.here, 'log', '-1', '--format=%s', save), SUBJECT);
  assert.deepEqual(serverLog(c), ['Start'], 'nothing sent');
  assert.deepEqual(journals(), []);
  // The next Save goes by the rule for commits not on the server: his commit changes another file, so it is his to send.
  const next = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(next.sent, false, next.message);
  assert.deepEqual(next.plan.unsent.others.map((x) => x.subject), ['My own work, not to be sent']);
  assert.deepEqual(serverLog(c), ['Start']);
  // His commit of the Work file alone on top: a Save sends both.
  const d = await setup();
  const r2 = await saveWith(d, { match: `commit --quiet -m ${SUBJECT}`, cmd: 'sed -i.bak "s/Task b/Task b, his/" work/tasks.json && rm work/tasks.json.bak && git commit -q -am "His own edit of the list"' });
  assert.match(r2.message, /^Not saved to git: your commit [0-9a-f]{7,} "His own edit of the list" came in while the save ran; the save's commit [0-9a-f]{12} is under it, not sent: Save again sends it\.$/);
  const both = await saveWork(d.place, { subject: SUBJECT });
  assert.equal(both.sent, true, both.message);
  assert.deepEqual(serverLog(d), ['His own edit of the list', SUBJECT, 'Start']);
});

test('a failing send while he switches branch: nothing is taken back on the other checkout, the message says where the commit is', { skip }, async () => {
  const c = await setup();
  t.git(c.here, 'branch', 'feature');
  refuse(c);
  const r = await saveWith(c, { match: 'push --quiet', cmd: 'git checkout -q feature' });
  const save = t.git(c.here, 'rev-parse', 'main');
  assert.equal(r.code, 'not-sent', r.message);
  assert.equal(r.message, `Not saved to git: the server refused it, and the save's commit ${save.slice(0, 12)} was not taken back because r${n} was switched to feature meanwhile: it is on main, not on the server. Save again sends it.`);
  assert.equal(t.git(c.here, 'log', '-1', '--format=%s', 'main'), SUBJECT, 'main keeps the save\'s commit, with his list in it');
  assert.deepEqual(ids(t.git(c.here, 'show', 'main:work/tasks.json')), ['a:done', 'b:open', 'c:open', 'new-here:open']);
  assert.equal(t.git(c.here, 'status', '--porcelain'), '', 'the other checkout is as he switched to it: nothing written into its index');
  assert.deepEqual(journals(), []);
});

test('a failing send while he edits the Work file: nothing is taken back, his edit stays, and it is not called a hook', { skip }, async () => {
  const c = await setup();
  refuse(c);
  const r = await saveWith(c, { match: 'push --quiet', cmd: 'sed -i.bak "s/Task b/Task b, edited by hand/" work/tasks.json && rm work/tasks.json.bak' });
  const save = t.git(c.here, 'rev-parse', 'main');
  assert.equal(r.message, `Not saved to git: the server refused it, and the save's commit ${save.slice(0, 12)} was not taken back because the Work file was changed meanwhile: it is on main, not on the server. Save again sends it.`);
  assert.match(fs.readFileSync(c.place.file, 'utf8'), /Task b, edited by hand/);
  assert.equal(t.git(c.here, 'log', '-1', '--format=%s'), SUBJECT);
});

test('an edit right after the commit is not called "a hook changed the file"', { skip }, async () => {
  const c = await setup();
  const r = await saveWith(c, { arm: `commit --quiet -m ${SUBJECT}`, cmd: 'sed -i.bak "s/Task c/Task c, edited by hand/" work/tasks.json && rm work/tasks.json.bak' });
  assert.equal(r.sent, true, r.message);
  assert.doesNotMatch(r.message, /hook/);
  assert.match(fs.readFileSync(c.place.file, 'utf8'), /Task c, edited by hand/, 'his edit stays, as a change of the file');
});

test('a merge whose send fails puts the version of the Work file he had staged back in the index', { skip }, async () => {
  const c = await setup('list');
  t.git(c.here, 'add', 'work/tasks.json');
  const staged = t.git(c.here, 'rev-parse', ':work/tasks.json');
  await workStore(c.place).add({ title: 'After staging' });
  refuse(c);
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.code, 'not-sent', r.message);
  assert.equal(t.git(c.here, 'rev-parse', ':work/tasks.json'), staged, 'his staged version, as it was');
  assert.deepEqual(c.list(), ['a:done', 'b:open', 'c:open', 'from-b:open', 'new-here:open', 'after-staging:open']);
});

test('he commits while a merge puts the file back: the true reason, his list back in the file, nothing left over', { skip }, async () => {
  const c = await setup('list');
  const head = t.git(c.here, 'rev-parse', 'HEAD');
  const r = await saveWith(c, { match: 'checkout --quiet HEAD', cmd: HIS_COMMIT });
  assert.equal(r.code, 'moved-here', r.message);
  assert.match(r.message, /^Not saved to git: your commit [0-9a-f]{7,} "My own work, not to be sent" came in while the save ran, so the server's commits were not brought in\. Nothing was changed; your changes are kept in the file\.$/);
  assert.equal(t.git(c.here, 'rev-parse', 'HEAD^'), head);
  assert.deepEqual(c.list(), ['a:done', 'b:open', 'c:open', 'new-here:open']);
  assert.equal(t.git(c.here, 'for-each-ref', 'refs/hoprig'), '');
  assert.deepEqual(journals(), []);
});

test('another command brings the server\'s commits in meanwhile: the save says that, and nothing was committed', { skip }, async () => {
  const c = await setup('readme');
  const r = await saveWith(c, { match: 'rev-list --left-right --count', cmd: 'git merge -q --ff-only origin/main' });
  assert.equal(r.code, 'moved', r.message);
  assert.match(r.message, /^Not saved to git: another command brought the server's commits into r\d+ while the save ran\. Nothing was changed/);
  const again = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(again.sent, true, again.message);
});

// ---------- the list a merge keeps in the repository ----------

/** The save in a child process that ends itself right after `step` (save.mjs STOP_ENV). */
function killedSave(place, step) {
  const code = `import { saveWork } from ${JSON.stringify(new URL('../../src/work/save.mjs', import.meta.url).href)};
    await saveWork(${JSON.stringify(place)}, { subject: ${JSON.stringify(SUBJECT)} });`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, [STOP_ENV]: step }, stdio: 'ignore' });
}
const kill = (place, step) => {
  try {
    killedSave(place, step);
  } catch (e) {
    assert.equal(endSignal(e), 'SIGKILL');
    return;
  }
  assert.fail(`the save ended after ${step}`);
};

test('a merge killed after it put the file back, its state folder gone: the next look finds his list in the repository', async () => {
  const c = await setup('list');
  kill(c.place, 'putback');
  fs.rmSync(path.join(process.env.HOPRIG_STATE_DIR, 'work-journal'), { recursive: true, force: true });
  const plan = await savePlan(c.place);
  assert.equal(plan.code, 'interrupted', plan.problem);
  const show = /git show (refs\/hoprig\/work-save\/[0-9a-f]{12})/.exec(plan.problem);
  assert.ok(show, plan.problem);
  assert.match(plan.problem, /^a save of the Work list was interrupted, and its record is not in this Hoprig's state folder .*, but your list as it was before that save is kept in r\d+: git show refs\/hoprig\/work-save\/[0-9a-f]{12} prints it\. Nothing was changed\. To put it back into the Work file, in a terminal in r\d+: git show refs\/hoprig\/work-save\/[0-9a-f]{12} > work\/tasks\.json; then drop the kept list/);
  assert.deepEqual(ids(t.git(c.here, 'show', show[1])), ['a:done', 'b:open', 'c:open', 'new-here:open'], 'it prints his list');
  assert.deepEqual(c.list(), ['a:open', 'b:open', 'c:open'], 'nothing applied by itself: the file as the save put it back');
  const waits = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(waits.code, 'interrupted', 'a save waits: never "Nothing to save"');
  // He puts it back as the message says, then drops it: the next Save merges and sends.
  fs.writeFileSync(c.place.file, execFileSync(REAL, ['-C', c.here, 'show', show[1]]));
  const { dropInterrupted } = await import('../../src/work/save.mjs');
  assert.equal(await dropInterrupted(c.place), true);
  const r = await saveWork(c.place, { subject: SUBJECT });
  assert.equal(r.sent, true, r.message);
  assert.deepEqual(ids(t.git(c.bare, 'show', 'main:work/tasks.json')), ['a:done', 'b:open', 'c:open', 'from-b:open', 'new-here:open']);
  assert.equal(t.git(c.here, 'for-each-ref', 'refs/hoprig'), '');
});

test('a damaged record says where his list is kept; a merge that ends deletes what it kept', async () => {
  const c = await setup('list');
  kill(c.place, 'ff');
  const dir = path.join(process.env.HOPRIG_STATE_DIR, 'work-journal');
  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{"v":2,"top": broken');
  const plan = await savePlan(c.place);
  assert.match(plan.problem, /cannot be read: nothing was changed, and your list as it was before that save is kept in r\d+: git show refs\/hoprig\/work-save\/[0-9a-f]{12} prints it\. Then drop the record/);
  fs.rmSync(dir, { recursive: true, force: true });
  t.git(c.here, 'update-ref', '-d', /refs\/hoprig\/work-save\/[0-9a-f]{12}/.exec(plan.problem)[0]);
  const d = await setup('list');
  const r = await saveWork(d.place, { subject: SUBJECT });
  assert.equal(r.sent, true, r.message);
  assert.equal(t.git(d.here, 'for-each-ref', 'refs/hoprig'), '', 'nothing kept after a save that ended');
});

test('a merge killed right after its record, then he discards the file: the recovery writes nothing over it', async () => {
  const c = await setup('list');
  kill(c.place, 'journal');
  t.git(c.here, 'checkout', '-q', '--', 'work/tasks.json');
  const plan = await savePlan(c.place);
  assert.equal(plan.recovered, 'A save of the Work list was interrupted before it changed anything in git: your list is as it was.');
  assert.deepEqual(c.list(), ['a:open', 'b:open', 'c:open'], 'as he left it');
  assert.deepEqual(journals(), []);
});

test('a plain save killed right after its record, then he edits the file: the record is dropped, nothing is shown or written', async () => {
  const c = await setup();
  kill(c.place, 'journal');
  await workStore(c.place).add({ title: 'Added after the kill' });
  const before = fs.readFileSync(c.place.file, 'utf8');
  const plan = await savePlan(c.place);
  assert.equal(plan.problem, undefined, plan.problem);
  assert.match(plan.recovered, /^A save of the Work list was interrupted before its commit/);
  assert.equal(fs.readFileSync(c.place.file, 'utf8'), before);
  assert.deepEqual(journals(), []);
});

// ---------- a branch git sends to another place ----------

test('a branch git sends to another place than it follows: the save is the commit alone, and says so', async () => {
  const cases = {
    'branch.main.pushRemote': (c, fork) => {
      t.git(c.here, 'remote', 'add', 'fork', fork);
      t.git(c.here, 'config', 'branch.main.pushRemote', 'fork');
    },
    'remote.pushDefault': (c, fork) => {
      t.git(c.here, 'remote', 'add', 'fork', fork);
      t.git(c.here, 'config', 'remote.pushDefault', 'fork');
    },
    'a push refspec of its own': (c) => t.git(c.here, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/backup/*'),
  };
  for (const [name, set] of Object.entries(cases)) {
    const c = await setup();
    const fork = path.join(t.root, `fork-${n}.git`);
    execFileSync(REAL, ['clone', '-q', '--bare', c.bare, fork]);
    set(c, fork);
    const r = await saveWork(c.place, { subject: SUBJECT });
    assert.equal(r.ok, true, `${name}: ${r.message}`);
    assert.equal(r.sent, false, name);
    assert.equal(r.message, 'Kept a copy of your list (2 changes); this branch is sent to another place than it follows, so Work did not send it.', name);
    assert.equal(t.git(c.here, 'log', '-1', '--format=%s'), SUBJECT, name);
    assert.deepEqual(t.git(c.bare, 'for-each-ref', '--format=%(refname) %(subject)').split('\n'), ['refs/heads/main Start'], `${name}: nothing on the server it follows`);
    assert.deepEqual(t.git(fork, 'for-each-ref', '--format=%(refname) %(subject)').split('\n'), ['refs/heads/main Start'], `${name}: nothing on the other place`);
  }
});
