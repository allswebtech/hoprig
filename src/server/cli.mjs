// The dashboard's commands, called by the launcher's bin script: serve, passwd, service.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../config.mjs';
import { stateDir } from '../paths.mjs';
import { generatePassword, hashPassword } from './auth.mjs';
import { DEFAULT_HOST, DEFAULT_PORT, createServer, hasPassword } from './server.mjs';
import { isLoopback } from './security.mjs';
import { notePassword, passwordProblem } from './strength.mjs';
import { firstPassword, passwordFileFrom, publicUrlSettings, resolveListen } from './serveopts.mjs';
import { APP_NAME } from './brand.mjs';
import { service, serviceInstalled } from './service/index.mjs';
import { listenTakingOver } from './takeover.mjs';

const A = APP_NAME;
export const USAGE = `usage:
  ${A} serve [--host H] [--port P] [--password-file F] [--take-over]
                                       start the dashboard (default ${DEFAULT_HOST}:${DEFAULT_PORT}; HOST and PORT in the
                                       environment also work; with no password set yet, F gets a new one;
                                       --take-over ends this Hoprig's dashboard on that port first)
  ${A} passwd                          set the dashboard password (asked twice, not shown)
  ${A} passwd --generate <file>        write a random password to <file> (mode 600) and use it
  ${A} stop                            stop the dashboard; it stays stopped until you start it
  ${A} service install|uninstall|status|start|stop|restart
                                       run the dashboard in the background from login
                                       (systemd on Linux, launchd on macOS, Task Scheduler on Windows)
`;

/**
 * What the keeper left and what a start settles (src/keeper/keep.mjs): the owner's stop is over, the note of a mend or a
 * rollback becomes one Activity line, and a new version that stays up for a minute has passed its start check.
 */
async function afterStart() {
  try {
    const keeper = await import('../keeper/keep.mjs');
    const { createActivityLog } = await import('../automation/store.mjs');
    const state = stateDir();
    keeper.confirmStart({ state });
    const { serviceFiles, serviceInstalled } = await import('./service/index.mjs');
    if (serviceInstalled(process.platform)) {
      const reload = process.platform === 'linux' ? () => service('reload') : null;
      const written = await keeper.refreshFiles({ files: () => serviceFiles(process.platform), reload });
      if (written.length) keeper.logLine(state, `wrote the service files again at a start (${written.length} of them differed)`);
    }
    keeper.announceNote({ state, activity: createActivityLog(path.join(state, 'automation.log')).add });
    // The version this process loaded, not the one on disk now (an update may be replacing the files under it).
    const { ownVersion } = await import('./dashboardfile.mjs');
    const version = ownVersion();
    setTimeout(() => keeper.confirmStart({ state, version, verify: true }), keeper.START_CHECK_MS).unref();
  } catch {
    /* the keeper's bookkeeping never stops a dashboard from starting */
  }
}

/** Read a line from the terminal without echoing it. */
function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(prompt);
    let value = '';
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.resume();
    const done = (fn) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stdout.write('\n');
      fn();
    };
    function onData(chunk) {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    }
    input.on('data', onData);
  });
}

async function setPassword(password) {
  const hash = await hashPassword(password);
  saveConfig({ server: { passwordHash: hash } });
  notePassword(password, hash); // whether it is strong enough for the public link (only the result is kept)
  // A new password logs every browser out.
  try {
    fs.unlinkSync(path.join(stateDir(), 'web-sessions.json'));
  } catch {
    /* none yet */
  }
}

async function passwd(args) {
  if (args[0] === '--generate') {
    const file = args[1];
    if (!file) {
      console.error(`usage: ${A} passwd --generate <file>`);
      return 2;
    }
    const target = path.resolve(file);
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
      console.error(`${target} is a folder; give a file name`);
      return 2;
    }
    const pw = generatePassword();
    fs.writeFileSync(target, pw + '\n', { mode: 0o600 });
    fs.chmodSync(target, 0o600); // writeFileSync keeps the mode of a file that already existed
    await setPassword(pw);
    console.log(`New dashboard password written to ${target}`);
    return 0;
  }
  if (args.length) {
    process.stderr.write(USAGE);
    return 2;
  }
  // While the public link is on, the page can be reached from anywhere: no weak password then.
  const weak = (pw) => {
    const why = loadConfig().publicLink?.on === true ? passwordProblem(pw) : null;
    if (why) console.error(`The public link is on, so the password must be strong: ${why}. Nothing changed. Or: ${A} passwd --generate <file>`);
    return !!why;
  };
  if (!process.stdin.isTTY) {
    // Piped in (e.g. from a password manager): the first line is the password, no confirmation.
    let text = '';
    for await (const c of process.stdin) text += c;
    const pw = text.split(/\r?\n/)[0];
    if (pw.length < 8) {
      console.error('Use at least 8 characters.');
      return 1;
    }
    if (weak(pw)) return 1;
    await setPassword(pw);
    console.log('Dashboard password set.');
    return 0;
  }
  const a = await askHidden('New dashboard password: ');
  if (a.length < 8) {
    console.error('Use at least 8 characters.');
    return 1;
  }
  if (weak(a)) return 1;
  const b = await askHidden('Again: ');
  if (a !== b) {
    console.error('The two did not match; nothing changed.');
    return 1;
  }
  await setPassword(a);
  console.log('Dashboard password set. Every browser that was logged in has to log in again.');
  return 0;
}

function parseServeArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const val = (name) => {
      const m = a.startsWith(`${name}=`) ? a.slice(name.length + 1) : args[++i];
      if (m === undefined) throw new Error(`${name} needs a value`);
      return m;
    };
    if (a === '--host' || a.startsWith('--host=')) out.host = val('--host');
    else if (a === '--port' || a.startsWith('--port=')) {
      const p = Number(val('--port'));
      if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('--port must be 1-65535');
      out.port = p;
    } else if (a === '--password-file' || a.startsWith('--password-file=')) out.passwordFile = val('--password-file');
    else if (a === '--take-over') out.takeOver = true;
    // The move to an ordinary user (src/setup/moveswitch.mjs) tries the user's dashboard on copied settings first: it
    // answers, and starts nothing of its own (no restored sessions, no public link, no gateway, no looks).
    else if (a === '--trial') out.trial = true;
    else throw new Error(`unknown option ${a}`);
  }
  return out;
}

async function serve(args) {
  let o;
  try {
    o = parseServeArgs(args);
  } catch (e) {
    console.error(`${A} serve: ${e.message}`);
    return 2;
  }
  // An unattended first start (a hosting panel, Docker): no password yet, but a file is named for it.
  const pwFile = passwordFileFrom({ flags: o });
  if (!hasPassword() && pwFile) {
    try {
      const r = await firstPassword(pwFile, { setPassword, generate: generatePassword });
      console.log(r.created ? `New dashboard password written to ${pwFile}` : `Dashboard password taken from ${pwFile}`);
    } catch (e) {
      console.error(`${A} serve: ${e.message}`);
      return 1;
    }
  }
  if (!hasPassword()) {
    console.error(`${A} serve: no dashboard password is set. Set one first:\n\n  ${A} passwd\n\nor, to generate one into a file:\n\n  ${A} passwd --generate ~/${A}-password.txt`);
    return 1;
  }
  if (process.env.HOPRIG_PUBLIC_URL) {
    const patch = publicUrlSettings(process.env.HOPRIG_PUBLIC_URL, loadConfig().server);
    if (patch) saveConfig({ server: patch });
    else if (!/^https:\/\//.test(process.env.HOPRIG_PUBLIC_URL.trim())) console.error(`${A} serve: HOPRIG_PUBLIC_URL must be an https:// address; ignored`);
  }
  let host;
  let port;
  try {
    ({ host, port } = resolveListen({ flags: o, server: loadConfig().server, defaults: { host: DEFAULT_HOST, port: DEFAULT_PORT } }));
  } catch (e) {
    console.error(`${A} serve: ${e.message}`);
    return 2;
  }
  // A trial (--trial) starts nothing of its own, and asks no sign-in check either.
  const app = o.trial ? createServer({ host, port, watch: false, startFeatures: false }) : createServer({ host, port, loginCheck: true });
  try {
    await listenTakingOver(() => app.listen(port, host), port, { takeOver: o.takeOver === true });
  } catch (e) {
    console.error(`${A} serve: cannot listen on ${host}:${port}: ${e.message}`);
    return 1;
  }
  if (!o.trial) await afterStart();
  const urls = [];
  if (host === '0.0.0.0' || host === '::') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4') urls.push(`http://${a.address}:${port}/`);
    }
  } else urls.push(`http://${host.includes(':') ? `[${host}]` : host}:${port}/`);
  console.log(`${A} dashboard: ${urls.join('  ')}`);
  if (!isLoopback(host)) {
    console.log('Plain HTTP is not encrypted: use it only on a network you trust, or put it behind HTTPS (Tailscale, a reverse proxy).');
  }
  if (app.backend.kind === 'none') console.log(app.backend.message);
  else console.log(`Sessions run on the ${app.backend.kind} backend.${app.backend.capabilities.persistent ? '' : ' They end when this server stops.'}`);
  // Stop the server, then the backend: the pty backend ends its sessions cleanly (Claude gets SIGHUP and saves);
  // tmux sessions keep running. The timer is the backstop if something hangs. It must outlast a clean stop of the
  // built-in terminals (their programs get STOP_WAIT_MS, then the shell as long, then what ignored SIGHUP gets
  // SIGTERM): cut short before that last step, a nohup job would outlive the dashboard.
  const stop = () => {
    app.close()
      .then(() => app.backend.close())
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  // SIGTERM never arrives on Windows; there Ctrl+Break (SIGBREAK) and closing the console window (SIGHUP) do.
  const signals = process.platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const sig of signals) process.once(sig, stop);
  return null; // keep running
}

/**
 * `hoprig stop`: the owner's stop. With the background service it is the service's own stop (so the service manager and
 * the keeper leave it stopped); a dashboard started by hand in a terminal is ended as a start over it would end it.
 */
export async function stopDashboard({ installed = serviceInstalled, stopService = () => service('stop'), endOld = null } = {}) {
  if (installed()) return stopService();
  const { endOldDashboard } = await import('./takeover.mjs');
  const r = await (endOld || endOldDashboard)();
  if (r.ended) {
    console.log(`The dashboard (process ${r.ended}) was stopped.`);
    return 0;
  }
  console.error(r.why || r.left || 'No dashboard of this Hoprig is running.');
  return r.why ? 1 : 0;
}

/** Entry point from the bin script. Returns an exit code, or null while the server runs. */
export async function main(command, args = []) {
  // --help prints the usage (before, "serve --help" only said "unknown option" and showed none).
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (command) {
    case 'serve':
      return serve(args);
    case 'passwd':
      return passwd(args);
    case 'stop':
      return stopDashboard();
    case 'service':
      // As root on a computer where Hoprig was never set up for root: the same making of the work user as set-up's.
      if (args[0] === 'install') {
        const code = await freshRootSetup();
        if (code !== null) return code;
      }
      if (args[0] === 'install' && !hasPassword()) {
        console.error(`Set a dashboard password first (${A} passwd).`);
        return 1;
      }
      if (args[0] === 'install') return installWithReport();
      return service(args[0]);
    // Hidden: the detached helper of a restart asked for from the dashboard's own page (selfrestart.mjs). Not in the
    // usage; a person never types it.
    case '__service-restart': {
      const { restartAfterExit } = await import('./selfrestart.mjs');
      return restartAfterExit(args[0]);
    }
    default:
      process.stderr.write(USAGE);
      return 2;
  }
}

/**
 * "service install" restarts the dashboard. When the one running before was another version (an update of Hoprig went
 * before it), that restart is the go-live: a field report says whether it restarted and the new version answers
 * (src/field/wire.mjs reportRestart). Reading the running dashboard never fails the install.
 */
/**
 * `service install` as root, not on purpose, with Hoprig never set up for root: runs the installer that makes the work
 * user (rootwork.mjs) and returns its exit code; null in every other case (the command goes on as before). `facts`,
 * `installed` and `work` are handed in by tests.
 */
export async function freshRootSetup({ facts, installed, work } = {}) {
  const R = await import('../setup/rootfacts.mjs');
  const f = facts || R.rootFacts({ cfg: loadConfig() });
  if (!f.root || R.workAsRootAllowed(f)) return null;
  const W = await import('../setup/rootwork.mjs');
  const { serviceInstalled } = await import('./service/index.mjs');
  if (!W.freshRoot({ serviceInstalled: installed ?? serviceInstalled(), cfg: loadConfig() })) return null;
  console.log(W.FRESH_ROOT_START);
  return (work || W.runWorkSetup)([]);
}

export async function installWithReport({ facts, run = () => service('install'), wait = 250, tries = 20 } = {}) {
  const ask = facts || (async () => (await import('../setup/running.mjs')).runningFacts().catch(() => null));
  const startedAt = Date.now();
  const before = await ask().catch(() => null);
  const code = await run();
  let after = null;
  if (before && code === 0) {
    for (let i = 0; i < tries && !(after && after.version && after.pid !== before.pid); i++) {
      after = await ask().catch(() => null);
      if (!(after && after.version && after.pid !== before.pid)) await new Promise((r) => setTimeout(r, wait));
    }
  }
  const { reportRestart } = await import('../field/wire.mjs');
  const { appVersion } = await import('../setup/checks.mjs');
  reportRestart({ before, code, after, mine: appVersion(), startedAt });
  return code;
}
