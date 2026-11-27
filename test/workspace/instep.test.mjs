// Projects in step (src/workspace/instep.mjs): a light look that fetches and moves ONLY a clean branch that is only
// behind, in a place whose switch is on; everything else is left alone and said as one row. Nothing is pushed, merged,
// reset, rebased or stashed. A local "git server" and two computers (made-up labels); no network.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert, dropWorld, getOn, reset } from './dropfix.mjs';

const w = await dropWorld('instep', { labels: ['desk', 'peer'], group: true });
test.after(() => w.cleanup());
const [D, P] = w.computers;
const I = await import('../../src/workspace/instep.mjs');
const { repoInfo } = await import('../../src/pcsetup/workspace.mjs');
const api = path.join(D.shop, 'code', 'shop-api');
const peerApi = path.join(P.shop, 'code', 'shop-api');
const head = (d) => w.sh(d, 'rev-parse', 'HEAD');
const tmp = () => path.join(w.root, `looks-${Math.random().toString(36).slice(2)}.json`);
const none = () => false;
const on = { projects: true };
/** The peer pushes a commit of its own: this computer is one behind. */
let k = 0;
const peerPushes = (file = `peer${++k}.txt`, text = 'from the peer\n') => {
  w.commit(peerApi, file, text);
  w.sh(peerApi, 'push', '-q');
};
const look = (o = {}) => I.lookProjects({ dir: D.ws, projects: D.projects, ff: on, busy: none, file: tmp(), ...o });
const rowOf = (r, label = 'shop/code/shop-api') => r.items.find((i) => i.label === label);
async function fresh() {
  await reset(P);
  await reset(D);
  D.use();
}

test('a clean branch that is only behind is moved by the look; nothing is pushed; no row', async () => {
  await fresh();
  peerPushes();
  const before = head(api);
  const r = await look();
  assert.notEqual(head(api), before, 'moved');
  assert.equal(head(api), w.sh(path.join(w.server, 'team', 'shop-api.git'), 'rev-parse', 'main'));
  assert.equal(w.sh(path.join(w.server, 'team', 'shop-api.git'), 'rev-parse', 'main'), w.sh(peerApi, 'rev-parse', 'HEAD'), 'the server is where the peer left it');
  assert.equal(rowOf(r), undefined, 'nothing is off');
  assert.deepEqual(r.items, [], 'an empty list: nothing is shown');
  assert.deepEqual(r.moved.map((m) => m.label), ['shop/code/shop-api']);
  assert.equal(fs.readFileSync(path.join(api, `peer${k}.txt`), 'utf8'), 'from the peer\n');
});

test('the place\'s switch off: fetched, said behind, not moved; the page data counts it behind', async () => {
  await fresh();
  peerPushes();
  const before = head(api);
  const r = await look({ ff: { projects: false } });
  assert.equal(head(api), before, 'not moved');
  const row = rowOf(r);
  assert.ok(row && row.state === 'behind' && /1 /.test(row.why), JSON.stringify(r.items));
  assert.equal((await repoInfo(api)).behind, 1, 'the look fetched, so the page data says behind');
});

test('a group\'s own place is off by default: nothing there is moved', async () => {
  await fresh();
  const tool = path.join(D.ws, 'kits', 'packs', 'tool', 'code', 'tool-core');
  if (!fs.existsSync(tool)) return; // the group's member is not here: nothing to prove
  const r = await look({ ff: on });
  assert.ok(!r.moved.some((m) => /tool/.test(m.label)));
});

test('a changed file the new commits touch: left alone, said as one row, the file kept', async () => {
  await fresh();
  peerPushes(`notes${++k}.txt`, 'peer\n');
  fs.writeFileSync(path.join(api, `notes${k}.txt`), 'mine, not committed\n');
  const before = head(api);
  const r = await look();
  assert.equal(head(api), before);
  assert.equal(fs.readFileSync(path.join(api, `notes${k}.txt`), 'utf8'), 'mine, not committed\n');
  const rows = r.items.filter((i) => i.label === 'shop/code/shop-api');
  assert.equal(rows.length, 1, 'one row');
  assert.equal(rows[0].state, 'dirty');
});

test('a changed file the new commits do not touch: the move happens, the change stays', async () => {
  await fresh();
  peerPushes(`other${++k}.txt`, 'peer\n');
  fs.writeFileSync(path.join(api, 'draft.txt'), 'mine\n');
  const r = await look();
  assert.ok(r.moved.length === 1);
  assert.equal(fs.readFileSync(path.join(api, 'draft.txt'), 'utf8'), 'mine\n');
});

test('both sides moved: left alone, one row, no merge, no rebase', async () => {
  await fresh();
  peerPushes();
  w.commit(api, `mine${++k}.txt`, 'mine\n');
  const before = head(api);
  const r = await look();
  assert.equal(head(api), before);
  assert.equal(w.sh(api, 'rev-list', '--merges', 'HEAD'), '');
  assert.equal(rowOf(r).state, 'diverged');
});

test('commits only here: left alone, one row, nothing pushed', async () => {
  await fresh();
  w.commit(api, `mine${++k}.txt`, 'mine\n');
  const server = w.sh(path.join(w.server, 'team', 'shop-api.git'), 'rev-parse', 'main');
  const r = await look();
  assert.equal(w.sh(path.join(w.server, 'team', 'shop-api.git'), 'rev-parse', 'main'), server, 'main was not pushed');
  assert.equal(rowOf(r).state, 'unpushed');
  assert.match(rowOf(r).why, /1 /);
});

test('a rebase under way, a detached head: left alone', async () => {
  await fresh();
  peerPushes();
  const before = head(api);
  fs.mkdirSync(path.join(api, '.git', 'rebase-merge'));
  const r = await look();
  assert.equal(head(api), before, 'a rebase under way');
  assert.equal(rowOf(r).state, 'behind');
  fs.rmSync(path.join(api, '.git', 'rebase-merge'), { recursive: true });
  w.sh(api, 'checkout', '-q', '--detach');
  const r2 = await look();
  assert.equal(head(api), before, 'a detached head');
  assert.equal(rowOf(r2), undefined, 'a detached head follows nothing: no row');
  w.sh(api, 'checkout', '-q', 'main');
});

test('a session or chat open in the folder: not moved', async () => {
  await fresh();
  peerPushes();
  const before = head(api);
  const r = await look({ busy: (dir) => dir.startsWith(D.shop) });
  assert.equal(head(api), before);
  assert.equal(rowOf(r).state, 'behind');
  assert.match(rowOf(r).why, /open/);
});

test('the list is kept for the page: read from the file, no network; a later look of one project keeps the others', async () => {
  await fresh();
  peerPushes();
  const file = tmp();
  await look({ ff: { projects: false }, file });
  const kept = I.readInstep(file);
  assert.equal(kept.items.length, 1);
  assert.ok(kept.at > 0);
  assert.deepEqual(I.instepList(path.join(w.root, 'nothing.json')), { at: 0, items: [] });
  await look({ ff: on, file, only: 'shop' });
  assert.deepEqual(I.readInstep(file).items, [], 'the project is in step now: the row goes');
});

test('before a session starts: a clean behind project is moved, and a slow server delays the start by 3 seconds at most', async () => {
  await fresh();
  peerPushes();
  const file = tmp();
  const before = head(api);
  await I.lookBeforeStart(api, { dir: D.ws, projects: D.projects, ff: on, busy: none, file });
  assert.notEqual(head(api), before, 'moved before the session starts');
  // fresh: a second start within 10 minutes asks nothing
  let asked = 0;
  await I.lookBeforeStart(api, { dir: D.ws, projects: D.projects, ff: on, busy: none, file, run: async (...a) => (asked++, { ok: true, stdout: '', stderr: '' }) });
  assert.equal(asked, 0, 'looked a moment ago');
  // a server that answers after 10 seconds
  peerPushes(`later${++k}.txt`, 'x\n');
  const slow = (argv, o) => (argv.includes('fetch') ? new Promise((res) => setTimeout(() => res({ ok: false, stdout: '', stderr: 'slow' }), 10_000).unref()) : import('../../src/setup/system.mjs').then((m) => m.capture(argv, o)));
  const t0 = Date.now();
  await I.lookBeforeStart(api, { dir: D.ws, projects: D.projects, ff: on, busy: none, file: tmp(), run: slow });
  const took = Date.now() - t0;
  assert.ok(took < 3600, `took ${took} ms`);
  assert.ok(took >= 2500, 'it waited for the cap');
});

test('a switch off for the place: the start does not look at all', async () => {
  await fresh();
  let asked = 0;
  await I.lookBeforeStart(api, { dir: D.ws, projects: D.projects, ff: { projects: false }, busy: none, file: tmp(), run: async () => (asked++, { ok: true, stdout: '', stderr: '' }) });
  assert.equal(asked, 0);
});

test('a session counts as open in the repository, in a folder inside it, or in the project folder that holds it; not in a sibling', () => {
  const open = I.sessionOpenIn(['/ws/projects/shop/code/api/src', '/ws/projects/blog']);
  assert.equal(open('/ws/projects/shop/code/api', '/ws/projects/shop'), true, 'inside the repository');
  assert.equal(open('/ws/projects/blog', '/ws/projects/blog'), true, 'the project folder itself');
  assert.equal(open('/ws/projects/shop/code/web', '/ws/projects/shop'), false, 'a sibling repository');
  assert.equal(I.sessionOpenIn(['/ws/projects/shop'])('/ws/projects/shop/code/web', '/ws/projects/shop'), true, 'a session in the project folder works across its code');
  assert.equal(I.sessionOpenIn(['/ws'])('/ws/projects/shop', '/ws/projects/shop'), false, 'a session above the project is none of its business');
  assert.equal(I.sessionOpenIn([])('/ws/projects/shop', '/ws/projects/shop'), false);
});
