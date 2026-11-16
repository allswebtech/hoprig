// What OpenCode's server says (its event stream, GET /api/event of OpenCode 2.3) → the chat's events
// (src/chat/events.mjs). One mapper per open conversation: it follows the conversation and the conversations its
// subagents run (OpenCode makes a child conversation for each; their events nest under the call that started them).
// Never throws on a shape it does not know: such an event is left out.
//
// What was seen on the real server (the recording in test/chat/fixtures/opencode-events.jsonl):
//   a turn       session.execution.started … session.execution.succeeded | failed | interrupted (Stop)
//   a step       session.step.started (the model is asked) … session.step.ended { tokens, cost, files }
//   text         session.text.started / .delta / .ended { assistantMessageID, ordinal, text }; reasoning the same
//   a tool call  session.tool.input.started { id, name } → session.tool.called { id, input } → .success | .failed
//   a subagent   its call starts it and returns at once; it runs in a conversation of its own (session.created with
//                parentID) in the background, and when that ends the main conversation goes on by itself
//   an OK        permission.asked { id, action, resources, save, metadata.files[].patch, source.id (the call) } and
//                permission.replied; a question to the owner is a form (form.created / replied / cancelled)
//   a message    session.inbox.enqueued / delivered / cancelled { inboxID } (a message written while a turn runs)
import { askSubject, SUBJECT_MAX } from './claude-parse.mjs';
import { clipDiff, clipInput, clipText, plainText } from '../events.mjs';
import { unifiedHunks } from './diffs.mjs';

const str = (x, n = 200) => (typeof x === 'string' ? x.slice(0, n) : null);
const num = (x) => (Number.isFinite(x) ? x : null);

/**
 * OpenCode's tools in the page's words: the name its cards know and the input under the keys they read, so an edit
 * is drawn as a diff and a command as a command, as for Claude Code. A tool not named here keeps its own name.
 */
const TOOLS = {
  shell: { name: 'Bash', kind: 'shell', input: (i) => ({ command: i.command, description: i.description }) },
  edit: { name: 'Edit', kind: 'edit', input: (i) => ({ file_path: i.path ?? i.filePath, old_string: i.oldString, new_string: i.newString, replace_all: i.replaceAll }) },
  write: { name: 'Write', kind: 'edit', input: (i) => ({ file_path: i.path ?? i.filePath, content: i.content }) },
  patch: { name: 'Patch', kind: 'edit', input: (i) => i },
  read: { name: 'Read', kind: 'read', input: (i) => ({ file_path: i.path ?? i.filePath, offset: i.offset, limit: i.limit }) },
  glob: { name: 'Glob', kind: 'search', input: (i) => ({ pattern: i.pattern, path: i.path }) },
  grep: { name: 'Grep', kind: 'search', input: (i) => ({ pattern: i.pattern, path: i.path, glob: i.include ?? i.glob }) },
  list: { name: 'LS', kind: 'search', input: (i) => ({ path: i.path }) },
  webfetch: { name: 'WebFetch', kind: 'web', input: (i) => ({ url: i.url, prompt: i.prompt }) },
  websearch: { name: 'WebSearch', kind: 'web', input: (i) => ({ query: i.query }) },
  subagent: { name: 'Agent', kind: 'agent', input: (i) => ({ description: i.description, prompt: i.prompt, subagent_type: i.agent ?? i.subagent_type ?? i.subagentType }) },
  skill: { name: 'Skill', kind: 'other', input: (i) => ({ skill: i.name ?? i.skill, args: i.args }) },
};
/** An OK's action → the tool it is about, where no call was seen for it. */
const ACTION_TOOL = { shell: 'shell', edit: 'edit', read: 'read', webfetch: 'webfetch', websearch: 'websearch', glob: 'glob', grep: 'grep', subagent: 'subagent', skill: 'skill' };

/**
 * A call the owner refused: only the reason he gave (inside the chat's own sentence to the coding tool, asks.mjs), as
 * Claude Code's refused calls are drawn (denied: "you said no", with his reason).
 */
export function refusedReason(message) {
  if (typeof message !== 'string') return '';
  const m = /^The user said no to this \S+ call in the dashboard(?:: ([\s\S]*?))?\. Do not do it another way/.exec(message);
  return plainText(m ? m[1] || '' : message, 1000);
}

/**
 * The result of a call that did not succeed: refused by the owner, stopped by him (Stop: OpenCode's words then name
 * its own files and shell ids, which are nobody's business), or failed with the tool's words.
 */
export function failedResult(error, metadata) {
  const err = error && typeof error === 'object' ? error : {};
  if (err.type === 'permission.rejected') return { denied: true, text: refusedReason(err.message) };
  if (metadata && metadata.interrupted) return { stopped: true, text: '' };
  return { text: String(err.message || 'failed') };
}

const drop = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined && x !== null));
/** { name, toolKind, input } of an OpenCode call (its own name and input) in the page's words. */
export function pageTool(name, input) {
  const t = TOOLS[name];
  const i = input && typeof input === 'object' ? input : {};
  if (!t) return { name: String(name || 'tool').slice(0, 100), toolKind: 'other', input: i };
  return { name: t.name, toolKind: t.kind, input: drop(t.input(i)) };
}

const TITLE_KEYS = ['command', 'file_path', 'url', 'pattern', 'query', 'description', 'skill', 'path'];
const titleOf = (input, name) => {
  const k = TITLE_KEYS.find((x) => typeof input[x] === 'string' && input[x].trim());
  return k ? plainText(input[k], 200) : name;
};

/** The text of a tool's result (its content parts), or its error's words. */
const resultText = (d) => {
  const parts = Array.isArray(d.content) ? d.content : [];
  const t = parts.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  return t || (d.metadata && typeof d.metadata.notice === 'string' ? d.metadata.notice : '');
};

/** The hunks of a change's files (OpenCode gives each file's unified diff). */
export function filesDiff(files) {
  if (!Array.isArray(files)) return null;
  return clipDiff(files.flatMap((f) => (f && typeof f.patch === 'string' ? unifiedHunks(f.patch) : [])));
}

const usageOf = (t) => (t && typeof t === 'object'
  ? { input_tokens: num(t.input), output_tokens: num(t.output), cache_read_input_tokens: num(t.cache && t.cache.read), cache_creation_input_tokens: num(t.cache && t.cache.write) }
  : null);

/**
 * One conversation's mapper. o: { id (the conversation), contextWindow() (the model's, or null) }. feed(event) →
 * [chat events]. It also keeps what the session needs to answer: the asks and forms that wait.
 */
export class OpencodeEvents {
  constructor(o) {
    this.o = o;
    this.id = o.id;
    this.children = new Map(); // a subagent's conversation → the call that started it
    this.calls = new Map(); // call id → { name, input (OpenCode's own), agent }
    this.patches = new Map(); // call id → the diff its OK showed (a write's result carries none)
    this.waiting = new Map(); // a call that started a subagent, whose conversation has not come yet
    this.running = new Set(); // the subagents' conversations whose turn has not ended (Stop of one task, close)
    this.asks = new Map(); // request id → { kind: permission | form, form }
    this.turn = null; // { at, usage }
    this.cost = null; // the conversation's cost so far (what the server says)
  }

  /** The call a subagent's events nest under (null: the main conversation), or undefined: not this chat's. */
  agentOf(sid) {
    if (sid === this.id) return null;
    return this.children.has(sid) ? this.children.get(sid) : undefined;
  }

  feed(e) {
    try {
      return this.#feed(e) || [];
    } catch {
      return [];
    }
  }

  #feed(e) {
    const d = e && e.data && typeof e.data === 'object' ? e.data : null;
    if (!d) return [];
    if (e.type === 'session.created') return this.#child(d);
    if (e.type === 'form.created' && d.form) return this.#form(d.form);
    const sid = d.sessionID;
    const agent = this.agentOf(sid);
    if (agent === undefined) return [];
    const main = agent === null;
    const block = (kind) => `${d.assistantMessageID}:${kind}${num(d.ordinal) ?? 0}`;
    switch (e.type) {
      case 'session.execution.started':
        if (!main) return [];
        this.turn = { at: Date.now(), usage: null };
        return [{ kind: 'turn-begin' }];
      case 'session.step.started':
        return main ? [{ kind: 'status', state: 'requesting', model: d.model || null }] : [];
      case 'session.text.delta':
        return typeof d.delta === 'string' ? [{ kind: 'text-delta', blockId: block('t'), text: d.delta, agent }] : [];
      case 'session.text.ended':
        return typeof d.text === 'string' && d.text.trim() ? [{ kind: 'text', blockId: block('t'), text: d.text, agent }] : [];
      case 'session.reasoning.delta':
        return typeof d.delta === 'string' ? [{ kind: 'thinking-delta', blockId: block('r'), text: d.delta, agent }] : [];
      case 'session.reasoning.ended': // an empty one (a model that thinks without saying it) is no line to open
        return typeof d.text === 'string' && d.text.trim() ? [{ kind: 'thinking', blockId: block('r'), text: clipText(d.text, 20000), agent }] : [];
      case 'session.tool.input.started': {
        const id = str(d.id, 200);
        if (!id) return [];
        this.calls.set(id, { name: String(d.name || 'tool'), input: null, agent });
        const p = pageTool(d.name, {});
        return [{ kind: 'tool-start', id, name: p.name, title: p.name, toolKind: p.toolKind, agent }];
      }
      case 'session.tool.called': {
        const id = str(d.id, 200);
        if (!id) return [];
        const call = this.calls.get(id) || { name: String(d.name || 'tool'), agent };
        call.input = d.input && typeof d.input === 'object' ? d.input : {};
        this.calls.set(id, call);
        const p = pageTool(call.name, call.input);
        if (p.toolKind === 'agent') this.waiting.set(sid, [...(this.waiting.get(sid) || []), id]);
        return [{ kind: 'tool', id, name: p.name, title: titleOf(p.input, p.name), toolKind: p.toolKind, input: clipInput(p.input), agent }];
      }
      case 'session.tool.progress':
        return [];
      case 'session.tool.success':
      case 'session.tool.failed': {
        const id = str(d.id, 200);
        if (!id) return [];
        const ok = e.type === 'session.tool.success';
        const m = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
        const diff = ok ? filesDiff(m.files) || this.patches.get(id) || null : null;
        this.patches.delete(id);
        const r = ok ? { text: resultText(d) } : failedResult(d.error, m);
        const out = [{ kind: 'tool-result', id, ok, ...r, text: clipText(r.text), ...(diff ? { diff } : {}), agent }];
        // A subagent runs in the background (its call only starts it): its task ends with its own conversation's
        // turn, below. A call that failed started nothing.
        if (!ok) {
          for (const [child, call] of this.children) {
            if (call !== id) continue;
            this.running.delete(child);
            out.push({ kind: 'task', taskId: child, toolId: id, status: 'failed', agent: null });
          }
        }
        return out;
      }
      case 'session.step.ended':
      case 'session.step.failed': {
        if (!main) return [];
        const out = [{ kind: 'status', state: null }];
        const t = d.tokens;
        if (t && this.turn) this.turn.usage = addUsage(this.turn.usage, t);
        // What the model saw on this step is what the conversation fills of its context now.
        if (t && Number.isFinite(t.input)) out.push({ kind: 'usage', contextUsed: t.input + (num(t.cache && t.cache.read) || 0) + (num(t.cache && t.cache.write) || 0), contextWindow: this.o.contextWindow ? this.o.contextWindow() : null });
        return out;
      }
      case 'session.usage.updated':
        if (!main) return [];
        if (Number.isFinite(d.cost)) this.cost = d.cost;
        return [];
      case 'session.retry.scheduled': {
        const err = d.error && typeof d.error === 'object' ? d.error : {};
        const limited = err.status === 429 || /rate.?limit|quota|credit/i.test(String(err.message || ''));
        return main ? [{ kind: 'status', state: 'retrying', retry: { attempt: num(d.attempt), error: limited ? 'rate_limit' : String(err.type || 'server_error').slice(0, 100) } }] : [];
      }
      case 'session.compaction.started':
        return main ? [{ kind: 'status', state: 'compacting' }] : [];
      case 'session.compaction.ended':
        return main ? [{ kind: 'status', state: null }, { kind: 'session-changed', id: this.id, reason: 'compact', trigger: str(d.reason, 20), agent: null }] : [];
      case 'session.renamed':
        return main && typeof d.title === 'string' ? [{ kind: 'title', text: plainText(d.title, 200) }] : [];
      case 'session.inbox.delivered':
        return main ? [{ kind: 'inbox', state: 'started', inboxId: str(d.inboxID) }] : [];
      case 'session.inbox.cancelled':
        return main ? [{ kind: 'inbox', state: 'cancelled', inboxId: str(d.inboxID) }] : [];
      case 'permission.asked':
        return this.#ask(d, agent);
      case 'permission.replied':
        return this.#closed(str(d.requestID));
      case 'form.replied':
      case 'form.cancelled':
        return this.#closed(str(d.id));
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted': {
        const how = e.type.slice('session.execution.'.length);
        if (main) return this.#end(how, d);
        // A subagent's turn ended: its task (the main conversation goes on by itself when it reads the result).
        this.running.delete(sid);
        const err = d.error && typeof d.error === 'object' ? d.error : {};
        return [{ kind: 'task', taskId: sid, toolId: agent, status: how === 'succeeded' ? 'completed' : how === 'interrupted' ? 'stopped' : 'failed', ...(how === 'failed' ? { error: plainText(String(err.message || 'it failed'), 300) } : {}), agent: null }];
      }
      default:
        return [];
    }
  }

  /** A conversation was made: a subagent's, when its parent is this chat's (or one of its subagents'). */
  #child(d) {
    const sid = d.sessionID;
    if (!sid || !d.parentID || this.children.has(sid)) return [];
    if (d.parentID !== this.id && !this.children.has(d.parentID)) return [];
    // The call that started it: the oldest subagent call of the parent that has no conversation yet.
    const queue = this.waiting.get(d.parentID) || [];
    const call = queue.shift() || null;
    this.children.set(sid, call);
    if (!call) return [];
    this.running.add(sid);
    const input = (this.calls.get(call) || {}).input || {};
    return [{
      kind: 'task', taskId: sid, toolId: call, type: 'agent', status: 'running', background: true,
      title: plainText(String(input.description || d.title || 'Subagent'), 200), agentType: str(d.agent || input.agent, 60),
      model: d.model && typeof d.model.id === 'string' ? d.model.id.slice(0, 60) : null, agent: null,
    }];
  }

  /** An OK the owner (or the chat) gives: what the call does, whole, is its subject. */
  #ask(d, agent) {
    const request = str(d.id);
    if (!request || this.asks.has(request)) return []; // also read from the server's list of what waits
    const action = String(d.action || 'tool');
    const callId = d.source && typeof d.source.id === 'string' ? d.source.id : null;
    const call = callId ? this.calls.get(callId) : null;
    const resources = Array.isArray(d.resources) ? d.resources.filter((r) => typeof r === 'string') : [];
    const save = Array.isArray(d.save) ? d.save.filter((r) => typeof r === 'string') : [];
    const meta = d.metadata && typeof d.metadata === 'object' ? d.metadata : {};
    const diff = filesDiff(meta.files);
    if (diff && callId) this.patches.set(callId, diff);
    // The whole input of the call it is about, as the call gave it: OpenCode's own `resources` are pieces of it (a
    // command split at "&&"). Without the call, only those pieces are known: then the OK is the owner's.
    const p = call && call.input ? pageTool(call.name, call.input) : pageTool(ACTION_TOOL[action] || action, {});
    const known = !!(call && call.input);
    const outside = action === 'external_directory';
    // Outside the folder: what the call does and the folders it reaches.
    const subject = known ? [askSubject(p.input), ...(outside ? resources : [])].filter(Boolean).join('\n') : resources.join('\n');
    this.asks.set(request, { kind: 'permission' });
    const edits = action === 'edit';
    return [{
      kind: 'ask', request, type: 'permission', tool: p.name, title: p.name, toolId: callId, description: '',
      input: clipInput(known ? p.input : { ...p.input, resources }), full: known ? p.input : { resources },
      ...(diff ? { diff } : {}),
      subject: subject.slice(0, SUBJECT_MAX), subjectCut: subject.length > SUBJECT_MAX,
      // A call the chat did not see whole: the owner's to answer.
      owner: known ? null : 'unknown',
      why: outside ? `It wants to reach outside the chat's folder: ${resources.join(', ')}` : known ? '' : 'OpenCode did not say the whole of what it wants to do: only you can allow this.',
      // "Allow in this chat": the patterns OpenCode itself would remember (kept by the chat only, never saved).
      grant: save.length && known ? { atoms: save.map((s) => `opencode:${action}:${s}`), updates: null, edits, text: edits ? '' : save.join(', ') } : null,
      settled: true, agent,
    }];
  }

  /**
   * A question to the owner (OpenCode's form) as the chat's question card: each field one question; a choice from
   * its options, yes or no, or the owner's own words. Always the owner's.
   */
  #form(f) {
    const agent = this.agentOf(f.sessionID);
    if (agent === undefined || typeof f.id !== 'string' || this.asks.has(f.id)) return [];
    const fields = (Array.isArray(f.fields) ? f.fields : []).filter((x) => x && typeof x.key === 'string' && !x.hidden).slice(0, 10);
    const questions = [];
    const keys = new Map(); // question → field
    for (const x of fields) {
      let q = plainText(String(x.title || x.key), 500) || x.key;
      if (keys.has(q)) q = `${q} (${x.key})`;
      keys.set(q, x);
      const options = x.type === 'boolean' ? [{ label: 'Yes' }, { label: 'No' }]
        : Array.isArray(x.options) ? x.options.filter((o) => o && typeof o.label === 'string').slice(0, 12).map((o) => ({ label: plainText(o.label, 200) })) : [];
      questions.push({ question: q, header: '', options, multiSelect: x.type === 'multiselect' });
    }
    this.asks.set(f.id, { kind: 'form', keys });
    const input = { questions };
    return [{
      kind: 'ask', request: f.id, type: 'question', tool: 'AskUserQuestion', title: plainText(String(f.title || 'A question'), 200), toolId: null,
      description: '', input, full: input, subject: questions.map((q) => q.question).join('\n').slice(0, SUBJECT_MAX), subjectCut: false,
      owner: 'question', why: '', grant: null, settled: false, agent,
    }];
  }

  /** The owner's answers to a form (question → the label chosen, several joined by ", ", or his own words). */
  formAnswer(request, answers) {
    const a = this.asks.get(request);
    if (!a || a.kind !== 'form') return null;
    const out = {};
    for (const [q, x] of a.keys) {
      const said = typeof answers[q] === 'string' ? answers[q] : null;
      if (said === null) continue;
      const byLabel = (s) => ((x.options || []).find((o) => o.label === s) || {}).value ?? s;
      if (x.type === 'boolean') out[x.key] = /^(yes|true)$/i.test(said.trim());
      else if (x.type === 'multiselect') out[x.key] = said.split(', ').map(byLabel);
      else if (x.type === 'number' || x.type === 'integer') out[x.key] = Number(said);
      else out[x.key] = byLabel(said);
    }
    return out;
  }

  isForm(request) {
    return (this.asks.get(request) || {}).kind === 'form';
  }

  #closed(request) {
    if (!request || !this.asks.has(request)) return [];
    this.asks.delete(request);
    return [{ kind: 'ask-cancelled', request }]; // the chat ignores it where it answered itself
  }

  #end(how, d) {
    const turn = this.turn;
    this.turn = null;
    const err = d.error && typeof d.error === 'object' ? d.error : {};
    const ok = how === 'succeeded';
    const error = ok ? null : how === 'interrupted' ? 'stopped' : String(err.message || err.type || 'the turn failed').slice(0, 500);
    return [
      ...(this.cost !== null ? [{ kind: 'usage', costTotal: this.cost }] : []),
      { kind: 'turn-end', ok, subtype: how, error, costUsd: this.cost, usage: turn ? turn.usage : null, durationMs: turn ? Date.now() - turn.at : null },
    ];
  }
}

function addUsage(u, t) {
  const add = (a, b) => (Number.isFinite(b) ? (a || 0) + b : a);
  const x = usageOf(t);
  if (!u) return x;
  return Object.fromEntries(Object.keys(x).map((k) => [k, add(u[k], x[k])]));
}
