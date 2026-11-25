// The map's upgrade from the Workspace page (POST /api/workspace/map/upgrade, mapundo.mjs): the look is upgradeMap's
// dry run in plain words with an id, and changes nothing in the home; the yes is the owner's own page only, refused
// to Tia's token, another site, an unknown key and a plan id that is not the plan now; it writes version 2 and keeps
// the old text in Hoprig's state folder; undo puts it back only while the map is what the upgrade wrote. A temporary
// home with a version-1 map, compared whole before and after.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-upgradeweb');
test.after(() => w.cleanup());
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;

const urls = { brain: w.bare('brain'), app: w.bare('app'), web: w.bare('app-web') };
w.clone(urls.brain, path.join(A.ws, 'ai_brain'));
const app = w.clone(urls.app, path.join(A.projects, 'app'));
const web = w.clone(urls.web, path.join(app, 'code', 'app-web'));
w.sh(web, 'worktree', 'add', '-q', '-b', 'try', path.join(app, 'code', 'app-web-wt'));
const v1 = {
  version: 1,
  brain: { url: urls.brain },
  projects: [{ name: 'app', url: urls.app, repos: [{ dir: 'code/app-web', url: urls.web }, { dir: 'code/app-web-wt', url: urls.web }] }],
  others: [],
};

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');
const M = await import('../../src/workspace/map.mjs');
const U = await import('../../src/workspace/mapundo.mjs');
const file = M.mapFile(A.ws);
const V1_TEXT = JSON.stringify(v1, null, 2) + '\n';
fs.writeFileSync(file, V1_TEXT);

/** Every file and link under `top` with what it holds. The dashboard's own sign-in record and the brain lock's file
 * are left out: they change with every signed-in request or every locked call, whatever the route does. */
const SIGNINS = path.join(A.env.HOPRIG_STATE_DIR, 'web-sessions.json');
const LOCKS = path.join(A.env.HOPRIG_STATE_DIR, 'work-locks');
function snapshot(top) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === SIGNINS || p === LOCKS) continue;
      if (e.isSymbolicLink()) out.set(p, `link:${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) walk(p);
      else out.set(p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(top);
  return out;
}
const same = (a, b) => assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());

let app2;
let origin;
let page;
const post = async (body, headers = page) => {
  const r = await fetch(`${origin}/api/workspace/map/upgrade`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};

test.before(async () => {
  saveConfig({ projectsDir: A.projects, server: { passwordHash: await hashPassword('pw'), roots: [A.home], backend: 'pty' } });
  app2 = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `upgradeweb-${process.pid}` });
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const { port } = app2.server.address();
  saveConfig({ server: { port } });
  origin = `http://127.0.0.1:${port}`;
  const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
  page = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin };
});
test.after(() => new Promise((r) => app2.server.close(r)));

test('the look: the entries that leave, that nothing on disk changes, every upgradeWords line, an id; nothing changes', async () => {
  const before = snapshot(A.home);
  const look = await post({ dryRun: true });
  assert.equal(look.status, 200, JSON.stringify(look.json));
  assert.deepEqual(look.json.dropped, ['app/code/app-web-wt']);
  assert.equal(look.json.from, 1);
  assert.equal(look.json.to, 2);
  assert.match(look.json.seen, /^[0-9a-f]{16}$/);
  const { upgradeMap, upgradeWords } = await import('../../src/workspace/mapupgrade.mjs');
  for (const l of upgradeWords(upgradeMap({ dir: A.ws, projects: A.projects, dryRun: true }))) assert.ok(look.json.lines.includes(l), `the look says: ${l}`);
  assert.ok(look.json.lines.some((l) => /^app\/code\/app-web-wt leaves the map: its folder here is a second checkout/.test(l)));
  assert.ok(look.json.lines.some((l) => /^Nothing on disk changes/.test(l)));
  assert.deepEqual(look.json.undo, U.UNDO_WORDS);
  same(snapshot(A.home), before);
  // The same look twice gives the same id.
  assert.equal((await post({ dryRun: true })).json.seen, look.json.seen);
});

test('the yes is refused to Tia, another site, an unknown key and a stale id, and then nothing changed', async () => {
  const before = snapshot(A.home);
  const { seen } = (await post({ dryRun: true })).json;
  assert.ok([401, 403].includes((await post({ seen }, { Authorization: 'Bearer tia_0123456789abcdef', ...page })).status), 'Tia\'s token');
  assert.ok([401, 403].includes((await post({ seen }, { Cookie: page.Cookie, Origin: 'http://evil.example' })).status), 'another site');
  assert.equal((await post({ seen, force: true })).status, 400, 'an unknown key');
  assert.equal((await post({ seen, dryRun: 'yes' })).status, 400, 'a boolean that is not one');
  assert.equal((await post({ seen: '../x' })).status, 400, 'an id that is no id');
  const stale = await post({ seen: '0123456789abcdef' });
  assert.deepEqual([stale.status, stale.json.error], [409, U.CHANGED]);
  assert.equal((await post({})).status, 409, 'no id at all: never upgraded without the look');
  same(snapshot(A.home), before);
});

test('Tia\'s own call in the dashboard (not over HTTP) is refused, also for undo', async () => {
  const { Readable } = await import('node:stream');
  const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
  const f = workspaceFeature({ config: () => ({ workspaceDir: A.ws, projectsDir: A.projects }), readJson: async (req) => req.body, caller: () => 'self' });
  const [, , fn] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/workspace/map/upgrade'));
  const { seen } = U.upgradePlan({ dir: A.ws, projects: A.projects });
  for (const body of [{ seen }, { undo: true }]) await assert.rejects(fn(Object.assign(Readable.from([]), { body, headers: {} })), (e) => e.status === 403 && /owner's own step/.test(e.message));
  assert.equal(fs.readFileSync(file, 'utf8'), V1_TEXT);
});

test('his yes writes version 2 and keeps the old text in the state folder only; undo puts it back exactly', async () => {
  const before = snapshot(A.home);
  const { seen } = (await post({ dryRun: true })).json;
  const yes = await post({ seen });
  assert.deepEqual([yes.status, yes.json], [200, { done: true, from: 1, to: 2, dropped: ['app/code/app-web-wt'], undo: true }]);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(m.version, 2);
  assert.deepEqual(m.projects[0].repos.map((r) => r.dir), ['code/app-web']);
  // File by file: the map changed, the kept copy is new and lies in the state folder; nothing else.
  const after = snapshot(A.home);
  const kept = U.keptFile();
  assert.ok(kept.startsWith(A.env.HOPRIG_STATE_DIR + path.sep), 'kept in Hoprig\'s state folder');
  assert.equal(JSON.parse(fs.readFileSync(kept, 'utf8')).text, V1_TEXT);
  const others = (s) => [...s.entries()].filter(([p]) => p !== file && p !== kept).sort();
  assert.deepEqual(others(after), others(before));
  assert.ok(!before.has(kept) && after.has(kept));
  assert.equal((await post({ dryRun: true })).json.already, true, 'nothing more to upgrade');
  // Undo: its look first, then the yes.
  const u = await post({ dryRun: true, undo: true });
  assert.equal(u.json.can, true);
  const back = await post({ undo: true, seen: u.json.seen });
  assert.deepEqual([back.status, back.json], [200, { undone: true, version: 1 }]);
  assert.equal(fs.readFileSync(file, 'utf8'), V1_TEXT, 'the old text, byte for byte');
  assert.ok(!fs.existsSync(kept), 'the kept copy goes after a good undo');
  same(snapshot(A.home), before);
  assert.equal((await post({ dryRun: true, undo: true })).json.can, false);
  assert.equal((await post({ undo: true })).status, 409, 'nothing to undo');
});

test('undo is refused when the map changed since the upgrade, and the map stays as it is', async () => {
  fs.writeFileSync(file, V1_TEXT);
  const { seen } = (await post({ dryRun: true })).json;
  assert.equal((await post({ seen })).status, 200);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.skip = ['old'];
  M.writeMap(m, A.ws);
  const changed = fs.readFileSync(file, 'utf8');
  const look = await post({ dryRun: true, undo: true });
  assert.equal(look.json.can, false);
  assert.match(look.json.why, /The map changed since the upgrade/);
  const r = await post({ undo: true });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /The map changed since the upgrade/);
  assert.equal(fs.readFileSync(file, 'utf8'), changed);
});

test('the command: --upgrade keeps the old map, --undo puts it back (the same function as the page\'s Undo)', async () => {
  fs.rmSync(U.keptFile(), { force: true });
  fs.writeFileSync(file, V1_TEXT);
  const { main } = await import('../../src/workspace/cli.mjs');
  const run = async (args) => {
    const q = await quietUi();
    let out = '';
    const code = await main(args, { ui: q.ui, write: (s) => (out += s) });
    return { code, text: q.text(), out };
  };
  assert.equal((await run(['map', '--undo'])).code, 1, 'nothing to undo yet');
  const up = await run(['map', '--upgrade', '--yes']);
  assert.equal(up.code, 0, up.text);
  assert.match(up.text, /hoprig workspace map --undo puts it back/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
  const look = await run(['map', '--undo', '--dry-run']);
  assert.equal(look.code, 0, look.text);
  assert.match(look.text, /would put the old map back: nothing was written/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2, 'a dry run writes nothing');
  const back = await run(['map', '--undo', '--json']);
  assert.equal(back.code, 0, back.text);
  assert.deepEqual(JSON.parse(back.out), { undone: true, version: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), V1_TEXT);
  assert.equal((await run(['map', '--upgrade', '--undo'])).code !== 0, true, 'one of them at a time');
});
