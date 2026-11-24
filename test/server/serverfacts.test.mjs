// Settings → Security → Network on a server: the settings answer carries why this computer is a server and the safe
// ways to reach it, so the page names those instead of "serve --host 0.0.0.0" (src/setup/server.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';

test('the settings answer names the server reason and the ways to reach it', { timeout: 60_000 }, async (t) => {
  const box = sandbox('srvfacts');
  // The dashboard service has no ssh session: set-up, run over ssh, saved what it found (setup/server.mjs).
  for (const k of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT', 'DISPLAY', 'WAYLAND_DISPLAY']) delete process.env[k];
  fs.mkdirSync(process.env.HOPRIG_STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.HOPRIG_STATE_DIR, 'server.json'), JSON.stringify({ kind: 'ssh', sshPort: '2222' }));
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ server: { backend: 'pty', passwordHash: await hashPassword('first-password') } });
  // Whatever computer runs the tests: Linux (only Linux is taken for a server), no public address, no cloud hardware,
  // no display of its own.
  const app = createServer({ serverFacts: { platform: 'linux', publicIps: [], dmi: {}, localDisplay: false } });
  const { port } = await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    box.cleanup();
  });
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'first-password' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const s = await (await fetch(`${base}/api/settings`, { headers: { Origin: base, Cookie: cookie } })).json();
  assert.ok(s.network.server, JSON.stringify(s.network));
  assert.match(s.network.server.why, /this is a server \(reached over ssh, with no desktop of its own\)/);
  assert.equal(s.network.server.ways.length, 4);
  assert.match(s.network.server.ways.join('\n'), /Computers → Add a computer → "I can reach it by SSH"/);
  assert.match(s.network.server.forward, new RegExp(`^ssh -N -L ${port + 10000}:127\\.0\\.0\\.1:${port} -p 2222 `), 'the ssh port set-up saw, the command alone');
  assert.doesNotMatch(JSON.stringify(s.network.server), /10\.0\.0\.5|192\.168\.1\.20/, 'no private address');
  assert.ok(fs.existsSync(box.config));
});
