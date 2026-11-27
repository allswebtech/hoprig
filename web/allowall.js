// "Allow everything": the mode beyond Bypass permissions (src/bypassgate.mjs). Its words, and the one question asked
// the first time on a computer (the acknowledgement). Everything that offers the mode (the chat's mode menu, a new
// session's options, Settings → New sessions) asks through askOnce before the choice goes ahead; after the first yes it
// is a mode like the others.
import { api, confirmSheet, toast } from './lib.js';

export const ALL = 'allowEverything';

/** What the mode means: said under the choice in the New Session options and Settings → New sessions. */
export const ALL_SAYS = ['Nothing is held, also not what Hands-off holds, except a delete of your whole home, workspace or disk.', 'It is for work you watch or trust.'];
export const ALL_MEANS = `${ALL_SAYS.join(' ')} Claude Code runs every command and changes every file without asking: a command Hoprig cannot read, a delete, a push, a release, a command with sudo. A wrong command can delete or overwrite your files. Questions, plans to approve, a sign-in and a usage limit still come to you. What Hoprig would have held leaves one quiet line in the session.`;
/** The note under the defaults select while Allow everything is the default. */
export const ALL_DEFAULT_NOTE = 'Only sessions you start yourself on this page start in Allow everything. Sessions started by Tia, a schedule, Work or another computer start in Bypass permissions.';
export const ACK_TITLE = 'Allow everything on this computer?';
export const ACK_TEXT = `${ALL_SAYS.join(' ')} In this mode nothing asks you for permission. Claude Code runs every command and changes every file without stopping, also what Hands-off or Bypass permissions would hold. A wrong command can delete or overwrite your files, and nobody is asked first. Questions, plans to approve, a sign-in and a usage limit still come to you. Sessions Tia starts, schedules and Work never run in this mode. You are asked this once on this computer.`;
export const ACK_OK = 'Allow everything';
export const ACK_TOAST = 'Allow everything is accepted on this computer';

/**
 * Has the owner accepted Allow everything on this computer? If not, the sheet; his yes is sent once. → true when the
 * choice may go ahead. `state`: { everything } as GET /api/settings/bypass says it (kept up to date here, so the page
 * asks once), or null to look it up. `deps`: the page's functions, for a test.
 */
export async function askOnce(state = null, deps = {}) {
  const { call = api, sheet = confirmSheet, say = toast } = deps;
  const s = state || {};
  if (typeof s.everything !== 'boolean') {
    try {
      s.everything = (await call('/api/settings/bypass')).everything === true;
    } catch {
      s.everything = false;
    }
  }
  if (s.everything) return true;
  if (!(await sheet({ title: ACK_TITLE, text: ACK_TEXT, ok: ACK_OK, danger: true }))) return false;
  try {
    await call('/api/settings/bypass/everything', { confirm: true });
  } catch (e) {
    say(e, { kind: 'error' });
    return false;
  }
  s.everything = true;
  say(ACK_TOAST);
  return true;
}
