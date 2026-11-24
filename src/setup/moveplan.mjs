// The look of `hoprig move-to-user` (src/setup/movecli.mjs): an installation that works as root is moved to an
// ordinary user that already exists here. This module only looks: which user, what runs now, what would be copied
// (with sizes and entry counts), the free space on the user's disk, and the steps that would run as administrator.
// It writes nothing and starts only programs that read (getent, tmux list-panes, loginctl show-user, ss). With no user
// Hoprig made, the move makes one after his yes, through the installer's one way of making it (moverun.mjs).
// Every reader is handed in (`io`) so a test plays root, the user and the disk.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeDir, configDir, stateDir } from '../paths.mjs';
import { claudeSlug } from './movecopy.mjs';
import { capture, showCommand } from './system.mjs';
import { USER_NAME_RE, WORK_USER_NAMES, lookUser, madeByHoprig } from './rootfacts.mjs';
import { MARK_FILE, isLive, readMark, usedCopy } from './movemark.mjs';
import { listenerPid, procUid } from './moveswitch.mjs';
import { asUserArgv } from './asuser.mjs';
import { NETWORK_LINE, networkNeeds, proxyOf } from './movenet.mjs';
import { JOB_FILE } from './movejob.mjs';
import { LOCK_FILE } from './movelock.mjs';

/** The space the copy must leave free on the user's disk, over its own size (a tenth). */
export const MARGIN = 0.1;

/**
 * What belongs to root's RUNNING dashboard in the state folder: left behind (the user's dashboard makes its own). The
 * page's job file is root's move, running: a copy of it would read as a move that runs (the switch mirrors the job into
 * the user's state folder itself).
 */
export const STATE_LEFT = ['runs', 'hook-settings', 'launch', 'dashboard.json', 'router.log', MARK_FILE, 'move-install.log', JOB_FILE];
const stateLeft = (rel) => {
  const top = rel.split('/')[0];
  if (STATE_LEFT.includes(top)) return true;
  if (rel.includes('/')) return false;
  // The job's own half-written file (movejob.mjs writeWhole), and a lock's file of its own a crash left (movelock.mjs).
  return top.endsWith('.lock') || top.startsWith(`${JOB_FILE}.`) || top.startsWith(`.${LOCK_FILE}.`);
};

/** In ~/.ssh only what git uses to reach a git server: the keys, config and known_hosts. Never authorized_keys. */
export const sshKept = (rel) => /^(id_[^/]+|config|known_hosts)$/.test(rel);

/** The other tools' settings the move carries when they are there (paths under the home). */
const TOOL_PARTS = [
  ['.claude.json', "Claude Code's settings file"],
  ['.config/gh', "GitHub CLI's settings"],
  ['.config/git', "git's settings folder"],
  ['.gitconfig', "git's settings"],
  ['.npmrc', "npm's settings"],
  ['.config/opencode', "OpenCode's settings"],
  ['.local/share/opencode', "OpenCode's data"],
  ['.codex', "Codex's settings"],
  ['.cloudflared', "cloudflared's settings"],
];

/** A user of the default name that Hoprig did not make: said, with the two ways on. */
/** The stop of a move confirmed for a new user (--new) when a user of that name, not made by Hoprig, is there now. */
export const NOT_NEW = (name) => `A user named ${name} is on this server now and Hoprig did not make it, while the move was confirmed for a new user ${name} made by the move: nothing was made or copied. Look again to see it as it is now. To move to ${name} all the same: hoprig move-to-user --user ${name}`;

export const NAME_TAKEN = (name, free) => `A user named ${name} is already on this server and Hoprig did not make it, so the move does not use it on its own. To have a new user made: hoprig move-to-user --user ${free || '<a free name>'}. To move to ${name} all the same: hoprig move-to-user --user ${name}`;
export const NOT_ROOT = 'Hoprig does not run as root here: there is nothing to move.';

const defaultIo = () => ({
  home: os.homedir(),
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  env: process.env,
  dirs: null,
  run: capture,
  lstat: fs.lstatSync,
  readFile: fs.readFileSync,
  readdir: (d) => fs.readdirSync(d, { withFileTypes: true }),
  exists: fs.existsSync,
  statfs: (p) => fs.statfsSync(p),
  // Is /bin/bash there to be the made user's shell (install.sh's WU_SHELL decides the same way)?
  hasBash: () => {
    try {
      fs.accessSync('/bin/bash', fs.constants.X_OK);
      return fs.statSync('/bin/bash').isFile();
    } catch {
      return false;
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === 'EPERM';
    }
  },
});

const inside = (p, base) => p === base || p.startsWith(base.endsWith('/') ? base : `${base}/`);

/**
 * The user the move would use, or { error } with one line. `--user NAME`: that user (it is not root, has a user id of
 * 1000 or more and a home folder of its own), or made when there is none of that name. Without it: the work user
 * Hoprig made (the mark of root's in its home), else the default name made; a user of the default name that Hoprig did not make is said
 * (NAME_TAKEN), never used on its own. A user to be made is { user: { name, uid: null, home }, make: true }: nothing is
 * made here. `fresh` (--new: the hub's look said the move makes this user, and that is what he confirmed): a user of
 * that name that is there now and that Hoprig did not make is refused (NOT_NEW), never moved into.
 */
export async function pickUser(name, io, { fresh = false } = {}) {
  const toMake = (n) => ({ user: { name: n, uid: null, gid: null, home: `/home/${n}` }, make: true });
  const marked = (e) => madeByHoprig(e, { lstat: io.lstat, readFile: io.readFile || fs.readFileSync });
  if (name !== undefined && name !== null) {
    if (!USER_NAME_RE.test(String(name))) return { error: `"${name}" is not a user name (small letters, digits, - and _, at most 32)` };
    const e = await lookUser(name, { run: io.run });
    if (e && fresh && !marked(e)) return { error: NOT_NEW(name) };
    return e ? checkUser(e, io) : toMake(name);
  }
  let free = null;
  let taken = null;
  for (const n of WORK_USER_NAMES) {
    const e = await lookUser(n, { run: io.run });
    if (!e) {
      free = n;
      break;
    }
    if (marked(e)) return checkUser(e, io);
    taken = taken || n;
  }
  return taken ? { error: NAME_TAKEN(taken, free) } : toMake(free);
}

function checkUser(e, io) {
  if (e.uid === 0 || e.name === 'root') return { error: `${e.name} is root: the move is to an ordinary user` };
  if (e.uid < 1000) return { error: `${e.name} has the user id ${e.uid}, which the system keeps for its own services: name an ordinary user (1000 or more)` };
  if (!path.posix.isAbsolute(e.home || '') || inside(io.home, e.home) || inside(e.home, io.home)) return { error: `${e.name} has no home folder of its own (${e.home || 'none'})` };
  let st;
  try {
    st = io.lstat(e.home);
  } catch {
    return { error: `${e.name}'s home folder ${e.home} is not there` };
  }
  if (!st.isDirectory() || st.uid !== e.uid) return { error: `${e.name}'s home folder ${e.home} is not a folder of its own (its owner is another user)` };
  return { user: { name: e.name, uid: e.uid, gid: e.gid, home: e.home.replace(/\/+$/, '') } };
}

/**
 * Entries and bytes under `p` (links counted, never followed), with `keep(rel)` choosing what is part of it. A socket
 * or a pipe is not counted: the copy cannot copy one (movecopy.mjs skips it), so it is not part of what is moved.
 */
export function measure(p, io, keep = () => true) {
  const out = { entries: 0, bytes: 0, repos: 0 };
  let st;
  try {
    st = io.lstat(p);
  } catch {
    return null;
  }
  out.entries = 1;
  if (!st.isDirectory()) {
    out.bytes = st.isFile() ? st.size : 0;
    return out;
  }
  const walk = (dir, rel) => {
    let names;
    try {
      names = io.readdir(dir);
    } catch {
      return;
    }
    for (const d of names) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (!keep(r)) continue;
      const full = path.join(dir, d.name);
      if (!d.isDirectory() && !d.isFile() && !d.isSymbolicLink()) continue; // a socket, a pipe or a device
      out.entries += 1;
      if (d.name === '.git') out.repos += 1;
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) walk(full, r);
      else if (d.isFile()) {
        try {
          out.bytes += io.lstat(full).size;
        } catch {
          /* gone meanwhile */
        }
      }
    }
  };
  walk(p, '');
  return out;
}

/**
 * The parts the move copies, each { id, what, from, to, keep? }: Hoprig's settings and state (without what belongs to
 * the running dashboard), the workspace, Claude Code's folder, the other tools' settings, and the keys git uses. Only
 * what lies inside root's home: a part elsewhere is returned in `outside`, and stops the move.
 */
export function moveParts(oldHome, newHome, dirs) {
  const to = (p) => newHome + p.slice(oldHome.length);
  const list = [
    { id: 'config', what: "Hoprig's settings", plural: true, from: dirs.config },
    { id: 'state', what: "Hoprig's state (without what belongs to the running dashboard)", from: dirs.state, keep: (r) => !stateLeft(r) },
    { id: 'workspace', what: 'the workspace', from: dirs.workspace },
    { id: 'claude', what: "Claude Code's folder", from: dirs.claude },
    ...TOOL_PARTS.map(([rel, what]) => ({ id: rel, what, from: path.posix.join(oldHome, rel) })),
    { id: 'ssh', what: 'the keys git uses (never the login keys)', from: path.posix.join(oldHome, '.ssh'), keep: sshKept },
  ];
  const outside = [];
  const parts = [];
  for (const p of list) {
    if (!inside(p.from, oldHome) || p.from === oldHome) {
      outside.push(p);
      continue;
    }
    // A part inside another (the Claude folder kept in the workspace) is copied with it once.
    if (list.some((q) => q !== p && q.from !== p.from && inside(p.from, q.from) && inside(q.from, oldHome) && q.from !== oldHome)) continue;
    parts.push({ ...p, to: to(p.from) });
  }
  return { parts, outside };
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

/** What runs now, read without changing anything: { working: [..], terminals: [..], work: n, assistant: n }. */
export async function whatRuns(dirs, cfg, io, { workRunning = null } = {}) {
  const working = [];
  const idle = [];
  const runs = path.join(dirs.state, 'runs');
  let names = [];
  try {
    names = fs.readdirSync(runs).filter((n) => n.endsWith('.json'));
  } catch {
    /* none */
  }
  const panes = new Set(); // tmux panes the run records name (their sessions are Hoprig's)
  for (const n of names) {
    const r = readJson(path.join(runs, n));
    if (r && typeof r.tmuxPane === 'string' && /^%\d+$/.test(r.tmuxPane)) panes.add(`${r.tmuxSocket || ''}\t${r.tmuxPane}`);
    if (!r || !Number.isInteger(r.pid) || !io.alive(r.pid)) continue;
    const label = `${path.basename(String(r.cwd || '?'))} (${r.status || 'unknown'})`;
    (['working', 'starting'].includes(r.status) ? working : idle).push(label);
  }
  // Root's terminals that the move ends after the switch: only Hoprig's. On the dashboard's own socket (server.tmuxSocket)
  // every session is the dashboard's; on the person's normal tmux server only the sessions whose pane a run record
  // names, never his other sessions. The session that holds this move (its $TMUX and $TMUX_PANE) is never one.
  const terminals = [];
  const sock = tmuxSocketPath(cfg, io);
  if (sock && io.exists(sock)) {
    const own = !!String(cfg?.server?.tmuxSocket || '');
    const r = await io.run(['tmux', '-S', sock, 'list-panes', '-a', '-F', '#{pane_id}\t#{session_name}'], { timeout: 5000 });
    const rows = r.ok ? r.stdout.split('\n').map((x) => x.trim().split('\t')).filter((x) => x.length === 2 && x[1]) : [];
    const self = String(io.env.TMUX || '').split(',')[0] === sock ? rows.find(([pane]) => pane === io.env.TMUX_PANE)?.[1] : null;
    const named = (pane) => panes.has(`${sock}\t${pane}`) || panes.has(`\t${pane}`);
    const sessions = new Set();
    for (const [pane, session] of rows) if (session !== self && (own || named(pane))) sessions.add(session);
    for (const session of sessions) terminals.push({ socket: sock, session });
  }
  let assistant = 0;
  const jobs = path.join(dirs.state, 'assistant', 'jobs');
  try {
    for (const n of fs.readdirSync(jobs).filter((x) => x.endsWith('.json'))) if (['working', 'waiting'].includes(readJson(path.join(jobs, n))?.state)) assistant += 1;
  } catch {
    /* none */
  }
  const work = typeof workRunning === 'function' ? await workRunning(cfg) : await workRuns(cfg);
  return { working, idle, terminals, work, assistant };
}

/** The tmux socket of root's dashboard: its own (-L name) or the default server, in tmux's folder for this user. */
export function tmuxSocketPath(cfg, io) {
  const name = String(cfg?.server?.tmuxSocket || 'default');
  if (!/^[\w.-]+$/.test(name) || !Number.isInteger(io.uid)) return null;
  return path.posix.join(io.env.TMUX_TMPDIR || '/tmp', `tmux-${io.uid}`, name);
}

async function workRuns(cfg) {
  try {
    const { resolvePlace } = await import('../work/place.mjs');
    const { listRuns } = await import('../work/runs.mjs');
    return listRuns(resolvePlace(cfg)).filter((r) => r.state === 'running').length;
  } catch {
    return 0;
  }
}

/** Lingering for the user: 'yes' | 'no' | null (no loginctl, or it could not say). */
async function lingerOf(name, io) {
  const r = await io.run(['loginctl', 'show-user', name, '-p', 'Linger'], { timeout: 5000 });
  const m = /Linger=(yes|no)/.exec(r.stdout || '');
  return m ? m[1] : r.error === 'ENOENT' ? null : /not logged in|No such|not known/i.test(`${r.stderr}`) ? 'no' : null;
}

/**
 * The command a step runs as the user, as shown: asUserArgv's own, or for a user not made yet (no user id) the same with
 * the placeholder install.sh shows, never a made-up number.
 */
function shownAsUser(user, argv) {
  if (Number.isInteger(user.uid) && user.uid > 0) return asUserArgv(user, argv);
  const ph = '<its user id>';
  return asUserArgv({ ...user, uid: 1 }, argv).map((a) => (a === 'XDG_RUNTIME_DIR=/run/user/1' ? `XDG_RUNTIME_DIR=/run/user/${ph}` : a === 'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1/bus' ? `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${ph}/bus` : a));
}

/** Every copied entry given to the user: the links themselves (-h), never what they point to. */
const OWNER = (user) => ({ id: 'owner', why: `set the owner of everything copied to ${user.name} (links themselves, never what they point to)`, argv: ['chown', '-hR', `${user.name}:${user.name}`, '<each copied part>'] });

/** The last step: root's service kept from starting at boot, only once the user's dashboard answered as the user. */
const DISABLE_ROOT = { id: 'disable-root', why: "once the user's dashboard answers: keep root's service from starting at boot", argv: ['systemctl', '--user', 'disable', 'hoprig.service'] };

/**
 * The steps that run as administrator, each its exact command: the user made (`make`: the installer's own steps, said
 * by it again before it makes anything), lingering (when off), then the switch's own.
 */
export function adminSteps(user, linger, { make = false, bash = false } = {}) {
  const steps = [];
  if (make) {
    steps.push({ id: 'make-user', why: `make the user ${user.name} with no password${bash ? ', bash as its shell (the usual command line, with history and arrow keys)' : ''} (by the installer that came with this Hoprig)`, argv: ['useradd', '--create-home', '--comment', 'Hoprig work user', ...(bash ? ['--shell', '/bin/bash'] : []), user.name] });
    steps.push({ id: 'keys', why: `give ${user.name} the keys that let you in as root (root's own file is not changed)`, argv: ['install', '-m', '0600', '-o', user.name, '-g', user.name, "<root's key lines>", `${user.home}/.ssh/authorized_keys`] });
    steps.push({ id: 'sudoers', why: `administrator rights for ${user.name} as cloud servers give their first user: sudo without a password, in one file checked by visudo first`, argv: ['install', '-m', '0440', '-o', 'root', '-g', 'root', '<the checked line>', `/etc/sudoers.d/90-hoprig-${user.name}`] });
    steps.push({ id: 'linger', why: `keep ${user.name}'s dashboard running without a login`, argv: ['loginctl', 'enable-linger', user.name] });
    steps.push(OWNER(user));
    steps.push({ id: 'stop-root', why: "stop root's dashboard service (its files stay)", argv: ['systemctl', '--user', 'stop', 'hoprig.service'] });
    steps.push({ id: 'install', why: `install this same build of Hoprig for ${user.name}, run as ${user.name}`, argv: shownAsUser(user, ['sh', 'install.sh', '--yes', '--no-dashboard']) });
    steps.push({ id: 'service', why: `run the dashboard as ${user.name}'s own service`, argv: shownAsUser(user, ['hoprig', 'service', 'install']) });
    steps.push(DISABLE_ROOT);
    return steps;
  }
  if (linger === 'no') steps.push({ id: 'linger', why: `keep ${user.name}'s dashboard running without a login`, argv: ['loginctl', 'enable-linger', user.name] });
  steps.push(OWNER(user));
  steps.push({ id: 'stop-root', why: "stop root's dashboard service (its files stay)", argv: ['systemctl', '--user', 'stop', 'hoprig.service'] });
  steps.push({ id: 'install', why: `install this same build of Hoprig for ${user.name}, run as ${user.name}`, argv: shownAsUser(user, ['sh', 'install.sh', '--yes', '--no-dashboard']) });
  steps.push({ id: 'service', why: `run the dashboard as ${user.name}'s own service`, argv: shownAsUser(user, ['hoprig', 'service', 'install']) });
  steps.push(DISABLE_ROOT);
  return steps;
}

const present = (p, io) => {
  try {
    io.lstat(p);
    return true;
  } catch {
    return false;
  }
};

/** The nearest folder of `p` that exists (the user's disk, before the copy made anything there). */
function existingAncestor(p, io) {
  let d = p;
  while (d !== path.posix.dirname(d) && !io.exists(d)) d = path.posix.dirname(d);
  return d;
}

/**
 * The whole look: { ok, stops: [lines], user, parts: [{ id, what, from, to, entries, bytes }], total, free, need,
 * running, admin }. `ok` is false when the move must not start; `stops` says why, one line each.
 */
export async function movePlan({ userName, fresh = false, cfg = {}, io: given = {} } = {}) {
  const io = { ...defaultIo(), ...given };
  const dirs = io.dirs || { config: configDir(), state: stateDir(), claude: claudeDir(), workspace: await wsDir(cfg) };
  if (io.uid !== 0) return { ok: false, stops: [NOT_ROOT], user: null, parts: [], running: null, admin: [] };
  const picked = await pickUser(userName, io, { fresh });
  if (picked.error) return { ok: false, stops: [picked.error], user: null, parts: [], running: null, admin: [] };
  const { user } = picked;
  const stops = [];
  // The move's own copy of an earlier run to this user (movemark.mjs): gone on from, never a reason to stop, unless
  // the user's dashboard may run on it (switched, and no step back since): then nothing is cleared or copied.
  const mark = readMark(dirs.state);
  if (isLive(mark)) stops.push(LIVE_STOP(mark));
  const again = mark && mark.user === user.name && mark.home === user.home ? mark : null;
  const ours = new Set(again ? again.parts : []);
  const { parts, outside } = moveParts(io.home, user.home, dirs);
  for (const p of outside) if (io.exists(p.from)) stops.push(`${p.what} ${p.plural ? 'lie' : 'lies'} outside root's home (${p.from}): the move copies only what is in the home`);
  const measured = [];
  for (const p of parts) {
    const m = measure(p.from, io, p.keep);
    if (!m) continue;
    measured.push({ ...p, ...m });
    // Nothing of the user's is written over: a part already in his home stops the move (the keys git uses are added
    // beside his own ~/.ssh files, and a file of the same name there is kept).
    if (p.id !== 'ssh' && !ours.has(p.to) && present(p.to, io)) stops.push(`${p.to} is already in ${user.name}'s home: the move does not write over it. Move it away, then run the move again`);
  }
  // The Claude folder's project folders are ALSO placed under the new path's name: their size counts twice.
  const claude = measured.find((p) => p.id === 'claude');
  const twice = claude ? projectsBytes(claude.from, io.home, io) : 0;
  const total = { entries: measured.reduce((n, p) => n + p.entries, 0), bytes: measured.reduce((n, p) => n + p.bytes, 0) + twice };
  const need = Math.ceil(total.bytes * (1 + MARGIN));
  let free = null;
  try {
    const s = io.statfs(existingAncestor(user.home, io));
    free = Number(s.bavail) * Number(s.bsize);
  } catch {
    /* unknown */
  }
  if (free === null) stops.push(`the free space on ${user.home}'s disk could not be read: nothing is copied without it`);
  else if (free < need) stops.push(`${user.home}'s disk has ${size(free)} free, and the copy needs ${size(need)} (its size and a tenth more): make room first`);
  const running = await whatRuns(dirs, cfg, io, { workRunning: given.workRunning });
  if (running.working.length) stops.push(`a session is working now (${running.working.join(', ')}): end it first, then run the move again`);
  if (running.work) stops.push(`Work is running ${running.work} task${running.work === 1 ? '' : 's'}: end ${running.work === 1 ? 'it' : 'them'} first`);
  if (running.assistant) stops.push(`Tia is working on ${running.assistant} job${running.assistant === 1 ? '' : 's'}: end ${running.assistant === 1 ? 'it' : 'them'} first`);
  const admin = adminSteps(user, picked.make ? 'no' : await lingerOf(user.name, io), { make: picked.make, bash: !!(picked.make && io.hasBash()) });
  const port = Number(cfg?.server?.port) || 7433;
  // The user's own dashboard on the port (a move switched, whatever the mark says): its data is in use.
  if (!picked.make && !isLive(mark) && (await portOwner(port, io)) === user.uid) stops.push(`${user.name}'s own dashboard answers on port ${port}: Hoprig runs as ${user.name} already. To go back to root's first: hoprig move-to-user --back`);
  // What the user's own install needs from the network: asked by the move before it makes or copies anything.
  const network = networkNeeds(io.home, { readFile: io.readFile });
  const proxy = proxyOf(io.home, { env: io.env || {}, readFile: io.readFile });
  return { ok: stops.length === 0, stops, user, make: !!picked.make, again, oldHome: io.home, dirs, port, parts: measured, total, free, need, running, admin, network, proxy };
}

/** The stop of a look while the user's dashboard may run on the move's copy. */
export const LIVE_STOP = (mark) => `Hoprig runs as ${mark.user} since ${String(mark.switchedAt || mark.switchingAt || mark.at).slice(0, 16)}Z, on the move's copy in ${mark.home}: nothing is copied over it. To go back to root's dashboard first: hoprig move-to-user --back`;

/** The user id of the process that listens on `port` (ss, then /proc), or null when none is known. */
async function portOwner(port, io) {
  const r = await io.run(['ss', '-ltnpH'], { timeout: 5000 });
  const pid = r.ok ? listenerPid(r.stdout, port) : null;
  if (!pid) return null;
  try {
    return procUid(String(io.readFile(`/proc/${pid}/status`, 'utf8')));
  } catch {
    return null;
  }
}

async function wsDir(cfg) {
  const { workspaceDir } = await import('../workspace/layout.mjs');
  return workspaceDir(cfg);
}

/** Bytes of Claude Code's project folders that belong to the old home's paths (each is copied a second time). */
function projectsBytes(claude, oldHome, io) {
  const dir = path.join(claude, 'projects');
  const prefix = claudeSlug(oldHome);
  let n = 0;
  try {
    for (const d of io.readdir(dir)) if (d.isDirectory() && d.name.startsWith(prefix)) n += measure(path.join(dir, d.name), io)?.bytes || 0;
  } catch {
    /* none */
  }
  return n;
}

/** Bytes as a person reads them: "512 B", "3.4 MB", "2.9 GB". */
export function size(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(b) || 0;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${i ? v.toFixed(v < 10 ? 1 : 0) : v} ${u[i]}`;
}

/** The look as lines for the command line and the page's job. */
export function planLines(plan) {
  const out = [];
  if (!plan.user) return [...plan.stops];
  out.push(plan.make
    ? `Hoprig would move from root to a new user ${plan.user.name}, made by the move (home ${plan.user.home}).`
    : `Hoprig would move from root to the user ${plan.user.name} (home ${plan.user.home}).`);
  if (plan.again) out.push(plan.again.switchedAt
    ? `An earlier move to ${plan.user.name} switched on ${plan.again.switchedAt.slice(0, 16)}Z: its copy is set aside beside it (never deleted) and made again from root's.`
    : usedCopy(plan.again)
      ? `An earlier move to ${plan.user.name} stopped root's dashboard on ${String(plan.again.switchingAt || plan.again.at).slice(0, 16)}Z and went back: its copy is set aside beside it (never deleted) and made again from root's.`
      : `An earlier move to ${plan.user.name} began a copy on ${String(plan.again.at).slice(0, 16)}Z and did not switch: that copy is taken away and made again.`);
  const r = plan.running;
  out.push('What runs now:');
  out.push(`  sessions working: ${r.working.length ? r.working.join(', ') : 'none'}`);
  out.push(`  idle sessions: ${r.idle.length ? r.idle.join(', ') : 'none'}`);
  out.push(`  terminals of root: ${r.terminals.length ? r.terminals.map((t) => t.session).join(', ') : 'none'}${r.terminals.length ? ' (ended after the switch, each by its own socket and session)' : ''}`);
  out.push(`  Work: ${r.work ? `${r.work} running` : 'nothing running'}; Tia: ${r.assistant ? `${r.assistant} working` : 'nothing working'}`);
  out.push('What would be copied (root\'s copy stays as it is):');
  for (const p of plan.parts) out.push(`  ${p.what}: ${p.from} → ${p.to}, ${p.entries} ${p.entries === 1 ? 'entry' : 'entries'}, ${size(p.bytes)}${p.repos ? `, ${p.repos} repositor${p.repos === 1 ? 'y' : 'ies'}` : ''}`);
  out.push(`  in all: ${plan.total.entries} ${plan.total.entries === 1 ? 'entry' : 'entries'}, ${size(plan.total.bytes)}; free on the user's disk: ${plan.free === null ? 'unknown' : size(plan.free)}`);
  out.push('Steps that run as administrator:');
  for (const s of plan.admin) out.push(`  ${s.why}${s.argv ? `: ${showCommand(s.argv)}` : ''}`);
  if (plan.network?.length) out.push(NETWORK_LINE(plan.user.name, plan.network, plan.proxy));
  for (const s of plan.stops) out.push(`STOP: ${s}`);
  return out;
}
