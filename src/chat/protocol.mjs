// The coding chat's protocol with Claude Code: the arguments of a headless run, the lines written to it and read from
// it (stream-json), and the conversation as the page shows it, from the live stream or from the transcript file.
//
// Checked on Claude Code 2.1.325 against a stand-in Messages API (no model, no quota) and once against a real model:
//   --permission-prompt-tool stdio   a tool use that needs the owner's OK arrives on stdout as
//       {"type":"control_request","request_id":R,"request":{"subtype":"can_use_tool","tool_name","input",
//        "tool_use_id","description","permission_suggestions", …}}
//     and is answered on stdin with
//       {"type":"control_response","response":{"subtype":"success","request_id":R,
//        "response":{"behavior":"allow","updatedInput":{…},"updatedPermissions":[…]}}}  or {"behavior":"deny","message":"…"}
//     This is the channel the Agent SDK's canUseTool callback uses (docs: agent-sdk/typescript, "CanUseTool" and
//     "PermissionResult"); "stdio" is the value the SDK itself passes. /cli-reference documents the flag only with an
//     MCP tool, which would need a server of ours in every coding chat; stdio needs nothing more.
//     An answer of another shape is not asked again: the tool call fails ("invalid permission result").
//   What still asks in bypassPermissions (everything else runs unasked there, .git/ and .claude/ included):
//       AskUserQuestion and ExitPlanMode                     "requires_user_interaction": true (the card is the answer)
//       an ask rule of the settings (permissions.ask)        "decision_reason_type": "rule" (or "matched_ask_rule")
//       a hook that answers "ask"                            "decision_reason_type": "hook"
//       a delete that could empty the disk (rm -rf $DIR/*)   "decision_reason_type": "safetyCheck", "classifier_approvable": false
//       any change after Claude itself entered plan mode     "decision_reason_type": "mode" (EnterPlanMode does not ask;
//                                                            system/status then reports permissionMode "plan")
//     A deny rule never asks: Claude Code refuses the call itself, in every mode. Where the settings turn the mode off
//     (disableBypassPermissionsMode), init reports permissionMode "default" and everything asks as usual.
//   permission_suggestions are what the terminal's "don't ask again" would add. For an edit they are for the session
//     ({"type":"setMode","mode":"acceptEdits","destination":"session"}); for a command, an MCP tool or a web page
//     they name a settings file ({"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"npm view *"}],
//     "behavior":"allow","destination":"localSettings"}). Sent back with "destination":"session" they hold for the
//     running process only and nothing is written; a resumed process has forgotten them. Given at the start instead
//     (--settings '{"permissions":{"allow":["Bash(node -e 1)"]}}', which writes nothing either) they hold from the
//     first tool call on, with Claude Code's own judgement: a command that chains an allowed one (cd sub && node -e 1,
//     git status && node -e 1) runs unasked, as in the process where the rule was added, while a chain with a part no
//     rule covers asks for that part only. An "ask" or "deny" rule of the owner's settings still wins over them.
//   A chained command asks with "decision_reason_type": "subcommandResults"; its suggestions name the parts that
//     still need a rule, and are empty where a part needs more than a rule (a sensitive file, "$(…)", a write outside).
//     A sensitive file (.git/, .claude/, a shell profile) asks with "decision_reason_type": "safetyCheck" in every
//     mode but bypassPermissions, also after "acceptEdits" was set (which it still suggests in the default mode).
//   Stop: {"type":"control_request","request_id":X,"request":{"subtype":"interrupt"}}. Claude Code answers with a
//     control_response, takes back an OK it still waits for (control_cancel_request), ends the running tool, and the
//     turn's result has subtype "error_during_execution".
//   A resumed conversation (--resume <id>) keeps writing the same transcript, <claudeDir>/projects/<slug>/<id>.jsonl,
//     so a chat opens in the terminal (claude --resume <id>) and the other way round.
//   total_cost_usd in a result is the conversation's total so far (it carries over a resume); usage is the turn's.
import fs from 'node:fs';

/** Claude Code's arguments for one coding chat. Its normal tools, CLAUDE.md, settings, MCP servers and skills stay. */
export function chatArgs({ sessionId, resume = false, permissionMode = null, effort = null, model = null, settings = null }) {
  if (!sessionId) throw new Error('chatArgs needs a session id');
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-prompt-tool', 'stdio',
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    ...(settings ? ['--settings', settings] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(model ? ['--model', model] : []),
    resume ? '--resume' : '--session-id', sessionId,
  ];
}

const line = (o) => JSON.stringify(o) + '\n';
/** One message of the owner as a stream-json input line. */
export const userLine = (text) => line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: String(text) }] } });
/** A tool use is allowed. `permissions`: rule changes for this session only (sessionGrant). */
export const allowLine = (requestId, input, permissions = null) =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'allow', updatedInput: input, ...(permissions && permissions.length ? { updatedPermissions: permissions } : {}) } } });
export const denyLine = (requestId, message) =>
  line({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } } });
export const interruptLine = (requestId) => line({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });

// ---------- "allow in this chat" ----------

const GRANT_MAX = 20; // rules or folders in one answer

/**
 * What "allow in this chat" adds for one ask: Claude Code's own suggestions, for this session only, whatever settings
 * file they name. Only what makes Claude ask less about the same thing is taken: allow rules, more folders, and
 * "edits without asking"; never another mode, a deny or ask rule, or a removal. Returns
 * { updates (for allowLine), atoms (one word per rule, folder and mode, to remember the grant by), edits, text }
 * or null when there is nothing to offer.
 */
export function sessionGrant(suggestions) {
  const updates = [];
  const atoms = [];
  const words = [];
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'setMode' && s.mode === 'acceptEdits') {
      updates.push({ type: 'setMode', mode: 'acceptEdits', destination: 'session' });
      atoms.push('mode:acceptEdits');
      words.push('all edits');
    } else if (s.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)) {
      const rules = s.rules.filter((r) => r && typeof r.toolName === 'string' && r.toolName && (r.ruleContent === undefined || typeof r.ruleContent === 'string'))
        .map((r) => (r.ruleContent === undefined ? { toolName: r.toolName } : { toolName: r.toolName, ruleContent: r.ruleContent }));
      if (!rules.length || rules.length !== s.rules.length) continue;
      updates.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' });
      for (const r of rules) {
        atoms.push(`rule:${r.toolName}:${r.ruleContent ?? ''}`);
        words.push(r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`);
      }
    } else if (s.type === 'addDirectories' && Array.isArray(s.directories) && s.directories.length && s.directories.every((d) => typeof d === 'string' && d)) {
      updates.push({ type: 'addDirectories', directories: [...s.directories], destination: 'session' });
      for (const d of s.directories) {
        atoms.push(`dir:${d}`);
        words.push(`the folder ${d}`);
      }
    }
  }
  if (!updates.length || atoms.length > GRANT_MAX) return null;
  return { updates, atoms, edits: atoms.every((a) => a === 'mode:acceptEdits'), text: clipText(words.join(', '), 300) };
}

// Characters of the rules and folders in --settings. Windows starts claude.cmd through cmd.exe, whose whole command
// line may be 8191 characters, quoting included.
const SETTINGS_MAX = 3000;

/**
 * What the chat remembers from "allow in this chat" (sessionGrant atoms, oldest first) as Claude Code's --settings
 * for a new process: the allow rules and folders, so it starts as the process where they were added left off. The
 * newest are kept when they do not all fit. "All edits" is not a rule: an edit's ask is answered from the atom
 * (chat.mjs). Returns a JSON string, or null when there is nothing to give.
 */
export function grantSettings(atoms) {
  const allow = [];
  const dirs = [];
  let size = 0;
  for (const a of [...(atoms || [])].reverse()) {
    let m;
    if ((m = /^rule:([^:]+):([\s\S]*)$/.exec(a))) {
      const rule = m[2] ? `${m[1]}(${m[2]})` : m[1];
      if ((size += JSON.stringify(rule).length + 1) > SETTINGS_MAX) break;
      allow.unshift(rule);
    } else if ((m = /^dir:([\s\S]+)$/.exec(a))) {
      if ((size += JSON.stringify(m[1]).length + 1) > SETTINGS_MAX) break;
      dirs.unshift(m[1]);
    }
  }
  if (!allow.length && !dirs.length) return null;
  return JSON.stringify({ permissions: { ...(allow.length ? { allow } : {}), ...(dirs.length ? { additionalDirectories: dirs } : {}) } });
}

// Claude Code marks these two itself (requires_user_interaction); their names hold where a version does not.
const isQuestion = (ask) => ask.interactive || ask.tool === 'AskUserQuestion' || ask.tool === 'ExitPlanMode';

/**
 * Why an ask is the owner's to answer even where the chat answers by itself (bypassPermissions), or null:
 *   "question"  the card is the answer (a question to the owner, a plan to approve): never a permission
 *   "rule"      the owner's own settings say "ask" for this
 *   "hook"      a hook of the owner's setup says a person must look
 *   "safety"    Claude Code's stop before a delete that could empty the disk or the home folder
 */
export function ownerOnly(ask) {
  if (isQuestion(ask)) return 'question';
  if (ask.ruleForced) return 'rule';
  if (ask.reasonType === 'hook') return 'hook';
  if (ask.manualOnly) return 'safety';
  return null;
}

/** One line for the card: why Claude Code asks, where that is not plain from the request itself. */
export function askWhy(ask) {
  if (isQuestion(ask)) return '';
  if (ask.ruleForced) return 'Your permission settings say to ask for this.';
  if (ask.reasonType === 'hook') return `A hook asks for your OK${ask.reason ? `: ${ask.reason}` : '.'}`;
  if (ask.reasonType === 'mode') return 'Claude is in plan mode, where it asks before it changes anything.';
  if (ask.reasonType === 'safetyCheck' || ask.reasonType === 'workingDir' || ask.manualOnly) return ask.reason;
  return '';
}

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

/** Text of Claude Code or a hook for the page: no escape sequences or other control characters, one line, cut. */
const plainText = (s, max) => (typeof s === 'string' ? s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, max) : '');

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
 *   { kind: "mode", permissionMode }   the mode changed while it runs (Claude entered or left plan mode)
 *   { kind: "text", text } · { kind: "tool", id, name, input, full } · { kind: "result", id, isError, text }
 *   { kind: "ask", request, tool, title, description, input, full, suggestions,    a tool use waits for an OK
 *     interactive, reasonType, reason, ruleForced, manualOnly, noAlways }           (ownerOnly, askWhy read these)
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
  if (m.type === 'system' && m.subtype === 'status' && typeof m.permissionMode === 'string') return [{ kind: 'mode', permissionMode: m.permissionMode }];
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
      interactive: r.requires_user_interaction === true,
      reasonType: typeof r.decision_reason_type === 'string' ? r.decision_reason_type : null,
      reason: plainText(r.decision_reason, 300),
      ruleForced: r.decision_reason_type === 'rule' || (!!r.matched_ask_rule && typeof r.matched_ask_rule === 'object'),
      manualOnly: r.classifier_approvable === false,
      noAlways: r.suppress_always_allow_rule === true,
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
