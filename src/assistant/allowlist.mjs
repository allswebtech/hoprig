// What Tia may allow by herself when a chat she started asks for an OK: a short allow-list, not a deny-list. A list of
// what is bad is never whole (a redirection glued to a path, a bare `cd`, `git -C..`, `npm test -- --import=…` …); so
// she allows only work on files inside the chat's folder and the few commands of TABLE with the few options it names,
// and everything else is the owner's card with one plain reason. Pure: the call (tool, its input) and the chat's folder
// in, a verdict out. policy.mjs asks it for her answer "allow" to a chat's OK of a known shape, and runs the deny-list
// (tia.mjs) after it.
//
//   a. file tools: every path of the call, resolved against the chat's folder by node:path, lies inside that folder;
//      no path names the home folder by "~" or a variable; no path is a file that may hold secrets; a write goes to no
//      place that makes a program run later (.git/, .claude/, .vscode/, .github/, .mcp.json …).
//   b. Bash: one simple command (none of ; & | < > ( ) { } $ ` \ ' " ~, no line break, and no * ? [ ]: the shell
//      would turn those into words nobody judged), its first word or two a key of TABLE, every word that starts with
//      "-" an option TABLE names for it, and every other word judged as its entry says.
//   c. any other tool (a page fetch, a web search, a skill, a subagent, a tool added later): the owner's.
//
// Two limits, said plainly. The secret rule goes by a file's name, so a search over the folder (grep -r, the Grep tool)
// can still show a line of such a file. Paths are judged as text, so a link that already lies in the folder and points
// outside it is not seen.
import os from 'node:os';
import path from 'node:path';
import { ASSISTANT_NAME, SECRET_FILES } from './tia.mjs';

const P = path.posix;

// ---------- the table: the commands she may allow herself, and every option each may carry ----------
// Key: the first word, or the first two. letters: one-letter options that may be combined (-la); flags: options taken
// exactly as written; num / word: options whose value is the next word, a number / a plain word (once each); eq: an
// option with "=" and a number in the same word (-count=3); dashNum: -<number> (-20); args: how the words that are not
// options are judged (ARGS below); script: a script runner (SCRIPT below). Any other option, "--" itself and an option
// glued to a value are a card. Keep it this short: a command earns a place by only looking at the folder, or only
// testing and building what is in it.
export const TABLE = {
  ls: { letters: 'alhR1trSdF', args: 'paths' },
  pwd: { args: 'paths' },
  cat: { flags: ['-n'], args: 'paths' },
  head: { num: ['-n', '-c'], dashNum: true, args: 'paths' },
  tail: { num: ['-n', '-c'], dashNum: true, args: 'paths' },
  wc: { letters: 'lcwm', args: 'paths' },
  stat: { args: 'paths' },
  du: { letters: 'sha', args: 'paths' },
  tree: { flags: ['-a', '-d'], num: ['-L'], args: 'paths' },
  file: { args: 'paths' },
  grep: { letters: 'niRrlcwvEFHhos', word: ['-e'], num: ['-A', '-B', '-C'], args: 'loose' },
  rg: { letters: 'nilcwvFS', word: ['-e'], num: ['-A', '-B', '-C'], args: 'loose' },
  'git status': { flags: ['-s', '--short', '-b', '--branch'], args: 'loose' },
  'git diff': { flags: ['--stat', '--name-only', '--name-status', '--cached', '--staged', '-p'], args: 'loose' },
  'git show': { flags: ['--stat', '--name-only', '--name-status', '--cached', '--staged', '-p'], args: 'loose' },
  'git log': { flags: ['--oneline', '--stat', '--name-only', '--graph', '--all', '-p'], num: ['-n'], dashNum: true, args: 'loose' },
  'git ls-files': { args: 'loose' },
  'git blame': { args: 'loose' },
  'git rev-parse': { flags: ['--abbrev-ref', '--show-toplevel', '--short'], args: 'loose' },
  'git describe': { flags: ['--tags', '--always'], args: 'loose' },
  npm: { script: true },
  pnpm: { script: true },
  yarn: { script: true },
  'node --test': { args: 'files' },
  pytest: { flags: ['-q', '-x', '-v', '-vv'], word: ['-k'], args: 'paths' },
  'go test': { flags: ['-v', '-race'], eq: ['-count'], word: ['-run'], args: 'packages' },
  'go build': { flags: ['-v', '-race'], eq: ['-count'], word: ['-run'], args: 'packages' },
  'go vet': { flags: ['-v', '-race'], eq: ['-count'], word: ['-run'], args: 'packages' },
  'cargo test': { flags: ['--release', '--workspace', '--all', '-q'], word: ['-p'], args: 'filter' },
  'cargo build': { flags: ['--release', '--workspace', '--all', '-q'], word: ['-p'], args: 'filter' },
  'cargo check': { flags: ['--release', '--workspace', '--all', '-q'], word: ['-p'], args: 'filter' },
};
// A script runner takes "test", or "run" and one of these names (test:unit too), and nothing after it: whatever follows
// (an option, "--" and what the script passes on) is read by npm or by the program the script starts.
const SCRIPT = /^(test|tests|lint|build|typecheck|check|format)(:[A-Za-z0-9_-]+)?$/;

export const WHY = {
  noFolder: 'the chat\'s folder is not known',
  notProject: 'the chat\'s folder is the whole disk, a home folder or a settings folder in it, not a project\'s folder',
  noPath: 'a call without the path it works on',
  outside: 'a path outside the chat\'s folder',
  home: 'a path that names the home folder or a variable',
  secret: 'a file that may hold secrets (a key, a password, a .env)',
  runsLater: 'a write to a file that makes a program run later (.git, .claude, .vscode, .github, .mcp.json …)',
  command: `a command that is not on the short list ${ASSISTANT_NAME} may allow herself`,
  option: `an option that is not on the short list ${ASSISTANT_NAME} may allow herself`,
  tool: `a tool ${ASSISTANT_NAME} does not allow herself (only files inside the folder and a short list of commands)`,
};

// ---------- rule a: one path ----------

/** Why `raw` is not a path she may touch by herself in folder `root` (absolute, normalised), or null. */
function pathWhy(raw, root) {
  if (typeof raw !== 'string' || !raw) return WHY.noPath;
  if (/[~$]/.test(raw)) return WHY.home;
  if (/[\\\x00-\x1f\x7f]/.test(raw)) return WHY.outside; // another system's separator, or a control character
  const abs = P.resolve(root, raw);
  if (abs !== root && !abs.startsWith(`${root}/`)) return WHY.outside;
  if (SECRET_FILES.test(raw) || SECRET_FILES.test(abs)) return WHY.secret;
  return null;
}
const optionalPath = (raw, root) => (raw === undefined ? null : pathWhy(raw, root));

// Places whose files a program runs or reads its settings from later: git's hooks and config, the coding tool's and the
// editors' settings and tasks, CI, the MCP servers a coding tool starts, npm's and direnv's start-up files. Compared
// without case (a Mac's disk does not tell .Git from .git).
const RUNS_LATER = new Set(['.git', '.claude', '.vscode', '.idea', '.husky', '.github', '.mcp.json', '.npmrc', '.envrc', '.pypirc']);
/** A write: a path she may touch, and no part of it a place in RUNS_LATER. */
function writeWhy(raw, root) {
  const why = pathWhy(raw, root);
  if (why) return why;
  return P.resolve(root, raw).toLowerCase().split('/').some((part) => RUNS_LATER.has(part)) ? WHY.runsLater : null;
}

// A glob of the Glob tool: what it can match must stay in the folder. No "..", no element that starts at "/" inside
// braces or a group ({/etc,src}), and an absolute one must start inside the folder.
function globWhy(raw, base, root) {
  if (typeof raw !== 'string' || !raw) return WHY.noPath;
  if (/[~$]/.test(raw)) return WHY.home;
  if (raw.includes('..') || /[{,(|]\s*\//.test(raw) || /[\\\x00-\x1f\x7f]/.test(raw)) return WHY.outside;
  return pathWhy(P.resolve(base, raw), root);
}
// The Grep tool's glob only filters the files under its path: it must not climb out or name another place.
function filterWhy(raw) {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') return WHY.noPath;
  if (/[~$]/.test(raw)) return WHY.home;
  if (raw.includes('..') || raw.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(raw)) return WHY.outside;
  return SECRET_FILES.test(raw) ? WHY.secret : null;
}

/** The coding tool's file tools and the paths of each call (input: the strings of the call). */
export const FILE_TOOLS = {
  Read: (i, root) => pathWhy(i.file_path, root),
  Write: (i, root) => writeWhy(i.file_path, root),
  Edit: (i, root) => writeWhy(i.file_path, root),
  MultiEdit: (i, root) => writeWhy(i.file_path, root),
  NotebookEdit: (i, root) => writeWhy(i.notebook_path, root),
  Glob: (i, root) => optionalPath(i.path, root) || globWhy(i.pattern, typeof i.path === 'string' ? P.resolve(root, i.path) : root, root),
  Grep: (i, root) => optionalPath(i.path, root) || filterWhy(i.glob),
};

// ---------- rule b: one command ----------

// Characters that make more than one simple command, redirect, expand or quote: with none of them, the words split on
// blanks are the words the program gets.
const NOT_SIMPLE = /[;&|<>(){}$`\\'"~*?[\]]|[^\x20-\x7e\t]/;
// A word of a package list (go): letters, digits and a few marks, nothing the shell or the tool reads further.
const PLAIN = /^[A-Za-z0-9_.,:=@%+/-]+$/;
// A test file of node --test: a path and nothing else (no "data:" or other URL, no "=").
const FILE = /^[A-Za-z0-9_.@+/-]+$/;
const NUMBER = /^[0-9]+$/;
// The value of a `word` option and cargo's test filter: a plain word that is not a path (no "/", no "..").
const isValue = (w) => /^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/.test(w) && !w.includes('..');

const first = (list, fn) => {
  for (const x of list) {
    const why = fn(x);
    if (why) return why;
  }
  return null;
};
// A word every piece of which (split at = : ,) is a path inside the folder.
function strictWord(w, root) {
  return first(w.split(/[=:,]/), (x) => x && pathWhy(x, root));
}
// A revision or a pattern: a plain word; every piece with a slash or a ".." is a path inside the folder; none names a
// secret file.
function looseWord(w, root) {
  if (SECRET_FILES.test(w)) return WHY.secret;
  return first(w.split(/[=:,]/), (x) => (x.includes('/') || x.includes('..')) && pathWhy(x, root));
}

/** How the words that are not options are judged (an entry's `args`). */
const ARGS = {
  paths: (ws, root) => first(ws, (w) => strictWord(w, root)),
  loose: (ws, root) => first(ws, (w) => looseWord(w, root)),
  files: (ws, root) => first(ws, (w) => (FILE.test(w) ? pathWhy(w, root) : WHY.command)),
  packages: (ws, root) => first(ws, (w) => (PLAIN.test(w) ? looseWord(w, root) : WHY.command)),
  filter: (ws) => (ws.length > 1 || (ws.length === 1 && !isValue(ws[0])) ? WHY.command : null),
};

/** An option word that needs no value of its own: named exactly, a group of the entry's letters, -<number>, -count=3. */
function optionOk(e, w) {
  if (e.flags && e.flags.includes(w)) return true;
  if (e.dashNum && /^-[0-9]+$/.test(w)) return true;
  if (e.letters && /^-[^-]/.test(w) && [...w.slice(1)].every((c) => e.letters.includes(c))) return true;
  const eq = /^(-[a-z]+)=([0-9]+)$/.exec(w);
  return !!(eq && e.eq && e.eq.includes(eq[1]));
}

/** The words after an entry's key: each option one it names (with its value), then the other words as `args` says. */
function wordsWhy(e, words, root) {
  const used = new Set();
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('-')) {
      rest.push(w);
      continue;
    }
    const valueOk = e.num && e.num.includes(w) ? (v) => NUMBER.test(v) : e.word && e.word.includes(w) ? isValue : null;
    // An option with a value: the next word, a number or a plain word, and the option only once.
    if (valueOk) {
      if (used.has(w) || i + 1 >= words.length || !valueOk(words[i + 1])) return WHY.option;
      used.add(w);
      i++;
      continue;
    }
    if (!optionOk(e, w)) return WHY.option;
    const name = w.split('=')[0];
    if (e.eq && e.eq.includes(name)) {
      if (used.has(name)) return WHY.option; // -count=3 -count=4: a second value
      used.add(name);
    }
  }
  return ARGS[e.args](rest, root);
}

/** Why `command` is not one she may allow herself in folder `root`, or null. */
function commandWhy(command, root) {
  if (typeof command !== 'string' || NOT_SIMPLE.test(command)) return WHY.command;
  const words = command.trim().split(/[ \t]+/);
  const two = words.slice(0, 2).join(' ');
  const key = words.length > 1 && Object.hasOwn(TABLE, two) ? two : Object.hasOwn(TABLE, words[0]) ? words[0] : null;
  if (!key) return WHY.command;
  const e = TABLE[key];
  const rest = words.slice(key.split(' ').length);
  if (e.script) return (rest.length === 1 && rest[0] === 'test') || (rest.length === 2 && rest[0] === 'run' && SCRIPT.test(rest[1])) ? null : WHY.command;
  return wordsWhy(e, rest, root);
}

// ---------- the chat's folder ----------

// A home folder by its usual place (a chat on another computer has its own home).
const HOME_AT = /^(\/home\/[^/]+|\/Users\/[^/]+|\/root)(?=\/|$)/;
/** The whole disk, a home folder or a folder that holds one is not a project's folder: it holds the shell's start-up
 * files and every account's settings. Nor is a folder directly in a home whose name starts with a dot or is "bin", or
 * anything in those (~/.config/x, ~/.local/share/y, ~/bin): settings, start-up entries and programs on the PATH. */
function notAProject(root, home) {
  if (root === '/' || root === '/home' || root === '/Users') return true;
  const homes = [];
  const m = HOME_AT.exec(root);
  if (m) homes.push(m[1]);
  if (typeof home === 'string' && home.startsWith('/')) homes.push(P.resolve(home));
  return homes.some((h) => {
    if (h === root || h.startsWith(`${root}/`)) return true;
    if (!root.startsWith(`${h}/`)) return false;
    const top = root.slice(h.length + 1).split('/')[0];
    return top.startsWith('.') || top === 'bin';
  });
}

/**
 * May Tia allow this call by herself? tool: the coding tool's name of it; input: the strings of the call (the command,
 * the paths; src/chat/engines/claude-parse.mjs askSubject); cwd: the chat's folder; home: this computer's home folder.
 * → { ok: true } | { ok: false, why }
 */
export function allowsHerself(tool, input, cwd, home = os.homedir()) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return { ok: false, why: WHY.noFolder };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, why: WHY.tool };
  const root = P.resolve(cwd);
  if (notAProject(root, home)) return { ok: false, why: WHY.notProject };
  let why;
  if (tool === 'Bash') why = commandWhy(input.command, root);
  else if (typeof tool === 'string' && Object.hasOwn(FILE_TOOLS, tool)) why = FILE_TOOLS[tool](input, root);
  else why = WHY.tool;
  return why ? { ok: false, why } : { ok: true };
}
