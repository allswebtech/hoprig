// What Tia may allow by herself when a chat she started asks for an OK: a short allow-list, not a deny-list. A list of
// what is bad is never whole (a redirection glued to a path, a bare `cd`, `git -C..`, `npm test -- --import=…` …); so
// she allows only work on files inside the chat's folder and the few commands of TABLE with the few options it names,
// and everything else is the owner's card with one plain reason. Pure: the call (tool, its input) and the chat's folder
// in, a verdict out. policy.mjs asks it for her answer "allow" to a chat's OK of a known shape, and runs the deny-list
// (tia.mjs) after it.
//
//   0. the chat's folder is a project's: not the whole disk, a system folder, a home folder or a settings folder in it,
//      nor a folder whose own path names secrets or a place that makes a program run later.
//   a. file tools: every path of the call, resolved against the chat's folder by node:path, lies inside that folder and
//      is plain ASCII; no path names the home folder by "~" or a variable; below the folder, no path is a file that may
//      hold secrets, and a write goes to no place that makes a program run later (.git/, .claude/, .vscode/, .mcp.json …).
//   b. Bash: one simple command of plain ASCII (none of ; & | < > ( ) { } $ ` \ ' " ~, no line break, and no * ? [ ]:
//      the shell would turn those into words nobody judged), no word that starts with "@" or "=" (some programs read
//      such a word as a file of options; a shell expands it), its first word or two a key of TABLE, every word that
//      starts with "-" an option TABLE names for it, and every other word judged as its entry says.
//   c. any other tool (a page fetch, a web search, a skill, a subagent, a tool added later): the owner's.
//
// Its limits, said plainly:
// - The secret rule goes by a file's name, so a search over the folder (grep -r, the Grep tool) can still show a line
//   of such a file.
// - Paths are judged as text, so a link in the folder that points outside it is not seen.
// - npm, git and the coding tool's own search look upward and around inside the repository: in a chat whose folder is a
//   subfolder of one, they can read what the repository holds above it.
// - A write inside the folder followed by a test run runs what was written (a test file, package.json): that is what
//   letting her write and test means, and why the level is the owner's choice.
import os from 'node:os';
import path from 'node:path';
import { ASSISTANT_NAME, SECRET_FILES } from './tia.mjs';

const P = path.posix;

// ---------- the table: the commands she may allow herself, and every option each may carry ----------
// Key: the first word, or the first two. letters: one-letter options that may be combined (-la); flags: options taken
// exactly as written; num / word: options whose value is the next word, a number / a plain word (once each); dashNum:
// -<number> (-20); args: how the words that are not options are judged (ARGS below); script: a script runner (SCRIPT
// below); exact: the key and nothing after it. Any other option, "--" itself and an option glued to a value are a card. Keep it this short: a command earns
// a place by only looking at the folder, or only testing and building what is in it. A test runner that reads its
// words its own way (a file of options, an import path, any file as a test) stays off until it is studied on its own.
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
  // Exactly these two words: node finds the project's test files by itself.
  'node --test': { exact: true },
};
// A script runner takes "test", or "run" and one of these names (test:unit too), and nothing after it: whatever follows
// (an option, "--" and what the script passes on) is read by npm or by the program the script starts.
const SCRIPT = /^(test|tests|lint|build|typecheck|check|format)(:[A-Za-z0-9_-]+)?$/;

export const WHY = {
  noFolder: 'the chat\'s folder is not known',
  notProject: 'the chat\'s folder is not a project\'s folder (the whole disk, a system folder, a home folder, a settings folder, or one that holds secrets)',
  noPath: 'a call without the path it works on',
  outside: 'a path outside the chat\'s folder',
  home: 'a path that names the home folder or a variable',
  notAscii: 'a path with a character outside plain ASCII (a disk that ignores case may read it as another name)',
  secret: 'a file that may hold secrets (a key, a password, a .env)',
  runsLater: 'a write to a file that makes a program run later (.git, .claude, .vscode, .github, .mcp.json …)',
  command: `a command that is not on the short list ${ASSISTANT_NAME} may allow herself`,
  option: `an option that is not on the short list ${ASSISTANT_NAME} may allow herself`,
  atWord: 'a word that starts with "@" or "=": a file some programs read their options from, or a word the shell expands',
  tool: `a tool ${ASSISTANT_NAME} does not allow herself (only files inside the folder and a short list of commands)`,
};

// ---------- rule a: one path ----------

// Places whose files a program runs or reads its settings from later: git's hooks and config, the coding tool's and the
// editors' settings and tasks, CI, the MCP servers a coding tool starts, npm's and direnv's start-up files. Compared
// without case (a Mac's disk does not tell .Git from .git).
const RUNS_LATER = new Set(['.git', '.claude', '.vscode', '.idea', '.husky', '.github', '.mcp.json', '.npmrc', '.envrc', '.pypirc']);

/** The part of `abs` (inside `root`) below the folder, as parts. */
const below = (abs, root) => (abs === root ? [] : abs.slice(root.length + 1).split('/'));

/** Why `raw` is not a path she may touch by herself in folder `root` (absolute, normalised), or null. The secret rule
 * reads from the folder's own name down: what lies above is rule 0's business, and a name that spans the edge
 * (a folder .docker, a file config.json in it) is still seen. */
function pathWhy(raw, root) {
  if (typeof raw !== 'string' || !raw) return WHY.noPath;
  if (/[~$]/.test(raw)) return WHY.home;
  if (/[^\x00-\x7f]/.test(raw)) return WHY.notAscii;
  if (/[\\\x00-\x1f\x7f]/.test(raw)) return WHY.outside; // another system's separator, or a control character
  const abs = P.resolve(root, raw);
  if (abs !== root && !abs.startsWith(`${root}/`)) return WHY.outside;
  return SECRET_FILES.test([P.basename(root), ...below(abs, root)].join('/')) ? WHY.secret : null;
}
const optionalPath = (raw, root) => (raw === undefined ? null : pathWhy(raw, root));

/** A write: a path she may touch, and no part of it below the folder a place in RUNS_LATER. */
function writeWhy(raw, root) {
  const why = pathWhy(raw, root);
  if (why) return why;
  return below(P.resolve(root, raw), root).some((part) => RUNS_LATER.has(part.toLowerCase())) ? WHY.runsLater : null;
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
  if (/[^\x00-\x7f]/.test(raw)) return WHY.notAscii;
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

// Characters that make more than one simple command, redirect, expand or quote, and any that is not plain ASCII: with
// none of them, the words split on blanks are the words the program gets.
const NOT_SIMPLE = /[;&|<>(){}$`\\'"~*?[\]]|[^\x20-\x7e\t]/;
const NUMBER = /^[0-9]+$/;
// The value of a `word` option: a plain word that is not a path (no "/", no "..").
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
// A revision or a pattern: a plain word; every piece with a slash or a ".." is a path inside the folder; no other piece
// names a secret file.
function looseWord(w, root) {
  return first(w.split(/[=:,]/), (x) => (x.includes('/') || x.includes('..') ? pathWhy(x, root) : SECRET_FILES.test(x) ? WHY.secret : null));
}

/** How the words that are not options are judged (an entry's `args`). */
const ARGS = {
  paths: (ws, root) => first(ws, (w) => strictWord(w, root)),
  loose: (ws, root) => first(ws, (w) => looseWord(w, root)),
};

/** An option word that needs no value of its own: named exactly, a group of the entry's letters, -<number>. */
function optionOk(e, w) {
  if (e.flags && e.flags.includes(w)) return true;
  if (e.dashNum && /^-[0-9]+$/.test(w)) return true;
  return !!(e.letters && /^-[^-]/.test(w) && [...w.slice(1)].every((c) => e.letters.includes(c)));
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
  }
  return ARGS[e.args](rest, root);
}

/** Why `command` is not one she may allow herself in folder `root`, or null. */
function commandWhy(command, root) {
  if (typeof command !== 'string' || NOT_SIMPLE.test(command)) return WHY.command;
  const words = command.trim().split(/[ \t]+/);
  if (words.some((w) => w.startsWith('@') || w.startsWith('='))) return WHY.atWord;
  const two = words.slice(0, 2).join(' ');
  const key = words.length > 1 && Object.hasOwn(TABLE, two) ? two : Object.hasOwn(TABLE, words[0]) ? words[0] : null;
  if (!key) return WHY.command;
  const e = TABLE[key];
  const rest = words.slice(key.split(' ').length);
  if (e.exact) return rest.length ? WHY.command : null;
  if (e.script) return (rest.length === 1 && rest[0] === 'test') || (rest.length === 2 && rest[0] === 'run' && SCRIPT.test(rest[1])) ? null : WHY.command;
  return wordsWhy(e, rest, root);
}

// ---------- rule 0: the chat's folder ----------

// A home folder by its usual place (a chat on another computer has its own home); a Mac's disk ignores case.
const HOME_AT = /^(\/home\/[^/]+|\/users\/[^/]+)(?=\/|$)/;
// The system's own folders, first part of a path, compared without case: Linux's and the Mac's.
const SYSTEM = new Set(['etc', 'proc', 'sys', 'dev', 'usr', 'bin', 'sbin', 'lib', 'lib64', 'boot', 'tmp', 'run', 'root', 'system', 'library', 'private']);
// Claude Code keeps a worktree of a project at .claude/worktrees/<name>: that is the project's work, not its settings.
const WORKTREE = /\/\.claude\/worktrees\/(?=[^/]+\/)/gi;

/** The whole disk, a system folder, a home folder or a folder that holds one is not a project's folder: they hold the
 * system, the shell's start-up files and every account's settings. Nor is a folder directly in a home whose name
 * starts with a dot or is "bin" or "Library", or anything in those (~/.config/x, ~/bin, ~/Library/LaunchAgents):
 * settings, start-up entries and programs on the PATH. Nor a folder whose own path names secrets (a credentials folder,
 * a folder of keys) or lies in a place that makes a program run later (.git/hooks, .claude/agents); a project named
 * .github and a worktree of Claude Code are a project's. */
function notAProject(root, home) {
  const low = root.toLowerCase();
  if (low === '/' || low === '/home' || low === '/users' || SYSTEM.has(low.split('/')[1])) return true;
  const own = `${root}/`.replace(WORKTREE, '/');
  if (SECRET_FILES.test(own) || own.toLowerCase().split('/').some((part) => part !== '.github' && RUNS_LATER.has(part))) return true;
  const homes = [];
  const m = HOME_AT.exec(low);
  if (m) homes.push(m[1]);
  if (typeof home === 'string' && home.startsWith('/')) homes.push(P.resolve(home).toLowerCase());
  return homes.some((h) => {
    if (h === low || h.startsWith(`${low}/`)) return true;
    if (!low.startsWith(`${h}/`)) return false;
    const top = low.slice(h.length + 1).split('/')[0];
    return top.startsWith('.') || top === 'bin' || top === 'library';
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
