// The coding chat's protocol with Claude Code: the arguments of a headless run, the lines written to it and read from
// it (stream-json), and the conversation as the page shows it, from the live stream or from the transcript file.
//
// Checked on Claude Code 2.1.325 against a stand-in Messages API (no model, no quota) and once against a real model:
//   --permission-prompt-tool stdio   a tool use that needs the owner's OK arrives on stdout as
//       {"type":"control_request","request_id":R,"request":{"subtype":"can_use_tool","tool_name","input",
//        "tool_use_id","description","permission_suggestions"}}
//     and is answered on stdin with
//       {"type":"control_response","response":{"subtype":"success","request_id":R,
//        "response":{"behavior":"allow","updatedInput":{…}}}}      or  {"behavior":"deny","message":"…"}
//     This is the channel the Agent SDK's canUseTool callback uses (docs: agent-sdk/typescript, "CanUseTool" and
//     "PermissionResult"); "stdio" is the value the SDK itself passes. /cli-reference documents the flag only with an
//     MCP tool, which would need a server of ours in every coding chat; stdio needs nothing more.
//   Stop: {"type":"control_request","request_id":X,"request":{"subtype":"interrupt"}}. Claude Code answers with a
//     control_response, ends the running tool, and the turn's result has subtype "error_during_execution".
//   A resumed conversation (--resume <id>) keeps writing the same transcript, <claudeDir>/projects/<slug>/<id>.jsonl,
//     so a chat opens in the terminal (claude --resume <id>) and the other way round.
//   total_cost_usd in a result is the conversation's total so far (it carries over a resume); usage is the turn's.
import fs from 'node:fs';

/** Claude Code's arguments for one coding chat. Its normal tools, CLAUDE.md, settings, MCP servers and skills stay. */
export function chatArgs({ sessionId, resume = false, permissionMode = null, effort = null, model = null }) {
  if (!sessionId) throw new Error('chatArgs needs a session id');
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio',
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(model ? ['--model', model] : []),
    resume ? '--resume' : '--session-id', sessionId,
  ];
}

const line = (o) => JSON.stringify(o) + '\n';
/** One message of the owner as a stream-json input line. */
export const userLine = (text) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text) }] } });
/** The owner allowed a tool use. `permissions`: rule changes for this session only (Claude Code's own suggestions). */
export const allowLine = (requestId, input, permissions = null) =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input, ...(permissions && permissions.length ? { updatedPermissions: permissions } : {}) } } });
export const denyLine = (requestId, message) =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } } });
export const interruptLine = (requestId) => line({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });

// ---------- what the page shows ----------

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

const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && c.type === 'text' ? c.text : c && c.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
};

// Turns Claude Code writes as if the user said them: command wrappers, reminders, hook output.
const MACHINE_TURN = /^\s*(<(command-|local-command|system-reminder|bash-|user-memory|task-notification)|Caveat:)/;
const INTERRUPTED = /^\[Request interrupted by user/;

/** The owner's own words in a user turn, or null when it is machine-made. */
function ownWords(content) {
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
  if (!text.trim() || MACHINE_TURN.test(text)) return null;
  return text;
}

/** The events of one assistant message's content. */
function assistantEvents(content) {
  const out = [];
  for (const c of Array.isArray(content) ? content : []) {
    if (c.type === 'text' && c.text && c.text.trim()) out.push({ kind: 'text', text: c.text });
    else if (c.type === 'tool_use') out.push({ kind: 'tool', id: c.id, name: String(c.name), input: clipInput(c.input || {}), full: c.input || {} });
  }
  return out;
}

/** The events of one user message's content: tool results, an interruption, or (from the transcript) the owner's words. */
function userEvents(content, { words }) {
  const out = [];
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && c.type === 'tool_result') out.push({ kind: 'result', id: c.tool_use_id, isError: c.is_error === true, text: clipText(resultText(c.content)) });
    }
  }
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n') : '';
  // Live, the turn's result says it stopped; only the transcript needs this line.
  if (INTERRUPTED.test(text)) {
    if (words) out.push({ kind: 'notice', text: 'Stopped.' });
  }
  else if (words && !out.length) {
    const own = ownWords(content);
    if (own) out.push({ kind: 'user', text: own });
  }
  return out;
}

const usageOf = (u) => (u && typeof u === 'object'
  ? { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }
  : null);

/**
 * One stdout line of the live process → events. Subagents' messages (parent_tool_use_id set) are left out: the
 * page shows the main conversation, with the subagent as one tool call. Never throws; unknown lines give [].
 *   { kind: "init", sessionId, model, permissionMode }
 *   { kind: "text", text } · { kind: "tool", id, name, input, full } · { kind: "result", id, isError, text }
 *   { kind: "ask", request, tool, title, description, input, full, suggestions }   a tool use waits for the owner's OK
 *   { kind: "ask-cancelled", request }
 *   { kind: "retry", attempt, error }
 *   { kind: "done", ok, subtype, error, costUsd, usage, durationMs }
 *   { kind: "notice", text }
 */
export function parseLine(raw) {
  let m;
  try {
    m = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!m || typeof m !== 'object') return [];
  if (m.type === 'system' && m.subtype === 'init') return [{ kind: 'init', sessionId: m.session_id || null, model: m.model || null, permissionMode: m.permissionMode || null }];
  if (m.type === 'system' && m.subtype === 'api_retry') return [{ kind: 'retry', attempt: m.attempt ?? null, error: String(m.error || 'unknown') }];
  if (m.parent_tool_use_id) return [];
  if (m.type === 'assistant' && m.message) return assistantEvents(m.message.content);
  if (m.type === 'user' && m.message) return userEvents(m.message.content, { words: false });
  if (m.type === 'control_request' && m.request && m.request.subtype === 'can_use_tool' && m.request_id) {
    const r = m.request;
    return [{
      kind: 'ask', request: String(m.request_id), tool: String(r.tool_name || 'tool'), title: String(r.title || r.display_name || r.tool_name || 'tool'),
      description: typeof r.description === 'string' ? r.description.slice(0, 300) : '', input: clipInput(r.input || {}), full: r.input || {},
      toolUseId: r.tool_use_id || null, suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
    }];
  }
  if (m.type === 'control_cancel_request' && m.request_id) return [{ kind: 'ask-cancelled', request: String(m.request_id) }];
  if (m.type === 'result') {
    const ok = m.is_error !== true && m.subtype === 'success';
    const error = ok ? null : String(typeof m.result === 'string' && m.result ? m.result : m.subtype === 'error_during_execution' ? 'stopped' : (m.errors || []).join(' ') || m.subtype || 'error').slice(0, 500);
    return [{ kind: 'done', ok, subtype: m.subtype || null, error, costUsd: Number.isFinite(m.total_cost_usd) ? m.total_cost_usd : null, usage: usageOf(m.usage), durationMs: Number.isFinite(m.duration_ms) ? m.duration_ms : null }];
  }
  return [];
}

/**
 * The conversation in a transcript file → { events, size, mtimeMs }. Only the main thread (no subagents) and the
 * owner's own words. Lines other than user and assistant turns (request records, summaries) are not even parsed.
 */
export function transcriptEvents(file) {
  let text;
  let st;
  try {
    st = fs.statSync(file);
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { events: [], size: 0, mtimeMs: 0 };
  }
  const events = [];
  for (const l of text.split('\n')) {
    if (!l.includes('"type":"user"') && !l.includes('"type":"assistant"')) continue;
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      continue; // the last line may be half written
    }
    if (!m || m.isSidechain || !m.message) continue;
    const at = Date.parse(m.timestamp) || null;
    if (m.type === 'assistant') events.push(...assistantEvents(m.message.content).map((e) => ({ ...e, at })));
    else if (m.type === 'user' && !m.isMeta) events.push(...userEvents(m.message.content, { words: true }).map((e) => ({ ...e, at })));
  }
  return { events, size: st.size, mtimeMs: st.mtimeMs };
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
  if (ev.kind === 'result' && t.creating.has(ev.id)) {
    const c = t.creating.get(ev.id);
    t.creating.delete(ev.id);
    const m = /^Task #(\S+) created/.exec(ev.text || '');
    if (ev.isError || !m) return false;
    t.list.push({ id: m[1], status: 'pending', ...c });
    if (t.list.length > 100) t.list.shift();
    return true;
  }
  return false;
}

export const newTodos = () => ({ list: [], creating: new Map() });
