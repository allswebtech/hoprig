// One conversation is one place (web/trail.js handOver, web/chat/handover.js): moving it between the App and a
// terminal replaces the address, so Back goes where he was before he opened it; a confirm sheet only while a reply
// is being written. The trail is pure state, driven address by address as the router would.
import assert from 'node:assert/strict';
import test from 'node:test';

const replaced = [];
globalThis.location ||= { hash: '', search: '', pathname: '/' };
globalThis.location.replace = (to) => replaced.push(to);
const { arrive, named, resetTrail, wayBack, handOver } = await import('../web/trail.js');
const { askFirst, terminalWrites } = await import('../web/chat/handover.js');

function open(hash, label, from = null) {
  arrive(hash, from);
  named(label);
}

test('Back after App, Terminal, App lands where he was before he opened the conversation', () => {
  resetTrail();
  replaced.length = 0;
  open('#/', 'Home');
  open('#/chat/a', 'Fix the cart');
  assert.deepEqual(wayBack(), { hash: '#/', label: 'Home' });
  handOver('#/s/shop');
  assert.deepEqual(replaced, ['#/s/shop'], 'the address is replaced, not added');
  open('#/s/shop', 'shop');
  assert.deepEqual(wayBack(), { hash: '#/', label: 'Home' }, 'the terminal goes back to Home, not to the chat');
  handOver('#/chat/a');
  open('#/chat/a', 'Fix the cart');
  assert.deepEqual(wayBack(), { hash: '#/', label: 'Home' }, 'the chat again: back to Home, not to the terminal');
  assert.equal(replaced.length, 2);
});

test('from the list: a hand-over keeps the list as the way back; another computer keeps its address', () => {
  resetTrail();
  replaced.length = 0;
  open('#/work', 'Work');
  open('#/m/laptop/s/shop', 'shop');
  handOver('#/chat/b', 'laptop');
  assert.deepEqual(replaced, ['#/m/laptop/chat/b']);
  open('#/m/laptop/chat/b', 'Fix the cart');
  assert.deepEqual(wayBack(), { hash: '#/work', label: 'Work' });
  open('#/providers', 'Providers');
  assert.deepEqual(wayBack(), { hash: '#/m/laptop/chat/b', label: 'Fix the cart' }, 'an ordinary move adds a place again');
});

test('no sheet when nothing runs, the sheet while a reply is being written', async () => {
  const asked = [];
  const sheet = async (o) => (asked.push(o.title), true);
  assert.equal(await askFirst(false, { title: 'Open in the Terminal?' }, sheet), true, 'one press does it');
  assert.deepEqual(asked, []);
  assert.equal(await askFirst(true, { title: 'Open in the Terminal?' }, sheet), true);
  assert.deepEqual(asked, ['Open in the Terminal?']);
  assert.equal(await askFirst(true, { title: 'Continue here?' }, async () => false), false, 'Cancel stops it');
});

test('a terminal writes a reply while its card says Working; a terminal not in the list is asked about', () => {
  const sessions = [
    { name: 'shop', kind: 'claude', status: 'waiting' },
    { name: 'cart', kind: 'claude', status: 'working' },
    { name: 'x', kind: 'chat', chatId: 'c9', status: 'working', where: 'terminal' },
  ];
  assert.equal(terminalWrites(sessions, { name: 'shop' }), false);
  assert.equal(terminalWrites(sessions, { name: 'cart' }), true);
  assert.equal(terminalWrites(sessions, { name: 'gone' }), true, 'not known: asked, as before');
  assert.equal(terminalWrites(sessions, { name: 'other', chatId: 'c9' }), true, 'one card per conversation: its state');
  assert.equal(terminalWrites(sessions, null), true, 'a terminal outside the dashboard');
});
