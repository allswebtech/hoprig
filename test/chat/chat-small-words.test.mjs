// At 390 px the chat says the context once (the composer's ring, not the status line too), and the session menu's
// Fork line fits in two lines.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../../web/chat/chat.css', import.meta.url), 'utf8');
const header = fs.readFileSync(new URL('../../web/chat/header.js', import.meta.url), 'utf8');

test('the status line leaves its context out while the ring says the context', () => {
  assert.match(css, /\.chat-wrap:has\(\.chat-ring\[data-kind='context'\]:not\(\.hidden\)\) \.chat-st-part\[data-k='Context'\] \{ display: none; \}/);
});

test('the Fork line of the session menu is short', () => {
  const m = /value: 'fork', label: 'Fork', sub: '([^']+)'/.exec(header);
  assert.ok(m);
  assert.equal(m[1], 'A copy of this chat you switch into; this one stays');
  assert.ok(m[1].length <= 55, m[1]);
});

test('a long branch ends in an ellipsis, the key bar cuts no word, the list button says its state, one line is not lines', () => {
  assert.match(css, /\.chat-st-part\[data-k='Git branch'\] \{[^}]*text-overflow: ellipsis/);
  const keys = fs.readFileSync(new URL('../../web/page-session.css', import.meta.url), 'utf8');
  assert.match(/\n\.key \{[^}]*\}/.exec(keys)[0], /white-space: normal/);
  assert.match(header, /sideBtn\.setAttribute\('aria-pressed'/);
  const tools = fs.readFileSync(new URL('../../web/chat/tools.js', import.meta.url), 'utf8');
  assert.match(tools, /n === 1 \? 'line' : 'lines'/);
});
