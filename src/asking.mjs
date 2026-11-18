// What a coding tool asks the owner, and what Hoprig answers by itself in the mode that asks nothing ("bypass"). One
// rule for a terminal session and a chat with Claude Code (both through the hook, hook.mjs; chat/asks.mjs says how a
// chat gets it), so the mode means the same in both, as far as each can tell (each caller says what its channel
// tells and what it cannot).
// Only node: imports: the hook loads this for every event, and Claude Code waits for the hook.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitFolder, newBudget, plainOnDisk } from './plaindisk.mjs';

/**
 * What kind of ask a tool call is: 'question' (the tool puts a question to the owner), 'plan' (a plan to approve)
 * or 'permission' (may I do this?). Only a permission has "allow" for an answer.
 */
export const askType = (tool) => (tool === 'AskUserQuestion' ? 'question' : tool === 'ExitPlanMode' ? 'plan' : 'permission');

export const BYPASS = 'bypassPermissions';

// The one tool whose permission bypass mode may answer: Bash, the shell tool of Claude Code's tools reference
// (code.claude.com/docs/en/tools-reference, Claude Code 2.1.326), and only for a plain delete (plainDelete). Any other
// tool (a file tool, PowerShell, a web fetch, a subagent, an MCP server's tool, a tool this does not know yet, the
// question tool, the plan) is not answered: Claude Code asks the owner as it would.
export const SHELL_TOOL = 'Bash';

/** Does one entry of a `permissions.ask` list ("Bash", "Bash(npm *)") name `tool`? */
export function ruleNames(rule, tool) {
  return typeof rule === 'string' && rule.split('(')[0].trim() === tool;
}

/**
 * The `permissions.ask` entries of the settings files Claude Code reads for a session, read now (an edit takes effect
 * at the next ask, as in Claude Code). `project`: its primary working folder; `configDir`: Claude Code's own folder
 * ($CLAUDE_CONFIG_DIR, else ~/.claude); `extra`: the settings file Hoprig hands to the session; `managed`: the folder of
 * an organisation's settings file (the system's own by default). A file that exists but
 * cannot be read as settings gives ['*'] (an ask for everything): what it says cannot be known.
 * Not read: settings an organisation delivers by its management system or from the console (no file on this
 * computer says them).
 */
export function askRules({ project = null, configDir = null, extra = null, managed = managedDir(process.platform) } = {}) {
  const files = [path.join(configDir || path.join(os.homedir(), '.claude'), 'settings.json')];
  if (project) {
    files.push(path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json'));
    // The local file of a git repository is kept at its root (the main checkout's for a worktree).
    const root = repoRoot(project);
    if (root && root !== project) files.push(path.join(root, '.claude', 'settings.local.json'));
  }
  if (managed) {
    files.push(path.join(managed, 'managed-settings.json'));
    try {
      for (const f of fs.readdirSync(path.join(managed, 'managed-settings.d')).sort()) {
        if (f.endsWith('.json') && !f.startsWith('.')) files.push(path.join(managed, 'managed-settings.d', f));
      }
    } catch {
      /* no drop-in folder */
    }
  }
  if (extra) files.push(extra);
  const out = [];
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue;
      out.push('*');
      continue;
    }
    try {
      const ask = JSON.parse(text)?.permissions?.ask;
      if (Array.isArray(ask)) out.push(...ask.filter((r) => typeof r === 'string'));
    } catch {
      out.push('*');
    }
  }
  return out;
}

// Where an organisation puts its settings file (Claude Code's managed settings reference).
function managedDir(platform) {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode';
  return '/etc/claude-code';
}

// The root of the git repository `dir` is in (the main checkout's for a worktree), or null. Read from the files, not
// by running git: this runs for every ask.
function repoRoot(dir) {
  for (let d = path.resolve(dir), i = 0; i < 64; i++) {
    const git = path.join(d, '.git');
    let st = null;
    try {
      st = fs.statSync(git);
    } catch {
      /* not here */
    }
    if (st && st.isDirectory()) return d;
    if (st && st.isFile()) {
      // A worktree: "gitdir: <main>/.git/worktrees/<name>".
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(git, 'utf8'));
      const gd = m && path.resolve(d, m[1].trim());
      const main = gd && /[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.test(gd) ? path.dirname(path.dirname(path.dirname(gd))) : null;
      return main || d;
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/**
 * Is shell command `command` plainly a delete inside the folder it runs in? This is an allow-list of one thing, an
 * ordinary delete inside that folder, read by a small strict reader that says no to anything it does not know. It does
 * not judge danger: a no only means that Claude Code asks as it would. Yes only when all of this holds:
 *   - the line has at most 2,000 characters, made only of letters (any script), digits, space, tab, . _ - / * ? @ + ,
 *     = : % and the two quote signs; besides those only `&&` and `;` between commands, and at the end of a command
 *     `2>/dev/null` or `>/dev/null 2>&1`, then `|| true`. Any other character ($ ` \ ~ ( ) { } [ ] < > | & ; ! #, a
 *     newline) anywhere means no;
 *   - every command is `rm` (exactly that word, not quoted, not a path to it) with options from a fixed list (-r -R -f
 *     -v -d and their combinations, --recursive --force --verbose --dir, --) and one target or more;
 *   - every target, its quotes taken off (a quoted part holds only the characters above and spaces): a relative path
 *     whose first part is a plain name (not . or .., no glob), after at most one leading ./, with no . or .. part
 *     anywhere, no part named .git (a repository's own history), and a glob (* ?) only after that first part, never in
 *     a part that begins with a dot (.* can match ..);
 *     or an absolute path strictly inside the folder it runs in, whose rest after that folder reads the same way;
 *   - the folder it runs in (`cwd`) is known, written plainly (/a/b), and is not the root, a folder directly under it,
 *     a home folder, the workspace folder, a folder that holds projects (`projects`: projectFolders), or a folder that
 *     holds one of those (by text, and by the real place of each where a link leads to it). From the projects folder
 *     `rm -rf shop/*` empties a whole project. Nor is it inside a .git folder (a part named .git, by text or real
 *     place) or in a git folder, or below one (plaindisk.mjs gitFolder: a bare repository, a worktree's own too).
 *   - on disk (plaindisk.mjs plainOnDisk, read only when the rule is asked): each target expanded as the shell does,
 *     no path rm gets goes through a symbolic link, out of the folder by its real place, onto another file system or
 *     across a mount, none lies inside a git folder, and none is, or holds anywhere below it as far as the look's
 *     budget reaches, a repository (a folder of projects that is on no list: `rm -rf code/*\/*` from a project's
 *     parent). Names that are not valid UTF-8, and ? against a name with a byte over 127, cannot be told: no. A look
 *     over its budget (entries, folders, 250 ms for the line) says no;
 *   - no target begins with = (zsh's path of a program) or holds ** (any depth).
 * `relative: false` where the channel does not say which folder the shell is in at the moment (a chat whose Claude Code
 * is too old for the hook, chat/asks.mjs): `cwd` is then
 * the session's own folder, and only absolute targets inside it count. A path is read by its text: a link inside the
 * folder is followed by the shell and by rm as usual. Only Bash's language is read (PowerShell's differs: a comma
 * makes a list, @x reads a variable, C: names a drive), and only folders written as /a/b (not C:\a\b).
 */
export function plainDelete(command, { cwd = null, home = null, workspace = null, projects = [], relative = true } = {}) {
  if (typeof command !== 'string' || command.length > PLAIN_MAX || !plainFolder(cwd, home, [workspace, ...(Array.isArray(projects) ? projects : [])])) return false;
  const list = commands(tokens(command));
  const targets = [];
  if (!list || !list.every((cmd) => plainRm(cmd, cwd, relative, targets))) return false;
  const budget = newBudget();
  return targets.every((rest) => plainOnDisk(cwd, rest, budget));
}

const PLAIN_MAX = 2000;
const PLAIN = /^[\p{L}\p{Nd}._\-/*?@+,=:%]$/u; // one character of a word
const BOUND = String.raw`(?=[ \t]|;|&&|$)`;
// What may end a command: its output thrown away, then its failure taken as success.
const ENDS = [
  [new RegExp(String.raw`2>/dev/null${BOUND}`, 'y'), 'quiet'],
  [new RegExp(String.raw`>/dev/null[ \t]+2>&1${BOUND}`, 'y'), 'quiet'],
  [new RegExp(String.raw`\|\|[ \t]+true${BOUND}`, 'y'), 'true'],
];
const OPTION = /^(?:-[rRfvd]+|--recursive|--force|--verbose|--dir)$/;

// The line as words ({ word: quotes taken off, raw: as written }), separators ({ op }) and endings ({ end }), or null
// for anything the reader does not know.
function tokens(line) {
  const out = [];
  let word = null;
  let raw = '';
  const flush = () => {
    if (word !== null) out.push({ word, raw });
    word = null;
    raw = '';
  };
  for (let i = 0; i < line.length; ) {
    const c = String.fromCodePoint(line.codePointAt(i));
    if (c === ' ' || c === '\t' || c === ';' || line.startsWith('&&', i)) {
      flush();
      if (c === ';' || c === '&') out.push({ op: c === ';' ? ';' : '&&' });
      i += c === '&' ? 2 : 1;
      continue;
    }
    if (word === null) {
      const end = ENDS.find(([re]) => {
        re.lastIndex = i;
        return re.test(line);
      });
      if (end) {
        out.push({ end: end[1] });
        i = end[0].lastIndex;
        continue;
      }
    }
    if (c === '"' || c === "'") {
      const close = line.indexOf(c, i + 1);
      const inner = close < 0 ? null : line.slice(i + 1, close);
      if (inner === null || ![...inner].every((x) => x === ' ' || PLAIN.test(x))) return null;
      word = (word ?? '') + inner;
      raw += line.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (!PLAIN.test(c)) return null;
    word = (word ?? '') + c;
    raw += c;
    i += c.length;
  }
  flush();
  return out;
}

// The commands between the separators, each a non-empty list of words and endings; null when one is empty.
function commands(toks) {
  if (!toks) return null;
  const list = [[]];
  for (const t of toks) {
    if (!t.op) list.at(-1).push(t);
    else if (list.at(-1).length) list.push([]);
    else return null;
  }
  return list.every((c) => c.length) ? list : null;
}

// One command: rm, its options, its targets, then the endings in their order (each at most once).
function plainRm(cmd, cwd, relative, targets) {
  if (cmd[0].raw !== 'rm') return false;
  let options = true;
  let n = 0;
  let ends = '';
  for (const t of cmd.slice(1)) {
    if (t.end) {
      if (ends.includes(t.end) || ends.endsWith('true')) return false;
      ends += t.end;
    } else if (ends) return false;
    else if (options && t.word === '--') options = false;
    else if (options && t.word.startsWith('-')) {
      if (!OPTION.test(t.word)) return false;
    } else {
      const rest = inside(t.word, cwd, relative);
      if (rest === null) return false;
      targets.push(rest);
      n++;
    }
  }
  return n > 0;
}

// One target: a path that stays strictly inside `cwd` by its text (see plainDelete). → its part after `cwd`, or null.
function inside(target, cwd, relative) {
  let rest;
  if (target.startsWith('/')) {
    if (/[*?]/.test(cwd) || !target.startsWith(`${cwd}/`)) return null;
    rest = target.slice(cwd.length + 1);
  } else if (relative) rest = target.startsWith('./') ? target.slice(2) : target;
  else return null;
  // A word that begins with = is a program's path in zsh (=node), and ** reads any depth (zsh, bash with globstar). The
  // signs other glob options and other shells give a meaning (extglob, zsh's extended globs, history, brace and tilde)
  // are refused by their text too: ^ # ! ~ [ ] { } ( ), and @ or + right before a (. (The alphabet of the reader above
  // already lets none of them through; this says the rule where the target is read.)
  if (target.startsWith('=') || target.includes('**') || /[\^#!~[\]{}()]/.test(target) || target.includes('@(') || target.includes('+(')) return null;
  const parts = rest.split('/');
  if (parts.length > 1 && parts.at(-1) === '') parts.pop(); // one slash at the end
  const [first, ...more] = parts;
  if (!first || first === '.' || first === '..' || /[*?]/.test(first)) return null;
  if (parts.some((p) => p.toLowerCase() === '.git')) return null; // a repository's own history is no ordinary delete
  return more.every((p) => p && p !== '.' && p !== '..' && !(p.startsWith('.') && /[*?]/.test(p))) ? rest : null;
}

// The folder a command runs in may hold plain deletes: known, written plainly, and none of the folders above
// (`others`: the workspace and the folders that hold projects).
function plainFolder(cwd, home, others) {
  if (typeof cwd !== 'string' || typeof home !== 'string' || !home) return false;
  if (!cwd.startsWith('/') || cwd.endsWith('/') || path.posix.normalize(cwd) !== cwd || cwd.split('/').length < 3) return false;
  const low = (p) => p.toLowerCase(); // a folder whose name differs only in case may be the same one (macOS, Windows)
  const here = [cwd, real(cwd)].filter(Boolean).map(low);
  const kept = [home, ...others].flatMap((p) => [p, real(p)]).filter((p) => typeof p === 'string' && p.startsWith('/')).map((p) => low(path.posix.normalize(p).replace(/(.)\/+$/, '$1')));
  const homes = [home, real(home)].filter((p) => typeof p === 'string' && p.startsWith('/')).map((p) => low(path.posix.dirname(path.posix.normalize(p))));
  // A repository's own history: from inside it (`cd .git`, then `rm -rf objects/*/*`) a target's text names no .git.
  if (here.some((h) => h.split('/').includes('.git')) || insideGitFolder(cwd)) return false;
  return here.every((h) => h.split('/').length >= 3 && !kept.some((k) => k === h || k.startsWith(`${h}/`)) && !homes.includes(path.posix.dirname(h)));
}

// Is `dir`, or a folder above it up to the root (by its real place), a git folder: a bare repository (mirror.git)
// has no part named .git, and from its objects or refs folder a target's text names none either.
function insideGitFolder(dir) {
  for (let d = real(dir) || dir, i = 0; i < 256; i++) {
    if (gitFolder(d)) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
  return true;
}

const MAP_MAX = 1024 * 1024; // the workspace map as read on an ask (projectFolders)

// The workspace map's text, read on an ask in the dashboard's process too: opened without following a link and without
// waiting (a FIFO put in its place must not block), then the OPEN file checked (a plain file of at most MAP_MAX) and
// read from that descriptor, so nothing swapped in between the check and the read is read.
function readMap(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAP_MAX) throw new Error('not a map');
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = fs.readSync(fd, buf, got, st.size - got, got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The folders that hold projects, as far as they can be known without the rest of Hoprig: the projects folder chosen in
 * Hoprig's settings (`chosen`, its projectsDir), the default one (<workspace>/projects) and the earlier default
 * (~/projects), and the projects folder the workspace's map names (<workspace>/ai_brain/workspace.json, its
 * config.projectsDir: a folder inside the workspace). Read when asked, for an ask in bypass mode only.
 */
export function projectFolders({ workspace = null, home = null, chosen = null } = {}) {
  const out = [];
  if (typeof chosen === 'string' && path.isAbsolute(chosen)) out.push(chosen);
  if (typeof workspace === 'string' && path.isAbsolute(workspace)) {
    out.push(path.join(workspace, 'projects'));
    try {
      const d = JSON.parse(readMap(path.join(workspace, 'ai_brain', 'workspace.json')))?.config?.projectsDir;
      if (typeof d === 'string' && d && !path.isAbsolute(d)) out.push(path.join(workspace, d));
    } catch {
      /* no map, or one that cannot be read: the folders above */
    }
  }
  if (typeof home === 'string' && path.isAbsolute(home)) out.push(path.join(home, 'projects'));
  return [...new Set(out.map((p) => path.normalize(p)))];
}

const real = (p) => {
  try {
    return typeof p === 'string' && p ? fs.realpathSync(p) : null;
  } catch {
    return null;
  }
};

/**
 * Does Hoprig answer this ask with "allow" by itself? All of these must hold:
 *   mode     the coding tool itself reports bypass mode
 *   tool     the shell tool, Bash (SHELL_TOOL). Not the file tools: Claude Code does not ask for them in this mode by
 *            itself, so a question for one comes from a rule of the owner or his organisation, and is his to answer.
 *            Never a question, a plan or any other tool
 *   why      the channel names no reason that makes the ask the owner's (a chat's channel does: claude-lines.mjs
 *            ownerOnly; a terminal's hook event carries none)
 *   rules    no "ask" rule of the owner's settings names the tool (askRules; the pattern in it is not matched against
 *            the call: an ask rule for a tool means the owner is asked for that tool)
 *   input    its command is plainly a delete inside the folder it runs in (plainDelete)
 * `places`: { cwd, home, workspace, projects, relative } for plainDelete.
 */
export function bypassAllows({ mode, tool, input = null, why = null, rules = [], places = {} }) {
  if (mode !== BYPASS || why || tool !== SHELL_TOOL) return false;
  if (rules.some((r) => r === '*' || ruleNames(r, tool))) return false;
  return !!input && typeof input.command === 'string' && plainDelete(input.command, places);
}

// ---------- a delete written in plain sight (an OpenCode chat in bypass mode: chat/asks.mjs openCodeAllows) ----------

const LINE_MAX = 4000;
const CASE_BLIND = process.platform === 'darwin' || process.platform === 'win32';
const DELETER_NAMES = new Set(['rm', 'shred', 'unlink', 'truncate', 'gnurm', 'gnushred', 'gnuunlink', 'gnutruncate']);
// Programs with a subcommand named like a deleter (git rm, npm rm, docker image rm): the word after them is no deleter,
// where they begin their command or stand directly after a program that passes a command on (sudo git rm); docker's
// object words only directly after docker, podman or nerdctl. Never after an option or another word (sudo -u git rm).
const HAS_RM_SUBCOMMAND = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'cargo', 'docker', 'podman', 'nerdctl']);
const CONTAINER_TOOLS = new Set(['docker', 'podman', 'nerdctl']);
const CONTAINER_OBJECTS = new Set(['container', 'image', 'volume', 'network', 'compose', 'context', 'builder', 'buildx', 'secret', 'config', 'service', 'stack', 'node', 'plugin', 'manifest', 'system']);
const PASSES_ON = new Set(['sudo', 'doas', 'env', 'time', 'nice', 'nohup', 'timeout', 'command', 'exec', 'xargs', 'ionice', 'stdbuf', 'setsid', 'busybox', 'npx', 'eatmydata', 'fakeroot']);
// Rule 2's lists (mayDelete): where a deleter's name in quoted text counts.
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'csh', 'tcsh']);
// (c) programs that take a command or a text to run.
const TAKES_COMMAND = new Set(['eval', 'ssh', 'su', 'runuser', 'sg', 'sudo', 'doas', 'env', 'xargs', 'watch', 'parallel', 'script', 'timeout', 'nice', 'ionice', 'nohup', 'time', 'stdbuf', 'setsid', 'flock', 'exec', 'command', 'trap', 'tmux', 'screen', 'concurrently', 'at', 'batch']);
// (d) languages, and the ways they start a program.
const LANGUAGES = new Set(['python', 'python2', 'python3', 'perl', 'ruby', 'node', 'nodejs', 'deno', 'bun', 'php', 'lua', 'awk', 'gawk', 'mawk']);
const STARTS_PROGRAM = ['system', 'exec', 'popen', 'spawn', 'subprocess', 'shell', 'passthru', '%x', '`'];
// What only passes a command on, at the head of a command (with its options, numbers and assignments after it).
const HEAD_PASSERS = new Set(['sudo', 'doas', 'env', 'time', 'nice', 'nohup', 'timeout', 'command', 'exec', 'builtin', 'xargs', 'ionice', 'stdbuf', 'setsid', 'eatmydata', 'fakeroot', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'coproc', '{']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

const isNumber = (w) => w.length > 0 && [...w].every((c) => c >= '0' && c <= '9');
const isAssignment = (w) => {
  const eq = w.indexOf('=');
  return eq > 0 && [...w.slice(0, eq)].every((c, k) => c === '_' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (k > 0 && c >= '0' && c <= '9'));
};
const isBlank = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f';
// Signs that end a word (and a command, for the word before a deleter's name).
const isSeparator = (c) => isBlank(c) || c === ';' || c === '|' || c === '&' || c === '(' || c === ')' || c === '<' || c === '>' || c === '{' || c === '}';
const ENDS_COMMAND = new Set([';', '|', '&', '(', ')', '{', '}', '\n']);
// What makes a word: letters (any script), digits and _ - . / + : @ % = , . Anything else ends it.
const isWordChar = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c > '\x7f' || '_-./+:@%=,'.includes(c);
const baseName = (w) => {
  const b = w.slice(w.lastIndexOf('/') + 1);
  return CASE_BLIND ? b.toLowerCase() : b;
};
const splitWords = (text) => {
  const out = [];
  let w = '';
  for (const c of text) {
    if (isSeparator(c) || !isWordChar(c)) {
      if (w) out.push(w);
      w = '';
    } else w += c;
  }
  if (w) out.push(w);
  return out;
};

/**
 * May shell line `line` delete something, as a coding agent writes it in plain sight? The aim, said honestly: HOPRIG
 * STOPS THE DELETES A CODING AGENT WRITES IN PLAIN SIGHT; it is not a wall against a line written to get around it (a
 * script or a program may delete without a question anyway). So this is the simplest thing that cannot hang: one pass
 * over the line whose index only moves forward, no regular expression, a line over 4,000 characters is true.
 *
 * It keeps the quote state as bash does in plain cases (single quotes: nothing special inside; double quotes: a
 * backslash before " \ $ and a backtick, and $( … ) or a backtick inside them is a command of its own; $'…' and $"…"
 * as quoted; outside quotes a backslash takes the next character and a backslash-newline is nothing). It keeps the
 * words written outside quotes and every quoted text, each with the number of the COMMAND it stands in (a command ends
 * at ; | & && || a newline ( ) { }). A word ends at white space, at ; | & ( ) < > { } and at a quote's edge where the
 * neighbour is one of those (r''m is one word "rm" outside quotes; 'rm x' is quoted text; one word quoted whole where a
 * command starts is that command's word). A here-document's body (after << or <<- and its delimiter, up to the line
 * that is exactly the delimiter, or the end) is quoted text of the command it stands in, with no quote state kept in
 * it, except that where the delimiter is not quoted a $( … ) or a backtick in it is a command; <<< is none, and there
 * is none inside an arithmetic (( … )). A # outside quotes starts a comment where bash begins one: at the start of the
 * line or after a space, a tab, a newline or one of ; | & ( ) < > (not a ) that closes a $( ) or $(( )) in a word;
 * $#, ${#x} and *#* are no comment). A quote that never closes: true. A deleter's name is the base name rm, shred,
 * unlink, truncate, gnurm, gnushred, gnuunlink or gnutruncate (case-blind on macOS and Windows). True when:
 *   1. a deleter's name is a word outside quotes, unless the word before it in the same command is a program with a
 *      subcommand of that name where it begins its command or stands right after a program that passes a command on
 *      (git rm, sudo git rm, npm rm, docker image rm are ordinary; sudo -u git rm, ssh stack rm are not);
 *   2. a deleter's name, or a form of 3, is in quoted text that counts, which is only:
 *      (a) in a command that holds a shell's name (or busybox sh) and after it an option with one - and the letter c,
 *          wherever it stands (docker exec box sh -c "…", kubectl exec pod -- sh -c "…", strace -f sh -c "…");
 *      (b) anywhere on the line, where a shell begins a command (after passers) with neither -c nor a script file
 *          (echo "…" | sh, bash <<EOF, bash <<< "…"; bash build.sh && git commit -m "rm x" is ordinary);
 *      (c) in a command that begins (after passers) with a program that takes a command or a text to run (eval, ssh,
 *          su, sudo, env, xargs, watch, timeout, trap, tmux, at and the others of TAKES_COMMAND), and in the command
 *          before a pipe into at or batch;
 *      (d) in a command that begins with a language (python, perl, ruby, node, php, awk …), where that text itself
 *          holds a way to start a program (system, exec, popen, spawn, subprocess, shell, passthru, %x, a backtick);
 *      (e) after -c or --call of npx, npm exec, pnpm exec, pnpm dlx, yarn exec, uv run, poetry run, bundle exec, and
 *          after --exec or -x of nodemon;
 *   3. the words outside quotes hold find and later -delete; git whose first word that is no option is clean; rsync
 *      and later a word that begins --del or is --remove-source-files.
 * Not caught, on purpose: a deleter's name built at run time (a variable, $'\x72m', a glob, a brace), what bash runs
 * from text without a visible name (PS4, ${x@P}, arithmetic on an array index, alias, BASH_ENV, . or source of a
 * text), git -c alias…, a language's own delete (os.remove, shutil.rmtree, fs.rmSync, perl's unlink), a deleter's name
 * in quotes after a program that is in none of the lists (eatmydata 'rm' -rf x; without the quotes it is caught), mv,
 * dd, a redirect, rmdir, a script or a program, OpenCode's own file tools.
 * Known and not yet caught (found by the last review, to be closed): a word that holds ${…}, {} or an unquoted $( )
 * or backtick ends the command here although bash keeps it inside the word, so a quoted text after it is judged
 * without its program (ssh to a host written as ${HOST}, su or sudo to a user written as a variable, tmux send-keys
 * to a session written as one, xargs -I{} ssh {}); and a here-document's body is judged line by line for the
 * language case, so a body that names the delete on one line and starts it on another is not caught. A pipe into a
 * shell named after ssh, docker exec -i or kubectl exec -i is not read as a shell either.
 */
export function mayDelete(line) {
  if (typeof line !== 'string' || line.length > LINE_MAX) return true;
  const outside = []; // { word, after, after2, cmd } (after: the word before it in the same command, or null)
  const texts = []; // { cmd, pos (outside words of its command before it), words, raw } of every quoted text
  const cmds = [{ words: [], texts: 0, pipeNext: false }]; // each command's outside words, its texts, and whether a pipe follows it
  let cmd = 0;
  let word = ''; // the outside word being read
  let last = null; // the outside word before it in the same command
  let last2 = null; // … and the one before that
  const heredocs = []; // { delim, strip, expands, cmd, pos } of the here-documents whose bodies begin at the next newline
  const quotes = []; // { text, gluedBefore, cmd, pos } of each quote being read (a quote can hold a $( … ) that holds one)
  const stack = []; // 'sq' 'dq' 'ansi' 'sub' (a $( … ) inside double quotes) 'tick' (a backtick inside them)
  const depths = []; // the parentheses open in each 'sub'
  const saved = []; // the command a 'sub' or a 'tick' interrupted: { cmd, last, last2 }
  const parens = []; // outside quotes: each open parenthesis, true where it opened a $( (a word goes on after it)
  let wordParenAt = -1; // where a ) closed a $( … ) inside a word
  let arith = 0; // (( … )) open outside quotes: no here-document in arithmetic
  let redirect = false; // the next word is a redirection's target (no argument of its command)
  const pushWord = (w, notArgument = false) => {
    outside.push({ word: w, after: last, after2: last2, cmd });
    if (!notArgument && !redirect) cmds[cmd].words.push(w);
    redirect = false;
    last2 = last;
    last = w;
  };
  // A word ends at sign `c`: a number right before < or > is a file descriptor (2>&1), no argument either.
  const endWord = (c = '') => {
    if (word) pushWord(word, (c === '<' || c === '>') && isNumber(word));
    word = '';
  };
  const endCommand = (pipe = false) => {
    if (cmds[cmd].words.length || cmds[cmd].texts) {
      cmds[cmd].pipeNext = pipe;
      cmds.push({ words: [], texts: 0, pipeNext: false });
      cmd = cmds.length - 1;
    }
    last = null;
    last2 = null;
    redirect = false;
  };
  // A command of its own inside another (a $( … ) or a backtick in double quotes, or in a here-document's body).
  const enter = () => {
    saved.push({ cmd, last, last2 });
    cmds.push({ words: [], texts: 0, pipeNext: false });
    cmd = cmds.length - 1;
    last = null;
    last2 = null;
  };
  const leave = () => {
    ({ cmd, last, last2 } = saved.pop());
  };
  const addText = (raw, at = { cmd, pos: cmds[cmd].words.length }) => {
    const words = splitWords(raw);
    if (words.length) {
      texts.push({ cmd: at.cmd, pos: at.pos, words, raw });
      cmds[at.cmd].texts++;
    }
    return words;
  };
  // A line of a here-document whose delimiter is not quoted: bash expands it, so what stands in a $( … ) or a backtick
  // there is a command of its own; the rest is text of the here-document's command. One pass over the line.
  const bodyLine = (l, h) => {
    let text = '';
    let w = '';
    let open = 0; // parentheses open in a $( … ), or -1 inside a backtick
    const flush = () => {
      if (w) pushWord(w);
      w = '';
    };
    for (let k = 0; k < l.length; k++) {
      const c = l[k];
      if (!open && ((c === '$' && l[k + 1] === '(') || c === '`')) {
        addText(text, h);
        text = '';
        enter();
        open = c === '`' ? -1 : 1;
        if (c === '$') k++;
        continue;
      }
      if (!open) {
        text += c;
        continue;
      }
      if ((open === -1 && c === '`') || (open > 0 && c === ')' && --open === 0)) {
        flush();
        leave();
        open = 0;
        continue;
      }
      if (open > 0 && c === '(') open++;
      if (isWordChar(c)) w += c;
      else {
        flush();
        if (ENDS_COMMAND.has(c)) {
          last = null;
          last2 = null;
        }
      }
    }
    flush();
    if (open) leave();
    addText(text, h);
  };
  const openQuote = (kind) => {
    quotes.push({ text: '', gluedBefore: word !== '', cmd, pos: cmds[cmd].words.length });
    stack.push(kind);
  };
  // A quote just closed: its text is quoted text of its command; glued to a word beside it, also part of that word.
  const closeQuote = (next) => {
    const q = quotes.pop();
    stack.pop();
    const words = addText(q.text, q);
    if (q.gluedBefore || (next !== undefined && !isSeparator(next))) word += q.text;
    else if (last === null && words.length === 1 && words[0] === q.text) pushWord(q.text); // "rm" x: the command word
    else redirect = false; // a quoted redirection target (<<< 'text', > "file") is no argument either
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const top = stack.length ? stack[stack.length - 1] : 'out';
    const quoted = quotes[quotes.length - 1];
    if (top === 'sq') {
      if (c === "'") closeQuote(line[i + 1]);
      else quoted.text += c;
      continue;
    }
    if (top === 'ansi') {
      if (c === '\\' && i + 1 < line.length) quoted.text += line[++i];
      else if (c === "'") closeQuote(line[i + 1]);
      else quoted.text += c;
      continue;
    }
    if (top === 'dq') {
      if (c === '\\' && '"\\$`'.includes(line[i + 1] || '')) quoted.text += line[++i];
      else if (c === '"') closeQuote(line[i + 1]);
      else if (c === '$' && line[i + 1] === '(') {
        // A command of its own, inside the quotes: its words are outside words.
        i++;
        stack.push('sub');
        depths.push(1);
        enter();
      } else if (c === '`') {
        stack.push('tick');
        enter();
      } else quoted.text += c;
      continue;
    }
    // Outside quotes (also inside a $( … ) or a backtick within double quotes).
    const prev = line[i - 1];
    if (c === '#' && word === '' && (i === 0 || prev === ' ' || prev === '\t' || prev === '\n' || (';|&(<>'.includes(prev)) || (prev === ')' && wordParenAt !== i - 1))) {
      // A comment: up to the end of the line (the newline itself is read as usual).
      while (i + 1 < line.length && line[i + 1] !== '\n') i++;
      continue;
    }
    if (c === '<' && line[i + 1] === '<' && line[i + 2] === '<') {
      // A here-string (<<<) is no here-document: its three signs end a word, as any other; its word is no argument.
      endWord();
      i += 2;
      redirect = true;
      continue;
    }
    if (c === '(' && line[i + 1] === '(') arith++;
    else if (c === ')' && line[i + 1] === ')' && arith > 0) arith--;
    if (c === '<' && line[i + 1] === '<' && !arith) {
      // A here-document: its delimiter, quotes taken off; its body is read at the next newline.
      endWord();
      const at = { cmd, pos: cmds[cmd].words.length };
      i += 2;
      const strip = line[i] === '-';
      if (strip) i++;
      while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
      let delim = '';
      let quotedDelim = false;
      for (; i < line.length && !isSeparator(line[i]); i++) {
        if (line[i] === "'" || line[i] === '"' || line[i] === '\\') quotedDelim = true;
        else delim += line[i];
      }
      i--;
      if (delim) heredocs.push({ delim, strip, expands: !quotedDelim, ...at });
      continue;
    }
    if (c === '\n' && heredocs.length) {
      endWord();
      endCommand();
      // The bodies, in their order: the lines up to one that is exactly the delimiter (for <<- after leading tabs).
      // Their words are text, no quote state is kept in them; one whose end never comes takes the rest of the line.
      let at = i + 1;
      for (const h of heredocs.splice(0)) {
        while (at < line.length) {
          let end = line.indexOf('\n', at);
          if (end < 0) end = line.length;
          let l = line.slice(at, end);
          if (h.strip) {
            let t = 0;
            while (t < l.length && l[t] === '\t') t++;
            l = l.slice(t);
          }
          at = end + 1;
          if (l === h.delim) break;
          if (h.expands) bodyLine(l, h);
          else addText(l, h);
        }
      }
      i = at - 1; // the pass goes on after the last end line, whose newline is read as a separator
      continue;
    }
    if (c === '\\') {
      if (line[i + 1] === '\n') i++; // a backslash-newline is nothing
      else if (i + 1 < line.length) word += line[++i];
      continue;
    }
    if (c === "'") {
      openQuote('sq');
      continue;
    }
    if (c === '"') {
      openQuote('dq');
      continue;
    }
    if (c === '$' && (line[i + 1] === "'" || line[i + 1] === '"')) {
      openQuote(line[i + 1] === "'" ? 'ansi' : 'dq');
      i++;
      continue;
    }
    if (top === 'sub' && (c === '(' || c === ')')) {
      depths[depths.length - 1] += c === '(' ? 1 : -1;
      if (!depths[depths.length - 1]) {
        endWord();
        depths.pop();
        stack.pop(); // back inside the double quotes
        leave();
        continue;
      }
    }
    if (top === 'tick' && c === '`') {
      endWord();
      stack.pop();
      leave();
      continue;
    }
    if (top === 'out') {
      if (c === '(') parens.push(prev === '$');
      else if (c === ')' && parens.pop()) wordParenAt = i;
    }
    if (isWordChar(c)) {
      word += c;
      continue;
    }
    endWord(c);
    if (c === '<' || c === '>') redirect = line[i + 1] !== '&' && line[i + 1] !== '(';
    else if (c === '&' && (prev === '>' || prev === '<')) redirect = true; // >&2, <&0: the descriptor after it
    if (ENDS_COMMAND.has(c) || c === '`' || (c === '$' && line[i + 1] === '(')) endCommand(c === '|');
  }
  if (stack.length) return true; // a quote that never closes
  endWord();
  const names = outside.map((o) => baseName(o.word));
  // 1. a deleter's name outside quotes, not as another program's subcommand.
  const subcommand = (o) => {
    if (!o.after) return false;
    const owner = baseName(o.after);
    const before = o.after2 === null ? null : baseName(o.after2);
    if (CONTAINER_OBJECTS.has(owner)) return CONTAINER_TOOLS.has(before);
    return HAS_RM_SUBCOMMAND.has(owner) && (before === null || PASSES_ON.has(before));
  };
  if (outside.some((o, k) => DELETER_NAMES.has(names[k]) && !subcommand(o))) return true;
  // 3. find … -delete; git … clean; rsync … --del….
  if (deletesByForm(outside.map((o) => o.word))) return true;
  // 2. a deleter's name, or one of those forms, in quoted text that counts.
  const deleting = texts.filter((t) => t.words.some((w) => DELETER_NAMES.has(baseName(w))) || deletesByForm(t.words));
  if (!deleting.length) return false;
  const facts = cmds.map((c) => commandFacts(c.words));
  if (facts.some((f) => f.shellFromElsewhere)) return true; // (b)
  return deleting.some((t) => {
    const f = facts[t.cmd];
    if (f.shellWithC || f.takesCommand) return true; // (a), (c)
    if (f.language && STARTS_PROGRAM.some((s) => t.raw.includes(s))) return true; // (d)
    if (f.textAfter >= 0 && t.pos > f.textAfter) return true; // (e)
    return t.cmd + 1 < cmds.length && cmds[t.cmd].pipeNext && facts[t.cmd + 1].intoAt; // (c) a pipe into at or batch
  });
}

// What one command's outside words say for rule 2 of mayDelete: { shellWithC (a), shellFromElsewhere (b),
// takesCommand (c), language (d), textAfter (e: the index of the word after which a text counts, or -1), intoAt }.
function commandFacts(words) {
  // gnuenv, gnutimeout and the like are the same programs under another name (as gnurm is rm).
  const b = words.map((w) => {
    const n = baseName(w);
    return n.startsWith('gnu') && TAKES_COMMAND.has(n.slice(3)) ? n.slice(3) : n;
  });
  const isShellAt = (k) => SHELLS.has(b[k]) || (b[k] === 'busybox' && b[k + 1] === 'sh');
  const cOption = (w) => w.startsWith('-') && !w.startsWith('--') && w.includes('c');
  const facts = { shellWithC: false, shellFromElsewhere: false, takesCommand: false, language: false, textAfter: -1, intoAt: false };
  // (a) a shell's name, and after it an option with one - and the letter c, wherever they stand (one pass from the end).
  let cLater = false;
  for (let k = words.length - 1; k >= 0 && !facts.shellWithC; k--) {
    if (isShellAt(k) && cLater) facts.shellWithC = true;
    if (cOption(words[k])) cLater = true;
  }
  // The head: past assignments and what only passes a command on (with its options and numbers).
  // (e) npx, npm exec, pnpm exec, pnpm dlx, yarn exec, uv run, poetry run, bundle exec: a text after -c or --call
  // counts; without either they only pass a command on.
  const runsPackage = (j) => b[j] === 'npx' || ((b[j] === 'npm' || b[j] === 'pnpm' || b[j] === 'yarn' || b[j] === 'bundle') && b[j + 1] === 'exec') || (b[j] === 'pnpm' && b[j + 1] === 'dlx') || ((b[j] === 'uv' || b[j] === 'poetry') && b[j + 1] === 'run');
  // Where the next -c or --call stands after each word (one pass from the end).
  const nextCall = new Array(words.length).fill(-1);
  for (let j = words.length - 2, at = -1; j >= 0; j--) {
    if (words[j + 1] === '-c' || words[j + 1] === '--call') at = j + 1;
    nextCall[j] = at;
  }
  let k = 0;
  for (;;) {
    while (k < words.length && isAssignment(words[k])) k++;
    if (k >= words.length) return facts;
    if (TAKES_COMMAND.has(b[k])) facts.takesCommand = true;
    if (runsPackage(k)) {
      const call = nextCall[k];
      if (call >= 0) {
        facts.textAfter = call;
        return facts;
      }
      k += b[k] === 'npx' ? 1 : 2;
    } else if (HEAD_PASSERS.has(b[k])) k++;
    else break;
    while (k < words.length && (words[k].startsWith('-') || isNumber(words[k]) || isAssignment(words[k]))) k++;
  }
  const head = b[k];
  if (head === 'at' || head === 'batch') facts.intoAt = true;
  if (isShellAt(k)) {
    // (b) a shell that reads its script from elsewhere: neither -c nor a first argument that is a file.
    let j = k + (head === 'busybox' ? 2 : 1);
    let file = false;
    let withC = false;
    for (; j < words.length; j++) {
      const w = words[j];
      if (w === '-o' || w === '+o' || w === '-O' || w === '+O' || w === '--rcfile' || w === '--init-file') j++;
      else if (cOption(w)) withC = true;
      else if (!w.startsWith('-') && !w.startsWith('+') && w !== '/dev/stdin' && w !== '/dev/fd/0') {
        file = true;
        break;
      }
    }
    facts.shellFromElsewhere = !withC && !file;
  }
  if (LANGUAGES.has(head)) facts.language = true;
  // (e) nodemon: a text after --exec or -x counts.
  if (head === 'nodemon') facts.textAfter = words.findIndex((w, j) => j > k && (w === '--exec' || w === '-x'));
  return facts;
}

// find and later -delete; git whose first word that is no option is clean; rsync and later --del… or
// --remove-source-files. In one pass (each word looked at a fixed number of times).
function deletesByForm(words) {
  let lastDelete = -1;
  let lastRsyncDelete = -1;
  words.forEach((w, k) => {
    if (w === '-delete') lastDelete = k;
    if (w.startsWith('--del') || w === '--remove-source-files') lastRsyncDelete = k;
  });
  for (let k = 0; k < words.length; k++) {
    const n = baseName(words[k]);
    if ((n === 'find' && k < lastDelete) || (n === 'rsync' && k < lastRsyncDelete)) return true;
    if (n === 'git') {
      let j = k + 1;
      while (j < words.length && words[j].startsWith('-')) j += GIT_VALUE_OPTIONS.has(words[j]) ? 2 : 1;
      if (j < words.length && words[j] === 'clean') return true;
      k = Math.max(k, j - 1); // the options read are not read again
    }
  }
  return false;
}
