// The push of the other branches (src/workspace/branchpush.mjs, the one press of "Before you format this computer" and
// the upkeep's per-place switch) never moves a default branch, also where this computer's own idea of it is wrong: a
// clone whose origin/HEAD is stale (the server's default was changed after the clone) pushes nothing of that repository,
// and a branch that follows another remote is said, never pushed into that remote. On a local "git server" only.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { dropWorld, reset, serverHeads } from './dropfix.mjs';

const w = await dropWorld('bp-default', { labels: ['desk'] });
test.after(() => w.cleanup());
const [D] = w.computers;
const { pushBranches } = await import('../../src/workspace/branchpush.mjs');
const push = () => pushBranches({ dir: D.ws, projects: D.projects, on: ['projects'] });

test('a stale origin/HEAD: the server\'s real default branch is not pushed, and the command that mends it is named', async () => {
  D.use();
  await reset(D);
  const api = path.join(D.shop, 'code', 'shop-api');
  w.sh(api, 'push', '-q', 'origin', 'main:refs/heads/legacy');
  w.sh(api, 'fetch', '-q', 'origin');
  w.sh(api, 'remote', 'set-head', 'origin', 'legacy'); // this clone believes "legacy" is the default; the server says main
  const main0 = serverHeads(w, 'shop-api').main;
  w.commit(api, 'release.txt', 'ship\n');
  const r = await push();
  assert.equal(serverHeads(w, 'shop-api').main, main0, 'the server\'s main did not move');
  const e = r.repos.find((x) => /shop-api/.test(x.label));
  assert.ok(e && !e.pushed.length, JSON.stringify(r));
  assert.ok(e.todo.some((t) => /calls main its default branch, and this computer knows legacy/.test(t.why) && /remote set-head origin --auto/.test(t.command)), JSON.stringify(e));
  w.sh(api, 'remote', 'set-head', 'origin', 'main');
});

test('a branch that follows another remote is said, never pushed into it', async () => {
  D.use();
  await reset(D);
  const api = path.join(D.shop, 'code', 'shop-api');
  const up = w.bare('bp-upstream');
  const bareDir = path.join(w.server, 'team', 'bp-upstream.git');
  w.sh(bareDir, 'branch', 'develop', 'main');
  w.sh(bareDir, 'symbolic-ref', 'HEAD', 'refs/heads/develop');
  w.sh(api, 'remote', 'add', 'upstream', up);
  w.sh(api, 'fetch', '-q', 'upstream');
  w.sh(api, 'switch', '-q', '-c', 'develop', '--track', 'upstream/develop');
  w.commit(api, 'up.txt', 'up\n');
  w.sh(api, 'switch', '-q', 'main');
  const before = serverHeads(w, 'bp-upstream').develop;
  try {
    const r = await push();
    assert.equal(serverHeads(w, 'bp-upstream').develop, before, 'the other remote\'s default branch did not move');
    const e = r.repos.find((x) => /shop-api/.test(x.label));
    assert.ok(e && !e.pushed.includes('develop'), JSON.stringify(r));
    assert.ok(e.todo.some((t) => /develop follows a branch of another git server \(upstream\)/.test(t.why)), JSON.stringify(e));
  } finally {
    w.sh(api, 'branch', '-q', '-D', 'develop');
    w.sh(api, 'remote', 'remove', 'upstream');
  }
});

test('a branch of its own is still pushed when the server and this computer agree on the default', async () => {
  D.use();
  await reset(D);
  const api = path.join(D.shop, 'code', 'shop-api');
  w.sh(api, 'switch', '-q', '-c', 'feature/y');
  const y = w.commit(api, 'y.txt', 'y\n');
  w.sh(api, 'switch', '-q', 'main');
  const r = await push();
  assert.equal(serverHeads(w, 'shop-api')['feature/y'], y, JSON.stringify(r));
});
