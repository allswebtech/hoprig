// Property: where Hoprig acts it stays really inside (inside.mjs). Random trees with links in random places (inside
// the entry's folder, on the way to it, pointing inside, outside, up, nowhere, at another link; some named as the
// owner's own), tracked by a repository and not: no act ever changes, or reads for acting, a file whose real path is
// outside the entry's own folder. Shown by a snapshot of everything outside, before and after, and by a marker in the
// file outside that no file inside holds afterwards (a read through a link would copy it in).
//
//   1. the acts themselves, on 300 random trees (fast: the file system only; git and programs are recorded);
//   2. the flows that use them, on random workspaces with real git (local bare repositories): restore, get, sync with
//      --push, the upkeep's round with commit and push, project setup and its installs.
// A seed makes a run repeatable: HOPRIG_PROP_SEED=<n>; HOPRIG_PROP_TREES / HOPRIG_PROP_WORLDS change how many.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { gitWorld, quietUi } from './gitfix.mjs';

const SEED = Number(process.env.HOPRIG_PROP_SEED || 20261117);
const TREES = Number(process.env.HOPRIG_PROP_TREES || 300);
const WORLDS = Number(process.env.HOPRIG_PROP_WORLDS || 6);

/** A small seeded random source (mulberry32): the same seed, the same trees. */
function rand(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n) => Math.floor(next() * n), pick: (xs) => xs[Math.floor(next() * xs.length)], chance: (p) => next() < p };
}

/** Everything below `dir`, never following a link: { rel: 'd' | 'l:<target>' | 'f:<sha>' }. */
function snapshot(dir) {
  const out = {};
  const walk = (rel) => {
    let names = [];
    try {
      names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of names) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, r);
      if (d.isSymbolicLink()) out[r] = `l:${fs.readlinkSync(full)}`;
      else if (d.isDirectory()) {
        out[r] = 'd';
        walk(r);
      } else out[r] = `f:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
    }
  };
  walk('');
  return out;
}

/** The files below `dir` (never through a link) that hold `marker`: a read outside copied it in. */
function holding(dir, marker) {
  const hits = [];
  const walk = (d) => {
    let names = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && fs.readFileSync(full).includes(marker)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

const w = gitWorld('ws-insideprop');
test.after(() => w.cleanup());
const C = w.computer('c');
C.use();
const I = await import('../../src/workspace/inside.mjs');
const { saveConfig } = await import('../../src/config.mjs');

test(`the acts on ${TREES} random trees never touch or read anything outside the entry's own folder (seed ${SEED})`, async () => {
  const r = rand(SEED);
  let acted = 0;
  let refused = 0;
  for (let n = 0; n < TREES; n++) {
    const T = path.join(w.root, `t${n}`);
    const ws = path.join(T, 'ws');
    const projects = path.join(ws, 'projects');
    const OUT = path.join(T, 'OUT');
    const MINE = path.join(T, 'MINE');
    for (const d of [projects, path.join(ws, 'kits', 'builds'), path.join(OUT, 'sub'), MINE]) fs.mkdirSync(d, { recursive: true });
    const marker = `TOKEN=s3cr3t-${SEED}-tree-${n}`;
    fs.writeFileSync(path.join(OUT, 'secret.txt'), `${marker}\n`);
    fs.writeFileSync(path.join(OUT, 'sub', 'file'), 'outside\n');
    const mylinks = [];
    // The entry: a project of the projects folder, or a member of a group's held folder.
    const inGroup = r.chance(0.5);
    const root = inGroup ? path.join(ws, 'kits', 'builds', `m${n}`) : path.join(projects, `p${n}`);
    // A link on the way to the root (the held folder, the root itself), sometimes the owner's own.
    if (r.chance(0.25)) {
      const at = inGroup && r.chance(0.5) ? path.join(ws, 'kits', 'builds') : root;
      const mine = r.chance(0.4);
      const target = mine ? path.join(MINE, `w${n}`) : r.pick([OUT, path.join(OUT, 'sub'), path.join(ws, 'projects')]);
      fs.mkdirSync(target, { recursive: true });
      fs.rmSync(at, { recursive: true, force: true });
      fs.symlinkSync(target, at);
      if (mine) mylinks.push(at);
      if (at !== root) fs.mkdirSync(root, { recursive: true });
    } else fs.mkdirSync(root, { recursive: true });
    // Folders and files inside, then links in random places.
    const dirs = [root];
    for (let i = 0; i < 1 + r.int(4); i++) {
      const d = path.join(r.pick(dirs), r.pick(['a', 'b', 'code', 'src', 'mem']) + i);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, '.env.example'), 'X=1\n');
      dirs.push(d);
    }
    const links = [];
    for (let i = 0; i < r.int(5); i++) {
      const at = path.join(r.pick(dirs), `l${i}`);
      const kind = r.int(7);
      const target = [
        () => path.relative(path.dirname(at), r.pick(dirs)) || '.', // inside, relative
        () => r.pick(dirs), // inside, absolute
        () => r.pick([OUT, path.join(OUT, 'sub')]), // a folder outside
        () => path.join(OUT, 'secret.txt'), // a file outside
        () => '..', // up
        () => path.join(OUT, `nothing${i}`), // dangling, outside
        () => (links.length ? links[r.int(links.length)] : '..'), // another link
      ][kind]();
      try {
        fs.symlinkSync(target, at);
        links.push(at);
        if (r.chance(0.1) && !path.relative(root, at).startsWith('..')) {
          const mt = path.join(MINE, `x${n}-${i}`);
          fs.mkdirSync(mt, { recursive: true });
          fs.rmSync(at);
          fs.symlinkSync(mt, at);
          mylinks.push(at);
        }
      } catch {
        /* the name is taken */
      }
    }
    // Some of it tracked by a repository (git's index has no say any more: the result must be the same).
    if (r.chance(0.3)) {
      try {
        w.sh(root, 'init', '-q');
        w.sh(root, 'add', '-A');
      } catch {
        /* a root that leads out: git may refuse */
      }
    }
    const at = { root, dir: ws, projects, mylinks };
    const fences = [I.realOf(root), ...mylinks.map((m) => I.realOf(m))];
    const insideSomeFence = (p) => fences.some((f) => f && (p === f || p.startsWith(f + path.sep)));
    const before = snapshot(OUT);
    const recorded = [];
    // Where each would act: git -C <dir>, a clone's destination (its last argument), a program's cwd.
    const rec = async (argv, o = {}) => (recorded.push(argv[1] === '-C' ? argv[2] : o.cwd || argv[argv.length - 1]), { ok: true, output: '' });
    const candidates = [...dirs, ...links];
    for (let k = 0; k < 6; k++) {
      const base = r.pick(candidates);
      const name = `new${k}`;
      const target = path.join(base, r.chance(0.5) ? name : `${name}/deeper`);
      // The check's own promise: when it says inside, the real path is inside.
      if (!I.leaves(root, target, at)) {
        assert.ok(insideSomeFence(I.realOf(target)), `tree ${n}: ${target} said inside, real path ${I.realOf(target)}`);
      }
      const tries = [
        () => I.mkdirIn(at, target),
        () => I.writeIn(at, path.join(base, `${name}.txt`), 'written\n'),
        () => I.writeIn(at, path.join(r.pick(candidates)), 'over\n'),
        () => I.copyIn(at, path.join(r.pick(candidates), '.env.example'), path.join(base, `${name}.env`)),
        () => I.copyIn(at, r.pick(links.length ? links : candidates), path.join(base, `${name}.copy`)),
        () => I.renameIn(at, path.join(base, `${name}.txt`), path.join(base, `${name}.moved`)),
        () => I.removeIn(at, path.join(base, `${name}.moved`)),
      ];
      for (const t of tries) {
        try {
          t();
          acted++;
        } catch (e) {
          if (!/leaves its folder|not inside its folder|is a link|there already|not a regular file|ENOENT|EEXIST|ENOTDIR|EISDIR|ENOTEMPTY/.test(`${e.message} ${e.code}`)) throw e;
          refused++;
        }
      }
      await I.gitIn(at, base, ['status'], rec);
      await I.startIn(at, base, ['npm', 'ci'], rec);
      await I.cloneInto(at, path.join(base, `${name}-clone`), 'https://git.example.test/team/x.git', { run: rec });
    }
    for (const c of recorded) assert.ok(insideSomeFence(I.realOf(c)), `tree ${n}: a program or git ran in ${c} (real ${I.realOf(c)})`);
    assert.deepEqual(snapshot(OUT), before, `tree ${n}: something outside changed`);
    assert.deepEqual(holding(ws, marker), [], `tree ${n}: a file outside was read into the workspace`);
    fs.rmSync(T, { recursive: true, force: true });
  }
  assert.ok(acted > TREES && refused > TREES / 4, `both kinds were tried: ${acted} acts done, ${refused} refused`);
});

// ---- the flows, on random workspaces with real git ----

test(`restore, get, sync --push, the upkeep, project setup and its installs on ${WORLDS} random workspaces never act outside (seed ${SEED})`, async () => {
  const M = await import('../../src/workspace/map.mjs');
  const { restoreWorkspace } = await import('../../src/workspace/restore.mjs');
  const { syncAll } = await import('../../src/workspace/sync.mjs');
  const { upkeepMap } = await import('../../src/workspace/upkeep.mjs');
  const { projectSetup } = await import('../../src/pcsetup/project.mjs');
  const { getProject } = await import('../../src/pcsetup/getproject.mjs');
  const { stream } = await import('../../src/setup/system.mjs');
  const r = rand(SEED + 1);
  for (let n = 0; n < WORLDS; n++) {
    const OUT = path.join(w.root, `OUT${n}`);
    for (const d of ['shopcode/web/.githooks', 'builds', 'blogcode', 'kmem', 'smem']) fs.mkdirSync(path.join(OUT, d), { recursive: true });
    w.sh(path.join(OUT, 'shopcode', 'web'), 'init', '-q');
    fs.writeFileSync(path.join(OUT, 'shopcode', 'web', 'package.json'), '{"name":"web","version":"1.0.0"}\n');
    fs.writeFileSync(path.join(OUT, 'shopcode', 'web', '.env.example'), 'X=1\n');
    const marker = `TOKEN=s3cr3t-${SEED}-world-${n}`;
    fs.writeFileSync(path.join(OUT, 'secret.txt'), `${marker}\n`);
    // A repository of the owner's outside, with a commit only it has: nothing may ever push it.
    const victimUrl = w.bare(`victim${n}`);
    const victim = w.clone(victimUrl, path.join(OUT, 'builds', `acme${n}`, 'code', 'v'));
    w.commit(victim, 'LOCAL.md', 'mine\n');
    // The repositories of the map, each with random links committed in it.
    const name = (x) => `${x}${n}`;
    const links = {
      shop: [['code', path.join(OUT, 'shopcode')], ['.env.example', path.join(OUT, 'secret.txt')], ['ai_brain', path.join(OUT, 'smem')]].filter(() => r.chance(0.6)),
      kits: [['builds', path.join(OUT, 'builds')], ['packs/blog/code', path.join(OUT, 'blogcode')], ['mem', path.join(OUT, 'kmem')]].filter(() => r.chance(0.6)),
    };
    const seedRepo = (repo, files, ls) => {
      const s = w.clone(w.bare(name(repo)), path.join(w.root, `seed-${name(repo)}`));
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(s, rel)), { recursive: true });
        fs.writeFileSync(path.join(s, rel), text);
      }
      for (const [rel, to] of ls) {
        fs.mkdirSync(path.dirname(path.join(s, rel)), { recursive: true });
        fs.rmSync(path.join(s, rel), { recursive: true, force: true });
        fs.symlinkSync(to, path.join(s, rel));
      }
      w.sh(s, 'add', '-A');
      w.sh(s, 'commit', '-q', '-m', 'seed');
      w.sh(s, 'push', '-q', 'origin', 'main');
    };
    ['web', 'api', 'acme', 'x', 'blog-web'].forEach((x) => w.bare(name(x)));
    seedRepo('shop', { 'project.json': JSON.stringify({ name: 'shop', repos: [{ dir: 'code/web', url: w.url(name('web')) }, { dir: 'code/api', url: w.url(name('api')) }], memories: { '.': 'ai_brain/claude-memory' } }) }, links.shop);
    seedRepo('kits', { 'packs/blog/project.json': JSON.stringify({ name: 'blog', repos: [{ dir: 'code/blog-web', url: w.url(name('blog-web')) }], memories: {} }), '.gitignore': '/builds/*/\n/packs/*/code/\n' }, links.kits);
    const brainUrl = w.bare(name('brain'));
    const A = w.computer(`a${n}`);
    const bdir = w.clone(brainUrl, path.join(A.ws, 'ai_brain'));
    const map = {
      version: 2, brain: { url: brainUrl },
      groups: [{ dir: 'kits', url: w.url(name('kits')), memories: { '.': 'mem/claude' }, holds: [{ dir: 'builds' }, { dir: 'packs', parent: 'group' }] }],
      projects: [
        { name: 'shop', url: w.url(name('shop')), repos: [{ dir: 'code/web', url: w.url(name('web')) }, { dir: 'code/api', url: w.url(name('api')) }], memories: { '.': 'ai_brain/claude-memory' } },
        { name: `acme${n}`, in: 'kits/builds', url: w.url(name('acme')), repos: [{ dir: 'code/x', url: w.url(name('x')) }] },
        { name: 'blog', in: 'kits/packs', url: null, repos: [{ dir: 'code/blog-web', url: w.url(name('blog-web')) }] },
      ],
      others: [],
    };
    w.commit(bdir, 'workspace.json', JSON.stringify(map, null, 2) + '\n', 'map');
    w.sh(bdir, 'push', '-q', 'origin', 'main');
    // The computer that restores it.
    const B = w.computer(`b${n}`);
    B.use();
    process.env.HOPRIG_WORKSPACE_DIR = B.ws;
    saveConfig({ projectsDir: B.projects });
    const before = snapshot(OUT);
    const victimServer = path.join(w.server, 'team', `victim${n}.git`);
    const pushedBefore = w.sh(victimServer, 'rev-list', '--all', '--count');
    const started = [];
    // Clones are real; any other program (a dependency install) is only recorded, with where it would run.
    const runner = async (argv, o = {}) => {
      if (argv[0] === 'git' && argv[1] === 'clone') return stream(argv, o);
      started.push(o.cwd || '');
      return { ok: true, output: '' };
    };
    const q = await quietUi();
    q.ui.yes = true;
    await restoreWorkspace(brainUrl, { ui: q.ui, dir: B.ws, projects: B.projects, runner });
    // A link made by hand after the restore, in a code folder: the same as one a repository brought.
    const api = path.join(B.projects, 'shop', 'code', 'api');
    if (r.chance(0.5) && fs.existsSync(path.dirname(api)) && !fs.lstatSync(path.join(B.projects, 'shop', 'code')).isSymbolicLink()) {
      fs.rmSync(api, { recursive: true, force: true });
      fs.symlinkSync(path.join(OUT, 'shopcode', 'web'), api);
    }
    const ctx = { dir: B.ws, projects: B.projects };
    await syncAll({ ...ctx, push: true, memory: true });
    await upkeepMap({ ...ctx, commit: true, push: true });
    await projectSetup(['shop', '--yes'], { ui: q.ui, runner });
    await getProject('kits/packs/blog', { ui: q.ui, dir: B.projects, runner });
    assert.deepEqual(snapshot(OUT), before, `workspace ${n} (links ${JSON.stringify(links)}): something outside changed\n${q.text()}`);
    assert.deepEqual(holding(B.ws, marker), [], `workspace ${n}: a file outside was read into the workspace`);
    assert.equal(w.sh(victimServer, 'rev-list', '--all', '--count'), pushedBefore, `workspace ${n}: the repository outside was pushed`);
    for (const c of started) assert.ok(!I.realOf(c).startsWith(OUT + path.sep), `workspace ${n}: a program would run in ${c}, outside`);
    assert.ok(!JSON.stringify(M.readMap(B.ws).map).includes(`victim${n}`), `workspace ${n}: the map gained a repository outside`);
  }
});
