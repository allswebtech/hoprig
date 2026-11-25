// The git side of tools/lostcomputer.mjs: a stand-in git server of bare repositories on disk, the git settings of a
// home that reach only it, and what a home holds (every repository's branches, their trees, the work not committed,
// the memory folders), taken before the first home is deleted and compared with the second home.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SERVER = 'https://git.example.test/';
export const url = (name) => `${SERVER}team/${name}.git`;

/** git in `cwd` with the home's environment `env`; throws with git's own words when it fails. */
export function git(env, cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const tryGit = (env, cwd, ...args) => {
  try {
    return git(env, cwd, ...args);
  } catch {
    return '';
  }
};

/**
 * A home's own git settings: every address of the made-up server turns into a bare repository of `server`, and no
 * protocol but file is allowed (the environment says the same with GIT_ALLOW_PROTOCOL), so nothing leaves the disk.
 */
export function gitSettings(home, server) {
  const file = path.join(home, '.gitconfig');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(file, `[user]\n\tname = Example Owner\n\temail = owner@example.invalid\n[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[url "${server}/"]\n\tinsteadOf = ${SERVER}\n[protocol]\n\tallow = never\n[protocol "file"]\n\tallow = always\n`);
  return file;
}

/** A bare repository `team/<name>.git` on the server, filled from `files` ({ path: text }) in one commit when given. */
export function bare(env, server, name, files = null, scratch) {
  const d = path.join(server, 'team', `${name}.git`);
  fs.mkdirSync(d, { recursive: true });
  git(env, d, 'init', '-q', '--bare', '-b', 'main');
  if (files) {
    const w = fs.mkdtempSync(path.join(scratch, `seed-${name}-`));
    git(env, w, 'init', '-q', '-b', 'main');
    for (const [p, text] of Object.entries(files)) write(w, p, text);
    git(env, w, 'add', '-A');
    git(env, w, 'commit', '-q', '-m', `Start ${name}`);
    git(env, w, 'push', '-q', d, 'main');
    fs.rmSync(w, { recursive: true, force: true });
  }
  return url(name);
}

export function write(dir, rel, text) {
  const p = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
export function commit(env, dir, rel, text, msg = `Change ${rel}`) {
  write(dir, rel, text);
  git(env, dir, 'add', '-A');
  git(env, dir, 'commit', '-q', '-m', msg);
}

/** The id git gives a file's content (a blob), counted here so a file of either home is hashed the same way. */
const blobOf = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fileBlob = (p) => {
  try {
    const st = fs.lstatSync(p);
    return st.isSymbolicLink() ? blobOf(Buffer.from(fs.readlinkSync(p))) : st.isFile() ? blobOf(fs.readFileSync(p)) : null;
  } catch {
    return null;
  }
};

/** Every git repository under `top` (also one inside another's working tree), links never followed. */
export function reposUnder(top) {
  const out = [];
  const walk = (d) => {
    let list;
    try {
      list = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    if (list.some((e) => e.name === '.git')) out.push(d);
    for (const e of list) if (e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules') walk(path.join(d, e.name));
  };
  walk(top);
  return out.sort();
}

const lines = (s) => s.split('\n').filter(Boolean);
const refs = (env, dir, prefix) => Object.fromEntries(lines(tryGit(env, dir, 'for-each-ref', '--format=%(refname) %(objectname)', prefix)).map((l) => l.split(' ')).map(([r, sha]) => [r.slice(prefix.length + 1), sha]).filter(([n]) => n && n !== 'HEAD'));
/** Every tracked file of a commit: { path: blob id }. */
const treeOf = (env, dir, sha) => Object.fromEntries(lines(tryGit(env, dir, '-c', 'core.quotepath=off', 'ls-tree', '-r', '--full-tree', sha)).map((l) => { const [meta, p] = l.split('\t'); return [p, meta.split(' ')[2]]; }));

/**
 * One repository of the first home: its local branches with their heads and trees, the branch checked out, and each
 * file whose working copy is not what that branch holds (changed, new or deleted, git's ignored files left out).
 */
export function snapRepo(env, dir) {
  const branches = refs(env, dir, 'refs/heads');
  const trees = Object.fromEntries(Object.entries(branches).map(([b, sha]) => [b, treeOf(env, dir, sha)]));
  const current = tryGit(env, dir, 'symbolic-ref', '--quiet', '--short', 'HEAD') || null;
  const work = {};
  // Not through git(): its trim would take the leading space of " M path" and shift every path by one character.
  let status = '';
  try {
    status = execFileSync('git', ['-C', dir, 'status', '--porcelain', '--no-renames', '--untracked-files=all', '-z'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    /* not a repository git can read: no work to keep */
  }
  for (const entry of status.split('\0').filter(Boolean)) {
    const p = entry.slice(3);
    work[p] = fileBlob(path.join(dir, ...p.split('/')));
  }
  return { branches, trees, current, work };
}

/** The memory folders of a workspace: the brain's, and each one a project.json or a group of the map names. */
export function memoryFolders(ws) {
  const out = [path.join(ws, 'ai_brain', 'claude-memory')];
  for (const r of reposUnder(ws)) {
    for (const file of [path.join(r, 'project.json'), ...packFiles(r)]) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const v of Object.values(j.memories || {})) if (typeof v === 'string') out.push(path.join(path.dirname(file), ...v.split('/')));
      } catch {
        /* no project.json here */
      }
    }
  }
  return [...new Set(out)].filter((d) => fs.existsSync(d)).sort();
}
// A group's members keep their project.json inside the group's repository (packs/<name>/project.json).
const packFiles = (r) => {
  try {
    return fs.readdirSync(r, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== '.git').flatMap((e) => fs.readdirSync(path.join(r, e.name), { withFileTypes: true }).filter((m) => m.isDirectory()).map((m) => path.join(r, e.name, m.name, 'project.json')));
  } catch {
    return [];
  }
};

/** Every file of a memory folder: { rel: sha256 of its content }. */
export function memoryFiles(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && e.name !== '.git') walk(p);
      else if (e.isFile()) out[path.relative(dir, p).split(path.sep).join('/')] = sha256(fs.readFileSync(p));
    }
  };
  walk(dir);
  return out;
}

/**
 * What the first home holds, by home-relative place ("~/Workspace/projects/shop"): { repos: { where: snapRepo },
 * memories: { where: { repo: where of the repository holding it, files } } }.
 */
export function snapHome(env, home, ws, only = null) {
  const where = (p) => `~/${path.relative(home, p).split(path.sep).join('/')}`;
  const repos = reposUnder(ws).filter((r) => !only || only.some((o) => r === o || r.startsWith(o + path.sep)));
  const snap = { repos: {}, memories: {} };
  for (const r of repos) snap.repos[where(r)] = snapRepo(env, r);
  for (const m of memoryFolders(ws).filter((d) => !only || only.some((o) => d.startsWith(o + path.sep)))) {
    const holder = repos.filter((r) => m.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0];
    snap.memories[where(m)] = { repo: holder ? where(holder) : null, files: memoryFiles(m) };
  }
  return snap;
}

const short = (sha) => (sha ? sha.slice(0, 7) : 'none');

/**
 * The first home's snapshot `a` against the second home `homeB` as it is now (its local branches, and the server's
 * branches as its clones know them). Each difference keeps `kind` (branch, work, memory, repo) and `branch` for the
 * naming. → { differences: [{ where, what, kind, branch? }], compared: { repos, branches, files, memoryFiles } }
 */
export function compare(a, envB, homeB) {
  const differences = [];
  const compared = { repos: 0, branches: 0, files: 0, memoryFiles: 0 };
  const dirOf = (where) => path.join(homeB, ...where.slice(2).split('/'));
  const files = (where, kind, branch, ta, tb, label) => {
    for (const p of [...new Set([...Object.keys(ta), ...Object.keys(tb)])].sort()) {
      compared.files++;
      if (ta[p] === tb[p]) continue;
      const state = !(p in tb) ? 'is not on the second home' : !(p in ta) ? 'is only on the second home' : 'differs on the second home';
      differences.push({ where, kind, ...(branch ? { branch } : {}), what: `${label}${p} ${state}` });
    }
  };
  for (const [where, r] of Object.entries(a.repos)) {
    compared.repos++;
    const d = dirOf(where);
    if (!fs.existsSync(path.join(d, '.git'))) {
      differences.push({ where, kind: 'repo', what: 'the repository is not on the second home' });
      continue;
    }
    const local = refs(envB, d, 'refs/heads');
    const server = refs(envB, d, 'refs/remotes/origin');
    const headB = (b) => local[b] || server[b] || null;
    for (const [b, sha] of Object.entries(r.branches)) {
      compared.branches++;
      const there = headB(b);
      if (!there) {
        differences.push({ where, kind: 'branch', branch: b, what: `branch ${b} is not on the second home` });
        continue;
      }
      if (there !== sha) differences.push({ where, kind: 'branch', branch: b, what: `branch ${b}: ${short(sha)} here, ${short(there)} on the second home` });
      files(where, 'branch', b, r.trees[b], treeOf(envB, d, there), `branch ${b}: `);
    }
    // Work not committed: each such file of the first home, against the same file on the second.
    for (const [p, blob] of Object.entries(r.work)) {
      compared.files++;
      if (fileBlob(path.join(d, ...p.split('/'))) !== blob) differences.push({ where, kind: 'work', what: `not committed: ${p}` });
    }
  }
  for (const [where, m] of Object.entries(a.memories)) {
    const d = dirOf(where);
    const there = fs.existsSync(d) ? memoryFiles(d) : {};
    for (const [rel, h] of Object.entries(m.files)) {
      compared.memoryFiles++;
      if (there[rel] !== h) differences.push({ where, repo: m.repo, kind: 'memory', what: `memory file ${rel} ${rel in there ? 'differs on' : 'is not on'} the second home` });
    }
  }
  return { differences, compared };
}

/**
 * The Item of the check that had named a difference, or null: a branch by its own id, work by the repository's work
 * item, a memory file by a memory item of its folder or by work or a branch of the repository holding it, a missing
 * repository by anything the check said of it.
 */
export function namedBy(d, items) {
  const ids = new Set(items.map((i) => i.id));
  const has = (id) => (ids.has(id) ? id : null);
  if (d.kind === 'branch') return has(`branch:${d.where}:${d.branch}`) || has(`noserver:${d.where}`);
  if (d.kind === 'work') return has(`work:${d.where}`);
  if (d.kind === 'memory') return has(`memory:${d.where}`) || (d.repo && (has(`work:${d.repo}`) || items.find((i) => i.kind === 'branch' && i.where === d.repo)?.id)) || null;
  return items.find((i) => i.where === d.where)?.id || null;
}
