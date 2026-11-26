// Helpers shared by the per-OS platform modules. Every external command runs through execFile (or spawn) with an argument
// array, never through a shell.
import { execFile, execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { startInTurn } from '../../oneturn.mjs';

const MAX_OUTPUT = 8 << 20;

/**
 * Run a command; never rejects. LC_ALL=C keeps number and date formats the parsers expect. `noTerminal`: the command
 * runs in a session of its own, without the dashboard's terminal (when it was started in one), so a program that asks
 * for a password on the terminal itself (unzip, bsdtar) fails at once instead of waiting there for keys.
 */
export const run = (cmd, args, { timeout = 5000, env, noTerminal = false } = {}) => {
  const e = env || { ...process.env, LC_ALL: 'C' };
  if (noTerminal && process.platform !== 'win32') return runAlone(cmd, args, { timeout, env: e });
  return new Promise((resolve, reject) => {
    // One start per turn of the server's thread (oneturn.mjs startInTurn): the snapshot's df, ps and ss started together.
    // A program that failed without a word on stderr is named with how it ended (Node's "Command failed: <line>" alone
    // says nothing of why: an exit code, a signal, the time limit).
    startInTurn(() => execFile(cmd, args, { timeout, maxBuffer: MAX_OUTPUT, windowsHide: true, env: e }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: (stderr || (err && `${err.message.trim()}${endedHow(err)}`) || '').trim() }),
    )).catch(reject);
  });
};

/** How a program that failed ended, for its error line: " (exit code 1)", " (ended by SIGTERM)", " (killed: it took too long)". */
export function endedHow(err) {
  if (!err) return '';
  if (err.killed) return ' (killed: it took too long)';
  if (err.signal) return ` (ended by ${err.signal})`;
  return Number.isInteger(err.code) ? ` (exit code ${err.code})` : '';
}

/**
 * run() in a new session (execFile cannot start one): setsid leaves the terminal behind, and past the time limit the
 * whole group ends, the programs it started too (tar's gzip). Same answer as run().
 */
function runAlone(cmd, args, { timeout, env }) {
  // Only the start is in the turn (startInTurn): the program's run and its answer are awaited outside it.
  return new Promise((resolve) => startInTurn(() => {
    let child;
    try {
      child = spawn(cmd, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: err.message });
      return;
    }
    const out = [[], []];
    let size = 0;
    let why = '';
    const end = (reason) => {
      if (why) return;
      why = reason;
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* it ended already */
      }
    };
    const take = (i) => (b) => {
      size += b.length;
      if (size > MAX_OUTPUT) end('its output was too long');
      else out[i].push(b);
    };
    child.stdout.on('data', take(0));
    child.stderr.on('data', take(1));
    const timer = setTimeout(() => end(`it took longer than ${Math.round(timeout / 1000)} s`), timeout);
    let done = false;
    const finish = (ok, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stderr = Buffer.concat(out[1]).toString().trim();
      resolve({ ok: ok && !why, stdout: Buffer.concat(out[0]).toString(), stderr: stderr || why || extra });
    };
    child.on('error', (err) => finish(false, err.message)); // ENOENT: not installed
    child.on('close', (code, signal) => finish(code === 0, signal ? `ended by ${signal}` : `exit code ${code}`));
  }).catch((err) => resolve({ ok: false, stdout: '', stderr: err.message })));
}

/** The synchronous twin, for the few callers that must answer at once. Returns stdout, or null on failure. */
export function runSync(cmd, args, { timeout = 5000 } = {}) {
  try {
    return execFileSync(cmd, args, { timeout, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
  } catch {
    return null;
  }
}

// Secrets sometimes ride on command lines and in log lines (--token=…, API keys, a password in a URL). The browser
// only gets a masked, clipped copy. In the order applied:
//   a URL's password                 scheme://user:pass@host      → scheme://user:***@host
//   values with a secret's shape     GitHub, GitLab, Slack, AWS, Google, OpenAI-style keys, JWTs
//   a value after a secret's name    --token=…, PASSWORD=…, api_key: …, Bearer …, Basic …
//   passwords given as options       mysql -pSECRET, curl -u user:SECRET, sshpass -p SECRET
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:@/'"]*:)[^\s@/'"]+@/gi;
const SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})|\bsk-[A-Za-z0-9_-]{8,}|\bhbt_[A-Za-z0-9_-]{20,}/g;
const SECRET_RE = /(\b[\w-]*(?:token|api[-_]?key|secret|passw(?:or)?d)[\w-]*(?:=|:\s*|\s+)|\bBearer\s+)\S+|\b(Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi;
const OPTION_PASSWORDS = [
  // mysql, mariadb and their tools take the password glued to -p
  [/(\b(?:mysql\w*|mariadb\w*)\b.*?\s-p)(?!\s)\S+/gi, '$1***'],
  // curl and others: -u / --user name:password
  [/(\s(?:-u|--user)(?:\s+|=)[^\s:]+:)\S+/g, '$1***'],
  // sshpass -p password
  [/(\bsshpass\b(?:\s+-[a-oq-zA-Z]\S*)*\s+-p\s*)\S+/g, '$1***'],
];
export const redact = (s, max = 160) => {
  let masked = String(s).replace(URL_PASSWORD, '$1***@').replace(SHAPES, '***').replace(SECRET_RE, (m, keep, basic) => `${keep || basic}***`);
  for (const [re, to] of OPTION_PASSWORDS) masked = masked.replace(re, to);
  return masked.length > max ? masked.slice(0, max - 1) + '…' : masked;
};

/** One row per port and owner (IPv4 and IPv6 listeners of one program count once), sorted by port. */
export function uniquePorts(rows) {
  const seen = new Set();
  return rows
    .filter((r) => {
      const k = `${r.port}|${r.pid}`;
      return seen.has(k) ? false : seen.add(k);
    })
    .sort((a, b) => a.port - b.port);
}

/** "127.0.0.1:80", "[::1]:80", "*:80" (lsof, ss) → { addr, port }. */
export function splitHostPort(s, sep = ':') {
  const i = s.lastIndexOf(sep);
  if (i < 0) return null;
  const port = Number(s.slice(i + 1));
  if (!Number.isInteger(port)) return null;
  return { addr: s.slice(0, i), port };
}

/** The 12 biggest by `key`, with `mine` set by the caller's rule. */
export const top = (procs, key, isMine) =>
  [...procs].sort((a, b) => b[key] - a[key]).slice(0, 12).map((p) => ({ ...p, mine: p.pid !== process.pid && isMine(p) }));

/**
 * True when `pid` is `ancestor` or runs below it. When the very first lookup fails (no process table on this
 * system) the answer is true, so callers fall back to trusting the terminal id alone.
 */
export function descendsFrom(pid, ancestor, parentOf) {
  let p = pid;
  for (let i = 0; i < 64 && p && p > 1; i++) {
    if (p === ancestor) return true;
    const next = parentOf(p);
    if (next === null || next === undefined) return i === 0;
    p = next;
  }
  return false;
}

/** A parentOf() function over a pid → parent pid map taken at one moment. */
export const lookupFrom = (map) => (pid) => (map.has(pid) ? map.get(pid) : null);

/** `ps -A -o pid=,ppid=` (Linux and macOS) → Map(pid → parent pid). */
export function parseParents(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/**
 * How paths compare on `platform`: Windows and macOS disks ignore letter case by default, Windows takes "\" and "/"
 * and names drives (D:\work). → { fold, same(a, b), within(p, top), forms(p) }: `forms` are the spellings a file may
 * hold of one folder (on Windows with either slash and the drive letter in either case), for a search of old paths.
 */
export function pathRules(platform = process.platform) {
  const win = platform === 'win32';
  const p = win ? path.win32 : path.posix;
  const fold = win || platform === 'darwin';
  const norm = (s) => {
    const r = p.resolve(String(s)).replace(/[\\/]+$/, '') || p.sep;
    return fold ? r.toLowerCase() : r;
  };
  const same = (a, b) => norm(a) === norm(b);
  const within = (x, top) => {
    const a = norm(x);
    const b = norm(top);
    return a === b || a.startsWith(b.endsWith(p.sep) ? b : b + p.sep);
  };
  const forms = (s) => {
    const r = p.resolve(String(s));
    const out = new Set([r]);
    if (win) {
      out.add(r.replace(/\\/g, '/'));
      out.add(r.replace(/\\/g, '\\\\')); // as JSON and many config files write it
      for (const f of [...out]) if (/^[A-Za-z]:/.test(f)) out.add((f[0] === f[0].toUpperCase() ? f[0].toLowerCase() : f[0].toUpperCase()) + f.slice(1));
    }
    return [...out];
  };
  return { win, fold, path: p, same, within, forms };
}
