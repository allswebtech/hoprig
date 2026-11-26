// `hoprig drop --dry-run` and `--check` change NOTHING, on the rich world of dryrun-fixture.mjs with groups, plus one
// thing of every kind drop looks at: changed, staged and untracked work, a stash, a tag only here, a branch without an
// upstream, a branch ahead, a detached HEAD with its own commit, a repository inside without a git server, an ignored
// .env, test-data/, an unknown ignored file, build output, a real memory folder, a linked worktree outside the project,
// a link that points out, a project folder that is a link, a group member, and a second computer's file in the brain.
// A full snapshot of the whole temporary home (every path, type, size, mode, time, inode and hash, every ref of every
// repository and of the bare "server" ones) before and after: no difference at all. Then a real drop, to show the
// world is real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { dryWorld, gh, runCli } from './dryrun-fixture.mjs';

const { main } = await import('../../src/workspace/dropcli.mjs');
const { repoLabel } = await import('../../src/workspace/drop.mjs');
const drop = (args) => runCli((a, o) => main(a, o), args);

test('drop --dry-run and --check of every project, alone and together, with --json: nothing changes', async (tc) => {
  const w = await dryWorld(tc, 'drop', { groups: true });
  const api = path.join(w.shop, 'code', 'shop-api');
  const web = path.join(w.shop, 'code', 'shop-web');
  // Work of every kind in shop.
  fs.writeFileSync(path.join(api, 'README.md'), 'changed\n');
  fs.writeFileSync(path.join(api, 'staged.txt'), 'staged\n');
  w.sh(api, 'add', 'staged.txt');
  fs.writeFileSync(path.join(w.shop, 'notes.txt'), 'untracked\n');
  fs.writeFileSync(path.join(web, 'aside.txt'), 'aside\n');
  w.sh(web, 'add', 'aside.txt');
  w.sh(web, 'stash', '-q');
  w.sh(web, 'tag', 'v0.1');
  w.sh(web, 'branch', 'idea');
  w.sh(api, 'switch', '-q', '--detach');
  fs.writeFileSync(path.join(api, 'lost.txt'), 'lost\n');
  w.sh(api, 'add', 'lost.txt');
  w.sh(api, 'commit', '-q', '-m', 'on no branch');
  const nested = path.join(w.shop, 'tools', 'local');
  fs.mkdirSync(nested, { recursive: true });
  w.sh(nested, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(nested, 'x.txt'), 'x\n');
  w.sh(nested, 'add', '-A');
  w.sh(nested, 'commit', '-q', '-m', 'only here');
  fs.appendFileSync(path.join(w.shop, '.git', 'info', 'exclude'), 'test-data/\n*.dump\ntools/\n');
  fs.writeFileSync(path.join(w.shop, '.env'), 'SECRET=1\n');
  fs.mkdirSync(path.join(w.shop, 'test-data'));
  fs.writeFileSync(path.join(w.shop, 'test-data', 'rows.csv'), 'a,b\n');
  fs.writeFileSync(path.join(w.shop, 'db.dump'), 'dump\n');
  fs.mkdirSync(path.join(web, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(web, 'node_modules', 'x', 'i.js'), 'made again\n');
  fs.symlinkSync(path.join(w.root, 'server'), path.join(w.shop, 'out.lnk'));
  w.sh(api, 'worktree', 'add', '-q', '--detach', path.join(w.root, 'side-wt'));
  const mem = path.join(w.env.CLAUDE_CONFIG_DIR, 'projects', web.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
  fs.mkdirSync(mem, { recursive: true });
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '# only here\n');
  // blog: a project folder that is a link, to a clone on another disk.
  const disk2 = path.join(w.root, 'disk2', 'blog');
  fs.mkdirSync(path.dirname(disk2), { recursive: true });
  w.sh(w.root, 'clone', '-q', gh('blog-workspace'), disk2);
  fs.symlinkSync(disk2, path.join(w.projects, 'blog'));
  // The member tool with its code repository, and a branch ahead in acme's code repository.
  w.sh(w.root, 'clone', '-q', gh('tool-core'), path.join(w.groups.tool, 'code', 'tool-core'));
  const acmeApp = path.join(w.groups.acme, 'code', 'acme-app');
  w.sh(acmeApp, 'switch', '-q', '-c', 'feature');
  fs.writeFileSync(path.join(acmeApp, 'f.txt'), 'f\n');
  w.sh(acmeApp, 'add', '-A');
  w.sh(acmeApp, 'commit', '-q', '-m', 'feature');
  w.sh(acmeApp, 'switch', '-q', 'main');
  // A second computer's file in the brain.
  fs.mkdirSync(path.join(w.brain, 'computers'), { recursive: true });
  fs.writeFileSync(path.join(w.brain, 'computers', 'box2.json'), `${JSON.stringify({ label: 'box2', id: 'a'.repeat(32), here: ['shop'], hoprig: '0.3.2' }, null, 2)}\n`);
  await new Promise((r) => setTimeout(r, 20));

  const all = ['shop', 'blog', 'clients/acme', 'clients/zeta', 'kits/packs/tool', 'kits/builds/widget'];
  for (const name of all) {
    for (const mode of ['--dry-run', '--check']) await w.unchanged(`drop ${name} ${mode}`, () => drop([name, mode]));
  }
  const d = await w.unchanged('drop of all --dry-run', () => drop([...all, '--dry-run']));
  assert.equal(d.code, 1, 'shop and blog are refused');
  for (const re of [/a stash with 1 entry/, /tag v0\.1 is only on this computer/, /HEAD is detached/, /projects\/shop\/tools\/local: it has no git server/, /a linked worktree of it is at .*side-wt, outside the project/, /Claude Code's memory for it is a real folder/, /projects[\\/]blog leaves its folder through a link: drop does not follow it/]) assert.match(d.text, re);
  const c = await w.unchanged('drop of all --check --json', () => drop([...all, '--check', '--json']));
  const j = JSON.parse(c.text.slice(c.text.indexOf('{')));
  assert.equal(j.mode, 'check');
  const shop = j.projects.find((p) => p.spec === 'shop');
  assert.deepEqual(shop.confirm.map((i) => i.path).sort(), ['.env', 'db.dump', 'test-data/'], 'build output and the nested repository\'s folder left out');
  // An untracked link git does not ignore is work: offered on a wip/ branch (its text, never its target).
  const work = shop.asks.find((a) => a.ask === 'work');
  assert.ok(work.repos.find((r) => r.repo === 'projects/shop').files.includes('out.lnk'), JSON.stringify(work));
  assert.ok(!JSON.stringify(j).includes('SECRET'), 'no content of a file');
  const acme = j.projects.find((p) => p.spec === 'clients/acme');
  assert.deepEqual(acme.pushes.map((p) => p.branch), ['feature']);
  // The world is real: a drop of acme without --dry-run changes it.
  const real = await w.changed('drop clients/acme', () => drop(['clients/acme']));
  assert.equal(real.r.code, 0, real.r.text);
  assert.match(real.diff, /removed home\/Workspace\/clients\/acme\n/);
});

test('a repository is named by its place in the workspace with / between its parts, also on Windows', () => {
  const ws = 'C:\\Users\\ann\\Workspace';
  assert.equal(repoLabel(`${ws}\\projects\\shop\\tools\\local`, { dir: ws }, path.win32), 'projects/shop/tools/local');
  assert.equal(repoLabel('D:\\elsewhere\\shop', { dir: ws }, path.win32), 'D:\\elsewhere\\shop', 'outside the workspace: its full path');
  assert.equal(repoLabel('/home/ann/Workspace/projects/shop/code/shop-api', { dir: '/home/ann/Workspace' }, path.posix), 'projects/shop/code/shop-api');
});
