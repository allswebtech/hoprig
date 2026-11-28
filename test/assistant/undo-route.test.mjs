// Undo on her Activity, through the real dashboard: the audit list says which entries can be taken back, the owner's press
// (POST /api/assistant/undo) puts the state back once, and her own token cannot press it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(t); } catch { return null; } })(), headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('Activity: an act she did alone offers Undo, one press takes it back, a second changes nothing; her token cannot press it', { timeout: 60_000 }, async (t) => {
  const box = sandbox('undoroute');
  const { saveConfig, loadConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  saveConfig({ ...loadConfig(), usage: false, server: { backend: 'pty', roots: [box.home], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true }, operator: { acts: true } });
  const { createServer } = await import('../../src/server/server.mjs');
  const app = createServer({ watch: false, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const feature = app.features.find((f) => f.name === 'assistant');
  feature.setAddress(base);
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  const owner = (m, p, b) => request(base, m, p, { body: b, headers: { Cookie: cookie } });
  // She adds a watch alone, through her own door (the switch is on): a watch is Hoprig's own state and can be taken back.
  const tia = fs.readFileSync(`${stateDir()}/assistant-token`, 'utf8').trim();
  const asTia = (tool, args) => request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': 'conv-u' } });
  const added = await asTia('watch_work', { action: 'add', on: 'computer', target: 'this', when: 'fails' });
  assert.equal(added.status, 200, JSON.stringify(added.json));
  assert.equal(feature.core.watches.list().length, 1);
  const seen = (await owner('GET', '/api/assistant/audit')).json.entries.find((e) => e.tool === 'watch_work');
  assert.equal(seen.undo, 'press');
  assert.equal(seen.result.undo.kind, 'watch-add');
  // her token cannot press it
  assert.equal((await request(base, 'POST', '/api/assistant/undo', { body: { at: seen.at }, headers: { Authorization: `Bearer ${tia}` } })).status, 403);
  assert.equal(feature.core.watches.list().length, 1);
  // his press
  assert.equal((await owner('POST', '/api/assistant/undo', {})).status, 400, 'no time given');
  const pressed = await owner('POST', '/api/assistant/undo', { at: seen.at });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.json));
  assert.equal(feature.core.watches.list().length, 0, 'the watch is gone again');
  const after = (await owner('GET', '/api/assistant/audit')).json.entries;
  assert.equal(after.find((e) => e.tool === 'watch_work').undo, 'done');
  assert.ok(after.some((e) => e.tool === 'undo' && e.actor === 'owner' && e.result.undid === seen.at));
  const again = await owner('POST', '/api/assistant/undo', { at: seen.at });
  assert.ok(again.status >= 400, 'a second press does nothing');
  assert.equal(feature.core.watches.list().length, 0);
});
