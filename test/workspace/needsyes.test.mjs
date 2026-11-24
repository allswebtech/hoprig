// A need is opened only after the owner accepted it ON THIS COMPUTER (src/workspace/needsyes.mjs). A
// project.json is someone else's words: a pull that adds a need opens nothing until his yes; the next session names it
// ("not accepted on this computer yet", with the command). The yes is kept in Hoprig's own settings, never in the
// project, and taken back the same way. `--with` is his own word for one session and needs no yes. Local bare
// repositories only (gitfix.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const N = await import('../../src/workspace/needs.mjs');
const Y = await import('../../src/workspace/needsyes.mjs');

function world(name) {
  const w = gitWorld(`needs-yes-${name}`);
  const shopUrl = w.bare('shop-workspace');
  const seed = w.clone(shopUrl, path.join(w.root, 'seed-shop'));
  w.commit(seed, 'project.json', JSON.stringify({ name: 'shop', repos: [], memories: {} }) + '\n');
  w.sh(seed, 'push', '-q');
  const c = w.computer('alpha');
  c.use();
  process.env.HOPRIG_WORKSPACE_DIR = c.ws;
  const map = { version: 2, brain: { url: w.url('brain') }, groups: [{ dir: 'kits' }], projects: [{ name: 'shop', url: shopUrl, repos: [] }, { name: 'parts', in: 'kits', url: w.url('parts'), repos: [] }, { name: 'blog', url: w.url('blog'), repos: [] }], others: [] };
  fs.mkdirSync(path.join(c.ws, 'ai_brain'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, 'ai_brain', 'workspace.json'), JSON.stringify(map, null, 2) + '\n');
  const shop = w.clone(shopUrl, path.join(c.projects, 'shop'));
  fs.mkdirSync(path.join(c.ws, 'kits', 'parts'), { recursive: true });
  fs.writeFileSync(path.join(c.ws, 'kits', 'parts', 'README.md'), 'parts\n');
  fs.mkdirSync(path.join(c.projects, 'blog'), { recursive: true });
  const at = { dir: c.ws, projects: c.projects };
  return { w, c, seed, shop, at, cfg: () => JSON.parse(fs.readFileSync(path.join(c.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8')) };
}

test('a pull adds a need: the next session does not get it until the yes; the yes and its taking back stay on this computer', async () => {
  const x = world('pull');
  try {
    let ex = await N.sessionExtras(x.shop, x.at);
    assert.deepEqual(ex.dirs, [], 'no need yet');
    // Someone else's commit names kits/parts; a pull brings it here.
    x.w.commit(x.seed, 'project.json', JSON.stringify({ name: 'shop', repos: [], memories: {}, needs: ['kits/parts'] }) + '\n', 'Name a need');
    x.w.sh(x.seed, 'push', '-q');
    execFileSync('git', ['-C', x.shop, 'pull', '-q'], { stdio: 'ignore' });
    ex = await N.sessionExtras(x.shop, x.at);
    assert.deepEqual(ex.dirs, [], 'not opened before the yes');
    assert.deepEqual(ex.notAccepted, [{ ref: 'kits/parts', of: 'shop', allow: 'hoprig workspace needs allow shop kits/parts' }]);
    assert.ok(N.startNote(ex).includes('shop needs kits/parts: not opened: not accepted on this computer yet:  hoprig workspace needs allow shop kits/parts'));
    const st = (await N.needsHere(x.at)).find((n) => n.project === 'shop');
    assert.deepEqual(st.notAccepted, [{ name: 'kits/parts', allow: 'hoprig workspace needs allow shop kits/parts' }], 'status says it too');
    // --with: his own word for one session, no yes needed.
    const wi = await N.sessionExtras(x.shop, { ...x.at, withs: ['kits/parts'] });
    assert.deepEqual(wi.refs, ['kits/parts']);
    assert.deepEqual(wi.notAccepted, []);
    // The yes (as `hoprig workspace needs allow` gives it): kept in Hoprig's settings only.
    let out = '';
    const { makeUi } = await import('../../src/setup/ui.mjs');
    const ui = makeUi({ interactive: false, write: (s) => (out += s) });
    const usage = () => 2;
    assert.equal(await Y.needsMain(['allow', 'shop', 'kits/parts'], { ui, write: () => {}, usage }), 0);
    assert.deepEqual(x.cfg().acceptedNeeds, { shop: ['kits/parts'] });
    assert.equal(execFileSync('git', ['-C', x.shop, 'status', '--porcelain'], { encoding: 'utf8' }), '', 'nothing written into the project');
    ex = await N.sessionExtras(x.shop, x.at);
    assert.deepEqual(ex.refs, ['kits/parts'], 'opened from the next start');
    // A name the project does not name, or one it cannot read, is refused.
    assert.equal(await Y.needsMain(['allow', 'shop', 'blog'], { ui, write: () => {}, usage }), 1);
    assert.match(out, /shop's project\.json does not name "blog" in "needs"/);
    // Taken back: closed again from the next start.
    assert.equal(await Y.needsMain(['revoke', 'shop', 'kits/parts'], { ui, write: () => {}, usage }), 0);
    assert.deepEqual(x.cfg().acceptedNeeds, {});
    ex = await N.sessionExtras(x.shop, x.at);
    assert.deepEqual(ex.dirs, []);
  } finally {
    delete process.env.HOPRIG_WORKSPACE_DIR;
    x.w.cleanup();
  }
});

test('the page\'s yes: POST /api/folders/extras/accept from the owner\'s page only; GET says what is accepted', async () => {
  const x = world('route');
  fs.writeFileSync(path.join(x.shop, 'project.json'), JSON.stringify({ name: 'shop', repos: [], memories: {}, needs: ['kits/parts'] }) + '\n');
  const { saveConfig } = await import('../../src/config.mjs');
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  saveConfig({ claudeBin: '/bin/false', usage: false, server: { passwordHash: await hashPassword('right-password'), roots: [x.c.ws] }, automation: { enabled: false } });
  const backend = { list: async () => [], capture: async () => '', kind: 'pty', capabilities: {}, create: async (o) => ({ name: o.name, id: o.name }) };
  const app = createServer({ backend, watch: false });
  const { port } = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const call = async (p, body) => {
      const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: JSON.parse((await r.text()) || '{}') };
    };
    let g = await call(`/api/folders/extras?${new URLSearchParams({ path: x.shop })}`);
    assert.deepEqual(g.json.needs, [{ name: 'kits/parts', here: true, accepted: false }]);
    let r = await call('/api/folders/extras/accept', { path: x.shop, need: 'kits/parts', allow: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    g = await call(`/api/folders/extras?${new URLSearchParams({ path: x.shop })}`);
    assert.equal(g.json.needs[0].accepted, true);
    for (const bad of [{ path: x.shop, need: 'credentials', allow: true }, { path: x.shop, need: 'blog', allow: true }, { path: '/etc', need: 'kits/parts', allow: true }, { path: x.shop, need: 'kits/parts' }]) {
      r = await call('/api/folders/extras/accept', bad);
      assert.ok(r.status === 400 || r.status === 404, JSON.stringify(bad));
    }
    // Tia's door (the server's own request for the owner) and another computer may not give the yes: the route asks
    // who sent it first. (createServer gives a test no handle on its in-process dispatch: read from the source.)
    const src = fs.readFileSync(new URL('../../src/server/server.mjs', import.meta.url), 'utf8');
    const route = src.slice(src.indexOf("/^\\/api\\/folders\\/extras\\/accept$/"), src.indexOf("/^\\/api\\/sessions$/"));
    assert.ok(route.length > 50, 'the route is there');
    assert.match(route.split('readJson')[0], /if \(ctx\.caller\(req\) !== 'page'\) throw new HttpError\(403/, 'refused before anything is read, unless from the page');
    r = await call('/api/folders/extras/accept', { path: x.shop, need: 'kits/parts', allow: false });
    assert.equal(r.status, 200);
    assert.deepEqual(x.cfg().acceptedNeeds, {});
  } finally {
    await app.close();
    delete process.env.HOPRIG_WORKSPACE_DIR;
    x.w.cleanup();
  }
});
