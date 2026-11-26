// A lock a crashed dashboard left keeps a write of the spending record waiting once: until the lock is stale
// (STALE_MS, five seconds after it was last made fresh), then the write takes it over and writes under its own lock.
// The writes after it find no lock and do not wait. A line is never appended without the lock, so a live dashboard
// that only works slowly inside it never has a line put into the file its rewrite replaces (spend.mjs #append).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BUSY, SpendLedger } from '../../src/assistant/spend.mjs';

const ago = (file, ms) => {
  const t = (Date.now() - ms) / 1000;
  fs.utimesSync(file, t, t);
};

test('three writes while a lock a dead dashboard left is there: the first waits until it is stale, every line is written under the writer\'s own lock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-writewait-'));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  ago(lock, 3000); // stale in about two seconds
  const { appendFileSync } = fs;
  t.after(() => {
    fs.appendFileSync = appendFileSync;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // At each line: a lock is there, and it is a fresh one (the writer's own), not the one the dead dashboard left.
  const under = [];
  fs.appendFileSync = function (p, ...rest) {
    if (p === file) {
      let s = null;
      try {
        s = fs.statSync(lock);
      } catch {
        /* no lock */
      }
      under.push(!!s && Date.now() - s.mtimeMs < 1000);
    }
    return appendFileSync.call(fs, p, ...rest);
  };
  const l = new SpendLedger({ file });
  const t0 = Date.now();
  l.measure('this|alpha', 0.1);
  const first = Date.now() - t0;
  l.measure('this|beta', 0.2);
  l.spent(0.3, 'her own turn');
  const took = Date.now() - t0;
  fs.appendFileSync = appendFileSync;
  assert.ok(first >= 1500, `the first write waited ${first} ms: not until the left lock was stale`);
  // One wait for the left lock, then the next writes find no lock: not one wait for every line.
  assert.ok(took - first < 500, `the two writes after it took ${took - first} ms`);
  assert.deepEqual(under, [true, true, true], 'a line was written without the writer\'s own lock');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  assert.deepEqual(lines.map((e) => e.kind), ['measured', 'measured', 'spent']);
  assert.equal(Math.round(new SpendLedger({ file }).detail().spent * 100) / 100, 0.6);
  assert.equal(fs.existsSync(lock), false, 'the left lock was not taken over, or the writer\'s own was left behind');
});

test('a lock dated far ahead (the clock was set back since it was made) is taken over; one a few seconds ahead is not', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-ahead-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  ago(lock, -120_000);
  // What the taker met at each step (spend.mjs trace), said on a failure.
  const met = [];
  const l = new SpendLedger({ file, trace: (st, w) => met.push(`${st} ${w}`) });
  const t0 = Date.now();
  l.spent(1, 'her own turn');
  const took = Date.now() - t0;
  assert.ok(took < 500, `the write waited ${took} ms for a lock dated two minutes ahead; met: ${met.slice(-40).join(' | ')}`);
  assert.equal(fs.existsSync(lock), false, 'the lock dated ahead is still there');
  fs.writeFileSync(lock, '');
  ago(lock, -120_000);
  met.length = 0;
  assert.equal(l.take(5), null, `take() refused while a lock dated two minutes ahead was there; met: ${met.slice(-40).join(' | ')}`);
  assert.equal(fs.existsSync(lock), false);
  // A few seconds ahead: a live holder on a disk whose clock runs a little ahead. Never taken over.
  fs.writeFileSync(lock, '');
  ago(lock, -8000);
  assert.equal(l.take(5), BUSY, 'a lock dated eight seconds ahead was taken over');
  assert.equal(fs.existsSync(lock), true, 'a lock dated eight seconds ahead was removed');
  fs.rmSync(lock);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  assert.deepEqual(lines.map((e) => e.kind), ['spent', 'hold']);
});

test('a lock that cannot be dated again (its disk refuses the time): the write is done at once, under its own lock', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-nodate-'));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  const { utimesSync, futimesSync, appendFileSync } = fs;
  const restore = () => Object.assign(fs, { utimesSync, futimesSync, appendFileSync });
  t.after(() => {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const refuse = () => {
    const e = new Error('operation not permitted');
    e.code = 'EPERM';
    throw e;
  };
  fs.utimesSync = refuse;
  fs.futimesSync = refuse;
  let under = 0;
  fs.appendFileSync = function (p, ...rest) {
    if (p === file && fs.existsSync(lock)) under++;
    return appendFileSync.call(fs, p, ...rest);
  };
  const l = new SpendLedger({ file });
  const t0 = Date.now();
  l.spent(1, 'her own turn');
  l.spent(2, 'her own turn');
  const took = Date.now() - t0;
  restore();
  assert.ok(took < 500, `two writes took ${took} ms`);
  assert.equal(under, 2, 'a line was written without the writer\'s own lock');
  assert.equal(new SpendLedger({ file }).detail().spent, 3);
  assert.equal(fs.existsSync(lock), false, 'the writer\'s lock was left behind');
});

test('a lock a live holder keeps fresh and never lets go: the write ends with an error after its wait, and writes nothing', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-endless-'));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  // The holder makes its lock fresh at every look, and the clock runs a second at each reading: the write's wait (a
  // few tens of seconds) passes in a moment here, and it must end then.
  const { statSync } = fs;
  const now = Date.now;
  let offset = 0;
  const restore = () => {
    fs.statSync = statSync;
    Date.now = now;
  };
  t.after(() => {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  Date.now = () => now() + (offset += 1000);
  fs.statSync = function (p, ...rest) {
    const s = statSync.call(fs, p, ...rest);
    return p === lock ? { ino: s.ino, dev: s.dev, mtimeMs: Date.now(), size: s.size } : s;
  };
  let error = null;
  try {
    new SpendLedger({ file }).spent(1, 'her own turn');
  } catch (e) {
    error = e;
  }
  restore();
  assert.ok(error && /stayed locked/.test(error.message), `the write ${error ? `ended with: ${error.message}` : 'ended without an error'}`);
  assert.ok(offset <= 120_000, `the write's clock ran ${offset / 1000} seconds`);
  assert.equal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', '', 'a line was written while the live holder had the lock');
  assert.equal(fs.existsSync(lock), true, 'the live holder\'s lock was removed');
});

// What was measured on Windows (test/zz-windiag-locks.test.mjs): a file just removed is gone at once, and making it
// again works; but removing a file that another process touches at that moment is refused with EPERM now and then.
const refuse = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };

test('Windows: a stale lock whose removal is refused a few times (another process touched it) is taken over, not answered busy', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-rm-refused-'));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  ago(lock, 60_000); // left by a dashboard that was killed inside it
  const { rmSync } = fs;
  t.after(() => {
    fs.rmSync = rmSync;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Refused for longer than take()'s short wait for a lock another dashboard holds.
  const refusedUntil = Date.now() + 400;
  fs.rmSync = function (p, ...rest) {
    if (p === lock && Date.now() < refusedUntil) refuse();
    return rmSync.call(fs, p, ...rest);
  };
  const met = [];
  assert.equal(new SpendLedger({ file, platform: 'win32', trace: (st, w) => met.push(`${st} ${w}`) }).take(5), null, met.join(' | '));
  assert.ok(met.includes('break EPERM at the removal'), 'the refusal was met');
  assert.equal(fs.existsSync(lock), false, 'and its own lock let go');
  // Elsewhere an EPERM at that removal is an error, as before: never a wait.
  fs.writeFileSync(lock, '');
  ago(lock, 60_000);
  fs.rmSync = function (p, ...rest) {
    if (p === lock) refuse();
    return rmSync.call(fs, p, ...rest);
  };
  assert.equal(new SpendLedger({ file, platform: 'linux' }).take(5), BUSY, 'not taken over, and no longer wait');
});

test('a stale lock removed on the last round of the wait is followed by this taker\'s own lock, not by "busy" and a lock nobody holds', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-last-round-'));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  fs.writeFileSync(lock, '');
  ago(lock, 60_000);
  const { rmSync } = fs;
  t.after(() => {
    fs.rmSync = rmSync;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // The removal of the stale lock comes only after take()'s whole short wait (a slow computer): the round that removed
  // it must still make the taker's own.
  fs.rmSync = function (p, ...rest) {
    if (p === lock) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    return rmSync.call(fs, p, ...rest);
  };
  assert.equal(new SpendLedger({ file }).take(5), null, 'taken over on the round that removed it');
  fs.rmSync = rmSync;
  assert.equal(fs.existsSync(lock), false);
});

test('Windows: a holder whose removal of its own lock is refused a moment (another process looked at it) removes it then, never leaves it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-release-'));
  const file = path.join(dir, 'spend.jsonl');
  const lock = `${file}.lock`;
  const { rmSync } = fs;
  t.after(() => {
    fs.rmSync = rmSync;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let refusals = 0;
  fs.rmSync = function (p, ...rest) {
    if (p === lock && refusals < 3) {
      refusals++;
      refuse();
    }
    return rmSync.call(fs, p, ...rest);
  };
  assert.equal(new SpendLedger({ file, platform: 'win32' }).take(5), null);
  assert.equal(refusals, 3);
  assert.equal(fs.existsSync(lock), false, 'its own lock is not left for the others to wait out as stale');
});

test('Windows: a make of the lock refused with EPERM a moment (between processes) is looked at again; elsewhere an error, as before', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-make-eperm-'));
  const file = path.join(dir, 'spend.jsonl');
  const { openSync } = fs;
  t.after(() => {
    fs.openSync = openSync;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let refusals = 0;
  fs.openSync = function (p, ...rest) {
    if (p === `${file}.lock` && refusals < 3) {
      refusals++;
      refuse();
    }
    return openSync.call(fs, p, ...rest);
  };
  assert.equal(new SpendLedger({ file, platform: 'win32' }).take(5), null);
  assert.equal(refusals, 3);
  fs.openSync = function (p, ...rest) {
    if (p === `${file}.lock`) refuse();
    return openSync.call(fs, p, ...rest);
  };
  assert.throws(() => new SpendLedger({ file, platform: 'linux' }).spent(1, 'her own turn'), { code: 'EPERM' });
});
