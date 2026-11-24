import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The terminal's session menu draws each line under a label in two lines at most (web/style.css .choice-sub): at
// 390 px that is about 80 letters. A folder's name in the line made it longer than that, and it was cut at "delete…".
test('the session menu\'s Earlier conversations line has no folder name and fits two lines of a phone\'s sheet', () => {
  const src = readFileSync(new URL('../web/session.js', import.meta.url), 'utf8');
  const m = src.match(/value: 'earlier', label: 'Earlier conversations', sub: ('[^']*'|`[^`]*`)/);
  assert.ok(m, 'the Earlier conversations line is in web/session.js');
  const sub = m[1].slice(1, -1);
  assert.doesNotMatch(sub, /\$\{/, 'no folder name of any length in the line');
  assert.equal(sub, 'Ended ones in this folder: delete one you do not need');
  assert.ok(sub.length <= 60, `short enough for two lines at 390 px (${sub.length} letters)`);
});
