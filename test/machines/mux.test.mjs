// The direct link's stream multiplexer: the frame codec under random splits, many streams at once, frames that must
// be refused, a destination the other side cannot choose, and flow control under a slow reader.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import test from 'node:test';
import { Decoder, HEADER, MAX_PAYLOAD, Mux, ProtocolError, T, WINDOW, credit, encode } from '../../src/machines/mux.mjs';

const rand = (n) => Math.floor(Math.random() * n);

/** Two muxes joined by an in-memory wire that splits every frame at random points (like any byte stream may). */
function pair({ connectLocal, window } = {}) {
  const wire = { toMachine: 0, toHub: 0 };
  let hub;
  let machine;
  const splitInto = (target) => (buf) => {
    let i = 0;
    while (i < buf.length) {
      const n = 1 + rand(Math.max(1, buf.length - i));
      const part = buf.subarray(i, i + n);
      setImmediate(() => target().receive(part));
      i += n;
    }
  };
  const toMachine = splitInto(() => machine);
  const toHub = splitInto(() => hub);
  hub = new Mux({ role: 'hub', window, send: (b) => ((wire.toMachine += b.length), toMachine(b)) });
  machine = new Mux({ role: 'machine', window, connectLocal, send: (b) => ((wire.toHub += b.length), toHub(b)) });
  return { hub, machine, wire };
}

const listen = (handler) => new Promise((resolve) => {
  const s = net.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve(s));
});

test('codec: any frames, cut at random points, come out whole and in order', () => {
  for (let round = 0; round < 200; round++) {
    const frames = Array.from({ length: 1 + rand(20) }, () => ({ type: 1 + rand(5), id: rand(2 ** 32), payload: crypto.randomBytes(rand(3) === 0 ? rand(MAX_PAYLOAD + 1) : rand(64)) }));
    const bytes = Buffer.concat(frames.map((f) => encode(f.type, f.id, f.payload)));
    const d = new Decoder();
    const out = [];
    for (let i = 0; i < bytes.length;) {
      const n = 1 + rand(5000);
      out.push(...d.push(bytes.subarray(i, i + n)));
      i += n;
    }
    assert.equal(out.length, frames.length);
    out.forEach((f, i) => {
      assert.equal(f.type, frames[i].type);
      assert.equal(f.id, frames[i].id);
      assert.ok(f.payload.equals(frames[i].payload));
    });
  }
});

test('codec: an oversized frame or an unknown type is refused before its payload arrives', () => {
  const big = Buffer.alloc(HEADER);
  big.writeUInt8(T.DATA, 0);
  big.writeUInt32BE(1, 1);
  big.writeUInt32BE(MAX_PAYLOAD + 1, 5);
  assert.throws(() => new Decoder().push(big), ProtocolError);
  const odd = encode(T.DATA, 1, Buffer.from('x'));
  odd.writeUInt8(9, 0);
  assert.throws(() => new Decoder().push(odd), /unknown frame type/);
  // A mux that gets such a frame reports it and closes.
  let err = null;
  const m = new Mux({ role: 'machine', send: () => {}, onError: (e) => (err = e) });
  m.receive(big);
  assert.ok(err instanceof ProtocolError);
  assert.equal(m.closed, true);
});

test('many streams at once, interleaved over one wire, each gets exactly its own bytes back', async () => {
  const echo = await listen((s) => s.pipe(s));
  const { hub } = pair({ connectLocal: () => net.connect(echo.address().port, '127.0.0.1') });
  const front = await listen((s) => hub.accept(s));
  const runs = Array.from({ length: 20 }, async () => {
    const data = crypto.randomBytes(rand(400_000) + 1);
    const c = net.connect(front.address().port, '127.0.0.1');
    const got = [];
    c.on('data', (d) => got.push(d));
    for (let i = 0; i < data.length;) {
      const n = 1 + rand(70_000);
      c.write(data.subarray(i, i + n));
      i += n;
    }
    await new Promise((resolve) => {
      const check = () => (Buffer.concat(got).length >= data.length ? resolve() : setTimeout(check, 10));
      check();
    });
    c.destroy();
    return Buffer.concat(got).equals(data);
  });
  assert.deepEqual(await Promise.all(runs), Array(20).fill(true));
  front.close();
  echo.close();
});

test('the linked computer connects only to its own dashboard, whatever an OPEN frame carries', () => {
  const dials = [];
  const sent = [];
  const fakeSock = () => Object.assign(new EventEmitter(), { write: () => true, end() {}, destroy() {}, pause() {}, resume() {} });
  const m = new Mux({ role: 'machine', send: (b) => sent.push(b), connectLocal: () => (dials.push('dashboard'), fakeSock()) });
  m.receive(encode(T.OPEN, 7, Buffer.from('10.0.0.1:22')));
  assert.deepEqual(dials, ['dashboard'], 'the payload names no destination: it is ignored');
  // The hub never accepts an OPEN; a duplicate id is refused; unknown ids get a RESET.
  const hubSent = [];
  const h = new Mux({ role: 'hub', send: (b) => hubSent.push(b) });
  h.receive(encode(T.OPEN, 3));
  assert.equal(new Decoder().push(hubSent[0])[0].type, T.RESET);
  m.receive(encode(T.OPEN, 7));
  assert.equal(new Decoder().push(sent.at(-1))[0].type, T.RESET);
  m.receive(encode(T.DATA, 999, Buffer.from('x')));
  const last = new Decoder().push(sent.at(-1))[0];
  assert.deepEqual([last.type, last.id], [T.RESET, 999]);
});

test('too many streams: the rest are refused', () => {
  const sent = [];
  const fakeSock = () => Object.assign(new EventEmitter(), { write: () => true, end() {}, destroy() {}, pause() {}, resume() {} });
  const m = new Mux({ role: 'machine', maxStreams: 3, send: (b) => sent.push(b), connectLocal: fakeSock });
  for (let id = 1; id <= 4; id++) m.receive(encode(T.OPEN, id));
  assert.equal(m.streams.size, 3);
  const f = new Decoder().push(sent.at(-1))[0];
  assert.deepEqual([f.type, f.id], [T.RESET, 4]);
});

test('flow control: a slow reader stops the sender at the window; nothing piles up; then all of it arrives', async () => {
  // The linked computer's dashboard "reads" only when we say so: its socket never finishes a write until released.
  const held = [];
  let received = 0;
  const slow = Object.assign(new EventEmitter(), {
    write(buf, cb) {
      held.push(() => {
        received += buf.length;
        cb();
      });
      return false;
    },
    end() {},
    destroy() {},
    pause() {},
    resume() {},
  });
  const { hub, wire } = pair({ connectLocal: () => slow });
  const front = await listen((s) => hub.accept(s));
  const total = 8 * 1024 * 1024;
  const c = net.connect(front.address().port, '127.0.0.1');
  c.write(crypto.randomBytes(total));
  await new Promise((r) => setTimeout(r, 800));
  assert.ok(wire.toMachine <= WINDOW + 2 * (MAX_PAYLOAD + HEADER), `sent ${wire.toMachine} bytes while nothing was read`);
  // The reader catches up: credit flows back and everything arrives.
  const t = setInterval(() => held.splice(0).forEach((f) => f()), 5);
  await new Promise((resolve) => {
    const check = () => (received >= total ? resolve() : setTimeout(check, 20));
    check();
  });
  clearInterval(t);
  assert.equal(received, total);
  c.destroy();
  front.close();
});

test('a peer that ignores the window loses the stream instead of filling memory', () => {
  const sent = [];
  const sock = Object.assign(new EventEmitter(), { write: () => false, end() {}, destroy() {}, pause() {}, resume() {} });
  const m = new Mux({ role: 'machine', window: 1000, send: (b) => sent.push(b), connectLocal: () => sock });
  m.receive(encode(T.OPEN, 1));
  m.receive(encode(T.DATA, 1, Buffer.alloc(600)));
  assert.equal(m.streams.size, 1);
  m.receive(encode(T.DATA, 1, Buffer.alloc(600)));
  assert.equal(m.streams.size, 0);
  assert.equal(new Decoder().push(sent.at(-1))[0].type, T.RESET);
  assert.equal(new Decoder().push(credit(5, 77))[0].payload.readUInt32BE(0), 77);
});

/** A stand-in socket that writes at once (its callback a moment later) and records how it was ended. */
function fakeSocket() {
  const s = Object.assign(new EventEmitter(), { written: 0, ended: false, destroyed: false, soon: false });
  Object.assign(s, {
    write: (b, cb) => ((s.written += b.length), setImmediate(cb), true),
    end: () => (s.ended = true),
    destroy: () => (s.destroyed = true),
    destroySoon: () => (s.soon = true),
    pause() {},
    resume() {},
  });
  return s;
}

test('a credit for a stream this side has finished needs no answer; any other frame for it gets a reset', () => {
  const sent = [];
  const m = new Mux({ role: 'machine', send: (b) => sent.push(b), connectLocal: fakeSocket });
  m.receive(credit(9, 65536)); // the other side wrote our last bytes on after we ended and forgot the stream
  assert.deepEqual(sent, [], 'no reset for it');
  m.receive(encode(T.DATA, 9, Buffer.alloc(3)));
  assert.equal(new Decoder().push(sent.at(-1))[0].type, T.RESET);
});

test('a reset after the other side ended and every byte was written on lets the socket finish; before that it cuts', async () => {
  const sent = [];
  const hub = new Mux({ role: 'hub', send: (b) => sent.push(b) });
  const done = fakeSocket();
  const id = hub.accept(done);
  hub.receive(encode(T.DATA, id, Buffer.alloc(1000)));
  await new Promise((r) => setImmediate(r)); // the bytes are written on
  hub.receive(encode(T.END, id));
  assert.equal(done.ended, true);
  hub.receive(encode(T.RESET, id)); // the other side forgot the stream
  assert.deepEqual([done.destroyed, done.soon, hub.streams.size], [false, true, 0], 'not destroyed: it closes once what it holds is out');
  const cut = fakeSocket();
  const id2 = hub.accept(cut);
  hub.receive(encode(T.DATA, id2, Buffer.alloc(1000)));
  hub.receive(encode(T.RESET, id2)); // before its end: an abort
  assert.deepEqual([cut.destroyed, hub.streams.size], [true, 0]);
});

test('an answer that ends with the connection closing still arrives whole, even when it waits for credit', async () => {
  // The linked computer's "dashboard" sends 3 MB and closes at once (like HTTP with Connection: close).
  const data = crypto.randomBytes(3 * 1024 * 1024);
  const server = await listen((s) => s.end(data));
  const { hub } = pair({ connectLocal: () => net.connect(server.address().port, '127.0.0.1') });
  const front = await listen((s) => hub.accept(s));
  const got = await new Promise((resolve) => {
    const c = net.connect(front.address().port, '127.0.0.1');
    const parts = [];
    c.on('data', (d) => parts.push(d));
    c.on('end', () => resolve(Buffer.concat(parts)));
  });
  assert.ok(got.equals(data), `got ${got.length} of ${data.length} bytes`);
  front.close();
  server.close();
});

// The debug switch (HOPRIG_MUX_DEBUG, read once when mux.mjs is loaded): on, one line per flow event on stderr; off,
// not one. Run in a child of its own, since the switch is read when the file is loaded.
test('the debug switch writes the flow of a stream when on, and nothing when off', async () => {
  const { spawn } = await import('node:child_process');
  const mux = new URL('../../src/machines/mux.mjs', import.meta.url).href; // by its file URL, which Windows needs
  const script = `import net from 'node:net';
const { Mux } = await import(${JSON.stringify(mux)});
let got = 0;
const server = net.createServer((s) => s.on('data', (d) => { got += d.length; if (got >= 300000) { console.log('all ' + got); console.log(machine.describe().join('\\n')); process.exit(0); } }));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let hub, machine;
hub = new Mux({ role: 'hub', window: 65536, send: (b) => setImmediate(() => machine.receive(b)) });
machine = new Mux({ role: 'machine', window: 65536, connectLocal: () => net.connect(server.address().port, '127.0.0.1'), send: (b) => setImmediate(() => hub.receive(b)) });
const front = net.createServer((s) => hub.accept(s));
await new Promise((r) => front.listen(0, '127.0.0.1', r));
net.connect(front.address().port, '127.0.0.1').end(Buffer.alloc(300000, 1));
setTimeout(() => process.exit(3), 20000).unref();
`;
  const run = (env) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err }));
  });
  const env = { ...process.env };
  delete env.HOPRIG_MUX_DEBUG;
  const off = await run(env);
  assert.equal(off.code, 0, off.err);
  assert.match(off.out, /^all 300000/);
  assert.doesNotMatch(off.err, /^mux /m, 'off: not one line');
  const on = await run({ ...env, HOPRIG_MUX_DEBUG: '1' });
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /^machine 1: window \d+, unacked \d+, queued 0, .*; socket read 0, written 300000, /m, 'describe(): each open stream in one line');
  for (const re of [/^mux hub \d+ 1 first bytes are not HTTP \(\d+ bytes\)$/m, /^mux hub \d+ 1 socket ended \(its source finished\): read 300000$/m, /^mux hub \d+ 1 open$/m, /^mux machine \d+ 1 open$/m, /^mux hub \d+ 1 send 65536 \(total 65536\): window 65536 -> 0$/m, /^mux hub \d+ 1 waits for credit: window 0, queued \d+; socket paused$/m, /^mux machine \d+ 1 recv 65536 \(total \d+\), unacked \d+, socket /m, /^mux machine \d+ 1 written 65536, unacked \d+, credit sent$/m, /^mux hub \d+ 1 credit 65536: window 0 -> 65536, queued \d+$/m, /^mux hub \d+ 1 goes on: window \d+; socket resumed$/m]) {
    assert.match(on.err, re);
  }
});
