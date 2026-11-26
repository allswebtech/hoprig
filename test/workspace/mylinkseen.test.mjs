// "This link is mine" saves only the place the sheet showed: a link pointed elsewhere between the sheet and the yes
// (a pull, a session) is refused with 409 and nothing is saved; a yes that names no place is refused too. A temporary
// home only, the route over HTTP with the owner's own sign-in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-mylinkseen');
test.after(() => w.cleanup());
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const shop = path.join(A.projects, 'shop');
fs.mkdirSync(path.join(shop, 'code'), { recursive: true });
const away = path.join(A.home, 'disk2', 'shop-web');
const other = path.join(A.home, '.ssh-made-up');
fs.mkdirSync(away, { recursive: true });
fs.mkdirSync(other, { recursive: true });
const link = path.join(shop, 'code', 'shop-web');
fs.symlinkSync(away, link);

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { myLinkEntries, addMyLink } = await import('../../src/workspace/inside.mjs');

test('the link pointed elsewhere between the sheet and the yes: 409, nothing saved', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [A.home], backend: 'pty' } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `mylinkseen-${process.pid}` });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  saveConfig({ server: { port } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const page = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin };
    const post = async (body) => {
      const r = await fetch(`${origin}/api/workspace/mylink`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...page }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const look = await post({ path: link, dryRun: true });
    assert.equal(look.json.to, path.join('~', 'disk2', 'shop-web'));
    assert.equal((await post({ path: link })).status, 400, 'a yes that names no place');
    // Pointed elsewhere while the sheet is open.
    fs.unlinkSync(link);
    fs.symlinkSync(other, link);
    const yes = await post({ path: link, seen: look.json.seen });
    assert.equal(yes.status, 409, JSON.stringify(yes.json));
    assert.match(yes.json.error || JSON.stringify(yes.json), /points elsewhere now: open it again/);
    assert.deepEqual(myLinkEntries(), [], 'nothing saved');
    // Opened again, the sheet shows the new place; that yes saves it.
    const again = await post({ path: link, dryRun: true });
    assert.equal(again.json.to, path.join('~', '.ssh-made-up'));
    const ok = await post({ path: link, seen: again.json.seen });
    assert.equal(ok.status, 200);
    assert.deepEqual(myLinkEntries(), [{ path: link, to: other }]);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('the command keeps working without a place to compare (it names the link where it points now)', () => {
  saveConfig({ workspaceLinks: [] });
  fs.unlinkSync(link);
  fs.symlinkSync(away, link);
  const r = addMyLink(link);
  assert.equal(r.added, true);
  assert.equal(r.to, away);
  assert.throws(() => addMyLink(link, {}, { expect: other }), (e) => e.status === 409);
});
