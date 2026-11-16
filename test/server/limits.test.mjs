import assert from 'node:assert/strict';
import test from 'node:test';
import { detectLimit } from '../../src/server/limits.mjs';

// Lines as Claude Code 2.1.323 prints them (strings taken from the binary, filled in the way it fills them).
const HITS = [
  ["  ⎿  You've hit your 5-hour limit · resets 5pm (Europe/Berlin)", '5pm (Europe/Berlin)'],
  ["You've hit your weekly limit · resets Nov 18, 9am (UTC)", 'Nov 18, 9am (UTC)'],
  ["⏺ You've hit your session limit · resets 11:30pm", '11:30pm'],
  ["You’ve hit your Opus limit · resets 3am", '3am'],
  ["You've reached your Fable limit for this week. Switch models?", ''],
  ["You're out of usage credits. See Usage in Settings", ''],
  ["You've hit your monthly spend limit · your individual spend limit resets Dec 1", 'Dec 1'],
  ['Your org is out of usage · contact your admin', ''],
  ["You're out of extra usage", ''],
  ['Usage limit reached · continuing automatically in 2h 10m · esc to cancel', ''],
  ['Fable limit reached · continuing on Opus uses usage credits', ''],
  ['❯ 1. Stop and wait for limit to reset', ''],
  ['Paused · usage limit resets at 4pm', '4pm'],
  ['Opus 4 requires usage credits. /model to switch models.', ''],
];

test('every real limit message is detected', () => {
  for (const [line, resets] of HITS) {
    const screen = `some output\n${line}\n\n╭────╮\n│ >  │\n╰────╯\n  ? for shortcuts\n`;
    const r = detectLimit(screen);
    assert.ok(r, line);
    assert.equal(r.resets, resets, line);
  }
});

test('ordinary output is not a limit', () => {
  const normal = [
    'Working on it…',
    "I'll check whether you've hit your rate limit in the code: the limiter lives in src/x.ts",
  ];
  assert.equal(detectLimit(normal.join('\n')), null);
  assert.equal(detectLimit("You've used 80% of your weekly limit · resets Nov 18"), null, 'a warning is not a hit');
  assert.equal(detectLimit("You're close to your 5-hour limit"), null);
  assert.equal(detectLimit(''), null);
  assert.equal(detectLimit(undefined), null);
});

test('only the last lines count', () => {
  const old = "You've hit your 5-hour limit · resets 5pm\n" + 'line\n'.repeat(40);
  assert.equal(detectLimit(old), null);
  assert.ok(detectLimit(old, 50));
});

// As Claude Code 2.1.325 draws it (taken from a session run against a stand-in API that answered with a 5-hour limit):
// the conversation, the prompt box, and the footer under it.
const TALK = [
  '❯ first message',
  "  ⎿  You've hit your 5-hour limit · resets 2:29pm (Europe/Berlin)",
  '● Usage limit reached · continuing automatically at 2:29pm · esc to cancel',
  '✻ Baked for 0s',
];
const BOX = ['────────────────────────────────', '❯ ', '────────────────────────────────'];
const FOOTER = ['  ⚠ Usage limit reached · limit resets 2:29pm', '    Continuing automatically at 2:29pm · Esc to cancel'];
const screen = (talk, footer = FOOTER) => [...talk, ...BOX, ...footer].join('\n');
const AT_LIMIT = screen(TALK);

test('a limit Claude has answered past is history: the session went on', () => {
  assert.ok(detectLimit(AT_LIMIT), 'standing at the limit');
  const typed = [...TALK, '❯ Continue from where you stopped.', '✢ Honking…'];
  assert.ok(detectLimit(screen(typed)), 'a message was typed, nothing came back yet: still at the limit as far as the screen says');
  assert.equal(detectLimit(screen([...typed, '● Picking up where I left off.', '✻ Crunched for 2s'], [])), null, 'a reply under it');
  assert.equal(detectLimit(screen([...typed, '⏺ Bash(npm test)', '  ⎿  ok'], [])), null, 'a tool call under it');
  // a new limit after the session went on is a limit again
  const again = screen([...typed, '● Picking up.', "  ⎿  You've hit your weekly limit · resets Nov 18, 9am (UTC)"], []);
  assert.equal(detectLimit(again).resets, 'Nov 18, 9am (UTC)');
  // without a prompt box on the screen (a plain transcript) the rest of the screen is the conversation
  assert.equal(detectLimit(`${TALK.join('\n')}\n● Picking up.\n`), null);
  // a bulleted limit line is not a reply
  assert.ok(detectLimit("● You've hit your 5-hour limit · resets 5pm\n● Usage limit reached · continuing automatically in 2h · esc to cancel\n"));
});

test('the owner\'s own status line under the prompt box is not a reply, bullet or not', () => {
  for (const status of ['  ● main* · Opus · 42%', '⏺ ctx 40%', '● 5h 100% · resets 2:29pm']) {
    const r = detectLimit(screen(TALK, [...FOOTER, status]));
    assert.ok(r, status);
    assert.equal(r.resets, '', 'the line found is the one above the box');
    assert.ok(detectLimit(screen(TALK, [status])), `${status}, without the notice`);
  }
  // an older prompt box with sides, and a status line under it
  const old = [...TALK, '╭──────────────────────╮', '│ >                    │', '╰──────────────────────╯', '  ● main · 42%'].join('\n');
  assert.ok(detectLimit(old));
  // a limit notice in the footer is about now, whatever the conversation above it shows
  const footer = screen(['❯ hi', '● Hello.'], ["  ● You've hit your 5-hour limit · resets 5pm", '  ● main · 42%']);
  assert.equal(detectLimit(footer).resets, '5pm');
  // and a reply between the limit line and the box still means the session went on, status line or not
  assert.equal(detectLimit(screen([...TALK, '❯ go on', '● Going on.'], ['  ● main · 42%'])), null);
});
