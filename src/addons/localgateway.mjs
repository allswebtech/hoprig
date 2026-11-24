// A gateway add-on made from a definition: a program on this computer that offers Claude's API on a local port and
// passes it on to other AI providers (you add those in the gateway's own page). As a Hoprig profile it is an "api"
// account that Auto mode can fall back to. The definitions are data (gateways.mjs): the ones Hoprig ships, and the
// ones the owner defined himself.
//
// A definition: { id, title, summary, homepage,
//   npm        the npm package that installs and updates it, or null: then `bin` is a program already on the computer
//   allowScripts  (a shipped one only) the packages of it whose install scripts npm may run, as its README names them
//   bin        the program: a plain name found on PATH, or an absolute path
//   port       the default port (config.json addons.<id>.port changes it)
//   args       how the port is passed: a list of words in which PORT stands for the port
//   version    the arguments that make it print its version, or null (never asked then)
//   dashboard  the path of its own page on the port, or null when it has none
//   profile    { name, label, token }: the provider `addons setup` and the page write (token: the variable of its key)
//   words      { what, choice, add, key }: the sentences of the page's steps (what it is, the line under "Other
//              providers", what to do in its page, how to get a key there) }
// shipped: a gateway Hoprig itself ships. Only such a one may be started through cmd.exe (an npm .cmd shim on
// Windows, every argument escaped: startPlan); one the owner defined never is. Nothing starts through shell: true.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { knock } from '../knock.mjs';
import { binFile, stateDir } from '../paths.mjs';
import { filedProcess, system } from '../procid.mjs';
import { workspaceDir } from '../workspace/layout.mjs';
import { belongsTo, groupOf, parentOf } from './proctree.mjs';
import { capture, npmArgv, showCommand, stream, which } from '../setup/system.mjs';
import { windowsSpawnPlan } from '../winspawn.mjs';
import { forGateway, forInstalls } from '../secretenv.mjs';
import { servicePid } from './gatewayservice.mjs';
import { FirstLines } from './firstlines.mjs';

// The filter a gateway's output goes through when its definition names its first password's line (firstlines.mjs).
const FILTER = fileURLToPath(new URL('./firstlines.mjs', import.meta.url));
import { openHost, serverReason } from '../setup/server.mjs';
import { runningDashboard } from '../server/dashboardfile.mjs';
import { resolveListen } from '../server/serveopts.mjs';

// A package name as npm takes it, stricter: no flag, no path, no version (allowScripts holds names only).
const PACKAGE_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,99}\/)?[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * npm's flags for installing `def.npm`: --allow-scripts=<allowScripts> and --loglevel=error when the definition names
 * parts whose install scripts may run (npm 11 prints four warning lines about them without the log level; an npm
 * that does not know --allow-scripts takes it as an unknown setting and says nothing at that level). [] when it names
 * none, null when a name is not a package name: then nothing is installed.
 */
export function installFlags(def) {
  const names = def.allowScripts ?? [];
  if (!Array.isArray(names) || !names.every((n) => typeof n === 'string' && PACKAGE_RE.test(n))) return null;
  return names.length ? [`--allow-scripts=${names.join(',')}`, '--loglevel=error'] : [];
}

const COUNT = ['No', 'One', 'Two', 'Three', 'Four', 'Five'];

/** The one line the Install confirmation says about the parts that build a helper, or null when none does. */
export function buildsLine(def) {
  const names = installFlags(def) ? def.allowScripts || [] : [];
  if (!names.length) return null;
  const n = names.length;
  return `${COUNT[n] || n} of its parts (${names.join(', ')}) ${n === 1 ? 'builds a helper program' : 'build a helper program each'} on this computer while it installs.`;
}

/** The npm command that installs (or, with `spec`, updates) `def.npm`, with its flags. */
export function installArgv(def, spec = def.npm) {
  const flags = installFlags(def);
  return flags ? npmArgv(['install', '-g', ...flags, spec]) : null;
}

/** Does something answer on the port? */
export async function listening(p, host = '127.0.0.1', timeoutMs = 3000) {
  return (await knock({ port: p, host }, timeoutMs)) === 'open';
}

/** The sha256 of a file's contents, as hex: the fingerprint a program the owner defined is kept with. */
export const fileSha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// The fingerprints status() shows, by the file's identity and times: the add-ons list asks often, and a program can be
// large. A start never uses this: it reads the file again.
const seenSha = new Map();
function cachedSha256(file) {
  const st = fs.statSync(file);
  const key = `${file}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
  if (!seenSha.has(key)) {
    if (seenSha.size > 64) seenSha.clear();
    seenSha.set(key, fileSha256(file));
  }
  return seenSha.get(key);
}

/** May this user run the file? (POSIX: its x bit for us; Windows has none to read.) */
export function executable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export const notExecutable = (file) => `the program ${file} is not executable: make it so with chmod +x ${file}`;

/** Is the real path `real` inside the workspace (its real path too), where sessions write? */
export function insideWorkspace(real, workspace = workspaceDir()) {
  let ws = path.resolve(workspace);
  try {
    ws = fs.realpathSync(ws);
  } catch {
    /* no workspace folder yet */
  }
  const rel = path.relative(ws, real);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The first of `file` and the folders above it that someone other than the owner (or the system) can change, or null.
 * Writable by everyone, or owned by another user, is never accepted. Writable by its group only when that group is the
 * owner's own primary group on Linux (a user-private group, the default there, with umask 002 making folders group-
 * writable). A folder that everyone may write with the sticky bit (/tmp) is fine: there nobody replaces another's file.
 */
export function changeableByOthers(file, platform = process.platform) {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  for (let p = file; ; p = path.dirname(p)) {
    const st = fs.statSync(p);
    const sticky = st.isDirectory() && (st.mode & 0o1000) !== 0;
    if (st.uid !== uid && st.uid !== 0) return p;
    if ((st.mode & 0o002) && !sticky) return p;
    if ((st.mode & 0o020) && !sticky && !(platform === 'linux' && st.gid === gid)) return p;
    if (path.dirname(p) === p) return null;
  }
}

/**
 * The program `def.bin` of the npm package `def.npm` as npm installs it globally: the first one on PATH whose file is
 * inside <prefix>/lib/node_modules/<package>/, the global folder's layout (POSIX), and not inside the workspace, where
 * sessions write (a folder there can be laid out like the global one), and in no folder others can change (the rule
 * pinProgram applies to a program: a folder everyone may write can be laid out like the global one too). A file of
 * that name that is something else (a project's node_modules/.bin copy, another program) is passed over. → its path on
 * PATH, or null.
 */
export function packageProgram(def, envPath = process.env.PATH || '') {
  if (process.platform === 'win32') return which(def.bin); // an npm definition is refused there (gateways.mjs)
  const inside = `${path.sep}lib${path.sep}node_modules${path.sep}${def.npm.split('/').join(path.sep)}${path.sep}`;
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const file = path.join(dir, def.bin);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      const real = fs.realpathSync(file);
      if (fs.statSync(file).isFile() && real.includes(inside) && !insideWorkspace(real) && !changeableByOthers(real)) return file;
    } catch {
      /* not here */
    }
  }
  return null;
}

/**
 * How a gateway's program is started: { command, args, options } for spawn. Never through a shell (shell: true joins
 * the arguments unescaped, which Node warns about as DEP0190): on Windows an npm .cmd shim goes to cmd.exe with every
 * argument escaped (winspawn.mjs), an .exe starts directly; elsewhere the program itself.
 */
export function startPlan(bin, args, platform = process.platform, env = process.env) {
  return platform === 'win32' ? windowsSpawnPlan(bin, args, env) : { command: bin, args, options: {} };
}

/**
 * The file a program as the owner named it leads to now: an absolute path as it is, a plain name looked up on PATH; or
 * null when there is no such file.
 */
export function typedProgram(typed, lookup = which) {
  const file = path.isAbsolute(typed) ? typed : lookup(typed);
  try {
    return file && fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

const quote = (s) => (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(s) ? s : `"${s}"`);

/** The page's sentences for a gateway, from its definition, with plain ones where it says none. */
export function wordsOf(def) {
  const w = def.words || {};
  return {
    what: w.what || `${def.title} is a gateway on this computer: you add other AI providers in it, and Claude Code uses them through it.`,
    choice: w.choice || `Other AI providers, translated for Claude Code by ${def.title}, a gateway on this computer.`,
    add: w.add || (def.dashboard ? `Open ${def.title} and add your provider there.` : `Add your provider in ${def.title}, as its own instructions say.`),
    key: w.key || `In ${def.title}, create an API key.`,
  };
}

/** The argument list a start passes: `args` with PORT replaced by the port, then `extra` (hostArgs). */
export const startArgs = (def, port, extra = []) => [...(def.args || ['--port', 'PORT']).map((a) => a.replaceAll('PORT', String(port))), ...extra];

/**
 * Where the dashboard of this computer listens: the running one's own address (dashboard.json, written when it listens:
 * `serve --host`, HOST or the settings, whichever it started with); with none running, what a start would take
 * (serveopts.mjs resolveListen: HOST, then the settings). '' is every address, as for the server.
 */
export function dashboardHost({ env = process.env, cfg = loadConfig() } = {}) {
  const d = runningDashboard();
  const host = d ? d.host : resolveListen({ env, server: cfg.server || {}, defaults: { host: '127.0.0.1', port: 7433 } }).host;
  return host === '' ? '0.0.0.0' : host;
}

/** Is the dashboard reached over Tailscale (set-up's choice: a ts.net origin; it keeps listening on this computer)? */
const viaTailscale = (cfg = loadConfig()) => (cfg.server?.allowedOrigins || []).some((o) => /^https:\/\/[^/]+\.ts\.net$/.test(o));

/**
 * The arguments that keep a gateway Hoprig starts no wider than the dashboard of this computer: its definition's
 * `localOnly` (a shipped one's, or the owner's own words) on a server (`reason`, server.mjs serverReason) and wherever the dashboard listens on
 * this computer only; none where the owner opened the dashboard to his network or reaches it over Tailscale from his
 * other devices (as before, so a page he opens from another device at home stays open).
 */
export function hostArgs(def, { host = dashboardHost(), reason = null, tailscale = viaTailscale() } = {}) {
  const local = Array.isArray(def.localOnly) && def.localOnly.every((a) => typeof a === 'string' && ARG_SAFE.test(a)) ? def.localOnly : [];
  return local.length && keepsLocal({ host, reason, tailscale }) ? local : [];
}

/** Does the rule above keep a gateway Hoprig starts on this computer (a server, or a dashboard on this computer only)? */
export function keepsLocal({ host = dashboardHost(), reason = null, tailscale = viaTailscale() } = {}) {
  return Boolean(reason || (!openHost(host || '127.0.0.1') && !tailscale));
}

/**
 * How a start listens, the same for every start (Health, Settings → Add-ons, Tia, a session's PRERUN, the start after
 * an update, its service): where the rule keeps it on this computer, its definition's localOnly words and HOST=127.0.0.1
 * (which most servers read); elsewhere nothing is added, as before. → { args, env }.
 */
export function listenRule(def, opts = {}) {
  const o = { host: opts.host ?? dashboardHost(), reason: opts.reason ?? null, tailscale: opts.tailscale ?? viaTailscale() };
  return keepsLocal(o) ? { args: hostArgs(def, o), env: { HOST: '127.0.0.1' } } : { args: [], env: {} };
}
const ARG_SAFE = /^[A-Za-z0-9._=:,@/+-]{1,200}$/;

// A line of a gateway's output that may hold its first password, a token or a key: never part of an answer.
const SECRETISH = /pass(word|phrase)?|token|secret|\bkey\b|api[-_ ]?key|credential/i;

/**
 * "It said: …" with the last lines a start added to the gateway's output (from byte `from`), in an answer the page
 * shows: a person cannot open a file on a server. A line that may hold a password is left out.
 */
export function saidLines(file, from = 0) {
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(from, size - 4096);
      const buf = Buffer.alloc(Math.max(0, size - start));
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* nothing written */
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).map((l) => (SECRETISH.test(l) ? '(a line that may hold a password, left out)' : l.slice(0, 200)));
  return lines.length ? `It said: ${lines.join(' · ')}` : 'It said nothing.';
}

/** A gateway add-on (see index.mjs for the shape of an add-on) for `def`. */
export function localGateway(def, { shipped = false, reason = () => serverReason() } = {}) {
  const { id, title } = def;
  const port = () => Number(loadConfig().addons?.[id]?.port) || def.port;
  const url = () => `http://localhost:${port()}`;
  const page = () => (def.dashboard ? `${url()}${def.dashboard === '/' ? '' : def.dashboard}` : null);
  // The gateway this add-on started (only start() writes it): { pid, proc } (proc: its identity, procid.mjs), or the
  // bare pid an older version wrote.
  const pidFile = () => path.join(stateDir(), 'addons', `${id}.pid`);
  const logFile = () => path.join(stateDir(), 'addons', `${id}.log`);
  // A program the owner defined runs as the file it was pinned to (gateways.mjs pinProgram), never what PATH finds now.
  // The program of an npm package he defined is the one npm installed globally (packageProgram): a copy of that name
  // earlier on PATH (a project's node_modules/.bin, where a session starts it) is not it. The shipped gateway's is
  // found on PATH, as it always was.
  const pinned = !shipped && !def.npm;
  // What its last start printed first, for its page once (firstlines.mjs): only where its definition names that line.
  const firstLines = new FirstLines();
  const program = () => {
    if (shipped) return which(def.bin);
    if (def.npm) return packageProgram(def);
    try {
      return fs.statSync(def.bin).isFile() ? def.bin : null;
    } catch {
      return null;
    }
  };
  /**
   * Is the pinned program still the one the owner confirmed? null when it is, 'no-fingerprint' for a definition that
   * keeps none (written into config.json by hand), 'changed' when its file is another or its contents differ (an
   * update of the program too). `hash`: how the file is read (status() may use what it read before).
   */
  function confirmState(bin, hash = fileSha256) {
    if (!def.sha256) return 'no-fingerprint';
    try {
      return fs.realpathSync(bin) === def.bin && hash(def.bin) === def.sha256 ? null : 'changed';
    } catch {
      return 'changed'; // unreadable: not shown to be the same
    }
  }
  /**
   * A pinned program whose file is gone: 'gone' when what the owner typed when he added it leads to a program now (an
   * update moved it: confirm shows that one), 'gone-old' for a definition from before that was kept; else null.
   */
  const goneState = () => (!def.typed ? 'gone-old' : typedProgram(def.typed) ? 'gone' : null);
  const confirmStep = (button) => `confirm it with hoprig gateways confirm ${id}, or with ${button} in Settings → Add-ons`;
  /** Why a pinned program may not start now, with the step that keeps its definition, sharing and keys; or null. */
  function notAsConfirmed(bin) {
    const st = confirmState(bin);
    if (st === 'no-fingerprint') return `config.json keeps no fingerprint (sha256) of the program ${def.bin} for ${title}, so Hoprig does not start it: if it is yours, ${confirmStep('Confirm the program')}`;
    return st ? `the program ${def.bin} for ${title} changed after you confirmed it. If you changed it, ${confirmStep('Confirm the new program')}. If you did not, do not confirm it` : null;
  }

  /** What the gateway's port says: "open", "closed" or "silent" (no answer in time), as knock.mjs tells them. */
  const probe = (p = port()) => knock({ port: p, host: '127.0.0.1' });
  const answers = () => listening(port());

  // A gateway the owner defined is only the process this add-on started. Another program that answers on its port (his
  // own server, a service) is never reported as running, never used as the gateway and never stopped: its provider's
  // key would go to it, and a stop would end it. The shipped gateway keeps what it always did: what listens on its
  // port is the gateway.
  const foreignText = (p = port()) => `Another program answers on port ${p}: Hoprig did not start it, so it is not ${title} and it is left alone.`;
  /**
   * What of the gateway is shown to be this add-on's: { onPort: what listens on the port (null: it cannot be found
   * here), leader: the process start() spawned (startedByUs), listener: what listens, when it is that process, its
   * descendant or in the process group it leads (a wrapper script whose server is its grandchild), or the listener
   * start() wrote down (one whose wrapper has ended since) }.
   */
  async function ours(rec = readPidFile()) {
    const onPort = await pidOnPort();
    if (await byService(onPort)) return { onPort, leader: null, listener: onPort, service: true };
    if (!rec) return { onPort, leader: null, listener: null };
    const leader = await startedByUs(rec, onPort);
    let listener = null;
    if (onPort !== null) {
      if (leader !== null && (await belongsTo(onPort, leader)) === true) listener = onPort;
      else if (rec.listener?.pid === onPort && filedProcess(pidFile(), rec.listener, { after: (await system.refresh([onPort])) || 0 }) === true) listener = onPort;
    }
    return { onPort, leader, listener };
  }
  /**
   * Does its service (Health → Gateways → Run as a service) run what listens on the port? Then it is the gateway, as
   * one start() spawned is: the service runs the program Hoprig wrote into its file on the owner's press. A pinned
   * program only while it is the one he confirmed, as start() requires.
   */
  async function byService(onPort) {
    if (shipped || onPort === null) return false;
    const main = await servicePid(id);
    if (main === null || (await belongsTo(onPort, main)) !== true) return false;
    const bin = program();
    return !pinned || (bin !== null && confirmState(bin, cachedSha256) === null);
  }
  /** Does the service of this gateway run what listens on its port (the shipped one's too)? Only asked where its file is. */
  async function serviceRunsIt() {
    const main = await servicePid(id);
    if (main === null) return false;
    const onPort = await pidOnPort();
    return onPort !== null && (await belongsTo(onPort, main)) === true;
  }
  /** It is the gateway: what listens on its port is ours, or (where that cannot be found) the process start() spawned runs. */
  const isOurs = (o) => o.listener !== null || (o.onPort === null && o.leader !== null);
  /** Does the gateway run: its port answers and, for one the owner defined, it is the process this add-on started. */
  async function runs() {
    const up = await answers();
    return { up, mine: up && (shipped || isOurs(await ours())) };
  }

  /** `version: false`: only whether it is installed and runs (the Operator's minute check starts no program for it). */
  async function status({ version: withVersion = true } = {}) {
    const bin = program();
    let version = null;
    if (bin && def.version && withVersion) {
      try {
        const m = /(\d+\.\d+\.\d+[\w.-]*)/.exec((await capture([bin, ...def.version], { timeout: 10_000 })).stdout || '');
        version = m ? m[1] : null;
      } catch {
        /* installed, version unknown */
      }
    }
    const { up, mine } = await runs();
    // needsConfirm: a program of the owner's own that is not started until he confirms it again (confirmState).
    const unconfirmed = !pinned ? null : bin ? confirmState(bin, cachedSha256) : goneState();
    // byService: the copy that runs is its service's (Health → Gateways → Run as a service), not one Hoprig started.
    const byService = mine && (await serviceRunsIt());
    return { installed: Boolean(bin), version, running: mine, url: url(), ...(byService ? { byService: true } : {}), ...(up && !mine ? { foreign: true } : {}), ...(unconfirmed ? { needsConfirm: unconfirmed } : {}) };
  }

  // A program, not a package: nothing to install or update; it is there or it is not.
  async function there(onLine) {
    const ok = Boolean(program());
    onLine(ok ? `${title} is a program on this computer (${program()}): there is nothing to install.` : `${title} is not on this computer: ${def.bin} was not found.`);
    return ok ? { ok } : { ok, error: `the program ${def.bin} was not found` };
  }

  const badFlags = () => ({ ok: false, error: `the definition of ${title} names a part that is not a package name, so it is not installed` });

  async function install({ onLine = () => {} } = {}) {
    if (!def.npm) return there(onLine);
    const argv = installArgv(def);
    if (!argv) return badFlags();
    const r = await stream(argv, { env: forInstalls(process.env), onLine });
    return { ok: r.ok && Boolean(program()) };
  }

  async function update({ onLine = () => {} } = {}) {
    if (!def.npm) return there(onLine);
    const argv = installArgv(def, `${def.npm}@latest`);
    if (!argv) return badFlags();
    const was = (await runs()).mine;
    if (was) await stop();
    const r = await stream(argv, { env: forInstalls(process.env), onLine });
    if (was) await start();
    return { ok: r.ok };
  }

  /**
   * Start it in the background unless it already answers. It keeps running after this process ends. Where it
   * listens is the rule of listenRule, for every caller.
   */
  async function start() {
    const listen = listenRule(def, { reason: reason() });
    const now = await runs();
    if (now.mine) return { ok: true, url: url(), already: true };
    if (now.up) return { ok: false, url: url(), error: `${foreignText()} Stop that program, or give ${title} another port.` };
    const bin = program();
    if (!bin) {
      const gone = pinned ? goneState() : null;
      const error = def.npm ? `${title} is not installed (hoprig addons install ${id})`
        : gone === 'gone' ? `the program ${def.bin} of ${title} is not on this computer any more (an update may have moved it), and ${def.typed} leads to another file now: if that is yours, ${confirmStep('Confirm the program')}`
        : gone === 'gone-old' ? `${title} is not on this computer: ${def.bin} was not found. If an update moved it, name the program it is now: hoprig gateways confirm ${id} --program <path>`
        : `${title} is not on this computer: ${def.bin} was not found`;
      return { ok: false, url: url(), error };
    }
    // A .cmd shim (npm on Windows) only starts through cmd.exe: only for a gateway Hoprig ships, never for one defined
    // in the configuration, which runs exactly the program and arguments its owner confirmed.
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    if (viaShell && !shipped) return { ok: false, url: url(), error: `the program ${bin} would need a shell to start: name the program itself (an .exe, or node with its script)` };
    const changed = pinned ? notAsConfirmed(bin) : null;
    if (changed) return { ok: false, url: url(), error: changed, code: 'gateway-not-confirmed' };
    if (pinned && process.platform !== 'win32' && !executable(bin)) return { ok: false, url: url(), error: notExecutable(bin) };
    fs.mkdirSync(path.dirname(logFile()), { recursive: true, mode: 0o700 });
    const log = fs.openSync(logFile(), 'a', 0o600);
    fs.chmodSync(logFile(), 0o600); // also a log an older version left wider: only this user reads what a gateway prints
    const from = fs.fstatSync(log).size; // what this start adds to its output, for the answer when it fails
    // A gateway of the owner's own gets only what a server needs of the starting process's environment (forGateway):
    // a session's PRERUN runs in that session's, with other providers' keys, cloud credentials and the session's
    // marks. Its own key arrives with each request. The shipped gateway starts as it always did.
    const env = { ...(shipped ? process.env : forGateway(process.env)), ...(listen.env || {}) };
    // Its definition names the line of its first password: its output goes through the filter, which keeps that line
    // out of the log and hands the first lines here, kept in memory for its page only. Else the log is as it prints.
    const marker = typeof def.firstPassword === 'string' && def.firstPassword && !viaShell ? def.firstPassword : null;
    const said = [];
    const child = marker
      ? spawn(process.execPath, [FILTER, logFile(), marker, bin, ...startArgs(def, port(), listen.args)], { detached: true, stdio: ['ignore', 'pipe', log], windowsHide: true, env })
      : (() => {
        // No shell (startPlan): on Windows an npm .cmd shim goes to cmd.exe with every argument escaped.
        const plan = startPlan(bin, startArgs(def, port(), listen.args), process.platform, env);
        return spawn(plan.command, plan.args, { ...plan.options, detached: true, stdio: ['ignore', log, log], windowsHide: true, env });
      })();
    if (marker) {
      let rest = '';
      child.stdout.on('data', (c) => {
        const parts = (rest + c.toString('utf8')).split(/\r?\n/);
        rest = parts.pop();
        for (const l of parts) if (l.trim() && said.length < 20) said.push(l);
      });
      child.stdout.on('error', () => {});
    }
    // When this start has answered: what it said first is kept for its page, and Hoprig stops listening to it.
    const handOver = (r) => {
      if (marker) {
        firstLines.keep(said);
        child.stdout.destroy();
      }
      return r;
    };
    child.on('error', () => {}); // reported below: it never answers on its port
    let failed = null; // it ended with an error before it answered: no need to wait the 30 seconds
    child.on('exit', (code, signal) => {
      if (code !== 0) failed = { code, signal };
    });
    child.unref();
    fs.closeSync(log);
    if (child.pid) {
      const after = await system.refresh([child.pid]);
      fs.writeFileSync(pidFile(), JSON.stringify({ pid: child.pid, proc: system.of([child.pid], { after }).get(child.pid) || null }), { mode: 0o600 });
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (failed && !(await answers())) return handOver({ ok: false, url: url(), error: `${title} stopped at once${failed.code !== null ? ` (exit code ${failed.code})` : ''}. ${saidLines(logFile(), from)}` });
      if (await answers()) {
        if (child.pid) await noteListener(child.pid);
        // One the owner defined that answers but is not shown to be ours detached itself from what Hoprig started
        // (setsid, a daemon mode): it would be called another program right after and could never be stopped.
        if (!shipped && !isOurs(await ours())) {
          await endStarted(child);
          return handOver({ ok: false, url: url(), error: `${title} answered on port ${port()}, but its program detached itself from Hoprig (setsid, a daemon mode), so Hoprig could not stop it: run it in the foreground (without its daemon option) so that Hoprig can stop it. What Hoprig started of it was ended; the program now on port ${port()} is not Hoprig's and is left alone: stop it yourself.` });
        }
        // Its first lines arrive with its page's answer: a moment for what it prints right after it listens.
        if (marker) await new Promise((r) => setTimeout(r, 300));
        return handOver({ ok: true, url: url(), already: false });
      }
    }
    return handOver({ ok: false, url: url(), error: `${title} did not answer on port ${port()} within 30 seconds. ${saidLines(logFile(), from)}` });
  }

  /**
   * End what start() spawned as far as Hoprig can reach it: the process and the process group it leads (it was spawned
   * detached), while that process has not ended (after that, its pid and group id may be handed out again). Not a
   * program that left that group. The pid file goes too.
   */
  async function endStarted(child) {
    const running = () => child.pid && child.exitCode === null && child.signalCode === null;
    if (process.platform !== 'win32') {
      for (const sig of ['SIGTERM', 'SIGKILL']) {
        if (!running()) break;
        try { process.kill(-child.pid, sig); } catch { /* none left in its group */ }
        try { process.kill(child.pid, sig); } catch { /* gone */ }
        if (sig === 'SIGTERM') await new Promise((r) => setTimeout(r, 300));
      }
    }
    fs.rmSync(pidFile(), { force: true });
  }

  // The process that listens on the port, when we did not start it ourselves.
  async function pidOnPort() {
    try {
      if (process.platform === 'win32') {
        const r = await capture(['netstat', '-ano', '-p', 'TCP'], { timeout: 10_000 });
        const line = (r.stdout || '').split('\n').find((l) => /LISTENING/i.test(l) && new RegExp(`[:.]${port()}\\s`).test(l));
        return line ? Number(line.trim().split(/\s+/).pop()) || null : null;
      }
      if (which('lsof')) {
        const r = await capture(['lsof', '-ti', `TCP:${port()}`, '-sTCP:LISTEN'], { timeout: 10_000 });
        return Number((r.stdout || '').trim().split('\n')[0]) || null;
      }
      const r = await capture(['ss', '-ltnpH', `sport = :${port()}`], { timeout: 10_000 });
      const m = /pid=(\d+)/.exec(r.stdout || '');
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }

  /** Write down what listens on the port, when it belongs to the process `pid` just spawned: it may outlive `pid`. */
  async function noteListener(pid) {
    const onPort = await pidOnPort();
    const rec = readPidFile();
    if (!onPort || onPort === pid || rec?.pid !== pid || (await belongsTo(onPort, pid)) !== true) return;
    const after = await system.refresh([onPort]);
    fs.writeFileSync(pidFile(), JSON.stringify({ ...rec, listener: { pid: onPort, proc: system.of([onPort], { after }).get(onPort) || null } }), { mode: 0o600 });
  }

  function readPidFile() {
    try {
      const text = fs.readFileSync(pidFile(), 'utf8').trim();
      const rec = /^\d+$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
      return Number.isInteger(rec?.pid) && rec.pid > 0 ? rec : null;
    } catch {
      return null; // not started by us
    }
  }

  /**
   * The file's pid, when it is shown to be the gateway this add-on started (procid.mjs filedProcess): its identity, or
   * for a file without one, being what listens on the port (`onPort`), its ancestor or group leader (a .cmd shim, a
   * shell) or its parent. Else null: after a restart of the computer that pid may be another program's.
   */
  async function startedByUs(rec, onPort) {
    if (!rec) return null;
    // Without the process on the port nothing is related to it.
    let related = null;
    if (onPort) {
      const [below, down] = await Promise.all([belongsTo(onPort, rec.pid), parentOf(rec.pid)]);
      related = below === true || down === onPort ? true : below === false && down !== null ? false : null;
    }
    const after = (await system.refresh([rec.pid])) || 0;
    return filedProcess(pidFile(), rec, { fact: () => related, after }) === true ? rec.pid : null;
  }

  /**
   * Stop it. The shipped gateway: what listens on its port is the gateway, and the file's pid when it is shown to be
   * ours (startedByUs). One the owner defined: only the process this add-on started, the process group it leads (it
   * was spawned detached: its wrapper's children are in it) and what listens on the port when that is ours (ours()).
   * "Not running" is said only when the port refuses; a port that does not answer in time is a gateway that may run.
   */
  async function stop() {
    const first = await probe();
    if (first === 'closed') return { ok: true, already: true };
    const rec = readPidFile();
    const was = await ours(rec);
    // Run by its service: stopped through it (Health → Gateways), never by a signal here, which its service may undo.
    if (was.service || (shipped && (await serviceRunsIt()))) return { ok: false, error: `${title} runs as a service on this computer: stop it under Health → Gateways, which stops its service`, code: 'gateway-service' };
    // The group the spawned process leads, once that process is shown to be ours. POSIX hands a group's id out again
    // only when no process is left in it, so it stays ours for the SIGKILL below, also after its leader has ended.
    let group = null;
    const signal = async (sig) => {
      const now = await ours(rec);
      if (group === null && now.leader !== null && now.leader !== process.pid && process.platform !== 'win32' && (await groupOf(now.leader)) === now.leader) group = now.leader;
      if (group !== null) try { process.kill(-group, sig); } catch { /* none left in it */ }
      // One the owner defined: what listens on the port only when it is ours.
      for (const p of new Set([shipped ? now.onPort : now.listener, now.leader])) {
        if (p) try { process.kill(p, sig); } catch { /* gone */ }
      }
    };
    // One the owner defined whose port another program holds: that program gets no signal (a process this add-on
    // started that still runs, not the one on the port, is ended).
    if (!shipped && was.listener === null && (was.leader === null || was.onPort !== null)) {
      if (was.leader !== null) await signal('SIGTERM');
      return first === 'open'
        ? { ok: true, already: true, foreign: true, note: foreignText() }
        : { ok: false, error: `Port ${port()} did not answer in time, so it is not known what runs there. Try again in a moment.` };
    }
    await signal('SIGTERM');
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if ((await probe()) === 'closed') {
        fs.rmSync(pidFile(), { force: true });
        return { ok: true };
      }
    }
    await signal('SIGKILL');
    const now = await probe();
    if (now === 'closed') {
      fs.rmSync(pidFile(), { force: true });
      return { ok: true };
    }
    return {
      ok: false,
      error: now === 'open'
        ? `${title} still answers on port ${port()}: the program listening there could not be stopped.`
        : `Port ${port()} did not answer in time, so it is not known whether ${title} still runs. Try again in a moment.`,
    };
  }

  const words = wordsOf(def);
  return {
    id,
    title,
    summary: def.summary || `${title}: a gateway on this computer that offers other AI providers through Claude's API.`,
    homepage: def.homepage || null,
    // An AI gateway with Claude's API on this port: src/gateway finds it on every computer and can share it.
    gateway: { port },
    /** Where it keeps its own data under the home of the user it runs as (gateways.mjs dataDir), or null. */
    dataDir: def.dataDir || null,
    // A program already on the computer: the page offers no Install or Update for it.
    ...(def.npm ? {} : { installable: false }),
    defined: !shipped, // the owner defined it (gateways.mjs): it can be removed
    /** Its definition names the line of its first password: the start keeps that line out of the log, for its page once. */
    marksFirst: Boolean(def.firstPassword),
    /** What its last start printed first: given out once (take), for ten minutes at most; nothing is written. */
    firstLines,
    oldNames: (shipped && def.oldNames) || null, // the names an older page reads for it (gateways.mjs SHIPPED)
    words,
    /** Its own page as this computer reaches it, or null when it has none. */
    page,
    /** What `hoprig gateways` shows and the page's confirmation names: the exact program and arguments it runs. */
    command: () => [def.bin, ...startArgs(def, port(), listenRule(def, { reason: reason() }).args)],
    /** How a start listens now (listenRule): its service is written with the same. */
    listen: () => listenRule(def, { reason: reason() }),
    /** On a server: true when Hoprig keeps it on this computer (its localOnly words), false when it cannot; null elsewhere. */
    keptLocal: () => (reason() ? hostArgs(def, { reason: reason() }).length > 0 : null),
    installHint: () => (def.npm ? showCommand(['npm', 'install', '-g', ...(installFlags(def) || []), def.npm]) : `${def.bin} was not found on this computer`),
    /** The line of the Install confirmation about parts that build a helper (null: none). */
    builds: buildsLine(def),
    status,
    /** { up, mine }: does its port answer, and is what answers the gateway (for one the owner defined: ours()). */
    answering: runs,
    install,
    update,
    start,
    stop,
    /** The profile `addons setup` writes. The key comes from the gateway's own page and is typed by the owner. */
    profile: () => ({
      name: def.profile?.name || id,
      label: def.profile?.label || `API via ${title}`,
      env: { ANTHROPIC_BASE_URL: url() },
      // Started on demand: the first session (or the router) that needs it brings it up.
      prerun: `${quote(process.execPath)} ${quote(binFile())} addons start ${id}`,
      tokenVar: def.profile?.token || 'ANTHROPIC_AUTH_TOKEN',
      tokenHint: page() ? `Open ${page()} , sign in, create an API key and paste it here` : `${words.key} Paste it here`,
    }),
  };
}
