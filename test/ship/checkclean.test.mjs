// The clean-up after a check can never hold check.lock (src/ship/check.mjs): a folder a check made read-only, or one a
// process the check left in the background still writes into, is made writable and tried once more, else said and
// left; what the check started (its process group) ends with it; and a new process on the same state folder (a
// restarted dashboard) checks again as before.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempShip } from './helpers.mjs';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'check-child.mjs');
const t = tempShip('ship-checkclean');
// A folder left read-only by a failed run must not stop the test's own clean-up either.
const writable = (d) => {
  try {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) writable(path.join(d, e.name));
    fs.chmodSync(d, 0o700);
  } catch {
    /* gone */
  }
};
test.after(() => {
  writable(t.root);
  t.cleanup();
});
const { runCheck, verdict } = await import('../../src/ship/check.mjs');
const { allow } = await import('../../src/ship/allow.mjs');
const { readCheck } = await import('../../src/ship/project.mjs');
const idle = () => ({ over: false, why: null });
const runs = () => path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'checkruns');
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A check in another process on the same state folder, to its end. */
const inChild = (real) => new Promise((res) => spawn(process.execPath, [CHILD, real, real], { stdio: 'ignore' }).on('exit', res));

// Makes cache/ with a file in it and leaves it read-only, as module and build caches do.
const READONLY = "import fs from 'node:fs'; fs.mkdirSync('cache/m', { recursive: true }); fs.writeFileSync('cache/m/a.js', 'x'); fs.chmodSync('cache/m', 0o555); fs.chmodSync('cache', 0o555);\n";

test('a check that leaves a read-only folder: the lock is free, the next check passes, also in a new process', async () => {
  const shop = path.join(t.projects, 'shop');
  t.repo(shop, { 'project.json': JSON.stringify({ check: [['node', 'test.mjs']] }), 'test.mjs': READONLY });
  allow(shop, 'check', readCheck(shop).check);
  const one = await runCheck(shop, shop, { busy: idle });
  assert.equal(verdict(one).state, 'ready');
  const two = await runCheck(shop, shop, { busy: idle });
  assert.deepEqual([verdict(two).state, verdict(two).passed], ['ready', 2], 'the second check is not refused');
  assert.deepEqual(fs.readdirSync(runs()), [], 'the folder went: made writable and tried again');
  assert.equal(fs.existsSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'check.lock')), false);
  await inChild(shop);
  const three = await runCheck(shop, shop, { busy: idle });
  assert.deepEqual([verdict(three).state, verdict(three).passed], ['ready', 4], 'a check in another process, then here');
  assert.deepEqual(t.trapped(), []);
});

test('a folder left by a Hoprig that is gone, read-only: the next check (a restarted dashboard) still runs', async () => {
  const cafe = path.join(t.projects, 'cafe');
  t.repo(cafe, { 'project.json': JSON.stringify({ check: [['node', '-e', '0']] }) });
  allow(cafe, 'check', readCheck(cafe).check);
  // As a dashboard killed in its clean-up leaves it: a dead pid's folder that cannot be removed as it is, and its lock.
  const dead = spawn(process.execPath, ['-e', '0']);
  await new Promise((res) => dead.on('exit', res));
  const left = path.join(runs(), `${dead.pid}-0123456789ab`);
  fs.mkdirSync(path.join(left, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(left, 'cache', 'a.js'), 'x');
  fs.chmodSync(path.join(left, 'cache'), 0o555);
  fs.writeFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'ship', 'check.lock'), `${JSON.stringify({ pid: dead.pid, proc: null, what: 'check', at: new Date().toISOString() })}\n`);
  const rec = await runCheck(cafe, cafe, { busy: idle });
  assert.equal(verdict(rec).state, 'ready');
  assert.equal(fs.existsSync(left), false, 'the left folder is removed after all');
});

test('a check that leaves a process writing into its folder: that process ends with the check; the next one passes', async () => {
  const deli = path.join(t.projects, 'deli');
  const pidFile = path.join(t.root, 'writer.pid');
  // A child in the check's own process group (as `cmd &` makes one) that writes a new file every 20 ms for ever.
  const loop = "const fs = require('node:fs'); let i = 0; setInterval(() => fs.writeFileSync('w' + (i++ % 50) + '.log', 'x'), 20);";
  const start = `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(loop)}], { stdio: 'ignore' }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); setTimeout(() => {}, 200);`;
  t.repo(deli, { 'project.json': JSON.stringify({ check: [['node', '-e', start]] }) });
  allow(deli, 'check', readCheck(deli).check);
  const one = await runCheck(deli, deli, { busy: idle });
  assert.equal(verdict(one).state, 'ready');
  const writer = Number(fs.readFileSync(pidFile, 'utf8'));
  for (let i = 0; i < 40 && alive(writer); i++) await sleep(25);
  assert.equal(alive(writer), false, 'what the check started is ended with it');
  const two = await runCheck(deli, deli, { busy: idle });
  assert.deepEqual([verdict(two).state, verdict(two).passed], ['ready', 2]);
  // A process killed with its group is visible until it is reaped: the same wait as after the first check.
  for (let i = 0; i < 40 && alive(Number(fs.readFileSync(pidFile, 'utf8'))); i++) await sleep(25);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false, 'ended with the second check too');
  assert.deepEqual(fs.readdirSync(runs()), []);
  await inChild(deli);
  for (let i = 0; i < 40 && alive(Number(fs.readFileSync(pidFile, 'utf8'))); i++) await sleep(25);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false, 'also when another process ran the check');
  const three = await runCheck(deli, deli, { busy: idle });
  assert.deepEqual([verdict(three).state, verdict(three).passed], ['ready', 4]);
});
