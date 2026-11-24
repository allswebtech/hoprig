// The browser terminal's socket (src/server/terminal.mjs): what a browser may send reaches the session as it should.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachTerminal } from '../../src/server/terminal.mjs';

function rig({ sessions = [] } = {}) {
  const written = [];
  const closed = [];
  let exit = null;
  const ws = Object.assign(new EventEmitter(), { OPEN: 1, readyState: 1, bufferedAmount: 0, send: () => {}, close: (code, why) => closed.push([code, why]) });
  const stream = { onData: () => {}, onExit: (fn) => (exit = fn), write: (d) => written.push(d), resize: () => {}, pause: () => {}, resume: () => {}, close: () => {} };
  const backend = { attach: () => stream, list: async () => sessions.map((session) => ({ session })) };
  attachTerminal(ws, { backend, name: 's', cols: 80, rows: 24 });
  const send = (m) => ws.emit('message', Buffer.from(JSON.stringify(m)), false);
  return { written, send, ws, closed, exit: () => exit() };
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

test('a frame the socket refuses (a paste over its size limit) closes that terminal only, never the dashboard', () => {
  const { ws } = rig();
  const tooBig = Object.assign(new RangeError('Max payload size exceeded'), { code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' });
  assert.doesNotThrow(() => ws.emit('error', tooBig), 'an error with no listener is thrown and ends the process');
  ws.emit('close');
});

test('a bracketed paste reaches the session whole, in one write, also when its end mark spans two frames', async () => {
  const { inputFrames, inputMessages } = await import('../../web/termkeys.js');
  const { written, send, ws } = rig();
  const paste = `\x1b[200~${'A'.repeat(100_000)}\x1b[201~`;
  assert.ok(inputMessages(paste).every((m) => m.paste === true), 'the page flags every frame of a bracketed paste');
  const frames = [...inputFrames(paste.slice(0, -3)), paste.slice(-3)]; // the last frame starts inside the end mark
  assert.ok(frames.length > 10 && frames.at(-1) === '01~');
  send({ t: 'in', d: 'k' });
  for (const f of frames) send({ t: 'in', d: f, paste: true });
  send({ t: 'in', d: 'x\r' });
  assert.deepEqual(written, ['k', paste, 'x\r']);
  send({ t: 'in', d: 'a\x1b[200~p\x1b[201~b', paste: true });
  assert.deepEqual(written.slice(3), ['a', '\x1b[200~p\x1b[201~', 'b'], 'keys around a paste in one frame keep their places');
  ws.emit('close');
});

test('a paste cut off by a dropped link reaches nothing: the keys typed after the reconnect are keys, not paste text', () => {
  const first = rig();
  first.send({ t: 'in', d: `\x1b[200~${'A'.repeat(8186)}`, paste: true });
  first.send({ t: 'in', d: 'A'.repeat(8192), paste: true });
  first.ws.emit('close'); // the end mark never came
  assert.deepEqual(first.written, [], 'a part of a paste would leave the program inside it');
  const next = rig(); // the reconnect
  next.send({ t: 'in', d: 'x\r' });
  assert.deepEqual(next.written, ['x\r']);
});

test('a start mark inside text that is no bracketed paste (the clipboard of a program that did not ask) is passed on as keys', async () => {
  const { inputMessages } = await import('../../web/termkeys.js');
  // xterm.js sends the clipboard as it is to a program that did not turn bracketed paste on, an Escape in it too.
  const typed = inputMessages('echo a\x1b[200~b');
  assert.deepEqual(typed, [{ t: 'in', d: 'echo a\x1b[200~b' }], 'not flagged: the page made no paste of it');
  const { written, send, ws } = rig();
  for (const m of typed) send(m);
  for (const k of ['x', '\r', '\x03']) send({ t: 'in', d: k });
  assert.deepEqual(written, ['echo a\x1b[200~b', 'x', '\r', '\x03'], 'held, it waited for an end mark that never came, and took every key after it');
  ws.emit('close');
});

test('a paste over the cap goes on as it comes, and a close inside it ends the paste for the program', async () => {
  const { wholePaste } = await import('../../src/server/terminal.mjs');
  const written = [];
  const p = wholePaste((d) => written.push(d), { cap: 10 });
  p.write('\x1b[200~12345');
  p.write('67890abc');
  p.write('def\x1b[2');
  p.write('01~z');
  assert.equal(written.join(''), '\x1b[200~1234567890abcdef\x1b[201~z');
  assert.equal(written.at(-1), 'z', 'after the end mark keys go on as keys');
  written.length = 0;
  p.write('\x1b[200~0123456789xyz');
  p.close();
  assert.deepEqual(written, ['\x1b[200~0123456789xyz', '\x1b[201~']);
});

test('a held paste of megabytes is joined once, not searched again on every frame: the dashboard is not held up', async () => {
  // Every other terminal and page of the dashboard waits while a frame is taken. Searching and joining all that was
  // held on every frame grew with the square of the paste: 0.65 s for the 4 Mi cap.
  const { wholePaste } = await import('../../src/server/terminal.mjs');
  const { inputFrames } = await import('../../web/termkeys.js');
  const paste = `\x1b[200~${'A'.repeat((4 << 20) - 100)}\x1b[201~`;
  const frames = inputFrames(paste);
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const written = [];
    const p = wholePaste((d) => written.push(d));
    const t = performance.now();
    for (const f of frames) p.write(f);
    best = Math.min(best, performance.now() - t);
    assert.equal(written.length, 1, 'in one write');
    assert.ok(written[0] === paste, 'whole');
  }
  assert.ok(best < 150, `a 4 Mi paste took ${best.toFixed(0)} ms`);
  // The end mark split at every place, in frames of one character too: found across the seam, keys after it go on.
  for (let cut = 1; cut < 6; cut++) {
    const written = [];
    const p = wholePaste((d) => written.push(d));
    const text = '\x1b[200~ab\x1b[201~';
    p.write(text.slice(0, text.length - cut));
    for (const c of text.slice(text.length - cut)) p.write(c);
    p.write('k');
    assert.deepEqual(written, [text, 'k'], `end mark cut ${cut} from its end`);
  }
});

test('the attach ends: "session ended" only when the session is gone; a detach key of the user\'s tmux lets the page connect again', async () => {
  const gone = rig({ sessions: ['other'] });
  await gone.exit();
  assert.deepEqual(gone.closed, [[4000, 'session ended']]);
  const detached = rig({ sessions: ['s'] }); // bind -n C-q detach-client: the client went, the session runs on
  await detached.exit();
  assert.deepEqual(detached.closed, [[4001, 'detached']], 'not 4000: the page shows "This session has ended" for that');
});
