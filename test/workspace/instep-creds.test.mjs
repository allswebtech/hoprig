// The credentials repository on a second computer: files land 600 in folders 700 after a clone and after a pull; a
// computer whose credentials folder is not the map's repository gets one row, and one press sets the folder aside
// (never deletes it) and clones the repository. Made-up files with a marker value only.
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert } from './dropfix.mjs';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-instep-creds');
test.after(() => w.cleanup());
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const cr = await import('../../src/workspace/credrepo.mjs');
const I = await import('../../src/workspace/instep.mjs');
const posix = process.platform !== 'win32';
const MARK = 'MADEUP-MARKER-VALUE-0001';

const u = { brain: w.bare('brain', { empty: true }), creds: w.bare('creds') };
const A = w.computer('alpha');
A.use();
const brainA = path.join(A.ws, 'ai_brain');
w.sh(w.root, 'clone', '-q', u.brain, brainA);
fs.writeFileSync(path.join(brainA, 'BRAIN.md'), '# brain\n');
fs.writeFileSync(path.join(brainA, 'workspace.json'), JSON.stringify({ version: 2, brain: { url: u.brain }, credentials: { url: u.creds }, groups: [], projects: [], others: [] }, null, 2) + '\n');
w.sh(brainA, 'add', '-A');
w.sh(brainA, 'commit', '-q', '-m', 'map');
w.sh(brainA, 'push', '-q', '-u', 'origin', 'main');
const seed = w.clone(u.creds, path.join(w.root, 'seed-creds'));
w.commit(seed, 'shop/app.env', `KEY=${MARK}\n`);
w.sh(seed, 'push', '-q');
const modes = (dir) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      out.push([path.relative(dir, p), fs.lstatSync(p).mode & 0o777, e.isDirectory()]);
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
};

test('after a clone the files are 600 and the folders 700', { skip: !posix }, async () => {
  const B = w.computer('beta');
  B.use();
  const { ui } = await quietUi();
  const r = await restoreWorkspace(u.brain, { ui, dir: B.ws, projects: B.projects });
  assert.ok(r.ok, JSON.stringify(r.plan));
  const list = modes(path.join(B.ws, 'credentials'));
  assert.ok(list.some(([p]) => p === path.join('shop', 'app.env')), 'the file is here');
  for (const [p, m, d] of list) assert.equal(m, d ? 0o700 : 0o600, `${p} is ${m.toString(8)}`);
  w.B = B;
});

test('after a pull the new files are 600 too', { skip: !posix }, async () => {
  const B = w.B;
  B.use();
  w.commit(seed, 'shop/new/more.env', 'OTHER=x\n');
  w.sh(seed, 'push', '-q');
  const s = await syncAll({ dir: B.ws, projects: B.projects });
  assert.ok(s.repos.some((x) => x.label === 'credentials' && x.did.some((d) => /pulled 1/.test(d))), JSON.stringify(s.repos.map((x) => [x.label, x.did, x.todo])));
  for (const [p, m, d] of modes(path.join(B.ws, 'credentials'))) assert.equal(m, d ? 0o700 : 0o600, `${p} is ${m.toString(8)}`);
});

test('a plain folder where the map has the repository: sync says so, with one row; one press sets it aside and clones', { skip: !posix }, async () => {
  const C = w.computer('gamma');
  C.use();
  const { ui } = await quietUi();
  // a computer that has the brain but whose credentials folder is a plain folder with the owner's own file
  await restoreWorkspace(u.brain, { ui, dir: C.ws, projects: C.projects });
  fs.rmSync(path.join(C.ws, 'credentials'), { recursive: true, force: true });
  fs.mkdirSync(path.join(C.ws, 'credentials', 'shop'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(C.ws, 'credentials', 'shop', 'mine.env'), 'MINE=1\n');
  const s = await syncAll({ dir: C.ws, projects: C.projects });
  const e = s.repos.find((x) => x.label === 'credentials');
  assert.ok(e && e.todo.length === 1, JSON.stringify(e));
  assert.match(e.todo[0].why, /not the credentials repository of the map/);
  assert.doesNotMatch(JSON.stringify(e), /hoprig get credentials/);
  const row = await cr.credentialsRow({ dir: C.ws });
  assert.ok(row && row.state === 'credentials', JSON.stringify(row));
  const got = await cr.getCredentialsRepo({ dir: C.ws });
  assert.ok(got.ok, JSON.stringify(got));
  assert.ok(got.aside && fs.existsSync(path.join(got.aside, 'shop', 'mine.env')), 'the owner\'s folder is kept, never deleted');
  assert.equal(fs.readFileSync(path.join(C.ws, 'credentials', 'shop', 'app.env'), 'utf8'), `KEY=${MARK}\n`);
  for (const [p, m, d] of modes(path.join(C.ws, 'credentials'))) assert.equal(m, d ? 0o700 : 0o600, `${p} is ${m.toString(8)}`);
  assert.equal(await cr.credentialsRow({ dir: C.ws }), null, 'in step: no row');
  assert.ok((await cr.getCredentialsRepo({ dir: C.ws })).already, 'a second press changes nothing');
});

test('the in-step list holds the credentials row only while the folder is not the repository, and never a value', async () => {
  const D = w.computer('delta');
  D.use();
  const { ui } = await quietUi();
  await restoreWorkspace(u.brain, { ui, dir: D.ws, projects: D.projects });
  fs.rmSync(path.join(D.ws, 'credentials'), { recursive: true, force: true });
  fs.mkdirSync(path.join(D.ws, 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(D.ws, 'credentials', 'x.env'), `V=${MARK}\n`);
  const list = await I.instepNow({ dir: D.ws, projects: D.projects, file: path.join(w.root, 'none.json') });
  const row = list.items.find((i) => i.state === 'credentials');
  assert.ok(row, JSON.stringify(list));
  assert.equal(row.button, 'Get it');
  assert.ok(!JSON.stringify(list).includes(MARK));
});
