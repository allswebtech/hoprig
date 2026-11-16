// An edit as a real diff: hunks with the old and new line numbers, as Claude Code's own patch gives them (the
// tool-result's `diff`), else computed here from the edit's two texts (then the numbers count from the edit's first
// line, since the file around it is not known). Long diffs show their first rows and a "Show all".
import { add, h } from '../lib.js';

const SHOW = 80; // rows shown before "Show all"
const LCS_MAX = 2_000_000; // above this many line pairs the plain prefix/suffix diff is used (fast, less exact)

/** [[mark, text]] of two texts by their longest common lines (mark " ", "-" or "+"). */
export function diffLines(before, after) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  // The same start and end are context without the table.
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  let mid;
  if (A.length * B.length > LCS_MAX) mid = [...A.map((t) => ['-', t]), ...B.map((t) => ['+', t])];
  else {
    // L[i][j]: the longest common lines of A[i..] and B[j..]
    const L = Array.from({ length: A.length + 1 }, () => new Uint32Array(B.length + 1));
    for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    mid = [];
    let i = 0;
    let j = 0;
    while (i < A.length || j < B.length) {
      if (i < A.length && j < B.length && A[i] === B[j]) {
        mid.push([' ', A[i++]]);
        j++;
      } else if (j < B.length && (i === A.length || L[i][j + 1] > L[i + 1][j])) mid.push(['+', B[j++]]); // on a tie the removed line first, as diffs show it
      else mid.push(['-', A[i++]]);
    }
  }
  return [...a.slice(0, p).map((t) => [' ', t]), ...mid, ...a.slice(a.length - s).map((t) => [' ', t])];
}

/** Hunks ({ oldStart, oldLines, newStart, newLines, lines: [" a", "-b", "+c"] }) of two texts, `context` lines around each change. */
export function hunksOf(before, after, context = 3) {
  const rows = diffLines(before, after);
  const out = [];
  let o = 1;
  let n = 1;
  let cur = null;
  let lastChange = -Infinity;
  rows.forEach(([m, t], k) => {
    const change = m !== ' ';
    const nextChange = rows.slice(k + 1, k + 1 + context).some((r) => r[0] !== ' ');
    if (change || nextChange || k - lastChange <= context) {
      if (!cur) {
        cur = { oldStart: o, oldLines: 0, newStart: n, newLines: 0, lines: [] };
        out.push(cur);
      }
      cur.lines.push(m + t);
      if (m !== '+') cur.oldLines++;
      if (m !== '-') cur.newLines++;
    } else cur = null;
    if (change) lastChange = k;
    if (m !== '+') o++;
    if (m !== '-') n++;
  });
  return out;
}

/** Added and removed lines of hunks. */
export function hunkCounts(hunks) {
  let added = 0;
  let removed = 0;
  for (const x of hunks || []) for (const l of x.lines) if (l[0] === '+') added++; else if (l[0] === '-') removed++;
  return { added, removed };
}

/**
 * The diff view. o: { numbers (show line numbers: false where they only count from the edit) }. Every line is set as
 * text; each row says added or removed in words for a screen reader, and by a sign as well as a colour.
 */
export function diffView(hunks, { numbers = true } = {}) {
  const rows = [];
  hunks.forEach((x, k) => {
    if (k || x.oldStart > 1) rows.push(h('div.cd-gap', numbers ? `Line ${x.newStart}` : '⋯'));
    let o = x.oldStart;
    let n = x.newStart;
    for (const l of x.lines) {
      const m = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
      const text = '+- '.includes(l[0]) ? l.slice(1) : l;
      const cls = m === '+' ? 'add' : m === '-' ? 'del' : 'ctx';
      rows.push(h(`div.cd-row.cd-${cls}`,
        numbers ? h('span.cd-n', { 'aria-hidden': 'true' }, m === '+' ? '' : String(o)) : null,
        numbers ? h('span.cd-n', { 'aria-hidden': 'true' }, m === '-' ? '' : String(n)) : null,
        h('span.cd-m', { 'aria-label': m === '+' ? 'added' : m === '-' ? 'removed' : null }, m === ' ' ? ' ' : m === '-' ? '−' : '+'),
        h('span.cd-t', text || ' ')));
      if (m !== '+') o++;
      if (m !== '-') n++;
    }
  });
  const box = h(`div.chat-diffbox${numbers ? '' : '.chat-diff-nonum'}`, { role: 'group', 'aria-label': 'Changes' });
  if (rows.length <= SHOW + 20) return add(box, rows);
  const more = h('button.btn.small.ghost.chat-showall', { type: 'button', onclick: () => {
    more.remove();
    add(box, rows.slice(SHOW));
  } }, `Show all ${rows.length} lines`);
  return add(box, rows.slice(0, SHOW), more);
}

/** A new file's text as a diff of added lines, numbered from 1. */
export function addedView(text) {
  const lines = String(text || '').replace(/\n$/, '').split('\n');
  return diffView([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((l) => `+${l}`) }]);
}
