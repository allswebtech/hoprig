// The workspace: one tree, the same on every computer (docs/WORKSPACE.md). This module only says where it is and
// what is there; setup.mjs creates what is missing and link.mjs links Claude Code's folder into the brain.
//
//   <workspace>/ai_brain/  projects/<project>/code/<repo>/  credentials/  development/  git/  database/postgresql/  backups/
//
// An existing computer is adopted as it is: a projects folder chosen before stays where it is, and a folder that
// exists is only reported, never moved, renamed or changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { defaultWorkspaceDir, tilde, workspaceEnvDir } from '../paths.mjs';
import { PRIVATE_DIRS } from '../pcsetup/projects.mjs';

/** The folders of the tree, in the order they are shown, each with the one sentence that says what it is for. */
export const TREE = [
  { id: 'ai_brain', rel: 'ai_brain', purpose: 'Shared AI knowledge for all projects: the rules Claude gets everywhere, skills, memory, notes, scripts; its own private git repository.' },
  { id: 'projects', rel: 'projects', purpose: 'One folder per project: its AGENTS.md, ai_brain/ (that project\'s memory, learnings, current context), docs, decisions and project.json, with each code repository under code/.' },
  { id: 'credentials', rel: 'credentials', purpose: 'Keys and passwords for local work: never in git; AI tools may use them but never print them.' },
  { id: 'development', rel: 'development', purpose: 'Toolchains and SDKs installed for you (node, flutter, android, …).' },
  { id: 'git', rel: 'git', purpose: 'Your own git material (mirrors, shared hooks).' },
  { id: 'database', rel: 'database/postgresql', purpose: 'Local database data.' },
  { id: 'backups', rel: 'backups', purpose: 'Backups of your own files and local databases.' },
];

const readCfg = (cfg) => {
  if (cfg) return cfg;
  try {
    return loadConfig();
  } catch {
    return {};
  }
};

/** Where the workspace is, and why: { dir, source: 'env' | 'setting' | 'default' }. */
export function workspaceRoot(cfg) {
  const e = workspaceEnvDir();
  if (e && path.isAbsolute(e)) return { dir: path.normalize(e), source: 'env' };
  const c = readCfg(cfg);
  if (typeof c.workspaceDir === 'string' && path.isAbsolute(c.workspaceDir)) return { dir: path.normalize(c.workspaceDir), source: 'setting' };
  return { dir: defaultWorkspaceDir(), source: 'default' };
}

export const workspaceDir = (cfg) => workspaceRoot(cfg).dir;
export const brainDir = (dir = workspaceDir()) => path.join(dir, 'ai_brain');

/**
 * The projects folder when none was chosen before: <workspace>/projects for a new install. A computer that already
 * keeps its projects in ~/projects (the earlier default) without having saved that choice keeps them there.
 */
export function defaultProjectsDir(cfg, home = os.homedir()) {
  const ws = path.join(workspaceDir(cfg), 'projects');
  const legacy = path.join(home, 'projects');
  if (!fs.existsSync(ws) && isDir(legacy)) return legacy;
  return ws;
}

/** The projects folder in use: the one chosen before ("projectsDir"), else the default above. */
export const projectsIn = (cfg) => {
  const c = readCfg(cfg);
  return typeof c.projectsDir === 'string' && path.isAbsolute(c.projectsDir) ? c.projectsDir : defaultProjectsDir(c);
};

/** The same folder, a link to it counted as the same (projects/ may be a link to where the projects are). */
const sameDir = (a, b) => {
  const r = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return r(a) === r(b);
};

export const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const kindOf = (p) => {
  try {
    const l = fs.lstatSync(p);
    if (l.isSymbolicLink()) return isDir(p) ? 'link' : 'broken-link';
    return l.isDirectory() ? 'folder' : 'file';
  } catch {
    return null;
  }
};

/** A git repository: a .git folder (or a .git file, as a worktree or submodule has). */
export const isGitRepo = (d) => fs.existsSync(path.join(d, '.git'));

/**
 * A linked worktree (`git worktree add`): its .git is a file pointing into another repository's
 * ".git/worktrees/<name>", whose folder holds a "commondir" file. It is a second checkout of that repository, never
 * a repository of its own. A submodule's .git file points into ".git/modules/<name>" (no commondir): not a worktree.
 * When the folder pointed to is gone (the worktree was pruned), where it pointed decides.
 */
export function isLinkedWorktree(d) {
  try {
    const dotGit = path.join(d, '.git');
    if (!fs.lstatSync(dotGit).isFile()) return false;
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return false;
    const gitDir = path.resolve(d, m[1].trim());
    if (fs.existsSync(gitDir)) return fs.existsSync(path.join(gitDir, 'commondir'));
    return path.basename(path.dirname(gitDir)) === 'worktrees';
  } catch {
    return false;
  }
}

/** What restore and sync say of a map entry whose folder here is a linked worktree: they never touch it. */
export const WORKTREE_LEFT = 'a linked worktree is in its folder here (a second checkout of another repository): left alone';

/**
 * The address of a repository's first remote, read from its git config (no git process: this is read on every
 * automation round), or null. It may hold a token: it never leaves the server.
 */
export function remoteOf(repo) {
  try {
    let gitDir = path.join(repo, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(repo, m[1].trim());
      try {
        gitDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); // a worktree
      } catch {
        /* a submodule, or a plain .git file */
      }
    }
    let inRemote = false;
    for (const line of fs.readFileSync(path.join(gitDir, 'config'), 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith('[')) inRemote = /^\[remote\s+"[^"]*"\]$/.test(t);
      else if (inRemote) {
        const m = /^url\s*=\s*(\S.*)$/.exec(t);
        if (m) return m[1].trim();
      }
    }
  } catch {
    /* not a repository, or unreadable */
  }
  return null;
}

/** Project folders in `dir`: no dot-folders, never a private one. [{ name, dir, git, parent }] */
export function listProjects(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.') && !PRIVATE_DIRS.includes(d.name) && isDir(path.join(dir, d.name)))
    .map((d) => {
      const p = path.join(dir, d.name);
      // A "parent": the project-workspace shape (AGENTS.md, ai_brain/ or project.json next to code/).
      const parent = ['ai_brain', 'project.json', 'AGENTS.md'].some((f) => fs.existsSync(path.join(p, f)));
      return { name: d.name, dir: p, git: isGitRepo(p), parent };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Owner-only permissions on credentials/ (POSIX only; Windows has no such mode bits). */
const looseMode = (p, platform = process.platform) => {
  if (platform === 'win32') return false;
  try {
    return (fs.statSync(p).mode & 0o077) !== 0;
  } catch {
    return false;
  }
};

/**
 * What the workspace has. Nothing is changed. `projectsDir` is the projects folder in use (it may be outside the
 * workspace on a computer that chose it before).
 * → { dir, short, source, exists, projectsDir, projectsShort, projectsInWorkspace, folders: [{ id, rel, path, exists,
 *     kind, purpose, git?, warning? }], projects: [{ name, git, parent }], brain: { exists, git } }
 */
export function workspaceStatus({ cfg, projectsDir: pdir, platform = process.platform } = {}) {
  const c = readCfg(cfg);
  const { dir, source } = workspaceRoot(c);
  const projectsDir = pdir || projectsIn(c);
  const folders = TREE.map((f) => {
    const p = path.join(dir, f.rel);
    const kind = kindOf(p);
    const out = { id: f.id, rel: f.rel, path: p, exists: kind === 'folder' || kind === 'link', kind: kind || 'missing', purpose: f.purpose };
    if (f.id === 'ai_brain') out.git = out.exists && isGitRepo(p);
    if (f.id === 'credentials' && out.exists && looseMode(p, platform)) out.warning = 'other users of this computer can open it: chmod 700 it';
    if (f.id === 'projects' && !sameDir(projectsDir, p)) out.note = `your projects folder is ${tilde(projectsDir)}`;
    if (kind === 'file' || kind === 'broken-link') out.warning = kind === 'file' ? 'a file is in the way: it is left alone' : 'a link that leads nowhere: it is left alone';
    return out;
  });
  const brain = folders.find((f) => f.id === 'ai_brain');
  return {
    dir,
    short: tilde(dir),
    source,
    exists: isDir(dir),
    projectsDir,
    projectsShort: tilde(projectsDir),
    projectsInWorkspace: sameDir(projectsDir, path.join(dir, 'projects')),
    folders,
    projects: listProjects(projectsDir).map(({ name, git, parent }) => ({ name, git, parent })),
    brain: { exists: brain.exists, git: brain.git },
  };
}

/** One line for the doctor and the setup report. */
export function workspaceLine(st) {
  const missing = st.folders.filter((f) => !f.exists).map((f) => f.rel);
  const warn = st.folders.filter((f) => f.warning);
  if (!st.exists) return { status: 'info', detail: `${st.short} not set up yet`, fix: 'hoprig workspace setup' };
  const brain = st.brain.exists ? `brain${st.brain.git ? ' (git)' : ' (not in git)'}` : 'no brain';
  const detail = `${st.short} · ${brain} · ${st.projects.length} project${st.projects.length === 1 ? '' : 's'}${missing.length ? ` · missing ${missing.join(', ')}` : ''}${warn.length ? ` · ${warn.map((f) => `${f.rel}: ${f.warning}`).join('; ')}` : ''}`;
  return { status: warn.length ? 'warn' : missing.length ? 'info' : 'ok', detail, fix: missing.length ? 'hoprig workspace setup' : warn.some((f) => f.id === 'credentials') ? `chmod 700 "${path.join(st.dir, 'credentials')}"` : '' };
}
