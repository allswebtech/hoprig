// For test/runner.test.mjs (--again): one more file with a failing test, for a run with more than three of them. Each
// run adds a line to again-fails-b.runs in its temporary folder (TMPDIR, the test's own).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

fs.appendFileSync(path.join(os.tmpdir(), 'again-fails-b.runs'), 'run\n');

test('fails', () => {
  throw new Error('made-up failure b');
});
