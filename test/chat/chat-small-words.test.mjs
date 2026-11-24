// At 390 px the chat says the context once (the composer's ring, not the status line too), and the session menu's
// Branch line fits in two lines.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../../web/chat/chat.css', import.meta.url), 'utf8');
const header = fs.readFileSync(new URL('../../web/chat/header.js', import.meta.url), 'utf8');

test('the status line leaves its context out while the ring says the context', () => {
  assert.match(css, /\.chat-wrap:has\(\.chat-ring\[data-kind='context'\]:not\(\.hidden\)\) \.chat-st-part\[data-k='Context'\] \{ display: none; \}/);
});

test('the Branch line of the session menu is short', () => {
  const m = /value: 'fork', label: 'Branch', sub: '([^']+)'/.exec(header);
  assert.ok(m);
  assert.equal(m[1], 'A copy of this chat you switch into; this one stays');
  assert.ok(m[1].length <= 55, m[1]);
});
