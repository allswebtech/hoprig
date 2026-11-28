// One set of words for what a session does, on Home, in the App's session list, in the notifications, in Settings and on
// Tia's cards (web/lib.js stateOf). The inner keys stay (status waiting and ended, the event keys, the prefs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import '../chat/fakedom.mjs';

globalThis.window = globalThis.window || { addEventListener() {} };
const { stateOf, bgCommandNote, BG_COMMAND_LINE } = await import('../../web/lib.js');
const { GROUPS } = await import('../../web/home.js');
const { foldLine } = await import('../../web/homefold.js');
const { sideGroups } = await import('../../web/chat/sidebar.js');
const src = (p) => fs.readFileSync(new URL(`../../web/${p}`, import.meta.url), 'utf8');

test('a turn that is over is Finished (green), a session nobody has written to yet is Ready, an ended one is Ended', () => {
  assert.deepEqual(stateOf({ kind: 'chat', status: 'waiting', lastMessage: 'Done: the cart is a list now.' }), { key: 'waiting', text: 'Finished', rank: 2 });
  assert.deepEqual(stateOf({ kind: 'chat', status: 'waiting', lastMessage: '' }), { key: 'waiting', text: 'Ready', rank: 2 }, 'no message of Claude yet: it has not finished anything');
  assert.equal(stateOf({ kind: 'claude', status: 'waiting' }).text, 'Ready');
  assert.equal(stateOf({ kind: 'claude', status: 'ended' }).text, 'Ended');
  assert.equal(stateOf({ kind: 'claude', status: 'ended' }).key, 'ended', 'the key stays');
  assert.equal(stateOf({ kind: 'chat', status: 'working', background: true }).text, 'Working in the background');
  assert.equal(stateOf({ kind: 'chat', status: 'working' }).text, 'Working');
  assert.equal(stateOf({ kind: 'shell', status: 'waiting' }).text, 'Terminal');
  assert.equal(stateOf({ kind: 'chat', status: 'waiting', limit: { text: 'x' }, lastMessage: 'a' }).text, 'Limit reached', 'a limit is still a limit');
});

test('a chat whose last turn ended in an error does not read Finished in the list', () => {
  assert.equal(stateOf({ kind: 'chat', status: 'waiting', lastMessage: 'x', endedInError: true }).text, 'Stopped with an error');
  assert.equal(stateOf({ kind: 'chat', status: 'waiting', lastMessage: '', endedInError: true }).text, 'Stopped with an error');
  assert.equal(stateOf({ kind: 'chat', status: 'waiting', lastMessage: 'x', endedInError: false }).text, 'Finished');
});

test('a terminal with a command still running in the background stays Finished, with its note', () => {
  const s = { kind: 'claude', status: 'waiting', lastMessage: 'Started the dev server.', bgCommands: 1 };
  assert.equal(stateOf(s).text, 'Finished');
  assert.equal(bgCommandNote(s), BG_COMMAND_LINE);
});

test('Home\'s group is Finished (waiting and ended), its fold line says so, the list says the same', () => {
  const g = GROUPS.find((x) => x[0] === 'waiting');
  assert.equal(g[1], 'Finished');
  assert.deepEqual(g[2], ['waiting', 'ended'], 'the keys stay');
  assert.equal(foldLine(12), 'Finished more than 6 hours ago: 12');
  assert.equal(foldLine(1), 'Finished more than 6 hours ago: 1');
  const machines = [{ machine: null, machineLabel: 'W', status: 'online', sessions: [{ name: 'a', kind: 'chat', chatId: 'a', status: 'waiting', cwd: '/w/a' }] }];
  assert.deepEqual(sideGroups(machines, { group: 'state' }).map((x) => x.label), ['Finished']);
});

test('Settings, the notifications and Tia\'s cards use the same words', () => {
  assert.match(src('settings.js'), /EVENT_LABELS = \{ waiting: 'Finished', attention: 'Needs your OK', limit: 'Limit reached', ended: 'Ended',/);
  assert.match(src('store.js'), /waiting: 'has finished',/);
  assert.match(src('store.js'), /ended: 'has ended',/);
  assert.match(src('tiacards.js'), /waiting: 'Finished',/);
  assert.match(src('tiacards.js'), /ended: 'Ended',/);
  assert.doesNotMatch(src('tiacards.js'), /Waiting for your next message/);
});
