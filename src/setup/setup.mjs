// `hoprig setup`: from a fresh machine to a dashboard you open by scanning a QR code. It finds out, does, and
// prints one line per step. It asks at most two things, and only when they are not decided yet:
//   1. Claude Code is missing: install it now?
//   2. who may open the dashboard: this computer, devices on the network (default), or Tailscale
// Everything else has one sensible answer and is just done: a profile for the stored login, a generated
// dashboard password (kept in a private file; the QR sign-in link means it is rarely typed), the background
// service. Running it again changes nothing that is already in place.
//
//   --yes                  answer both questions with their defaults
//   --dry-run              ask nothing, change nothing, only report
//   --access local|network|tailscale   choose (or change) who may open it, without the question
//   --no-service           do not install the background service
//   --password-file FILE   where a newly generated password is written (default: in the settings folder)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeInfo, claudeInstall, claudeLoginStatus, resolveClaude } from '../claudecode.mjs';
import { configFile, configDir, tilde } from '../paths.mjs';
import { loadConfig, saveConfig } from '../config.mjs';
import { listProfiles } from '../profiles.mjs';
import {
  APP, DEFAULT_HOST, DEFAULT_PORT, appRoot, appVersion, hasBuildTools, nodeCheck, passwordCheck, probe, ptyCause, ptyFix,
  ptyRepairArgv, ptyState, ptyWorks, ptyWorksNow, serviceInstalled, sysInfo, systemdUser, tailscaleState,
} from './checks.mjs';
import { publicAddresses } from './https.mjs';
import { stepHttps, stepHttpsVerify } from './hubsetup.mjs';
import { PARTS, reportParts, runParts } from './firstrun.mjs';
import { ensureCommand } from './localbin.mjs';
import { qrText } from './qr.mjs';
import { tmuxNewEnough } from '../server/backends/tmuxversion.mjs';
import { capture, forThisUser, installCommands, npmMajor, osName, showCommand, showCommands, stream, which } from './system.mjs';
import { bold, dim, makeUi } from './ui.mjs';

export const ACCESS = ['local', 'network', 'tailscale'];

export function parseSetupArgs(args) {
  const o = { yes: false, dryRun: false, passwordFile: null, access: null, service: true, hub: false, domain: null, ip: null, tlsInternal: false, only: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = (name) => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      if (!args[i + 1]) throw new Error(`${name} needs a value`);
      return args[++i];
    };
    if (a === '--yes' || a === '-y') o.yes = true;
    else if (a === '--dry-run' || a === '-n') o.dryRun = true;
    else if (a === '--no-service') o.service = false;
    else if (a === '--hub') o.hub = true;
    else if (a === '--domain' || a.startsWith('--domain=')) o.domain = value('--domain');
    else if (a === '--ip' || a.startsWith('--ip=')) o.ip = value('--ip');
    else if (a === '--tls-internal') o.tlsInternal = true;
    else if (a === '--only' || a.startsWith('--only=')) {
      o.only = value('--only');
      if (!PARTS.includes(o.only)) throw new Error(`--only must be one of: ${PARTS.join(', ')}`);
    }
    else if (a === '--password-file' || a.startsWith('--password-file=')) o.passwordFile = value('--password-file');
    else if (a === '--access' || a.startsWith('--access=')) {
      o.access = value('--access');
      if (!ACCESS.includes(o.access)) throw new Error(`--access must be one of: ${ACCESS.join(', ')}`);
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

/** Run the package manager commands (after the user said yes to what they are for). Returns true on success. */
async function runInstall(ui, sys, packages) {
  const cmds = sys.pm ? installCommands(sys.pm, packages, { root: sys.root }) : null;
  if (!cmds || (cmds.some((c) => c[0] === 'sudo') && !sys.has('sudo'))) {
    ui.line('fail', `Install ${packages.join(' and ')} first${cmds ? ` (${forThisUser(showCommands(cmds), sys)})` : ''}, then run: ${APP} setup`);
    return false;
  }
  ui.note(showCommands(cmds));
  for (const argv of cmds) {
    // The terminal goes to the command, so sudo can ask for its password.
    const r = await stream(argv, { env: sys.env, interactive: true });
    if (!r.ok) {
      ui.line('fail', `"${showCommand(argv)}" did not succeed.`);
      return false;
    }
  }
  return true;
}

/** What the official installer needs on macOS / Linux: bash, and curl or wget (docs: Alpine needs `apk add bash curl`). */
export function installerNeeds(sys) {
  if (sys.platform === 'win32') return [];
  const need = [];
  if (!sys.has('bash')) need.push('bash');
  if (!sys.has('curl') && !sys.has('wget')) need.push('curl');
  return need;
}

// ---- Claude Code: the one install question ---------------------------------------------------------------------
export async function stepClaude(ui, sys, state) {
  const info = await claudeInfo({ env: sys.env });
  if (info.installed) {
    ui.line('ok', `Claude Code ${info.installed}${info.updateAvailable ? dim(`  (${info.latest} available: ${APP} claude update)`) : ''}`);
    rememberPath(ui, sys, info.path);
    return true;
  }
  ui.line('warn', 'Claude Code is not installed.');
  if (!(await ui.confirm('Install it now?', true))) {
    if (!ui.dryRun) ui.note(`Later: ${APP} claude install latest`);
    return false;
  }
  const need = installerNeeds(sys);
  if (need.length && !(await runInstall(ui, sys, need))) return false;
  ui.note(`Installing with the official installer (${sys.platform === 'win32' ? 'https://claude.ai/install.ps1' : 'https://claude.ai/install.sh'})…`);
  // Its output is shown only when something goes wrong: on success one line says it all.
  const r = await claudeInstall();
  if (!r.ok) {
    ui.out(r.output.split('\n').slice(-15).map((l) => `    ${l}`).join('\n'));
    ui.line('fail', `Claude Code did not install (see above). Try again: ${APP} claude install latest`);
    return false;
  }
  ui.line('ok', `Claude Code ${r.version} installed`);
  state.changed = true;
  const found = resolveClaude({ env: sys.env });
  if (found) rememberPath(ui, sys, found.path);
  return true;
}

/** A fresh install lands in ~/.local/bin, often not on PATH until the next login: remember the full path. */
function rememberPath(ui, sys, file) {
  if (ui.dryRun || which(loadConfig().claudeBin, sys.env, sys.platform)) return;
  saveConfig({ claudeBin: file });
}

// ---- login: one line, never a stop -----------------------------------------------------------------------------
export async function stepLogin(ui, sys) {
  const s = await claudeLoginStatus({ env: sys.env, remember: !ui.dryRun });
  if (s.loggedIn) ui.line('ok', 'Claude account logged in');
  else if (s.loggedIn === false) ui.line('warn', 'No Claude account logged in: run "claude" once, type /login, then run setup again.');
  else ui.line('warn', `Claude login unknown (${s.reason}).`);
  return !!s.loggedIn;
}

// ---- terminal --------------------------------------------------------------------------------------------------
/**
 * Build the terminal module with the command doctor shows (checks.mjs: ptyRepairArgv), in hoprig's own folder. No
 * question: it is a part of hoprig, and its package.json allows the install script of exactly that module. This is
 * what makes an install with npm 12 complete, which does not run that script in `npm install -g`. Returns
 * whether the module works after it (asked in a new process: checks.mjs ptyWorksNow).
 */
export async function buildTerminal(ui, sys, works = ptyWorksNow) {
  const argv = ptyRepairArgv(ptyState(), sys.platform);
  ui.note(`Building the terminal module (${showCommand(argv)})…`);
  const r = await stream(argv, { env: sys.env, cwd: appRoot() });
  if (!r.ok) ui.out(r.output.split('\n').filter(Boolean).slice(-8).map((l) => `    ${l}`).join('\n'));
  return works();
}

export async function stepTerminal(ui, sys, works = ptyWorks, build = buildTerminal) {
  // The same choice the dashboard makes (backends/index.mjs): tmux when it is there and 3.2 or newer.
  const file = sys.platform === 'win32' ? null : which('tmux', sys.env, sys.platform);
  const tmux = !!file && tmuxNewEnough((await capture([file, '-V'], { env: sys.env })).stdout);
  let r = await works();
  // Without the build tools on Linux a build can only fail: the line below then names them.
  if (!r.ok && (sys.platform !== 'linux' || hasBuildTools(sys))) {
    if (ui.dryRun) ui.line('info', `Would build the terminal module (${showCommand(ptyRepairArgv(ptyState(), sys.platform))})`);
    else r = await build(ui, sys);
  }
  if (r.ok) {
    ui.line('ok', `Terminal: ${tmux ? 'tmux' : 'built-in'}`);
    return true;
  }
  const state = ptyState();
  const why = ptyCause(state, state === 'unbuilt' ? await npmMajor({ env: sys.env, platform: sys.platform }) : null) || r.why;
  const fix = ptyFix(sys, appRoot(), state);
  // tmux keeps the sessions, but the terminal in the browser is drawn through the same module.
  if (tmux) {
    ui.line('warn', `Terminal: sessions run in tmux and take messages, but no terminal can open in the browser: the terminal module does not work (${why}). Fix: ${fix}`);
    return true;
  }
  ui.line('fail', `Terminal: the built-in terminal does not work (${why}). Fix: ${fix}`);
  return false;
}

// ---- profile, password: no questions ---------------------------------------------------------------------------
export async function stepProfile(ui) {
  if (listProfiles().length) return true;
  if (ui.dryRun) {
    ui.line('info', 'Would create the profile "sub" (your Claude login)');
    return true;
  }
  // The launcher's own first-start code path, so setup and a first `hoprig` start create the same profile.
  const menu = await import('../menu.mjs');
  if (typeof menu.ensureFirstProfile === 'function') menu.ensureFirstProfile();
  else (await import('../profiles.mjs')).writeProfile('sub', { label: 'Claude account (stored login)' });
  return true;
}

export const defaultPasswordFile = () => path.join(configDir(), 'dashboard-password.txt');

/** No password yet: generate one, store only its hash, write the password itself to a private file. */
export async function stepPassword(ui, opts, state) {
  if ((await passwordCheck()).status === 'ok') {
    if (fs.existsSync(defaultPasswordFile())) state.passwordFile = defaultPasswordFile();
    return true;
  }
  const file = path.resolve(opts.passwordFile || defaultPasswordFile());
  if (ui.dryRun) {
    ui.line('info', `Would generate a dashboard password into ${tilde(file)}`);
    return true;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const cli = await import('../server/cli.mjs');
  // `passwd --generate` prints one line of its own; the summary says where the file is, so it is not needed here.
  const code = await quietly(() => cli.main('passwd', ['--generate', file]));
  if (code !== 0) {
    ui.line('fail', `Could not set a dashboard password. Set one: ${APP} passwd`);
    return false;
  }
  state.passwordFile = file;
  state.changed = true;
  return true;
}

async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
}

// ---- who may open it: the second question ----------------------------------------------------------------------
export const tailscaleUrl = (dnsName) => `https://${dnsName}/`;
export const tailscaleServeArgv = (bin, port) => [bin, 'serve', '--bg', String(port)];

/** What is set now: 'local' | 'network' | 'tailscale', or null when it was never chosen. */
export function currentAccess(raw, tsOrigin) {
  const server = (raw && raw.server) || {};
  if (tsOrigin && (server.allowedOrigins || []).includes(tsOrigin)) return 'tailscale';
  if (server.host === undefined) return null;
  return server.host === '0.0.0.0' || server.host === '::' ? 'network' : 'local';
}

function rawConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

export async function stepAccess(ui, sys, opts, state) {
  const port = loadConfig().server.port || DEFAULT_PORT;
  const ts = await tailscaleState(sys);
  const tsOrigin = ts.running && ts.dnsName ? `https://${ts.dnsName}` : null;
  const now = currentAccess(rawConfig(), tsOrigin);
  // A server with a public address: "devices on my network" would be the whole internet over plain http.
  const publicIps = sys.publicIps ?? publicAddresses();
  const exposed = publicIps.length > 0;
  let want = opts.access;
  if (want === 'network' && exposed) {
    ui.line('fail', `Not over plain http: this computer has a public address (${publicIps[0]}), so everyone could read the password on the way. Use HTTPS: ${APP} setup --hub (a hub), or Tailscale.`);
    return false;
  }
  if (!want && now) want = now; // decided earlier: no question
  if (!want) {
    const options = [{ key: '1', label: 'only this computer' }];
    if (!exposed) options.push({ key: '2', label: 'devices on my network, e.g. my phone on the same Wi-Fi' });
    options.push({ key: '3', label: 'from anywhere' });
    const key = await ui.choose('Who should be able to open the dashboard?', options, exposed ? '1' : '2');
    want = { 1: 'local', 2: 'network' }[key] || null;
    if (key === '3') {
      const ways = [
        { key: 'a', label: 'I have a server: make it the hub, and connect this computer to it' },
        { key: 'b', label: 'a public link (free, through Cloudflare, no server: a new address at each start, or your own domain)' },
      ];
      if (tsOrigin) ways.push({ key: 'c', label: `Tailscale (${tailscaleUrl(ts.dnsName)}, only your own devices)` });
      const way = await ui.choose('How?', ways, tsOrigin ? 'c' : 'a');
      if (way === 'c') want = 'tailscale';
      else {
        want = 'local';
        if (way === 'a') {
          ui.note(`On the server: ${APP} setup --hub   (it shows a one-time code)`);
          ui.note(`Then here:     ${APP} join https://<the server's address> <code>`);
        } else if (way === 'b') {
          ui.note(`Turn it on: ${APP} public on   (it shows the address and a QR code; also in Settings → Public link)`);
        }
      }
    }
    if (!want) {
      if (!ui.dryRun) ui.note('Kept: only this computer.');
      return true;
    }
  }
  if (want === 'tailscale' && !tsOrigin) {
    ui.line('fail', ts.installed ? 'Tailscale is not logged in: run "tailscale up", then setup again.' : 'Tailscale is not installed: get it at https://tailscale.com/download, sign in, then run setup again.');
    return false;
  }
  if (want !== now && !ui.dryRun) {
    const cfg = loadConfig();
    if (want === 'tailscale') {
      const argv = tailscaleServeArgv(ts.bin, port);
      const r = await stream(argv, { env: sys.env, onLine: (l) => ui.note(`  ${l}`) });
      if (!r.ok) {
        ui.line('fail', `"${showCommand(argv)}" did not succeed.${sys.platform === 'linux' ? ' It may need, once: sudo tailscale set --operator="$USER"' : ''}`);
        return false;
      }
      // The dashboard keeps listening on this computer only; Tailscale brings the https traffic to it.
      const origins = new Set(cfg.server.allowedOrigins || []);
      origins.add(tsOrigin);
      saveConfig({ server: { host: DEFAULT_HOST, allowedOrigins: [...origins] } });
    } else saveConfig({ server: { host: want === 'network' ? '0.0.0.0' : DEFAULT_HOST } });
    state.changed = true;
  }
  if (want === 'tailscale') state.phoneUrl = tailscaleUrl(ts.dnsName);
  const label = { local: 'only this computer', network: 'devices on your network (plain http: use a network you trust)', tailscale: `your Tailscale devices (${tailscaleUrl(ts.dnsName || '')})` }[want];
  ui.line(ui.dryRun && want !== now ? 'info' : 'ok', `${ui.dryRun && want !== now ? 'Would open it to' : 'Open to'}: ${label}`);
  state.access = want;
  return true;
}

// ---- background service: done by default -----------------------------------------------------------------------
async function serviceSupported(sys) {
  if (typeof sys.serviceSupported === 'boolean') return sys.serviceSupported; // decided by the caller (tests)
  if (sys.platform === 'linux') return systemdUser(sys);
  return sys.platform === 'darwin' || sys.platform === 'win32';
}

export async function stepService(ui, sys, opts, state) {
  const cfg = loadConfig();
  // `sys.probe` lets a test answer for the port: on a machine that already runs the dashboard the real port
  // answers, which is not what a test of a fresh setup should see.
  const ask = sys.probe || probe;
  const running = (await ask(cfg.server.host || DEFAULT_HOST, cfg.server.port || DEFAULT_PORT)) === 200;
  if (!opts.service) {
    ui.line(running ? 'ok' : 'info', running ? 'Dashboard running' : `Dashboard: start it with "${APP} serve"`);
    return running;
  }
  if (!(await serviceSupported(sys))) {
    ui.line(running ? 'ok' : 'info', running ? 'Dashboard running' : `Dashboard: no background service here; start it with "${APP} serve"`);
    return running;
  }
  const installed = await serviceInstalled(sys);
  if (installed && running && !state.changed) {
    ui.line('ok', 'Dashboard running in the background');
    return true;
  }
  if (ui.dryRun) {
    ui.line('info', `Would ${installed ? 'restart' : 'install and start'} the background service`);
    return true;
  }
  if ((await passwordCheck()).status !== 'ok') return false;
  const out = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  let code;
  try {
    code = await (await import('../server/cli.mjs')).main('service', ['install']);
  } finally {
    console.log = log;
    console.error = err;
  }
  if (code !== 0) {
    ui.line('fail', `The background service did not start: ${out.join(' ').trim() || 'see hoprig service status'}`);
    return false;
  }
  // Give it a moment to listen, so the summary can say it is up.
  const host = loadConfig().server.host || DEFAULT_HOST;
  const port = loadConfig().server.port || DEFAULT_PORT;
  for (let i = 0; i < 20 && (await ask(host, port, 500)) !== 200; i++) await new Promise((r) => setTimeout(r, 250));
  ui.line('ok', 'Dashboard running in the background (starts with the computer)');
  const linger = out.join('\n').match(/sudo loginctl enable-linger \S+/);
  if (linger) ui.note(`To keep it running while you are logged out: ${linger[0]}`);
  return true;
}

// ---- the end: a QR code to sign in ------------------------------------------------------------------------------
export function lanUrls(port, nets = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(nets)) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}/`);
  }
  return out;
}

/** A one-time sign-in link for `baseUrl` when the server offers them; else null (the plain URL is shown). */
export async function loginLink(baseUrl) {
  try {
    const mod = await import('../server/loginlink.mjs');
    if (typeof mod.createLoginLink !== 'function') return null;
    const r = await mod.createLoginLink({ baseUrl, minutes: 15 });
    return r && typeof r.url === 'string' ? r : null;
  } catch {
    return null;
  }
}

export async function stepSummary(ui, state) {
  const cfg = loadConfig();
  const host = cfg.server.host || DEFAULT_HOST;
  const port = cfg.server.port || DEFAULT_PORT;
  const local = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}/`;
  const phoneBase = state.phoneUrl || (host === '0.0.0.0' || host === '::' ? lanUrls(port)[0] : null);
  ui.out();
  if (ui.dryRun) {
    ui.out(`  ${bold('Dry run: nothing was changed.')} At the end, setup shows a QR code to open the dashboard on your phone.`);
    return;
  }
  if (state.hub && state.hubFailed) {
    ui.out(`  The hub cannot be reached over HTTPS yet: fix the step marked ✗ above, then run ${bold(`${APP} setup --hub`)} again.`);
    return;
  }
  const link = phoneBase && !ui.dryRun ? await loginLink(phoneBase) : null;
  const target = link ? link.url : phoneBase;
  ui.out(`  ${bold(`${APP} is ready.`)}`);
  if (target) {
    ui.out(`  Scan with your phone's camera${link ? ' to sign in (the link works once, for 15 minutes)' : ''}:`);
    const qr = qrText(target);
    if (qr) ui.out(qr.replace(/\n$/, '').split('\n').map((l) => `  ${l}`).join('\n'));
    ui.out(`  ${target}`);
  }
  ui.out(`  On this computer: ${bold(local)}`);
  const pw = state.passwordFile;
  if (pw) ui.out(`  Password, if asked: in ${tilde(pw)}`);
  if (state.hub) {
    // The other computers join with a one-time code (10 minutes), shown ready to copy.
    const base = (state.phoneUrl || local).replace(/\/$/, '');
    try {
      const { code } = (await import('../machines/link.mjs')).createLinkCode();
      // The whole line to type on the other computer: with the fingerprint of the hub's certificate authority when
      // the certificate is the hub's own (Caddy's), so that computer can check it talks to this hub.
      const { hubCertificate, joinCommand } = await import('../machines/hubcert.mjs');
      const { line, note } = joinCommand(base, code, await hubCertificate(base), APP);
      ui.out(`  Connect each PC to it (the code works once, for 10 minutes): ${bold(line)}`);
      if (note) ui.out(`  ${note}`);
    } catch {
      ui.out(`  Connect each PC to it: on the hub run ${bold(`${APP} machines invite`)}, then on the PC ${bold(`${APP} join ${base} <code>`)}`);
    }
    ui.out(`  Check everything: ${bold(`${APP} doctor`)}`);
    return;
  }
  ui.out(`  Add another provider: ${bold(`${APP} add`)}     Check everything: ${bold(`${APP} doctor`)}`);
}

/** Run every step. Returns 0 when the dashboard can work, 1 when something needed is missing, 2 on bad options. */
export async function setup(args = [], { ui: givenUi, sys = sysInfo(), parts: partsOver = {} } = {}) {
  let opts;
  try {
    opts = parseSetupArgs(args);
  } catch (e) {
    process.stderr.write(`${APP} setup: ${e.message}\nusage: ${APP} setup [--yes] [--dry-run] [--only base|pc|git|workspace|project|skills] [--hub [--domain D] [--ip A] [--tls-internal]] [--access local|network|tailscale] [--no-service] [--password-file FILE]\n`);
    return 2;
  }
  const ui = givenUi || makeUi({ yes: opts.yes, dryRun: opts.dryRun });
  const state = { changed: false, phoneUrl: null, passwordFile: null, access: null };
  ui.out(`${bold(`${APP} setup`)} ${dim(`${appVersion() || ''} · ${osName(sys.platform)}${opts.dryRun ? ' · dry run' : ''}`)}`);
  const node = nodeCheck();
  ui.line(node.status, `Node.js ${node.detail}`);
  if (node.status !== 'ok') {
    ui.note(node.fix);
    return 1;
  }
  // The command in every shell (also over ssh and in a non-interactive login shell), before anything else.
  {
    const c = ensureCommand({ dryRun: opts.dryRun, home: sys.env.HOME || undefined, platform: sys.platform, shell: sys.env.SHELL || '' });
    for (const l of [...c.did, ...c.kept]) ui.line('ok', l);
  }
  // A hub only shows and relays other computers: no Claude Code, no account and no terminal are needed on it.
  const hub = opts.hub || loadConfig().hubOnly === true;
  const doBase = !opts.only || opts.only === 'base';
  let claudeOk = true;
  let termOk = true;
  let pwOk = true;
  let httpsOk = true;
  if (!doBase) {
    // --only pc|project|skills: just that part.
  } else if (hub) {
    if (opts.hub && !opts.dryRun && loadConfig().hubOnly !== true) saveConfig({ hubOnly: true });
    ui.line('info', 'Hub only: this computer shows your other computers. Claude Code is not needed here.');
  } else {
    claudeOk = await stepClaude(ui, sys, state);
    if (claudeOk) await stepLogin(ui, sys);
    termOk = await stepTerminal(ui, sys);
    await stepProfile(ui);
  }
  if ((opts.domain || opts.ip || opts.tlsInternal) && !hub) {
    ui.line('fail', `--domain and --ip are for a hub: ${APP} setup --hub --domain …`);
    return 2;
  }
  if (doBase) {
    pwOk = await stepPassword(ui, opts, state);
    // A hub on a server with a public address (or a domain) gets HTTPS in front; a hub at home answers the question.
    const https = hub ? await stepHttps(ui, sys, opts, state) : null;
    if (https === null) await stepAccess(ui, sys, opts, state);
    else httpsOk = https;
    state.hubFailed = https === false;
    await stepService(ui, sys, opts, state);
    if (https) await stepHttpsVerify(ui, state);
  }
  // Then, in the same run: this computer for coding, a project, skills. A hub stops here: it codes nothing itself.
  let parts = [];
  if (hub && opts.only && opts.only !== 'base') ui.line('info', 'A hub has no computer, project or skills step: it only shows your other computers.');
  else if (!hub && opts.only !== 'base') parts = await runParts(ui, opts, { only: opts.only, parts: partsOver });
  reportParts(ui, parts);
  state.hub = hub;
  if (doBase) await stepSummary(ui, state);
  if (opts.dryRun) return 0;
  return claudeOk && termOk && pwOk && httpsOk && parts.every((r) => r.ok) ? 0 : 1;
}

