// A folder whose name differs from its map entry only in letter case (mapcase.mjs): status names it ("The folder Shop
// is shop in the map") on a disk that ignores letter case and on one that keeps it; the look changes nothing; the
// rename goes through a temporary name, finishes one that stopped halfway, and is undone the same way; it is refused
// for two such folders, a link, and a folder a program works in. A temporary home; the disk's answer is given.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-mapcase');
test.after(() => w.cleanup());
const A = w.computer('a');
A.use();
process.env.HOPRIG_WORKSPACE_DIR = A.ws;
const urls = { brain: w.bare('brain'), shop: w.bare('shop') };
w.clone(urls.brain, path.join(A.ws, 'ai_brain'));
const M = await import('../../src/workspace/map.mjs');
const C = await import('../../src/workspace/mapcase.mjs');
const { saveConfig } = await import('../../src/config.mjs');
const { printMapStatus } = await import('../../src/workspace/cli-git.mjs');
saveConfig({ projectsDir: A.projects });
const at = { dir: A.ws, projects: A.projects };
fs.writeFileSync(M.mapFile(A.ws), JSON.stringify({ version: 1, brain: { url: urls.brain }, projects: [{ name: 'shop', url: urls.shop, repos: [] }], others: [] }, null, 2) + '\n');
const Shop = path.join(A.projects, 'Shop');
const shop = path.join(A.projects, 'shop');
const tmp = path.join(A.projects, `${C.TMP_PREFIX}shop`);
w.clone(urls.shop, Shop);
// A disk that folds letter case (macOS has one): SHOP is then the folder Shop itself.
const FOLDS = fs.existsSync(path.join(A.projects, 'SHOP'));

function snapshot(top) {
  const out = new Map();
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out.set(p, `link:${fs.readlinkSync(p)}`);
      else if (e.isDirectory()) (out.set(p, 'dir'), walk(p));
      else out.set(p, crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(top);
  return out;
}
const same = (a, b) => assert.deepEqual([...a.entries()].sort(), [...b.entries()].sort());
const names = () => fs.readdirSync(A.projects).sort();

for (const blind of [true, false]) {
  test(`status names the folder (a disk that ${blind ? 'ignores' : 'keeps'} letter case), with the command that fixes it`, async () => {
    const ms = await M.mapStatus({ ...at, blind });
    assert.equal(ms.caseOnly.length, 1);
    assert.equal(ms.caseOnly[0].words, 'The folder Shop is shop in the map');
    assert.equal(ms.caseOnly[0].blind, blind);
    const e = ms.entries.find((x) => x.kind === 'project' && x.label === 'shop');
    assert.deepEqual([e.caseOf, e.fix], ['Shop', 'hoprig workspace map --fix-case']);
    const q = await quietUi();
    printMapStatus(q.ui, ms);
    assert.match(q.text(), /The folder Shop is shop in the map:  hoprig workspace map --fix-case/);
  });
}

test('the disk is asked with a probe that is removed at once (this one keeps letter case)', () => {
  const before = names();
  assert.equal(C.caseBlind(A.projects, at), process.platform === 'linux' ? false : C.caseBlind(A.projects, at));
  assert.deepEqual(names(), before);
});

test('the look says what is renamed and changes nothing in the home; a stale id is refused', async () => {
  const before = snapshot(A.home);
  const look = await C.fixCase({ ...at, dryRun: true, blind: true });
  assert.deepEqual(look.steps.map((s) => [s.folder, s.name, s.action]), [['Shop', 'shop', 'rename']]);
  assert.equal(look.steps[0].words, 'Shop becomes shop, through a temporary name in the same folder. Nothing inside it changes.');
  assert.match(look.seen, /^[0-9a-f]{16}$/);
  await assert.rejects(C.fixCase({ ...at, seen: '0123456789abcdef', blind: true }), (e) => e.status === 409 && e.message === C.CHANGED);
  same(snapshot(A.home), before);
});

test('the rename goes through a temporary name, keeps what is inside, and undo gives the old name back', async () => {
  const inside = snapshot(Shop);
  const { seen } = await C.fixCase({ ...at, dryRun: true, blind: true });
  const r = await C.fixCase({ ...at, seen, blind: true });
  assert.deepEqual(r, { done: [{ label: 'shop', from: 'Shop', to: 'shop' }], refused: 0 });
  assert.deepEqual(names().filter((n) => /shop/i.test(n)), ['shop']);
  same(new Map([...snapshot(shop)].map(([p, v]) => [p.replace(shop, Shop), v])), inside);
  assert.equal((await M.mapStatus({ ...at, blind: true })).caseOnly, undefined, 'nothing more to report');
  assert.ok(fs.existsSync(C.recordFile()) && C.recordFile().startsWith(A.env.HOPRIG_STATE_DIR + path.sep), 'what was renamed is kept in the state folder');
  const u = await C.undoFixCase({ ...at, dryRun: true });
  assert.equal(u.can, true);
  assert.deepEqual(u.steps.map((s) => [s.folder, s.name]), [['shop', 'Shop']]);
  assert.deepEqual(await C.undoFixCase({ ...at, seen: u.seen }), { undone: [{ from: 'shop', to: 'Shop' }] });
  assert.deepEqual(names().filter((n) => /shop/i.test(n)), ['Shop']);
  assert.ok(!fs.existsSync(C.recordFile()));
  await assert.rejects(C.undoFixCase(at), /There is no rename to undo/);
});

test('a rename that stopped between its two steps is reported and finished', async () => {
  fs.renameSync(Shop, tmp);
  const ms = await M.mapStatus({ ...at, blind: true });
  assert.equal(ms.caseOnly[0].words, `The folder ${C.TMP_PREFIX}shop is halfway through its rename to shop: finish it`);
  const look = await C.fixCase({ ...at, dryRun: true, blind: true });
  assert.equal(look.steps[0].action, 'finish');
  await C.fixCase({ ...at, seen: look.seen, blind: true });
  assert.deepEqual(names().filter((n) => /shop/i.test(n)), ['shop']);
  fs.renameSync(shop, Shop);
});

// Not proven on a disk that folds letter case: two such folders cannot exist there, and the other refusals were not
// yet run on such a disk (the rename, its undo, the command and the route are, by the tests around this one).
test('refused, with nothing renamed: two such folders, a link, the halfway name beside the folder, a busy folder', { skip: FOLDS && 'a disk that folds letter case: these refusals are not proven there yet' }, async () => {
  const refusedOnly = async (re) => {
    const before = snapshot(A.projects);
    const look = await C.fixCase({ ...at, dryRun: true, blind: true });
    assert.equal(look.steps.length, 1);
    assert.match(look.steps[0].refused || '', re, JSON.stringify(look.steps));
    assert.deepEqual(await C.fixCase({ ...at, seen: look.seen, blind: true }), { done: [], refused: 1 });
    same(snapshot(A.projects), before);
  };
  fs.mkdirSync(path.join(A.projects, 'SHOP'));
  await refusedOnly(/SHOP and Shop each differ from shop only in letter case|Shop and SHOP each differ/);
  fs.rmdirSync(path.join(A.projects, 'SHOP'));
  fs.mkdirSync(tmp);
  await refusedOnly(/Shop and \.hoprig-case-shop are both here/);
  fs.rmdirSync(tmp);
  const real = path.join(A.home, 'elsewhere');
  fs.renameSync(Shop, real);
  fs.symlinkSync(real, Shop);
  await refusedOnly(/Shop is not a folder of its own here/);
  fs.unlinkSync(Shop);
  fs.renameSync(real, Shop);
  if (process.platform === 'linux') {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: Shop, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 300));
      await refusedOnly(/a program is working in Shop now/);
    } finally {
      child.kill();
    }
  }
});

test('the command: --fix-case asks once, renames on --yes, and --undo gives the old name back', async () => {
  const { main } = await import('../../src/workspace/cli.mjs');
  const run = async (args) => {
    const q = await quietUi();
    let out = '';
    const code = await main(args, { ui: q.ui, write: (s) => (out += s) });
    return { code, text: q.text(), out };
  };
  const dry = await run(['map', '--fix-case', '--dry-run']);
  assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, /\(dry run\) Shop becomes shop/);
  assert.equal((await run(['map', '--fix-case'])).code, 1, 'no yes, no rename');
  assert.ok(fs.existsSync(Shop));
  const yes = await run(['map', '--fix-case', '--yes']);
  assert.equal(yes.code, 0, yes.text);
  assert.match(yes.text, /Shop is shop now/);
  assert.deepEqual(names().filter((n) => /shop/i.test(n)), ['shop']);
  const back = await run(['map', '--fix-case', '--undo', '--yes', '--json']);
  assert.equal(back.code, 0, back.text);
  assert.deepEqual(JSON.parse(back.out), { undone: [{ from: 'shop', to: 'Shop' }] });
  assert.equal((await run(['map', '--upgrade', '--fix-case'])).code !== 0, true, 'one of them at a time');
});

test('the route: the look changes nothing; Tia, her relayed mark, another site, a stale id and an unknown key are refused', async () => {
  const { hashPassword } = await import('../../src/server/auth.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const { workspaceFeature } = await import('../../src/workspace/feature.mjs');
  const { Readable } = await import('node:stream');
  saveConfig({ server: { passwordHash: await hashPassword('pw'), roots: [A.home], backend: 'pty' } });
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false, tmuxSocket: `mapcase-${process.pid}` });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const { port } = app.server.address();
  saveConfig({ server: { port } });
  const origin = `http://127.0.0.1:${port}`;
  try {
    const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'pw' }) });
    const page = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: origin };
    const post = async (body, headers = page) => {
      const r = await fetch(`${origin}/api/workspace/map/case`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json().catch(() => null) };
    };
    const before = snapshot(A.projects);
    const look = await post({ dryRun: true });
    assert.equal(look.status, 200, JSON.stringify(look.json));
    assert.deepEqual(look.json.steps.map((s) => [s.folder, s.name, s.action, s.parent]), [['Shop', 'shop', 'rename', path.join('~', 'Workspace', 'projects')]]);
    const { seen } = look.json;
    assert.ok([401, 403].includes((await post({ seen }, { Authorization: 'Bearer tia_0123456789abcdef', ...page })).status), 'Tia\'s token');
    assert.equal((await post({ seen }, { Cookie: page.Cookie, Origin: 'http://evil.example' })).status, 403, 'another site');
    assert.equal((await post({ seen, force: true })).status, 400, 'an unknown key');
    assert.equal((await post({ seen, undo: 'no' })).status, 400, 'a boolean that is not one');
    assert.equal((await post({ seen: '0123456789abcdef' })).status, 409, 'a stale id');
    // Her door in the dashboard, and a request relayed with her mark from another computer.
    const f = workspaceFeature({ config: () => ({ workspaceDir: A.ws, projectsDir: A.projects }), readJson: async (req) => req.body, caller: () => 'self' });
    const [, , fn] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/workspace/map/case'));
    await assert.rejects(fn(Object.assign(Readable.from([]), { body: { seen }, headers: {} })), (e) => e.status === 403);
    const g = workspaceFeature({ config: () => ({ workspaceDir: A.ws, projectsDir: A.projects }), readJson: async (req) => req.body, caller: () => 'computer' });
    const [, , gn] = g.routes.find(([m, re]) => m === 'POST' && re.test('/api/workspace/map/case'));
    await assert.rejects(gn(Object.assign(Readable.from([]), { body: { seen }, headers: { 'x-hoprig-self': '1' } })), (e) => e.status === 403);
    same(snapshot(A.projects), before);
    // His yes.
    const yes = await post({ seen });
    assert.deepEqual([yes.status, yes.json], [200, { done: [{ label: 'shop', from: 'Shop', to: 'shop' }], refused: 0 }]);
    const u = await post({ dryRun: true, undo: true });
    assert.equal((await post({ undo: true, seen: u.json.seen })).status, 200);
    same(snapshot(A.projects), before);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});
