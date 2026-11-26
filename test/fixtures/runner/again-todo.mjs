// For test/runner.test.mjs (--again): a file whose only failing test is a todo, which fails no run: it is not run
// again, and nothing is said of a second run. Each run adds a line to again-todo.runs in its temporary folder (TMPDIR,
// the test's own).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

fs.appendFileSync(path.join(os.tmpdir(), 'again-todo.runs'), 'run\n');

test('passes', () => {});
test('a todo that fails', { todo: 'made-up, not done yet' }, () => {
  throw new Error('made-up failure of a todo');
});
