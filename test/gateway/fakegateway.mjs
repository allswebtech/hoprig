// A stand-in for an AI gateway with Claude's API (what TRouteAI offers on its port): it wants its own key as a
// bearer token, lists two models, answers /v1/messages as server-sent events with a pause in the middle (so a test
// can see that the answer streams), and serves a "dashboard" page on every other path (which must stay private).
import http from 'node:http';

export const GW_KEY = 'gateway-own-key-0123456789abcdef';

// `hold(body)`: for a request it says yes to, the rest of the streamed answer waits until the reader says it has the
// first part (`release()`), or 5 s: then that it came is certain, however slow the computer is. `writes` records each
// event of such an answer as it was written: { at (epoch ms), what }.
export async function fakeGateway({ pauseMs = 300, hold = () => false } = {}) {
  const seen = [];
  const writes = [];
  const held = new Set();
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const json = (s, b) => {
        res.writeHead(s, { 'content-type': 'application/json', 'set-cookie': 'gw=1', 'x-internal': 'no' });
        res.end(JSON.stringify(b));
      };
      if (!req.url.startsWith('/v1/')) {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<h1>gateway dashboard: settings and keys</h1>');
      }
      if (req.headers.authorization !== `Bearer ${GW_KEY}`) return json(401, { error: { message: 'unauthorized' } });
      if (req.url.startsWith('/v1/models')) return json(200, { data: [{ id: 'combo-best' }, { id: 'haiku-like' }] });
      if (req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed', 'set-cookie': 'gw=1' });
        const holding = hold(body);
        const note = (what) => holding && writes.push({ at: Date.now(), what });
        res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
        note('message_start');
        const rest = () => {
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n');
          note('content_block_delta');
          res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          note('message_stop');
        };
        if (!holding) setTimeout(rest, pauseMs);
        else {
          const go = (why) => {
            if (!held.delete(go)) return;
            clearTimeout(timer);
            note(why);
            rest();
          };
          const timer = setTimeout(() => go('no word from the reader within 5 s'), 5000);
          held.add(go);
        }
        return;
      }
      return json(404, { error: { message: 'no route' } });
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    seen,
    writes,
    release: () => [...held].forEach((go) => go('the reader has the first part')),
    close: () => {
      srv.closeAllConnections();
      return new Promise((r) => srv.close(r));
    },
  };
}

/** An add-on as src/gateway sees one: TRouteAI's shape, at the fake gateway's port. */
export const fakeAddon = (port) => ({
  id: 'trouteai',
  title: 'TRouteAI',
  gateway: { port: () => port },
  status: async () => ({ installed: true, version: '1.0.9', running: true, url: `http://localhost:${port}` }),
  start: async () => ({ ok: true }),
});

/** One request, read as it arrives: { status, headers, text, chunks: [{ at, text }] }. `onChunk(chunk, i)` hears each. */
export function stream(url, { method = 'POST', headers = {}, body = '', onChunk = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push({ at: Date.now(), text: c.toString('utf8') });
        onChunk(chunks.at(-1), chunks.length - 1);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: chunks.map((c) => c.text).join(''), chunks }));
      res.on('error', reject);
    });
    r.on('error', reject);
    r.end(body || undefined);
  });
}
