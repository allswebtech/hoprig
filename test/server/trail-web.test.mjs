// The way back (web/trail.js): a page another page sent you to links back to that page. The trail is pure state, so
// it is driven here address by address, as the router would; the pages themselves are driven in a headless browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { arrive, cameFrom, forgetHere, named, placeOf, resetTrail, startOver, wayBack } from '../../web/trail.js';

/** The router opens `hash` (coming from `from`), and the page names itself `label`. */
function open(hash, label, from = null) {
  arrive(hash, from);
  named(label);
}

test('which page an address shows', () => {
  assert.equal(placeOf('#/'), 'home');
  assert.equal(placeOf(''), 'home');
  assert.equal(placeOf('#/s/shop-1'), 'session');
  assert.equal(placeOf('#/computer/setup'), 'computer');
  assert.equal(placeOf('#/m/laptop/computer/setup'), 'computer', 'another computer: the same page');
  assert.equal(placeOf('#/m/laptop'), 'home');
  assert.equal(placeOf('#/settings/security'), 'settings');
});

test('Setup → Fix opens a session → its way back is Setup; going back ends that step', () => {
  resetTrail();
  open('#/computer/setup', 'Setup');
  assert.equal(wayBack('#/computers'), null, 'entered from the menu: its own parent');
  open('#/s/fix-docker', 'fix-docker');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' });
  open('#/computer/setup', 'Setup');
  assert.equal(wayBack('#/computers'), null, 'back at Setup: nothing behind it but its parent');
});

test('a tab changed in place is where the way back goes', () => {
  resetTrail();
  open('#/computer', 'This computer');
  // The Setup tab replaces the address without a redraw by the router; the next move says where it was.
  open('#/s/fix', 'fix', '#/computer/setup');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'This computer' });
});

test('several steps: each page goes back to the one before it; a press in the navigation starts over', () => {
  resetTrail();
  open('#/computer/setup', 'Setup');
  open('#/s/fix', 'fix');
  open('#/providers', 'Providers');
  assert.deepEqual(wayBack(), { hash: '#/s/fix', label: 'fix' });
  open('#/s/fix', 'fix');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' }, 'the session again: Providers is gone from the way');
  startOver({ button: 0 });
  open('#/workspace', 'Workspace');
  assert.equal(wayBack(), null, 'a new trail');
});

test('a press that opens a new tab keeps the trail', () => {
  resetTrail();
  open('#/computer/setup', 'Setup');
  startOver({ ctrlKey: true, button: 0 });
  open('#/s/fix', 'fix');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' });
});

test('New session only starts the session: it goes back to where you were before', () => {
  resetTrail();
  open('#/', 'Home');
  open('#/new', 'New session');
  assert.deepEqual(wayBack('#/'), { hash: '#/', label: 'Home' });
  open('#/s/shop', 'shop');
  assert.deepEqual(wayBack(), { hash: '#/', label: 'Home' });
});

test('moving on inside a page whose parent is part of it: that parent is the way back', () => {
  resetTrail();
  open('#/computer/setup', 'Setup');
  open('#/workspace', 'Workspace');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' });
  open('#/workspace/shop', 'shop');
  assert.equal(wayBack('#/workspace'), null, 'a project goes back to the Workspace list');
  open('#/workspace', 'Workspace');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' }, 'and the list still to Setup');
});

test('Settings: another page of its list goes back to the list on a phone; the page you came from stays known', () => {
  resetTrail();
  open('#/s/one', 'one');
  open('#/settings/security', 'Settings');
  assert.deepEqual(wayBack('#/settings'), { hash: '#/s/one', label: 'one' });
  open('#/settings/appearance', 'Settings');
  assert.equal(wayBack('#/settings'), null, 'a phone: back to the list');
  assert.deepEqual(cameFrom(), { hash: '#/s/one', label: 'one' }, 'a desktop, where the list is beside it: back to the session');
});

test('another session from the switcher keeps where the first one came from', () => {
  resetTrail();
  open('#/computer/setup', 'Setup');
  open('#/s/one', 'one');
  open('#/s/two', 'two');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' });
  open('#/providers', 'Providers');
  assert.deepEqual(wayBack(), { hash: '#/s/two', label: 'two' }, 'the session you were in');
});

test('a chat is a place of its own; a closed one is never a way back; Home starts a new trail', () => {
  resetTrail();
  open('#/computer/setup', 'Setup');
  open('#/chat/a', 'Fix the build');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' });
  open('#/chat/b', 'Another chat');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' }, 'chat to chat keeps where the first came from, like sessions');
  open('#/s/one', 'one');
  assert.deepEqual(wayBack(), { hash: '#/chat/b', label: 'Another chat' }, 'a session opened from a chat goes back to it');
  open('#/chat/b', 'Another chat');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' }, 'back at the chat: the session is gone from the way');
  resetTrail();
  open('#/new', 'New session');
  open('#/chat/c', 'New chat');
  assert.equal(wayBack(), null, 'New session hands its way back on to the chat it starts');
  resetTrail();
  open('#/computer/setup', 'Setup');
  open('#/chat/d', 'Chat');
  forgetHere(); // "Open in terminal": the chat closes
  open('#/s/term', 'term');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' }, 'not back to the closed chat');
  open('#/', 'Home');
  open('#/providers', 'Providers');
  assert.deepEqual(wayBack(), { hash: '#/', label: 'Home' }, 'Home: a new trail');
});

test('the session switcher: back at a session on the way takes off what came after it; never a link to itself', () => {
  resetTrail();
  open('#/computer/setup', 'Setup');
  open('#/s/one', 'one');
  open('#/chat/c', 'Chat');
  open('#/s/term', 'term');
  open('#/s/one', 'one'); // picked in the switcher
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' }, 'not back to itself, not to the chat');
  open('#/s/two', 'two');
  open('#/s/one', 'one');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' });
});

test('another computer: its page is a place of its own', () => {
  resetTrail();
  open('#/m/laptop/computer/setup', 'Setup · laptop');
  open('#/m/desk/computer', 'desk');
  assert.deepEqual(wayBack('#/computers'), { hash: '#/m/laptop/computer/setup', label: 'Setup · laptop' });
  open('#/m/laptop/s/fix', 'fix');
  open('#/m/desk/s/fix', 'fix');
  assert.deepEqual(wayBack(), { hash: '#/m/laptop/s/fix', label: 'fix' }, 'a session of the same name on another computer');
});

test('a session that ended by itself is never a way back', () => {
  resetTrail();
  open('#/computer/setup', 'Setup');
  open('#/s/gone', 'gone');
  forgetHere(); // the "This session has ended" screen
  open('#/providers', 'Providers');
  assert.deepEqual(wayBack(), { hash: '#/computer/setup', label: 'Setup' });
});

test('at most eight places, and labels are short', () => {
  resetTrail();
  for (let i = 0; i < 12; i++) open(i % 2 ? `#/s/s${i}` : `#/page${i}`, `${'x'.repeat(80)}${i}`);
  assert.equal(wayBack().label.length, 60);
});
