// `hoprig drop` and the other computers: the map keeps the entry, this computer's file drops it (committed and pushed
// only by the upkeep's own path, with no other file of the brain), the other computer's file and disk are untouched, and
// `get` on the second home brings back the same tree. A project folder that is a link loses the link, never its target;
// a member that comes with its group's repository loses only its code repositories, and the group shows no change.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dropOn, dropWorld, getOn, reset, treeOf } from './dropfix.mjs';

const w = await dropWorld('two', { labels: ['alpha', 'beta'], group: true });
/** Commit what is staged (or the named files) when there is something: `hoprig get` commits this computer's file itself now. */
const commitIfAny = (dir, msg, ...files) => {
  const dirty = w.sh(dir, 'status', '--porcelain', ...(files.length ? ['--', ...files] : []));
  if (dirty) w.sh(dir, 'commit', '-q', '-m', msg, ...(files.length ? ['--', ...files] : []));
};
test.after(() => w.cleanup());
const [A, B] = w.computers;
const brainServer = path.join(w.server, 'team', 'brain.git');
const setSwitches = async (c, workspace) => {
  c.use();
  const { saveConfig } = await import('../../src/config.mjs');
  saveConfig({ automation: { workspace } });
};

test('two computers: the map keeps it, this computer\'s file drops it and is committed and pushed alone; the other computer is untouched; get on the second home is equal', async () => {
  // Both computers have shop; beta's file is on the server and in alpha's brain.
  await reset(A);
  await reset(B);
  B.use();
  w.sh(B.brain, 'add', '-A');
  commitIfAny(B.brain, 'beta');
  w.sh(B.brain, 'push', '-q');
  A.use();
  w.sh(A.brain, 'add', '-A');
  commitIfAny(A.brain, 'alpha');
  w.sh(A.brain, 'pull', '-q', '--rebase');
  w.sh(A.brain, 'push', '-q');
  // The owner's own change in the brain: a tracked file changed, a new file; both stay as they are.
  w.commit(A.brain, 'NOTES.md', 'v1\n');
  w.sh(A.brain, 'push', '-q');
  fs.writeFileSync(path.join(A.brain, 'NOTES.md'), 'v2, not committed\n');
  fs.writeFileSync(path.join(A.brain, 'scratch.md'), 'mine\n');
  const betaFile = fs.readFileSync(path.join(A.brain, 'computers', 'beta.json'), 'utf8');
  const bTree = treeOf(B.ws, w.sh);
  const shopBefore = treeOf(A.shop, w.sh);
  const mapBefore = fs.readFileSync(path.join(A.brain, 'workspace.json'), 'utf8');
  const serverBefore = w.sh(brainServer, 'rev-parse', 'main');
  await setSwitches(A, { commitMap: true, push: true });
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
  // The map: the entry stays, nothing in skip.
  assert.equal(fs.readFileSync(path.join(A.brain, 'workspace.json'), 'utf8'), mapBefore, 'the map is not changed by a drop');
  // This computer's file: committed and pushed in one commit holding only the map and that file.
  const top = w.sh(brainServer, 'rev-parse', 'main');
  assert.notEqual(top, serverBefore);
  assert.deepEqual(w.sh(brainServer, 'diff', '--name-only', serverBefore, top).split('\n'), ['computers/alpha.json']);
  const onServer = JSON.parse(w.sh(brainServer, 'show', 'main:computers/alpha.json'));
  assert.ok(!onServer.here.some((x) => x === 'shop' || x.startsWith('shop/')), JSON.stringify(onServer.here));
  assert.equal(w.sh(brainServer, 'show', 'main:computers/beta.json') + '\n', betaFile, 'the other computer\'s file is untouched on the server');
  assert.equal(fs.readFileSync(path.join(A.brain, 'computers', 'beta.json'), 'utf8'), betaFile, 'and here');
  // The owner's own change stays exactly as it was.
  assert.equal(fs.readFileSync(path.join(A.brain, 'NOTES.md'), 'utf8'), 'v2, not committed\n');
  assert.equal(fs.readFileSync(path.join(A.brain, 'scratch.md'), 'utf8'), 'mine\n');
  assert.equal(w.sh(A.brain, 'diff', '--cached', '--name-only'), '', 'nothing of the owner\'s is staged');
  assert.equal(w.sh(A.brain, 'diff', '--name-only'), 'NOTES.md');
  assert.equal(w.sh(A.brain, 'ls-files', '--others', '--exclude-standard'), 'scratch.md');
  // The other computer: its disk is untouched.
  assert.deepEqual(treeOf(B.ws, w.sh), bTree);
  // get on the second home (after its own drop, it may get again) and on this one: the same tree.
  assert.equal((await dropOn(B, ['shop'])).code, 0);
  assert.equal((await getOn(B, ['shop'])).code, 0);
  assert.deepEqual(treeOf(B.shop, w.sh), shopBefore, 'get on the second home brings back the same tree');
  await setSwitches(A, { commitMap: false, push: false });
});

test('with the commit switch off: the file is written, not committed, and the words say how to share it', async () => {
  await reset(A);
  await setSwitches(A, { commitMap: false, push: false });
  const head = w.sh(A.brain, 'rev-parse', 'HEAD');
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
  assert.equal(w.sh(A.brain, 'rev-parse', 'HEAD'), head, 'nothing committed in the brain');
  assert.match(r.text, /this computer's file is written, not committed \(the "commit" switch is off\): to share it, {2}git -C \S+ commit -m 'Update the workspace map' -- computers\/alpha\.json {2}and push the brain/);
});

test('a project folder that is a link: the link goes, its target stays, byte for byte; a link inside pointing out keeps its target', async () => {
  await reset(A);
  const elsewhere = path.join(w.root, 'disk2', 'shop');
  fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
  const outside = path.join(w.root, 'outside.txt');
  fs.writeFileSync(outside, 'keep me\n');
  const api = path.join(A.shop, 'code', 'shop-api');
  fs.symlinkSync(outside, path.join(api, 'out.lnk'));
  w.sh(api, 'add', 'out.lnk');
  w.sh(api, 'commit', '-q', '-m', 'a link out');
  w.sh(api, 'push', '-q');
  // The owner keeps the project on another disk: the folder in the workspace is his own link to it.
  fs.renameSync(A.shop, elsewhere);
  fs.symlinkSync(elsewhere, A.shop);
  const { addMyLink } = await import('../../src/workspace/inside.mjs');
  A.use();
  addMyLink(A.shop, { dir: A.ws, projects: A.projects });
  const before = treeOf(elsewhere, w.sh);
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
  assert.equal(fs.lstatSync(A.shop, { throwIfNoEntry: false }), undefined, 'the link is gone');
  assert.deepEqual(treeOf(elsewhere, w.sh), before, 'its target: every file and every branch and tag the same');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n');
  fs.rmSync(path.dirname(elsewhere), { recursive: true, force: true });
});

test('a member that comes with its group: only its code repositories go; its folder stays, the group\'s git status is clean', async () => {
  const g = await getOn(A, ['kits/packs/tool']);
  assert.equal(g.code, 0, g.text);
  const member = path.join(A.ws, 'kits', 'packs', 'tool');
  const core = path.join(member, 'code', 'tool-core');
  assert.ok(fs.existsSync(path.join(core, '.git')));
  const kits = path.join(A.ws, 'kits');
  assert.equal(w.sh(kits, 'status', '--porcelain'), '');
  const r = await dropOn(A, ['kits/packs/tool']);
  assert.equal(r.code, 0, r.text);
  assert.equal(fs.existsSync(core), false);
  assert.equal(fs.readFileSync(path.join(member, 'config', 'settings.txt'), 'utf8'), 'kept by the group\n');
  assert.equal(w.sh(kits, 'status', '--porcelain', '--untracked-files=all'), '', 'no deletion and nothing left in the group');
  const back = await getOn(A, ['kits/packs/tool']);
  assert.equal(back.code, 0, back.text);
  assert.ok(fs.existsSync(path.join(core, 'README.md')));
});

test('a drop commits only this computer\'s file: an edit of the owner\'s in the map stays his; with other staged changes the words say how to share it', async () => {
  await reset(A);
  A.use();
  w.sh(A.brain, 'add', '-A');
  w.sh(A.brain, 'commit', '-q', '--allow-empty', '-m', 'here');
  w.sh(A.brain, 'pull', '-q', '--rebase');
  w.sh(A.brain, 'push', '-q');
  await setSwitches(A, { commitMap: true, push: true });
  const mapFile = path.join(A.brain, 'workspace.json');
  const mine = fs.readFileSync(mapFile, 'utf8').replace('"blog"', '"blog-half-renamed"');
  fs.writeFileSync(mapFile, mine);
  const before = w.sh(brainServer, 'rev-parse', 'main');
  const r = await dropOn(A, ['shop']);
  assert.equal(r.code, 0, r.text);
  const top = w.sh(brainServer, 'rev-parse', 'main');
  assert.deepEqual(w.sh(brainServer, 'diff', '--name-only', before, top).split('\n'), ['computers/alpha.json'], 'only this computer\'s file went up');
  assert.equal(fs.readFileSync(mapFile, 'utf8'), mine, 'the owner\'s edit stays');
  assert.equal(w.sh(A.brain, 'diff', '--name-only'), 'workspace.json', 'and stays not committed');
  w.sh(A.brain, 'checkout', '--', 'workspace.json');
  // Other staged changes in the brain: nothing is committed, and the words give the command.
  assert.equal((await getOn(A, ['shop'])).code, 0);
  commitIfAny(A.brain, 'here again', 'computers/alpha.json'); // as the upkeep would: the drop has a change to share (get commits it at once already)
  fs.writeFileSync(path.join(A.brain, 'NOTES.md'), 'staged\n');
  w.sh(A.brain, 'add', 'NOTES.md');
  const s = await dropOn(A, ['shop']);
  assert.equal(s.code, 0, s.text);
  assert.match(s.text, /this computer's file was not committed \(the brain has other staged changes\): to share it, {2}git -C \S+ commit -m 'Update the workspace map' -- computers\/alpha\.json {2}and push the brain, or, once those staged changes are committed or unstaged, the upkeep's next round shares it/);
  assert.equal(w.sh(A.brain, 'diff', '--cached', '--name-only'), 'NOTES.md', 'the owner\'s staging stays');
  w.sh(A.brain, 'reset', '-q', '--', 'NOTES.md');
  fs.rmSync(path.join(A.brain, 'NOTES.md'));
  await setSwitches(A, { commitMap: false, push: false });
});
