// The demo's stand-in for Tia (src/demo/tia.mjs) makes the README's screenshots: it calls only Tia's real tools,
// and her replies are her own words, never a tool's summary written for the model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { byName } from '../../src/assistant/tools.mjs';

const SRC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'demo', 'tia.mjs'), 'utf8');

test('demo Tia: every tool it calls is one of her real tools', () => {
  const called = [...SRC.matchAll(/call\('([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(called.includes('list_projects'), 'finds the project with list_projects');
  for (const name of called) assert.ok(byName.has(name), `${name} is a real tool`);
});

test('demo Tia: no reply passes on a tool summary; the job goal reads as a title', () => {
  assert.doesNotMatch(SRC, /say\([^)]*\br\.split\(/, 'a tool answer is never said as it is');
  assert.doesNotMatch(SRC, /\(await call\([^)]*\)\)\.split\(/);
  const goal = /goal: '([^']+)'/.exec(SRC)[1];
  assert.match(goal, /^[A-Z]/, 'starts with a capital, as a title');
});
