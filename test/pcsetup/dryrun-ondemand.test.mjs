// A dry run changes NOTHING, for every command this step added or changed: restore without projects, the computer's
// label, the map with this computer's own file, status --all, get --list, a get that meets a clone cut off half way,
// sync of one project, and the upkeep's switches shown. Each runs on the rich world of dryrun-fixture.mjs with a full
// snapshot of the temporary home before and after (every path, type, size, mode, time, inode and content hash, and
// the refs of every repository and of the bare "server" ones): no difference at all. Then the real command, to show
// the world is real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { dryWorld, gh, runCli } from './dryrun-fixture.mjs';

const { getMain } = await import('../../src/pcsetup/getproject.mjs');
const ws = await import('../../src/workspace/cli.mjs');
const get = (args) => runCli((a, o) => getMain(a, o), args);
const workspace = (args) => runCli((a, o) => ws.main(a, o), args);

test('workspace restore --dry-run without projects, and the real restore: no project is cloned', async (tc) => {
  const w = await dryWorld(tc, 'restore-od');
  const r = await w.unchanged('workspace restore --dry-run', () => workspace(['restore', gh('brain'), '--dry-run']));
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /in the map, not on this computer, not cloned .*blog/);
  await w.unchanged('workspace restore --dry-run --json', () => workspace(['restore', gh('brain'), '--dry-run', '--json']));
  const real = await w.changed('workspace restore --yes', () => workspace(['restore', gh('brain'), '--yes']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.ok(!fs.existsSync(path.join(w.projects, 'blog')), 'blog stays in the map');
  assert.match(real.r.text, /hoprig get blog/);
});

test('workspace label --dry-run, map --dry-run with the computer\'s file, status --all, get --list, auto: nothing changes', async (tc) => {
  const w = await dryWorld(tc, 'label-od');
  const d = await w.unchanged('workspace label box1 --dry-run', () => workspace(['label', 'box1', '--dry-run']));
  assert.equal(d.code, 0, d.text);
  assert.match(d.text, /\(dry run\) this computer is box1 in the workspace: nothing was written/);
  await w.unchanged('workspace label (show)', () => workspace(['label']));
  await w.unchanged('workspace status --all', () => workspace(['status', '--all']));
  await w.unchanged('workspace status --all --json', () => workspace(['status', '--all', '--json']));
  await w.unchanged('get --list', () => get(['--list']));
  await w.unchanged('get --list --json', () => get(['--list', '--json']));
  await w.unchanged('workspace auto (show)', () => workspace(['auto']));
  const real = await w.changed('workspace label box1', () => workspace(['label', 'box1']));
  assert.match(real.diff, /added home\/Workspace\/ai_brain\/computers\/box1\.json/);
  const m = await w.unchanged('workspace map --dry-run (with a label)', () => workspace(['map', '--dry-run']));
  assert.equal(m.code, 0, m.text);
});

test('get --dry-run over a clone cut off half way, and sync <project> --dry-run: nothing moves', async (tc) => {
  const w = await dryWorld(tc, 'cutoff-od');
  // What a killed clone of shop-web leaves: the address, no commit checked out.
  const web = path.join(w.shop, 'code', 'shop-web');
  fs.rmSync(web, { recursive: true, force: true });
  fs.mkdirSync(web, { recursive: true });
  execFileSync('git', ['-C', web, 'init', '-q']);
  execFileSync('git', ['-C', web, 'remote', 'add', 'origin', gh('shop-web')]);
  const g = await w.unchanged('get shop --dry-run', () => get(['shop', '--dry-run']));
  assert.equal(g.code, 0, g.text);
  await w.unchanged('workspace sync shop --dry-run', () => workspace(['sync', 'shop', '--dry-run']));
  const real = await w.changed('get shop', () => get(['shop', '--yes']));
  assert.match(real.diff, /added home\/Workspace\/projects\/shop\/code\/\.shop-web\.broken-\d{8}-\d{6}/, 'kept aside, never deleted');
});
