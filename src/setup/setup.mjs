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
//   --no-dashboard         no service, no port and no look for a dashboard that runs now (the move installs for the
//                          user this way while root's dashboard still holds the port)
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
import { lingerOutcome, lingerPlan, runLingerAlone } from './linger.mjs';
import { LOCALE_VARS, installedLocales, localeWords, missingLocale, withWorkingLocale } from './locale.mjs';
import { dormantReason, dormantWords, forgetServer, forwardLine, liveReason, notOnServer, openHost, rememberServer, serverReason, serverWays } from './server.mjs';
import { stepHttps, stepHttpsVerify } from './hubsetup.mjs';
import { PARTS, reportParts, runParts } from './firstrun.mjs';
import { ensureCommand } from './localbin.mjs';
import { listensOtherwise, runningFacts, whereWords } from './running.mjs';
import { qrText } from './qr.mjs';
import { tmuxNewEnough } from '../server/backends/tmuxversion.mjs';
import { findWorkUser, freshRootRefusal, rootCheck, rootFacts, STAY_ROOT_KEY, workAsRootAllowed } from './rootfacts.mjs';
import { FRESH_ROOT_START, freshRoot, runWorkSetup } from './rootwork.mjs';
import { capture, forThisUser, installCommands, npmMajor, osName, showCommand, showCommands, stream, which } from './system.mjs';
import { bold, closingList, collectTodo, dim, makeUi, yours } from './ui.mjs';
import { forInstalls } from '../secretenv.mjs';

export const ACCESS = ['local', 'network', 'tailscale'];
/** The usage of `hoprig setup` (printed for a wrong option, and as its help). */
export const SETUP_USAGE = `usage: ${APP} setup [--yes] [--dry-run] [--only base|pc|git|workspace|project|skills] [--hub [--domain D] [--ip A] [--tls-internal]] [--access local|network|tailscale] [--no-service] [--no-dashboard] [--password-file FILE] [--stay-root]`;

export function parseSetupArgs(args) {
  const o = { yes: false, dryRun: false, passwordFile: null, access: null, service: true, hub: false, domain: null, ip: null, tlsInternal: false, only: null, stayRoot: false, noDashboard: false };
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
    else if (a === '--no-dashboard') {
      o.noDashboard = true;
      o.service = false;
    }
    else if (a === '--stay-root') o.stayRoot = true; // keep Hoprig on root on purpose (kept in the settings: rootfacts.mjs)
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
    const r = await stream(argv, { env: forInstalls(sys.env), interactive: true });
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
  else if (s.loggedIn === false) yours(ui, 'warn', 'No Claude account logged in', 'claude', { alone: 'No Claude account logged in: sign in on the dashboard, Home → Get started → Sign in to Claude (or, in a terminal: run "claude" once and type /login).' });
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
  const argv = ptyRepairArgv(ptyState(), sys.platform, sys.env);
  ui.note(`Building the terminal module (${showCommand(argv)})…`);
  const r = await stream(argv, { env: forInstalls(sys.env), cwd: appRoot() }); // npm runs node-pty's build script
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
    if (ui.dryRun) ui.line('info', `Would build the terminal module (${showCommand(ptyRepairArgv(ptyState(), sys.platform, sys.env))})`);
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
  // The launcher's own first-start code path, so setup and a first `hoprig` start create the same profile; said here,
  // through set-up's own lines, in words that hold whether the Claude login is there yet or not.
  if ((await import('../menu.mjs')).ensureFirstProfile({ quiet: true })) ui.line('ok', 'Created the profile "sub" (this computer\'s Claude login)');
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
  // The host first, with the same rule as doctor's (server.mjs openHost): any host beyond loopback, also a card's own
  // address set by hand, is open to the network, whatever Tailscale origin an earlier run also kept.
  if (openHost(server.host)) return 'network';
  if (tsOrigin && (server.allowedOrigins || []).includes(tsOrigin)) return 'tailscale';
  return server.host === undefined ? null : 'local';
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
  // Closing a host open to the network keeps the Tailscale origin an earlier run saved: what is left is Tailscale, and
  // the next run reads it so (currentAccess). Said so now, not "only this computer" (two runs would contradict).
  const keptTs = !!tsOrigin && (rawConfig().server?.allowedOrigins || []).includes(tsOrigin);
  // A server (a public address, ssh with no desktop, or a cloud's hardware: server.mjs): "devices on my network" would be
  // the whole internet over plain http.
  // What this run sees is kept for the dashboard service and its terminals, which have no ssh session (server.mjs).
  if (!ui.dryRun) rememberServer(liveReason(sys), sys);
  const reason = serverReason(sys);
  const exposed = !!reason;
  state.server = reason;
  let want = opts.access;
  if (want === 'network' && exposed) {
    ui.line('fail', notOnServer(reason, port, sys));
    state.accessRefused = true;
    // Already open (an earlier version, or by hand): refusing alone would leave it answering from the internet.
    if (now === 'network') {
      if (ui.dryRun) ui.line('info', 'Would close it to this computer only (it is open to the network now)');
      else {
        saveConfig({ server: { host: DEFAULT_HOST } });
        state.changed = true;
        state.hostChanged = true;
        ui.line('ok', `Closed it to this computer only (it was open to the network)${keptTs ? `; your Tailscale devices still reach it (${tailscaleUrl(ts.dnsName)})` : ''}`);
      }
    }
    state.access = now === 'network' ? (keptTs ? 'tailscale' : 'local') : now;
    if (state.access === 'tailscale') state.phoneUrl = tailscaleUrl(ts.dnsName);
    return false;
  }
  if (!want && now) want = now; // decided earlier: no question
  // Opened to the network by an earlier run (or by hand) on what is a server: said in the same words, and closed to this
  // computer after a yes (--yes says yes; a dry run only asks).
  if (!opts.access && now === 'network' && exposed) {
    ui.line('warn', `The dashboard is open to the network. ${notOnServer(reason, port, sys)}`);
    // A dry run asks nothing and shows what a yes would do.
    if ((await ui.confirm('Close it to this computer only?', true)) || ui.dryRun) want = keptTs ? 'tailscale' : 'local';
    else {
      ui.line('warn', `Kept open to the network. To close it: ${APP} setup --access local`);
      state.access = 'network';
      return true;
    }
  }
  if (!want) {
    // Numbered in the order shown: on a server "devices on my network" is left out, and no number is missing.
    const shown = [['local', 'only this computer'], ...(exposed ? [] : [['network', 'devices on my network, e.g. my phone on the same Wi-Fi: inside your own Wi-Fi only and not encrypted, so not for a shared or public Wi-Fi']]), ['anywhere', 'from anywhere']];
    const options = shown.map(([, label], i) => ({ key: String(i + 1), label }));
    const key = await ui.choose('Who should be able to open the dashboard?', options, String(shown.findIndex(([w]) => w === (exposed ? 'local' : 'network')) + 1));
    const picked = key ? shown[Number(key) - 1][0] : null;
    want = picked === 'anywhere' ? null : picked;
    if (picked === 'network' && !ui.yes) state.choseNetwork = true; // asked and answered, not a default
    if (picked === 'anywhere') {
      const ways = [
        { key: 'a', label: 'I have a server: make it the main computer, and connect this computer to it' },
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
  // The owner said "devices on my network" himself at this computer's own desktop: a server reason an earlier ssh run
  // saved is forgotten (else the logged-out service would count this home computer as a server again).
  const forgot = !ui.dryRun && want === 'network' && !exposed && (opts.access === 'network' || state.choseNetwork) && forgetServer(sys);
  if (forgot) ui.line('ok', 'This computer no longer counts as a server (an earlier set-up over ssh had saved that)');
  // Kept, and not used only because someone is at this desktop now: said once, with the way out (the service, with
  // nobody logged in, counts the computer as a server again and keeps the dashboard to this computer).
  const dormant = !forgot && !(ui.dryRun && want === 'network' && opts.access === 'network') ? dormantReason(sys) : null;
  if (dormant) ui.line('info', dormantWords(dormant));
  if (want === 'tailscale' && !tsOrigin) {
    ui.line('fail', ts.installed ? 'Tailscale is not logged in: run "tailscale up", then setup again.' : 'Tailscale is not installed: get it at https://tailscale.com/download, sign in, then run setup again.');
    return false;
  }
  if (want !== now && !ui.dryRun) {
    const cfg = loadConfig();
    // A kept origin is enough when the host only closes; asked for by name, `tailscale serve` runs again (it may have been reset).
    if (want === 'tailscale' && keptTs && opts.access !== 'tailscale') saveConfig({ server: { host: DEFAULT_HOST } });
    else if (want === 'tailscale') {
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
    // Only a host that really changed needs the dashboard to restart (a first run keeps 127.0.0.1, so does Tailscale).
    if ((loadConfig().server.host || DEFAULT_HOST) !== (cfg.server.host || DEFAULT_HOST)) state.hostChanged = true;
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

/** Does a dashboard with these settings run its sessions in the built-in terminals (backends/index.mjs's choice)? */
async function builtInTerminals(sys, cfg) {
  const kind = cfg.server.backend || 'auto';
  if (kind !== 'auto') return kind === 'pty';
  if (sys.platform === 'win32') return true;
  const file = which('tmux', sys.env, sys.platform);
  return !file || !tmuxNewEnough((await capture([file, '-V'], { env: sys.env })).stdout);
}

/** Set-up's root facts: root from `sys.root` (tests play it), the container files from `sys.exists`, the kept choice. */
const rootFactsOf = (sys, opts = {}) => ({ ...rootFacts({ env: sys.env, exists: sys.exists, cfg: opts.stayRoot ? { [STAY_ROOT_KEY]: true } : loadConfig() }), root: sys.root === true && sys.platform !== 'win32' });

export async function stepService(ui, sys, opts, state) {
  // --no-dashboard: another dashboard (root's, during a move) may hold the port; it is none of this set-up's business.
  if (opts.noDashboard) {
    ui.line('info', 'Dashboard: not started by this set-up (--no-dashboard); the background service is made later');
    return true;
  }
  const cfg = loadConfig();
  const port = cfg.server.port || DEFAULT_PORT;
  const want = cfg.server.host || DEFAULT_HOST;
  // `sys.probe` and `sys.running` let a test answer for the port and for the dashboard running now: on a machine that
  // already runs the dashboard the real one answers, which is not what a test of a fresh setup should see.
  const ask = sys.probe || probe;
  const askRunning = sys.running || (() => runningFacts());
  // The running dashboard says where it really listens and which version it is (running.mjs); a probe of 127.0.0.1
  // alone is answered by a dashboard on every address too.
  const facts = await askRunning();
  const running = !!facts || (await ask(want, port)) === 200;
  const wide = !!facts && listensOtherwise(facts.host, want);
  const mine = appVersion();
  // A dashboard from before the route (running.mjs: `earlier`) counts as another version: it is restarted too.
  const old = facts && facts.earlier ? 'an earlier version' : facts && facts.version && mine && facts.version !== mine ? `version ${facts.version}` : null;
  // A dashboard reads who may open it once, when it starts: one this step does not restart keeps the old setting.
  const stale = (how) => ui.line('warn', `Dashboard running with the setting it started with: ${wide ? `it listens ${whereWords(facts.host)}, its settings say ${whereWords(want)}; ` : ''}who may open it changes when it restarts (${how})`);
  const needs = running && (state.hostChanged || wide);
  // On a server, a dashboard that answers but says nothing about itself here (no dashboard file of this home: a
  // program that is not this Hoprig's, or one with other settings) may listen on every address: never "✓ running".
  const unknown = running && !facts && !!state.server;
  const cannotRead = (how) => {
    ui.line('warn', `Dashboard running, but set-up cannot read where it listens (it says nothing about itself here), and this computer is a server: restart it so it runs with its settings (${how})`);
    // It may listen on every address: not ready (stepSummary), unless a line above already said why not.
    if (!state.serviceLeft) {
      state.serviceLeft = 'unread';
      state.unreadNext = `restart it so it runs with its settings (${how})`;
    }
  };
  // Not restarted by this step: on a server a listener wider than this computer is the internet over plain http, so
  // the run is not ready (stepSummary says how to restart it, the way this step just named).
  const leftOpen = (how) => {
    if (wide && state.server && openHost(facts.host)) {
      state.serviceLeft = 'open';
      state.restartHow = how;
    } else if (running && !facts && state.hostChanged && state.server) {
      // The dashboard answers but says no local facts here, so we cannot read where it listens; this run just closed
      // a server's open setting, and the dashboard started with that setting: not ready until it restarts.
      state.serviceLeft = 'open';
      state.restartHow = how;
    }
  };
  if (!opts.service) {
    const how = `${APP} service install, or stop "${APP} serve" and start it again`;
    if (unknown) cannotRead(how);
    else if (needs) stale(how);
    else ui.line(running ? 'ok' : 'info', running ? 'Dashboard running' : `Dashboard: start it with "${APP} serve"`);
    leftOpen(how);
    return running && !state.serviceLeft;
  }
  if (!(await serviceSupported(sys))) {
    const how = `stop "${APP} serve" and start it again`;
    if (unknown) cannotRead(how);
    else if (needs) stale(how);
    else ui.line(running ? 'ok' : 'info', running ? 'Dashboard running' : `Dashboard: no background service here; start it with "${APP} serve"`);
    leftOpen(how);
    return running && !state.serviceLeft;
  }
  const installed = await serviceInstalled(sys);
  // As root, not on purpose: no service is made new for root (rootfacts.mjs). Said once; nothing is made.
  const asRoot = rootFactsOf(sys, opts);
  if (freshRootRefusal(asRoot, installed)) {
    state.rootRefused = true;
    state.serviceLeft = 'root';
    ui.line('fail', freshRootRefusal(asRoot, installed));
    return false;
  }
  if (installed && running && !state.changed && !wide && !old) {
    // Not restarted here: what answers cannot say whether sessions in its built-in terminals would end with it.
    if (unknown) cannotRead(`${APP} service install`);
    else ui.line('ok', 'Dashboard running in the background');
    return !state.serviceLeft;
  }
  // Which version runs is said only where no restart follows; a restart says "it ran X, now Y" itself.
  const which_ = () => old && ui.line('info', `The dashboard running now is ${old}; this is ${mine}`);
  if (wide) ui.line('warn', `The dashboard running now listens ${whereWords(facts.host)}; its settings say ${whereWords(want)}: that changes when it restarts`);
  // Its built-in terminals end with it (tmux sessions do not): never without a word, and not without a yes.
  const ends = facts && facts.backend === 'pty' && Array.isArray(facts.terminals) ? facts.terminals : [];
  // One that cannot say (an earlier version) may have them when its settings give it the built-in terminals.
  const mayEnd = !!facts && facts.unknown && (await builtInTerminals(sys, cfg));
  if (running && (ends.length || mayEnd)) {
    ui.line('warn', ends.length ? `A restart of the dashboard ends the session${ends.length > 1 ? 's' : ''} in its built-in terminals: ${ends.join(', ')}` : 'A restart of the dashboard ends the sessions in its built-in terminals, if it has any (the dashboard running now cannot say which)');
    const go = ui.dryRun || ui.yes ? false : await ui.confirm('Restart it now anyway?', false);
    if (!go) {
      which_();
      const runsOn = `Not restarted: ${old ? `${old} runs on` : 'it runs on with the setting it started with'}`;
      // On a server a listener wider than this computer is the internet over plain http: not ready (stepSummary).
      if (wide && state.server) state.serviceLeft = 'open';
      yours(ui, 'info', runsOn, 'restart', { step: `${APP} service install, once ${ends.length ? `the session${ends.length > 1 ? 's' : ''} ${ends.join(', ')} ${ends.length > 1 ? 'are' : 'is'}` : 'its sessions are'} done`, alone: `${runsOn}. Restart it when those sessions are done: ${APP} service install` });
      return !state.serviceLeft;
    }
  }
  if (ui.dryRun) {
    which_();
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
    // With set-up's own environment (sys.env): the systemctl it runs is the one on that PATH, reaching the service
    // manager that environment names (a test's stand-in, never the computer's real one).
    // Lingering is one of set-up's own listed steps (linger.mjs): the service's "run this once yourself" is not said.
    code = await (await import('../server/service/index.mjs')).service('install', sys.platform, { env: sys.env, lingerNote: false, rootFacts: asRoot });
  } finally {
    console.log = log;
    console.error = err;
  }
  if (code !== 0) {
    ui.line('fail', `The background service did not start: ${out.join(' ').trim() || 'see hoprig service status'}`);
    state.serviceLeft = 'failed';
    return false;
  }
  // Give it a moment to listen, so the summary can say it is up.
  for (let i = 0; i < 20 && (await ask(want, port, 500)) !== 200; i++) await new Promise((r) => setTimeout(r, 250));
  const after = await askRunning();
  // The same process still answers after the service's restart: so it is not the service's own (an earlier "hoprig
  // serve"), it holds the port, and the service could not take it. Never "running in the background" then.
  if (facts && after && after.pid === facts.pid) {
    ui.line('fail', `An earlier dashboard (pid ${facts.pid}, not the background service) still holds port ${port}${openHost(facts.host) ? ' open to the network' : ''}, so the service could not take it. Stop it (kill ${facts.pid}), then run ${APP} setup again`);
    state.serviceLeft = openHost(facts.host) ? 'held-open' : 'held';
    return false;
  }
  if (old && after && after.version) ui.line(after.version === mine ? 'ok' : 'warn', after.version === mine ? `The dashboard ran ${old.replace(/^version /, '')}, now ${mine}` : `The dashboard still runs ${after.version}, not ${mine}: ${APP} service status`);
  // Still nothing that says where it listens (the service did not write its file, or another program has the port).
  if (!after && state.server) {
    ui.line('warn', `Dashboard restarted, but set-up cannot read where it listens (nothing on port ${port} says it is this Hoprig), and this computer is a server: ${APP} service status`);
    state.serviceLeft = 'unread';
    state.unreadNext = `see what holds port ${port}: ${APP} service status`;
    return false;
  }
  // On Linux a user's service starts with the computer only with lingering on: set-up's lingering step says that part.
  ui.line('ok', `Dashboard running in the background${sys.platform === 'linux' ? '' : ' (starts with the computer)'}`);
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

// The summary's last lines: the dashboard's press first, in the page's own names (web/accounts.js Add provider,
// web/pc.js Health tab), the command only as the other way, so nothing of a first day is a command alone.
const addLine = () => `  Add another provider: on the dashboard, Providers → Add provider (or: ${bold(`${APP} add`)})`;
const checkLine = () => `  Check everything: on the dashboard, Computers → this computer → Health (or: ${bold(`${APP} doctor`)})`;

export async function stepSummary(ui, state, sys = {}) {
  const cfg = loadConfig();
  const host = cfg.server.host || DEFAULT_HOST;
  const port = cfg.server.port || DEFAULT_PORT;
  const local = `http://${host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host}:${port}/`;
  const phoneBase = state.phoneUrl || (host === '0.0.0.0' || host === '::' ? lanUrls(port)[0] : null);
  ui.out();
  if (ui.dryRun) {
    ui.out(`  ${bold('Dry run: nothing was changed.')} ${state.server ? 'At the end, setup shows how to open the dashboard from your own computer.' : 'At the end, setup shows a QR code to open the dashboard on your phone.'}`);
    return;
  }
  if (state.hub && state.hubFailed) {
    ui.out(`  The main computer cannot be reached over HTTPS yet: fix the step marked ✗ above, then run ${bold(`${APP} setup --hub`)} again.`);
    return;
  }
  // The dashboard is not what this run set up (the ✗ or ! above says why): said where the person reads the end.
  if (state.serviceLeft) {
    const why = {
      failed: `the background service did not start: fix the step marked ✗ above, then run ${bold(`${APP} setup`)} again.`,
      held: `an earlier dashboard still holds its port: stop it as the ✗ above says, then run ${bold(`${APP} setup`)} again.`,
      'held-open': `an earlier dashboard still holds its port, open to the network: stop it as the ✗ above says, then run ${bold(`${APP} setup`)} again.`,
      open: `the dashboard running now is still open to the network, and this computer is a server: restart it ${state.restartHow ? `(${state.restartHow}).` : 'as listed below.'}`,
      unread: `set-up cannot read where the dashboard running now listens, and this computer is a server: ${state.unreadNext}.`,
      root: `this is root, and no background service was made for root (the ✗ above says what to do).`,
    }[state.serviceLeft];
    ui.out(`  ${bold(`${APP} is not ready`)}: ${why}`);
    return;
  }
  // A refused choice is said again where the person reads the end: ready, but not the way that was asked.
  ui.out(`  ${state.accessRefused ? `${bold(`${APP} is ready`)}, for ${state.access === 'tailscale' ? 'this computer and your Tailscale devices' : 'this computer only'}: not opened to the network (the ✗ above says why).` : bold(`${APP} is ready.`)}`);
  // As root: the end says the root line again, as information when root is on purpose (a container, the owner's
  // choice) or Hoprig was moved to another user, otherwise with the move to an ordinary user as the next step.
  if (state.root) ui.out(`  This is root, ${state.root.status === 'info' ? `${state.root.detail}.` : `and ${state.root.detail.replace(/^Hoprig works as root here\. /, '')}. Next: ${state.root.fix}`}`);
  // A server (server.mjs): no QR code and no link to an address nobody outside can open, but how to reach it.
  if (state.server && !state.phoneUrl) {
    ui.out('  How to open the dashboard:');
    for (const w of serverWays(port)) ui.out(`    · ${w}`);
    // The command alone on its line, so it can be copied without the words around it.
    ui.out(`        ${forwardLine(port, { sshPort: state.server.sshPort, ...sys, workUser: state.workUser || null })}`);
    if (state.passwordFile) ui.out(`  Password, if asked: in ${tilde(state.passwordFile)}`);
    ui.out(addLine());
    ui.out(checkLine());
    return;
  }
  const link = phoneBase && !ui.dryRun ? await loginLink(phoneBase) : null;
  const target = link ? link.url : phoneBase;
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
      ui.out(`  Connect each of your computers to it (the code works once, for 10 minutes): ${bold(line)}`);
      if (note) ui.out(`  ${note}`);
    } catch {
      ui.out(`  Connect each of your computers to it: on this main computer run ${bold(`${APP} machines invite`)}, then on the other computer ${bold(`${APP} join ${base} <code>`)}`);
    }
    ui.out(checkLine());
    return;
  }
  ui.out(addLine());
  ui.out(checkLine());
}

/** Run every step. Returns 0 when the dashboard can work, 1 when something needed is missing, 2 on bad options. */
/**
 * What a set-up run did, for its field report (src/field/wire.mjs reportSetup): whether this computer is a server, each
 * step by the product's own id with how it ended, and the class of what went wrong first. Only facts of the run's own
 * state: never a message, a path or an address.
 */
function summarize(state, ok, parts) {
  const steps = [];
  const add = (id, good) => good !== undefined && steps.push({ id, end: good ? 'ok' : 'failed' });
  if (!state.hub) {
    add('claude', ok.claude);
    add('terminal', ok.term);
  }
  add('password', ok.pw);
  if (state.hub) add('https', ok.https);
  else add('access', ok.access);
  if (ok.base) add('service', !state.serviceLeft);
  for (const r of parts) add(r.part, r.ok);
  const left = state.serviceLeft;
  const error = state.accessRefused || left === 'open' || left === 'held-open' || (!ok.access && state.server) ? 'open-to-network'
    : left === 'held' ? 'port-in-use'
      : left === 'failed' || left === 'unread' ? 'service-failed'
        : !ok.claude ? 'missing-program'
          : !ok.term ? 'terminal-module'
            : !ok.pw ? 'not-set-up'
              : parts.some((r) => !r.ok && r.part === 'pc') ? 'install-failed'
                : 'other';
  return { server: !!state.server, steps, error };
}

export async function setup(args = [], { ui: givenUi, sys = sysInfo(), parts: partsOver = {}, summary = null } = {}) {
  let opts;
  try {
    opts = parseSetupArgs(args);
  } catch (e) {
    process.stderr.write(`${APP} setup: ${e.message}\n${SETUP_USAGE}\n`);
    return 2;
  }
  const ui = collectTodo(givenUi || makeUi({ yes: opts.yes, dryRun: opts.dryRun }));
  const state = { changed: false, phoneUrl: null, passwordFile: null, access: null };
  // As root, the work user Hoprig made (rootfacts.mjs): the closing ssh line names it, never root@. `sys.workUser` from tests.
  if (sys.workUser !== undefined) state.workUser = sys.workUser;
  else if (sys.root === true && sys.platform !== 'win32') state.workUser = await findWorkUser().catch(() => null);
  ui.out(`${bold(`${APP} setup`)} ${dim(`${appVersion() || ''} · ${osName(sys.platform, sys.release)}${opts.dryRun ? ' · dry run' : ''}`)}`);
  // A locale the terminal sent that this computer lacks: said once, and every program of set-up (and the service it
  // writes) runs with one that is there.
  {
    const locales = sys.locales !== undefined ? sys.locales : installedLocales(sys.platform);
    const missing = missingLocale(sys.env, locales);
    if (missing) {
      sys = { ...sys, env: withWorkingLocale(sys.env, locales) };
      // The parts after the dashboard's steps (computer, Git, workspace) start their programs with this process's own
      // environment: it gets the same locale.
      const own = withWorkingLocale(process.env, locales);
      for (const k of LOCALE_VARS) {
        if (own[k] === undefined) delete process.env[k];
        else process.env[k] = own[k];
      }
      ui.line('warn', localeWords(missing, sys.env.LANG, sys));
    }
  }
  // Root: said once, before anything is set up, in the doctor's own words (rootCheck in rootfacts.mjs). --stay-root is
  // the owner's choice, kept in the settings, after which it is information and nothing nags.
  if (sys.root === true && sys.platform !== 'win32') {
    // A fresh set-up as root makes the work user, through the one implementation of it (install.sh, rootwork.mjs):
    // the same steps, the same question. `sys.workSetup` is handed in by tests.
    const onPurpose = workAsRootAllowed({ ...rootFacts({ env: sys.env, exists: sys.exists, cfg: loadConfig() }), root: true, stay: opts.stayRoot || loadConfig()[STAY_ROOT_KEY] === true });
    if (!onPurpose && freshRoot({ serviceInstalled: await serviceInstalled(sys), cfg: loadConfig() })) {
      ui.line('info', FRESH_ROOT_START);
      const code = await (sys.workSetup || runWorkSetup)(args, { env: sys.env });
      if (summary) Object.assign(summary, { server: false, steps: [{ id: 'work-user', end: code === 0 ? 'done' : 'failed' }], error: code === 0 ? null : 'other' });
      return code;
    }
    if (opts.stayRoot && !opts.dryRun && loadConfig()[STAY_ROOT_KEY] !== true) saveConfig({ [STAY_ROOT_KEY]: true });
    const cfgNow = opts.stayRoot ? { ...loadConfig(), [STAY_ROOT_KEY]: true } : loadConfig();
    const r = rootCheck({ ...rootFacts({ env: sys.env, exists: sys.exists, cfg: cfgNow }), root: true });
    if (r) ui.line(r.status, `${r.label}: ${r.detail}${r.fix ? `. Next: ${r.fix}` : ''}`);
    state.root = r; // said again at the end (stepSummary), where the person reads
  }
  const node = nodeCheck();
  ui.line(node.status, `Node.js ${node.detail}`);
  if (node.status !== 'ok') {
    ui.note(node.fix);
    if (summary) Object.assign(summary, { server: false, steps: [{ id: 'node', end: 'failed' }], error: 'node-too-old' });
    return 1;
  }
  // The command in every shell (also over ssh and in a non-interactive login shell), before anything else.
  {
    const c = ensureCommand({ dryRun: opts.dryRun, home: sys.env.HOME || undefined, platform: sys.platform, shell: sys.env.SHELL || '' });
    for (const l of [...c.did, ...c.kept]) ui.line('ok', l);
    // This shell does not read the line it just got: a new terminal finds the command by its name.
    const localBin = path.join(sys.env.HOME || os.homedir(), '.local', 'bin');
    if (!opts.dryRun && c.did.some((l) => l.includes('to PATH')) && !String(sys.env.PATH || '').split(path.delimiter).includes(localBin)) ui.todo('terminal');
  }
  // A hub only shows and relays other computers: no Claude Code, no account and no terminal are needed on it.
  const hub = opts.hub || loadConfig().hubOnly === true;
  const doBase = !opts.only || opts.only === 'base';
  let claudeOk = true;
  let termOk = true;
  let pwOk = true;
  let httpsOk = true;
  let accessOk = true;
  if (!doBase) {
    // --only pc|project|skills: just that part.
  } else if (hub) {
    if (opts.hub && !opts.dryRun && loadConfig().hubOnly !== true) saveConfig({ hubOnly: true });
    ui.line('info', 'Main computer only: this computer shows your other computers. Claude Code is not needed here.');
  } else {
    claudeOk = await stepClaude(ui, sys, state);
    if (claudeOk) await stepLogin(ui, sys);
    termOk = await stepTerminal(ui, sys);
    await stepProfile(ui);
  }
  if ((opts.domain || opts.ip || opts.tlsInternal) && !hub) {
    ui.line('fail', `--domain and --ip are for a main computer: ${APP} setup --hub --domain …`);
    return 2;
  }
  if (doBase) {
    pwOk = await stepPassword(ui, opts, state);
    // A hub on a server with a public address (or a domain) gets HTTPS in front; a hub at home answers the question.
    const https = hub ? await stepHttps(ui, sys, opts, state) : null;
    if (https === null) accessOk = await stepAccess(ui, sys, opts, state);
    else httpsOk = https;
    state.hubFailed = https === false;
    await stepService(ui, sys, opts, state);
    if (https) await stepHttpsVerify(ui, state);
    // Lingering (Linux, a systemd user service): one of the sudo steps the computer step lists and runs.
    // Not for root when no service was made for root (stepService said why).
    if (opts.service && !state.rootRefused && sys.platform === 'linux' && (await serviceSupported(sys))) state.linger = await lingerPlan(sys);
  }
  // Then, in the same run: this computer for coding, a project, skills. A hub stops here: it codes nothing itself.
  let parts = [];
  // The computer step takes set-up's own facts (a fresh look would read this process's platform and package manager).
  const pcOpts = { ...opts, pcFacts: { platform: sys.platform, ...(sys.pm ? { pm: sys.pm } : {}), root: sys.root, env: sys.env, user: sys.user, release: sys.release }, extraSteps: state.linger && state.linger.step ? [state.linger.step] : [] };
  // Right after the computer step that ran it: what came of it.
  if (pcOpts.extraSteps.length && !opts.dryRun) pcOpts.afterPc = async () => { state.lingerOn = await lingerOutcome(ui, sys); state.lingerSaid = true; };
  if (hub && opts.only && opts.only !== 'base') ui.line('info', 'This main computer only shows your other computers, so it has no computer, project or skills step.');
  else if (!hub && opts.only !== 'base') parts = await runParts(ui, pcOpts, { only: opts.only, parts: partsOver });
  if (state.linger && (state.linger.step || state.linger.manual)) {
    // The computer step did not run (--only base, a hub): the step is listed and asked on its own.
    if (state.linger.step && !pcOpts.extraRan && !opts.dryRun) await runLingerAlone(ui, sys, state.linger.step);
    if (state.linger.step && !pcOpts.extraRan && opts.dryRun) ui.line('info', `Would run: ${showCommand(state.linger.step.argv)} (keeps the dashboard running after you log out)`);
    if (!opts.dryRun && !state.lingerSaid) state.lingerOn = await lingerOutcome(ui, sys, { manual: state.linger.manual });
  }
  reportParts(ui, parts);
  state.hub = hub;
  if (doBase) await stepSummary(ui, state, sys);
  closingList(ui);
  if (opts.dryRun) return 0;
  if (summary) Object.assign(summary, summarize(state, { claude: claudeOk, term: termOk, pw: pwOk, https: httpsOk, access: accessOk, base: doBase }, parts));
  return claudeOk && termOk && pwOk && httpsOk && accessOk && !state.serviceLeft && parts.every((r) => r.ok) ? 0 : 1;
}

