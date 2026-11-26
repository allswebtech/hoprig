// A group's own command on the Workspace page (toolweb.mjs), over real HTTP on a temporary home: GET names the
// waiting command with short paths only; the dry run shows what the yes makes and changes nothing in the home; the
// yes is the owner's own page only (Tia's token, her door, a relayed request with her mark, a script's token and
// another site are refused, also with a correct `seen`); a file changed between the sheet and the press is refused
// with one plain sentence; the yes makes exactly the launcher the command makes, and Remove takes it away again.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

// Windows gets no launcher for a group's tool (allowTool refuses there); the tests that make one are for macOS and Linux.
const NO_LAUNCHER = { skip: process.platform === 'win32' && 'a group\'s tool gets no launcher on Windows' };

const w = gitWorld('ws-toolweb');
const C = w.computer('t');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const bin = path.join(C.home, '.local', 'bin');
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(path.join(bin, 'hoprig'), '#!/bin/sh\n# hoprig-command-wrapper\nexit 0\n', { mode: 0o755 });
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;

const seed = w.clone(w.bare('kits'), path.join(w.root, 'seed-kits'));
fs.writeFileSync(path.join(seed, 'kit.sh'), '#!/bin/sh\necho kit\n', { mode: 0o755 });
w.sh(seed, 'add', '-A');
w.sh(seed, 'commit', '-q', '-m', 'kits');
w.sh(seed, 'push', '-q', 'origin', 'main');
w.bare('brain');
w.clone(w.url('brain'), path.join(C.ws, 'ai_brain'));
const kits = w.clone(w.url('kits'), path.join(C.ws, 'kits'));
const M = await import('../../src/workspace/map.mjs');
M.writeMap({ version: 2, brain: { url: w.url('brain') }, projects: [], others: [], groups: [{ dir: 'kits', url: w.url('kits'), tool: { name: 'kit', run: 'kit.sh', needs: ['git', 'no-such-program-here'] } }] }, C.ws);

const { saveConfig, loadConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createToken } = await import('../../src/machines/tokens.mjs');
const { OWNER_PAGE_HEADER, SELF_HEADER } = await import('../../src/machines/relay.mjs');
const { createServer } = await import('../../src/server/server.mjs');
saveConfig({ projectsDir: C.projects, server: { passwordHash: await hashPassword('pw'), roots: [C.home], backend: 'pty' } });
const script = createToken('a script');
const hub = createToken('hub');
fs.writeFileSync(path.join(C.env.HOPRIG_CONFIG_DIR, 'joined.json'), JSON.stringify({ hubs: [{ id: '0123456789ab', target: 'alex@box2', port: 7433, tokenId: hub.id }] }));
const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `toolweb-${process.pid}` });
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
const launcher = path.join(bin, 'kit');

/** Every file and link of the home with what it holds; the dashboard's own records of sign-ins and of each token's
 * last use change with every request, whatever the route does. */
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

test('GET /api/workspace/tools names the waiting command, what it needs, with short paths only', async () => {
  const r = await call('/api/workspace/tools');
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json.tools, [{ group: 'kits', name: 'kit', run: 'kit.sh', file: path.join('~', 'Workspace', 'kits', 'kit.sh'), launcher: path.join('~', '.local', 'bin', 'kit'), state: 'waits', missing: [{ program: 'no-such-program-here' }] }]);
  assert.ok(!JSON.stringify(r.json).includes(C.home), 'no full path of the home');
  assert.equal((await call('/api/workspace/tools', undefined, bearer('tia_0123456789abcdef'))).status, 401, 'Tia\'s token');
});

test('the yes: refused from Tia, her mark, a script, a hub without the mark and another site, also with a correct seen', NO_LAUNCHER, async () => {
  const before = snapshot();
  const look = await call('/api/workspace/tools/allow', { group: 'kits', dryRun: true });
  assert.equal(look.status, 200, JSON.stringify(look.json));
  assert.deepEqual({ ...look.json, seen: undefined }, { group: 'kits', name: 'kit', run: 'kit.sh', url: w.url('kits'), file: '~/Workspace/kits/kit.sh', launcher: '~/.local/bin/kit', onPath: true, dryRun: true, seen: undefined });
  assert.match(look.json.seen, /^[0-9a-f]{64}$/);
  assert.deepEqual(snapshot(), before, 'the dry run changed nothing in the home');
  const yes = { group: 'kits', seen: look.json.seen };
  for (const h of [bearer('tia_0123456789abcdef'), { ...page, ...bearer('tia_0123456789abcdef') }, bearer(script.token), bearer(script.token, { [OWNER_PAGE_HEADER]: '1' }), bearer(hub.token), bearer(hub.token, { [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' }), { Cookie: cookie, Origin: 'http://evil.example' }, {}]) {
    const r = await call('/api/workspace/tools/allow', yes, h);
    assert.ok([401, 403].includes(r.status), `${JSON.stringify(h)}: ${r.status} ${JSON.stringify(r.json)}`);
  }
  for (const h of [bearer(script.token), bearer(hub.token, { [SELF_HEADER]: '1', [OWNER_PAGE_HEADER]: '1' })]) {
    assert.equal((await call('/api/workspace/tools/remove', { group: 'kits' }, h)).status, 403);
  }
  assert.equal((await call('/api/workspace/tools/allow', { ...yes, force: true })).status, 400, 'an unknown key');
  assert.equal((await call('/api/workspace/tools/allow', { ...yes, dryRun: 'yes' })).status, 400, 'a boolean that is not one');
  assert.equal((await call('/api/workspace/tools/allow', { group: 'kits' })).status, 400, 'no seen');
  assert.equal((await call('/api/workspace/tools/allow', { group: 'kits', seen: '0'.repeat(64) })).json.error, 'This changed since you looked: look again.', 'a stale seen');
  assert.ok(!fs.existsSync(launcher), 'no launcher');
  assert.deepEqual(snapshot(), before, 'nothing in the home changed');
});

test('Tia\'s own call in the dashboard (not over HTTP) is refused, with a correct seen', NO_LAUNCHER, async () => {
  const { Readable } = await import('node:stream');
  const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
  const f = workspaceFeature({ config: () => loadConfig(), readJson: async (req) => req.body, caller: () => 'self' });
  const fn = (p) => f.routes.find(([m, re]) => m === 'POST' && re.test(p))[2];
  const seen = (await fn('/api/workspace/tools/allow')(Object.assign(Readable.from([]), { body: { group: 'kits', dryRun: true }, headers: {} }))).seen;
  await assert.rejects(fn('/api/workspace/tools/allow')(Object.assign(Readable.from([]), { body: { group: 'kits', seen }, headers: {} })), (e) => e.status === 403 && /owner's own step/.test(e.message));
  assert.ok(!fs.existsSync(launcher));
});

test('a file changed between the sheet and the press is refused; the yes makes the command\'s own launcher; Remove takes it away', NO_LAUNCHER, async () => {
  const look = await call('/api/workspace/tools/allow', { group: 'kits', dryRun: true });
  fs.writeFileSync(path.join(kits, 'kit.sh'), '#!/bin/sh\necho changed\n', { mode: 0o755 });
  const stale = await call('/api/workspace/tools/allow', { group: 'kits', seen: look.json.seen });
  assert.deepEqual([stale.status, stale.json.error], [409, 'This changed since you looked: look again.']);
  assert.ok(!fs.existsSync(launcher));
  w.sh(kits, 'checkout', '--', 'kit.sh');
  const again = await call('/api/workspace/tools/allow', { group: 'kits', dryRun: true });
  const before = new Map(snapshot());
  const r = await call('/api/workspace/tools/allow', { group: 'kits', seen: again.json.seen });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.made, true);
  const { launcherText } = await import('../../src/workspace/grouptool.mjs');
  assert.equal(fs.readFileSync(launcher, 'utf8'), launcherText('kits'), 'the launcher the command makes');
  assert.deepEqual(loadConfig().groupTools, { kits: { name: 'kit', run: 'kit.sh', url: w.url('kits') } });
  // Only the launcher is new, and only the settings file changed.
  const after = new Map(snapshot());
  const changed = [...after.keys()].filter((p) => before.get(p) !== after.get(p)).sort();
  const { configFile } = await import('../../src/paths.mjs');
  assert.deepEqual(changed, [launcher, configFile()].sort());
  assert.equal((await call('/api/workspace/tools')).json.tools[0].state, 'made');
  // Remove: its dry run names the launcher and removes nothing; then it goes, and the yes with it.
  const dry = await call('/api/workspace/tools/remove', { group: 'kits', dryRun: true });
  assert.deepEqual(dry.json, { group: 'kits', name: 'kit', removed: ['~/.local/bin/kit'], dryRun: true });
  assert.ok(fs.existsSync(launcher));
  const rm = await call('/api/workspace/tools/remove', { group: 'kits' });
  assert.deepEqual(rm.json, { group: 'kits', name: 'kit', removed: ['~/.local/bin/kit'], dryRun: false });
  assert.ok(!fs.existsSync(launcher));
  assert.equal((loadConfig().groupTools || {}).kits, undefined);
  assert.equal((await call('/api/workspace/tools')).json.tools[0].state, 'waits');
  assert.equal(w.sh(kits, 'status', '--porcelain'), '', 'nothing written into the group\'s repository');
});
