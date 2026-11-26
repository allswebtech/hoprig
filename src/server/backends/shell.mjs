// The one shell string the dashboard ever makes: the command line typed into a fresh login shell.
//
// Nothing that came from outside is ever in it. A shell's line editor reads every typed byte before the shell parses
// the line: Ctrl-U erases the opening quote, Tab completes and closes it, fish reads \' inside single quotes, csh
// expands ! in them. So quoting cannot make outside text safe to type; the folder, the arguments and the first
// message go in a launch file (src/launchfile.mjs) and the line holds only the launcher's own command, the file's
// path and the start mark. Each of those words is refused unless all its characters are on one short list that no
// shell reads specially, inside or outside quotes.
//
// And only printable ASCII is typed. A line editor may read a byte above 0x7f as a key of its own: bash 3.2 (macOS's
// /bin/bash) under the C locale takes each one for a Meta key (a count, a binding), so the line it runs is not the one
// typed. A word with any other character (a home folder named in the owner's language) goes into the terminal's
// environment instead, and the line names it in double quotes: every shell expands that without its editor reading
// the value.

/**
 * Letters, marks and digits of any script, and _ . / : @ % + = , - and space. Nothing else: no quote, backslash, !,
 * $, `, ~, *, ?, brackets, control byte or line end. Those beyond ASCII are not typed but named (WORD).
 */
const TYPABLE = /^[\p{L}\p{M}\p{N}_./:@%+=, -]+$/u;

// What the shell would split or read as an option, or the Windows command line would read as a quote: never in a word
// of a Windows terminal's command (it is not typed there, but goes to ConPTY as one command line).
const WINDOWS_BAD = /["\p{Cc}]/u;
// A program that is a .cmd or .bat file: Windows starts it through cmd.exe, which reads the whole command line again.
// There % (and ! where delayed expansion is on) reads a variable, & | < > start a second command or a redirection,
// and ^ escapes the next character. None of them may be in any word of such a command. An .exe gets the line as it
// is: no shell reads it, so a % or a $ in a path is only a character there.
const CMD_FILE = /\.(cmd|bat)$/i;
const CMD_BAD = /[%!^&|<>]/;

/**
 * The plain error for a word that cannot go on a start line: 400, so the page shows the sentence and the assistant
 * gets it as a tool error. `platform` win32: the sentence of a Windows terminal, where nothing is typed.
 */
export function untypable(word, platform = 'posix', viaCmd = false) {
  const said = JSON.stringify(String(word));
  const e = new Error(platform === 'win32'
    ? `Hoprig cannot type this path into a shell: ${said}. On Windows a word of the start cannot hold a quote, a line break or another control character${viaCmd ? ', nor any of % ! ^ & | < > when the program is a .cmd or .bat file (Windows starts it through cmd.exe)' : ''}: put Node, Hoprig or the state folder (HOPRIG_STATE_DIR) where its path has none of these, or name node.exe and Hoprig's script as the launcher`
    : `Hoprig cannot type this path into a shell: ${said}. Only letters, digits, spaces and _ . / : @ % + = , - can be typed: put Node, Hoprig or the state folder (HOPRIG_STATE_DIR) where its path has nothing else`);
  e.status = 400;
  return e;
}

/**
 * Throws untypable() for the first word that cannot be typed (`platform` win32: the Windows command line's rule; the
 * first word is the program, and a .cmd or .bat program puts every word under cmd.exe's rule too).
 */
export function assertTypable(words, platform = process.platform) {
  const viaCmd = platform === 'win32' && words.length > 0 && CMD_FILE.test(String(words[0]));
  for (const w of words) {
    const s = String(w);
    if (platform === 'win32' ? !s || WINDOWS_BAD.test(s) || (viaCmd && CMD_BAD.test(s)) : !TYPABLE.test(s)) throw untypable(s, platform === 'win32' ? 'win32' : 'posix', viaCmd);
  }
}

/** Quote one word that passed assertTypable: plain words stay readable; one with a space or other letters is quoted. */
export function shellQuote(s) {
  s = String(s);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s}'`;
}

/** The environment variables a start line names its words beyond ASCII by: HOPRIG_WORD_1, HOPRIG_WORD_2, ... */
const WORD = 'HOPRIG_WORD_';
const ASCII = /^[\x20-\x7e]*$/;

/**
 * The line typed into a fresh login shell, and the environment the terminal is started with for it: { line, env }
 * (env is empty when every word is plain ASCII, as it nearly always is). No `cd`: the terminal starts in its folder,
 * and the launcher goes to the folder its launch file names (a shell rc may change the folder on start). No `exec`,
 * on purpose: when the coding tool exits the shell is still there, so the terminal survives and shows what happened.
 * `mark`: a file removed once the shell is back (marks.mjs): after the command ended, and also when it could not start
 * (the program is missing). `command rm`: the program itself, never an alias or a function of the owner's shell named
 * rm (one that moves files to a trash).
 */
export function shellLine(argv, { mark = null } = {}) {
  assertTypable(mark ? [...argv, mark] : argv, 'posix');
  const env = {};
  const word = (w) => {
    if (ASCII.test(String(w))) return shellQuote(w);
    const name = `${WORD}${Object.keys(env).length + 1}`;
    env[name] = String(w);
    return `"$${name}"`;
  };
  return { line: `${CLEAR}; ${argv.map(word).join(' ')}${mark ? `; command rm -f ${word(mark)}` : ''}`, env };
}

/**
 * Typed first, so the terminal starts clean: without it the typed command shows twice (once as it is typed
 * before the shell is ready, once echoed at the prompt) above the coding tool. printf is built into every shell;
 * the three sequences are "cursor home", "clear screen", "clear scrollback". A fixed text of our own, never input.
 */
export const CLEAR = "printf '\\033[H\\033[2J\\033[3J'";
