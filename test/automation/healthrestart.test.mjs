// Health's "Restart the dashboard" (POST /api/health/restart, src/automation/feature.mjs): the same restart as the
// Updates page's Restart now, at any time, from the owner's own page only: here (signed in), or a hub of his relayed
// with its page's mark. Never Tia's door, a paired script's token, or a body that does not name this computer. A real
// dashboard; the restart itself is a stand-in that only counts (no service manager is asked, nothing stops).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import '../chat/fakedom.mjs'; // web/health.js draws with the page's lib.js

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (x) => (t += x));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(t); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, setCookie: res.headers['set-cookie'] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('the restart on Health: the owner\'s page and his hub\'s page only, with this computer\'s name', { timeout: 60_000 }, async (t) => {
  const box = sandbox('healthrestart');
  t.after(() => box.cleanup());
  fs.mkdirSync(path.join(box.root, 'work'), { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { OWNER_PAGE_HEADER, SELF_HEADER } = await import('../../src/machines/relay.mjs');
  const { defaultHubLabel } = await import('../../src/machines/hub.mjs');
  saveConfig({ server: { backend: 'pty', roots: [path.join(box.root, 'work')], passwordHash: await hashPassword('pw-for-tests'), machineLabel: 'made-up-box' } });
  const hub = createToken('made-up-hub', { hub: true });
  const script = createToken('made-up-script');
  let service = true;
  const runs = [];
  const app = createServer({ watchTickMs: 60_000, dashboardFile: false, automation: { restarter: { installed: () => service, run: () => runs.push(1) } } });
  t.after(() => app.close().catch(() => {}));
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).setCookie[0].split(';')[0];
  const NAME = defaultHubLabel();
  assert.equal(NAME, 'made-up-box');
  const owner = (b) => request(base, 'POST', '/api/health/restart', { body: b, headers: { Cookie: cookie } });
  const token = (tok, more, b = { confirm: NAME }) => request(base, 'POST', '/api/health/restart', { body: b, headers: { Authorization: `Bearer ${tok}`, ...more } });

  // Refused, and nothing restarts.
  assert.equal((await owner({})).status, 400, 'no name of this computer');
  assert.equal((await owner({ confirm: 'another-box' })).status, 400, 'another computer\'s name');
  assert.equal((await owner({ confirm: NAME, force: true })).status, 400, 'nothing else in the body');
  for (const [what, r] of [
    ['Tia through a hub', await token(hub.token, { [SELF_HEADER]: '1' })],
    ['both marks', await token(hub.token, { [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' })],
    ['a hub token without the page\'s mark', await token(hub.token, {})],
    ['a paired script that sets the mark itself', await token(script.token, { [OWNER_PAGE_HEADER]: '1' })],
    ['Tia\'s own key', await request(base, 'POST', '/api/health/restart', { body: { confirm: NAME }, headers: { Authorization: 'Bearer tia_made-up' } })],
    ['no sign-in at all', await request(base, 'POST', '/api/health/restart', { body: { confirm: NAME } })],
  ]) assert.ok([401, 403].includes(r.status), `${what}: ${r.status} ${JSON.stringify(r.json)}`);
  assert.deepEqual(runs, [], 'nothing restarted');

  // The owner's page here, then his hub's page relayed with its mark.
  const mine = await owner({ confirm: NAME });
  assert.deepEqual([mine.status, mine.json], [200, { ok: true, restarting: true }]);
  const relayed = await token(hub.token, { [OWNER_PAGE_HEADER]: '1' });
  assert.equal(relayed.status, 200, JSON.stringify(relayed.json));
  assert.deepEqual(runs, [1, 1]);

  // Not a background service: it says so and restarts nothing.
  service = false;
  const plain = await owner({ confirm: NAME });
  assert.equal(plain.json.ok, false);
  assert.match(plain.json.why, /not running as a background service/);
  assert.deepEqual(runs, [1, 1]);
});

test('the sheet says what happens to the sessions on that computer', async () => {
  globalThis.window ??= { addEventListener() {} };
  const { restartWords } = await import('../../web/health.js');
  assert.match(restartWords({ restoreDefault: false }, 'alpha'), /^Its sessions are kept by tmux: they go on through the restart\./);
  assert.match(restartWords({ restoreDefault: true, restoreOn: true }, 'alpha'), /built-in terminals, which end with the restart; "Reopen sessions after a restart" is on, so they come back/);
  assert.match(restartWords({ restoreDefault: true, restoreOn: false }, 'alpha'), /is off, so they do not come back/);
  assert.match(restartWords(null, 'alpha'), /Sessions kept by tmux go on/);
  assert.match(restartWords(null, 'alpha'), /This page loses alpha for a few seconds\.$/);
});
