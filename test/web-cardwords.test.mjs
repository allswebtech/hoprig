// The words of a Home card (web/sessionitem.js): the last line as plain text, the state said on the card itself.
import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.location ||= { hash: '', search: '', pathname: '/' };
const { plainLine } = await import('../web/sessionitem.js');
const lib = await import('../web/lib.js');
const { readyLast } = await import('../web/homefold.js');


test('formatting marks are taken out of the last line of a card', () => {
  assert.equal(plainLine('**Done.** I changed `cart.js` and ran the tests.'), 'Done. I changed cart.js and ran the tests.');
  assert.equal(plainLine('## Summary\n- first thing\n- second thing'), 'Summary first thing · second thing');
  assert.equal(plainLine('1. one\n2. two'), 'one · two');
  assert.equal(plainLine('See [the guide](https://example.com/g) now'), 'See the guide now');
  assert.equal(plainLine('```js\nlet a = 1;\n```\nDone'), 'let a = 1; Done');
  assert.equal(plainLine('> quoted _word_ and __more__'), 'quoted word and more');
  assert.equal(plainLine('2 * 3 = 6'), '2 * 3 = 6', 'a lone star in a sum stays');
  assert.equal(plainLine(''), '');
});

test('the items of a list are joined with a dot, never run into one sentence', () => {
  assert.equal(plainLine('Summary\n- all 9 pass\n- one skipped'), 'Summary all 9 pass · one skipped');
  assert.equal(plainLine('- a\n\n- b'), 'a b', 'a blank line ends the list');
  assert.equal(plainLine('Done.\n1. all 9 pass\n2. one skipped\n3. none left'), 'Done. all 9 pass · one skipped · none left');
});

test('a card reset is said as the 24-hour clock and the time left, only where the time is known', () => {
  const now = Date.parse('2026-03-10T14:00:00');
  const s = { profile: { name: 'max' }, limit: { text: "You've hit your 5-hour limit · resets 6pm", resets: '6pm' } };
  const at = (min) => now + min * 60_000;
  const profiles = (min) => [{ name: 'max', usage: { fiveHour: { pct: 100, resetsAt: at(min) } } }];
  assert.equal(lib.limitResetText(s, profiles(130), now), "You've hit your 5-hour limit · resets 16:10 (in\u00a02\u00a0h\u00a010\u00a0min)");
  assert.equal(lib.limitResetText(s, [{ name: 'max' }], now), null, 'no time known: the tool words stay');
  assert.equal(lib.limitResetText(s, profiles(-5), now), null, 'a time that has passed is not said');
  assert.equal(lib.limitResetText({ ...s, limit: { text: 'limit reached', resets: '' } }, profiles(130), now), null);
});

test('Finished: the cards with a result stand first, the Ready ones after, each in its order', () => {
  const mk = (name, lastMessage) => ({ name, kind: 'claude', status: 'waiting', lastMessage });
  const list = [mk('r1', ''), mk('f1', 'Done'), mk('r2', ''), mk('f2', 'Done too')];
  assert.deepEqual(readyLast(list).map((s) => s.name), ['f1', 'f2', 'r1', 'r2']);
});
