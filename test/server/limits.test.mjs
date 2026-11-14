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
