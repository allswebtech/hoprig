// Everything hoprig knows about the Claude Code installation: which version is installed and where, how it was
// installed, the newest version, updating, installing (or switching to) a version, and whether an account is
// logged in. The dashboard and `hoprig setup / doctor / claude` all use this one module.
//
// Where each command comes from (read again before changing any of them; checked against Claude Code 2.1.325):
//   install, macOS / Linux / WSL   curl -fsSL https://claude.ai/install.sh | bash [-s stable|latest|VERSION]
//   install, Windows PowerShell    irm https://claude.ai/install.ps1 | iex  (a version: the script's first argument)
//                                  https://code.claude.com/docs/en/setup  (sections "Install", "Install a specific
//                                  version"). We download the same script over https to a temporary file and run
//                                  it with bash / PowerShell, which is what the pipe does, minus the pipe.
//   update                         claude update   https://code.claude.com/docs/en/setup ("Update Claude Code");
//                                  `claude update --help`: "package-manager installs update through the package
//                                  manager", so it is the right command for every install method.
//   one version (native install)   claude install <stable|latest|VERSION>
//                                  https://code.claude.com/docs/en/cli-reference ("claude install")
//   one version (npm install)      npm install -g @anthropic-ai/claude-code@<VERSION>
//                                  https://code.claude.com/docs/en/setup ("Install with npm")
//   login state                    claude auth status   JSON by default, exit code 0 when logged in, 1 when not;
//                                  `authMethod` is none | claude.ai | oauth_token | api_key | api_key_helper |
//                                  third_party.  https://code.claude.com/docs/en/cli-reference ("claude auth status")
//   log in                         claude auth login    same page ("claude auth login"); /login inside a session
//                                  does the same (https://code.claude.com/docs/en/authentication)
//   newest version                 https://downloads.claude.ai/claude-code-releases/latest, a plain-text version,
//                                  the file the official installer reads (https://claude.ai/install.sh) and the
//                                  address https://code.claude.com/docs/en/troubleshoot-install checks. The same
//                                  folder has a `stable` file for the stable channel (not named in the docs: it is
//                                  used only when the user chose that channel). npm installs ask the npm registry.
//   channel                        "autoUpdatesChannel": "latest" | "stable" in ~/.claude/settings.json
//                                  https://code.claude.com/docs/en/setup ("Configure release channel")
//   native install location        ~/.local/bin/claude -> ~/.local/share/claude/versions/<version>
//                                  (%USERPROFILE%\.local\bin\claude.exe on Windows)  https://code.claude.com/docs/en/setup
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { claudeDir } from './paths.mjs';
import { clearLimited, limitedProfiles } from './autoswitch.mjs';
import { listProfiles } from './profiles.mjs';
import { withoutSecrets } from './secretenv.mjs';
import { forgetUsage, rememberLogin } from './routerstate.mjs';
import { capture, compareVersions, npmArgv, stream, which } from './setup/system.mjs';

export const INSTALL_SH = 'https://claude.ai/install.sh';
export const INSTALL_PS1 = 'https://claude.ai/install.ps1';
export const RELEASES = 'https://downloads.claude.ai/claude-code-releases';
export const NPM_PACKAGE = '@anthropic-ai/claude-code';
export const REGISTRY = 'https://registry.npmjs.org';

/** What the official installer accepts as its argument (same pattern as the script itself). */
export const TARGET_RE = /^(stable|latest|\d+\.\d+\.\d+(-[^\s]+)?)$/;
const VERSION_RE = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

const LOOKUP_TTL_MS = 5 * 60_000;
const LOOKUP_FAIL_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 6000;

/** The environment Claude Code commands run with (its installer, update, version, sign-in status): without any
 * secret (./secretenv.mjs), so the answer is about the login stored on this machine (what the default "sub"
 * profile uses), and an installer script sees no key. */
export function cleanEnv(base = process.env) {
  return withoutSecrets(base);
}

/** Where the official native installer puts the launcher (see the header). */
export function nativeBinPath(platform = process.platform, home = os.homedir()) {
  return path.join(home, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude');
}

/** The configured Claude Code program; the default name when the settings file cannot be read (doctor says why). */
function configuredBin() {
  try {
    return loadConfig().claudeBin || 'claude';
  } catch {
    return 'claude';
  }
}

/**
 * The Claude Code program to use: the configured `claudeBin` found on PATH, else (for the default name) the
 * native installer's location even when that folder is not on PATH yet. { path, onPath } or null.
 */
export function resolveClaude({ bin = configuredBin(), env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const found = which(bin, env, platform);
  if (found) return { path: found, onPath: !bin.includes('/') && !bin.includes('\\') };
  if (bin === 'claude') {
    const native = nativeBinPath(platform, home);
    if (which(native, env, platform)) return { path: native, onPath: false };
  }
  return null;
}

/** How Claude Code was installed, from the real path of its program. */
export function methodOf(realPath) {
  const p = String(realPath || '').replace(/\\/g, '/');
  if (/\/\.local\/share\/claude\/versions\//.test(p)) return 'native';
  if (/\/node_modules\/@anthropic-ai\/claude-code(\/|$)/.test(p)) return 'npm';
  return 'unknown';
}

/**
 * The version of the Claude Code at `realPath`, read from where it lives and without starting it: the native
 * install names its program by its version (…/claude/versions/2.1.325), an npm install has its package.json a
 * few folders up. null when the place does not tell.
 */
export function versionFromPath(realPath, readFile = (f) => fs.readFileSync(f, 'utf8')) {
  const p = String(realPath || '').replace(/\\/g, '/');
  const native = /\/claude\/versions\/(\d+\.\d+\.\d+)(?:\.exe)?(?:\/|$)/.exec(p);
  if (native) return native[1];
  const npm = /^(.*\/node_modules\/@anthropic-ai\/claude-code)(?:\/|$)/.exec(p);
  if (!npm) return null;
  try {
    const v = JSON.parse(readFile(`${npm[1]}/package.json`)).version;
    return typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The installed Claude Code's version without running it (see versionFromPath), or null. For the launcher. */
export function claudeVersionQuick({ bin = configuredBin(), env = process.env } = {}) {
  try {
    const found = resolveClaude({ bin, env });
    return found ? versionFromPath(fs.realpathSync(found.path)) : null;
  } catch {
    return null;
  }
}

/** "2.1.325 (Claude Code)" -> "2.1.325"; null when the text has no version. */
export function parseClaudeVersion(text) {
  const m = VERSION_RE.exec(String(text || ''));
  return m ? m[0] : null;
}

/** The release channel the user chose for Claude Code's own updates: 'latest' (default) or 'stable'. */
export function readChannel(dir = claudeDir()) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    return s && s.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';
  } catch {
    return 'latest';
  }
}

/**
 * The channel an install follows. Homebrew's `claude-code` cask follows stable and `claude-code@latest` latest
 * (https://code.claude.com/docs/en/setup, "Homebrew"); everything else follows the user's setting.
 */
export function channelFor(realPath, configured = 'latest') {
  const p = String(realPath || '').replace(/\\/g, '/');
  if (/\/Caskroom\/claude-code@latest\//.test(p)) return 'latest';
  if (/\/Caskroom\/claude-code\//.test(p)) return 'stable';
  return configured;
}

/** Where to ask for the newest version: { kind: 'text' | 'npm', url }. */
export function latestSource(method, channel = 'latest') {
  const ch = channel === 'stable' ? 'stable' : 'latest';
  if (method === 'npm') return { kind: 'npm', url: `${REGISTRY}/-/package/${NPM_PACKAGE}/dist-tags`, tag: ch };
  return { kind: 'text', url: `${RELEASES}/${ch}` };
}

/** The releases file holds one version and nothing else; anything else (an error page) is no answer. */
export function parseLatestText(text) {
  const t = String(text || '').trim();
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(t) ? t : null;
}

/** The registry's dist-tags answer ({ latest, stable, next }) -> the version for the channel, or null. */
export function parseRegistryTags(json, tag = 'latest') {
  let o = json;
  if (typeof json === 'string') {
    try {
      o = JSON.parse(json);
    } catch {
      return null;
    }
  }
  const v = o && typeof o === 'object' ? o[tag] || (tag === 'stable' ? o.latest : null) : null;
  return typeof v === 'string' && parseLatestText(v) ? v : null;
}

// One cache per fetch function: a caller that looks "offline" on purpose (a stand-in fetch that always fails, as the
// onboarding check passes) must not leave its "unknown" in the cache that the real lookups read.
let lookupCaches = new WeakMap();
const cacheFor = (fetchImpl) => {
  if (!lookupCaches.has(fetchImpl)) lookupCaches.set(fetchImpl, new Map());
  return lookupCaches.get(fetchImpl);
};

/** Forget cached lookups (after an update, and in tests). */
export function clearLatestCache() {
  lookupCaches = new WeakMap();
}

/** The newest version for this install method and channel, or null when it cannot be found out. Cached, except when
 * `fresh` (Check now: the owner asked to look again). */
export async function latestVersion(method, channel, { fetchImpl = globalThis.fetch, now = Date.now(), fresh = false } = {}) {
  const src = latestSource(method, channel);
  const key = `${src.url}#${src.tag || ''}`;
  const lookupCache = cacheFor(fetchImpl);
  const hit = lookupCache.get(key);
  if (!fresh && hit && now - hit.at < (hit.value ? LOOKUP_TTL_MS : LOOKUP_FAIL_TTL_MS)) return hit.value;
  let value = null;
  try {
    const res = await fetchImpl(src.url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), headers: { accept: src.kind === 'npm' ? 'application/json' : 'text/plain' } });
    if (res.ok) {
      const body = await res.text();
      value = src.kind === 'npm' ? parseRegistryTags(body, src.tag) : parseLatestText(body);
    }
  } catch {
    value = null; // offline, DNS, timeout: we say "unknown", never guess
  }
  lookupCache.set(key, { at: now, value });
  return value;
}

async function installedVersion(file, env) {
  const r = await capture([file, '--version'], { env, timeout: 15_000 });
  return r.ok ? parseClaudeVersion(r.stdout || r.stderr) : null;
}

/**
 * { installed, path, latest, method, updateAvailable }. `installed` and `path` are null when Claude Code is not
 * found; `latest` is null when it cannot be looked up (offline).
 */
export async function claudeInfo({ env = process.env, fetchImpl, fresh = false } = {}) {
  const found = resolveClaude({ env });
  let installed = null;
  let method = 'unknown';
  let real = null;
  if (found) {
    installed = await installedVersion(found.path, cleanEnv(env));
    real = found.path;
    try {
      real = fs.realpathSync(found.path);
    } catch {
      /* keep the path we have */
    }
    method = methodOf(real);
  }
  const latest = await latestVersion(method, channelFor(real, readChannel()), { fetchImpl, fresh });
  return {
    installed,
    path: found ? found.path : null,
    latest,
    method,
    updateAvailable: !!(installed && latest && compareVersions(latest, installed) > 0),
  };
}

/**
 * How to run the official installer that was saved to `file`: argv for this OS. `target` is optional
 * (stable | latest | a version).
 */
export function installerArgv({ platform = process.platform, file, target } = {}) {
  if (target != null && !TARGET_RE.test(target)) throw new Error(`"${target}" is not a version (like 2.1.89), "stable" or "latest"`);
  const extra = target ? [target] : [];
  if (platform === 'win32') return ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...extra];
  return ['bash', file, ...extra];
}

/** The installer script's address for this OS. */
export const installerUrl = (platform = process.platform) => (platform === 'win32' ? INSTALL_PS1 : INSTALL_SH);

/**
 * How to switch an existing install to `version`: an argv, or { error } when this install is managed by
 * something we should not go around (Homebrew, WinGet, apt...).
 */
export function versionPlan({ method, bin, version, platform = process.platform }) {
  if (!TARGET_RE.test(String(version || ''))) return { error: `"${version}" is not a version (like 2.1.89), "stable" or "latest".` };
  if (method === 'native') return { argv: [bin, 'install', version] };
  if (method === 'npm') return { argv: npmArgv(['install', '-g', `${NPM_PACKAGE}@${version}`], platform) };
  return {
    error:
      'This Claude Code was installed by a package manager (for example Homebrew, WinGet or apt). ' +
      'Change its version with that package manager, or remove it and install the official build with: hoprig claude install ' + version,
  };
}

/** Download the official installer script over https into a fresh temporary folder. Returns its path. */
export async function downloadInstaller({ platform = process.platform, fetchImpl = globalThis.fetch } = {}) {
  const url = installerUrl(platform);
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`could not download ${url}: HTTP ${res.status}`);
  if (res.url && !res.url.startsWith('https://')) throw new Error(`${url} redirected to a non-https address; not running it`);
  const text = await res.text();
  if (platform !== 'win32' && !text.startsWith('#!')) throw new Error(`${url} did not return an installer script`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-claude-'));
  const file = path.join(dir, platform === 'win32' ? 'install.ps1' : 'install.sh');
  fs.writeFileSync(file, text, { mode: 0o700 });
  return file;
}

async function runInstaller(target, { onLine = () => {}, env = process.env, platform = process.platform, fetchImpl } = {}) {
  let file;
  const lines = [];
  const say = (l) => {
    lines.push(l);
    onLine(l);
  };
  try {
    file = await downloadInstaller({ platform, fetchImpl });
  } catch (e) {
    say(e.message);
    return { ok: false, version: null, output: lines.join('\n') };
  }
  try {
    const argv = installerArgv({ platform, file, target });
    const r = await stream(argv, { env: cleanEnv(env), onLine: say });
    clearLatestCache();
    const found = resolveClaude({ env, platform });
    const version = found ? await installedVersion(found.path, cleanEnv(env)) : null;
    return { ok: r.ok && !!version, version, output: lines.join('\n') };
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

/** Install Claude Code the officially documented way for this OS (the native installer). */
export function claudeInstall({ onLine } = {}) {
  return runInstaller(undefined, { onLine });
}

/**
 * Install one version (or channel: stable | latest). With Claude Code already installed natively this is
 * `claude install <version>`; with an npm install it is npm; with nothing installed, the official installer.
 */
export async function claudeInstallVersion(version, { onLine = () => {} } = {}) {
  if (!TARGET_RE.test(String(version || ''))) {
    const output = `"${version}" is not a version (like 2.1.89), "stable" or "latest".`;
    onLine(output);
    return { ok: false, version: null, output };
  }
  const found = resolveClaude();
  if (!found) return runInstaller(version, { onLine });
  let real = found.path;
  try {
    real = fs.realpathSync(found.path);
  } catch {
    /* keep */
  }
  const plan = versionPlan({ method: methodOf(real), bin: found.path, version });
  if (plan.error) {
    onLine(plan.error);
    return { ok: false, version: await installedVersion(found.path, cleanEnv(process.env)), output: plan.error };
  }
  const r = await stream(plan.argv, { env: cleanEnv(process.env), onLine });
  clearLatestCache();
  const now = await installedVersion(found.path, cleanEnv(process.env));
  return { ok: r.ok, version: now, output: r.output };
}

/** `claude update`. Works for native, npm and package-manager installs alike (see the header). */
export async function claudeUpdate({ onLine = () => {} } = {}) {
  const found = resolveClaude();
  if (!found) {
    const output = 'Claude Code is not installed. Install it with: hoprig claude install latest';
    onLine(output);
    return { ok: false, version: null, output };
  }
  const r = await stream([found.path, 'update'], { env: cleanEnv(process.env), onLine });
  clearLatestCache();
  return { ok: r.ok, version: await installedVersion(found.path, cleanEnv(process.env)), output: r.output };
}

/**
 * Read `claude auth status` (JSON; exit 0 = logged in, 1 = not). Returns { loggedIn: true|false|null, method, plan }.
 * null means "could not tell" (an old Claude Code without `auth status`, or an answer we do not understand).
 * Only the login method and the plan type ("pro", "max", "team", …: it decides whether usage figures exist) are
 * kept. The answer also names the account (e-mail, organisation): that part is read by parseAuthAccount, and only
 * for the owner's own page (claudeAccount).
 */
export function parseAuthStatus({ code, stdout }) {
  let j = null;
  try {
    j = JSON.parse(String(stdout || '').trim());
  } catch {
    j = null;
  }
  const method = j && typeof j.authMethod === 'string' ? j.authMethod : null;
  const plan = j && typeof j.subscriptionType === 'string' && /^[a-z0-9_-]{1,32}$/i.test(j.subscriptionType) ? j.subscriptionType.toLowerCase() : null;
  if (j && typeof j.loggedIn === 'boolean') return { loggedIn: j.loggedIn, method, plan: j.loggedIn ? plan : null };
  if (code === 0 && j) return { loggedIn: method !== 'none', method, plan: method !== 'none' ? plan : null };
  if (code === 1 && j) return { loggedIn: false, method, plan: null };
  return { loggedIn: null, method, plan: null };
}

const oneLine = (v, max) => (typeof v === 'string' && v.trim() ? v.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max) : null);

/**
 * Who is signed in, from the same answer (Claude Code 2.1.325: "email", "orgName", "orgId"): { email, org, id }.
 * `id` tells one account from another (address and organisation); routerstate.mjs keeps only a salted fingerprint
 * of it, for noticing that another account signed in. All null when the answer names nobody (not signed in, an API
 * key, an older Claude Code).
 */
export function parseAuthAccount(stdout) {
  let j = null;
  try {
    j = JSON.parse(String(stdout || '').trim());
  } catch {
    j = null;
  }
  const email = j && j.loggedIn !== false ? oneLine(j.email, 200) : null;
  const org = j && j.loggedIn !== false ? oneLine(j.orgName, 120) : null;
  const orgId = j && j.loggedIn !== false ? oneLine(j.orgId, 80) : null;
  const who = [email, orgId || org].filter(Boolean);
  return { email, org, id: who.length ? who.join('\n').toLowerCase() : null };
}

/**
 * Another account is signed in than the last one seen: what was known about the earlier one's limits no longer
 * holds for the providers that use the stored sign-in. Their limit marks and usage figures go.
 */
function accountChanged() {
  for (const p of listProfiles()) {
    if (p.kind !== 'login') continue;
    try {
      clearLimited(p.name);
      forgetUsage(p.name);
    } catch {
      /* a state folder that cannot be written must not break a check */
    }
  }
}

async function askAuthStatus(env, remember) {
  const found = resolveClaude({ env });
  if (!found) return { s: { loggedIn: null, method: null, reason: 'Claude Code is not installed' }, account: { email: null, org: null, id: null }, changed: false };
  const r = await capture([found.path, 'auth', 'status', '--json'], { env: cleanEnv(env), timeout: 20_000 });
  const s = parseAuthStatus(r);
  const account = parseAuthAccount(r.stdout);
  // The answer is kept for the page (routerstate.mjs: providerFacts), which must not start a program per request.
  // `remember: false` for a run that may change nothing at all (setup --dry-run).
  let changed = false;
  if (remember) {
    try {
      ({ changed } = rememberLogin({ ...s, account: account.id }));
      if (changed) accountChanged();
    } catch {
      /* the answer still stands */
    }
  }
  return { s: s.loggedIn === null ? { ...s, reason: 'this Claude Code cannot report its login (update it)' } : s, account, changed };
}

/** Is an account logged in on this machine (the stored login, without any profile's variables)? */
export async function claudeLoginStatus({ env = process.env, remember = true } = {}) {
  return (await askAuthStatus(env, remember)).s;
}

/**
 * Notice soon that the stored sign-in changed outside the page — /login or /logout typed in a session, `claude auth
 * login` in a terminal — instead of at the half-hourly check: until the check runs, the earlier account's limit mark
 * stays, Home says "at its limit", and Auto mode passes the provider by. `check()` is cheap and meant to be called
 * every few seconds: it only looks at the modification time of Claude Code's credentials file (Linux and Windows
 * keep the sign-in there; Hoprig never reads it) and asks `claude auth status` (`ask`) once when it changed. Where
 * there is no such file (macOS keeps the sign-in in the Keychain, or nobody is signed in) a change cannot be seen,
 * so while a provider on the stored sign-in has a limit mark it asks every `blindEveryMs` (5 minutes) instead.
 * A token refresh rewrites the file as well; that costs one check, which finds the same account and clears nothing.
 */
export function signInWatch({
  file = path.join(claudeDir(), '.credentials.json'),
  ask = () => claudeLoginStatus(),
  marked = storedSignInMarked,
  platform = process.platform,
  now = Date.now,
  blindEveryMs = 5 * 60_000,
} = {}) {
  let asking = null;
  let askedAt = now(); // the server asks once at start anyway
  const look = () => {
    try {
      const st = fs.statSync(file);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return null;
    }
  };
  let last = look(); // what the file looked like at the last look; a change from now on counts
  const run = async () => {
    askedAt = now();
    try {
      await ask();
    } catch {
      /* the next change or the half-hourly check asks again */
    }
    last = look(); // what the check itself wrote (a refreshed token) is not another change
    asking = null;
  };
  return {
    check() {
      if (asking) return asking;
      const seen = look();
      const changed = seen !== last;
      last = seen;
      let due = false;
      if (!changed && (platform === 'darwin' || seen === null) && now() - askedAt >= blindEveryMs) {
        try {
          due = marked();
        } catch {
          due = false;
        }
      }
      return changed || due ? (asking = run()) : Promise.resolve();
    },
  };
}

/** A provider that uses the stored sign-in has a limit mark. */
function storedSignInMarked() {
  const marks = limitedProfiles();
  return listProfiles().some((p) => p.kind === 'login' && marks[p.name]);
}

/**
 * The same check with who is signed in: { loggedIn, method, plan, email, org, changed }. `changed`: another account
 * than the last one seen (its providers' limit marks and figures were cleared just now). For the owner's own page
 * only: nothing else may pass the address on, and it is never written to a file or a log.
 */
export async function claudeAccount({ env = process.env } = {}) {
  const { s, account, changed } = await askAuthStatus(env, true);
  return { ...s, email: s.loggedIn ? account.email : null, org: s.loggedIn ? account.org : null, changed };
}

/**
 * Sign out (`claude auth logout`; 2.1.325 prints one line and exits 0, signed in or not). Claude Code removes the
 * stored sign-in and what else it saved with it. Returns { ok, error? }; the next sign-in check tells the rest.
 */
export async function claudeLogout({ env = process.env } = {}) {
  const found = resolveClaude({ env });
  if (!found) return { ok: false, error: 'Claude Code is not installed' };
  const r = await capture([found.path, 'auth', 'logout'], { env: cleanEnv(env), timeout: 30_000 });
  if (r.code === 0) return { ok: true };
  const said = String(r.stderr || r.stdout || '').trim().split('\n').pop() || '';
  return { ok: false, error: said.slice(0, 200) || `claude auth logout ended with code ${r.code}` };
}

/** Start the browser sign-in in this terminal (`claude auth login`). Interactive only. */
export async function claudeLogin() {
  const found = resolveClaude();
  if (!found) return { ok: false };
  const r = await stream([found.path, 'auth', 'login'], { env: cleanEnv(process.env), interactive: true });
  return { ok: r.ok };
}
