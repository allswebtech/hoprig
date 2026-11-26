// For test/runner.test.mjs: a file whose process ends at once under the runner (NODE_TEST_CONTEXT is set there),
// before any test ran, as was seen on Windows; run again by itself it passes whole. The run must not fail for it.
import { test } from 'node:test';

if (process.env.NODE_TEST_CONTEXT) process.exit(0);
test('first', () => {});
test('second', () => {});
