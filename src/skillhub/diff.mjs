// What changed between the installed skill and a newer one: files added, removed and changed, and for text files
// the changed lines with a little context (a plain LCS diff; skills are small).

const MAX_LINES = 5000;

/** Line diff of two texts as hunks: [{ oldStart, newStart, lines: [[' '|'-'|'+', text]] }]. */
export function lineDiff(a, b, context = 2) {
  const x = String(a).split('\n');
  const y = String(b).split('\n');
  if (x.length > MAX_LINES || y.length > MAX_LINES) return null;
  // Trim the common head and tail first, so the table stays small for typical edits.
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let post = 0;
  while (post < x.length - pre && post < y.length - pre && x[x.length - 1 - post] === y[y.length - 1 - post]) post++;
  const xs = x.slice(pre, x.length - post);
  const ys = y.slice(pre, y.length - post);
  if (xs.length * ys.length > 4_000_000) return null;
  const n = xs.length;
  const m = ys.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = xs[i] === ys[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const ops = [];
  for (let k = 0; k < pre; k++) ops.push([' ', x[k]]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) {
      ops.push([' ', xs[i]]);
      i++;
      j++;
    } else if (j < m && (i >= n || t[i][j + 1] >= t[i + 1][j])) ops.push(['+', ys[j++]]);
    else ops.push(['-', xs[i++]]);
  }
  for (let k = x.length - post; k < x.length; k++) ops.push([' ', x[k]]);
  // Group into hunks.
  const hunks = [];
  let oldLine = 1;
  let newLine = 1;
  let cur = null;
  let lastChange = -Infinity;
  ops.forEach((op, idx) => {
    const changed = op[0] !== ' ';
    const nextChange = ops.findIndex((o, k) => k >= idx && o[0] !== ' ');
    const near = changed || idx - lastChange <= context || (nextChange >= 0 && nextChange - idx <= context);
    if (near) {
      if (!cur) {
        cur = { oldStart: oldLine, newStart: newLine, lines: [] };
        hunks.push(cur);
      }
      cur.lines.push(op);
    } else cur = null;
    if (changed) lastChange = idx;
    if (op[0] !== '+') oldLine++;
    if (op[0] !== '-') newLine++;
  });
  return hunks;
}

/**
 * Compare two file maps { rel: { sha256, text|null } }: { added, removed, changed: [{ path, hunks|null }] }.
 * `text` is null for binary or very large files; their change is reported without lines.
 */
export function folderDiff(before, after) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const p of Object.keys(after).sort()) {
    if (!before[p]) added.push({ path: p, hunks: after[p].text === null ? null : lineDiff('', after[p].text) });
    else if (before[p].sha256 !== after[p].sha256) changed.push({ path: p, hunks: before[p].text === null || after[p].text === null ? null : lineDiff(before[p].text, after[p].text) });
  }
  for (const p of Object.keys(before).sort()) if (!after[p]) removed.push({ path: p });
  return { added, removed, changed };
}

/** A diff as text lines for the terminal (unified style). */
export function diffText(d, { maxLines = 400 } = {}) {
  const out = [];
  for (const f of d.removed) out.push(`--- removed: ${f.path}`);
  for (const [label, list] of [['added', d.added], ['changed', d.changed]]) {
    for (const f of list) {
      out.push(`${label === 'added' ? '+++ added' : '*** changed'}: ${f.path}`);
      if (!f.hunks) {
        out.push('    (binary or too large to show line by line)');
        continue;
      }
      for (const h of f.hunks) {
        out.push(`@@ -${h.oldStart} +${h.newStart} @@`);
        for (const [op, text] of h.lines) out.push(`${op}${text}`);
      }
    }
  }
  if (out.length > maxLines) return [...out.slice(0, maxLines), `… ${out.length - maxLines} more lines`];
  return out;
}
