// Secrets never pass through the model: no tool takes or returns a token, key or password. These helpers are
// the last line of that rule: tool inputs that look like a secret are refused, and text that goes back to the
// model or into the audit log has anything secret-shaped masked.

// Values that are secrets by their shape alone.
const SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys and OAuth tokens
  /\bsk-[A-Za-z0-9_-]{16,}/g, // other providers' API keys
  /\bhop_[A-Za-z0-9_-]{20,}/g, // hoprig machine tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
// A value after a secret-sounding name: TOKEN=…, api_key: …, --password …, Authorization: Bearer …
const NAMED = /(\b[\w-]*(?:token|api[-_]?key|secret|passw(?:or)?d|credential)[\w-]*["']?\s*(?:=|:)\s*["']?|\bBearer\s+|--(?:token|password|api-key)[= ]\s*)([^\s"'&]{6,})/gi;

/** Mask everything secret-shaped in `text`. */
export function redact(text) {
  let s = String(text);
  for (const re of SHAPES) s = s.replace(re, '***');
  return s.replace(NAMED, (m, name) => `${name}***`);
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
