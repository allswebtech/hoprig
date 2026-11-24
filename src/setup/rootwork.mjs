// A fresh set-up as root (`hoprig setup`, `hoprig service install`) makes the work user the way the installer does: it
// runs the install.sh shipped with this Hoprig, which says every step with its command, asks once on a terminal (or
// takes --yes), makes the user and sets Hoprig up there. One implementation of the making, in install.sh's plain sh,
// because the installer must do it before Node exists; this module only starts it. The user gets the SAME build root
// runs: this package's own folder is the installer's source, never the newest from the network.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { appRoot } from './checks.mjs';

/** The installer shipped with this Hoprig. */
export const bundledInstaller = () => path.join(appRoot(), 'install.sh');

/** The command named in the installer's words for a person who ran set-up (install.sh: HOPRIG_INSTALL_COMMAND). */
export const SETUP_COMMAND = 'hoprig setup';

/**
 * Hoprig is set up for root already when root has its background service or a dashboard password: that installation
 * keeps working and the doctor offers the move. Otherwise a set-up as root is a fresh one, and makes the work user.
 * `serviceInstalled` and `cfg` are handed in (set-up's and the service command's own facts).
 */
export const freshRoot = ({ serviceInstalled, cfg }) => !serviceInstalled && !(cfg && cfg.server && typeof cfg.server.passwordHash === 'string' && cfg.server.passwordHash);

/** Said before the installer starts, so the person knows why the words that follow are the installer's. */
export const FRESH_ROOT_START = 'This is root and Hoprig is not set up here yet: the installer of this Hoprig makes an ordinary user for the work and sets Hoprig up there.';

/**
 * The argv and environment that run the bundled installer for the work user with set-up's own arguments `args` (they
 * go on to the user's set-up; --yes is his yes, --dry-run lists and makes nothing). HOPRIG_YES is left out: as root
 * only a typed --yes counts.
 */
export function workSetupCommand(args = [], env = process.env) {
  const { HOPRIG_YES: _yes, ...rest } = env;
  return {
    argv: ['sh', bundledInstaller(), ...args],
    env: { ...rest, HOPRIG_SOURCE: appRoot(), HOPRIG_INSTALL_COMMAND: SETUP_COMMAND },
  };
}

/**
 * Runs it with the terminal handed through (its one question is asked there). Resolves the exit code. Only as the
 * real root: anything else would be an ordinary install, which is not what was asked. `uid` is handed in by tests.
 */
export function runWorkSetup(args = [], { env = process.env, uid = typeof process.getuid === 'function' ? process.getuid() : null } = {}) {
  if (uid !== 0) {
    process.stderr.write('The work user is made only by root.\n');
    return Promise.resolve(1);
  }
  const { argv, env: e } = workSetupCommand(args, env);
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { env: e, stdio: 'inherit' });
    child.on('error', (err) => {
      process.stderr.write(`The installer could not start: ${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}
