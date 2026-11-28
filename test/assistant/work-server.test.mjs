// manage_work on the real dashboard: the Work routes, her door, the card and the job, with the stand-in coding tool for
// the run's session and the stand-in engine for her turns (no model). Her token reaches Work only through her tool;
// an act and its undo land in the Work file; the start's card runs only on the owner's yes, two yeses make one run;
// the run's session ends, the task goes to review, and the job wakes her to report in two lines without accepting.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { closedGateways } from '../seal.mjs';
import { tempWork } from '../work/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_TIA = path.join(HERE, 'fixtures', 'fake-tia.mjs');

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
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('Tia and Work in the real dashboard: her door, an act and its undo, the start card, one run, the job that reports', { timeout: 180_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const w = tempWork('tia-work');
  // A workspace of its own (tempWork): a dashboard maps its workspace a second after it starts.
  assert.equal(process.env.HOPRIG_WORKSPACE_DIR, w.ws);
  const shop = path.join(w.projects, 'shop');
  w.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({
    server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') },
    assistant: { enabled: true, level: 'work' }, operator: { acts: true }, sessionDefaults: { permissionMode: 'default' },
    work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
    addons: closedGateways(), // the shipped gateway's port is the test's own, never the default
  });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 30_000 },
    assistant: { engine: { command: { command: process.execPath, args: [FAKE_TIA] }, resolveEnv: async () => ({ ...process.env }) } },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  // Her engine's tools call this dashboard (without a dashboard file it would take the configured port).
  app.features.find((f) => f.name === 'assistant').setAddress(base);
  t.after(async () => {
    await app.close();
    w.cleanup();
  });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const conv = 'conv-work';
  const call = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': conv } })).json;
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const file = path.join(shop, 'docs', 'plans', 'tasks.json');
  const items = () => JSON.parse(fs.readFileSync(file, 'utf8')).items;
  const runsDir = path.join(shop, 'docs', 'plans', 'runs');
  const runFiles = () => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')) : []);

  // Her token reaches Work's routes only through her tool: the routes themselves refuse it.
  for (const [m, p, b] of [['GET', '/api/work'], ['POST', '/api/work/items', { title: 'Sneak in a task' }], ['POST', '/api/work/items/x/do', { at: 0, brief: 'go' }], ['GET', '/api/work/runs']]) {
    const r = await request(base, m, p, { body: b, headers: { Authorization: `Bearer ${tia}` } });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.json.code, 'token-scope');
  }
  assert.deepEqual(items(), []);

  // An act lands in the Work file at once; undo takes it back.
  let r = await call('manage_work', { action: 'add', title: 'Rename the checkout button', project: 'shop' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(items().map((x) => x.id), ['rename-the-checkout-button']);
  r = await call('manage_work', { action: 'undo' });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(items(), []);

  // The task the session will do, and Today as she reads it.
  r = await call('manage_work', { action: 'add', title: 'Fix the cart total', project: 'shop', by: 'ai', note: 'The total ignores the discount code.' });
  assert.equal(r.isError, false, r.text);
  r = await call('manage_work', { action: 'list' });
  assert.match(r.text, /"task":"fix-the-cart-total"/);
  assert.match(r.text, /<untrusted_data tool="manage_work">.*The total ignores the discount code/s);

  // A start is a card; two cards for the task, two yeses at once: one run, one session.
  const start = { action: 'start', task: 'fix-the-cart-total', brief: 'Make the cart total use the discount code. Done: the cart test passes. Do not push.', kind: 'code' };
  const a = await call('manage_work', start);
  const b = await call('manage_work', start);
  for (const x of [a, b]) assert.match(x.text, /Waiting for the owner's OK/, x.text);
  assert.deepEqual(runFiles(), [], 'nothing started before the yes');
  const card = (x) => /card (c_[0-9a-f]{12})/.exec(x.text)[1];
  const cards = (await owner('GET', '/api/assistant/cards')).json.cards;
  const shown = cards.find((c) => c.id === card(a)).lines.join('\n');
  for (const want of ['"Fix the cart total" (fix-the-cart-total)', 'the project shop, its own folder', 'provider: Main (sub)', 'model: opus; effort: medium', `Brief: ${start.brief}`]) assert.ok(shown.includes(want), `the card shows ${want}:\n${shown}`);
  const yes = await Promise.all([card(a), card(b)].map((id) => owner('POST', `/api/assistant/cards/${id}/confirm`, {})));
  assert.equal(runFiles().length, 1, 'one run');
  const said = (x) => (x.json.card && x.json.card.outcome ? x.json.card.outcome.summary : '');
  assert.ok(yes.some((x) => x.json.ok && /^Started work on the task fix-the-cart-total/.test(said(x))), JSON.stringify(yes.map((x) => x.json)));
  // The other yes started nothing: stale (the task was at work already) or the same run, followed once.
  assert.ok(yes.some((x) => !x.json.ok || /^Nothing new was started/.test(said(x))), JSON.stringify(yes.map((x) => x.json)));
  assert.equal((await owner('GET', '/api/assistant/jobs')).json.jobs.filter((j) => j.work).length, 1, 'one job follows the run');
  const run = JSON.parse(fs.readFileSync(path.join(runsDir, runFiles()[0]), 'utf8'));
  assert.equal(run.brief, start.brief, 'the brief the card showed');
  assert.deepEqual([run.project, run.folder, run.provider, run.model, run.effort], ['shop', '.', 'sub', 'opus', 'medium']);

  // The stand-in coding tool answers and ends its turn: the run settles, the task waits for review, and the job wakes
  // her (the stand-in engine) to read the run and report in two lines. Nobody accepted it.
  const settled = await until('the run to end', async () => {
    const x = JSON.parse(fs.readFileSync(path.join(runsDir, runFiles()[0]), 'utf8'));
    return x.state !== 'running' ? x : null;
  });
  assert.equal(settled.state, 'done', JSON.stringify(settled));
  assert.match(settled.answer, /echo: Make the cart total use the discount code/);
  assert.equal(items()[0].status, 'review');
  const job = await until('the job to be reported', async () => {
    const j = (await owner('GET', '/api/assistant/jobs')).json.jobs.find((x) => x.work && x.work.run === run.id);
    return j && j.state === 'done' ? j : null;
  }, 40_000);
  assert.match(job.log.at(-1).text, /done: The session worked on fix-the-cart-total: done\.\nIt waits for your review/);
  assert.equal(items()[0].status, 'review', 'she reported; the result waits for the owner');

  // Rule 7 at run time: when she read progress, its lines are the answer, under her reply, made by code. Words with a
  // figure no tool gave (she worked out "0 se 40 minute baaki" herself) are hidden, and Activity notes it once.
  const turnOf = async (text) => {
    const c = (await owner('POST', '/api/assistant/chat', { text })).json.conversation;
    return until('her turn', async () => {
      const ev = (await owner('GET', `/api/assistant/chat/${c}?from=0`)).json.events;
      return ev.some((e) => e.kind === 'done') ? ev : null;
    }, 40_000);
  };
  const lines = (await call('manage_work', { action: 'progress' })).text;
  let ev = await turnOf('bhai cart fix mein aur kitna time lagega?');
  let pr = ev.find((e) => e.kind === 'progress');
  assert.ok(pr, JSON.stringify(ev));
  assert.equal(pr.replaced, true, 'her own figure was not pr as the answer');
  const words = ev.find((e) => e.kind === 'text' && /40 minute/.test(e.text));
  assert.deepEqual(pr.hides, [words.i]);
  // The first line says when it was read ("(as of 10:41)"): her turn reads it a few seconds after the test did, and a
  // minute may pass in between. So the clock is compared as a clock reading, and everything else word for word.
  const clock = (s) => s.replace(/ \(as of \d{2}:\d{2}\)/g, ' (as of a clock reading)');
  assert.match(pr.lines[0], / \(as of \d{2}:\d{2}\)$/, 'the lines say when they were read');
  assert.ok(pr.lines.length && pr.lines.every((l) => clock(lines).includes(clock(l.trim()))), 'the lines are the tool\'s own');
  const notes = (await owner('GET', '/api/assistant/audit')).json.entries.filter((e) => e.outcome === 'replaced');
  assert.equal(notes.length, 1, 'noted once in her Activity');
  ev = await turnOf('how far is the cart fix?');
  pr = ev.find((e) => e.kind === 'progress');
  assert.equal(pr.replaced, false);
  assert.deepEqual(pr.hides, [], 'words with no figure of her own stay above the lines');
  assert.equal((await owner('GET', '/api/assistant/audit')).json.entries.filter((e) => e.outcome === 'replaced').length, 1);
});
