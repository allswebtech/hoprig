// The map keeps itself between two computers (mapkeep.mjs): two temporary homes on one local bare repository as the
// brain's git server. Both add a different project in the same hour: both end with both, nobody is told, no merge
// commit is made by git and nothing is forced. A local commit that touches any other file stops the rule and nothing
// is changed; an uncommitted change in another file of the brain stays exactly as it was (staged or not); a forget on
// one home is not undone by a scan on the other; the rule cut off at each of its steps leaves a brain the next round
// finishes; a server that keeps moving is tried three times, then the owner is told.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-mapkeep');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const K = await import('../../src/workspace/mapkeep.mjs');
const C = await import('../../src/workspace/computer.mjs');
const { capture } = await import('../../src/setup/system.mjs');

const server = path.join(w.server, 'team', 'brain.git');
const brainUrl = w.bare('brain', { empty: true });
// The first computer makes the brain with its first map and pushes it.
const A = w.computer('boxa');
A.use();
const brainA = path.join(A.ws, 'ai_brain');
fs.mkdirSync(A.projects, { recursive: true });
w.sh(A.ws, 'clone', '-q', brainUrl, brainA);
w.commit(brainA, 'BRAIN.md', '# brain\n', 'Start the brain');
await M.updateMap({ dir: A.ws, projects: A.projects });
w.sh(brainA, 'add', '-A');
w.sh(brainA, 'commit', '-q', '-m', 'Add the map');
w.sh(brainA, 'push', '-q', '-u', 'origin', 'main');
await C.setLabel('boxa', { dir: A.ws, projects: A.projects });
const B = w.computer('boxb');
B.use();
const brainB = path.join(B.ws, 'ai_brain');
w.clone(brainUrl, brainB);
fs.mkdirSync(B.projects, { recursive: true });
await C.setLabel('boxb', { dir: B.ws, projects: B.projects });

const on = { commit: true, push: true };
const round = async (c, extra = {}) => {
  c.use();
  return upkeepMap({ dir: c.ws, projects: c.projects, ...on, ...extra });
};
const names = (c) => M.readMap(c.ws).map.projects.map((p) => p.name).sort();
const serverMap = () => JSON.parse(w.sh(server, 'show', 'main:workspace.json'));
const allCommits = (d) => w.sh(d, 'rev-list', '--all').split('\n').filter(Boolean);

test('two homes add different projects in the same hour: both end with both, nobody is told, no merge commit', async () => {
  w.clone(w.bare('shop'), path.join(A.projects, 'shop'));
  w.clone(w.bare('blog'), path.join(B.projects, 'blog'));
  const ra = await round(A);
  assert.deepEqual(ra.pushed, { done: true }, JSON.stringify(ra));
  // B committed its map too, then its push is refused: the rule brings it in step.
  const rb = await round(B);
  assert.deepEqual(rb.pushed, { done: true }, JSON.stringify(rb));
  assert.deepEqual(rb.needs, [], 'nothing needs the owner');
  assert.ok(rb.lines.some((l) => /brought in step with the one on the git server/.test(l)));
  const ra2 = await round(A);
  assert.deepEqual(ra2.needs, []);
  assert.deepEqual(names(A), ['blog', 'shop']);
  assert.deepEqual(names(B), ['blog', 'shop']);
  assert.deepEqual(serverMap().projects.map((p) => p.name).sort(), ['blog', 'shop']);
  for (const b of [brainA, brainB, server]) assert.equal(w.sh(b, 'rev-list', '--merges', 'main'), '', 'no merge commit anywhere');
  // Each computer's own file is in the brain, written by that computer only.
  const files = w.sh(server, 'ls-tree', '--name-only', 'main', 'computers/').split('\n').sort();
  assert.deepEqual(files, ['computers/boxa.json', 'computers/boxb.json']);
  assert.deepEqual(JSON.parse(w.sh(server, 'show', 'main:computers/boxa.json')).here, ['shop']);
  assert.deepEqual(JSON.parse(w.sh(server, 'show', 'main:computers/boxb.json')).here, ['blog']);
  // The commits that touched each computer's file were made by that computer (its commit holds its file only).
  for (const [label, other] of [['boxa', 'boxb'], ['boxb', 'boxa']]) {
    for (const c of w.sh(server, 'log', '--format=%H', 'main', '--', `computers/${label}.json`).split('\n').filter(Boolean)) {
      assert.ok(!w.sh(server, 'show', '--name-only', '--format=', c).split('\n').includes(`computers/${other}.json`), `${label}'s commit never carries ${other}'s file`);
    }
  }
});

test('a forget on one home is not undone by a scan on the other', async () => {
  A.use();
  M.forget('shop', A.ws);
  await round(A);
  assert.ok(serverMap().skip.includes('shop'));
  // B still has blog; A's clone of shop is still on A's disk: neither scan brings shop back.
  await round(B);
  await round(A);
  for (const c of [A, B]) assert.ok(!names(c).includes('shop'), `${path.basename(c.home)}: shop stays forgotten`);
  assert.ok(!serverMap().projects.some((p) => p.name === 'shop'));
});

test('a local commit that touches any other file stops the rule: nothing is changed, the owner is told', async () => {
  A.use();
  w.commit(brainA, 'notes.md', 'mine\n', 'A note');
  B.use();
  w.clone(w.bare('wiki'), path.join(B.projects, 'wiki'));
  await round(B); // the server moved
  A.use();
  w.clone(w.bare('docs'), path.join(A.projects, 'docs'));
  const before = { head: w.sh(brainA, 'rev-parse', 'HEAD'), commits: allCommits(brainA) };
  const r = await round(A);
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((n) => /change more than the map \(notes\.md\)/.test(n)), r.needs.join('\n'));
  assert.equal(w.sh(brainA, 'rev-parse', 'HEAD^'), before.head, 'only the map commit of this round was added on top');
  assert.ok(before.commits.every((c) => allCommits(brainA).includes(c)), 'every commit is still there');
  // Settle it the way the owner would, so the next tests start from a brain in step.
  w.sh(brainA, 'reset', '-q', '--hard', 'origin/main');
  await round(A);
  await round(B);
});

test('uncommitted changes in other files of the brain stay exactly as they were, staged and not', async () => {
  B.use();
  w.clone(w.bare('cms'), path.join(B.projects, 'cms'));
  await round(B);
  A.use();
  fs.writeFileSync(path.join(brainA, 'staged.md'), 'staged\n');
  w.sh(brainA, 'add', 'staged.md');
  fs.writeFileSync(path.join(brainA, 'BRAIN.md'), '# brain, edited here\n');
  w.clone(w.bare('tools'), path.join(A.projects, 'tools'));
  const r = await round(A);
  // The staged file keeps the map from being committed (it would ride along): said, nothing moved.
  assert.equal(r.commit.done, false);
  assert.match(r.commit.why, /other staged changes/);
  w.sh(brainA, 'reset', '-q', 'staged.md');
  const r2 = await round(A);
  assert.deepEqual(r2.pushed, { done: true }, JSON.stringify(r2));
  assert.equal(fs.readFileSync(path.join(brainA, 'BRAIN.md'), 'utf8'), '# brain, edited here\n', 'the unstaged edit stays');
  assert.equal(fs.readFileSync(path.join(brainA, 'staged.md'), 'utf8'), 'staged\n', 'the untracked file stays');
  assert.deepEqual([w.sh(brainA, 'diff', '--name-only'), w.sh(brainA, 'diff', '--cached', '--name-only')], ['BRAIN.md', ''], 'the edit stays unstaged, nothing else is staged');
  assert.ok(names(A).includes('cms') && names(A).includes('tools'));
  fs.rmSync(path.join(brainA, 'staged.md'));
  w.sh(brainA, 'checkout', '-q', '--', 'BRAIN.md');
});

test('a staged change in another file while the server moved: the rule waits, the change stays staged', async () => {
  B.use();
  w.clone(w.bare('staging'), path.join(B.projects, 'staging'));
  await round(B);
  A.use();
  w.clone(w.bare('later'), path.join(A.projects, 'later'));
  assert.deepEqual((await round(A, { push: false, holdOwn: true })).commit, { done: true }, 'the map commit is made first');
  fs.writeFileSync(path.join(brainA, 'BRAIN.md'), '# staged edit\n');
  w.sh(brainA, 'add', 'BRAIN.md');
  const head = w.sh(brainA, 'rev-parse', 'HEAD');
  const r = await round(A);
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((n) => /staged changes and the git server moved/.test(n)), r.needs.join('\n'));
  assert.equal(w.sh(brainA, 'rev-parse', 'HEAD'), head, 'the branch did not move');
  assert.equal(w.sh(brainA, 'diff', '--cached', '--name-only'), 'BRAIN.md', 'still staged');
  w.sh(brainA, 'reset', '-q', 'BRAIN.md');
  w.sh(brainA, 'checkout', '-q', '--', 'BRAIN.md');
  assert.deepEqual((await round(A)).pushed, { done: true });
});

/** A runner that stops (throws, as a killed process stops) at the first git call that matches `at`. */
const killAt = (at) => {
  let hit = false;
  const run = async (argv, o) => {
    if (!hit && at(argv)) {
      hit = true;
      throw new Error(`killed at ${argv.slice(3).join(' ')}`);
    }
    return capture(argv, o);
  };
  return run;
};

for (const [step, at] of [
  ['(1) the fetch', (a) => a.includes('fetch')],
  ['(2) the move of the branch', (a) => a.includes('reset')],
  ['(3) the commit', (a) => a.includes('commit') && a.includes('Update the workspace map') && process.env.HOME === B.home],
  ['(3) the push', (a) => a.includes('push')],
]) {
  test(`the rule cut off at ${step}: the next round finishes it; nothing is lost`, async () => {
    // A adds a project and pushes; B adds another and runs the rule, which is cut off.
    w.clone(w.bare(`a-${step.length}`), path.join(A.projects, `a-${step.length}`));
    await round(A);
    B.use();
    w.clone(w.bare(`b-${step.length}`), path.join(B.projects, `b-${step.length}`));
    // B's map commit first (as its round makes it), so the rule has a local commit to carry.
    const first = await round(B, { push: false, holdOwn: true });
    assert.deepEqual(first.commit, { done: true });
    const r = await round(B, { run: killAt(at) });
    assert.ok(r.skipped || r.pushed.done === false || r.pushed.done === true, JSON.stringify(r));
    // Whatever it left, the next round ends with both projects on both sides of the git server.
    const again = await round(B);
    assert.deepEqual(again.needs, [], JSON.stringify(again));
    const want = [`a-${step.length}`, `b-${step.length}`];
    for (const n of want) assert.ok(serverMap().projects.some((p) => p.name === n), `${n} is on the git server`);
    for (const n of want) assert.ok(names(B).includes(n), `${n} is in B's map`);
    assert.equal(fs.existsSync(path.join(brainB, '.git', 'hoprig-map-pending.json')), false, 'nothing is left beside the git folder');
    assert.equal(w.sh(brainB, 'status', '--porcelain'), '');
    assert.equal(w.sh(brainB, 'rev-list', '--merges', 'main'), '');
  });
}

test('a server that keeps moving: three tries, then the owner is told; the next round finishes', async () => {
  B.use();
  w.clone(w.bare('moving'), path.join(B.projects, 'moving'));
  const other = w.clone(brainUrl, path.join(w.root, 'mover'));
  // Every push of B's is preceded by another computer's push (the stand-in moves the server just before).
  let n = 0;
  const run = async (argv, o) => {
    if (argv.includes('push') && process.env.HOME === B.home) {
      n++;
      w.sh(other, 'pull', '-q');
      w.commit(other, 'learnings.md', `move ${n}\n`);
      w.sh(other, 'push', '-q');
    }
    return capture(argv, o);
  };
  const r = await round(B, { run });
  assert.equal(n, K.TRIES);
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((x) => /moved again while Hoprig brought the map in step \(3 tries\)/.test(x)), r.needs.join('\n'));
  const r2 = await round(B);
  assert.deepEqual(r2.pushed, { done: true });
  assert.ok(serverMap().projects.some((p) => p.name === 'moving'));
});

const at = (n) => `https://git.example.test/team/${n}.git`;
const repo = (d, u = d) => ({ dir: `code/${d}`, url: at(u) });
const sorted = (list) => list.map((x) => x.name || x.dir).sort();

test('uniteMaps: added here goes in, removed or renamed on the server stays out, in both keeps the server\'s values, a forget wins', () => {
  // Where the two parted.
  const base = {
    version: 1,
    groups: [{ dir: 'kits' }, { dir: 'oldkits' }],
    brain: { url: null },
    projects: [
      { name: 'shop', url: at('shop'), repos: [repo('shop-api'), repo('shop-web')] },
      { name: 'gone', url: at('gone'), repos: [] },
      { name: 'alpha', url: null, repos: [] },
      { name: 'forgot', url: at('forgot'), repos: [] },
    ],
    others: [{ dir: 'git/tools', url: at('tools') }, { dir: 'git/old', url: at('old') }],
  };
  // The server: shop-api renamed, shop-web moved to another address, gone and oldkits and git/old removed, example new,
  // and a project this side added later forgotten there.
  const theirs = {
    version: 2,
    groups: [{ dir: 'kits' }],
    brain: { url: null },
    projects: [
      { name: 'shop', url: at('shop'), repos: [repo('shop-api2', 'shop-api2'), repo('shop-web', 'shop-web-moved')] },
      { name: 'alpha', url: null, repos: [] },
      { name: 'forgot', url: at('forgot'), repos: [] },
      { name: 'example', url: at('example'), repos: [] },
    ],
    others: [{ dir: 'git/tools', url: at('tools') }],
    skip: ['dropped'],
  };
  // This side: its old map plus what it added (shop-admin, beta, dropped, the group newkits, git/mine), an address of
  // its own for shop, an address and memory links for alpha, and a forget of its own.
  const mine = {
    version: 1,
    groups: [{ dir: 'kits' }, { dir: 'oldkits' }, { dir: 'newkits' }],
    brain: { url: at('brain') },
    projects: [
      { name: 'shop', url: at('shop-fork'), repos: [repo('shop-api'), repo('shop-web'), repo('shop-admin')] },
      { name: 'gone', url: at('gone'), repos: [] },
      { name: 'alpha', url: at('alpha'), memories: { '.': 'claude-memory' }, repos: [] },
      { name: 'beta', url: at('beta'), repos: [] },
      { name: 'dropped', url: at('dropped'), repos: [] },
    ],
    others: [{ dir: 'git/tools', url: at('tools') }, { dir: 'git/old', url: at('old') }, { dir: 'git/mine', url: at('mine') }],
    skip: ['forgot'],
  };
  const keep = JSON.stringify([base, theirs, mine]);
  const u = K.uniteMaps(base, theirs, mine);
  assert.equal(JSON.stringify([base, theirs, mine]), keep, 'the three maps given are not changed');
  assert.deepEqual(sorted(u.projects), ['alpha', 'beta', 'example', 'shop'], 'gone (removed there) out, beta (added here) in, dropped and forgot (forgotten) out');
  const shop = u.projects.find((p) => p.name === 'shop');
  assert.deepEqual(sorted(shop.repos), ['code/shop-admin', 'code/shop-api2', 'code/shop-web'], 'the renamed shop-api stays out, shop-admin added here goes in');
  assert.equal(shop.url, at('shop'), 'on a project both have, the server\'s address stays');
  assert.equal(shop.repos.find((r) => r.dir === 'code/shop-web').url, at('shop-web-moved'), 'on a repository both have, the server\'s address stays');
  const alpha = u.projects.find((p) => p.name === 'alpha');
  assert.equal(alpha.url, at('alpha'), 'an address the server\'s entry lacks is taken from this side');
  assert.deepEqual(alpha.memories, { '.': 'claude-memory' });
  assert.deepEqual(sorted(u.groups), ['kits', 'newkits'], 'the group removed there stays out, the one added here goes in');
  assert.deepEqual(sorted(u.others), ['git/mine', 'git/tools'], 'the other folder removed there stays out, the one added here goes in');
  assert.deepEqual(u.skip, ['dropped', 'forgot']);
  assert.equal(u.version, 2);
  assert.equal(u.brain.url, at('brain'));
});

test('uniteMaps: only behind gives the server\'s map; no map at the merge-base puts nothing of this side in; no map on the server keeps what this side added', () => {
  const old = { version: 2, groups: [], brain: { url: at('brain') }, projects: [{ name: 'shop', url: at('shop'), repos: [repo('shop-api')] }], others: [] };
  const theirs = { ...old, projects: [{ name: 'shop', url: at('shop'), repos: [repo('shop-api2', 'shop-api2')] }, { name: 'alpha', url: at('alpha'), repos: [] }] };
  // Only behind: this side's map is the merge-base's.
  assert.deepEqual(K.uniteMaps(old, theirs, old), theirs);
  // No map at the merge-base (or it could not be read): the server's map as it is.
  const mine = { ...old, projects: [...old.projects, { name: 'beta', url: at('beta'), repos: [] }] };
  assert.deepEqual(K.uniteMaps(null, theirs, mine), theirs);
  // Only a forget of this side's still wins there: it never brings anything back.
  const forgot = K.uniteMaps(null, theirs, { ...mine, skip: [`alpha`] });
  assert.deepEqual(sorted(forgot.projects), ['shop']);
  assert.deepEqual(forgot.skip, ['alpha']);
  // No map here: the server's.
  assert.deepEqual(K.uniteMaps(old, theirs, null), theirs);
  // No map on the server and none at the merge-base: nothing there was removed, this side's map as it is.
  assert.deepEqual(K.uniteMaps(null, null, mine), mine);
  // No map on the server, one at the merge-base: only what this side added since.
  assert.deepEqual(sorted(K.uniteMaps(old, null, mine).projects), ['beta']);
});
