// What Claude Code asks on the screen (src/server/prompts.mjs). The page's Allow, Do not allow and "always" are typed
// only into Claude Code's permission dialog, recognised by its own fixed parts; the fixtures are real screens of
// Claude Code 2.1.326 at several widths (test/server/fixtures/claude-screens, paths replaced by neutral ones of the
// same length).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { alwaysOption, dialogShows, menuOpen, permissionDialog, permissionQuestion } from '../../src/server/prompts.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-screens');
const screen = (name) => fs.readFileSync(path.join(DIR, `${name}.txt`), 'utf8');

// ---------- the permission dialog: one test per real capture and width ----------
const DIALOGS = {
  // tool: [widths, the answers' count, the "always" answer's number or null]
  bash: [[80, 60, 46, 38, 30, 24, 20, 16], 4, '2'],
  write: [[80, 46, 30, 20, 16], 3, null],
  edit: [[80, 46, 30, 20, 16], 3, null],
  read: [[80, 46, 30, 20, 16], 3, '2'],
  fetch: [[80, 46, 30, 20, 16], 3, '2'], // no footer: its last answer ends "(esc)"
};
// Bypass mode: Claude Code's own stop before an rm of the home folder (Hoprig answers nothing there), and the
// question an "ask" rule of the settings makes; only the dialog itself was kept of these screens.
const OTHER_DIALOGS = { 'stop-rm-80': 2, 'stop-rm-46': 2, 'stop-rm-30': 2, 'stop-rm-20': 2, 'perm-askrule-80': 2 };
for (const [name, count] of Object.entries(OTHER_DIALOGS)) {
  test(`the permission dialog ${name} is recognised`, () => {
    const d = permissionDialog(screen(name));
    assert.deepEqual(d && d.options.map((o) => o.text), count === 2 ? ['Yes', 'No'] : null);
    assert.equal(alwaysOption(screen(name)), null, 'no "always" answer: no button');
  });
}
for (const [tool, [widths, count, always]] of Object.entries(DIALOGS)) {
  for (const w of widths) {
    test(`the permission dialog for ${tool}, ${w} columns wide, is recognised`, () => {
      const s = screen(`perm-${tool}-${w}`);
      const d = permissionDialog(s);
      assert.ok(d, 'recognised');
      assert.equal(d.options.length, count);
      assert.equal(d.options[0].text, 'Yes');
      assert.match(d.options[count - 1].text, /^No\b/);
      assert.equal(permissionQuestion(s), true);
      assert.equal(menuOpen(s), true, 'typing a message now would answer it');
      assert.equal(alwaysOption(s)?.key ?? null, always);
    });
  }
}

test('12 columns wide the dialog\'s question has scrolled away: not recognised, the owner answers in the terminal', () => {
  assert.equal(permissionDialog(screen('perm-bash-12')), null);
});

test('the "always" answers of 2.1.326, in Claude\'s own words, without "Yes, (and)"', () => {
  assert.deepEqual(alwaysOption(screen('perm-bash-80')), {
    key: '2',
    text: 'Yes, and always allow access to /home/robin/projects/example-shop-storef/frontend/web from this project',
    label: 'Always allow access to /home/robin/projects/example-shop-storef/frontend/web from this project',
  });
  assert.equal(alwaysOption(screen('perm-read-80')).label, 'Allow reading from /home/robin/projects/example-shop-store/frontend during this session');
  assert.equal(alwaysOption(screen('perm-fetch-80')).label, "Don't ask again for example.com");
  // A change of the session's mode is not an "always" for this permission: no button.
  for (const name of ['perm-edit-80', 'perm-write-80']) assert.equal(alwaysOption(screen(name)), null, name);
  assert.match(permissionDialog(screen('perm-edit-80')).options[1].text, /^Yes, and switch to accept edits/);
  assert.match(permissionDialog(screen('perm-bash-80')).options[2].text, /^Yes, and switch to auto mode/);
});

// ---------- what looks like it and is not ----------
const NOT = {
  'the question tool (AskUserQuestion)': ['ask-80', 'ask-46', 'ask-30', 'ask-16'],
  'the question tool with boxes to tick': ['multi-80', 'multi-46'],
  'the plan\'s approval, whose first answer turns bypass on': ['plan-80', 'plan-46'],
  'the folder trust dialog': ['trust-80'],
  'a model\'s own text that copies a dialog, above the message box': ['fake-80', 'fake-46'],
  'the message box after Esc': ['after-esc-80', 'after-plan-esc-80'],
};
for (const [what, names] of Object.entries(NOT)) {
  for (const name of names) {
    test(`not a permission dialog: ${what} (${name})`, () => {
      const s = screen(name);
      assert.equal(permissionDialog(s), null);
      assert.equal(permissionQuestion(s), false);
      assert.equal(alwaysOption(s), null);
    });
  }
}

test('the plan\'s approval is no permission dialog even where its first answer is shown as "Yes" alone', () => {
  // Only the fixed parts count: the plan is drawn three spaces in and has no footer of the permission dialog.
  const plan = screen('plan-80').replace('Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this', 'Yes').replace(/\n {8}session\n/, '\n');
  assert.equal(permissionDialog(plan), null);
});

test('a dialog with something drawn under it, or a part missing, is not recognised', () => {
  const s = screen('perm-bash-80');
  assert.equal(permissionDialog(`${s}${'─'.repeat(80)}\n❯ \n${'─'.repeat(80)}\n  ⏸ manual mode on · ? for shortcuts\n`), null, 'a message box under it');
  assert.equal(permissionDialog(s.replace(' Esc to cancel · Tab to amend', ' Esc to cancel')), null, 'another footer');
  assert.equal(permissionDialog(s.replace(' Do you want to proceed?', ' Proceed?')), null, 'another question');
  assert.equal(permissionDialog(s.replace(/^ ❯ 1\. Yes$/m, '❯ 1. Yes')), null, 'the answers at another indent');
  assert.equal(permissionDialog(s.replace(/^╌+$/gm, '').replace(/^─+$/gm, '')), null, 'no frame');
  assert.equal(permissionDialog(s.replace('   4. No', '   4. Later')), null, 'the last answer is not No');
  assert.equal(permissionDialog(''), null);
  assert.equal(permissionDialog(null), null);
});

// ---------- any menu (the message box's guard) ----------
test('a menu of any kind at the bottom of the screen: typing now would answer it', () => {
  assert.equal(menuOpen(screen('ask-80')), true, 'the question tool');
  assert.equal(menuOpen(screen('plan-80')), true, 'the plan');
  const limit = ["  ⎿  You've hit your 5-hour limit · resets 5pm (UTC)", '', '  What do you want to do?', '  ❯ 1. Stop and wait for limit to reset', '    2. Switch to extra usage'].join('\n');
  assert.equal(menuOpen(limit), true, 'the menu Claude Code may open at a limit');
  assert.equal(permissionQuestion(limit), false, 'which is not a permission dialog');
  assert.equal(menuOpen("  ⎿  You've hit your 5-hour limit · resets 5pm (UTC)\n● Usage limit reached · continuing automatically at 5pm · esc to cancel\n────\n❯ \n────\n"), false, 'the plain message box');
  assert.equal(menuOpen(screen('after-esc-80')), false, 'the message box after Esc');
  assert.equal(menuOpen('1. first\n2. second\n' + 'more text\n'.repeat(12)), false, 'a numbered list further up is no menu');
  assert.equal(menuOpen(''), false);
  assert.equal(menuOpen(undefined), false);
});

test('the dialog on the screen is the card\'s only when it shows the card\'s command or file, at every width', () => {
  const cases = [
    // [screen, the card's text (hook.mjs askedWhat), the session's folder, shown?]
    ...[80, 46, 30, 20, 16].map((w) => [`perm-bash-${w}`, 'touch b.txt', null, true]),
    ['perm-bash-80', 'touch', null, false], ['perm-bash-80', 'touch b.txt && rm x', null, false], ['perm-bash-80', 'Create empty file b.txt', null, false],
    ['perm-bash-80', 'touch b…', null, true], ['perm-bash-80', 'touch c…', null, false], ['perm-bash-80', '', null, false], ['perm-bash-80', '…', null, false],
    ['perm-bash-80', 'touch ***', null, false], ['perm-askrule-80', 'echo hoprigask1', null, true], ['stop-rm-20', 'rm -rf ~', null, true],
    // A file: by its full path where the dialog writes it so (Read), or relative to the session's folder (Create, Edit).
    ...[80, 30, 16].map((w) => [`perm-write-${w}`, '/w/p/w.txt', '/w/p', true]), ['perm-write-80', '/w/p/x.txt', '/w/p', false], ['perm-write-80', '/w/q/w.txt', '/w/p', false],
    ['perm-write-80', 'w.txt', null, true], ['perm-edit-46', '/w/p/a.txt', '/w/p/', true], ['perm-edit-46', '/w/p/a.txt…', '/w/p', false],
    ['perm-read-30', '/home/robin/projects/example-shop-storefr/frontend/notes.txt', null, true], ['perm-read-80', '/home/robin/projects/example-shop-storefr/frontend', null, false],
    ['perm-fetch-16', 'https://example.com', null, true], ['perm-fetch-80', 'https://example.co', null, false], ['perm-fetch-80', 'https://example.com/', null, true],
    // Not a permission dialog: nothing to compare with.
    ['ask-80', 'Yes', null, false], ['plan-80', 'x', null, false],
  ];
  for (const [name, what, cwd, shown] of cases) assert.equal(dialogShows(screen(name), what, cwd), shown, `${name}: ${what}`);
  for (const bad of [undefined, null, 7]) assert.equal(dialogShows(screen('perm-bash-80'), bad), false);
});

test('the dialog says which answer its arrow is on: Enter takes that one', () => {
  assert.equal(permissionDialog(screen('perm-bash-80')).cursor, 1);
  const moved = screen('perm-bash-80').replace(' ❯ 1. Yes', '   1. Yes').replace('   4. No', ' ❯ 4. No');
  assert.deepEqual([permissionDialog(moved).cursor, permissionDialog(moved).options.length], [4, 4]);
});
