// The home part of the whole-computer check (`hoprig pc leave --check`, leave.mjs merges it): the places outside the
// workspace where this computer keeps things that are in no git, so that a format would lose them.
//
//   memory       a memory folder of Claude Code (<claude dir>/projects/*/memory) that is a real folder with files, or a
//                link to a folder in no git; a link into a repository (the brain, a project) is safe and not named.
//                OpenCode keeps no memory of its own (codetools/opencode.mjs ownMemory: false): its memory is the
//                project's, in git.
//   rules        a rules file or skills folder of a coding tool that holds something and is not linked to the brain
//                (link.mjs planLink decides; the home memory is the memory kind's).
//   key          a private SSH key in ~/.ssh with no byte-identical copy anywhere in the credentials folder. What
//   keystore     another computer has cannot be known and is not assumed. ~/.android/debug.keystore, the same way.
//   hoprig       Hoprig's own settings, providers and state: in no git by design; named by folder and size only.
//   credentials  the credentials folder when it is in no git (its files are never named).
//   database     leavedb.mjs.
//   dotfolder    every other dot-folder (and dot-file) of the home above MIN_SIZE that is not a known cache: an Ask
//                until the owner marks it keep or ignore (leavemarks.mjs), then never again.
//
// It READS only. A key is compared by its sha256 in memory, and neither its content nor its hash ever leaves this
// module. Every size comes from the one budgeted walk of leavewalk.mjs (no link followed, no private folder entered).
// A folder marked "outside" is named in `outside` and never walked, wherever it is.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDir, profilesDir, stateDir, toolsDir } from '../paths.mjs';
import { projectSlug } from '../sessions.mjs';
import { credsDir } from './credlinks.mjs';
import { brainDir, isGitRepo, workspaceDir } from './layout.mjs';
import { databaseLook } from './leavedb.mjs';
import { readMarks } from './leavemarks.mjs';
import { isPrivateName, makeWalker, sizeWords } from './leavewalk.mjs';
import { planLink } from './link.mjs';
import { resolveLink } from './needswalk.mjs';

/** Below this a dot-folder is not asked about: settings files and small tools' state. */
export const MIN_SIZE = 1024 * 1024;

// Caches and what a program makes again (downloads, installs, toolchains, build daemons' state): never asked about.
// A folder is here only when losing it costs a download or an install, never the owner's own work.
const KNOWN = new Set([
  '.cache', '.npm', '.nvm', '.fnm', '.volta', '.bun', '.deno', '.node-gyp', '.yarn', '.pnpm-store', '.cargo', '.rustup',
  '.gradle', '.m2', '.ivy2', '.sbt', '.konan', '.pub-cache', '.dartServer', '.flutter', '.cocoapods', '.pyenv', '.rbenv',
  '.sdkman', '.expo', '.electron-gyp', '.vscode-server', '.vscode-server-insiders', '.cursor-server', '.vscode', '.cursor',
  // ~/.local/bin is NOT here: the owner's own scripts may live there, so it is asked about once.
  '.Trash', '.local/share/Trash', '.local/lib', '.local/include', '.local/share/pnpm', '.config/pnpm',
  // Claude Code's own install (its versions), put back by its installer.
  '.local/share/claude',
  // The Android SDK's own state and emulators: made again by Android Studio. Its debug keystore is the keystore kind's.
  '.android',
]);
// Shell and program history: never counted (the design's word), wherever it is.
const HISTORY = new Set([
  '.bash_history', '.zsh_history', '.zhistory', '.sh_history', '.history', '.python_history', '.node_repl_history',
  '.psql_history', '.mysql_history', '.sqlite_history', '.irb_history', '.lesshst', '.wget-hsts', '.viminfo', '.zsh_sessions',
  '.local/share/fish/fish_history',
]);
// Looked at one level down: each folder in these is a program's own.
const EXPAND = new Set(['.config', '.local', '.local/share', '.local/state']);
const PRIVATE_KEY = /^-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----|^PuTTY-User-Key-File-/;
const NOT_KEYS = /^(known_hosts|authorized_keys|config|environment)(\..*|2)?$|\.pub$/;
const KEY_MAX = 64 * 1024;

const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const names = (d) => {
  try {
    return fs.readdirSync(d).sort();
  } catch {
    return [];
  }
};
const within = (p, top) => p === top || p.startsWith(top.endsWith(path.sep) ? top : top + path.sep);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const inRepo = (p) => {
  for (let d = p; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
};

/** The home part of the check: { items, asks, outside, notChecked } (SHAPE.md). */
export async function homeLook(opts = {}) {
  const home = path.resolve(opts.home || os.homedir());
  const dir = opts.dir || workspaceDir();
  const marks = opts.marks || readMarks({ dir, home });
  const walker = makeWalker({ budget: opts.budget, now: opts.now });
  const items = [];
  const asks = [];
  const notChecked = [];
  const where = (p) => (within(p, home) ? `~${p.slice(home.length).split(path.sep).join('/')}` : p);
  const abs = (name) => path.join(home, ...name.slice(2).split('/'));
  const outside = marks.outside.map((w) => ({ where: w, why: 'not checked, by your word' }));
  // Never walked by any kind: the owner's outside folders, and history kept inside a program's folder.
  const skip = new Set([...marks.outside.map(abs), ...[...HISTORY].filter((h) => h.includes('/')).map((h) => path.join(home, h))]);
  const unfinished = (p, r) => notChecked.push({ where: where(p), why: `at least ${sizeWords(r.size)}, not measured further` });
  const measure = (p, o = {}) => walker.walk(p, { skip, ...o });
  const item = (kind, p, size, what, todo, command = '') => items.push({ id: `${kind}:${where(p)}`, kind, where: where(p), what, size, todo, command, pushable: false });
  const isOutside = (p) => [...skip].some((s) => within(p, s));

  const creds = credsDir(dir);
  await keysAndCredentials({ home, creds, measure, item, notChecked, where, unfinished, isOutside });
  await hoprigOwn({ measure, item, unfinished, isOutside });
  const claude = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  await memories({ claude, home, measure, item, unfinished, isOutside });
  await rules({ claude, home, dir, measure, item, notChecked, unfinished, isOutside });
  const db = await databaseLook({ dir, home, facts: opts.facts && opts.facts.databases, testData: marks.testData, walker, run: opts.run, now: opts.now });
  items.push(...db.items);
  notChecked.push(...db.notChecked);

  // Every other dot-folder: the folders the kinds above cover are theirs, never asked about twice.
  const covered = [claude, configDir(), profilesDir(), stateDir(), path.join(home, '.ssh'), dir, creds].map((p) => path.resolve(p));
  const marked = new Set([...marks.keep, ...marks.ignore, ...marks.outside]);
  const look = async (rel) => {
    const p = path.join(home, ...rel.split('/'));
    const w = `~/${rel}`;
    if (isPrivateName(path.basename(rel)) || HISTORY.has(path.basename(rel)) || HISTORY.has(rel) || KNOWN.has(rel)) return;
    if (marked.has(w) || isOutside(p) || covered.some((c) => within(p, c))) return;
    const st = lst(p);
    if (!st || st.isSymbolicLink()) return; // a link is never followed: its target is not this folder's
    if (st.isDirectory() && EXPAND.has(rel)) {
      for (const n of names(p)) await look(`${rel}/${n}`);
      return;
    }
    let size = st.size;
    if (st.isDirectory()) {
      const r = await measure(p, { skip: new Set([...skip, ...covered]) });
      if (!r.opened) return notChecked.push({ where: w, why: 'it cannot be read' });
      if (!r.done) return unfinished(p, r);
      size = r.size;
    } else if (!st.isFile()) return;
    if (size >= MIN_SIZE) asks.push({ id: `dotfolder:${w}`, kind: 'dotfolder', where: w, size, question: `${w} holds ${sizeWords(size)} of a program's own data: keep (you back it up) or ignore?` });
  };
  for (const n of names(home)) if (n.startsWith('.') && n !== '.' && n !== '..') await look(n);
  return { items, asks, outside, notChecked };
}

/** A key file of ~/.ssh: a file with a matching .pub, or one whose first line says it is a private key. */
function keyFiles(ssh) {
  const all = names(ssh);
  const out = [];
  for (const n of all) {
    if (NOT_KEYS.test(n) || isPrivateName(n)) continue;
    const p = path.join(ssh, n);
    const st = lst(p);
    if (!st || !st.isFile() || st.size > KEY_MAX) continue;
    out.push({ p, st, paired: all.includes(`${n}.pub`) });
  }
  return out;
}

async function keysAndCredentials({ home, creds, measure, item, notChecked, where, unfinished, isOutside }) {
  const ssh = path.join(home, '.ssh');
  const found = []; // { p, kind, size, hash }: the hash stays in this function
  const sshAt = lst(ssh);
  const sshReal = sshAt && sshAt.isSymbolicLink() ? resolveLink(ssh) : null;
  // ~/.ssh as a link into the credentials folder keeps its keys there: nothing of it is only here.
  if (sshReal && !(sshReal.real && within(sshReal.real, path.resolve(creds)))) notChecked.push({ where: '~/.ssh', why: 'it is a link, and Hoprig does not follow it to look at the keys' });
  const candidates = sshAt && sshAt.isDirectory() && !isOutside(ssh) ? keyFiles(ssh).map((k) => ({ ...k, kind: 'key' })) : [];
  const ks = path.join(home, '.android', 'debug.keystore');
  const kst = lst(ks);
  if (kst && kst.isFile() && !isOutside(ks)) candidates.push({ p: ks, st: kst, kind: 'keystore', paired: true });
  for (const c of candidates) {
    let buf;
    try {
      buf = fs.readFileSync(c.p);
    } catch {
      notChecked.push({ where: where(c.p), why: 'it cannot be read, so whether the credentials folder has a copy is not known' });
      continue;
    }
    if (c.kind === 'key' && !c.paired && !PRIVATE_KEY.test(buf.subarray(0, 100).toString('latin1'))) continue;
    found.push({ p: c.p, kind: c.kind, size: buf.length, hash: sha(buf) });
    buf.fill(0);
  }
  // One walk of the credentials folder: its size, and the files as large as a key (only those are hashed).
  const sizes = new Set(found.map((f) => f.size));
  const copies = new Set();
  const cst = (() => {
    try {
      return fs.statSync(creds);
    } catch {
      return null;
    }
  })();
  let r = null;
  if (cst && cst.isDirectory() && !isOutside(creds)) {
    const same = [];
    r = await measure(creds, { madeAgain: false, onFile: (p, st) => sizes.has(st.size) && same.push(p) });
    for (const p of same) {
      try {
        const b = fs.readFileSync(p);
        copies.add(sha(b));
        b.fill(0);
      } catch {
        /* unreadable: not a copy that can be counted on */
      }
    }
    if (!isGitRepo(creds) && !r.done) unfinished(creds, r);
    else if (!isGitRepo(creds) && r.files) item('credentials', creds, r.size, 'the credentials folder is in no git: its keys and passwords are only on this computer', 'make it a private repository and push it:  hoprig workspace credentials --github', 'hoprig workspace credentials --github');
  }
  for (const f of found) {
    if (copies.has(f.hash)) continue;
    if (r && !r.done) {
      notChecked.push({ where: where(f.p), why: 'the credentials folder is too large to look for a copy of it within the budget' });
      continue;
    }
    if (f.kind === 'key') item('key', f.p, f.size, 'a private SSH key that has no copy in the credentials folder', 'copy it into the credentials folder (and keep that in a private repository), or make a new key on the next computer and add it where this one is used');
    else item('keystore', f.p, f.size, 'the Android debug keystore has no copy in the credentials folder: apps signed with it cannot be updated from another computer', 'copy it into the credentials folder (and keep that in a private repository)');
  }
}

async function hoprigOwn({ measure, item, unfinished, isOutside }) {
  const settings = configDir();
  const places = [[settings, 'Hoprig\'s own settings and providers are here, in no git']];
  if (!within(path.resolve(profilesDir()), path.resolve(settings))) places.push([profilesDir(), 'Hoprig\'s providers are here, in no git']);
  places.push([stateDir(), 'Hoprig\'s own records (what it ran, what it remembers) are here, in no git']);
  for (const [p, what] of places) {
    const st = lst(p);
    if (!st || !st.isDirectory() || isOutside(p)) continue;
    // The coding tools Hoprig installed itself are installed again: not counted.
    const r = await measure(p, { skip: new Set([path.resolve(toolsDir())]) });
    if (!r.done) unfinished(p, r);
    else if (r.files) item('hoprig', p, r.size, what, 'copy it yourself if you want your providers and settings on the next computer');
  }
}

async function memories({ claude, home, measure, item, unfinished, isOutside }) {
  const top = path.join(claude, 'projects');
  for (const n of names(top)) {
    if (isPrivateName(n)) continue;
    const m = path.join(top, n, 'memory');
    const st = lst(m);
    if (!st || isOutside(m)) continue;
    let at = m;
    let what = 'a memory folder of Claude Code that is a real folder, in no git';
    if (st.isSymbolicLink()) {
      const res = resolveLink(m);
      // A loop, or a link into a private folder (the owner's own, never looked into), or into a repository: safe.
      if (!res || res.at !== undefined || isOutside(res.real) || inRepo(res.real) || !lst(res.real) || !lst(res.real).isDirectory()) continue;
      at = res.real;
      what = 'a memory folder of Claude Code that is a link to a folder in no git';
    } else if (!st.isDirectory()) continue;
    const r = await measure(at);
    if (!r.done) unfinished(m, r);
    else if (r.files) {
      const homeMemory = n === projectSlug(home);
      item('memory', m, r.size, what, homeMemory ? 'link it to the brain, which keeps its files:  hoprig workspace link' : 'link it into its project\'s memory (its files are merged in, a backup is kept):  hoprig project link <name>', homeMemory ? 'hoprig workspace link' : '');
    }
  }
}

async function rules({ claude, home, dir, measure, item, notChecked, unfinished, isOutside }) {
  let plan = [];
  try {
    plan = planLink({ base: claude, brain: brainDir(dir), home });
  } catch {
    notChecked.push({ where: '~/.claude', why: 'how the coding tools are linked to the brain could not be read' });
    return;
  }
  for (const p of plan) {
    // Only what holds something here: a link, nothing there, or the brain's own text loses nothing.
    if (p.id === 'memory' || (p.kind !== 'file' && p.kind !== 'dir') || ['already', 'link', 'backup'].includes(p.action)) continue;
    const st = lst(p.link);
    if (!st || st.isSymbolicLink() || isOutside(p.link)) continue;
    let size = st.size;
    if (st.isDirectory()) {
      const r = await measure(p.link);
      if (!r.done) {
        unfinished(p.link, r);
        continue;
      }
      if (!r.files) continue;
      size = r.size;
    } else if (!size) continue;
    const what = `${p.what[0].toUpperCase()}${p.what.slice(1)}: ${st.isDirectory() ? 'a real folder' : 'a file'} here, not linked to the brain`;
    item('rules', p.link, size, what, p.action === 'conflict' ? `${p.why}; then link it:  hoprig workspace link` : 'link it to the brain (its files are merged in, a backup is kept):  hoprig workspace link', 'hoprig workspace link');
  }
}
