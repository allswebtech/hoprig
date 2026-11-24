// "This link is mine": the yes is compared with the place the sheet showed by an exact value, not by the page's text of
// it. A place whose path holds the home folder's text not at its start (a sibling "<home>.bak", a backup tree that
// repeats the home path) is saved on his yes like any other. A temporary home only, over HTTP with his own sign-in.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-mylinkplace');
test.after(() => w.cleanup());
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const code = path.join(A.projects, 'shop', 'code');
fs.mkdirSync(code, { recursive: true });
const places = {
  plain: path.join(A.home, 'disk2', 'shop-web'),
  sibling: `${A.home}.bak/shop-web`,
  mirror: path.join(w.root, 'mirror', ...A.home.split(path.sep).filter(Boolean), 'shop-web'),
};
for (const [k, t] of Object.entries(places)) {
  fs.mkdirSync(t, { recursive: true });
  fs.symlinkSync(t, path.join(code, `web-${k}`));
}
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { myLinkEntries } = await import('../../src/workspace/inside.mjs');

test('the yes saves the place the sheet showed, also where its text holds the home folder not at its start', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [A.home], backend: 'pty' } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `mylinkplace-${process.pid}` });
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
    for (const [k, to] of Object.entries(places)) {
      const l = path.join(code, `web-${k}`);
      const look = await post({ path: l, dryRun: true });
      assert.equal(look.status, 200, k);
      const yes = await post({ path: l, seen: look.json.seen });
      assert.deepEqual([yes.status, yes.json && yes.json.added], [200, true], `${k}: ${JSON.stringify(yes.json)}`);
      assert.ok(myLinkEntries().some((e) => e.path === l && e.to === to), `${k} is saved with its real place`);
    }
    // A seen of another place is still refused.
    const l = path.join(code, 'web-plain');
    fs.unlinkSync(l);
    fs.symlinkSync(places.sibling, l);
    const plainSeen = (await import('../../src/workspace/inside.mjs')).placeSeen(places.plain);
    const stale = await post({ path: l, seen: plainSeen });
    assert.equal(stale.status, 409, JSON.stringify(stale.json));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
