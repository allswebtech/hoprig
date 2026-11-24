// "Also open" through the dashboard's own routes (src/server/server.mjs): GET /api/folders/extras says what may be
// opened beside a session in a folder and the project's own needs; POST /api/sessions and POST /api/chats take
// `with`, and every name from a browser goes through the one decision (workspace/needs.mjs extraFolder) on the
// server: the credentials folder, the brain, a path, a name not here are refused before anything starts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { needsWorld } from './needsfix.mjs';

const w = needsWorld('needs-route', { shopNeeds: ['kits/parts', 'docs'] });
process.env.HOPRIG_WORKSPACE_DIR = w.ws;
for (const k of ['HOPRIG_RUN_FILE', 'HOPRIG_TERM_ID']) delete process.env[k];
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { writeProfile } = await import('../../src/profiles.mjs');
const { createServer } = await import('../../src/server/server.mjs');
saveConfig({ claudeBin: '/bin/false', usage: false, server: { passwordHash: await hashPassword('right-password'), roots: [w.ws] }, automation: { enabled: false } });
writeProfile('alpha', {});
const made = [];
let terms = [];
const backend = { list: async () => terms, capture: async () => '', kind: 'pty', capabilities: {}, create: async (o) => (made.push(o), { name: o.name, id: o.name }) };
const app = createServer({ backend, watch: false });
const { port } = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;
test.after(async () => {
  await app.close();
  w.cleanup();
});
const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
const cookie = login.headers.get('set-cookie').split(';')[0];
async function call(p, body) {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: base, Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, json: JSON.parse(text || '{}') };
}
const launchArgv = (o) => {
  const i = o.argv.indexOf('--launch');
  return i < 0 ? o.argv : JSON.parse(fs.readFileSync(o.argv[i + 1], 'utf8')).argv;
};

test('GET /api/folders/extras: the choices beside shop, its own needs shown as included', async () => {
  const r = await call(`/api/folders/extras?${new URLSearchParams({ path: w.shop })}`);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.project, 'shop');
  assert.deepEqual(r.json.needs, [{ name: 'kits/parts', here: true, accepted: true }, { name: 'docs', here: false, accepted: true, fix: 'hoprig get docs' }]);
  assert.deepEqual(r.json.choices, ['blog']);
  assert.ok(!JSON.stringify(r.json).includes(w.ws), 'map names only, no paths');
  assert.equal((await call(`/api/folders/extras?${new URLSearchParams({ path: '/etc' })}`)).status, 404);
  // Before a project is chosen: every project that may be opened, none of its needs.
  const any = await call('/api/folders/extras');
  assert.deepEqual([any.json.project, any.json.needs, any.json.choices], [null, [], ['blog', 'kits/parts', 'shop']]);
});

test('POST /api/sessions with "with": checked on the server, passed to the launcher as --with', async () => {
  let r = await call('/api/sessions', { dir: w.shop, profile: 'alpha', mode: 'new', with: ['blog'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const argv = launchArgv(made.at(-1));
  const i = argv.indexOf('--with');
  assert.deepEqual(argv.slice(i, i + 2), ['--with', 'blog']);
  const before = made.length;
  for (const bad of [['credentials'], ['../credentials'], ['Credentials'], ['ai_brain'], [`${w.ws}/credentials`], ['kits/parts/'], ['docs'], ['tools'], ['kits'], 'blog', [1], Array.from({ length: 11 }, () => 'blog')]) {
    r = await call('/api/sessions', { dir: w.shop, profile: 'alpha', mode: 'new', with: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  // The session's own project ticked too: skipped (it is its folder already), never an extra folder.
  r = await call('/api/sessions', { dir: w.shop, profile: 'alpha', mode: 'new', with: ['shop', 'blog'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(launchArgv(made.at(-1)).filter((x, i, a) => a[i - 1] === '--with'), ['blog']);
  fs.mkdirSync(path.join(w.shop, 'sub'), { recursive: true });
  r = await call('/api/sessions', { dir: path.join(w.shop, 'sub'), profile: 'alpha', mode: 'new', with: ['shop'] });
  assert.equal(r.status, 400, 'a folder inside it is not its own folder: refused');
  r = await call('/api/sessions', { dir: w.shop, profile: 'alpha', mode: 'new', with: ['docs'] });
  assert.match(r.json.error, /hoprig get docs/);
  assert.equal(made.length, before + 1, 'nothing started for a refused name (one start above with shop and blog)');
});

test('POST /api/chats with "with": refused the same way; a good one is kept with the chat', async () => {
  for (const bad of [['credentials'], ['ai_brain'], ['docs'], ['../kits/parts']]) {
    const r = await call('/api/chats', { dir: w.shop, profile: 'alpha', with: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const r = await call('/api/chats', { dir: w.shop, profile: 'alpha', with: ['blog'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const chats = await call('/api/chats');
  const card = chats.json.chats.find((c) => c.chatId === r.json.id);
  assert.deepEqual(card.extras, ['blog'], 'its card names its extra folder before its first start');
});

test('a terminal session\'s card names its extra folders from its run record; OpenCode refuses "Also open"', async () => {
  const runs = path.join(process.env.HOPRIG_STATE_DIR, 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(runs, 'xs.json'), JSON.stringify({ runId: 'xs', pid: process.pid, profile: 'alpha', cwd: w.shop, termId: 'pty-dddddddddddd', tmuxPane: null, tool: 'claude', status: 'waiting', statusAt: now, startedAt: now, carryArgs: [], extras: ['kits/parts', 'blog'] }));
  terms = [{ id: 'pty-dddddddddddd', session: 'xs', cwd: w.shop, pid: 1, activity: now }];
  try {
    const st = await call('/api/state');
    const card = st.json.sessions.find((c) => c.name === 'xs');
    assert.deepEqual(card.extras, ['kits/parts', 'blog']);
    assert.ok(!JSON.stringify(card.extras).includes('/'.repeat(2)), 'map names, no paths');
  } finally {
    fs.rmSync(path.join(runs, 'xs.json'));
    terms = [];
  }
  const r = await call('/api/sessions', { tool: 'opencode', dir: w.shop, profile: 'alpha', mode: 'new', with: ['blog'] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /works with Claude Code only/);
});
