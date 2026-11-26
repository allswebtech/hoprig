// For test/runner.test.mjs: a file whose second test ends its process with exit code 3, after one result and a line on
// its error output; its summary never comes, and the runner's second run of it says how it ended.
import { test } from 'node:test';

test('first', () => {});
test('second ends the process with code 3', () => {
  process.stderr.write('made-up last words before exit 3\n');
  process.exit(3);
});
