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
import { redact } from './secrets.mjs';

const TAG_START = /[<\uFF1C\uFE64\u2039\u3008]\s*\/?\s*untrusted/gi;
// ANSI escapes and other control characters (tab and newline kept): a screen dump must not carry terminal codes.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;

export const FENCE_KINDS = ['terminal_output', 'data', 'command_output', 'file', 'review'];

/** Text made safe to sit inside a fence: no control codes, no forged fence tags, secrets masked, clipped. */
export function neutralize(text, max = 20_000) {
  let s = String(text ?? '').normalize('NFC').replace(ANSI, '').replace(CONTROL, '').replace(TAG_START, (m) => '‹' + m.slice(1));
  s = redact(s);
  if (s.length > max) s = '…' + s.slice(s.length - max + 1); // a screen's newest lines matter most
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
