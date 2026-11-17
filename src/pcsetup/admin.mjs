// Administrator rights for the dashboard's setup jobs, without a terminal.
//
// The rule (it replaced "no password ever goes through this page", Nov 2026): setup runs in the page, so when sudo
// needs the computer's password the page asks for it once, for that one job. Because:
//   - the owner asked for setup without a terminal; a terminal only for the password sent him away from the page;
//   - the password is sent like the dashboard's own password (same page, same connection), and the page warns on a
//     plain-http connection that is not this computer and offers the terminal instead.
// How it is kept safe:
//   - each admin step runs as `sudo -S -k -p '' -- <argv…>`: the password goes to sudo's input, never on a command
//     line; -k makes sudo ignore and not keep a cached sign-in, so the server process holds no admin rights after;
//   - the password stays in memory for that job only (never written, logged, returned or put in a job's state), and
//     every output line is scrubbed of it before it is kept;
//   - it is checked first (`sudo -S -k -p '' -- true`): a wrong one installs nothing and the page asks again.
import { forInstalls, withoutSecrets } from '../secretenv.mjs';
import { capture, stream } from '../setup/system.mjs';

const HIDDEN = '••••';

/** True when sudo would ask for a password here: not root, sudo is there, and `sudo -n true` is refused. */
export async function sudoNeedsPassword(sys, run = capture) {
  if (!sys || sys.root || !sys.has('sudo')) return false;
  const r = await run(['sudo', '-n', 'true'], { timeout: 10_000 });
  return !r.ok;
}

/**
 * An argv written with sudo, as a job runs it: with a password `sudo -S -k -p '' -- …` (it is read from the input),
 * without one `sudo -n -- …` (it may not ask: no terminal would see the question). Anything else as it is.
 */
export function asAdmin(argv, withPassword) {
  if (!Array.isArray(argv) || argv[0] !== 'sudo') return argv;
  return ['sudo', ...(withPassword ? ['-S', '-k', '-p', ''] : ['-n']), '--', ...argv.slice(1)];
}

/** A function that replaces `secret` in a text with dots (nothing to do without one). */
export const scrubber = (secret) => (s) => (secret ? String(s).split(secret).join(HIDDEN) : String(s));

/**
 * Check the password before anything is installed: { ok, notAllowed }. `notAllowed`: the password may be right but
 * this account may not use sudo at all (asking again would not help).
 */
export async function checkPassword(password, run = stream) {
  const clean = scrubber(password);
  const lines = [];
  const r = await run(asAdmin(['sudo', 'true'], true), { input: `${password}\n`, onLine: (l) => lines.push(clean(l)) });
  if (r.ok) return { ok: true, notAllowed: false };
  return { ok: false, notAllowed: /not in the sudoers|is not allowed to|may not run sudo/i.test(lines.join('\n')) };
}

/**
 * A stream()-like runner for a setup job: sudo steps as asAdmin() says, the password to sudo's input only, every
 * line scrubbed, nothing ever given a terminal, no secret in the environment, and git never asks for a password
 * (GIT_TERMINAL_PROMPT=0).
 */
export function adminRunner(password, base = stream) {
  const clean = scrubber(password);
  return (argv, o = {}) => {
    const admin = Array.isArray(argv) && argv[0] === 'sudo';
    const onLine = o.onLine || (() => {});
    return base(asAdmin(argv, Boolean(password)), {
      ...o,
      interactive: false,
      // No secret reaches a step, whatever env the caller gave. The caller's own env says the rest: a kit's steps come
      // with forInstalls() (runSteps), while a clone or a project's own dependency install keeps GitHub's token, as it
      // does from `hoprig pc setup` in a terminal (a private repository may need it). Without one: as an install.
      env: { ...(o.env ? withoutSecrets(o.env) : forInstalls(process.env)), GIT_TERMINAL_PROMPT: '0' },
      onLine: (l) => onLine(clean(l)),
      input: admin && password ? `${password}\n` : null,
    }).then((r) => ({ ...r, output: clean(r.output || '') }));
  };
}
