// Every write of the spending record runs under its lock, not only take(): the rewrite that drops earlier days never
// drops a cost or a hold another dashboard on the same state folder wrote in between, and a day whose own entries are
// big is not rewritten on every write.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SpendLedger } from '../../src/assistant/spend.mjs';

const SPEND = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'assistant', 'spend.mjs')).href;
const run = (file, args) => new Promise((resolve) => {
  const p = spawn(process.execPath, [file, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (c) => (out += c));
  p.stderr.on('data', (c) => (err += c));
  p.on('close', (code) => resolve({ code, out, err }));
});

test('one dashboard records its costs while the other takes on a big file of earlier days: no cost is lost', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-writes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'assistant', 'spend.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const go = path.join(dir, 'go');
  const taker = path.join(dir, 'taker.mjs');
  const coster = path.join(dir, 'coster.mjs');
  // The taker keeps the file past 256 KB with lines of two days ago, so its writes rewrite the file.
  fs.writeFileSync(taker, `import fs from 'node:fs';
import { SpendLedger } from ${JSON.stringify(SPEND)};
const [file, go] = process.argv.slice(2);
const w = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(go)) Atomics.wait(w, 0, 0, 1);
const l = new SpendLedger({ file });
const old = JSON.stringify({ at: Date.now() - 2 * 86400000, kind: 'spent', usd: 0, what: 'x'.repeat(60) }) + '\\n';
const pad = old.repeat(Math.ceil(270 * 1024 / old.length));
let n = 0;
const end = Date.now() + 2000;
while (Date.now() < end) { fs.appendFileSync(file, pad); if (l.take(10000) === null) n++; }
process.stdout.write(String(n));
`);
  // The other dashboard: what her turns cost, $1 each.
  fs.writeFileSync(coster, `import fs from 'node:fs';
import { SpendLedger } from ${JSON.stringify(SPEND)};
const [file, go] = process.argv.slice(2);
const w = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(go)) Atomics.wait(w, 0, 0, 1);
const l = new SpendLedger({ file });
let n = 0;
const end = Date.now() + 2000;
while (Date.now() < end) { l.spent(1, 'her own turn'); n++; }
process.stdout.write(String(n));
`);
  const a = run(taker, [file, go]);
  const b = run(coster, [file, go]);
  await new Promise((res) => setTimeout(res, 300));
  fs.writeFileSync(go, '');
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.code, 0, ra.err);
  assert.equal(rb.code, 0, rb.err);
  const d = new SpendLedger({ file }).detail();
  assert.ok(Number(rb.out) > 0 && Number(ra.out) > 0, `costs ${rb.out}, holds ${ra.out}`);
  assert.equal(d.spent, Number(rb.out), `${rb.out} costs of $1 were written, and today's record has $${d.spent}`);
  // Counted as lines: a cost without a hold id settles the oldest hold without one in detail(), so its `unmeasured`
  // is not the number of holds here.
  const held = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)).filter((e) => e.kind === 'hold').length;
  assert.equal(held, Number(ra.out), `${ra.out} holds were given, and today's record has ${held}`);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n !== 'spend.jsonl'), [], 'a lock or a temporary file was left behind');
});

test('a dashboard whose rewrite holds the lock past the stale time while the other records costs: no cost is lost', { timeout: 60_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-slow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'assistant', 'spend.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = JSON.stringify({ at: Date.now() - 2 * 86400000, kind: 'spent', usd: 0, what: 'x'.repeat(60) }) + '\n';
  fs.writeFileSync(file, old.repeat(Math.ceil(270 * 1024 / old.length)));
  const held = path.join(dir, 'held');
  const holder = path.join(dir, 'holder.mjs');
  const coster = path.join(dir, 'coster.mjs');
  // The slow dashboard takes a hold by the ledger's own way (take), on a computer under load: the three steps of its
  // rewrite (the new file written, renamed over the record, its own line) take 1.9 s each, so it holds its one lock
  // for more than five seconds (STALE_MS), each step shorter than half of that. It says when it has the lock (its
  // rewrite has begun).
  fs.writeFileSync(holder, `import fs from 'node:fs';
import { SpendLedger } from ${JSON.stringify(SPEND)};
const [file, held] = process.argv.slice(2);
const w = new Int32Array(new SharedArrayBuffer(4));
const slow = () => Atomics.wait(w, 0, 0, 1900);
const { appendFileSync, renameSync, writeFileSync } = fs;
fs.writeFileSync = function (p, ...rest) {
  if (typeof p === 'string' && p.endsWith('.tmp')) { writeFileSync.call(fs, held, ''); slow(); }
  return writeFileSync.call(fs, p, ...rest);
};
fs.renameSync = function (from, to, ...rest) {
  if (to === file) slow();
  return renameSync.call(fs, from, to, ...rest);
};
fs.appendFileSync = function (p, ...rest) {
  if (p === file) slow();
  return appendFileSync.call(fs, p, ...rest);
};
const l = new SpendLedger({ file });
const t0 = Date.now();
let why = l.take(10000);
for (let i = 0; i < 5 && why && why.startsWith('another dashboard'); i++) why = l.take(10000);
process.stdout.write(JSON.stringify({ why, ms: Date.now() - t0 }));
`);
  // The other dashboard: two of her turns end while the slow one holds the lock, $1 each.
  fs.writeFileSync(coster, `import fs from 'node:fs';
import { SpendLedger } from ${JSON.stringify(SPEND)};
const [file, held] = process.argv.slice(2);
const w = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(held)) Atomics.wait(w, 0, 0, 1);
const l = new SpendLedger({ file });
l.spent(1, 'her own turn');
l.spent(1, 'her own turn');
`);
  const a = run(holder, [file, held]);
  const b = run(coster, [file, held]);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.code, 0, ra.err);
  assert.equal(rb.code, 0, rb.err);
  const r = JSON.parse(ra.out);
  assert.equal(r.why, null, `the slow dashboard's hold: ${r.why}`);
  assert.ok(r.ms > 5000, `the slow dashboard held the lock ${r.ms} ms, not past the stale time`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  const spent = lines.filter((e) => e.kind === 'spent' && e.usd === 1).length;
  assert.equal(spent, 2, `2 costs of $1 were written while the other dashboard rewrote the record, and the record has ${spent}`);
  assert.equal(lines.filter((e) => e.kind === 'hold').length, 1, 'the slow dashboard\'s hold is in the record');
  assert.equal(lines.every((e) => e.at >= Date.now() - 86400000), true, 'the earlier days were rewritten away');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n !== 'spend.jsonl'), [], 'a lock or a temporary file was left behind');
});

test('a step of the rewrite that took more than half the stale time gives the lock up: the write takes it again and writes its line only', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-giveup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  const old = JSON.stringify({ at: Date.now() - 2 * 86400000, kind: 'spent', usd: 0, what: 'x'.repeat(60) }) + '\n';
  fs.writeFileSync(file, old.repeat(Math.ceil(270 * 1024 / old.length)));
  const { openSync, readFileSync, renameSync, utimesSync } = fs;
  t.after(() => Object.assign(fs, { openSync, readFileSync, renameSync, utimesSync }));
  const w = new Int32Array(new SharedArrayBuffer(4));
  let takes = 0;
  let renames = 0;
  let slow = true;
  let keptAfterSlow = 0;
  fs.openSync = function (p, flags, ...rest) {
    const fd = openSync.call(fs, p, flags, ...rest);
    if (p === lock && flags === 'wx') takes++;
    return fd;
  };
  // The first read of the rewrite takes 2.6 s: more than half of STALE_MS. Another dashboard may then be about to take
  // the lock over, so it is not made fresh again, and nothing is renamed under it.
  fs.readFileSync = function (p, ...rest) {
    if (p === file && slow) {
      slow = false;
      Atomics.wait(w, 0, 0, 2600);
      const read = readFileSync.call(fs, p, ...rest);
      fs.utimesSync = function (q, ...r) {
        if (q === lock && takes === 1) keptAfterSlow++;
        return utimesSync.call(fs, q, ...r);
      };
      return read;
    }
    return readFileSync.call(fs, p, ...rest);
  };
  fs.renameSync = function (from, to, ...rest) {
    if (to === file) renames++;
    return renameSync.call(fs, from, to, ...rest);
  };
  new SpendLedger({ file }).spent(1, 'her own turn');
  Object.assign(fs, { openSync, readFileSync, renameSync, utimesSync });
  assert.equal(keptAfterSlow, 0, 'the lock was made fresh again after a step longer than half the stale time');
  assert.equal(takes, 2, `the write took the lock ${takes} times`);
  // The second time without the rewrite: a rewrite that is slow every time cannot keep the line out.
  assert.equal(renames, 0, `the record was rewritten ${renames} times under a lock given up or taken again`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  assert.deepEqual(lines.filter((e) => e.usd === 1).length, 1, 'the cost is written once');
  assert.equal(lines.length, Math.ceil(270 * 1024 / old.length) + 1, 'the earlier days are left for a later write');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== 'spend.jsonl'), [], 'a lock or a temporary file was left behind');
});

test('a day whose own entries are past the size is not rewritten; one with an earlier day is, once', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-size-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'spend.jsonl');
  const now = Date.now();
  const line = (at) => JSON.stringify({ at, kind: 'spent', usd: 0.001, what: 'y'.repeat(60) }) + '\n';
  fs.writeFileSync(file, line(now).repeat(Math.ceil(270 * 1024 / line(now).length)));
  const l = new SpendLedger({ file });
  const ino = fs.statSync(file).ino;
  // A rewrite is a file renamed over the record (appendFileSync goes through writeFileSync, so that is not counted).
  const { renameSync } = fs;
  let rewrites = 0;
  fs.renameSync = function (from, to, ...rest) {
    if (to === file) rewrites++;
    return renameSync.call(fs, from, to, ...rest);
  };
  t.after(() => (fs.renameSync = renameSync));
  for (let i = 0; i < 5; i++) l.spent(0.5, 'turn');
  assert.equal(rewrites, 0, 'today\'s own entries were rewritten');
  assert.equal(fs.statSync(file).ino, ino);
  // Two days ago at the start: rewritten once to today's entries, the file swapped whole.
  const before = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, line(now - 2 * 86400000).repeat(100) + before);
  const today = new SpendLedger({ file }).detail().spent;
  l.spent(0.5, 'turn');
  l.spent(0.5, 'turn');
  assert.equal(rewrites, 1);
  assert.equal(Math.round(new SpendLedger({ file }).detail().spent * 1000) / 1000, Math.round((today + 1) * 1000) / 1000);
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).every((x) => JSON.parse(x).at >= now - 1000), true);
});
