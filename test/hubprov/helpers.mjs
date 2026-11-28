// Made-up pieces for the hub-provider tests: a stand-in upstream that answers like a model address, a made-up computer
// of one made-up person, and small readers. Every key here is made at run time from two parts.
import http from 'node:http';
import crypto from 'node:crypto';

export const SECRET_PART = 'zq9';
/** A made-up key that looks like no real one: built from two parts at run time. */
export const madeUpKey = (tag) => `${tag}-${SECRET_PART}-${crypto.randomBytes(12).toString('hex')}`;

/** A stand-in upstream. `seen` holds each request's method, path, headers and body. */
export async function upstream({ status = 200, reply = '{"type":"message","content":[{"type":"text","text":"hi"}]}', headers = {} } = {}) {
  const seen = [];
  const open = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const entry = { method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8'), closed: false, closedAt: 0 };
      seen.push(entry);
      res.on('close', () => {
        entry.closed = true;
        entry.closedAt = Date.now();
      });
      if (req.url.startsWith('/v1/stream')) {
        // A long answer that never ends by itself: a chunk every 50 ms.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const t = setInterval(() => res.write('data: tick\n\n'), 50);
        res.on('close', () => clearInterval(t));
        return;
      }
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(reply);
    });
  });
  server.on('connection', (s) => {
    open.add(s);
    s.on('close', () => open.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => { for (const s of open) s.destroy(); return new Promise((r) => server.close(r)); } };
}

export const machineEntry = (name, extra = {}) => ({
  name, label: name.toUpperCase(), via: 'link', port: 20000 + Math.floor(Math.random() * 1000), linkId: crypto.randomBytes(6).toString('hex'),
  linkHash: crypto.randomBytes(32).toString('hex'), token: 'hop_' + crypto.randomBytes(32).toString('base64url'), tokenId: crypto.randomBytes(6).toString('hex'), added: Date.now(), ...extra,
});

/** A request to `base` + `path`: { status, headers, body } (the whole answer). */
export function call(base, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const req = http.request(u, { method, headers: { ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

export const until = async (what, fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await Promise.resolve(fn()).catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
};
