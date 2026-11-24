// Run ONE administrator command of Tia's, at the "Ask each time" and "Full" levels.
// It reuses the computer set-up's own construction (src/pcsetup/admin.mjs) and changes none of its promises:
//   - sudo runs as `sudo -S -k -p '' -- <program> <args>`: the password goes to sudo's input, never on a command line;
//     `-k` makes sudo keep no cached sign-in, so the server process holds no administrator rights after the command;
//   - the password is checked first (`sudo -S -k -p '' -- true`): a wrong one runs nothing and the page asks again;
//   - every kept line is scrubbed of the password, and the password is never written, logged, returned or kept;
//   - where sudo asks nothing (a NOPASSWD account — Full's only home) it runs `sudo -n -- <program> <args>`, no
//     password at all.
//
// This module only runs an argv it is handed. Which commands are administrator commands, and the exact argv, are the
// wall's one reader through sudoArgv (src/assistant/adminrefused.mjs): there is no second reader here.
import { sudoArgv } from './adminrefused.mjs';
import { adminRunner, checkPassword } from '../pcsetup/admin.mjs';
import { stream } from '../setup/system.mjs';

export { sudoArgv };

/**
 * Run a `['sudo', <program>, …]` argv (from sudoArgv) as administrator. With a password it is checked first: a wrong
 * one runs nothing (`{ wrong: true }`), and an account that may not use sudo at all is said once (`{ notAllowed: true
 * }`) — neither runs the command. Without a password (a NOPASSWD account) it runs `sudo -n`. The returned `output` is
 * scrubbed of the password, and the password is in no field returned here.
 *
 * @param {object} o
 * @param {string[]} o.argv       a `['sudo', <program>, …]` from sudoArgv
 * @param {string} [o.password]   the one-shot password the owner typed on his page, or '' for a NOPASSWD account
 * @param {string|null} [o.cwd]   the folder to run in
 * @param {Function} [o.run]      the base runner (stream by default; a test passes a stand-in)
 * @param {Function} [o.check]    the password check (checkPassword by default)
 * @returns {Promise<{ ran: boolean, ok: boolean, code: number|null, output: string, wrong: boolean, notAllowed: boolean }>}
 */
export async function runAdmin({ argv, password = '', cwd = null, run = stream, check = checkPassword } = {}) {
  if (!Array.isArray(argv) || argv[0] !== 'sudo') throw new Error('runAdmin needs a sudo argv from sudoArgv');
  if (password) {
    const c = await check(password, run);
    if (!c.ok) return { ran: false, ok: false, code: null, output: '', wrong: !c.notAllowed, notAllowed: c.notAllowed };
  }
  const r = await adminRunner(password || null, run)(argv, { ...(cwd ? { cwd } : {}) });
  return { ran: true, ok: r.ok, code: Number.isInteger(r.code) ? r.code : null, output: r.output || '', wrong: false, notAllowed: false };
}
