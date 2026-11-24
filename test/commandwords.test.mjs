// Every command word of `hoprig` is a reserved name: a provider file under such a name could never be started (the
// command runs instead), so `hoprig add` refuses it, the list of providers leaves it out and doctor names it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = await import('../src/profiles.mjs');

test('every command word of the command line is reserved for provider names', () => {
  const words = [...fs.readFileSync(path.join(ROOT, 'bin', 'hoprig.mjs'), 'utf8').matchAll(/^ {4}case '([a-z-]+)'/gm)].map((m) => m[1]);
  assert.ok(words.includes('sync') && words.includes('get') && words.includes('workspace'), 'the command words were found');
  assert.deepEqual(words.filter((w) => !P.RESERVED.has(w)), []);
  for (const w of ['sync', 'get']) assert.equal(P.validName(w), false, `${w} cannot name a provider`);
});
