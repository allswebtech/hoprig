// For test/seal.test.mjs: prints the names in its own environment, so the test can check that the runner let
// none of the owner's tokens, agent sockets or desktop variables through into a test file's process.
import { test } from 'node:test';

test('env', () => {
  console.log('ENVKEYS ' + JSON.stringify(Object.keys(process.env)));
});
