// The checks `doctor` lists and `setup` acts on. Each returns { id, label, status, detail, fix }:
//   status  ok | fail (something needed is broken) | warn (works, but could be better) | info
//   fix     the exact command (or one plain sentence) that fixes it, or ''
// None of them changes anything, and none ever shows a secret: profiles appear as names and kinds only.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { claudeInfo, claudeLoginStatus } from '../claudecode.mjs';
import { ownEndpoint, ownEndpointWords, unreadSettings } from '../codetools/ownsettings.mjs';
import { loadConfig } from '../config.mjs';
import { binFile, configDir, configFile, profilesDir, stateDir, tilde } from '../paths.mjs';
import { anyTool, enabledToolIds } from '../codetools/index.mjs';
import { hiddenProfiles, listProfiles } from '../profiles.mjs';
import { ensureSpawnHelper } from '../server/backends/pty-helper.mjs';
import { tmuxNewEnough } from '../server/backends/tmuxversion.mjs';
import { MIN_NODE, MIN_NODE_TEXT } from '../nodefloor.mjs';
import { brainDir } from '../workspace/layout.mjs';
import { dormantReason, dormantWords, notOnServer, openHost, serverReason } from './server.mjs';
import { listensOtherwise, runningFacts, whereWords } from './running.mjs';
import { resolveListen } from '../server/serveopts.mjs';
import { capture, compareVersions, detectPackageManager, installCommands, isRoot, npmArgv, npmMajor, showCommand, showCommands, which } from './system.mjs';
import { rootCheck, rootFacts } from './rootfacts.mjs';

export const APP = 'hoprig';
export { MIN_NODE }; // src/nodefloor.mjs
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7433; // the same default as src/server/server.mjs
export const UNIT = `${APP}.service`;

/** The folder hoprig runs from (holds package.json). */
export const appRoot = () => path.resolve(path.dirname(binFile()), '..');

export function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appRoot(), 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

const result = (id, label, status, detail, fix = '') => ({ id, label, status, detail, fix });

/** The system facts a check may need. Tests pass their own. */
export function sysInfo(over = {}) {
  const env = over.env || process.env;
  const platform = over.platform || process.platform;
  const has = (cmd) => !!which(cmd, env, platform);
  return { env, platform, has, pm: detectPackageManager(platform, has), root: isRoot(), home: os.homedir(), ...over };
}

/** The command line that installs `packages` here, for a "fix" hint ('' when we cannot tell). */
export function installHint(sys, packages) {
  const cmds = sys.pm ? installCommands(sys.pm, packages, { root: sys.root }) : null;
  return cmds ? showCommands(cmds) : '';
}

/** Build tools node-pty needs to compile on Linux (it ships ready-made builds only for macOS and Windows). */
export const BUILD_TOOLS = {
  apt: ['build-essential', 'python3'],
  dnf: ['gcc-c++', 'make', 'python3'],
  yum: ['gcc-c++', 'make', 'python3'],
  pacman: ['base-devel', 'python'],
  zypper: ['gcc-c++', 'make', 'python3'],
  apk: ['build-base', 'python3', 'linux-headers'],
};

export function nodeCheck(version = process.versions.node) {
  const ok = compareVersions(version, MIN_NODE) >= 0;
  return result('node', 'Node.js', ok ? 'ok' : 'fail', `${version}${ok ? '' : ` (Hoprig needs ${MIN_NODE_TEXT} or newer)`}`,
    ok ? '' : `Install Node.js ${MIN_NODE_TEXT} or newer (https://nodejs.org), then run the Hoprig installer again.`);
}

export function appCheck() {
  return result('app', APP, 'ok', `${appVersion() || '?'} (${tilde(appRoot())})`);
}

export function configCheck() {
  if (!fs.existsSync(configFile())) return result('config', 'Settings file', 'info', `${tilde(configFile())} does not exist yet (defaults are used)`);
  try {
    loadConfig();
    return result('config', 'Settings file', 'ok', `${tilde(configFile())} is valid`);
  } catch (e) {
    return result('config', 'Settings file', 'fail', e.message, `Fix the JSON in ${configFile()}, or move it away and run: ${APP} setup`);
  }
}

/** The config, profiles and state folders: present, and private (only you may read them: they hold secrets). */
export function dirsCheck(platform = process.platform) {
  const out = [];
  for (const [id, label, dir] of [['dir-config', 'Settings folder', configDir()], ['dir-profiles', 'Profiles folder', profilesDir()], ['dir-state', 'State folder', stateDir()]]) {
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      out.push(result(id, label, 'info', `${tilde(dir)} not created yet`));
      continue;
    }
    if (platform === 'win32') {
      out.push(result(id, label, 'ok', tilde(dir)));
      continue;
    }
    const open = st.mode & 0o077;
    const mine = typeof process.getuid !== 'function' || st.uid === process.getuid();
    if (!mine) out.push(result(id, label, 'fail', `${tilde(dir)} belongs to another user`, `sudo chown -R "$(id -un)" ${showCommand([dir])}`));
    else if (open) out.push(result(id, label, 'warn', `${tilde(dir)} can be read by other users (mode ${(st.mode & 0o777).toString(8)})`, showCommand(['chmod', '700', dir])));
    else out.push(result(id, label, 'ok', `${tilde(dir)} (private)`));
  }
  return out;
}

/** Claude Code installed? Which version, how, and is there a newer one? `info` is from claudeInfo(). */
export function claudeCheck(info, { onPath = true } = {}) {
  if (!info.installed) {
    if (info.path) return result('claude', 'Claude Code', 'fail', `${tilde(info.path)} does not run`, `${APP} claude install latest`);
    return result('claude', 'Claude Code', 'fail', 'not installed', `${APP} setup   (or: ${APP} claude install latest)`);
  }
  const how = { native: 'official installer', npm: 'npm', unknown: 'a package manager' }[info.method];
  const latest = info.latest ? (info.updateAvailable ? `, ${info.latest} is available` : ', the newest') : ', newest version unknown (offline?)';
  if (!onPath) {
    return result('claude', 'Claude Code', 'warn', `${info.installed} at ${tilde(info.path)} (${how}), but its folder is not on PATH`,
      `Add ${path.dirname(info.path)} to PATH, or run: ${APP} setup (it can remember the full path)`);
  }
  if (info.updateAvailable) return result('claude', 'Claude Code', 'warn', `${info.installed} (${how})${latest}`, `${APP} claude update`);
  return result('claude', 'Claude Code', 'ok', `${info.installed} (${how})${latest}`);
}

/**
 * Logged in? Only needed when some profile uses the stored login (kind "login") or there is no profile yet:
 * subscription-token and API profiles bring their own credentials.
 */
export function loginCheck(status, profiles) {
  const needsLogin = !profiles.length || profiles.some((p) => p.kind === 'login');
  if (status.loggedIn === true) return result('login', 'Claude login', 'ok', `logged in (${status.method || 'account'})`);
  const fix = 'claude   (then type /login; or: claude auth login)';
  // `action`: the page signs in from the row itself (src/server/claudelogin.mjs); the fix stays for the terminal.
  if (status.loggedIn === false) return { ...result('login', 'Claude login', needsLogin ? 'fail' : 'warn', 'not logged in', fix), action: 'claude-login' };
  return result('login', 'Claude login', needsLogin ? 'warn' : 'info', `unknown: ${status.reason || 'no answer'}`, status.reason === 'Claude Code is not installed' ? '' : fix);
}

export function profilesCheck(profiles, hidden = []) {
  // A provider file named like a command (codex, opencode, tools…) is not listed: say so, and how to rename it.
  if (hidden.length) {
    const n = hidden[0];
    return result('profiles', 'Profiles', 'warn', `${hidden.map((x) => `"${x}"`).join(', ')} ${hidden.length === 1 ? 'is a command word now, so that provider is' : 'are command words now, so those providers are'} not used`,
      showCommand(['mv', path.join(profilesDir(), `${n}.env`), path.join(profilesDir(), `${n}-provider.env`)]));
  }
  if (!profiles.length) return result('profiles', 'Profiles', 'warn', 'none yet (the first start creates "sub" for your login)', `${APP} setup   (or: ${APP} add)`);
  return result('profiles', 'Profiles', 'ok', profiles.map((p) => `${p.name} (${p.kind})`).join(', '));
}

/**
 * The shared rules file reaches every coding tool, but only Claude Code follows its "@path" import lines: OpenCode
 * (and Codex) read the line as text, so what it points to never reaches them. Said when another coding tool is on and
 * the file has such lines; nothing otherwise (no brain, only Claude Code).
 */
export function sharedRulesCheck({ tools = [], file = path.join(brainDir(), 'claude', 'CLAUDE.md') } = {}) {
  const others = tools.filter((id) => id !== 'claude').map((id) => (anyTool(id) || { name: id }).name); // doctor passes the offered ones
  if (!others.length) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const imports = text.split('\n').filter((l) => /^\s*@[\w./~-]/.test(l)).map((l) => l.trim());
  if (!imports.length) return result('rules', 'Shared rules', 'ok', `one file for Claude Code and ${others.join(' and ')}`);
  return result('rules', 'Shared rules', 'warn',
    `${imports.length} import line${imports.length === 1 ? '' : 's'} (${imports.slice(0, 2).join(', ')}${imports.length > 2 ? ', …' : ''}) in ${tilde(file)}: only Claude Code follows them, ${others.join(' and ')} do not`,
    'Put what every coding tool needs into the file itself; keep imports for what only Claude Code needs.');
}

/** Which terminal the dashboard uses: tmux when it is installed and new enough (sessions survive a dashboard
 * restart), else its built-in one. Information only: both work. */
export async function terminalCheck(sys) {
  const file = sys.platform === 'win32' ? null : which('tmux', sys.env, sys.platform);
  if (!file) return result('terminal', 'Terminal', 'info', 'built-in');
  const version = (await capture([file, '-V'], { env: sys.env })).stdout.trim();
  if (!tmuxNewEnough(version)) return result('terminal', 'Terminal', 'info', `built-in (${version} is too old: tmux sessions need 3.2 or newer)`);
  return result('terminal', 'Terminal', 'info', version || 'tmux', '');
}

/** Try the terminal module for real: load it and run one tiny program in a terminal. */
export async function ptyWorks() {
  const { nodePty: pty, nodePtyError } = await import('../server/backends/nodepty.mjs');
  if (!pty) return { ok: false, why: `it does not load (${nodePtyError})` };
  try {
    ensureSpawnHelper(); // as the dashboard does before its first spawn: a fresh install leaves the helper not executable
    const p = pty.spawn(process.execPath, ['-e', ''], { cols: 40, rows: 5, env: process.env });
    const code = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('timeout'), 5000);
      p.onExit(({ exitCode }) => {
        clearTimeout(t);
        resolve(exitCode);
      });
    });
    return code === 0 ? { ok: true } : { ok: false, why: `a test program did not run (${code})` };
  } catch (e) {
    return { ok: false, why: `it cannot start a program (${String(e.message).split('\n')[0]})` };
  }
}

/**
 * The same check in a new Node process: this one loaded the module once and keeps that answer
 * (backends/nodepty.mjs), so after the module was built only a new process can tell whether it works now.
 */
export async function ptyWorksNow() {
  const code = `const m = await import(${JSON.stringify(import.meta.url)}); process.stdout.write(JSON.stringify(await m.ptyWorks()));`;
  const r = await capture([process.execPath, '--input-type=module', '-e', code], { timeout: 30_000 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return { ok: false, why: 'the check could not be run again' };
  }
}

/**
 * What is on disk of the terminal module. It has ready-made builds for macOS and Windows; on Linux its install
 * script compiles it.
 *   absent    no node-pty folder: npm up to 11 leaves an optional module out when its build fails, which is what
 *             happens without a C++ compiler
 *   unbuilt   the folder is there and nothing was ever built: its install script did not run. npm 12 and newer do
 *             not run a dependency's install script until it is allowed, and never in a plain `npm install -g`
 *   failed    a build was started and left no module
 *   present   a module for this computer is there (when it still does not work, the cause is something else)
 */
export function ptyState(root = appRoot(), platform = process.platform, arch = process.arch) {
  let dir;
  try {
    dir = path.dirname(createRequire(path.join(root, 'package.json')).resolve('node-pty/package.json'));
  } catch {
    return 'absent';
  }
  const has = (...p) => fs.existsSync(path.join(dir, ...p));
  if (has('build', 'Release', 'pty.node') || has('build', 'Release', 'conpty.node') || has('prebuilds', `${platform}-${arch}`)) return 'present';
  return has('build') ? 'failed' : 'unbuilt';
}

/** The cause in plain words for a state of ptyState(), or '' when the folder does not tell. */
export function ptyCause(state, major = null) {
  if (state === 'absent') return 'it is not installed: npm leaves it out when it cannot be built, and that needs the C++ build tools';
  if (state === 'unbuilt') {
    return major >= 12
      ? `it was installed but never built: npm ${major} does not run the install script of a dependency until it is allowed`
      : 'it was installed but never built: its install script did not run';
  }
  if (state === 'failed') return 'building it did not succeed';
  return '';
}

/**
 * The npm command that builds the terminal module, run in hoprig's own folder: its package.json allows the
 * install script of exactly the node-pty version it pins, which is what npm 12 asks for. A module that is not
 * there at all has to be installed (`npm rebuild` only builds what is there).
 */
export function ptyRepairArgv(state, platform = process.platform, env = process.env) {
  return npmArgv(state === 'absent' ? ['install', '--omit=dev', '--no-audit', '--no-fund'] : ['rebuild', 'node-pty'], platform, env);
}

/** Are the tools there that node-pty compiles with on Linux? */
export const hasBuildTools = (sys) => typeof sys.has === 'function' && sys.has('make') && (sys.has('g++') || sys.has('c++')) && sys.has('python3');

/** The one command line that makes node-pty work, per OS and for what is on disk (ptyState). */
export function ptyFix(sys, root = appRoot(), state = 'unbuilt') {
  const build = `${showCommand(['cd', root])} && ${state === 'absent' ? 'npm install --omit=dev' : 'npm rebuild node-pty'}`;
  if (sys.platform === 'darwin') return `xcode-select --install && ${build}`;
  if (sys.platform === 'win32') return `cd "${root}" && npm install`;
  if (hasBuildTools(sys)) return build;
  const tools = sys.pm && BUILD_TOOLS[sys.pm] ? installHint(sys, BUILD_TOOLS[sys.pm]) : 'Install a C++ compiler, make and python3';
  return `${tools} && ${build}`;
}

/**
 * The terminal module for doctor. Without it no terminal opens in the browser. With tmux the sessions still run
 * and take messages, so it is a warning there; without tmux (and on Windows, which has none) nothing can start.
 * `o.state` and `o.npm` (npm's major version) are looked up when not given.
 */
export async function ptyCheck(sys, { tmux, state, npm } = {}, works = ptyWorks) {
  const r = await works();
  if (r.ok) return result('pty', 'Terminal module (node-pty)', 'ok', 'loads and runs');
  state ??= ptyState();
  if (state === 'unbuilt' && npm === undefined) npm = await npmMajor({ env: sys.env, platform: sys.platform });
  const why = ptyCause(state, npm) || r.why;
  const needed = sys.platform === 'win32' || !tmux;
  const detail = needed ? why : `no terminal can open in the browser (sessions still run in tmux and take messages): ${why}`;
  return result('pty', 'Terminal module (node-pty)', needed ? 'fail' : 'warn', detail, ptyFix(sys, appRoot(), state));
}

export async function passwordCheck() {
  let has = false;
  try {
    has = (await import('../server/server.mjs')).hasPassword();
  } catch {
    has = false;
  }
  return has
    ? result('password', 'Dashboard password', 'ok', 'set')
    : result('password', 'Dashboard password', 'fail', 'not set (the dashboard will not start without one)', `${APP} passwd`);
}

/** Can systemd user services run here (Linux with a user systemd: not in most containers)? */
export async function systemdUser(sys) {
  if (sys.platform !== 'linux' || !sys.has('systemctl')) return false;
  const r = await capture(['systemctl', '--user', 'show-environment'], { env: sys.env, timeout: 5000 });
  return r.ok;
}

/** Is the background service installed (Linux: systemd user unit; macOS: LaunchAgent; Windows: scheduled task)? */
export async function serviceInstalled(sys) {
  try {
    if (sys.platform === 'linux') return fs.existsSync(path.join(sys.env.XDG_CONFIG_HOME || path.join(sys.home, '.config'), 'systemd', 'user', UNIT));
    if (sys.platform === 'darwin') return fs.existsSync((await import('../server/service/launchd.mjs')).plistFile(sys.home));
    if (sys.platform === 'win32') return fs.existsSync((await import('../server/service/windows.mjs')).scriptFile());
  } catch {
    /* the service modules could not load: not installed as far as we can tell */
  }
  return false;
}

export async function serviceCheck(sys) {
  const label = 'Background service';
  if (sys.platform === 'linux') {
    if (!(await systemdUser(sys))) return result('service', label, 'info', 'systemd user services are not available here: start the dashboard with hoprig serve');
    const r = await capture(['systemctl', '--user', 'is-active', UNIT], { env: sys.env, timeout: 5000 });
    const state = r.stdout.trim() || 'unknown';
    if (state === 'active') return result('service', label, 'ok', 'running (systemd user service)');
    if (!(await serviceInstalled(sys))) return result('service', label, 'warn', 'not installed', `${APP} service install`);
    return result('service', label, 'warn', `installed but ${state}`, `${APP} service install   (then: ${APP} service status)`);
  }
  if (sys.platform !== 'darwin' && sys.platform !== 'win32') return result('service', label, 'info', `not available on ${sys.platform}: start the dashboard with hoprig serve`);
  if (await serviceInstalled(sys)) return result('service', label, 'ok', `installed (${sys.platform === 'darwin' ? 'LaunchAgent' : 'scheduled task'}, starts with your login)`);
  return result('service', label, 'warn', 'not installed', `${APP} service install`);
}

/** GET /login on the dashboard address. Resolves to the HTTP status, or an error code such as ECONNREFUSED. */
export function probe(host, port, timeout = 2500) {
  const h = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  return new Promise((resolve) => {
    const req = http.get({ host: h, port, path: '/login', timeout }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => resolve(e.code || 'error'));
  });
}

export async function portCheck(host, port, doProbe = probe) {
  const r = await doProbe(host, port);
  const where = `${host}:${port}`;
  if (r === 200) return result('port', 'Dashboard', 'ok', `answers on ${where}`);
  if (r === 'ECONNREFUSED') return result('port', 'Dashboard', 'warn', `not running on ${where}`, `${APP} serve   (or in the background: ${APP} service install)`);
  return result('port', 'Dashboard', 'warn', `${where} answered ${r} (is another program using this port?)`, 'Choose another port: set "server": { "port": ... } in ' + configFile());
}

/** Tailscale: { installed, running, dnsName } — dnsName like "pc.tailnet.ts.net" (no trailing dot). */
export async function tailscaleState(sys) {
  const bin = which('tailscale', sys.env, sys.platform);
  if (!bin) return { installed: false, running: false, dnsName: null, bin: null };
  const r = await capture([bin, 'status', '--json'], { env: sys.env, timeout: 8000 });
  return { installed: true, bin, ...parseTailscaleStatus(r.stdout) };
}

export function parseTailscaleStatus(text) {
  try {
    const j = JSON.parse(text);
    const dns = j && j.Self && typeof j.Self.DNSName === 'string' ? j.Self.DNSName.replace(/\.$/, '') : null;
    return { running: j.BackendState === 'Running', dnsName: dns || null };
  } catch {
    return { running: false, dnsName: null };
  }
}

/**
 * `running`: what the dashboard running now says (running.mjs runningFacts), or null: it decides over the settings.
 * `listenPort`: the port doctor's port check asked (allChecks), so the two lines name the same port.
 */
export function accessCheck(cfg, ts, server = null, sys = {}, running = null, listenPort = null) {
  const want = cfg.server.host || DEFAULT_HOST;
  const port = listenPort || cfg.server.port || DEFAULT_PORT;
  // A dashboard reads its settings when it starts: where it listens now is what can reach it (set-up says the same).
  const differs = running && running.host && listensOtherwise(running.host, want);
  const now = differs && `the dashboard running now listens ${whereWords(running.host)}; its settings say ${whereWords(want)}: that changes when it restarts`;
  // On a server (server.mjs) a dashboard open to the network is open to the internet on plain http. Settings that say
  // so fail whatever runs now: a restart with them (the fix below for a different place) would open it.
  if (server && openHost(want)) return result('access', 'Who can reach it', 'fail', `${now || `open to the network (http, port ${port})`}. ${notOnServer(server, port, sys)}`, `${APP} setup --access local`);
  if (differs) {
    if (server && openHost(running.host)) return result('access', 'Who can reach it', 'fail', `${now}. ${notOnServer(server, port, sys)}`, `${APP} service install   (restarts it with its settings)`);
    return result('access', 'Who can reach it', 'warn', now, `${APP} service install   (restarts it with its settings)`);
  }
  const host = want;
  const parts = [host === '0.0.0.0' || host === '::' ? `local network (http, port ${port})` : `this computer only (${host}:${port})`];
  const tsOrigin = (cfg.server.allowedOrigins || []).find((o) => /^https:\/\/[^/]+\.ts\.net$/.test(o));
  if (tsOrigin) parts.push(`Tailscale ${tsOrigin}/`);
  else if (ts.running) parts.push('Tailscale is on but not set up for the dashboard');
  // A reason an earlier set-up saved, unused only while this user is at the desktop: named, with the way out.
  const dormant = server ? null : dormantReason(sys);
  if (dormant) return result('access', 'Who can reach it', 'warn', `${parts.join('; ')}. ${dormantWords(dormant)}`, `${APP} setup --access network   (only if this is not a server)`);
  return result('access', 'Who can reach it', 'info', parts.join('; '), ts.running && !tsOrigin ? `${APP} setup` : '');
}

/** Run every check. `opts.offline` skips the newest-version lookup. Returns the list of results. */
export async function allChecks({ sys = sysInfo(), offline = false } = {}) {
  const list = [nodeCheck(), appCheck(), configCheck()];
  let cfg;
  try {
    cfg = loadConfig();
  } catch {
    cfg = { claudeBin: 'claude', server: {} };
  }
  // Root: one line, said here and so on Health too (rootfacts.mjs). `sys.root` decides, so a test plays root by facts;
  // `sys.exists` answers the container files.
  const root = rootCheck({ ...rootFacts({ env: sys.env, exists: sys.exists, cfg }), root: sys.root === true && sys.platform !== 'win32' });
  if (root) list.push(root);
  const info = await claudeInfo({ env: sys.env, fetchImpl: offline ? async () => ({ ok: false }) : undefined });
  const onPath = !info.path || !!which(cfg.claudeBin, sys.env, sys.platform);
  // On a hub (it only shows and relays other computers) Claude Code, an account and a terminal are not needed:
  // whatever those checks find is information there, never a problem.
  const hub = cfg.hubOnly === true || sys.env.HOPRIG_HUB === '1';
  const forHub = (r) => (hub && r.status !== 'ok' ? { ...r, status: 'info', detail: `${r.detail} (not needed on a main computer)`, fix: undefined, action: undefined } : r);
  list.push(forHub(claudeCheck(info, { onPath })));
  let profiles = [];
  try {
    profiles = listProfiles();
  } catch {
    /* reported by the folder check */
  }
  list.push(forHub(loginCheck(await claudeLoginStatus({ env: sys.env }), profiles)), forHub(profilesCheck(profiles, hiddenProfiles())));
  const own = ownEndpointCheck();
  if (own) list.push(forHub(own));
  const term = await terminalCheck(sys);
  list.push(term, forHub(await ptyCheck(sys, { tmux: !term.detail.startsWith('built-in') })), await passwordCheck(), await serviceCheck(sys));
  // The port the dashboard would really listen on, by the same resolution the server uses (serveopts.mjs
  // resolveListen: the environment's PORT, then the settings', then the default). A test that sets a port of its own
  // then never probes 7433, where a contributor's own dashboard listens. A PORT the server would itself refuse is
  // said, not probed. sys.probe lets a test answer the probe without a real connection (sysInfo sets none in use).
  // A dashboard that runs now says where it listens (its dashboard.json): that is asked first, whatever this shell's
  // PORT or the settings say (the service does not carry PORT, and a dashboard started with --port or under another
  // PORT listens elsewhere). Only when none runs is the port resolved. The access line names the same port.
  const running = await (sys.running || runningFacts)();
  let listen = running && Number.isInteger(running.port) ? { host: running.host || DEFAULT_HOST, port: running.port } : null;
  if (!listen) {
    try {
      listen = resolveListen({ env: sys.env, server: cfg.server, defaults: { host: DEFAULT_HOST, port: DEFAULT_PORT } });
    } catch {
      list.push(result('port', 'Dashboard', 'warn', `PORT=${sys.env.PORT} is not a port number (1-65535); the dashboard would refuse it`, 'Unset PORT, or set it to a port number.'));
    }
  }
  if (listen) list.push(await portCheck(listen.host, listen.port, sys.probe));
  list.push(accessCheck(cfg, await tailscaleState(sys), serverReason(sys), sys, running, listen?.port), ...dirsCheck(sys.platform), ...(await longPathsChecks(sys)));
  // On a server: a gateway Hoprig started that listens beyond this computer (gatewaycheck.mjs).
  try {
    const [{ gatewayChecks }, { gatewayAddons }] = await Promise.all([import('./gatewaycheck.mjs'), import('../addons/gateways.mjs')]);
    list.push(...gatewayChecks(gatewayAddons(), { reason: serverReason(sys), platform: sys.platform, net: sys.net ?? null }));
  } catch {
    /* the add-ons could not load: doctor's own add-on line says so */
  }
  const rules = sharedRulesCheck({ tools: enabledToolIds(cfg) });
  if (rules) list.push(rules);
  // The command in every shell, also `ssh <computer> hoprig …` (localbin.mjs).
  const cmd = (await import('./localbin.mjs')).commandCheck({ home: sys.env.HOME || undefined, platform: sys.platform });
  list.push(result('command', 'The hoprig command', cmd.status, cmd.detail, cmd.fix || undefined));
  return list;
}

/**
 * An address in Claude Code's own settings file wins over every profile, silently: named, with where to change it.
 * Host and port only, never a key. null when the file names none.
 */
export function ownEndpointCheck(dir) {
  const o = ownEndpoint(dir);
  if (!o) {
    const u = unreadSettings(dir);
    return u ? result('ownendpoint', "Claude Code's own settings", 'warn', `${u.file} names ANTHROPIC_BASE_URL but could not be read as JSON (a comment or a trailing comma?)`,
      `Look for ANTHROPIC_BASE_URL in that file yourself: if it is set there, every session goes to that address, whichever provider you pick`) : null;
  }
  return result('ownendpoint', "Claude Code's own settings", 'warn', ownEndpointWords(o),
    `On the dashboard's Providers page, press "Take the address out" (a copy of the file is kept). Or by hand: remove ANTHROPIC_BASE_URL from "env" in ${shownPath(o.file)}`);
}

/** A path as a person opens it: on Windows %USERPROFILE%\… (Explorer and PowerShell's cmd open that, not ~\…). */
export function shownPath(p, platform = process.platform, homeDir = os.homedir()) {
  if (platform !== 'win32') return tilde(p);
  const lower = p.toLowerCase();
  const h = homeDir.replace(/[\\/]+$/, '');
  return lower === h.toLowerCase() || lower.startsWith(h.toLowerCase() + '\\') ? `%USERPROFILE%${p.slice(h.length)}` : p;
}

export const LONGPATHS_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem';

/** `reg query … /v LongPathsEnabled` output → true, false, or null when it does not say. */
export function parseLongPaths(out) {
  const m = /^[ \t]+LongPathsEnabled[ \t]+REG_DWORD[ \t]+0x([0-9a-f]+)/im.exec(String(out || ''));
  return m ? parseInt(m[1], 16) !== 0 : null;
}

/**
 * Windows only: paths longer than 260 characters (a deep build cache in a project) fail in many programs unless
 * Windows allows them, and git needs its own setting too. One line each, with the one command that turns it on;
 * nothing is changed by doctor. `run(argv)` → { ok, stdout } (tests hand in made-up answers).
 */
export async function longPathsChecks(sys, run = (argv) => capture(argv, { env: sys.env, timeout: 10_000 })) {
  if (sys.platform !== 'win32') return [];
  const out = [];
  const r = await run(['reg', 'query', LONGPATHS_KEY, '/v', 'LongPathsEnabled']);
  const on = r.ok ? parseLongPaths(r.stdout) : false; // no value: Windows' default, off
  if (on === true) out.push(result('longpaths', 'Long paths in Windows', 'ok', 'allowed'));
  // Off is Windows' and git's default, and nothing is broken until a project has such a deep path: so a line for
  // information (·), with the command, not a warning on every first run.
  else if (on === false) out.push(result('longpaths', 'Long paths in Windows', 'info', 'off (the default): a file path longer than 260 characters (a deep folder in a project) fails in many programs. Turned on, it helps Node, git and newer programs; Windows PowerShell 5.1 and File Explorer still cannot use such a path (use a shorter folder, or PowerShell 7)',
    'In PowerShell opened with "Run as administrator": New-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force'));
  if (sys.has('git')) {
    const g = await run(['git', 'config', '--get', 'core.longpaths']);
    const gOn = g.ok && /^(true|yes|on|1)$/i.test(g.stdout.trim());
    out.push(gOn ? result('gitlongpaths', 'Long paths in git', 'ok', 'on')
      : result('gitlongpaths', 'Long paths in git', 'info', 'off (the default): git cannot check out or list a file whose path is longer than 260 characters', 'git config --global core.longpaths true'));
  }
  return out;
}

/** doctor's exit code: 0 only when nothing needed is broken. */
export function exitCodeFor(results) {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

