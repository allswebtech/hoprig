// For test/runner.test.mjs: a file whose test is over but which still holds a timer open; the run must end all the same.
import { test } from 'node:test';

test('done, with a timer left running', () => {
  setInterval(() => {}, 1000);
});
