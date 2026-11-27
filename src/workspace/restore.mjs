// `hoprig workspace restore <brain address>`: a fresh computer gets its workspace from git. The AI brain is cloned
// into <workspace>/ai_brain and its map (map.mjs) says what else belongs to the workspace: the credentials repository
// when the map names one, every group's own repository and the other repositories are cloned where the map puts
// them, and the missing folders of the tree are made. NO project is cloned: a project comes to a computer only when
// its owner asks for it (`hoprig get <name>`), and restore lists each one as "in the map, not on this computer".
// `withProjects` (`restore --with-projects`) is the one option for an owner who wants every project everywhere:
// then each project's parent and code repositories are cloned too, and each project it cloned is finished like
// `project clone` does (memory links, git hooks, .env.example, the dependency installs offered); a project that was
// here already is not changed (what it misses is said, with `hoprig project setup <name>`).
//
// Safe to run again: what is there is never overwritten or moved (one exception: the starting brain that
// `workspace setup` made and nobody changed is kept aside as ai_brain.unused-<time>, so restore can follow setup; and
// a broken clone of the same address, one without a first commit checked out, is moved aside under a dated name by
// the clone, inside.mjs cloneInto). A folder that is there is left alone: when it is the same repository it counts as
// done, when it is something else it is reported. A repository that cannot be cloned (no access, wrong address) is
// listed with git's reason and the rest goes on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { tilde } from '../paths.mjs';
import { finishProject } from '../pcsetup/project.mjs';
import { findByAddress, gitReason, mvCommand } from '../pcsetup/getproject.mjs';
import { cloneRepo, parseRepo, rememberDir } from '../pcsetup/projects.mjs';
import { MANIFEST, readManifest, stamp } from '../pcsetup/workspace.mjs';
import { capture, showFileCommand, stream } from '../setup/system.mjs';
import { loadConfig } from '../config.mjs';
import { WORKTREE_WHY, isDir, isGitRepo, isLinkedWorktree, projectsIn, workspaceDir } from './layout.mjs';
import { mapTargets, placeDir, placesOf, planGroupMemories } from './groups.mjs';
import { LEAVES, brokenClone, gitIn, leaves, leavesWords, mkdirIn, myLinkCommand, renameIn, rmdirIn } from './inside.mjs';
import { MAP_FILE, readMap, refOf, sameUrl } from './map.mjs';
import { placeOf } from './mapcheck.mjs';
import { toolsState, waitingLine } from './grouptool.mjs';
import { ruleOf } from './findrule.mjs';
import { makeFolders } from '../pcsetup/getbyrule.mjs';
import { brainScaffold, workspaceSetup } from './setup.mjs';
import { untouchedCredentials } from './credlinks.mjs';
import { writeOwnFile } from './computer.mjs';

/** The projects folder this computer chose before (config "projectsDir"), or null. */
function chosenProjectsDir() {
  try {
    const c = loadConfig();
    return typeof c.projectsDir === 'string' && path.isAbsolute(c.projectsDir) ? c.projectsDir : null;
  } catch {
    return null;
  }
}

const fail = (status, message) => Object.assign(new Error(message), { status });
const emptyDir = (d) => {
  try {
    return fs.readdirSync(d).length === 0;
  } catch {
    return false;
  }
};

/** What is at `dest` for the repository `url`: clone | here | different | no-address (+ why). */
export async function placeState(dest, url, run = capture) {
  if (!fs.existsSync(dest) || emptyDir(dest)) return url ? { action: 'clone' } : { action: 'no-address', why: 'not on a git server yet: copy it from the computer that has it' };
  if (!isGitRepo(dest)) return { action: 'different', why: 'a folder that is not this repository is there' };
  if (isLinkedWorktree(dest)) return { action: 'different', why: WORKTREE_WHY }; // never cloned over, never counted as this one
  const r = await gitRead(dest, ['config', '--get', 'remote.origin.url'], { run, timeout: 10_000 });
  const have = r.ok ? r.stdout.trim() : '';
  // A clone of this address that was cut off: the clone moves it aside under a dated name and clones again.
  if (url && have === url && (await brokenClone(dest, url))) return { action: 'clone', why: 'a clone that was cut off is there: it is moved aside under a dated name and cloned again' };
  if (!url || sameUrl(have, url)) return { action: 'here' };
  return { action: 'different', why: `another repository is there (${have ? 'its address differs' : 'it has no remote'})` };
}

/**
 * The starting brain `workspace setup` makes, with nothing of the person's in it: exactly the scaffold's files with
 * the scaffold's text, and (when it is a git repository) only setup's first commit, no remote, nothing uncommitted.
 */
export async function untouchedScaffold(dir, run = capture) {
  const files = brainScaffold();
  const listed = [];
  const walk = (rel) => {
    for (const d of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (r === '.git') continue;
      if (d.isDirectory()) walk(r);
      else listed.push(r);
    }
  };
  try {
    walk('');
  } catch {
    return false;
  }
  if (listed.sort().join('\n') !== Object.keys(files).sort().join('\n')) return false;
  if (listed.some((r) => fs.readFileSync(path.join(dir, r), 'utf8') !== files[r])) return false;
  if (!isGitRepo(dir)) return true;
  const [log, remote, st] = await Promise.all([
    gitRead(dir, ['log', '--format=%s'], { run }), gitRead(dir, ['remote'], { run }), gitRead(dir, ['status', '--porcelain'], { run }),
  ]);
  return log.ok && log.stdout.trim() === 'Start the AI brain' && remote.ok && !remote.stdout.trim() && st.ok && !st.stdout.trim();
}

/**
 * Every place the map names, in order: the brain, each group that is a repository, each project (in every place)
 * then its code repositories, the others. A member that comes with its group's repository has no clone of its own:
 * only its code repositories are listed, under the group.
 */
/** The plan as a person or a program reads it: `root` (the folder each clone must stay inside) stays inside. */
const shown = (plan) => plan.map(({ root, ...e }) => e);

async function planFrom(map, { dir, projects, brainUrl, run, withProjects = false }) {
  const plan = [{ kind: 'brain', label: 'ai_brain', url: brainUrl, dest: path.join(dir, 'ai_brain'), root: path.join(dir, 'ai_brain'), ...(await placeState(path.join(dir, 'ai_brain'), brainUrl, run)) }];
  // The credentials repository the map names comes right after the brain (before the tree's own credentials folder).
  if (map.credentials && map.credentials.url) {
    const cdir = path.join(dir, 'credentials');
    let state = await placeState(cdir, map.credentials.url, run);
    // The starting folder `workspace setup` makes (its README only, nothing of the owner's): kept aside, then cloned.
    if (state.action === 'different' && untouchedCredentials(cdir)) state = { action: 'clone', aside: true, why: 'the starting credentials folder of workspace setup (its README only) is kept aside as credentials.unused-<time> first' };
    plan.push({ kind: 'credentials', label: 'credentials', url: map.credentials.url, dest: cdir, root: cdir, ...state });
  }
  const ctx = { dir, projects };
  // Without --with-projects a project is never cloned: what a clone would get is "in the map, not on this computer".
  const onDemand = (e, ref) => (!withProjects && e.action === 'clone' ? { ...e, action: 'notHere', why: `in the map, not on this computer: hoprig get ${ref}` } : e);
  // Every folder comes from mapTargets (groups.mjs); one behind a link that is not followed is never looked into.
  const all = await mapTargets(map, ctx, run);
  // The plan's word for it is "not followed"; why says the link and the command that names it as the owner's own.
  const stateOf = (t, url) => (t.blocked ? { action: 'link', why: t.blocked.what === LEAVES ? `${leavesWords(t.blocked)}; if that link is yours:  ${myLinkCommand(t.blocked.path)}` : leavesWords(t.blocked) } : placeState(t.dir, url, run));
  for (const t of all.filter((x) => x.kind === 'group' && x.entry.url)) plan.push({ kind: 'group', label: t.label, url: t.entry.url, dest: t.dir, root: t.root, ...(await stateOf(t, t.entry.url)) });
  const places = placesOf(map, ctx);
  for (const t of all.filter((x) => x.kind === 'project')) {
    const p = t.entry;
    const root = t.dir;
    const ref = t.label;
    const repos = all.filter((x) => x.kind === 'repo' && x.project === ref);
    const place = places.find((x) => x.id === (p.in || '')) || places[0];
    // `root`: the folder each clone must stay inside (inside.mjs), checked again by the clone itself.
    const gbase = place.group ? path.join(dir, ...place.group.split('/')) : null;
    const repoEntry = async (r) => onDemand({ kind: 'repo', project: ref, root: r.root, ...(gbase ? { ingroup: place.group } : {}), label: r.label, url: r.entry.url, branch: r.entry.branch, dest: r.dir, ...(await stateOf(r, r.entry.url)) }, ref);
    if (place.members === 'group') {
      for (const r of repos) plan.push({ ...(await repoEntry(r)), group: place.group });
      continue;
    }
    const pdir = placeDir(place.id, ctx);
    let state = await stateOf(t, p.url);
    // Here already under another name (an older clone named after its repository): reported with the mv, never
    // moved and never cloned a second time.
    // A folder that is itself a project of the map in this place (two entries may share one address: two clones
    // someone keeps) is in its own place, never the misnamed copy of this one.
    const other = state.action === 'clone' ? (await findByAddress(pdir, p.url, run)).filter((f) => !map.projects.some((x) => (x.in || '') === place.id && x.name === f))[0] : null;
    if (other) state = { action: 'misnamed', why: `it is here as ${other}: to give it the map's name run  ${mvCommand(pdir, other, p.name)}`, mv: mvCommand(pdir, other, p.name) };
    plan.push(onDemand({ kind: 'project', label: ref, url: p.url, dest: root, root: t.root, ...(gbase ? { ingroup: place.group } : {}), ...state }, ref));
    for (const r of repos) plan.push(await repoEntry(r));
  }
  for (const t of all.filter((x) => x.kind === 'other')) plan.push({ kind: 'other', label: t.label, url: t.entry.url, branch: t.entry.branch, dest: t.dir, root: t.root, ...(await stateOf(t, t.entry.url)) });
  return plan;
}

/** The projects restore did not get, by their names, with the command that gets one: { notHere: [ref] } (or nothing). */
function onDemandOf(plan) {
  // A project whose own folder is here but that lacks a code repository is not "not on this computer": it is counted by
  // the code repositories missing, and `hoprig get <project>` brings them.
  const here = new Set(plan.filter((e) => e.kind === 'project' && e.action !== 'notHere').map((e) => e.label));
  const away = plan.filter((e) => e.action === 'notHere');
  const refs = [...new Set(away.filter((e) => !(e.kind === 'repo' && here.has(e.project))).map((e) => e.project || e.label))];
  const code = {};
  for (const e of away) if (e.kind === 'repo' && here.has(e.project)) code[e.project] = (code[e.project] || 0) + 1;
  return { ...(refs.length ? { notHere: refs } : {}), ...(Object.keys(code).length ? { codeMissing: code } : {}) };
}

/** Clone the credentials repository into the workspace's credentials folder, owner-only. Its result goes into `e`. */
async function cloneCredentials(e, { ui, quiet, runner, env, at }) {
  // Here already: made owner-only again (a folder a killed clone left with another mode is repaired, never left).
  if (e.action === 'here') {
    if (isDir(e.dest) && !leaves(e.dest, e.dest, at)) mkdirIn({ ...at, root: e.dest }, e.dest, { mode: 0o700 });
    return (e.result = 'here');
  }
  if (e.action !== 'clone') return (e.result = e.action === 'link' ? `skipped: ${e.why}` : `left alone: ${e.why}`);
  if (e.aside) {
    // Kept next to it under a dated name, never deleted.
    const aside = `${e.dest}.unused-${stamp()}`;
    renameIn({ ...at, root: path.dirname(e.dest) }, e.dest, aside);
    ui.note(`the starting credentials folder was kept as ${tilde(aside)}`);
  }
  ui.out(`  git clone ${e.url} ${tilde(e.dest)}`);
  // Only its owner may open it, from the first file on: the empty folder is made owner-only first and git clones into
  // it (never a moment with the umask's mode). A failed clone leaves it empty and owner-only: the next restore clones
  // into it, and set-up's starting folder is not made in its place.
  const own = { ...at, root: e.dest };
  mkdirIn(own, e.dest, { mode: 0o700 });
  const lines = [];
  const c = await cloneRepo({ url: e.url, name: 'credentials' }, path.dirname(e.dest), { quiet, run: runner, env, onLine: (l) => lines.push(l), root: e.dest, at, mode: 0o700 });
  // A cut-off clone moved aside holds the server's objects, so the keys: said, for the owner to look at and remove.
  if (c.aside) ui.line('warn', `credentials: a clone that was cut off was moved aside as ${tilde(c.aside)} (it holds the keys too): look at it, then remove it yourself`);
  if (isDir(e.dest)) mkdirIn(own, e.dest, { mode: 0o700 });
  if (!c.ok) {
    e.result = `failed: ${gitReason(lines) || 'git failed'}`;
    ui.line('fail', `credentials: ${e.result}`);
    return e.result;
  }
  (await import('./credrepo.mjs')).ownerOnlyTree(e.dest);
  ui.line('ok', 'credentials: cloned');
  return (e.result = c.skipped ? 'left alone: something came into its folder before the clone' : 'cloned');
}

/**
 * Restore. `ui` is a setup ui (out, line, note, confirm, interactive). → { ok, dryRun, brain, plan: [{ kind, label,
 * url, dest, action, why?, result? }], folders: [what the tree step made], notes }. `result` (after a real run):
 * cloned | here | failed: <git's reason> | skipped: <why> | left alone: <why>.
 */
export async function restoreWorkspace(spec, { ui, dryRun = false, dir = workspaceDir(), projects: given = null, runner = stream, run = capture, withProjects = false, platform = process.platform } = {}) {
  const repo = parseRepo(spec);
  if (!repo) throw fail(400, `"${String(spec).slice(0, 80)}" is not a git address of a brain (https or SSH, or owner/name on GitHub)`);
  const brainDir = path.join(dir, 'ai_brain');
  let brainHere = await placeState(brainDir, repo.url, run);
  let setAside = null;
  if (brainHere.action === 'different' && (await untouchedScaffold(brainDir, run))) {
    // Only the starting brain `workspace setup` made, never changed: it is kept next to it, not deleted.
    setAside = `${brainDir}.unused-${stamp()}`;
    if (!dryRun) renameIn({ root: dir, dir }, brainDir, setAside);
    brainHere = { action: 'clone' };
  }
  if (brainHere.action === 'different') {
    throw fail(409, `${tilde(brainDir)} is there already and is not the brain at ${repo.url}: nothing was changed. Move it aside first (${showFileCommand('mv', [brainDir, `${brainDir}.old`], platform)}) and run restore again.`);
  }
  // Without a terminal git may not ask for a password, and ssh may not ask about a host key: it fails and says why.
  const quiet = !ui.interactive;
  const env = quiet && !process.env.GIT_SSH_COMMAND ? { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15' } : {};
  const said = (l) => ui.note(l);

  // The map: from the brain that is here, from a fresh clone, or (dry run) from a clone in a temporary folder.
  let mapDir = dir;
  let tmp = null;
  if (brainHere.action === 'clone') {
    if (setAside) ui.note(`the unused starting brain ${dryRun ? 'would be' : 'was'} kept as ${tilde(setAside)}`);
    const into = dryRun ? (tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-restore-'))) : path.dirname(brainDir);
    if (!dryRun) rmdirIn({ root: dir, dir }, brainDir); // an empty folder: git clones into a new one (a link stays)
    ui.out(`  git clone ${repo.url} ${dryRun ? '(into a temporary folder, to read its map)' : tilde(brainDir)}`);
    const lines = [];
    const c = await cloneRepo(repo, into, { name: 'ai_brain', quiet, run: runner, env, onLine: (l) => lines.push(l), at: { dir }, scratch: dryRun });
    if (!c.ok) {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      throw fail(502, `the brain could not be cloned: ${gitReason(lines) || 'git failed'}`);
    }
    if (dryRun) mapDir = tmp;
  }
  try {
    const m = readMap(mapDir);
    if (m.errors) throw fail(422, `the brain's ${MAP_FILE} was refused: ${m.errors.join('; ')}`);
    if (!m.exists) throw fail(404, `the brain has no ${MAP_FILE}: on the computer that has your workspace run  hoprig workspace map, commit and push the brain, then restore again`);
    const notes = setAside ? [`the unused starting brain ${dryRun ? 'would be' : 'was'} kept as ${tilde(setAside)}`] : [];
    if (m.map.brain.url && !sameUrl(m.map.brain.url, repo.url)) notes.push(`the map names the brain as ${m.map.brain.url}; it was restored from ${repo.url}`);
    // The projects folder: one chosen on this computer before wins; else where the map says (relative to the
    // workspace); else <workspace>/projects.
    const projects = given || chosenProjectsDir() || (m.map.config && m.map.config.projectsDir ? path.join(dir, ...m.map.config.projectsDir.split('/')) : projectsIn({ workspaceDir: dir }));
    const plan = await planFrom(m.map, { dir, projects, brainUrl: repo.url, run, withProjects });
    plan[0] = { ...plan[0], action: brainHere.action, why: setAside ? `the unused starting brain is kept as ${tilde(setAside)} first` : plan[0].why };
    if (!plan[0].why) delete plan[0].why;
    // The brain comes from git, never from the scaffold: only the other folders of the tree are listed.
    const folders = (await workspaceSetup({ dryRun: true, cfg: { workspaceDir: dir, projectsDir: projects } })).did.filter((d) => !/ai_brain$/.test(d.path));
    // A group's own command: restore only says it waits for the owner's yes on this computer, or why one that has a
    // yes would not start (grouptool.mjs); it never makes one. A dry run's groups are not here yet: they would wait.
    const toolNote = async () => waitingLine((await toolsState({ dir, projects, map: m.map })).map((t) => (t.state === 'absent' ? { ...t, state: 'waits' } : t)));
    if (dryRun) {
      const waiting = await toolNote();
      if (waiting) notes.push(waiting);
      return { ok: true, dryRun, brain: repo.url, projectsDir: projects, plan: shown(plan), folders, notes, ...onDemandOf(plan) };
    }

    // ---- the real run ----
    // The credentials repository first: the tree's own credentials folder (made just below) would be in its way.
    const at0 = { dir, projects };
    for (const e of plan.filter((x) => x.kind === 'credentials')) await cloneCredentials(e, { ui, quiet, runner, env, at: at0 });
    const made = await workspaceSetup({ cfg: { workspaceDir: dir, projectsDir: projects } });
    plan[0].result = brainHere.action === 'clone' ? 'cloned' : 'here';
    // Nothing is cloned where it would lead out of its folder (a group's `builds -> /elsewhere`, a parent's
    // `code -> ..`): asked again right before each clone (inside.mjs), and by the clone itself.
    const at = { dir, projects };
    const throughLink = async (e) => {
      const t = e.root ? leaves(e.root, e.dest, at) : null;
      if (!t) return false;
      e.result = `skipped: ${leavesWords(t)}`;
      if (e.action !== 'link') ui.line('warn', `${e.label}: ${e.result}`); // a link the plan showed is not said twice
      return true;
    };
    const cloneOne = async (e) => {
      if (e.result) return e.result; // done before (the credentials repository)
      if (e.action === 'here') return (e.result = 'here');
      if (e.action === 'notHere') return (e.result = e.why);
      if (await throughLink(e)) return e.result;
      if (e.action !== 'clone') return (e.result = e.action === 'no-address' ? `skipped: ${e.why}` : `left alone: ${e.why}`);
      ui.out(`  git clone ${e.url} ${tilde(e.dest)}`);
      const lines = [];
      const c = await cloneRepo({ url: e.url, name: path.basename(e.dest) }, path.dirname(e.dest), { quiet, run: runner, env, onLine: (l) => lines.push(l), root: e.root || e.dest, at });
      if (c.aside) ui.line('warn', `${e.label}: a clone that was cut off was moved aside as ${tilde(c.aside)}: look at it, then remove it yourself`);
      if (!c.ok) {
        e.result = `failed: ${gitReason(lines) || 'git failed'}`;
        ui.line('fail', `${e.label}: ${e.result}`);
        return e.result;
      }
      if (c.skipped) return (e.result = 'left alone: something came into its folder before the clone');
      if (e.branch) await gitIn({ ...at, root: e.root || e.dest }, e.dest, ['checkout', '-q', '--no-overwrite-ignore', e.branch], run);
      ui.line('ok', `${e.label}: cloned`);
      return (e.result = 'cloned');
    };
    // A plain group is a folder: made when it is missing. A file in its way is left alone and its projects wait.
    const notFolder = new Set();
    for (const g of (m.map.groups || []).filter((x) => !x.url)) {
      try {
        const gdir = path.join(dir, ...g.dir.split('/'));
        mkdirIn({ root: gdir, dir, projects }, gdir);
      } catch (err) {
        notFolder.add(g.dir);
        said(`${g.dir}: ${err.code === 'ELEAVES' ? `${leavesWords(err.leaves)}: its projects were not cloned` : `a ${err.code === 'EEXIST' || err.code === 'ENOTDIR' ? 'file' : 'thing'} is where the group's folder goes: left alone, its projects were not cloned`}`);
      }
    }
    for (const e of plan.slice(1)) {
      if (e.action === 'notHere') {
        e.result = e.why;
        continue;
      }
      if (e.ingroup && notFolder.has(e.ingroup)) {
        e.result = `skipped: the group's folder ${e.ingroup} is not a folder here`;
        continue;
      }
      // Never into a group whose own repository is not here (a failed clone, something else in its folder): a
      // member cloned there would keep the group from ever being cloned in its place.
      const grp = e.ingroup && plan.find((x) => x.kind === 'group' && x.label === e.ingroup);
      if (grp && !isGitRepo(grp.dest)) {
        e.result = `skipped: its group's repository is not here (${grp.label}: ${grp.result || grp.action})`;
        continue;
      }
      if (e.kind === 'repo' && e.group) {
        const g = plan.find((x) => x.kind === 'group' && x.label === e.group);
        if (g && !isGitRepo(g.dest)) {
          e.result = 'skipped: its group was not cloned';
          continue;
        }
        if (await throughLink(e)) continue;
      }
      if (e.kind === 'repo' && !e.group) {
        const parent = plan.find((x) => x.kind === 'project' && x.label === e.project);
        if (parent && !isDir(parent.dest)) {
          e.result = 'skipped: its project was not cloned';
          continue;
        }
        if (parent && parent.why === WORKTREE_WHY) {
          e.result = 'skipped: its project\'s folder here is a linked worktree';
          continue;
        }
      }
      await cloneOne(e);
    }
    // A project's own project.json may name code repositories the map does not have yet: clone those too, except
    // one taken out with `workspace forget` (the map's skip list has it as <project>/<dir>).
    const forgotten = new Set(m.map.skip || []);
    const ctx = { dir, projects };
    // What restore set up like a fresh clone: all of a project it cloned, else only the code repositories it cloned.
    const freshOf = (ref, cloned) => (cloned ? true : new Set(plan.filter((x) => x.kind === 'repo' && x.project === ref && x.result === 'cloned').map((x) => x.dest)));
    // A project whose folder leads out (inside.mjs) was said once already: nothing of it is set up.
    for (const p of plan.filter((x) => x.kind === 'project' && x.action !== 'link' && isGitRepo(x.dest) && x.why !== WORKTREE_WHY)) {
      const { manifest, source } = await readManifest(p.dest, run);
      if (!manifest) continue;
      // Memory links: the project's own project.json says; without one, the map does (never a guess when it knows).
      const fromMap = (m.map.projects.find((x) => refOf(x) === p.label) || {}).memories;
      if (source !== MANIFEST && fromMap) manifest.memories = fromMap;
      for (const r of manifest.repos) {
        if (forgotten.has(`${p.label}/${r.dir}`) || plan.some((x) => x.kind === 'repo' && x.dest === path.join(p.dest, r.dir))) continue;
        const e = { kind: 'repo', project: p.label, root: p.root || p.dest, label: `${p.label}/${r.dir}`, url: r.url, branch: r.branch, dest: path.join(p.dest, r.dir), ...(await placeState(path.join(p.dest, r.dir), r.url, run)) };
        plan.push(e);
        await cloneOne(e);
      }
      // A project that was here already is not changed (finish.mjs says what it misses); what this run cloned is set up.
      // In a group its memory is its own, else the group's (groups.mjs).
      const memories = p.ingroup ? await planGroupMemories(m.map, ctx, { run, only: p.label }) : null;
      // A parent without project.json in a place with a naming rule is another tool's: only its folders and memory.
      const rule = source !== MANIFEST ? ruleOf(m.map, placeOf(m.map.projects.find((x) => refOf(x) === p.label) || {})) : null;
      if (rule) {
        if (p.result === 'cloned') makeFolders(p.dest, rule, { ui, at: ctx });
        await finishProject(p.dest, manifest, { ui, dir: projects, runner, fresh: freshOf(p.label, p.result === 'cloned'), ref: p.label, memories, kinds: ['memory'], command: `hoprig project link ${p.label}`, at: ctx });
        continue;
      }
      await finishProject(p.dest, manifest, { ui, dir: projects, runner, fresh: freshOf(p.label, p.result === 'cloned'), ref: p.label, memories, at: ctx });
    }
    // A member that comes with its group's repository has no clone of its own: it is fresh when its group was cloned
    // now, else only its code repositories this run cloned are set up.
    const targets = await mapTargets(m.map, ctx, run);
    for (const pl of placesOf(m.map, ctx).filter((x) => x.members === 'group')) {
      const gp = plan.find((x) => x.kind === 'group' && x.label === pl.group);
      for (const e of m.map.projects.filter((x) => x.in === pl.id)) {
        const ref = refOf(e);
        const t = targets.find((x) => x.kind === 'project' && x.label === ref);
        const root = t.dir;
        if (t.blocked || !isDir(root) || leaves(root, root, at)) continue;
        const { manifest, source } = await readManifest(root, run);
        if (!manifest) continue;
        if (source !== MANIFEST && e.repos.length) manifest.repos = e.repos; // without a project.json the map knows them
        await finishProject(root, manifest, { ui, dir: projects, runner, fresh: freshOf(ref, Boolean(gp && gp.result === 'cloned')), ref, memories: await planGroupMemories(m.map, ctx, { run, only: ref }), at: ctx });
      }
    }
    // A group's own memory (a group that is a repository): linked when restore cloned the group, else said or asked.
    for (const g of (m.map.groups || []).filter((x) => x.url)) {
      const gp = plan.find((x) => x.kind === 'group' && x.label === g.dir);
      const gdir = path.join(dir, ...g.dir.split('/'));
      if (!gp || !isGitRepo(gdir)) continue;
      const own = (await planGroupMemories(m.map, ctx, { run, only: g.dir })).filter((x) => x.group === g.dir && !x.project);
      if (own.length) await finishProject(gdir, { repos: [], memories: {} }, { ui, dir: projects, runner, fresh: gp.result === 'cloned' ? true : new Set(), ref: g.dir, memories: own, kinds: ['memory'], command: `hoprig project link ${g.dir}`, at: ctx });
    }
    rememberDir(projects);
    const waiting = await toolNote(); // after the clones: the truth about each tool now
    if (waiting) notes.push(waiting);
    // This computer's own file in the brain, when it has a label (restore never asks for one: set-up does).
    const own = await writeOwnFile({ dir, projects });
    if (own.why && own.file) notes.push(own.why);
    const ok = plan.every((e) => !String(e.result).startsWith('failed'));
    for (const e of plan) if (e.why && ['different', 'misnamed'].includes(e.action)) said(`${e.label}: ${e.why}: left alone`);
    return { ok, dryRun, brain: repo.url, projectsDir: projects, plan: shown(plan), folders: made.did, notes, ...onDemandOf(plan) };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
