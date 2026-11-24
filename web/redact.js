// The secret shapes of src/assistant/secrets.mjs (redact), for text the page draws itself from what the poller read (a
// session's note on Tia's status card): a key is masked there as in the server's own card text. test/server/web-tiacards
// keeps these equal to the server's. They are built from strings, so a browser that cannot read one of them (lookbehind)
// still loads the page: then redact gives null and the caller shows no such text.
const SHAPES = [
  String.raw`\bsk-ant-[A-Za-z0-9_-]{8,}`,
  String.raw`\bsk-[A-Za-z0-9_-]{16,}`,
  String.raw`\bhop_[A-Za-z0-9_-]{20,}`,
  String.raw`\bhwc_[0-9a-f]{64}\b`,
  String.raw`\bhwt_[A-Za-z0-9_-]{20,}`,
  String.raw`\btia_[A-Za-z0-9_-]{20,}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
  String.raw`\bsk_(?:live|test)_[A-Za-z0-9]{10,}`,
  String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
  String.raw`\bnpm_[A-Za-z0-9]{30,}`,
  String.raw`(?<=\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(?=@)`,
  String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\beyJ(?:(?!-eyJ)[A-Za-z0-9_-]){10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`,
];
const NAMED = String.raw`((?<![\w-])(?=[\w-]*?(?:token|api[-_]?key|secret|passw(?:or)?d|credential))[\w-]+["']?\s*(?:=|:)\s*["']?|\bBearer\s+|--(?:token|password|api-key)[= ]\s*)([^\s"'&]{6,})`;

// The characters the server takes out before it looks for a key (src/assistant/fence.mjs HIDDEN_PATTERNS, in its
// order): terminal codes, then control and invisible characters. A key with a zero-width space or a soft hyphen inside
// is a key all the same once they are out.
const HIDDEN = [
  String.raw`\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]`,
  String.raw`[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}\u{e0000}-\u{e007f}\ufe00-\ufe0f\u{e0100}-\u{e01ef}]`,
];

let built = null;
try {
  built = { hidden: [new RegExp(HIDDEN[0], 'g'), new RegExp(HIDDEN[1], 'gu')], shapes: SHAPES.map((s) => new RegExp(s, 'g')), named: new RegExp(NAMED, 'gi') };
} catch {
  built = null;
}

/** `text` with everything secret-shaped masked, as the server's redact does; null when this browser cannot tell. */
export function redact(text) {
  if (!built) return null;
  let s = String(text);
  for (const re of built.hidden) s = s.replace(re, '');
  s = s.normalize('NFC');
  for (const re of built.shapes) s = s.replace(re, '***');
  return s.replace(built.named, (m, name) => `${name}***`);
}

/** The patterns, for the test that keeps them equal to the server's. */
export const PATTERNS = { hidden: HIDDEN, shapes: SHAPES, named: NAMED };
