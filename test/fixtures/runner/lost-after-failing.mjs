// For test/runner.test.mjs: a file whose first test FAILS under the runner and whose process then ends before its
// summary; alone (no NODE_TEST_CONTEXT) it passes. A file that reported a failing test is never rescued.
import { test } from 'node:test';

test('fails under the runner', () => {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('made-up failure of the first run');
});
test('ends the process under the runner', async () => {
  // A moment first, so the failure above reaches the runner before the process ends.
  if (process.env.NODE_TEST_CONTEXT) await new Promise((r) => setTimeout(r, 300)).then(() => process.exit(0));
});
