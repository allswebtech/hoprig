// A gateway add-on made from a definition: a program on this computer that offers Claude's API on a local port and
// passes it on to other AI providers (you add those in the gateway's own page). As a Hoprig profile it is an "api"
// account that Auto mode can fall back to. The definitions are data (gateways.mjs): the ones Hoprig ships, and the
// ones the owner defined himself.
//
// A definition: { id, title, summary, homepage,
//   npm        the npm package that installs and updates it, or null: then `bin` is a program already on the computer
//   bin        the program: a plain name found on PATH, or an absolute path
//   port       the default port (config.json addons.<id>.port changes it)
//   args       how the port is passed: a list of words in which PORT stands for the port
//   version    the arguments that make it print its version, or null (never asked then)
//   dashboard  the path of its own page on the port, or null when it has none
//   profile    { name, label, token }: the provider `addons setup` and the page write (token: the variable of its key)
//   words      { what, choice, add, key }: the sentences of the page's steps (what it is, the line under "Other
//              providers", what to do in its page, how to get a key there) }
// shipped: a gateway Hoprig itself ships. Only such a one may be started through a shell (an npm .cmd shim on
// Windows); one the owner defined never is.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { knock } from '../knock.mjs';
import { binFile, stateDir } from '../paths.mjs';
import { filedProcess, system } from '../procid.mjs';
import { workspaceDir } from '../workspace/layout.mjs';
import { belongsTo, groupOf, parentOf } from './proctree.mjs';
import { capture, npmArgv, stream, which } from '../setup/system.mjs';
import { forGateway, forInstalls } from '../secretenv.mjs';

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

/** The argument list a start passes: `args` with PORT replaced by the port. */
export const startArgs = (def, port) => (def.args || ['--port', 'PORT']).map((a) => a.replaceAll('PORT', String(port)));

/** A gateway add-on (see index.mjs for the shape of an add-on) for `def`. */
export function localGateway(def, { shipped = false } = {}) {
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
    return st ? `the program ${def.bin} is not the one you confirmed for ${title} any more (it changed since you confirmed it): if you changed it, ${confirmStep('Confirm the new program')}` : null;
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
    if (!rec) return { onPort, leader: null, listener: null };
    const leader = await startedByUs(rec, onPort);
    let listener = null;
    if (onPort !== null) {
      if (leader !== null && (await belongsTo(onPort, leader)) === true) listener = onPort;
      else if (rec.listener?.pid === onPort && filedProcess(pidFile(), rec.listener, { after: (await system.refresh([onPort])) || 0 }) === true) listener = onPort;
    }
    return { onPort, leader, listener };
  }
  /** It is the gateway: what listens on its port is ours, or (where that cannot be found) the process start() spawned runs. */
  const isOurs = (o) => o.listener !== null || (o.onPort === null && o.leader !== null);
  /** Does the gateway run: its port answers and, for one the owner defined, it is the process this add-on started. */
  async function runs() {
    const up = await answers();
    return { up, mine: up && (shipped || isOurs(await ours())) };
  }

  async function status() {
    const bin = program();
    let version = null;
    if (bin && def.version) {
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
    return { installed: Boolean(bin), version, running: mine, url: url(), ...(up && !mine ? { foreign: true } : {}), ...(unconfirmed ? { needsConfirm: unconfirmed } : {}) };
  }

  // A program, not a package: nothing to install or update; it is there or it is not.
  async function there(onLine) {
    const ok = Boolean(program());
    onLine(ok ? `${title} is a program on this computer (${program()}): there is nothing to install.` : `${title} is not on this computer: ${def.bin} was not found.`);
    return ok ? { ok } : { ok, error: `the program ${def.bin} was not found` };
  }

  async function install({ onLine = () => {} } = {}) {
    if (!def.npm) return there(onLine);
    const r = await stream(npmArgv(['install', '-g', def.npm]), { env: forInstalls(process.env), onLine });
    return { ok: r.ok && Boolean(program()) };
  }

  async function update({ onLine = () => {} } = {}) {
    if (!def.npm) return there(onLine);
    const was = (await runs()).mine;
    if (was) await stop();
    const r = await stream(npmArgv(['install', '-g', `${def.npm}@latest`]), { env: forInstalls(process.env), onLine });
    if (was) await start();
    return { ok: r.ok };
  }

  /** Start it in the background unless it already answers. It keeps running after this process ends. */
  async function start() {
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
    // A .cmd shim (npm on Windows) only starts through a shell: only for a gateway Hoprig ships, never for one defined
    // in the configuration, which runs exactly the program and arguments its owner confirmed.
    const viaShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
    if (viaShell && !shipped) return { ok: false, url: url(), error: `the program ${bin} would need a shell to start: name the program itself (an .exe, or node with its script)` };
    const changed = pinned ? notAsConfirmed(bin) : null;
    if (changed) return { ok: false, url: url(), error: changed };
    if (pinned && process.platform !== 'win32' && !executable(bin)) return { ok: false, url: url(), error: notExecutable(bin) };
    fs.mkdirSync(path.dirname(logFile()), { recursive: true, mode: 0o700 });
    const log = fs.openSync(logFile(), 'a', 0o600);
    // A gateway of the owner's own gets only what a server needs of the starting process's environment (forGateway):
    // a session's PRERUN runs in that session's, with other providers' keys, cloud credentials and the session's
    // marks. Its own key arrives with each request. The shipped gateway starts as it always did.
    const env = shipped ? process.env : forGateway(process.env);
    const child = spawn(viaShell ? `"${bin}"` : bin, startArgs(def, port()), { detached: true, stdio: ['ignore', log, log], windowsHide: true, shell: viaShell, env });
    child.on('error', () => {}); // reported below: it never answers on its port
    child.unref();
    fs.closeSync(log);
    if (child.pid) {
      const after = await system.refresh([child.pid]);
      fs.writeFileSync(pidFile(), JSON.stringify({ pid: child.pid, proc: system.of([child.pid], { after }).get(child.pid) || null }), { mode: 0o600 });
    }
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await answers()) {
        if (child.pid) await noteListener(child.pid);
        // One the owner defined that answers but is not shown to be ours detached itself from what Hoprig started
        // (setsid, a daemon mode): it would be called another program right after and could never be stopped.
        if (!shipped && !isOurs(await ours())) {
          await endStarted(child);
          return { ok: false, url: url(), error: `${title} answered on port ${port()}, but its program detached itself from Hoprig (setsid, a daemon mode), so Hoprig could not stop it: run it in the foreground (without its daemon option) so that Hoprig can stop it. What Hoprig started of it was ended; the program now on port ${port()} is not Hoprig's and is left alone: stop it yourself.` };
        }
        return { ok: true, url: url(), already: false };
      }
    }
    return { ok: false, url: url(), error: `${title} did not answer on port ${port()} within 30 seconds (see ${logFile()})` };
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
    // A program already on the computer: the page offers no Install or Update for it.
    ...(def.npm ? {} : { installable: false }),
    defined: !shipped, // the owner defined it (gateways.mjs): it can be removed
    oldNames: (shipped && def.oldNames) || null, // the names an older page reads for it (gateways.mjs SHIPPED)
    words,
    /** Its own page as this computer reaches it, or null when it has none. */
    page,
    /** What `hoprig gateways` shows and the page's confirmation names: the exact program and arguments it runs. */
    command: () => [def.bin, ...startArgs(def, port())],
    installHint: () => (def.npm ? `npm install -g ${def.npm}` : `${def.bin} was not found on this computer`),
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
