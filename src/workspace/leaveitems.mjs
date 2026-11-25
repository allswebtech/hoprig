// What a check of `hoprig drop` found (dropcheck.mjs checkRepo, drop.mjs lookAt), said as the Items of `hoprig pc
// leave --check` (leave.mjs): one line per thing that exists only on this computer, each with what to do and the
// command for it. The check is drop's own, so "only here" means the same in both; only its words change, because a
// format is not a drop (nothing is pushed or removed here: every command is shown, never run).
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture, showCommand } from '../setup/system.mjs';
import { commits, lastLine } from './dropcheck.mjs';

/** A place as the report names it: home-relative inside the home ("~/Workspace/projects/shop"), else absolute. */
export function whereOf(p, home) {
  const r = path.relative(home, p);
  if (r === '') return '~';
  return !r.startsWith('..') && !path.isAbsolute(r) ? `~/${r.split(path.sep).join('/')}` : p;
}

/** An Item of the report (SHAPE: id, kind, where, what, size, todo, command, pushable). `key`: what tells two apart. */
export const item = ({ kind, where, what, size = null, todo, command = '', pushable = false, key = '' }) => ({ id: key ? `${kind}:${where}:${key}` : `${kind}:${where}`, kind, where, what, size, todo, command, pushable });

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const are = (n) => (n === 1 ? 'is' : 'are');
const lines = (s) => (s || '').split('\n').filter(Boolean);

/**
 * What the git server of `dir` had at the last fetch, in askServer's shape (dropcheck.mjs), without asking it: the
 * daily look and the folders of --also reach no network. Its branches are the remote-tracking ones; a tag counts as
 * the server's when its commit is on one of them (a tag elsewhere is named as only here).
 */
export async function lastFetch(at, dir, run = capture) {
  const r = await gitRead(dir, ['for-each-ref', '--format=%(refname:lstrip=3)%09%(objectname)', 'refs/remotes/origin'], { run });
  if (!r.ok) return { ok: false, why: lastLine(r) };
  const heads = new Map(lines(r.stdout).map((l) => l.split('\t')).filter(([n]) => n && n !== 'HEAD'));
  const sym = await gitRead(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { run });
  const head = sym.ok ? sym.stdout.trim().replace(/^origin\//, '') : '';
  const tags = new Map();
  // One read per branch of the server: several --merged in one read mean "in all of them" in some versions of git.
  const local = await gitRead(dir, ['for-each-ref', '--count=1', '--format=%(refname)', 'refs/tags'], { run });
  for (const n of local.ok && local.stdout.trim() ? heads.keys() : []) {
    const t = await gitRead(dir, ['for-each-ref', '--format=%(refname:lstrip=2)%09%(objectname)', `--merged=refs/remotes/origin/${n}`, 'refs/tags'], { run });
    for (const l of t.ok ? lines(t.stdout) : []) {
      const [name, sha] = l.split('\t');
      tags.set(name, sha);
    }
  }
  return { ok: true, head, heads, tags, tips: [...heads.values()] };
}

const g = (dir, ...a) => showCommand(['git', '-C', dir, ...a]);
const markCommand = (where) => showCommand(['hoprig', 'pc', 'leave', '--outside', where]);

/** The size of the files of a work list on disk (a deleted one counts nothing). */
function workSize(dir, list) {
  let n = 0;
  for (const w of list) {
    try {
      const st = fs.lstatSync(path.join(dir, ...w.path.split('/')));
      if (st.isFile()) n += st.size;
    } catch {
      /* gone: a deletion */
    }
  }
  return n;
}

/**
 * The branches and the work of one check (its refusals are said by refusalItems). `pushable`: whether the one press
 * may push its branches (a repository of the workspace map; never the credentials or a folder of --also).
 */
export function checkItems(c, { home, pushable = false }) {
  const where = whereOf(c.dir, home);
  const out = [];
  for (const p of c.pushes) {
    const there = (c.serverHeads || []).includes(p.to);
    const argv = p.track ? ['push', '-u', 'origin', p.branch] : p.to === p.branch ? ['push', 'origin', p.branch] : ['push', 'origin', `${p.branch}:${p.to}`];
    out.push(item({
      kind: 'branch', where, key: p.branch, pushable,
      what: there ? `${commits(p.count)} on ${p.branch} ${are(p.count)} on no git server` : `${p.branch} (${commits(p.count)}) has no copy on the git server`,
      todo: 'push it', command: g(c.dir, ...argv),
    }));
  }
  if (c.def) {
    out.push(item({
      kind: 'branch', where, key: c.def.branch,
      what: `${commits(c.def.count)} on ${c.def.branch}, the default branch, ${are(c.def.count)} on no git server`,
      todo: 'a push of the default branch is yours (it can be a release): push it yourself when it may go live', command: g(c.dir, 'push', 'origin', c.def.branch),
    }));
  }
  const work = [...c.work, ...(c.memoryFiles || [])];
  if (work.length) {
    out.push(item({
      kind: 'work', where, size: workSize(c.dir, work),
      what: `${plural(work.length, 'file')} changed and not committed${c.memoryFiles && c.memoryFiles.length ? ' (the memory folder among them)' : ''}`,
      todo: 'commit and push them, or undo what is not needed', command: g(c.dir, 'status'),
    }));
  }
  return out;
}

// A sentence of drop says "what: what to do"; the first ": " outside brackets splits it.
function split(text) {
  let depth = 0;
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ':' && text[i + 1] === ' ' && depth === 0) return [text.slice(0, i), text.slice(i + 2)];
  }
  return [text, ''];
}
// Drop's words for its own next step, which a format does not take.
const tidy = (s) => s.replace(/,? then drop again/g, '').replace(/ \(a drop fetches first\)/g, '').replace(/drop does not put it back/g, 'it is not pushed by itself');

/**
 * What a refusal of drop is for a format: a kind of Item, 'unknown' (it could not be told: named as not checked), or
 * null (it stops a drop but loses nothing: a group that tracks files of a member, a clean worktree elsewhere, a
 * memory folder, which leave.mjs names itself with its size).
 */
export function refusalKind(what) {
  if (/^a stash with/.test(what)) return 'stash';
  if (/has no git server \(no remote/.test(what)) return 'noserver';
  if (/^its folder is no git repository/.test(what)) return 'folder';
  if (/^Claude Code's memory for it/.test(what) || /^the group's repository .* tracks files inside it/.test(what) || /^a linked worktree of it is at /.test(what)) return null;
  if (/could not be (read|listed|compared|asked)|cannot be told/.test(what)) return 'unknown';
  if (/^(tag |refs\/|HEAD is detached)|only here|not on the git server|branch on the git server|default branch is not known/.test(what)) return 'branch';
  return 'work';
}

/**
 * Items (and not-checked lines) of drop's refusals: [{ dir, what, command }]. `sizeOf(dir)`: the size of a
 * repository with no server, or of a folder in no git (leave.mjs walks it within the budget).
 * → { items, notChecked: [{ where, why }] }
 */
export async function refusalItems(list, { home, sizeOf, names = true }) {
  const items = [];
  const notChecked = [];
  for (const r of list) {
    const kind = refusalKind(r.what);
    if (!kind) continue;
    const where = whereOf(r.dir, home);
    // The credentials folder: no name of a file in it is ever shown, so its lines say only what kind of thing it is.
    const [what, todo] = names ? split(tidy(r.what)) : [`something of the credentials repository is only here (${kind === 'unknown' ? 'it could not be looked at' : kind})`, 'commit and push it in the credentials repository'];
    if (kind === 'unknown') {
      notChecked.push({ where, why: names ? tidy(r.what) : what });
      continue;
    }
    if (kind === 'noserver') {
      const s = await sizeOf(r.dir);
      items.push(item({ kind, where, size: s.size, what: `it has no git server, so all of it exists only here${s.done ? '' : ' (at least this size, not measured further)'}`, todo: 'give it a git server and push it', command: r.command }));
    } else if (kind === 'folder') {
      const s = await sizeOf(r.dir);
      if (s.done && !s.files) continue; // an empty folder loses nothing
      items.push(item({ kind, where, size: s.size, what: `a folder in no git: ${plural(s.files, 'file')}${s.done ? '' : ' at least, not measured further'}`, todo: 'make it a repository with a git server and push it, or mark it as yours to keep', command: markCommand(where) }));
    } else if (kind === 'stash') {
      items.push(item({ kind, where, what, todo: todo || 'take it back and commit it, or remove it', command: names ? r.command : '' }));
    } else {
      // A tag, a ref, a detached HEAD, a branch whose server copy went: each its own line, told apart by its subject.
      items.push(item({ kind, where, key: what.replace(/\d+/g, 'n').slice(0, 80), what, todo: todo || 'look at it', command: names ? r.command : '' }));
    }
  }
  return { items, notChecked };
}

/**
 * One line for the files git ignores in a repository that cannot be made again (drop's typed list: an .env, test
 * data, a private folder). `names`: whether their names may be shown (never inside the credentials folder).
 */
export function ignoredItem(dir, list, { home, names = true }) {
  if (!list.length) return null;
  const where = whereOf(dir, home);
  const size = list.reduce((n, x) => n + (x.size || 0), 0);
  const shown = names ? `: ${list.slice(0, 3).map((x) => x.path).join(', ')}${list.length > 3 ? ', …' : ''}` : '';
  return item({ kind: 'folder', where, key: 'ignored', size, what: `${plural(list.length, 'file or folder', 'files or folders')} git ignores ${list.length === 1 ? 'is' : 'are'} in no git${shown}`, todo: 'keep what you need of them somewhere else (a key or an .env in the credentials folder), or delete them', command: '' });
}
