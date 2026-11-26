// For test/runner.test.mjs: a file whose process ends on an error thrown in a timer that nothing catches. Node's test
// runner catches such an error itself and goes on, so its handler is taken away first: the error is then really
// uncaught, the process ends with code 1 and its summary never comes.
import { test } from 'node:test';

test('first', () => {});
test('second throws in a timer', () => new Promise(() => {
  setTimeout(() => {
    process.removeAllListeners('uncaughtException');
    throw new Error('made-up error in a timer');
  }, 10);
}));
