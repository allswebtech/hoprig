// What Tia may allow by herself when a chat she started asks for an OK: a short allow-list, not a deny-list. A list of
// what is bad is never whole (a redirection glued to a path, a bare `cd`, `git -C..`, `npm test -- --import=…`, a file
// written today that a program runs tomorrow …); so she allows only LOOKING inside the chat's folder and RUNNING THE
// PROJECT'S OWN CHECKS, and everything else is the owner's card with one plain reason. Changing a file is never hers.
// Pure (it touches no disk): the call (tool, its input), the chat's folder and the home folder in, a verdict out.
// policy.mjs asks it for her answer "allow" to a chat's OK of a known shape, and runs the deny-list (tia.mjs) after it.
//
//   w. Write, Edit, MultiEdit, NotebookEdit: always the owner's.
//   0. the chat's folder is a project's: not the whole disk, a system folder, a home folder (as written or by its real
//      path) or a settings folder, bin or Library in it, nor a folder whose own path names secrets or holds a character
//      outside plain ASCII.
//   a. Read, Glob, Grep: every path of the call, resolved against the chat's folder by node:path, lies inside that folder
//      and is plain ASCII; no path names the home folder by "~" or a variable; below the folder, no path is a file that
//      may hold secrets. Grep also names which files it searches (a glob that is more than wildcards, or a type): a
//      search through every file of a folder reads its secrets too, as grep -r and rg would.
//   b. Bash: one simple command of plain ASCII (none of ; & | < > ( ) { } $ ` \ ' " ~, no line break, and no * ? [ ] ^ #:
//      the shell would turn those into words nobody judged; ^ and # are patterns to a shell with extended patterns), no
//      word that starts with "@" or "=" (some programs read such a word as a file of options; a shell expands it), its
//      first word or two a key of TABLE, every word that starts with "-" an option TABLE names for it, and every other
//      word judged as its entry says.
//   c. any other tool (a page fetch, a web search, a skill, a subagent, a tool added later): the owner's.
//
// Its limits, said plainly:
// - The secret rule goes by a file's name (SECRET_FILES in tia.mjs): it is not a wall around secrets. Inside the chat's
//   folder the coding tool's own Read reads without asking in its default mode, and a key can sit in a file of any
//   name. The list only keeps HER from saying yes to the obvious ones. The forms that read every file of a folder at
//   once (grep -r, rg, a patch of git diff, git show or git log -p, git grep, the Grep tool without a file filter) are
//   not hers for that reason. A filter such as "*.json" still reaches a secret of that kind under another name.
// - git show --stat with an object's id prints a file whole when the id is a file's (a blob's): only a name is judged,
//   so a committed secret named by its object id is not seen.
// - Paths are judged as text, so a link in the folder that points outside it is not seen.
// - npm, git and the coding tool's own search look upward and around inside the repository: in a chat whose folder is a
//   subfolder of one, they can read what the repository holds above it.
// - In a partial clone, git's reading commands fetch what is missing from the repository's remote.
// - A test run runs the project's own code as it is on the disk: code the owner allowed to be written, or that was there.
//   A script runner may first fetch the package manager version the project names. A build writes its own output and a
//   linter may write a cache: what a check always writes.
import os from 'node:os';
import path from 'node:path';
import { ASSISTANT_NAME, SECRET_FILES } from './tia.mjs';

const P = path.posix;

// ---------- the table: the commands she may allow herself, and every option each may carry ----------
// Key: the first word, or the first two. letters: one-letter options that may be combined (-la); flags: options taken
// exactly as written; num / word: options whose value is the next word, a number / a plain word (once each); dashNum:
// -<number> (-20); needs: one of these options must be there; args: how the words that are not options are judged (ARGS
// below); script: a script runner (SCRIPTS below); exact: the key and nothing after it. Any other option, "--" itself and an option glued to a value are a card. Keep it this short: a command earns
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
  // grep only on the files it names (no -r, -R: a search of a whole folder reads every file in it, secrets too); rg
  // searches a whole folder by itself, so it is not here.
  grep: { letters: 'nilcwvEFHhos', word: ['-e'], num: ['-A', '-B', '-C'], args: 'loose' },
  'git status': { flags: ['-s', '--short', '-b', '--branch'], args: 'loose' },
  // A patch shows every changed file's lines at once: git diff and git show only with the names or the counts of what
  // changed (one of `needs`), git log never with -p.
  'git diff': { flags: ['--stat', '--name-only', '--name-status', '--cached', '--staged'], needs: ['--stat', '--name-only', '--name-status'], args: 'loose' },
  'git show': { flags: ['--stat', '--name-only', '--name-status'], needs: ['--stat', '--name-only', '--name-status'], args: 'loose' },
  'git log': { flags: ['--oneline', '--stat', '--name-only', '--graph', '--all'], num: ['-n'], dashNum: true, args: 'loose' },
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
// A script runner takes "test", or "run" and one of these names exactly, and nothing after it: whatever follows (an
// option, "--" and what the script passes on) is read by npm or by the program the script starts. A fixed short list:
// any other name is a card, also test:<anything else> (test:update, test:fix rewrite snapshots or source files), lint:fix
// and format.
const TEST_KINDS = ['unit', 'e2e', 'integration', 'ci', 'all', 'types', 'lint', 'smoke', 'coverage'];
export const SCRIPTS = new Set(['test', 'tests', 'lint', 'build', 'typecheck', 'check', ...TEST_KINDS.flatMap((k) => [`test:${k}`, `tests:${k}`])]);

export const WHY = {
  noFolder: 'the chat\'s folder is not known',
  notProject: 'the chat\'s folder is not a project\'s folder (the whole disk, a system folder, a home folder, a settings folder, one that holds secrets, or one whose path is not plain ASCII)',
  noPath: 'a call without the path it works on',
  outside: 'a path outside the chat\'s folder',
  home: 'a path that names the home folder or a variable',
  notAscii: 'a path with a character outside plain ASCII (a disk that ignores case may read it as another name)',
  secret: 'a file that may hold secrets (a key, a password, a .env)',
  wholeFolder: 'a search through every file of a folder, secrets too (a search that names its kind of file, such as *.js, she may allow)',
  write: 'changing a file is yours to allow; with the permission mode that accepts edits the coding tool does not ask at all',
  command: `a command that is not on the short list ${ASSISTANT_NAME} may allow herself`,
  option: `an option that is not on the short list ${ASSISTANT_NAME} may allow herself`,
  atWord: 'a word that starts with "@" or "=": a file some programs read their options from, or a word the shell expands',
  tool: `a tool ${ASSISTANT_NAME} does not allow herself (only looking inside the folder and a short list of commands)`,
};

// ---------- rule a: one path ----------

/** The part of `abs` (inside `root`) below the folder, as parts. */
const below = (abs, root) => (abs === root ? [] : abs.slice(root.length + 1).split('/'));

/** Why `raw` is not a path she may look at by herself in folder `root` (absolute, normalised), or null. The secret rule
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
/** A glob's alternatives ("*.{ts,tsx}" → "*.ts", "*.tsx"), at most a few dozen. */
function alternatives(g, n = 0) {
  const m = /\{([^{}]*)\}/.exec(g);
  if (!m || n > 5) return [g];
  return m[1].split(',').slice(0, 12).flatMap((x) => alternatives(g.slice(0, m.index) + x + g.slice(m.index + m[0].length), n + 1));
}
// Which files the Grep tool searches: without a glob or a type, every file of its folder; a glob whose last part is only
// wildcards ("*", "**/*", "*.*", "[a-z]*") is the same, and so is one that leaves files out ("!*.js": all the others). A type is one of ripgrep's names of file kinds ("js", "py").
function narrowWhy(i) {
  if (i.glob === undefined && i.type === undefined) return WHY.wholeFolder;
  if (i.type !== undefined && (typeof i.type !== 'string' || !/^[A-Za-z0-9_+-]{1,20}$/.test(i.type) || i.type.toLowerCase() === 'all')) return WHY.wholeFolder;
  if (i.type !== undefined && SECRET_FILES.test(`x.${i.type}`)) return WHY.secret;
  if (i.glob === undefined) return null;
  if (String(i.glob).trimStart().startsWith('!')) return WHY.wholeFolder;
  for (const alt of alternatives(i.glob)) {
    const last = alt.split('/').pop().replace(/\[[^\]]*\]/g, '*');
    if (!/[A-Za-z0-9]/.test(last)) return WHY.wholeFolder;
    if (SECRET_FILES.test(alt)) return WHY.secret;
  }
  return null;
}

/** The coding tool's tools that change a file: never hers, wherever the file is (what is written may be run later by
 * something nobody listed: a hook, a CI file, a package manager's settings, a shell's start-up file). */
export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** The coding tool's tools that only look, and the paths of each call (input: the strings of the call). */
export const FILE_TOOLS = {
  Read: (i, root) => pathWhy(i.file_path, root),
  Glob: (i, root) => optionalPath(i.path, root) || globWhy(i.pattern, typeof i.path === 'string' ? P.resolve(root, i.path) : root, root),
  Grep: (i, root) => optionalPath(i.path, root) || filterWhy(i.glob) || narrowWhy(i),
};

// ---------- rule b: one command ----------

// Characters that make more than one simple command, redirect, expand or quote (^ and # are patterns to a shell with
// extended patterns), and any that is not plain ASCII: with none of them, the words split on blanks are the words the
// program gets.
const NOT_SIMPLE = /[;&|<>(){}$`\\'"~*?[\]^#]|[^\x20-\x7e\t]/;
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
  if (e.script) return (rest.length === 1 && rest[0] === 'test') || (rest.length === 2 && rest[0] === 'run' && SCRIPTS.has(rest[1])) ? null : WHY.command;
  if (e.needs && !rest.some((w) => e.needs.includes(w))) return WHY.option;
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
 * settings, start-up entries and programs on the PATH. A home counts as written and by its real path (the chat's folder
 * is a real path; a home reached through a link is the same place). Nor a folder whose own path names secrets (a
 * credentials folder, a folder of keys; a worktree of Claude Code is a project's), or holds a character outside plain
 * ASCII (a disk that ignores case may read it as another name). */
function notAProject(root, homes) {
  const low = root.toLowerCase();
  if (low === '/' || low === '/home' || low === '/users' || SYSTEM.has(low.split('/')[1])) return true;
  if (/[^\x20-\x7e]/.test(root) || SECRET_FILES.test(`${root}/`.replace(WORKTREE, '/'))) return true;
  const all = [];
  const m = HOME_AT.exec(low);
  if (m) all.push(m[1]);
  for (const h of homes) if (typeof h === 'string' && h.startsWith('/')) all.push(P.resolve(h).toLowerCase());
  return all.some((h) => {
    if (h === low || h.startsWith(`${low}/`)) return true;
    if (!low.startsWith(`${h}/`)) return false;
    const top = low.slice(h.length + 1).split('/')[0];
    return top.startsWith('.') || top === 'bin' || top === 'library';
  });
}

/**
 * May Tia allow this call by herself? tool: the coding tool's name of it; input: the strings of the call (the command,
 * the paths; src/chat/engines/claude-parse.mjs askSubject); cwd: the chat's folder; home: this computer's home folder,
 * or a list of it as written and by its real path (the caller looks that up: this module touches no disk).
 * → { ok: true } | { ok: false, why }
 */
export function allowsHerself(tool, input, cwd, home = os.homedir()) {
  if (WRITE_TOOLS.has(tool)) return { ok: false, why: WHY.write };
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return { ok: false, why: WHY.noFolder };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, why: WHY.tool };
  const root = P.resolve(cwd);
  if (notAProject(root, [].concat(home))) return { ok: false, why: WHY.notProject };
  let why;
  if (tool === 'Bash') why = commandWhy(input.command, root);
  else if (typeof tool === 'string' && Object.hasOwn(FILE_TOOLS, tool)) why = FILE_TOOLS[tool](input, root);
  else why = WHY.tool;
  return why ? { ok: false, why } : { ok: true };
}
