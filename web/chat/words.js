// The chat page's words (web/chat/): a tool call in one line, an edit as a small diff, the cost of a turn, the
// permission modes, models and efforts as the chips say them. Plain functions without the page, so the tests run
// them directly.

const fileName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';
/** Lines of a text as an editor counts them: a last newline ends the last line, it does not start one. */
export const lineCount = (s) => (s ? String(s).replace(/\n$/, '').split('\n').length : 0);

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
    case 'Bash': return { verb: i.run_in_background ? 'Started' : 'Ran', detail: firstLine(i.command), mono: true };
    case 'BashOutput': return { verb: 'Read the output of', detail: i.bash_id || i.shell_id || '', mono: true };
    case 'KillShell': return { verb: 'Stopped', detail: i.shell_id || '', mono: true };
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
    case 'ToolSearch': return { verb: 'Looked for a tool', detail: i.query || '', mono: false };
    case 'WebFetch': return { verb: 'Read the page', detail: i.url || '', mono: false };
    case 'WebSearch': return { verb: 'Searched the web for', detail: i.query || '', mono: false };
    case 'Task':
    case 'Agent': return { verb: i.run_in_background ? 'Started a background agent' : 'Asked an agent', detail: i.description || '', mono: false };
    case 'SendMessage': return { verb: 'Wrote to an agent', detail: i.to || '', mono: false };
    case 'Workflow': return { verb: 'Ran a workflow', detail: i.name || '', mono: false };
    case 'Monitor': return { verb: 'Watches', detail: i.description || firstLine(i.command), mono: false };
    case 'TaskCreate': return { verb: 'Added a task', detail: i.subject || '', mono: false };
    case 'TaskUpdate': return { verb: 'Updated task', detail: `#${i.taskId ?? '?'}${i.status ? ` · ${i.status.replace(/_/g, ' ')}` : ''}`, mono: false };
    case 'TodoWrite': return { verb: 'Updated the to-do list', detail: '', mono: false };
    case 'Skill': return { verb: 'Used the skill', detail: i.skill || i.name || '', mono: false };
    case 'AskUserQuestion': return { verb: 'Asked you', detail: (i.questions && i.questions[0] && i.questions[0].question) || '', mono: false };
    case 'EnterPlanMode': return { verb: 'Started to plan', detail: '', mono: false };
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
export const kilo = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
/** less than 1 s, 4 s, 1 min 5 s, 2 h 3 min */
export function took(ms) {
  if (ms < 1000) return 'less than 1 s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(s / 3600)} h${Math.floor(s / 60) % 60 ? ` ${Math.floor(s / 60) % 60} min` : ''}`;
}

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

// ---------- the composer's chips ----------

/** The permission modes as the chip and its menu say them. `danger`: runs anything (the chip is marked). */
export const MODE = {
  manual: { chip: 'Ask first', sub: 'Asks before every change and command' },
  acceptEdits: { chip: 'Accept edits', sub: 'Changes files without asking; asks before commands' },
  plan: { chip: 'Plan', sub: 'Reads and proposes; changes nothing until you approve' },
  auto: { chip: 'Auto', sub: 'Decides by itself what is safe; asks for the rest' },
  dontAsk: { chip: 'Never ask', sub: 'Anything not already allowed is refused' },
  bypassPermissions: { chip: 'Bypass', sub: 'Runs anything without asking (riskiest)', danger: true },
};
/** The order Shift+Tab goes through, as in Claude Code (never-ask is only in the menu). */
export const MODE_CYCLE = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export function nextMode(now, modes = Object.keys(MODE)) {
  const ring = MODE_CYCLE.filter((m) => modes.includes(m));
  const i = ring.indexOf(now || 'manual');
  return ring[(i + 1) % ring.length];
}
/** The mode the chat runs in: what the running process says, else what is set (null: Claude Code's default, ask first). */
export const modeOf = (v) => (v.liveMode ? (v.liveMode === 'default' ? 'manual' : v.liveMode) : v.permissionMode || 'manual');
export const modeChip = (m) => (MODE[m] ? MODE[m].chip : m ? m : 'Ask first');

const MODEL_NAMES = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };
/** "Opus", or the model's own id for one the dashboard does not name. */
export const modelName = (m) => MODEL_NAMES[m] || (m ? String(m).replace(/^claude-/, '') : 'Auto');
export const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
export const effortName = (e) => EFFORT_NAMES[e] || (e ? e : 'Auto');

/** A path in the chat's folder as the owner reads it: relative to the folder, else as it is. */
export function inFolder(p, cwd) {
  const s = String(p || '');
  const base = String(cwd || '').replace(/\/+$/, '');
  return base && s.startsWith(`${base}/`) ? s.slice(base.length + 1) : s;
}

/** The plan's limits in a few words: "5 h 42% · week 10%". */
const WINDOWS = { five_hour: '5 h', seven_day: 'week', seven_day_opus: 'week Opus', seven_day_sonnet: 'week Sonnet' };
export function limitsLine(limits) {
  return Object.entries(limits || {})
    .filter(([, x]) => x && Number.isFinite(x.percent))
    .map(([w, x]) => `${WINDOWS[w] || w.replace(/_/g, ' ')} ${Math.round(x.percent)}%`)
    .join(' · ');
}

/** Context used, in percent (null when not known). */
export function contextPercent(u) {
  if (!u) return null;
  if (Number.isFinite(u.contextPercent)) return Math.round(u.contextPercent);
  if (Number.isFinite(u.contextUsed) && Number.isFinite(u.contextWindow) && u.contextWindow > 0) return Math.round((u.contextUsed / u.contextWindow) * 100);
  return null;
}

/** The exit code a shell's result names ("Exit code 2"), or null. */
export const exitCode = (text) => {
  const m = /(?:^|\n)\s*(?:Exit code|exit code:?|exited with code)\s+(-?\d+)/i.exec(String(text || ''));
  return m ? Number(m[1]) : null;
};
