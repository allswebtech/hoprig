// For test/runner.test.mjs: a file whose process ends at once under the runner, and whose second run by itself has a
// failing test: it stays a lost result and the run fails.
import { test } from 'node:test';

if (process.env.NODE_TEST_CONTEXT) process.exit(0);
test('first', () => {});
test('second fails', () => {
  throw new Error('made-up failure of the second run');
});
