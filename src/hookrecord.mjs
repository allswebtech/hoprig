// The hook's hot path: what Claude Code starts for every event, and what keeps the run record's status true (hook.mjs
// says what each event means). A status event (a session's start and end, a prompt, a reply's end, a notification, a
// batch of tool calls, a subagent's end) needs only the record, so this module loads only what writes it. The wall,
// Hands-off's answers, the bypass rule and the Lead's helper rule (hook.mjs and what it loads) are loaded only for
// PreToolUse and PermissionRequest, the two events that can be answered: Claude Code waits for every start, and each
// module more is time it waits.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './assistant/secrets.mjs';
import { configFile } from './paths.mjs';
import { cleanLine } from './providers/table.mjs';
import { changeRun, watchFile } from './runfile.mjs';

// The events with an answer (hook.mjs answerEvent); every other event only changes the record.
const ANSWERED_EVENTS = new Set(['PreToolUse', 'PermissionRequest']);

// The dashboard's own continue prompt when the settings name none (autoswitch.mjs DEFAULTS.prompt). A copy, so the
// hot path does not load Auto mode; test/hook-hotpath.test.mjs holds the two the same.
export const CONTINUE_PROMPT = 'Continue from where you stopped.';

// Work is a call that changes something: an edit, a write, a command (handsoff.mjs WORK_TOOLS, which PostToolBatch
// reads). A copy, so the hot path does not load Hands-off; test/hook-hotpath.test.mjs holds the two the same.
export const WORK_TOOLS = Object.freeze(new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash', 'Patch']));

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

// The events a chat's record takes besides PermissionRequest, and the only fields it keeps of them: a stop, and what
// clears it (the next prompt, a reply that ended well, a new conversation).
const CHAT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure']);
const CHAT_KEEPS = new Set(['failure', 'limit', 'agentStops', 'agentWhat']);

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

/**
 * What an agent was doing, from the file Claude Code keeps beside its record (2.1.328:
 * <conversation folder>/<session>/subagents/agent-<id>.meta.json, its "description"): an agent that stops in an API error
 * before any Stop event listed it is named by it, not only by its type. Only that one small file is read; the id and
 * the session come from the event and must be plain names, so no other path can be reached.
 */
function agentLabel(ev, id) {
  try {
    if (typeof ev.transcript_path !== 'string' || typeof ev.session_id !== 'string') return '';
    if (!/^[\w-]{1,80}$/.test(id) || !/^[\w-]{1,80}$/.test(ev.session_id)) return '';
    const file = path.join(path.dirname(ev.transcript_path), ev.session_id, 'subagents', `agent-${id}.meta.json`);
    if (fs.statSync(file).size > 64 * 1024) return '';
    const d = JSON.parse(fs.readFileSync(file, 'utf8')).description;
    return typeof d === 'string' ? oneLine(cleanLine(d), 80) : '';
  } catch {
    return ''; // no such file, or one of another shape: the agent's type names it
  }
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

// The work Hands-off looks for between its answers (handsoff.mjs LOOP_MAX): a call that changes something and did not
// fail (PostToolBatch's tool_calls carry each call's tool_response).
const failed = (r) => !!r && typeof r === 'object' && (r.is_error === true || r.interrupted === true || r.success === false);
const workIn = (ev) => Array.isArray(ev.tool_calls) && ev.tool_calls.some((c) => c && WORK_TOOLS.has(c.tool_name) && !failed(c.tool_response));

// Read Hoprig's settings, and say whether the file could be read at all: { cfg, readFailed }. `readFailed` is true
// when the file is missing or cannot be parsed — the wall uses it to tell a config the owner set to `offered: false`
// (readable, honoured) from one that is gone (held, so the wall is not lost with the file).
export function readHoprigSettings() {
  try {
    const c = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
    return { cfg: c && typeof c === 'object' ? c : {}, readFailed: false };
  } catch {
    return { cfg: {}, readFailed: true };
  }
}

// What is asked, per asker (`askers`: key → { type, note, kind, at, what }): the card shows what still waits. Where a
// question or a plan waits it is that (its answer is the owner's own word, in the terminal), else the newest ask.
// `askWhat`: the command or file of that ask (askedWhat), which the server finds again in the dialog on the screen
// before it types the page's answer (server/prompts.mjs dialogShows).
function waiting(left, askers) {
  const k = shownAsker(left, askers);
  if (k === null) return {};
  const shown = askers[k];
  return { note: shown.note || '', attentionKind: shown.kind || null, askType: shown.type || null, askWhat: shown.what || '', askCard: shown.card || null, handsWait: shown.handsWait || null };
}

// Which of the askers the card shows (waiting): a question or a plan first, else the newest ask. → its key, or null.
function shownAsker(left, askers) {
  const all = left.filter((k) => askers[k] && typeof askers[k] === 'object');
  if (!all.length) return null;
  const own = all.filter((k) => askers[k].type === 'question' || askers[k].type === 'plan');
  return (own.length ? own : all).reduce((a, b) => ((askers[b].at || 0) >= (askers[a].at || 0) ? b : a));
}

// What the wall held, per agent (`holds`: key → heldRecord). A hold is its own agent's: set by that agent's held call
// (PreToolUse), gone with its next call, with its ask (answered or dropped) and with its end, and never cleared by
// another agent's event. The record's `held`, which the card reads, is the hold of the asker the card shows (waiting),
// or with nobody asking, that of the agent the event came from (its dialog is about to be drawn). An older record has
// only `held`: it stands for the main agent's.
function holdsPatch(run, ev, who, held, before, patch) {
  const was = run.holds && typeof run.holds === 'object' ? run.holds : run.held && typeof run.held === 'object' ? { [MAIN]: run.held } : {};
  let holds = { ...was };
  const name = ev.hook_event_name;
  if (name === 'SessionEnd' || (name === 'SessionStart' && ev.source !== 'compact') || (name === 'StopFailure' && who === MAIN)) holds = {};
  else if (name === 'PreToolUse') {
    delete holds[who];
    if (held) holds[who] = held;
  } else if (name === 'PostToolBatch' || name === 'SubagentStop' || name === 'StopFailure') delete holds[who];
  else if (name === 'Stop' || name === 'UserPromptSubmit') {
    delete holds[MAIN]; // the main reply is over, or a prompt got in: its own call is done
    delete holds[SOMEONE];
  }
  const after = patch.asks || before;
  for (const k of before) if (!after.includes(k)) delete holds[k]; // its ask went: answered, refused or dropped
  holds = Object.fromEntries(Object.entries(holds).slice(-20));
  const askers = patch.askers || (run.askers && typeof run.askers === 'object' ? run.askers : {});
  const shown = after.length ? shownAsker(after, askers) : who;
  return { holds, held: (shown !== null && holds[shown]) || null };
}

/**
 * What `ev` changes in `run`: the fields to set, possibly none. Pure, so every case can be tested without Claude.
 * The rule behind it: "attention" holds exactly while `asks` names someone (or the reply ended in an error);
 * otherwise the status is what the last turn event said.
 */
export function recordPatch(run, ev, now = Date.now(), { allowed = false, hands = null, held = null, continuePrompt = null, cardParts = null } = {}) {
  // A coding chat's record (runs.mjs createChatRun): the chat follows its process through its own channel, the cards
  // and its status included, so the record keeps only what the hook allowed and how a provider stopped the chat or an
  // agent of it (launch.mjs chatHooks), for the Operator.
  if (run.kind === 'chat') {
    if (ev.hook_event_name === 'PermissionRequest') return allowed ? { allowed: allowedList(run, ev, now) } : {};
    if (!CHAT_EVENTS.has(ev.hook_event_name)) return {};
    const full = recordPatch({ ...run, kind: 'claude' }, ev, now);
    return Object.fromEntries(Object.entries(full).filter(([k]) => CHAT_KEEPS.has(k)));
  }
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
    } else {
      Object.assign(patch, { status, note: '', attentionKind: null, askType: null, askWhat: '', askCard: null, handsWait: null, askers: {} });
    }
  };
  // `type`: what is asked (asking.mjs askType), so the page offers "Allow" for a permission only. `askAt`: every ask
  // has its own time, so the page tells a second question from the one the owner just answered.
  const ask = (key, note, kind, type = null, what = '', extra = {}) => {
    const left = [...without(key), key].slice(-20);
    const next = { ...only(left.filter((k) => k !== key)), [key]: { type, note, kind, at: now, what, ...extra } };
    Object.assign(patch, { asks: left, askers: next, status: 'attention', askAt: now }, waiting(left, next));
  };

  switch (ev.hook_event_name) {
    case 'PreToolUse':
      // The wall held this call (preToolHold): its hold is kept for the agent that made it (holdsPatch, below). The
      // dialog the tool draws for it comes as a PermissionRequest next; the hold goes with that ask. A call of the same
      // agent that holds nothing clears a hold left from its earlier one, so a stale card is never shown on, nor its
      // Allow sent for, a later unrelated permission; another agent's call leaves it alone.
      break;
    case 'SessionStart':
      if (ev.source === 'compact') break; // Claude Code compacted, often in the middle of a turn: nothing ended
      settle([], 'waiting');
      Object.assign(patch, { background: [], bgCommands: 0, endReason: null, agentStops: [], agentWhat: {} }); // a /clear ended the last one and goes on
      break;
    case 'UserPromptSubmit': {
      // The main agent's own question is gone by now: no prompt gets in while it is on the screen.
      settle(without(MAIN, SOMEONE), 'working');
      Object.assign(patch, { limit: null, failure: null, background: [], bgCommands: 0 });
      // A message of the owner's begins work between Hands-off's answers, so the loop count starts again. The
      // dashboard's own continue prompt, typed into a run after a move or a restart (watcher #followUp, server.mjs,
      // launch.mjs), is not the owner's and must not reset the count the move carried.
      const ownMessage = !(continuePrompt && typeof ev.prompt === 'string' && ev.prompt.trim() === String(continuePrompt).trim());
      if (ownMessage && run.handsOffRow) patch.handsOffRow = 0;
      break;
    }
    case 'Stop': {
      const tasks = (Array.isArray(ev.background_tasks) ? ev.background_tasks : []).filter(running);
      const background = tasks.filter((t) => WAKES.has(t.type) && typeof t.id === 'string').map((t) => t.id.slice(0, 80)).slice(0, 50);
      // A running background task that does NOT wake Claude — a background shell command (`npm run build &`) or a
      // monitor — keeps a command going while the reply is over, but it never makes Claude continue by itself, so
      // the session still waits for the owner's message. Counted on its own (the card says so in words); never
      // mixed into `background`, which stays agents and workflows and keeps its meaning for every status reader.
      const bgCommands = tasks.filter((t) => !WAKES.has(t.type)).length;
      // The main reply is over, so its own question is gone; a subagent's question can only still wait while that
      // subagent runs. One the owner stopped (ctrl+x ctrl+k while it asked) never sends PostToolBatch or
      // SubagentStop, and without this its question would hold the session on "needs your OK" for good. A
      // workflow's agents are not listed by id, so while a workflow runs their questions stay.
      const workflow = tasks.some((t) => t.type === 'workflow');
      const live = asks.filter((k) => k !== MAIN && k !== SOMEONE && (workflow || background.includes(k)));
      settle(live, background.length ? 'working' : 'waiting');
      Object.assign(patch, { background, bgCommands, stopAt: now, failure: null });
      // What each background agent does, in the words Claude Code lists it with: an agent that stops in an API error
      // later is named by them (StopFailure carries only its id and type).
      patch.agentWhat = Object.fromEntries(tasks.filter((t) => WAKES.has(t.type) && typeof t.id === 'string' && typeof t.description === 'string' && t.description.trim())
        .slice(0, 50).map((t) => [t.id.slice(0, 80), oneLine(cleanLine(t.description), 80)]));
      if (typeof ev.last_assistant_message === 'string') patch.lastMessage = oneLine(ev.last_assistant_message);
      break;
    }
    case 'StopFailure': {
      // The line is kept cleaned: a gateway puts the key, the account and the Authorization header into its error.
      const text = typeof ev.last_assistant_message === 'string' ? oneLine(cleanLine(ev.last_assistant_message)) : '';
      if (who !== MAIN) {
        // An agent inside the session ended in an API error (Claude Code 2.1.328 sends StopFailure with its agent_id).
        // The session goes on: its status, its other agents and their questions stay. This agent no longer runs, and
        // its stop is written down, with what it was doing, for the Operator: a step of the session was lost.
        const background = names(run.background);
        if (background.includes(who)) patch.background = background.filter((id) => id !== who);
        if (asks.includes(who)) settle(without(who), 'working');
        const what = run.agentWhat && typeof run.agentWhat === 'object' && typeof run.agentWhat[who] === 'string' ? run.agentWhat[who] : '';
        const label = oneLine(what || agentLabel(ev, who) || (typeof ev.agent_type === 'string' ? ev.agent_type : ''), 80);
        const was = (Array.isArray(run.agentStops) ? run.agentStops : []).filter((a) => a && typeof a === 'object' && a.id !== who);
        patch.agentStops = [...was, { id: who, label, at: now, error: String(ev.error || 'unknown').slice(0, 60), text }].slice(-10);
        break;
      }
      // The reply ended in an API error. Claude sits idle now; the text says why.
      Object.assign(patch, { status: 'attention', note: text || String(ev.error || 'error'), attentionKind: null, askType: null, askWhat: '', askCard: null, handsWait: null, asks: [], askers: {}, background: [], bgCommands: 0 });
      // Which kind of error (overloaded, server_error, authentication_failed…): the retry automation acts on it.
      // `own`: the session's own reply (an agent's stop is in agentStops). A failure without it was written by an
      // earlier hook, which wrote an agent's stop there too: the Operator then cannot say whose it was.
      patch.failure = { at: now, error: String(ev.error || 'unknown').slice(0, 60), text, own: true };
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
      // Answered by Hands-off (handsOffFor): no dialog is drawn, nobody is asked. Shown to the owner, the newest 10.
      if (hands && hands.output) {
        patch.handsOffDone = [...(Array.isArray(run.handsOffDone) ? run.handsOffDone : []), hands.line].slice(-cardParts.hourMax);
        patch.handsOffRow = (Number(run.handsOffRow) || 0) + 1;
        break;
      }
      if (hands && hands.loop) patch.handsOffStop = hands.loop === 'hour' ? 'hour' : 'loop';
      // The card is the tool's own data (cardFor); `handsWait`: why Hands-off left it to the owner.
      ask(who, question(ev), 'permission_prompt', cardParts.askType(ev.tool_name), askedWhat(ev), { card: cardParts.cardFor(ev), ...(hands && hands.wait ? { handsWait: hands.wait } : {}) });
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
      if (run.handsOffRow && workIn(ev)) patch.handsOffRow = 0; // work between Hands-off's answers
      break;
    }
    case 'SubagentStop': {
      const background = names(run.background);
      if (background.includes(who)) patch.background = background.filter((id) => id !== who);
      if (asks.includes(who)) settle(without(who), 'working');
      break;
    }
    case 'SessionEnd':
      // Why it ended, as Claude Code names it: "prompt_input_exit" is /exit or the exit keys, the person's own end
      // (the launcher then shows no menu); "logout", "clear", "resume", "other" are not.
      Object.assign(patch, { status: 'ended', asks: [], askers: {}, askCard: null, handsWait: null, background: [], bgCommands: 0, endReason: typeof ev.reason === 'string' ? ev.reason.slice(0, 40) : null });
      break;
    default:
      break;
  }
  // The holds, per agent, and the one the card shows. Never written into a record that never carried a hold
  // (Hands-off off leaves the record as the base code does).
  if (held || 'held' in run || 'holds' in run) Object.assign(patch, holdsPatch(run, ev, who, held, asks, patch));
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
export const wantsToolNews = (run) => Boolean(run) && run.status !== 'ended' && (run.status !== 'working' || names(run.asks).length > 0 || Number(run.handsOffRow) > 0);

// Nothing, an empty text and an empty list are the same "nothing" here, so a record written before these fields
// existed is not rewritten for their sake. The same for an empty object.
const plain = (v) => (v == null || v === '' || (Array.isArray(v) && !v.length) || (v.constructor === Object && !Object.keys(v).length) ? null : v);
const same = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));

/**
 * Apply `ev` to the run file, under its lock (runfile.mjs changeRun: two hooks of one session may run at once). The
 * file is written only when the event changes something; returns the record as it stands (null when the file is
 * gone: the launcher already cleaned up). `answer`: what the hook answered Claude Code for it (hookAnswer).
 */
export function applyRecord(file, ev, now = Date.now(), answer = null, hands = null, held = null, continuePrompt = null, cardParts = null) {
  const next = changeRun(file, (run) => {
    const patch = recordPatch(run, ev, now, { allowed: !!answer && !(hands && hands.output && answer === hands.output) && !held, hands, held, continuePrompt, cardParts });
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

// The dashboard's own continue prompt (Auto mode's move, the continue route's restart), for UserPromptSubmit only: it
// must not reset the loop count a move carried, so the record tells it from a message of the owner's.
function continuePromptFor(ev) {
  if (ev.hook_event_name !== 'UserPromptSubmit') return null;
  const a = readHoprigSettings().cfg.autoSwitch;
  return a && typeof a.prompt === 'string' && a.prompt.trim() ? a.prompt.trim().slice(0, 500) : CONTINUE_PROMPT;
}

/**
 * `hoprig hook` and bin/hoprig-hook.mjs: called by Claude Code with the event as JSON on stdin. An event that can be
 * answered goes to hook.mjs (answerEvent), which is loaded only then; any other event only updates the run file named
 * by $HOPRIG_RUN_FILE and prints nothing. It never fails: any other output would land in the conversation.
 */
export async function hookMain() {
  const file = process.env.HOPRIG_RUN_FILE;
  if (!file) return; // not a session Hoprig started: nothing to keep, nothing to answer
  let ev = null;
  try {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    ev = JSON.parse(raw);
  } catch {
    return; // an event of a shape we do not know: no answer, Claude Code asks as usual
  }
  if (!ev || typeof ev !== 'object') return;
  if (ANSWERED_EVENTS.has(ev.hook_event_name)) {
    const { answerEvent } = await import('./hook.mjs');
    answerEvent(file, ev);
    return;
  }
  try {
    applyRecord(file, ev, Date.now(), null, null, null, continuePromptFor(ev));
  } catch {
    /* never disturb the session */
  }
}
