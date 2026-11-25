// A project's needs from the page's Get (POST /api/pcsetup/project/needs, getneeds.mjs), over real HTTP on a temporary
// home with local bare repositories: the dry run names each need missing here in the terminal's own words and changes
// nothing in the home; the yes is the owner's own page only (Tia's token, her token on the page, a script's token, a
// hub with her mark, another site and no sign-in are refused, also with a correct `seen`); an unknown key, a boolean
// that is not one, no seen and a stale seen are refused; a need added between the look and the press changes the
// offer, and nothing is got; the yes brings each need by the same get as the terminal's yes, never answering a need's
// own setup questions, and lets the sessions read them on this computer.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from '../workspace/gitfix.mjs';

const w = gitWorld('getneeds-web');
const u = { brain: w.bare('brain', { empty: true }), shop: w.bare('shop-workspace'), parts: w.bare('parts'), tools: w.bare('tools-workspace'), blog: w.bare('blog-workspace') };
const seed = (url, files) => {
  const d = w.clone(url, path.join(w.root, `seed-${path.basename(url)}`));
  for (const [f, body] of Object.entries(files)) w.commit(d, f, body);
  w.sh(d, 'push', '-q');
};
const pj = (json) => JSON.stringify(json, null, 2) + '\n';
seed(u.shop, { 'project.json': pj({ name: 'shop', repos: [], memories: {}, needs: ['kits/parts'] }) });
// parts has a setup question of its own (an install): the press never answers it.
seed(u.parts, { 'project.json': pj({ name: 'parts', repos: [], memories: {}, needs: ['tools', 'shop'] }), 'package.json': JSON.stringify({ name: 'parts', scripts: { postinstall: 'echo hi' } }) + '\n' });
// tools names blog in its own project.json only (the map says nothing of it): offered after tools is here; and
// kits/parts, here by then but not allowed for tools: that offer is the one his next press is checked against.
seed(u.tools, { 'project.json': pj({ name: 'tools', repos: [], memories: {}, needs: ['blog', 'kits/parts'] }) });
seed(u.blog, { 'project.json': pj({ name: 'blog', repos: [], memories: {} }) });
const map = { version: 2, brain: { url: u.brain }, groups: [{ dir: 'kits' }], projects: [{ name: 'shop', url: u.shop, repos: [] }, { name: 'parts', in: 'kits', url: u.parts, repos: [], needs: ['tools'] }, { name: 'tools', url: u.tools, repos: [] }, { name: 'blog', url: u.blog, repos: [] }], others: [] };
const C = w.computer('alpha');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
fs.mkdirSync(path.join(C.ws, 'ai_brain'), { recursive: true });
fs.writeFileSync(path.join(C.ws, 'ai_brain', 'workspace.json'), JSON.stringify(map, null, 2) + '\n');

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { OWNER_PAGE_HEADER, SELF_HEADER } = await import('../../src/machines/relay.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const { getMain } = await import('../../src/pcsetup/getproject.mjs');
const { makeUi } = await import('../../src/setup/ui.mjs');
saveConfig({ projectsDir: C.projects, server: { passwordHash: await hashPassword('pw'), roots: [C.home], backend: 'pty' } });
// shop got the way the page's Get gets it (no terminal: nothing more comes).
assert.equal(await getMain(['shop'], { ui: makeUi({ interactive: false, write: () => {} }), write: () => {}, dir: C.projects }), 0);
const script = createToken('a script');
const hub = createToken('hub');
fs.writeFileSync(path.join(C.env.HOPRIG_CONFIG_DIR, 'joined.json'), JSON.stringify({ hubs: [{ id: '0123456789ab', target: 'alex@box2', port: 7433, tokenId: hub.id }] }));
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `getneeds-${process.pid}` });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const { port } = app.server.address();
saveConfig({ server: { port } });
const origin = `http://127.0.0.1:${port}`;
test.after(async () => {
  await new Promise((r) => app.server.close(r));
  w.cleanup();
});
const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
const page = { Cookie: cookie, Origin: origin };
const bearer = (t, extra = {}) => ({ Authorization: `Bearer ${t}`, ...extra });
const call = async (p, body, headers = page) => {
  const r = await fetch(origin + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const here = (rel) => fs.existsSync(path.join(C.ws, rel, '.git'));
const accepted = () => loadConfig().acceptedNeeds || {};
const shopJson = path.join(C.projects, 'shop', 'project.json');

/** Every file and link of the home with what it holds; the dashboard's own records of sign-ins and token use left out. */
const OWN = new Set(['web-sessions.json', 'token-use.json'].map((f) => path.join(C.env.HOPRIG_STATE_DIR, f)));
function snapshot(top = C.home) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (OWN.has(p)) continue;
      if (e.isSymbolicLink()) out.push([p, `link:${fs.readlinkSync(p)}`]);
      else if (e.isDirectory()) walk(p);
      else out.push([p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]);
    }
  };
  walk(top);
  return out.sort();
}
async function jobEnd() {
  for (let i = 0; i < 600; i++) {
    const j = await call('/api/pcsetup/job');
    if (!j.json.running) return j.json;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the job did not end');
}

test('the look names each need missing here in the terminal\'s words, and changes nothing in the home', async () => {
  const before = snapshot();
  const r = await call('/api/pcsetup/project/needs', { name: 'shop', dryRun: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.project, 'shop');
  assert.deepEqual(r.json.missing, [{ name: 'kits/parts' }, { name: 'tools', of: 'kits/parts' }]);
  assert.ok(r.json.lines.includes('shop also needs, to read: kits/parts; and kits/parts needs tools. They are not on this computer.'), JSON.stringify(r.json.lines));
  assert.equal(r.json.question, 'Get them too, and let the sessions read them?');
  assert.equal(r.json.later, 'hoprig get kits/parts tools  and  hoprig workspace needs allow shop kits/parts  and  hoprig workspace needs allow kits/parts tools');
  assert.match(r.json.seen, /^[0-9a-f]{64}$/);
  assert.deepEqual(snapshot(), before, 'the look changed nothing in the home');
  assert.equal((await call('/api/pcsetup/project/needs', { name: 'shop', dryRun: true }, bearer('tia_0123456789abcdef'))).status, 401, 'Tia\'s token');
  assert.equal((await call('/api/pcsetup/project/needs', { name: 'nothing-here', dryRun: true })).status, 404);
});

test('the yes: refused from Tia, her mark, a script, another site; an unknown key, a stale or a missing seen', async () => {
  const before = snapshot();
  const look = await call('/api/pcsetup/project/needs', { name: 'shop', dryRun: true });
  const yes = { name: 'shop', seen: look.json.seen };
  for (const h of [bearer('tia_0123456789abcdef'), { ...page, ...bearer('tia_0123456789abcdef') }, bearer(script.token), bearer(script.token, { [OWNER_PAGE_HEADER]: '1' }), bearer(hub.token), bearer(hub.token, { [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' }), { Cookie: cookie, Origin: 'http://evil.example' }, {}]) {
    const r = await call('/api/pcsetup/project/needs', yes, h);
    assert.ok([401, 403].includes(r.status), `${JSON.stringify(h)}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal((await call('/api/pcsetup/project/needs', { ...yes, force: true })).status, 400, 'an unknown key');
  assert.equal((await call('/api/pcsetup/project/needs', { ...yes, dryRun: 'yes' })).status, 400, 'a boolean that is not one');
  assert.equal((await call('/api/pcsetup/project/needs', { name: 'shop' })).status, 400, 'no seen');
  const stale = await call('/api/pcsetup/project/needs', { name: 'shop', seen: '0'.repeat(64) });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error, 'This changed since you looked: look again.');
  assert.ok(!here('kits/parts') && !here('projects/tools'), 'nothing got');
  assert.deepEqual(accepted(), {}, 'nothing allowed');
  assert.deepEqual(snapshot(), before, 'nothing in the home changed');
});

test('a need added between the look and the press: the offer changed, nothing is got', async () => {
  const look = await call('/api/pcsetup/project/needs', { name: 'shop', dryRun: true });
  const was = fs.readFileSync(shopJson, 'utf8');
  fs.writeFileSync(shopJson, pj({ name: 'shop', repos: [], memories: {}, needs: ['kits/parts', 'blog'] }));
  try {
    const r = await call('/api/pcsetup/project/needs', { name: 'shop', seen: look.json.seen });
    assert.equal(r.status, 409, JSON.stringify(r.json));
    assert.equal(r.json.error, 'This changed since you looked: look again.');
    assert.ok(!here('kits/parts') && !here('projects/blog'), 'nothing got');
    assert.deepEqual(accepted(), {});
  } finally {
    fs.writeFileSync(shopJson, was);
  }
});

test('his press "Get them too": each need by the same get, allowed on this computer, its own setup never answered', async () => {
  const look = await call('/api/pcsetup/project/needs', { name: 'shop', dryRun: true });
  const r = await call('/api/pcsetup/project/needs', { name: 'shop', seen: look.json.seen });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.started, true);
  const j = await jobEnd();
  assert.equal(j.kind, 'get-needs');
  assert.equal(j.result.ok, true, JSON.stringify(j));
  assert.deepEqual(j.result.data.got, [{ name: 'kits/parts', ok: true, result: 'cloned' }, { name: 'tools', ok: true, result: 'cloned' }]);
  assert.ok(here('kits/parts') && here('projects/tools'), 'both are here now');
  assert.deepEqual(accepted(), { shop: ['kits/parts'], 'kits/parts': ['tools'] }, 'the same yes as the terminal\'s');
  const text = j.lines.join('\n');
  assert.match(text, /allowed on this computer: shop reads kits\/parts, kits\/parts reads tools/);
  assert.doesNotMatch(text, /yes \(--yes\)/, 'no setup question of a need is answered');
  assert.ok(!fs.existsSync(path.join(C.ws, 'kits', 'parts', 'node_modules')), 'no install of the need ran');
  // tools names blog in its own project.json: a new offer, never got without another press.
  assert.ok(!here('projects/blog'), 'blog is not got by the same press');
  const next = j.result.data.more.find((v) => v.project === 'tools');
  assert.ok(next, JSON.stringify(j.result.data.more));
  assert.deepEqual(next.missing, [{ name: 'blog' }]);
  assert.ok(next.lines.includes('tools also needs, to read: blog. It is not on this computer.'), JSON.stringify(next.lines));
  // parts names shop as a need: a loop, shop is never offered again.
  assert.ok(!j.result.data.more.some((v) => v.missing.some((x) => x.name === 'shop')));
  // His second press, on that offer, brings blog.
  const r2 = await call('/api/pcsetup/project/needs', { name: 'tools', seen: next.seen });
  assert.equal(r2.status, 200, JSON.stringify(r2.json));
  const j2 = await jobEnd();
  assert.equal(j2.result.ok, true, JSON.stringify(j2));
  assert.ok(here('projects/blog'));
  const after = await call('/api/pcsetup/project/needs', { name: 'shop', dryRun: true });
  assert.equal(after.json.ask, false, JSON.stringify(after.json));
  assert.ok(after.json.lines.some((l) => /^every session in shop reads kits\/parts/.test(l)));
});
