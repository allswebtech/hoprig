// The case the owner asked for, end to end on a real dashboard: a script adds a task with a Work token; the owner does
// it ("Do it", with the stand-in Claude Code of the chat tests); a receiver on this computer, its webhook marked "on my
// own network", gets the signed "result ready" and fetches the result with the token.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tempWork } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const t = tempWork('work-token-e2e');
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] }, sessionDefaults: { permissionMode: 'manual' }, work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } });
writeProfile('sub', { label: 'Main' });

const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('a script adds a task with its token, the owner does it, the receiver gets "result ready" signed and reads the result', { timeout: 60_000 }, async (tt) => {
  const app = createServer({
    backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 400, stopGraceMs: 1500 },
    work: { hooks: { lookEvery: 200 } },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const origin = `http://127.0.0.1:${port}`;
  tt.after(() => app.close());
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const page = async (p, body) => {
    const r = await fetch(origin + p, body === undefined ? { headers: { Cookie: cookie } } : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
    const b = await r.json();
    assert.equal(r.status, 200, `${p}: ${JSON.stringify(b)}`);
    return b;
  };

  // The owner: a token, and a webhook for its tasks to a receiver on this computer.
  const token = (await page('/api/work/access/tokens', { name: 'Shop script', confirmed: true })).secret;
  let secret = null;
  const results = [];
  const receiver = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const ts = req.headers['x-hoprig-timestamp'];
      const want = `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
      const sig = String(req.headers['x-hoprig-signature'] || '');
      const ok = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want)) && Math.abs(Date.now() / 1000 - Number(ts)) < 300;
      res.writeHead(ok ? 204 : 401).end();
      if (!ok) return results.push({ refused: true });
      const ev = JSON.parse(body);
      // the result itself is read with the token, not taken from the body
      const r = await fetch(`${origin}/api/work/token/tasks/${ev.task.id}`, { headers: { Authorization: `Bearer ${token}` } });
      results.push({ ev, read: await r.json() });
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  tt.after(() => new Promise((r) => receiver.close(r)));
  const hookUrl = `http://127.0.0.1:${receiver.address().port}/hoprig`;
  const ask = await page('/api/work/access/webhooks', { token: (await page('/api/work/access')).tokens[0].id, url: hookUrl, events: ['result'], ownNetwork: true });
  assert.ok(ask.confirm.includes(hookUrl), 'the question names the address');
  secret = (await page('/api/work/access/webhooks', { token: (await page('/api/work/access')).tokens[0].id, url: hookUrl, events: ['result'], ownNetwork: true, confirmed: true })).secret;

  // The script: adds a task with its token.
  const added = await fetch(`${origin}/api/work/token/tasks`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Say hello from the shop', note: 'Answer with one line.', project: 'shop' }) });
  assert.equal(added.status, 200);
  const task = (await added.json()).task;
  assert.equal(task.from, 'Shop script');

  // Nothing starts by itself: the task waits for the owner.
  await new Promise((r) => setTimeout(r, 600));
  assert.equal((await page('/api/work')).items.find((x) => x.id === task.id).status, 'open');

  // The owner does it: the sheet shows the brief (the script's words fenced as data from outside), then Start.
  const it = (await page('/api/work')).items.find((x) => x.id === task.id);
  assert.equal(it.from.name, 'Shop script');
  const plan = await page(`/api/work/items/${task.id}/do?at=${it.at}`);
  assert.match(plan.brief, /added by another program \(the Work token "Shop script"\)/);
  assert.match(plan.brief, /<untrusted_data source="work-token"/);
  const started = await page(`/api/work/items/${task.id}/do`, { at: it.at, seen: plan.brief });
  assert.equal(started.run.state, 'running');

  const got = await until('the receiver to get "result ready"', () => results.length && results[0]);
  assert.equal(got.refused, undefined, 'the signature checks out');
  assert.equal(got.ev.event, 'result');
  assert.equal(got.ev.task.id, task.id);
  assert.equal(got.ev.run, started.run.id);
  assert.equal('answer' in got.ev, false, 'the answer is not in the body');
  assert.equal(got.read.task.status, 'review');
  assert.equal(got.read.runs.length, 1);
  assert.equal(got.read.runs[0].state, 'done');
  assert.match(got.read.runs[0].answer, /Say hello from the shop/, 'the result read with the token: the session\'s answer');
  assert.equal(JSON.stringify(got.read).includes(t.root), false, 'no full path in what the token reads');
  for (const k of ['session', 'folder', 'commits', 'changed', 'brief']) assert.equal(k in got.read.runs[0], false, k);
  // The owner's side: Activity's list of runs names the program the task came from.
  const listed = (await page(`/api/work/runs?item=${task.id}`)).runs;
  assert.equal(listed[0].from, 'Shop script', 'Activity names the Work token of the run\'s task');
});

test.after(() => t.cleanup());
