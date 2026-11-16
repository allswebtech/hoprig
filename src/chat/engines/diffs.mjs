// Diffs as the chat draws them (src/chat/events.mjs clipDiff: hunks with the old and new line numbers), from the
// unified diff a coding tool gives for a change (OpenCode: each file of an edit or a write, in the ask and the result).

/** A unified diff's text → [{ oldStart, oldLines, newStart, newLines, lines }] (no file headers). */
export function unifiedHunks(text) {
  const hunks = [];
  let h = null;
  for (const line of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      h = { oldStart: +m[1], oldLines: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLines: m[4] === undefined ? 1 : +m[4], lines: [] };
      hunks.push(h);
    } else if (h && /^[-+ ]/.test(line)) h.lines.push(line);
  }
  return hunks;
}
