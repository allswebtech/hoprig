// Find in files for the editor: ripgrep when this computer has it, else `git grep` inside a repository, else a plain
// walk in JavaScript. Each skips git's folder, installed packages, private folders and binary files, and stops at the
// limits below (a running program is killed there, never buffered whole).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { which } from '../setup/system.mjs';
import { repoOf } from './git.mjs';
import { HIDDEN, PRIVATE_DIRS, fail, rootOf } from './paths.mjs';
import { isBinary } from './files.mjs';

export const LIMITS = { matches: 2000, perFile: 50, ms: 10_000, text: 200, fileBytes: 1024 * 1024, query: 500 };
const SKIP = [...HIDDEN, ...PRIVATE_DIRS];

/** "src/**, *.md" → ['src/**', '*.md']: the page's include / exclude boxes. */
const globs = (s) => String(s || '').split(',').map((g) => g.trim()).filter(Boolean).slice(0, 20).map((g) => {
  if (g.length > 200 || /[\0\\]/.test(g) || g.startsWith('-')) throw fail(400, 'a file pattern is not usable');
  return g;
});

/** A glob as a RegExp over a relative path; a pattern without "/" matches the name at any depth (as in VS Code). */
export function globRe(g) {
  let s = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      s += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') s += '[^/]*';
    else if (c === '?') s += '[^/]';
    else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(g.includes('/') ? `^${s}(/.*)?$` : `(^|/)${s}(/.*)?$`);
}

/** The one line shown for a hit: at most LIMITS.text characters, around the match. */
function excerpt(line, col) {
  const text = line.replace(/\r?\n$/, '');
  if (text.length <= LIMITS.text) return { text, col };
  const start = Math.max(0, Math.min(col - 1 - 40, text.length - LIMITS.text));
  return { text: text.slice(start, start + LIMITS.text), col: col - start, cut: start };
}

/** Run a search program, line by line, until it ends, the match limit or the time limit. */
function runLines(argv, { cwd, env, onLine }) {
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
    throw fail(400, `that is not a valid regular expression: ${e.message}`);
  }
  const matches = [];
  const add = (p, line, col, text) => {
    if (matches.length >= LIMITS.matches) return false;
    matches.push({ path: p, line, ...excerpt(text, col) });
    return matches.length < LIMITS.matches;
  };
  const pick = engine || (which('rg', env) ? 'rg' : (await repoOf(root, roots)).top ? 'git' : 'walk');
  let res = { timedOut: false };
  if (pick === 'rg') res = await viaRg(root, { q, regex, caseSensitive, word, inc, exc }, env, add);
  else if (pick === 'git') res = await viaGit(root, { q, regex, caseSensitive, word, inc, exc }, env, add);
  else res = await viaWalk(root, re, { inc, exc }, add);
  if (res.badPattern) throw fail(400, `that is not a valid regular expression: ${res.badPattern}`);
  return { engine: pick, matches, truncated: matches.length >= LIMITS.matches, timedOut: Boolean(res.timedOut) };
}

async function viaRg(root, o, env, add) {
  const argv = [
    'rg', '--json', '--hidden', '--max-count', String(LIMITS.perFile), '--max-filesize', '1M', '--max-columns', '1000',
    o.caseSensitive ? '--case-sensitive' : '--ignore-case', ...(o.regex ? [] : ['--fixed-strings']), ...(o.word ? ['--word-regexp'] : []),
    ...SKIP.flatMap((d) => ['--glob', `!${d}`]), // a name without "/" is that folder at any depth
    ...o.inc.flatMap((g) => ['--glob', g]), ...o.exc.flatMap((g) => ['--glob', `!${g}`]),
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
      const p = m.data.path.text.replace(/^\.\//, '');
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
  const pathspecs = [
    ...(o.inc.length ? o.inc.map((g) => `:(glob)${g.includes('/') ? g : `**/${g}`}`) : ['.']),
    ...o.exc.map((g) => `:(exclude,glob)${g.includes('/') ? g : `**/${g}`}`),
    ...SKIP.map((d) => `:(exclude,glob)**/${d}/**`),
  ];
  const argv = [
    'git', 'grep', '-n', '--column', '-I', '-z', '--untracked', '--exclude-standard', '--max-count', String(LIMITS.perFile),
    ...(o.caseSensitive ? [] : ['-i']), ...(o.regex ? ['-P'] : o.ere ? ['-E'] : ['-F']), ...(o.word ? ['-w'] : []), '-e', o.q, '--', ...pathspecs,
  ];
  const r = await runLines(argv, {
    cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
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

async function viaWalk(root, re, { inc, exc }, add) {
  const until = Date.now() + LIMITS.ms;
  const incRe = inc.map(globRe);
  const excRe = exc.map(globRe);
  const stack = [''];
  while (stack.length) {
    if (Date.now() > until) return { timedOut: true };
    const rel = stack.pop();
    let list;
    try {
      list = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    list.sort((a, b) => b.name.localeCompare(a.name));
    for (const d of list) {
      if (SKIP.includes(d.name)) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (excRe.some((x) => x.test(p))) continue;
      if (d.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!d.isFile() || (incRe.length && !incRe.some((x) => x.test(p)))) continue;
      let buf;
      try {
        const full = path.join(root, p);
        if (fs.statSync(full).size > LIMITS.fileBytes) continue;
        buf = fs.readFileSync(full);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      let inFile = 0;
      for (let i = 0; i < lines.length && inFile < LIMITS.perFile; i++) {
        const m = re.exec(lines[i]);
        if (!m) continue;
        inFile++;
        if (!add(p, i + 1, m.index + 1, lines[i])) return {};
      }
    }
  }
  return {};
}
