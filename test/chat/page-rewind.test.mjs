// The App's rewind in Claude Code's words, "Rewind to here" on a message on every device, and Fork in the session menu.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
globalThis.location ||= { hash: '', search: '', pathname: '/' };
const src = (f) => fs.readFileSync(new URL(`../../web/chat/${f}`, import.meta.url), 'utf8');

test('the rewind offers Claude Code\'s choices, in its order, and Never mind', () => {
  const s = src('sheets.js');
  const order = ['Restore code and conversation', 'Restore conversation', 'Restore code', 'Never mind'].map((w) => s.indexOf(`'${w}')`));
  assert.ok(order.every((i) => i > 0), 'every choice is there');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in Claude Code\'s order');
  for (const old of ["'Files only'", "'Conversation only'", "'Both'", "'Cancel'"]) assert.ok(!s.includes(old), old);
});

test('"Rewind to here" is under the message: in words on a touch screen, a named icon with a mouse', () => {
  assert.match(src('timeline.js'), /h\('span\.chat-actword', 'Rewind to here'\)/);
  assert.match(src('timeline.js'), /'aria-label': 'Rewind to here'/);
  const css = fs.readFileSync(new URL('../../web/chat/chat-input.css', import.meta.url), 'utf8');
  const touch = css.match(/@media \(hover: none\) and \(pointer: coarse\) \{([^@]*)\n\}/);
  assert.ok(touch, 'a rule for a screen with no hover');
  assert.match(touch[1], /\.chat-actword \{ display: inline; \}/, 'the words show on a touch screen');
  assert.match(touch[1], /min-height: 44px/, 'large enough for a finger');
  assert.match(css, /\.chat-useracts \{[^}]*opacity: 0/, 'quiet until the message is hovered or focused');
  assert.match(css, /\.chat-userrow:focus-within \.chat-useracts/);
  assert.doesNotMatch(css, /\.chat-userrow \{[^}]*(row|justify)/, 'nothing stands beside the bubble');
});

test('Branch is in the session menu where the coding tool can fork, and not where it cannot', async () => {
  const { sessionItems } = await import('../../web/chat/header.js');
  const claude = { title: 't', cwd: '/w/a', engine: { id: 'claude', capabilities: { fork: true } } };
  const oc = { title: 't', cwd: '/w/a', engine: { id: 'opencode', capabilities: { fork: false } } };
  assert.ok(sessionItems(claude, {}).some((x) => x.value === 'fork' && x.label === 'Fork'), 'Claude Code\'s /branch: it switches into the copy');
  assert.ok(sessionItems(claude, { phone: true }).some((x) => x.value === 'fork'), 'a phone too');
  assert.ok(!sessionItems(oc, {}).some((x) => x.value === 'fork'));
  assert.match(src('page.js'), /const r = await api\(`\$\{A\}\/fork`, \{\}\);[\s\S]*?if \(stay\) return toast\([^\n]*\n\s*location\.hash = link\(`#\/chat\/\$\{r\.id\}`\);/, 'Branch opens the new session; /fork stays');
});
