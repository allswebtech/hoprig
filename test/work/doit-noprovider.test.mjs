// "Do it" on a computer with no provider yet (src/work/doit.mjs): refused with the sentence that names Providers and
// the code of that place (web/errorways.js), so the page draws the button to it; nothing is started. A real dashboard
// over HTTP on a temporary computer (test/work/helpers.mjs), with no provider written.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { FIXTURE, tempWork } from './helpers.mjs';

const t = tempWork('work-noprov');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { WAYS } = await import('../../web/errorways.js');

assert.ok(process.env.HOPRIG_WORKSPACE_DIR.startsWith(t.root));
t.repo(t.brain, { 'README.md': '# brain\n' });
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/deadlines.json': fs.readFileSync(FIXTURE, 'utf8') });
saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [t.home] }, sessionDefaults: { permissionMode: 'manual' } });

const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
const { port } = await app.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${port}`;
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const post = async (p, body) => {
  const r = await fetch(origin + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
test.after(async () => {
  await app.close();
  t.cleanup();
});

test('Do it with no provider yet: a 400 that names Providers, with the code no-provider; nothing starts', async () => {
  const add = await post('/api/work/items', { title: 'Echo the brief', project: 'shop', by: 'ai' });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  const it = add.body.item;
  const r = await post(`/api/work/items/${encodeURIComponent(it.id)}/do`, { at: it.at, brief: 'Echo the brief' });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.error, 'there is no provider for this coding tool yet: add one under Providers first');
  assert.equal(r.body.code, 'no-provider');
  assert.equal(WAYS[r.body.code].href, '#/providers');
  const runs = path.join(t.brain, 'work', 'runs');
  assert.equal(fs.existsSync(runs) ? fs.readdirSync(runs).length : 0, 0, 'no run was made');
});
