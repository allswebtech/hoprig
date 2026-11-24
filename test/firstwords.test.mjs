// The first-time question card names the key of the safe answer only as the screen shows it, never a fixed number.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { noticeOnScreen } = await import('../src/askcard.mjs');
const screen = (a, b) => [' Allow external CLAUDE.md file imports?', ' Only use Claude Code with files you trust.', ` ❯ ${a}`, `   ${b}`,
  ' Enter to confirm · Esc to cancel'].join('\n');
const said = (s) => noticeOnScreen(s, { starting: true }).notice.text;

test('the answers in today\'s order: the card names 1, the number on the safe answer\'s line', () => {
  const t = said(screen('1. No, disable external imports', '2. Yes, allow external imports'));
  assert.match(t, /No is the safe answer: press 1 in the terminal, or type 1 in the message box and send it\.$/);
  const b = noticeOnScreen([' WARNING: Claude Code running in Bypass Permissions mode', ' ❯ 1. No, exit', '   2. Yes, I accept',
    ' Enter to confirm · Esc to cancel'].join('\n'), { starting: true }).notice.text;
  assert.match(b, /No is the safe answer: press 1 in the terminal/);
});

test('the answers swapped: the card names 2, never the key that accepts', () => {
  const t = said(screen('1. Yes, allow external imports', '2. No, disable external imports'));
  assert.match(t, /press 2 in the terminal, or type 2 in the message box/);
  assert.doesNotMatch(t, /\b1\b/);
  const b = noticeOnScreen([' WARNING: Claude Code running in Bypass Permissions mode', ' ❯ 1. Yes, I accept', '   2. No, exit',
    ' Enter to confirm · Esc to cancel'].join('\n'), { starting: true }).notice.text;
  assert.match(b, /press 2 in the terminal/);
  assert.doesNotMatch(b, /\b1\b/);
});

test('no number on the safe answer\'s line: the line is named by its words and no key at all', () => {
  const t = said(screen('No, disable external imports', 'Yes, allow external imports'));
  assert.match(t, /No is the safe answer: choose "No, disable external imports" in the terminal\.$/);
  assert.doesNotMatch(t, /press|type \d|\b\d\b/);
  assert.ok(t.length <= 300, `the card keeps 300 characters of its note (${t.length})`);
});
