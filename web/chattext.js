// The chat view's words for what Claude does (chat.js): a tool call in one line, an edit as a small diff, the cost
// of a turn. Plain functions without the page, so the tests run them directly.

const fileName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
const lineCount = (s) => (s ? String(s).split('\n').length : 0);

/** What an edit changes: { added, removed } lines, the way the diff below shows it. */
export function editCounts(input = {}) {
  const pairs = Array.isArray(input.edits) ? input.edits : [input];
  let added = 0;
  let removed = 0;
  for (const e of pairs) {
    const d = lineDiff(e.old_string || '', e.new_string || '');
    added += d.filter((x) => x[0] === '+').length;
    removed += d.filter((x) => x[0] === '-').length;
  }
  return { added, removed };
}

/**
 * A small line diff of one replacement: the lines both sides share at the start and at the end are context (two of
 * each are kept), everything between is removed and added. [[mark, text]], mark " ", "-" or "+".
 */
export function lineDiff(before, after, context = 2) {
  const a = String(before).split('\n');
  const b = String(after).split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return [
    ...a.slice(Math.max(0, p - context), p).map((t) => [' ', t]),
    ...a.slice(p, a.length - s).map((t) => ['-', t]),
    ...b.slice(p, b.length - s).map((t) => ['+', t]),
    ...a.slice(a.length - s, a.length - s + context).map((t) => [' ', t]),
  ];
}

/** One line for a tool call: { verb, detail, mono } — "Bash" + its command, "Edit" + the file and +/- lines, … */
export function toolLine(name, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { verb: mcp[2].replace(/_/g, ' '), detail: mcp[1], mono: false };
  switch (name) {
    case 'Bash': return { verb: 'Ran', detail: firstLine(i.command), mono: true };
    case 'Read': return { verb: 'Read', detail: fileName(i.file_path), mono: true };
    case 'Write': return { verb: 'Wrote', detail: `${fileName(i.file_path)} · ${lineCount(i.content)} lines`, mono: true };
    case 'Edit':
    case 'MultiEdit': {
      const c = editCounts(i);
      return { verb: 'Edited', detail: `${fileName(i.file_path)} · +${c.added} −${c.removed}`, mono: true };
    }
    case 'NotebookEdit': return { verb: 'Edited', detail: fileName(i.notebook_path), mono: true };
    case 'Glob': return { verb: 'Looked for files', detail: i.pattern || '', mono: true };
    case 'Grep': return { verb: 'Searched for', detail: i.pattern || '', mono: true };
    case 'WebFetch': return { verb: 'Read the page', detail: i.url || '', mono: false };
    case 'WebSearch': return { verb: 'Searched the web for', detail: i.query || '', mono: false };
    case 'Task':
    case 'Agent': return { verb: 'Asked a helper', detail: i.description || '', mono: false };
    case 'TaskCreate': return { verb: 'Added a task', detail: i.subject || '', mono: false };
    case 'TaskUpdate': return { verb: 'Updated task', detail: `#${i.taskId ?? '?'}${i.status ? ` · ${i.status.replace(/_/g, ' ')}` : ''}`, mono: false };
    case 'TodoWrite': return { verb: 'Updated the to-do list', detail: '', mono: false };
    case 'Skill': return { verb: 'Used the skill', detail: i.skill || i.name || '', mono: false };
    case 'AskUserQuestion': return { verb: 'Asked you', detail: (i.questions && i.questions[0] && i.questions[0].question) || '', mono: false };
    case 'ExitPlanMode': return { verb: 'Made a plan', detail: '', mono: false };
    default: {
      const first = Object.values(i).find((x) => typeof x === 'string');
      return { verb: name, detail: first ? firstLine(first) : '', mono: false };
    }
  }
}

/** What Claude asks to do, as the head of the OK card. */
export function askTitle(tool, input = {}) {
  switch (tool) {
    case 'Bash': return 'Claude wants to run a command';
    case 'Write': return `Claude wants to write ${fileName(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `Claude wants to change ${fileName(input.file_path || input.notebook_path)}`;
    case 'WebFetch': return 'Claude wants to read a web page';
    case 'AskUserQuestion': return 'Claude asks you';
    case 'ExitPlanMode': return 'Claude has a plan';
    default: return `Claude wants to use ${toolLine(tool, input).verb}`;
  }
}

export const money = (n) => (n >= 0.01 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : '$0');
const kilo = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** The line under a finished turn: what it cost and used, as Claude Code reported it. */
export function turnLine(ev) {
  const parts = [];
  if (Number.isFinite(ev.turnCostUsd)) parts.push(money(ev.turnCostUsd));
  if (ev.usage) {
    const input = (ev.usage.input || 0) + (ev.usage.cacheRead || 0) + (ev.usage.cacheWrite || 0);
    parts.push(`${kilo(input)} tokens in · ${kilo(ev.usage.output || 0)} out`);
  }
  if (Number.isFinite(ev.durationMs)) parts.push(`${Math.max(1, Math.round(ev.durationMs / 1000))} s`);
  return parts.join(' · ');
}

