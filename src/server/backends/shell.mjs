// Building the one shell string the dashboard ever makes: the command line typed into a fresh login shell.

/** Quote one word for a POSIX shell. Plain words stay readable; anything else goes in single quotes. */
export function shellQuote(s) {
  s = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The line typed into a fresh login shell: change to the folder first (a shell rc may cd elsewhere on start),
 * then run the command. No `exec`, on purpose: when Claude exits the shell is still there, so the terminal
 * survives and shows what happened. `mark`: a file removed once the shell is back (marks.mjs): after the
 * command ended, and also when it could not start (the folder is gone, the program is missing). `command rm`: the
 * program itself, never an alias or a function of the owner's shell named rm (one that moves files to a trash).
 */
export function shellLine(dir, argv, { mark = null } = {}) {
  return `${CLEAR}; cd ${shellQuote(dir)} && ${argv.map(shellQuote).join(' ')}${mark ? `; command rm -f ${shellQuote(mark)}` : ''}`;
}

/**
 * Typed first, so the terminal starts clean: without it the typed command shows twice (once as it is typed
 * before the shell is ready, once echoed at the prompt) above Claude. printf is built into every shell; the
 * three sequences are "cursor home", "clear screen", "clear scrollback".
 */
export const CLEAR = "printf '\\033[H\\033[2J\\033[3J'";
