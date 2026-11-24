// For test/seal.test.mjs: a test file that listens on a port of its own (SEAL_PORT), then connects to it in the way
// SEAL_KNOCK names (net, http or fetch). The runner names that port in HOPRIG_SEAL_EXTRA_PORTS, so the seal must refuse
// the connection as it refuses one to a default port of the product: the caller sees a closed port, and the run fails
// by name. The test itself passes whatever happens; it prints what the caller saw.
import http from 'node:http';
import net from 'node:net';
import { test } from 'node:test';

const port = Number(process.env.SEAL_PORT);

test('knocks on its own port', async () => {
  let accepted = 0;
  const server = net.createServer((s) => { accepted++; s.destroy(); });
  await new Promise((res) => server.listen(port, '127.0.0.1', res));
  let saw;
  try {
    if (process.env.SEAL_KNOCK === 'net') {
      saw = await new Promise((res) => {
        const s = net.connect({ port, host: '127.0.0.1' });
        s.once('connect', () => { s.destroy(); res('connected'); });
        s.once('error', (e) => res(e.code));
      });
    } else if (process.env.SEAL_KNOCK === 'http') {
      saw = await new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/' }, (r) => { r.resume(); res(`status ${r.statusCode}`); }).on('error', (e) => res(e.code)));
    } else {
      saw = await fetch(`http://127.0.0.1:${port}/`).then((r) => `status ${r.status}`, (e) => e.cause?.code || e.code || e.message);
    }
  } finally {
    await new Promise((res) => server.close(res));
  }
  console.log(`KNOCK ${saw} accepted ${accepted}`);
});
