// Claude Code's permission question read from the screen (src/server/prompts.mjs): the "don't ask again" answer is
// offered only when the question on screen has one, in Claude's own words, with its own number.
import assert from 'node:assert/strict';
import test from 'node:test';
import { alwaysOption, menuOpen, permissionOptions } from '../../src/server/prompts.mjs';

const bash = [
  '╭──────────────────────────────────────────╮',
  '│ Bash command                             │',
  '│                                          │',
  '│   npm install react-native-svg@15.8.0    │',
  '│                                          │',
  '│ Do you want to proceed?                  │',
  '│ ❯ 1. Yes                                 │',
  "│   2. Yes, and don't ask again for npm install commands │",
  '│   3. No, and tell Claude what to do differently (esc) │',
  '╰──────────────────────────────────────────╯',
  '  Enter to confirm · Esc to exit',
  '',
].join('\n');

test('a Bash question: three answers, the second is "don\'t ask again"', () => {
  assert.deepEqual(permissionOptions(bash).map((o) => o.n), [1, 2, 3]);
  assert.deepEqual(alwaysOption(bash), { key: '2', text: "Yes, and don't ask again for npm install commands", label: "Don't ask again for npm install commands" });
});

test('a file edit: "allow all edits during this session", without the key hint', () => {
  const edit = ['Do you want to make this edit to app.js?', '❯ 1. Yes', '  2. Yes, allow all edits during this session (shift+tab)', '  3. No, and tell Claude what to do differently (esc)'].join('\n');
  assert.deepEqual(alwaysOption(edit), { key: '2', text: 'Yes, allow all edits during this session (shift+tab)', label: 'Allow all edits during this session' });
});

test('an answer wrapped onto the next line is read whole', () => {
  const wrapped = ['Do you want to proceed?', '❯ 1. Yes', "  2. Yes, and don't ask again for npm install", '     commands in ~/projects/app', '  3. No (esc)'].join('\n');
  assert.equal(alwaysOption(wrapped).text, "Yes, and don't ask again for npm install commands in ~/projects/app");
});

test('nothing is guessed: no such answer, no menu, a menu that is not a permission question', () => {
  assert.equal(alwaysOption(['Do you want to proceed?', '❯ 1. Yes', '  2. No, and tell Claude what to do differently (esc)'].join('\n')), null, 'only Yes and No');
  assert.equal(alwaysOption('Done: the tests pass.\n> '), null, 'no menu');
  assert.equal(alwaysOption(['What next?', '❯ 1. Stop and wait for limit to reset', "  2. Yes, and don't ask again"].join('\n')), null, 'the first answer is not Yes');
  // The question scrolled away: a menu far above the last lines does not count.
  assert.equal(alwaysOption(`${bash}\n${Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n')}`), null);
  assert.equal(alwaysOption(['❯ 1. Yes', "  3. Yes, and don't ask again"].join('\n')), null, 'numbers out of order');
  assert.equal(alwaysOption(''), null);
  assert.equal(alwaysOption(null), null);
});

test('a menu of any kind at the bottom of the screen: typing now would answer it', () => {
  assert.equal(menuOpen(bash), true, 'a permission question');
  const limit = ["  ⎿  You've hit your 5-hour limit · resets 5pm (UTC)", '', '  What do you want to do?', '  ❯ 1. Stop and wait for limit to reset', '    2. Switch to extra usage'].join('\n');
  assert.equal(menuOpen(limit), true, 'the menu Claude Code may open at a limit');
  assert.equal(permissionOptions(limit), null, 'which is not a permission question');
  assert.equal(menuOpen("  ⎿  You've hit your 5-hour limit · resets 5pm (UTC)\n● Usage limit reached · continuing automatically at 5pm · esc to cancel\n────\n❯ \n────\n"), false, 'the plain message box');
  assert.equal(menuOpen('1. first\n2. second\n' + 'more text\n'.repeat(12)), false, 'a numbered list further up is no menu');
  assert.equal(menuOpen(''), false);
  assert.equal(menuOpen(undefined), false);
});
