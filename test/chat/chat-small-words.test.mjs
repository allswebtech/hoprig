// The session menu's Fork line fits in two lines; the key bar cuts no word.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../../web/chat/chat.css', import.meta.url), 'utf8');
const header = fs.readFileSync(new URL('../../web/chat/header.js', import.meta.url), 'utf8');

test('the Fork line of the session menu is short', () => {
  const m = /value: 'fork', label: 'Fork', sub: '([^']+)'/.exec(header);
  assert.ok(m);
  assert.equal(m[1], 'A copy of this chat you switch into; this one stays');
  assert.ok(m[1].length <= 55, m[1]);
});

test('the key bar cuts no word, the list button says its state, one line is not lines', () => {
  const keys = fs.readFileSync(new URL('../../web/page-session.css', import.meta.url), 'utf8');
  assert.match(/\n\.key \{[^}]*\}/.exec(keys)[0], /white-space: normal/);
  assert.match(header, /sideBtn\.setAttribute\('aria-pressed'/);
  const tools = fs.readFileSync(new URL('../../web/chat/tools.js', import.meta.url), 'utf8');
  assert.match(tools, /n === 1 \? 'line' : 'lines'/);
});
