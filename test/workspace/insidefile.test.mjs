// A file where a folder of the map goes: a project's repository that tracks `code` as a link is checked out by Git
// for Windows (core.symlinks off, its default) as a plain file holding the link's target. A clone of code/web then
// finds a file where the folder code goes: nothing is cloned, it is said, and restore goes on with the rest. The same
// file is handed in here on every system (a repository that commits a plain file `code`). Local bare repositories only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-insidefile');
test.after(() => w.cleanup());
for (const n of ['brain', 'shop', 'web', 'blog']) w.bare(n);
const outside = path.join(w.root, 'OUT');
fs.mkdirSync(outside, { recursive: true });
// What Git for Windows writes for a link `code -> <outside>` when it makes no links: a file with the target's text.
const LINK_TEXT = String(outside).replaceAll('\\', '/');
const ss = w.clone(w.url('shop'), path.join(w.root, 'seed-shop'));
w.commit(ss, 'code', LINK_TEXT);
const brain = w.clone(w.url('brain'), path.join(w.root, 'seed-brain'));
const map = { version: 2, brain: { url: w.url('brain') }, projects: [{ name: 'shop', url: w.url('shop'), repos: [{ dir: 'code/web', url: w.url('web') }] }, { name: 'blog', url: w.url('blog'), repos: [] }], others: [] };
w.commit(brain, 'workspace.json', `${JSON.stringify(map, null, 2)}\n`);
w.sh(ss, 'push', '-q', 'origin', 'main');
w.sh(brain, 'push', '-q', 'origin', 'main');
const B = w.computer('b');
B.use();
process.env.HOPRIG_WORKSPACE_DIR = B.ws;
const { cloneInto } = await import('../../src/workspace/inside.mjs');

test('restore: a file where the folder code goes is said, nothing is cloned there, and the rest is cloned', async () => {
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const q = await quietUi();
  q.ui.yes = true;
  const r = await restoreWorkspace(w.url('brain'), { withProjects: true, ui: q.ui, dir: B.ws, projects: B.projects });
  const code = path.join(B.projects, 'shop', 'code');
  assert.equal(fs.readFileSync(code, 'utf8'), LINK_TEXT, 'the file is left as it is');
  const web = r.plan.find((e) => e.label === 'shop/code/web');
  assert.ok(web, JSON.stringify(r.plan.map((e) => e.label)));
  assert.equal(web.result, `failed: a file is where the folder ${code} goes: nothing was cloned`);
  assert.ok(fs.existsSync(path.join(B.projects, 'blog', '.git')), `the next project is still cloned\n${q.text()}`);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing outside');
});

test('the clone itself: a file on the way to its folder, also further up, starts no git and throws nothing', async () => {
  const shop = path.join(B.projects, 'shop');
  const calls = [];
  const run = async (argv) => (calls.push(argv), { ok: true, output: '' });
  const lines = [];
  for (const dest of [path.join(shop, 'code', 'web'), path.join(shop, 'code', 'deeper', 'web')]) {
    const c = await cloneInto({ root: shop, dir: B.ws, projects: B.projects }, dest, w.url('web'), { run, onLine: (l) => lines.push(l) });
    assert.equal(c.ok, false, dest);
    assert.equal(c.output, `a file is where the folder ${path.join(shop, 'code')} goes: nothing was cloned`);
  }
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 2);
});
