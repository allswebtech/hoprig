// A folder of the workspace's tree that is the owner's own link (his database folder on another disk): workspace setup
// never makes anything through it and never stops there. It names the link with the command that names it as his own,
// makes the rest, and restore still clones every project. Temporary homes and local bare repositories only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-setuplink');
test.after(() => w.cleanup());
for (const n of ['brain', 'shop']) w.bare(n);
const seed = w.clone(w.url('brain'), path.join(w.root, 'seed-brain'));
w.commit(seed, 'workspace.json', JSON.stringify({ version: 2, brain: { url: w.url('brain') }, projects: [{ name: 'shop', url: w.url('shop'), repos: [] }], others: [] }, null, 2) + '\n');
w.sh(seed, 'push', '-q', 'origin', 'main');
const B = w.computer('b');
B.use();
process.env.HOPRIG_WORKSPACE_DIR = B.ws;
const disk = path.join(w.root, 'DISK', 'database');
fs.mkdirSync(disk, { recursive: true });
fs.mkdirSync(B.ws, { recursive: true });
fs.symlinkSync(disk, path.join(B.ws, 'database'));
const { workspaceSetup } = await import('../../src/workspace/setup.mjs');
const { myLinkCommand } = await import('../../src/workspace/inside.mjs');

test('setup: a tree folder behind a link is named with the mylink command, the rest is made, nothing outside', async () => {
  const dry = await workspaceSetup({ dryRun: true });
  const named = dry.left.find((l) => /database[\\/]postgresql$/.test(l.path));
  assert.ok(named, JSON.stringify(dry.left));
  assert.match(named.why, /database leaves its folder through a link: not followed; if that link is yours: +hoprig workspace mylink add /);
  assert.ok(named.why.endsWith(myLinkCommand(path.join(B.ws, 'database'))));
  assert.ok(!dry.did.some((d) => /database[\\/]/.test(d.path)), 'not planned');
  const r = await workspaceSetup({});
  assert.ok(r.left.some((l) => /database[\\/]postgresql$/.test(l.path)));
  assert.deepEqual(fs.readdirSync(disk), [], 'nothing made on the other disk');
  assert.ok(fs.existsSync(path.join(B.ws, 'credentials')), 'the rest of the tree is made');
});

test('restore into such a workspace clones every project', async () => {
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const q = await quietUi();
  q.ui.yes = true;
  await restoreWorkspace(w.url('brain'), { withProjects: true, ui: q.ui, dir: B.ws, projects: B.projects });
  assert.ok(fs.existsSync(path.join(B.projects, 'shop', '.git')), q.text());
  assert.deepEqual(fs.readdirSync(disk), []);
});
