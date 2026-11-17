// The one door for every read of a folder's git state (status, file lists, diffs, logs, branches, settings). The
// dashboard looks at folders it did not make: a project cloned or unpacked from elsewhere, one a coding tool writes
// into. A repository's own settings can name programs that git then starts by itself: an fsmonitor command, hooks,
// content filters, diff converters. A read through here never starts one of them:
// - fixed settings on the command line (-c outranks the folder's file): no fsmonitor, hooks from the null device,
//   no signature checks, no submodule recursion, no transport (a partial clone would fetch a missing object);
// - diff, show and log never use an external diff or a text converter (--no-ext-diff --no-textconv);
// - a filter or diff driver has a free name, so no fixed setting reaches it: before a read that can compare file
//   contents, the folder's own settings are listed (that runs nothing) and every driver command found there is set
//   to nothing; when the list cannot be read, the read is refused with a plain sentence;
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
  'submodule.recurse=false',
  'status.submoduleSummary=false',
  'protocol.allow=never',
  ...['file', 'ext', 'ssh', 'git', 'http', 'https'].map((p) => `protocol.${p}.allow=never`), // a folder may allow one
];
const FLAGS = ['--no-pager', ...FIXED.flatMap((c) => ['-c', c])];

// Reads that compare the contents of files (a clean filter runs there) or print them (textconv, external diff).
// (cat-file prints a stored object as it is: the reader never asks it to filter or convert.)
const CONTENT = new Set(['status', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'ls-files', 'grep', 'show', 'log', 'whatchanged', 'blame']);
const NO_CONVERT = new Set(['diff', 'diff-files', 'diff-index', 'diff-tree', 'show', 'log', 'whatchanged']);
// Commands that change a repository: never through the reader.
const WRITES = new Set(['add', 'commit', 'restore', 'rm', 'checkout', 'switch', 'reset', 'merge', 'pull', 'push', 'fetch', 'clone', 'init', 'rebase', 'cherry-pick', 'revert', 'mv', 'clean', 'gc', 'maintenance', 'update-index', 'apply', 'am']);
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

/**
 * The command line and environment of one read of the repository at `dir` (`args`: git's arguments without "git").
 * `env`: the caller's environment to take PATH and the home folder from. `run`: how the folder's settings are listed
 * (capture's shape). → { argv, env } or { refused: sentence }.
 */
export async function readCommand(dir, args, { env = process.env, run = capture } = {}) {
  const at = commandAt(args);
  const cmd = at < 0 ? '' : String(args[at]);
  if (WRITES.has(cmd)) throw new Error(`git ${cmd} changes a repository: it is not a read`);
  if (args.slice(0, Math.max(at, 0)).some((a) => REFUSED_OPTS.has(String(a).split('=')[0]))) throw new Error('a read names its folder with dir only');
  if (cmd === 'cat-file' && args.some((a) => /^--(filters|textconv)/.test(String(a)))) throw new Error('the reader never asks cat-file to filter or convert');
  const base = readEnv(env);
  let extra = {};
  if (CONTENT.has(cmd)) {
    const own = await ownSettings(dir, base, run);
    // A folder that is not there is no refusal: git's own words say so, as for any read.
    if (!own.ok) return { refused: fs.existsSync(dir) ? REFUSED : own.err.trim() || `${dir} is not there` };
    const o = overridesFor(own.names);
    // In the environment, not with -c: a driver's name may hold "=", which -c would read as the end of the name.
    extra = { GIT_CONFIG_COUNT: String(o.length) };
    o.forEach(([k, v], i) => {
      extra[`GIT_CONFIG_KEY_${i}`] = k;
      extra[`GIT_CONFIG_VALUE_${i}`] = v;
    });
  }
  const rest = [...args];
  if (NO_CONVERT.has(cmd)) rest.splice(at + 1, 0, '--no-ext-diff', '--no-textconv');
  // A submodule's own settings are not listed here: its contents are not compared (its new commits still show).
  if (cmd === 'status') rest.splice(at + 1, 0, '--ignore-submodules=dirty');
  return { argv: ['git', ...FLAGS, '-C', dir, ...rest], env: { ...base, ...extra } };
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
