// `hoprig workspace credentials`: the credentials folder as the owner's own private repository, when he chooses it
// (docs/WORKSPACE.md, "Credentials"). Off by default: the folder stays a local folder, owner-only, never in git.
//
//   workspace credentials                       its state: a local folder, or a repository with its address
//   workspace credentials --repo <address>      make it a repository and push it to that (private) repository
//   workspace credentials --github [<name>]     the same, to a new private repository <name> (default "credentials")
//                                               of the signed-in GitHub account
//
// The cost is said once, in plain words, and the owner confirms by TYPING the repository's name: no flag skips it,
// and without a terminal nothing is done. Hoprig never creates the repository public (gh repo create --private) and
// never pushes to one that is public: a GitHub address's visibility is asked through gh, and public, or an answer it
// cannot get, is refused. Whether an address is GitHub's, and which repository there, is told from the address git
// really reaches (githubOf: insteadOf rules, an SSH host alias, ssh.github.com), and a rule that sends it to another
// owner or name is refused; only for another server does the owner confirm it is private as part of what he types.
// What it does
// is all or nothing: the folder made a git repository if it is not one, everything committed as "Credentials" with
// git's own identity, the remote set, pushed, then the map gets "credentials": { "url" }. A failure undoes what this
// run did in the folder. The folder keeps mode 700 at every step. Nothing in the folder is ever named: what is said
// is counts ("3 files"), never a file name, a value or a diff.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitRead } from '../gitread.mjs';
import { withoutSecrets } from '../secretenv.mjs';
import { cleanRemote, parseRepo } from '../pcsetup/projects.mjs';
import { lsRemote } from '../pcsetup/workspace.mjs';
import { capture } from '../setup/system.mjs';
import { credsDir } from './credlinks.mjs';
import { gitIn, kindAt, leaves, leavesWords, mkdirIn, removeIn } from './inside.mjs';
import { brainDir, isDir, isGitRepo, projectsIn, remoteOf, workspaceDir } from './layout.mjs';
import { mapUrl, readMap, sameUrl, writeMap } from './map.mjs';

export const COST = 'Whoever can read that repository reads every key in it, and a private repository is only as safe as the account it is in.';
export const COMMIT = 'Credentials';
export const UPDATE = 'Update credentials';

const fail = (status, message) => Object.assign(new Error(message), { status });
const last = (r) => String(r.stderr || r.stdout || r.error || 'git failed').trim().split('\n').pop();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * A runner for every git act in the credentials folder: no hook runs. The owner's global core.hooksPath (a secret
 * scanner, say) would otherwise run on the folder's commits and pushes, and what it prints names files and values.
 * Set through the environment (GIT_CONFIG_COUNT), so a fetch, a merge, a clone or a push gets it as a commit does.
 */
export const withoutHooks = (run) => (argv, opts = {}) => {
  if (argv[0] !== 'git') return run(argv, opts);
  const env = { ...(opts.env || process.env) };
  const n = Number(env.GIT_CONFIG_COUNT) || 0;
  return run(argv, { ...opts, env: { ...env, GIT_CONFIG_COUNT: String(n + 1), [`GIT_CONFIG_KEY_${n}`]: 'core.hooksPath', [`GIT_CONFIG_VALUE_${n}`]: os.devNull } });
};

// git's own text about this folder may name a file in it or a value (a hook's or the server's words): it is never
// passed on. Plain words are chosen from a few known patterns and the exit code instead.
const KNOWN = [
  [/Please tell me who you are|user\.(name|email)|identity unknown/i, 'git does not know your name and e-mail (git config --global user.name / user.email)'],
  [/could not read Username|terminal prompts disabled|Authentication failed|Permission denied \(publickey|access denied/i, "the server did not accept this computer's sign-in"],
  [/Repository not found|does not appear to be a git repository|repository .* not found/i, 'the server does not find the repository'],
  [/Could not resolve host|unable to access|Connection (refused|timed out|reset)|Network is unreachable|timed out/i, 'the server could not be reached'],
  [/\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i, 'the server has commits this folder does not have (sync it first)'],
  [/remote rejected|hook declined|protected branch|pre-receive/i, 'the server refused it'],
];
/** Plain words for a failed git result (or git's text), never git's own text. */
export function gitWords(r) {
  if (r && r.leaves) return 'the credentials folder leads out through a link';
  const text = typeof r === 'string' ? r : `${(r && r.stderr) || ''}\n${(r && r.stdout) || ''}`;
  for (const [re, words] of KNOWN) if (re.test(text)) return words;
  if (r && typeof r === 'object' && (r.error === 'ETIMEDOUT' || (r.code === null && !r.error))) return 'git did not finish in time';
  return `git failed${r && typeof r.code === 'number' ? ` (exit ${r.code})` : ''}`;
}

// GitHub's own host names: an address on any of them reaches GitHub (ssh.github.com is its SSH over port 443).
const GITHUB_HOSTS = new Set(['github.com', 'ssh.github.com', 'www.github.com']);
const NOWHERE = path.parse(process.cwd()).root; // reads of an address run outside any repository

/**
 * The ONE environment of everything that decides where a push of the credentials goes, and of the push itself: the
 * caller's own, as it is. What is asked of git before a push (its push addresses, the address a rule makes of one) is
 * asked with it, so a rewrite rule given in the environment (GIT_CONFIG_COUNT and its keys and values) or in a
 * settings file named there is seen by the check exactly as by the push. (A check read with gitRead's short
 * environment, which drops those variables, judged an address the push then did not use.) How the owner reaches a
 * server (his ssh command, a proxy) is his own setting and is not judged here.
 */
export const pushEnv = (base = process.env) => ({ ...base, GIT_TERMINAL_PROMPT: '0' });

// A host name as an address may write it: letters, digits, ". _ -" (a dot at the end allowed), or an IPv6 address in
// brackets. Anything else (a "%", a letter of another script that looks like one of these) is not read as a host.
const HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?\.?)$/i;
const hostOf = (h) => h.toLowerCase().replace(/\.$/, '');
const REMOTE_SCHEMES = new Set(['http', 'https', 'git', 'ssh', 'git+ssh', 'ssh+git']);

/**
 * One address, read by an allow-list of shapes; what is not on it is `unknown`, and an unknown address is never
 * taken for a folder on this computer (three reviews each found one more shape that a looser reader took for a
 * local mirror while git pushed the keys to a server).
 *   { kind: 'remote', host, path, ssh }  https://, http://, git://, ssh://, git+ssh://, ssh+git:// (a user and a port
 *                                        allowed; the host is what follows the last "@"), and the scp form
 *                                        [user@]host:path with a host of two or more characters
 *   { kind: 'local', path }              ONLY an absolute path or file:///… (on Windows also C:\…)
 *   { kind: 'unknown' }                  everything else: a one-letter "host" (a drive on one system, a server on
 *                                        another), a relative path, a network share (//server/…), a transport helper
 *                                        (name::…), another scheme, white space, a host that is not a host name
 */
export function readAddress(url) {
  // The address as it is written: a user name is not taken out first (what stands before an "@" decides nothing,
  // but a "#", "?" or "\\" there does, and must be seen).
  const s = String(url ?? '').trim();
  const unknown = { kind: 'unknown' };
  if (!s || /[\s\x00-\x1f\x7f]/.test(s) || /^[a-z0-9+.-]+::/i.test(s)) return unknown;
  const u = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (u) {
    const scheme = u[1].toLowerCase();
    if (scheme === 'file') return u[2].startsWith('/') && !u[2].startsWith('//') ? { kind: 'local', path: u[2] } : unknown;
    if (!REMOTE_SCHEMES.has(scheme)) return unknown;
    const slash = u[2].indexOf('/');
    if (slash < 1) return unknown;
    const authority = u[2].slice(0, slash);
    if (/[?#\\]/.test(authority)) return unknown; // for git's own reader the host ends there: what follows an "@" after it is not the host
    // One "@" at most stands before the host (git's own reader and the others agree only then), and git:// has no
    // user at all: git takes "user@host" there as the host's name.
    const ats = authority.split('@').length - 1;
    if (ats > 1 || (ats && scheme === 'git')) return unknown;
    const m = /^(\[[^\]]*\]|[^:[\]]*)(?::(\d{1,5}))?$/.exec(authority.slice(authority.lastIndexOf('@') + 1));
    const p = u[2].slice(slash).replace(/^\/+/, '');
    if (!m || !HOST.test(m[1]) || !p) return unknown;
    if (m[2] !== undefined && !(Number(m[2]) >= 1 && Number(m[2]) <= 65535)) return unknown; // not a port: git then takes "host:number" as the host's name
    return { kind: 'remote', host: hostOf(m[1]), path: p, ssh: scheme.includes('ssh') };
  }
  if (s.startsWith('/')) return s.startsWith('//') ? unknown : { kind: 'local', path: s };
  if (process.platform === 'win32' && /^[a-z]:[\\/]/i.test(s)) return { kind: 'local', path: s };
  const m = /^(?:[^@/:\\]+@)?(\[[^\]]*\]|[^@/:\\[\]]+):(.+)$/.exec(s); // the scp form: a colon before any slash
  // git looks for "@[" first and takes the bracketed address after it as the host, wherever it stands: such an
  // address is read only when that is the host found here too.
  if (m && s.includes('@[') && !(m[1].startsWith('[') && s.indexOf('@[') === s.indexOf(m[1]) - 1)) return unknown;
  const p = m ? m[2].replace(/^\/+/, '') : '';
  if (m && HOST.test(m[1]) && hostOf(m[1]).length >= 2 && p) return { kind: 'remote', host: hostOf(m[1]), path: p, ssh: true };
  return unknown;
}
const ownerName = (p) => {
  const m = /^([^/]+)\/([^/]+?)(?:\.git)?\/*$/.exec(p);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
};

// The last two parts of a local path as <owner>/<name> (a mirror on this computer keeps them), or null.
const tailOf = (a) => ownerName(String(a).replace(/\\/g, '/').replace(/^file:\/\//i, '').split('/').filter(Boolean).slice(-2).join('/'));

/**
 * Whether an address reaches GitHub, and which repository there, found from the address git really talks to: the
 * address as written, and `reached`, the addresses git makes of it (default: with the owner's url.<x>.insteadOf rules
 * applied, git ls-remote --get-url; for a push, the folder's own push addresses), each SSH one by the host name its
 * SSH settings give (ssh -G: a "Host github-work" alias for a second account). Visibility is asked of one GitHub
 * repository, so git must reach that one: a rule that sends a GitHub address to another owner or name, or to another
 * server, is refused; only a folder on this computer that ends in the same <owner>/<name> (a mirror) is taken as it.
 * An address on another server is held to the same: a rule that sends it to a third place is refused. Every address is
 * read by readAddress, and one it does not know is refused ("could not be told"), never taken for a folder here.
 * → { full: 'owner/name' } | { full: null } (another server) | { why } (refused, or it could not be told: never taken
 * for another server).
 */
export async function githubOf(url, run = capture, { reached = null } = {}) {
  const env = pushEnv();
  let at = reached;
  if (!at) {
    const r = await run(['git', 'ls-remote', '--get-url', '--', url], { cwd: NOWHERE, timeout: 10_000, env });
    if (!r.ok || !r.stdout.trim()) return { why: 'which address git reaches with it could not be asked' };
    at = [r.stdout.trim()];
  }
  // Where one address leads: { why } (refused, or it could not be told) | { local: path } | { full } (a GitHub
  // repository) | { server: 'host/path' } (another server).
  const where = async (a) => {
    const ra = readAddress(a);
    if (ra.kind === 'unknown') return { why: 'which server it reaches could not be told' };
    if (ra.kind === 'local') return { local: ra.path };
    let host = ra.host;
    if (!GITHUB_HOSTS.has(host) && ra.ssh) {
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(host)) return { why: 'which server it reaches could not be told' };
      const s = await run(['ssh', '-G', host], { cwd: NOWHERE, timeout: 10_000, env: withoutSecrets(env) }); // ssh's own settings: it needs none of the caller's secrets
      if (!s.ok) return { why: `which server it reaches could not be asked (${s.error === 'ENOENT' ? 'ssh is not on this computer' : 'ssh -G failed'})` };
      const h = /^hostname\s+(\S+)\s*$/im.exec(s.stdout);
      if (h) host = h[1].toLowerCase();
    }
    if (!GITHUB_HOSTS.has(host)) return { server: `${host}/${ra.path.replace(/(?:\.git)?\/*$/, '')}` };
    const full = ownerName(ra.path);
    return full ? { full } : { why: 'it reaches GitHub, but not as <owner>/<name>' };
  };
  // The same place? Two folders by their path; two servers by host and path; a folder on this computer is the mirror
  // of a server's repository when it keeps the last two parts of its path.
  const samePlace = (w, g) => {
    if (w.local !== undefined) return g.local !== undefined && path.resolve(w.local) === path.resolve(g.local);
    if (g.local !== undefined) return Boolean(tailOf(g.local)) && tailOf(g.local) === tailOf(w.server);
    return g.server === w.server;
  };
  const written = await where(url);
  if (written.why) return written;
  let full = written.full || null;
  for (const a of at.filter((x) => x !== url)) {
    const g = await where(a);
    if (g.why) return g;
    if (written.full) {
      // A GitHub repository was named: git must reach that one (or a folder here that keeps <owner>/<name>).
      const other = g.full || (g.local !== undefined ? tailOf(g.local) : null);
      if (other !== written.full) return { why: `git really reaches ${g.full ? `another GitHub repository with it (${g.full})` : g.server ? 'another server with it' : 'another repository with it'}, through a url.<base>.insteadOf rule in git's settings` };
    } else if (g.full) {
      full = g.full; // the owner's own short form of a GitHub address: judged as the GitHub repository git reaches
    } else if (!samePlace(written, g)) {
      return { why: "git really reaches another address with it, through a url.<base>.insteadOf rule in git's settings" };
    }
  }
  return { full };
}

/** The name the owner types: the last part of the address, without .git. */
export const typedName = (url) => String(parseRepo(url)?.name || '').replace(/\.git$/, '');

/**
 * A GitHub repository's visibility, asked through gh right now. → { private: true } | { private: false, why }. Public,
 * internal, not found, gh missing or not signed in, slow or an answer it does not know: never private.
 */
export async function askVisibility(full, run = capture) {
  const r = await run(['gh', 'repo', 'view', full, '--json', 'visibility,isPrivate'], { timeout: 20_000 });
  if (!r.ok) {
    const why = r.error === 'ENOENT' ? 'gh is not on this computer' : r.code === 4 ? 'gh is not signed in' : r.error === 'ETIMEDOUT' || r.code === null ? 'gh did not answer in time' : /could not resolve|not found/i.test(`${r.stderr}${r.stdout}`) ? 'GitHub does not find it for this sign-in' : `gh failed (${last(r).slice(0, 120)})`;
    return { private: false, why: `its visibility could not be asked: ${why}` };
  }
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    return { private: false, why: 'its visibility could not be asked: gh answered something unexpected' };
  }
  if (j && j.isPrivate === true && j.visibility === 'PRIVATE') return { private: true };
  if (j && j.visibility === 'PUBLIC') return { private: false, why: 'it is public on GitHub' };
  return { private: false, why: `it is not private on GitHub (${String(j && j.visibility).slice(0, 20).toLowerCase()})` };
}

/** Files and links in the folder, its .git left out (counted only: no name ever leaves). */
function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (d === dir && e.name === '.git') continue;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  walk(dir);
  return n;
}

const modeOf = (d) => {
  try {
    return fs.statSync(d).mode & 0o777;
  } catch {
    return null;
  }
};

/** The state, read only: { folder: missing | folder | repository | other, owner_only, remote?, map? } (addresses only). */
export function credentialsState({ dir = workspaceDir() } = {}) {
  const c = credsDir(dir);
  const k = kindAt(c);
  const m = readMap(dir);
  const map = m.map && m.map.credentials && m.map.credentials.url ? m.map.credentials.url : null;
  if (k === 'none') return { folder: 'missing', ...(map ? { map } : {}) };
  if (!isDir(c)) return { folder: 'other', ...(map ? { map } : {}) };
  const raw = isGitRepo(c) ? remoteOf(c) : null;
  let remote = null;
  try {
    remote = raw ? mapUrl(raw) : null; // never an address with a secret in it
  } catch {
    remote = raw ? '(an address that is not shown)' : null;
  }
  return { folder: isGitRepo(c) ? 'repository' : 'folder', ownerOnly: process.platform === 'win32' || (modeOf(c) & 0o077) === 0, ...(remote ? { remote } : {}), ...(map ? { map } : {}) };
}

/**
 * What `--repo <address>` / `--github [<name>]` would do, read only. Refusals throw with the reason (nothing changed).
 * → { url, github, create, name, steps: [words], files, recordOnly }
 */
export async function planCredentialsRepo({ dir = workspaceDir(), repo = null, github = null, run = capture } = {}) {
  const m = readMap(dir);
  if (m.errors) throw fail(409, `the workspace map was refused: ${m.errors.join('; ')}`);
  if (!m.exists) throw fail(409, 'there is no workspace map yet: hoprig workspace map, then hoprig workspace map --upgrade');
  if (m.map.version !== 2) throw fail(409, 'the map is of version 1, and the credentials repository needs version 2:  hoprig workspace map --upgrade');
  let url;
  let full = null;
  let create = false;
  if (github !== null) {
    const name = github || 'credentials';
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || /^\.+$/.test(name)) throw fail(400, `"${name.slice(0, 60)}" is not a repository name`);
    const who = await run(['gh', 'api', 'user', '--jq', '.login'], { timeout: 20_000 });
    const login = who.ok ? who.stdout.trim() : '';
    if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw fail(409, `the signed-in GitHub account could not be asked (${who.error === 'ENOENT' ? 'gh is not on this computer' : 'gh is not signed in'}): nothing was done`);
    full = `${login}/${name}`;
    url = `https://github.com/${full}.git`;
    // Before anything is created: the address must reach that repository (no rule sends it elsewhere).
    const g = await githubOf(url, run);
    if (g.why) throw fail(409, `${url} is refused: ${g.why}. Hoprig pushes credentials only to a private repository: nothing was done`);
    const there = await run(['gh', 'repo', 'view', full, '--json', 'name'], { timeout: 20_000 });
    create = !there.ok;
  } else {
    try {
      url = mapUrl(repo);
    } catch (e) {
      throw fail(400, e.message);
    }
    if (!url) throw fail(400, 'give the address of the repository: --repo <address>');
    const g = await githubOf(url, run);
    if (g.why) throw fail(409, `${url} is refused: ${g.why}. Hoprig pushes credentials only to a private repository: nothing was done`);
    full = g.full;
  }
  if (m.map.credentials && m.map.credentials.url && !sameUrl(m.map.credentials.url, url)) throw fail(409, `the map names another credentials repository already (${m.map.credentials.url}): nothing was done`);
  // The folder: there, a real folder where the workspace has it.
  const c = credsDir(dir);
  const at = { dir, projects: projectsIn() };
  const out = kindAt(c) === 'none' ? null : leaves(c, c, at);
  if (out) throw fail(409, `the credentials folder: ${leavesWords(out)}: nothing was done`);
  if (!isDir(c)) throw fail(409, `there is no credentials folder at ${c} (hoprig workspace setup makes it): nothing was done`);
  // Visibility: never anything but private.
  if (full && !create) {
    const v = await askVisibility(full, run);
    if (!v.private) throw fail(409, `${url} is refused: ${v.why}. Hoprig pushes credentials only to a private repository: nothing was done`);
  }
  const repoHere = isGitRepo(c);
  const have = repoHere ? remoteOf(c) : null;
  if (have && !sameUrl(have, url)) throw fail(409, 'the credentials folder is a repository with another remote: nothing was done. Give that address with --repo, or move the folder aside and run hoprig workspace restore');
  // The server must have nothing this folder lacks (else a push would be refused, or worse, the folder is not the repository).
  let serverShas = [];
  if (!create) {
    const there = await lsRemote(url, null, { run });
    serverShas = there.shas || [];
    if (there.error) throw fail(502, `the server could not be asked (${there.error}): nothing was done`);
    for (const sha of there.shas) {
      const anc = repoHere ? await gitRead(c, ['merge-base', '--is-ancestor', sha, 'HEAD'], { run }) : { ok: false };
      if (!anc.ok) throw fail(409, 'the repository on the server has commits this folder does not have: nothing was done. To get it here, move the folder aside and run hoprig workspace restore (it clones it)');
    }
  }
  const h = repoHere ? await gitRead(c, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { run }) : { ok: false };
  const head = h.ok;
  const changes = repoHere ? (await gitRead(c, ['status', '--porcelain'], { run })).stdout.split('\n').filter(Boolean).length : countFiles(c);
  // Only recorded when the server has this folder's commit already: a run killed after the remote was set and before
  // the push is pushed by the next one, never only written into the map.
  const recordOnly = Boolean(have) && changes === 0 && head && serverShas.includes(h.stdout.trim());
  const steps = [];
  if (!recordOnly) {
    if (!repoHere) steps.push('make the credentials folder a git repository (git init)');
    if (changes || !head) steps.push(`commit ${changes ? plural(changes, 'file') : 'it'} in it as "${COMMIT}"`);
    if (create) steps.push(`create the private repository ${full} on GitHub (gh repo create --private)`);
    if (!have) steps.push(`set its remote origin to ${url}`);
    steps.push(`push it to ${url}`);
  }
  steps.push('write its address into the workspace map (ai_brain/workspace.json)');
  return { url, github: full, create, name: create ? full.split('/')[1] : typedName(url), steps, changes, head, repoHere, have: Boolean(have), recordOnly };
}

/** Said when the address is not GitHub's: the owner, not gh, says the repository is private. */
export const NOT_GITHUB = 'This is not a GitHub address, so Hoprig cannot ask whether it is private: you confirm that it is.';

/**
 * The one comparison of what the owner typed with the repository's name (the command's typedYes and the Workspace
 * page's route both call it): only the exact name, spaces around it aside. → true | false
 */
export const typedMatches = (said, name) => said !== null && said !== undefined && typeof name === 'string' && name !== '' && String(said).trim() === name;

/** The typed confirmation: the cost said once, then the repository's name typed. → true only for the exact name. */
export async function typedYes(ui, plan) {
  ui.out(`\n  ${COST}`);
  if (!plan.github) ui.out(`  ${NOT_GITHUB}`);
  if (!ui.interactive) {
    ui.line('info', 'nothing was done: this needs you at a terminal, to type the repository\'s name (no option skips it)');
    return false;
  }
  const said = await ui.ask(`  Type ${plan.name} to ${plan.github ? '' : 'confirm that it is private and to '}go ahead: `);
  if (!typedMatches(said, plan.name)) {
    ui.line('info', 'nothing was done: what was typed is not the repository\'s name');
    return false;
  }
  return true;
}

/** Do it, all or nothing in the folder. → { ok, pushed, recorded, why? } */
export async function applyCredentialsRepo(plan, { dir = workspaceDir(), run: given = capture, ui } = {}) {
  const run = withoutHooks(given);
  const c = credsDir(dir);
  const at = { dir, projects: projectsIn(), root: c };
  const own = () => mkdirIn(at, c, { mode: 0o700 });
  const g = (args, opts) => gitIn(at, c, args, run, opts);
  const did = { init: false, before: null, committed: false, remote: false };
  const undo = async (why) => {
    if (did.remote) await g(['remote', 'remove', 'origin']);
    if (did.init) removeIn(at, path.join(c, '.git'), { recursive: true });
    else if (did.committed) await g(did.before ? ['reset', '-q', '--soft', did.before] : ['update-ref', '-d', 'HEAD']);
    own();
    return { ok: false, why: `${why}: what this run did in the folder was undone, nothing else changed` };
  };
  own();
  if (!plan.recordOnly) {
    if (!plan.repoHere) {
      const r = await g(['init', '-q', '-b', 'main']);
      if (!r.ok) return undo(`git init failed (${gitWords(r)})`);
      did.init = true;
    }
    if (plan.changes || !plan.head) {
      if (plan.head) did.before = (await gitRead(c, ['rev-parse', 'HEAD'], { run })).stdout.trim();
      const a = await g(['add', '-A']);
      if (!a.ok) return undo(`git add failed (${gitWords(a)})`);
      const k = await g(['commit', '-q', '--allow-empty', '-m', COMMIT]);
      if (!k.ok) return undo(`the commit failed (${gitWords(k)})`);
      did.committed = true;
    }
    own();
    if (plan.create) {
      const r = await run(['gh', 'repo', 'create', plan.github, '--private'], { timeout: 60_000 });
      if (!r.ok) return undo(`GitHub did not create the repository (${last(r).slice(0, 160)})`);
      ui.line('ok', `created the private repository ${plan.github} on GitHub`);
    }
    if (!plan.have) {
      const r = await g(['remote', 'add', 'origin', plan.url]);
      if (!r.ok) return undo(`the remote could not be set (${gitWords(r)})`);
      did.remote = true;
    }
    // Every address the push reaches is the one typed (a folder that had the remote may have more push addresses).
    const addr = await pushAddresses(c, plan.url, run);
    if (addr.why) return undo(`${plan.url} is refused: ${addr.why}`);
    // Asked once more right before the push, of the repository the push really reaches: a repository made public
    // since the plan, or one the folder's own git settings send it to, is never pushed to.
    const priv = await privateWhy(plan.url, addr.at, run);
    if (priv) return undo(priv);
    const p = await pushCredentials(at, c, run);
    if (!p.ok) return undo(`the push failed (${gitWords(p)})`);
    own();
    ui.line('ok', `pushed the credentials to ${plan.url}`);
  }
  // The map, as every map change is written (under the brain's lock).
  try {
    const { withRepoLock } = await import('../work/lock.mjs');
    await withRepoLock(brainDir(dir), async () => {
      const m = readMap(dir);
      writeMap({ ...m.map, credentials: { url: plan.url } }, dir);
    }, { wait: 30_000 });
  } catch (e) {
    return { ok: false, pushed: !plan.recordOnly, why: `the map was not written (${e.message}): run the same command again, it only writes the map then` };
  }
  return { ok: true, pushed: !plan.recordOnly, recorded: true };
}

/** The command. → exit code */
export async function credentialsMain(args, { ui, write, usage, run = capture }) {
  const { flags } = await import('../pcsetup/project.mjs');
  const o = flags(args, { repo: 'v', github: 'bool', 'dry-run': 'bool', json: 'bool' });
  if (o.errors.length || o._.length > 1 || (o._.length && !o.github) || (o.repo !== undefined && o.github)) return usage();
  const json = (v) => (write(JSON.stringify(v, null, 2) + '\n'), 0);
  if (o.repo === undefined && !o.github) {
    if (o['dry-run']) return usage();
    const s = credentialsState();
    if (o.json) return json(s);
    const where = s.folder === 'missing' ? 'not here (hoprig workspace setup makes it, restore clones it when the map names one)' : s.folder === 'other' ? 'something that is not a folder is where it goes' : s.folder === 'folder' ? 'a local folder, never in git' : `a git repository${s.remote ? `, its remote ${s.remote}` : ', with no remote'}`;
    ui.line(s.folder === 'other' || s.ownerOnly === false ? 'warn' : 'ok', `credentials: ${where}`);
    if (s.ownerOnly === false) ui.line('warn', 'other users of this computer can open it: chmod 700 it');
    if (s.map) ui.note(`the map names ${s.map}${s.remote && !sameUrl(s.remote, s.map) ? ' (another address than its remote)' : ''}: restore clones it on a fresh computer`);
    else ui.note('the map names no credentials repository (hoprig workspace credentials --repo <address> or --github makes one)');
    return 0;
  }
  if (o.json && !o['dry-run']) return usage(); // the real run needs the terminal for what is typed
  let plan;
  try {
    plan = await planCredentialsRepo({ repo: o.repo === undefined ? null : o.repo, github: o.github ? o._[0] || '' : null, run });
  } catch (e) {
    if (o.json) return (json({ ok: false, error: e.message }), 1);
    ui.line('fail', e.message);
    return 1;
  }
  const shown = { url: plan.url, steps: plan.steps };
  if (o['dry-run']) {
    if (o.json) return json({ ok: true, dryRun: true, ...shown });
    for (const s of plan.steps) ui.line('info', `(dry run) would ${s}`);
    ui.note(`(dry run) would ask you to type ${plan.name}; nothing was changed`);
    return 0;
  }
  for (const s of plan.steps) ui.line('info', `would ${s}`);
  if (!(await typedYes(ui, plan))) return 1;
  const r = await applyCredentialsRepo(plan, { run, ui });
  if (!r.ok) {
    ui.line('fail', r.why);
    return 1;
  }
  ui.line('ok', `the map names ${plan.url} as the credentials repository now: restore clones it right after the brain`);
  ui.note('commit the brain to share the map (or turn on hoprig workspace auto --commit on); hoprig workspace auto --credentials on commits and pushes a change of the credentials by itself');
  return 0;
}

/**
 * Where a push of the credentials folder by `origin` goes: { at: [the addresses git really pushes to] }, or { why } it
 * could reach another address than `url`. git pushes to EVERY remote.origin.pushurl, and a url.<x>.pushInsteadOf rule
 * rewrites the address for a push only, so `git config --get` of one value proves nothing: origin's address must be
 * `url`, each push address written must be `url`, and every address git really pushes to (git remote get-url --push --all, which applies those rules) must be
 * the one it fetches from. A push is always `push origin HEAD`, so branch.<b>.pushRemote and remote.pushDefault are
 * never used.
 */
export async function pushAddresses(c, url, run = capture) {
  // Asked of git in the push's own environment (pushEnv), not gitRead's short one: the rules git applies to these
  // answers must be the rules it applies to the push.
  const lines = async (args) => {
    const r = await run(['git', ...args], { cwd: c, timeout: 15_000, env: pushEnv() });
    if (r.ok) return r.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
    return r.code === 1 && args[0] === 'config' ? [] : null; // git config: 1 is "not set"
  };
  const NOT = 'its remote origin is not the address the map names';
  // remote.origin.vcs hands the push to a helper program of that name, whatever the address says.
  const helper = await lines(['config', '--get-all', 'remote.origin.vcs']);
  if (!helper) return { why: 'its remote origin could not be read' };
  if (helper.length) return { why: `${NOT}: it is pushed by a transport helper (remote.origin.vcs)` };
  const origin = await lines(['config', '--get-all', 'remote.origin.url']);
  const written = await lines(['config', '--get-all', 'remote.origin.pushurl']);
  const unread = { why: 'its remote origin could not be read' };
  if (!origin || !written) return unread;
  if (origin.length !== 1 || !sameUrl(cleanRemote(origin[0]), url) || written.some((x) => !sameUrl(cleanRemote(x), url))) return { why: NOT };
  const fetchAt = await lines(['remote', 'get-url', '--all', 'origin']);
  const pushAt = await lines(['remote', 'get-url', '--push', '--all', 'origin']);
  if (!fetchAt || !pushAt || fetchAt.length !== 1 || !pushAt.length) return unread;
  if (pushAt.some((x) => x !== fetchAt[0])) return { why: `${NOT}: a push from it would go to another address (a pushInsteadOf rule or a second push address)` };
  return { at: pushAt };
}

/** Why `url`, pushed to the addresses `at` git really reaches, may not be pushed to, or '': a GitHub one is private now. */
async function privateWhy(url, at, run) {
  const g = await githubOf(url, run, { reached: at });
  if (g.why) return `${url} is refused: ${g.why}`;
  if (g.full) {
    const v = await askVisibility(g.full, run);
    if (!v.private) return `${url} is refused: ${v.why}`;
  }
  return '';
}

/**
 * Why the credentials repository may not be pushed now, or '' when it may: every address a push reaches is the
 * address the map names (pushAddresses), and the GitHub repository git really reaches is private, asked through gh
 * at this moment.
 */
export async function credPushWhy({ dir = workspaceDir(), url, run = capture } = {}) {
  const addr = await pushAddresses(credsDir(dir), url, run);
  return addr.why || privateWhy(url, addr.at, run);
}

/** The one push of the credentials folder: by origin, the branch named (HEAD), never by a branch's push remote. */
export const pushCredentials = (at, c, run, { upstream = false } = {}) => gitIn(at, c, ['push', '-q', '--no-recurse-submodules', ...(upstream ? [] : ['-u']), 'origin', 'HEAD'], run, { env: pushEnv() });

/**
 * The upkeep's round for the credentials (the switch "credentials", off by default): a change is committed as
 * "Update credentials" with the folder's own git identity, then pushed when credPushWhy allows it. Never throws.
 * → { skipped?, lines: [activity lines], needs: [what needs the owner] } (counts only, never a name in the folder)
 */
export async function upkeepCredentials({ dir = workspaceDir(), run: given = capture } = {}) {
  const run = withoutHooks(given);
  const lines = [];
  const needs = [];
  const m = readMap(dir);
  const url = m.map && m.map.credentials && m.map.credentials.url;
  if (!url) return { skipped: 'the map names no credentials repository', lines, needs };
  const c = credsDir(dir);
  const at = { dir, projects: projectsIn(), root: c };
  const out = kindAt(c) === 'none' ? null : leaves(c, c, at);
  if (out) return { lines, needs: [`the credentials folder: ${leavesWords(out)}: nothing was committed`] };
  if (!isGitRepo(c)) return { lines, needs: ['the credentials folder is not a git repository here (hoprig workspace restore clones it): nothing was committed'] };
  const g = (args, opts) => gitIn(at, c, args, run, opts);
  const st = await gitRead(c, ['status', '--porcelain'], { run });
  const n = st.ok ? st.stdout.split('\n').filter(Boolean).length : 0;
  if (n) {
    const a = await g(['add', '-A']);
    const k = a.ok ? await g(['commit', '-q', '-m', UPDATE]) : a;
    if (!k.ok) {
      const who = /identity|user\.(name|email)|Please tell me who you are/i.test(`${k.stderr}${k.stdout}`);
      return { lines, needs: [`the credentials could not be committed: ${who ? 'git does not know a name and e-mail for that folder' : 'git failed'}`] };
    }
    lines.push(`The credentials were committed (${plural(n, 'changed file')})`);
  }
  mkdirIn(at, c, { mode: 0o700 });
  const { repoInfo } = await import('../pcsetup/workspace.mjs');
  const s = await repoInfo(c, run);
  if (!s.ok) return { lines, needs: ['the credentials repository could not be read (git status there says why)'] };
  if (s.upstream && !s.ahead) return { lines, needs };
  const why = await credPushWhy({ dir, url, run });
  if (why) return { lines, needs: [`the credentials were not pushed: ${why}`] };
  const p = await pushCredentials(at, c, run, { upstream: Boolean(s.upstream) });
  if (p.ok) lines.push('The credentials were pushed to the address the map names');
  else needs.push(`the credentials could not be pushed: ${gitWords(p)}`);
  return { lines, needs };
}
