// "She answers the OKs of her Work runs" on the real dashboard: her Work run's session is the stand-in coding tool
// (test/chat/fixtures/fake-claude.mjs, no model), her turns are a stand-in engine (fixtures/fake-tia-answers.mjs).
//   switch off: the run asks to run the project's tests; she tells the owner and answers nothing: the OK is his.
//   switch on:  the same OK is hers; she allows it, the run goes on, and her Activity has the answer with what it asked.
//               Her allow-list counts no folder under a system folder (/tmp) as a project's, so the test's computer is
//               made where a project may lie (the temporary folder when it is not a system one, else /var/tmp); the
//               allow-list is not widened. A computer with no such folder (a Mac keeps them under /private) skips it.
//   switch on:  the run asks to push: her answer becomes the owner's card, and nothing is answered.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowsHerself } from '../../src/assistant/allowlist.mjs';
import { closedGateways } from '../seal.mjs';
import { tempWork } from '../work/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_TIA = path.join(HERE, 'fixtures', 'fake-tia-answers.mjs');

/** A temporary folder her allow-list counts a project inside as a project's (a folder under it, not a system folder). */
function projectBase() {
  for (const c of [os.tmpdir(), '/var/tmp']) {
    let real;
    try {
      real = fs.realpathSync(c);
      fs.accessSync(real, fs.constants.W_OK);
    } catch {
      continue;
    }
    const home = path.join(real, 'x', 'home');
    if (allowsHerself('Bash', { command: 'npm test' }, path.join(home, 'Workspace', 'projects', 'shop'), [home]).ok) return real;
  }
  return null;
}
const BASE = projectBase();

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
const until = async (what, fn, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('her Work run asks for an OK: switch off his, switch on hers for the project\'s tests, a push his card', { timeout: 300_000, skip: process.platform === 'win32' ? 'the stand-ins are POSIX' : !BASE && 'no temporary folder here lies outside a system folder' }, async (t) => {
  // The computer is made in BASE (tempWork takes the temporary folder); the children keep the runner's own one.
  const was = process.env.TMPDIR;
  process.env.TMPDIR = BASE;
  let w;
  try {
    w = tempWork('tia-answers');
  } finally {
    if (was === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = was;
  }
  assert.equal(process.env.HOPRIG_WORKSPACE_DIR, w.ws);
  const shop = path.join(w.projects, 'shop');
  w.repo(shop, { 'README.md': '# shop\n', 'package.json': '{ "name": "shop", "scripts": { "test": "node --test" } }\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({
    server: { backend: 'pty', roots: [w.home], passwordHash: await hashPassword('pw-for-tests') },
    assistant: { enabled: true, level: 'work' }, operator: { acts: true }, sessionDefaults: { permissionMode: 'default' },
    work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' },
    addons: closedGateways(),
  });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 30_000 },
    assistant: { engine: { command: { command: process.execPath, args: [FAKE_TIA] }, resolveEnv: async () => ({ ...process.env }) } },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  app.features.find((f) => f.name === 'assistant').setAddress(base);
  t.after(async () => {
    await app.close();
    w.cleanup();
  });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  // Each run in a conversation of its own: a wake of an earlier run's job holds its conversation while her turn runs.
  const call = async (tool, args, conv) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': conv } })).json;
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const runsDir = path.join(shop, 'docs', 'plans', 'runs');
  const runOf = (task) => (fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'))).find((r) => r.item === task) : null);
  const audit = async () => (await owner('GET', '/api/assistant/audit?n=500')).json.entries;
  const chatOf = async (id) => (await owner('GET', '/api/chats')).json.chats.find((c) => c.chatId === id);

  /** A task the run's session does by `brief` (the stand-in's script), started by her and confirmed by him. */
  async function startRun(task, title, brief) {
    const conv = `conv-${task}`;
    let r = await call('manage_work', { action: 'add', title, project: 'shop', by: 'ai' }, conv);
    assert.equal(r.isError, false, r.text);
    await call('manage_work', { action: 'list' }, conv);
    r = await call('manage_work', { action: 'start', task, brief, kind: 'code' }, conv);
    const card = /card (c_[0-9a-f]{12})/.exec(r.text)[1];
    assert.equal((await owner('POST', `/api/assistant/cards/${card}/confirm`, {})).json.ok, true);
    const run = await until('the run to have its chat', async () => runOf(task)?.session && runOf(task));
    const chat = await until('the run to ask for its OK', async () => {
      const c = await chatOf(run.session);
      return c && c.status === 'attention' && c.ask ? c : null;
    });
    return { run, chat };
  }

  // Switch off (the default): the OK to run the project's tests is the owner's. She is woken, tells him, answers nothing.
  const one = await startRun('run-the-cart-tests', 'Run the cart tests', 'run npm test');
  assert.equal(one.chat.ask.subject, 'npm test');
  await until('her note to the owner', async () => (await audit()).some((e) => e.tool === 'notify_owner' && e.outcome === 'done'));
  const j1 = (await owner('GET', '/api/assistant/jobs')).json.jobs.find((j) => j.work && j.work.run === one.run.id);
  assert.match(j1.log.map((l) => l.text).join('\n'), /the OK is the owner's, waiting for him/);
  assert.equal((await chatOf(one.run.session)).status, 'attention', 'the OK still waits for him');
  assert.deepEqual((await audit()).filter((e) => e.tool === 'send_to_chat'), [], 'she answered nothing');
  // He answers it himself; the run ends.
  assert.equal((await owner('POST', `/api/chats/${one.run.session}/answer`, { request: one.chat.ask.request, allow: true })).status, 200);
  await until('the first run to end', async () => runOf('run-the-cart-tests').state !== 'running');

  // He turns the switch on, on his own page.
  const set = await owner('POST', '/api/assistant/settings', { answersHers: true });
  assert.equal(set.status, 200);
  assert.equal(set.json.settings.answersHers, true);

  // Switch on: the same kind of OK in her next Work run is hers. She allows it, the run goes on to its end.
  const two = await startRun('run-the-cart-tests-again', 'Run the cart tests again', 'run npm test');
  assert.deepEqual(allowsHerself('Bash', { command: 'npm test' }, two.chat.cwd, [w.home]), { ok: true }, 'the run\'s folder is a project\'s');
  const answered = await until('her answer', async () => (await audit()).find((e) => e.tool === 'send_to_chat' && e.outcome === 'done' && e.input.session === `chat:${two.run.session}`));
  assert.equal(answered.level, 'L1');
  assert.equal(answered.input.answer, 'allow');
  assert.deepEqual([answered.result.herWork, answered.result.asked], [true, 'npm test']);
  const settled = await until('the second run to end', async () => (runOf('run-the-cart-tests-again').state !== 'running' ? runOf('run-the-cart-tests-again') : null));
  assert.equal(settled.state, 'done', JSON.stringify(settled));
  assert.match(settled.answer, /Done\./);

  // Switch on: a push in her Work run stays his card. Her answer is staged, nothing is answered.
  const three = await startRun('push-the-cart-fix', 'Push the cart fix', 'run git push origin main');
  const staged = await until('the card for her answer', async () => (await owner('GET', '/api/assistant/cards')).json.cards.find((c) => c.tool === 'send_to_chat' && c.input.session === `chat:${three.run.session}`));
  assert.match(staged.lines.join('\n'), /Why a card: /);
  assert.equal((await chatOf(three.run.session)).status, 'attention', 'the push still waits for him');
  assert.equal((await audit()).filter((e) => e.tool === 'send_to_chat' && e.outcome === 'done' && e.input.session === `chat:${three.run.session}`).length, 0);
});
