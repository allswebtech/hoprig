// `hoprig workspace restore <brain address>`: a fresh computer gets the whole workspace from git. The AI brain is
// cloned into <workspace>/ai_brain, its map (map.mjs) says what else belongs to the workspace, and every project
// parent, its code repositories and the other repositories are cloned where the map puts them. Then the missing
// folders of the tree are made and each project is finished like `project clone` does (memory links, git hooks,
// .env.example, the dependency installs offered).
//
// Safe to run again: what is there is never overwritten or moved (one exception: the starting brain that
// `workspace setup` made and nobody changed is kept aside as ai_brain.unused-<time>, so restore can follow setup). A folder that is there is left alone: when it is
// the same repository it counts as done, when it is something else it is reported. A repository that cannot be
// cloned (no access, wrong address) is listed with git's reason and the rest goes on.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tilde } from '../paths.mjs';
import { finishProject } from '../pcsetup/project.mjs';
import { cloneRepo, parseRepo, rememberDir } from '../pcsetup/projects.mjs';
import { MANIFEST, git, readManifest, stamp } from '../pcsetup/workspace.mjs';
import { capture, stream } from '../setup/system.mjs';
import { loadConfig } from '../config.mjs';
import { isDir, isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { MAP_FILE, readMap, sameUrl } from './map.mjs';
import { brainScaffold, workspaceSetup } from './setup.mjs';

/** The projects folder this computer chose before (config "projectsDir"), or null. */
function chosenProjectsDir() {
  try {
    const c = loadConfig();
    return typeof c.projectsDir === 'string' && path.isAbsolute(c.projectsDir) ? c.projectsDir : null;
  } catch {
    return null;
  }
}

const sameNote = (label, same) => `${label}: not cloned, it is the same repository as ${same}`;
const fail = (status, message) => Object.assign(new Error(message), { status });
const lastLine = (text) => String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
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
  if (!isGitRepo(dest)) return { action: 'different', why: 'a folder that is not this repository is there: left alone' };
  const r = await run(['git', '-C', dest, 'config', '--get', 'remote.origin.url'], { timeout: 10_000 });
  const have = r.ok ? r.stdout.trim() : '';
  if (!url || sameUrl(have, url)) return { action: 'here' };
  return { action: 'different', why: `another repository is there (${have ? 'its address differs' : 'it has no remote'}): left alone` };
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
    run(['git', '-C', dir, 'log', '--format=%s']), run(['git', '-C', dir, 'remote']), run(['git', '-C', dir, 'status', '--porcelain']),
  ]);
  return log.ok && log.stdout.trim() === 'Start the AI brain' && remote.ok && !remote.stdout.trim() && st.ok && !st.stdout.trim();
}

/**
 * A code repository the plan already gets for that project under another name: a project lists a repository once
 * (map.mjs twinsIn), so a second plain entry with its address (a worktree an older map or project.json named, or one
 * repository under two names) is not cloned again. An entry that names its own branch is a checkout someone asked
 * for and is always cloned. → the label of the one in the plan, or null.
 */
const clonedAs = (plan, e) => (e.url && !e.branch ? (plan.find((x) => x.kind === 'repo' && x.project === e.project && x.label !== e.label && !x.branch && x.url && sameUrl(x.url, e.url) && ['clone', 'here'].includes(x.action)) || {}).label || null : null);

/** Every place the map names, in order: the brain, each project then its code repositories, the others. */
async function planFrom(map, { dir, projects, brainUrl, run, notes }) {
  const plan = [{ kind: 'brain', label: 'ai_brain', url: brainUrl, dest: path.join(dir, 'ai_brain'), ...(await placeState(path.join(dir, 'ai_brain'), brainUrl, run)) }];
  for (const p of map.projects) {
    const root = path.join(projects, p.name);
    plan.push({ kind: 'project', label: p.name, url: p.url, dest: root, ...(await placeState(root, p.url, run)) });
    for (const r of p.repos) {
      const e = { kind: 'repo', project: p.name, label: `${p.name}/${r.dir}`, url: r.url, branch: r.branch, dest: path.join(root, r.dir), ...(await placeState(path.join(root, r.dir), r.url, run)) };
      const same = e.action === 'clone' && clonedAs(plan, e);
      if (same) notes.push(sameNote(e.label, same));
      else plan.push(e);
    }
  }
  for (const o of map.others) plan.push({ kind: 'other', label: o.dir, url: o.url, branch: o.branch, dest: path.join(dir, o.dir), ...(await placeState(path.join(dir, o.dir), o.url, run)) });
  return plan;
}

/**
 * Restore. `ui` is a setup ui (out, line, note, confirm, interactive). → { ok, dryRun, brain, plan: [{ kind, label,
 * url, dest, action, why?, result? }], folders: [what the tree step made], notes }. `result` (after a real run):
 * cloned | here | failed: <git's reason> | skipped: <why> | left alone: <why>.
 */
export async function restoreWorkspace(spec, { ui, dryRun = false, dir = workspaceDir(), projects: given = null, runner = stream, run = capture } = {}) {
  const repo = parseRepo(spec);
  if (!repo) throw fail(400, `"${String(spec).slice(0, 80)}" is not a git address of a brain (https or SSH, or owner/name on GitHub)`);
  const brainDir = path.join(dir, 'ai_brain');
  let brainHere = await placeState(brainDir, repo.url, run);
  let setAside = null;
  if (brainHere.action === 'different' && (await untouchedScaffold(brainDir, run))) {
    // Only the starting brain `workspace setup` made, never changed: it is kept next to it, not deleted.
    setAside = `${brainDir}.unused-${stamp()}`;
    if (!dryRun) fs.renameSync(brainDir, setAside);
    brainHere = { action: 'clone' };
  }
  if (brainHere.action === 'different') {
    throw fail(409, `${tilde(brainDir)} is there already and is not the brain at ${repo.url}: nothing was changed. Move it aside first (mv "${brainDir}" "${brainDir}.old") and run restore again.`);
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
    if (!dryRun && isDir(brainDir)) fs.rmdirSync(brainDir); // an empty folder: git clones into a new one
    ui.out(`  git clone ${repo.url} ${dryRun ? '(into a temporary folder, to read its map)' : tilde(brainDir)}`);
    const lines = [];
    const c = await cloneRepo(repo, into, { name: 'ai_brain', quiet, run: runner, env, onLine: (l) => lines.push(l) });
    if (!c.ok) {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      throw fail(502, `the brain could not be cloned: ${lastLine(lines.join('\n')) || 'git failed'}`);
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
    const plan = await planFrom(m.map, { dir, projects, brainUrl: repo.url, run, notes });
    plan[0] = { ...plan[0], action: brainHere.action, why: setAside ? `the unused starting brain is kept as ${tilde(setAside)} first` : plan[0].why };
    if (!plan[0].why) delete plan[0].why;
    // The brain comes from git, never from the scaffold: only the other folders of the tree are listed.
    const folders = (await workspaceSetup({ dryRun: true, cfg: { workspaceDir: dir, projectsDir: projects } })).did.filter((d) => !/ai_brain$/.test(d.path));
    if (dryRun) return { ok: true, dryRun, brain: repo.url, projectsDir: projects, plan, folders, notes };

    // ---- the real run ----
    const made = await workspaceSetup({ cfg: { workspaceDir: dir, projectsDir: projects } });
    plan[0].result = brainHere.action === 'clone' ? 'cloned' : 'here';
    const cloneOne = async (e) => {
      if (e.action === 'here') return (e.result = 'here');
      if (e.action !== 'clone') return (e.result = e.action === 'no-address' ? `skipped: ${e.why}` : `left alone: ${e.why}`);
      ui.out(`  git clone ${e.url} ${tilde(e.dest)}`);
      const lines = [];
      const c = await cloneRepo({ url: e.url, name: path.basename(e.dest) }, path.dirname(e.dest), { quiet, run: runner, env, onLine: (l) => lines.push(l) });
      if (!c.ok) {
        e.result = `failed: ${lastLine(lines.join('\n')) || 'git failed'}`;
        ui.line('fail', `${e.label}: ${e.result}`);
        return e.result;
      }
      if (e.branch) await git(e.dest, ['checkout', '-q', e.branch], run);
      ui.line('ok', `${e.label}: cloned`);
      return (e.result = 'cloned');
    };
    for (const e of plan.slice(1)) {
      if (e.kind === 'repo') {
        const parent = plan.find((x) => x.kind === 'project' && x.label === e.project);
        if (parent && !isDir(parent.dest)) {
          e.result = 'skipped: its project was not cloned';
          continue;
        }
      }
      await cloneOne(e);
    }
    // A project's own project.json may name code repositories the map does not have yet: clone those too.
    for (const p of plan.filter((x) => x.kind === 'project' && isGitRepo(x.dest))) {
      const { manifest, source } = await readManifest(p.dest, run);
      if (!manifest) continue;
      // Memory links: the project's own project.json says; without one, the map does (never a guess when it knows).
      const fromMap = (m.map.projects.find((x) => x.name === p.label) || {}).memories;
      if (source !== MANIFEST && fromMap) manifest.memories = fromMap;
      for (const r of manifest.repos) {
        if (plan.some((x) => x.kind === 'repo' && x.dest === path.join(p.dest, r.dir))) continue;
        const e = { kind: 'repo', project: p.label, label: `${p.label}/${r.dir}`, url: r.url, branch: r.branch, dest: path.join(p.dest, r.dir), ...(await placeState(path.join(p.dest, r.dir), r.url, run)) };
        const same = e.action === 'clone' && clonedAs(plan, e);
        if (same) {
          notes.push(sameNote(e.label, same));
          ui.note(sameNote(e.label, same));
          continue;
        }
        plan.push(e);
        await cloneOne(e);
      }
      await finishProject(p.dest, manifest, { ui, dir: projects, runner });
    }
    rememberDir(projects);
    const ok = plan.every((e) => !String(e.result).startsWith('failed'));
    for (const e of plan) if (e.why && e.action === 'different') said(`${e.label}: ${e.why}`);
    return { ok, dryRun, brain: repo.url, projectsDir: projects, plan, folders: made.did, notes };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
