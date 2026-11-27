// The quiet line "Allowed without asking" is drawn in the family of the tool lines: left, one muted line, cut with an
// ellipsis, its whole words in its title.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../../web/${f}`, import.meta.url), 'utf8');
const chat = read('chat/chat.css');
const rule = (sel) => {
  const i = chat.indexOf(`${sel} {`);
  assert.ok(i >= 0, `a rule for ${sel}`);
  return chat.slice(i, chat.indexOf('}', i));
};

test('the allowed line is a muted one-line row at the left, as a tool line', () => {
  const r = rule('.chat-note.chat-allowed');
  assert.match(r, /justify-self: start/);
  assert.match(r, /min-height: 28px/);
  assert.match(r, /font-size: var\(--fs-sm\)/);
  assert.match(r, /white-space: nowrap/);
  assert.match(r, /text-overflow: ellipsis/);
  assert.match(r, /text-align: left/);
  assert.doesNotMatch(r, /overflow-wrap: anywhere/);
});

test('its whole words are its title, so a cut line is still readable', () => {
  assert.match(read('chat/timeline.js'), /h\('p\.chat-item\.chat-note\.chat-allowed', \{ role: 'status', title:/);
});
