// What Tia may allow by herself when a chat she started asks for an OK: a short allow-list, not a deny-list. A list of
// what is bad is never whole (a redirection glued to a path, a bare `cd`, `git -C..`, `$OLDPWD` …); so she allows
// only work on files inside the chat's folder and the few commands in the table below, in a plain form, and
// everything else is the owner's card with one plain reason. Pure: the call (tool, its input) and the chat's folder in,
// a verdict out. policy.mjs asks it for a chat's OK of a known shape, and runs the deny-list (tia.mjs) after it.
//
//   a. file tools: every path of the call, resolved against the chat's folder by node:path, lies inside that folder;
//      no path names the home folder by "~" or a variable; no path is a file that may hold secrets.
//   b. Bash: one simple command (none of ; & | < > ( ) { } $ ` \ ' " ~, no line break, and no * ? [ ]: the shell
//      would turn those into words nobody judged), its first word in COMMANDS, and that entry's rule passes.
//   c. any other tool (a page fetch, a web search, a skill, a subagent, a tool added later): the owner's.
import os from 'node:os';
import path from 'node:path';
import { ASSISTANT_NAME, SECRET_FILES } from './tia.mjs';

const P = path.posix;

export const WHY = {
  noFolder: 'the chat\'s folder is not known',
  notProject: 'the chat\'s folder is the whole disk or a home folder, not a project\'s folder',
  noPath: 'a call without the path it works on',
  outside: 'a path outside the chat\'s folder',
  home: 'a path that names the home folder or a variable',
  secret: 'a file that may hold secrets (a key, a password, a .env)',
  command: `a command that is not on the short list ${ASSISTANT_NAME} may allow herself`,
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
  Write: (i, root) => pathWhy(i.file_path, root),
  Edit: (i, root) => pathWhy(i.file_path, root),
  MultiEdit: (i, root) => pathWhy(i.file_path, root),
  NotebookEdit: (i, root) => pathWhy(i.notebook_path, root),
  Glob: (i, root) => optionalPath(i.path, root) || globWhy(i.pattern, typeof i.path === 'string' ? P.resolve(root, i.path) : root, root),
  Grep: (i, root) => optionalPath(i.path, root) || filterWhy(i.glob),
};

// ---------- rule b: one command ----------

// Characters that make more than one simple command, redirect, expand or quote: with none of them, the words split on
// blanks are the words the program gets.
const NOT_SIMPLE = /[;&|<>(){}$`\\'"~*?[\]]|[^\x20-\x7e\t]/;
// A word of a test or build command: letters, digits and a few marks, nothing the shell or the tool reads further.
const PLAIN = /^[A-Za-z0-9_.,:=@%+/-]+$/;
// A script's name, never an option (npm run --script-shell python3 test would run another program).
const SCRIPT = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

// A word every piece of which (split at = : ,) is a path inside the folder.
function strictWord(w, root) {
  for (const x of w.split(/[=:,]/)) {
    const why = x && pathWhy(x, root);
    if (why) return why;
  }
  return null;
}
// The part of an option word that may be a path: from its first "/" or "..", or after its first "=". A value glued to a
// short option (-f/etc/x, -zf../x, -O/srv/x) is read by the program as much as one after "=" or in the next word.
function glued(w) {
  const at = [w.indexOf('/'), w.indexOf('..'), w.includes('=') ? w.indexOf('=') + 1 : -1].filter((i) => i >= 0);
  return at.length ? w.slice(Math.min(...at)) : '';
}
// A word that may be a path: every piece with a slash or a ".." must lie inside the folder (of an option, the part
// glued() finds); none names a secret file.
function looseWord(w, root) {
  if (SECRET_FILES.test(w)) return WHY.secret;
  for (const x of (w.startsWith('-') ? glued(w) : w).split(/[=:,]/)) {
    const why = (x.includes('/') || x.includes('..')) && pathWhy(x, root);
    if (why) return why;
  }
  return null;
}
const first = (list, fn) => {
  for (const x of list) {
    const why = fn(x);
    if (why) return why;
  }
  return null;
};
// A long option `name`, or an abbreviation of it (getopt and git accept one): --fil is --file.
const longIs = (w, names) => {
  const n = w.split('=')[0];
  return n.length > 2 && names.some((x) => x === n || x.startsWith(n));
};

/** Any options; every other word (and an option's value, after "=" or glued to it) is a path inside the folder. */
function lookAt(args, root) {
  let ended = false;
  return first(args, (w) => {
    if (!ended && w === '--') {
      ended = true;
      return null;
    }
    if (!ended && w.startsWith('-')) return SECRET_FILES.test(w) ? WHY.secret : strictWord(glued(w), root);
    return strictWord(w, root);
  });
}

const PATTERN_FILES = ['--file', '--exclude-from', '--pre', '--pre-glob', '--ignore-file', '--hostname-bin'];
/** grep, rg: no option that reads patterns from a file or runs a command; a word with a slash or ".." is a path. */
function search(args, root) {
  let ended = false;
  return first(args, (w) => {
    if (!ended && w === '--') {
      ended = true;
      return null;
    }
    if (!ended && w.startsWith('--') && longIs(w, PATTERN_FILES)) return WHY.command;
    if (!ended && /^-[^-]/.test(w) && w.slice(1).includes('f')) return WHY.command; // -f FILE, also in a group (-rnf)
    return looseWord(w, root);
  });
}

const GIT_LOOKS = ['status', 'diff', 'log', 'show', 'ls-files', 'blame', 'rev-parse', 'describe'];
// Another repository or work tree, a config value, another program, an output file; --no-index reads any two files.
const GIT_NEVER = ['--git-dir', '--work-tree', '--exec-path', '--output', '--no-index'];
/** git: only commands that look, and none of the options that point it elsewhere or make it run or write. */
function git(args, root) {
  if (!GIT_LOOKS.includes(args[0])) return WHY.command;
  let ended = false;
  return first(args.slice(1), (w) => {
    if (!ended && w === '--') {
      ended = true;
      return null;
    }
    if (!ended && w.startsWith('--') && longIs(w, GIT_NEVER)) return WHY.command;
    if (!ended && /^-[^-]/.test(w) && /[Cco]/.test(w.slice(1))) return WHY.command; // -C, -c, -o, also in a group
    return looseWord(w, root);
  });
}

/** Plain words only; options only where `options` says (else only after "--"), none that `never` names. */
function plainWords(args, root, { options = true, never = () => false } = {}) {
  let ended = false;
  return first(args, (w) => {
    if (!PLAIN.test(w)) return WHY.command;
    if (!ended && w === '--') {
      ended = true;
      return null;
    }
    if (!ended && w.startsWith('-') && (!options || never(w))) return WHY.command;
    return looseWord(w, root);
  });
}

/** npm, pnpm, yarn: `test` or `run <name>`, then plain words (an option only after "--": before it, npm reads it). */
function script(args, root) {
  if (args[0] === 'test') return plainWords(args.slice(1), root, { options: false });
  if (args[0] === 'run' && SCRIPT.test(args[1] || '')) return plainWords(args.slice(2), root, { options: false });
  return WHY.command;
}

/** node --test, then only paths inside the folder. */
function nodeTest(args, root) {
  if (args[0] !== '--test') return WHY.command;
  return first(args.slice(1), (w) => (w.startsWith('-') ? WHY.command : strictWord(w, root)));
}

const sub = (names, never) => (args, root) => (names.includes(args[0]) ? plainWords(args.slice(1), root, { never }) : WHY.command);

/**
 * The commands she may allow herself, each with its rule (args: the words after the first; root: the folder). Keep it
 * this short: a command earns a place by only looking at the folder or only testing and building what is in it.
 */
export const COMMANDS = {
  ls: lookAt, // any options; every other word a path inside the folder
  pwd: lookAt,
  cat: lookAt,
  head: lookAt,
  tail: lookAt,
  wc: lookAt,
  file: lookAt,
  stat: lookAt,
  du: lookAt,
  tree: lookAt,
  grep: search, // no -f, --file, --pre … ; a word with a slash or ".." a path inside the folder
  rg: search,
  git, // status, diff, log, show, ls-files, blame, rev-parse, describe; never -C, -c, -o, --git-dir, --work-tree …
  npm: script, // test, or run <name>; then plain words
  pnpm: script,
  yarn: script,
  node: nodeTest, // --test with paths inside the folder
  pytest: (args, root) => plainWords(args, root), // plain words and paths inside the folder
  // -exec, -toolexec and -vettool run another program
  go: sub(['test', 'build', 'vet'], (w) => /^--?(exec|toolexec|vettool)(=|$)/.test(w)),
  cargo: sub(['test', 'build', 'check'], (w) => /^--config(=|$)/.test(w) || /^-Z/.test(w)), // config can name a program
};

/** Why `command` is not one she may allow herself in folder `root`, or null. */
function commandWhy(command, root) {
  if (typeof command !== 'string' || NOT_SIMPLE.test(command)) return WHY.command;
  const words = command.trim().split(/[ \t]+/);
  if (!words[0] || !Object.hasOwn(COMMANDS, words[0])) return WHY.command;
  return COMMANDS[words[0]](words.slice(1), root);
}

// The usual home folders and the folders that hold them (a chat on another computer has its own home).
const HOMES = /^\/(home|Users)(\/[^/]+)?$|^\/root$/;
/** The whole disk, a home folder or a folder that holds one is not a project's folder: it holds the shell's start-up
 * files and every account's settings. */
const notAProject = (root, home) =>
  root === '/' || HOMES.test(root) || (typeof home === 'string' && home.startsWith('/') && (P.resolve(home) === root || P.resolve(home).startsWith(`${root}/`)));

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
