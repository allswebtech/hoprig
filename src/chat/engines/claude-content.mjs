// What Claude Code's user lines hold (stream-json and its transcript alike): the owner's own words and pictures, a
// command he typed and what it printed, the results of tool calls (also one the owner stopped or said no to), and
// the to-do list followed from its tool calls. Used by claude-parse.mjs (live) and claude-transcript.mjs (read back).
import { clipDiff, clipText, plainText } from '../events.mjs';

const str = (x, max = 300) => (typeof x === 'string' ? x.slice(0, max) : null);

// Turns Claude Code writes as if the user said them: command wrappers, reminders, hook output, task notifications.
const MACHINE_TURN = /^\s*(<(command-|local-command|system-reminder|bash-|user-memory|task-notification)|Caveat:)/;
const LOCAL_OUT = /<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>/;
export const INTERRUPTED = /^\[Request interrupted by user/;

export const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '');

/** The owner's own words and pictures in a user message, or null when it is machine-made. */
export function ownMessage(content) {
  const text = textOf(content);
  if (MACHINE_TURN.test(text) || INTERRUPTED.test(text)) return null;
  const attachments = (Array.isArray(content) ? content : []).filter((c) => c && (c.type === 'image' || c.type === 'document'))
    .map((c) => ({ type: c.type === 'image' ? 'image' : 'file', name: str(c.title, 200) || '', mime: str(c.source && c.source.media_type, 100) || '' }));
  if (!text.trim() && !attachments.length) return null;
  return { text, attachments };
}
/** What a local command answered, as the notice the page shows in a box of its own. */
export const localNotice = (text) => ({ kind: 'notice', level: 'info', local: true, text: clipText(String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim(), 4000), agent: null });
// A command the owner typed, as Claude Code keeps it in the transcript.
const COMMAND = /^\s*<command-name>\/?([^<]{1,100})<\/command-name>/;
const ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
/** The command line the owner typed ("/model sonnet") from Claude Code's wrapper, or null. */
export function typedCommand(content) {
  const text = textOf(content);
  const m = COMMAND.exec(text);
  if (!m) return null;
  const args = (ARGS.exec(text) || [])[1];
  return `/${m[1].trim()}${args && args.trim() ? ` ${args.trim()}` : ''}`;
}
/** What a local command printed (/cost, /model …), or null. */
export const localOutput = (content) => {
  const m = LOCAL_OUT.exec(textOf(content));
  return m ? clipText(m[1].replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim(), 4000) : null;
};

const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
};

// A tool call that did not run, in the words Claude Code writes for the model: the owner stopped the turn (or said
// no in a terminal), or said no on the chat's card (asks.mjs writes that sentence, with his reason).
const STOPPED_RESULT = /^\s*(<tool_use_error>)?\s*The user doesn't want to (proceed with this tool use|take this action)/;
const DENIED_RESULT = /The user said no to this \S+ call in the dashboard(?:: ([\s\S]*?))?\. Do not do it another way/;

/** The tool-result events of one user message (tool_use_result: what Claude Code adds, an edit's patch among it). */
export function toolResults(content, extra, agent) {
  const out = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (!c || c.type !== 'tool_result') continue;
    const text = resultText(c.content);
    const id = String(c.tool_use_id || '');
    // Not run: no text written for the model, only what the owner did (and why, where he said it).
    if (c.is_error === true && STOPPED_RESULT.test(text)) {
      out.push({ kind: 'tool-result', id, ok: false, stopped: true, text: '', agent });
      continue;
    }
    const no = c.is_error === true ? DENIED_RESULT.exec(text) : null;
    if (no) {
      out.push({ kind: 'tool-result', id, ok: false, denied: true, text: no[1] ? plainText(no[1], 1000) : '', agent });
      continue;
    }
    const diff = extra && typeof extra === 'object' ? clipDiff(extra.structuredPatch) : null;
    out.push({ kind: 'tool-result', id, ok: c.is_error !== true, text: clipText(text), ...(diff ? { diff } : {}), agent });
  }
  return out;
}

// ---------- the to-do list ----------

/**
 * The to-do list Claude keeps, followed from its tool calls: TaskCreate / TaskUpdate (Claude Code 2.1.3xx) and
 * TodoWrite (older versions). `t` is { list: [{ id, content, status, activeForm }], creating: Map }. Returns true when
 * the list changed.
 */
export function todoStep(t, ev) {
  if (ev.kind === 'tool') {
    const i = ev.full || ev.input || {};
    if (ev.name === 'TodoWrite' && Array.isArray(i.todos)) {
      t.list = i.todos.slice(0, 100).map((x, n) => ({ id: String(n + 1), content: String(x.content || ''), status: String(x.status || 'pending'), activeForm: String(x.activeForm || '') }));
      return true;
    }
    if (ev.name === 'TaskCreate' && i.subject) t.creating.set(ev.id, { content: String(i.subject), activeForm: String(i.activeForm || '') });
    if (ev.name === 'TaskUpdate' && i.taskId !== undefined) {
      const it = t.list.find((x) => x.id === String(i.taskId));
      if (!it) return false;
      if (i.status === 'deleted') t.list = t.list.filter((x) => x !== it);
      else {
        if (i.status) it.status = String(i.status);
        if (i.subject) it.content = String(i.subject);
        if (i.activeForm) it.activeForm = String(i.activeForm);
      }
      return true;
    }
    return false;
  }
  if (ev.kind === 'tool-result' && t.creating.has(ev.id)) {
    const c = t.creating.get(ev.id);
    t.creating.delete(ev.id);
    const m = /^Task #(\S+) created/.exec(ev.text || '');
    if (!ev.ok || !m) return false;
    t.list.push({ id: m[1], status: 'pending', ...c });
    if (t.list.length > 100) t.list.shift();
    return true;
  }
  return false;
}

export const newTodos = () => ({ list: [], creating: new Map() });
