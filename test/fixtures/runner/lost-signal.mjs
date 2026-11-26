// For test/runner.test.mjs: a file whose second test ends its own process by a signal (process.kill of itself).
import { test } from 'node:test';

test('first', () => {});
test('second kills its own process', () => {
  process.kill(process.pid);
});
