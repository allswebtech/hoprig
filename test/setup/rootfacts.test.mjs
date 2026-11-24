import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const R = await import('../../src/setup/rootfacts.mjs');

const none = () => false;
const only = (...files) => (f) => files.includes(f);

test('root is user id 0 on Linux and macOS, never on Windows', () => {
  assert.equal(R.rootFacts({ uid: 0, platform: 'linux', exists: none, env: {} }).root, true);
  assert.equal(R.rootFacts({ uid: 0, platform: 'darwin', exists: none, env: {} }).root, true);
  assert.equal(R.rootFacts({ uid: 1000, platform: 'linux', exists: none, env: {} }).root, false);
  assert.equal(R.rootFacts({ uid: null, platform: 'win32', exists: none, env: {} }).root, false);
  assert.equal(R.rootFacts({ uid: 0, platform: 'win32', exists: none, env: {} }).root, false);
});

test('a container is told by named facts, each said as it was found', () => {
  assert.deepEqual(R.containerFacts({ exists: none, env: {} }), []);
  assert.deepEqual(R.containerFacts({ exists: only('/.dockerenv'), env: {} }), ['/.dockerenv']);
  assert.deepEqual(R.containerFacts({ exists: only('/run/.containerenv', '/run/systemd/container'), env: {} }), ['/run/.containerenv', '/run/systemd/container']);
  assert.deepEqual(R.containerFacts({ exists: none, env: { container: 'podman' } }), ['container=podman']);
  // An empty variable is no fact; a value is cut to plain characters (it is shown on a page).
  assert.deepEqual(R.containerFacts({ exists: none, env: { container: '' } }), []);
  assert.deepEqual(R.containerFacts({ exists: none, env: { container: 'lxc<b>' } }), ['container=lxcb']);
  // A file that cannot be looked at is not a fact.
  assert.deepEqual(R.containerFacts({ exists: () => { throw new Error('EACCES'); }, env: {} }), []);
});

test('staying root is the owner\'s choice in the settings, true only', () => {
  assert.equal(R.rootFacts({ uid: 0, platform: 'linux', exists: none, env: {}, cfg: { stayRoot: true } }).stay, true);
  assert.equal(R.rootFacts({ uid: 0, platform: 'linux', exists: none, env: {}, cfg: { stayRoot: 'yes' } }).stay, false);
  assert.equal(R.rootFacts({ uid: 0, platform: 'linux', exists: none, env: {}, cfg: {} }).stay, false);
  assert.equal(R.rootFacts({ uid: 0, platform: 'linux', exists: none, env: {}, cfg: null }).stay, false);
});

// No home of these tests has the file mark unless a test says so: the computer's real /home is never looked at.
const noFile = { lstat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); } };

test('the comment field alone is never the mark: chfn may let any user write it', () => {
  const made = R.passwdEntry('hoprig:x:1001:1001:Hoprig work user:/home/hoprig:/bin/bash');
  assert.deepEqual(made, { name: 'hoprig', uid: 1001, gid: 1001, comment: 'Hoprig work user', home: '/home/hoprig', shell: '/bin/bash' });
  assert.equal(R.madeByHoprig(made, noFile), false);
  assert.equal(R.madeByHoprig(R.passwdEntry('hoprig:x:1001:1001:Hoprig work user,,,:/home/hoprig:/bin/bash'), noFile), false);
  assert.equal(R.madeByHoprig(null, noFile), false);
  for (const bad of ['', 'hoprig:x:1001', 'hoprig:x:a:1001:c:/h:/s', ':x:1:1:c:/h:/s']) assert.equal(R.passwdEntry(bad), null, bad);
});

test('"made by Hoprig" by the file mark in its home: owned by root, one name, its one line; one the user wrote never counts', () => {
  const looked = [];
  const statOf = (files) => ({
    lstat: (p) => {
      looked.push(p);
      const f = files[p];
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isFile: () => f.file !== false, uid: f.uid, nlink: f.nlink ?? 1, size: (f.text ?? '').length };
    },
    readFile: (p) => files[p].text,
  });
  const empty = R.passwdEntry('hoprig:x:1001:1001::/home/hoprig:/bin/bash');
  const at = '/home/hoprig/.hoprig-made-by-move';
  const line = R.markText('hoprig');
  assert.equal(R.MOVE_MARK_FILE, '.hoprig-made-by-move');
  assert.equal(line, 'Hoprig work user hoprig\n');
  assert.equal(R.madeByHoprig(empty, statOf({ [at]: { uid: 0, text: line } })), true);
  assert.deepEqual(looked, [at]);
  // The user owns his home: a file he wrote there is his own, and counts for nothing (it would give him sudo).
  assert.equal(R.madeByHoprig(empty, statOf({ [at]: { uid: 1001, text: line } })), false);
  // A file of root's he moved into that name (another text), or a second name of one (a hard link): not the mark.
  assert.equal(R.madeByHoprig(empty, statOf({ [at]: { uid: 0, text: 'something of root\'s\n' } })), false);
  assert.equal(R.madeByHoprig(empty, statOf({ [at]: { uid: 0, text: line, nlink: 2 } })), false);
  assert.equal(R.madeByHoprig(empty, statOf({ [at]: { uid: 0, text: R.markText('hoprig2') } })), false, "another user's mark");
  // No file, or a folder of that name: not ours.
  assert.equal(R.madeByHoprig(empty, statOf({})), false);
  assert.equal(R.madeByHoprig(empty, statOf({ [at]: { uid: 0, text: line, file: false } })), false);
  // A home that is not a whole path is never looked in.
  looked.length = 0;
  assert.equal(R.madeByHoprig(R.passwdEntry('hoprig:x:1001:1001::home/hoprig:/bin/bash'), statOf({})), false);
  assert.deepEqual(looked, []);
  // What a user Hoprig makes gets: the comment and the mark (a home written with a / at its end is the same home).
  const both = R.passwdEntry('hoprig:x:1001:1001:Hoprig work user:/home/hoprig/:/bin/bash');
  assert.equal(R.madeByHoprig(both, statOf({ [at]: { uid: 0, text: line } })), true);
});

test('a user is read with getent, by a name that is checked first', async () => {
  const asked = [];
  const run = async (argv) => {
    asked.push(argv);
    if (argv[2] === 'hoprig') return { ok: true, code: 0, stdout: 'hoprig:x:1001:1001:Hoprig work user:/home/hoprig:/bin/bash\n', stderr: '' };
    return { ok: false, code: 2, stdout: '', stderr: '' };
  };
  assert.equal((await R.lookUser('hoprig', { run })).uid, 1001);
  assert.equal(await R.lookUser('hoprig2', { run }), null);
  assert.deepEqual(asked, [['getent', 'passwd', 'hoprig'], ['getent', 'passwd', 'hoprig2']]);
  for (const bad of ['', 'Root', '-x', 'a b', 'a:b', '../x', 'x'.repeat(33)]) await assert.rejects(R.lookUser(bad, { run }), /not a user name/, bad);
  assert.equal(asked.length, 2, 'no bad name reached getent');
});

test('the root line after a move that switched: "moved to <user>", never the move offered again', () => {
  const live = { user: 'hoprig', state: 'switched', switchedAt: '2026-11-20T10:06:00.000Z' };
  const f = R.rootFacts({ uid: 0, platform: 'linux', exists: () => false, env: {}, mark: () => live });
  assert.deepEqual(f.moved, { user: 'hoprig', since: '2026-11-20T10:06' });
  const line = R.rootCheck(f);
  assert.equal(line.status, 'info');
  assert.match(line.detail, /^moved to hoprig since 2026-11-20T10:06Z: Hoprig works as hoprig now, and this is root's kept copy\. Back to root's: hoprig move-to-user --back$/);
  assert.equal(line.fix, '', 'the move is not offered again');
  // After --back (or no mark): the suggestion with the move, as before.
  for (const m of [{ ...live, state: 'back' }, null]) assert.match(R.rootCheck(R.rootFacts({ uid: 0, platform: 'linux', exists: () => false, env: {}, mark: () => m })).fix, /^hoprig move-to-user\b/);
});

test('the root line: none for an ordinary user; a suggestion with the move; information when on purpose', async () => {
  assert.equal(R.rootCheck({ root: false, container: [], stay: false }), null);
  const plain = R.rootCheck({ root: true, container: [], stay: false });
  assert.equal(plain.status, 'warn');
  assert.equal(plain.label, 'Runs as root');
  assert.match(plain.detail, /Hoprig works as root here/);
  assert.ok(plain.detail.includes(R.CLAUDE_ROOT_REFUSAL), 'the coding tool\'s own words');
  // Health shows the fix with a Copy button: it is the command alone, which a shell runs as it is.
  assert.equal(plain.fix, 'hoprig move-to-user');
  assert.equal((await import('node:child_process')).spawnSync('sh', ['-n', '-c', plain.fix]).status, 0);
  assert.match(plain.detail, /shows each step and asks first/);
  const boxed = R.rootCheck({ root: true, container: ['/.dockerenv'], stay: false });
  assert.equal(boxed.status, 'info');
  assert.match(boxed.detail, /on purpose, inside a container \(\/\.dockerenv\)/);
  assert.ok(boxed.detail.includes(R.CLAUDE_ROOT_REFUSAL));
  assert.equal(boxed.fix, '', 'nothing nags on purpose');
  const chosen = R.rootCheck({ root: true, container: [], stay: true });
  assert.equal(chosen.status, 'info');
  assert.match(chosen.detail, /kept on root by your choice/);
});
