// The coding tool of a chat, on the server where a chat starts, moves, resumes and is scheduled (the real dashboard,
// createServer, with a stand-in of OpenCode's server): a tool that is off or not installed is refused, a provider must
// serve the chat's tool (a Claude subscription never reaches OpenCode), a folder remembers its last tool, a
// schedule starts a chat in its tool and a terminal schedule checks its provider again when it runs; the page's
// words for another tool; `hoprig chat --tool`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { SESSION_ID, standIn, standInOpts } from './fixtures/opencode-standin.mjs';

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

test('a chat of OpenCode: refused while off or missing; only a provider that serves it; the folder keeps its tool; schedules', { timeout: 60_000, skip: process.platform === 'win32' && 'POSIX paths' }, async (t) => {
  const box = sandbox('chattools');
  const proj = path.join(box.root, 'work', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const s = await standIn();
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { toolsDir } = await import('../../src/paths.mjs');
  saveConfig({ server: { backend: 'pty', roots: [path.dirname(proj)], passwordHash: await hashPassword('pw-for-tests') } });
  writeProfile('sub', { label: 'Main' }); // a Claude subscription: Claude Code only
  writeProfile('gw', { label: 'Gateway', api: ['messages', 'models'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'gw-token-of-the-test' } });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, toolSessions: async () => [{ id: SESSION_ID, at: 1, title: 'Recorded session' }], chat: { resolveEnv: async () => ({}), engineOpts: standInOpts(s), idleMs: 30_000 } });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.close();
    await s.close();
    box.cleanup();
  });
  const cookie = (await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, (res) => resolve(res.headers['set-cookie'][0].split(';')[0]));
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  }));
  const owner = (method, p, body) => request(base, method, p, { body, headers: { Cookie: cookie } });

  // Off: only Claude Code, and a chat of OpenCode is refused in words that name only what is offered.
  assert.deepEqual((await owner('GET', '/api/chats/tools')).json.tools.map((x) => x.id), ['claude']);
  let r = await owner('POST', '/api/chats', { dir: proj, tool: 'opencode', profile: 'gw' });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'a chat runs one of these coding tools: Claude Code');
  // On but not installed.
  saveConfig({ codingTools: ['claude', 'opencode'] });
  r = await owner('POST', '/api/chats', { dir: proj, tool: 'opencode', profile: 'gw' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /OpenCode is not installed/);
  assert.deepEqual((await owner('GET', '/api/chats/tools')).json.tools.map((x) => x.id), ['claude'], 'not offered while missing');
  const bin = path.join(toolsDir(), 'opencode', 'node_modules', '.bin', 'opencode');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const tools = (await owner('GET', '/api/chats/tools')).json.tools;
  assert.deepEqual(tools.map((x) => x.id), ['claude', 'opencode']);
  assert.deepEqual(tools[1].modes, ['manual', 'acceptEdits', 'bypassPermissions']);
  assert.ok(!JSON.stringify(tools).includes('Codex'));

  // A Claude subscription never reaches OpenCode: where a chat starts, and where it moves.
  r = await owner('POST', '/api/chats', { dir: proj, tool: 'opencode', profile: 'sub' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /"Main" cannot be used for OpenCode: a Claude subscription is for Claude Code only/);
  r = await owner('POST', '/api/chats', { dir: proj, tool: 'opencode' });
  assert.equal(r.status, 200, 'nothing chosen: the first provider that serves OpenCode');
  const id = r.json.id;
  let v = (await owner('GET', `/api/chats/${id}`)).json;
  assert.equal(v.engine.id, 'opencode');
  assert.equal(v.profile.name, 'gw');
  assert.deepEqual(v.choices.modes, ['manual', 'acceptEdits', 'bypassPermissions']);
  assert.equal(v.engine.capabilities.compact, false);
  r = await owner('POST', `/api/chats/${id}/provider`, { profile: 'sub' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cannot be used for OpenCode/);
  r = await owner('POST', `/api/chats/${id}/mode`, { mode: 'plan' });
  assert.equal(r.status, 400, 'Claude Code\'s plan mode is not OpenCode\'s');
  assert.equal((await owner('POST', `/api/chats/${id}/mode`, { mode: 'acceptEdits' })).status, 200);

  // A message on the stand-in: the card names its tool; the conversation is OpenCode's own id.
  assert.equal((await owner('POST', `/api/chats/${id}/send`, { text: 'Reply with exactly three short words, nothing else.' })).status, 200);
  for (let i = 0; i < 100; i++) {
    v = (await owner('GET', `/api/chats/${id}`)).json;
    if (v.events.some((e) => e.kind === 'turn-end')) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const card = (await owner('GET', '/api/chats')).json.chats.find((c) => c.chatId === id);
  assert.equal(card.tool, 'opencode');
  assert.equal(card.sessionId, SESSION_ID);
  const hist = (await owner('GET', `/api/chats/${id}/history`)).json;
  assert.equal(hist.tool, 'opencode');
  assert.deepEqual(hist.conversations.map((c) => [c.id, c.current]), [[SESSION_ID, true]]);
  // One place at a time: the conversation the chat runs is not started in a terminal too (resumed, or the folder's
  // newest continued), so a terminal never changes the rules the chat keeps on it.
  for (const how of [{ mode: 'resume', sessionId: SESSION_ID }, { mode: 'continue' }]) {
    r = await owner('POST', '/api/sessions', { tool: 'opencode', dir: proj, profile: 'gw', permissionMode: 'bypassPermissions', ...how });
    assert.equal(r.status, 409, how.mode);
    assert.match(r.json.error, /open as a chat right now/);
  }

  // The folder keeps its tool: a chat opened there without a choice is OpenCode's, as the last one.
  assert.equal((await owner('POST', `/api/chats/${id}/close`, {})).status, 200);
  r = await owner('POST', '/api/chats', { dir: proj });
  assert.equal(r.status, 200);
  assert.equal((await owner('GET', `/api/chats/${r.json.id}`)).json.engine.id, 'opencode');
  assert.equal((await owner('GET', `/api/chats/${r.json.id}`)).json.permissionMode, 'acceptEdits', 'with its mode');
  assert.equal((await owner('POST', `/api/chats/${r.json.id}/close`, {})).status, 200);
  // Continued from OpenCode's store: the conversation is read back, in its tool.
  r = await owner('POST', '/api/chats', { dir: proj, tool: 'opencode', sessionId: SESSION_ID });
  assert.equal(r.status, 200);
  for (let i = 0; i < 100; i++) {
    v = (await owner('GET', `/api/chats/${r.json.id}`)).json; // read through the server: it comes a moment later
    if (v.events.length) break;
    await new Promise((res) => setTimeout(res, 30));
  }
  assert.ok(v.events.some((e) => e.kind === 'user'), 'read back');
  assert.equal((await owner('POST', '/api/chats', { dir: proj, tool: 'opencode', sessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d' })).status, 400, 'a Claude Code id is no OpenCode conversation');
  assert.equal((await owner('POST', `/api/chats/${r.json.id}/close`, {})).status, 200);

  // Tia and the schedules take Settings, not the folder's last tool (the folder's last chat was OpenCode's).
  r = await owner('POST', '/api/chats', { dir: proj, defaults: true });
  assert.equal((await owner('GET', `/api/chats/${r.json.id}`)).json.engine.id, 'claude');
  assert.equal((await owner('POST', `/api/chats/${r.json.id}/close`, {})).status, 200);
  // On but its program gone (uninstalled, a failed update): the folder's last tool is not used, Claude Code is.
  fs.renameSync(bin, `${bin}.away`);
  r = await owner('POST', '/api/chats', { dir: proj });
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.equal((await owner('GET', `/api/chats/${r.json.id}`)).json.engine.id, 'claude');
  assert.equal((await owner('POST', `/api/chats/${r.json.id}/close`, {})).status, 200);
  fs.renameSync(`${bin}.away`, bin);

  // Turned off while one of its chats is open: that chat runs nothing and lists nothing until it is on again.
  r = await owner('POST', '/api/chats', { dir: proj, tool: 'opencode', sessionId: SESSION_ID });
  const open = r.json.id;
  saveConfig({ codingTools: ['claude'] });
  r = await owner('POST', `/api/chats/${open}/send`, { text: 'hello' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /OpenCode is off on this computer/);
  assert.equal((await owner('GET', `/api/chats/${open}/history`)).status, 409);
  const prompts = s.calls.filter((x) => x.path.endsWith('/prompt')).length;
  saveConfig({ codingTools: ['claude', 'opencode'] });
  assert.equal((await owner('GET', `/api/chats/${open}/history`)).status, 200);
  assert.equal(s.calls.filter((x) => x.path.endsWith('/prompt')).length, prompts, 'nothing was sent while it was off');
  assert.equal((await owner('POST', `/api/chats/${open}/close`, {})).status, 200);

  // A Claude Code conversation older than the newest 50 of the folder still opens as a chat (Tia's ids, a link).
  const { projectDir } = await import('../../src/sessions.mjs');
  fs.mkdirSync(projectDir(proj), { recursive: true });
  const ids = Array.from({ length: 52 }, (_, i) => `0a1b2c3d-4e5f-4a6b-8c7d-${String(i).padStart(12, '0')}`);
  for (const [i, sid] of ids.entries()) {
    const f = path.join(projectDir(proj), `${sid}.jsonl`);
    fs.writeFileSync(f, `${JSON.stringify({ type: 'user', message: { role: 'user', content: `message ${i}` }, sessionId: sid, cwd: proj })}\n`);
    fs.utimesSync(f, new Date(1e12 + i * 1000), new Date(1e12 + i * 1000));
  }
  r = await owner('POST', '/api/chats', { dir: proj, tool: 'claude', sessionId: ids[0] });
  assert.equal(r.status, 200, r.json && r.json.error);
  assert.equal((await owner('POST', `/api/chats/${r.json.id}/close`, {})).status, 200);

  // Schedules: a chat in OpenCode on a provider that serves it; never a terminal of another tool, never a subscription.
  const schedule = (action) => ({ op: 'add', schedule: { when: { kind: 'daily', time: '07:00' }, action: { type: 'start', in: 'chat', dir: proj, ...action } } });
  const added = await owner('POST', '/api/automation/schedules', schedule({ tool: 'opencode', profile: 'gw' }));
  assert.equal(added.status, 200);
  assert.equal(added.json.schedules.filter((x) => x.action.tool === 'opencode' && x.action.in === 'chat').length, 1);
  r = await owner('POST', '/api/automation/schedules', schedule({ tool: 'opencode', profile: 'sub' }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cannot be used for OpenCode/);
  r = await owner('POST', '/api/automation/schedules', schedule({ tool: 'opencode', profile: 'gw', in: 'terminal' }));
  assert.equal(r.status, 400);
  assert.match(r.json.error, /another coding tool only in a chat/);
});

test('a schedule that starts a terminal checks its provider again when it runs, as a chat schedule does', { skip: process.platform === 'win32' && 'POSIX paths' }, async (t) => {
  const box = sandbox('schedrun');
  t.after(() => box.cleanup());
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { serverAdapter } = await import('../../src/automation/feature.mjs');
  writeProfile('oai', { label: 'OpenAI key', env: { OPENAI_API_KEY: 'sk-openai-secret-of-the-test' } });
  writeProfile('sub', { label: 'Main' });
  const created = [];
  const sctx = {
    config: () => ({ server: { roots: [box.root] } }), state: async () => ({ sessions: [] }),
    deck: { launcher: () => ['hoprig'] }, backend: { list: async () => [], create: async (o) => (created.push(o), { name: o.name }) },
  };
  const a = serverAdapter(sctx, { log: () => {} });
  // Saved while it served Claude Code; now it does not (here: a provider that never did, as after a change).
  await assert.rejects(a.deck.start({ dir: box.root, profile: 'oai' }), /"OpenAI key" cannot be used for Claude Code/);
  await assert.rejects(a.deck.start({ dir: box.root, profile: 'auto' }), /Auto mode is off/);
  assert.equal(created.length, 0, 'nothing started');
  assert.ok(await a.deck.start({ dir: box.root, profile: 'sub' }));
  assert.equal(created.length, 1);
  // When saved: the chat's tool decides which providers fit.
  assert.throws(() => a.checks.profileOk('sub', 'opencode'), /cannot be used for OpenCode/);
  assert.equal(a.checks.profileOk('auto', 'opencode'), false);
});

test('OpenCode\'s conversations of one folder only, though its server lists every folder\'s', async () => {
  const { opencodeSessions } = await import('../../src/codetools/stores.mjs');
  const s = await standIn();
  try {
    const ensure = async () => ({ ok: true, server: s.server });
    assert.deepEqual((await opencodeSessions('/work/proj', { ensure })).map((x) => x.id), [SESSION_ID]);
    assert.deepEqual(await opencodeSessions('/work/other', { ensure }), []);
    const asked = s.calls.find((x) => x.path === '/api/session' && x.method === 'GET');
    assert.equal(new URLSearchParams(asked.query).get('directory'), '/work/proj', 'by the filter the server knows');
  } finally {
    await s.close();
  }
});

test('hoprig chat --tool: the address opens a chat in that coding tool', async () => {
  const { chatAddress, main } = await import('../../src/chat/cli.mjs');
  assert.equal(chatAddress('http://h:1', '/x', 'opencode'), 'http://h:1/#/new?dir=%2Fx&tool=opencode');
  const out = [];
  const opened = [];
  const run = (args) => main(args, { cwd: process.cwd(), running: () => ({ pid: 1, host: '127.0.0.1', port: 7433 }), base: () => 'https://dash.example', local: () => 'http://127.0.0.1:7433', open: (u) => opened.push(u) || true, atHand: () => true, log: (x) => out.push(x), err: (x) => out.push(`ERR ${x}`) });
  assert.equal(await run(['--tool', 'opencode']), 0);
  assert.match(opened[0], /&tool=opencode$/);
  assert.equal(await run(['--tool=claude', '--no-open']), 0);
  assert.doesNotMatch(out.join('\n'), /tool=claude/, 'Claude Code is the default: no word for it');
  assert.equal(await run(['--tool']), 2);
  assert.equal(await run(['--tool', 'Bad Tool']), 2);
});

test('the chat page in another tool\'s words: its name, its modes, its OK cards and patterns', async () => {
  globalThis.document ||= { createElement: () => ({}), addEventListener: () => {} };
  const W = await import('../../web/chat/words.js');
  const v = { engine: { id: 'opencode', label: 'OpenCode', capabilities: { compact: false, ultracode: true } }, choices: { modeWords: { manual: { chip: 'Ask first', sub: 'Asks before it changes a file' } } } };
  assert.equal(W.toolWord(v), 'OpenCode');
  assert.equal(W.toolWord({ engine: { id: 'claude', label: 'Claude Code' } }), 'Claude');
  assert.equal(W.toolWord(null), 'Claude');
  assert.equal(W.modeInfo(v, 'manual').sub, 'Asks before it changes a file');
  assert.equal(W.modeInfo({}, 'manual').chip, 'Ask first', 'Claude Code\'s words otherwise');
  assert.equal(W.caps(v).compact, false);
  // Compact: offered unless the tool says it has none (an older dashboard's Claude Code says nothing, and has it).
  assert.equal(W.canCompact(v), false);
  assert.equal(W.canCompact({ engine: { id: 'claude', capabilities: { compact: true } } }), true);
  assert.equal(W.canCompact({ engine: { id: 'claude', capabilities: { liveMode: true } } }), true, 'a peer on the version before');
  assert.equal(W.askTitle('Bash', { command: 'ls' }, 'OpenCode'), 'OpenCode wants to run a command');
  assert.equal(W.askTitle('Write', { file_path: '/a/b.txt' }), 'Claude wants to write b.txt');
  assert.equal(W.alwaysWords({ tool: 'Bash', input: { command: 'sleep 1 && echo x' }, alwaysText: 'sleep *, echo *' }, 'OpenCode'), '“Allow in this chat” also lets OpenCode do what matches this again in this chat without asking: sleep *, echo *.');
  const St = await import('../../web/chat/statusline.js');
  assert.equal(St.stateWords({ ...v, status: 'attention', asking: 'question' }), 'OpenCode asks you a question');
  assert.equal(St.stateWords({ ...v, status: 'working', turn: true, activity: 'requesting', live: [] }), 'OpenCode is thinking…');
  const { askNote } = await import('../../src/chat/events.mjs');
  assert.equal(askNote({ type: 'permission', tool: 'Bash', subject: 'ls -la .' }, '/w', 'OpenCode'), 'OpenCode wants to run: ls -la .');
});

test('the engine itself refuses a provider that does not serve its coding tool, also where a chat resumes or moves', async (t) => {
  const box = sandbox('servedprov');
  t.after(() => box.cleanup());
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { providerFor } = await import('../../src/chat/engines/served.mjs');
  writeProfile('sub', { label: 'Main' });
  writeProfile('gw', { label: 'Gateway', api: ['messages'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'gw-token-of-the-test' } });
  assert.throws(() => providerFor('sub', 'opencode'), (e) => e.status === 400 && /a Claude subscription is for Claude Code only/.test(e.message));
  assert.throws(() => providerFor('auto', 'opencode'), /Auto mode is for Claude Code only/);
  assert.equal(providerFor('gw', 'opencode').name, 'gw');
});
