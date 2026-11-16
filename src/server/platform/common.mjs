// Helpers shared by the per-OS platform modules. Every external command runs through execFile with an argument
// array, never through a shell.
import { execFile, execFileSync } from 'node:child_process';

/** Run a command; never rejects. LC_ALL=C keeps number and date formats the parsers expect. */
export const run = (cmd, args, { timeout = 5000, env } = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 << 20, windowsHide: true, env: env || { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: stdout || '', stderr: (stderr || (err && err.message) || '').trim() }),
    );
  });

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
const SHAPES = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})|\bsk-[A-Za-z0-9_-]{8,}/g;
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
