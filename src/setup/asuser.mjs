// The one way Hoprig runs a step as the work user it made, from root's own session. A command run "as the user" from
// root's session has no address of that user's service manager: `su - <user> -c "systemctl --user …"` fails with
// "Failed to connect to user scope bus" because XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are not set. So every
// step goes through runuser with both named, and a PATH that finds the user's own Hoprig and Node first. install.sh
// has the same rule in its function as_user (it runs before Node exists); keep the two alike.
import fs from 'node:fs';
import path from 'node:path';
import { capture, which } from './system.mjs';
import { USER_NAME_RE } from './rootfacts.mjs';

/** The folder of the user's service manager, made by systemd once the user's manager runs (lingering starts it). */
export const runtimeDir = (uid) => `/run/user/${uid}`;

/**
 * The newest Node bin folder of the user's own nvm (`<home>/.nvm/versions/node/v*\/bin`, else the workspace's
 * `<home>/Workspace/development/nodejs/nvm/versions/node/v*\/bin`, where pc setup puts a new nvm), or '' when there is none.
 */
export function userNodeBin(home, { readdir = fs.readdirSync } = {}) {
  let base;
  let names;
  for (const nvm of [path.posix.join(home, '.nvm'), path.posix.join(home, 'Workspace', 'development', 'nodejs', 'nvm')]) {
    try {
      names = readdir(path.posix.join(nvm, 'versions', 'node'));
      base = path.posix.join(nvm, 'versions', 'node');
      break;
    } catch {
      /* not this one */
    }
  }
  if (!base) return '';
  const num = (v) => v.slice(1).split('.').map(Number);
  const newest = names
    .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => {
      const [x, y] = [num(a), num(b)];
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    })
    .pop();
  return newest ? path.posix.join(base, newest, 'bin') : '';
}

/**
 * The argv that runs `argv` as the user { name, uid, home }: runuser with the user's HOME, USER, LOGNAME, the address
 * of its service manager and a PATH of its own. An array, no shell string. `nodeBin` is the user's Node bin folder
 * (userNodeBin), left out of PATH when there is none yet.
 */
export function asUserArgv(user, argv, { nodeBin = '' } = {}) {
  const { name, uid, home } = user || {};
  if (!USER_NAME_RE.test(String(name || ''))) throw new Error(`"${name}" is not a user name`);
  if (!Number.isInteger(uid) || uid <= 0) throw new Error(`the user ${name} has no ordinary user id`);
  if (typeof home !== 'string' || !path.posix.isAbsolute(home)) throw new Error(`the user ${name} has no home folder`);
  if (!Array.isArray(argv) || !argv.length || argv.some((a) => typeof a !== 'string')) throw new Error('nothing to run as the user');
  const run = runtimeDir(uid);
  const PATH = [path.posix.join(home, '.local', 'bin'), nodeBin, '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  return [
    'runuser', '-u', name, '--',
    'env', `HOME=${home}`, `USER=${name}`, `LOGNAME=${name}`,
    `XDG_RUNTIME_DIR=${run}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=${run}/bus`, `PATH=${PATH}`,
    ...argv,
  ];
}

/** The one line said when this computer has no runuser: the step stops there. */
export const NO_RUNUSER = 'runuser is not on this computer (it comes with util-linux): the step as the work user cannot run, so it stops here.';

/**
 * Run `argv` as the user. Resolves like capture ({ ok, code, stdout, stderr }); without runuser it does not start
 * anything and says NO_RUNUSER. `run`, `has` and `readdir` are handed in by tests.
 */
export async function runAsUser(user, argv, { run = capture, has = (c) => !!which(c), readdir, env = process.env, timeout = 120_000 } = {}) {
  const full = asUserArgv(user, argv, { nodeBin: userNodeBin(user.home, readdir ? { readdir } : {}) });
  if (!has('runuser')) return { ok: false, code: null, stdout: '', stderr: NO_RUNUSER, error: 'ENOENT' };
  return run(full, { env, timeout });
}

/**
 * Wait, bounded, for the user's service manager: its socket `/run/user/<uid>/bus`, made once lingering has started
 * it. True when it is there. `isSocket` and `sleep` are handed in by tests.
 */
export async function waitForBus(uid, { limitMs = 15_000, stepMs = 500, isSocket = defaultIsSocket, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const bus = `${runtimeDir(uid)}/bus`;
  for (let waited = 0; ; waited += stepMs) {
    if (isSocket(bus)) return true;
    if (waited >= limitMs) return false;
    await sleep(stepMs);
  }
}

function defaultIsSocket(p) {
  try {
    return fs.statSync(p).isSocket();
  } catch {
    return false;
  }
}
