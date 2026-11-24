// One go-live of a project at a time (src/ship/lock.mjs): the lock lies in the repository's git folder, never in its
// working tree; a second taker is refused while the holder lives (also another process); the lock of a process that
// is gone is taken over.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempShip } from './helpers.mjs';

const t = tempShip('ship-lock');
test.after(() => t.cleanup());
const { gitFolder, takeLock, lockHolder, LOCK_NAME } = await import('../../src/ship/lock.mjs');
const { system } = await import('../../src/procid.mjs');
const shop = path.join(t.projects, 'shop');
t.repo(shop);

test('the lock is in the git folder; a second take is refused until it is released', async () => {
  const folder = await gitFolder(shop);
  assert.equal(folder, path.join(shop, '.git'));
  const release = takeLock(folder, 'go live');
  assert.ok(fs.existsSync(path.join(folder, LOCK_NAME)));
  assert.equal(t.git(shop, 'status', '--porcelain'), '', 'git does not see it');
  assert.throws(() => takeLock(folder, 'go live'), (e) => e.status === 409 && /already/.test(e.message));
  release();
  assert.equal(lockHolder(folder), null);
  takeLock(folder, 'go live')();
});

test('another living process holds it: refused; that process gone: taken over', async () => {
  const folder = await gitFolder(shop);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const proc = system.of([child.pid]).get(child.pid);
    fs.writeFileSync(path.join(folder, LOCK_NAME), JSON.stringify({ pid: child.pid, proc, what: 'go live', at: new Date().toISOString() }));
    assert.throws(() => takeLock(folder, 'go live'), (e) => e.status === 409 && new RegExp(`process ${child.pid}`).test(e.message));
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
  }
  assert.equal(lockHolder(folder).gone, true);
  const release = takeLock(folder, 'go live');
  assert.equal(JSON.parse(fs.readFileSync(path.join(folder, LOCK_NAME), 'utf8')).pid, process.pid);
  release();
});
