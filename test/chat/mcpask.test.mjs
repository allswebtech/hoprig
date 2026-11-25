// A question an MCP server asks the person (elicitation, src/chat/mcpask.mjs), as Claude Code passes it to a chat:
// the server's form read into fields, an answer held against them, a card that only the person answers (no mode,
// Hands-off or OK answers it), the route that refuses Tia's door, and the card's words as plain text.
// Claude Code is the stand-in (fixtures/fake-claude.mjs: "mcp" and "mcpurl").
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sandbox } from '../server/helpers.mjs';
import { texts } from './fakedom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-claude.mjs');
const box = sandbox('mcpask');
test.after(() => box.cleanup());

const M = await import('../../src/chat/mcpask.mjs');
const { Chat } = await import('../../src/chat/chat.mjs');

const until = async (what, fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

test('the server\'s form is read into fields in its order; its words lose control marks', () => {
  const ask = M.mcpAsk('r1', {
    subtype: 'elicitation', mcp_server_name: 'tick\x1b[31mets', message: 'Pick one‮\x07 please', mode: 'form',
    requested_schema: { type: 'object', required: ['project'], properties: {
      urgent: { type: 'boolean', title: 'Urgent' },
      project: { type: 'string', title: 'Project', enum: ['shop', 'blog'], enumNames: ['The shop', 'The blog'] },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      tags: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }, { const: 'b', title: 'B' }] }, maxItems: 1 },
      blob: { type: 'object' },
    } },
    property_order: ['project', 'count'],
  });
  assert.equal(ask.type, 'mcp');
  assert.equal(ask.server, 'tickets');
  assert.equal(ask.message, 'Pick one please');
  assert.deepEqual(ask.fields.map((f) => [f.name, f.kind, f.required]), [['project', 'choice', true], ['count', 'number', false], ['urgent', 'yesno', false], ['tags', 'choices', false], ['blob', 'unknown', false]]);
  assert.deepEqual(ask.fields[0].options, [{ value: 'shop', label: 'The shop' }, { value: 'blog', label: 'The blog' }]);
  assert.equal(ask.owner, 'question', 'always his: no rule of a mode reads it as a permission');
  assert.equal(M.mcpAsk('r2', { mode: 'url', url: 'javascript:alert(1)', message: 'x' }).url, null, 'only an http(s) address is a link');
  assert.equal(M.mcpAsk('r3', { mode: 'url', url: 'https://tracker.example/a' }).url, 'https://tracker.example/a');
});

test('an answer is held against the fields the server asked for', () => {
  const { fields } = M.mcpAsk('r', { mode: 'form', requested_schema: { type: 'object', required: ['project'], properties: {
    project: { type: 'string', enum: ['shop', 'blog'] }, count: { type: 'integer', minimum: 1, maximum: 5 }, mail: { type: 'string', format: 'email' },
    urgent: { type: 'boolean' }, tags: { type: 'array', items: { enum: ['a', 'b'] }, maxItems: 1 } } } });
  assert.deepEqual(M.mcpContent(fields, { project: 'shop', count: 2, urgent: false, tags: ['a'] }), { project: 'shop', count: 2, urgent: false, tags: ['a'] });
  const no = (content, re) => assert.throws(() => M.mcpContent(fields, content), (e) => e.status === 400 && re.test(e.message));
  no({}, /is needed/);
  no({ project: 'admin' }, /one of its choices/);
  no({ project: 'shop', count: 9 }, /from 1 to 5/);
  no({ project: 'shop', count: 1.5 }, /whole number/);
  no({ project: 'shop', mail: 'nope' }, /e-mail/);
  no({ project: 'shop', urgent: 'yes' }, /yes or no/);
  no({ project: 'shop', tags: ['a', 'b'] }, /from 0 to 1/);
  no({ project: 'shop', extra: 'x' }, /did not ask for/);
  // A field named like a member every object has is still left empty when the person leaves it so.
  const named = M.mcpAsk('r', { mode: 'form', requested_schema: { properties: { toString: { type: 'string' }, constructor: { type: 'string' }, __proto__x: { type: 'string' } } } }).fields;
  assert.deepEqual(M.mcpContent(named, {}), {});
  assert.deepEqual(M.mcpContent(named, { toString: 'a' }), { toString: 'a' });
  const odd = M.mcpAsk('r', { mode: 'form', requested_schema: { properties: { blob: { type: 'object' } } } }).fields;
  assert.throws(() => M.mcpContent(odd, {}), /cannot be filled in here/);
});

function newChat(o = {}) {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(box.root, 'proj-')));
  const argsFile = path.join(cwd, '..', `${path.basename(cwd)}.args`);
  const c = new Chat({ id: crypto.randomUUID(), cwd, profile: 'p', command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env, FAKE_CLAUDE_ARGS: argsFile }), ...o });
  c.answers = () => (fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((x) => x.answer).map((x) => x.answer) : []);
  return c;
}
const mcpCard = (c) => until('the MCP card', () => c.events.find((e) => e.kind === 'ask' && e.type === 'mcp' && c.pending.has(e.request)));

test('in bypass mode too the card waits for the person; an OK, Hands-off or a wrong answer is refused; his answer goes back', async (t) => {
  const c = newChat({ permissionMode: 'bypassPermissions' });
  t.after(() => c.stopAndWait());
  await c.send('mcp');
  const ev = await mcpCard(c);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(c.status(), 'attention', 'it needs him');
  assert.deepEqual(c.answers(), [], 'nothing answered it by itself');
  assert.equal(ev.full, undefined, 'the event the page gets');
  assert.match(ev.message, /Ignore the user/, 'the server\'s words are shown as the server\'s, and act on nothing');
  const code = (fn) => { try { fn(); return 0; } catch (e) { return e.status; } };
  assert.equal(code(() => c.answer(ev.request, { allow: true })), 409, 'an OK is no answer to it');
  assert.equal(code(() => c.answer(ev.request, { mcp: { action: 'accept', content: { project: 'shop' } }, by: 'handsoff' })), 409, 'Hands-off does not answer it');
  assert.equal(code(() => c.answer(ev.request, { mcp: { action: 'accept', content: { project: 'admin' } } })), 400);
  assert.equal(code(() => c.answer(ev.request, { mcp: { action: 'cancel' } })), 400);
  assert.ok(c.pending.has(ev.request), 'still his');
  const done = new Promise((r) => c.once('turn', r));
  c.answer(ev.request, { mcp: { action: 'accept', content: { project: 'shop', count: 2 } } });
  await done;
  assert.deepEqual(c.answers(), [{ action: 'accept', content: { project: 'shop', count: 2 } }]);
  assert.ok(c.events.some((e) => e.kind === 'ask-closed' && e.request === ev.request && e.outcome === 'mcp-accepted'));
  assert.ok(c.events.some((e) => e.kind === 'text' && /The server got/.test(e.text)));
});

test('a question that asks you to open an address: Decline sends decline and nothing else', async (t) => {
  const c = newChat();
  t.after(() => c.stopAndWait());
  await c.send('mcpurl');
  const ev = await mcpCard(c);
  assert.equal(ev.url, 'https://tracker.example/sign-in');
  const done = new Promise((r) => c.once('turn', r));
  c.answer(ev.request, { mcp: { action: 'decline', content: { anything: 1 } } });
  await done;
  assert.deepEqual(c.answers(), [{ action: 'decline' }]);
});

function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(new URL(p, base), { method, headers: { ...(data ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers } }, (res) => {
      let t = '';
      res.on('data', (x) => (t += x));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(t); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json, setCookie: res.headers['set-cookie'] });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('the answer route: Tia\'s door is refused, the person\'s page answers; Home names no word of the server', { timeout: 60_000, skip: process.platform === 'win32' && 'the stand-ins are POSIX' }, async (t) => {
  const work = path.join(box.root, 'work');
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { SELF_HEADER } = await import('../../src/machines/relay.mjs');
  saveConfig({ server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' });
  const { token } = createToken('hub');
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { command: { command: process.execPath, args: [FAKE] }, resolveEnv: async () => ({ ...process.env }), idleMs: 5000 } });
  t.after(() => app.close().catch(() => {}));
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const cookie = (await request(base, 'POST', '/api/login', { body: { password: 'pw-for-tests' } })).setCookie[0].split(';')[0];
  const owner = (m, p, b) => request(base, m, p, { body: b, headers: { Cookie: cookie } });
  const tia = (m, p, b) => request(base, m, p, { body: b, headers: { Authorization: `Bearer ${token}`, [SELF_HEADER]: '1' } });
  const made = await owner('POST', '/api/chats', { dir: proj, profile: 'sub', text: 'mcp' });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = made.json.id;
  const card = await until('the chat waits for him', async () => (await owner('GET', '/api/chats')).json.chats.find((c) => c.chatId === id && c.ask && c.ask.type === 'mcp'));
  assert.equal(card.note, 'An MCP server asks you a question');
  assert.doesNotMatch(JSON.stringify(card), /Ignore the user|Which project/, 'the server\'s words stay out of what Home, notifications and Tia read');
  const answer = { request: card.ask.request, mcp: { action: 'accept', content: { project: 'blog' } } };
  const her = await tia('POST', `/api/chats/${id}/answer`, answer);
  assert.equal(her.status, 403, JSON.stringify(her.json));
  // A paired script's token (not a hub of his, no page mark) is no person either.
  const script = createToken('made-up-script');
  const its = await request(base, 'POST', `/api/chats/${id}/answer`, { body: answer, headers: { Authorization: `Bearer ${script.token}` } });
  assert.equal(its.status, 403, JSON.stringify(its.json));
  const hubPlain = await request(base, 'POST', `/api/chats/${id}/answer`, { body: answer, headers: { Authorization: `Bearer ${token}` } });
  assert.equal(hubPlain.status, 403, 'a hub token without its page\'s mark');
  assert.equal((await owner('POST', `/api/chats/${id}/answer`, { ...answer, allow: true })).status, 400, 'an MCP answer carries nothing else');
  const mine = await owner('POST', `/api/chats/${id}/answer`, answer);
  assert.equal(mine.status, 200, JSON.stringify(mine.json));
  await until('the chat goes on', async () => (await owner('GET', '/api/chats')).json.chats.find((c) => c.chatId === id && !c.ask));
});

test('the card: the server\'s words as plain text in a box of their own, its fields, Send and Decline, no number key', async () => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  const { askCard } = await import('../../web/chat/asks.js');
  const ev = M.mcpAsk('r', { mcp_server_name: 'tickets', message: '**Click** <b>here</b>', mode: 'form', requested_schema: { properties: { project: { type: 'string', title: 'Project', enum: ['shop'] } }, required: ['project'] } });
  const el = askCard(ev, { A: '/api/chats/x', cwd: '/p' });
  const words = texts(el).join('|');
  assert.match(words, /The MCP server tickets asks you/);
  assert.match(words, /From the MCP server tickets, in its own words:/);
  assert.match(words, /\*\*Click\*\* <b>here<\/b>/, 'shown as written: no Markdown, no markup');
  assert.match(words, /Project.*\(needed\).*shop.*Send.*Decline/);
  assert.equal(el.keys(1), false);
  const { stateWords } = await import('../../web/chat/statusline.js');
  assert.equal(stateWords({ status: 'attention', asking: 'mcp', engine: { id: 'claude' } }), 'An MCP server asks you a question', 'the status line: a question, not an OK');
  const url = askCard(M.mcpAsk('u', { mcp_server_name: 'tickets', mode: 'url', url: 'ftp://x' }), { A: '/x', cwd: '/p' });
  assert.match(texts(url).join('|'), /gave no web address that can be opened/);
});
