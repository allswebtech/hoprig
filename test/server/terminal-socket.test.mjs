// The browser terminal's socket (src/server/terminal.mjs): what a browser may send reaches the session as it should.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachTerminal } from '../../src/server/terminal.mjs';

function rig() {
  const written = [];
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {}, close: () => {} });
  const stream = { onData: () => {}, onExit: () => {}, write: (d) => written.push(d), resize: () => {}, pause: () => {}, resume: () => {}, close: () => {} };
  attachTerminal(ws, { backend: { attach: () => stream }, name: 's', cols: 80, rows: 24 });
  const send = (m) => ws.emit('message', Buffer.from(JSON.stringify(m)), false);
  return { written, send, ws };
}

test('keys go as text; mouse reports in the oldest encoding go as the bytes they are', () => {
  const { written, send, ws } = rig();
  send({ t: 'in', d: 'é\r' });
  assert.deepEqual(written, ['é\r']);
  send({ t: 'bin', d: '\x1b[M`\xa0\x21' }); // a wheel turn at column 128: a byte above 127, not "\xa0" as UTF-8
  assert.ok(Buffer.isBuffer(written[1]));
  assert.deepEqual([...written[1]], [0x1b, 0x5b, 0x4d, 0x60, 0xa0, 0x21]);
  send({ t: 'bin', d: 'not ✓ bytes' });
  send({ t: 'bin', d: 42 });
  assert.equal(written.length, 2, 'only characters 0 to 255 are bytes');
  ws.emit('message', Buffer.from('x'), true);
  assert.equal(written.length, 2, 'a binary frame is ignored');
  ws.emit('close');
});
