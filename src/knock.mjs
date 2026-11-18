// Whether something listens at an address, said three ways, so nobody reports "not running" for an answer that was
// only slow.
import net from 'node:net';

/**
 * Connect once to `target` (net.connect's options: { host, port } or { path }) and tell what came back: "open"
 * (something accepts), "closed" (refused, or no such socket: nothing listens) or "silent" (no answer within
 * `timeoutMs`: a busy computer or a stuck program; which of the two cannot be told from here).
 */
export function knock(target, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect(target);
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    // A computer under load may run this process late: then the time is over and the answer has come as well, and
    // the time is looked at first. An answer that came is taken before "silent" (setImmediate runs after it).
    s.setTimeout(timeoutMs, () => setImmediate(() => s.connecting && done('silent')));
    s.once('connect', () => done('open'));
    // A Unix socket whose queue is full refuses at once with EAGAIN: it is there and busy, not gone.
    s.once('error', (e) => done(e.code === 'EAGAIN' || e.code === 'ETIMEDOUT' ? 'silent' : 'closed'));
  });
}
