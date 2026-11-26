// The kept Codex code behind the server's routes, with Codex offered (test/fixtures/every-tool.mjs swaps the one
// switch, src/codetools/offered.mjs, for this process only). This version does not offer Codex
// (codingsessions.test.mjs proves the refusals); these tests keep what was built for it proven, so turning it on is
// one line: POST /api/sessions starts and resumes Codex with its own choices, the resume list comes from Codex's own
// store, and its sign-in kind is a normal provider again in /api/state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { offerEveryTool } from '../fixtures/every-tool.mjs';
import { launched, sandbox } from './helpers.mjs';

offerEveryTool(); // before the first import of src/
const box = sandbox('codexkept');
process.env.HOPRIG_TOOLS_DIR = path.join(box.root, 'tools');
process.env.CODEX_HOME = path.join(box.root, 'codex-home');
const work = path.join(box.root, 'work');
fs.mkdirSync(work);

const { saveConfig } = await import('../../src/config.mjs');
const { publicProfile, readProfile, writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { TOOL_IDS } = await import('../../src/codetools/index.mjs');

const KEY = 'gw-key-codexkept-0123456789';
saveConfig({ launcher: ['L'], server: { roots: [box.root], passwordHash: await hashPassword('right-password') } });
writeProfile('gw', { label: 'Gateway', api: ['messages', 'responses', 'chat'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: KEY } });
writeProfile('gw2', { label: 'Gateway two', api: ['messages', 'responses'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: KEY } });
writeProfile('sub', { env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-secret-subscription' } });

const created = [];
const backend = {
  kind: 'pty', capabilities: {},
  list: async () => [],
  capture: async () => '',
  create: async ({ name, dir, argv }) => {
    created.push({ name, dir, argv });
    return { name };
  },
  respawn: async () => {},
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
  const bin = path.join(process.env.HOPRIG_TOOLS_DIR, tool, 'node_modules', '.bin', process.platform === 'win32' ? `${tool}.cmd` : tool); // the name Windows looks for (npmtool.mjs binPath); never run
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
};

test('the stand-in switch is in place: every built tool is offered in this process', () => {
  assert.deepEqual(TOOL_IDS, ['claude', 'codex', 'opencode']);
});

test('Codex starts only when it is on and installed, on a provider that serves it, with its own choices', async () => {
  let r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'new' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Codex is off/);
  saveConfig({ codingTools: ['claude', 'codex', 'opencode'] });
  r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'new' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /not installed/);
  install('codex');
  r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'sub', mode: 'new' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /cannot be used for Codex: a Claude subscription is for Claude Code only/);
  assert.equal((await call('/api/sessions', { tool: 'codex', dir: work, profile: 'auto', mode: 'new' })).status, 400, 'Auto mode is Claude Code\'s');
  assert.equal((await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'new', permissionMode: 'acceptEdits' })).status, 400);
  r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'new', permissionMode: 'readOnly', effort: 'low', prompt: 'hi there' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { name: 'work', tool: 'codex' });
  assert.deepEqual(launched(created.pop().argv), ['L', 'codex', 'gw', '--permission-mode', 'readOnly', '--effort', 'low', '--', 'hi there']);
});

test('the resume list and a resume come from Codex\'s own store', async () => {
  const id = '01a1e390-0000-7000-8000-000000000001';
  const day = path.join(process.env.CODEX_HOME, 'sessions', '2026', '11', '16');
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-11-16T14-00-00-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd: work } })}\n`);
  let r = await call(`/api/folders/sessions?path=${encodeURIComponent(work)}&tool=codex`);
  assert.deepEqual(r.json.sessions.map((s) => [s.id, s.title]), [[id, '(untitled)']]);
  assert.equal(r.json.tool, 'codex');
  r = await call(`/api/folders/sessions?path=${encodeURIComponent(work)}`);
  assert.deepEqual(r.json.sessions, [], 'Claude Code\'s store is another one');
  assert.equal((await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw', mode: 'resume', sessionId: '01a1e399-0000-7000-8000-000000000000' })).status, 400);
  r = await call('/api/sessions', { tool: 'codex', dir: work, profile: 'gw2', mode: 'resume', sessionId: id });
  assert.equal(r.status, 200);
  assert.deepEqual(launched(created.pop().argv), ['L', 'codex', 'gw2', '--resume', id]);
});

test('the Codex sign-in and a key only Codex can use are normal providers again in /api/state and publicProfile', async () => {
  writeProfile('cx', { signin: 'codex' });
  writeProfile('resp', { label: 'Responses only', api: ['responses'], env: { OPENAI_API_KEY: 'sk-resp-0123456789' } });
  const st = await call('/api/state');
  const of = (name) => st.json.profiles.find((p) => p.name === name);
  assert.deepEqual([of('cx').tools, of('cx').unusable], [['codex'], undefined]);
  assert.deepEqual([of('resp').tools, of('resp').unusable], [['codex'], undefined]);
  assert.deepEqual(of('gw').tools, ['claude', 'codex', 'opencode']);
  assert.deepEqual(publicProfile(readProfile('cx')).tools, ['codex']);
});

test('no response carried a key', () => {
  for (const secret of [KEY, 'sk-ant-oat01', 'sk-resp-0123456789']) assert.equal(bodies.join('\n').includes(secret), false, secret);
});
