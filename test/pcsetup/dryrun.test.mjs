// --dry-run changes nothing on the computer, for every command of the project and workspace area that takes it.
// Each test builds the rich world of dryrun-fixture.mjs (a project already here with a .env.example, hooks, an install
// and no memory link; one that is not here, with an unfinished clone and stale locks left by an earlier run), takes a
// full snapshot of the temporary home (every path, its type, size, time, inode and hash; the refs of every repository
// and of the bare "server" ones), runs the command with --dry-run and compares: no difference at all. Then it runs
// the same command without --dry-run, to show that the world is real and the command does change it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, runCli } from './dryrun-fixture.mjs';

const { getMain } = await import('../../src/pcsetup/getproject.mjs');
const { projectMain } = await import('../../src/pcsetup/project.mjs');
const ws = await import('../../src/workspace/cli.mjs');

const world = (tc, name) => dryWorld(tc, name);
const cli = runCli;
const get = (args) => cli((a, o) => getMain(a, o), args);
const project = (args) => cli((a, o) => projectMain(a, o), args);
const workspace = (args) => cli((a, o) => ws.main(a, o), args);
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

test('hoprig get --dry-run: a project already here and one that is not change nothing; without it they do', async (tc) => {
  const w = await world(tc, 'get');
  const shopEnv = path.join(w.shop, 'code', 'shop-api', '.env');
  const here = await w.unchanged('get shop --dry-run', () => get(['shop', '--dry-run']));
  assert.equal(here.code, 0, here.text);
  assert.match(here.text, /\.env\.example/); // what a fresh clone would have set up is said, not done
  const missing = await w.unchanged('get blog --dry-run', () => get(['blog', '--dry-run']));
  assert.equal(missing.code, 0, missing.text);
  assert.match(missing.text, /\(dry run\) would clone https:\/\/github\.com\/alex\/blog-workspace\.git into .*\/projects\/blog/);
  assert.match(missing.text, /unfinished clone .* would be moved aside/);
  const both = await w.unchanged('get shop blog --dry-run --json', () => get(['shop', 'blog', '--dry-run', '--json']));
  assert.deepEqual(JSON.parse(both.text.slice(both.text.indexOf('{'))).projects.map((p) => p.result), ['here', 'would clone']);

  const real = await w.changed('get blog', () => get(['blog']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(w.projects, 'blog', 'code', 'blog-app', '.env')), 'a fresh clone gets its .env');
  assert.ok(!exists(w.leftover), 'the unfinished clone was moved aside');
  for (const l of w.locks.slice(0, 1)) assert.ok(!exists(l), 'the stale lock was taken over and released');
  assert.ok(!exists(shopEnv));
});

test('hoprig project clone --dry-run: the same code as get, nothing changed; without it the project comes', async (tc) => {
  const w = await world(tc, 'clone');
  const dry = await w.unchanged('project clone shop blog --dry-run', () => project(['clone', 'shop', 'blog', '--dry-run']));
  assert.equal(dry.code, 0, dry.text);
  assert.match(dry.text, /hoprig project setup shop/);
  const real = await w.changed('project clone blog', () => project(['clone', 'blog']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(w.projects, 'blog', 'code', 'blog-app', '.git')));
});

test('hoprig project new --dry-run: no folder, no template clone, no settings; without it the project is made', async (tc) => {
  const w = await world(tc, 'new');
  for (const args of [['new', 'fresh', '--dry-run'], ['new', 'fresh', '--github', '--dry-run'], ['new', 'fresh', '--template', gh('notes'), '--dry-run']]) {
    const r = await w.unchanged(`project ${args.join(' ')}`, () => project(args));
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /\(dry run\) would create .*\/projects\/fresh/);
  }
  const real = await w.changed('project new fresh', () => project(['new', 'fresh']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(w.projects, 'fresh', '.git')));
});

test('hoprig project add --dry-run: no code repository made; without it there is one', async (tc) => {
  const w = await world(tc, 'add');
  for (const args of [['add', 'shop', 'admin', '--dry-run'], ['add', 'shop', 'admin', '--github', '--dry-run']]) {
    const r = await w.unchanged(`project ${args.join(' ')}`, () => project(args));
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /\(dry run\) would create .*\/shop\/code\/shop-admin/);
  }
  const real = await w.changed('project add shop admin', () => project(['add', 'shop', 'admin']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(w.shop, 'code', 'shop-admin', '.git')));
});

test('hoprig project sync --dry-run: no fetch, no pull, no push, no memory commit; without it all three happen', async (tc) => {
  const w = await world(tc, 'psync');
  const serverWeb = () => w.sh(path.join(w.server, 'alex', 'shop-web.git'), 'rev-parse', 'main');
  const pushedBefore = serverWeb();
  for (const args of [['sync', 'shop', '--dry-run'], ['sync', '--dry-run'], ['sync', 'shop', '--memory', '--dry-run']]) {
    const r = await w.unchanged(`project ${args.join(' ')}`, () => project(args));
    assert.match(r.text, /would fetch the server's new commits on main first/, r.text); // shop-api: not fetched, so not counted
    assert.match(r.text, /would push 1/, r.text); // shop-web
  }
  // The server's commit fetched by hand earlier (here, not merged): then a dry run counts it.
  w.sh(path.join(w.shop, 'code', 'shop-api'), 'fetch', '-q');
  const counted = await w.unchanged('project sync shop --dry-run, the commit here', () => project(['sync', 'shop', '--dry-run']));
  assert.match(counted.text, /code\/shop-api +would pull 1\b/, counted.text);
  const bad = await w.unchanged('project sync shop --dry-ru', () => project(['sync', 'shop', '--dry-ru']));
  assert.equal(bad.code, 1); // an unknown option is refused, never a real sync
  const real = await w.changed('project sync shop', () => project(['sync', 'shop']));
  assert.match(real.diff, /shop-api\/\.git\/FETCH_HEAD/);
  assert.notEqual(serverWeb(), pushedBefore, 'the push happened');
});

test('hoprig project link --dry-run: no memory link; without it the link is made', async (tc) => {
  const w = await world(tc, 'link');
  const r = await w.unchanged('project link shop --dry-run', () => project(['link', 'shop', '--dry-run']));
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\(dry run\) memory for the project: would link/);
  const real = await w.changed('project link shop', () => project(['link', 'shop']));
  assert.match(real.diff, /added home\/\.claude\/projects\/.*\/memory/);
});

test('hoprig project setup --dry-run: nothing set up; without it the .env, hooks and memory link are made', async (tc) => {
  const w = await world(tc, 'setup');
  const r = await w.unchanged('project setup shop --dry-run', () => project(['setup', 'shop', '--dry-run']));
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /\(dry run\) would copy \.env\.example to \.env in shop\/code\/shop-api/);
  assert.match(r.text, /\(dry run\) would use the git hooks in \.githooks for shop\b/);
  assert.match(r.text, /\(dry run\) would link Claude Code's memory for the project/);
  assert.match(r.text, /\(dry run\) would ask: shop-web: run npm install\?/);
  const real = await w.changed('project setup shop', () => project(['setup', 'shop']));
  assert.ok(exists(path.join(w.shop, 'code', 'shop-api', '.env')));
  assert.equal(w.sh(w.shop, 'config', '--get', 'core.hooksPath'), '.githooks');
  assert.match(real.r.text, /shop-web: run npm install\? \(installs its dependencies\) skipped: no terminal/);
  const again = await w.unchanged('project setup shop, a second time', () => project(['setup', 'shop']));
  assert.doesNotMatch(again.text, /\.env/);
});

test('hoprig workspace setup --dry-run: no folder made; without it the missing ones are', async (tc) => {
  const w = await world(tc, 'wsetup');
  const r = await w.unchanged('workspace setup --dry-run', () => workspace(['setup', '--dry-run']));
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /would create/);
  const real = await w.changed('workspace setup --yes', () => workspace(['setup', '--yes']));
  assert.match(real.diff, /added home\/Workspace\/credentials/);
});

test('hoprig workspace link --dry-run: no link, no backup; without it the coding tools are linked to the brain', async (tc) => {
  const w = await world(tc, 'wlink');
  const r = await w.unchanged('workspace link --dry-run', () => workspace(['link', '--dry-run']));
  assert.match(r.text, /CLAUDE\.md/);
  const real = await w.changed('workspace link --yes', () => workspace(['link', '--yes']));
  assert.match(real.diff, /added home\/\.claude\/CLAUDE\.md/);
});

test('hoprig workspace map --dry-run: the map is not written; without it it is', async (tc) => {
  const w = await world(tc, 'wmap');
  const r = await w.unchanged('workspace map --dry-run', () => workspace(['map', '--dry-run']));
  assert.match(r.text, /added: .*notes/);
  await w.unchanged('workspace map --dry-run --json', () => workspace(['map', '--dry-run', '--json']));
  const real = await w.changed('workspace map', () => workspace(['map']));
  assert.match(real.diff, /changed home\/Workspace\/ai_brain\/workspace\.json/);
});

test('hoprig workspace restore --dry-run: nothing cloned into the workspace, the temporary clone of a brain removed; without it the missing project comes and the one here is left alone', async (tc) => {
  const w = await world(tc, 'restore');
  const r = await w.unchanged('workspace restore --dry-run', () => workspace(['restore', gh('brain'), '--dry-run']));
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /blog .*clone/);
  // A brain that is not here yet: read from a temporary clone in the system's temporary folder, which is removed.
  const fresh = path.join(w.home, 'Elsewhere');
  const away = await w.unchanged('workspace restore --dry-run (no brain here)', async () => {
    process.env.HOPRIG_WORKSPACE_DIR = fresh;
    try {
      return await workspace(['restore', gh('brain'), '--dry-run', '--json']);
    } finally {
      process.env.HOPRIG_WORKSPACE_DIR = w.ws;
    }
  });
  assert.equal(away.code, 0, away.text);
  const shopEnv = path.join(w.shop, 'code', 'shop-api', '.env');
  const real = await w.changed('workspace restore --yes', () => workspace(['restore', gh('brain'), '--yes']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(w.projects, 'blog', 'code', 'blog-app', '.env')), 'what restore cloned is set up');
  assert.ok(!exists(shopEnv), 'a project that was here is not changed');
  assert.match(real.r.text, /shop was already here, so nothing in it was changed\. .*copy \.env\.example to \.env in shop\/code\/shop-api.*hoprig project setup shop/);
});

test('hoprig workspace sync --dry-run: no fetch, pull, push or commit, from the server or from another computer; without it they happen', async (tc) => {
  const w = await world(tc, 'wsync');
  for (const args of [['sync', '--dry-run'], ['sync', '--push', '--dry-run'], ['sync', '--memory', '--dry-run'], ['sync', '--dry-run', '--json']]) {
    const r = await w.unchanged(`workspace ${args.join(' ')}`, () => workspace(args));
    assert.match(r.text, /server's new commits on main/, r.text);
  }
  // Another computer over SSH (a stand-in ssh that runs the command here): its shop-api has the newer commit.
  const { syncWith } = await import('../../src/workspace/peer.mjs');
  const peer = path.join(w.root, 'peer');
  w.sh(w.root, 'clone', '-q', gh('shop-api'), path.join(peer, 'projects', 'shop', 'code', 'shop-api'));
  const fake = path.join(w.root, 'bin', 'fake-ssh');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o|-p|-l) shift 2 ;; -*) shift ;; *) break ;; esac; done\nshift\nexec sh -c "$*"\n', { mode: 0o755 });
  w.env.GIT_SSH_COMMAND = fake;
  w.env.GIT_SSH_VARIANT = 'ssh';
  tc.after(() => {
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_VARIANT;
  });
  const info = { name: 'box2', target: 'alex@box2', dir: path.join(peer, 'Workspace'), projectsDir: path.join(peer, 'projects') };
  const dry = await w.unchanged('workspace sync --with box2 --dry-run', () => syncWith('box2', { info, dryRun: true }));
  assert.match(dry.repos.find((x) => x.label === 'shop/code/shop-api').did[0], /would get main's new commits from box2/);
  const fromPeer = await w.changed('workspace sync --with box2', () => syncWith('box2', { info }));
  assert.deepEqual(fromPeer.r.repos.find((x) => x.label === 'shop/code/shop-api').did, ['got 1 from box2']);
  const real = await w.changed('workspace sync', () => workspace(['sync']));
  assert.match(real.diff, /FETCH_HEAD/);
});

test('hoprig workspace forget|set|auto|git do not take --dry-run: refused, nothing changed; forget without it changes the map', async (tc) => {
  const w = await world(tc, 'wrest');
  for (const args of [['forget', 'blog', '--dry-run'], ['set', '--projects', w.projects, '--dry-run'], ['auto', '--map', 'off', '--dry-run'], ['git', '--dry-run']]) {
    const r = await w.unchanged(`workspace ${args.join(' ')}`, () => workspace(args));
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.text}`);
  }
  const real = await w.changed('workspace forget blog', () => workspace(['forget', 'blog']));
  assert.match(real.diff, /workspace\.json/);
});
