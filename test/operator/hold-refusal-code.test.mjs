// A start refused because new starts are held ("Lift the hold on the Operator page to start now.") carries the code of
// the Operator page beside its words (web/errorways.js turns it into a button to that page): a session's start and a
// chat's open. Nothing starts while the hold stands.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'fixtures', 'fake-launcher.mjs');
const box = sandbox('holdcode');
const work = path.join(box.root, 'work');
fs.mkdirSync(work);
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { setHold, liftHold } = await import('../../src/operator/decide-store.mjs');
const { WAYS } = await import('../../web/errorways.js');
saveConfig({ launcher: [process.execPath, FAKE], server: { backend: 'pty', roots: [box.root], passwordHash: await hashPassword('test-password-1') } });
writeProfile('sub', { label: 'Stored sign-in' });
test.after(() => {
  liftHold();
  box.cleanup();
});

async function dashboard() {
  const app = createServer({ dashboardFile: false, root: false, workUser: null });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'test-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const req = async (p, body) => {
    const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  return { req, list: async () => (await req('/api/state')).json.sessions, close: () => app.close() };
}

test('a held start says so with the Operator page\'s code; its words stay; nothing starts', async (t) => {
  assert.deepEqual([WAYS['operator-page'].label, WAYS['operator-page'].href], ['Operator', '#/operator'], 'the code is in the one table');
  const d = await dashboard();
  t.after(() => d.close());
  for (const by of ['owner', 'tia']) {
    liftHold();
    setHold(Date.now() + 20 * 60_000, Date.now(), by);
    const s = await d.req('/api/sessions', { dir: work, profile: 'sub', mode: 'new' });
    assert.equal(s.status, 409, by);
    assert.equal(s.json.code, 'operator-page', `${by}: a session's start`);
    assert.match(s.json.error, /hold new starts for about \d+ min more.*Lift the hold on the Operator page to start now\.$|holds new starts for about \d+ min more.*Lift the hold on the Operator page to start now\.$/);
    const c = await d.req('/api/chats', { dir: work, profile: 'sub', text: 'hello' });
    assert.equal(c.status, 409, by);
    assert.equal(c.json.code, 'operator-page', `${by}: a chat's open`);
    assert.match(c.json.error, /Lift the hold on the Operator page to start now\.$/);
  }
  assert.equal((await d.list()).length, 0, 'nothing started');
  liftHold();
});
