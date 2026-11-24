// A demo a test starts stays inside the suite's seal: isolate() keeps the runner's variables (the folder of its traps,
// the file and process they name), so the demo's children and its second computer still find the traps first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SEAL_VARS } from '../seal.mjs';

test('demo: isolate keeps the test runner\'s seal variables', async () => {
  const { isolate } = await import('../../src/demo/index.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-seal-'));
  try {
    const env = { PATH: '/usr/bin', HOME: '/made-up/home', GH_TOKEN: 'x' }; // seal: a value no program is started with
    for (const k of SEAL_VARS) env[k] = `made-up-${k}`;
    isolate(root, env);
    for (const k of SEAL_VARS) assert.equal(env[k], `made-up-${k}`, `${k} is kept`);
    assert.equal(env.GH_TOKEN, undefined, 'the rest still goes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
