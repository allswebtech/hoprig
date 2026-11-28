// Her new reach in a REAL dashboard (not a stand-in): the dashboard hands the acts adapter and the one watch store to her core,
// so plan_acts runs its steps and watch_work keeps a watch that the operator's loop fires and tells.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(t); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function dashboard(t, name) {
  const box = sandbox(name);
  const work = path.join(box.root, 'work');
  fs.mkdirSync(path.join(work, 'projects'), { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level: 'ask' }, operator: { acts: true } });
  const app = createServer({ watch: false, dashboardFile: false, workspace: { dir: path.join(box.root, 'ws'), projectsDir: () => path.join(work, 'projects') } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); box.cleanup(); });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args, conversation = 'wired') => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': conversation } })).json;
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => resolve(res.headers['set-cookie'][0].split(';')[0]));
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const confirm = (id) => request(base, 'POST', `/api/assistant/cards/${id}/confirm`, { body: {}, headers: { Cookie: cookie } });
  const feature = (n) => app.features.find((f) => f.name === n);
  return { app, call, confirm, feature, base, cookie, box };
}

test('a plan of reads runs its steps in a real dashboard, and her watch is the one the operator loop evaluates', { timeout: 120_000 }, async (t) => {
  const d = await dashboard(t, 'reachwired');
  // Her core has the acts adapter and THE watch store (one object, shared with the operator's attention loop).
  assert.ok(d.feature('assistant').core.watches, 'her core holds a watch store');
  assert.equal(d.feature('assistant').core.watches, d.feature('operator').watches, 'the same store as the operator loop');
  // watch_work add -> list: kept; the operator loop can read it.
  let r = await d.call('watch_work', { action: 'add', on: 'computer', target: 'box', when: 'back', tell: 'row' });
  assert.ok(!r.isError, r.text);
  r = await d.call('watch_work', { action: 'list' });
  assert.match(r.text, /1 watch/, r.text);
  assert.equal(d.feature('operator').watches.list().length, 1);
  // The operator loop fires it from its facts and tells him once.
  const { factsOf } = await import('../../src/assistant/watches.mjs');
  const fired = d.feature('operator').watches.evaluate(factsOf({ computers: [{ name: 'box', status: 'online' }] }));
  assert.equal(fired.length, 1);
  assert.match(fired[0].text, /box is back/);
  // A plan of two reads: found first, then planned; it runs at once, every step done (not "this build cannot run").
  const found = await d.call('find_acts', { query: 'extras folders recent', limit: 8 });
  assert.match(found.text, /folders\.extras/, found.text);
  const found2 = await d.call('find_acts', { query: 'move read' });
  assert.match(found2.text, /machine\.move-read/, found2.text);
  const p = await d.call('plan_acts', { title: 'Look at two things', steps: [{ act: 'folders.extras', args: {} }, { act: 'machine.move-read', args: {} }], why: 'he asked to look' });
  assert.ok(!p.isError, p.text);
  assert.match(p.text, /done/, p.text);
  assert.doesNotMatch(p.text, /failed|cannot/, p.text);
});
