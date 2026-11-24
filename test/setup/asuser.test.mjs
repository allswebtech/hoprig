// The one way a step runs as the work user: runuser with the address of the user's service manager. A stand-in
// runuser (first on PATH, in the test's own folder) writes down its arguments and runs the rest, so the environment
// the step gets is seen too. No real runuser, su or systemctl is reached.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fakeBin, pathWith, scratch } from './helpers.mjs';
import { sealed, sealedPath } from '../seal.mjs';

const s = scratch();
test.after(s.cleanup);
const A = await import('../../src/setup/asuser.mjs');
const { capture } = await import('../../src/setup/system.mjs');

const user = { name: 'hoprig', uid: 1001, home: '/home/hoprig' };

test('the step as the user names XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS, and a PATH of its own', () => {
  const argv = A.asUserArgv(user, ['systemctl', '--user', 'daemon-reload'], { nodeBin: '/home/hoprig/.nvm/versions/node/v24.11.0/bin' });
  assert.deepEqual(argv, [
    'runuser', '-u', 'hoprig', '--',
    'env', 'HOME=/home/hoprig', 'USER=hoprig', 'LOGNAME=hoprig',
    'XDG_RUNTIME_DIR=/run/user/1001', 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus',
    'PATH=/home/hoprig/.local/bin:/home/hoprig/.nvm/versions/node/v24.11.0/bin:/usr/local/bin:/usr/bin:/bin',
    'systemctl', '--user', 'daemon-reload',
  ]);
  // No Node of the user's own yet: its PATH has no empty part.
  assert.ok(A.asUserArgv(user, ['id']).includes('PATH=/home/hoprig/.local/bin:/usr/local/bin:/usr/bin:/bin'));
  // Anything that is not a plain user, or not an array of words, is refused before anything is built.
  for (const bad of [{ ...user, name: 'Root' }, { ...user, name: 'a b' }, { ...user, uid: 0 }, { ...user, uid: '1001' }, { ...user, home: 'home/x' }, null]) {
    assert.throws(() => A.asUserArgv(bad, ['id']), /user/, JSON.stringify(bad));
  }
  assert.throws(() => A.asUserArgv(user, 'systemctl --user'), /nothing to run/);
  assert.throws(() => A.asUserArgv(user, []), /nothing to run/);
  assert.throws(() => A.asUserArgv(user, ['id', 7]), /nothing to run/);
});

test("the user's own Node: the newest nvm version, by number, not by name", () => {
  const readdir = () => ['v22.9.0', 'v22.10.0', 'v24.1.0', 'v24.11.0', 'system', '.cache'];
  assert.equal(A.userNodeBin('/home/hoprig', { readdir }), '/home/hoprig/.nvm/versions/node/v24.11.0/bin');
  assert.equal(A.userNodeBin('/home/hoprig', { readdir: () => ['v22.9.0', 'v22.10.0'] }), '/home/hoprig/.nvm/versions/node/v22.10.0/bin');
  assert.equal(A.userNodeBin('/home/hoprig', { readdir: () => { throw new Error('ENOENT'); } }), '');
  assert.equal(A.userNodeBin('/home/hoprig', { readdir: () => [] }), '');
});

test('a stand-in runuser is asked once, with the argv as an array, and the step gets the address of the user manager', { skip: process.platform === 'win32' && 'runuser is Linux' }, async () => {
  const rec = path.join(s.tmp, 'runuser.log');
  const envRec = path.join(s.tmp, 'step-env.log');
  // runuser -u NAME -- CMD…: written down one word a line, then CMD run (here env, which sets the variables and runs
  // the stand-in step that writes what it was given).
  const bin = fakeBin(path.join(s.tmp, 'bin'), {
    runuser: `printf '%s\\n' "$@" > "${rec}"; [ "$1" = -u ] && [ "$3" = -- ] || exit 9; shift 3; exec "$@"`,
    'step-standin': `printf 'HOME=%s\\nUSER=%s\\nLOGNAME=%s\\nXDG_RUNTIME_DIR=%s\\nDBUS_SESSION_BUS_ADDRESS=%s\\nPATH=%s\\nARGS=%s\\n' "$HOME" "$USER" "$LOGNAME" "$XDG_RUNTIME_DIR" "$DBUS_SESSION_BUS_ADDRESS" "$PATH" "$*" > "${envRec}"`,
  });
  // env finds the step by the PATH runuser hands it, so the step's own bin folder is the user's ~/.local/bin.
  const home = path.join(s.tmp, 'user-home');
  fs.mkdirSync(path.join(home, '.local'), { recursive: true });
  fs.symlinkSync(bin, path.join(home, '.local', 'bin'));
  const env = sealed({ PATH: sealedPath(pathWith(s.tmp, bin) + ':/usr/bin:/bin') });
  const r = await A.runAsUser({ name: 'hoprig', uid: 1001, home }, ['step-standin', 'a b', '$(id)'], {
    has: (c) => c === 'runuser',
    run: (argv, o) => capture(argv, { ...o, env }),
    readdir: () => ['v24.11.0'],
  });
  assert.equal(r.ok, true, r.stderr);
  const words = fs.readFileSync(rec, 'utf8').trim().split('\n');
  assert.deepEqual(words.slice(0, 4), ['-u', 'hoprig', '--', 'env']);
  assert.ok(words.includes('XDG_RUNTIME_DIR=/run/user/1001'));
  assert.ok(words.includes('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus'));
  // Each word stayed one word: no shell string was built from them.
  assert.deepEqual(words.slice(-3), ['step-standin', 'a b', '$(id)']);
  const got = Object.fromEntries(fs.readFileSync(envRec, 'utf8').trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  assert.equal(got.HOME, home);
  assert.equal(got.USER, 'hoprig');
  assert.equal(got.LOGNAME, 'hoprig');
  assert.equal(got.XDG_RUNTIME_DIR, '/run/user/1001');
  assert.equal(got.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1001/bus');
  assert.ok(got.PATH.startsWith(`${home}/.local/bin:${home}/.nvm/versions/node/v24.11.0/bin:`), got.PATH);
  assert.equal(got.ARGS, 'a b $(id)');
});

test('without runuser the step stops with one line and nothing is started', async () => {
  const asked = [];
  const r = await A.runAsUser(user, ['systemctl', '--user', 'start', 'hoprig'], { has: () => false, run: async (a) => (asked.push(a), { ok: true }), readdir: () => [] });
  assert.equal(r.ok, false);
  assert.equal(r.stderr, A.NO_RUNUSER);
  assert.deepEqual(asked, []);
});

test("the user manager's socket is waited for, bounded", async () => {
  let n = 0;
  const looked = [];
  const ok = await A.waitForBus(1001, { limitMs: 2000, stepMs: 500, sleep: async () => {}, isSocket: (p) => (looked.push(p), ++n >= 3) });
  assert.equal(ok, true);
  assert.deepEqual([...new Set(looked)], ['/run/user/1001/bus']);
  n = -100;
  let slept = 0;
  assert.equal(await A.waitForBus(1001, { limitMs: 2000, stepMs: 500, sleep: async () => slept++, isSocket: () => false }), false);
  assert.equal(slept, 4, 'it gave up at the limit');
});
