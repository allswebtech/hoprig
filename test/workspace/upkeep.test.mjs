// The map keeps building itself: with a local bare repository as the brain's git server. A new project is added on
// the next round, once; nothing changed means no write; commitMap commits only workspace.json and leaves the rest of
// the brain alone; with push it uploads only when purely ahead; staged changes in the brain stop the commit (said
// why). Then the automation's schedule and messages, `hoprig workspace auto`, and status's "not saved" line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const w = gitWorld('ws-upkeep');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const rule = await import('../../src/automation/workspacesync.mjs');
const { main } = await import('../../src/workspace/cli.mjs');

const A = w.computer('alex');
A.use();
const brain = path.join(A.ws, 'ai_brain');
const urls = { brain: w.bare('brain') };
const o = { dir: A.ws, projects: A.projects };
const head = (d) => w.sh(d, 'rev-parse', 'HEAD');
const newProject = (name, { remote = true } = {}) => {
  if (remote) return w.clone(w.bare(name), path.join(A.projects, name));
  const d = path.join(A.projects, name);
  fs.mkdirSync(d, { recursive: true });
  w.sh(d, 'init', '-q');
  w.commit(d, 'README.md', name);
  return d;
};

test('no map yet: the upkeep never makes the first one', async () => {
  w.clone(urls.brain, brain);
  newProject('shop');
  const r = await upkeepMap(o);
  assert.match(r.skipped, /no map yet/);
  assert.equal(fs.existsSync(M.mapFile(A.ws)), false);
  await M.updateMap(o);
  w.sh(brain, 'add', 'workspace.json');
  w.sh(brain, 'commit', '-q', '-m', 'first map');
  w.sh(brain, 'push', '-q', 'origin', 'HEAD:main');
  w.sh(brain, 'branch', '-q', '-u', 'origin/main');
});

test('nothing changed: no write; a new project: the map gains it on the next round, once', async () => {
  const before = fs.statSync(M.mapFile(A.ws)).mtimeMs;
  const same = await upkeepMap(o);
  assert.equal(same.changed, false);
  assert.equal(fs.statSync(M.mapFile(A.ws)).mtimeMs, before, 'not even rewritten');
  newProject('blog');
  const r = await upkeepMap(o);
  assert.deepEqual(r.lines, ['The map gained blog']);
  assert.equal(r.commit, undefined, 'commitMap is off: written, not committed');
  assert.deepEqual((await upkeepMap(o)).lines, [], 'once');
  const st = await M.mapStatus(o);
  assert.equal(st.saved.unsaved, true);
  assert.match(st.saved.command, /add workspace\.json && .* commit -m "Update the workspace map"/);
  // Status says it in words, with the command.
  const { ui, text } = await quietUi();
  assert.equal(await main(['status'], { ui, write: () => {} }), 0);
  assert.match(text(), /the map changed and is not saved in the brain's history yet/);
});

test('commitMap: only workspace.json is committed; other changes in the brain stay as they are', async () => {
  fs.appendFileSync(path.join(brain, 'README.md'), 'my own unsaved line\n');
  newProject('docs');
  const r = await upkeepMap({ ...o, commit: true });
  assert.deepEqual(r.commit, { done: true });
  assert.equal(w.sh(brain, 'log', '-1', '--format=%s'), 'Update the workspace map');
  assert.equal(w.sh(brain, 'show', '--name-only', '--format=', 'HEAD'), 'workspace.json');
  assert.match(w.sh(brain, 'status', '--porcelain'), /^ ?M README\.md$/m, 'the person\'s change is untouched and uncommitted');
  assert.equal((await M.mapStatus(o)).saved.unsaved, false);
});

test('push: uploads only when the brain is purely ahead', async () => {
  newProject('wiki');
  const r = await upkeepMap({ ...o, commit: true, push: true });
  assert.deepEqual(r.pushed, { done: true });
  assert.equal(w.sh(path.join(w.server, 'team', 'brain.git'), 'rev-parse', 'main'), head(brain));
  // The server moves on (another computer saved something): ours is ahead and behind, so nothing is uploaded.
  const other = w.clone(urls.brain, path.join(w.root, 'other-brain'));
  w.commit(other, 'learnings.md', 'from the other computer');
  w.sh(other, 'push', '-q');
  w.sh(brain, 'fetch', '-q');
  newProject('notes');
  const r2 = await upkeepMap({ ...o, commit: true, push: true });
  assert.deepEqual(r2.commit, { done: true });
  assert.equal(r2.pushed.done, false);
  assert.match(r2.pushed.why, /behind/);
  assert.ok(r2.needs.some((n) => /both moved/.test(n)), 'the owner is told');
  assert.notEqual(w.sh(path.join(w.server, 'team', 'brain.git'), 'rev-parse', 'main'), head(brain));
});

test('staged changes in the brain: the map is written, not committed, and it says why; a repository with no address needs the owner', async () => {
  fs.writeFileSync(path.join(brain, 'draft.md'), 'staged by the person\n');
  w.sh(brain, 'add', 'draft.md');
  const before = head(brain);
  newProject('local', { remote: false });
  const r = await upkeepMap({ ...o, commit: true });
  assert.equal(r.commit.done, false);
  assert.match(r.commit.why, /other staged changes/);
  assert.equal(head(brain), before, 'nothing committed');
  assert.match(w.sh(brain, 'diff', '--cached', '--name-only'), /^draft\.md$/, 'the staged file stays staged, alone');
  assert.ok(M.readMap(A.ws).map.projects.some((p) => p.name === 'local'), 'the map itself is up to date');
  assert.ok(r.needs.some((n) => /local: not on a git server yet/.test(n)));
  assert.ok(r.needs.some((n) => /staged changes/.test(n)));
});

test('commitMap by itself (the page\'s "Save it now"): refused over staged changes, then only workspace.json', async () => {
  const { commitMap } = await import('../../src/workspace/upkeep.mjs');
  assert.equal((await M.mapStatus(o)).saved.unsaved, true, 'the round above wrote the map without committing it');
  const refused = await commitMap({ dir: A.ws });
  assert.deepEqual([refused.done, refused.staged], [false, true]);
  w.sh(brain, 'reset', '-q', 'draft.md');
  assert.deepEqual(await commitMap({ dir: A.ws }), { done: true });
  assert.equal(w.sh(brain, 'show', '--name-only', '--format=', 'HEAD'), 'workspace.json');
  assert.equal((await M.mapStatus(o)).saved.unsaved, false);
});

test('the automation: right after start, then on its schedule; one line per change; a notification only when the owner is needed, once', async () => {
  const H = 3600_000;
  const s = { map: true, commitMap: false, sync: false, push: false, everyHours: 6 };
  const d = rule.decide({ data: {}, now: 100 * H, boot: true, settings: s });
  assert.deepEqual(d.actions, [{ type: 'map', commit: false, push: false }]);
  assert.deepEqual(rule.decide({ data: d.data, now: 101 * H, settings: s }).actions, []);
  assert.deepEqual(rule.decide({ data: d.data, now: 101 * H, boot: true, settings: s }).actions.map((a) => a.type), ['map'], 'a restart looks again');
  assert.deepEqual(rule.decide({ data: d.data, now: 106 * H, settings: { ...s, sync: true, commitMap: true } }).actions, [{ type: 'sync', push: false }, { type: 'map', commit: true, push: false }], 'sync first, then the map');
  const records = [];
  const told = [];
  let saved = {};
  const result = { changed: true, lines: ['The map gained shop/code/shop-admin'], needs: ['tools/x: not on a git server yet (no remote)'] };
  const ctx = { record: (e) => records.push(e), notify: (e) => told.push(e), data: {}, save: (x) => (saved = x), workspaceMap: async () => result };
  await rule.apply([{ type: 'map', commit: false, push: false }], ctx);
  assert.deepEqual(records.map((r) => r.did), ['The map gained shop/code/shop-admin']);
  assert.equal(told.length, 1);
  await rule.apply([{ type: 'map', commit: false, push: false }], { ...ctx, data: saved, workspaceMap: async () => ({ changed: false, lines: [], needs: result.needs }) });
  assert.equal(records.length, 1, 'nothing changed: no line');
  assert.equal(told.length, 1, 'the same need is not told twice');
});

test('`hoprig workspace auto`: shows and sets the switches (the dashboard\'s setting), refuses bad values', async () => {
  let out = '';
  const { ui } = await quietUi();
  assert.equal(await main(['auto', '--map', 'on', '--commit', 'on', '--push', 'on', '--every', '3', '--json'], { ui, write: (x) => (out += x) }), 0);
  assert.deepEqual(JSON.parse(out), { map: true, commitMap: true, sync: false, push: true, everyHours: 3 });
  const cfg = JSON.parse(fs.readFileSync(path.join(A.env.HOPRIG_CONFIG_DIR, 'config.json'), 'utf8'));
  assert.deepEqual(cfg.automation.workspace, { map: true, commitMap: true, sync: false, push: true, everyHours: 3 });
  const bad = await quietUi();
  assert.equal(await main(['auto', '--map', 'maybe'], { ui: bad.ui, write: () => {} }), 1);
  assert.equal(await main(['auto', '--every', '0'], { ui: bad.ui, write: () => {} }), 1);
  assert.match(bad.text(), /on or off[\s\S]*1 to 168/);
  const show = await quietUi();
  assert.equal(await main(['auto'], { ui: show.ui, write: () => {} }), 0);
  assert.match(show.text(), /on   commit: a change of the map is saved/);
});
