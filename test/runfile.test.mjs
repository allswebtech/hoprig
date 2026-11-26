// The run record's lock (src/runfile.mjs): released only by its holder, a stale one taken over by one waiter only, and
// never waited for longer than the hook can afford (Claude Code gives it 5 seconds).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { changeRun, lockRun, readRun, writeRun } = await import('../src/runfile.mjs');
const RUNFILE = fileURLToPath(new URL('../src/runfile.mjs', import.meta.url));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-runfile-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const record = () => {
  const file = path.join(tmp, `run-${++n}.json`);
  writeRun(file, { count: 0 });
  return file;
};
const age = (file, ms) => {
  const t = new Date(Date.now() + ms);
  fs.utimesSync(`${file}.lock`, t, t);
};

test('a lock whose time lies in the future (a clock set back) is taken over at once, not waited for', () => {
  const file = record();
  fs.writeFileSync(`${file}.lock`, 'someone');
  age(file, 3600_000);
  const t = Date.now();
  changeRun(file, (r) => ({ ...r, count: r.count + 1 }));
  assert.ok(Date.now() - t < 500, `${Date.now() - t} ms`);
  assert.equal(readRun(file).count, 1);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'and released');
});

test('a lock is released only by its holder: one that was taken over stays with the one who took it', () => {
  const file = record();
  const first = lockRun(file);
  age(file, -10_000); // the first holder took too long: its lock counts as left over
  const second = lockRun(file);
  first();
  assert.equal(fs.existsSync(`${file}.lock`), true, 'the first one\'s release left the second one\'s lock alone');
  second();
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.deepEqual(fs.readdirSync(tmp).filter((f) => f.startsWith(path.basename(file)) && f !== path.basename(file)), [], 'nothing moved aside is left');
});

test('a lock of another is waited for only until it is a second old, then taken over: the hook never waits longer', () => {
  const file = record();
  fs.writeFileSync(`${file}.lock`, 'another');
  const t = Date.now();
  changeRun(file, (r) => ({ ...r, count: r.count + 1 }));
  const ms = Date.now() - t;
  assert.ok(ms >= 900 && ms < 2500, `${ms} ms`);
  assert.equal(readRun(file).count, 1);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

// Windows: while one holder removes its lock, a new one there is refused with EPERM (the name is still taken until the
// removal is through). That is a taken lock, waited for as EEXIST is; elsewhere EPERM stays "no lock can be made here".
test('Windows: a lock refused with EPERM while another removes it is waited for, not given up', (t) => {
  const file = record();
  const { writeFileSync } = fs;
  let refusals = 0;
  t.after(() => (fs.writeFileSync = writeFileSync));
  fs.writeFileSync = function (p, ...rest) {
    if (p === `${file}.lock` && refusals < 3) {
      refusals++;
      throw Object.assign(new Error('EPERM: operation not permitted, open'), { code: 'EPERM' });
    }
    return writeFileSync.call(fs, p, ...rest);
  };
  const win = lockRun(file, { platform: 'win32' });
  assert.equal(win.held, true, 'held once the removal is through');
  assert.equal(refusals, 3);
  win();
  refusals = 0;
  assert.equal(lockRun(file, { platform: 'linux' }).held, false, 'elsewhere as before: no lock can be made here');
  assert.equal(refusals, 1);
});

// Windows: a record another program holds open for a moment (a virus scan of a file just written) refuses a read or a
// replace with EPERM until it lets go; that is tried again. Elsewhere those errors stand as they are.
test('Windows: a record held open for a moment is read and replaced once it is let go; elsewhere not tried again', (t) => {
  const file = record();
  const { readFileSync, renameSync } = fs;
  let refusals = 0;
  const busy = () => {
    if (refusals < 3) {
      refusals++;
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    }
  };
  t.after(() => Object.assign(fs, { readFileSync, renameSync }));
  fs.renameSync = function (from, to) {
    if (to === file) busy();
    return renameSync.call(fs, from, to);
  };
  fs.readFileSync = function (p, ...rest) {
    if (p === file) busy();
    return readFileSync.call(fs, p, ...rest);
  };
  writeRun(file, { count: 5 }, { platform: 'win32' });
  assert.equal(refusals, 3);
  refusals = 0;
  assert.deepEqual(readRun(file, { platform: 'win32' }), { count: 5 });
  assert.equal(refusals, 3);
  refusals = 0;
  assert.throws(() => writeRun(file, { count: 6 }, { platform: 'linux' }), { code: 'EPERM' });
  refusals = 0;
  assert.equal(readRun(file, { platform: 'linux' }), null, 'elsewhere as before: a read that fails is no record');
  fs.rmSync(`${file}.${process.pid}.tmp`, { force: true });
});

// Processes that meet a stale lock at one moment, each running `step` (a change of the count under the lock) after
// waiting for `start`; each says whether it had the lock or gave up waiting (by design after 1.5 seconds).
// Imported by its file URL: an ES module import of a Windows path (C:\…) is read as a URL of scheme "c:" and refused.
const STEP = `import { lockRun, readRun, writeRun } from ${JSON.stringify(pathToFileURL(RUNFILE).href)};
  const nap = new Int32Array(new SharedArrayBuffer(4));
  const [start, file, gap] = process.argv.slice(1).map((a, i) => (i === 1 ? a : Number(a)));
  while (Date.now() < start) {}
  const release = lockRun(file, { pause: () => gap && Atomics.wait(nap, 0, 0, gap) });
  // Each one reads the count, holds the lock a little while, writes the count + 1: two holders at once would lose one.
  const r = readRun(file); const end = Date.now() + 5; while (Date.now() < end) {}
  writeRun(file, { ...r, count: r.count + 1 });
  release();
  process.stdout.write(release.held ? 'held' : 'gave up');`;
async function meet(count, gap = 0) {
  const file = record();
  fs.writeFileSync(`${file}.lock`, 'dead');
  age(file, -10_000);
  const start = Date.now() + 1500;
  const said = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', STEP, String(start), file, String(gap)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`child ended with ${code}: ${err.trim()}`))));
  })));
  return { file, said };
}

test('twelve processes meet a stale lock at the same moment: one takes it over, and no change is lost', { timeout: 60_000 }, async () => {
  const { file, said } = await meet(12);
  // A process that gave up waiting changes the record without the lock (by design: the hook never waits longer); that is
  // a slow computer, not a lost change, and is said as such.
  assert.deepEqual(said, Array(12).fill('held'), 'every process had the lock');
  assert.equal(readRun(file).count, 12);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a take-over held open: eight processes pause 30 ms inside each step of taking a stale lock over, six rounds, and no change is lost', { timeout: 120_000 }, async () => {
  // While a stale lock was moved aside its name stood empty: a newcomer made a lock there, and a waiter that had judged
  // the old one stale moved the newcomer's away and held as well (two holders; on a slow CI runner one change of
  // twelve was lost). The pauses make that moment last.
  for (let round = 0; round < 6; round++) {
    const { file, said } = await meet(8, 30);
    assert.deepEqual(said, Array(8).fill('held'), `round ${round}: every process had the lock`);
    assert.equal(readRun(file).count, 8, `round ${round}`);
    assert.equal(fs.existsSync(`${file}.lock`), false);
    assert.equal(fs.existsSync(`${file}.lock.takeover`), false);
  }
});
