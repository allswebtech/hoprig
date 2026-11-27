// The Skills page: its tabs (Projects, Skills, Memory) are the first thing under the title, with nothing above them.
// There is no tab of its own for Suggested, Find or Learned any more: one list, and "Worth adding" is a group in it,
// never a tall panel above the rest (a person took it for the whole page and did not scroll).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const page = fs.readFileSync(new URL('../../web/skillhub.js', import.meta.url), 'utf8');
const body = page.slice(page.indexOf('  frame({\n    title: \'Skills\''), page.indexOf('  const scopeName'));

test('the tabs are the first item of the page body', () => {
  assert.ok(body.includes('body: [tabs,'), 'tabs are the first item of the body');
  assert.match(page, /const tabs = projectsTabs\('skills'\)/);
});

test('Worth adding is a group of the one list, below Installed and the search', () => {
  assert.match(page, /groupHead\('Worth adding'/);
  assert.ok(body.indexOf('form,') < body.indexOf('installedBox') && body.indexOf('installedBox') < body.indexOf('worthBox'), 'search, Installed, Worth adding');
  assert.doesNotMatch(page, /tabs\.update\(/, 'the tabs are never repainted into four parts');
});
