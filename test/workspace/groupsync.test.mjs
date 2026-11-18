// Sync and a group: a group's folder that is a linked worktree (a second checkout of another repository) is left
// alone, never fetched or fast-forwarded as the group's repository.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-groupsync');
test.after(() => w.cleanup());
const C = w.computer('gs');
C.use();
process.env.HOPRIG_WORKSPACE_DIR = C.ws;
const M = await import('../../src/workspace/map.mjs');
const { syncAll } = await import('../../src/workspace/sync.mjs');
const { WORKTREE_LEFT } = await import('../../src/workspace/layout.mjs');

test('a group\'s folder that is a linked worktree is left alone by sync', async () => {
  w.clone(w.bare('brain'), path.join(C.ws, 'ai_brain'));
  const main = w.clone(w.bare('kits'), path.join(w.root, 'kits-main'));
  w.sh(main, 'worktree', 'add', '-q', '-b', 'try', path.join(C.ws, 'kits'));
  M.writeMap({ version: 2, brain: { url: w.url('brain') }, groups: [{ dir: 'kits', url: w.url('kits'), holds: [{ dir: 'builds' }] }], projects: [], others: [] }, C.ws);
  const r = await syncAll({ dir: C.ws, projects: C.projects });
  const kits = r.repos.find((x) => x.label === 'kits');
  assert.deepEqual(kits.did, [WORKTREE_LEFT]);
  assert.deepEqual(kits.todo, []);
});
