// The lock beside the spending record (spend.mjs take): a lock left by a process that ended inside it is taken over,
// but only that lock. A taker that saw it stale a moment ago never removes the fresh lock another taker made in its
// place, so the two never both hold past the cap. And a lock another dashboard holds makes take() wait only briefly:
// it runs on the dashboard's one thread, so every page and terminal waits with it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BUSY, SpendLedger } from '../../src/assistant/spend.mjs';

const SPEND = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'assistant', 'spend.mjs')).href;
const holds = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === 'hold').length : 0);
const ago = (file, ms) => {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(file, t, t);
};

test('a taker that saw the old lock stale does not remove the fresh lock that took its place', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-stale-'));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  fs.writeFileSync(file, '');
  fs.writeFileSync(lock, '');
  ago(lock, 60_000); // left by a dashboard that was killed inside it
  const seenStale = fs.statSync(lock);
  // What each taker met at each step, said on a failure (spend.mjs trace).
  const met = [];
  const a = new SpendLedger({ file, trace: (step, what) => met.push(`A ${step} ${what}`) });
  const b = new SpendLedger({ file, trace: (step, what) => met.push(`B ${step} ${what}`) });
  const { readFileSync, statSync } = fs;
  t.after(() => {
    Object.assign(fs, { readFileSync, statSync });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // The order two processes can run in: B looks at the lock and sees it stale; A takes it over, makes its own and has
  // read the record (no hold yet); only then B goes on. Played here in one process: right after A's read inside its
  // lock, B takes, and B's first look at the lock is the one it made before A came.
  let bLooked = false;
  let bTook;
  fs.statSync = function (p, ...rest) {
    if (p === lock && bTaking && !bLooked) {
      bLooked = true;
      return seenStale;
    }
    return statSync.call(fs, p, ...rest);
  };
  let bTaking = false;
  fs.readFileSync = function (p, ...rest) {
    const read = readFileSync.call(fs, p, ...rest);
    if (p === file && bTook === undefined && !bTaking && fs.existsSync(lock)) {
      bTaking = true;
      bTook = b.take(0.5);
      bTaking = false;
    }
    return read;
  };
  const aTook = a.take(0.5);
  Object.assign(fs, { readFileSync, statSync });
  // A that answers busy never had the lock in its short wait (on Windows a removed lock may stay in the way while
  // another program, a virus scan, still has it open): then B was never asked, and the answer says so.
  assert.equal(bLooked, true, `B never looked at the lock: the order was not played (A answered ${JSON.stringify(aTook)}, B ${JSON.stringify(bTook)}, the lock is ${fs.existsSync(lock) ? 'there' : 'gone'}; met: ${met.slice(-40).join(' | ')})`);
  assert.equal(aTook, null, 'A took over the stale lock and held');
  assert.equal(bTook, BUSY, `B ${bTook === null ? 'held too, after it removed A\'s fresh lock' : `answered ${bTook}`}`);
  assert.equal(holds(file), 1, 'a cap with room for one hold held more');
  assert.equal(fs.existsSync(lock), false, 'the lock was left behind');
});

test('a lock left by a killed process, six takers in six processes at once, a cap of one hold', { timeout: 120_000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-stale-many-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const taker = path.join(dir, 'taker.mjs');
  fs.writeFileSync(taker, `import fs from 'node:fs';
import { SpendLedger } from ${JSON.stringify(SPEND)};
const [file, go] = process.argv.slice(2);
const w = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(go)) Atomics.wait(w, 0, 0, 1);
const l = new SpendLedger({ file });
let why = l.take(0.5);
// Busy is not a refusal of the cap: a dashboard asks again later. Asked again until the lock is free.
for (let i = 0; i < 100 && why && why.startsWith('another dashboard'); i++) why = l.take(0.5);
process.stdout.write(why === null ? '1' : why.startsWith('another dashboard') ? 'b' : '0');
`);
  const run = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [taker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => resolve({ code, out, err }));
  });
  for (let r = 0; r < 8; r++) {
    const file = path.join(dir, `s${r}`, 'spend.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, '');
    ago(`${file}.lock`, 60_000);
    const go = path.join(dir, `go${r}`);
    const kids = Array.from({ length: 6 }, () => run([file, go]));
    await new Promise((res) => setTimeout(res, 300));
    fs.writeFileSync(go, '');
    const done = await Promise.all(kids);
    for (const k of done) assert.equal(k.code, 0, k.err);
    const got = done.filter((k) => k.out === '1').length;
    assert.equal(got, 1, `round ${r}: ${got} takers held against a cap with room for one (${done.map((k) => k.out).join('')})`);
    assert.equal(holds(file), 1, `round ${r}: the record holds ${holds(file)}`);
    assert.equal(fs.existsSync(`${file}.lock`), false, `round ${r}: the lock was left behind`);
  }
});

test('a lock another dashboard holds: take() refuses after a short wait and holds nothing; an old one is taken over', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-busy-'));
  try {
    const file = path.join(dir, 'spend.jsonl');
    const l = new SpendLedger({ file });
    fs.writeFileSync(`${file}.lock`, '');
    const t0 = Date.now();
    assert.equal(l.take(5), BUSY);
    const waited = Date.now() - t0;
    assert.ok(waited < 400, `take() kept the dashboard waiting ${waited} ms`);
    assert.equal(holds(file), 0);
    assert.equal(fs.existsSync(`${file}.lock`), true, 'another dashboard\'s fresh lock was removed');
    ago(`${file}.lock`, 10_000);
    assert.equal(l.take(5), null, 'a lock left 10 s ago is taken over');
    assert.equal(holds(file), 1);
    assert.equal(fs.existsSync(`${file}.lock`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
