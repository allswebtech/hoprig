// Find in files for the editor: ripgrep when this computer has it, else `git grep` inside a repository, else a plain
// walk in JavaScript (in a worker thread, walk.mjs). Each skips git's folder, installed packages, private folders and
// binary files, and stops at the limits below (a running program or the worker is ended there, never buffered whole).
// Whatever an engine prints, every hit is checked once more before it is shown (paths.mjs showable).
import { spawn } from 'node:child_process';
import { which } from '../setup/system.mjs';
import { excludes, gitEnv, repoOf } from './git.mjs';
import { FOLD, HIDDEN, PRIVATE_DIRS, fail, rootOf, showable } from './paths.mjs';
import { globRe, walk } from './walk.mjs';

export { globRe };
export const LIMITS = { matches: 2000, perFile: 50, ms: 10_000, text: 200, fileBytes: 1024 * 1024, query: 500 };
const SKIP = [...HIDDEN, ...PRIVATE_DIRS];

/**
 * "src/**, *.md" → ['src/**', '*.md']: the page's include / exclude boxes. A pattern stays inside the opened folder:
 * no "..", no leading "/" or ":" (git would read that as its own pathspec magic), no backslash.
 */
const globs = (s) => String(s || '').split(',').map((g) => g.trim()).filter(Boolean).slice(0, 20).map((g) => {
  if (g.length > 200 || /[\0\\]/.test(g) || /^[-/:!]/.test(g) || g.split('/').includes('..')) throw fail(400, 'a file pattern is not usable: it must stay inside the opened folder');
  return g;
});

/** The one line shown for a hit: at most LIMITS.text characters, around the match. */
function excerpt(line, col) {
  const text = line.replace(/\r?\n$/, '');
  if (text.length <= LIMITS.text) return { text, col };
  const start = Math.max(0, Math.min(col - 1 - 40, text.length - LIMITS.text));
  return { text: text.slice(start, start + LIMITS.text), col: col - start, cut: start };
}

/** Run a search program, line by line, until it ends, the match limit or the time limit. */
export function runLines(argv, { cwd, env, onLine }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: null, err: e.message, timedOut: false });
      return;
    }
    let rest = '';
    let err = '';
    let stopped = false;
    let timedOut = false;
    const stop = () => {
      stopped = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, LIMITS.ms);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      if (stopped) return;
      const parts = (rest + c).split('\n');
      rest = parts.pop();
      for (const l of parts) if (!stopped && onLine(l) === false) stop();
    });
    child.stderr.on('data', (c) => {
      if (err.length < 2000) err += c;
    });
    child.on('error', (e) => {
      err ||= e.message;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!stopped && rest) onLine(rest);
      resolve({ code, err: err.trim(), timedOut, stopped });
    });
  });
}

/** The matches of a search request, one of three engines. */
export async function search(rootArg, { q, regex = false, caseSensitive = false, word = false, include = '', exclude = '' }, roots, { env = process.env, engine = null } = {}) {
  const root = rootOf(rootArg, roots);
  if (typeof q !== 'string' || !q || q.length > LIMITS.query || q.includes('\0')) throw fail(400, `type what to look for (up to ${LIMITS.query} characters)`);
  const inc = globs(include);
  const exc = globs(exclude);
  let re;
  try {
    const body = regex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(word ? `\\b(?:${body})\\b` : body, caseSensitive ? 'u' : 'iu');
  } catch (e) {
    throw fail(400, `that is not a valid regular expression (${e.message.replace(/^.*: /, '').toLowerCase()})`);
  }
  const matches = [];
  const cache = new Map();
  const add = (p, line, col, text) => {
    // Whatever an engine printed, a hit in a hidden or private folder, in git's folder or in a file with a sign-in is
    // never shown (an include pattern could otherwise bring them back).
    if (!showable(root, p, cache)) return true;
    if (matches.length >= LIMITS.matches) return false;
    matches.push({ path: p, line, ...excerpt(text, col) });
    return matches.length < LIMITS.matches;
  };
  const pick = engine || (which('rg', env) ? 'rg' : (await repoOf(root, roots)).top ? 'git' : 'walk');
  let res = { timedOut: false };
  if (pick === 'rg') res = await viaRg(root, { q, regex, caseSensitive, word, inc, exc }, env, add);
  else if (pick === 'git') res = await viaGit(root, { q, regex, caseSensitive, word, inc, exc }, env, add);
  else {
    res = await walk(root, { mode: 'search', skip: SKIP, fold: FOLD, re: { source: re.source, flags: re.flags }, inc, exc, perFile: LIMITS.perFile, fileBytes: LIMITS.fileBytes, ms: LIMITS.ms },
      (hits) => hits.every(([p, line, col, text]) => add(p, line, col, text) !== false));
  }
  if (res.badPattern) throw fail(400, `that is not a valid regular expression: ${res.badPattern}`);
  return { engine: pick, matches, truncated: matches.length >= LIMITS.matches, timedOut: Boolean(res.timedOut) };
}

export const FILES_MAX = 20_000;

/**
 * Every file of the opened folder, for quick open: git's tracked and new files (what .gitignore leaves out is not
 * listed) inside a repository, else a walk. The same folders as in a search are skipped, and so are paths the editor
 * cannot open (a part that starts with "-"). { files, truncated }.
 */
export async function listFiles(rootArg, roots, { env = process.env } = {}) {
  const root = rootOf(rootArg, roots);
  const cache = new Map();
  const usable = (p) => p && !p.startsWith('"') && !p.split('/').some((s) => s.startsWith('-')) && showable(root, p, cache);
  const files = [];
  const seen = new Set(); // git lists a file twice while it has a conflict
  let truncated = false;
  const keep = (p) => {
    if (!usable(p) || seen.has(p)) return true;
    seen.add(p);
    if (files.length >= FILES_MAX) {
      truncated = true;
      return false;
    }
    files.push(p);
    return true;
  };
  if ((await repoOf(root, roots)).top) {
    // Names with a quote, a backslash or a control character come back C-quoted: those are left out (keep).
    const argv = ['git', '-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '--', '.', ...excludes(SKIP)];
    const r = await runLines(argv, { cwd: root, env: gitEnv(env), onLine: keep });
    return { files: files.sort(), truncated: truncated || r.timedOut };
  }
  const r = await walk(root, { mode: 'files', skip: SKIP, fold: FOLD, inc: [], exc: [], ms: LIMITS.ms }, (list) => list.every(keep));
  return { files: files.sort(), truncated: truncated || Boolean(r.timedOut) };
}

async function viaRg(root, o, env, add) {
  const argv = [
    'rg', '--json', '--hidden', '--max-count', String(LIMITS.perFile), '--max-filesize', '1M', '--max-columns', '1000',
    o.caseSensitive ? '--case-sensitive' : '--ignore-case', ...(o.regex ? [] : ['--fixed-strings']), ...(o.word ? ['--word-regexp'] : []),
    '--path-separator', '/', // the page's paths, also on Windows
    ...o.inc.flatMap((g) => ['--glob', g]), ...o.exc.flatMap((g) => ['--glob', `!${g}`]),
    // After the include patterns: of ripgrep's globs the last one that matches wins. A name without "/" is that
    // folder at any depth.
    ...SKIP.flatMap((d) => [FOLD ? '--iglob' : '--glob', `!${d}`]),
    '-e', o.q, '--', '.',
  ];
  const r = await runLines(argv, {
    cwd: root, env,
    onLine: (l) => {
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        return true;
      }
      if (m.type !== 'match' || !m.data.path.text || m.data.lines.text === undefined) return true;
      const p = (process.platform === 'win32' ? m.data.path.text.replace(/\\/g, '/') : m.data.path.text).replace(/^\.\//, '');
      const text = m.data.lines.text;
      const byte = m.data.submatches[0] ? m.data.submatches[0].start : 0;
      const col = Buffer.from(text).subarray(0, byte).toString('utf8').length + 1;
      return add(p, m.data.line_number, col, text);
    },
  });
  // rg: 0 found, 1 none found, 2 an error (a bad pattern among them).
  if (r.code === 2 && !r.stopped && /regex|parse/i.test(r.err)) return { badPattern: r.err.split('\n').slice(-3).join(' ') };
  return r;
}

async function viaGit(root, o, env, add) {
  // A pattern without "/" matches at any depth, and a folder's pattern takes in what is inside it (as with rg).
  const spec = (magic, g) => {
    const p = g.includes('/') ? g : `**/${g}`;
    return [`:(${magic})${p}`, `:(${magic})${p}/**`];
  };
  const pathspecs = [
    ...(o.inc.length ? o.inc.flatMap((g) => spec('glob', g)) : ['.']),
    ...o.exc.flatMap((g) => spec('exclude,glob', g)),
    ...excludes(SKIP),
  ];
  const argv = [
    'git', 'grep', '-n', '--column', '-I', '-z', '--untracked', '--exclude-standard', '--max-count', String(LIMITS.perFile),
    ...(o.caseSensitive ? [] : ['-i']), ...(o.regex ? ['-P'] : o.ere ? ['-E'] : ['-F']), ...(o.word ? ['-w'] : []), '-e', o.q, '--', ...pathspecs,
  ];
  const r = await runLines(argv, {
    cwd: root, env: gitEnv(env),
    onLine: (l) => {
      const [p, line, col, ...rest] = l.split('\0');
      if (!p || !line) return true;
      const text = rest.join('\0');
      // git counts the column in bytes; the page counts characters.
      return add(p, Number(line), Buffer.from(text).subarray(0, Math.max(0, Number(col) - 1)).toString('utf8').length + 1, text);
    },
  });
  // git built without PCRE: the same search with POSIX extended expressions.
  if (r.code === 128 && o.regex && /not built with|support for perl|USE_LIBPCRE/i.test(r.err)) return viaGit(root, { ...o, regex: false, ere: true }, env, add);
  if (r.code === 128 && !r.stopped && /regex|pattern|PCRE|parse/i.test(r.err)) return { badPattern: r.err.split('\n')[0] };
  return r;
}
