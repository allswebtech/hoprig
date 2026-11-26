// For tests that call a dashboard running in their own process across a long step (a go-live, a removal): each call on
// a connection of its own, and a watch over the process's event loop.
//
// Node's fetch keeps a connection open for the next request (about 4 s), and the server closes one it judges idle (5
// s). In one process both run on the same loop: when the loop has stood still, the server's timer may close a
// connection at the moment the next request is sent on it, and that request is reset (ECONNRESET). A call here never
// reuses one: node:http with `agent: false` opens a connection for the request and closes it after the answer
// ("Connection: close"), so no request is ever sent on a socket that may be closing.
import http from 'node:http';
import { performance } from 'node:perf_hooks';

/** One request on a connection of its own → { status, json (null when not JSON), headers }. `body`: sent as JSON. */
export function oneCall(origin, method, p, { headers = {}, body } = {}) {
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const r = http.request(origin + p, { method, agent: false, headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(parts).toString('utf8'));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
      res.on('error', reject);
    });
    r.on('error', (e) => reject(Object.assign(new Error(`${method} ${p}: ${e.code || e.message}`), { cause: e })));
    r.end(data || undefined);
  });
}

/**
 * A watch over this process's event loop: the longest time it stood still (a 50 ms beat that came late), and during
 * which step of the test (`mark(step)` names the step that begins). `end()` stops it; on Windows it prints one line
 * "WINDIAG loop: <name> …" (never a failure). → { mark(step), end() → { longest, during } }
 */
export function loopWatch(name, { every = 50 } = {}) {
  let step = 'the start';
  let longest = 0;
  let during = step;
  let last = performance.now();
  const beat = setInterval(() => {
    const now = performance.now();
    const stood = now - last - every;
    if (stood > longest) {
      longest = stood;
      during = step;
    }
    last = now;
  }, every);
  beat.unref();
  return {
    mark: (s) => (step = s),
    end() {
      clearInterval(beat);
      if (process.platform === 'win32') console.log(`WINDIAG loop: ${name} the longest stop of the loop ${Math.round(longest)} ms, during ${during}`);
      return { longest, during };
    },
  };
}
