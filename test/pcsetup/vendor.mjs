// A stand-in vendor for the checked-download tests: a server of the test's own on 127.0.0.1, reached through the getter
// the product is handed. The product checks the vendor's own https addresses; the getter only carries each one to the
// local server by its path, so a refusal is always the product's, never the network's.
//   routes[path]: { status, headers, body } or a function (req, res)
//   → { get (the getter), asked (every address asked, in order) }
import http from 'node:http';

export async function vendor(tc, routes) {
  const asked = [];
  const server = http.createServer((req, res) => {
    const r = routes[req.url];
    if (typeof r === 'function') return r(req, res);
    if (!r) return res.writeHead(404).end();
    res.writeHead(r.status || 200, r.headers || {});
    res.end(r.body || '');
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  tc.after(() => new Promise((ok) => {
    server.closeAllConnections();
    server.close(ok);
  }));
  const { port } = server.address();
  const get = (url) => {
    asked.push(url);
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: u.pathname + u.search }, (res) => resolve({ status: res.statusCode, headers: res.headers, body: res })).on('error', reject);
    });
  };
  return { get, asked };
}
