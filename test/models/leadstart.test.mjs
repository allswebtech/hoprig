// "Lead model" at a chat's start on a gateway (a real createServer, Claude Code a stand-in that records its arguments):
// the provider's list is asked at the start when it is not known (a fresh dashboard, a chat Tia or a schedule starts,
// the first start after an update), so the start gets its helpers; where no list can be had, the timeline says that
// Lead started without helpers, and why.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, '..', 'assistant', 'fixtures', 'fake-session.mjs');

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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const until = async (what, fn, ms = 15_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** A gateway's model list; `down()` makes it answer 503 from then on. Counts the asks. */
async function gateway(t, ids) {
  let up = true;
  const asked = [];
  const srv = http.createServer((req, res) => {
    asked.push(req.url);
    if (!up) return void res.writeHead(503).end();
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => srv.close(r)));
  return { asked, url: `http://127.0.0.1:${srv.address().port}`, down: () => (up = false) };
}

test('a Lead chat on a gateway whose list is not known yet asks for it at its start and gets its helpers', { timeout: 120_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const box = sandbox('leadstart');
  const work = path.join(box.root, 'work');
  const shop = path.join(work, 'shop');
  fs.mkdirSync(shop, { recursive: true });
  const gw = await gateway(t, ['gw-haiku-1', 'gw-sonnet-1', 'gw-opus-1']);
  const dead = await gateway(t, []);
  dead.down();
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { forgetModels } = await import('../../src/models/catalog.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('gw', { label: 'Gateway', env: { ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: 'sk-gw-test-0123456789' } });
  writeProfile('down', { label: 'Down gateway', env: { ANTHROPIC_BASE_URL: dead.url, ANTHROPIC_AUTH_TOKEN: 'sk-down-test-0123456789' } });
  const argsFile = path.join(box.root, 'starts.args');
  forgetModels();
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }), idleMs: 400 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  // The server first (it ends its chats' Claude Code processes), then the folder: hooks run in the order they are added.
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const starts = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray) : []);
  const agentsOf = (a) => (a.includes('--agents') ? Object.values(JSON.parse(a[a.indexOf('--agents') + 1])).map((x) => x.model) : null);
  const notices = async (id) => (await owner('GET', `/api/chats/${id}?from=0`)).json.events.filter((e) => e.kind === 'notice').map((e) => e.text);

  // A fresh dashboard, no picker opened: the first message starts Claude Code with the gateway's own helpers.
  const open = await owner('POST', '/api/chats', { dir: shop, profile: 'gw', lead: true, text: 'hello' });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  const first = await until('the first start', () => starts()[0]);
  assert.deepEqual(agentsOf(first), ['gw-haiku-1', 'gw-sonnet-1', 'gw-opus-1']);
  assert.equal(gw.asked.length, 1, 'one ask');
  assert.ok(!(await notices(open.json.id)).some((n) => /without helpers/.test(n)));

  // The process ends after its quiet while; the lists dropped (what a restart or an update leaves): the next start
  // asks again and leads.
  await until('the process ended', async () => !(await owner('GET', `/api/chats/${open.json.id}`)).json.running);
  forgetModels();
  assert.equal((await owner('POST', `/api/chats/${open.json.id}/send`, { text: 'again' })).status, 200);
  const second = await until('the second start', () => starts()[1]);
  assert.deepEqual(agentsOf(second), ['gw-haiku-1', 'gw-sonnet-1', 'gw-opus-1']);

  // No list can be had: no helpers, and the timeline says so with the reason.
  const down = await owner('POST', '/api/chats', { dir: shop, profile: 'down', lead: true, text: 'hello' });
  assert.equal(down.status, 200, JSON.stringify(down.json));
  const third = await until('the start on the gateway that is down', () => starts()[2]);
  assert.equal(agentsOf(third), null);
  const said = await until('the notice', async () => (await notices(down.json.id)).find((n) => /Lead model started without helpers/.test(n)));
  assert.match(said, /Could not get this provider's model list.*Lead model will not split the work/, 'the reason, not "not known yet"');
  assert.ok(!said.includes(dead.url) && !said.includes('sk-down'), 'no address or key in the words');
});
