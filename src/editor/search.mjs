// Find in files for the editor: ripgrep when this computer has it, else `git grep` inside a repository, else a plain
// walk in JavaScript (in a worker thread, walk.mjs). Each skips git's folder, installed packages, private folders and
// binary files, and stops at the limits below (a running program or the worker is ended there, never buffered whole).
// Whatever an engine prints, every hit is checked once more before it is shown (paths.mjs showable).
// A pattern that came from the page is never compiled or run on this thread (one that backtracks over a long line held
// every terminal and page of the dashboard for seconds): ripgrep and git run it as programs of their own, the walk, the
// check of the pattern and the count of a long line's matches run in walk.mjs's worker under a time limit.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { which } from '../setup/system.mjs';
import { readCommand } from '../gitread.mjs';
import { excludes, repoOf } from './git.mjs';
import { FOLD, HIDDEN, PRIVATE_DIRS, fail, resolveIn, rootOf, showable } from './paths.mjs';
import { countIn, patternError, walk } from './walk.mjs';
import { MAX_BYTES, versionOfFile } from './files.mjs';
import { patternSource } from './words.mjs'; // Match Whole Word: the page's definition (web/editor/words.js), held equal by a test

// countMs: how long the count of long lines' matches may take (in the worker); countBytes: how much line text is kept
// for it. Past either the lines have no count (the page's Replace All counts what it writes anyway).
export const LIMITS = { matches: 2000, perFile: 50, ms: 10_000, text: 200, fileBytes: 1024 * 1024, query: 500, countMs: 2000, countBytes: 8 * 1024 * 1024 };
const SKIP = [...HIDDEN, ...PRIVATE_DIRS];

/**
 * "src/**, *.md" → ['src/**', '*.md']: the page's include / exclude boxes. A pattern stays inside the opened folder:
 * no "..", no leading "/" or ":" (git would read that as its own pathspec magic), no backslash.
 */
const globs = (s) => String(s || '').split(',').map((g) => g.trim()).filter(Boolean).slice(0, 20).map((g) => {
  if (g.length > 200 || /[\0\\]/.test(g) || /^[-/:!]/.test(g) || g.split('/').includes('..')) throw fail(400, 'a file pattern is not usable: it must stay inside the opened folder');
  return g;
});

/** The one line shown for a hit: at most LIMITS.text characters, around the match (cut: where it starts in the line). */
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
  const started = Date.now();
  const re = { source: patternSource({ q, regex, word }), flags: caseSensitive ? 'u' : 'iu' };
  // Plain text is escaped and always compiles; a regular expression is checked in the worker.
  const invalid = regex ? await patternError(re, LIMITS.ms) : null;
  if (invalid) throw fail(400, `that is not a valid regular expression (${invalid.replace(/^.*: /, '').toLowerCase()})`);
  const matches = [];
  const cache = new Map();
  // A line longer than the excerpt can hold matches the excerpt leaves out, and Replace All writes them all: such a
  // result says how many the whole line has (count), as the page's replace counts them (no empty match). ripgrep
  // gives its own count; the other lines are counted in the worker once the search is done.
  const toCount = [];
  let kept = 0;
  const add = (p, line, col, text, count) => {
    // Whatever an engine printed, a hit in a hidden or private folder, in git's folder or in a file with a sign-in is
    // never shown (an include pattern could otherwise bring them back).
    if (!showable(root, p, cache)) return true;
    if (matches.length >= LIMITS.matches) return false;
    const x = excerpt(text, col);
    const m = { path: p, line, ...x };
    if (x.cut !== undefined && count !== undefined) m.count = count;
    else if (x.cut !== undefined && kept + text.length <= LIMITS.countBytes) {
      kept += text.length;
      toCount.push([m, text.replace(/\r?\n$/, '')]);
    }
    matches.push(m);
    return matches.length < LIMITS.matches;
  };
  let pick = engine || (which('rg', env) ? 'rg' : (await repoOf(root, roots)).top ? 'git' : 'walk');
  let res = { timedOut: false };
  if (pick === 'rg') res = await viaRg(root, { q, regex, caseSensitive, word, inc, exc }, env, add);
  else if (pick === 'git') res = await viaGit(root, { q, regex, caseSensitive, word, inc, exc }, env, add);
  if (res.refused) pick = 'walk'; // the folder's git settings could not be read: no git here, the walk needs none
  if (pick === 'walk') {
    res = await walk(root, { mode: 'search', skip: SKIP, fold: FOLD, re, inc, exc, perFile: LIMITS.perFile, fileBytes: LIMITS.fileBytes, ms: LIMITS.ms },
      (hits) => hits.every(([p, line, col, text]) => add(p, line, col, text) !== false));
  }
  if (res.badPattern) throw fail(400, `that is not a valid regular expression: ${res.badPattern}`);
  if (res.invalid) throw fail(400, `that is not a valid regular expression (${res.invalid.replace(/^.*: /, '').toLowerCase()})`);
  if (res.tooHard) throw fail(400, 'that regular expression takes too long on a line of these files: make it simpler');
  if (toCount.length) {
    const counts = await countIn(re, toCount.map(([, t]) => t), Math.min(LIMITS.countMs, LIMITS.ms - (Date.now() - started)));
    if (counts) toCount.forEach(([m], i) => { m.count = counts[i]; });
  }
  return { engine: pick, matches, truncated: matches.length >= LIMITS.matches, timedOut: Boolean(res.timedOut), versions: await versionsOf(root, matches, roots) };
}

/**
 * The version (files.mjs versionOf) of each file with a hit, read once the search is done: Replace All saves over
 * that version, so a file changed after the search (and so after its preview) is skipped and named, never written.
 */
async function versionsOf(root, matches, roots) {
  const out = {};
  const paths = [...new Set(matches.map((m) => m.path))];
  let next = 0;
  // Read without blocking, a few files at a time: up to 2000 files of a megabyte, read in one go, held every
  // terminal and page of the dashboard for seconds.
  const reader = async () => {
    while (next < paths.length) {
      const p = paths[next++];
      try {
        // By the editor's own rules (a link that leads out of the roots is not read), and only what it would open.
        const at = resolveIn(root, p, roots);
        if ((await fs.promises.stat(at.abs)).size <= MAX_BYTES) out[p] = await versionOfFile(at.abs);
      } catch {
        /* gone or refused meanwhile: Replace All reads it again and says so */
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, reader));
  return out;
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
  // Through the reader: a folder's own git settings never start a program here. When it cannot read them, the walk.
  const c = (await repoOf(root, roots)).top && await readCommand(root, ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '--', '.', ...excludes(SKIP)], { env });
  if (c && !c.refused) {
    // Names with a quote, a backslash or a control character come back C-quoted: those are left out (keep).
    const r = await runLines(c.argv, { cwd: root, env: c.env, onLine: keep });
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
      // ripgrep's own count of the line's matches (its engine does not backtrack), without empty ones.
      return add(p, m.data.line_number, col, text, m.data.submatches.filter((x) => x.end > x.start).length);
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
  // Match Whole Word is ripgrep's word (words.js) through PCRE: git's own -w cuts a word at a joiner, a mark or a
  // superscript digit. (*UTF): characters, not bytes, whatever the locale. git's -w only where git has no PCRE.
  const pcre = !o.noPcre && (o.regex || o.word);
  const c = await readCommand(root, [
    'grep', '-n', '--column', '-I', '-z', '--untracked', '--exclude-standard', '--max-count', String(LIMITS.perFile),
    ...(o.caseSensitive ? [] : ['-i']), ...(pcre ? ['-P'] : o.regex ? ['-E'] : ['-F']), ...(!pcre && o.word ? ['-w'] : []),
    '-e', pcre ? `(*UTF)${patternSource(o)}` : o.q, '--', ...pathspecs,
  ], { env });
  if (c.refused) return { refused: c.refused };
  const r = await runLines(c.argv, {
    cwd: root, env: c.env,
    onLine: (l) => {
      const [p, line, col, ...rest] = l.split('\0');
      if (!p || !line) return true;
      const text = rest.join('\0');
      // git counts the column in bytes; the page counts characters.
      return add(p, Number(line), Buffer.from(text).subarray(0, Math.max(0, Number(col) - 1)).toString('utf8').length + 1, text);
    },
  });
  // git built without PCRE (or with one too old for the word's classes): POSIX extended expressions and git's -w.
  if (r.code === 128 && pcre && /not built with|support for perl|USE_LIBPCRE|unknown property/i.test(r.err)) return viaGit(root, { ...o, noPcre: true }, env, add);
  // PCRE's own stop for a pattern that backtracks too long (a JIT stack or match limit): not a bad pattern.
  if (r.code === 128 && !r.stopped && /match limit|JIT stack|pcre2?_(jit_)?match/i.test(r.err)) return { tooHard: true };
  if (r.code === 128 && !r.stopped && /regex|pattern|PCRE|parse/i.test(r.err)) return { badPattern: r.err.split('\n')[0] };
  return r;
}
