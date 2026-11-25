// `hoprig drop <name>`: a project leaves THIS computer safely (docs/WORKSPACE.md, "Drop"). The owner's rule: before a
// project is removed it is pushed to its git server, so that it can be brought back with `hoprig get`. "Somewhere else"
// is the git server only, never "another computer has it". So, for one project, in this order:
//
//   1. the lock `hoprig get` takes for the same project (leftovers.mjs): a get and a drop never run at once;
//   2. every git repository in the project's folder is fetched with prune (the parent, each code repository, any other
//      one inside: nested, a submodule), then checked (dropcheck.mjs) with the git server asked what it has now;
//   3. the questions, all before anything is done: work not committed (one question: a `wip/` branch), commits only on a
//      default branch (per repository: push them, push them as a `wip/` branch, or stop), and the exact list of files
//      git ignores that cannot be made again (confirmed by typing the project's name; no flag skips it);
//   4. the acts: the memory folder committed, the work saved on its `wip/` branch, the branches pushed (never forced);
//   5. the whole check again, after a new fetch: the folder goes only when that finds nothing that exists only here;
//   6. the removal (dropacts.mjs): renamed aside, memory links taken away, this computer's file written, deleted.
// `--check` and `--dry-run` change nothing: no fetch (it writes refs), no commit, no file; the git server is asked
// read-only (git ls-remote). The map keeps the entry: the project is "in the map, not on this computer".
import fs from 'node:fs';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { capture, showCommand } from '../setup/system.mjs';
import { MEMORY_MESSAGE, readManifest } from '../pcsetup/workspace.mjs';
import { sayLock, takeLock } from '../pcsetup/leftovers.mjs';
import { LEAVES, leaves, leavesWords, myLinkCommand } from './inside.mjs';
import { isGitRepo, isLinkedWorktree, projectsIn, remoteOf, workspaceDir } from './layout.mjs';
import { readMap, sameUrl } from './map.mjs';
import { findProject, placeOf, placesOf, refOf } from './groups.mjs';
import { askServer, checkRepo, inside, sealHash, sealParts } from './dropcheck.mjs';
import { filesIn, memoriesOf, walkProject } from './dropfind.mjs';
import { withoutAWord } from './dropsilent.mjs';
import * as acts from './dropacts.mjs';
import { thisComputer, writeOwnFile } from './computer.mjs';

const lst = (p) => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};
const readRefs = async (dir, run) => {
  const r = await gitRead(dir, ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'], { run });
  return r.ok ? r.stdout.split('\n').filter((n) => n && n !== 'HEAD') : [];
};

/**
 * Which project a name means, and where it is here. → { entry, ref, place, folder, member, link } | { error }.
 * `ctx`: { dir, projects }.
 */
export function findTarget(spec, ctx) {
  const m = readMap(ctx.dir);
  if (!m.exists) return { error: 'there is no workspace map here (hoprig workspace map makes it), so nothing could get the project back: nothing was dropped' };
  if (m.errors) return { error: `the workspace map was refused (${m.errors[0]}): nothing was dropped` };
  let entry;
  try {
    entry = findProject(m.map, spec);
  } catch (e) {
    return { error: e.status === 404 ? `${e.message}: drop takes a project of the workspace map, so that hoprig get can bring it back (a project that is only here: hoprig workspace map adds it)` : e.message };
  }
  const place = placeOf(entry);
  const pl = placesOf(m.map && m.map.version === 2 ? m.map : null, ctx).find((x) => x.id === place);
  if (!pl) return { error: `${refOf(entry)}: its place ${place} is not a place of the workspace map` };
  const folder = path.join(pl.dir, entry.name);
  const st = lst(folder);
  return { entry, ref: refOf(entry), place, placeDir: pl.dir, folder, member: pl.members === 'group', group: pl.group, link: Boolean(st && st.isSymbolicLink()), here: Boolean(st) };
}

/** The folder of `wt` as the owner reads it: relative to the workspace when it is in it. */
const repoLabel = (wt, ctx) => {
  const r = path.relative(ctx.dir, wt);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : wt;
};

/**
 * The whole check of a project: every repository, the memory folders, the private folders. `fetch`: fetch each one
 * with prune first (a real drop only). `seen`: Map(wt → names of the server's branches known before a fetch). `ask`: what
 * tells what the git server has (askServer; the daily look of pc leave hands in one that asks nobody, leave.mjs).
 * → { checks: [checkRepo + label], refusals: [{ repo, what, command }], confirm: [{ repo, path, kind, size, ... }], tops }
 */
export async function lookAt(t, ctx, { fetch = false, run = capture, seen = new Map(), onStep = () => {}, ask = askServer } = {}) {
  const root = t.folder;
  const at = { ...ctx, root };
  const { repos, privates } = walkProject(root);
  const refusals = [];
  const confirm = [];
  const credentials = path.join(ctx.dir, 'credentials');
  const man = t.member ? null : (await readManifest(root, run)).manifest;
  const memories = man ? [...new Set(Object.values(man.memories || {}))] : [];
  const memo = new Map(); // what git said of each folder, for this whole look
  // Its credential links (project.json "credentials", a member's own too): get's own check says which are provably ones.
  const project = { root, manifest: man || (await readManifest(root, run)).manifest, at: { dir: ctx.dir, projects: ctx.projects } };
  const checks = [];
  for (const wt of repos) {
    const label = repoLabel(wt, ctx);
    const origin = (await gitRead(wt, ['config', '--get', 'remote.origin.url'], { run })).ok;
    if (origin && !isLinkedWorktree(wt)) {
      if (!seen.has(wt)) seen.set(wt, await readRefs(wt, run));
      if (fetch) {
        const f = await acts.fetchRepo(at, wt, run);
        onStep('fetch', wt);
        if (!f.ok) refusals.push({ repo: label, what: `it could not be fetched from its git server (${f.why}), so it cannot be told what is only here`, command: showCommand(['git', '-C', wt, 'fetch', 'origin']) });
      }
    }
    const server = origin ? await ask(at, wt, run) : null;
    const c = await checkRepo(wt, { label, repos, memories: wt === root ? memories : [], server, credentials, project, memo, seenBefore: seen.get(wt) || [], run });
    for (const r of c.refusals) refusals.push({ repo: label, ...r });
    for (const i of c.ignored) confirm.push({ repo: label, ...i });
    const sealed = await sealParts(c, run);
    checks.push({ ...c, label, sealed, seal: sealHash(sealed) });
  }
  if (!t.member && !repos.includes(root)) refusals.push({ repo: repoLabel(root, ctx), what: 'its folder is no git repository, so none of it is on a git server', command: '' });
  for (const p of privates) {
    // Inside a folder of build output that git ignores as a whole (an installed package called "ignore"): made again.
    if (await withoutAWord(p, { repos, isDir: true, memo, run })) continue;
    // The repository it is in (the nearest one above it) answers yes or no about it; its names are never read.
    const wt = repos.filter((r) => inside(p, r + path.sep)).sort((a, b) => b.length - a.length)[0] || root;
    const rel = path.relative(wt, p).split(path.sep).join('/');
    const label = repoLabel(wt, ctx);
    const q = await privateState(wt, rel, run);
    if (q.state === 'clean') continue; // all of it is committed: on the git server when its branch is (checked above)
    if (q.state === 'changed' || q.state === 'unknown') {
      refusals.push({ repo: label, what: q.state === 'changed' ? `the private folder ${rel}/ has changes not committed (Hoprig does not look into it): commit and push them yourself, then drop again` : `the private folder ${rel}/ could not be asked whether it has changes not committed: commit and push them yourself, then drop again`, command: showCommand(['git', '-C', wt, 'status', '--', `${rel}/`]) });
      continue;
    }
    // Listed by its name and the number of files in it, whatever .gitignore says of it: never a name from inside it.
    if (!confirm.some((x) => `${x.repo}/${x.path}`.replace(/\/$/, '') === `${label}/${rel}`)) confirm.push({ repo: label, path: `${rel}/`, kind: q.state === 'ignored inside' ? 'private folder, with files git ignores in it' : 'private folder, not in git', size: null, files: filesIn(p) });
  }
  // Claude Code's memory for a folder of the project that is a real folder, not a link into a repository: in no git.
  const launches = [...(t.member ? [] : [root]), ...repos.filter((r) => r !== root)];
  for (const m of memoriesOf(launches, root).filter((x) => x.state === 'real')) {
    const own = m.launch === root && memories.length;
    const files = `${m.files} file${m.files === 1 ? '' : 's'}`;
    // A code repository's memory: moved into the project's memory folder, never over a file of the same name there.
    const into = man && man.memories && man.memories['.'] ? path.join(root, ...man.memories['.'].split('/')) : '';
    const what = own
      ? 'this moves its files into the project\'s memory folder and links it there'
      : into
        ? `the command moves its files into the project's memory folder ${repoLabel(into, ctx)} (a file of the same name there is not overwritten: then the folder stays, and you merge that file by hand), then removes the empty folder`
        : 'the project has no memory folder: copy what you need of it into the project, commit and push it, then remove the folder';
    const command = own ? `hoprig project link ${t.ref}` : into ? `mv -n ${showCommand([m.link])}/* ${showCommand([into])}/ && rmdir ${showCommand([m.link])}` : showCommand(['ls', m.link]);
    refusals.push({ repo: repoLabel(m.launch, ctx), what: `Claude Code's memory for it is a real folder (${m.link}, ${files}), in no git: ${what}`, command });
  }
  // A member's code repositories go, its folder stays: the group must track nothing inside them.
  if (t.member && t.group) {
    const gdir = path.join(ctx.dir, ...t.group.split('/'));
    for (const wt of repos.filter((r) => !repos.some((o) => o !== r && inside(r, o + path.sep)))) {
      const ls = await gitRead(gdir, ['ls-files', '--', path.relative(gdir, wt)], { run });
      if (ls.ok && ls.stdout.trim()) refusals.push({ repo: repoLabel(wt, ctx), what: `the group's repository ${t.group} tracks files inside it, so removing it would show as deletions there: nothing of it is removed`, command: showCommand(['git', '-C', gdir, 'ls-files', '--', path.relative(gdir, wt)]) });
    }
  }
  // A repository inside that neither the map nor project.json names: get does not clone it, so the owner is told
  // where it is kept (its own git server; a submodule comes back with its parent's command).
  const named = new Set([root, ...[...((t.entry && t.entry.repos) || []), ...((man && man.repos) || [])].map((r) => path.join(root, ...String(r.dir || '').split('/')))]);
  const unnamed = [];
  for (const wt of repos) {
    if (named.has(wt) || isLinkedWorktree(wt)) continue;
    const url = remoteOf(wt);
    if (!url) continue; // refused above: no git server
    const sub = lst(path.join(wt, '.git'))?.isFile();
    const top = repos.filter((r) => r !== wt && inside(wt, r + path.sep)).sort((a, b) => b.length - a.length)[0] || root;
    unnamed.push(sub
      ? `${repoLabel(wt, ctx)} is a submodule of ${repoLabel(top, ctx)}: hoprig get does not check it out; after the get,  ${showCommand(['git', '-C', top, 'submodule', 'update', '--init', '--', path.relative(top, wt).split(path.sep).join('/')])}`
      : `${repoLabel(wt, ctx)} is a repository of its own on its git server (${noCredentials(url)}), and hoprig get does not clone it: add it to project.json, or clone it yourself after the get`);
  }
  return { checks, refusals, confirm, repos, unnamed, tops: t.member ? repos.filter((r) => !repos.some((o) => o !== r && inside(r, o + path.sep))) : [root] };
}

/** An address as it may be shown: no user or token in it. */
const noCredentials = (url) => String(url).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');

/**
 * A private folder (no-ai/, ignore/), asked about through git with yes-or-no questions only: no name in it is read or
 * shown. → { state: 'clean' (tracked, nothing changed, nothing untracked or ignored in it) | 'changed' (a tracked
 * file changed, or an untracked file beside tracked ones) | 'untracked' (not in git at all, ignored or not) |
 * 'ignored inside' (tracked and clean, with files git ignores in it) | 'unknown' }
 */
export async function privateState(wt, rel, run) {
  const ask = async (args) => {
    const r = await gitRead(wt, ['--literal-pathspecs', ...args, '--', `${rel}/`], { run });
    return r.ok ? r.stdout.length > 0 : null;
  };
  const tracked = await ask(['ls-files', '-z']);
  const untracked = await ask(['ls-files', '-z', '--others', '--exclude-standard', '--directory']);
  if (tracked === null || untracked === null) return { state: 'unknown' };
  if (!tracked) return { state: 'untracked' }; // an empty one is listed too: it costs one word
  // Asked only of a tracked folder: inside a folder git ignores, git (2.53) fails this question ("directory entry not
  // superset of prefix"), and an untracked folder needs no answer to it.
  const ignored = await ask(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']);
  if (ignored === null) return { state: 'unknown' };
  const d = await gitRead(wt, ['--literal-pathspecs', 'diff', '--quiet', 'HEAD', '--', `${rel}/`], { run });
  if (d.code !== 0 && d.code !== 1) return { state: 'unknown' };
  if (d.code === 1 || untracked) return { state: 'changed' };
  return { state: ignored ? 'ignored inside' : 'clean' };
}

/** What a look finds that a removal would lose, besides the confirmed list: the words, one per thing. */
export function stillHere(look) {
  const out = [...look.refusals.map((r) => `${r.repo}: ${r.what}`)];
  for (const c of look.checks) {
    if (c.work.length) out.push(`${c.label}: ${c.work.length} file${c.work.length === 1 ? '' : 's'} not committed`);
    if (c.memoryChanged) out.push(`${c.label}: the memory folder is not committed`);
    for (const p of c.pushes) out.push(`${c.label}: ${p.branch} is not on the git server`);
    if (c.def) out.push(`${c.label}: ${c.def.branch} has commits not on the git server`);
  }
  return out;
}

/** The refusal of a drop that needs the owner's answers where there is no terminal to ask in. */
export const NO_TERMINAL = 'it needs your answers, and there is no terminal to ask in';

const confirmKey = (i) => `${i.repo}/${i.path}|${i.size}|${i.files ?? ''}`; // a private folder: its count of files

/**
 * The confirmed items under the folder `top` that leaves, each with a key that does not change when `top` is renamed
 * (its repository relative to `top`): a finish after a cut compares what it finds with them. → [{ item, key }]
 */
export function keysUnder(items, top, ctx) {
  const out = [];
  for (const item of items) {
    const rel = path.relative(top, path.resolve(ctx.dir, item.repo));
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    out.push({ item, key: `${rel.split(path.sep).join('/')}|${item.path}|${item.size}|${item.files ?? ''}` });
  }
  return out;
}

/**
 * Drop one project. `mode`: 'drop' | 'check' | 'dry-run'. `ask`: the questions (dropcli.mjs), null without a terminal.
 * `onStep(step, what)`: called after each act (a test stops a run there). → the result for the owner and for --json.
 */
export async function dropProject(spec, { ctx = { dir: workspaceDir(), projects: projectsIn() }, mode = 'drop', ask = null, run = capture, ui, onStep = () => {}, share = null, checked = null } = {}) {
  const t = findTarget(spec, ctx);
  const res = { spec, ok: false, result: 'refused', refusals: [], pushes: [], asks: [], confirm: [], notes: [], did: [] };
  if (t.error) return { ...res, refusals: [{ repo: spec, what: t.error, command: '' }] };
  Object.assign(res, { ref: t.ref, folder: t.folder });
  const dry = mode !== 'drop';
  const key = t.member ? { member: t.ref } : { url: t.entry.url, repo: path.basename(String(t.entry.url)).replace(/\.git$/, '') };
  if (mode === 'drop') {
    const lock = takeLock(t.placeDir, key, { ui, at: ctx });
    if (lock.busy) return { ...res, result: 'busy', refusals: [{ repo: t.ref, what: `a hoprig get of it runs right now${lock.busy.pid ? ` (process ${lock.busy.pid})` : ''}: wait for it, then drop again`, command: '' }] };
    try {
      return await dropLocked(t, res, { ctx, mode, ask, run, ui, onStep, share, checked });
    } finally {
      lock.release();
    }
  }
  if (mode === 'dry-run' && sayLock(t.placeDir, key, { ui })) return { ...res, result: 'busy' };
  return dropLocked(t, res, { ctx, mode, ask, run, ui, onStep, share, dry });
}

async function dropLocked(t, res, { ctx, mode, ask, run, ui, onStep, share, checked = null }) {
  const dry = mode !== 'drop';
  // What a drop cut off after its rename left: checked again as a whole (a terminal open in it follows the rename),
  // then finished; one that holds what is not on the git server now is kept and named. A member's code repositories
  // are renamed in its own folder.
  const spots = t.member ? (t.entry.repos || []).map((r) => [path.join(t.folder, ...path.dirname(r.dir).split('/')), path.basename(r.dir)]) : [[t.placeDir, t.entry.name]];
  const left = [];
  for (const [d, n] of spots) left.push(...(await acts.finishDropping(d, n, ctx, ui, { dryRun: dry, share: dry ? null : share, quiet: true, member: t.member, ref: t.ref, run })));
  const kept = [];
  for (const l of left) {
    if (l.finished) res.did.push(`finished ${l.label}, left by a drop that was cut off (its whole check passed again)`);
    else if (l.would) res.did.push(`${mode === 'check' ? 'a drop would finish' : '(dry run) would finish'} ${l.label}, left by a drop that was cut off (its whole check passes)`);
    else kept.push({ repo: l.label, what: acts.keptWhat(l, t.entry.name, t.ref), command: l.command });
  }
  const finishedSome = left.some((l) => l.finished || l.would);
  if (!t.here) return { ...res, ok: !kept.length, refusals: kept, result: kept.length ? 'refused' : finishedSome ? (dry ? 'would finish' : 'finished') : 'not here' };
  // A project folder that leads out of its place through a link that is not the owner's own: never followed.
  const b = leaves(t.folder, t.folder, ctx);
  if (b) return { ...res, refusals: [{ repo: t.ref, what: `${leavesWords(b)}: drop does not follow it`, command: b.what === LEAVES ? myLinkCommand(b.path) : '' }] };
  if (!t.member) {
    const url = isGitRepo(t.folder) ? remoteOf(t.folder) : null;
    if (!url || !t.entry.url || !sameUrl(url, t.entry.url)) return { ...res, refusals: [{ repo: t.ref, what: `its folder is ${url ? `a clone of another repository than the map's (${t.entry.url || 'none'})` : 'no clone of the map\'s repository'}, so hoprig get would not bring it back: nothing is dropped`, command: '' }] };
  }
  // Another project on this computer names it as a need (its project.json, direct needs only: workspace/needs.mjs).
  // Said in every mode; a drop asks this first, before any fetch or other question; without a terminal it is refused.
  const by = await (await import('./needs.mjs')).neededBy(t.ref, { ctx }).catch(() => []);
  if (by.length) res.neededBy = by;
  if (by.length && mode === 'drop') {
    if (!ask) return { ...res, result: 'refused', noTerminal: true, asks: [{ ask: 'needed', by }], refusals: [{ repo: t.ref, what: NO_TERMINAL, command: `hoprig drop ${t.ref}` }] };
    if (!(await ask.needed(t.ref, by))) return { ...res, result: 'stopped', stoppedAt: 'projects that need it' };
  }
  const seen = new Map();
  const look = await lookAt(t, ctx, { fetch: !dry, run, seen, onStep });
  res.refusals = [...kept, ...look.refusals];
  res.confirm = look.confirm;
  res.notes = [...new Set(look.checks.flatMap((c) => c.notes.map((n) => `${c.label}: ${n}`)))];
  res.rebuilt = look.checks.flatMap((c) => c.rebuilt.map((x) => `${c.label}/${x}`));
  res.credLinks = look.checks.reduce((n, c) => n + c.credLinks.length, 0);
  res.notes.push(...look.unnamed);
  res.seals = look.checks.map((c) => [c.label, c.seal]); // what the page's sheet stands for (dropweb.mjs)
  if (t.member && !look.repos.length) return { ...res, ok: true, result: 'not here' };
  const work = look.checks.filter((c) => c.work.length && !c.linked);
  const defs = look.checks.filter((c) => c.def);
  for (const c of look.checks) {
    for (const p of c.pushes) res.pushes.push({ repo: c.label, branch: p.branch, to: p.to, commits: p.count, ...(p.track ? { newOnServer: true } : {}) });
    if (c.memoryChanged && !(c.def && c.current === c.def.branch)) res.pushes.push({ repo: c.label, memory: true, branch: c.current });
  }
  if (by.length && mode !== 'drop') res.asks.push({ ask: 'needed', by });
  if (work.length) res.asks.push({ ask: 'work', repos: work.map((c) => ({ repo: c.label, files: c.work.map((w) => w.path) })) });
  for (const c of defs) res.asks.push({ ask: 'default branch', repo: c.label, branch: c.def.branch, commits: c.def.count, ...(c.memoryChanged && c.current === c.def.branch ? { memory: true } : {}) });
  if (look.confirm.length) res.asks.push({ ask: 'confirm', name: t.entry.name, items: look.confirm.length });
  // Another project needing it is a question of the drop, not something that exists only here: --check's answer (and
  // its exit code) stays about data; neededBy and the ask say it.
  const onlyHere = res.refusals.length + res.pushes.length + res.asks.filter((a) => a.ask !== 'needed').length;
  if (mode === 'check') return { ...res, ok: true, result: onlyHere ? 'only here' : 'nothing only here' };
  if (res.refusals.length) return res;
  if (mode === 'dry-run') return { ...res, ok: true, result: 'would drop', removes: look.tops };
  // The page's sheet showed a check: what this fresh check finds must be exactly that, or nothing is asked or done
  // (dropweb.mjs). The terminal asks right after its own check, so it passes none.
  if (checked && !checked(res)) return { ...res, result: 'changed' };

  // The questions, every one before anything is done.
  if (res.asks.length && !ask) return { ...res, result: 'refused', noTerminal: true, refusals: [{ repo: t.ref, what: NO_TERMINAL, command: `hoprig drop ${t.ref}` }] };
  const label = thisComputer().label;
  const taken = new Set(look.checks.flatMap((c) => c.serverHeads || [])); // a wip/ name free here and on the git server
  const plan = { work: [], defs: [] };
  if (work.length) {
    if (!(await ask.work(work))) return { ...res, result: 'stopped', stoppedAt: 'work' };
    for (const c of work) {
      const name = await acts.wipName(c.dir, label, taken, run);
      taken.add(name);
      plan.work.push({ c, name });
    }
  }
  for (const c of defs) {
    const a = await ask.defaultBranch(c);
    if (a === 'push') plan.defs.push({ c, to: c.def.to });
    else if (a === 'wip') {
      const name = await acts.wipName(c.dir, label, taken, run);
      taken.add(name);
      plan.defs.push({ c, to: name, wip: true });
    } else return { ...res, result: 'stopped', stoppedAt: `default branch of ${c.label}` };
  }
  if (look.confirm.length && !(await ask.confirm(t.entry.name, look.confirm))) return { ...res, result: 'stopped', stoppedAt: 'list of what is deleted with it' };

  // The acts, from what the check sealed (dropcheck.mjs sealParts), never from the files as they are now: every
  // commit is made from the bytes the check hashed, on an index of its own, and nothing references it before a push
  // of it succeeded. Before every push each sealed file (and what is staged, where Hoprig has not touched the index)
  // is read again: one that is not as the check saw it stops the drop ("changed"); what was not pushed yet is not,
  // and no branch of this computer is moved for it. A failure stops here: the folder stays, what was done is said.
  const at = { ...ctx, root: t.folder };
  const fail = (what, why) => ({ ...res, result: 'failed', refusals: [{ repo: what, what: `${why}: the project stays here`, command: '' }] });
  const changed = (repo, p) => ({ ...res, result: 'changed', refusals: [{ repo, what: `${p} changed while the drop ran, so it is not what you were shown: nothing more is pushed, and the project stays here`, command: '' }] });
  const entriesOf = (c, kind) => c.sealed.files.filter((f) => f[0] === kind).map((f) => ({ path: f[2], id: f[3] }));
  const memSha = new Map(); // repository → the memory commit (made, not yet referenced)
  const wipOf = new Map(); // repository → { sha, name } of its wip/ commit
  for (const c of look.checks.filter((x) => x.memoryChanged)) {
    const m = await acts.sealedCommit(at, c.dir, { parent: c.sealed.head, entries: entriesOf(c, 'memory'), message: MEMORY_MESSAGE, algo: c.sealed.algo, run });
    if (!m.ok) return m.changed ? changed(c.label, m.changed) : fail(c.label, `its memory folder could not be committed (${m.why})`);
    if (!m.same) memSha.set(c.dir, m.sha);
    onStep('memory', c.dir);
  }
  for (const { c, name } of plan.work) {
    if (c.sealed.staged === null) return fail(c.label, 'what is staged in it could not be read');
    const mem = new Set(entriesOf(c, 'memory').map((e) => e.path));
    // What is staged first, as it is staged (a file staged and changed again keeps both versions), then the rest.
    let parent = memSha.get(c.dir) || c.sealed.head;
    const staged = c.sealed.staged.filter(([p]) => !mem.has(p)).map(([p, mode, id]) => ({ path: p, mode, id }));
    if (staged.length) {
      const s = await acts.sealedCommit(at, c.dir, { parent, entries: staged, message: 'Staged work, kept by hoprig drop', algo: c.sealed.algo, run });
      if (!s.ok) return fail(c.label, `the work could not be saved on ${name} (${s.why})`);
      parent = s.sha;
    }
    const w = await acts.sealedCommit(at, c.dir, { parent, entries: entriesOf(c, 'work'), message: 'Work in progress, kept by hoprig drop', algo: c.sealed.algo, run });
    if (!w.ok) return w.changed ? changed(c.label, w.changed) : fail(c.label, `the work could not be saved on ${name} (${w.why})`);
    wipOf.set(c.dir, { sha: w.sha, name });
    onStep('wip-commit', c.dir);
  }
  const touched = new Set(); // repositories whose index or branches the press changed: their staging is its own now
  const drifted = async () => {
    for (const c of look.checks) {
      const now = await sealParts(c, run);
      const was = new Map(c.sealed.files.map((f) => [`${f[0]} ${f[1]} ${f[2]}`, f[3]]));
      for (const f of now.files) if (was.get(`${f[0]} ${f[1]} ${f[2]}`) !== f[3]) return changed(c.label, f[2]);
      if (now.files.length !== c.sealed.files.length) return changed(c.label, 'a file of its list');
      if (!touched.has(c.dir) && JSON.stringify(now.staged) !== JSON.stringify(c.sealed.staged)) return changed(c.label, 'what is staged in it');
    }
    return null;
  };
  const tipOf = (c, b) => (b === c.current && memSha.get(c.dir)) || sealedTips(c).get(b) || '';
  // A push that carried the memory commit: this computer's branch moves to it (only from where the check saw it).
  const memoryHome = async (c, b, sha) => {
    if (b !== c.current || sha !== memSha.get(c.dir) || res.did.includes(`${c.label}: committed the memory folder`)) return null;
    const m = await acts.moveBranch(at, c.dir, b, sha, sealedTips(c).get(b) || '', run);
    if (!m.ok) return changed(c.label, `its branch ${b}`);
    touched.add(c.dir);
    if (!wipOf.has(c.dir)) await acts.indexFromHead(at, c.dir, entriesOf(c, 'memory').map((e) => e.path), run);
    res.did.push(`${c.label}: committed the memory folder`);
    return null;
  };
  for (const { c, name } of plan.work) {
    const stop = await drifted();
    if (stop) return stop;
    const { sha } = wipOf.get(c.dir);
    const s = await acts.pushSha(at, c.dir, sha, name, run);
    if (!s.ok) return fail(c.label, `the work could not be saved on ${name} (${s.why})`);
    const k = await acts.takeWip(at, c.dir, name, sha, c.sealed.algo, run);
    touched.add(c.dir);
    onStep('wip', c.dir);
    if (!k.ok) return fail(c.label, `the work is on the git server as ${name}, but this computer could not be put on that branch (${k.why})`);
    res.did.push(`${c.label}: saved the work on ${name} and pushed it (the repository is on that branch now; the branch it was on did not move)`);
  }
  for (const c of look.checks) {
    for (const p of c.pushes) {
      const stop = await drifted();
      if (stop) return stop;
      const sha = tipOf(c, p.branch);
      if (!sha) return fail(c.label, `${p.branch} was not seen by the check`);
      const r = await acts.pushSha(at, c.dir, sha, p.to, run);
      if (!r.ok) return fail(c.label, `${p.branch} could not be pushed (${r.why}); push it yourself:  ${acts.pushCommand(c.dir, p.branch, p.to, p.track)}`);
      if (p.track) await acts.setUpstream(at, c.dir, p.branch, p.to, run);
      const m = await memoryHome(c, p.branch, sha);
      onStep('push', `${c.dir} ${p.branch}`);
      if (m) return m;
      res.did.push(`${c.label}: pushed ${p.branch}${p.to !== p.branch ? ` to ${p.to}` : ''}`);
    }
  }
  for (const { c, to, wip } of plan.defs) {
    const stop = await drifted();
    if (stop) return stop;
    const sha = tipOf(c, c.def.branch);
    if (!sha) return fail(c.label, `${c.def.branch} was not seen by the check`);
    const r = await acts.pushSha(at, c.dir, sha, to, run);
    if (!r.ok) return fail(c.label, `${c.def.branch} could not be pushed${wip ? ` as ${to}` : ''} (${r.why})`);
    const m = await memoryHome(c, c.def.branch, sha);
    onStep('push', `${c.dir} ${c.def.branch}`);
    if (m) return m;
    res.did.push(`${c.label}: pushed ${c.def.branch}${wip ? ` as ${to}` : ''}`);
  }

  // The whole check again, after a new fetch: only nothing that exists only here lets the folder go.
  onStep('check', t.folder);
  const again = await lookAt(t, ctx, { fetch: true, run, seen, onStep });
  const left2 = stillHere(again);
  const ok = new Set(look.confirm.map(confirmKey));
  for (const i of again.confirm) if (!ok.has(confirmKey(i))) left2.push(`${i.repo}/${i.path}: an ignored file that was not in the list you confirmed`);
  if (left2.length) return { ...res, result: 'refused', refusals: left2.map((w) => ({ repo: t.ref, what: `after the pushes, still only here: ${w}`, command: '' })), secondCheck: true };

  // The removal.
  for (const top of again.tops) {
    const spelled = lst(top).isSymbolicLink();
    const links = acts.memoryLinksOf(top, { spelled });
    const renamed = acts.renameAway(ctx, top, keysUnder(again.confirm, top, ctx).map((k) => k.key));
    onStep('rename', renamed);
    res.did.push(`renamed ${repoLabel(top, ctx)} to ${path.basename(renamed)}`);
    acts.unlinkAll([...new Set([...links, ...acts.memoryLinksOf(top, { spelled })])]);
    onStep('link', top);
    if (links.length) res.did.push(`took away ${links.length} memory link${links.length > 1 ? 's' : ''}`);
    res.pending = [...(res.pending || []), renamed];
  }
  const own = await writeOwnFile({ dir: ctx.dir, projects: ctx.projects });
  onStep('file', own.file || '');
  if (own.written) res.did.push('wrote this computer\'s file without it');
  else if (own.why) res.notes.push(own.why);
  const notDeleted = [];
  for (const r of res.pending) {
    const d = acts.deleteAway(ctx, r);
    onStep('delete', r);
    if (!d.ok) notDeleted.push({ repo: repoLabel(r, ctx), what: `its check passed and it is off the workspace, but the renamed folder could not be deleted (${d.why}): delete it yourself (hoprig get ${t.ref} works meanwhile)`, command: acts.deleteCommand(r) });
  }
  delete res.pending;
  if (!notDeleted.length) res.did.push(`removed ${again.tops.map((x) => repoLabel(x, ctx)).join(', ')}`);
  if (share) res.shared = await share();
  if (notDeleted.length) return { ...res, ok: false, result: 'left over', refusals: notDeleted };
  return { ...res, ok: true, result: 'dropped', refusals: [] };
}

/** The tip of every local branch as the check sealed it: Map(branch → commit). */
function sealedTips(c) {
  return new Map(String(c.sealed.heads || '').split('\n').filter(Boolean).map((l) => l.split('\t')).map(([r, s]) => [r.replace(/^refs\/heads\//, ''), s]));
}
