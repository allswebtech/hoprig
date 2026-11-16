// The desktop shows the dashboard's own pages as windows (same-origin frames). Framing is allowed for this same
// site only: every answer, signed in or not, page or API, says so, and nothing in it lets another site frame the
// dashboard. A real browser check of a page from another origin is in tools/desktop-check.mjs.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('desk-frame');
test.after(() => box.cleanup());

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { securityHeaders } = await import('../../src/server/security.mjs');

const backend = { list: async () => [], capture: async () => '' };

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
  saveConfig({ server: { passwordHash: await hashPassword('right-password') } });
  const app = createServer({ backend });
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
      // Another site asking for the page in a frame (the browser sends these): still only this site may frame it.
      ['/?bare=1', { Cookie: cookie, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site', Referer: 'http://evil.example/' }, 200, 'a cross-site frame request'],
    ];
    for (const [p, headers, status, what] of cases) {
      const r = await fetch(`${origin}${p}`, { headers, redirect: 'manual' });
      assert.equal(r.status, status, what);
      sameOriginOnly(r.headers.get('content-security-policy'), r.headers.get('x-frame-options'), what);
      await r.arrayBuffer();
    }
  } finally {
    await app.close();
  }
});
