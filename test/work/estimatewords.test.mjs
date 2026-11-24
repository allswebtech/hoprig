// A row with nothing to measure it by says so in four words, with no reason in the row. Tia's prompt and her
// progress summary quote the very words the rows give, so she says them as they are.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as est from '../../src/work/estimate.mjs';

const { NO_ESTIMATE, basisOf, etaOf } = est;
import { BASE_PROMPT } from '../../src/assistant/prompt.mjs';
import fs from 'node:fs';

const WORKTOOL = fs.readFileSync(new URL('../../src/assistant/worktool.mjs', import.meta.url), 'utf8');

test('no basis: "no time estimate yet", and no unused reason kept beside it', () => {
  assert.equal(NO_ESTIMATE, 'no time estimate yet');
  assert.equal(basisOf('code', []).text, 'no time estimate yet');
  assert.equal(etaOf(null, Date.now(), Date.now()).text, 'no time estimate yet');
  assert.ok(!('NO_ESTIMATE_WHY' in est), 'no tooltip text that nothing shows');
  assert.doesNotMatch(NO_ESTIMATE, /:/, 'no reason in the row');
});

test('her prompt and the progress summary quote the words the rows give', () => {
  assert.ok(BASE_PROMPT.includes(`"${NO_ESTIMATE}"`), 'the prompt quotes NO_ESTIMATE');
  assert.ok(!/"no estimate yet"/.test(BASE_PROMPT));
  assert.ok(WORKTOOL.includes(`"${NO_ESTIMATE}"`), 'the progress summary quotes NO_ESTIMATE');
});
