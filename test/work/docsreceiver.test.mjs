// The receiver in docs/WORK.md ("Another program"), run as a script author copies it: it checks the signature and the
// time, and no request (a signature header of other characters) and no failed read of the result (the dashboard down,
// a refusal) ends it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DOC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'WORK.md');
const SECRET = 'a'.repeat(64);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-docsreceiver-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The docs' receiver block, as written. */
function receiverSource() {
  const m = /```js\n(\/\/ receiver\.mjs[\s\S]*?)```/.exec(fs.readFileSync(DOC, 'utf8'));
  assert.ok(m, 'docs/WORK.md has the receiver');
  return m[1];
}
const freePort = () => new Promise((r) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => r(port));
  });
});
/** A stand-in dashboard: answers the read of a task with [status, body]. */
async function dashboard(status, body) {
  const srv = http.createServer((req, res) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
}
async function startReceiver(hoprigUrl) {
  const file = path.join(dir, 'receiver.mjs');
  fs.writeFileSync(file, receiverSource());
  const port = await freePort();
  const child = spawn(process.execPath, [file], { env: { PATH: process.env.PATH, HOOK_SECRET: SECRET, PORT: String(port), HOPRIG_URL: hoprigUrl, HOPRIG_WORK_TOKEN: `hwt_${'x'.repeat(43)}` }, stdio: ['ignore', 'pipe', 'pipe'] });  // seal: process.env.PATH keeps the traps
  const out = { text: '', exited: null };
  child.stdout.on('data', (c) => (out.text += c));
  child.stderr.on('data', (c) => (out.text += c));
  child.on('exit', (code) => (out.exited = code));
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' }).then(() => true, () => false)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, out, stop: () => child.kill() };
}
/** One raw POST (any header bytes): → the status, or null when nothing answered. */
function post(port, body, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(null));
    req.end(body);
  });
}
/** One request written byte by byte (header bytes as latin1, one byte a character): → its status line, or null. */
function rawPost(port, body, headerLines) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let out = '';
    s.on('data', (c) => (out += c));
    s.on('close', () => resolve(/^HTTP\/1\.1 (\d+)/.exec(out)?.[1] ? Number(/^HTTP\/1\.1 (\d+)/.exec(out)[1]) : null));
    s.on('error', () => resolve(null));
    s.end(Buffer.concat([Buffer.from(`POST / HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${headerLines}\r\n`, 'latin1'), Buffer.from(body)]));
  });
}
const signed = (body, ts = String(Math.floor(Date.now() / 1000))) => ({
  'X-Hoprig-Timestamp': ts, 'X-Hoprig-Signature': `sha256=${crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')}`,
});
const settle = () => new Promise((r) => setTimeout(r, 300));

test('the receiver refuses a wrong, old or odd signature with 401 and keeps answering', async () => {
  const rx = await startReceiver('http://127.0.0.1:9');
  try {
    const body = JSON.stringify({ event: 'done', task: { id: 'a-task', title: 'A task', status: 'done' }, run: null, time: new Date().toISOString() });
    assert.equal(await post(rx.port, body, signed(body, String(Math.floor(Date.now() / 1000) - 3600))), 401, 'an old time');
    assert.equal(await post(rx.port, `${body} `, signed(body)), 401, 'a changed body');
    // As long as a real signature in characters (one latin1 byte each on the wire), longer in UTF-8 bytes.
    const odd = `X-Hoprig-Timestamp: ${Math.floor(Date.now() / 1000)}\r\nX-Hoprig-Signature: sha256=${'\xe9'.repeat(64)}\r\n`;
    assert.equal(await rawPost(rx.port, body, odd), 401, 'other characters');
    await settle();
    assert.equal(rx.out.exited, null, `the receiver is still there: ${rx.out.text.slice(0, 300)}`);
    assert.equal(await post(rx.port, body, signed(body)), 204, 'and still takes a good delivery');
  } finally {
    rx.stop();
  }
});

test('a read of the result that fails (the dashboard down, 429, 401) is said, and the receiver keeps answering', async () => {
  const body = JSON.stringify({ event: 'result', task: { id: 'a-task', title: 'A task', status: 'open' }, run: '20261118-100000-0a0b0c0d', time: new Date().toISOString() });
  const down = await startReceiver('http://127.0.0.1:9'); // nothing listens there
  const refusing = await dashboard(429, { error: 'This Work token made 60 requests in the last minute', code: 'minute-limit' });
  const revoked = await dashboard(401, { error: 'this dashboard does not accept that Work token', code: 'token' });
  const fine = await dashboard(200, { task: { id: 'a-task' }, runs: [{ id: '20261118-100000-0a0b0c0d', state: 'done', answer: 'The price list is checked' }] });
  const rxs = [down, await startReceiver(refusing.url), await startReceiver(revoked.url), await startReceiver(fine.url)];
  try {
    for (const rx of rxs) {
      assert.equal(await post(rx.port, body, signed(body)), 204);
      await settle();
      assert.equal(rx.out.exited, null, `the receiver is still there: ${rx.out.text.slice(0, 300)}`);
      assert.equal(await post(rx.port, body, signed(body)), 204, 'and takes the next delivery');
    }
    assert.match(rxs[1].out.text, /429 minute-limit/);
    assert.match(rxs[2].out.text, /401 token/);
    assert.match(rxs[3].out.text, /result: A task\nThe price list is checked/);
  } finally {
    for (const rx of rxs) rx.stop();
    for (const d of [refusing, revoked, fine]) await d.close();
  }
});

test('the docs name every refusal code the token routes send', () => {
  const src = path.join(path.dirname(DOC), '..', 'src', 'work');
  const door = fs.readFileSync(path.join(src, 'tokenfeature.mjs'), 'utf8');
  const store = fs.readFileSync(path.join(src, 'store.mjs'), 'utf8');
  const addFrom = store.slice(store.indexOf('async addFrom('), store.indexOf('async edit('));
  const codes = new Set(['refused']); // what a refusal without a code of its own is sent as
  for (const m of `${door}\n${addFrom}`.matchAll(/code: '([a-z-]+)'|fail\(\d{3}, [^\n]*?'([a-z-]+)'\)/g)) codes.add(m[1] || m[2]);
  const doc = fs.readFileSync(DOC, 'utf8');
  const part = doc.slice(doc.indexOf('## Another program'), doc.indexOf('\n## ', doc.indexOf('## Another program') + 3));
  const missing = [...codes].filter((c) => !part.includes(`\`${c}\``));
  assert.ok(codes.size >= 10, [...codes].join(' '));
  assert.deepEqual(missing, [], 'codes the docs do not name');
});

test('the docs name the refusals an add meets in the Work file, its lock and the body, each with its status', () => {
  const src = path.join(path.dirname(DOC), '..', 'src');
  const read = (f) => fs.readFileSync(path.join(src, f), 'utf8');
  const doc = fs.readFileSync(DOC, 'utf8');
  const part = doc.slice(doc.indexOf('## Another program'), doc.indexOf('\n## ', doc.indexOf('## Another program') + 3));
  const rows = part.split('\n').filter((l) => /^\| \d{3} \|/.test(l));
  const row = (status, code) => rows.some((l) => l.startsWith(`| ${status} |`) && l.split('|')[2].includes(`\`${code}\``));
  // Reading and writing the Work file (store.mjs, from parseText to the store itself) and the file's lock (lock.mjs
  // fileBusy, what withLock throws): every status and code they refuse with.
  const store = read('work/store.mjs');
  const file = store.slice(store.indexOf('export function parseText('), store.indexOf('// ---------- the store of one place'));
  const lock = read('work/lock.mjs');
  const busy = lock.slice(lock.indexOf('const fileBusy'), lock.indexOf('\n', lock.indexOf('const fileBusy')));
  const found = [];
  for (const m of `${file}\n${busy}`.matchAll(/status: (\d{3}),[^\n]*?code: '([a-z-]+)'/g)) found.push([Number(m[1]), m[2]]);
  // The body (server.mjs readJson): its statuses, sent as `refused`.
  const server = read('server/server.mjs');
  const body = server.slice(server.indexOf('function readJson('), server.indexOf('\n}\n', server.indexOf('function readJson(')));
  for (const m of body.matchAll(/new HttpError\((\d{3})/g)) found.push([Number(m[1]), 'refused']);
  const names = found.map(([st, c]) => `${st} ${c}`);
  for (const want of ['409 broken', '409 unreadable', '409 limits', '409 untidy', '409 unwritable', '409 busy', '413 refused', '415 refused']) assert.ok(names.includes(want), `found in the code: ${names.join(', ')}`);
  assert.deepEqual(found.filter(([st, c]) => !row(st, c)).map(([st, c]) => `${st} ${c}`), [], 'refusals the docs do not name with their status');
});
