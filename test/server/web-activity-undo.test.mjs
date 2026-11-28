// The Undo press on Tia's Activity (web/tia.js): one plain button on an entry the server says can be taken back, one request, a
// plain word after it; the owner's press in the log reads as a sentence of its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import '../chat/fakedom.mjs';

globalThis.location ||= { hash: '#/tia', pathname: '/', protocol: 'http:', hostname: 'localhost', origin: 'http://localhost', href: '' };
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {} });
const { activityWords } = await import('../../web/tiaactivity.js');
const src = fs.readFileSync(new URL('../../web/tia.js', import.meta.url), 'utf8');

test('the Undo button: shown for an entry marked press, "Taken back" for one marked done, posts the time of the entry', () => {
  assert.match(src, /e\.undo === 'press'/);
  assert.match(src, /label: 'Undo'/);
  assert.match(src, /api\(`\$\{A\}\/undo`, \{ at: e\.at \}\)/);
  assert.match(src, /e\.undo === 'done' \? h\('span\.row-sub', 'Taken back'\)/);
});

test('the owner\'s press is a line of Activity in plain words', () => {
  const p = { computer: (x) => x, provider: (x) => x, chat: (x) => x };
  assert.equal(activityWords({ tool: 'undo', actor: 'owner', input: { act: 'watch_work' }, result: { undid: 1 } }, p).what, 'take one of her acts back');
});
