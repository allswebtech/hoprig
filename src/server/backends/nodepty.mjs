// node-pty (the terminal module, an optional dependency), loaded once for every part that uses it: the built-in
// terminals, the tmux attach client, the account sign-in and setup's check.
//
// Once, and with require, for a reason. A node-pty that is installed but not built throws while it loads (npm 12
// does not run its install script in a global install; --ignore-scripts does the same). When such a package is
// imported a second time (`import('node-pty')` in one module, `import pty from 'node-pty'` in another), Node 20,
// 22 and 26 report the second import as loaded and then end the process with the first error as an unhandled
// rejection: `hoprig doctor` and `hoprig setup` died with a stack trace instead of saying what is wrong. A require
// that throws is an ordinary exception, caught here.
import { createRequire } from 'node:module';
import { ensureSpawnHelper } from './pty-helper.mjs';

let nodePty = null;
let nodePtyError = '';
try {
  nodePty = createRequire(import.meta.url)('node-pty');
} catch (e) {
  nodePtyError = String(e.message).split('\n')[0];
}

/**
 * node-pty's spawn, with its helper made executable first (pty-helper.mjs: a fresh install on macOS leaves it without
 * the bit, and every spawn then fails with "posix_spawnp failed"), for every part, also the account sign-in that may be
 * the first terminal a dashboard opens; without the module, a function that says what to do.
 */
export const ptySpawn = nodePty
  ? (...args) => {
      ensureSpawnHelper();
      return nodePty.spawn(...args);
    }
  : () => {
      throw new Error('the terminal module (node-pty) does not work: run "hoprig doctor"');
    };
export { nodePty, nodePtyError };
