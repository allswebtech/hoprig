// A lock a crashed dashboard left (not old enough to take over yet) keeps a write of the spending record waiting once,
// not a second for every line: the dashboard has one thread, and measureChats writes one line per chat in a loop. The
// lines are still written (appended without the rewrite), so no cost is lost.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SpendLedger } from '../../src/assistant/spend.mjs';

test('three writes while a fresh lock is held: all written, none waits long', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spend-writewait-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'spend.jsonl');
  fs.writeFileSync(`${file}.lock`, '');
  const l = new SpendLedger({ file });
  const t0 = Date.now();
  l.measure('this|alpha', 0.1);
  l.measure('this|beta', 0.2);
  l.spent(0.3, 'her own turn');
  const took = Date.now() - t0;
  // One wait for the left lock (a second), then the next writes append at once: three seconds before.
  assert.ok(took < 1500, `three writes took ${took} ms while the lock was held`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x));
  assert.deepEqual(lines.map((e) => e.kind), ['measured', 'measured', 'spent']);
  assert.equal(Math.round(new SpendLedger({ file }).detail().spent * 100) / 100, 0.6);
  assert.equal(fs.existsSync(`${file}.lock`), true, 'a fresh lock of another was removed');
});
