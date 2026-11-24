// A card made before the dashboard restarted: cards and what the owner said live in the running dashboard only, so
// his tap on such a card (a page left open over the restart) runs nothing. What he reads then is one plain sentence
// that says why and what to do: ask her again.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const FAKE_SESSION = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-session.mjs');

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(t);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('his tap on a card made before the dashboard restarted runs nothing and says so in one plain sentence', { timeout: 60_000, skip: process.platform === 'win32' && 'the fake launcher is POSIX' }, async (t) => {
  const box = sandbox('tia-restart');
  const work = path.join(box.root, 'work');
  fs.mkdirSync(path.join(work, 'shop'), { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'ask' } });
  writeProfile('sub', { label: 'Main' });
  const open = async () => {
    const app = createServer({ watch: false, dashboardFile: false });
    const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
    const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
    return { app, base, cookie };
  };
  let d = await open();
  t.after(async () => {
    await d.app.close();
    box.cleanup();
  });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const r = (await request(d.base, 'POST', '/api/assistant/call', { body: { tool: 'start_session', args: { folder: path.join(work, 'shop'), account: 'sub', message: 'run the tests' } }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': 'before' } })).json;
  const id = /card (c_[0-9a-f]{12})/.exec(r.text)[1];
  const made = (await request(d.base, 'GET', '/api/assistant/cards', { headers: { Cookie: d.cookie } })).json.cards.find((c) => c.id === id).createdAt;
  await new Promise((res) => setTimeout(res, 20)); // the next dashboard starts later than the card was made

  // The dashboard restarts; the page he left open still shows the card, and he taps it.
  await d.app.close();
  d = await open();
  const tap = await request(d.base, 'POST', `/api/assistant/cards/${id}/confirm`, { body: { made }, headers: { Cookie: d.cookie } });
  assert.equal(tap.status, 409);
  assert.equal(tap.json.code, 'before-restart');
  assert.equal(tap.json.error, 'This card was made before the dashboard restarted, so it cannot run any more: ask Tia again if you still want it.');
  assert.equal((await request(d.base, 'GET', '/api/state', { headers: { Cookie: d.cookie } })).json.sessions.length, 0, 'something started');
  // Declining it says the same, and changes nothing.
  const no = await request(d.base, 'POST', `/api/assistant/cards/${id}/reject`, { body: { made }, headers: { Cookie: d.cookie } });
  assert.equal(no.status, 409);
  assert.equal(no.json.code, 'before-restart');
  // An id that is not known and that the page does not say was made earlier: refused as before, with no such sentence.
  const odd = await request(d.base, 'POST', '/api/assistant/cards/c_000000000000/confirm', { body: { made: Date.now() + 60_000 }, headers: { Cookie: d.cookie } });
  assert.equal(odd.status, 409);
  assert.notEqual(odd.json.code, 'before-restart');
});
