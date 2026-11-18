// For test/runner.test.mjs: 300 tests with long names, so that their results fill the pipe to the runner many times
// over before the file's process ends.
import { test } from 'node:test';

for (let i = 0; i < 300; i++) test(`result ${i} of 300 ${'with a long name '.repeat(60)}`, () => {});
