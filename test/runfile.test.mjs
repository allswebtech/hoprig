// The run record's lock (src/runfile.mjs): released only by its holder, a stale one taken over by one waiter only, and
// never waited for longer than the hook can afford (Claude Code gives it 5 seconds).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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

test('twelve processes meet a stale lock at the same moment: one takes it over, and no change is lost', { timeout: 60_000 }, async () => {
  const file = record();
  fs.writeFileSync(`${file}.lock`, 'dead');
  age(file, -10_000);
  // Each one reads the count, holds the lock a little while, writes the count + 1: two holders at once would lose one.
  const child = `import { changeRun } from ${JSON.stringify(RUNFILE)};
    const start = Number(process.argv[1]);
    while (Date.now() < start) {}
    changeRun(process.argv[2], (r) => { const end = Date.now() + 5; while (Date.now() < end) {} return { ...r, count: r.count + 1 }; });`;
  const start = Date.now() + 1500;
  await Promise.all(Array.from({ length: 12 }, () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child, String(start), file], { stdio: 'inherit' });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`child ended with ${code}`))));
  })));
  assert.equal(readRun(file).count, 12);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});
