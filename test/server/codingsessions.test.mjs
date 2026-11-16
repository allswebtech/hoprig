// POST /api/sessions and the routes around it for Codex and OpenCode: the tool must be on and installed, the
// provider must serve it (a Claude subscription and Auto mode never do), the choices are the tool's own, resume
// lists come from the tool's store, and a move stays inside the tool. A Claude Code start is unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

const box = sandbox('codingsessions');
process.env.HOPRIG_TOOLS_DIR = path.join(box.root, 'tools');
process.env.CODEX_HOME = path.join(box.root, 'codex-home');
const work = path.join(box.root, 'work');
fs.mkdirSync(work);

const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const KEY = 'gw-key-sessions-0123456789';
saveConfig({ launcher: ['L'], server: { roots: [box.root], passwordHash: await hashPassword('right-password') } });
writeProfile('gw', { label: 'Gateway', api: ['messages', 'responses', 'chat'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: KEY } });
writeProfile('gw2', { label: 'Gateway two', api: ['messages', 'responses'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: KEY } });
writeProfile('sub', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret-subscription' } });

const created = [];
const respawned = [];
let terms = [];
const backend = {
  kind: 'pty', capabilities: {},
  list: async () => terms,
  capture: async () => '',
  create: async ({ name, dir, argv }) => {
    created.push({ name, dir, argv });
    return { name };
  },
  respawn: async (id, dir, argv) => respawned.push(argv),
};
const app = createServer({ backend, watch: false });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(async () => {
  await app.close();
  box.cleanup();
});
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const bodies = [];
async function call(p, body) {
  const r = await fetch(base + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  bodies.push(text);
  return { status: r.status, json: JSON.parse(text || '{}') };
}

const install = (tool) => {
  const bin = path.join(process.env.HOPRIG_TOOLS_DIR, tool, 'node_modules', '.bin', tool);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
};

test('Codex starts only when it is on and installed, on a provider that serves it, with its own choices', async () => {
  let r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'new' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Codex is off/);
  saveConfig({ codingTools: ['claude', 'codex', 'opencode'] });
  r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'new' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not installed/);
  install('codex');
  install('opencode');
  r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'sub', mode: 'new' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cannot be used for Codex: a Claude subscription is for Claude Code only/);
  assert.equal((await call('/api/sessions', { tool: 'codex', dir: work, profile: 'auto', mode: 'new' })).status, 400, 'Auto mode is Claude Code\'s');
  assert.equal((await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'new', permissionMode: 'acceptEdits' })).status, 400);
  assert.equal((await call('/api/sessions', { tool: 'vim', dir: work, profile: 'gw', mode: 'new' })).status, 400);
  r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'new', permissionMode: 'readOnly', effort: 'low', prompt: 'hi there' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { name: 'work', tool: 'codex' });
  assert.deepEqual(created.pop().argv, ['L', 'codex', 'gw', '--permission-mode', 'readOnly', '--effort', 'low', '--', 'hi there']);
  // Claude Code: the command it always had.
  r = await call('/api/sessions', { dir: work, profile: 'gw', mode: 'new', effort: 'low' });
  assert.equal(r.status, 200);
  assert.deepEqual(created.pop().argv, ['L', 'gw', '--effort', 'low']);
});

test('resume lists and resume come from the tool\'s own store', async () => {
  const id = '01a1e390-0000-7000-8000-000000000001';
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '16');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-16T14-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: work } })}\n`);
  let r = await call(`/api/folders/sessions?path=${encodeURIComponent(work)}&tool=codex`);
  assert.deepEqual(r.json.sessions.map((s) => [s.id, s.title]), [[id, '(untitled)']]);
  assert.equal(r.json.tool, 'codex');
  assert.equal((await call(`/api/folders/sessions?path=${encodeURIComponent(work)}&tool=vim`)).status, 400);
  r = await call(`/api/folders/sessions?path=${encodeURIComponent(work)}`);
  assert.deepEqual(r.json.sessions, [], 'Claude Code\'s store is another one');
  assert.equal((await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'resume', sessionId: '01a1e399-0000-7000-8000-000000000000' })).status, 400);
  r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw2', mode: 'resume', sessionId: id });
  assert.equal(r.status, 200);
  assert.deepEqual(created.pop().argv, ['L', 'codex', 'gw2', '--resume', id]);
});

test('a move stays in the tool: refused to a provider that does not serve it, else the conversation is resumed', async () => {
  const runs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(runs, 'oc.json'), JSON.stringify({
    runId: 'oc', pid: process.pid, profile: 'gw', cwd: work, termId: 'pty-cccccccccccc', tmuxPane: null, tool: 'opencode', server: true,
    statusSource: 'server', sessionId: 'ses_abcdefgh12345678', status: 'waiting', statusAt: now, startedAt: now, carryArgs: ['--permission-mode', 'ask'],
  }));
  terms = [{ id: 'pty-cccccccccccc', session: 'oc', cwd: work, pid: 1, activity: now }];
  const st = await call('/api/state');
  const card = st.json.sessions.find((c) => c.name === 'oc');
  assert.deepEqual([card.kind, card.tool, card.status], ['claude', 'opencode', 'waiting']);
  let r = await call('/api/sessions/oc/switch', { profile: 'sub' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cannot be used for OpenCode/);
  assert.equal((await call('/api/sessions/oc/switch', { profile: 'auto' })).status, 400);
  r = await call('/api/sessions/oc/switch', { profile: 'gw2' });
  assert.equal(r.status, 200);
  assert.deepEqual(respawned.pop(), ['L', 'opencode', 'gw2', '--permission-mode', 'ask', '--resume', 'ses_abcdefgh12345678']);
  fs.rmSync(path.join(runs, 'oc.json'));
  terms = [];
});

test('no response carried a key', () => {
  for (const secret of [KEY, 'sk-ant-oat01']) assert.equal(bodies.join('\n').includes(secret), false, secret);
});
