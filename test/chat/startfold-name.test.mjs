// The folded first message names the project from its mark, also before the chat's own state has been read.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const { startMark } = await import('../../src/pcsetup/newprojectstart.mjs');
const { startFold } = await import('../../web/chat/words.js');

test('the mark carries the folder name and the fold reads it back', () => {
  assert.equal(startMark('bakery-website'), '<!-- hoprig:new-project bakery-website -->');
  const f = startFold(`${startMark('bakery-website')}\nUse the new-project skill …\n\n----- my brief -----\nBread.`);
  assert.deepEqual([f.name, f.brief], ['bakery-website', 'Bread.']);
  assert.equal(startFold('<!-- hoprig:new-project -->\nx').name, '', 'an old mark without a name still folds');
  assert.equal(startMark('a b<c>'), '<!-- hoprig:new-project abc -->', 'nothing that could end the mark');
  const s = fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'web', 'chat', 'timeline.js'), 'utf8');
  assert.match(s, /const name = \(fold && fold\.name\) \|\|/);
});
