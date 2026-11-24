// The copy of `hoprig move-to-user`: every part the look listed (src/setup/moveplan.mjs) is COPIED from root's home
// into the user's, with modes and times, and the owner of every entry copied set to the user (links themselves, never
// what they point to). Root's files are only read. In the copy only:
// - links that point into root's home point into the user's;
// - git's two records of a linked work tree (the tree's `.git` file and `.git/worktrees/<name>/gitdir`) name the new
//   place, then `git worktree repair` runs as the user;
// - Hoprig's settings and state (JSON values and keys, the small text settings files and the provider files), the
//   workspace map and Claude Code's settings file name the new home. Never a log, a conversation or a project's file;
// - each project folder of Claude Code is ALSO placed under the name its new path gives (src/sessions.mjs
//   projectSlug of its real path, as Claude Code names it), as a copy: a folder of that name already there keeps its files, and only missing ones are added.
// Every file system call is handed in (`io`), so a test plays the owners (it cannot make a file of another user).
import fs from 'node:fs';
import path from 'node:path';
import { projectSlug } from '../sessions.mjs';
import { realOr } from '../server/folders.mjs';
import { runAsUser } from './asuser.mjs';

/** How often the copy says how far it is, at most (ms). */
export const PROGRESS_MS = 2000;
/** Settings files that are not JSON and are rewritten (k3): only these, and only when small. */
const TEXT_SETTINGS = /\.(ya?ml|conf|toml|ini)$/i;
const SETTINGS_MAX = 1 << 20;
const JSON_MAX = 8 << 20;

export const defaultCopyIo = () => ({
  lstat: fs.lstatSync,
  readdir: (d) => fs.readdirSync(d),
  mkdir: (p, mode) => fs.mkdirSync(p, { mode }),
  copyFile: (a, b) => fs.copyFileSync(a, b, fs.constants.COPYFILE_EXCL),
  readlink: fs.readlinkSync,
  symlink: (t, p) => fs.symlinkSync(t, p),
  chmod: fs.chmodSync,
  utimes: fs.utimesSync,
  chown: (p, uid, gid) => fs.lchownSync(p, uid, gid),
  exists: (p) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  },
  now: Date.now,
});

const inside = (p, base) => p === base || p.startsWith(`${base}/`);
/** `p` under the old home → the same place under the new one; anything else as it is. */
export const moved = (p, oldHome, newHome) => (inside(p, oldHome) ? newHome + p.slice(oldHome.length) : p);
/** The name of Claude Code's project folder for `p`: Claude Code names it after its real folder (process.cwd()). */
export const claudeSlug = (p) => projectSlug(realOr(p));

/** A run of the copy: what was made (for the line that says how to take it away), counts, and the files to rewrite. */
function context({ user, oldHome, newHome, io, onProgress, total }) {
  return { user, oldHome, newHome, io, onProgress, total, made: [], done: { entries: 0, bytes: 0 }, last: io.now(), gitFiles: [], settings: [], skipped: [] };
}

function tick(ctx, force = false) {
  const t = ctx.io.now();
  if (!force && t - ctx.last < PROGRESS_MS) return;
  ctx.last = t;
  ctx.onProgress?.({ phase: 'copy', entries: ctx.done.entries, bytes: ctx.done.bytes, totalEntries: ctx.total?.entries ?? null, totalBytes: ctx.total?.bytes ?? null });
}

const own = (ctx, p) => ctx.io.chown(p, ctx.user.uid, ctx.user.gid ?? ctx.user.uid);

/** The folders above `to` up to the new home that are not there yet: made (0755; .ssh 0700) and given to the user. */
function parents(ctx, to) {
  const missing = [];
  for (let d = path.posix.dirname(to); inside(d, ctx.newHome) && d !== ctx.newHome && !ctx.io.exists(d); d = path.posix.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    ctx.io.mkdir(d, path.posix.basename(d) === '.ssh' ? 0o700 : 0o755);
    own(ctx, d);
    ctx.made.push(d);
  }
}

/**
 * One entry and, for a folder, all under it. `keep(rel)` chooses; `addOnly`: a target that is there is kept as it
 * is (only what is missing is copied). Folders get their mode and times after their contents (a read-only folder).
 * `note(src, dst, rel)` sees every file copied (the rewrite lists). `counted`: its entries count towards the look's
 * total (false for a project folder placed a second time under its new name: the look counts those as bytes only).
 */
function copyTree(ctx, from, to, { keep = () => true, addOnly = false, note = () => {}, counted = true } = {}) {
  const { io } = ctx;
  const after = [];
  const stack = [[from, to, '']];
  let added = 0;
  while (stack.length) {
    const [src, dst, rel] = stack.pop();
    const st = io.lstat(src);
    const there = addOnly && io.exists(dst);
    if (st.isSymbolicLink()) {
      if (!there) {
        io.symlink(moved(io.readlink(src), ctx.oldHome, ctx.newHome), dst);
        own(ctx, dst);
        added += 1;
      }
    } else if (st.isDirectory()) {
      if (!there) {
        io.mkdir(dst, 0o700);
        own(ctx, dst);
        after.push([dst, st]);
        added += 1;
      }
      for (const name of io.readdir(src)) {
        const r = rel ? `${rel}/${name}` : name;
        if (keep(r)) stack.push([`${src}/${name}`, `${dst}/${name}`, r]);
      }
    } else if (st.isFile()) {
      if (!there) {
        io.copyFile(src, dst);
        io.chmod(dst, st.mode & 0o7777);
        io.utimes(dst, st.atime, st.mtime);
        own(ctx, dst);
        ctx.done.bytes += st.size;
        added += 1;
        note(src, dst, rel);
      }
    } else {
      ctx.skipped.push(src); // a socket or a pipe: nothing to copy, and the look did not count it (measure)
      continue;
    }
    if (counted) ctx.done.entries += 1;
    tick(ctx);
  }
  for (const [d, st] of after.reverse()) {
    io.chmod(d, st.mode & 0o7777);
    io.utimes(d, st.atime, st.mtime);
  }
  return added;
}

/** Which copied files the rewrite looks at, by part (see the head of this file). */
function noter(ctx, part) {
  if (part.id === 'workspace') {
    return (src, dst, rel) => {
      const name = path.posix.basename(rel);
      if (name === '.git' || /(^|\/)\.git\/worktrees\/[^/]+\/gitdir$/.test(rel)) ctx.gitFiles.push(dst);
      else if (rel === 'ai_brain/workspace.json') ctx.settings.push({ file: dst, json: true });
    };
  }
  if (part.id === 'config' || part.id === 'state') {
    return (src, dst, rel) => {
      if (rel.endsWith('.json')) ctx.settings.push({ file: dst, json: true });
      else if (TEXT_SETTINGS.test(rel) || /^profiles\/[^/]+\.env$/.test(rel)) ctx.settings.push({ file: dst, json: false });
    };
  }
  if (part.id === '.claude.json') return (src, dst) => ctx.settings.push({ file: dst, json: true });
  return () => {};
}

/** A JSON value with every string (and key) that is the old home or under it carried to the new home. */
export function carryJson(v, oldHome, newHome, count = { n: 0 }) {
  const one = (s) => {
    if (s === oldHome || s.startsWith(`${oldHome}/`)) {
      count.n += 1;
      return newHome + s.slice(oldHome.length);
    }
    return s;
  };
  if (typeof v === 'string') return one(v);
  if (Array.isArray(v)) return v.map((x) => carryJson(x, oldHome, newHome, count));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [one(k), carryJson(x, oldHome, newHome, count)]));
  return v;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Text with the old home, as a whole path or the start of one, carried to the new home. `oldHome` may be several
 * names of the same folder (its given path and its real one): all are carried in ONE pass, the longest first, so a
 * new home that lies below one of the names is never carried a second time.
 */
export function carryText(text, oldHome, newHome, count = { n: 0 }) {
  const names = [...new Set([].concat(oldHome))].sort((a, b) => b.length - a.length).map(esc).join('|');
  const re = new RegExp(`(?<![\\w./-])(?:${names})(?=/|$|[\\s"',;:\\]})])`, 'gm');
  return text.replace(re, () => {
    count.n += 1;
    return newHome;
  });
}

/** Rewrite the noted files in place (their mode and owner stay): → { files, values }. */
function rewrite(ctx) {
  let files = 0;
  let values = 0;
  for (const { file, json } of ctx.settings) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.size > (json ? JSON_MAX : SETTINGS_MAX)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const count = { n: 0 };
    let out;
    if (json) {
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        continue; // not JSON after all: left as it is
      }
      const k = carryJson(j, ctx.oldHome, ctx.newHome, count);
      out = `${JSON.stringify(k, null, 2)}\n`;
    } else out = carryText(text, ctx.oldHome, ctx.newHome, count);
    if (!count.n) continue;
    fs.writeFileSync(file, out);
    files += 1;
    values += count.n;
  }
  let git = 0;
  for (const file of ctx.gitFiles) {
    let text;
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // git writes a work tree's records with real paths: the old home reached through a link is carried by both names.
    const count = { n: 0 };
    const out = carryText(text, [ctx.oldHome, realOr(ctx.oldHome)], ctx.newHome, count);
    if (count.n) {
      fs.writeFileSync(file, out);
      git += 1;
    }
  }
  return { files, values, git };
}

/**
 * Claude Code's project folders of the old home's paths, each ALSO placed under the name of its new path, in the copy.
 * → [{ from, to, added }] (names in the projects folder).
 */
function placeConversations(ctx, claudeTo) {
  const dir = `${claudeTo}/projects`;
  const oldSlug = claudeSlug(ctx.oldHome);
  const newSlug = claudeSlug(ctx.newHome);
  let names = [];
  try {
    names = ctx.io.readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!(name === oldSlug || name.startsWith(`${oldSlug}-`))) continue;
    const to = newSlug + name.slice(oldSlug.length);
    if (to === name || !ctx.io.lstat(`${dir}/${name}`).isDirectory()) continue;
    const added = copyTree(ctx, `${dir}/${name}`, `${dir}/${to}`, { addOnly: true, counted: false });
    out.push({ from: name, to, added });
  }
  return out;
}

/** The repositories under `dir` that hold linked work trees (`.git/worktrees`), for git worktree repair. */
function reposWithTrees(ctx) {
  return [...new Set(ctx.gitFiles.filter((f) => f.endsWith('/gitdir')).map((f) => f.replace(/\/\.git\/worktrees\/[^/]+\/gitdir$/, '')))];
}

/**
 * Copy every part of `plan` (movePlan) into the user's home. → { ok, made, placed, rewritten, repaired, skipped,
 * done } or { ok: false, error, made } with nothing of root's changed. `onProgress` gets how far it is.
 */
export async function copyParts(plan, { io: given = {}, onProgress, asUser } = {}) {
  const io = { ...defaultCopyIo(), ...given };
  const ctx = context({ user: plan.user, oldHome: plan.oldHome, newHome: plan.user.home, io, onProgress, total: plan.total });
  const runUser = asUser || ((argv, o) => runAsUser(plan.user, argv, o));
  try {
    for (const p of plan.parts) if (p.id !== 'ssh' && io.exists(p.to)) throw new Error(`${p.to} is already in ${plan.user.name}'s home: nothing is written over it`);
    let placed = [];
    for (const p of plan.parts) {
      parents(ctx, p.to);
      if (p.id === 'ssh') {
        if (!io.exists(p.to)) {
          io.mkdir(p.to, 0o700);
          own(ctx, p.to);
          ctx.made.push(p.to);
        }
        ctx.done.entries += 1; // the folder itself, as the look counts it
        // Beside the user's own files: one of the same name there is kept (and counted: the look counted root's).
        for (const name of io.readdir(p.from).filter((n) => p.keep(n))) {
          if (io.exists(`${p.to}/${name}`)) {
            ctx.done.entries += 1;
            continue;
          }
          copyTree(ctx, `${p.from}/${name}`, `${p.to}/${name}`);
          ctx.made.push(`${p.to}/${name}`);
        }
        continue;
      }
      ctx.made.push(p.to);
      copyTree(ctx, p.from, p.to, { keep: p.keep, note: noter(ctx, p) });
      if (p.id === 'claude') placed = placeConversations(ctx, p.to);
    }
    tick(ctx, true);
    const rewritten = rewrite(ctx);
    const repaired = [];
    for (const repo of reposWithTrees(ctx)) {
      const r = await runUser(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repo, 'worktree', 'repair'], { timeout: 60_000 });
      repaired.push({ repo, ok: !!r.ok });
    }
    return { ok: true, made: ctx.made, placed, rewritten, repaired, skipped: ctx.skipped, done: ctx.done };
  } catch (e) {
    return { ok: false, error: e.message, made: ctx.made, done: ctx.done };
  }
}

/** The lines after a copy that failed: what was made in the user's home, and how to take it away (as that user). */
export function failedCopyLines(r, user) {
  const lines = [`The copy stopped: ${r.error}. Root's installation was not changed and still runs.`];
  if (r.made.length) {
    lines.push(`Made in ${user.name}'s home so far (the next run of the move takes it away first; a part changed after this is set aside beside it, never deleted):`);
    for (const m of r.made) lines.push(`  ${m}`);
  }
  return lines;
}
