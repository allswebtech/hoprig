// The Skills page: its tabs are the first thing under the title; "Worth adding" is the first part of the Suggested tab
// and never a tall panel above the tabs (a person took it for the whole page and did not scroll to the tabs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('../../web/skillhub.js', import.meta.url), 'utf8');
const body = page.slice(page.indexOf('  frame({\n    title: \'Skills\''), page.indexOf('  const scopeName'));

test('the tabs come before every other part of the page body', () => {
  const at = (s) => body.indexOf(s);
  assert.ok(at('tabs,') > 0, 'the tabs are in the body');
  for (const later of ['sk-for', 'linkBrainNote', 'proposalsBox, partBox', 'partBox']) assert.ok(at('tabs,') < at(later), `tabs before ${later}`);
  assert.ok(body.indexOf('body: [tabs') > 0, 'tabs are the first item of the body');
});

test('Worth adding is drawn inside the Suggested tab, not after the proposals above the tabs', () => {
  assert.doesNotMatch(page, /paintWorth\(proposalsBox/, 'not put after the box above the tabs');
  const suggested = page.slice(page.indexOf('function paintSuggested()'), page.indexOf('// ---------- Find'));
  assert.match(suggested, /worthPanel\(/, 'the Suggested tab draws it');
  assert.ok(suggested.indexOf('worthPanel(') < suggested.indexOf('suggest.suggestions.length'), 'as the first part');
  assert.match(page, /openCount\(\) \+ worthCount\(\)/, 'its number is on the Suggested tab');
  assert.doesNotMatch(page, /tabs\.update\(PARTS\.concat/, 'no new tab');
});
