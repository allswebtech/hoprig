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
import { runHoprig } from '../machines/ssh.mjs';
import { git, repoInfo } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { isGitRepo, projectsIn, workspaceDir } from './layout.mjs';
import { syncTargets } from './sync.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const SAFE_PATH = /^\/[A-Za-z0-9._/+@-]{0,1000}$/; // no spaces or quotes: it becomes part of an ssh:// address
const BRANCH_RE = /^(?!-)[A-Za-z0-9._/-]{1,100}$/;

/** The other computer's workspace: { name, target, dir, projectsDir }. */
export async function peerInfo(name, { remote = (target) => runHoprig(target, ['workspace', 'status', '--json'], { timeoutMs: 30_000 }) } = {}) {
  const m = typeof name === 'string' ? getMachine(name) : null;
  if (!m) throw fail(404, `there is no computer "${String(name).slice(0, 40)}" in the list (hoprig machines)`);
  if (m.via !== 'ssh') throw fail(400, `${name} is not linked by SSH: only a computer added by SSH can be synced with directly`);
  const r = await remote(m.target);
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
  return { name: m.name, target: m.target, dir: st.dir, projectsDir: st.projectsDir };
}

/** ssh://… address of a folder on the other computer. */
export function peerUrl(target, abs) {
  if (!SAFE_PATH.test(abs)) throw fail(400, 'not a plain absolute path');
  return target.startsWith('ssh://') ? `${target}${abs}` : `ssh://${target}${abs}`;
}

/** Fetch the current branch from the other computer and fast-forward when that is safe. → { did, todo, notes } */
export async function pullFrom(dir, url, peer, run = capture, { dryRun = false } = {}) {
  const did = [];
  const todo = [];
  const notes = [];
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(process.env.GIT_SSH_COMMAND ? {} : { GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=10' }) };
  const s = await repoInfo(dir, run);
  if (!s.ok) return { did, todo: [{ why: s.error, command: '' }], notes };
  if (!BRANCH_RE.test(s.branch) || s.branch === '(detached)') return { did, todo: [{ why: 'no branch is checked out here', command: `git -C "${dir}" switch <branch>` }], notes };
  const ref = `refs/hoprig-peer/${peer}/${s.branch}`;
  const f = await git(dir, ['fetch', '--quiet', '--no-tags', '--', url, `+refs/heads/${s.branch}:${ref}`], run, { env, timeout: 120_000 });
  if (!f.ok) {
    const why = (f.stderr || '').trim().split('\n').pop() || 'git failed';
    return { did, todo: [{ why: /couldn't find remote ref/i.test(why) ? `${peer} has no branch ${s.branch} there` : `could not fetch from ${peer}: ${why}`, command: '' }], notes };
  }
  const c = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...${ref}`], run);
  const [ahead, behind] = c.stdout.trim().split(/\s+/).map(Number);
  if (ahead && behind) todo.push({ why: `${s.branch} here and on ${peer} have both moved (${ahead} here, ${behind} there)`, command: `git -C "${dir}" merge ${ref}   (or: git -C "${dir}" rebase ${ref})` });
  else if (behind && dryRun) did.push(`would get ${behind} from ${peer}${s.changes ? `, unless they touch your ${s.changes} uncommitted change${s.changes > 1 ? 's' : ''}` : ''}`);
  else if (behind) {
    // As in syncRepo: uncommitted work stays; git refuses, changing nothing, only when the same files are touched.
    const m = await git(dir, ['merge', '--ff-only', '--quiet', ref], run);
    if (m.ok) did.push(`got ${behind} from ${peer}${s.changes ? ` (your ${s.changes} uncommitted change${s.changes > 1 ? 's' : ''} stay${s.changes > 1 ? '' : 's'})` : ''}`);
    else if (s.changes) todo.push({ why: `${behind} to get from ${peer}, but there are ${s.changes} uncommitted changes in the same files here`, command: `git -C "${dir}" stash && git -C "${dir}" merge --ff-only ${ref} && git -C "${dir}" stash pop` });
    else todo.push({ why: 'fast-forward failed', command: `git -C "${dir}" merge --ff-only ${ref}` });
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
  const there = (t) => {
    if (t.kind === 'brain') return path.posix.join(p.dir, 'ai_brain');
    if (t.kind === 'other') return path.posix.join(p.dir, t.label);
    return path.posix.join(p.projectsDir, t.label);
  };
  const repos = [];
  for (const t of targets) {
    let r;
    if (!isGitRepo(t.dir)) r = { did: [], todo: [{ why: 'not on this computer', command: 'hoprig workspace restore <brain address>' }], notes: [] };
    else r = await pullFrom(t.dir, peerUrl(p.target, there(t)), p.name, run, { dryRun });
    const e = { label: t.label, ...r };
    repos.push(e);
    onLine(`${e.todo.length ? '!' : '✓'} ${e.label}  ${e.did.join(', ') || (e.todo.length ? '' : 'in step')}${e.todo.map((x) => `\n    ${x.why}${x.command ? `  →  ${x.command}` : ''}`).join('')}${e.notes.map((n) => `\n    ${n}`).join('')}`);
  }
  return { peer: p.name, repos, tools };
}
