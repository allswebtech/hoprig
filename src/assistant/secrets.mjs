// Secrets never pass through the model: no tool takes or returns a token, key or password. These helpers are
// the last line of that rule: tool inputs that look like a secret are refused, and text that goes back to the
// model or into the audit log has anything secret-shaped masked.

// Values that are secrets by their shape alone (web/redact.js has the same, for the page; a test keeps them equal).
export const SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys and OAuth tokens
  /\bsk-[A-Za-z0-9_-]{16,}/g, // other providers' API keys
  /\bhop_[A-Za-z0-9_-]{20,}/g, // hoprig machine tokens
  /\bhwc_[0-9a-f]{64}\b/g, // hoprig's command token (`hoprig tasks do`)
  /\bhwt_[A-Za-z0-9_-]{20,}/g, // a Work token (another program, src/work/access.mjs)
  /\btia_[A-Za-z0-9_-]{20,}/g, // Tia's token
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained tokens
  /\bsk_(?:live|test)_[A-Za-z0-9]{10,}/g, // payment providers' secret keys
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\bnpm_[A-Za-z0-9]{30,}/g, // npm tokens
  /(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)/g, // the password in a URL (https://user:password@host)
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  // JWTs. The first part ends before a "-eyJ", where the next try starts: else each "eyJ" after a hyphen read the rest
  // of the run again ("eyJ-eyJ-…" took time with the square of its length). A real header never holds "-eyJ"; if one
  // did, the part before it would stay and the rest of the token would still be masked.
  /\beyJ(?:(?!-eyJ)[A-Za-z0-9_-]){10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
// A value after a secret-sounding name: TOKEN=…, api_key: …, --password …, Authorization: Bearer …
// The name is a whole run of word characters and hyphens that holds one of the words (found by the lookahead): read
// once from the run's start. (As "\b[\w-]*word[\w-]*" it started again at every "\b" and every word in the run, and
// "a-a-a-…" or "tokentoken…" took time with the square of their length.)
export const NAMED = /((?<![\w-])(?=[\w-]*?(?:token|api[-_]?key|secret|passw(?:or)?d|credential))[\w-]+["']?\s*(?:=|:)\s*["']?|\bBearer\s+|--(?:token|password|api-key)[= ]\s*)([^\s"'&]{6,})/gi;

/** Mask everything secret-shaped in `text`. */
export function redact(text) {
  let s = String(text);
  for (const re of SHAPES) s = s.replace(re, '***');
  return s.replace(NAMED, (m, name) => `${name}***`);
}

/** What stands where a key was in the owner's own message, and the one line she says about it. */
export const KEY_MARK = '[key removed]';
export const KEY_NOTE = 'A key was in your message. It was not kept or sent. If it was a real one, revoke it.';

/**
 * The owner's message as it may go on: every secret-shaped part replaced by KEY_MARK (a value after a secret-sounding
 * name only when it looks random, as looksSecret reads it: MAX_TOKENS=200000 stays). → { text, found }
 */
export function maskInput(text) {
  let found = false;
  let s = String(text);
  for (const re of SHAPES) s = s.replace(re, () => ((found = true), KEY_MARK));
  s = s.replace(NAMED, (m, name, v) => {
    if (v.length >= 16 && /[A-Za-z]/.test(v) && /\d/.test(v)) {
      found = true;
      return name + KEY_MARK;
    }
    return m;
  });
  return { text: s, found };
}

/** True when `text` carries something that looks like a secret (an input the assistant must not pass on). */
export function looksSecret(text) {
  const s = String(text);
  if (SHAPES.some((re) => new RegExp(re.source).test(s))) return true;
  // After a secret-sounding name, only a random-looking value counts: "MAX_TOKENS=200000" is not a secret.
  for (const m of s.matchAll(new RegExp(NAMED.source, 'gi'))) {
    const v = m[2];
    if (v.length >= 16 && /[A-Za-z]/.test(v) && /\d/.test(v)) return true;
  }
  return false;
}

const SECRET_KEY = /token|secret|passw|api[-_]?key|authorization|cookie|credential/i;

/** A deep copy for the audit log: secret-named keys masked, secret-shaped values masked, long text clipped. */
export function maskForAudit(value, depth = 0) {
  if (depth > 6) return '…';
  if (typeof value === 'string') {
    const r = redact(value);
    return r.length > 2000 ? r.slice(0, 1999) + '…' : r;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((x) => maskForAudit(x, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '***' : maskForAudit(v, depth + 1);
    return out;
  }
  return value;
}

/** Every string inside a (validated) input value, for the looksSecret check. */
export function stringsIn(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const x of value) stringsIn(x, out);
  else if (value && typeof value === 'object') for (const x of Object.values(value)) stringsIn(x, out);
  return out;
}
