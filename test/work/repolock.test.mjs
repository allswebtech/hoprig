// One lock for the repository between a save of the Work list and the workspace's upkeep in the AI brain (its map
// commit, its fetch and fast-forward, its push): while a save holds it, the upkeep skips its round with the reason
// and comes again at the next tick; while the upkeep holds it, a save waits a few seconds, then says so and changes
// nothing. Both at once, on a temporary brain with a local bare "server".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-repolock');
test.after(() => t.cleanup());
const { resolvePlace } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { saveWork } = await import('../../src/work/save.mjs');
const { takeRepoLock } = await import('../../src/work/lock.mjs');
const { capture } = await import('../../src/setup/system.mjs');
const upkeep = await import('../../src/automation/workspacesync.mjs');

const bare = t.repo(t.brain, { 'README.md': '# brain\n', 'work/tasks.json': '{\n  "items": []\n}\n' });
const place = () => resolvePlace({});
const add = (title) => workStore(place(), { projects: [] }).add({ title });

test('a save holds the brain from its fetch to its send: the upkeep skips its round, with the reason, and comes again', async () => {
  await add('Saved while the upkeep looks');
  let reached;
  let go;
  const atFetch = new Promise((r) => (reached = r));
  const gate = new Promise((r) => (go = r));
  const slow = async (args, o) => {
    if (args.includes('fetch')) {
      reached();
      await gate;
    }
    return capture(args, o);
  };
  const saving = saveWork(place(), { subject: 'Update work items', run: slow });
  await atFetch;
  // The upkeep's round, as the automation runs it, with the real engines.
  const lines = [];
  let saved;
  await upkeep.apply([{ type: 'sync', push: true }, { type: 'map', commit: true, push: true }], {
    record: (l) => lines.push(l), notify: () => {}, data: { lastAt: 111, lastMapAt: 222 }, save: (d) => (saved = d),
    workspaceSync: upkeep.realWorkspaceSync, workspaceMap: upkeep.realWorkspaceMap,
  });
  assert.deepEqual(lines.map((l) => [l.did, l.outcome]), [
    ['skipped keeping the workspace in step this round', 'skipped: a save of the Work list is using the AI brain right now'],
    ['skipped looking at the workspace map this round', 'skipped: a save of the Work list is using the AI brain right now'],
  ]);
  assert.equal(saved.lastAt, 0, 'sync comes again at the next tick');
  assert.equal(saved.lastMapAt, 0, 'the map too');
  go();
  const r = await saving;
  assert.equal(r.sent, true, r.message);
  assert.equal(t.git(t.brain, 'rev-parse', 'HEAD'), t.git(bare, 'rev-parse', 'main'));
  // The save is done: the upkeep runs.
  const after = await upkeep.realWorkspaceSync({ push: false });
  assert.equal(after.busy, undefined);
  assert.ok(Array.isArray(after.repos));
});

test('the upkeep holds the brain: a save waits, then says the workspace is being synced, and changes nothing', async () => {
  await add('Saved after the sync');
  const release = await takeRepoLock(t.brain, { who: 'upkeep', wait: 0 });
  const head = t.git(t.brain, 'rev-parse', 'HEAD');
  const before = fs.readFileSync(place().file, 'utf8');
  const started = Date.now();
  const r = await saveWork(place(), { subject: 'Update work items', repoWait: 400 });
  assert.ok(Date.now() - started >= 400, 'it waited');
  assert.equal(r.code, 'syncing');
  assert.equal(r.message, 'The workspace is being synced: Save again in a moment. Your changes are kept in the file.');
  assert.equal(t.git(t.brain, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(place().file, 'utf8'), before);
  // Freed within the wait: the save goes on.
  setTimeout(release, 200);
  const later = await saveWork(place(), { subject: 'Update work items', repoWait: 5000 });
  assert.equal(later.sent, true, later.message);
  // Two saves at once: the second waits for the first, then finds nothing left to save.
  await add('One more');
  const [a, b] = await Promise.all([saveWork(place(), { subject: 'Update work items' }), saveWork(place(), { subject: 'Update work items' })]);
  assert.deepEqual([a.sent || b.sent, /^Nothing to save/.test(a.sent ? b.message : a.message)], [true, true], `${a.message} | ${b.message}`);
});
