// The one event model of a coding chat: every engine (src/chat/engines/) turns what its coding tool says into these
// events, and the page draws them. Each event is { kind, at, agent, … }: `agent` is null for the main conversation,
// else the id of the tool call that started the subagent the event belongs to (so the page nests it there).
//
// Kept in the chat's numbered list (and rebuilt from the transcript):
//   user          { text, attachments: [{ type: "image" | "file", name, mime }], messageId }
//   text          { blockId, text }                       thinking { blockId, text, durationMs }
//   tool          { id, name, title, toolKind, input }    toolKind: edit shell read search web agent workflow plan
//                                                           question todo other
//   tool-result   { id, ok, text, diff?: [{ oldStart, oldLines, newStart, newLines, lines }] }
//   ask           { request, toolId, type: permission | question | plan, tool, title, description, input, plan?,
//                   why, canAlways, always, alwaysText }   a tool call waits for the owner
//   ask-closed    { request, outcome: allowed | allowed-always | denied | cancelled }
//   turn-start    { auto, messageId? }                    auto: the coding tool went on by itself (a task ended)
//   turn-end      { ok, subtype, error, turnCostUsd, usage, durationMs, stopped }
//   session-changed { id, reason: clear | compact | fork, … }
//   notice        { level, text, local? }                local: what the coding tool answered by itself (/cost)
// Live only (sent to a page that streams, folded into the state, never numbered):
//   text-delta, thinking-delta { blockId, text, tokens? } · tool-start { id, name, title } · tool-progress { id, elapsedS }
// Engine to chat only (the chat keeps them as its state): session, status, mode, settings, usage, limits, title, task,
//   tasks-running, todos, queue-state, exit.

const TEXT_MAX = 4000; // a tool's result as shown; the whole of it stays in the transcript
const INPUT_MAX = 8000; // one string of a tool's input (an edit's text)

export function clipText(s, max = TEXT_MAX) {
  const t = String(s ?? '');
  return t.length > max ? `${t.slice(0, max)}\n… (${t.length - max} more characters)` : t;
}

/** A tool's input with long strings and lists cut, for the page. */
export function clipInput(v, depth = 0) {
  if (typeof v === 'string') return clipText(v, INPUT_MAX);
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => clipInput(x, depth + 1));
  if (v && typeof v === 'object') {
    if (depth > 4) return '…';
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) out[k] = clipInput(x, depth + 1);
    return out;
  }
  return v;
}

/** Text of a coding tool or a hook for the page: no escape sequences or other control characters, one line, cut. */
export const plainText = (s, max) => (typeof s === 'string' ? s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');

const DIFF_HUNKS = 50;
const DIFF_LINES = 2000;
/** A unified diff as hunks ({ oldStart, oldLines, newStart, newLines, lines: ["-a", "+b", " c"] }), cut for the page. */
export function clipDiff(hunks) {
  if (!Array.isArray(hunks) || !hunks.length) return null;
  const out = [];
  let left = DIFF_LINES;
  for (const h of hunks.slice(0, DIFF_HUNKS)) {
    if (!h || !Array.isArray(h.lines) || left <= 0) break;
    const lines = h.lines.filter((l) => typeof l === 'string').slice(0, left).map((l) => (l.length > 2000 ? `${l.slice(0, 2000)}…` : l));
    left -= lines.length;
    const n = (x) => (Number.isFinite(x) ? x : 0);
    out.push({ oldStart: n(h.oldStart), oldLines: n(h.oldLines), newStart: n(h.newStart), newLines: n(h.newLines), lines });
  }
  return out.length ? out : null;
}

export const oneLine = (s, max) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
