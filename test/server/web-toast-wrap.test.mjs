// One rule for every toast (web/style.css): the sentence keeps a readable width and the button goes under it when both
// do not fit on one line, and a long word (a file path, a name) breaks, so no toast is wider than the screen and no
// button label is cut. Never a rule per code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');
const rule = (sel) => {
  const all = [...css.matchAll(new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[2]);
  return all.join(';');
};

test('a toast wraps: its button goes under the sentence when the line is too narrow', () => {
  assert.match(rule('.toast'), /flex-wrap:\s*wrap/);
  assert.match(rule('.toast'), /max-width:\s*100%/);
  assert.match(rule('.toast > span'), /flex:\s*1 1 14em/, 'the sentence keeps a readable width before the button moves');
  assert.match(rule('.toast > span'), /min-width:\s*0/);
});

test('a long word in the sentence breaks, and the button label wraps instead of being cut', () => {
  assert.match(rule('.toast > span'), /overflow-wrap:\s*anywhere/);
  assert.match(rule('.toast-action'), /white-space:\s*normal/);
  assert.match(rule('.toast-action'), /max-width:\s*100%/);
});

test('no rule per code: the toast style names no code', () => {
  assert.doesNotMatch(css, /\.toast[^{]*\[data-code/);
});
