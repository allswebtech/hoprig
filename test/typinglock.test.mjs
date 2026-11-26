// The typing lock (src/typinglock.mjs) let go after its work: a lock that cannot be removed then (a removal refused,
// on Windows by a process that touches the file, for longer than its patience) is no error of that work. The route
// that typed a message answers what it typed, never an error for a message already in the terminal; the launcher's
// record is gone all the same; and the lock left is taken over by the next typist once it is stale.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'typinglock-'));
process.env.HOPRIG_STATE_DIR = path.join(tmp, 'state');
process.env.HOPRIG_CONFIG_DIR = path.join(tmp, 'config');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { lockOf, removeLocked, whileTyping } = await import('../src/typinglock.mjs');

/** Every removal of `lock` refused with EIO, for the rest of this test. */
function refusing(t, lock) {
  const rm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (p, o) => {
    if (p === lock) throw Object.assign(new Error(`EIO: i/o error, rm '${p}'`), { code: 'EIO' });
    return rm(p, o);
  });
}

test('a message typed under a lock that cannot be removed afterwards is answered as typed, not as an error', async (t) => {
  const run = path.join(tmp, 'a.json');
  fs.writeFileSync(run, '{}');
  refusing(t, lockOf(run));
  assert.equal(await whileTyping(run, async () => 'typed'), 'typed');
  assert.ok(fs.existsSync(lockOf(run)), 'the lock is left');
  t.mock.restoreAll();
  // Left: stale after its time, then the next typist takes it (aged here instead of waited out).
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lockOf(run), old, old);
  assert.equal(await whileTyping(run, async () => 'again', { wait: 500 }), 'again');
  assert.ok(!fs.existsSync(lockOf(run)));
});

test('the launcher removes its record under a lock that cannot be removed afterwards without an error', (t) => {
  const run = path.join(tmp, 'b.json');
  fs.writeFileSync(run, '{}');
  refusing(t, lockOf(run));
  assert.equal(removeLocked(run, (f) => fs.unlinkSync(f)), false);
  assert.ok(!fs.existsSync(run), 'the record is gone');
});
