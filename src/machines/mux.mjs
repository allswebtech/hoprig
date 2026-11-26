// Many TCP streams over one connection: hoprig's own `ssh -R`, carried by the direct link's WebSocket (link.mjs).
//
// A frame is   type (1 byte) · stream id (4 bytes) · length (4 bytes) · payload (length bytes), integers big-endian.
//   OPEN   1   the hub has a new TCP connection for the linked computer (only the hub sends it; no payload: the linked
//              computer always connects to its OWN dashboard, never to a host or port named by the other side)
//   DATA   2   bytes of that stream (at most MAX_PAYLOAD per frame)
//   END    3   that side finished sending (TCP half-close)
//   RESET  4   the stream is gone (error, refused, unknown id)
//   CREDIT 5   payload = 4 bytes: the receiver has passed that many bytes on; the sender may send that much more
// Flow control: each side may have at most WINDOW bytes of a stream in flight. The receiver gives credit only once its
// TCP socket has taken the bytes, so a slow reader stops the sender and nothing piles up in memory.
// The decoder takes bytes in any split (a WebSocket message usually holds one whole frame, but nothing relies on it)
// and refuses a frame that claims more than MAX_PAYLOAD: the connection is then closed.
import net from 'node:net';
import { performance } from 'node:perf_hooks';

// HOPRIG_MUX_DEBUG=1 (read once, when this file is loaded): one line per flow event on stderr, "mux <role> <ms> <stream>
// <event> ...": a stream opened, bytes sent and taken, credit sent and received with the window before and after, a send
// that waits for credit and when it goes on, a write the socket held back (write returned false) and its drain, the
// socket paused and resumed, the stream's end with its counts. Off, every call site is one test of a constant false:
// no line is made, no counter kept.
const DEBUG = /^(1|true|yes|on)$/i.test(process.env.HOPRIG_MUX_DEBUG || '');
const trace = (role, id, words) => process.stderr.write(`mux ${role} ${Math.round(performance.now())} ${id} ${words}\n`);
// What a stream carries, from the first line of its first bytes: a request's method and path (no query, at most 60
// characters) or an answer's status. No header and no value is read.
function firstLine(chunk) {
  const line = chunk.subarray(0, 200).toString('latin1').split('\r\n')[0];
  const req = /^([A-Z]{3,7}) (\/[^\s?#]*)\S* HTTP\/1\.[01]$/.exec(line);
  if (req) return `for ${req[1]} ${req[2].slice(0, 60)}`;
  const ans = /^HTTP\/1\.[01] (\d{3})\b/.exec(line);
  return ans ? `answer ${ans[1]}` : `first bytes are not HTTP (${chunk.length} bytes)`;
}

export const T = { OPEN: 1, DATA: 2, END: 3, RESET: 4, CREDIT: 5 };
export const HEADER = 9;
export const MAX_PAYLOAD = 64 * 1024;
export const WINDOW = 256 * 1024;
export const MAX_STREAMS = 64;

export function encode(type, id, payload = Buffer.alloc(0)) {
  const b = Buffer.allocUnsafe(HEADER + payload.length);
  b.writeUInt8(type, 0);
  b.writeUInt32BE(id >>> 0, 1);
  b.writeUInt32BE(payload.length, 5);
  payload.copy(b, HEADER);
  return b;
}

export const credit = (id, n) => {
  const p = Buffer.allocUnsafe(4);
  p.writeUInt32BE(n >>> 0, 0);
  return encode(T.CREDIT, id, p);
};

export class ProtocolError extends Error {}

/** Splits bytes into frames, whatever the chunk boundaries. push(chunk) returns the complete frames. */
export class Decoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    const out = [];
    while (this.buf.length >= HEADER) {
      const type = this.buf.readUInt8(0);
      const id = this.buf.readUInt32BE(1);
      const len = this.buf.readUInt32BE(5);
      if (!Object.values(T).includes(type)) throw new ProtocolError(`unknown frame type ${type}`);
      if (len > MAX_PAYLOAD) throw new ProtocolError(`frame of ${len} bytes is larger than ${MAX_PAYLOAD}`);
      if (this.buf.length < HEADER + len) break;
      out.push({ type, id, payload: this.buf.subarray(HEADER, HEADER + len) });
      this.buf = this.buf.subarray(HEADER + len);
    }
    if (this.buf.length > HEADER + MAX_PAYLOAD) throw new ProtocolError('too much unframed data');
    return out;
  }
}

/**
 * One end of the multiplexed connection.
 *   role 'hub':     accept(socket) turns a local TCP connection into a stream (sends OPEN)
 *   role 'machine': each OPEN connects to connectLocal() (its own dashboard) and only there
 * `send(buf)` puts a frame on the connection; `close()` ends every stream. `onError(e)` hears protocol errors (the
 * owner then closes the connection).
 */
export class Mux {
  constructor({ role, send, connectLocal = null, onError = () => {}, window = WINDOW, maxStreams = MAX_STREAMS }) {
    Object.assign(this, { role, send, connectLocal, onError, window, maxStreams });
    this.decoder = new Decoder();
    this.streams = new Map();
    this.nextId = 1;
    this.closed = false;
  }

  /** Bytes from the connection. */
  receive(chunk) {
    let frames;
    try {
      frames = this.decoder.push(chunk);
    } catch (e) {
      this.onError(e);
      this.close();
      return;
    }
    for (const f of frames) this.#frame(f);
  }

  #frame({ type, id, payload }) {
    if (type === T.OPEN) {
      // Only the hub opens streams, and only to the linked computer's own dashboard.
      if (this.role !== 'machine' || this.streams.has(id) || this.streams.size >= this.maxStreams || !this.connectLocal) return this.send(encode(T.RESET, id));
      let sock;
      try {
        sock = this.connectLocal();
      } catch {
        return this.send(encode(T.RESET, id));
      }
      this.#attach(id, sock);
      return;
    }
    const st = this.streams.get(id);
    if (!st) {
      // Unknown id: tell the other side, once. Not for a credit: one for a stream this side has finished and forgotten
      // comes after its END as a matter of course (the other side wrote our last bytes on), and needs no answer.
      if (type !== T.RESET && type !== T.CREDIT) this.send(encode(T.RESET, id));
      return;
    }
    if (type === T.DATA) {
      st.unacked += payload.length;
      if (st.unacked > this.window) {
        // The other side ignored flow control: drop the stream rather than buffer without bound.
        DEBUG && trace(this.role, id, `drop: ${st.unacked} unacked bytes, past the window`);
        this.#drop(id, true);
        return;
      }
      const n = payload.length;
      const took = st.sock.write(Buffer.from(payload), () => {
        st.unacked -= n;
        const sent = !this.closed && this.streams.has(id);
        if (sent) this.send(credit(id, n));
        DEBUG && trace(this.role, id, `written ${n}, unacked ${st.unacked}, credit ${sent ? 'sent' : 'not sent (closed)'}`);
      });
      if (DEBUG) {
        st.got += n;
        trace(this.role, id, `recv ${n} (total ${st.got}), unacked ${st.unacked}, socket ${took ? 'took it' : `held back (buffered ${st.sock.writableLength})`}`);
        if (!took) st.sock.once('drain', () => trace(this.role, id, 'socket drained'));
      }
    } else if (type === T.CREDIT) {
      if (payload.length !== 4) return this.#drop(id, true);
      DEBUG && trace(this.role, id, `credit ${payload.readUInt32BE(0)}: window ${st.window} -> ${st.window + payload.readUInt32BE(0)}, queued ${st.queue.reduce((a, b) => a + b.length, 0)}`);
      st.window += payload.readUInt32BE(0);
      st.pump();
    } else if (type === T.END) {
      DEBUG && trace(this.role, id, 'end from the other side');
      st.remoteEnded = true;
      st.sock.end();
      this.#maybeDone(id);
    } else if (type === T.RESET) {
      DEBUG && trace(this.role, id, 'reset from the other side');
      // After the other side's END, with every byte of it written on: the other side only forgot the stream. Its
      // socket keeps what it holds and closes once that is out; a destroy now may lose the tail of the answer (on
      // Windows it did: the client never saw the answer end).
      if (st.remoteEnded && st.unacked === 0) {
        this.streams.delete(id);
        st.queue.length = 0;
        st.sock.pause();
        st.sock.destroySoon();
        return;
      }
      this.#drop(id, false);
    }
  }

  /** Hub side: a TCP connection to the link's local port becomes a stream. */
  accept(sock) {
    if (this.role !== 'hub' || this.closed || this.streams.size >= this.maxStreams) {
      sock.destroy();
      return null;
    }
    const id = this.nextId;
    this.nextId = (this.nextId % 0x7fffffff) + 1;
    this.send(encode(T.OPEN, id));
    this.#attach(id, sock);
    return id;
  }

  #attach(id, sock) {
    const st = { sock, window: this.window, unacked: 0, paused: false, localEnded: false, remoteEnded: false, queue: [], endPending: false };
    this.streams.set(id, st);
    if (DEBUG) {
      Object.assign(st, { sent: 0, got: 0, waits: 0, read: 0 });
      trace(this.role, id, 'open');
    }
    // Never more than the window in flight: what the socket gave beyond it waits here (at most one read's worth,
    // because the socket is paused meanwhile) until credit comes back.
    st.pump = () => {
      while (st.queue.length && st.window > 0 && !this.closed) {
        const head = st.queue[0];
        const n = Math.min(head.length, st.window, MAX_PAYLOAD);
        this.send(encode(T.DATA, id, head.subarray(0, n)));
        if (DEBUG) {
          st.sent += n;
          trace(this.role, id, `send ${n} (total ${st.sent}): window ${st.window} -> ${st.window - n}`);
        }
        st.window -= n;
        if (n === head.length) st.queue.shift();
        else st.queue[0] = head.subarray(n);
      }
      if (st.queue.length) {
        if (!st.paused) {
          st.paused = true;
          sock.pause();
          if (DEBUG) {
            st.waits += 1;
            trace(this.role, id, `waits for credit: window ${st.window}, queued ${st.queue.reduce((a, b) => a + b.length, 0)}; socket paused`);
          }
        }
        return;
      }
      if (st.endPending) {
        st.endPending = false;
        st.localEnded = true;
        DEBUG && trace(this.role, id, `end sent: sent ${st.sent}, got ${st.got}, waited ${st.waits} times`);
        if (!this.closed) this.send(encode(T.END, id));
        if (st.sockClosed) this.streams.delete(id);
        else this.#maybeDone(id);
        return;
      }
      if (st.paused && st.window > 0) {
        st.paused = false;
        sock.resume();
        DEBUG && trace(this.role, id, `goes on: window ${st.window}; socket resumed`);
      }
    };
    sock.on('data', (chunk) => {
      if (this.streams.get(id) !== st) return; // let go after a reset (it finishes what it holds and closes)
      if (DEBUG && !st.read) trace(this.role, id, firstLine(chunk));
      if (DEBUG) st.read += chunk.length;
      st.queue.push(chunk);
      st.pump();
    });
    sock.on('end', () => {
      DEBUG && trace(this.role, id, `socket ended (its source finished): read ${st.read}`);
      st.endPending = true;
      st.pump();
    });
    sock.on('error', (e) => {
      DEBUG && trace(this.role, id, `socket error ${e && e.code}`);
      this.#drop(id, true);
    });
    sock.on('close', () => {
      DEBUG && trace(this.role, id, `socket closed: sent ${st.sent}, got ${st.got}, waited ${st.waits} times, queued ${st.queue.reduce((a, b) => a + b.length, 0)}, window ${st.window}, unacked ${st.unacked}`);
      if (this.streams.get(id) !== st) return;
      // Closed after a clean end with bytes still waiting for credit (an HTTP answer with "Connection: close"):
      // finish sending them, then END. Anything else is an abort.
      if (st.endPending || st.queue.length) {
        st.sockClosed = true;
        return;
      }
      if (st.localEnded) {
        this.streams.delete(id); // our side is done; the other side's END has nowhere to go
        return;
      }
      this.#drop(id, true);
    });
  }

  #maybeDone(id) {
    const st = this.streams.get(id);
    if (st && st.localEnded && st.remoteEnded) this.streams.delete(id);
  }

  #drop(id, tell) {
    const st = this.streams.get(id);
    if (!st) return;
    DEBUG && trace(this.role, id, `dropped (${tell ? 'reset sent' : 'by the other side'}): sent ${st.sent}, got ${st.got}`);
    this.streams.delete(id);
    st.sock.destroy();
    if (tell && !this.closed) this.send(encode(T.RESET, id));
  }

  /** Each stream's state now, one line each (for a debug message: called on demand, never on the way of the bytes). */
  describe() {
    return [...this.streams].map(([id, st]) => {
      const k = st.sock;
      const queued = st.queue.reduce((a, b) => a + b.length, 0);
      return `${this.role} ${id}: window ${st.window}, unacked ${st.unacked}, queued ${queued}, paused ${st.paused}, ended here ${st.localEnded}, there ${st.remoteEnded}, end pending ${st.endPending}; socket read ${k.bytesRead}, written ${k.bytesWritten}, readable ${k.readableLength}, flowing ${k.readableFlowing}, isPaused ${k.isPaused()}, writable ${k.writableLength}, ${k.destroyed ? 'destroyed' : k.readyState}`;
    });
  }

  close() {
    this.closed = true;
    for (const st of this.streams.values()) st.sock.destroy();
    this.streams.clear();
  }
}

/** The machine side's only destination: its own dashboard on loopback. */
export const dashboardConnector = (addr) => () => net.connect({ host: addr().host, port: addr().port });
