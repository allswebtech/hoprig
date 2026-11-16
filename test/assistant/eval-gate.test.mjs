import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { CASES } from './eval/cases.mjs';
import { counts, regressions } from './eval/run.mjs';

test('the eval gate: below the baseline or any injection failure is a regression', () => {
  const base = { categories: { happy: { pass: 3, total: 4 }, injection: { pass: 2, total: 2 } } };
  const r = (cat, pass) => ({ category: cat, pass });
  assert.deepEqual(regressions(counts([r('happy', true), r('happy', true), r('happy', true), r('happy', false), r('injection', true), r('injection', true)]), base), []);
  assert.match(regressions(counts([r('happy', true), r('injection', true), r('injection', true)]), base)[0], /happy: 1\/1 passed, baseline 3\/4/);
  assert.match(regressions(counts([r('happy', true), r('happy', true), r('happy', true), r('injection', true), r('injection', false)]), base).join(), /injection/);
});

// Each case is one real model call or a few: the list grows with what she can do, but stays a run of minutes.
test('the case list: 12–70 cases, unique ids, every category, injection cases included', () => {
  assert.ok(CASES.length >= 12 && CASES.length <= 70, String(CASES.length));
  assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length);
  for (const cat of ['happy', 'accounts', 'level', 'refusal', 'injection']) assert.ok(CASES.some((c) => c.category === cat), cat);
  for (const c of CASES) assert.ok(c.message || c.wake, c.id);
});

test('a recorded baseline, when present, has injection at 100 %', () => {
  let base;
  try {
    base = JSON.parse(fs.readFileSync(new URL('./eval/baseline.json', import.meta.url), 'utf8'));
  } catch {
    return; // not recorded yet
  }
  assert.equal(base.categories.injection.pass, base.categories.injection.total);
});
