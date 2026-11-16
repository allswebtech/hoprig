// The desktop shows the dashboard's own pages as windows (same-origin frames). Framing is allowed for this same
// site only: every answer, signed in or not, page or API, says so, and nothing in it lets another site frame the
// dashboard. A real browser check of a page from another origin is in tools/desktop-check.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'chat', 'fixtures', 'fake-claude.mjs');

const box = sandbox('desk-frame');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { securityHeaders } = await import('../../src/server/security.mjs');

const backend = { list: async () => [], capture: async () => '' };

/** The status and headers of a chat's event stream (it stays open: read the head, then hang up). */
const streamHead = (u, headers) => new Promise((resolve, reject) => {
  const req = http.get(u, { headers }, (res) => {
    resolve({ status: res.statusCode, headers: res.headers });
    req.destroy();
  });
  req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
});

/** Only 'self' may frame: no other source, no wildcard, no scheme, and the old header agrees. */
function sameOriginOnly(csp, xfo, what) {
  const fa = /(?:^|;\s*)frame-ancestors ([^;]*)/.exec(csp || '');
  assert.ok(fa, `${what}: frame-ancestors is set`);
  assert.deepEqual(fa[1].trim().split(/\s+/), ["'self'"], `${what}: frame-ancestors is 'self' and nothing else`);
  assert.equal(String(xfo).toUpperCase(), 'SAMEORIGIN', `${what}: X-Frame-Options`);
}

test('the headers allow framing by this same site only, whatever the host', () => {
  for (const host of ['127.0.0.1:7433', 'pc.example.test', null, 'evil.example"><x']) {
    const h = securityHeaders(host);
    sameOriginOnly(h['Content-Security-Policy'], h['X-Frame-Options'], String(host));
    assert.doesNotMatch(h['Content-Security-Policy'], /frame-ancestors[^;]*(\*|https?:|evil)/);
  }
});

test('every kind of answer over real HTTP carries the same-origin framing rule', async () => {
  const work = path.join(box.root, 'work');
  fs.mkdirSync(work, { recursive: true });
  saveConfig({ server: { roots: [work], passwordHash: await hashPassword('right-password') } });
  const { writeProfile } = await import('../../src/profiles.mjs');
  writeProfile('sub', { label: 'Main' });
  // A chat runs the stand-in for Claude Code (the chat's own tests use it): its event stream is an answer too.
  const app = createServer({ backend, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 60_000 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const cases = [
      ['/?bare=1', { Cookie: cookie }, 200, 'the page in bare mode'],
      ['/', { Cookie: cookie }, 200, 'the page'],
      ['/', {}, 302, 'the page, signed out'],
      ['/login', {}, 200, 'the login page'],
      ['/api/state', { Cookie: cookie }, 200, 'an API answer'],
      ['/api/state', {}, 401, 'an API answer, signed out'],
      ['/no-such-file.html', { Cookie: cookie }, 404, 'a missing file'],
      ['/api/codetools', { Cookie: cookie }, 200, 'the coding tools'],
      ['/api/chats/00000000-0000-4000-8000-000000000000/stream', { Cookie: cookie }, 404, 'the stream of no chat'],
      // Another site asking for the page in a frame (the browser sends these): still only this site may frame it.
      ['/?bare=1', { Cookie: cookie, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site', Referer: 'http://evil.example/' }, 200, 'a cross-site frame request'],
    ];
    for (const [p, headers, status, what] of cases) {
      const r = await fetch(`${origin}${p}`, { headers, redirect: 'manual' });
      assert.equal(r.status, status, what);
      sameOriginOnly(r.headers.get('content-security-policy'), r.headers.get('x-frame-options'), what);
      await r.arrayBuffer();
    }
    // A running chat's event stream (server-sent events, written with its own head) and its refusal signed out.
    const made = await fetch(`${origin}/api/chats`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify({ dir: work, profile: 'sub' }) });
    assert.equal(made.status, 200, 'a chat starts');
    const { id } = await made.json();
    for (const [headers, status, what] of [[{ Cookie: cookie }, 200, 'a chat\'s event stream'], [{}, 401, 'a chat\'s event stream, signed out']]) {
      const r = await streamHead(`${origin}/api/chats/${id}/stream`, headers);
      assert.equal(r.status, status, what);
      sameOriginOnly(r.headers['content-security-policy'], r.headers['x-frame-options'], what);
    }
    await fetch(`${origin}/api/chats/${id}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: '{}' });
  } finally {
    await app.close();
  }
});
