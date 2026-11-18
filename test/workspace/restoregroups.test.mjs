// Restore with groups when something is in the way: a file where a plain group's folder goes is left alone and its
// projects wait (no raw EEXIST); a group whose own repository could not be cloned gets no member cloned into it
// (else the group could never be cloned there afterwards).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-restoregroups');
test.after(() => w.cleanup());
const A = w.computer('a');
const brain = w.bare('brain');
const bdir = w.clone(brain, path.join(A.ws, 'ai_brain'));
['shop', 'tool1', 'theme'].forEach((n) => w.bare(n));
const map = {
  version: 2, brain: { url: brain },
  groups: [{ dir: 'client-work' }, { dir: 'kits', url: w.url('kits-gone'), holds: [{ dir: 'packs', parent: 'group' }, { dir: 'builds' }] }],
  projects: [
    { name: 'shop', in: 'client-work', url: w.url('shop'), repos: [] },
    { name: 'tool1', in: 'kits/builds', url: w.url('tool1'), repos: [] },
    { name: 'blog', in: 'kits/packs', url: null, repos: [{ dir: 'code/theme', url: w.url('theme') }] },
  ],
  others: [],
};
w.commit(bdir, 'workspace.json', JSON.stringify(map, null, 2) + '\n', 'map');
w.sh(bdir, 'push', '-q', 'origin', 'main');
const B = w.computer('b');
B.use();
process.env.HOPRIG_WORKSPACE_DIR = B.ws;
const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');

test('a file where a plain group goes: said, left alone, its projects wait', async () => {
  fs.mkdirSync(B.ws, { recursive: true });
  fs.writeFileSync(path.join(B.ws, 'client-work'), 'a file\n');
  const q = await quietUi();
  const r = await restoreWorkspace(brain, { ui: q.ui, dir: B.ws, projects: B.projects });
  const by = Object.fromEntries(r.plan.map((e) => [e.label, e.result]));
  assert.match(q.text(), /client-work: a file is where the group's folder goes: left alone/);
  assert.equal(fs.readFileSync(path.join(B.ws, 'client-work'), 'utf8'), 'a file\n');
  assert.match(by['client-work/shop'], /skipped: the group's folder client-work is not a folder here/);
  res = r;
});

let res;
test('no member is cloned into a group whose own repository could not be cloned', () => {
  const by = Object.fromEntries(res.plan.map((e) => [e.label, e.result]));
  assert.match(by.kits, /^failed/);
  assert.match(by['kits/builds/tool1'], /skipped: its group's repository is not here/);
  assert.match(by['kits/packs/blog/code/theme'], /skipped: its group/);
  assert.ok(!fs.existsSync(path.join(B.ws, 'kits')), 'nothing made where the group goes, so it can be cloned there later');
});
