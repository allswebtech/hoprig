// Fences for untrusted text. Everything that comes out of a terminal, a file or folder name, a session title, a
// remote machine or a web page is DATA, never instructions. Tool results put such text inside a fence:
//
//   <untrusted_terminal_output session="api-fix">…what the screen shows…</untrusted_terminal_output>
//   <untrusted_data tool="list_sessions">{…JSON…}</untrusted_data>
//
// and the system prompt (prompt.mjs) says that nothing inside a fence can authorise an action, change the goal or
// reveal a secret. The text inside cannot close the fence early: every "<" that starts something looking like an
// untrusted_ tag (also full-width and small "<" look-alikes, any case, spaces or a slash in between) is replaced
// by "‹", and in the JSON fence every "<" at all is escaped as \u003c (still valid JSON, still readable).
import { SHAPES, redact } from './secrets.mjs';

const TAG_START = /[<\uFF1C\uFE64\u2039\u3008]\s*\/?\s*untrusted/gi;
// ANSI escapes and other control characters (tab and newline kept): a screen dump must not carry terminal codes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
// Control characters (C0 and C1; tab and newline kept) and the characters nobody can see that can hide words in a text:
// every format character (Cf: zero-width and joiners, direction marks, embeddings and isolates, the soft hyphen, U+180E,
// the byte-order mark, the tag characters), the whole tag block U+E0000-U+E007F and the variation selectors.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}\u{e0000}-\u{e007f}\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/gu;

export const FENCE_KINDS = ['terminal_output', 'data', 'command_output', 'file', 'review'];

const hiddenOut = (text) => text.replace(ANSI, '').replace(CONTROL, '');
/** The two patterns hiddenOut takes out, in its order (web/redact.js runs the same ones; a test keeps them equal). */
export const HIDDEN_PATTERNS = Object.freeze([ANSI, CONTROL]);

/**
 * Text without control codes, direction marks, hidden characters or forged fence tags; its words as they are. Once is
 * enough: stripped(stripped(t)) is stripped(t) (NFC comes after the removal, which can bring a letter and its accent
 * together).
 */
export function stripped(text) {
  return hiddenOut(String(text ?? '')).normalize('NFC').replace(TAG_START, (m) => '‹' + m.slice(1));
}

/** What a card says when her text had characters nobody can see (web/tia.js shows it in the card's words). */
export const HIDDEN_REMOVED = 'Hidden characters were removed from this text.';

/**
 * A tool call's input as it comes in, cleaned once at the door: every string as stripped() makes it, so what a card
 * shows and what the run sends are one value. → { value, changed (characters nobody can see were taken out) }
 */
export function cleanInput(value) {
  let changed = false;
  const each = (v) => {
    if (typeof v === 'string') {
      if (hiddenOut(v) !== v) changed = true;
      return stripped(v);
    }
    if (Array.isArray(v)) return v.map(each);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, each(x)]));
    return v;
  };
  return { value: each(value), changed };
}

/** Text made safe to sit inside a fence: no control codes, no forged fence tags, secrets masked, clipped. */
export function neutralize(text, max = 20_000) {
  let s = redact(stripped(text));
  if (s.length > max) s = '…' + s.slice(s.length - max + 1); // a screen's newest lines matter most
  return s;
}

/**
 * The last line before a tool result goes to the model: every secret-shaped part of the whole text (summary, fences,
 * errors) is masked, whatever an earlier step let through. Only the shapes, so the JSON in a fence stays valid.
 */
export function maskShapes(text) {
  let s = String(text ?? '');
  for (const re of SHAPES) s = s.replace(re, '***');
  return s;
}

const attrValue = (v) => String(v).replace(/[^A-Za-z0-9_.:/@~ -]/g, '_').slice(0, 80);

function open(kind, attrs) {
  if (!FENCE_KINDS.includes(kind)) throw new Error(`unknown fence kind ${kind}`);
  const a = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${attrValue(v)}"`)
    .join('');
  return `<untrusted_${kind}${a}>`;
}

/** Fence raw text (a screen, a command's output, a skill body). */
export function fence(kind, attrs, text, max) {
  return `${open(kind, attrs)}\n${neutralize(text, max)}\n</untrusted_${kind}>`;
}

/** JSON whose every "<" is escaped, so no string inside can form a tag of any kind. */
export function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

/** Fence a structured result. Strings inside are redacted (secrets) and stripped of control codes first. */
export function fenceData(attrs, value) {
  return `${open('data', attrs)}${safeJson(clean(value))}</untrusted_data>`;
}

function clean(v, depth = 0) {
  if (typeof v === 'string') return redact(v.replace(ANSI, '').replace(CONTROL, ''));
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object' && depth < 8) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x, depth + 1)]));
  return v;
}
