// Validators for every value that arrives from the browser. Each returns the clean value or null; callers turn
// null into a 400. Nothing from the browser reaches tmux, ps or the file system without passing one of these.
import path from 'node:path';
import { listProfiles } from '../profiles.mjs';
import { isSessionId } from '../sessions.mjs';

/** A session name as the browser may send it. The backend has the final say (backend.validName) when creating. */
export const SESSION_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,39}$/; // never starts with "-" (would look like an option)

export const sessionName = (v) => (typeof v === 'string' && SESSION_NAME_RE.test(v) ? v : null);
export const sessionId = (v) => (isSessionId(v) ? v : null);

/** A profile name is only valid when that profile exists right now. Returns the full profile (server side only). */
export function profile(v, profiles = listProfiles()) {
  if (typeof v !== 'string') return null;
  return profiles.find((p) => p.name === v) || null;
}

/** A pid of a process (not 0, 1 or negative, which mean "process groups" or "everyone" to kill()). */
export const pid = (v) => (Number.isInteger(v) && v > 1 && v < 2 ** 31 ? v : null);

/** Text for the message box: a string, at most 32 KiB, without NUL (tmux arguments are C strings). */
export const MESSAGE_MAX = 32 * 1024;
export function message(v) {
  if (typeof v !== 'string' || !v.length || v.includes('\0')) return null;
  return Buffer.byteLength(v) <= MESSAGE_MAX ? v : null;
}

/**
 * A chat's own name as the chat keeps it (POST /api/chats title): one line, no control characters, at most 80
 * characters. Whoever looks an open chat up by the name it gave it compares with this, not with what it sent.
 */
export const chatTitle = (v) => String(v).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** An absolute path string (existence and root containment are checked by folders.mjs). */
export function absPath(v) {
  if (typeof v !== 'string' || !path.isAbsolute(v) || v.includes('\0') || v.length > 4096) return null;
  return v;
}

/** Turn any text (a folder name) into a usable tmux session name: tmux-safe characters, no "." or ":". */
export function safeSessionName(text, fallback = 'session') {
  const s = String(text || '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return s || fallback;
}

/** The first of base, base-2, base-3 ... that is not in `taken`. */
export function uniqueName(base, taken) {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const n = `${base.slice(0, 36)}-${i}`;
    if (!set.has(n)) return n;
  }
  return `${base.slice(0, 30)}-${Date.now().toString(36)}`;
}
