// The chat page's words (web/chat/): a tool call in one line, an edit as a small diff, the cost of a turn, the
// permission modes, models and efforts as the chips say them. Plain functions without the page, so the tests run
// them directly.

/**
 * What a failed action says in a toast: the dashboard's own sentence (an ApiError has a status); a fault of the page
 * itself never shows its script message ("Cannot read properties of null").
 */
export const failText = (e) => (e && Number.isInteger(e.status) && e.message ? e.message : 'That did not work. Reload the page and try again.');

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

// A call's verb by its state: [done, running, waiting for the owner's OK, refused by the owner]. A call is never
// said in the past before it ran ("Wrote" while it still asks to write).
const VERBS = {
  Bash: ['Ran', 'Running', 'Wants to run', 'Not run'],
  BashBg: ['Started', 'Starting', 'Wants to start', 'Not started'],
  BashOutput: ['Read the output of', 'Reading the output of', 'Wants to read the output of', 'Not read'],
  KillShell: ['Stopped', 'Stopping', 'Wants to stop', 'Not stopped'],
  Read: ['Read', 'Reading', 'Wants to read', 'Not read'],
  Write: ['Wrote', 'Writing', 'Wants to write', 'Not written'],
  Edit: ['Edited', 'Editing', 'Wants to change', 'Not changed'],
  Glob: ['Looked for files', 'Looking for files', 'Wants to look for files', 'Not looked for'],
  Grep: ['Searched for', 'Searching for', 'Wants to search for', 'Not searched'],
  ToolSearch: ['Looked for a tool', 'Looking for a tool', 'Wants to look for a tool', 'Not looked for'],
  WebFetch: ['Read the page', 'Reading the page', 'Wants to read the page', 'Not read'],
  WebSearch: ['Searched the web for', 'Searching the web for', 'Wants to search the web for', 'Not searched'],
  Agent: ['Asked an agent', 'Asking an agent', 'Wants to ask an agent', 'Not asked'],
  AgentBg: ['Started a background agent', 'Starting a background agent', 'Wants to start a background agent', 'Not started'],
  SendMessage: ['Wrote to an agent', 'Writing to an agent', 'Wants to write to an agent', 'Not sent'],
  Workflow: ['Ran a workflow', 'Running a workflow', 'Wants to run a workflow', 'Not run'],
  Monitor: ['Watches', 'Watching', 'Wants to watch', 'Not watched'],
  TaskCreate: ['Added a task', 'Adding a task', 'Wants to add a task', 'Not added'],
  TaskUpdate: ['Updated task', 'Updating task', 'Wants to update task', 'Not updated'],
  TodoWrite: ['Updated the to-do list', 'Updating the to-do list', 'Wants to update the to-do list', 'Not updated'],
  Skill: ['Used the skill', 'Using the skill', 'Wants to use the skill', 'Not used'],
  AskUserQuestion: ['Asked you', 'Asks you', 'Asks you', 'Not answered'],
  EnterPlanMode: ['Started to plan', 'Starting to plan', 'Wants to plan', 'Not planned'],
  ExitPlanMode: ['Made a plan', 'Has a plan', 'Has a plan for you to approve', 'Kept planning'],
};
VERBS.MultiEdit = VERBS.Edit;
VERBS.NotebookEdit = VERBS.Edit;
VERBS.Task = VERBS.Agent;
const STATES = { done: 0, running: 1, asking: 2, refused: 3, stopped: 4 };

/**
 * One line for a tool call: { verb, detail, mono } — "Ran" + its command, "Edited" + the file and +/- lines, …
 * `state`: done (default), running, asking (waits for the owner's OK), refused (he said no), stopped (Stop came
 * before it ran: "Did not write", never in the past) or failed (only for a change of a file, which is one step: "Could
 * not write"; nothing was written).
 */
export function toolLine(name, input = {}, state = 'done') {
  if (state === 'stopped' || state === 'failed') {
    // "Wants to write" → "Did not write" (stopped) or "Could not write" (it failed: a rule refused it, the file was
    // not there); a verb without "Wants to" ("Asks you") says it as refused ("Not answered").
    const line = toolLine(name, input, 'asking');
    const m = /^Wants to (.+)$/.exec(line.verb);
    return { ...line, verb: m ? `${state === 'stopped' ? 'Did not' : 'Could not'} ${m[1]}` : toolLine(name, input, 'refused').verb };
  }
  const i = input && typeof input === 'object' ? input : {};
  const n = STATES[state] ?? 0;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { verb: [mcp[2].replace(/_/g, ' '), `Using ${mcp[2].replace(/_/g, ' ')}`, `Wants to use ${mcp[2].replace(/_/g, ' ')}`, 'Not used'][n], detail: mcp[1], mono: false };
  const key = (name === 'Bash' && i.run_in_background) ? 'BashBg' : ((name === 'Agent' || name === 'Task') && i.run_in_background) ? 'AgentBg' : name;
  const verbs = VERBS[key];
  const verb = verbs ? verbs[n] : [name, name, `Wants to use ${name}`, 'Not used'][n];
  const line = (detail, mono) => ({ verb, detail, mono });
  switch (name) {
    case 'Bash': return line(firstLine(i.command), true);
    case 'BashOutput': return line(i.bash_id || i.shell_id || '', true);
    case 'KillShell': return line(i.shell_id || '', true);
    case 'Read': return line(fileName(i.file_path), true);
    case 'Write': {
      const n = lineCount(i.content);
      return line(`${fileName(i.file_path)} · ${n} line${n === 1 ? '' : 's'}`, true);
    }
    case 'Edit':
    case 'MultiEdit': {
      const c = editCounts(i);
      return line(`${fileName(i.file_path)} · +${c.added} −${c.removed}`, true);
    }
    case 'NotebookEdit': return line(fileName(i.notebook_path), true);
    case 'Glob':
    case 'Grep': return line(i.pattern || '', true);
    case 'ToolSearch': return line(i.query || '', false);
    case 'WebFetch': return line(i.url || '', false);
    case 'WebSearch': return line(i.query || '', false);
    case 'Task':
    case 'Agent': return line(i.description || '', false);
    case 'SendMessage': return line(i.to || '', false);
    case 'Workflow': return line(i.name || '', false);
    case 'Monitor': return line(i.description || firstLine(i.command), false);
    case 'TaskCreate': return line(i.subject || '', false);
    case 'TaskUpdate': return line(`#${i.taskId ?? '?'}${i.status ? ` · ${i.status.replace(/_/g, ' ')}` : ''}`, false);
    case 'TodoWrite': return line('', false);
    case 'Skill': return line(i.skill || i.name || '', false);
    case 'AskUserQuestion': return line((i.questions && i.questions[0] && i.questions[0].question) || '', false);
    case 'EnterPlanMode':
    case 'ExitPlanMode': return line('', false);
    default: {
      const first = Object.values(i).find((x) => typeof x === 'string');
      return line(first ? firstLine(first) : '', false);
    }
  }
}

// The items of a grant's text (src/chat/engines/claude-lines.mjs sessionGrant): "Tool", "Tool(rule)", "the folder
// <path>" and "all edits", joined by ", ". A rule may hold ", " itself: a comma splits only where a next item starts.
const grantItems = (text) => String(text || '').split(/,\s*(?=[A-Za-z_][\w-]*(?:\(|,|$)|the folder |all edits(?:,|$))/).map((x) => x.trim()).filter(Boolean);

/**
 * What "Allow in this chat" covers, in words: Claude Code's rules ("Bash(npm view *)", "WebFetch(domain:x.org)")
 * as a person reads them. Only the rule's own part is allowed, which may be a part of a longer command.
 */
export function ruleWords(text) {
  return grantItems(text).map((r) => {
    let m;
    if ((m = /^Bash\((.+?)(?::\*| \*)\)$/.exec(r))) return `commands that start with “${m[1]}”`;
    if ((m = /^Bash\((.+)\)$/.exec(r))) return `the command “${m[1]}”`;
    if (r === 'Bash') return 'every command';
    if ((m = /^WebFetch\(domain:(.+)\)$/.exec(r))) return `pages on ${m[1]}`;
    if ((m = /^(Read|Edit|Write)\((.+)\)$/.exec(r))) return `${m[1] === 'Read' ? 'reading' : 'changing'} ${m[2]}`;
    if ((m = /^mcp__(.+?)__(.+)$/.exec(r))) return `${m[2].replace(/_/g, ' ')} of ${m[1]}`;
    if (r === 'all edits') return 'every edit of a file';
    return r;
  }).join(', ');
}

/**
 * Under an OK card: what "Allow in this chat" adds, in words. Claude Code suggests a rule for each part of a command
 * that still asks (`ls x; exit 2` gives Bash(exit 2)): then the sentence says it covers only that part.
 */
export function alwaysWords(ev, who = 'Claude') {
  // Another coding tool's own patterns ("ls *"), which cover each part of a command it asked for.
  if (who !== 'Claude') return ev.alwaysText ? `“Allow in this session” also lets ${who} do what matches this again in this session without asking: ${ev.alwaysText}.` : '';
  const what = ruleWords(ev.alwaysText);
  if (!what) return '';
  const cmd = ev.tool === 'Bash' && ev.input && typeof ev.input.command === 'string' ? ev.input.command.trim() : '';
  const part = !!cmd && /[;&|\n]/.test(cmd) && !grantItems(ev.alwaysText).includes(`Bash(${cmd})`);
  return `“Allow in this session” also lets Claude do this again in this session without asking: ${what}.${part ? ' That is only part of this command.' : ''}`;
}

/** What the coding tool (`who`: "Claude", "OpenCode") asks to do, as the head of the OK card. */
export function askTitle(tool, input = {}, who = 'Claude') {
  switch (tool) {
    case 'Bash': return `${who} wants to run a command`;
    case 'Write': return `${who} wants to write ${fileName(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': return `${who} wants to change ${fileName(input.file_path || input.notebook_path)}`;
    case 'WebFetch': return `${who} wants to read a web page`;
    case 'AskUserQuestion': return `${who} asks you`;
    case 'ExitPlanMode': return `${who} has a plan`;
    default: return `${who} wants to use ${toolLine(tool, input).verb}`;
  }
}

// A cent or more in cents; what rounds to a cent is one (a difference of two sums is 0.0099999…, not "$0.0100").
export const money = (n) => (n >= 0.00995 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : '$0');
export const kilo = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));
/** less than 1 s, 4 s, 1 min 5 s, 2 h 3 min */
export function took(ms) {
  if (ms < 1000) return 'less than 1 s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(s / 3600)} h${Math.floor(s / 60) % 60 ? ` ${Math.floor(s / 60) % 60} min` : ''}`;
}

/**
 * The line under a finished turn, as Claude Code reported it: { cost ("$0.04", or ""), rest ("19k tokens in · 140
 * out · 9 s") }. Both empty for a command Claude Code answered by itself (/cost): it used nothing.
 */
export function turnParts(ev) {
  const u = ev.usage || {};
  if (!ev.turnCostUsd && !(u.input || u.output || u.cacheRead || u.cacheWrite)) return { cost: '', rest: '' };
  const parts = [];
  if (ev.usage) {
    const input = (ev.usage.input || 0) + (ev.usage.cacheRead || 0) + (ev.usage.cacheWrite || 0);
    if (input || ev.usage.output) parts.push(`${kilo(input)} tokens in · ${kilo(ev.usage.output || 0)} out`);
  }
  if (Number.isFinite(ev.durationMs)) parts.push(`${Math.max(1, Math.round(ev.durationMs / 1000))} s`);
  return { cost: Number.isFinite(ev.turnCostUsd) ? money(ev.turnCostUsd) : '', rest: parts.join(' · ') };
}
/** The same in one line: "$0.04 · 19k tokens in · 140 out · 9 s". */
export function turnLine(ev) {
  const { cost, rest } = turnParts(ev);
  return [cost, rest].filter(Boolean).join(' · ');
}

// One "@name" with the blanks after it: @"a name with spaces" (no line break inside) or @ and all up to a blank. A
// name has one reading at every place, so the scan below never goes back.
const END_NAME = /@(?:"([^"\n]+)"(?![^\s@])|(\S+))\s*/y;

/**
 * The "@name" words that end `s` after a blank line: { index (of that "\n\n"), paths }, or null. One pass over the
 * text: the regular expression this replaces went back and forth over a long "@!@!@…" for minutes. A later blank
 * line inside names that failed fails at the same place, so the next try starts after it.
 */
function endNames(s) {
  for (let from = s.indexOf('\n\n@'); from !== -1;) {
    const paths = [];
    let at = from + 2;
    END_NAME.lastIndex = at;
    for (let n; (n = END_NAME.exec(s));) {
      paths.push(n[1] || n[2]);
      at = END_NAME.lastIndex;
    }
    if (at === s.length) return { index: from, paths };
    from = s.indexOf('\n\n@', at);
  }
  return null;
}

/**
 * The owner's message as its bubble shows it. The files sent with it are named at its end for the coding tool
 * ("@.uploads/…"); they go out of the text, and each is a chip below. A message read back from the conversation, or
 * one from an older computer, names an upload only there: it becomes a chip by its name. An "@file" the owner wrote
 * at the end himself stays his words. → { text, files }
 */
export function ownMessageView(text, files = []) {
  const s = String(text || '');
  const m = endNames(s);
  if (!m) return { text: s, files };
  const paths = m.paths;
  const uploads = paths.filter((p) => /(?:^|\/)\.uploads\//.test(p));
  if (!files.some((f) => f.type === 'file') && uploads.length !== paths.length) return { text: s, files };
  const named = new Set(files.map((f) => f.name));
  const more = uploads.map((p) => p.split('/').pop()).filter((n) => n && !named.has(n)).map((name) => ({ type: 'file', name, mime: '' }));
  return { text: s.slice(0, m.index), files: [...files, ...more] };
}

/**
 * The transcript views, in the words of the desktop app's session menu (Transcript view). Thinking is offered once
 * the session has thinking to show.
 */
export const VIEWS = [
  { id: 'normal', label: 'Normal', sub: 'Tool calls collapsed into summaries, with full text responses' },
  { id: 'thinking', label: 'Thinking', sub: 'Tool calls collapsed into summaries, plus Claude\'s thinking' },
  { id: 'verbose', label: 'Verbose', sub: 'Every tool call, file read and step, plus Claude\'s thinking' },
];
export const viewOk = (id) => VIEWS.some((x) => x.id === id);
/**
 * The views the menu offers: Thinking only when there is thinking to show (or it is the view now). `who`: the coding
 * tool as a sentence names it (toolWord): an OpenCode session's thinking is not Claude's.
 */
export const viewChoices = (now, thought, who = 'Claude') => VIEWS.filter((x) => x.id !== 'thinking' || thought || now === 'thinking')
  .map((x) => ({ ...x, sub: x.sub.replace('Claude\'s thinking', `${who}'s thinking`) }));
/**
 * Whether dollars are said for this chat's turns: only on a provider billed by use (an API key or a gateway). A
 * subscription's sign-in is not billed per turn, so its dollar figures mislead; a provider not known says none.
 */
export const billed = (v) => !!(v && v.profile && (v.profile.kind === 'api' || v.profile.kind === 'openai'));

// ---------- the composer's chips ----------

/**
 * The permission modes as the chip and its menu say them: Claude Code's own names (its desktop app's mode selector,
 * and "don't ask", which only its terminal has). `danger`: runs anything (the chip is marked).
 */
export const MODE = {
  manual: { chip: 'Manual', sub: 'Asks before editing files or running commands' },
  acceptEdits: { chip: 'Accept edits', sub: 'Accepts file edits and common file commands; asks before other commands' },
  plan: { chip: 'Plan', sub: 'Explores, then proposes a plan without editing your code' },
  auto: { chip: 'Auto', sub: 'Runs without routine prompts; a background check reviews risky actions' },
  dontAsk: { chip: 'Don\'t ask', sub: 'Anything not already allowed is refused' },
  bypassPermissions: { chip: 'Bypass permissions', sub: 'Runs without permission prompts (riskiest)', danger: true },
};
/** The mode menu in the desktop app's order; what it does not offer (don't ask) waits under "More modes". */
export const MODE_MENU = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export const MODE_RARE = ['dontAsk'];
/**
 * The menu's two parts for the modes the chat offers (`modes`, the server's list in any order): { main, rare }. A mode
 * this page does not know (a newer server's) goes to the end of the main part.
 */
export function modeMenu(modes = Object.keys(MODE)) {
  const main = [...MODE_MENU.filter((m) => modes.includes(m)), ...modes.filter((m) => !MODE_MENU.includes(m) && !MODE_RARE.includes(m))];
  return { main, rare: MODE_RARE.filter((m) => modes.includes(m)) };
}
/**
 * A plan's first two answers, as Claude Code words them: approve and go on in auto mode ("Yes, auto-accept edits"
 * where the chat does not offer auto mode), or approve and review each edit. `modes`: the chat's (null: an older
 * computer that did not say, whose Claude Code had auto mode). → [{ label, mode }]
 */
export function planAnswers(modes) {
  const auto = !Array.isArray(modes) || modes.includes('auto');
  return [
    auto ? { label: 'Yes, and use auto mode', mode: 'auto' } : { label: 'Yes, auto-accept edits', mode: 'acceptEdits' },
    { label: 'Yes, manually approve edits', mode: 'manual' },
  ];
}
/**
 * The modes a plan's answers may switch to: the chat's, but for Claude Code auto mode only once the session showed it
 * has it (`autoMode`: it ran in auto mode). Its mode list always names auto, yet auto mode needs a model and settings
 * that allow it; until then "Yes, auto-accept edits" is the first answer, which works everywhere. → [modes] or null
 */
export function planModes(v) {
  const modes = v && v.choices && Array.isArray(v.choices.modes) ? v.choices.modes : null;
  if (!modes) return null;
  const claude = !(v.engine && v.engine.id && v.engine.id !== 'claude');
  return claude && v.autoMode !== true ? modes.filter((m) => m !== 'auto') : modes;
}
/**
 * What a look's answer (events and state in one, stream.js) says before its state is applied: the first look draws
 * the events first. Its coding tool (the events are drawn in its words) and its modes (a plan that waits is drawn
 * with the answers it has: planModes). An older computer's answer without them changes nothing. → the state to draw with
 */
export function beforeState(v, r) {
  let w = v;
  if (r.engine && !(w && w.engine)) w = { ...(w || {}), engine: r.engine };
  if (r.choices && !(w && w.choices)) w = { ...(w || {}), choices: r.choices, autoMode: r.autoMode };
  return w;
}
/** The order Shift+Tab goes through, as in Claude Code (don't ask is only in the menu). */
export const MODE_CYCLE = ['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];
export function nextMode(now, modes = Object.keys(MODE)) {
  const ring = MODE_CYCLE.filter((m) => modes.includes(m));
  const i = ring.indexOf(now || 'manual');
  return ring[(i + 1) % ring.length];
}
/** The mode the chat runs in: what the running process says, else what is set (null: Claude Code's default, Manual). */
export const modeOf = (v) => (v.liveMode ? (v.liveMode === 'default' ? 'manual' : v.liveMode) : v.permissionMode || 'manual');
export const modeChip = (m) => (MODE[m] ? MODE[m].chip : m ? m : MODE.manual.chip);
/**
 * A mode as the chip and menu say it: Claude Code's name (one word for one mode, in every coding tool's chat), and
 * what it does in the chat's coding tool's own words where it has them (what its modes do differs), else Claude Code's.
 */
export const modeInfo = (v, m) => {
  const own = v && v.choices && v.choices.modeWords && v.choices.modeWords[m];
  if (!own) return MODE[m] || null;
  return MODE[m] ? { ...own, chip: MODE[m].chip } : own;
};
/** How the page names the chat's coding tool in a sentence: "Claude" for Claude Code, else the tool's name. */
export const toolWord = (v) => (v && v.engine && v.engine.id && v.engine.id !== 'claude' ? v.engine.label || v.engine.id : 'Claude');
/** What the chat's coding tool can do (its engine's capabilities; before the first state: nothing extra). */
export const caps = (v) => (v && v.engine && v.engine.capabilities) || {};
/**
 * Whether the chat offers Compact: not while it is read only (a terminal runs the conversation or its coding tool is
 * off: a compact is a message to the coding tool), and not where its coding tool says it cannot (absent: an older
 * dashboard's Claude Code, which can).
 */
export const canCompact = (v) => caps(v).compact !== false && !(v && (v.terminal || v.toolOff));

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
/**
 * Whether the chat's provider has plan limits to show (a Claude subscription or sign-in, in a chat of Claude Code): a
 * gateway, an API key, Auto mode or another coding tool has none, whatever the coding tool reports through it.
 */
export const hasPlan = (v) => !(v && v.engine && v.engine.id && v.engine.id !== 'claude')
  && !(v && v.profile && v.profile.kind && v.profile.kind !== 'subscription' && v.profile.kind !== 'login');

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

/**
 * What the page of a session that is not open any more says: moved to its terminal (`was.terminal`), else archived
 * (the session menu's Archive) or moved to the Terminal. One word for one act: Archive, not "closed".
 */
export const goneWords = (was) => (was && was.terminal ? 'This session moved to the Terminal: the conversation goes on there.' : 'This session is not open in the App any more: it was archived, or moved to the Terminal.');

/** A turn runs (Stop and Esc end it; a message is queued). A chat of an older computer says only "working". */
export const turnRuns = (v) => !!(v && (v.turn !== undefined ? v.turn : v.working));

/** A screen that is touched, not pointed at: no keyboard hints there (Enter makes a new line). Asked each time. */
export const touchScreen = () => typeof matchMedia !== 'undefined' && (matchMedia('(pointer: coarse)').matches || matchMedia('(any-pointer: coarse)').matches);
