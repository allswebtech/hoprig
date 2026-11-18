// The hook: Claude Code calls it with one event as JSON on stdin, and it keeps the run record's status true
// (runs.mjs says what the record holds). It imports next to nothing, because Claude waits for it every time.
//
// What Claude Code tells us and what it does not (seen on 2.1.325 and 2.1.326, with a hook that logged every event):
//   UserPromptSubmit   a turn starts: the owner's message, a queued message, and also the notice that wakes Claude
//                      when a background command or subagent ends
//   PermissionRequest  a question is about to be put to the owner: a tool permission, AskUserQuestion, the plan's
//                      approval. With `agent_id` when a subagent asks. Fires at once. It carries the tool, its
//                      input and `permission_mode`, and no word on why Claude Code asks. What the hook prints is
//                      the answer (hookAnswer): with "allow" no question is shown at all
//   Notification       permission_prompt comes about six seconds after such a question and only if nobody
//                      answered yet; idle_prompt a minute after a reply
//   PostToolBatch      a batch of tool calls is through (with `agent_id` for a subagent's). It is the first thing
//                      Claude Code says after the owner answered: for a question at once, for an allowed tool
//                      when that tool has finished, for a subagent's refused tool at once. Two calls of one batch
//                      that both ask: one event after both
//   SubagentStop       a subagent ended (also the unnamed one that suggests the next message after every reply)
//   Stop               the main reply ended. `background_tasks` lists what still runs in the background. The
//                      owner can stop background agents (ctrl+x ctrl+k), even one that is asking: then no
//                      PostToolBatch or SubagentStop comes for it, only a turn ("…was stopped by the user") and its
//                      Stop, which no longer lists it
//   SessionStart       a session starts, resumes, or is cleared; `source: "compact"` is the middle of a turn when
//                      Claude Code compacts by itself, so it says nothing about the status
//   (nothing)          the owner answers "No" to the main agent's question or presses Esc: the turn ends and no
//                      event tells. An allowed tool that runs for minutes: nothing until it ends. The server
//                      sees both on the screen (server/screen.mjs) and corrects the card
//
// Bypass mode ("permission_mode": "bypassPermissions") still asks, on 2.1.326: AskUserQuestion, the plan's approval,
// an "ask" rule of the settings, and Claude Code's own stop before a delete it cannot judge or that names a folder
// such as / or the home folder ("Dangerous rm operation …", blocked by itself after two minutes without an answer).
// All of them come as a PermissionRequest that names no reason. What the hook answers there is one rule (asking.mjs
// bypassAllows), for a terminal session and for a coding chat's Claude Code, which gets this hook too (chat/asks.mjs): Bash, no ask rule for it in the settings Claude Code reads, and a command that is
// plainly a delete inside the folder it runs in. That folder is the event's cwd: seen on 2.1.326, it is the folder the
// shell is in when the command starts (after a `cd sub` in an earlier call it is sub; after a cd out of the project
// Claude Code puts the shell back in the project and cwd says so; a cd in the same line is not in it, and such a line
// is no plain delete). Each such allow is written down in the record (`allowed`) for the owner: a terminal's record or
// a chat's (runs.mjs createChatRun), and the session's page or the chat shows it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BYPASS, askRules, askType, bypassAllows, projectFolders } from './asking.mjs';
import { redact } from './assistant/secrets.mjs';
import { configFile, defaultWorkspaceDir } from './paths.mjs';
import { changeRun, watchFile } from './runfile.mjs';

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

// A background task that Stop lists but that is already over (finished, failed, stopped by the owner): it neither
// wakes Claude nor can it still ask anything. Only these words count as over; a status this version does not
// know counts as running, so that a real question is never dropped.
const OVER = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled', 'canceled', 'error', 'done']);
const running = (t) => Boolean(t) && typeof t === 'object' && !OVER.has(t.status);

const oneLine = (s, max = 300) => String(s).replace(/\s+/g, ' ').trim().slice(0, max);
const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);

/**
 * What is asked, for the card and for the record of what Hoprig allowed: the command, the file or the address, on one
 * line, shortened, with anything that looks like a secret masked (a command line can hold a token).
 */
export function askedWhat(ev) {
  const i = ev && ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  const v = [i.command, i.file_path, i.notebook_path, i.path, i.url, i.pattern].find((x) => typeof x === 'string' && x.trim());
  if (!v) return '';
  const s = oneLine(redact(v), 4000);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

/** What the card says while Claude waits for an answer. */
function question(ev) {
  const tool = typeof ev.tool_name === 'string' ? oneLine(ev.tool_name, 80) : '';
  if (tool === 'AskUserQuestion') {
    const q = ev.tool_input && Array.isArray(ev.tool_input.questions) && ev.tool_input.questions[0] && ev.tool_input.questions[0].question;
    return typeof q === 'string' && q.trim() ? `Claude asks: ${oneLine(redact(q), 240)}` : 'Claude has a question for you';
  }
  if (tool === 'ExitPlanMode') return 'Claude needs your approval for the plan';
  const what = askedWhat(ev);
  return tool ? `Claude needs your permission to use ${tool}${what ? `: ${what}` : ''}` : 'Claude needs your permission';
}

const ALLOW = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PermissionRequest', decision: Object.freeze({ behavior: 'allow' }) }) });

/**
 * What the hook needs to know about the session beyond the event, read when asked (only for a PermissionRequest in
 * bypass mode): the "ask" rules of the settings Claude Code reads for it, and for plainDelete the folder the command
 * runs in (the event's cwd: the shell's folder at that moment, so a relative target can be read) and the folders that
 * may not be that folder (the home, the workspace, the folders that hold projects).
 * The settings file Hoprig handed to the session lies next to the run records (launch.mjs: hookSettingsDir).
 */
export function sessionFacts(ev, env = process.env) {
  const file = env.HOPRIG_RUN_FILE;
  return {
    rules: () => askRules({
      project: env.CLAUDE_PROJECT_DIR || (ev && typeof ev.cwd === 'string' ? ev.cwd : null),
      configDir: env.CLAUDE_CONFIG_DIR || null,
      extra: file ? path.join(path.dirname(path.dirname(file)), 'hook-settings', path.basename(file)) : null,
    }),
    places: () => {
      const cfg = hoprigSettings();
      const workspace = workspaceDir(env, cfg);
      const home = os.homedir();
      return { home, workspace, projects: projectFolders({ workspace, home, chosen: cfg.projectsDir }), cwd: ev && typeof ev.cwd === 'string' ? ev.cwd : null, relative: true };
    },
  };
}

// Hoprig's settings file, read without loading the rest of Hoprig ({} when there is none or it cannot be read).
function hoprigSettings() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

// The workspace folder as Hoprig finds it (workspace/layout.mjs), without loading the rest of Hoprig.
function workspaceDir(env, cfg) {
  if (env.HOPRIG_WORKSPACE_DIR && path.isAbsolute(env.HOPRIG_WORKSPACE_DIR)) return path.normalize(env.HOPRIG_WORKSPACE_DIR);
  if (typeof cfg.workspaceDir === 'string' && path.isAbsolute(cfg.workspaceDir)) return path.normalize(cfg.workspaceDir);
  return defaultWorkspaceDir();
}

/**
 * What the hook answers Claude Code for `ev`, or null (nothing: Claude Code goes on as it would, and asks the owner).
 * In bypass mode a permission is allowed here when the one rule allows it (asking.mjs bypassAllows); `facts` says
 * what that rule needs to know about the session (sessionFacts). This is the output a PermissionRequest hook allows
 * with, checked on Claude Code 2.1.326: its question is not drawn and the tool runs ("Allowed by PermissionRequest hook").
 */
export function hookAnswer(ev, facts = sessionFacts(ev)) {
  if (!ev || typeof ev !== 'object' || ev.hook_event_name !== 'PermissionRequest' || ev.permission_mode !== BYPASS) return null;
  const allows = bypassAllows({ mode: ev.permission_mode, tool: ev.tool_name, input: ev.tool_input, rules: facts.rules(), places: facts.places() });
  return allows ? ALLOW : null;
}

// What is asked, per asker (`askers`: key → { type, note, kind, at, what }): the card shows what still waits. Where a
// question or a plan waits it is that (its answer is the owner's own word, in the terminal), else the newest ask.
// `askWhat`: the command or file of that ask (askedWhat), which the server finds again in the dialog on the screen
// before it types the page's answer (server/prompts.mjs dialogShows).
function waiting(left, askers) {
  const all = left.map((k) => askers[k]).filter((a) => a && typeof a === 'object');
  if (!all.length) return {};
  const own = all.filter((a) => a.type === 'question' || a.type === 'plan');
  const shown = (own.length ? own : all).reduce((a, b) => ((b.at || 0) >= (a.at || 0) ? b : a));
  return { note: shown.note || '', attentionKind: shown.kind || null, askType: shown.type || null, askWhat: shown.what || '' };
}

/**
 * What `ev` changes in `run`: the fields to set, possibly none. Pure, so every case can be tested without Claude.
 * The rule behind it: "attention" holds exactly while `asks` names someone (or the reply ended in an error);
 * otherwise the status is what the last turn event said.
 */
export function hookPatch(run, ev, now = Date.now(), { allowed = false } = {}) {
  // A coding chat's record (runs.mjs createChatRun) gets only PermissionRequest (claude.mjs) and keeps only what the
  // hook allowed: the chat follows its process through its own channel, the cards included.
  if (run.kind === 'chat') return ev.hook_event_name === 'PermissionRequest' && allowed ? { allowed: allowedList(run, ev, now) } : {};
  const patch = {};
  if (typeof ev.session_id === 'string' && UUID_RE.test(ev.session_id)) patch.sessionId = ev.session_id;
  const asks = names(run.asks);
  const who = typeof ev.agent_id === 'string' && ev.agent_id ? ev.agent_id.slice(0, 80) : MAIN;
  const without = (...gone) => asks.filter((k) => !gone.includes(k));
  // Who asks what. A record written by an older hook has only the one kind, note and time: they stand for its askers.
  const was = run.askers && typeof run.askers === 'object' ? run.askers : {};
  const askers = {};
  for (const k of asks) askers[k] = was[k] || { type: run.askType || null, note: run.note || '', kind: run.attentionKind || null, at: run.askAt || 0 };
  const only = (left) => Object.fromEntries(left.map((k) => [k, askers[k]]));
  // With somebody still waiting it stays "attention" and shows what still waits (waiting); else `status`, and the
  // words go. `askAt` moves whenever who waits changes, so the page offers its answers again for what is left.
  const settle = (left, status) => {
    patch.asks = left;
    patch.askers = only(left);
    if (left.length) {
      Object.assign(patch, { status: 'attention' }, waiting(left, patch.askers));
      if (left.length !== asks.length) patch.askAt = now;
    } else Object.assign(patch, { status, note: '', attentionKind: null, askType: null, askWhat: '', askers: {} });
  };
  // `type`: what is asked (asking.mjs askType), so the page offers "Allow" for a permission only. `askAt`: every ask
  // has its own time, so the page tells a second question from the one the owner just answered.
  const ask = (key, note, kind, type = null, what = '') => {
    const left = [...without(key), key].slice(-20);
    const next = { ...only(left.filter((k) => k !== key)), [key]: { type, note, kind, at: now, what } };
    Object.assign(patch, { asks: left, askers: next, status: 'attention', askAt: now }, waiting(left, next));
  };

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
      const tasks = (Array.isArray(ev.background_tasks) ? ev.background_tasks : []).filter(running);
      const background = tasks.filter((t) => WAKES.has(t.type) && typeof t.id === 'string').map((t) => t.id.slice(0, 80)).slice(0, 50);
      // The main reply is over, so its own question is gone; a subagent's question can only still wait while that
      // subagent runs. One the owner stopped (ctrl+x ctrl+k while it asked) never sends PostToolBatch or
      // SubagentStop, and without this its question would hold the session on "needs your OK" for good. A
      // workflow's agents are not listed by id, so while a workflow runs their questions stay.
      const workflow = tasks.some((t) => t.type === 'workflow');
      const live = asks.filter((k) => k !== MAIN && k !== SOMEONE && (workflow || background.includes(k)));
      settle(live, background.length ? 'working' : 'waiting');
      Object.assign(patch, { background, stopAt: now, failure: null });
      if (typeof ev.last_assistant_message === 'string') patch.lastMessage = oneLine(ev.last_assistant_message);
      break;
    }
    case 'StopFailure': {
      // The reply ended in an API error. Claude sits idle now; the text says why.
      const text = typeof ev.last_assistant_message === 'string' ? oneLine(ev.last_assistant_message) : '';
      Object.assign(patch, { status: 'attention', note: text || String(ev.error || 'error'), attentionKind: null, askType: null, asks: [], askers: {}, background: [] });
      // Which kind of error (overloaded, server_error, authentication_failed…): the retry automation acts on it.
      patch.failure = { at: now, error: String(ev.error || 'unknown').slice(0, 60), text };
      if (LIMIT_ERRORS.has(ev.error)) patch.limit = { at: now, error: ev.error, text };
      break;
    }
    case 'PermissionRequest':
      // Allowed by the hook itself (bypass mode: `allowed` is its answer, hookAnswer): Claude Code shows no question,
      // so nobody is asked. What was allowed is written down for the owner, the newest 20.
      if (allowed) {
        patch.allowed = allowedList(run, ev, now);
        break;
      }
      ask(who, question(ev), 'permission_prompt', askType(ev.tool_name), askedWhat(ev));
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
      Object.assign(patch, { status: 'ended', asks: [], askers: {}, background: [] });
      break;
    default:
      break;
  }
  return patch;
}

// The record's list of what the hook allowed, with `ev` added: the newest 20. Each has its number `n`, one more than the
// last, given under the record's lock (applyHook), so a chat tells two allows of the same moment apart.
function allowedList(run, ev, now) {
  const tool = typeof ev.tool_name === 'string' ? oneLine(ev.tool_name, 80) : '';
  const was = Array.isArray(run.allowed) ? run.allowed : [];
  const n = was.reduce((m, a) => (a && Number.isInteger(a.n) && a.n > m ? a.n : m), 0) + 1;
  const folder = folderOf(run, ev);
  return [...was, { n, at: now, tool, what: askedWhat(ev), ...(folder ? { folder } : {}) }].slice(-20);
}

// Where the command ran, when that is not the session's own folder: relative to it where it is inside it.
function folderOf(run, ev) {
  const cwd = typeof ev.cwd === 'string' ? ev.cwd : '';
  const home = typeof run.cwd === 'string' ? run.cwd : '';
  if (!cwd || cwd === home) return '';
  const rel = home && cwd.startsWith(`${home}/`) ? cwd.slice(home.length + 1) : cwd;
  return oneLine(rel, 200);
}

/**
 * Should Claude Code start the hook after tool calls? Only while that could change something: someone waits for
 * an answer, or the record does not say "working". A session that is plainly working starts nothing per tool call.
 */
export const wantsToolNews = (run) => Boolean(run) && run.status !== 'ended' && (run.status !== 'working' || names(run.asks).length > 0);

// Nothing, an empty text and an empty list are the same "nothing" here, so a record written before these fields
// existed is not rewritten for their sake. The same for an empty object.
const plain = (v) => (v == null || v === '' || (Array.isArray(v) && !v.length) || (v.constructor === Object && !Object.keys(v).length) ? null : v);
const same = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

/**
 * Apply `ev` to the run file, under its lock (runfile.mjs changeRun: two hooks of one session may run at once). The
 * file is written only when the event changes something; returns the record as it stands (null when the file is
 * gone: the launcher already cleaned up). `answer`: what the hook answered Claude Code for it (hookAnswer).
 */
export function applyHook(file, ev, now = Date.now(), answer = null) {
  const next = changeRun(file, (run) => {
    const patch = hookPatch(run, ev, now, { allowed: !!answer });
    if (!Object.keys(patch).some((k) => !same(run[k], patch[k]))) return run;
    const out = { ...run, ...patch };
    if (patch.status && patch.status !== run.status) out.statusAt = now;
    return out;
  });
  if (!next) return null;
  const mark = watchFile(file);
  if (wantsToolNews(next) !== fs.existsSync(mark)) {
    if (wantsToolNews(next)) fs.writeFileSync(mark, '', { mode: 0o600 });
    else fs.rmSync(mark, { force: true });
  }
  return next;
}

/**
 * `hoprig hook`: called by Claude Code with the event as JSON on stdin. Prints the hook's answer where it has one
 * (hookAnswer), on one line, then updates the run file named by $HOPRIG_RUN_FILE. Otherwise it must stay silent, and
 * it never fails: any other output would land in the conversation.
 */
export async function hookMain() {
  const file = process.env.HOPRIG_RUN_FILE;
  if (!file) return; // not a session Hoprig started: nothing to keep, nothing to answer
  let ev = null;
  let answer = null;
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    ev = JSON.parse(raw);
    // The answer does not wait on the record: a run file that could not be written must not leave a question open.
    answer = hookAnswer(ev);
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch {
    /* an event of a shape we do not know: no answer, Claude Code asks as usual */
  }
  try {
    if (ev && typeof ev === 'object') applyHook(file, ev, Date.now(), answer);
  } catch {
    /* never disturb the session */
  }
}
