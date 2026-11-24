// A help word after a command ("hoprig pair help", "hoprig service uninstall --help", "hoprig auto on -h") only ever
// prints help. "help" is the word a person types to be safe, so it must never do anything. Before this rule each
// command read the words itself, and some took the word as an argument: "service uninstall help" turned the
// background dashboard off, "machines join help" connected by SSH to a computer named "help", "auto on --help" turned
// Auto mode on, "rm <name> --help" and "add <name> --help" acted on a profile, "pair help" made a pairing code.
//
// So bin/hoprig.mjs asks helpRequest() BEFORE it dispatches, for every command alike, and on a help request prints the
// help (src/helptext.mjs) without running the command's code at all. No list of commands decides it: only the two
// lists below, of the places where a word is not Hoprig's to read. test/skill/helpwalk.test.mjs walks every command of
// the dispatch and every subcommand its help names with each help form, and holds that nothing else happened.
export const HELP_WORDS = ['help', '--help', '-h'];
const FLAGS = ['--help', '-h'];

/**
 * Commands whose words go on to a coding tool: `codex` and `opencode` (`hoprig opencode <provider> --help` asks
 * OpenCode), `run <profile> …` and `auto …` (Claude Code's arguments). Each names the subcommands that are Hoprig's
 * own: after those the help words are Hoprig's again ("auto on --help" prints help, "auto -c --help" goes to Claude
 * Code). A help word as the first word is always Hoprig's help. A profile's name (`hoprig <profile> --help`) is no
 * command of the dispatch: its words go to Claude Code as typed.
 */
export const PASSED_ON = {
  codex: ['login', 'logout'],
  opencode: [],
  run: [],
  auto: ['on', 'off', 'order', 'return', 'status'],
};

/**
 * The places where the plain word "help" can be a real value, as [command, subcommand]: after these subcommands the
 * words are free text (a task's title or note, the words a skill is searched by, what a coding session says needed a
 * way round), so "tasks add help" adds a task
 * named help and "skills find help" searches for it. In the place of the subcommand itself "help" is still help, and
 * --help and -h are help everywhere before a "--". Everywhere else the plain word is help.
 */
export const VALUE_PLACES = [['tasks', 'add'], ['tasks', 'edit'], ['skills', 'find'], ['skills', 'search'], ['field', 'way-round']];

const isValuePlace = (cmd, sub) => VALUE_PLACES.some(([c, s]) => c === cmd && s === sub);

/**
 * For `hoprig <cmd> <rest...>`: null when this is not a help request (run it as typed), else { sub }: the word in
 * the place of a subcommand (null when there is none), whose own help is printed where it has one.
 */
export function helpRequest(cmd, rest) {
  if (HELP_WORDS.includes(rest[0])) return { sub: null };
  if (Object.hasOwn(PASSED_ON, cmd)) {
    if (!PASSED_ON[cmd].includes(rest[0])) return null;
  }
  const end = rest.indexOf('--');
  const words = end < 0 ? rest : rest.slice(0, end);
  const sub = words[0] !== undefined && !words[0].startsWith('-') ? words[0] : null;
  const value = sub !== null && isValuePlace(cmd, sub);
  const asked = words.some((w, i) => FLAGS.includes(w) || (w === 'help' && !(value && i > 0)));
  return asked ? { sub } : null;
}
