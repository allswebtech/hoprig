// One move at a time on a server (src/setup/movelock.mjs, movecli.mjs): the page's move process, a terminal's
// `hoprig move-to-user --yes` and the hub's move over SSH all take one lock file in root's state folder. A second move
// while one runs starts nothing and says so; a lock whose process is gone is taken over; a look alone takes none.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { scratch } from './helpers.mjs';

const s = scratch();
test.after(s.cleanup);
const L = await import('../../src/setup/movelock.mjs');
const M = await import('../../src/setup/movecli.mjs');

const state = path.join(s.tmp, 'root/.local/state/hoprig');
const dirs = { config: path.join(s.tmp, 'root/.config/hoprig'), state, claude: path.join(s.tmp, 'root/.claude'), workspace: path.join(s.tmp, 'root/Workspace') };
const lockFile = path.join(state, L.LOCK_FILE);

test('the lock: one holder; a second is refused with the holder\'s pid; a dead holder is taken over; release is the holder\'s own', () => {
  const a = L.takeLock(state, { pid: 4242, alive: (p) => p === 4242 });
  assert.equal(a.ok, true);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '4242\n');
  assert.deepEqual(L.takeLock(state, { pid: 4343, alive: (p) => p === 4242 }), { ok: false, pid: 4242 });
  // 4242 is gone (killed, a reboot): the next move takes it over.
  const b = L.takeLock(state, { pid: 4343, alive: (p) => p === 4343 });
  assert.equal(b.ok, true);
  a.release();
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '4343\n', "an old holder's release leaves the new holder's lock");
  b.release();
  assert.equal(fs.existsSync(lockFile), false);
});

test('the lock file never exists empty; one that is empty anyway is held while young and taken over when old', () => {
  fs.mkdirSync(state, { recursive: true });
  // A whole lock, and nothing of its own left beside it (the pid was written apart and linked into place).
  const a = L.takeLock(state, { pid: 4242, alive: () => true });
  assert.equal(a.ok, true);
  assert.deepEqual(fs.readdirSync(state), [L.LOCK_FILE]);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '4242\n');
  a.release();
  // An empty lock file (an older Hoprig that has made it and not yet written its pid, or one that crashed there).
  fs.writeFileSync(lockFile, '');
  const made = fs.statSync(lockFile).mtimeMs;
  const young = L.takeLock(state, { pid: 4343, alive: () => true, now: () => made + L.YOUNG_EMPTY_MS - 1000 });
  assert.deepEqual(young, { ok: false, pid: null }, 'a young empty lock is held');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '', 'and left as it was');
  assert.deepEqual(L.lockHolder(state, { now: () => made + 1000 }), { pid: null });
  assert.equal(L.HELD_LINE(null, state), `Another move runs on this server now, so this one does not start. Wait until it ends, then run the move again. If no move runs, remove ${lockFile}.`);
  const old = L.takeLock(state, { pid: 4343, alive: () => true, now: () => made + L.YOUNG_EMPTY_MS + 1000 });
  assert.equal(old.ok, true, 'an old empty lock is taken over');
  assert.equal(fs.readFileSync(lockFile, 'utf8'), '4343\n');
  old.release();
  assert.deepEqual(fs.readdirSync(state), []);
});

test("a lock's own file that a crash left is removed by the next move, and one of a move that runs is kept", () => {
  fs.mkdirSync(state, { recursive: true });
  // Killed between writing its pid and linking it (kill -9, a power loss): 999999 is gone, 4242 still runs.
  const dead = path.join(state, '.move.lock.999999.deadbeef');
  const live = path.join(state, '.move.lock.4242.abcd1234');
  fs.writeFileSync(dead, '999999\n');
  fs.writeFileSync(live, '4242\n');
  const a = L.takeLock(state, { pid: 4343, alive: (p) => p === 4343 || p === 4242 });
  assert.equal(a.ok, true);
  a.release();
  assert.deepEqual(fs.readdirSync(state), ['.move.lock.4242.abcd1234']);
  fs.rmSync(live);
});

test('a move while another runs starts nothing and says which process holds it; a dry run still looks', async () => {
  // The other move is a live process of this test (its parent), not this one.
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(lockFile, `${process.ppid}\n`);
  const out = [];
  // Every call gets the look's stand-ins (programs, the disk, Work), so a lock that does not hold stops at the look
  // in this test, never at a real program: the Work stand-in answers one running task.
  const io = { home: path.join(s.tmp, 'root'), uid: 0, dirs, run: async () => ({ ok: false, code: 2, stdout: '' }), statfs: () => ({ bavail: 1e7, bsize: 4096 }), workRunning: async () => 1 };
  const steps = new Proxy({}, { get: (t, k) => () => { throw new Error(`step ${String(k)} ran`); } });
  assert.equal(await M.main(['--yes'], { io, cfg: {}, steps, out: (l) => out.push(l), err: (l) => out.push(l) }), 1);
  assert.deepEqual(out, [L.HELD_LINE(process.ppid, state)]);
  assert.match(out[0], /^Another move runs on this server now \(process \d+\), so this one does not start\./);
  assert.equal(fs.readFileSync(lockFile, 'utf8'), `${process.ppid}\n`, "the other move's lock is left as it was");
  // A look alone takes no lock, and a run that is not root neither: each goes on to the look, which says there is
  // nothing to move, also when root's state folder cannot be written.
  for (const [args, given] of [[['--dry-run'], { ...io, uid: 1000 }], [['--yes'], { ...io, uid: 1000 }], [['--yes'], { ...io, uid: 1000, dirs: { ...dirs, state: '/nonexistent-made-up/state' } }]]) {
    out.length = 0;
    assert.equal(await M.main(args, { io: given, cfg: {}, steps, out: (l) => out.push(l), err: (l) => out.push(l) }), 1);
    assert.deepEqual(out, ['Hoprig does not run as root here: there is nothing to move.'], args.join(' '));
  }
  fs.rmSync(lockFile);
  // With no other move, the move takes the lock while it looks and lets it go at its end. The look stops (Work runs
  // a task), so no step of the move runs: every step is the Proxy above, which throws.
  let held = null;
  out.length = 0;
  const code = await M.main(['--yes'], { io: { ...io, workRunning: async () => ((held = fs.readFileSync(lockFile, 'utf8')), 1) }, cfg: {}, steps, out: (l) => out.push(l), err: (l) => out.push(l) });
  assert.equal(code, 1, out.join('\n'));
  assert.match(out.join('\n'), /STOP: Work is running 1 task/);
  assert.equal(held, `${process.pid}\n`, out.join('\n'));
  assert.equal(fs.existsSync(lockFile), false, 'let go at the end');
});
