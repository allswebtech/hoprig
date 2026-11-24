// Settings → Notifications has no field for the push address's headers (a token set by hand in config.json): a save
// from the page, the Work switches' own saves among them, keeps them; only for the same address's origin.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('notifyheaders');
test.after(() => box.cleanup());

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { keepHeaders } = await import('../../src/server/notify.mjs');

const URL1 = 'https://ntfy.example.invalid/topic';
const HEADERS = { Authorization: 'Bearer MADE-UP-TOKEN' };

test('a Work switch saved from the page keeps the push address\'s headers', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('right-password'), notify: { url: URL1, headers: HEADERS } } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  try {
    const call = (p, body, cookie = '') => fetch(`${origin}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
    const login = await call('/api/login', { password: 'right-password' });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    // What web/settings.js sends when one switch of "Work, by itself" is flipped.
    const r = await call('/api/settings', { server: { notify: { url: URL1, events: ['waiting'], work: { failed: true } } } }, cookie);
    assert.equal(r.status, 200, await r.text());
    assert.deepEqual(loadConfig().server.notify, { url: URL1, events: ['waiting'], work: { failed: true }, headers: HEADERS });
    // And the main Save of the push address, which leaves them out as well.
    await call('/api/settings', { server: { notify: { url: URL1, events: ['waiting', 'attention'] }, publicUrl: '' } }, cookie);
    assert.deepEqual(loadConfig().server.notify.headers, HEADERS);
  } finally {
    await app.close();
  }
});

test('headers are kept only for the same address, and a save that sends its own headers wins', () => {
  const stored = { url: URL1, headers: HEADERS };
  assert.deepEqual(keepHeaders({ url: 'https://other.example.invalid/t' }, stored), { url: 'https://other.example.invalid/t' }, 'a token never goes to another address');
  assert.deepEqual(keepHeaders({ url: URL1, headers: {} }, stored), { url: URL1, headers: {} });
  assert.equal(keepHeaders(null, stored), null, 'push turned off');
  assert.deepEqual(keepHeaders({ url: `${URL1}2` }, stored).headers, HEADERS, 'another topic on the same server');
});
