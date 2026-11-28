// A terminal session Tia starts on Codex or OpenCode gets no hook from Hoprig, so her administrator-rights level cannot
// hold an administrator command in it. The terminal route (POST /api/sessions) refuses such a start of hers below Full,
// proven here over HTTP through her door (her start_session tool, and another computer's dashboard relaying hers)
// on a real server in a temporary home. Started by the owner himself, the same start is not refused for her level.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { projectWork } from './fake-dashboard.mjs';

const POSIX = { skip: process.platform === 'win32' && 'POSIX paths' };

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
        resolve({ status: res.statusCode, json, text: t });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('below Full the terminal route refuses an OpenCode session of hers through her door; at Full and for his own it does not', { timeout: 60_000, ...POSIX }, async (t) => {
  const box = sandbox('hertermtool');
  const work = projectWork('hoprig-hertermtool-');
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { stateDir, toolsDir } = await import('../../src/paths.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { createToken } = await import('../../src/machines/tokens.mjs');
  const { SELF_HEADER } = await import('../../src/machines/relay.mjs');
  const { hoprigVersion } = await import('../../src/handsoff.mjs');
  // A stand-in for the installed OpenCode where Hoprig looks for it: a made-up script that ends at once.
  const bin = path.join(toolsDir(), 'opencode', 'node_modules', '.bin', 'opencode');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  saveConfig({
    usage: false,
    codingTools: ['claude', 'opencode'],
    server: { backend: 'pty', roots: [work], passwordHash: await hashPassword('pw-for-tests') },
    assistant: { enabled: true, level: 'handsoff', accounts: ['gw'], dailyCapUsd: 5 }, operator: { acts: true },
  });
  writeProfile('gw', { label: 'Gateway', api: ['messages', 'models'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'gw-token-of-the-test' } });

  const app = createServer({ watch: false, dashboardFile: false });
  const base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
  t.after(async () => {
    await app.close().catch(() => {});
    box.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  });
  const cookie = (await new Promise((resolve) => {
    const req = http.request(new URL('/api/login', base), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base } }, resolve);
    req.end(JSON.stringify({ password: 'pw-for-tests' }));
  })).headers['set-cookie'][0].split(';')[0];
  const owner = (p, body) => request(base, 'POST', p, { body, headers: { Cookie: cookie } });
  const tiaToken = fs.readFileSync(path.join(stateDir(), 'assistant-token'), 'utf8').trim();
  const call = async (tool, args) => (await request(base, 'POST', '/api/assistant/call', { body: { tool, args }, headers: { Authorization: `Bearer ${tiaToken}`, 'X-Hoprig-Conversation': 'conv-hertermtool' } })).json;
  const { token } = createToken('hub');
  const relayed = (body) => request(base, 'POST', '/api/sessions', { body, headers: { Authorization: `Bearer ${token}`, [SELF_HEADER]: '1' } });
  const folder = (name) => {
    const d = path.join(work, name);
    fs.mkdirSync(d, { recursive: true });
    return fs.realpathSync(d);
  };
  const REFUSAL = /Hoprig allows her to start OpenCode only when her administrator-rights level is Full/;

  // ---- below Full (the default, Off; and Ask): her door is refused, by the route's own words ----
  for (const level of [null, 'ask']) {
    if (level) saveConfig({ server: { herRights: { level, version: hoprigVersion(), at: Date.now() } } });
    const what = level || 'the default level';
    const viaRelay = await relayed({ dir: folder(`relay-${what}`), profile: 'gw', mode: 'new', tool: 'opencode' });
    assert.equal(viaRelay.status, 400, `${what}: her relayed OpenCode start is refused (${viaRelay.text})`);
    assert.match(viaRelay.json.error, REFUSAL, `${what}: the route says why`);
    const viaTool = await call('start_session', { folder: folder(`tool-${what}`), account: 'gw', coding_tool: 'opencode' });
    assert.equal(viaTool.isError, true, `${what}: her start_session on OpenCode is refused (${viaTool.text})`);
    assert.match(viaTool.text, REFUSAL, `${what}: her tool reads the route's refusal`);
  }

  // ---- his own start of the same is not refused for her level ----
  const his = await owner('/api/sessions', { dir: folder('his'), profile: 'gw', mode: 'new', tool: 'opencode' });
  assert.doesNotMatch(his.text, REFUSAL, 'his own OpenCode start is not refused for her level');
  assert.equal(his.status, 200, his.text);

  // ---- at Full her administrator commands run with no card anyway: her relayed start passes the guard ----
  saveConfig({ server: { herRights: { level: 'full', version: hoprigVersion(), at: Date.now() } } });
  const atFull = await relayed({ dir: folder('relay-full'), profile: 'gw', mode: 'new', tool: 'opencode' });
  assert.doesNotMatch(atFull.text, REFUSAL, 'at Full her OpenCode start is not refused for the level');
  assert.equal(atFull.status, 200, atFull.text);

  // The sessions started end with the server (t.after); end them here too so nothing waits on them.
  const all = (await request(base, 'GET', '/api/state', { headers: { Cookie: cookie } })).json.sessions || [];
  for (const s of all) await owner(`/api/sessions/${encodeURIComponent(s.name)}/kill`, {});
});
