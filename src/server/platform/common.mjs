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

// Secrets sometimes ride on command lines (--token=…, API keys). The browser only gets a masked, clipped copy.
const SECRET_RE = /(\b[\w-]*(?:token|api[-_]?key|secret|passw(?:or)?d)[\w-]*(?:=|:\s*|\s+)|\bBearer\s+)\S+|\bsk-[A-Za-z0-9_-]{8,}/gi;
export const redact = (s, max = 160) => {
  const masked = String(s).replace(SECRET_RE, (m, keep) => (keep ? `${keep}***` : '***'));
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
