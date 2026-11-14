// Where a skill comes from and how its files are fetched: plain `git` (no npm package, no archive to unpack), one
// commit, only the tree of that commit and the blobs of the skill's own folder. Nothing fetched is ever run: no
// hooks, no submodules, no LFS filters, no checkout scripts (git has none). The only things that leave the machine
// are the git requests to the source's host.
import fs from 'node:fs';
import path from 'node:path';
import { capture } from '../setup/system.mjs';
import { safeRel } from './scan.mjs';

const HEX40 = /^[0-9a-f]{40}$/;
const GH_PART = /^[A-Za-z0-9_.-]+$/;

const GIT_ENV = () => ({
  ...process.env,
  GIT_TERMINAL_PROMPT: '0', // never wait for a password on a private or missing repository
  GIT_LFS_SKIP_SMUDGE: '1',
  GIT_CONFIG_NOSYSTEM: '1',
  GCM_INTERACTIVE: 'never',
});
// Settings for every git call on fetched content: no hooks, no fsmonitor program, no submodules.
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'protocol.ext.allow=never', '-c', 'core.symlinks=true', '-c', 'advice.detachedHead=false'];

export class SourceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Run git; throws SourceError with git's own words when it fails. */
export async function git(args, { cwd, timeout = 180_000 } = {}) {
  const r = await capture(['git', ...SAFE, ...args], { cwd, env: GIT_ENV(), timeout });
  if (r.error === 'ENOENT') throw new SourceError('git is not installed; it is needed to fetch skills', 500);
  if (!r.ok) throw new SourceError(`git ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ') || `exit ${r.code}`}`, 502);
  return r.stdout;
}

/**
 * Parse what the user typed into a source: { url, repo (owner/repo for GitHub, else null), path, ref, skill, commit }.
 *   owner/repo   owner/repo/path/to/skill   owner/repo@skill-name   https://github.com/o/r[/tree/<ref>/<path>]
 *   any git URL (https, ssh, git@, file://) with an optional #path
 * A catalog id is resolved by the caller before this.
 */
export function parseSpec(spec) {
  const s = String(spec || '').trim();
  if (!s || s.length > 500 || /[\s\0]/.test(s)) throw new SourceError('name a skill: a catalog id, owner/repo[/path], owner/repo@skill or a git URL');
  let m = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?(?:#(.+))?$/.exec(s);
  if (m && GH_PART.test(m[1]) && GH_PART.test(m[2])) {
    const p = (m[4] || m[5] || '').replace(/\/+$/, '');
    return checked({ url: `https://github.com/${m[1]}/${m[2]}.git`, repo: `${m[1]}/${m[2]}`, path: p, ref: m[3] || null, skill: null });
  }
  if (/^(https?|ssh|git|file):\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s)) {
    const [url, frag = ''] = s.split('#');
    return checked({ url, repo: null, path: frag.replace(/\/+$/, ''), ref: null, skill: null });
  }
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.:-]+)$/.exec(s);
  if (m) return checked({ url: `https://github.com/${m[1]}/${m[2]}.git`, repo: `${m[1]}/${m[2]}`, path: '', ref: null, skill: m[3] });
  m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+?))?\/?$/.exec(s);
  if (m) return checked({ url: `https://github.com/${m[1]}/${m[2]}.git`, repo: `${m[1]}/${m[2]}`, path: m[3] || '', ref: null, skill: null });
  throw new SourceError(`"${s}" is not a catalog id, owner/repo, owner/repo@skill or a git URL`);
}

function checked(src) {
  if (src.path && !safeRel(src.path)) throw new SourceError('the path inside the repository must be relative, without ".."');
  if (src.ref && !/^[A-Za-z0-9._/-]{1,200}$/.test(src.ref)) throw new SourceError('bad branch or tag name');
  return src;
}

/** The commit a ref (default: the repository's default branch) points to now, read with ls-remote. */
export async function latestCommit(url, ref = null) {
  const out = await git(['ls-remote', '--', url, ref ? ref : 'HEAD'], { timeout: 60_000 });
  const lines = out.trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const want = ref ? [ref, `refs/heads/${ref}`, `refs/tags/${ref}^{}`, `refs/tags/${ref}`] : ['HEAD'];
  for (const w of want) {
    const hit = lines.find((l) => l[1] === w);
    if (hit && HEX40.test(hit[0])) return hit[0];
  }
  if (lines[0] && HEX40.test(lines[0][0])) return lines[0][0];
  throw new SourceError(`${url} has no ${ref || 'default branch'}`, 404);
}

/**
 * A shallow, blob-less copy of one commit in `dir` (created): the tree is there, file contents come only for the
 * paths checked out later. Returns the commit.
 */
export async function fetchCommit(dir, url, commitOrRef) {
  fs.mkdirSync(dir, { recursive: true });
  await git(['init', '-q', dir]);
  await git(['remote', 'add', 'origin', url], { cwd: dir });
  await git(['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', 'origin', commitOrRef], { cwd: dir });
  const commit = (await git(['rev-parse', 'FETCH_HEAD^{commit}'], { cwd: dir })).trim();
  if (HEX40.test(commitOrRef) && commit !== commitOrRef) throw new SourceError(`asked for ${commitOrRef}, got ${commit}`, 502);
  return commit;
}

/** Every SKILL.md in that commit (paths of their folders; '' for the top). */
export async function skillFolders(dir, commit) {
  const out = await git(['ls-tree', '-r', '--name-only', '-z', commit], { cwd: dir });
  return out.split('\0').filter((p) => /(^|\/)SKILL\.md$/.test(p) && !/(^|\/)node_modules\//.test(p)).map((p) => p.replace(/\/?SKILL\.md$/, '')).sort((a, b) => a.split('/').length - b.split('/').length || (a < b ? -1 : 1));
}

/** One file's text at a commit, or null. Fetches that one blob on demand. */
export async function showFile(dir, commit, rel) {
  try {
    return await git(['show', `${commit}:${rel}`], { cwd: dir, timeout: 60_000 });
  } catch {
    return null;
  }
}

/** The git tree id of a folder at a commit: it changes exactly when anything inside the folder changes. */
export async function treeOf(dir, commit, rel) {
  return (await git(['rev-parse', rel ? `${commit}:${rel}` : `${commit}^{tree}`], { cwd: dir })).trim();
}

/** Check out only `rel` (the skill folder) of the fetched commit. Returns the folder's absolute path. */
export async function checkoutFolder(dir, commit, rel) {
  if (rel) {
    await git(['sparse-checkout', 'set', '--no-cone', `/${rel}/`], { cwd: dir });
  }
  await git(['checkout', '-q', '--detach', commit], { cwd: dir });
  const full = path.join(dir, rel);
  if (!fs.existsSync(path.join(full, 'SKILL.md'))) throw new SourceError(`${rel || 'the top folder'} has no SKILL.md at that commit`, 404);
  return full;
}

/**
 * Pick the skill folder in a repository: the given path, the folder of `@skill` (by folder name, then by the
 * `name:` in its SKILL.md), or the only skill in it. Lists the choices when it cannot decide.
 */
export async function chooseFolder(dir, commit, src, readName) {
  const all = await skillFolders(dir, commit);
  if (src.path) {
    if (!all.includes(src.path)) throw new SourceError(`${src.path} has no SKILL.md in ${src.repo || src.url}`, 404);
    return src.path;
  }
  if (src.skill) {
    const byFolder = all.filter((p) => path.posix.basename(p) === src.skill);
    if (byFolder.length) return byFolder[0];
    for (const p of all.slice(0, 200)) if ((await readName(p)) === src.skill) return p;
    throw new SourceError(`no skill named "${src.skill}" in ${src.repo || src.url}`, 404);
  }
  if (all.length === 1) return all[0];
  if (!all.length) throw new SourceError(`${src.repo || src.url} has no SKILL.md (is it a tool rather than a skill?)`, 404);
  const head = all.slice(0, 30).map((p) => `  ${src.repo || src.url}/${p}`).join('\n');
  throw new SourceError(`${src.repo || src.url} has ${all.length} skills; name one:\n${head}${all.length > 30 ? '\n  …' : ''}`, 409);
}
