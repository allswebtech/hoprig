// A gateway's page opened through its forward (src/machines/forward.mjs) never gets the dashboard's sign-in, in a
// real browser (headless Chrome): a stand-in dashboard on 127.0.0.1 sets the product's own session cookie, then the
// forward's link is opened. A browser keeps cookies per host name, not per port, so a forward on the dashboard's own
// host name would be sent that cookie. Here the gateway's server must see none, and what the gateway's page asks of
// the dashboard arrives cross-site and without it. The other computer is reached through the stand-in ssh.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { fakeRemote } from './harness.mjs';
import { traps } from './traps.mjs';
import { sealedPath } from '../seal.mjs';

const box = sandbox('machines-forward-browser');
const { findChrome, launchChrome } = await import('../../tools/chrome.mjs');
const { sessionCookie } = await import('../../src/server/auth.mjs');
const { Forwards } = await import('../../src/machines/forward.mjs');
const skip = (process.platform === 'win32' && 'POSIX scripts') || (!findChrome() && 'no Chrome on this computer')
  || (process.platform === 'darwin' && process.env.CI && 'Chrome on the public macOS test computers does not answer a page load within a minute; proven on Linux');

const TOKEN = 'made-up-session-token-0123456789abcdef';
const seen = { dash: [], gw: [] };
const note = (list) => (req) => list.push({ url: req.url, cookie: req.headers.cookie || '', site: req.headers['sec-fetch-site'] || '' });
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

const dash = http.createServer((req, res) => {
  note(seen.dash)(req);
  if (req.url === '/') res.writeHead(200, { 'Set-Cookie': sessionCookie(TOKEN, { secure: false }), 'Content-Type': 'text/html' });
  res.end('<title>dashboard</title>');
});
const dashPort = await listen(dash);
const gw = http.createServer((req, res) => {
  note(seen.gw)(req);
  res.writeHead(200, { 'Content-Type': 'text/html' });
  // The gateway's page asks the dashboard for something, as any script of someone else's web program could.
  res.end(`<title>gateway</title><img src="http://127.0.0.1:${dashPort}/api/from-gateway">`);
});
const gwPort = await listen(gw);
const remote = fakeRemote(path.join(box.root, 'ssh'));
const trap = traps(box.root);
const forwards = new Forwards({ ssh: { env: { ...remote.sshEnv, PATH: sealedPath(trap.path(remote.bin)) } } });
let chrome = null;
test.after(async () => {
  forwards.closeAll();
  if (chrome) await chrome.close();
  await new Promise((r) => dash.close(r));
  await new Promise((r) => gw.close(r));
  box.cleanup();
});

test('the forward\'s server never receives the dashboard\'s cookie, and the gateway\'s page is another site', { skip }, async () => {
  process.env.HOPRIG_SEAL_REAL = path.basename(findChrome()); // seal: only a real browser shows which cookies it sends to which host and port; it opens pages on 127.0.0.1 only
  try {
    chrome = await launchChrome();
  } finally {
    delete process.env.HOPRIG_SEAL_REAL; // seal: the browser is started; nothing else of the file needs it
  }
  await chrome.goto(`http://127.0.0.1:${dashPort}/`, 600);
  await chrome.goto(`http://127.0.0.1:${dashPort}/again`, 600);
  assert.ok(seen.dash.find((r) => r.url === '/again').cookie.includes(TOKEN), 'the browser holds the dashboard\'s sign-in');
  const st = await forwards.open({ name: 'box2', target: 'alex@box2' }, 'relay', gwPort, { pageHost: `127.0.0.1:${dashPort}` });
  await chrome.goto(st.url, 1500);
  const page = seen.gw.filter((r) => r.url === '/');
  assert.ok(page.length, 'the gateway\'s page was opened through the forward');
  for (const r of seen.gw) assert.ok(!r.cookie.includes(TOKEN), `the gateway got the dashboard's cookie on ${r.url}`);
  const sub = seen.dash.filter((r) => r.url === '/api/from-gateway');
  assert.ok(sub.length, 'the gateway\'s page asked the dashboard');
  for (const r of sub) {
    assert.ok(!r.cookie.includes(TOKEN), 'its request to the dashboard carried the sign-in');
    assert.equal(r.site, 'cross-site');
  }
  assert.notEqual(new URL(st.url).hostname, '127.0.0.1', 'not the dashboard\'s host name');
  trap.check();
});
