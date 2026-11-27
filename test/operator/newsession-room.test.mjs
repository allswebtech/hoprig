// Where he picks the computer of a new session or chat (web/newsession-room.js): one line
// offers another computer only when the chosen one is busy or full AND the other has room AND can run this start.
// Nothing is picked for him: the line only offers a button.
import assert from 'node:assert/strict';
import test from 'node:test';
import { roomHint, roomsById } from '../../web/newsession-room.js';

const view = { computers: [
  { name: 'this', here: true, room: 'full', why: 'It is full: its load is 2.1 per CPU.' },
  { name: 'box2', room: 'free', why: 'it has room for new work' },
  { name: 'box3', room: 'busy', why: 'It is busy: only 20 % of its memory is free.' },
] };
const rooms = roomsById(view);
const computers = [{ id: '~', name: 'This computer', ok: true }, { id: 'box2', name: 'Box 2', ok: true }, { id: 'box3', name: 'Box 3', ok: true }];

test('the rooms are keyed as the sheet keys computers', () => {
  assert.deepEqual([...rooms.keys()], ['~', 'box2', 'box3']);
  assert.equal(rooms.get('box2').room, 'free');
});

test('the chosen computer is full and another has room: one line with a button that picks it', () => {
  assert.deepEqual(roomHint({ computers, rooms, chosen: '~' }), { text: 'This computer is full (its load is 2.1 per CPU): Box 2 has room.', to: 'box2', label: 'Use Box 2' });
  assert.deepEqual(roomHint({ computers, rooms, chosen: 'box3' }).to, 'box2');
});

test('no line when the chosen one has room, or when no other can take this start', () => {
  assert.equal(roomHint({ computers, rooms, chosen: 'box2' }), null);
  const cannot = computers.map((c) => (c.id === 'box2' ? { ...c, ok: false } : c));
  assert.equal(roomHint({ computers: cannot, rooms, chosen: '~' }), null, 'box2 cannot run it (no provider, no Claude Code, not online)');
  assert.equal(roomHint({ computers, rooms: roomsById({ computers: [{ here: true, name: 'this', room: 'full' }, { name: 'box2', room: 'unknown' }] }), chosen: '~' }), null, 'a computer not known never has room');
  assert.equal(roomHint({ computers, rooms: new Map(), chosen: '~' }), null);
});

test('this computer is offered first when it has room', () => {
  const r = roomsById({ computers: [{ here: true, name: 'this', room: 'free' }, { name: 'box2', room: 'free' }, { name: 'box3', room: 'full' }] });
  assert.equal(roomHint({ computers, rooms: r, chosen: 'box3' }).to, '~');
});

test('"Use Box 2" by keyboard: the focus lands on the Box 2 chip it picked, never on the computer it left', async () => {
  const mod = await import('../../web/newsession-room.js');
  assert.equal(typeof mod.useHint, 'function', 'the hint\'s button goes through useHint');
  let focused = null;
  const chip = (id) => ({ id, focus() { focused = id; } });
  const tiles = { '~': chip('~'), box2: chip('box2') };
  let chosen = '~';
  const slot = { querySelector: (sel) => tiles[/data-choice="([^"]+)"/.exec(sel)?.[1]] || null };
  // the sheet's own repaint puts the focus on the first chip when the focused button went away
  mod.useHint(slot, 'box2', (id) => { chosen = id; tiles['~'].focus(); });
  assert.equal(chosen, 'box2');
  assert.equal(focused, 'box2');
  const src = (await import('node:fs')).readFileSync(new URL('../../web/newsession-popup.js', import.meta.url), 'utf8');
  assert.match(src, /onclick: \(\) => useHint\(pcSlot, hint\.to, choose\)/);
});
