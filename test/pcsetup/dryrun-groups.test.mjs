// The same promise in every place a project can be: a dry run changes nothing, and a project that is already here is
// not changed without asking. The world of dryrun-fixture.mjs with { groups: true }: a plain group with a project here
// and one only in the map, a group that is a repository holding a folder whose members come with it and one whose
// members are repositories of their own (with what an interrupted get left there), and a group not on this computer
// yet. Each test takes a snapshot of the whole temporary home, runs the dry run (no difference at all), then the real
// run (a difference: the world is real).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, makeWorld, runCli } from './dryrun-fixture.mjs';

const { getMain } = await import('../../src/pcsetup/getproject.mjs');
const { projectMain } = await import('../../src/pcsetup/project.mjs');
const ws = await import('../../src/workspace/cli.mjs');

const get = (args) => runCli((a, o) => getMain(a, o), args);
const project = (args) => runCli((a, o) => projectMain(a, o), args);
const workspace = (args) => runCli((a, o) => ws.main(a, o), args);
const exists = (p) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const groups = { groups: true };

test('hoprig get in a group --dry-run: a project here, one not here, a member that comes with its group, one by --in; without it they come and the one here is left alone', async (tc) => {
  const w = await dryWorld(tc, 'gget', groups);
  const g = w.groups;
  const acmeEnv = path.join(g.acme, 'code', 'acme-app', '.env');
  const here = await w.unchanged('get clients/acme --dry-run', () => get(['clients/acme', '--dry-run']));
  assert.equal(here.code, 0, here.text);
  assert.match(here.text, /hoprig project setup clients\/acme/);
  const missing = await w.unchanged('get clients/zeta --dry-run', () => get(['clients/zeta', '--dry-run']));
  assert.equal(missing.code, 0, missing.text);
  assert.match(missing.text, /\(dry run\) would clone .*zeta-workspace\.git into .*[\\/]clients[\\/]zeta/);
  const member = await w.unchanged('get kits/packs/tool --dry-run', () => get(['kits/packs/tool', '--dry-run']));
  assert.equal(member.code, 0, member.text);
  assert.match(member.text, /\(dry run\) would clone .*tool-core\.git/);
  const built = await w.unchanged('get kits/builds/widget --dry-run', () => get(['kits/builds/widget', '--dry-run']));
  assert.equal(built.code, 0, built.text);
  assert.match(built.text, /unfinished clone .* would be moved aside/);
  // A group that is not on this computer yet: its folder is not made by a dry run.
  const into = await w.unchanged('get <address> --in spare --dry-run', () => get([gh('extra-workspace'), '--in', 'spare', '--dry-run']));
  assert.equal(into.code, 0, into.text);
  assert.ok(!exists(path.join(w.ws, 'spare')));

  const real = await w.changed('get clients/zeta kits/packs/tool kits/builds/widget clients/acme', () => get(['clients/zeta', 'kits/packs/tool', 'kits/builds/widget', 'clients/acme']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(g.clients, 'zeta', '.git')));
  assert.ok(exists(path.join(g.tool, 'code', 'tool-core', '.env')), 'the code repository this run cloned is set up like a fresh clone');
  assert.ok(exists(path.join(g.builds, 'widget', '.git')));
  assert.ok(!exists(g.widgetLeftover), 'the unfinished clone was moved aside');
  assert.ok(!exists(acmeEnv), 'a project that was here is not changed');
  assert.match(real.r.text, /clients\/acme was already here, so nothing in it was changed/);
  const extra = await w.changed('get <address> --in spare', () => get([gh('extra-workspace'), '--in', 'spare']));
  assert.equal(extra.r.code, 0, extra.r.text);
  assert.ok(exists(path.join(w.ws, 'spare', 'extra', '.git')));
});

test('hoprig project new --in --dry-run: no folder in the group, also not the group\'s own; without it the project is made there', async (tc) => {
  const w = await dryWorld(tc, 'gnew', groups);
  for (const args of [['new', 'fresh', '--in', 'clients', '--dry-run'], ['new', 'fresh', '--in', 'spare', '--dry-run'], ['new', 'fresh', '--in', 'kits/builds', '--dry-run']]) {
    const r = await w.unchanged(`project ${args.join(' ')}`, () => project(args));
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /\(dry run\) would create .*[\\/]fresh/);
  }
  const real = await w.changed('project new fresh --in clients', () => project(['new', 'fresh', '--in', 'clients']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(w.groups.clients, 'fresh', '.git')));
});

test('hoprig project setup and link in a group --dry-run: nothing set up; without it the project in the group gets its .env, and the member its group\'s memory', async (tc) => {
  const w = await dryWorld(tc, 'gsetup', groups);
  const g = w.groups;
  const acme = await w.unchanged('project setup clients/acme --dry-run', () => project(['setup', 'clients/acme', '--dry-run']));
  assert.equal(acme.code, 0, acme.text);
  assert.match(acme.text, /\(dry run\) would copy \.env\.example to \.env in clients\/acme\/code\/acme-app/);
  const tool = await w.unchanged('project setup kits/packs/tool --dry-run', () => project(['setup', 'kits/packs/tool', '--dry-run']));
  assert.match(tool.text, /\(dry run\) would link Claude Code's memory for the project to \.\.\/\.\.\/ai_brain\/claude-memory/);
  for (const args of [['link', 'kits/packs/tool', '--dry-run'], ['link', 'kits', '--dry-run'], ['link', 'clients/acme', '--dry-run']]) await w.unchanged(`project ${args.join(' ')}`, () => project(args));
  const real = await w.changed('project setup clients/acme', () => project(['setup', 'clients/acme']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(g.acme, 'code', 'acme-app', '.env')));
  const linked = await w.changed('project link kits', () => project(['link', 'kits']));
  assert.match(linked.diff, /added home\/\.claude\/projects\/.*kits\/memory/);
});

test('hoprig workspace group add|remove|ignore --dry-run and group list change nothing; add, remove and ignore without it change the map or the ignore file', async (tc) => {
  const w = await dryWorld(tc, 'ggroup', groups);
  for (const args of [['group', 'list'], ['group', 'list', '--json'], ['group'], ['status'], ['status', '--json']]) {
    const r = await w.unchanged(`workspace ${args.join(' ')}`, () => workspace(args));
    assert.equal(r.code, 0, r.text);
  }
  for (const args of [['group', 'add', 'labs', '--dry-run'], ['group', 'add', 'kits2', '--repo', gh('kits2'), '--holds', 'parts', '--dry-run'], ['group', 'add', 'clients', '--dry-run', '--json'], ['group', 'remove', 'spare', '--dry-run'], ['group', 'remove', 'spare', '--dry-run', '--json']]) {
    const r = await w.unchanged(`workspace ${args.join(' ')}`, () => workspace(args));
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.text}`);
  }
  // The group's ignore file without the line for packs: said, not written.
  fs.writeFileSync(path.join(w.groups.kits, '.gitignore'), '/builds/*/\n');
  for (const args of [['group', 'ignore', 'kits', '--dry-run'], ['group', 'ignore', 'kits', '--dry-run', '--json'], ['group', 'ignore', 'kits']]) {
    const r = await w.unchanged(`workspace ${args.join(' ')}`, () => workspace(args));
    assert.match(r.text, /\/packs\/\*\/code\//, r.text);
  }
  const map = path.join(w.ws, 'ai_brain', 'workspace.json');
  const add = await w.changed('workspace group add labs', () => workspace(['group', 'add', 'labs']));
  assert.match(add.diff, /changed home\/Workspace\/ai_brain\/workspace\.json/);
  assert.match(fs.readFileSync(map, 'utf8'), /"labs"/);
  const rm = await w.changed('workspace group remove spare', () => workspace(['group', 'remove', 'spare']));
  assert.equal(rm.r.code, 0, rm.r.text);
  assert.doesNotMatch(fs.readFileSync(map, 'utf8'), /"spare"/);
  const ign = await w.changed('workspace group ignore kits --yes', () => workspace(['group', 'ignore', 'kits', '--yes']));
  assert.match(ign.diff, /changed home\/Workspace\/kits\/\.gitignore/);
});

test('hoprig workspace map --upgrade --dry-run: the map stays version 1; without it, it is version 2 (and an upgraded map is left alone)', async (tc) => {
  const w = await dryWorld(tc, 'gupgrade');
  const map = path.join(w.ws, 'ai_brain', 'workspace.json');
  for (const args of [['map', '--upgrade', '--dry-run'], ['map', '--upgrade', '--dry-run', '--json'], ['map', '--upgrade']]) await w.unchanged(`workspace ${args.join(' ')}`, () => workspace(args));
  const real = await w.changed('workspace map --upgrade --yes', () => workspace(['map', '--upgrade', '--yes']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.equal(JSON.parse(fs.readFileSync(map, 'utf8')).version, 2);
  for (const args of [['map', '--upgrade', '--dry-run'], ['map', '--upgrade', '--yes']]) await w.unchanged(`workspace ${args.join(' ')}, version 2 already`, () => workspace(args));
});

test('hoprig workspace map --dry-run with groups: the map is not written; without it it is', async (tc) => {
  const w = await dryWorld(tc, 'gmap', groups);
  fs.mkdirSync(path.join(w.groups.clients, 'loose'));
  w.sh(path.join(w.groups.clients, 'loose'), 'init', '-q', '-b', 'main');
  w.sh(path.join(w.groups.clients, 'loose'), 'commit', '-q', '--allow-empty', '-m', 'start');
  for (const args of [['map', '--dry-run'], ['map', '--dry-run', '--json']]) await w.unchanged(`workspace ${args.join(' ')}`, () => workspace(args));
  const real = await w.changed('workspace map', () => workspace(['map']));
  assert.match(real.diff, /changed home\/Workspace\/ai_brain\/workspace\.json/);
});

test('hoprig workspace restore --dry-run with groups: nothing cloned or linked; without it what is missing comes, and what was here is left alone', async (tc) => {
  const w = await dryWorld(tc, 'grestore', groups);
  const g = w.groups;
  const r = await w.unchanged('workspace restore --dry-run', () => workspace(['restore', gh('brain'), '--with-projects', '--dry-run']));
  assert.equal(r.code, 0, r.text);
  await w.unchanged('workspace restore --dry-run --json', () => workspace(['restore', gh('brain'), '--with-projects', '--dry-run', '--json']));
  const acmeEnv = path.join(g.acme, 'code', 'acme-app', '.env');
  const real = await w.changed('workspace restore --yes', () => workspace(['restore', gh('brain'), '--with-projects', '--yes']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(exists(path.join(g.clients, 'zeta', '.git')));
  assert.ok(exists(path.join(g.builds, 'widget', '.git')));
  assert.ok(exists(path.join(g.tool, 'code', 'tool-core', '.env')), 'what restore cloned is set up');
  assert.ok(!exists(acmeEnv), 'a project that was here is not changed');
  assert.match(real.r.text, /clients\/acme was already here, so nothing in it was changed\..*hoprig project setup clients\/acme/);
  // The group's own folder was here: its memory link is said, not made.
  assert.match(real.r.text, /kits was already here, so nothing in it was changed\. A fresh clone would also link Claude Code's memory .*hoprig project link kits/);
  assert.ok(!fs.readdirSync(path.join(w.home, '.claude', 'projects')).some((d) => d.endsWith('-kits')), 'no memory link for the group that was here');
});

test('hoprig workspace sync --dry-run with groups: no fetch, pull, push or commit in any group; project sync of a member the same; without it they happen', async (tc) => {
  const w = await dryWorld(tc, 'gsync', groups);
  // The group's repository and acme's code repository are behind the server; the member's code repository is here.
  const seed = path.join(w.root, 'seed', 'kits-2');
  w.sh(w.root, 'clone', '-q', gh('kits'), seed);
  fs.writeFileSync(path.join(seed, 'NEWS.md'), 'newer\n');
  w.sh(seed, 'add', '-A');
  w.sh(seed, 'commit', '-q', '-m', 'news');
  w.sh(seed, 'push', '-q');
  fs.rmSync(seed, { recursive: true, force: true });
  w.sh(w.root, 'clone', '-q', gh('tool-core'), path.join(w.groups.tool, 'code', 'tool-core'));
  for (const args of [['sync', '--dry-run'], ['sync', '--push', '--dry-run'], ['sync', '--memory', '--dry-run'], ['sync', '--dry-run', '--json']]) {
    const r = await w.unchanged(`workspace ${args.join(' ')}`, () => workspace(args));
    assert.match(r.text, /server's new commits on main/, r.text);
  }
  for (const args of [['sync', 'kits/packs/tool', '--dry-run'], ['sync', 'clients/acme', '--memory', '--dry-run']]) await w.unchanged(`project ${args.join(' ')}`, () => project(args));
  const real = await w.changed('workspace sync', () => workspace(['sync']));
  assert.match(real.diff, /kits\/\.git\/FETCH_HEAD/);
});

// Another computer is one Hoprig reaches by SSH, at a POSIX path (peer.mjs: ssh://<computer>/<path>).
test('hoprig workspace sync --with another computer, with groups: each group and member is pulled from the same folder there; a dry run changes nothing', { skip: process.platform === 'win32' && 'another computer is reached by SSH at a POSIX path; on Windows the stand-in for it would be this computer, whose folders are no such path' }, async (tc) => {
  const w = await dryWorld(tc, 'gpeer', groups);
  // The other computer (a stand-in ssh that runs the command here): its kits and clients/acme/code/acme-app are newer.
  const { syncWith } = await import('../../src/workspace/peer.mjs');
  const peer = path.join(w.root, 'peer');
  const newer = (url, dest) => {
    w.sh(w.root, 'clone', '-q', url, dest);
    fs.writeFileSync(path.join(dest, 'THERE.md'), 'from the other computer\n');
    w.sh(dest, 'add', '-A');
    w.sh(dest, 'commit', '-q', '-m', 'there');
  };
  newer(gh('kits'), path.join(peer, 'Workspace', 'kits'));
  newer(gh('acme-app'), path.join(peer, 'Workspace', 'clients', 'acme', 'code', 'acme-app'));
  const fake = path.join(w.root, 'bin', 'fake-ssh');
  fs.writeFileSync(fake, '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o|-p|-l) shift 2 ;; -*) shift ;; *) break ;; esac; done\nshift\nexec sh -c "$*"\n', { mode: 0o755 });
  w.env.GIT_SSH_COMMAND = fake;
  w.env.GIT_SSH_VARIANT = 'ssh';
  tc.after(() => {
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.GIT_SSH_VARIANT;
  });
  const info = { name: 'box2', target: 'alex@box2', dir: path.join(peer, 'Workspace'), projectsDir: path.join(peer, 'Workspace', 'projects') };
  const label = (r, l) => r.repos.find((x) => x.label === l);
  const dry = await w.unchanged('workspace sync --with box2 --dry-run', () => syncWith('box2', { info, dryRun: true }));
  assert.match(label(dry, 'kits').did[0], /would get main's new commits from box2/);
  assert.match(label(dry, 'clients/acme/code/acme-app').did[0], /would get main's new commits from box2/);
  assert.match(label(dry, 'kits/builds/widget').todo[0].why, /not on this computer/);
  const real = await w.changed('workspace sync --with box2', () => syncWith('box2', { info }));
  assert.deepEqual(label(real.r, 'kits').did, ['got 1 from box2']);
  assert.deepEqual(label(real.r, 'clients/acme/code/acme-app').did, ['got 1 from box2']);
  assert.ok(exists(path.join(w.groups.kits, 'THERE.md')));
  assert.ok(exists(path.join(w.groups.acme, 'code', 'acme-app', 'THERE.md')));
  // A member that comes with the group: only its code repository (not here), never a parent of its own.
  assert.equal(label(real.r, 'kits/packs/tool'), undefined);
  assert.match(label(real.r, 'kits/packs/tool/code/tool-core').todo[0].why, /not on this computer/);
});

test('the fixture with groups is what the tests above say', async () => {
  const w = await makeWorld('gshape', groups);
  try {
    assert.ok(exists(path.join(w.groups.kits, '.git')));
    assert.ok(exists(path.join(w.groups.tool, 'project.json')));
    assert.ok(!exists(path.join(w.groups.tool, 'code', 'tool-core')));
    assert.ok(exists(path.join(w.groups.acme, 'code', 'acme-app', '.env.example')));
    assert.ok(!exists(path.join(w.ws, 'spare')));
  } finally {
    w.cleanup();
  }
});
