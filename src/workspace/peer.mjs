// `hoprig workspace sync --with <computer>`: get the workspace's commits straight from another of your computers
// over SSH, for a repository without a git server or a server this computer cannot reach.
//
// PULL ONLY, on purpose. Pushing into the other computer's repository would change a branch that may be checked
// out there (git refuses that by default, and forcing it would leave that working tree out of step with its
// branch). So this side only reads: `git fetch` over SSH runs git-upload-pack on the other computer, which never
// writes there. What was fetched lands under refs/hoprig-peer/<computer>/<branch> here (not a branch, not a remote:
// nothing else in git sees it), and the checked-out branch here is only fast-forwarded, when it is clean and only
// behind. The other computer gets this computer's commits the same way: by running `sync --with` itself.
//
// Only computers added by SSH (the machines list) are used, with the address stored there. Where the workspace and
// the projects folder are over there is asked from its own Hoprig (`hoprig workspace status --json`).
import path from 'node:path';
import { getMachine } from '../machines/store.mjs';
import { SSH_OPTS, runHoprig, shq } from '../machines/ssh.mjs';
import { sshExtraOf } from '../machines/keys.mjs';
import { gitRead } from '../gitread.mjs';
import { inTheWay, inTheWayWords } from '../pcsetup/intheway.mjs';
import { FAST_FORWARD, changedToo, keptBack, keptWords, lsRemote, repoInfo } from '../pcsetup/workspace.mjs';
import { capture, showCommand, showCommands } from '../setup/system.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { gitIn, leaves } from './inside.mjs';
import { notFollowed, syncTargets } from './sync.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const SAFE_PATH = /^\/[A-Za-z0-9._/+@-]{0,1000}$/; // no spaces or quotes: it becomes part of an ssh:// address
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;

/** The other computer's workspace: { name, target, dir, projectsDir }. */
export async function peerInfo(name, { remote = (target, sshExtra) => runHoprig(target, ['workspace', 'status', '--json'], { timeoutMs: 30_000, sshExtra }) } = {}) {
  const m = typeof name === 'string' ? getMachine(name) : null;
  if (!m) throw fail(404, `there is no computer "${String(name).slice(0, 40)}" in the list (hoprig machines)`);
  if (m.via !== 'ssh') throw fail(400, `${name} is not linked by SSH: only a computer added by SSH can be synced with directly`);
  // A computer added with a key file: its kept key and kept host key only, as every other ssh to it (keys.mjs).
  const sshExtra = sshExtraOf(m);
  const r = await remote(m.target, sshExtra);
  if (!r.ok) throw fail(502, r.message || `${name} did not answer`);
  let st;
  try {
    st = JSON.parse(r.result.stdout.slice(r.result.stdout.indexOf('{')));
  } catch {
    throw fail(502, `${name} did not say where its workspace is (is its Hoprig new enough? hoprig update there)`);
  }
  if (typeof st.dir !== 'string' || !SAFE_PATH.test(st.dir) || typeof st.projectsDir !== 'string' || !SAFE_PATH.test(st.projectsDir)) {
    throw fail(502, `${name} named a workspace folder this computer does not use (only plain absolute paths)`);
  }
  // sshExtra only for a computer with a kept key: one ssh knows by name gets the answer it always got.
  return { name: m.name, target: m.target, dir: st.dir, projectsDir: st.projectsDir, ...(sshExtra.length ? { sshExtra } : {}) };
}

/** git's ssh command for that computer: its own options (a kept key and host key), each word quoted for git's shell. */
export const gitSshCommand = (sshExtra = []) => ['ssh', ...SSH_OPTS.slice(0, 4), ...sshExtra].map((w) => (/^[A-Za-z0-9._=:/@-]+$/.test(w) ? w : shq(w))).join(' ');

/** ssh://… address of a folder on the other computer. */
export function peerUrl(target, abs) {
  if (!SAFE_PATH.test(abs)) throw fail(400, 'not a plain absolute path');
  return target.startsWith('ssh://') ? `${target}${abs}` : `ssh://${target}${abs}`;
}

/** Fetch the current branch from the other computer and fast-forward when that is safe. → { did, todo, notes } */
export async function pullFrom(dir, url, peer, run = capture, { dryRun = false, at = { root: dir }, sshExtra = [] } = {}) {
  const git = (d, args, r, opts) => gitIn(at, d, args, r, opts); // never in a repository that leads out (inside.mjs)
  const did = [];
  const todo = [];
  const notes = [];
  // A computer with a kept key always gets its own options: never the owner's own keys or ~/.ssh/known_hosts for it.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(process.env.GIT_SSH_COMMAND && !sshExtra.length ? {} : { GIT_SSH_COMMAND: gitSshCommand(sshExtra) }) };
  const s = await repoInfo(dir, run);
  if (!s.ok) return { did, todo: [{ why: s.error, command: '' }], notes };
  if (!BRANCH_RE.test(s.branch) || s.branch === '(detached)') return { did, todo: [{ why: 'no branch is checked out here', command: `${showCommand(['git', '-C', dir, 'switch'])} <branch>` }], notes };
  let ref = `refs/hoprig-peer/${peer}/${s.branch}`;
  if (dryRun) {
    // A dry run fetches nothing (that writes a ref and objects here): the branch's commit over there is looked up.
    const there = await lsRemote(url, `refs/heads/${s.branch}`, { run, env: { GIT_SSH_COMMAND: env.GIT_SSH_COMMAND } });
    if (there.error) return { did, todo: [{ why: `could not ask ${peer}: ${there.error}`, command: '' }], notes };
    if (!there.sha) return { did, todo: [{ why: `${peer} has no branch ${s.branch} there`, command: '' }], notes };
    if (!(await gitRead(dir, ['rev-list', '--count', `HEAD...${there.sha}`], { run })).ok) {
      did.push(`would get ${s.branch}'s new commits from ${peer} (a dry run does not fetch, so they are not counted), and fast-forward if ${s.branch} is only behind`);
      return { did, todo, notes };
    }
    ref = there.sha;
  } else {
    const f = await git(dir, ['fetch', '--quiet', '--no-tags', '--', url, `+refs/heads/${s.branch}:${ref}`], run, { env, timeout: 120_000 });
    if (!f.ok) {
      const why = (f.stderr || '').trim().split('\n').pop() || 'git failed';
      return { did, todo: [{ why: /couldn't find remote ref/i.test(why) ? `${peer} has no branch ${s.branch} there` : `could not fetch from ${peer}: ${why}`, command: '' }], notes };
    }
  }
  const c = await gitRead(dir, ['rev-list', '--left-right', '--count', `HEAD...${ref}`], { run });
  const [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
  if (ahead && behind) {
    // As in syncRepo: a merge or a rebase replaces what git ignores here without a word (inTheWay).
    const hit = await inTheWay(dir, ref, run);
    const both = `${s.branch} here and on ${peer} have both moved (${ahead} here, ${behind} there)`;
    todo.push({ why: `${both}${inTheWayWords(hit, 'those commits')}`, command: `${showCommand(['git', '-C', dir, 'merge', ref])}   (or: ${showCommand(['git', '-C', dir, 'rebase', ref])})` });
  }
  else if (behind && dryRun) did.push(`would get ${behind} from ${peer}${s.changes ? `, unless they touch your ${s.changes} uncommitted change${s.changes > 1 ? 's' : ''}` : ''}`);
  else if (behind) {
    // As in syncRepo: uncommitted work stays; git refuses, changing nothing, only when the same files are touched.
    // Never over what git ignores here (a member or a code repository of its own): FAST_FORWARD.
    const m = await git(dir, FAST_FORWARD(ref), run);
    const kept = keptBack(m);
    if (m.ok) did.push(`got ${behind} from ${peer}${s.changes ? ` (your ${s.changes} uncommitted change${s.changes > 1 ? 's' : ''} stay${s.changes > 1 ? '' : 's'})` : ''}`);
    else if (kept) todo.push({ why: `${behind} to get from ${peer}, but those commits ${keptWords(kept, changedToo(m), s.changes)}`, command: showCommand(['git', '-C', dir, ...FAST_FORWARD(ref)]) });
    else if (s.changes) todo.push({ why: `${behind} to get from ${peer}, but there are ${s.changes} uncommitted changes in the same files here`, command: showCommands([['git', '-C', dir, 'stash'], ['git', '-C', dir, ...FAST_FORWARD(ref)], ['git', '-C', dir, 'stash', 'pop']]) });
    else todo.push({ why: 'fast-forward failed', command: showCommand(['git', '-C', dir, ...FAST_FORWARD(ref)]) });
  }
  if (ahead && !behind) notes.push(`${ahead} commit${ahead > 1 ? 's' : ''} here that ${peer} does not have: it gets them by running  hoprig workspace sync --with <this computer>  there`);
  return { did, todo, notes };
}

/** Pull every repository of the map from the other computer. → { peer, repos: [{ label, did, todo, notes }] } */
export async function syncWith(name, { dir = workspaceDir(), projects = projectsIn(), run = capture, info, dryRun = false, onLine = () => {} } = {}) {
  const p = info || (await peerInfo(name));
  const all = (await syncTargets({ dir, projects, run })).targets;
  const tools = all.filter((t) => t.tool).map((t) => t.label);
  const targets = all.filter((t) => !t.tool); // tools are never synced, not from another computer either
  if (tools.length) onLine(`· tools, left alone: ${tools.join(', ')}`);
  // The same folder there: under its projects folder for a project of the projects folder, else under its workspace
  // (the brain, a group and its members, the others).
  const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');
  const there = (t) => {
    const inProjects = rel(projects, t.dir);
    if (t.kind !== 'brain' && !inProjects.startsWith('..') && !path.isAbsolute(inProjects)) return path.posix.join(p.projectsDir, inProjects);
    return path.posix.join(p.dir, rel(dir, t.dir));
  };
  const repos = [];
  for (const t of targets) {
    let r;
    const b = t.blocked || leaves(t.root, t.dir, { dir, projects }); // asked again right before the fetch (and by gitIn)
    if (b) r = { ...notFollowed(t, b), notes: [] };
    else if (!isGitRepo(t.dir)) r = { did: [], todo: [{ why: 'not on this computer', command: 'hoprig workspace restore <brain address>' }], notes: [] };
    else r = await pullFrom(t.dir, peerUrl(p.target, there(t)), p.name, run, { dryRun, at: { root: t.root, dir, projects }, sshExtra: p.sshExtra || [] });
    const e = { label: t.label, ...r };
    repos.push(e);
    onLine(`${e.todo.length ? '!' : '✓'} ${e.label}  ${e.did.join(', ') || (e.todo.length ? '' : 'in step')}${e.todo.map((x) => `\n    ${x.why}${x.command ? `  →  ${x.command}` : ''}`).join('')}${e.notes.map((n) => `\n    ${n}`).join('')}`);
  }
  return { peer: p.name, repos, tools };
}
