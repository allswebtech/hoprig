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
