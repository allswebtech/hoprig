// A chat's refusals that name a place carry its code (web/errorways.js), so the page draws the button to it: a new chat
// with no provider yet (code no-provider, Providers) and a message to an open chat whose coding tool was turned off
// since (code tool-off, Coding tools). The real dashboard (createServer), with the stand-in of OpenCode's server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';
import { standIn, standInOpts } from './fixtures/opencode-standin.mjs';

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

test('a chat: no provider yet answers no-provider; a coding tool turned off answers tool-off', { timeout: 60_000, skip: process.platform === 'win32' && 'POSIX paths' }, async (t) => {
  const box = sandbox('chatcodes');
  const proj = path.join(box.root, 'work', 'proj');
  fs.mkdirSync(proj, { recursive: true });
  const s = await standIn();
  const { saveConfig } = await import('../../src/config.mjs');
  const { writeProfile } = await import('../../src/profiles.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { toolsDir } = await import('../../src/paths.mjs');
  const { WAYS } = await import('../../web/errorways.js');
  saveConfig({ server: { backend: 'pty', roots: [path.dirname(proj)], passwordHash: await hashPassword('pw-for-tests') } });
  const app = createServer({ watchTickMs: 300, dashboardFile: false, chat: { resolveEnv: async () => ({}), engineOpts: standInOpts(s), idleMs: 30_000 } });
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

  // No provider at all: "add one under Providers first", with the code of Providers.
  let r = await owner('POST', '/api/chats', { dir: proj });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /there is no provider yet: add one under Providers first/);
  assert.equal(r.json.code, 'no-provider');
  assert.equal(WAYS[r.json.code].href, '#/providers');

  // An open chat of OpenCode, then OpenCode turned off: its message is refused with the code of Coding tools.
  writeProfile('gw', { label: 'Gateway', api: ['messages', 'models'], env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_AUTH_TOKEN: 'gw-token-of-the-test' } });
  saveConfig({ codingTools: ['claude', 'opencode'] });
  const bin = path.join(toolsDir(), 'opencode', 'node_modules', '.bin', 'opencode');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  r = await owner('POST', '/api/chats', { dir: proj, tool: 'opencode', profile: 'gw' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const open = r.json.id;
  saveConfig({ codingTools: ['claude'] });
  r = await owner('POST', `/api/chats/${open}/send`, { text: 'hello' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /OpenCode is off on this computer: turn it on under Settings → Coding tools/);
  assert.equal(r.json.code, 'tool-off');
  assert.equal(WAYS[r.json.code].href, '#/settings/codingtools');
  saveConfig({ codingTools: ['claude', 'opencode'] });
  assert.equal((await owner('POST', `/api/chats/${open}/close`, {})).status, 200);
});
