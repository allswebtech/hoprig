// Home (web/home.js, web/sessionitem.js, web/onecard.js): the groups in their order and words, a group with nothing
// in it not drawn, one card per conversation, a card's last line never its title again, the providers line only
// when something is wrong, the Set up card only while set-up is unfinished.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import './chat/fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
const { GROUPS, homeGroups, setupShown, showsComputer } = await import('../web/home.js');
const { foldLine } = await import('../web/homefold.js');
const { lastLine } = await import('../web/sessionitem.js');
const { cardKey, oneCardPerKey } = await import('../web/onecard.js');
const { sideGroups } = await import('../web/chat/sidebar.js');
const src = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), 'utf8');

const NOW = Date.UTC(2026, 10, 27, 12);

test('the groups in order and words: Needs you, Working, Ready, Terminals; the fold says Ready', () => {
  assert.deepEqual(GROUPS.map((g) => g[1]), ['Needs you', 'Working', 'Ready', 'Terminals']);
  assert.equal(foldLine(3), 'Ready for more than 6 hours: 3');
});

test('a group with no rows is not drawn; the rows at the top of Needs you draw it alone', () => {
  const groups = homeGroups([{ name: 'a', kind: 'claude', status: 'working', statusAt: NOW }], { now: NOW });
  assert.deepEqual(groups.map((g) => g.id), ['working']);
  assert.deepEqual(homeGroups([], { now: NOW }), []);
  const needs = homeGroups([], { needsRows: ['providers', null], now: NOW });
  assert.deepEqual(needs.map((g) => [g.id, g.count, g.rows]), [['needs', 1, ['providers']]]);
  const old = homeGroups([{ name: 'b', kind: 'claude', status: 'waiting', lastMessage: 'x', statusAt: NOW - 9 * 3600_000 }], { now: NOW });
  assert.deepEqual(old.map((g) => [g.id, g.recent.length, g.old.length]), [['waiting', 0, 1]], 'Ready with only its fold');
});

test('a card\'s last line never repeats its title', () => {
  assert.equal(lastLine({ display: 'Three-word greeting', title: 'Three-word greeting', kind: 'claude' }), null);
  assert.equal(lastLine({ display: 'Three-word greeting', kind: 'chat', lastMessage: 'Three-word greeting' }), null);
  assert.equal(lastLine({ display: 'Fix the cart', kind: 'chat', lastMessage: 'Done: the cart is a list now.' }), 'Done: the cart is a list now.');
  assert.doesNotMatch(src('sessionitem.js'), /p\.card-msg\.title/);
});

test('one card per key, the newer one; without a key the old fallback, chat and terminal apart', () => {
  assert.equal(cardKey({ key: 'claude:c1', kind: 'chat', chatId: 'c1' }), 'claude:c1');
  assert.equal(cardKey({ kind: 'chat', chatId: 'c1' }), 'chat:c1');
  assert.equal(cardKey({ kind: 'claude', name: 'shop' }), 'term:shop');
  const two = [{ key: 'claude:c1', name: 'old', statusAt: 1 }, { key: 'claude:c1', name: 'new', statusAt: 2 }, { key: 'term:x', name: 'x', statusAt: 0 }];
  assert.deepEqual(oneCardPerKey(two).map((s) => s.name), ['new', 'x']);
  assert.equal(oneCardPerKey([{ kind: 'chat', chatId: 'c1', name: 'chat-c1' }, { kind: 'claude', name: 'shop' }]).length, 2);
  const list = sideGroups([{ machine: null, machineLabel: 'Here', status: 'online', sessions: two }], { group: 'state' });
  assert.deepEqual(list.flatMap((g) => g.sessions.map((s) => s.name)), ['new', 'x'], 'the App session list too');
});

test('the computer pill only while every computer is shown', () => {
  assert.equal(showsComputer(true, 'all'), true);
  assert.equal(showsComputer(true, '~'), false);
  assert.equal(showsComputer(false, 'all'), false);
});

test('the providers line only as a Needs you row when something is wrong; no intro; Set up only while unfinished', () => {
  const home = src('home.js');
  assert.match(home, /const needsRows = \[\.\.\.providerRows\]/, 'the providers line is a row of Needs you');
  assert.doesNotMatch(home, /intro: /, 'no sentence under the title');
  assert.equal(setupShown({ mode: 'open' }), true);
  assert.equal(setupShown({ mode: 'collapsed' }), false, 'all done: no card');
  assert.equal(setupShown({ mode: 'hidden' }), false);
});
