// The map's own rule (mapkeep.mjs) at its edges, each on two fresh temporary homes that share one local bare brain:
// what the rule carries over and what it leaves to the owner, and that nothing of his is ever lost or hidden.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld } from './gitfix.mjs';

const w = gitWorld('ws-mapkeeprules');
test.after(() => w.cleanup());
const M = await import('../../src/workspace/map.mjs');
const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
const K = await import('../../src/workspace/mapkeep.mjs');
const C = await import('../../src/workspace/computer.mjs');

let n = 0;
/** Two computers (labels boxa, boxb) in step on a new brain with a first map. */
async function two() {
  n++;
  const brainUrl = w.bare(`brain${n}`, { empty: true });
  const server = path.join(w.server, 'team', `brain${n}.git`);
  const A = w.computer(`a${n}`);
  A.use();
  A.brain = path.join(A.ws, 'ai_brain');
  fs.mkdirSync(A.projects, { recursive: true });
  w.sh(A.ws, 'clone', '-q', brainUrl, A.brain);
  w.commit(A.brain, 'BRAIN.md', '# brain\n', 'Start the brain');
  await M.updateMap({ dir: A.ws, projects: A.projects });
  w.sh(A.brain, 'add', '-A');
  w.sh(A.brain, 'commit', '-q', '-m', 'Add the map');
  w.sh(A.brain, 'push', '-q', '-u', 'origin', 'main');
  await C.setLabel('boxa', { dir: A.ws, projects: A.projects });
  const B = w.computer(`b${n}`);
  B.use();
  B.brain = path.join(B.ws, 'ai_brain');
  w.clone(brainUrl, B.brain);
  fs.mkdirSync(B.projects, { recursive: true });
  await C.setLabel('boxb', { dir: B.ws, projects: B.projects });
  await round(A);
  await round(B);
  await round(A);
  return { A, B, server, serverNames: () => JSON.parse(w.sh(server, 'show', 'main:workspace.json')).projects.map((p) => p.name).sort() };
}
const round = async (c, extra = {}) => {
  c.use();
  return upkeepMap({ dir: c.ws, projects: c.projects, commit: true, push: true, ...extra });
};
const names = (c) => M.readMap(c.ws).map.projects.map((p) => p.name).sort();
/** Is `sha` on a branch or under any ref (not only in the reflog)? */
const reachable = (repo, sha) => w.sh(repo, 'for-each-ref', '--contains', sha, '--format=%(refname)') !== '';
const { capture } = await import('../../src/setup/system.mjs');

/** A project entry with code repositories (code/<dir>), each at an address of its own unless given one. */
const P = (name, repos = []) => ({ name, url: w.url(name), repos: repos.map((r) => (typeof r === 'string' ? { dir: `code/${r}`, url: w.url(r) } : r)) });
/** The owner's own edit of the map on computer `c`: committed with his message, and pushed unless `push` is false. */
const byHand = (c, change, message, { push = true } = {}) => {
  c.use();
  M.writeMap(change(M.readMap(c.ws).map), c.ws);
  w.sh(c.brain, 'commit', '-q', '-m', message, '--', 'workspace.json');
  if (push) w.sh(c.brain, 'push', '-q');
};
/** `map` with project `name` changed by `fn`. */
const inProject = (name, fn) => (map) => ({ ...map, projects: map.projects.map((p) => (p.name === name ? fn(p) : p)) });
/** A round of `c` that counts its pushes. */
const counted = async (c) => {
  let pushes = 0;
  const r = await round(c, { run: async (a, o) => (a.includes('push') && pushes++, capture(a, o)) });
  return { r, pushes };
};
const serverMap = (server) => JSON.parse(w.sh(server, 'show', 'main:workspace.json'));
const dirsOf = (map, name) => map.projects.find((p) => p.name === name).repos.map((r) => r.dir).sort();
const mapText = (c) => fs.readFileSync(path.join(c.brain, 'workspace.json'), 'utf8');
const pendingOf = (c) => path.join(c.brain, '.git', 'hoprig-map-pending.json');

test('(a) renamed on one computer while the other is only behind: the other takes the map as it is, commits and pushes nothing, nothing old comes back', async () => {
  const { A, B, server } = await two();
  const shop = `shop${n}`;
  byHand(A, (m) => ({ ...m, projects: [...m.projects, P(shop, [`${shop}-api`, `${shop}-web`, `${shop}-docs`])] }), 'Owner: shop in the map');
  await round(B);
  assert.deepEqual(dirsOf(M.readMap(B.ws).map, shop), [`code/${shop}-api`, `code/${shop}-docs`, `code/${shop}-web`]);
  // On A the owner changes two repositories' folder and address and renames the third (its folder only), then pushes.
  byHand(A, inProject(shop, (p) => ({ ...p, repos: [{ dir: `code/${shop}-api2`, url: w.url(`${shop}-api2`) }, { dir: `code/${shop}-site`, url: w.url(`${shop}-site`) }, { dir: `code/${shop}-handbook`, url: w.url(`${shop}-docs`) }] })), 'Owner: rename the repositories of shop');
  const head = w.sh(server, 'rev-parse', 'main');
  const { r, pushes } = await counted(B);
  assert.deepEqual(r.needs, [], r.needs.join('\n'));
  assert.equal(mapText(B), mapText(A), 'B\'s map is A\'s, byte for byte');
  assert.equal(w.sh(B.brain, 'rev-parse', 'HEAD'), head, 'B made no commit: it is on A\'s');
  assert.equal(w.sh(server, 'rev-parse', 'main'), head, 'the git server\'s head is still A\'s commit');
  assert.equal(pushes, 0, 'B pushed nothing');
  assert.equal(w.sh(B.brain, 'status', '--porcelain'), '', 'nothing written');
  assert.ok(!r.lines.some((l) => /brought in step/.test(l)), r.lines.join('\n'));
  const want = [`code/${shop}-api2`, `code/${shop}-handbook`, `code/${shop}-site`];
  assert.deepEqual(dirsOf(M.readMap(B.ws).map, shop), want, 'no old entry in B\'s map');
  assert.deepEqual(dirsOf(serverMap(server), shop), want, 'no old entry on the git server');
  assert.equal(fs.existsSync(pendingOf(B)), false);
});

test('(b) a project taken out of the map on one computer, not on the other\'s disk: it stays out, and the other commits nothing', async () => {
  const { A, B, server } = await two();
  const shop = `shop${n}`;
  byHand(A, (m) => ({ ...m, projects: [...m.projects, P(shop, [`${shop}-api`]), P(`blog${n}`)] }), 'Owner: shop and blog in the map');
  await round(B);
  assert.deepEqual(names(B), [`blog${n}`, shop]);
  byHand(A, (m) => ({ ...m, projects: m.projects.filter((p) => p.name !== shop) }), 'Owner: shop out of the map');
  const head = w.sh(server, 'rev-parse', 'main');
  const { r, pushes } = await counted(B);
  assert.deepEqual(names(B), [`blog${n}`], 'shop stays removed');
  assert.deepEqual(serverMap(server).projects.map((p) => p.name), [`blog${n}`]);
  assert.equal(w.sh(B.brain, 'rev-parse', 'HEAD'), head, 'no commit by B');
  assert.equal(w.sh(server, 'rev-parse', 'main'), head);
  assert.equal(pushes, 0);
  assert.ok(!r.lines.some((l) => /brought in step/.test(l)), r.lines.join('\n'));
});

/** Case (c): A renames shop's repository api to api2 and pushes; B meanwhile adds blog by its upkeep (a map commit). */
async function bothMoved() {
  const t = await two();
  const { A, B, server } = t;
  const shop = `shop${n}`;
  byHand(A, (m) => ({ ...m, projects: [...m.projects, P(shop, [`${shop}-api`, `${shop}-web`])] }), 'Owner: shop in the map');
  await round(B);
  byHand(A, inProject(shop, (p) => ({ ...p, repos: p.repos.map((r) => (r.dir === `code/${shop}-api` ? { dir: `code/${shop}-api2`, url: w.url(`${shop}-api2`) } : r)) })), 'Owner: rename shop-api');
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  assert.deepEqual((await round(B, { push: false, holdOwn: true })).commit, { done: true }, 'B\'s own map commit');
  return { ...t, shop, head: w.sh(server, 'rev-parse', 'main') };
}

test('(c) both moved: A renamed a repository, B added a project: the server ends with the rename and B\'s project, in one commit of B\'s', async () => {
  const { B, server, shop, head, serverNames } = await bothMoved();
  const r = await round(B);
  assert.deepEqual(r.pushed, { done: true }, JSON.stringify(r));
  assert.deepEqual(r.needs, [], r.needs.join('\n'));
  assert.ok(r.lines.some((l) => /brought in step/.test(l)), r.lines.join('\n'));
  assert.deepEqual(serverNames(), [`blog${n}`, shop]);
  assert.deepEqual(dirsOf(serverMap(server), shop), [`code/${shop}-api2`, `code/${shop}-web`], 'A\'s rename, the old entry gone');
  assert.deepEqual(dirsOf(M.readMap(B.ws).map, shop), [`code/${shop}-api2`, `code/${shop}-web`]);
  assert.equal(w.sh(server, 'rev-list', '--count', `${head}..main`), '1', 'one commit by B');
  assert.equal(w.sh(server, 'rev-parse', 'main^'), head, 'on top of A\'s');
});

test('(d) both moved: a code repository B added to a project A did not touch goes in; A\'s rename elsewhere stays', async () => {
  const { A, B, server } = await two();
  const shop = `shop${n}`;
  const wiki = `wiki${n}`;
  byHand(A, (m) => ({ ...m, projects: [...m.projects, P(shop, [`${shop}-api`]), P(wiki, [`${wiki}-core`])] }), 'Owner: shop and wiki in the map');
  await round(B);
  byHand(A, inProject(shop, (p) => ({ ...p, repos: [{ dir: `code/${shop}-api2`, url: w.url(`${shop}-api2`) }] })), 'Owner: rename shop-api');
  // B's own save of the map (Hoprig's message, the map only) with a new code repository in wiki.
  byHand(B, inProject(wiki, (p) => ({ ...p, repos: [...p.repos, { dir: `code/${wiki}-extra`, url: w.url(`${wiki}-extra`) }] })), M.COMMIT_MESSAGE, { push: false });
  const head = w.sh(server, 'rev-parse', 'main');
  const r = await round(B);
  assert.deepEqual(r.pushed, { done: true }, JSON.stringify(r));
  assert.deepEqual(dirsOf(serverMap(server), wiki), [`code/${wiki}-core`, `code/${wiki}-extra`], 'B\'s code repository went in');
  assert.deepEqual(dirsOf(serverMap(server), shop), [`code/${shop}-api2`], 'A\'s rename stays, the old entry does not come back');
  assert.equal(w.sh(server, 'rev-list', '--count', `${head}..main`), '1');
});

test('(e) no map where the two parted (it first appeared on both after): nothing of B\'s map is put in; what is on B\'s disk is, by the scan', async () => {
  n++;
  const brainUrl = w.bare(`brain${n}`, { empty: true });
  const server = path.join(w.server, 'team', `brain${n}.git`);
  const A = w.computer(`a${n}`);
  A.use();
  A.brain = path.join(A.ws, 'ai_brain');
  fs.mkdirSync(A.projects, { recursive: true });
  w.sh(A.ws, 'clone', '-q', brainUrl, A.brain);
  w.commit(A.brain, 'BRAIN.md', '# brain\n', 'Start the brain');
  w.sh(A.brain, 'push', '-q', '-u', 'origin', 'main');
  const B = w.computer(`b${n}`);
  B.use();
  B.brain = path.join(B.ws, 'ai_brain');
  w.clone(brainUrl, B.brain);
  fs.mkdirSync(B.projects, { recursive: true });
  // Each makes its first map after that commit; A pushes first.
  A.use();
  w.clone(w.bare(`alpha${n}`), path.join(A.projects, `alpha${n}`));
  await M.updateMap({ dir: A.ws, projects: A.projects });
  w.sh(A.brain, 'add', 'workspace.json');
  w.sh(A.brain, 'commit', '-q', '-m', M.COMMIT_MESSAGE);
  w.sh(A.brain, 'push', '-q');
  B.use();
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  await M.updateMap({ dir: B.ws, projects: B.projects });
  M.writeMap({ ...M.readMap(B.ws).map, projects: [...M.readMap(B.ws).map.projects, P(`handonly${n}`)] }, B.ws);
  w.sh(B.brain, 'add', 'workspace.json');
  w.sh(B.brain, 'commit', '-q', '-m', M.COMMIT_MESSAGE);
  const r = await round(B);
  assert.deepEqual(r.pushed, { done: true }, JSON.stringify(r));
  const onServer = serverMap(server).projects.map((p) => p.name).sort();
  assert.deepEqual(onServer, [`alpha${n}`, `blog${n}`], 'the server\'s map, plus blog from B\'s disk; nothing of B\'s map (handonly)');
  assert.deepEqual(names(B), onServer);
});

test('(f) a round cut off between the move and the write, in case (c): the kept result is written as it is, with A\'s rename and B\'s project, and no old entry', async () => {
  const { B, server, shop, serverNames } = await bothMoved();
  let cut = false;
  const run = async (a, o) => {
    const res = await capture(a, o);
    if (!cut && a.includes('reset') && a.includes('--keep')) {
      cut = true;
      throw new Error('cut off after the move');
    }
    return res;
  };
  await round(B, { run });
  assert.ok(cut, 'the round was cut off after the move');
  assert.equal(fs.existsSync(pendingOf(B)), true, 'what step (3) was about to write waits beside the git folder');
  B.use();
  const p = await K.finishPending({ dir: B.ws });
  assert.equal(p.finished, true, JSON.stringify(p));
  assert.deepEqual(names(B), [`blog${n}`, shop]);
  assert.deepEqual(dirsOf(M.readMap(B.ws).map, shop), [`code/${shop}-api2`, `code/${shop}-web`], 'A\'s rename, no old entry');
  assert.equal(fs.existsSync(pendingOf(B)), false);
  const r = await round(B);
  assert.deepEqual(r.pushed, { done: true }, JSON.stringify(r));
  assert.deepEqual(serverNames(), [`blog${n}`, shop]);
  assert.deepEqual(dirsOf(serverMap(server), shop), [`code/${shop}-api2`, `code/${shop}-web`]);
});

test('a commit of the owner\'s that changes no file stops the rule: nothing is taken off the branch', async () => {
  const { A, B } = await two();
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  assert.deepEqual((await round(B, { push: false, holdOwn: true })).commit, { done: true });
  w.sh(B.brain, 'commit', '-q', '--allow-empty', '-m', 'Owner: decision recorded here');
  const mine = w.sh(B.brain, 'rev-parse', 'HEAD');
  const r = await round(B);
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((x) => /your commit [0-9a-f]{7} "Owner: decision recorded here", which changes no file/.test(x)), r.needs.join('\n'));
  assert.equal(w.sh(B.brain, 'rev-parse', 'HEAD'), mine, 'the branch did not move');
});

test('a commit of the owner\'s that changes only the map is his too: it stays on the branch', async () => {
  const { A, B } = await two();
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  B.use();
  const map = M.readMap(B.ws).map;
  M.writeMap({ ...map, skip: ['by-hand'] }, B.ws);
  w.sh(B.brain, 'commit', '-q', '-am', 'Owner: forget by-hand');
  const mine = w.sh(B.brain, 'rev-parse', 'HEAD');
  const r = await round(B);
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((x) => /your commit [0-9a-f]{7} "Owner: forget by-hand"/.test(x)), r.needs.join('\n'));
  assert.equal(w.sh(B.brain, 'rev-parse', 'HEAD'), mine);
});

test('Hoprig\'s own map commits that the rule takes off the branch stay reachable under a ref of Hoprig\'s', async () => {
  const { A, B, serverNames } = await two();
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  assert.deepEqual((await round(B, { push: false, holdOwn: true })).commit, { done: true });
  const own = w.sh(B.brain, 'rev-parse', 'HEAD');
  const r = await round(B);
  assert.deepEqual(r.pushed, { done: true }, JSON.stringify(r));
  assert.deepEqual(serverNames(), [`blog${n}`, `shop${n}`]);
  assert.ok(reachable(B.brain, own), 'the commit the move left is still under a ref');
  assert.ok(w.sh(B.brain, 'for-each-ref', '--format=%(refname)', K.KEPT).split('\n').some((x) => x.startsWith(K.KEPT)));
});

test('a file git ignores here that the git server has: the move stops and the owner\'s file stays as it was', async () => {
  const { A, B } = await two();
  B.use();
  fs.appendFileSync(path.join(B.brain, '.git', 'info', 'exclude'), 'private.md\n');
  fs.writeFileSync(path.join(B.brain, 'private.md'), 'B OWN TEXT, never on a server\n');
  A.use();
  w.commit(A.brain, 'private.md', 'from A\n', 'A tracks private.md');
  w.sh(A.brain, 'push', '-q');
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  const head = (B.use(), w.sh(B.brain, 'rev-parse', 'HEAD'));
  const r = await round(B);
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((x) => /a file that is here already and that git does not track here \(private\.md\)/.test(x)), r.needs.join('\n'));
  assert.equal(fs.readFileSync(path.join(B.brain, 'private.md'), 'utf8'), 'B OWN TEXT, never on a server\n');
  assert.equal(w.sh(B.brain, 'rev-parse', 'HEAD^'), head, 'only this round\'s map commit was added; the branch was not moved');
});

test('two names that differ only in letter case: the one of this side is left out and named, the rest reaches the server', async () => {
  const { A, B, serverNames } = await two();
  w.clone(w.bare(`Shop${n}`), path.join(A.projects, `Shop${n}`));
  await round(A);
  w.clone(w.bare(`shop${n}`), path.join(B.projects, `shop${n}`));
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  const r = await round(B);
  assert.equal(r.skipped, undefined, JSON.stringify(r));
  assert.deepEqual(r.pushed, { done: true }, JSON.stringify(r));
  assert.ok(r.needs.some((x) => new RegExp(`shop${n} is not put into the map: .*differ only in letter case`).test(x)), r.needs.join('\n'));
  assert.deepEqual(serverNames(), [`Shop${n}`, `blog${n}`]);
  assert.equal(fs.existsSync(path.join(B.brain, '.git', 'hoprig-map-pending.json')), false);
  // A later, unrelated project still goes up.
  w.clone(w.bare(`wiki${n}`), path.join(B.projects, `wiki${n}`));
  const r2 = await round(B);
  assert.equal(r2.skipped, undefined);
  assert.ok(serverNames().includes(`wiki${n}`));
});

test('a kept map that holds two names differing only in case: the next round leaves one out, writes the rest, removes the file', async () => {
  const { B } = await two();
  B.use();
  const map = M.readMap(B.ws).map;
  M.writeMap({ ...map, projects: [...map.projects, { name: 'Docs', url: w.url('Docs'), repos: [] }] }, B.ws);
  w.sh(B.brain, 'commit', '-q', '-am', 'Owner: Docs');
  w.sh(B.brain, 'push', '-q');
  // The kept file is a three-way result: the server's map (Docs) with what this side added (docs, kept).
  const kept = { ...map, projects: [...map.projects, { name: 'Docs', url: w.url('Docs'), repos: [] }, { name: 'docs', url: w.url('docs'), repos: [] }, { name: 'kept', url: w.url('kept'), repos: [] }] };
  fs.writeFileSync(path.join(B.brain, '.git', 'hoprig-map-pending.json'), JSON.stringify(kept));
  const p = await K.finishPending({ dir: B.ws });
  assert.equal(p.finished, true, JSON.stringify(p));
  assert.deepEqual(p.left.map((l) => l.ref), ['docs']);
  assert.deepEqual(names(B), ['Docs', 'kept']);
  assert.equal(fs.existsSync(path.join(B.brain, '.git', 'hoprig-map-pending.json')), false);
});

test('a kept map while the map on disk is refused: the kept file stays and the owner is told why', async () => {
  const { B } = await two();
  B.use();
  const map = M.readMap(B.ws).map;
  const pending = path.join(B.brain, '.git', 'hoprig-map-pending.json');
  fs.writeFileSync(pending, JSON.stringify({ ...map, projects: [{ name: 'onlyhere', url: w.url('onlyhere'), repos: [] }] }));
  fs.writeFileSync(path.join(B.brain, 'workspace.json'), '{ broken');
  const p = await K.finishPending({ dir: B.ws });
  assert.equal(p.finished, false);
  assert.match(p.why, /waits beside the brain's git folder .* the map here was refused/);
  assert.equal(fs.existsSync(pending), true, 'the kept side is not thrown away');
  // Once the map can be read again, the next round puts it back.
  M.writeMap(map, B.ws);
  const r = await round(B, { commit: false, push: false });
  assert.ok(r.lines.some((l) => /kept from a round that was cut off/.test(l)), JSON.stringify(r));
  assert.ok(names(B).includes('onlyhere'));
  assert.equal(fs.existsSync(pending), false);
});

test('memory on: both computers move, the memory commit here is carried over, both end with both projects, nobody is told', async () => {
  const { A, B, server, serverNames } = await two();
  // B adds a project and pushes; A adds another and learns something, then its round runs with memory on.
  w.clone(w.bare(`notes${n}`), path.join(B.projects, `notes${n}`));
  assert.deepEqual((await round(B)).pushed, { done: true });
  A.use();
  fs.mkdirSync(path.join(A.brain, 'claude-memory', 'home'), { recursive: true });
  fs.writeFileSync(path.join(A.brain, 'claude-memory', 'home', 'MEMORY.md'), '- learned on A\n');
  w.clone(w.bare(`extra${n}`), path.join(A.projects, `extra${n}`));
  const r = await round(A, { memory: true });
  assert.deepEqual(r.needs, [], r.needs.join('\n'));
  assert.deepEqual(r.pushed, { done: true }, JSON.stringify(r));
  assert.deepEqual(serverNames(), [`extra${n}`, `notes${n}`]);
  assert.equal(w.sh(server, 'show', 'main:claude-memory/home/MEMORY.md'), '- learned on A');
  assert.equal(w.sh(A.brain, 'rev-list', '--left-right', '--count', 'HEAD...@{u}'), '0\t0');
  assert.equal(w.sh(A.brain, 'status', '--porcelain'), '');
  for (const b of [A.brain, server]) assert.equal(w.sh(b, 'rev-list', '--merges', 'main'), '');
  // B, with memory on too, learns something else: its round carries its memory over A's.
  B.use();
  fs.mkdirSync(path.join(B.brain, 'claude-memory'), { recursive: true });
  fs.writeFileSync(path.join(B.brain, 'claude-memory', 'note.md'), 'learned on B\n');
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  A.use();
  w.clone(w.bare(`wiki${n}`), path.join(A.projects, `wiki${n}`));
  await round(A);
  const rb = await round(B, { memory: true });
  assert.deepEqual(rb.needs, [], rb.needs.join('\n'));
  assert.deepEqual(rb.pushed, { done: true });
  assert.deepEqual(serverNames(), [`blog${n}`, `extra${n}`, `notes${n}`, `wiki${n}`]);
  assert.equal(w.sh(server, 'show', 'main:claude-memory/note.md'), 'learned on B');
  assert.equal(w.sh(server, 'show', 'main:claude-memory/home/MEMORY.md'), '- learned on A');
});

test('one memory file changed on both computers: the rule stops with nothing changed (a text only the owner merges)', async () => {
  const { A, B } = await two();
  A.use();
  fs.mkdirSync(path.join(A.brain, 'claude-memory'), { recursive: true });
  fs.writeFileSync(path.join(A.brain, 'claude-memory', 'MEMORY.md'), 'A\n');
  assert.deepEqual((await round(A, { memory: true })).pushed, { done: true });
  B.use();
  fs.mkdirSync(path.join(B.brain, 'claude-memory'), { recursive: true });
  fs.writeFileSync(path.join(B.brain, 'claude-memory', 'MEMORY.md'), 'B\n');
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  const r = await round(B, { memory: true });
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((x) => /a memory file changed here and on the git server \(claude-memory\/MEMORY\.md\)/.test(x)), r.needs.join('\n'));
  assert.equal(fs.readFileSync(path.join(B.brain, 'claude-memory', 'MEMORY.md'), 'utf8'), 'B\n');
});

test('a push the git server refuses by a hook: tried once, and the owner gets the server\'s own reason', async () => {
  const { A, B, server } = await two();
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  fs.writeFileSync(path.join(server, 'hooks', 'pre-receive'), '#!/bin/sh\necho "protected branch: main" >&2\nexit 1\n', { mode: 0o755 });
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  const { capture } = await import('../../src/setup/system.mjs');
  let pushes = 0;
  const r = await round(B, { run: async (a, o) => (a.includes('push') && pushes++, capture(a, o)) });
  assert.equal(pushes, 1);
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((x) => /could not be uploaded: protected branch: main; \[remote rejected\] main -> main \(pre-receive hook declined\)/.test(x)), r.needs.join('\n'));
  assert.ok(!r.needs.some((x) => /moved again/.test(x)));
  fs.rmSync(path.join(server, 'hooks', 'pre-receive'));
});

test('a rebase under way or a detached HEAD in the brain: nothing is committed into it and the owner is told', async () => {
  const { B } = await two();
  B.use();
  w.commit(B.brain, 'one.md', '1\n', 'one');
  w.commit(B.brain, 'two.md', '2\n', 'two');
  // The owner's rebase stops at its first commit ("edit").
  const { execFileSync } = await import('node:child_process');
  const editor = path.join(w.root, 'edit-first.mjs');
  fs.writeFileSync(editor, "import fs from 'node:fs';\nconst f = process.argv[2];\nfs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^pick/, 'edit'));\n");
  execFileSync('git', ['-C', B.brain, 'rebase', '-i', 'HEAD~2'], { env: { ...process.env, GIT_SEQUENCE_EDITOR: `"${process.execPath}" "${editor}"` }, stdio: 'ignore' });
  const before = w.sh(B.brain, 'rev-parse', 'HEAD');
  w.clone(w.bare(`shop${n}`), path.join(B.projects, `shop${n}`));
  const r = await round(B, { memory: true });
  assert.equal(r.commit.done, false);
  assert.ok(r.needs.some((x) => /a rebase is under way in the brain/.test(x)), r.needs.join('\n'));
  assert.equal(w.sh(B.brain, 'rev-parse', 'HEAD'), before, 'no commit inside the owner\'s rebase');
  // The page's "Save it now" refuses too.
  const { commitMap } = await import('../../src/workspace/upkeep.mjs');
  assert.equal((await commitMap({ dir: B.ws })).busy, true);
  w.sh(B.brain, 'rebase', '--abort');
  w.sh(B.brain, 'checkout', '-q', '--detach');
  const d = await round(B);
  assert.equal(d.commit.done, false);
  assert.ok(d.needs.some((x) => /on no branch \(a detached HEAD\)/.test(x)), d.needs.join('\n'));
  w.sh(B.brain, 'checkout', '-q', 'main');
  w.sh(B.brain, 'branch', '--unset-upstream');
  const u = await round(B);
  assert.equal(u.commit.done, true);
  assert.ok(u.needs.some((x) => /branch main has no upstream on a git server, so the map is not uploaded/.test(x)), u.needs.join('\n'));
});

test('the activity line after the rule committed and pushed says saved and uploaded, never that saving is off', async () => {
  const { A, B } = await two();
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  assert.deepEqual((await round(B, { push: false, holdOwn: true })).commit, { done: true }, 'B\'s map commit is made in an earlier round');
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  const { apply } = await import('../../src/automation/workspacesync.mjs');
  const records = [];
  B.use();
  await apply([{ type: 'map', commit: true, push: true, memory: false }], { record: (x) => records.push(x), notify: () => {}, save: () => {}, data: {}, workspaceMap: (o) => upkeepMap({ dir: B.ws, projects: B.projects, ...o }) });
  const line = records.find((x) => /brought in step with the one on the git server/.test(x.did));
  assert.ok(line, JSON.stringify(records));
  assert.equal(line.outcome, 'saved in the brain and uploaded');
});

test('one name with two addresses on two computers: four alternating rounds leave the git server\'s address as it was', async () => {
  const { A, B, server } = await two();
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  w.bare(`shop${n}-fork`);
  w.clone(w.url(`shop${n}-fork`), path.join(B.projects, `shop${n}`));
  const addr = () => JSON.parse(w.sh(server, 'show', 'main:workspace.json')).projects.find((p) => p.name === `shop${n}`).url;
  await round(A);
  const first = addr();
  const commits = w.sh(server, 'rev-list', '--count', 'main');
  const told = [];
  for (const c of [B, A, B, A]) told.push(...(await round(c)).needs);
  assert.equal(addr(), first, 'the address on the git server never changed');
  assert.equal(w.sh(server, 'rev-list', '--count', 'main'), commits, 'no commit flips the address back and forth');
  assert.ok(told.some((x) => new RegExp(`shop${n}: the folder here has another address .*shop${n}-fork.* than the map`).test(x)), told.join('\n'));
  assert.ok(told.every((x) => !/the folder here has another address \([^)]*\/shop\d+\.git\)/.test(x)), 'A, whose folder has the map\'s address, is never told');
});

test('sync on: a brain the map\'s rule settles in the same round is no thing to decide, and nothing is notified', async () => {
  const { A, B, serverNames } = await two();
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  assert.deepEqual((await round(B, { push: false, holdOwn: true })).commit, { done: true });
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  const WS = await import('../../src/automation/workspacesync.mjs');
  const { syncAll } = await import('../../src/workspace/sync.mjs');
  const settings = { map: true, commitMap: true, memory: false, sync: true, push: true, pushBranches: {}, everyHours: 6 };
  const { actions } = WS.decide({ data: { saidOnDemand: true }, now: Date.now(), boot: true, settings });
  const notes = [];
  B.use();
  await WS.apply(actions, {
    record: () => {},
    notify: (x) => notes.push(`${x.title} | ${x.message}`),
    save: () => {},
    data: { saidOnDemand: true },
    workspaceSync: (o) => syncAll({ dir: B.ws, projects: B.projects, upkeep: true, ...o }),
    workspaceMap: (o) => upkeepMap({ dir: B.ws, projects: B.projects, ...o }),
  });
  assert.deepEqual(notes, [], notes.join('\n'));
  assert.deepEqual(names(B), [`blog${n}`, `shop${n}`]);
  assert.deepEqual(serverNames(), [`blog${n}`, `shop${n}`]);
});

test('two computers take one label: the one whose file came second picks another; a label on the server only is taken', async () => {
  n++;
  const brainUrl = w.bare(`brain${n}`, { empty: true });
  const server = path.join(w.server, 'team', `brain${n}.git`);
  const A = w.computer(`a${n}`);
  A.use();
  A.brain = path.join(A.ws, 'ai_brain');
  fs.mkdirSync(A.projects, { recursive: true });
  w.sh(A.ws, 'clone', '-q', brainUrl, A.brain);
  w.commit(A.brain, 'BRAIN.md', '# brain\n');
  await M.updateMap({ dir: A.ws, projects: A.projects });
  w.sh(A.brain, 'add', '-A');
  w.sh(A.brain, 'commit', '-q', '-m', 'map');
  w.sh(A.brain, 'push', '-q', '-u', 'origin', 'main');
  const B = w.computer(`b${n}`);
  B.use();
  B.brain = path.join(B.ws, 'ai_brain');
  w.clone(brainUrl, B.brain);
  fs.mkdirSync(B.projects, { recursive: true });
  A.use();
  assert.equal((await C.setLabel('box', { dir: A.ws, projects: A.projects })).state, 'new');
  B.use();
  assert.equal((await C.setLabel('box', { dir: B.ws, projects: B.projects })).state, 'new', 'neither file was on the server yet');
  await round(A);
  const rb = await round(B);
  const hint = rb.needs.find((x) => /holds another computer's id/.test(x));
  assert.ok(hint, rb.needs.join('\n'));
  assert.match(hint, /Give this computer another label: {2}hoprig workspace label <name>/);
  assert.match(hint, /only if this IS that computer.*take its file over/);
  // B picks another label: allowed, since its file under "box" is not its own.
  B.use();
  assert.equal((await C.setLabel('boxb', { dir: B.ws, projects: B.projects })).state, 'new');
  assert.deepEqual((await round(B)).needs, []);
  const files = w.sh(server, 'ls-tree', '--name-only', 'main', 'computers/').split('\n').sort();
  assert.deepEqual(files, ['computers/box.json', 'computers/boxb.json']);
  // A third computer whose brain was not fetched since box.json went up: the server's file refuses the label.
  const D = w.computer(`d${n}`);
  D.use();
  D.brain = path.join(D.ws, 'ai_brain');
  fs.mkdirSync(D.projects, { recursive: true });
  w.sh(D.ws, 'clone', '-q', brainUrl, D.brain);
  w.sh(D.brain, 'reset', '-q', '--hard', 'HEAD~2');
  assert.equal(fs.existsSync(path.join(D.brain, 'computers', 'box.json')), false, 'not in this brain yet');
  await assert.rejects(C.setLabel('box', { dir: D.ws, projects: D.projects }), (e) => e.code === 'ETAKEN');
});

test('a home folder copied to another computer: the copy is noticed, it stops writing the file and takes an id of its own', async () => {
  const { A, B, server } = await two();
  // C is a copy of B's home: the same settings (label boxb and its id), its own projects from now on.
  const Cc = w.computer(`c${n}`);
  fs.cpSync(B.home, Cc.home, { recursive: true });
  Cc.brain = path.join(Cc.ws, 'ai_brain');
  B.use();
  const idB = C.thisComputer().id;
  Cc.use();
  assert.equal(C.thisComputer().id, idB, 'the copy has the same id');
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  w.clone(w.bare(`cms${n}`), path.join(Cc.projects, `cms${n}`));
  const told = { B: [], C: [] };
  for (let i = 0; i < 3; i++) {
    told.B.push(...(await round(B)).needs);
    told.C.push(...(await round(Cc)).needs);
    await round(A);
  }
  const twin = /holds this computer's id, but this computer did not write what is in it: two computers use one id/;
  assert.ok([...told.B, ...told.C].some((x) => twin.test(x)), JSON.stringify(told));
  // The file on the server stopped flipping: whatever it holds was written by one of them, and keeps blog or cms.
  const commits = () => w.sh(server, 'rev-list', '--count', 'main', '--', 'computers/boxb.json');
  const before = commits();
  await round(B);
  await round(Cc);
  await round(B);
  assert.equal(commits(), before, 'no more commits of computers/boxb.json from the two of them');
  // The one told takes an id and a label of its own; both files then live side by side.
  const who = told.C.some((x) => twin.test(x)) ? Cc : B;
  who.use();
  const r = await C.setLabel('boxc', { dir: who.ws, projects: who.projects, newId: true });
  assert.equal(r.state, 'new');
  assert.notEqual(C.thisComputer().id, idB);
  await round(who);
  await round(who === B ? Cc : B);
  const files = w.sh(server, 'ls-tree', '--name-only', 'main', 'computers/').split('\n').sort();
  assert.deepEqual(files, ['computers/boxa.json', 'computers/boxb.json', 'computers/boxc.json']);
  const here = (l) => JSON.parse(w.sh(server, 'show', `main:computers/${l}.json`)).here;
  assert.deepEqual([...here('boxb'), ...here('boxc')].sort(), [`blog${n}`, `cms${n}`]);
});

test('more versions of its own file saved here than it remembers, then the rule brings back the one the server holds: still its own', async () => {
  const { A, B, server } = await two();
  // Pushing off for a while: every round saves a new version of computers/boxb.json in B's history only.
  for (let i = 0; i < 22; i++) {
    fs.mkdirSync(path.join(B.ws, 'development', `kit${i}`), { recursive: true });
    assert.deepEqual((await round(B, { push: false, holdOwn: true })).needs, []);
  }
  // A moves the server; B pushes again: the rule moves B to the server's commit, which holds B's first version.
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  const twin = /two computers use one id/;
  const told = [...(await round(B)).needs, ...(await round(B)).needs];
  assert.ok(!told.some((x) => twin.test(x)), JSON.stringify(told));
  assert.match(w.sh(server, 'show', 'main:computers/boxb.json'), /kit21/, 'its newest file reaches the server');
});

test('a file name that is not plain ASCII: an ignored file in the way still stops the move, and the owner\'s text stays', async () => {
  const { A, B } = await two();
  B.use();
  fs.appendFileSync(path.join(B.brain, '.git', 'info', 'exclude'), 'privé notes.md\n');
  fs.writeFileSync(path.join(B.brain, 'privé notes.md'), 'B OWN TEXT, never on a server\n');
  A.use();
  w.commit(A.brain, 'privé notes.md', 'from A\n', 'A tracks privé notes.md');
  w.sh(A.brain, 'push', '-q');
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  const r = await round(B);
  assert.equal(r.pushed.done, false);
  assert.ok(r.needs.some((x) => x.includes('that git does not track here (privé notes.md)')), r.needs.join('\n'));
  assert.equal(fs.readFileSync(path.join(B.brain, 'privé notes.md'), 'utf8'), 'B OWN TEXT, never on a server\n');
});

test('a memory file whose name is not plain ASCII: carried over like any other, and named as it is when both sides changed it', async () => {
  const { A, B, server, serverNames } = await two();
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  B.use();
  fs.mkdirSync(path.join(B.brain, 'claude-memory'), { recursive: true });
  fs.writeFileSync(path.join(B.brain, 'claude-memory', 'नोट.md'), 'learned on B\n');
  w.clone(w.bare(`blog${n}`), path.join(B.projects, `blog${n}`));
  const r = await round(B, { memory: true });
  assert.deepEqual(r.needs, [], r.needs.join('\n'));
  assert.deepEqual(r.pushed, { done: true });
  assert.deepEqual(serverNames(), [`blog${n}`, `shop${n}`]);
  assert.equal(w.sh(server, 'show', 'main:claude-memory/नोट.md'), 'learned on B');
  // The same file changed on both computers: the rule stops and names it as it is, not in git's escapes.
  A.use();
  w.sh(A.brain, 'pull', '-q');
  fs.writeFileSync(path.join(A.brain, 'claude-memory', 'नोट.md'), 'A\n');
  assert.deepEqual((await round(A, { memory: true })).pushed, { done: true });
  B.use();
  fs.writeFileSync(path.join(B.brain, 'claude-memory', 'नोट.md'), 'B\n');
  w.clone(w.bare(`wiki${n}`), path.join(B.projects, `wiki${n}`));
  const r2 = await round(B, { memory: true });
  assert.equal(r2.pushed.done, false);
  assert.ok(r2.needs.some((x) => x.includes('a memory file changed here and on the git server (claude-memory/नोट.md)')), r2.needs.join('\n'));
  assert.equal(fs.readFileSync(path.join(B.brain, 'claude-memory', 'नोट.md'), 'utf8'), 'B\n');
});

test('a new address given by hoprig workspace map here, while the other computer moved: the rule takes it up; the server\'s stays only when it changed that address too', async () => {
  const { A, B, server } = await two();
  w.clone(w.bare(`shop${n}`), path.join(A.projects, `shop${n}`));
  await round(A);
  w.clone(w.url(`shop${n}`), path.join(B.projects, `shop${n}`));
  await round(B);
  await round(A);
  const addr = () => JSON.parse(w.sh(server, 'show', 'main:workspace.json')).projects.find((p) => p.name === `shop${n}`).url;
  const mineAddr = (c) => M.readMap(c.ws).map.projects.find((p) => p.name === `shop${n}`).url;
  // B's project moved to a new address and the owner runs what the upkeep's words tell him (hoprig workspace map).
  w.bare(`shop${n}-new`);
  w.sh(path.join(B.projects, `shop${n}`), 'remote', 'set-url', 'origin', w.url(`shop${n}-new`));
  B.use();
  await M.updateMap({ dir: B.ws, projects: B.projects });
  assert.equal(mineAddr(B), w.url(`shop${n}-new`));
  // A moves the server first; B's round runs the rule.
  w.clone(w.bare(`blog${n}`), path.join(A.projects, `blog${n}`));
  await round(A);
  const r = await round(B);
  assert.equal(r.pushed.done, true, JSON.stringify(r));
  assert.ok(!r.needs.some((x) => /another address/.test(x)), r.needs.join('\n'));
  assert.equal(mineAddr(B), w.url(`shop${n}-new`), 'B\'s map keeps the address its owner gave it');
  assert.equal(addr(), w.url(`shop${n}-new`), 'and it reaches the server');
  // Both changed it since they parted: the server's stays, and B is told.
  await round(A);
  w.bare(`shop${n}-b2`);
  w.sh(path.join(B.projects, `shop${n}`), 'remote', 'set-url', 'origin', w.url(`shop${n}-b2`));
  B.use();
  await M.updateMap({ dir: B.ws, projects: B.projects });
  assert.deepEqual((await round(B, { push: false, holdOwn: true })).commit, { done: true });
  A.use();
  w.bare(`shop${n}-a2`);
  w.sh(path.join(A.projects, `shop${n}`), 'remote', 'set-url', 'origin', w.url(`shop${n}-a2`));
  await M.updateMap({ dir: A.ws, projects: A.projects });
  assert.equal((await round(A)).pushed.done, true);
  const r2 = await round(B);
  assert.equal(addr(), w.url(`shop${n}-a2`), 'the server\'s own change stays');
  assert.ok(r2.needs.some((x) => new RegExp(`shop${n}: the folder here has another address .*shop${n}-b2.* than the map`).test(x)), r2.needs.join('\n'));
});
