// tools/chrome.mjs drives only the browser it started. Seen once: another run's Chrome already listened on
// 127.0.0.1:<port>, the new Chrome could bind only [::1]:<port>, and the launcher, which asked 127.0.0.1 for its page,
// drove the other run's browser for 45 s (navigated it, set its viewport, throttled it). Here a stand-in browser (a
// shell script named by CHROME) writes its port and id as Chrome does, and a stand-in listener plays the other browser.
// Chrome writes that file only when it picks the port itself (--remote-debugging-port=0): measured 20 Nov 2026 with
// Chrome 158 on a named port, the port answered and no file came in 10 s, so every launch with a port failed after 12 s.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const skip = process.platform === 'win32' && 'a POSIX shell stand-in';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-launch-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// The stand-in browser: notes that it was started, and, only when told to pick its own port (0) as Chrome, writes
// DevToolsActivePort into its profile (the port it was told to report, and its own id).
const browser = path.join(dir, 'made-up-browser');
const started = path.join(dir, 'started');
fs.writeFileSync(browser, [
  '#!/bin/sh',
  `: > '${started}'`,
  // STANDIN_EXIT: it exits at once with that code and two error lines; STANDIN_DELAY: it writes its port that late.
  '[ -n "$STANDIN_EXIT" ] && { echo "first made-up line" >&2; echo "made-up: cannot open the display" >&2; exit "$STANDIN_EXIT"; }',
  'for a; do case "$a" in --user-data-dir=*) d="${a#--user-data-dir=}";; --remote-debugging-port=*) p="${a#--remote-debugging-port=}";; esac; done',
  '[ -n "$STANDIN_DELAY" ] && sleep "$STANDIN_DELAY"',
  '[ "$p" = 0 ] && printf \'%s\\n/devtools/browser/the-one-this-run-started\\n\' "$STANDIN_REPORTS_PORT" > "$d/DevToolsActivePort"',
  'exec sleep 30',
].join('\n'), { mode: 0o755 });

/** Another run's browser: answers the DevTools questions with its own id and a page to drive, and notes each one. */
async function otherBrowser() {
  const asked = [];
  const server = http.createServer((req, res) => {
    asked.push(req.url);
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/json/version') return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/another-runs-browser` }));
    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/another-runs-tab` }]));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, asked, close: () => new Promise((r) => server.close(r)) };
}

/** A port nothing listens on: one the system gave and took back. */
const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

test('a debugging port named by the caller is refused at once, before any browser starts', { skip }, async () => {
  process.env.CHROME = browser;
  const { launchChrome } = await import('../tools/chrome.mjs');
  // A free port (as story-shots' 8423 was): a Chrome started on it never writes DevToolsActivePort.
  process.env.STANDIN_REPORTS_PORT = String(await freePort());
  let t = Date.now();
  await assert.rejects(launchChrome({ port: Number(process.env.STANDIN_REPORTS_PORT) }), /picks its own debugging port/);
  assert.ok(Date.now() - t < 2000, `refused in ${Date.now() - t} ms, not after waiting for a file Chrome never writes`);
  assert.ok(!fs.existsSync(started), 'no browser was started');
  // A port where another browser answers: refused the same way, and that browser is asked nothing.
  const other = await otherBrowser();
  try {
    process.env.STANDIN_REPORTS_PORT = String(other.port);
    t = Date.now();
    await assert.rejects(launchChrome({ port: other.port }), /picks its own debugging port/);
    assert.ok(!fs.existsSync(started), 'no browser was started');
    assert.deepEqual(other.asked, [], 'the other browser was asked nothing');
  } finally {
    await other.close();
  }
});

test('a browser that answers on the reported port with another id is not driven', { skip }, async () => {
  process.env.CHROME = browser;
  const { launchChrome } = await import('../tools/chrome.mjs');
  const other = await otherBrowser();
  try {
    // The system's free port (0): the stand-in reports a port where another browser answers.
    process.env.STANDIN_REPORTS_PORT = String(other.port);
    await assert.rejects(launchChrome(), /another browser answers there/);
    assert.ok(fs.existsSync(started), 'the browser was started, on a port of its own choosing');
    assert.ok(!other.asked.includes('/json/list'), `no page of the other browser was looked up: ${other.asked}`);
  } finally {
    await other.close();
  }
});

// A caller that asks Chrome's own HTTP list (the desktop check's frame targets) needs the port Chrome picked; it once
// guessed the demo's port + 1, which is not Chrome's. Here the stand-in browser reports a port where a stand-in
// DevTools answers with this run's id and a page that answers every call, so the launch succeeds.
test('the launcher returns the debugging port the browser picked', { skip }, async () => {
  process.env.CHROME = browser;
  const { launchChrome } = await import('../tools/chrome.mjs');
  const { WebSocketServer } = await import('ws');
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/json/version') return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/the-one-this-run-started` }));
    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/this-runs-tab` }]));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (sock) => sock.on('message', (m) => sock.send(JSON.stringify({ id: JSON.parse(m).id, result: {} }))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const picked = server.address().port;
  let chrome = null;
  try {
    process.env.STANDIN_REPORTS_PORT = String(picked);
    chrome = await launchChrome();
    assert.equal(chrome.port, picked, 'the port the browser wrote into DevToolsActivePort');
  } finally {
    if (chrome) await chrome.close();
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  }
});

// Seen on a busy public runner (Ubuntu, Node 24): "Chrome did not start" after 12 s, with nothing to say why. The
// launcher waits while the browser lives (up to 30 s), and says how it ended and its last error lines when it does not.
test('a browser that writes its port only after 13 s is still waited for', { skip, timeout: 60_000 }, async () => {
  process.env.CHROME = browser;
  process.env.STANDIN_DELAY = '13';
  const { launchChrome } = await import('../tools/chrome.mjs');
  const { WebSocketServer } = await import('ws');
  const server = http.createServer((req, res) => {
    const port = server.address().port;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/json/version') return res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/the-one-this-run-started` }));
    res.end(JSON.stringify([{ type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/this-runs-tab` }]));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (sock) => sock.on('message', (m) => sock.send(JSON.stringify({ id: JSON.parse(m).id, result: {} }))));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let chrome = null;
  try {
    process.env.STANDIN_REPORTS_PORT = String(server.address().port);
    const t = Date.now();
    chrome = await launchChrome();
    assert.ok(Date.now() - t >= 12_000, `started after ${Date.now() - t} ms`);
    assert.equal(chrome.port, server.address().port);
  } finally {
    delete process.env.STANDIN_DELAY;
    if (chrome) await chrome.close();
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  }
});

test('a browser that exits at once: the error names its exit code and its last error lines, without waiting out the time', { skip, timeout: 60_000 }, async () => {
  process.env.CHROME = browser;
  process.env.STANDIN_EXIT = '3';
  const { launchChrome } = await import('../tools/chrome.mjs');
  const t = Date.now();
  try {
    await assert.rejects(launchChrome(), (e) => /Chrome did not start: it exited with code 3/.test(e.message) && /made-up: cannot open the display/.test(e.message) ? true : assert.fail(e.message));
  } finally {
    delete process.env.STANDIN_EXIT;
  }
  assert.ok(Date.now() - t < 10_000, `refused in ${Date.now() - t} ms`);
});
