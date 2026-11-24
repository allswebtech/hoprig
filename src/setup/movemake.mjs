// The move makes the work user the way the installer does (one implementation, install.sh's plain sh): it runs the
// install.sh shipped with this Hoprig with --user-only, which says its steps with their commands, makes the user
// (its comment, and the mark: a file of root's in its home), gives it root's login keys, the one sudoers file checked by visudo (none with --no-admin) and
// lingering, and installs nothing: the move copies root's installation and installs the same build itself.
import { capture } from './system.mjs';
import { lookUser, madeByHoprig } from './rootfacts.mjs';
import { bundledInstaller } from './rootwork.mjs';

/** The argv and environment of the installer's making of `name`. HOPRIG_YES never counts as root: --yes is the move's yes. */
export function makeUserCommand(name, { noAdmin = false, env = process.env } = {}) {
  const { HOPRIG_YES: _yes, ...rest } = env;
  return {
    argv: ['sh', bundledInstaller(), '--yes', '--user-only', '--user', name, ...(noAdmin ? ['--no-admin'] : [])],
    env: { ...rest, HOPRIG_INSTALL_COMMAND: 'hoprig move-to-user' },
  };
}

/**
 * Make the plan's user. `say` takes each line of the installer. → { ok, user } (a passwdEntry-like { name, uid, gid,
 * home }) or { ok: false, why } naming the installer's own error line. `run`, `look` and `marked` are handed in by tests.
 */
export async function makeWorkUser(plan, { say = () => {}, noAdmin = false, run = capture, look = (n) => lookUser(n), marked = (u) => madeByHoprig(u), env = process.env } = {}) {
  const name = plan.user.name;
  const { argv, env: e } = makeUserCommand(name, { noAdmin, env });
  const r = await run(argv, { env: e, timeout: 5 * 60_000 });
  const lines = `${r.stdout || ''}${r.stderr || ''}`.split('\n').filter((l) => l.trim());
  for (const l of lines) say(l);
  if (!r.ok) {
    const failed = lines.find((l) => l.startsWith('hoprig installer: ')) || `the installer ended with exit ${r.code ?? 'unknown'}`;
    return { ok: false, why: failed.replace(/^hoprig installer: /, '') };
  }
  const u = await look(name);
  if (!u || !marked(u) || !(u.uid >= 1000)) return { ok: false, why: `the installer ended, but ${name} is not a user Hoprig made with an ordinary user id` };
  return { ok: true, user: { name: u.name, uid: u.uid, gid: u.gid, home: u.home.replace(/\/+$/, '') } };
}
