// Ending sessions from Home's End sheet (web/closesheet.js) and End session in a session's menu (web/session.js)
// are one act through one route: the sheet's sentence names End session, and both send him to one place to continue.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sheet = fs.readFileSync(new URL('../../web/closesheet.js', import.meta.url), 'utf8');
const session = fs.readFileSync(new URL('../../web/session.js', import.meta.url), 'utf8');
const sentence = (src, re) => { const m = re.exec(src); assert.ok(m, `found ${re}`); return m[1].replace(/\\'/g, "'"); };

test('the End sheet says it does what End session does, and both name the project\'s page to continue', () => {
  const close = sentence(sheet, /export const END_TEXT = '((?:[^'\\]|\\.)*)'/);
  const end = sentence(session, /text: '(Everything running in this session stops\.(?:[^'\\]|\\.)*)'/);
  // One act, one word: the sheet ends, and says what ending does in the words of End session's own question; it no
  // longer points at a menu he may never have opened, or at a "program".
  assert.match(close, /^This ends each session: everything running in it stops\./, 'the sheet says what End does');
  assert.match(end, /^Everything running in this session stops\./, 'as End session says it');
  assert.doesNotMatch(close, /\bprogram\b|\bmenu\b/, 'no word he does not know');
  assert.match(session, /label: 'End session'/, 'the menu item the sentence names');
  for (const t of [close, end]) assert.match(t, /continue[d]? (it |later )?from the project's page\./);
  assert.doesNotMatch(end, /from its folder/);
});
