// The empty chat says what to do in a newcomer's words, not by the terminal he may never have used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const src = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'chat', 'timeline.js'), 'utf8');

test('the empty chat asks for his own words and says what the coding tool does, with no word of a terminal', () => {
  const line = src.split('\n').find((l) => l.includes("h('div.chat-empty'"));
  assert.ok(line, 'the empty chat is drawn');
  assert.match(line, /Write what you want, in your own words\. \$\{who\(\)\} reads and changes the files of this project, and asks you before anything that needs your OK\./);
  assert.doesNotMatch(line, /terminal/);
});
