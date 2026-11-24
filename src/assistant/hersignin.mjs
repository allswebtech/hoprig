// The git sign-in Tia's sessions use, the owner's choice on his own page, per computer.
//
// By default a session Tia starts carries the owner's own git sign-in (his GH_TOKEN/GITHUB_TOKEN, his gh store): his
// full rights. The owner may instead name ONE file in his credentials folder that holds a token for the git server.
// Then the sessions Tia starts get THAT sign-in for git and for the git server's command-line tool (gh), in place of
// his own, so a mistake of a session cannot delete a repository or force past a protected branch when he made the
// token without those rights.
//
// Said honestly: a session runs as his user, so this guards against a mistake, not against a session that goes
// looking for his own sign-in. The file's content is never shown, logged or put on a command line: the token reaches
// git through a credential helper that reads the environment variable (never the literal token in a config value),
// and gh reads the same variable. The dashboard reads the file only to hand the session its environment and to run
// the owner's own "check" against the git server; it is never written to the state folder, an audit line or a log.
//
// Stored under config server.herGitSignin = { file, at }; herGitSigninFile(cfg) reads the chosen name, or null when
// the owner chose none (everything is then as it is today). The name is set only through the owner's signed-in page
// (src/server/hersignin.mjs), never through Tia's door, a token, another computer or a session.
import fs from 'node:fs';
import path from 'node:path';
import { markHers, unmarkHers } from '../hermark.mjs';
import { stateDir } from '../paths.mjs';

// The git server this sign-in is for. gh and git both speak to github.com today; a later gateway of the owner's own
// would name its own host here, so the code around it says "a git server" and never depends on one particular account.
export const GIT_HOST = 'github.com';

/** The chosen credentials-file name of a computer's config, or null when the owner chose none. */
export function herGitSigninFile(cfg) {
  const f = cfg && cfg.server && cfg.server.herGitSignin && cfg.server.herGitSignin.file;
  return typeof f === 'string' && f ? f : null;
}

/**
 * A file name as the owner's page sends it: a relative path inside the credentials folder, with "/" between its
 * parts. Empty or null clears the choice (→ null). Anything that could lead out of the folder — an absolute path, a
 * ".." part, a backslash, a control character, a leading or doubled slash — is refused with the one message the page
 * shows. Returns the cleaned name (no leading/trailing slash) or null.
 */
export function cleanHerGitSigninFile(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new Error('the sign-in file is the name of one file in the credentials folder');
  const name = v.trim();
  if (!name) return null;
  if (name.length > 255) throw new Error('that name is too long for a file in the credentials folder');
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f\x7f]/.test(name)) throw new Error('the sign-in file name holds a character a file name may not');
  if (path.isAbsolute(name) || /^[a-zA-Z]:/.test(name)) throw new Error('the sign-in file is named relative to the credentials folder, not by a full path');
  const parts = name.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new Error('the sign-in file is a plain name inside the credentials folder (no "..", no leading or doubled "/")');
  return parts.join('/');
}

/**
 * The absolute path of the chosen file inside `credsDir`, checked so no part and no link on the way leads out of the
 * folder. Throws a plain message (never the path or the content) when it leads out. `file` is already cleaned.
 */
export function herTokenPath(credsDir, file) {
  const base = path.resolve(credsDir);
  const full = path.resolve(base, ...file.split('/'));
  const rel = path.relative(base, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('the sign-in file is not inside the credentials folder');
  // A link on the way (or the file itself a link) could lead out: resolve what is really there and check again.
  let real = full;
  try {
    real = fs.realpathSync(full);
  } catch {
    // Not there yet: the path check above is what we can say; readHerToken reports "not there".
    return full;
  }
  let realBase = base;
  try {
    realBase = fs.realpathSync(base);
  } catch {
    /* the credentials folder is not there: readHerToken reports it */
  }
  const relReal = path.relative(realBase, real);
  if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error('the sign-in file leads out of the credentials folder through a link');
  return full;
}

/**
 * The token in the chosen file, read from disk. Throws a plain message (never the content) when the file is missing,
 * empty or leads out. The caller uses it at once (an environment, a check request) and never keeps or logs it.
 */
export function readHerToken(credsDir, file) {
  const full = herTokenPath(credsDir, file);
  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? 'the sign-in file is not in the credentials folder' : 'the sign-in file could not be read');
  }
  const token = text.trim();
  if (!token) throw new Error('the sign-in file is empty');
  if (/\s/.test(token)) throw new Error('the sign-in file holds more than one line: it must hold only the token');
  return token;
}

/** Append GIT_CONFIG key/value pairs to a base environment, after any GIT_CONFIG_* it already carries (never losing one). */
function withGitConfig(base, pairs) {
  const n = Number.parseInt(base.GIT_CONFIG_COUNT, 10);
  let i = Number.isInteger(n) && n >= 0 ? n : 0;
  const out = { ...base };
  for (const [key, value] of pairs) {
    out[`GIT_CONFIG_KEY_${i}`] = key;
    out[`GIT_CONFIG_VALUE_${i}`] = value;
    i += 1;
  }
  out.GIT_CONFIG_COUNT = String(i);
  return out;
}

// git runs a credential helper whose value starts with "!" through the shell as `<command> <operation>`. This one
// answers "get" with the token, read from the environment the git process already holds (GH_TOKEN), so the literal
// token is never in the config value, never on git's command line and never in anything git logs.
const HELPER = '!f() { test "$1" = get && printf \'username=x-access-token\\npassword=%s\\n\' "$GH_TOKEN"; }; f';

/**
 * The environment a session Tia starts gets so git and gh sign in with `token` instead of the owner's own, for the
 * git server at `host`. `base` is the session's environment so far; the result overrides its GH_TOKEN/GITHUB_TOKEN
 * and adds a git credential helper for `host`. The token appears only as the value of GH_TOKEN/GITHUB_TOKEN (the one
 * place git and gh read it): it is in no config value, on no command line, in no log.
 */
export function herGitEnv(token, { host = GIT_HOST, base = {} } = {}) {
  // His own tokens go first, all of them: an enterprise token of his left beside hers would sign a mistaken gh or git
  // call in with his full rights.
  const own = { ...base };
  for (const k of HIS_GIT_TOKENS) delete own[k];
  const env = withGitConfig(own, [
    [`credential.https://${host}.helper`, ''], // clear any inherited helper for this host first
    [`credential.https://${host}.helper`, HELPER],
    [`credential.https://${host}.username`, 'x-access-token'],
  ]);
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;
  return env;
}

/**
 * The git sign-in a session Tia starts should carry, from a computer's config and its credentials folder. Returns
 * null when the owner chose no file (the session keeps his own sign-in, as today), { ok: true, env } when the chosen
 * file holds a token, or { ok: false, why } when a file is chosen but cannot be read (a plain reason, never content).
 * `base` is the session's environment so far.
 */
export function herSessionGitEnv(cfg, credsDir, { base = {}, host = GIT_HOST } = {}) {
  const file = herGitSigninFile(cfg);
  if (!file) return null;
  let token;
  try {
    token = readHerToken(credsDir, file);
  } catch (e) {
    return { ok: false, why: e.message };
  }
  return { ok: true, env: herGitEnv(token, { host, base }) };
}

// The check, on the owner's press: with the chosen token, ask the git server what the token may do, so he can see
// before he trusts a session to it. The token goes in the Authorization header only; nothing the check returns holds
// it. github.com is the git server the check knows; another server's repository is said as "not known".
export const API_BASE = 'https://api.github.com';

/** The owner and name of a github.com repository address, or null for another server (the check knows only github.com). */
export function ghRepoOf(url) {
  const s = String(url || '').trim();
  const forms = [
    /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/,
    /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})?)\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/,
  ];
  for (const re of forms) {
    const m = re.exec(s);
    if (m && m[2] !== '.' && m[2] !== '..') return { owner: m[1], name: m[2] };
  }
  return null;
}

/** Whether a token can delete a repository, from its scopes header: true, false, or null ("not known"). */
export function tokenCanDelete(scopesHeader) {
  if (scopesHeader === null || scopesHeader === undefined) return null; // a fine-grained token shows no scopes here
  const scopes = String(scopesHeader).split(',').map((x) => x.trim()).filter(Boolean);
  return scopes.includes('delete_repo');
}

/** A branch's force-push and delete rule, from the protection endpoint's status and body (as the git server gives). */
export function branchRuleWords(status, body) {
  if (status === 404) return { forcePush: 'not blocked', branchDelete: 'not blocked' }; // no protection rule on the branch
  if (status !== 200 || !body || typeof body !== 'object') return { forcePush: 'not known', branchDelete: 'not known' };
  const rule = (o) => (o && typeof o.enabled === 'boolean' ? (o.enabled ? 'not blocked' : 'blocked') : 'not known');
  return { forcePush: rule(body.allow_force_pushes), branchDelete: rule(body.allow_deletions) };
}

async function ghGet(fetchImpl, apiBase, p, token, timeoutMs) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiBase}${p}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'hoprig-dashboard' },
      signal: ac.signal,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* no JSON body (an empty or non-JSON answer) */
    }
    return { status: res.status, scopes: res.headers.get('x-oauth-scopes'), body };
  } catch {
    return { status: 0, scopes: null, body: null };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask the git server what `token` may do: whether it can delete a repository, and per repository of `repos` ({ ref,
 * url }) whether a forced push or a delete of the default branch is blocked by a rule there. Nothing returned holds
 * the token. `fetchImpl` and `apiBase` let a test point the check at a stand-in git server (never the real one).
 */
export async function checkHerSignin({ token, apiBase = API_BASE, repos = [], fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const root = await ghGet(fetchImpl, apiBase, '/', token, timeoutMs);
  const accepted = root.status >= 200 && root.status < 300;
  if (!accepted) {
    const error = root.status === 0 ? 'the git server could not be reached' : root.status === 401 ? 'the git server did not accept this token' : `the git server answered ${root.status}`;
    return { accepted: false, canDelete: null, error, repos: [] };
  }
  const canDelete = tokenCanDelete(root.scopes);
  const out = { accepted: true, canDelete, repos: [] };
  for (const r of repos) {
    const gh = ghRepoOf(r.url);
    if (!gh) {
      out.repos.push({ ref: r.ref, known: false, why: 'it is not a github.com repository, so the check cannot ask about it' });
      continue;
    }
    const info = await ghGet(fetchImpl, apiBase, `/repos/${gh.owner}/${gh.name}`, token, timeoutMs);
    if (info.status !== 200 || !info.body || typeof info.body.default_branch !== 'string') {
      // A real reason the owner can act on, never a bare "not known" (which would read back as "not known (not known)").
      const why = info.status === 404 ? 'the git server does not find it with this token'
        : info.status === 403 ? 'this token may not read it'
          : info.status === 0 ? 'the git server could not be reached'
            : info.status === 200 ? 'the git server did not say which branch is its default'
              : `the git server answered ${info.status}`;
      out.repos.push({ ref: r.ref, owner: gh.owner, name: gh.name, known: false, why });
      continue;
    }
    const branch = info.body.default_branch;
    const prot = await ghGet(fetchImpl, apiBase, `/repos/${gh.owner}/${gh.name}/branches/${encodeURIComponent(branch)}/protection`, token, timeoutMs);
    out.repos.push({ ref: r.ref, owner: gh.owner, name: gh.name, branch, known: true, ...branchRuleWords(prot.status || -1, prot.body) });
  }
  return out;
}

// The git tokens the owner's own sign-in exports. When a chosen file cannot be read, these are taken out of a session
// Tia started, so a mistake of the session reaches no git sign-in at all, never his own full rights by falling back.
const HIS_GIT_TOKENS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'];
// What the blank sign-in puts in each of those in place of a token (herBlankSignin): plainly not one.
const BLANK_TOKEN = 'none';

/** The rights the chosen file's own folder in the credentials folder has, so the empty gh folder we make is no more
 *  open than the credentials the owner keeps there. 0o700 when the folder cannot be read. */
function tokenFolderMode(credsDir, file) {
  try {
    return fs.statSync(path.dirname(herTokenPath(credsDir, file))).mode & 0o777;
  } catch {
    return 0o700;
  }
}

/**
 * The environment a session of hers gets when a sign-in file was chosen but cannot be read: no git sign-in at all, his
 * least of all. His git tokens are taken out and each token variable gh reads holds a placeholder that is not a token
 * (so gh fails rather than asking the keyring); gh is pointed at an EMPTY folder of her own under Hoprig's state folder
 * (so it finds none of his stored sign-in), made no more open than the folder the token lives in; and git's credential
 * helper for the git server over https is cleared, the way herGitEnv clears it when the file IS read — an empty value,
 * which resets the host's whole helper list, a generic credential.helper of his included.
 */
function herBlankSignin(base, { host = GIT_HOST, credsDir, file } = {}) {
  const out = { ...base };
  for (const k of HIS_GIT_TOKENS) delete out[k];
  // gh's own order (`gh help environment`): for github.com, a subdomain of ghe.com or github.localhost it takes
  // GH_TOKEN, then GITHUB_TOKEN; for any other host (an Enterprise Server) GH_ENTERPRISE_TOKEN, then
  // GITHUB_ENTERPRISE_TOKEN; a token there "takes precedence over previously stored credentials". Only with none set
  // does it ask its stored sign-in, which `gh auth login` keeps in the system's keyring by default where there is
  // one (the empty GH_CONFIG_DIR below does not reach that). So each of the four gets a value that is plainly not a
  // token: gh uses it, fails with a sign-in error, and never asks the keyring for his. git does not read these.
  for (const k of HIS_GIT_TOKENS) out[k] = BLANK_TOKEN;
  const dir = path.join(stateDir(), 'her-git-blank');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: tokenFolderMode(credsDir, file) });
  } catch {
    /* the state folder cannot be made: GH_CONFIG_DIR still names a folder of ours, not his own ~/.config/gh */
  }
  out.GH_CONFIG_DIR = dir;
  // When no helper answers, git over https asks GIT_ASKPASS, then core.askPass, then SSH_ASKPASS — any of which the
  // owner may have set to hand back his own password — and last the terminal. Turn them all off, so a session of hers
  // fails to sign in rather than reaching one of his.
  out.GIT_ASKPASS = '';
  out.SSH_ASKPASS = '';
  out.GIT_TERMINAL_PROMPT = '0';
  return withGitConfig(out, [
    [`credential.https://${host}.helper`, ''],
    ['core.askPass', ''],
  ]);
}

/**
 * The environment a session Tia started should carry. `byTia`: the session is hers, not his own. With a sign-in file
 * chosen that reads, she signs in to git and gh with that token in place of his; with one chosen that cannot be read,
 * his own git tokens are taken out (a mistake then reaches no sign-in, not his full rights) and `onProblem` is told
 * why; with no file chosen, or a session of his own, the environment is returned unchanged. A new environment.
 */
export function herSignedEnv(env, { byTia = false, cfg, credsDir, onProblem } = {}) {
  if (!byTia) return env;
  const file = herGitSigninFile(cfg);
  if (!file) return env; // everything as today: her sessions use his own sign-in
  let token;
  try {
    token = readHerToken(credsDir, file);
  } catch (e) {
    if (onProblem) onProblem(e.message);
    return herBlankSignin(env, { credsDir, file });
  }
  return herGitEnv(token, { base: env });
}

/**
 * The ONE thing the dashboard does when it starts a session of Tia's, so every path that starts one does BOTH halves
 * of her safety together and a new path cannot get one without the other:
 *   - it MARKS the run hers (hermark.mjs) — the mark src/hook.mjs sessionByTia reads to hold her administrator
 *     commands below Full as the owner's card; written by the dashboard alone, beside the handed hook settings, where
 *     a session cannot reach it;
 *   - it SIGNS the session in to the git server with the token the owner chose in place of his own (herSignedEnv);
 *     with no file chosen the sign-in is his, as today; with a chosen file that cannot be read his git tokens are
 *     taken out (a mistake then reaches no sign-in, never his full rights) and onProblem is told why.
 * Returns the environment the session should carry; the mark is a side effect. The caller passes the run's record
 * file (the mark and the handed settings share its basename). endAsHers removes the mark when the session ends;
 * removeRun (runs.mjs) also sweeps it, so a missed end still cleans up.
 */
export function startAsHers(runFile, env, { cfg, credsDir, onProblem } = {}) {
  markHers(runFile);
  return herSignedEnv(env, { byTia: true, cfg, credsDir, onProblem });
}

/** The session of `runFile` has ended: its Tia mark goes (removeRun sweeps it too). */
export function endAsHers(runFile) {
  unmarkHers(runFile);
}

/** The check's answer in plain lines for the owner's page (and the test). Never holds the token. */
export function checkWords(result) {
  if (!result.accepted) return [result.error || 'the git server did not answer'];
  const lines = [result.canDelete === true ? 'This token can delete a repository.'
    : result.canDelete === false ? 'This token cannot delete a repository.'
      : 'Whether this token can delete a repository is not known (it may be a fine-grained token; check its rights on the git server).'];
  // The safe state keeps the word "blocked"; the dangerous state (no rule stops it) is stated in the affirmative, so
  // someone who is not a programmer reads the risk at a glance instead of a reassuring "not blocked".
  const rule = (what, state) =>
    state === 'blocked' ? `a rule blocks ${what}`
      : state === 'not blocked' ? `${what} is allowed (no rule blocks it)`
        : `whether ${what} is blocked is not known`;
  for (const r of result.repos) {
    if (!r.known) lines.push(r.why ? `${r.ref}: not known (${r.why}).` : `${r.ref}: not known.`);
    else lines.push(`${r.ref} — default branch "${r.branch}": ${rule('a forced push', r.forcePush)}; ${rule('deleting the branch', r.branchDelete)}.`);
  }
  return lines;
}
