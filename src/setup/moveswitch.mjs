// The switch of `hoprig move-to-user`, after the copy was checked (movecopy.mjs, movecheck.mjs). In this order:
//   1. lingering for the user, when it is off (the one administrator step the look listed), and its service manager;
//   2. Hoprig installed FOR the user (install.sh run as the user, through asuser.mjs), while root's dashboard runs:
//      the same build root runs (this package, packed), with --no-dashboard (root's holds the port), its whole output
//      kept in root's state folder;
//   3. a trial: the user's dashboard on a free port answers with the copied state folder, then it stops;
//   4. root's dashboard service stopped (its files stay, and it stays enabled), the port free;
//   5. the user's dashboard as the user's own service on the usual port: it answers, with the user's state folder,
//      and the process that listens there is the user's (the owner of the listening socket's process);
//   6. only then root's service disabled, and the plain file in root's home that says so.
// From 4 until the switch went through or root's runs again, a hang-up (the SSH connection dropped), Ctrl-C or a
// SIGTERM does not end the move: it would leave no dashboard at all (with keepHeld, also not in the gateways' step that
// follows, which would leave no gateway). The signals are held back (guardSignals) and the
// move ends its step; root's unit is still enabled until 6, so a reboot in that window brings root's back.
// A failure before 4 changes nothing of root's. A failure at 4 or after stops the user's service and starts root's
// again. `back` is the step back. Every program is reached through `sys` (handed in by tests); the defaults run the
// real ones, as root, the user's through runuser.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { stateKey } from '../server/dashboardfile.mjs';
import { capture, which } from './system.mjs';
import { NO_RUNUSER, asUserArgv, runAsUser, userNodeBin, waitForBus } from './asuser.mjs';
import { appRoot } from './checks.mjs';
import { moved } from './movecopy.mjs';

export const UNIT = 'hoprig.service';
export const MOVED_FILE = 'HOPRIG-MOVED.txt';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The listener's process on `port` → its pid, from `ss -ltnpH` output; null when none is named. */
export function listenerPid(ssText, port) {
  for (const line of String(ssText || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (!cols[3] || !cols[3].endsWith(`:${port}`)) continue;
    const m = /pid=(\d+)/.exec(line);
    if (m) return Number(m[1]);
  }
  return null;
}

/** The real user id of a process, from `/proc/<pid>/status` (its Uid line's first field). */
export function procUid(statusText) {
  const m = /^Uid:\s+(\d+)/m.exec(String(statusText || ''));
  return m ? Number(m[1]) : null;
}

/** The installer's whole output is kept here, in root's state folder (left behind by the copy: moveplan.mjs). */
export const INSTALL_LOG = 'move-install.log';

/**
 * The line of an installer's output that says what FAILED: the installer's own error, set-up's "is not ready" line, or
 * its last ✗ line; never an advice that happens to come last. Escape codes are removed.
 */
export function failedLine(output) {
  const lines = String(output || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.find((l) => l.startsWith('hoprig installer: '))
    || lines.find((l) => /\bis not ready\b/.test(l))
    || [...lines].reverse().find((l) => l.startsWith('✗ '))
    || null;
}

/**
 * Throws unless `user` has an ordinary user id and a home: the system calls of a user the move only planned (made later,
 * with an id and a home of the system's choosing) would ask for /run/user/null and write into a home that is not there.
 */
export function ordinaryUser(user) {
  if (!Number.isInteger(user?.uid) || user.uid <= 0) throw new Error(`the user ${user?.name} has no ordinary user id yet: its steps are made once it is there`);
  if (typeof user.home !== 'string' || !path.posix.isAbsolute(user.home)) throw new Error(`the user ${user.name} has no home folder`);
  return user;
}

/** A process's `/proc/<pid>/status` text. */
export const procStatus = (pid) => fs.readFileSync(`/proc/${pid}/status`, 'utf8');

/**
 * The default system calls of the switch for `user` (a passwdEntry with `home`). The lowest calls (`run`, `isSocket`,
 * `has`, `chown`, `spawn`, `readProc`, `sleep`, `freePort`, `fetch`) are handed in by tests; the defaults are the real ones.
 */
export function realSwitchSys(user, { run = capture, env = process.env, has = (c) => !!which(c), fetch: ask = fetch, isSocket, chown = fs.lchownSync, spawn: start = spawn, readProc = procStatus, sleep: nap = sleep, freePort: pickPort = freePort } = {}) {
  ordinaryUser(user);
  const asUser = (argv, o = {}) => runAsUser(user, argv, { run, env, has, ...o });
  const stateOf = path.posix.join(user.home, '.local/state/hoprig');
  return {
    hasRunuser: () => has('runuser'),
    linger: () => run(['loginctl', 'enable-linger', user.name], { timeout: 20_000 }),
    waitBus: () => waitForBus(user.uid, { isSocket, sleep: nap }),
    installUser: async ({ logDir } = {}) => {
      // The installer and the build root runs are handed into the user's home: root's folders are not the user's to
      // read. The build is this package, packed (a folder npm would only link), never the newest from the network.
      const dir = path.posix.join(user.home, '.cache', 'hoprig-move');
      for (const p of [path.posix.join(user.home, '.cache'), dir]) {
        if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) return { ok: false, code: null, stdout: '', stderr: `hoprig installer: ${p} is a link, so nothing is handed to ${user.name} through it` };
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.posix.join(dir, 'install.sh');
      const tgz = path.posix.join(dir, 'hoprig.tgz');
      fs.copyFileSync(path.join(appRoot(), 'install.sh'), file);
      const app = appRoot();
      const packed = await run(['tar', '-czf', tgz, '-C', path.dirname(app), '--exclude=node_modules', '--exclude=.git', path.basename(app)], { timeout: 120_000 });
      if (!packed.ok) return { ok: false, code: packed.code, stdout: '', stderr: `hoprig installer: this Hoprig could not be packed for ${user.name} (${(packed.stderr || '').trim().split('\n')[0]})` };
      for (const p of [path.posix.join(user.home, '.cache'), dir, file, tgz]) chown(p, user.uid, user.gid ?? user.uid);
      const r = await asUser(['env', `HOPRIG_SOURCE=${tgz}`, 'sh', file, '--yes', '--no-dashboard'], { timeout: 15 * 60_000 });
      if (logDir) {
        try {
          fs.writeFileSync(path.join(logDir, INSTALL_LOG), `${r.stdout || ''}${r.stderr || ''}`, { mode: 0o600 });
        } catch { /* the log is a help, not a step */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
      return r;
    },
    startTrial: (port) => {
      const argv = asUserArgv(user, ['hoprig', 'serve', '--trial', '--port', String(port)], { nodeBin: userNodeBin(user.home) });
      const child = start(argv[0], argv.slice(1), { stdio: 'ignore', env });
      return { stop: async () => { try { child.kill('SIGTERM'); } catch { /* gone */ } await nap(1000); } };
    },
    facts: (port) => localFacts(stateOf, port, { fetch: ask }),
    stopRoot: () => run(['systemctl', '--user', 'stop', UNIT], { env, timeout: 30_000 }),
    disableRoot: () => run(['systemctl', '--user', 'disable', UNIT], { env, timeout: 30_000 }),
    guard: () => guardSignals(),
    startRoot: () => run(['systemctl', '--user', 'enable', '--now', UNIT], { env, timeout: 30_000 }),
    installUserService: () => asUser(['hoprig', 'service', 'install'], { timeout: 60_000 }),
    stopUserService: () => asUser(['systemctl', '--user', 'disable', '--now', UNIT], { timeout: 30_000 }),
    listenerUid: async (port) => {
      const r = await run(['ss', '-ltnpH'], { timeout: 5000 });
      const pid = listenerPid(r.stdout, port);
      if (!pid) return null;
      try {
        return procUid(readProc(pid));
      } catch {
        return null;
      }
    },
    portFree: (port) => portFree(port),
    freePort: pickPort,
    writeFile: (file, text) => fs.writeFileSync(file, text, { mode: 0o644 }),
    sleep: nap,
  };
}

/** The answer of the dashboard on `port` whose state folder is `state` (its dashboard.json holds the key), or null. */
export async function localFacts(state, port, { fetch: ask = fetch } = {}) {
  let key;
  try {
    key = JSON.parse(fs.readFileSync(path.join(state, 'dashboard.json'), 'utf8')).key;
  } catch {
    return null;
  }
  try {
    const r = await ask(`http://127.0.0.1:${port}/api/local/facts`, { headers: { 'x-hoprig-local-key': String(key) }, signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The signals that would end the move in the switch window: a hang-up, Ctrl-C, and the SIGTERM of a time limit. */
export const HELD_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'];

/**
 * Hold the signals back until `release()`: each is written down instead of ending the process, and a write to a
 * terminal that hung up (EIO, EPIPE) no longer ends it either. → { release, seen: [signal names] }.
 */
export function guardSignals({ proc = process } = {}) {
  const seen = [];
  const quiet = () => {};
  const handlers = HELD_SIGNALS.map((sig) => [sig, () => seen.push(sig)]);
  for (const [sig, fn] of handlers) proc.on(sig, fn);
  for (const st of [proc.stdout, proc.stderr]) st?.on?.('error', quiet);
  return {
    seen,
    release: () => {
      for (const [sig, fn] of handlers) proc.off(sig, fn);
    },
  };
}

/** Wait, bounded, for `ok()` to be true. */
async function until(ok, sys, { tries = 30, stepMs = 1000 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (await ok()) return true;
    await sys.sleep(stepMs);
  }
  return false;
}

/** The text of the plain file in root's home after the switch. */
export function movedText({ user, oldHome, parts, at = new Date() }) {
  const kept = parts.map((p) => `  ${p.from}`).join('\n');
  return [
    `Hoprig on this server runs as the user ${user.name} since ${at.toISOString().slice(0, 16)}Z.`,
    '',
    `Root's copy of what was moved is kept, unchanged, in ${oldHome}:`,
    kept,
    'Removing it is a step of its own, for later, when the user\'s copy has served you a while.',
    '',
    `Become that user: sudo -iu ${user.name}   (or su - ${user.name})`,
    `Back to root's dashboard: hoprig move-to-user --back`,
    '',
  ].join('\n');
}

/**
 * Switch from root's dashboard to the user's (see the head of this file). `plan`: movePlan's; `say(line)` takes each
 * line. → { ok, step, lines } where `step` names where it stopped.
 */
export async function switchToUser(plan, { sys, say = () => {}, port = Number(plan.port) || 7433, onSwitching = () => {}, keepHeld = false } = {}) {
  const { user } = plan;
  const did = [];
  let held = null;
  const release = (when = 'the switch and was held back until a dashboard ran again') => {
    if (!held) return;
    held.release();
    if (held.seen.length) say(`(${[...new Set(held.seen)].join(', ')} came during ${when}.)`);
    held = null;
  };
  const fail = async (step, why, { back = false } = {}) => {
    say(`STOPPED at "${step}": ${why}`);
    if (back) {
      await sys.stopUserService();
      const r = await sys.startRoot();
      const up = await until(async () => !(await sys.portFree(port)), sys, { tries: 15 });
      say(r.ok && up ? "Root's dashboard runs again, as before." : `Root's dashboard did not answer again: start it with systemctl --user enable --now ${UNIT}`);
    } else say("Root's dashboard was not stopped: it runs as before.");
    release();
    return { ok: false, step, did };
  };
  if (!sys.hasRunuser()) return fail('run as the user', NO_RUNUSER);
  if (plan.admin.some((s) => s.id === 'linger')) {
    say(`Turning lingering on for ${user.name}: loginctl enable-linger ${user.name}`);
    const r = await sys.linger();
    if (!r.ok) return fail('lingering', (r.stderr || 'loginctl failed').trim().split('\n')[0]);
    did.push('linger');
  }
  if (!(await sys.waitBus())) return fail('the user\'s service manager', `/run/user/${user.uid}/bus did not appear: ${user.name}'s service manager is not running (lingering starts it)`);
  say(`Installing Hoprig for ${user.name} (its own Node.js, Claude Code and settings)…`);
  const logDir = plan.dirs?.state || null;
  const inst = await sys.installUser({ logDir });
  did.push('install');
  if (!inst.ok) {
    const why = failedLine(`${inst.stdout || ''}\n${inst.stderr || ''}`) || `the installer ended with exit ${inst.code ?? 'unknown'}`;
    return fail('install for the user', `${why}${logDir ? ` (the whole output: ${path.posix.join(logDir, INSTALL_LOG)})` : ''}`);
  }
  // The trial: the user's dashboard on a free port, with the copied settings and state.
  const trialPort = await sys.freePort();
  const userState = moved(plan.dirs?.state || path.posix.join(plan.oldHome, '.local/state/hoprig'), plan.oldHome, user.home);
  const want = stateKey(userState);
  say(`Trying ${user.name}'s dashboard on port ${trialPort} first…`);
  const trial = await sys.startTrial(trialPort);
  let seen = null;
  const answered = await until(async () => (seen = await sys.facts(trialPort)) !== null, sys);
  await trial.stop();
  if (!answered) return fail('the trial', `${user.name}'s dashboard did not answer on port ${trialPort}`);
  if (seen.state !== want) return fail('the trial', `the dashboard on port ${trialPort} is not the one of ${user.name}'s copied state folder`);
  say(`${user.name}'s dashboard answered with the copied settings.`);
  // The switch itself.
  // The mark says "switching" before root's stops: a later run then never takes this copy for a half-made one, even
  // when this process is ended in the window (moveplan.mjs stops on it). A mark that cannot be written stops here.
  try {
    await onSwitching();
  } catch (e) {
    return fail("the move's mark", `it could not be written (${e.message})`);
  }
  // From here until a dashboard runs again, a hang-up or Ctrl-C must not end the move halfway.
  held = sys.guard ? sys.guard() : null;
  say("Stopping root's dashboard service (its files stay; a dropped connection or Ctrl-C now waits until a dashboard runs again)…");
  await sys.stopRoot();
  did.push('stop-root');
  if (!(await until(() => sys.portFree(port), sys, { tries: 10 }))) return fail("stop root's dashboard", `port ${port} is still held`, { back: true });
  say(`Starting ${user.name}'s dashboard as its own service on port ${port}…`);
  const svc = await sys.installUserService();
  if (!svc.ok) return fail("the user's service", (svc.stderr || 'hoprig service install failed').trim().split('\n').slice(-1)[0], { back: true });
  let facts = null;
  if (!(await until(async () => (facts = await sys.facts(port)) !== null, sys))) return fail("the user's service", `nothing answered on port ${port}`, { back: true });
  const owner = await sys.listenerUid(port);
  if (owner !== user.uid) return fail("the user's service", `the dashboard on port ${port} runs as user id ${owner ?? 'unknown'}, not as ${user.name} (${user.uid})`, { back: true });
  if (facts.state !== want) return fail("the user's service", `the dashboard on port ${port} does not use ${user.name}'s state folder`, { back: true });
  say(`${user.name}'s dashboard answers on port ${port}, as ${user.name}.`);
  // Only now is root's service kept from starting at the next boot.
  const dis = await sys.disableRoot();
  if (!dis.ok) say(`! Root's service could not be disabled (${(dis.stderr || 'systemctl failed').trim().split('\n')[0]}): run systemctl --user disable ${UNIT} as root, or it starts again at the next boot.`);
  const file = path.posix.join(plan.oldHome, MOVED_FILE);
  sys.writeFile(file, movedText({ user, oldHome: plan.oldHome, parts: plan.parts }));
  say(`Root's copy is kept. ${file} says so.`);
  // keepHeld (moverun.mjs): the gateways' step comes next, which stops root's gateway before it starts the user's; the
  // signals stay held until it is done, and `release()` of the result lets them go.
  if (keepHeld && held) return { ok: true, step: 'done', file, release: () => release("the switch or the gateways' step and was held back until both were done") };
  release();
  return { ok: true, step: 'done', file, release: () => {} };
}

/** The step back: the user's dashboard service stopped, root's started again. → { ok }. */
export async function stepBack(plan, { sys, say = () => {}, port = Number(plan.port) || 7433 } = {}) {
  say(`Stopping ${plan.user.name}'s dashboard service…`);
  await sys.stopUserService();
  await until(() => sys.portFree(port), sys, { tries: 10 });
  say("Starting root's dashboard again…");
  const r = await sys.startRoot();
  const up = r.ok && (await until(async () => (await sys.listenerUid(port)) === 0, sys, { tries: 15 }));
  say(up ? `Root's dashboard runs again on port ${port}. ${plan.user.name}'s copy stays where it is.` : `Root's dashboard did not answer on port ${port}: systemctl --user status ${UNIT} says why.`);
  return { ok: !!up };
}
