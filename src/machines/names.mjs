// Validation for what the user types when adding a computer: its short name, an SSH target and a dashboard
// address. Everything that later reaches a command line or a URL passes one of these first.

/** The short name a machine is known by in URLs (/m/<name>/...) and on the command line. */
export const MACHINE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const machineName = (v) => (typeof v === 'string' && MACHINE_RE.test(v) ? v : null);

/** A display name: one line, 1-40 characters, no control characters. */
export function label(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 40 && !/[\u0000-\u001f\u007f]/.test(s) ? s : null;
}

/** A host name or free text turned into a machine name: "Alexs-MacBook.local" -> "alexs-macbook". */
export function slug(text, fallback = 'computer') {
  const s = String(text || '')
    .split('.')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|-+$/g, '')
    .slice(0, 32);
  return machineName(s) || fallback;
}

/** The first of base, base-2, base-3 ... that is not in `taken`. */
export function uniqueSlug(base, taken) {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base.slice(0, 28)}-${i}`;
    if (!set.has(n)) return n;
  }
  return `${base.slice(0, 20)}-${Date.now().toString(36)}`;
}

/**
 * An SSH destination: "host", "user@host", a name from ~/.ssh/config, or "ssh://user@host:port". Never starts
 * with "-" (ssh would read it as an option) and never holds spaces, quotes or shell characters, because it is
 * also shown in commands the user may copy.
 */
const SSH_RE = /^(?:ssh:\/\/)?(?:[A-Za-z0-9._][A-Za-z0-9._+-]{0,63}@)?(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,252}|\[[0-9A-Fa-f:.]{2,45}\])$/;
const SSH_URL_PORT_RE = /^ssh:\/\/(?:[A-Za-z0-9._][A-Za-z0-9._+-]{0,63}@)?(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,252}|\[[0-9A-Fa-f:.]{2,45}\]):(\d{1,5})$/;
export function sshTarget(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 300) return null;
  if (SSH_RE.test(s)) return s;
  const m = SSH_URL_PORT_RE.exec(s);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 65535) return s;
  return null;
}

/** The host part of an SSH target, for a default machine name before the machine has told us its own. */
export const sshHost = (t) => t.replace(/^ssh:\/\//, '').replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

/**
 * A dashboard address: http(s), no user name or password in it, no query. A path is kept (a reverse proxy can
 * serve the dashboard under one). Returned without the trailing slash.
 */
export function dashboardUrl(v) {
  if (typeof v !== 'string' || v.length > 500) return null;
  let u;
  try {
    u = new URL(v.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** A token's name as the other side gives it (its host name): one line, at most 60 characters. */
export function tokenName(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s.length <= 60 && /^[A-Za-z0-9 ._@()-]+$/.test(s) ? s : null;
}
