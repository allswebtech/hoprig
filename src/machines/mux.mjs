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
      if (type !== T.RESET) this.send(encode(T.RESET, id)); // unknown id: tell the other side, once
      return;
    }
    if (type === T.DATA) {
      st.unacked += payload.length;
      if (st.unacked > this.window) {
        // The other side ignored flow control: drop the stream rather than buffer without bound.
        this.#drop(id, true);
        return;
      }
      const n = payload.length;
      st.sock.write(Buffer.from(payload), () => {
        st.unacked -= n;
        if (!this.closed && this.streams.has(id)) this.send(credit(id, n));
      });
    } else if (type === T.CREDIT) {
      if (payload.length !== 4) return this.#drop(id, true);
      st.window += payload.readUInt32BE(0);
      st.pump();
    } else if (type === T.END) {
      st.remoteEnded = true;
      st.sock.end();
      this.#maybeDone(id);
    } else if (type === T.RESET) {
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
    // Never more than the window in flight: what the socket gave beyond it waits here (at most one read's worth,
    // because the socket is paused meanwhile) until credit comes back.
    st.pump = () => {
      while (st.queue.length && st.window > 0 && !this.closed) {
        const head = st.queue[0];
        const n = Math.min(head.length, st.window, MAX_PAYLOAD);
        this.send(encode(T.DATA, id, head.subarray(0, n)));
        st.window -= n;
        if (n === head.length) st.queue.shift();
        else st.queue[0] = head.subarray(n);
      }
      if (st.queue.length) {
        if (!st.paused) {
          st.paused = true;
          sock.pause();
        }
        return;
      }
      if (st.endPending) {
        st.endPending = false;
        st.localEnded = true;
        if (!this.closed) this.send(encode(T.END, id));
        if (st.sockClosed) this.streams.delete(id);
        else this.#maybeDone(id);
        return;
      }
      if (st.paused && st.window > 0) {
        st.paused = false;
        sock.resume();
      }
    };
    sock.on('data', (chunk) => {
      st.queue.push(chunk);
      st.pump();
    });
    sock.on('end', () => {
      st.endPending = true;
      st.pump();
    });
    sock.on('error', () => this.#drop(id, true));
    sock.on('close', () => {
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
    this.streams.delete(id);
    st.sock.destroy();
    if (tell && !this.closed) this.send(encode(T.RESET, id));
  }

  close() {
    this.closed = true;
    for (const st of this.streams.values()) st.sock.destroy();
    this.streams.clear();
  }
}

/** The machine side's only destination: its own dashboard on loopback. */
export const dashboardConnector = (addr) => () => net.connect({ host: addr().host, port: addr().port });
