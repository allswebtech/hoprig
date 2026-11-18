// For test/runner.test.mjs: a file whose second test ends the process, so its results and its summary never reach the
// runner. Node's runner then shows one passing line for the whole file; tools/test.mjs must fail the run by name.
import { test } from 'node:test';

test('first', () => {});
test('second ends the process', () => {
  process.exit(0);
});
test('third', () => {});
