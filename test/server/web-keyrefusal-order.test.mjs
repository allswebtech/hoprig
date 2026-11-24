// The save sheet's key refusal offers the press first: Move it out, then the coding tool's way (or .gitignore) as
// another way; after a move the same sheet offers Save the rest, not "open this again".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import '../chat/fakedom.mjs';

const { saveWords } = await import('../../web/gitsetup.js');
const base = { count: 1, files: ['.env'], more: 0, all: ['.env'], ahead: 0, behind: 0, repo: 'team/ai_brain on git.example.test', upstream: 'origin/main' };

test('Move it out first; the session and .gitignore way after it, as another way', () => {
  const w = saveWords({ ...base, secret: ['.env'], secretTracked: [], secretAdvice: 'Ask your coding tool in a session to move it out of the AI brain (naming it in the AI brain\'s .gitignore works too).', movedOut: '~/Workspace/ai_brain-moved-out', moveSeen: 'a'.repeat(64) });
  assert.equal(w.lines.length, 1, 'no advice line before the button\'s sentence');
  assert.match(w.moveOut.text, /^Move it out of the AI brain now/);
  assert.match(w.other, /^Another way, which also keeps it out of the save for good: ask your coding tool in a session/);
  const src = fs.readFileSync(new URL('../../web/gitsetup.js', import.meta.url), 'utf8');
  const a = src.indexOf("w.moveOut ? h('p.sheet-text', h('strong', `${w.moveOut.text}.`))");
  const b = src.indexOf("w.other ? h('p.hint', w.other) : null");
  assert.ok(a > 0 && b > a, 'drawn after the Move out sentence');
});

test('after the move, the sheet offers Save the rest itself', () => {
  const src = fs.readFileSync(new URL('../../web/gitsetup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /Open the save again to save the rest/);
  assert.match(src, /label: 'Save the rest', onclick: \(\) => \{\n\s+close\(false\);\n\s+saveSheet\(\);/);
});

test('without the button (an older server, a brain that is a link) the advice stays in its place', () => {
  const w = saveWords({ ...base, secret: ['.env'], secretTracked: [], secretAdvice: 'Ask your coding tool in a session to move it out of the AI brain.' });
  assert.equal(w.other, undefined);
  assert.match(w.lines[1], /^Ask your coding tool in a session/);
});
