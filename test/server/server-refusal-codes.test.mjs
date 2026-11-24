// A refusal of the server that names a place carries its code beside the sentence (web/errorways.js turns the code
// into a button to that place): bypass-off (a start and Settings' defaults), no-provider, notify-address, and the
// deck's root-bypass for a start as root with bypass in the config's arguments, which is still refused. The sign-in
// page's words for a used or old sign-in code. Root is a fact handed in: nothing here runs as root.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from './helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-launcher.mjs');
const box = sandbox('refusalcodes');
const work = path.join(box.root, 'work');
fs.mkdirSync(work);
const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { ROOT_BYPASS_LINE } = await import('../../src/bypassgate.mjs');
const OTHER = 'http://shop.example';
saveConfig({ launcher: [process.execPath, FAKE], allowBypass: false, server: { backend: 'pty', roots: [box.root], allowedOrigins: [OTHER], passwordHash: await hashPassword('test-password-1') } });
test.after(() => box.cleanup());

/** A dashboard (as root when `root`), signed in: { req, raw, list, close }. */
async function dashboard(root) {
  const app = createServer({ dashboardFile: false, root, workUser: null });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'test-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (p, body) => {
    const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  // A request with a Host header of its own (one the server cannot read an address from), from an allowed origin.
  const raw = (p, body, host) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { Host: host, Origin: OTHER, Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    r.on('error', reject);
    r.end(data);
  });
  return { req, raw, base, list: async () => (await req('/api/state')).json.sessions, close: () => app.close() };
}

test('no provider yet: the start says so with no-provider', async (t) => {
  const d = await dashboard(false);
  t.after(() => d.close());
  const r = await d.req('/api/sessions', { dir: work, mode: 'new' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'no-provider');
  assert.match(r.json.error, /no provider on this computer yet: add one under Providers first/);
});

test('bypass off: a start in bypass and Settings\' defaults in bypass say so with bypass-off; another refusal there has no code', async (t) => {
  writeProfile('sub', { label: 'Stored sign-in' });
  const d = await dashboard(false);
  t.after(() => d.close());
  let r = await d.req('/api/sessions', { dir: work, profile: 'sub', mode: 'new', permissionMode: 'bypassPermissions' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'bypass-off');
  assert.match(r.json.error, /^bypass permissions mode \(the coding tool then acts without asking you first\) is off: turn on "Allow bypass permissions mode" in Settings → New-session defaults first\.$/);
  r = await d.req('/api/settings', { sessionDefaults: { permissionMode: 'bypassPermissions' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'bypass-off');
  assert.match(r.json.error, /^bypass permissions mode \(the coding tool then acts without asking you first\) is off: turn on "Allow bypass permissions mode" in Settings → New-session defaults first\.$/, 'the place its button opens');
  assert.notEqual((loadConfig().sessionDefaults || {}).permissionMode, 'bypassPermissions', 'nothing was saved');
  r = await d.req('/api/settings', { sessionTitles: 'yes' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, undefined, 'a refusal that names no place carries no code');
  assert.equal((await d.list()).length, 0, 'no session was started');
});

test('a sign-in code for a page whose address cannot be told: notify-address', async (t) => {
  const d = await dashboard(false);
  t.after(() => d.close());
  const r = await d.raw('/api/login/links', {}, 'no_address_here');
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'notify-address');
  assert.equal(r.json.error, 'this page\'s address is not known here: set it in Settings → Notifications → This page\'s address');
});

test('a used or old sign-in code: the sign-in page says to show one again on the computer', async (t) => {
  const d = await dashboard(false);
  t.after(() => d.close());
  const r = await fetch(`${d.base}/api/login/link`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: d.base }, body: JSON.stringify({ token: 'not-a-real-code' }) });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'This sign-in code was used already or is too old. On the computer, press Show a sign-in code again.' });
});

test('as root, a start with bypass in every launch\'s arguments is still refused, now with root-bypass', async (t) => {
  saveConfig({ allowBypass: true, claudeArgs: ['--dangerously-skip-permissions'] });
  t.after(() => saveConfig({ allowBypass: false, claudeArgs: [] }));
  const d = await dashboard(true);
  t.after(() => d.close());
  const r = await d.req('/api/sessions', { dir: work, profile: 'sub', mode: 'new' });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, ROOT_BYPASS_LINE);
  assert.equal(r.json.code, 'root-bypass');
  assert.equal((await d.list()).length, 0, 'no session was started');
  // Named on the start itself: the route's own refusal, as before.
  const own = await d.req('/api/sessions', { dir: work, profile: 'sub', mode: 'new', permissionMode: 'bypassPermissions' });
  assert.deepEqual([own.status, own.json.code], [409, 'root-bypass']);
});
