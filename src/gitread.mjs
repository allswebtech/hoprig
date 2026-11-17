// The one door for every read of a folder's git state (status, file lists, diffs, logs, branches, settings). The
// dashboard looks at folders it did not make: a project cloned or unpacked from elsewhere, one a coding tool writes
// into. A repository's own settings can name programs that git then starts by itself: an fsmonitor command, hooks,
// content filters, diff converters. A read through here never starts one of them:
// - fixed settings on the command line (-c outranks the folder's file): no fsmonitor, hooks from the null device,
//   no signature checks, no submodule recursion, no transport (a partial clone would fetch a missing object);
// - diff, show and log never use an external diff or a text converter (--no-ext-diff --no-textconv), and neither
//   they nor status look inside a submodule's files (--ignore-submodules=dirty: a submodule's own settings are not
//   listed here, and git would compare its files with its own filters);
// - a filter or diff driver has a free name, so no fixed setting reaches it: before a read that can compare file
//   contents, the folder's own settings are listed (that runs nothing) and every driver command found there is set
//   to nothing; when the list cannot be read, the read is refused with a plain sentence;
// - only git's own read commands go through (an allow-list: a write, difftool, verify-commit or a folder's alias is
//   no read), and a caller's arguments cannot take any of this back: a later --textconv, --submodule=diff,
//   --show-signature or a %G placeholder, an abbreviation of a guarded option, a -c of its own are refused;
// - a settings read (git config --get) gets none of the fixed settings, which would otherwise be its answer;
// - the environment is a short list of its own: the caller's GIT_DIR, GIT_EXTERNAL_DIFF or GIT_CONFIG_COUNT never
//   reach git. The owner's own global settings stay in force (HOME, XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL).
// What the owner presses (stage, commit, discard) is not a read: it runs as git runs it from his terminal.
import fs from 'node:fs';
import os from 'node:os';
import { capture } from './setup/system.mjs';

/** Settings a read always gets, given with -c so that the repository's own file cannot outrank them. */
export const FIXED = [
  'core.fsmonitor=false',
  `core.hooksPath=${os.devNull}`,
  'log.showSignature=false', // would start gpg.program, which the folder can name
  'format.pretty=medium', // git's default; the folder's own could be a format with %G (a signature check)
  'submodule.recurse=false',
  'status.submoduleSummary=false',
  'diff.submodule=short', // "diff" would run a diff inside the submodule, with the submodule's own drivers
  'protocol.allow=never',
  ...['file', 'ext', 'ssh', 'git', 'http', 'https'].map((p) => `protocol.${p}.allow=never`), // a folder may allow one
];
const FLAGS = ['--no-pager', ...FIXED.flatMap((c) => ['-c', c])];

// Reads that compare the contents of files (a clean filter runs there) or print them (textconv, external diff).
// (cat-file prints a stored object as it is: the reader never asks it to filter or convert.)
const CONTENT = new Set(['status', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'ls-files', 'grep', 'show', 'log']);
const NO_CONVERT = new Set(['diff', 'diff-files', 'diff-index', 'diff-tree', 'show', 'log']);
// The reads the reader offers: git's own commands (a built-in name is never a folder's alias). Not offered: blame
// reads the working file through its clean filter, which the reader sets to nothing (git then fails on the empty
// command); difftool, verify-commit and the like start programs; whatchanged is being removed from git.
const READS = new Set(['status', 'ls-files', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'show', 'log', 'grep', 'cat-file', 'rev-parse', 'rev-list', 'symbolic-ref', 'for-each-ref', 'merge-base', 'config', 'remote']);
// Long options that would take a guard back, start a program or write a file: --textconv and --ext-diff (converters),
// --recurse-submodules, --submodule and --[no-]ignore-submodules (a submodule's own settings), --show-signature (gpg),
// --output (a file), --open-files-in-pager (grep), --filters (cat-file), --help (a man page or a browser). git takes
// an option by any unambiguous start of its name, so any start of one of these is refused too ...
const GUARDED = ['--textconv', '--ext-diff', '--recurse-submodules', '--submodule', '--ignore-submodules', '--no-ignore-submodules', '--show-signature', '--output', '--open-files-in-pager', '--filters', '--help'];
// ... except an option of its own that happens to be such a start (diff --text, rev-list --filter=<spec>).
const OWN_NAMES = new Set(['--text', '--filter']);
// The log formats git has by name: any other name may be the folder's own pretty.<name>, a format with %G.
const PRETTY_NAMES = new Set(['oneline', 'short', 'medium', 'full', 'fuller', 'reference', 'email', 'mboxrd', 'raw']);
// git's own options before the command word that a read may give (-c only as CALLER_SETTINGS says).
const GLOBAL_OK = new Set(['--no-pager', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects', '--no-optional-locks']);
// The only setting a caller may give with -c before the command: how names are quoted.
const CALLER_SETTINGS = /^core\.quotepath=(true|false)$/i;
// A settings read: what git config may be given (one of the first five, or the words get / list, says what it reads).
const CONFIG_ACTIONS = new Set(['--get', '--get-all', '--get-regexp', '--list', '-l']);
const CONFIG_OPTS = /^(--get|--get-all|--get-regexp|--list|-l|--null|-z|--name-only|--show-origin|--show-scope|--includes|--no-includes|--local|--global|--system|--worktree|--bool|--int|--path|--all|--regexp|--type=[a-z-]+|--default=.*)$/;
const CONFIG_WRITES = new Set(['set', 'unset', 'rename-section', 'remove-section', 'edit']);
// More driver commands than this in one folder's settings: not a project, the read is refused.
const DRIVERS_MAX = 200;
// git's options before the command that take a value as the next word.
const TAKES_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source']);
const REFUSED_OPTS = new Set(['--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env', '-C']);

// What a read's environment keeps of the caller's: where programs are, the owner's home and his global git settings,
// the language, and what Windows needs to start anything.
const KEEP = /^(PATH|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|SYSTEMROOT|WINDIR|LANG|LANGUAGE|LC_[A-Z]+|XDG_CONFIG_HOME|GIT_CONFIG_GLOBAL|GIT_CONFIG_SYSTEM|GIT_CONFIG_NOSYSTEM|TMPDIR|TEMP|TMP)$/i;

/** The environment of a read: the short list of `base`, then the reader's own GIT_* (plus `extra`, the overrides). */
export function readEnv(base = process.env, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) if (typeof v === 'string' && KEEP.test(k)) env[k] = v;
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_PAGER: 'cat', ...extra };
}

/** Where the command word is in `args` (after git's own options such as -c k=v or --literal-pathspecs). */
function commandAt(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith('-')) return i;
    if (TAKES_VALUE.has(a)) i++;
  }
  return -1;
}

/** Throws unless `args` is one of the reads offered, with nothing in the caller's own words that takes a guard back. */
function checkArgs(args, at, cmd) {
  for (let i = 0; i < Math.max(at, 0); i++) {
    const a = String(args[i]);
    if (REFUSED_OPTS.has(a.split('=')[0])) throw new Error('a read names its folder with dir only');
    if (a === '-c') {
      if (!CALLER_SETTINGS.test(String(args[++i]))) throw new Error(`a read takes no setting of its caller's but core.quotePath (${args[i]})`);
    } else if (!GLOBAL_OK.has(a)) throw new Error(`a read cannot ask for ${a}`);
  }
  if (!READS.has(cmd)) throw new Error(`git ${cmd || 'without a command'} is not a read the reader offers`);
  // The caller's words up to "--" (after it come paths), without grep's pattern (the user's text, not an option).
  const own = [];
  let dashes = false;
  for (let i = at + 1; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--') {
      dashes = true;
      break;
    }
    if (cmd === 'grep' && a === '-e') i++;
    else own.push(a);
  }
  for (const a of own) {
    const name = a.split('=')[0];
    const guarded = a.startsWith('--') && name.length > 2 && !OWN_NAMES.has(name) && GUARDED.some((g) => g.startsWith(name));
    if (guarded && !/^--ignore-submodules(=(dirty|all))?$/.test(a)) throw new Error(`a read cannot ask for ${a}`);
    if (/^-[^-]/.test(a) && a.includes('O')) throw new Error(`a read cannot ask for ${a} (-O opens files in a program)`);
    if (/%G|%\(signature/.test(a)) throw new Error(`a read cannot ask for a signature check (${a})`);
    const f = /^--(pretty|format)=([^]*)$/.exec(a);
    if (f && cmd !== 'for-each-ref' && !/^t?format:|%/.test(f[2]) && !PRETTY_NAMES.has(f[2].toLowerCase())) throw new Error(`a read cannot ask for ${a} (a format the folder may name)`);
  }
  const notRead = (what) => new Error(`git ${cmd} ${what}: it is not a read`);
  if (cmd === 'symbolic-ref') {
    const names = own.filter((a) => !a.startsWith('-'));
    if (dashes || names.length !== 1 || own.some((a) => a.startsWith('-') && !/^(-q|--quiet|--short|--no-short|--recurse|--no-recurse)$/.test(a))) throw notRead('with more than one name to read changes a repository');
  }
  if (cmd === 'remote') {
    const list = own.every((a) => a === '-v' || a === '--verbose');
    const url = own[0] === 'get-url' && own.slice(1).every((a) => !a.startsWith('-') || a === '--push' || a === '--all');
    if (dashes || !(list || url)) throw notRead('other than a list or get-url changes a repository or reaches a server');
  }
  if (cmd === 'config') {
    const sub = own[0] === 'get' || own[0] === 'list';
    if (dashes || own.some((a) => (a.startsWith('-') ? !CONFIG_OPTS.test(a) : CONFIG_WRITES.has(a))) || !(sub || own.some((a) => CONFIG_ACTIONS.has(a)))) {
      throw notRead('other than --get or --list of the folder\'s settings changes a repository or reads another file');
    }
  }
}

const versions = new Map(); // PATH → git's [major, minor], read once

/** git's version on this PATH, or null when it cannot be read. */
async function gitVersion(env, run) {
  const key = env.PATH || '';
  if (!versions.has(key)) {
    const r = await run(['git', '--version'], { env, timeout: 10_000 });
    const m = /(\d+)\.(\d+)/.exec(r.ok ? String(r.stdout) : '');
    if (!m) return null;
    versions.set(key, [Number(m[1]), Number(m[2])]);
  }
  return versions.get(key);
}

/** Driver commands among `names` (the folder's own setting names): each set to nothing, a filter no longer required. */
export function overridesFor(names) {
  const out = [];
  for (const n of names) {
    let m = /^filter\.(.+)\.(clean|smudge|process|required)$/.exec(n);
    if (m) {
      out.push([`filter.${m[1]}.${m[2]}`, m[2] === 'required' ? 'false' : '']);
      if (m[2] !== 'required') out.push([`filter.${m[1]}.required`, 'false']);
      continue;
    }
    m = /^diff\.(.+)\.(textconv|command)$/.exec(n);
    if (m) out.push([`diff.${m[1]}.${m[2]}`, '']);
    else if (n === 'diff.external') out.push(['diff.external', '']);
  }
  const seen = new Map(out); // one entry per key
  return [...seen];
}

/**
 * The folder's own settings (local and worktree, with what they include), names only. Runs nothing that the folder
 * names. → { ok, names } or { ok: false }.
 */
async function ownSettings(dir, env, run) {
  const r = await run(['git', ...FLAGS, '-C', dir, 'config', '--includes', '--name-only', '--show-scope', '-z', '--list'], { env, timeout: 10_000 });
  if (!r.ok) return { ok: false, err: r.stderr || '' };
  const t = String(r.stdout || '').split('\0');
  const names = [];
  for (let i = 0; i + 1 < t.length; i += 2) if (t[i] === 'local' || t[i] === 'worktree') names.push(t[i + 1]);
  return { ok: true, names };
}

export const REFUSED = 'git\'s own settings of this folder could not be read, so the dashboard does not read it with git (it cannot tell which programs those settings would start)';
export const REFUSED_OLD = 'this folder\'s git settings name a filter or diff program whose name holds "=", and this git (older than 2.31) cannot switch it off for a read, so the dashboard does not read the folder with git';
export const REFUSED_MANY = 'this folder\'s git settings name more filter and diff programs than any project needs, so the dashboard does not read it with git';

/**
 * The command line and environment of one read of the repository at `dir` (`args`: git's arguments without "git").
 * `env`: the caller's environment to take PATH and the home folder from. `run`: how the folder's settings are listed
 * (capture's shape). → { argv, env } or { refused: sentence }.
 */
export async function readCommand(dir, args, { env = process.env, run = capture } = {}) {
  const at = commandAt(args);
  const cmd = at < 0 ? '' : String(args[at]);
  checkArgs(args, at, cmd);
  const base = readEnv(env);
  // A settings read starts nothing, and a fixed setting given with -c would be its answer (core.hooksPath).
  if (cmd === 'config') return { argv: ['git', '--no-pager', '-C', dir, ...args], env: base };
  let own = [];
  const extra = {};
  if (CONTENT.has(cmd)) {
    const listed = await ownSettings(dir, base, run);
    // A folder that is not there is no refusal: git's own words say so, as for any read.
    if (!listed.ok) return { refused: fs.existsSync(dir) ? REFUSED : listed.err.trim() || `${dir} is not there` };
    const o = overridesFor(listed.names);
    if (o.length > DRIVERS_MAX) return { refused: REFUSED_MANY };
    // With -c, which every git reads. A driver's name may hold "=", which -c would read as the end of the name:
    // those go in GIT_CONFIG_COUNT/KEY/VALUE, which git reads only from 2.31 on (older git would ignore them).
    own = o.filter(([k]) => !k.includes('=')).flatMap(([k, v]) => ['-c', `${k}=${v}`]);
    const named = o.filter(([k]) => k.includes('='));
    if (named.length) {
      const v = await gitVersion(base, run);
      if (!v || v[0] < 2 || (v[0] === 2 && v[1] < 31)) return { refused: REFUSED_OLD };
      extra.GIT_CONFIG_COUNT = String(named.length);
      named.forEach(([k, val], i) => {
        extra[`GIT_CONFIG_KEY_${i}`] = k;
        extra[`GIT_CONFIG_VALUE_${i}`] = val;
      });
    }
  }
  const rest = [...args];
  if (NO_CONVERT.has(cmd)) rest.splice(at + 1, 0, '--no-ext-diff', '--no-textconv');
  // A submodule's own settings are not listed here: its files are not compared (its new commits still show).
  if (NO_CONVERT.has(cmd) || cmd === 'status') rest.splice(at + 1, 0, '--ignore-submodules=dirty');
  return { argv: ['git', ...FLAGS, ...own, '-C', dir, ...rest], env: { ...base, ...extra } };
}

/**
 * One read, collected (capture's shape: { ok, code, stdout, stderr }). A refused read is { ok: false, refused: true,
 * stderr: the sentence }. `run` runs both the listing and the read (a test may hand in its own).
 */
export async function gitRead(dir, args, { env = process.env, run = capture, timeout = 15_000 } = {}) {
  const c = await readCommand(dir, args, { env, run });
  if (c.refused) return { ok: false, code: null, stdout: '', stderr: c.refused, refused: true };
  return run(c.argv, { env: c.env, timeout });
}
