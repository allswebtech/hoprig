// "Use other providers" through a real dashboard (createServer; Claude Code a stand-in): the lead's one tool reaches
// POST /api/parts with its session's token only; two providers ticked and one not: a part reaches a ticked one, never
// the other; one billed by use waits for the owner's yes on one card; one at its limit is skipped and said; more parts than the
// computer's limit are not started at once. The providers' addresses are stand-ins that fail the
// test when asked: nothing here may call a provider.
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

/** A provider's address that fails the test when anything asks it. */
async function tripwire(t, port) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    asked.push(req.url);
    res.writeHead(500).end();
  });
  await new Promise((r, j) => srv.once('error', j).listen(port, '127.0.0.1', r)).catch(() => new Promise((r) => srv.listen(0, '127.0.0.1', r)));
  t.after(() => new Promise((r) => srv.close(r)));
  return { asked, url: `http://127.0.0.1:${srv.address().port}` };
}

test('a part reaches only a ticked provider, through the one door, checked by the server', { timeout: 120_000, skip: SHELL_STANDINS.skip }, async (t) => {
  const box = sandbox('partdoor');
  const work = path.join(box.root, 'work');
  const shop = path.join(work, 'shop');
  fs.mkdirSync(shop, { recursive: true });
  const wires = await Promise.all([8246, 8247, 8248, 8249].map((p) => tripwire(t, p)));
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { markLimited } = await import('../../src/autoswitch.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, automation: { schedules: { atOnce: 1 } } });
  writeProfile('sub', { label: 'Main', env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test-abcdefghij' } });
  const keys = { alpha: 'sk-alpha-test-0123456789', beta: 'sk-beta-test-0123456789', gamma: 'sk-gamma-test-0123456789' };
  writeProfile('alpha', { label: 'Alpha', env: { ANTHROPIC_BASE_URL: wires[0].url, ANTHROPIC_AUTH_TOKEN: keys.alpha } });
  writeProfile('beta', { label: 'Beta', env: { ANTHROPIC_BASE_URL: wires[1].url, ANTHROPIC_AUTH_TOKEN: keys.beta } });
  writeProfile('gamma', { label: 'Gamma', env: { ANTHROPIC_BASE_URL: wires[2].url, ANTHROPIC_AUTH_TOKEN: keys.gamma } });
  // Billed by use: a key straight to the provider (src/profiles.mjs isPayPerUse); never asked here either.
  writeProfile('paid', { label: 'Paid key', env: { ANTHROPIC_API_KEY: 'sk-ant-api-test-abcdefghij' } });
  const argsFile = path.join(box.root, 'starts.args');
  const app = createServer({
    watchTickMs: 300, dashboardFile: false,
    // A part's model is looked up in the catalog (a stand-in: the providers here are never asked); the lead's "result"
    // waits a short while here for the owner's answer to a card.
    parts: { models: async () => null, askWaitMs: 300 },
    chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async (name) => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile, HOPRIG_TEST_PROVIDER: name }), idleMs: 30_000 },
  });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  // The after hooks run in the order they are added: the dashboard ends first, then its home is removed.
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  app.features.find((f) => f.name === 'parts').setAddress(base);
  const cookie = await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => {
      res.resume();
      resolve(res.headers['set-cookie'][0].split(';')[0]);
    });
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  });
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });

  // The lead: Lead on, alpha, beta and paid ticked; gamma not.
  const open = await owner('POST', '/api/chats', { dir: shop, profile: 'sub', lead: true, others: ['alpha', 'beta', 'paid'], permissionMode: 'manual', text: 'hello' });
  assert.equal(open.status, 200, JSON.stringify(open.json));
  const leadId = open.json.id;
  const tokenFile = path.join(box.state, 'part-servers', `${leadId}.token`);
  await until('the lead started with its tool', () => fs.existsSync(tokenFile));
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (process.platform !== 'win32') assert.equal((fs.statSync(tokenFile).mode & 0o777).toString(8), '600');
  const start = (await until('the start recorded', () => fs.existsSync(argsFile) && fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter(Array.isArray)[0]));
  assert.ok(start.includes('--agents') && start.includes('--mcp-config'), 'the helpers and the one tool');
  const said = start[start.indexOf('--append-system-prompt') + 1];
  assert.match(said, /alpha, beta, paid/);
  const given = JSON.stringify(start) + said;
  for (const bit of [...Object.values(keys), 'sk-ant', token, ...wires.map((w) => w.url)]) assert.ok(!given.includes(bit), `nothing secret or an address in what the model is given: ${bit.slice(0, 12)}`);
  const cfgFile = start[start.indexOf('--mcp-config') + 1];
  assert.ok(!fs.readFileSync(cfgFile, 'utf8').includes(token), 'the token is in its own file, not in the config');

  const part = (body, tk = token) => request(base, 'POST', '/api/parts', { body, headers: { Authorization: `Bearer ${tk}` } });
  // The door: only its own token, only this route.
  assert.equal((await part({ action: 'start', provider: 'alpha', brief: 'x' }, `hpt_${'0'.repeat(48)}`)).status, 401);
  assert.equal((await request(base, 'GET', '/api/chats', { headers: { Authorization: `Bearer ${token}` } })).status, 403, 'a part token reaches nothing else');

  // A body that is not JSON: refused, and the dashboard still answers the next call.
  const raw = await new Promise((resolve, reject) => {
    const req = http.request(new URL('/api/parts', base), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end('{not json');
  });
  assert.equal(raw, 400);
  assert.match((await part({ action: 'result', part: 'p_nothere' })).json.text, /no such part/, 'still answers');

  // Not ticked: refused, nothing opened.
  const before = (await owner('GET', '/api/chats')).json.chats.length;
  const g = (await part({ action: 'start', provider: 'gamma', brief: 'look around' })).json;
  assert.equal(g.isError, true);
  assert.match(g.text, /not one of the providers ticked/);
  // Billed by use, not allowed by the owner for work that goes on by itself: ONE card in the lead's chat, nothing starts
  // before his yes. Also with Auto mode off and a paid key in its old order (pay-per-use inferred, never chosen).
  // The lead's first turn ("hello") has ended before the cards below: a turn that ends closes every card still open
  // (partdoor.mjs closeAsked), and on a slow computer it ended inside the late card's wait, which then read "The lead
  // went on without it" instead of "did this part itself".
  await until('the lead\'s first turn ended', async () => (await owner('GET', '/api/chats')).json.chats.find((c) => c.chatId === leadId)?.status === 'waiting');
  saveConfig({ autoSwitch: { enabled: false, order: ['sub', 'paid'] } });
  const pd = (await part({ action: 'start', provider: 'paid', kind: 'runner', brief: 'look around' })).json;
  assert.match(pd.text, /Waiting for the owner's OK: Paid key is billed by use/);
  const askId = /Part (p_[0-9a-f]+) starts there/.exec(pd.text)[1];
  // No answer in time: the lead is told to do it itself, and in that same step the card is closed for good. A Yes
  // pressed afterwards starts nothing and says that the lead did it (the same work twice, money he did not mean).
  const late = (await part({ action: 'start', provider: 'paid', kind: 'runner', brief: 'look once' })).json;
  const lateId = /Part (p_[0-9a-f]+) starts there/.exec(late.text)[1];
  const told = (await part({ action: 'result', part: lateId })).json.text;
  const pressed = await owner('POST', `/api/parts/${lateId}/answer`, { allow: true });
  assert.ok(!(await owner('GET', '/api/chats')).json.chats.some((c) => c.profile && c.profile.name === 'paid'), 'a late Yes starts nothing on the provider billed by use');
  assert.equal(pressed.status, 409, JSON.stringify(pressed.json));
  assert.match(pressed.json.error, /the lead did this part itself\. Nothing was started/);
  assert.match(told, /did not answer in time, so his card is closed: do the part yourself/);
  // His no while the lead waits for it: the lead's call returns at once with it, and nothing starts.
  const waitingFor = part({ action: 'result', part: askId });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await owner('POST', `/api/parts/${askId}/answer`, { allow: false })).json.started, false);
  assert.match((await waitingFor).json.text, /owner said no/);
  assert.equal((await owner('POST', `/api/parts/${askId}/answer`, { allow: true })).status, 409, 'answered once only');
  // A second card, asked while the computer's one slot is still free (answered below, once it is taken).
  const pd2 = (await part({ action: 'start', provider: 'paid', brief: 'look again' })).json;
  const ask2 = /Part (p_[0-9a-f]+) starts there/.exec(pd2.text)[1];
  // A part token cannot answer its own card.
  assert.equal((await request(base, 'POST', `/api/parts/${askId}/answer`, { body: { allow: true }, headers: { Authorization: `Bearer ${token}` } })).status, 403);
  // At its limit: skipped and said.
  markLimited('beta', { until: Date.now() + 3_600_000 });
  assert.match((await part({ action: 'start', provider: 'beta', brief: 'look around' })).json.text, /at its limit.*skipped/);
  assert.equal((await owner('GET', '/api/chats')).json.chats.length, before, 'none of them opened a session');

  // Ticked: a session of its own on alpha, without Lead; it waits for an OK (so it stays busy).
  const a = (await part({ action: 'start', provider: 'alpha', brief: 'write notes.txt' })).json;
  assert.ok(!a.isError, a.text);
  const pid = /Started part (p_[0-9a-f]+)/.exec(a.text)[1];
  const chats = (await owner('GET', '/api/chats')).json.chats;
  const onAlpha = chats.filter((c) => c.profile && c.profile.name === 'alpha');
  assert.equal(onAlpha.length, 1, 'one session on the ticked provider');
  assert.ok(!chats.some((c) => c.profile && c.profile.name === 'gamma'), 'never on the one not ticked');
  // The computer's limit (one at once): a second part waits.
  assert.match((await part({ action: 'start', provider: 'alpha', brief: 'another part' })).json.text, /at most 1 at once/);
  // With the slot taken, a part billed by use is refused outright: no card for what cannot start anyway.
  assert.match((await part({ action: 'start', provider: 'paid', brief: 'look once more' })).json.text, /at most 1 at once/);
  // His yes covers the billing only. Pressed while no call of the lead waits, it is kept and starts nothing; when the
  // lead's "result" takes it, every other check is made again: with the computer's one slot taken, it still does not start.
  const yes = (await owner('POST', `/api/parts/${ask2}/answer`, { allow: true })).json;
  assert.deepEqual([yes.started, yes.kept], [false, true], JSON.stringify(yes));
  const taken = (await part({ action: 'result', part: ask2 })).json.text;
  assert.match(taken, /could not start \(.*at most 1 at once/, taken);
  assert.ok(!(await owner('GET', '/api/chats')).json.chats.some((c) => c.profile && c.profile.name === 'paid'), 'nothing on the provider billed by use');
  const r = (await part({ action: 'result', part: pid })).json;
  assert.match(r.text, /working/);
  assert.match(r.text, /<untrusted_data/, 'a part\'s result comes back fenced, as data');
  assert.match((await part({ action: 'result', part: 'p_nothere' })).json.text, /no such part/);
  // Who did what: the part handed to alpha is named with its provider, read from that session's own records.
  const who = (await owner('GET', `/api/chats/${leadId}/parts`)).json;
  assert.deepEqual(who.others.map((x) => x.provider), ['alpha'], JSON.stringify(who));
  const { partRows } = await import('../../web/chat/parts.js');
  assert.ok(partRows(who).some(([k]) => k === 'On alpha'), 'the page draws a row for it');
  // What the owner reads in the lead's chat: one line for each.
  const ev = (await owner('GET', `/api/chats/${leadId}?from=0`)).json;
  const lines = JSON.stringify(ev);
  assert.match(lines, /"kind":"part-ask"/, 'the card is in the lead\'s chat');
  assert.match(lines, /"partKind":"running and recording"/, 'it names the part\'s kind');
  assert.match(lines, /"outcome":"no"/);
  assert.match(lines, /"outcome":"lead"/, 'the card says the lead did it, in the chat');
  assert.doesNotMatch(lines, /It was not started: turn Auto mode on/, 'never a line that only reports it afterwards');
  assert.match(lines, /skipped: that provider is at its limit/);
  assert.match(lines, /A part went to Alpha/);
  for (const w of wires) assert.deepEqual(w.asked, [], 'no provider was asked');
});
