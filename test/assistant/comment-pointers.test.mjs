// Comments of Tia's code say their reason in their own words: no pointer to a paper this repository does not have
// (a "decision N", a "(RULES: …)"), and the reason each pointer stood for is still said.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../../src/assistant/${f}`, import.meta.url), 'utf8');

test('the wrong-password comment and the git server comment keep their reasons without pointers', () => {
  const core = read('core.mjs');
  const her = read('hersignin.mjs');
  for (const [name, s] of [['core.mjs', core], ['hersignin.mjs', her]]) {
    assert.doesNotMatch(s, /\(decision \d+|\bRULES:/, `${name}: no pointer to a paper`);
  }
  assert.match(core, /A wrong password ran nothing and is tried again on the same card: keep it pending with its full time/);
  assert.match(core, /he only types the password again\./);
  assert.match(her, /the code around it says "a git server" and never depends on one particular account\./);
});
