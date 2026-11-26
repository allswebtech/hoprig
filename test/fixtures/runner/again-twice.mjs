// For test/runner.test.mjs (--again): a file whose test fails on every run, so its second run by itself fails as
// well. Each run adds a line to again-twice.runs in its temporary folder (TMPDIR, the test's own).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

fs.appendFileSync(path.join(os.tmpdir(), 'again-twice.runs'), 'run\n');

test('passes', () => {});
test('fails on every run', () => {
  throw new Error('made-up failure of every run');
});
