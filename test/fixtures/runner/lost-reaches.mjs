// For test/runner.test.mjs: a file whose summary never comes in the run (it ends its process there), and whose second
// run by itself (no NODE_TEST_CONTEXT: not under the runner's node --test) starts a trapped program. The runner must
// name that reach as it names one of the first run.
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('first', () => {});
test('second', () => {
  if (process.env.NODE_TEST_CONTEXT) process.exit(0);
  spawnSync('sudo', ['made-up-second-run'], { stdio: 'ignore' });
  process.exit(0);
});
