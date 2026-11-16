// What Claude Code says on stdout (stream-json, with partial messages and replayed user messages) → the chat's events
// (src/chat/events.mjs). One parser per process: it follows the message being streamed (to give a block one id from
// its first delta to its final text), the tool calls seen (a plan's text is in the call, not in the ask), the tasks
// (a subagent's ask names its task) and the to-do list. Unknown lines give nothing; it never throws.
//
// Shapes seen on Claude Code 2.1.325 (stand-in Messages API):
//   stream_event {event: message_start | content_block_start | content_block_delta (text_delta, thinking_delta,
//     input_json_delta) | content_block_stop | …}; and the whole block once more as an `assistant` line of the same
//     message id as the block ends (seen just before its content_block_stop). A subagent's messages are never streamed, only whole, and carry
//     parent_tool_use_id: the Agent call that started it (a subagent of a subagent carries its own parent's call).
//   system/init (every turn) · system/status {status: requesting | compacting | null, permissionMode?} ·
//   system/thinking_tokens · system/api_retry · system/task_started | task_progress (workflow_progress for a
//   workflow) | task_updated {patch} | task_notification · system/background_tasks_changed {tasks} ·
//   system/compact_boundary · system/session_title_changed · conversation_reset {new_conversation_id, trigger} ·
//   command_lifecycle {command_uuid, state: queued | started | completed | cancelled} (our messages, by our uuid) ·
//   tool_progress · rate_limit_event (a subscription sign-in) · control_request can_use_tool · control_cancel_request ·
//   control_response (the answers to our requests) · result (a turn ended; a background task's end starts another).
import { clipInput, clipText, plainText } from '../events.mjs';
import { localNotice, localOutput, newTodos, ownMessage, todoStep, toolResults } from './claude-content.mjs';
import { askWhy, ownerOnly, sessionGrant, settledByRule } from './claude-lines.mjs';

const KINDS = {
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Bash: 'shell', BashOutput: 'shell', KillShell: 'shell', Monitor: 'shell',
  Read: 'read', Grep: 'search', Glob: 'search', ToolSearch: 'search', WebFetch: 'web', WebSearch: 'web', Agent: 'agent', Task: 'agent',
  SendMessage: 'agent', Workflow: 'workflow', EnterPlanMode: 'plan', ExitPlanMode: 'plan', AskUserQuestion: 'question',
  TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', TaskList: 'todo', TaskGet: 'todo',
};
export const toolKind = (name) => KINDS[name] || 'other';

const TITLE_KEYS = ['description', 'command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'subject', 'skill'];
/** A tool call in a few words: what it runs or touches. */
export function toolTitle(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of TITLE_KEYS) if (typeof input[k] === 'string' && input[k].trim()) return plainText(input[k], 200);
  return '';
}
// What an OK is really about: the command it runs, the file it writes, the page it reads. Not `description`: for a
// command that is the model's own label of it ("Install the helper"), which says nothing of what runs.
const SUBJECT_KEYS = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern', 'query', 'skill'];
/** The subject of a tool call in full (clipped at 2000 characters): what the owner and Tia's rules judge. */
export function askSubject(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of SUBJECT_KEYS) if (typeof input[k] === 'string' && input[k].trim()) return input[k].slice(0, 2000);
  try {
    return JSON.stringify(input).slice(0, 2000); // an MCP tool's input: all of it
  } catch {
    return '';
  }
}
// The same from a tool's input while it still streams (partial JSON): the first of those keys whose string is whole.
const PARTIAL = new RegExp(`"(${TITLE_KEYS.join('|')})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
function partialTitle(json) {
  const m = PARTIAL.exec(json);
  if (!m) return '';
  try {
    return plainText(JSON.parse(`"${m[2]}"`), 200);
  } catch {
    return '';
  }
}

const TASK_TYPES = { local_agent: 'agent', remote_agent: 'agent', local_bash: 'shell', local_workflow: 'workflow', monitor: 'monitor', local_monitor: 'monitor' };
const usageOf = (u) => (u && typeof u === 'object'
  ? { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }
  : null);
const num = (x) => (Number.isFinite(x) ? x : null);
const str = (x, max = 300) => (typeof x === 'string' ? x.slice(0, max) : null);

// The model name of a message Claude Code writes itself (a local command's answer, an error it reports).
const SYNTHETIC = '<synthetic>';

const BLOCKS = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);

/** The events of one assistant message's blocks. `blockId(i)`: the id of block i (the same its deltas had). */
export function assistantEvents(content, blockId, agent) {
  const out = [];
  (Array.isArray(content) ? content : []).forEach((c, i) => {
    if (!c || !BLOCKS.has(c.type)) return;
    const id = blockId(i); // taken for every such block, shown or not, so the next one gets its own
    if (c.type === 'text' && c.text && c.text.trim()) out.push({ kind: 'text', blockId: id, text: c.text, agent });
    else if (c.type === 'thinking' && typeof c.thinking === 'string') out.push({ kind: 'thinking', blockId: id, text: clipText(c.thinking, 20000), agent });
    else if (c.type === 'redacted_thinking') out.push({ kind: 'thinking', blockId: id, text: '', agent });
    else if (c.type === 'tool_use') {
      const input = c.input && typeof c.input === 'object' ? c.input : {};
      out.push({ kind: 'tool', id: String(c.id), name: String(c.name), title: toolTitle(input), toolKind: toolKind(String(c.name)), input: clipInput(input), full: input, agent });
    }
  });
  return out;
}

/** A task line (task_started …, a workflow's progress) → a `task` event: the fields it says, nothing else. */
function taskEvent(m) {
  const p = m.patch && typeof m.patch === 'object' ? m.patch : {};
  const ev = { kind: 'task', taskId: String(m.task_id) };
  if (m.tool_use_id) ev.toolId = String(m.tool_use_id);
  if (m.task_type) ev.type = TASK_TYPES[m.task_type] || 'other';
  // task_started names the task; later lines say what it does now in the same field.
  if (typeof m.description === 'string') ev[m.subtype === 'task_started' ? 'title' : 'now'] = plainText(m.description, 200);
  if (typeof m.workflow_name === 'string') ev.title = plainText(m.workflow_name, 200);
  if (typeof m.is_backgrounded === 'boolean') ev.background = m.is_backgrounded;
  if (typeof m.subagent_type === 'string') ev.agentType = m.subagent_type.slice(0, 100);
  if (m.subtype === 'task_started') ev.status = 'running';
  const status = m.status || p.status;
  if (typeof status === 'string') ev.status = status === 'killed' ? 'stopped' : status;
  if (p.error || m.error) ev.error = plainText(String(p.error || m.error), 500);
  if (m.usage && typeof m.usage === 'object') ev.usage = { tokens: num(m.usage.total_tokens), tools: num(m.usage.tool_uses), ms: num(m.usage.duration_ms) };
  if (typeof m.summary === 'string') ev.summary = plainText(m.summary, 300);
  if (typeof m.last_tool_name === 'string') ev.lastTool = m.last_tool_name.slice(0, 100);
  if (Array.isArray(m.workflow_progress)) Object.assign(ev, workflowTree(m.workflow_progress));
  return ev;
}

/** A workflow's phases and agents (workflow_progress, or workflowProgress of its record). */
export function workflowTree(list) {
  const phases = [];
  const agents = [];
  for (const x of list.slice(0, 500)) {
    if (!x || typeof x !== 'object') continue;
    if (x.type === 'workflow_phase') phases.push({ index: num(x.index), title: plainText(x.title, 200) });
    else if (x.type === 'workflow_agent') {
      agents.push({
        index: num(x.index), label: plainText(x.label, 200), phase: num(x.phaseIndex), agentId: str(x.agentId, 100), model: str(x.model, 100),
        effort: str(x.effort, 20), state: str(x.state, 30), tokens: num(x.tokens), tools: num(x.toolCalls), ms: num(x.durationMs),
        result: x.resultPreview ? plainText(x.resultPreview, 300) : null,
      });
    }
  }
  return { phases, agents };
}

export class ClaudeParser {
  constructor() {
    this.msg = null; // the message being streamed
    this.blocks = new Map(); // its blocks by index → { blockId, type, id, name, json, titled }
    this.started = new Map(); // message id → ids of its blocks not yet given whole (its assistant lines come in that order)
    this.calls = new Map(); // tool use id → { name, input } (the newest 2000)
    this.taskTool = new Map(); // task id → the tool call that started it (a subagent's ask names its task)
    this.thinking = null; // the thinking block being streamed (its token count comes on its own line)
    this.thinkAt = new Map(); // thinking block id → when it started (how long it thought)
    this.usageOf = null; // the message whose prompt size was told last
    this.todos = newTodos();
    this.n = 0;
  }

  #call(id, name, input) {
    this.calls.set(id, { name, input });
    if (this.calls.size > 2000) this.calls.delete(this.calls.keys().next().value);
  }

  /** The id of block `i` of an assistant line of message `id`: the one its deltas had while it streamed. */
  #blockId(id) {
    const started = this.started.get(id);
    return (i) => (started && started.length ? started.shift() : `${id}:f${i}:${++this.n}`);
  }

  /** The to-do list followed from the main conversation's tool calls: a `todos` event when it changed. */
  #todos(events) {
    let changed = false;
    for (const e of events) if (!e.agent && todoStep(this.todos, e)) changed = true;
    return changed ? [...events, { kind: 'todos', list: this.todos.list.map((t) => ({ ...t })) }] : events;
  }

  line(raw) {
    let m;
    try {
      m = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
      return [];
    }
    if (!m || typeof m !== 'object') return [];
    try {
      return this.#line(m);
    } catch {
      return []; // a shape this version does not know
    }
  }

  #line(m) {
    const agent = m.parent_tool_use_id ? String(m.parent_tool_use_id) : null;
    switch (m.type) {
      case 'stream_event':
        return this.#stream(m.event || {}, agent);
      case 'assistant': {
        if (!m.message) return [];
        const id = m.message.id || `m${++this.n}`;
        const out = assistantEvents(m.message.content, this.#blockId(id), agent);
        // What Claude Code answers by itself (/cost, /context, /model …) is no reply of the model: a notice.
        if (m.message.model === SYNTHETIC && !m.error && !m.isApiErrorMessage) return out.filter((e) => e.kind === 'text').map((e) => localNotice(e.text));
        // An API error Claude Code writes as a reply (a usage limit, a refusal): the turn's end says it (the limit
        // banner, or the error box); as a reply too it would be said twice. It used no context either.
        if (m.message.model === SYNTHETIC) return [];
        for (const e of out) {
          if (e.kind === 'tool') this.#call(e.id, e.name, e.full);
          // How long it thought: Claude Code's own figure where the line has it, else since its first delta.
          if (e.kind === 'thinking') e.durationMs = num(m.thinkingDurationMs) ?? (this.thinkAt.has(e.blockId) ? Date.now() - this.thinkAt.get(e.blockId) : null);
          this.thinkAt.delete(e.blockId);
        }
        const u = m.message.usage;
        if (!agent && u && this.usageOf !== id) {
          this.usageOf = id;
          out.push({ kind: 'usage', contextUsed: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) });
        }
        return this.#todos(out);
      }
      case 'user': {
        if (!m.message) return [];
        const content = m.message.content;
        if (m.isReplay) {
          const out = localOutput(content);
          if (out !== null) return out ? [localNotice(out)] : [];
          const own = ownMessage(content);
          return own ? [{ kind: 'user', messageId: m.uuid ? String(m.uuid) : null, ...own, agent: null }] : [];
        }
        return this.#todos(toolResults(content, m.tool_use_result, agent));
      }
      case 'system':
        return this.#system(m);
      case 'tool_progress':
        return m.tool_use_id ? [{ kind: 'tool-progress', id: String(m.tool_use_id), elapsedS: num(m.elapsed_time_seconds), agent }] : [];
      case 'command_lifecycle':
        return m.command_uuid ? [{ kind: 'queue-state', messageId: String(m.command_uuid), state: String(m.state || '') }] : [];
      case 'conversation_reset':
        return m.new_conversation_id ? [{ kind: 'session-changed', id: String(m.new_conversation_id), reason: m.trigger === 'clear' ? 'clear' : String(m.trigger || 'clear').slice(0, 30), agent: null }] : [];
      case 'rate_limit_event': {
        const r = m.rate_limit_info || {};
        return [{ kind: 'limits', window: str(r.rateLimitType, 40) || 'unknown', status: str(r.status, 40), utilization: num(r.utilization), resetsAt: num(r.resetsAt) }];
      }
      case 'control_request':
        return m.request && m.request.subtype === 'can_use_tool' && m.request_id ? [this.#ask(String(m.request_id), m.request)] : [];
      case 'control_cancel_request':
        return m.request_id ? [{ kind: 'ask-cancelled', request: String(m.request_id) }] : [];
      case 'control_response': {
        const r = m.response || {};
        return r.request_id ? [{ kind: 'control-answer', requestId: String(r.request_id), ok: r.subtype === 'success', response: r.response ?? null, error: r.error ? String(r.error).slice(0, 300) : null, code: r.error_code || null }] : [];
      }
      case 'result':
        return this.#result(m);
      default:
        return [];
    }
  }

  #stream(e, agent) {
    switch (e.type) {
      case 'message_start':
        this.msg = (e.message && e.message.id) || `m${++this.n}`;
        this.blocks.clear();
        this.started.set(this.msg, []);
        if (this.started.size > 50) this.started.delete(this.started.keys().next().value);
        return [];
      case 'content_block_start': {
        const b = e.content_block || {};
        const block = { blockId: `${this.msg}:${e.index}`, type: b.type, id: b.id ? String(b.id) : null, name: String(b.name || ''), json: '', titled: false };
        this.blocks.set(e.index, block);
        // Claude Code gives the whole block as an assistant line while it ends (before or after its stop event).
        if (BLOCKS.has(b.type)) this.started.get(this.msg)?.push(block.blockId);
        if (b.type === 'thinking') {
          this.thinking = block.blockId;
          this.thinkAt.set(block.blockId, Date.now());
          if (this.thinkAt.size > 50) this.thinkAt.delete(this.thinkAt.keys().next().value);
        }
        if (b.type === 'text') return [{ kind: 'text-delta', blockId: block.blockId, text: '', agent }];
        if (b.type === 'thinking') return [{ kind: 'thinking-delta', blockId: block.blockId, text: '', agent }];
        if (b.type === 'tool_use') return [{ kind: 'tool-start', id: block.id, name: block.name, title: '', toolKind: toolKind(block.name), agent }];
        return [];
      }
      case 'content_block_delta': {
        const b = this.blocks.get(e.index);
        const d = e.delta || {};
        if (!b) return [];
        if (d.type === 'text_delta') return [{ kind: 'text-delta', blockId: b.blockId, text: String(d.text || ''), agent }];
        if (d.type === 'thinking_delta') return [{ kind: 'thinking-delta', blockId: b.blockId, text: String(d.thinking || ''), agent }];
        if (d.type === 'input_json_delta' && b.type === 'tool_use' && !b.titled) {
          b.json = (b.json + String(d.partial_json || '')).slice(0, 20000);
          const title = partialTitle(b.json);
          if (title) {
            b.titled = true;
            return [{ kind: 'tool-start', id: b.id, name: b.name, title, toolKind: toolKind(b.name), agent }];
          }
        }
        return [];
      }
      case 'content_block_stop': {
        const b = this.blocks.get(e.index);
        if (b && b.blockId === this.thinking) this.thinking = null;
        return [];
      }
      default:
        return [];
    }
  }

  #system(m) {
    switch (m.subtype) {
      case 'init':
        return [{
          kind: 'session', id: m.session_id || null, model: str(m.model, 100), mode: str(m.permissionMode, 40), cwd: str(m.cwd, 4096),
          version: str(m.claude_code_version, 40), tools: (m.tools || []).slice(0, 300).map(String),
          commands: (m.slash_commands || []).slice(0, 500).map(String), skills: (m.skills || []).slice(0, 500).map((s) => String(s.name || s)),
          agents: (m.agents || []).slice(0, 200).map((a) => String(a.name || a)),
        }];
      case 'status': {
        const out = [];
        if (typeof m.permissionMode === 'string') out.push({ kind: 'mode', mode: m.permissionMode });
        if (m.status === 'requesting' || m.status === 'compacting') out.push({ kind: 'status', state: m.status });
        else if ('status' in m && !m.status) out.push({ kind: 'status', state: null }); // that step is over
        return out;
      }
      case 'thinking_tokens':
        return this.thinking ? [{ kind: 'thinking-delta', blockId: this.thinking, text: '', tokens: num(m.estimated_tokens) }] : [];
      case 'api_retry':
        return [{ kind: 'status', state: 'retrying', retry: { attempt: num(m.attempt), max: num(m.max_retries), delayMs: num(m.retry_delay_ms), error: String(m.error || 'unknown').slice(0, 100) } }];
      case 'task_started':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification': {
        if (!m.task_id) return [];
        const ev = taskEvent(m);
        if (ev.toolId) this.taskTool.set(ev.taskId, ev.toolId);
        const call = ev.toolId && this.calls.get(ev.toolId);
        // The model and effort an Agent call asked for (Auto: the working rules pick them per task).
        if (m.subtype === 'task_started' && call && call.input) {
          if (typeof call.input.model === 'string') ev.model = call.input.model.slice(0, 60);
          if (typeof call.input.effort === 'string') ev.effort = call.input.effort.slice(0, 20);
        }
        return [ev];
      }
      case 'background_tasks_changed':
        return [{ kind: 'tasks-running', ids: (Array.isArray(m.tasks) ? m.tasks : []).map((t) => String(t && t.task_id)).filter(Boolean) }];
      case 'compact_boundary': {
        const c = m.compact_metadata || {};
        return [{ kind: 'session-changed', id: m.session_id || null, reason: 'compact', trigger: str(c.trigger, 20), preTokens: num(c.pre_tokens), postTokens: num(c.post_tokens), agent: null }];
      }
      case 'session_title_changed':
        return typeof m.title === 'string' ? [{ kind: 'title', text: plainText(m.title, 200) }] : [];
      case 'informational':
      case 'notification':
      case 'local_command_output': {
        const t = [m.content, m.text, m.message].find((x) => typeof x === 'string');
        return t ? [{ kind: 'notice', level: m.level === 'warning' || m.level === 'error' ? m.level : 'info', text: clipText(t, 2000), agent: null }] : [];
      }
      default:
        return [];
    }
  }

  #ask(request, r) {
    const tool = String(r.tool_name || 'tool');
    const call = r.tool_use_id ? this.calls.get(String(r.tool_use_id)) : null;
    const full = r.input && typeof r.input === 'object' ? r.input : {};
    const a = {
      kind: 'ask', request, tool, title: String(r.title || r.display_name || tool), toolId: r.tool_use_id ? String(r.tool_use_id) : null,
      description: typeof r.description === 'string' ? r.description.slice(0, 300) : '', subject: askSubject(full), input: clipInput(full), full,
      interactive: r.requires_user_interaction === true,
      reasonType: typeof r.decision_reason_type === 'string' ? r.decision_reason_type : null,
      reason: plainText(r.decision_reason, 300),
      ruleForced: r.decision_reason_type === 'rule' || (!!r.matched_ask_rule && typeof r.matched_ask_rule === 'object'),
      manualOnly: r.classifier_approvable === false,
      noAlways: r.suppress_always_allow_rule === true,
      agent: r.agent_id ? this.taskTool.get(String(r.agent_id)) || null : null,
    };
    a.type = tool === 'ExitPlanMode' ? 'plan' : tool === 'AskUserQuestion' ? 'question' : 'permission';
    // The plan's text is in the tool call, not in the ask.
    if (a.type === 'plan') a.plan = clipText(String(full.plan || (call && call.input && call.input.plan) || ''), 40000);
    a.owner = ownerOnly(a);
    a.why = askWhy(a);
    // What "allow in this chat" would add. Not offered where the answer must be the owner's each time, nor on
    // Claude Code's check of a sensitive file: it suggests "edits without asking" there too, and asks again for
    // the next such file all the same.
    a.grant = a.owner || a.noAlways || a.reasonType === 'safetyCheck' ? null : sessionGrant(r.permission_suggestions);
    a.settled = settledByRule(a);
    return a;
  }

  #result(m) {
    const ok = m.is_error !== true && m.subtype === 'success';
    const error = ok ? null : String(typeof m.result === 'string' && m.result ? m.result : m.subtype === 'error_during_execution' ? 'stopped' : (m.errors || []).join(' ') || m.subtype || 'error').slice(0, 500);
    const out = [];
    const mu = m.modelUsage && typeof m.modelUsage === 'object' ? m.modelUsage : null;
    if (mu || Number.isFinite(m.total_cost_usd)) {
      const windows = mu ? Object.values(mu).map((x) => x && x.contextWindow).filter(Number.isFinite) : [];
      out.push({ kind: 'usage', costTotal: num(m.total_cost_usd), ...(windows.length ? { contextWindow: Math.max(...windows) } : {}) });
    }
    out.push({ kind: 'turn-end', ok, subtype: m.subtype || null, error, costUsd: num(m.total_cost_usd), usage: usageOf(m.usage), durationMs: num(m.duration_ms) });
    return out;
  }
}
