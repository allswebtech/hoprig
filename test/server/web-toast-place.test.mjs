// On a desktop the toasts sit at the top right, under the page head: the head's buttons there (the computer picker,
// the round buttons) stay free to press while a toast with a button stays for 8 seconds or more.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8');

test('a desktop toast starts below the page head, not over its buttons', () => {
  const m = /@media \(min-width: 900px\) \{ \.toasts \{([^}]*)\} \}/.exec(css);
  assert.ok(m, 'a desktop rule places the toasts');
  const top = /top:\s*(\d+)px/.exec(m[1]);
  assert.ok(top, m[1]);
  // The page head is at least 56px high (.pagehead min-height).
  const head = /\.pagehead \{[^}]*min-height:\s*(\d+)px/.exec(css);
  assert.ok(head, 'the page head has a height');
  assert.ok(Number(top[1]) >= Number(head[1]) + 8, `top ${top[1]}px is under the head (${head[1]}px)`);
  assert.match(m[1], /bottom:\s*auto/);
});
