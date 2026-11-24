// The schedule sheet, the Schedules footnote and Run by AI say "a separate copy of the project", never "a branch of
// its own" (a word a newcomer does not know), so the sheet does not say the same thing twice in two ways.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('words: schedules and Run by AI never say a branch of its own', () => {
  for (const f of ['automation.js', 'workitems.js']) {
    const src = fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8').replace(/^\s*(\/\/|\*).*$/gm, '');
    assert.doesNotMatch(src, /branch of its own|\(work\/…\)|never on the main branch/, f);
  }
  const auto = fs.readFileSync(new URL('../../web/automation.js', import.meta.url), 'utf8');
  assert.match(auto, /'It runs once without a person, in a separate copy of the project, and ends at the time limit\./);
});
