// The one shell string the dashboard ever makes: the command line typed into a fresh login shell.
//
// Nothing that came from outside is ever in it. A shell's line editor reads every typed byte before the shell parses
// the line: Ctrl-U erases the opening quote, Tab completes and closes it, fish reads \' inside single quotes, csh
// expands ! in them. So quoting cannot make outside text safe to type; the folder, the arguments and the first
// message go in a launch file (src/launchfile.mjs) and the line holds only the launcher's own command, the file's
// path and the start mark. Each of those words is refused unless all its characters are on one short list that no
// shell reads specially, inside or outside quotes.

/**
 * Letters, marks and digits of any script, and _ . / : @ % + = , - and space. Nothing else: no quote, backslash, !,
 * $, `, ~, *, ?, brackets, control byte or line end.
 */
const TYPABLE = /^[\p{L}\p{M}\p{N}_./:@%+=, -]+$/u;

// What the shell would split or read as an option, or the Windows command line would read as a quote: never in a word
// of a Windows terminal's command (it is not typed there, but goes to ConPTY as one command line).
const WINDOWS_BAD = /["\p{Cc}]/u;

/**
 * The plain error for a word that cannot go on a start line: 400, so the page shows the sentence and the assistant
 * gets it as a tool error.
 */
export function untypable(word) {
  const e = new Error(`Hoprig cannot start a terminal from this path: ${JSON.stringify(String(word))}. Its name holds a character that a shell reads specially (only letters, digits, spaces and _ . / : @ % + = , - can be used). Install Node and Hoprig in a folder whose path has none of the others, or move the state folder (HOPRIG_STATE_DIR) to one.`);
  e.status = 400;
  return e;
}

/** Throws untypable() for the first word that cannot be typed (`platform` win32: the Windows command line's rule). */
export function assertTypable(words, platform = process.platform) {
  for (const w of words) {
    const s = String(w);
    if (platform === 'win32' ? !s || WINDOWS_BAD.test(s) : !TYPABLE.test(s)) throw untypable(s);
  }
}

/** Quote one word that passed assertTypable: plain words stay readable; one with a space or other letters is quoted. */
export function shellQuote(s) {
  s = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s}'`;
}

/**
 * The line typed into a fresh login shell. No `cd`: the terminal starts in its folder, and the launcher goes to the
 * folder its launch file names (a shell rc may change the folder on start). No `exec`, on purpose: when the coding
 * tool exits the shell is still there, so the terminal survives and shows what happened. `mark`: a file removed once
 * the shell is back (marks.mjs): after the command ended, and also when it could not start (the program is missing).
 * `command rm`: the program itself, never an alias or a function of the owner's shell named rm (one that moves files
 * to a trash).
 */
export function shellLine(argv, { mark = null } = {}) {
  assertTypable(mark ? [...argv, mark] : argv, 'posix');
  return `${CLEAR}; ${argv.map(shellQuote).join(' ')}${mark ? `; command rm -f ${shellQuote(mark)}` : ''}`;
}

/**
 * Typed first, so the terminal starts clean: without it the typed command shows twice (once as it is typed
 * before the shell is ready, once echoed at the prompt) above the coding tool. printf is built into every shell;
 * the three sequences are "cursor home", "clear screen", "clear scrollback". A fixed text of our own, never input.
 */
export const CLEAR = "printf '\\033[H\\033[2J\\033[3J'";
