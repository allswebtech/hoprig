// Two connected in-process sockets, for a stream of the direct link that must never touch a network port: whatever is
// written to one end is read on the other. Each end looks enough like a net.Socket for the mux (src/machines/mux.mjs)
// and for node:http (a server may take one as a connection, a request may use one as its socket).
import { Duplex } from 'node:stream';

function end(other) {
  const d = new Duplex({
    allowHalfOpen: true,
    read() {},
    write(chunk, _enc, cb) {
      // Taken at once: the mux's window (and the HTTP peers) already bound what is in flight.
      other().push(chunk);
      cb();
    },
    final(cb) {
      other().push(null);
      cb();
    },
    destroy(err, cb) {
      const o = other();
      if (o && !o.destroyed) setImmediate(() => o.destroy(err || undefined));
      cb(err);
    },
  });
  // The parts of net.Socket that http and the mux call.
  d.setNoDelay = () => d;
  d.setKeepAlive = () => d;
  d.setTimeout = () => d;
  d.ref = () => d;
  d.unref = () => d;
  d.destroySoon = () => d.end();
  d.remoteAddress = '127.0.0.1';
  d.remotePort = 0;
  d.localAddress = '127.0.0.1';
  d.encrypted = false;
  return d;
}

/** [a, b]: write to a, read on b, and the other way. Destroying one destroys the other. */
export function duplexPair() {
  let a;
  let b;
  a = end(() => b);
  b = end(() => a);
  return [a, b];
}
