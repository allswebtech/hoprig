// A Claude Code conversation read back from its files, as the chat's events (src/chat/events.mjs): what a chat shows
// when it opens, and again when a terminal went on with the conversation meanwhile.
//
// Files of conversation <id> in <claudeDir>/projects/<slug>/ (Claude Code 2.1.325):
//   <id>.jsonl                    the main conversation: user and assistant lines, and many others (attachment,
//                                 queue-operation, cost-state, mode, file-history-*, api-request…): every kind not
//                                 known here is skipped. compact_boundary (system) and custom-title are read.
//   <id>/subagents/agent-<a>.jsonl + .meta.json   one subagent: its lines, and { agentType, description, toolUseId,
//                                 model/pickedEffortModel, effort, finished }: nested under the call toolUseId
//   <id>/workflows/<wf>.json      one workflow: { taskId, workflowName, status, phases, workflowProgress }
import fs from 'node:fs';
import path from 'node:path';
import { plainText } from '../events.mjs';
import { INTERRUPTED, localNotice, localOutput, newTodos, ownMessage, todoStep, toolResults, typedCommand } from './claude-content.mjs';
import { assistantEvents, workflowTree } from './claude-parse.mjs';

const KNOWN = ['"type":"user"', '"type":"assistant"', '"compact_boundary"', '"custom-title"', '"local_command"'];

/**
 * One line of a transcript into `st` ({ events, title, agent }: `agent`, the tool call a subagent's lines nest under).
 * The same step for the whole file at once (linesToEvents) and for one read in pieces (transcript-pieces.mjs).
 */
export function lineStep(st, l) {
  const { events, agent } = st;
  {
    if (!KNOWN.some((k) => l.includes(k))) return;
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      return; // the last line may be half written
    }
    if (!m || typeof m !== 'object') return;
    const at = Date.parse(m.timestamp) || null;
    if (m.type === 'custom-title' && typeof m.customTitle === 'string') st.title = plainText(m.customTitle, 200);
    else if (m.type === 'system' && m.subtype === 'compact_boundary') {
      const c = m.compactMetadata || m.compact_metadata || {};
      events.push({ kind: 'session-changed', id: m.sessionId || null, reason: 'compact', trigger: typeof c.trigger === 'string' ? c.trigger : null, at, agent });
    } else if (m.type === 'system' && m.subtype === 'local_command' && !agent) {
      // What a command the owner typed printed (/cost, /context …): kept as the notice it was in the chat.
      const out = localOutput(m.content);
      if (out) events.push({ ...localNotice(out), at });
    } else if (!m.message || (!agent && m.isSidechain)) return;
    else if (m.type === 'assistant' && m.message.model === '<synthetic>') {
      // An API error Claude Code wrote as a reply (live, the turn's end said it; read back there is no turn end).
      const t = (m.message.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
      if (t && (m.isApiErrorMessage || m.error)) events.push({ kind: 'notice', level: 'error', text: plainText(t, 1000), at, agent });
      else if (t) events.push({ ...localNotice(t), at });
    } else if (m.type === 'assistant') {
      const id = m.message.id || m.uuid || 'x';
      const thought = Number.isFinite(m.thinkingDurationMs) ? m.thinkingDurationMs : null;
      events.push(...assistantEvents(m.message.content, (i) => `${id}:t${i}:${m.uuid || ''}`, agent).map((e) => ({ ...e, at, ...(e.kind === 'thinking' ? { durationMs: thought } : {}) })));
    } else if (m.type === 'user' && !m.isMeta && !m.isCompactSummary && !m.isVisibleInTranscriptOnly) {
      const results = toolResults(m.message.content, m.toolUseResult, agent);
      if (results.length) events.push(...results.map((e) => ({ ...e, at })));
      else if (agent) return; // a subagent's prompt: its Agent call shows it
      else if (INTERRUPTED.test(typeof m.message.content === 'string' ? m.message.content : (m.message.content || []).map((c) => (c && c.text) || '').join('\n'))) {
        events.push({ kind: 'notice', level: 'info', text: 'Stopped.', at, agent: null });
      } else if (typedCommand(m.message.content)) {
        events.push({ kind: 'user', messageId: m.uuid || null, text: typedCommand(m.message.content), attachments: [], at, agent: null });
      } else {
        const own = ownMessage(m.message.content);
        if (own) events.push({ kind: 'user', messageId: m.uuid || null, ...own, at, agent: null });
      }
    }
  }
}

/** The events of the lines of one transcript file. `agent`: the tool call a subagent's lines nest under. */
function linesToEvents(text, agent) {
  const st = { events: [], title: null, agent };
  for (const l of text.split('\n')) lineStep(st, l);
  return { events: st.events, title: st.title };
}

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const listDir = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};

/** The subagents of a conversation (files in <id>/subagents), without their lines: [{ toolId, file, task }]. */
export function subagentList(dir) {
  const out = [];
  const sub = path.join(dir, 'subagents');
  for (const f of listDir(sub)) {
    const m = /^agent-([A-Za-z0-9_-]{1,100})\.meta\.json$/.exec(f);
    if (!m) continue;
    const meta = readJson(path.join(sub, f));
    if (!meta || typeof meta.toolUseId !== 'string') continue;
    const model = typeof meta.model === 'string' ? meta.model : typeof meta.pickedEffortModel === 'string' ? meta.pickedEffortModel : null;
    out.push({
      toolId: meta.toolUseId,
      file: path.join(sub, `agent-${m[1]}.jsonl`),
      task: {
        kind: 'task', taskId: m[1], toolId: meta.toolUseId, type: 'agent', title: plainText(meta.description, 200), agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
        status: meta.finished === true ? 'completed' : 'unknown', background: meta.requestShape === 'background' || undefined, model, effort: typeof meta.effort === 'string' ? meta.effort : null,
      },
    });
  }
  return out;
}

/** The subagents of a conversation: their events and a task each. */
function subagents(dir) {
  return subagentList(dir).map((s) => {
    let text = '';
    try {
      text = fs.readFileSync(s.file, 'utf8');
    } catch {
      /* no lines yet */
    }
    return { ...s, events: linesToEvents(text, s.toolId).events };
  });
}

/** The main conversation's events with each subagent's events right after the call that started it. byTool: Map(toolId → events) */
export function nestAgents(mainEvents, byTool) {
  const events = [];
  for (const e of mainEvents) {
    events.push(e);
    if (e.kind === 'tool' && byTool.has(e.id)) {
      events.push(...byTool.get(e.id));
      byTool.delete(e.id);
    }
  }
  return events;
}

/** A workflow is linked to its call by the task id its call's result names. */
export function linkWorkflows(tasks, mainEvents) {
  for (const t of tasks) {
    if (t.type !== 'workflow' || t.toolId) continue;
    const r = mainEvents.find((e) => e.kind === 'tool-result' && e.text.includes(t.taskId));
    if (r) t.toolId = r.id;
  }
}

/** The workflows of a conversation (<id>/workflows/*.json) as tasks with their phases and agents. */
export function workflows(dir) {
  const out = [];
  const wf = path.join(dir, 'workflows');
  for (const f of listDir(wf)) {
    if (!/^[A-Za-z0-9_-]{1,100}\.json$/.test(f)) continue;
    const j = readJson(path.join(wf, f));
    if (!j || typeof j.taskId !== 'string') continue;
    out.push({
      kind: 'task', taskId: j.taskId, type: 'workflow', title: plainText(j.workflowName || j.summary || 'workflow', 200),
      status: typeof j.status === 'string' ? j.status : 'unknown', ...workflowTree(Array.isArray(j.workflowProgress) ? j.workflowProgress : []),
      usage: { tokens: Number.isFinite(j.totalTokens) ? j.totalTokens : null, tools: Number.isFinite(j.totalToolCalls) ? j.totalToolCalls : null, ms: Number.isFinite(j.durationMs) ? j.durationMs : null },
    });
  }
  return out;
}

/**
 * The conversation in transcript `file` → { events, tasks, todos, title, size, mtimeMs }: the main conversation with
 * each subagent's events right after the call that started it, the tasks (subagents and workflows), the to-do list
 * as the calls left it, and the title the conversation was given.
 */
export function readTranscript(file) {
  let text;
  let st;
  try {
    st = fs.statSync(file);
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { events: [], tasks: [], todos: [], title: null, size: 0, mtimeMs: 0 };
  }
  const main = linesToEvents(text, null);
  const dir = file.replace(/\.jsonl$/, '');
  const subs = subagents(dir);
  const events = nestAgents(main.events, new Map(subs.map((s) => [s.toolId, s.events])));
  const tasks = [...subs.map((s) => s.task), ...workflows(dir)];
  linkWorkflows(tasks, main.events);
  const todos = newTodos();
  for (const e of main.events) todoStep(todos, e);
  return { events, tasks, todos: todos.list, title: main.title, size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * Where a conversation goes on from when it is rewound to before the owner's message `messageId` (the uuid of its
 * line): { at (the uuid of the line before it; null: the message was the first), text (the message, for the
 * composer) }, or null when the file has no such message of the owner.
 */
export function forkPoint(file, messageId) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const l of text.split('\n')) {
    if (!l.includes(messageId) || !l.includes('"type":"user"')) continue;
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      continue;
    }
    if (!m || m.type !== 'user' || m.uuid !== messageId || !m.message || m.isSidechain) continue;
    const own = ownMessage(m.message.content);
    return { at: typeof m.parentUuid === 'string' && m.parentUuid ? m.parentUuid : null, text: typedCommand(m.message.content) || (own ? own.text : '') };
  }
  return null;
}

/**
 * Where a copy of the whole conversation goes on from (the session menu's Fork): the uuid of its newest line of the
 * main conversation (a message of the owner's or of Claude's, not a subagent's), or null when the file has none yet.
 */
export function endPoint(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.includes('"uuid"')) continue;
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      continue; // a line still being written
    }
    if (m && (m.type === 'user' || m.type === 'assistant') && typeof m.uuid === 'string' && m.uuid && !m.isSidechain && m.message) return m.uuid;
  }
  return null;
}
