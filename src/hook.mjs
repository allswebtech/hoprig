// The hook: Claude Code calls it with one event as JSON on stdin, and it keeps the run record's status true
// (runs.mjs says what the record holds). It imports next to nothing, because Claude waits for it every time.
//
// What Claude Code tells us and what it does not (seen on 2.1.325, with a hook that logged every event):
//   UserPromptSubmit   a turn starts: the owner's message, a queued message, and also the notice that wakes Claude
//                      when a background command or subagent ends
//   PermissionRequest  a question is about to be put to the owner: a tool permission, AskUserQuestion, the plan's
//                      approval. With `agent_id` when a subagent asks. Fires at once
//   Notification       permission_prompt comes about six seconds after such a question and only if nobody
//                      answered yet; idle_prompt a minute after a reply
//   PostToolBatch      a batch of tool calls is through (with `agent_id` for a subagent's). It is the first thing
//                      Claude Code says after the owner answered: for a question at once, for an allowed tool
//                      when that tool has finished, for a subagent's refused tool at once
//   SubagentStop       a subagent ended
//   Stop               the main reply ended. `background_tasks` lists what still runs in the background
//   SessionStart       a session starts, resumes, or is cleared; `source: "compact"` is the middle of a turn when
//                      Claude Code compacts by itself, so it says nothing about the status
//   (nothing)          the owner answers "No" to the main agent's question or presses Esc: the turn ends and no
//                      event tells. An allowed tool that runs for minutes: nothing until it ends. The server
//                      sees both on the screen (server/screen.mjs) and corrects the card
import fs from 'node:fs';
import { readRun, watchFile, writeRun } from './runfile.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // a session id, as in sessions.mjs

// Who waits for the owner: the main agent, a subagent (by its id), or a notification that does not say who.
const MAIN = 'main';
const SOMEONE = '?';

// Background work that ends by itself and then wakes Claude. A shell command may be a server that never ends and
// a monitor is meant to stay, so with only those the session waits for the owner like any other.
const WAKES = new Set(['subagent', 'workflow']);

// Notifications that only tell something: nobody has to answer them.
const TELLS = new Set([
  'idle_prompt', 'auth_success', 'auth_storage_failure', 'agent_completed', 'push_notification', 'plugin_notification',
  'computer_use_enter', 'computer_use_exit', 'quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled',
]);
// An MCP server's form was answered or went away.
const ANSWERED = new Set(['elicitation_complete', 'elicitation_response']);
// These follow a PermissionRequest that already said who asks and for what.
const REMINDS = new Set(['permission_prompt', 'worker_permission_prompt']);

// Reasons to carry a session on elsewhere: the profile is out of quota or out of credit. Other failures (a
// server error, a bad request) would fail the same way on any profile.
const LIMIT_ERRORS = new Set(['rate_limit', 'billing_error']);

const oneLine = (s, max = 300) => String(s).replace(/\s+/g, ' ').trim().slice(0, max);
const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

/** What the card says while Claude waits for an answer. Never the tool's input: a command may hold a secret. */
function question(ev) {
  const tool = typeof ev.tool_name === 'string' ? oneLine(ev.tool_name, 80) : '';
  if (tool === 'AskUserQuestion') {
    const q = ev.tool_input && Array.isArray(ev.tool_input.questions) && ev.tool_input.questions[0] && ev.tool_input.questions[0].question;
    return typeof q === 'string' && q.trim() ? `Claude asks: ${oneLine(q, 240)}` : 'Claude has a question for you';
  }
  if (tool === 'ExitPlanMode') return 'Claude needs your approval for the plan';
  return tool ? `Claude needs your permission to use ${tool}` : 'Claude needs your permission';
}

/**
 * What `ev` changes in `run`: the fields to set, possibly none. Pure, so every case can be tested without Claude.
 * The rule behind it: "attention" holds exactly while `asks` names someone (or the reply ended in an error);
 * otherwise the status is what the last turn event said.
 */
export function hookPatch(run, ev, now = Date.now()) {
  const patch = {};
  if (typeof ev.session_id === 'string' && UUID_RE.test(ev.session_id)) patch.sessionId = ev.session_id;
  const asks = names(run.asks);
  const who = typeof ev.agent_id === 'string' && ev.agent_id ? ev.agent_id.slice(0, 80) : MAIN;
  const without = (...gone) => asks.filter((k) => !gone.includes(k));
  // With somebody still waiting it stays "attention" and keeps its words; else `status`, and the words go.
  const settle = (left, status) => {
    patch.asks = left;
    if (left.length) patch.status = 'attention';
    else Object.assign(patch, { status, note: '', attentionKind: null });
  };
  const ask = (key, note, kind) => Object.assign(patch, { asks: [...without(key), key].slice(-20), status: 'attention', note, attentionKind: kind });

  switch (ev.hook_event_name) {
    case 'SessionStart':
      if (ev.source === 'compact') break; // Claude Code compacted, often in the middle of a turn: nothing ended
      settle([], 'waiting');
      patch.background = [];
      break;
    case 'UserPromptSubmit':
      // The main agent's own question is gone by now: no prompt gets in while it is on the screen.
      settle(without(MAIN, SOMEONE), 'working');
      Object.assign(patch, { limit: null, failure: null, background: [] });
      break;
    case 'Stop': {
      const tasks = Array.isArray(ev.background_tasks) ? ev.background_tasks : [];
      const background = tasks.filter((t) => t && WAKES.has(t.type) && typeof t.id === 'string').map((t) => t.id.slice(0, 80)).slice(0, 50);
      settle(without(MAIN, SOMEONE), background.length ? 'working' : 'waiting');
      Object.assign(patch, { background, stopAt: now, failure: null });
      if (typeof ev.last_assistant_message === 'string') patch.lastMessage = oneLine(ev.last_assistant_message);
      break;
    }
    case 'StopFailure': {
      // The reply ended in an API error. Claude sits idle now; the text says why.
      const text = typeof ev.last_assistant_message === 'string' ? oneLine(ev.last_assistant_message) : '';
      Object.assign(patch, { status: 'attention', note: text || String(ev.error || 'error'), attentionKind: null, asks: [], background: [] });
      // Which kind of error (overloaded, server_error, authentication_failed…): the retry automation acts on it.
      patch.failure = { at: now, error: String(ev.error || 'unknown').slice(0, 60), text };
      if (LIMIT_ERRORS.has(ev.error)) patch.limit = { at: now, error: ev.error, text };
      break;
    }
    case 'PermissionRequest':
      ask(who, question(ev), 'permission_prompt');
      break;
    case 'Notification': {
      const kind = typeof ev.notification_type === 'string' ? ev.notification_type.slice(0, 60) : null;
      // "Claude is waiting for your input" comes after a minute of quiet: that is still plain waiting.
      if (TELLS.has(kind)) break;
      if (ANSWERED.has(kind)) {
        if (asks.includes(SOMEONE)) settle(without(SOMEONE), 'working');
        break;
      }
      if (REMINDS.has(kind) && asks.length) break;
      ask(SOMEONE, typeof ev.message === 'string' ? ev.message.slice(0, 300) : '', kind);
      break;
    }
    case 'PostToolBatch': {
      if (run.status === 'ended') break;
      if (who !== MAIN) {
        // A subagent got its answer (or was refused) and goes on. Another one's question stays.
        if (asks.includes(who)) settle(without(who), 'working');
        break;
      }
      // The main agent finished tool calls, so a turn is running, however it started. Only an API error
      // (attention with nobody asking) waits for a prompt or the reply's end.
      if (run.status === 'attention' && !asks.length) break;
      settle(without(MAIN, SOMEONE), 'working');
      break;
    }
    case 'SubagentStop': {
      const background = names(run.background);
      if (background.includes(who)) patch.background = background.filter((id) => id !== who);
      if (asks.includes(who)) settle(without(who), 'working');
      break;
    }
    case 'SessionEnd':
      Object.assign(patch, { status: 'ended', asks: [], background: [] });
      break;
    default:
      break;
  }
  return patch;
}

/**
 * Should Claude Code start the hook after tool calls? Only while that could change something: someone waits for
 * an answer, or the record does not say "working". A session that is plainly working starts nothing per tool call.
 */
export const wantsToolNews = (run) => Boolean(run) && run.status !== 'ended' && (run.status !== 'working' || names(run.asks).length > 0);

// Nothing, an empty text and an empty list are the same "nothing" here, so a record written before these fields
// existed is not rewritten for their sake.
const plain = (v) => (v == null || v === '' || (Array.isArray(v) && !v.length) ? null : v);
const same = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

/**
 * Apply `ev` to the run file. The file is written only when the event changes something; returns the record as
 * it stands (null when the file is gone: the launcher already cleaned up).
 */
export function applyHook(file, ev, now = Date.now()) {
  const run = readRun(file);
  if (!run) return null;
  const patch = hookPatch(run, ev, now);
  let next = run;
  if (Object.keys(patch).some((k) => !same(run[k], patch[k]))) {
    next = { ...run, ...patch };
    if (patch.status && patch.status !== run.status) next.statusAt = now;
    writeRun(file, next);
  }
  const mark = watchFile(file);
  if (wantsToolNews(next) !== fs.existsSync(mark)) {
    if (wantsToolNews(next)) fs.writeFileSync(mark, '', { mode: 0o600 });
    else fs.rmSync(mark, { force: true });
  }
  return next;
}

/**
 * `hoprig hook`: called by Claude Code with the event as JSON on stdin. Updates the run file named by
 * $HOPRIG_RUN_FILE. Must stay silent and never fail: its output would land in the conversation.
 */
export async function hookMain() {
  try {
    const file = process.env.HOPRIG_RUN_FILE;
    if (!file) return;
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    applyHook(file, JSON.parse(raw));
  } catch {
    /* never disturb the session */
  }
}
