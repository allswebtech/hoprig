// The judge of what a plain delete may reach on disk (src/plaindisk.mjs): random trees with markers outside the folder,
// in nested repositories at depths 1 to 5 and behind links at every level, and random rm lines with multi-level globs,
// ?, a slash at the end, absolute forms and several targets. Every line the rule answers is run with the real rm
// through bash in a fresh copy of its tree: no marker may go, no repository may be touched.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const { plainDelete } = await import('../src/asking.mjs');
const { SHARE, listing, scaled } = await import('./plainjudge.mjs');

// mulberry32: a seeded source whose state runs through all 2^32 values before it repeats.
let seed = 20261118;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rnd = (n) => Math.floor(rand() * n);
const pick = (list) => list[rnd(list.length)];

const NAMES = ['a', 'b', 'src', 'dist', 'x1', 'x2', 'tmp'];

// One tree under `root`: outside/ and orepo/ (a repository outside), proj/ with folders, nested repositories at depths
// 1 to 5, and links (to a folder outside, to the repository outside, to a folder inside, to a file outside) as middle
// and last parts. → { proj, markers (files that must stay), paths (what exists inside proj, for the lines) }
function makeTree(root) {
  const proj = path.join(root, 'proj');
  const markers = [];
  const file = (p) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    return p;
  };
  markers.push(file(path.join(root, 'outside', 'm1')), file(path.join(root, 'outside', 'sub', 'm2')));
  markers.push(file(path.join(root, 'orepo', '.git', 'm')), file(path.join(root, 'orepo', 'f')));
  const dirs = [proj];
  fs.mkdirSync(proj, { recursive: true });
  for (let i = 0; i < 6 + rnd(6); i++) {
    const parent = pick(dirs);
    if (parent.split('/').length - proj.split('/').length >= 4) continue;
    const d = path.join(parent, pick(NAMES));
    fs.mkdirSync(d, { recursive: true });
    if (!dirs.includes(d)) dirs.push(d);
    if (rand() < 0.5) file(path.join(d, `f${rnd(3)}`));
  }
  // Nested repositories at depths 1 to 5 below proj.
  for (let depth = 1; depth <= 5; depth++) {
    if (rand() < 0.4) continue;
    let d = proj;
    for (let i = 1; i < depth; i++) d = path.join(d, pick(['a', 'b', 'src']));
    const repo = path.join(d, `r${depth}`);
    // Its history must stay (a file of its own may go as in any repository: the rule judges a folder that is or holds
    // a repository, not a file in one).
    markers.push(file(path.join(repo, rand() < 0.5 ? '.git' : '.GIT', 'm')));
    file(path.join(repo, 'f'));
    if (!dirs.includes(path.dirname(repo))) dirs.push(path.dirname(repo));
  }
  // A folder named like an option that holds a repository: BSD rm (macOS) takes a -rf after a target as this name.
  if (rand() < 0.5) markers.push(file(path.join(proj, '-rf', 'r', '.git', 'm')));
  // Links at random levels.
  for (const [name, to, relative] of [['lo', path.join(root, 'outside')], ['lr', path.join(root, 'orepo')], ['li', pick(dirs)], ['lf', path.join(root, 'outside', 'm1')], ['lrel', path.join(root, 'outside'), true]]) {
    if (rand() < 0.3) continue;
    const at = pick(dirs);
    const p = path.join(at, name);
    if (!fs.existsSync(p)) fs.symlinkSync(relative ? path.relative(at, to) : to, p);
  }
  const paths = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      paths.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(proj, '');
  return { proj, markers, paths };
}

// A random target for the tree: an existing path, some parts turned into globs, maybe more parts, a slash, absolute.
function target(tree) {
  const parts = (pick(tree.paths) || 'a').split('/');
  for (let i = 0; i < parts.length; i++) {
    const r = rand();
    if (i > 0 && r < 0.25) parts[i] = '*';
    else if (i > 0 && r < 0.35) parts[i] = '?';
    else if (i > 0 && r < 0.45) parts[i] = `${parts[i][0]}*`;
  }
  if (rand() < 0.3) parts.push(pick(['*', '?', 'x', 'm1', 'f0', '*1']));
  if (rand() < 0.2) parts.push('*');
  let t = parts.join('/');
  if (rand() < 0.2) t += '/';
  if (rand() < 0.15) t = `${tree.proj}/${t}`;
  return t;
}

function line(tree) {
  const targets = [];
  for (let n = 1 + rnd(3); n > 0; n--) targets.push(target(tree));
  if (rand() < 0.06) targets.splice(1, 0, pick(['-rf', '-r', '--', '"-rf"'])); // after the first target
  return `rm ${pick(['-rf', '-r', '-rf', '-f', '-rfv'])} ${targets.join(' ')}`;
}

const q = (p) => `'${p.replace(/'/g, "'\\''")}'`;

// Runs the lines of one tree, each in a fresh copy (made from `template` at `root`), with the real rm through bash.
// Prints "REMOVED: <marker> after <line>" for a marker that is gone.
function runLines(root, template, markers, lines) {
  const script = [
    'n=0; while IFS= read -r L; do',
    `  rm -rf ${q(root)}; cp -a ${q(template)} ${q(root)}`,
    `  (cd ${q(path.join(root, 'proj'))} && eval "$L") </dev/null >/dev/null 2>&1`,
    `  while IFS= read -r M; do [ -e "$M" ] || echo "REMOVED: $M after $L"; done < ${q(`${template}.markers`)}`,
    '  n=$((n+1)); done; echo "ran $n"',
  ].join('\n');
  fs.writeFileSync(`${template}.markers`, `${markers.join('\n')}\n`);
  return new Promise((resolve, reject) => {
    const p = spawn('bash', ['--norc', '--noprofile', '-c', script], { env: { PATH: process.env.PATH, HOME: path.join(root, 'nohome'), LC_ALL: 'C.UTF-8' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`bash ended with ${code}`))));
    p.stdin.end(`${lines.join('\n')}\n`);
  });
}

test('the real shell decides: of ten thousand random rm lines in random trees, no answered one removes a marker outside, behind a link or in a repository', { skip: process.platform === 'win32' && 'needs a POSIX shell and rm', timeout: 300_000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-judge-')));
  try {
    const TREES = scaled(25, { root: true });
    const PER = scaled(400, { root: true });
    const jobs = [];
    let answered = 0;
    const distinct = new Set();
    for (let k = 0; k < TREES; k++) {
      const root = path.join(base, `t${k}`);
      const tree = makeTree(root);
      const lines = [];
      for (let i = 0; i < PER; i++) {
        const l = line(tree);
        distinct.add(`${k}|${l}`);
        if (plainDelete(l, { home: '/home/alex', workspace: '/home/alex/Workspace', cwd: tree.proj })) lines.push(l);
      }
      answered += lines.length;
      const template = path.join(base, `t${k}.template`);
      fs.cpSync(root, template, { recursive: true, verbatimSymlinks: true });
      jobs.push({ root, template, markers: tree.markers, lines });
    }
    assert.ok(answered > (TREES * PER) / 10, `enough answered lines to run: ${answered}`);
    // Four shells side by side.
    const outs = [];
    for (let i = 0; i < jobs.length; i += 4) outs.push(...(await Promise.all(jobs.slice(i, i + 4).map((j) => runLines(j.root, j.template, j.markers, j.lines)))));
    // Each removed marker is said with its line and its tree before the assertion, so that a log shows all of them.
    outs.forEach((o, k) => {
      const removed = o.split('\n').filter((l) => l.startsWith('REMOVED'));
      if (removed.length) process.stdout.write(`# tree ${k}:\n${[...removed, listing(jobs[k].template)].join('\n').replace(/^/gm, '#   ')}\n`);
    });
    assert.deepEqual(outs.flatMap((o) => o.split('\n').filter((l) => l.startsWith('REMOVED'))), [], 'no marker removed');
    assert.equal(outs.reduce((sum, o) => sum + Number(/ran (\d+)/.exec(o)[1]), 0), answered);
    process.stdout.write(`# judge on ${process.platform}${SHARE < 1 ? ` (${SHARE} of the full size, a CI runner)` : ''}: ${TREES * PER} lines tried in ${TREES} trees (${distinct.size} distinct), ${answered} answered and run with the real rm, 0 markers removed\n`);
    assert.ok(distinct.size > TREES * PER * 0.9, `distinct lines: ${distinct.size}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('what cannot be told is no plain delete: a name that is not UTF-8, ? against a wide name, the inside of a git folder, a mount', { skip: process.platform === 'win32' && 'POSIX names and links' }, (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-told-')));
  try {
    const proj = path.join(base, 'proj');
    const at = (command) => plainDelete(command, { home: '/home/alex', workspace: '/home/alex/Workspace', cwd: proj });
    const mk = (...ds) => ds.forEach((d) => fs.mkdirSync(path.join(proj, d), { recursive: true }));
    // A name that is not valid UTF-8 (bash matches it; the look could not read it as text). Some disks refuse to make
    // one (APFS on macOS: EILSEQ); there no such name can be met, and that part is said to be left out.
    mk('x');
    let made = true;
    try {
      fs.mkdirSync(Buffer.concat([Buffer.from(`${proj}/x/`), Buffer.from([0xff]), Buffer.from('/.git')]), { recursive: true });
    } catch (e) {
      if (e.code !== 'EILSEQ') throw e;
      made = false;
      t.diagnostic('left out: this disk does not take a name that is not UTF-8 (EILSEQ)');
    }
    if (made) for (const command of ['rm -rf x/*', 'rm -rf x']) assert.equal(at(command), false, command);
    // ? is one character for bash (one byte under LC_ALL=C), one UTF-16 unit for the look.
    mk('y/😀/.git', 'z/é');
    for (const command of ['rm -rf y/?', 'rm -rf z/?']) assert.equal(at(command), false, command);
    mk('w/ab');
    assert.equal(at('rm -rf w/?b'), true, 'plain names only: told');
    // The inside of a bare repository, of a separate git folder (HEAD as a file or a link), and a folder on the way.
    for (const g of ['mirror.git', 'gd', 'gd2']) mk(`${g}/objects/ab`, `${g}/refs/heads`);
    fs.writeFileSync(path.join(proj, 'mirror.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(proj, 'gd', 'HEAD'), 'ref: refs/heads/main\n');
    fs.symlinkSync('elsewhere', path.join(proj, 'gd2', 'HEAD'));
    for (const command of ['rm -rf mirror.git/*', 'rm -rf mirror.git/objects', 'rm -rf mirror.git/objects/ab', 'rm -rf gd/objects', 'rm -rf gd2/objects', 'rm -rf gd2/refs/heads']) assert.equal(at(command), false, command);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a mount below or on the way to a path rm gets is no plain delete, also a bind of the same file system', { skip: process.platform !== 'linux' && 'the mount table is read on Linux only' }, (t) => {
  const bwrap = spawnSync('bash', ['-c', 'command -v bwrap']).stdout.toString().trim();
  if (!bwrap || spawnSync(bwrap, ['--dev-bind', '/', '/', 'true']).status !== 0) return t.skip('bwrap cannot make a mount here');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-mount-')));
  try {
    const proj = path.join(base, 'proj');
    fs.mkdirSync(path.join(proj, 'm', 'sub', 'mnt'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'other'), { recursive: true });
    fs.mkdirSync(path.join(base, 'far', 'keep'), { recursive: true });
    const asking = new URL('../src/asking.mjs', import.meta.url).href;
    const code = `const { plainDelete } = await import(${JSON.stringify(asking)}); const at = (c) => plainDelete(c, { home: '/home/alex', workspace: '/home/alex/Workspace', cwd: ${JSON.stringify(proj)} });
      process.stdout.write(JSON.stringify(['rm -rf m', 'rm -rf m/sub', 'rm -rf m/*', 'rm -rf m/sub/mnt/keep', 'rm -rf other'].map(at)));`;
    const r = spawnSync(bwrap, ['--dev-bind', '/', '/', '--bind', path.join(base, 'far'), path.join(proj, 'm', 'sub', 'mnt'), process.execPath, '--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), [false, false, false, false, true], r.stderr);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a git folder whose objects is a link (kept in a store elsewhere), and a worktree\'s own git folder (HEAD and commondir), are repositories', { skip: process.platform === 'win32' && 'links' }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-gitkinds-')));
  try {
    const proj = path.join(base, 'proj');
    const at = (command) => plainDelete(command, { home: '/home/alex', workspace: '/home/alex/Workspace', cwd: proj });
    fs.mkdirSync(path.join(base, 'store', 'ab'), { recursive: true });
    fs.mkdirSync(path.join(proj, 'mirror', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(proj, 'mirror', 'HEAD'), 'ref: refs/heads/main\n');
    fs.symlinkSync(path.join(base, 'store'), path.join(proj, 'mirror', 'objects'));
    fs.mkdirSync(path.join(proj, 'pkg', 'inner'), { recursive: true });
    fs.cpSync(path.join(proj, 'mirror'), path.join(proj, 'pkg', 'inner', 'mirror'), { recursive: true, verbatimSymlinks: true });
    fs.mkdirSync(path.join(proj, 'wtadmin'));
    for (const [f, text] of [['HEAD', 'ref: refs/heads/side\n'], ['commondir', '../../src/.git\n'], ['gitdir', '/elsewhere/wt/.git\n']]) fs.writeFileSync(path.join(proj, 'wtadmin', f), text);
    for (const command of ['rm -rf mirror', 'rm -rf mirror/refs', 'rm -f mirror/HEAD', 'rm -rf pkg', 'rm -rf wtadmin', 'rm -f wtadmin/HEAD']) assert.equal(at(command), false, command);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('judged as a superset of what any shell option hands to rm: a dot and any case are matched, other glob signs refused; bash with those options is the judge', { skip: process.platform === 'win32' && 'needs bash and rm' }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-shopt-')));
  try {
    const proj = path.join(base, 'proj');
    const make = () => {
      fs.rmSync(proj, { recursive: true, force: true });
      for (const d of ['sub/.git', 'x/Repo/.git', 'y/a', 'z/.hidden', 'w/b']) fs.mkdirSync(path.join(proj, d), { recursive: true });
      fs.writeFileSync(path.join(proj, 'sub', '.git', 'm'), 'x');
      fs.writeFileSync(path.join(proj, 'x', 'Repo', '.git', 'm'), 'x');
      fs.mkdirSync(path.join(proj, 's2'));
      fs.writeFileSync(path.join(proj, 's2', '.git'), 'gitdir: ../elsewhere\n');
      fs.writeFileSync(path.join(proj, 'y', 'a', 'f'), 'x');
    };
    make();
    const at = (command) => plainDelete(command, { home: '/home/alex', workspace: '/home/alex/Workspace', cwd: proj });
    // What dotglob, nocaseglob, extglob, globstar or zsh could make reach a repository: no.
    for (const command of ['rm -rf sub/*', 'rm -rf sub/?git', 'rm -rf x/r*', 'rm -rf x/R*/*', 'rm -rf s2/*', 'rm -rf sub/*/m', 'rm -rf x/*/?git']) assert.equal(at(command), false, command);
    for (const command of ['rm -rf y/!(a)', 'rm -rf y/@(a)', 'rm -rf y/+(a)', 'rm -rf y/^a', 'rm -rf y/a#', 'rm -rf y/[a]', 'rm -rf y/{a,b}', 'rm -rf y/~a', 'rm -rf y/(a)']) assert.equal(at(command), false, command);
    // What stays plain, and holds under the widest options bash has.
    const plain = ['rm -rf y/*', 'rm -rf w/*', 'rm -rf y/a/*', 'rm -rf z/*', 'rm -rf w/B'];
    for (const command of plain) assert.equal(at(command), true, command);
    for (const command of plain) {
      make();
      spawnSync('bash', ['--norc', '--noprofile', '-c', `shopt -s dotglob nocaseglob extglob globstar; ${command}`], { cwd: proj });
      assert.ok(fs.existsSync(path.join(proj, 'sub', '.git', 'm')) && fs.existsSync(path.join(proj, 'x', 'Repo', '.git', 'm')) && fs.existsSync(path.join(proj, 's2', '.git')), command);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the look keeps to its budget also while it matches and checks: a costly glob over long names ends soon, with no', { skip: process.platform === 'win32' && 'long names' }, () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-steps-')));
  try {
    const proj = path.join(base, 'proj');
    fs.mkdirSync(path.join(proj, 'long'), { recursive: true });
    for (let i = 0; i < 5000; i++) fs.writeFileSync(path.join(proj, 'long', `${'a'.repeat(245)}${String(i).padStart(5, '0')}`), '');
    const at = (command) => plainDelete(command, { home: '/home/alex', workspace: '/home/alex/Workspace', cwd: proj });
    for (const command of [`rm -f long/*${'a'.repeat(120)}b*`, `rm -f long/${'*a'.repeat(120)}b`, `rm -f ${Array.from({ length: 7 }, () => `long/*${'a'.repeat(125)}b*`).join(' ')}`]) {
      const t = performance.now();
      assert.equal(at(command), false, command.slice(0, 40));
      assert.ok(performance.now() - t < 300, `${(performance.now() - t).toFixed(0)} ms`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
