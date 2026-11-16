// A small WebSocket client (RFC 6455) for the one server Hoprig talks to this way: Codex's app server on the
// computer's loopback address. Node 20 has no WebSocket client without a flag, and Hoprig adds no dependency for
// this, so it is here: text frames only, masked as a client must, ping answered, fragments joined.
//
//   const ws = await wsConnect({ host: '127.0.0.1', port, path: '/', headers: { Authorization: 'Bearer …' } });
//   ws.on('message', (text) => …); ws.on('close', () => …); ws.send(text); ws.close();
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import net from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 32 * 1024 * 1024; // Codex says 16 MB per message; a bigger one is a broken peer

/** Connect; resolves once the server accepted the upgrade. `timeoutMs` covers the connect and the handshake. */
export function wsConnect({ host = '127.0.0.1', port, path = '/', headers = {}, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect({ host, port });
    const fail = (e) => {
      sock.destroy();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error('the server did not answer in time')), timeoutMs);
    sock.once('error', (e) => { clearTimeout(timer); fail(e); });
    sock.once('connect', () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13'];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      sock.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let head = Buffer.alloc(0);
    const onHead = (d) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 16384) { clearTimeout(timer); fail(new Error('bad answer from the server')); }
        return;
      }
      sock.off('data', onHead);
      clearTimeout(timer);
      const text = head.subarray(0, end).toString('latin1');
      const status = Number((/^HTTP\/1\.1 (\d{3})/.exec(text) || [])[1]);
      const accept = (/^sec-websocket-accept:\s*(\S+)/im.exec(text) || [])[1];
      const want = crypto.createHash('sha1').update(key + GUID).digest('base64');
      if (status !== 101 || accept !== want) return fail(Object.assign(new Error(status === 401 || status === 403 ? 'the server refused the token' : `the server refused the connection (${status || 'no status'})`), { status }));
      sock.removeAllListeners('error');
      resolve(new WsClient(sock, head.subarray(end + 4)));
    };
    sock.on('data', onHead);
  });
}

class WsClient extends EventEmitter {
  constructor(sock, rest) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.parts = [];
    this.closed = false;
    sock.setNoDelay(true);
    sock.on('data', (d) => this.#feed(d));
    sock.on('error', () => this.#end());
    sock.on('close', () => this.#end());
    if (rest.length) queueMicrotask(() => this.#feed(rest));
  }

  #end() {
    if (this.closed) return;
    this.closed = true;
    this.sock.destroy();
    this.emit('close');
  }

  #feed(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0; // a server never masks; tolerate it anyway
      if (masked) off += 4;
      if (len > MAX_MESSAGE) return this.#end();
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const mask = this.buf.subarray(off - 4, off);
        payload = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]));
      }
      this.buf = this.buf.subarray(off + len);
      const fin = (b0 & 0x80) !== 0;
      const op = b0 & 0x0f;
      if (op === 0x8) return this.#end();
      if (op === 0x9) { this.#frame(0xa, payload); continue; }
      if (op === 0xa) continue;
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        this.parts.push(payload);
        if (this.parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return this.#end();
        if (fin) {
          const text = Buffer.concat(this.parts).toString('utf8');
          this.parts = [];
          this.emit('message', text);
        }
      }
    }
  }

  #frame(op, payload) {
    if (this.closed) return;
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (len >= 126 && len < 65536) {
      head[0] = 0x80 | op;
      head[1] = 0x80 | 126;
      head.writeUInt16BE(len, 2);
    } else if (len >= 65536) {
      head[0] = 0x80 | op;
      head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const body = Buffer.from(payload.map((x, i) => x ^ mask[i % 4]));
    this.sock.write(Buffer.concat([head, mask, body]));
  }

  send(text) {
    this.#frame(0x1, Buffer.from(String(text), 'utf8'));
  }

  close() {
    if (this.closed) return;
    try {
      this.#frame(0x8, Buffer.alloc(0));
    } finally {
      this.sock.end();
      setTimeout(() => this.#end(), 200).unref();
    }
  }
}
