// "This link is mine" on a project's page: a sheet that names the link and where it leads (a dry run that saves
// nothing), then the owner's yes calls the same function as `hoprig workspace mylink add`. The route is his own page's
// only, as the brain's save is: refused to Tia's token, a call with no sign-in (a session's own), another site, a path
// outside the workspace and a folder that is no link. A temporary home, compared whole before and after.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-mylinkroute');
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const shop = path.join(A.projects, 'shop');
fs.mkdirSync(path.join(shop, 'code'), { recursive: true });
const away = path.join(A.home, 'disk2', 'shop-web'); // the owner's own folder, kept elsewhere
fs.mkdirSync(away, { recursive: true });
fs.writeFileSync(path.join(away, 'index.html'), '<p>shop</p>\n');
const link = path.join(shop, 'code', 'shop-web');
fs.symlinkSync(away, link);
const outside = path.join(w.root, 'elsewhere-link');
fs.symlinkSync(away, outside);

// Just enough of a browser for the page's modules to load (nothing is drawn here).
globalThis.document ??= { createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, addEventListener() {}, append() {}, replaceChildren() {} }), createElementNS: () => ({ setAttribute() {}, append() {} }), createTextNode: () => ({}), getElementById: () => null, addEventListener: () => {}, visibilityState: 'visible', body: { classList: { add() {}, remove() {}, toggle() {} } } };
globalThis.Node ??= class {};
globalThis.window ??= { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { myLinkEntries, leaves } = await import('../../src/workspace/inside.mjs');
const { configFile } = await import('../../src/paths.mjs');

/** Every file and link under `top` with what it holds (a hash). The test dashboard's own sign-in record is left out:
 * it changes with every signed-in request, whatever the route does. */
const SIGNINS = path.join(A.env.HOPRIG_STATE_DIR, 'web-sessions.json');
function snapshot(top) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === SIGNINS) continue;
      if (e.isSymbolicLink()) out.set(p, `link:${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) walk(p);
      else out.set(p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(top);
  return out;
}

test('the sheet asks first (nothing saved), his yes names the link: the same entry as the command, nothing else changes', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [A.home], backend: 'pty' } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `mylinkroute-${process.pid}` });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  saveConfig({ server: { port } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const page = { Cookie: cookie, Origin: origin };
    const post = async (body, headers) => {
      const r = await fetch(`${origin}/api/workspace/mylink`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    assert.ok(leaves(shop, link), 'before: the link leads out and is not followed');
    const cfgBefore = loadConfig();
    const before = snapshot(A.home);
    const body = { path: link };
    assert.equal((await post(body, { Authorization: 'Bearer tia_0123456789abcdef' })).status, 401, 'Tia\'s token alone');
    assert.ok([401, 403].includes((await post(body, { Authorization: 'Bearer tia_0123456789abcdef', ...page })).status), 'Tia\'s token, also with the cookie');
    assert.ok([401, 403].includes((await post(body, {})).status), 'no sign-in, as a session\'s own call');
    assert.equal((await post(body, { Origin: origin })).status, 401, 'no sign-in, from the dashboard\'s own address');
    assert.equal((await post(body, { Cookie: cookie, Origin: 'http://evil.example' })).status, 403, 'another site');
    assert.equal((await post({ path: link, force: true }, page)).status, 400);
    assert.equal((await post({ path: 'projects/shop/code/shop-web' }, page)).status, 400, 'a path that is not full');
    assert.equal((await post({ path: outside }, page)).status, 400, 'a link outside the workspace');
    assert.equal((await post({ path: path.join(shop, 'code') }, page)).status, 400, 'a folder that is no link');
    // The sheet's question: where it leads, nothing saved.
    const look = await post({ path: link, dryRun: true }, page);
    assert.deepEqual([look.status, look.json], [200, { ok: true, path: path.join('~', 'Workspace', 'projects', 'shop', 'code', 'shop-web'), to: path.join('~', 'disk2', 'shop-web'), added: false, dryRun: true, seen: look.json.seen }]);
    assert.match(look.json.seen, /^[0-9a-f]{64}$/);
    assert.deepEqual(myLinkEntries(), [], 'the question saved nothing');
    assert.deepEqual([...snapshot(A.home).entries()].sort(), [...before.entries()].sort(), 'nothing in the home changed before his yes');
    // His yes.
    const yes = await post({ ...body, seen: look.json.seen }, page);
    assert.deepEqual([yes.status, yes.json], [200, { ok: true, path: path.join('~', 'Workspace', 'projects', 'shop', 'code', 'shop-web'), to: path.join('~', 'disk2', 'shop-web'), added: true }]);
    assert.deepEqual(myLinkEntries(), [{ path: link, to: away }], 'the entry `hoprig workspace mylink add` keeps');
    assert.equal(leaves(shop, link), null, 'followed now');
    // Only the settings file changed, and in it only the list of his links.
    const after = snapshot(A.home);
    const cfg = configFile();
    const others = (m) => [...m.entries()].filter(([p]) => p !== cfg).sort();
    assert.deepEqual(others(after), others(before));
    assert.deepEqual(loadConfig(), { ...cfgBefore, workspaceLinks: [{ path: link, to: away }] });
    // The command lists it as its own.
    const { main } = await import('../../src/workspace/cli.mjs');
    let out = '';
    assert.equal(await main(['mylink', 'list', '--json'], { write: (s) => (out += s) }), 0);
    assert.deepEqual(JSON.parse(out).links, [{ path: link, to: away, there: true }]);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('Tia\'s own call in the dashboard (not over HTTP) is refused', async () => {
  const { Readable } = await import('node:stream');
  const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
  let adds = 0;
  const f = workspaceFeature({ config: () => ({}), readJson: async (req) => req.body, caller: () => 'self' }, { addMyLink: () => (adds++, { path: link, to: away, added: true }) });
  const [, , fn] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/workspace/mylink'));
  await assert.rejects(fn(Object.assign(Readable.from([]), { body: { path: link }, headers: {} })), (e) => e.status === 403 && /owner's own step/.test(e.message));
  assert.equal(adds, 0);
});

test('the page: a button that asks once, in place of the command to copy', async () => {
  const { myLinkWords } = await import('../../web/projects.js');
  const src = fs.readFileSync(new URL('../../web/projects.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /`hoprig workspace mylink add \$\{/, 'no command to copy on the page');
  assert.doesNotMatch(src, /'If that link is yours: '/);
  assert.match(src, /label: 'This link is mine'/);
  assert.match(src, /api\('\/api\/workspace\/mylink', \{ path: linkPath, dryRun: true \}\)/, 'where it leads is asked first');
  assert.match(src, /onclick: async \(\) => \{\n\s+yes\.disabled = true;\n\s+try \{\n\s+await api\('\/api\/workspace\/mylink', \{ path: linkPath, seen: look\.seen \}\)/, 'saved only on his yes, for the place the sheet showed');
  const words = myLinkWords('~/Workspace/projects/shop/code/shop-web', '~/disk2/shop-web');
  assert.equal(words.lines[0], '~/Workspace/projects/shop/code/shop-web is a link that leads out of the project, to ~/disk2/shop-web.');
  assert.match(words.lines[1], /Hoprig follows it from now on, on this computer only, as part of the project/);
  assert.match(words.lines[2], /press Cancel/);
  assert.equal(words.ok, 'Yes, it is mine');
});

test.after(() => w.cleanup());
