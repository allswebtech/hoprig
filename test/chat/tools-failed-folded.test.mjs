// A command that failed stays folded like every tool line: its words failed and the exit code are on the line (in the
// danger colour), the red output is under a press.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { byClass, texts } from './fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
const { toolCard } = await import('../../web/chat/tools.js');
const shell = (extra = {}) => toolCard({ id: 'b', name: 'Bash', toolKind: 'shell', input: { command: 'ls missing' } }, { cwd: '/p', view: () => 'normal', ...extra });

test('a failed command is folded, with failed and its exit code on the line', () => {
  const el = shell();
  el.result({ ok: false, text: 'Exit code 2\nls: missing: No such file or directory' });
  assert.equal(el.open, false, 'folded: the red output waits for a press');
  assert.ok(el.classList.contains('chat-is-err'));
  assert.match(texts(el).join('|'), /failed · exit 2/);
  assert.match(texts(byClass(el, 'chat-tool-said')[0]).join(''), /failed · exit 2/, 'on the line, in the said span');
});

test('a press opens it; the view decides again when it changes, a failed one has no exception', () => {
  const el = shell();
  el.result({ ok: false, text: 'Exit code 1\nboom' });
  el.open = true; // a press
  el.applyView('normal');
  assert.equal(el.open, false, 'Normal folds every call, a failed one too');
  el.applyView('verbose');
  assert.equal(el.open, true);
});

test('the words failed and the exit code are in the danger colour', () => {
  const css = fs.readFileSync(new URL('../../web/chat/chat-cards.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-tool-said \{[^}]*color: var\(--danger\)/);
});
