// The list of `hoprig project` commands at the top of src/pcsetup/project.mjs says in words what `project clone` is,
// not only "= hoprig get".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('project clone is said in words: the same as hoprig get, and what it does', () => {
  const s = fs.readFileSync(new URL('../../src/pcsetup/project.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /= hoprig get \(getproject\.mjs\)/);
  assert.match(s, /project clone .*the same as hoprig get: gets an\n\/\/\s+existing project onto this computer with its\n\/\/\s+code repositories and AI memory \(getproject\.mjs\)/);
});
