// The save sheet's key refusal has its own way through: the files the save refuses are moved out of the AI brain on
// the owner's press, to the folder beside the brain the sheet names, never deleted and never more than the sheet
// named. A file git keeps is also taken out of git (its removal staged). Refused: Tia's token, a call with no
// sign-in (a session's own call), another site, a path outside the brain, a link that leads out, a private folder, a
// file the server does not refuse. The only git server is a bare repository of this test's own; the home is a
// temporary one, compared whole before and after.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-brainmove');
const url = w.bare('ai_brain');
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const brain = w.clone(url, path.join(A.ws, 'ai_brain'));
const bareDir = path.join(w.server, 'team', 'ai_brain.git');
const KEY = `sk-ant-${'b7'.repeat(12)}`; // made up
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(brain, rel)), { recursive: true });
  fs.writeFileSync(path.join(brain, rel), text);
};
w.commit(brain, 'notes/learned.md', 'plain\n', 'add notes');
w.sh(brain, 'push', '-q');

const { moveOut } = await import('../../src/workspace/brainmove.mjs');
const { brainChanges, saveBrain } = await import('../../src/workspace/brainsave.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { createServer } = await import('../../src/server/server.mjs');

/** Every file and link under `top` with what it holds (a hash), the brain's own .git left out (its index changes). */
function snapshot(top) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (p === path.join(brain, '.git')) continue;
      if (e.isSymbolicLink()) out.set(p, `link:${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) walk(p);
      else out.set(p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(top);
  return out;
}

test('moved, never deleted: to the folder beside the brain, each keeping its path; nothing else in the home changes', async () => {
  write('.env', 'PORT=1\n'); // a key file by its name, new
  write('notes/learned.md', `the key is ${KEY}\n`); // git keeps it; it now holds a key
  write('notes/plain.md', 'nothing secret\n'); // goes up as usual: not moved
  const c = await brainChanges({ dir: A.ws });
  assert.deepEqual([c.secret.sort(), c.secretTracked], [['.env', 'notes/learned.md'], ['notes/learned.md']]);
  assert.equal(c.movedOut, path.join(A.ws, 'ai_brain-moved-out'), 'the sheet names the folder before the press');
  const before = snapshot(A.home);
  const r = await moveOut({ dir: A.ws, files: ['.env', 'notes/learned.md'], seen: c.moveSeen });
  const after = snapshot(A.home);
  const out = path.join(A.ws, 'ai_brain-moved-out');
  assert.deepEqual(r.moved, [{ from: '.env', to: path.join(out, '.env') }, { from: 'notes/learned.md', to: path.join(out, 'notes', 'learned.md') }]);
  assert.deepEqual(r.untracked, ['notes/learned.md']);
  // Exactly the two files changed place, with what they held; nothing else appeared, went or changed.
  const expect = new Map(before);
  for (const m of r.moved) {
    expect.set(m.to, before.get(path.join(brain, m.from)));
    expect.delete(path.join(brain, m.from));
  }
  assert.deepEqual([...after.entries()].sort(), [...expect.entries()].sort());
  // Git: the kept file's removal is staged; the key-shaped files are no longer refused; the plain note still goes.
  assert.match(w.sh(brain, 'status', '--porcelain'), /^D {2}notes\/learned\.md$/m);
  const now = await brainChanges({ dir: A.ws });
  assert.deepEqual([now.secret, now.all, now.removed], [[], ['notes/plain.md'], ['notes/learned.md']]);
  const saved = await saveBrain({ dir: A.ws, seen: now.seen });
  assert.equal(saved.ok, true);
  const tree = w.sh(bareDir, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  assert.ok(tree.includes('notes/plain.md') && !tree.includes('notes/learned.md') && !tree.includes('.env'), tree.join(' '));
  assert.ok(fs.existsSync(path.join(out, 'notes', 'learned.md')), 'still on the disk, beside the brain');
});

test('a file of the same name in the folder beside is never replaced: " (2)" before its extension', async () => {
  const out = path.join(A.ws, 'ai_brain-moved-out');
  write('notes/learned.md', `again ${KEY}\n`);
  write('.env', 'PORT=2\n');
  write('id.pem', 'x\n');
  fs.writeFileSync(path.join(out, 'id.pem'), 'older\n');
  const r = await moveOut({ dir: A.ws, files: ['notes/learned.md', '.env', 'id.pem'], seen: (await brainChanges({ dir: A.ws })).moveSeen });
  assert.deepEqual(r.moved.map((m) => m.to), [path.join(out, 'notes', 'learned (2).md'), path.join(out, '.env (2)'), path.join(out, 'id (2).pem')]);
  assert.equal(fs.readFileSync(path.join(out, 'notes', 'learned.md'), 'utf8'), `the key is ${KEY}\n`, 'the first one is kept');
  assert.equal(fs.readFileSync(path.join(out, 'id.pem'), 'utf8'), 'older\n');
  assert.equal(fs.readFileSync(path.join(out, '.env'), 'utf8'), 'PORT=1\n');
});

test('refused before anything moves: a path outside, a link that leads out, a private folder, a file not refused', async () => {
  const outside = path.join(w.root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'id_rsa'), 'x\n');
  fs.symlinkSync(outside, path.join(brain, 'away'));
  fs.symlinkSync(path.join(outside, 'id_rsa'), path.join(brain, 'id_ed25519'));
  fs.mkdirSync(path.join(brain, 'no-ai'), { recursive: true });
  fs.writeFileSync(path.join(brain, 'no-ai', '.env'), 'PORT=3\n');
  write('keys.pem', 'x\n'); // refused by the save: may move, but not with a bad name beside it
  write('ok.md', 'plain\n');
  const before = snapshot(A.home);
  const cases = [
    [['../outside/id_rsa'], 400, /not a path inside the AI brain/],
    [[path.join(outside, 'id_rsa')], 400, /not a path inside the AI brain/],
    [['notes/../../outside/id_rsa'], 400, /not a path inside the AI brain/],
    [['away/id_rsa'], 409, /link that leads out/],
    [['id_ed25519'], 409, /is a link, not a file/],
    [['no-ai/.env'], 400, /private folder/],
    [['ignore/.env'], 400, /private folder/],
    [['ok.md'], 409, /not a file the save refuses/],
    [['keys.pem', 'ok.md'], 409, /ok\.md: not a file the save refuses/],
    [['keys.pem', 'no-ai/.env'], 400, /private folder/],
    [['gone.pem'], 409, /not in the AI brain any more/],
    [[], 400, /name the files/],
  ];
  const seen = (await brainChanges({ dir: A.ws })).moveSeen;
  for (const [files, status, re] of cases) {
    await assert.rejects(moveOut({ dir: A.ws, files, seen }), (e) => e.status === status && re.test(e.message) && /nothing was moved|name the files/.test(e.message), JSON.stringify(files));
  }
  assert.deepEqual([...snapshot(A.home).entries()].sort(), [...before.entries()].sort(), 'nothing moved, nothing changed');
  fs.rmSync(path.join(brain, 'away'));
  fs.rmSync(path.join(brain, 'id_ed25519'));
  fs.rmSync(path.join(brain, 'keys.pem'));
  fs.rmSync(path.join(brain, 'ok.md'));
});

test('the route: his own page only; refused to Tia\'s token, a call with no sign-in, another site; checked on the server', async () => {
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [A.home], backend: 'pty' } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `brainmove-${process.pid}` });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  saveConfig({ server: { port } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const page = { Cookie: cookie, Origin: origin };
    const post = async (body, headers) => {
      const r = await fetch(`${origin}/api/workspace/git/brain/moveout`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    write('door.key', 'x\n');
    write('fine.md', 'plain\n');
    const sheet = await (await fetch(`${origin}/api/workspace/git/brain`, { headers: { Cookie: cookie } })).json();
    assert.equal(sheet.movedOut, '~/Workspace/ai_brain-moved-out', 'the sheet names the folder, as a short path');
    const body = { files: ['door.key'], seen: sheet.moveSeen };
    assert.equal((await post(body, { Authorization: 'Bearer tia_0123456789abcdef' })).status, 401, 'Tia\'s token alone');
    assert.ok([401, 403].includes((await post(body, { Authorization: 'Bearer tia_0123456789abcdef', ...page })).status), 'Tia\'s token, also with the cookie');
    assert.ok([401, 403].includes((await post(body, {})).status), 'no sign-in, as a session\'s own call');
    assert.equal((await post(body, { Origin: origin })).status, 401, 'no sign-in, from the dashboard\'s own address');
    assert.equal((await post(body, { Cookie: cookie, Origin: 'http://evil.example' })).status, 403, 'another site');
    assert.equal((await post({ ...body, force: true }, page)).status, 400);
    assert.equal((await post({ ...body, files: 'door.key' }, page)).status, 400);
    assert.equal((await post({ ...body, files: ['../outside/id_rsa'] }, page)).status, 400, 'a path outside');
    assert.equal((await post({ ...body, files: ['no-ai/.env'] }, page)).status, 400, 'a private folder');
    assert.equal((await post({ ...body, files: ['fine.md'] }, page)).status, 409, 'a file the server does not refuse');
    assert.ok(fs.existsSync(path.join(brain, 'door.key')), 'none of those moved it');
    const ok = await post(body, page);
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.deepEqual(ok.json, { ok: true, folder: '~/Workspace/ai_brain-moved-out', moved: [{ from: 'door.key', to: '~/Workspace/ai_brain-moved-out/door.key' }], untracked: [] });
    assert.ok(!fs.existsSync(path.join(brain, 'door.key')) && fs.existsSync(path.join(A.ws, 'ai_brain-moved-out', 'door.key')));
    assert.ok(fs.existsSync(path.join(brain, 'fine.md')));
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

test('Tia\'s own call in the dashboard (not over HTTP) is refused', async () => {
  const { Readable } = await import('node:stream');
  const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
  let moves = 0;
  const f = workspaceFeature({ config: () => ({}), readJson: async (req) => req.body, caller: () => 'self' }, { moveOut: async () => (moves++, { folder: '', moved: [], untracked: [] }) });
  const [, , fn] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/workspace/git/brain/moveout'));
  await assert.rejects(fn(Object.assign(Readable.from([]), { body: { files: ['a.pem'], seen: 'a'.repeat(64) }, headers: {} })), (e) => e.status === 403 && /owner's own step/.test(e.message));
  assert.equal(moves, 0);
});

test('nothing moves by itself: only the workspace routes import it', () => {
  const src = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src');
  const users = fs.readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith('.mjs') && /(from\s+|import\()['"][./]*(workspace\/)?brainmove\.mjs['"]/.test(fs.readFileSync(path.join(src, f), 'utf8')));
  assert.deepEqual(users, ['workspace/feature.mjs']);
});

test.after(() => w.cleanup());
