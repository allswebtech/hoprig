// The Work file as text: what a write would alter in it, and where a broken one breaks. Work writes the file back
// through JSON (store.mjs serialize), in the style it found (indent, line ends, a final newline, a byte-order mark).
// Some files do not come back the same that way: a number JSON cannot hold exactly (12345678901234567890) or writes
// another way (1.0, 1e3), a string written with escapes (é, \/), a key written twice (only the last value is
// read), mixed line ends, a list written on one line. Work never alters those by itself (store.mjs refuses a change);
// this module says what would be altered, so the owner can see it and tidy the file once. Pure: no files here.

const WS = new Set([' ', '\t', '\n', '\r']);

// What Work reads at all: a list of tasks is a few levels deep and its numbers are short. A file past these is
// refused with the reason (never "tidied"): JSON.parse turns a number of hundreds of digits into Infinity, which a
// write would make null, and every reader here walks the file level by level.
export const MAX_DEPTH = 100;
export const MAX_NUMBER = 400;

/**
 * Whether `text` stays within MAX_DEPTH levels and MAX_NUMBER characters per number: null, or { kind: "deep" |
 * "number", line }. One pass, no recursion; it needs no valid JSON (it runs before the parse).
 */
export function checkLimits(text) {
  let depth = 0;
  let run = 0;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      run = 0;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '\n') line++;
      }
      continue;
    }
    if (c === '\n') line++;
    if (c === '{' || c === '[') {
      if (++depth > MAX_DEPTH) return { kind: 'deep', line };
    } else if (c === '}' || c === ']') depth--;
    if ((c >= '0' && c <= '9') || c === '-' || c === '+' || c === '.' || c === 'e' || c === 'E') {
      if (++run > MAX_NUMBER) return { kind: 'number', line };
    } else run = 0;
  }
  return null;
}

/** A limit in plain words, for a refusal: "is nested more than 100 levels deep (line 3)". */
export const limitText = (l) => (l.kind === 'deep'
  ? `is nested more than ${MAX_DEPTH} levels deep (at line ${l.line})`
  : `has a number longer than ${MAX_NUMBER} characters (at line ${l.line}), which JSON cannot hold exactly`);

/**
 * Strict UTF-8: → { text, bad } where bad is null, or { line } of the first byte that is not UTF-8 (then `text` has
 * the character U+FFFD in its place, as a write would). A byte-order mark stays in the text.
 */
export function decodeBytes(buf) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf), bad: null };
  } catch {
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
    const at = firstBadByte(buf);
    let line = 1;
    for (let i = 0; i < at; i++) if (buf[i] === 0x0a) line++;
    return { text, bad: { line } };
  }
}

/** The length of the valid UTF-8 sequence at `i` of `buf`, or 0 when it is not one. */
function seqAt(buf, i) {
  const b = buf[i];
  if (b < 0x80) return 1;
  const n = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
  if (!n || i + n > buf.length) return 0;
  for (let k = 1; k < n; k++) if ((buf[i + k] & 0xc0) !== 0x80) return 0;
  const b1 = buf[i + 1];
  if ((b === 0xe0 && b1 < 0xa0) || (b === 0xed && b1 > 0x9f) || (b === 0xf0 && b1 < 0x90) || (b === 0xf4 && b1 > 0x8f)) return 0;
  return n;
}
function firstBadByte(buf) {
  for (let i = 0; i < buf.length;) {
    const n = seqAt(buf, i);
    if (!n) return i;
    i += n;
  }
  return buf.length;
}

/** The bytes as text to show in a difference: each byte that is not UTF-8 written as \xNN. */
export function bytesShown(buf) {
  let out = '';
  let from = 0;
  for (let i = 0; i < buf.length;) {
    const n = seqAt(buf, i);
    if (n) {
      i += n;
      continue;
    }
    out += buf.subarray(from, i).toString('utf8') + `\\x${buf[i].toString(16).toUpperCase().padStart(2, '0')}`;
    from = ++i;
  }
  return out + buf.subarray(from).toString('utf8');
}

/** Where offset `at` of `text` is: { line, column }, both from 1. */
export function lineColumn(text, at) {
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  return { line, column: at - before.lastIndexOf('\n') };
}

const fail = (text, at) => Object.assign(new Error('not valid JSON'), { at, ...lineColumn(text, at) });

/**
 * Read `text` (no byte-order mark) the way JSON.parse does, keeping how each value was written:
 * → a tree of { t: 'o', entries: [[keyRaw, key, node]] } | { t: 'a', items: [node] } | { t: 'v', raw }, and `notes`:
 * [{ kind: 'number' | 'escape' | 'key', path, from, to }] for the values a write would alter. Throws { line, column }
 * at the first thing that is not JSON.
 */
export function readTree(text) {
  let i = 0;
  const notes = [];
  const ws = () => {
    while (i < text.length && WS.has(text[i])) i++;
  };
  const str = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++;
      else if (text.charCodeAt(i) < 0x20) throw fail(text, i);
      i++;
    }
    if (i >= text.length) throw fail(text, start);
    i++;
    const raw = text.slice(start, i);
    try {
      return { raw, value: JSON.parse(raw) };
    } catch {
      throw fail(text, start);
    }
  };
  const value = (path, depth = 0) => {
    ws();
    const c = text[i];
    // Deeper than Work reads (checkLimits refuses such a file first): no location, rather than a stack overflow.
    if (depth > MAX_DEPTH) throw Object.assign(new Error('too deep'), { deep: true });
    if (c === '{') {
      i++;
      const entries = [];
      const seen = new Set();
      ws();
      if (text[i] === '}') {
        i++;
        return { t: 'o', entries };
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw fail(text, i);
        const k = str();
        const at = `${path}${path ? '.' : ''}${k.value}`;
        if (JSON.stringify(k.value) !== k.raw) notes.push({ kind: 'escape', path: at, from: k.raw, to: JSON.stringify(k.value) });
        if (seen.has(k.value)) notes.push({ kind: 'key', path: at });
        seen.add(k.value);
        ws();
        if (text[i] !== ':') throw fail(text, i);
        i++;
        entries.push([k.raw, k.value, value(at, depth + 1)]);
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === '}') {
          i++;
          return { t: 'o', entries };
        } else throw fail(text, i);
      }
    }
    if (c === '[') {
      i++;
      const items = [];
      ws();
      if (text[i] === ']') {
        i++;
        return { t: 'a', items };
      }
      for (;;) {
        items.push(value(`${path}[${items.length}]`, depth + 1));
        ws();
        if (text[i] === ',') i++;
        else if (text[i] === ']') {
          i++;
          return { t: 'a', items };
        } else throw fail(text, i);
      }
    }
    if (c === '"') {
      const s = str();
      if (JSON.stringify(s.value) !== s.raw) notes.push({ kind: 'escape', path, from: s.raw, to: JSON.stringify(s.value) });
      return { t: 'v', raw: s.raw };
    }
    LITERAL.lastIndex = i;
    const m = LITERAL.exec(text);
    if (!m) throw fail(text, i);
    i += m[0].length;
    const raw = m[0];
    if (/^-|\d/.test(raw)) {
      const to = JSON.stringify(JSON.parse(raw));
      if (to !== raw) notes.push({ kind: 'number', path, from: raw, to });
    }
    return { t: 'v', raw };
  };
  const tree = value('');
  ws();
  if (i < text.length) throw fail(text, i);
  return { tree, notes };
}

const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

/** The tree written back with its own spellings in JSON.stringify's layout (indent 0: one line), lines ending "\n". */
function layout(node, indent, depth = 0) {
  if (node.t === 'v') return node.raw;
  const pad = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  const inner = (d) => (pad ? `\n${pad.repeat(d)}` : '');
  const parts = node.t === 'o' ? node.entries.map(([raw, , v]) => `${raw}:${pad ? ' ' : ''}${layout(v, indent, depth + 1)}`) : node.items.map((v) => layout(v, indent, depth + 1));
  const [open, close] = node.t === 'o' ? ['{', '}'] : ['[', ']'];
  if (!parts.length) return `${open}${close}`;
  return `${open}${inner(depth + 1)}${parts.join(`,${inner(depth + 1)}`)}${inner(depth)}${close}`;
}

/**
 * What writing `text` back unchanged in style `fmt` would alter: [{ kind, path?, from?, to? }] with the kinds
 * "key" (written twice: the first value is lost), "number", "escape", "line-ends" (mixed: all become fmt.eol) and
 * "layout" (spaces and line breaks, such as a list on one line spread over lines). Empty: the text comes back as it
 * is. The text must be JSON (readTree throws otherwise).
 */
export function wouldAlter(text, fmt) {
  const body = text.replace(/^﻿/, '');
  const { tree, notes } = readTree(body);
  const out = [...notes];
  const crlf = (body.match(/\r\n/g) || []).length;
  const lf = (body.match(/\n/g) || []).length - crlf;
  if (crlf && lf) out.push({ kind: 'line-ends' });
  const want = layout(tree, fmt.indent) + (fmt.finalNewline ? '\n' : '');
  if (want !== body.replace(/\r\n/g, '\n')) out.push({ kind: 'layout' });
  return out;
}

/** One altered thing in plain words, for the page and the command. */
export function alterText(a) {
  if (a.kind === 'key') return `the key ${a.path} is written twice: only its last value is kept`;
  if (a.kind === 'number') return `the number ${a.from} at ${a.path} becomes ${a.to}`;
  if (a.kind === 'escape') return `${a.path || 'a value'} is written with escapes (${a.from.slice(0, 40)}): it becomes ${a.to.slice(0, 40)}`;
  if (a.kind === 'line-ends') return 'the lines end two ways (CRLF and LF): all become one';
  if (a.kind === 'bytes') return `the file has bytes that are not UTF-8 (the first at line ${a.line}): a write puts the character \uFFFD in their place`;
  return 'spaces and line breaks: a list or object written on one line is spread over lines, other spacing becomes even';
}

/**
 * The lines that differ between `a` and `b`: [{ op: ' ' | '-' | '+', line, text }] with two lines of context around
 * each change and "…" for the lines left out. Long files: the common start and end are cut first. At most `max` lines
 * (then one "… N more lines"), each cut at `width` characters; Infinity for both gives all of it.
 */
export function lineDiff(a, b, { context = 2, max = 400, width = 300 } = {}) {
  const A = a.replace(/\r\n/g, '\n').split('\n');
  const B = b.replace(/\r\n/g, '\n').split('\n');
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let e = 0;
  while (e < A.length - s && e < B.length - s && A[A.length - 1 - e] === B[B.length - 1 - e]) e++;
  const x = A.slice(s, A.length - e);
  const y = B.slice(s, B.length - e);
  let ops = [];
  if (x.length * y.length <= 4_000_000) {
    // Longest common subsequence of the middle.
    const w = y.length + 1;
    const L = new Uint32Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i * w + j] = x[i] === y[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) ops.push([' ', i++, j++]);
      else if (i < x.length && (j >= y.length || L[(i + 1) * w + j] >= L[i * w + j + 1])) ops.push(['-', i++, j]);
      else ops.push(['+', i, j++]);
    }
  } else ops = [...x.map((_, i) => ['-', i, 0]), ...y.map((_, j) => ['+', x.length, j])];
  const all = [...A.slice(0, s).map((t, k) => ({ op: ' ', line: k + 1, text: t })),
    ...ops.map(([op, i, j]) => ({ op, line: (op === '+' ? j : i) + s + 1, text: op === '+' ? y[j] : x[i] })),
    ...A.slice(A.length - e).map((t, k) => ({ op: ' ', line: A.length - e + k + 1, text: t }))];
  const keep = all.map((d, k) => d.op !== ' ' || all.slice(Math.max(0, k - context), k + context + 1).some((n) => n.op !== ' '));
  const out = [];
  all.forEach((d, k) => {
    if (keep[k]) out.push({ ...d, text: d.text.length > width ? `${d.text.slice(0, width)}…` : d.text });
    else if (!out.length || out[out.length - 1].op !== '…') out.push({ op: '…', line: null, text: '' });
  });
  return out.length > max ? [...out.slice(0, max), { op: '…', line: null, text: `${out.length - max} more lines` }] : out;
}
