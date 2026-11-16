// Is the dashboard password strong enough for a page anyone on the internet can reach (the public link)?
//
// Only the hash is stored, so the password itself is judged when Hoprig sees it: when it is set (`hoprig passwd`,
// Settings → Security) and at a sign-in with it. What was found is kept next to the hash as
// server.passwordCheck = { tag, strong, why }; `tag` ties it to that hash, so a new password is judged again. The
// password is never kept, and neither is anything that would help to guess it.
import crypto from 'node:crypto';
import { loadConfig, saveConfig } from '../config.mjs';

export const MIN_STRONG = 12;

// Passwords people choose first (and the product's own name): never strong, whatever their length.
const COMMON = new Set([
  'password', 'passw0rd', 'password1', 'password12', 'password123', 'password1234', 'qwerty', 'qwertyuiop', 'qwerty123',
  'qwerty123456', 'letmein', 'welcome', 'welcome123', 'admin', 'admin123', 'administrator', 'iloveyou', 'monkey',
  'dragon', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'trustno1', 'changeme', 'secret', 'default',
  'hoprig', 'hoprig123', 'dashboard', '123456789012', '1234567890', '111111111111', '000000000000', 'abc123',
  'abcdefghijkl', '1q2w3e4r5t6y', 'zaq12wsxcde3',
]);

/** Why `pw` is not strong enough for a public link, in plain words; null when it is. */
export function passwordProblem(pw) {
  if (typeof pw !== 'string' || !pw) return 'there is no password';
  const p = pw.normalize('NFKC');
  if ([...p].length < MIN_STRONG) return `it has fewer than ${MIN_STRONG} characters`;
  const low = p.toLowerCase();
  // The common word itself, or one with only digits or symbols around it ("Password2026!").
  const core = low.replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (COMMON.has(low) || COMMON.has(core)) return 'it is one of the passwords people try first';
  if (new Set(p).size < 5) return 'it repeats a few characters';
  if (isRun(low)) return 'it is a simple sequence';
  return null;
}

// "abcdefghijkl", "123456789012", "987654321098": each character one step from the one before.
function isRun(s) {
  const c = [...s].map((ch) => ch.codePointAt(0));
  const d = c.slice(1).map((x, i) => x - c[i]);
  return d.every((x) => x === d[0] && Math.abs(x) === 1) || /^(?:0123456789|1234567890|9876543210)+\d{0,9}$/.test(s);
}

/** The tag that ties a check to one password hash (16 hex characters of its SHA-256). */
export const hashTag = (hash) => crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 16);

/** 'none' | 'unknown' | 'weak' | 'strong', with `why` for weak: what is known of the stored password. */
export function passwordState(server = loadConfig().server) {
  const h = server.passwordHash;
  if (typeof h !== 'string' || !h.startsWith('scrypt$')) return { state: 'none', why: null };
  const c = server.passwordCheck;
  if (!c || typeof c !== 'object' || c.tag !== hashTag(h)) return { state: 'unknown', why: null };
  return c.strong === true ? { state: 'strong', why: null } : { state: 'weak', why: typeof c.why === 'string' ? c.why : 'it is too easy to guess' };
}

/**
 * Keep what `pw` (the password of `hash`) is like. Written only when it changed, so a sign-in does not rewrite the
 * config every time. Never throws: the check is a help, not a reason for a sign-in to fail.
 */
export function notePassword(pw, hash = loadConfig().server.passwordHash) {
  try {
    const why = passwordProblem(pw);
    const next = { tag: hashTag(hash), strong: !why, ...(why ? { why } : {}) };
    const cur = loadConfig().server.passwordCheck;
    if (!cur || cur.tag !== next.tag || cur.strong !== next.strong) saveConfig({ server: { passwordCheck: next } });
    return next;
  } catch {
    return null;
  }
}
