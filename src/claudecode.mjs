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
import { AUTH_VARS } from './profiles.mjs';
import { rememberLogin } from './routerstate.mjs';
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

/** The environment Claude Code commands run with: without the auth variables a profile may have set, so the
 * answer is about the login stored on this machine (what the default "sub" profile uses). */
export function cleanEnv(base = process.env) {
  const env = { ...base };
  for (const k of AUTH_VARS) delete env[k];
  return env;
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

const lookupCache = new Map();

/** Forget cached lookups (after an update, and in tests). */
export function clearLatestCache() {
  lookupCache.clear();
}

/** The newest version for this install method and channel, or null when it cannot be found out. Cached. */
export async function latestVersion(method, channel, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const src = latestSource(method, channel);
  const key = `${src.url}#${src.tag || ''}`;
  const hit = lookupCache.get(key);
  if (hit && now - hit.at < (hit.value ? LOOKUP_TTL_MS : LOOKUP_FAIL_TTL_MS)) return hit.value;
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
export async function claudeInfo({ env = process.env, fetchImpl } = {}) {
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
  const latest = await latestVersion(method, channelFor(real, readChannel()), { fetchImpl });
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
 * kept: the answer also carries the account's e-mail and organisation, which we never pass on.
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

/** Is an account logged in on this machine (the stored login, without any profile's variables)? */
export async function claudeLoginStatus({ env = process.env, remember = true } = {}) {
  const found = resolveClaude({ env });
  if (!found) return { loggedIn: null, method: null, reason: 'Claude Code is not installed' };
  const r = await capture([found.path, 'auth', 'status', '--json'], { env: cleanEnv(env), timeout: 20_000 });
  const s = parseAuthStatus(r);
  // The answer is kept for the page (routerstate.mjs: providerFacts), which must not start a program per request.
  // `remember: false` for a run that may change nothing at all (setup --dry-run).
  if (remember) rememberLogin(s);
  return s.loggedIn === null ? { ...s, reason: 'this Claude Code cannot report its login (update it)' } : s;
}

/** Start the browser sign-in in this terminal (`claude auth login`). Interactive only. */
export async function claudeLogin() {
  const found = resolveClaude();
  if (!found) return { ok: false };
  const r = await stream([found.path, 'auth', 'login'], { env: cleanEnv(process.env), interactive: true });
  return { ok: r.ok };
}
