// What `hoprig drop` does once it has checked a project (drop.mjs): fetch, push without forcing, save work on a `wip/`
// branch, and take the project's folder away so that nothing half made blocks the next `get`:
//
//   1. the folder is renamed beside itself (.<name>.dropping-<time>): from now on it is no project to any list or scan;
//   2. Claude Code's memory links into it are taken away (only links: a real folder is refused before, drop.mjs);
//   3. this computer's own file in the brain is written without it (computer.mjs writeOwnFile: nothing without a label);
//   4. the renamed folder is deleted (a link is removed as a link: what it points to is never touched);
//   5. the computer's file is committed and pushed by the upkeep's own path, when its switches are on.
// A run cut off after step 1 is finished by the next `drop` or `get` (finishDropping), but only after the whole check
// again: a terminal open in the project follows the rename, and work done there since must not go with it. Every act
// on the workspace goes through inside.mjs; the memory links live in Claude Code's own folder, outside the workspace.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { capture, showCommand, showCommands, showFileCommand, showLinkRemoveCommand } from '../setup/system.mjs';
import { gitRead } from '../gitread.mjs';
import { readManifest, stamp } from '../pcsetup/workspace.mjs';
import { LEAVES, gitIn, leaves, readIn, removeIn, renameIn, writeIn } from './inside.mjs';
import { idOf, isGitId, lastLine, quietEnv, readSealed } from './dropcheck.mjs';
import { writeOwnFile } from './computer.mjs';
import { droppingIn, droppingName, linksInto, walkProject } from './dropfind.mjs';

/** `git fetch --prune` of one repository from its git server. → { ok, why? } */
export async function fetchRepo(at, dir, run = capture) {
  const r = await gitIn(at, dir, ['fetch', '--prune', '--quiet', 'origin'], run, { env: quietEnv(), timeout: 600_000 });
  return r.ok ? { ok: true } : { ok: false, why: lastLine(r) };
}

/** The upstream of a branch pushed for the first time: origin's `<to>` (what `git push -u` would have set). */
export async function setUpstream(at, dir, branch, to, run = capture) {
  for (const [k, v] of [[`branch.${branch}.remote`, 'origin'], [`branch.${branch}.merge`, `refs/heads/${to}`]]) {
    const r = await gitIn(at, dir, ['config', k, v], run);
    if (!r.ok) return { ok: false, why: lastLine(r) };
  }
  return { ok: true };
}

/** The command the owner runs for the same push. */
export const pushCommand = (dir, from, to, track = false) => showCommand(['git', '-C', dir, 'push', ...(track ? ['-u'] : []), 'origin', from === to ? from : `${from}:${to}`]);

/** The name of a new `wip/` branch: wip/<label>-<time> (wip/<time> without a label), one not taken here or on the server. */
export async function wipName(dir, label, taken = new Set(), run = capture) {
  const base = `wip/${label ? `${label}-` : ''}${stamp()}`;
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (taken.has(name)) continue;
    const here = await gitRead(dir, ['rev-parse', '--verify', '-q', `refs/heads/${name}`], { run });
    if (!here.ok) return name;
  }
}

/** A plain push of the commit `sha` to `refs/heads/<to>` on origin: never forced. What is pushed is that commit. */
export async function pushSha(at, dir, sha, to, run = capture) {
  const r = await gitIn(at, dir, ['push', '--quiet', '--', 'origin', `${sha}:refs/heads/${to}`], run, { env: quietEnv(), timeout: 600_000 });
  return r.ok ? { ok: true } : { ok: false, why: lastLine(r) };
}

/**
 * A commit made from exactly what a check sealed (dropcheck.mjs sealParts), never from the files as they are when the
 * press runs: on a temporary index of its own (the repository's own index, HEAD and branches are not touched), each
 * file is read once, its blob id must be the sealed one, and that blob is what goes in. `entries`: [{ path, id, mode? }]
 * (`mode`: a staged entry, taken as it is: its blob is in the repository already; id 'none': the path is removed).
 * `parent`: a commit or '' (none). Nothing references the commit until a push of it succeeds. → { ok, sha, same } |
 * { ok: false, changed?: path, why }
 */
export async function sealedCommit(at, dir, { parent, entries, message, algo, run = capture }) {
  const gd = await gitRead(dir, ['rev-parse', '--absolute-git-dir'], { run });
  if (!gd.ok) return { ok: false, why: lastLine(gd) };
  const index = path.join(gd.stdout.trim(), `hoprig-drop-${process.pid}-${crypto.randomBytes(4).toString('hex')}.index`);
  const env = { ...quietEnv(), GIT_INDEX_FILE: index };
  const g = (args, opts = {}) => gitIn(at, dir, args, run, { env, ...opts });
  const changed = (p) => ({ ok: false, changed: p, why: `${p} is not as the check saw it` });
  try {
    const rt = await g(parent ? ['read-tree', parent] : ['read-tree', '--empty']);
    if (!rt.ok) return { ok: false, why: lastLine(rt) };
    const fm = await gitRead(dir, ['config', '--get', 'core.fileMode'], { run });
    const fileMode = !/^false$/i.test((fm.stdout || '').trim());
    for (const e of entries) {
      let r;
      if (e.id === 'none') r = await g(['update-index', '--force-remove', '--', e.path]);
      else if (e.mode) r = await g(['update-index', '--add', '--cacheinfo', `${e.mode},${e.id},${e.path}`]);
      else if (e.id.startsWith('gitlink ')) {
        if ((await idOf(dir, e.path, algo, run)) !== e.id) return changed(e.path);
        r = await g(['update-index', '--add', '--cacheinfo', `160000,${e.id.slice(8)},${e.path}`]);
      } else {
        if (!isGitId(e.id)) return { ok: false, why: `${e.path} is not a file git can keep (${e.id})` };
        const file = path.join(dir, ...e.path.split('/'));
        if (leaves(at.root || dir, file, at)) return { ok: false, why: `${e.path} ${LEAVES}` };
        let f;
        try {
          f = await readSealed(file);
        } catch {
          return changed(e.path);
        }
        if (f.marker) return changed(e.path);
        const h = await g(['hash-object', '-w', '--no-filters', '--stdin'], { input: f.data });
        if (!h.ok) return { ok: false, why: lastLine(h) };
        if (h.stdout.trim() !== e.id) return changed(e.path);
        const was = /^(\d{6}) /.exec((await g(['--literal-pathspecs', 'ls-files', '-s', '--', e.path])).stdout || '');
        const mode = f.link ? '120000' : fileMode ? (f.exec ? '100755' : '100644') : was && was[1] === '100755' ? '100755' : '100644';
        r = await g(['update-index', '--add', '--cacheinfo', `${mode},${e.id},${e.path}`]);
      }
      if (!r.ok) return { ok: false, why: lastLine(r) };
    }
    const tree = await g(['write-tree']);
    if (!tree.ok) return { ok: false, why: lastLine(tree) };
    if (parent) {
      const pt = await gitIn(at, dir, ['rev-parse', '--verify', '-q', `${parent}^{tree}`], run);
      if (pt.ok && pt.stdout.trim() === tree.stdout.trim()) return { ok: true, sha: parent, same: true };
    }
    const c = await g(['commit-tree', tree.stdout.trim(), ...(parent ? ['-p', parent] : []), '-m', message]);
    return c.ok ? { ok: true, sha: c.stdout.trim(), same: false } : { ok: false, why: lastLine(c) };
  } finally {
    try {
      removeIn(at, index);
    } catch {
      /* the temporary index is git's own file in its own folder: left, it is never read again */
    }
  }
}

/** Move `refs/heads/<branch>` to `sha`, only from `old` (another move since the check: refused). → { ok, why? } */
export async function moveBranch(at, dir, branch, sha, old, run = capture) {
  const r = await gitIn(at, dir, ['update-ref', '-m', 'hoprig drop', `refs/heads/${branch}`, sha, old], run);
  return r.ok ? { ok: true } : { ok: false, why: lastLine(r) };
}

/** After a pushed commit holds them: git's index for `paths` taken from HEAD (the working files are not touched). */
export const indexFromHead = (at, dir, paths, run = capture) => gitIn(at, dir, ['reset', '-q', '--', ...paths], run);

/** A pushed `wip/` branch made this repository's own: the branch, HEAD on it, the index as its commit, its upstream. */
export async function takeWip(at, dir, name, sha, algo, run = capture) {
  const none = algo === 'sha256' ? '0'.repeat(64) : '0'.repeat(40);
  for (const args of [['update-ref', '-m', 'hoprig drop', `refs/heads/${name}`, sha, none], ['symbolic-ref', 'HEAD', `refs/heads/${name}`], ['reset', '-q'], ['config', `branch.${name}.remote`, 'origin'], ['config', `branch.${name}.merge`, `refs/heads/${name}`]]) {
    const r = await gitIn(at, dir, args, run);
    if (!r.ok) return { ok: false, why: lastLine(r) };
  }
  return { ok: true };
}

// ---- the removal ----

const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/**
 * The memory links of Claude Code into a folder that leaves (by its name, also once it is gone). `spelled`: the folder
 * is a link itself: only links into it by its own name count (what it points to stays, and so do the links into that).
 */
export const memoryLinksOf = (folder, { spelled = false } = {}) => linksInto(folder, { spelled });

/** Take the links away: each one only when it is still a link (never a real folder). → [link removed] */
export function unlinkAll(links) {
  const out = [];
  for (const l of links) {
    const st = lst(l);
    if (!st || !st.isSymbolicLink()) continue;
    fs.unlinkSync(l); // the link itself, in Claude Code's own folder: never what it points to
    out.push(l);
  }
  return out;
}

// The ignored files the owner confirmed for a folder, kept in its renamed git folder: a finish later compares what it
// finds with them (deleted with the folder; a run cut off before it is written has none, so a finish then refuses).
const RECORD = 'hoprig-drop-confirmed.json';

/** Step 1: rename `folder` beside itself, and keep `confirmed` (keys of drop.mjs keysUnder) in it. → the new path */
export function renameAway(at, folder, confirmed = []) {
  const dir = path.dirname(folder);
  let to = path.join(dir, droppingName(path.basename(folder), stamp()));
  for (let i = 2; lst(to); i++) to = path.join(dir, `${droppingName(path.basename(folder), stamp())}-${i}`);
  const renamed = renameIn({ ...at, root: dir }, folder, to);
  const st = lst(renamed);
  if (st && st.isDirectory() && lst(path.join(renamed, '.git'))?.isDirectory()) {
    try {
      writeIn({ ...at, root: renamed }, path.join(renamed, '.git', RECORD), `${JSON.stringify({ confirmed })}\n`);
    } catch {
      /* without it a finish later refuses what it finds ignored: safe */
    }
  }
  return renamed;
}

const confirmedOf = (renamed, at) => {
  try {
    const list = JSON.parse(String(readIn({ ...at, root: renamed }, path.join(renamed, '.git', RECORD)) || '{}')).confirmed;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

/**
 * The command that deletes `p` by hand (a read-only folder in it made writable first). A link: the link only. On
 * Windows a folder is removed by showFileCommand's walk: read-only marks taken off (git's objects carry one there, the
 * job chmod -R u+w does on Linux and macOS), and a junction or link inside removed as a link, never followed.
 */
export const deleteCommand = (p, platform = process.platform) => {
  if (lst(p)?.isSymbolicLink()) return showLinkRemoveCommand(p, platform);
  return platform === 'win32' ? showFileCommand('rm -rf', [p], platform) : showCommands([['chmod', '-R', 'u+w', p], ['rm', '-rf', p]]);
};

/** Step 4: delete what was renamed away (a link: the link only; a read-only folder in it is made writable first). → { ok, why? } */
export function deleteAway(at, renamed) {
  try {
    removeIn({ ...at, root: path.dirname(renamed) }, renamed, { recursive: true, writable: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/** Is there a file (or a link) anywhere in folder `d`? An unreadable folder counts as holding one. */
function holdsAFile(d) {
  let ents;
  try {
    ents = fs.readdirSync(d, { withFileTypes: true });
  } catch {
    return true;
  }
  return ents.some((e) => !e.isDirectory() || holdsAFile(path.join(d, e.name)));
}

/**
 * What a folder a drop renamed away holds now that is not on the git server: the whole check again (read only, as
 * --check). A link is only a link: what it points to is never deleted. → [words] (empty: it may go)
 */
async function stillThere(renamed, ctx, { member, ref, run }) {
  if (lst(renamed)?.isSymbolicLink()) return [];
  // A delete that failed at its top (the folder it lies in could not be written) has emptied it already: nothing to lose.
  if (!holdsAFile(renamed)) return [];
  try {
    const { keysUnder, lookAt, stillHere } = await import('./drop.mjs');
    const look = await lookAt({ folder: renamed, member, ref, group: null }, ctx, { run });
    const left = stillHere(look);
    const ok = new Set(confirmedOf(renamed, ctx));
    for (const k of keysUnder(look.confirm, renamed, ctx)) if (!ok.has(k.key)) left.push(`${k.item.repo}/${k.item.path}: a file git ignores that was not in the list you confirmed`);
    return left;
  } catch (e) {
    return [`it could not be checked (${e.message})`];
  }
}

/**
 * Did a delete of the renamed folder stop partway (a file held open stopped it)? → null, or { gone: the parts that
 * lost their git folder (the folder itself, a repository its project.json names whose folder is still there): nothing
 * in those can be pushed any more; alive: every working tree in it that still has its git folder, from which what is
 * not on the git server can still be pushed }.
 */
async function halfDeleted(renamed, run) {
  if (lst(renamed)?.isSymbolicLink()) return null;
  const gone = lst(path.join(renamed, '.git')) ? [] : [renamed];
  if (lst(path.join(renamed, 'project.json'))?.isFile()) {
    for (const r of (await readManifest(renamed, run)).manifest?.repos || []) {
      const d = path.join(renamed, ...String(r.dir).split('/'));
      if (lst(d)?.isDirectory() && !lst(path.join(d, '.git'))) gone.push(d);
    }
  }
  return gone.length ? { gone, alive: walkProject(renamed).repos } : null;
}

/** A part of a renamed folder as the owner reads it: "its folder", or its path in it (code/shop-api). */
const partOf = (renamed, p) => (p === renamed ? 'its folder' : path.relative(renamed, p).split(path.sep).join('/'));

/**
 * Finish what a drop cut off after its rename left in `dir` for `name`: the whole check of the renamed folder again,
 * then the memory links into the folder it was, then the renamed folder. One that holds something not on the git
 * server now is kept and named. `ctx`: { dir, projects } of the workspace. `share`: write (and commit) this computer's
 * file after. `quiet`: say nothing (drop says it in its result). `member`, `ref`: the project, as drop names it.
 * `get`: hoprig get asks, and gets the project under its name right after (so it cannot be taken back as that).
 * → [{ path, label, links, finished, would?, left?: [words], command? }]
 */
export async function finishDropping(dir, name, ctx, ui, { dryRun = false, share = null, quiet = false, member = false, ref = name, get = false, run = capture } = {}) {
  const out = [];
  for (const l of droppingIn(dir, name)) {
    const rel = path.relative(ctx.dir, l.path);
    const label = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : l.path;
    const spelled = lst(l.path).isSymbolicLink();
    // The links into the folder it was, unless that folder is there again (a get since): then they are that one's.
    const here = Boolean(lst(path.join(dir, l.name)));
    const links = here ? [] : memoryLinksOf(path.join(dir, l.name), { spelled });
    const left = await stillThere(l.path, ctx, { member, ref, run });
    if (left.length) {
      const half = await halfDeleted(l.path, run);
      // Only the parts that lost their git folder are past pushing: from every one that has it, the owner pushes first.
      const half2 = half ? { half: true, gone: half.gone.map((p) => partOf(l.path, p)), alive: half.alive.map((p) => partOf(l.path, p)) } : {};
      const command = !half ? showCommand(['git', '-C', l.path, 'status']) : half.alive.length ? showCommands(half.alive.map((p) => ['git', '-C', p, 'status'])) : deleteCommand(l.path);
      const item = { path: l.path, label, links: [], finished: false, left, here: here || get, ...half2, command };
      if (!quiet) ui.line('warn', `${label}: ${keptWhat(item, name, ref)}\n      ${item.command}`);
      out.push(item);
      continue;
    }
    if (dryRun) {
      if (!quiet) ui.note(`(dry run) ${label} was left by a drop that was cut off: it would be finished (${links.length ? `${links.length} memory link${links.length > 1 ? 's' : ''} taken away, ` : ''}the folder deleted)`);
      out.push({ path: l.path, label, links, finished: false, would: true });
      continue;
    }
    unlinkAll(links);
    const d = deleteAway(ctx, l.path);
    if (!d.ok) {
      const item = { path: l.path, label, links, finished: false, left: [`it could not be deleted (${d.why})`], command: deleteCommand(l.path) };
      if (!quiet) ui.line('warn', `${label}: ${keptWhat(item, name, ref)}\n      ${item.command}`);
      out.push(item);
      continue;
    }
    if (!quiet) ui.line('ok', `${label}: a drop that was cut off is finished (its whole check passed again)`);
    out.push({ path: l.path, label, links, finished: true });
  }
  if (out.some((x) => x.finished)) {
    await writeOwnFile({ dir: ctx.dir, projects: ctx.projects }).catch(() => null); // what is here now
    if (share) await share();
  }
  return out;
}

const listOf = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0]);

/**
 * The words for a folder a cut-off drop left that is kept (after its name and a colon). `here`: the project is on
 * disk again (a get since), so the folder cannot be taken back under its name.
 */
export const keptWhat = (x, name, ref) => x.half && !(x.alive && x.alive.length)
  ? 'left by a drop that was cut off, and a delete of it stopped partway: its git folders are gone, so nothing in it can be pushed or checked any more, and it is kept: look at it first and copy out what you still need, then delete it yourself'
  : x.half
    ? `left by a drop that was cut off, and a delete of it stopped partway: ${listOf(x.gone)} lost ${x.gone.length > 1 ? 'their git folders' : 'its git folder'}, so nothing there can be pushed or checked any more; ${listOf(x.alive)} still ${x.alive.length > 1 ? 'have their git folders' : 'has its git folder'}, so what is only there can still be pushed (the check found: ${x.left[0]}${x.left.length > 1 ? `, and ${x.left.length - 1} more` : ''}). It is kept: push from there what git status shows is not on the git server, copy out what you still need of the rest, then delete the folder yourself`
  : x.command && x.command.startsWith('git ')
    ? `left by a drop that was cut off, it holds what is not on the git server now (${x.left[0]}${x.left.length > 1 ? `, and ${x.left.length - 1} more` : ''}), so it is kept: push that from there${x.here ? '' : ` (or take the folder back as ${name})`}, then hoprig drop ${ref} finishes it`
    : `left by a drop that was cut off, it passed its check again but ${x.left[0]}: delete it yourself`;
