// "Use other providers": a Yes on a part's card never starts the part by itself. Pressed while no "result" call of the
// lead waits, it is kept and starts nothing; the part starts when the lead's "result" is there to take it, once. The
// card closes for good when the lead's turn ends; a press after that starts nothing. Through a real dashboard
// (createServer; Claude Code a stand-in), on a provider billed by use that is never asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';
import { SHELL_STANDINS } from '../seal.mjs';

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
        resolve({ status: res.statusCode, json, headers: res.headers });
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

async function world(t) {
  const box = sandbox('partyes');
  const work = path.join(box.root, 'work');
  const shop = path.join(work, 'shop');
  fs.mkdirSync(shop, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, automation: { schedules: { atOnce: 4 } } });
  writeProfile('sub', { label: 'Main', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  // Billed by use: a key straight to the vendor (profiles.mjs isPayPerUse); never asked here (a stand-in model lookup).
  writeProfile('paid', { label: 'Paid key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } });
  const app = createServer({
    watchTickMs: 300, dashboardFile: false, parts: { models: async () => null, askWaitMs: 1500 },
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 30_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  // The after hooks run in the order they are added: the dashboard ends first, then its home is removed.
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  app.features.find((f) => f.name === 'parts').setAddress(base);
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });
  const open = await owner('POST', '/api/chats', { dir: shop, profile: 'sub', lead: true, others: ['paid'], permissionMode: 'manual', text: 'hello' });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  const lead = open.json.id;
  const tokenFile = path.join(box.state, 'part-servers', `${lead}.token`);
  await until('the lead started with its tool', () => fs.existsSync(tokenFile));
  // The lead's first turn ("hello") is over before any card is asked.
  await until('the first turn ended', async () => (await owner('GET', '/api/chats')).json.chats.find((c) => c.chatId === lead)?.status !== 'working');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const part = (body) => request(base, 'POST', '/api/parts', { body, headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json);
  const ask = async (brief) => /Part (p_[0-9a-f]+) starts there/.exec((await part({ action: 'start', provider: 'paid', kind: 'runner', brief })).text)[1];
  const yes = (id) => owner('POST', `/api/parts/${id}/answer`, { allow: true });
  const onPaid = async () => (await owner('GET', '/api/chats')).json.chats.filter((c) => c.profile && c.profile.name === 'paid').length;
  const events = async () => JSON.stringify((await owner('GET', `/api/chats/${lead}?from=0`)).json);
  return { owner, part, ask, yes, onPaid, events, lead };
}

test('a Yes while no call of the lead waits is kept and starts nothing; the lead\'s result then starts the part once', { timeout: 60_000, skip: SHELL_STANDINS.skip }, async (t) => {
  const w = await world(t);
  const id = await w.ask('list the TODOs');
  const pressed = await w.yes(id);
  assert.equal(pressed.status, 200);
  assert.deepEqual([pressed.json.started, pressed.json.kept], [false, true], JSON.stringify(pressed.json));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await w.onPaid(), 0, 'a Yes alone starts nothing');
  assert.match(await w.events(), /"kind":"part-ask-kept"/, 'the card says the yes is kept');
  assert.equal((await w.yes(id)).status, 409, 'a second press is not a second yes');
  // The lead asks: the kept yes starts the part now, once.
  const got = await w.part({ action: 'result', part: id });
  assert.match(got.text, /working/, got.text);
  assert.equal(await w.onPaid(), 1, 'the kept yes started the part once');
  await w.part({ action: 'result', part: id });
  assert.equal(await w.onPaid(), 1, 'asking again starts nothing more');
});

test('the lead\'s turn ends with the card open: it closes for good, and a Yes after that starts nothing', { timeout: 60_000, skip: SHELL_STANDINS.skip }, async (t) => {
  const w = await world(t);
  const open = await w.ask('count the lines');
  const kept = await w.ask('list the files');
  assert.equal((await w.yes(kept)).json.kept, true);
  // The lead goes on: its next turn ends without asking for either part.
  assert.equal((await w.owner('POST', `/api/chats/${w.lead}/send`, { text: 'go on' })).status, 200);
  await until('both cards closed', async () => ((await w.events()).match(/"outcome":"gone"/g) || []).length === 2);
  const late = await w.yes(open);
  assert.equal(late.status, 409);
  assert.match(late.json.error, /The lead went on without it\. Nothing was started/);
  assert.match((await w.part({ action: 'result', part: kept })).text, /turn ended before it started.*nothing was started/);
  assert.equal(await w.onPaid(), 0, 'neither the late Yes nor the kept one started anything');
});

test('two presses or two calls at the same moment start one part at most', { timeout: 60_000, skip: SHELL_STANDINS.skip }, async (t) => {
  const w = await world(t);
  // Two presses at once while the lead waits for the answer.
  const a = await w.ask('first part');
  const waits = w.part({ action: 'result', part: a });
  await new Promise((r) => setTimeout(r, 100));
  const [p1, p2] = await Promise.all([w.yes(a), w.yes(a)]);
  assert.deepEqual([p1.status, p2.status].sort(), [200, 409], `${JSON.stringify(p1.json)} ${JSON.stringify(p2.json)}`);
  assert.match((await waits).text, /working/);
  assert.equal(await w.onPaid(), 1, 'one start');
  // A kept yes, and two calls of the lead at once that take it.
  const b = await w.ask('second part');
  assert.equal((await w.yes(b)).json.kept, true);
  const [r1, r2] = await Promise.all([w.part({ action: 'result', part: b }), w.part({ action: 'result', part: b })]);
  assert.match(r1.text, /working/);
  assert.match(r2.text, /working/);
  assert.equal(await w.onPaid(), 2, 'one start for the second part too');
});
