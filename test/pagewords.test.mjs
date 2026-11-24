// Work and the Operator said the same "what needs you now" for two different lists, so a newcomer could not tell the
// pages apart. Each page has one line of its own now, said the same wherever the page is named: Work's Today is what
// is due and what waits for your yes; the Operator is what stopped or is about to.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const WORK = 'what is due, and what waits for your yes';
const OPERATOR = 'what stopped or is about to';

test('Work and the Operator each say what they list, in words of their own, wherever the page is named', () => {
  const work = /intro: '([^']*)'/.exec(read('web/work.js').slice(read('web/work.js').indexOf("title: 'Work'")))[1];
  const operator = /export const INTRO = '([^']*)'/.exec(read('web/operator.js'))[1];
  assert.match(work, new RegExp(WORK.replace(/,/g, ',?')), work);
  assert.match(operator.toLowerCase(), new RegExp(`^${OPERATOR}`), operator);
  for (const [name, text] of [['Work', work], ['Operator', operator]]) assert.doesNotMatch(text, /needs you now/, `${name}'s page`);
  const readme = read('README.md').replace(/\n\s*/g, ' ');
  assert.match(readme, /\*\*Work\*\*: your tasks, and its \*\*Today\*\* tab that lists what is due this week, what waits for your yes/);
  assert.match(readme, /\*\*Operator\*\*: one page with what stopped or is about to, from everything Hoprig watches/);
  assert.match(read('docs/WORK.md'), /one screen \(Today\) for what is due and what waits for\s+your yes/);
  assert.match(read('docs/OPERATOR.md'), /^# Operator: what stopped or is about to\n/);
  assert.match(read('site/content/changelog.md'), /\*\*Operator: one page that says what stopped or is about to\.\*\*/);
});

test('the changelog says what is true of a help word, and the Operator\'s step by the page\'s word', () => {
  const log = read('site/content/changelog.md');
  const line = log.split('\n').find((l) => l.startsWith('- **A help word after a command only prints help.**'));
  assert.ok(line, 'the line about the help word');
  assert.match(line, /after any command, or after any of its subcommands/);
  assert.match(line, /`hoprig service uninstall help` turned the background dashboard off/);
  assert.doesNotMatch(line, /`help` anywhere counts for/, 'the old rule, which no longer holds');
  assert.doesNotMatch(log, /suggested step/, 'the page says "recommended"');
  assert.match(log, /each rule does its item's recommended step/);
});
