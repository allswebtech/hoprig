// The chat's menu sends him to Hands-off's settings with a press, never by naming the place in words only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const s = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'chat', 'header.js'), 'utf8');

test('the session menu has "Hands-off settings", which opens Settings → Hands-off', () => {
  assert.doesNotMatch(s, /Settings → Hands-off\)/, 'no place named in words only');
  assert.match(s, /value: 'handsoffsettings', label: 'Hands-off settings'/);
  assert.match(s, /pick === 'handsoffsettings'\) location\.hash = link\('#\/settings\/handsoff'\)/);
  const page = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'handsoffsettings.js'), 'utf8');
  assert.match(page, /id: 'handsoff', title: 'Hands-off'/, 'the page the press opens is there');
});
