// The App as root (src/chat/feature.mjs, claude-lines.mjs chatArgs): a chat opened in bypass permissions mode is refused
// with the one line, and so is one nobody chooses for at that moment (a schedule's or Work's `defaults: true`) whose
// default names bypass, and the App's mode lists leave bypass out. Root is a fact handed in; the route answers before
// any coding tool would start.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('chatroot');
const shop = path.join(box.root, 'work', 'shop');
fs.mkdirSync(shop, { recursive: true });
const { saveConfig } = await import('../../src/config.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { ROOT_BYPASS_LINE } = await import('../../src/bypassgate.mjs');
saveConfig({ allowBypass: true, server: { backend: 'pty', roots: [path.join(box.root, 'work')], passwordHash: await hashPassword('right-password') }, sessionDefaults: { permissionMode: 'bypassPermissions' } });
writeProfile('sub', { label: 'Main' });
const backend = { kind: 'pty', capabilities: {}, list: async () => [], capture: async () => '', create: async ({ name }) => ({ name, id: 'pty-1' }), respawn: async () => {} };

test('the App as root: an open in bypass, or one nobody chose for with a bypass default, is refused with the line', async () => {
  const app = createServer({ backend, watch: false, root: true, workUser: null, dashboardFile: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const post = async (p, body) => {
      const r = await fetch(base + p, { method: 'POST', headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, json: JSON.parse((await r.text()) || '{}') };
    };
    let r = await post('/api/chats', { dir: shop, profile: 'sub', permissionMode: 'bypassPermissions' });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error, ROOT_BYPASS_LINE);
    r = await post('/api/chats', { dir: shop, profile: 'sub', defaults: true });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error, ROOT_BYPASS_LINE);
    // The App's mode lists leave bypass out as root even with the switch on.
    const tools = await (await fetch(`${base}/api/chats/tools`, { headers: { Origin: base, Cookie: cookie } })).json();
    for (const t of tools.tools.filter((x) => x.modes)) assert.ok(!t.modes.includes('bypassPermissions'), t.id);
  } finally {
    await app.close();
  }
});

test.after(() => box.cleanup());
