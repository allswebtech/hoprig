// Run state: one JSON file per running launcher, <runsDir>/<runId>.json. The launcher creates it, Claude Code's
// hooks keep it current (`hoprig hook`), and the dashboard reads it to know, per tmux pane, which profile and
// which session is running and whether Claude is working or waiting.
//
//   runId      string
//   pid        the launcher's process id (the file is stale once this process is gone)
//   proc       the identity of the process that wrote it (procid.mjs: its pid and when it started), so that another
//              process that has the same pid later (after a reboot) is not taken for it. Absent in records of older
//              launchers: then a file last written before this boot is stale
//   profile    profile name
//   cwd        folder Claude runs in
//   tmuxPane   $TMUX_PANE ("%3") when started inside tmux, else null
//   termId     $HOPRIG_TERM_ID when started in a terminal the dashboard itself holds (no tmux), else null
//   sessionId  Claude session id, set by the SessionStart hook (also after /clear and /resume)
//   conversation  the conversation the launcher starts the coding tool on, when its arguments name one (a resume, a
//              start under a given id, a move), written with the record before the tool starts: until the tool
//              reports its own (sessionId), this is the fact that the terminal runs that conversation. null for a
//              new conversation and for "continue the last one" (-c), whose id only the tool knows
//   status     "starting" | "working" | "waiting" | "attention" | "ended" (hook.mjs says which event sets which)
//   note       what Claude waits for when status is "attention" (a permission, a question, an error)
//   asks       who waits for the owner's answer right now: "main", a subagent's id, or "?" (a notification that
//              does not say who). "attention" holds while this is not empty; absent or [] otherwise
//   background ids of the subagents and workflows still running when the last reply ended: Claude goes on by
//              itself when they finish, so the status stays "working". Absent or [] otherwise
//   carryArgs  the launch arguments that are kept when the session moves to another profile
//   limit      { at, error, text } when the last reply ended at a usage limit; null again on the next prompt
//   lastMessage  the start of what Claude last said (for a preview)
//   stopAt     when the last reply ended
//   failure    { at, error, text } when the last reply ended in an API error (any kind); null again on the next prompt
//   attentionKind  what is behind the last "attention": permission_prompt, elicitation_dialog… (Claude Code's
//              notification types); null when nothing waits
//   askType    what the last ask is, when Claude Code named the tool that asks (asking.mjs): "permission", "question"
//              (it asks the owner something) or "plan" (a plan to approve); null when nothing waits or a notification
//              alone told it. Only a permission is answered with "allow"
//   askAt      when the last ask came: two questions in a row have two times
//   fallback   true when the session runs here only because a preferred profile reached its limit
//   usage      (added when read) how much of the plan's limits is used, from Claude Code's status data:
//              { fiveHour?: { pct, resetsAt }, week?: { pct, resetsAt }, at }; `at` is when Claude Code wrote it.
//              Absent for API profiles and for plans that report none. Each reading is also kept per provider
//              (routerstate.mjs: rememberUsage), so the figures outlive the run.
//   tool       the coding tool: 'claude' (Claude Code; its hooks keep this record), 'codex' or 'opencode' (the launcher
//              of src/codetools/terminal.mjs keeps it from the tool's server). Absent in records of older launchers:
//              Claude Code
//   server     (codex, opencode) true while the session is attached to Hoprig's server of that tool
//   statusSource  (codex, opencode) 'server': the status comes from the server's events; 'basic': it does not (the
//              tool runs on its own, or the server cannot be reached), and the card reads the screen's activity only
//   title      (codex, opencode) the conversation's name as the tool gave it
//   startedAt, statusAt   epoch milliseconds. startedAt is when the record first named its conversation: kept when the
//              launcher writes its record anew for its own move, so who held a conversation first stays known
//   termName   the dashboard's name of the terminal it runs in ($HOPRIG_TERM_NAME; the built-in terminals set it), or null
//   tmuxSocket the tmux server of its pane (from $TMUX), so another launcher can name that session
//
// A chat of the dashboard (src/chat) writes a record of the same kind while its coding tool's process runs on a
// conversation: kind 'chat', its chat's id (chat), pid the dashboard's own, conversation and tool, and sessionId once
// the process goes on in another conversation (a clear; OpenCode names a new chat's conversation itself). It holds no terminal,
// so only the readers of "who runs this conversation" (heldBefore, the dashboard's claim) list it: listRuns({ chats }).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { allMarkFile } from './allmark.mjs';
import { herMarkFile } from './hermark.mjs';
import { hookSettingsDir, runsDir, stateDir } from './paths.mjs';
import { stillOwned, system } from './procid.mjs';
import { rememberUsage, usageForgotten } from './routerstate.mjs';
import { changeRun, readRun, watchFile, writeRun as write } from './runfile.mjs';
import { RUN_ID_RE } from './launchfile.mjs';
import { noteEnd, noteStart } from './work/sessionlog.mjs';
import { replaceFile } from './replacefile.mjs';

export { readRun };

// Which provider each run of a conversation was on, until when: a record is written anew for another provider (the
// launcher's own move: Auto mode in the terminal, its menu after a stop) or removed (its launcher ended: a move from
// the dashboard restarts the terminal, and so does the owner who ends a session and resumes it on another provider).
// One JSON line per run that left its provider, <state>/runs-ended.jsonl, the last day. The Operator's limit rule reads
// it: it never moves a session back to a provider the session left within the hour, whoever moved it. A line is
// appended in one write (two writers never mix theirs); a line that cannot be read is skipped.
const ENDED_DAY = 24 * 3600_000;
const ENDED_MAX_BYTES = 64 * 1024;
const endedFile = () => path.join(stateDir(), 'runs-ended.jsonl');

function noteEnded(run, at = Date.now()) {
  try {
    const conversation = run && (run.sessionId || run.conversation);
    if (typeof conversation !== 'string' || !conversation || typeof run.profile !== 'string' || !run.profile) return;
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.appendFileSync(endedFile(), `${JSON.stringify({ conversation, tool: run.tool || 'claude', profile: run.profile, until: at })}\n`, { mode: 0o600 });
    if (fs.statSync(endedFile()).size > ENDED_MAX_BYTES) {
      const keep = ranBefore(at).map((r) => JSON.stringify(r)).join('\n');
      const tmp = `${endedFile()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, keep ? `${keep}\n` : '', { mode: 0o600 });
      replaceFile(tmp, endedFile());
    }
  } catch {
    /* never in the way of a run: a run that is not noted still ends */
  }
}

/** The runs of the last day that left their provider: [{ conversation, tool, profile, until }] (a time later than `now` counts as now). */
export function ranBefore(now = Date.now()) {
  let text = '';
  try {
    text = fs.readFileSync(endedFile(), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      const r = JSON.parse(l);
      if (!r || typeof r.conversation !== 'string' || typeof r.profile !== 'string' || !Number.isFinite(r.until)) continue;
      const until = Math.min(r.until, now);
      if (now - until < ENDED_DAY) out.push({ conversation: r.conversation, tool: typeof r.tool === 'string' ? r.tool : 'claude', profile: r.profile, until });
    } catch {
      /* a line cut off: skipped */
    }
  }
  return out;
}

/**
 * A new run id: the millisecond and the process id, and when a record of that name is there already (two made in one
 * millisecond by one process), the same with eight hex digits after it (RUN_ID_RE allows that tail).
 */
function freeRunId() {
  const base = `${Date.now().toString(36)}-${process.pid}`;
  let id = base;
  while (fs.existsSync(path.join(runsDir(), `${id}.json`))) id = `${base}-${crypto.randomBytes(4).toString('hex')}`;
  return id;
}

/**
 * `file`: the record of this launcher's previous run, written anew (its own move to another profile keeps it).
 * `hand`: a move of the dashboard's (launchfile.mjs HAND): the record takes the run id the dashboard chose, unless a
 * record of that id is there already, and the stops and the count of the run it came from, only when it starts on the
 * conversation that move carries on.
 */
export function createRun({ profile, cwd, carryArgs = [], tool = 'claude', conversation = null, file: again = null, hand = null }) {
  const given = !again && hand && typeof hand.runId === 'string' && RUN_ID_RE.test(hand.runId) && !fs.existsSync(path.join(runsDir(), `${hand.runId}.json`)) ? hand.runId : null;
  const runId = again ? path.basename(again, '.json') : given || freeRunId();
  const file = again || path.join(runsDir(), `${runId}.json`);
  const now = Date.now();
  const before = again ? readRun(again) : null;
  if (before && before.profile !== profile) noteEnded(before, now);
  // The run the dashboard moved this session from, as the move read it from that one record (its stops, its count).
  const c = given && conversation && hand.conversation === conversation && hand.carry && typeof hand.carry === 'object' ? hand.carry : null;
  const was = before || (c ? { handsOffStop: c.stop, handsOffRow: c.row, handsOffDone: c.done } : null);
  const run = {
    runId,
    pid: process.pid,
    proc: system.self(),
    profile,
    cwd,
    tmuxPane: process.env.TMUX_PANE || null,
    termId: process.env.HOPRIG_TERM_ID || null,
    termName: process.env.HOPRIG_TERM_NAME || null,
    tmuxSocket: process.env.TMUX_PANE && process.env.TMUX ? process.env.TMUX.split(',')[0] : null,
    sessionId: null,
    conversation: conversation || null,
    status: 'starting',
    note: '',
    carryArgs,
    tool,
    startedAt: before && Number.isFinite(before.startedAt) ? before.startedAt : now,
    statusAt: now,
  };
  // The same session goes on (a move to another provider): Hands-off's stops (a loop's, the hour's), its count and the
  // answers the hour is counted from go on with it, so a move never answers again after a stop and never starts the
  // hour's count at nothing. Its own switch is kept under the run id, which stays (handsoff.mjs); a move of the
  // dashboard's keeps it under the id it chose for this record (server/deck.mjs).
  if (was && (was.handsOffStop === 'loop' || was.handsOffStop === 'hour' || was.handsOffStop === 'reset')) run.handsOffStop = was.handsOffStop;
  if (was && Number.isInteger(was.handsOffRow) && was.handsOffRow > 0) run.handsOffRow = was.handsOffRow;
  if (was && Array.isArray(was.handsOffDone) && was.handsOffDone.length) run.handsOffDone = was.handsOffDone;
  // A resumed run the dashboard could not carry Hands-off for (a restore after a reboot, a chat/terminal hand-off):
  // it starts with its answers stopped, so it is the owner's until he turns it on, whatever the project's switch
  // says. The wall still holds by the switch (hook.mjs preToolHold); the stop only ends the answers. Never on a
  // relaunch of the same record (`again`), and never over a real carried stop.
  if (!again && !run.handsOffStop && hand && hand.reset === true) run.handsOffStop = 'reset';
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  write(file, run);
  noteStart(file, run); // Work's history (never throws)
  return { file, run };
}

/** The record of a chat's process on `conversation` (see the top of this file). Removed with removeRun when it ends. */
export function createChatRun({ chat, conversation, tool = 'claude', cwd, profile }) {
  const runId = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const file = path.join(runsDir(), `${runId}.json`);
  const now = Date.now();
  const run = { runId, kind: 'chat', chat, pid: process.pid, proc: system.self(), profile, cwd, sessionId: null, conversation, status: 'working', tool, startedAt: now, statusAt: now };
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  write(file, run);
  return { file, run };
}

/** Record `r` runs conversation `id` of coding tool `tool`: the tool's own report first, else the id it was started on. */
export const runsConversation = (r, id, tool = 'claude') => (r.tool || 'claude') === tool && (r.sessionId === id || (!r.sessionId && r.conversation === id));

/**
 * One conversation, one process, between processes that do not know of each other (a launcher in any terminal, a chat
 * of the dashboard): each writes its record first and asks this second. The live record (a terminal's or a chat's)
 * that runs conversation `id` and was there before `mine`, or null. Of two that start at the same moment, each sees
 * the other or only the later one sees the earlier: the earlier goes on, the later starts nothing.
 */
export function heldBefore(mine, id, tool = 'claude') {
  const earlier = (r) => r.startedAt < mine.startedAt || (r.startedAt === mine.startedAt && r.runId < mine.runId);
  // Only the records on this conversation are judged: on Windows asking the system about other processes takes most of
  // a second, and every launcher start asks this.
  return listRuns({ chats: true, usage: false, only: (r) => r.runId !== mine.runId && r.status !== 'ended' && runsConversation(r, id, tool) && earlier(r) })[0] || null;
}

/**
 * The records of chat `chat` of this dashboard that no process of it holds (`live`: the record files of the
 * dashboard's chat processes that have not ended, and of starts getting ready): left over, never counted. Their pid is
 * the dashboard's, so nothing else would ever remove them. A record in `live` stays, whichever chat object wrote it: a
 * chat closed a moment ago may still be ending under the same id.
 */
export function removeChatLeftovers(chat, live) {
  for (const r of listRuns({ chats: true, usage: false })) {
    const file = path.join(runsDir(), `${r.runId}.json`);
    if (r.kind === 'chat' && r.chat === chat && r.pid === process.pid && !live.has(file)) removeRun(file);
  }
}

/** Where the launch's status line script saves Claude Code's status data (see statusScript in launch.mjs). */
export const usageFile = (file) => `${file}.usage`;

const windowOf = (w) => {
  if (!w || typeof w !== 'object' || !Number.isFinite(Number(w.used_percentage))) return null;
  let resetsAt = null;
  if (typeof w.resets_at === 'number' && w.resets_at > 0) resetsAt = w.resets_at < 1e12 ? w.resets_at * 1000 : w.resets_at;
  else if (typeof w.resets_at === 'string' && !Number.isNaN(Date.parse(w.resets_at))) resetsAt = Date.parse(w.resets_at);
  return { pct: Math.max(0, Math.min(100, Math.round(Number(w.used_percentage)))), resetsAt };
};

/** Plan usage of the run in `file`, or null when Claude Code did not report any (API profiles, older versions). */
export function readUsage(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(usageFile(file), 'utf8'));
  } catch {
    return null;
  }
  const rl = data && data.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const out = {};
  const five = windowOf(rl.five_hour);
  const week = windowOf(rl.seven_day);
  if (five) out.fiveHour = five;
  if (week) out.week = week;
  return Object.keys(out).length ? out : null;
}

/**
 * The run's plan usage with the time Claude Code wrote it (`at`), kept for its provider as well so it is still
 * known after the run. null when there is none.
 */
export function noteUsage(file, profile) {
  const usage = readUsage(file);
  if (!usage) return null;
  let at = Date.now();
  try {
    at = Math.round(fs.statSync(usageFile(file)).mtimeMs);
  } catch {
    /* the file went away just now: the figures were read a moment ago */
  }
  try {
    // Figures of the account that was signed in before (the session has not asked anything since): not this run's.
    if (usageForgotten(profile, usage)) return null;
    rememberUsage(profile, usage, at);
  } catch {
    /* the store is a convenience: a run is listed without it */
  }
  return { ...usage, at };
}

/** Merge `patch` into the run file. Does nothing when the file is gone (the launcher already cleaned up). */
export function updateRun(file, patch) {
  return changeRun(file, (run) => {
    const next = { ...run, ...patch };
    if (patch.status && patch.status !== run.status) next.statusAt = Date.now();
    return next;
  });
}

export function removeRun(file) {
  const ending = readRun(file);
  noteEnded(ending);
  noteEnd(file, ending); // Work's history, before Tia's mark goes (never throws)
  // The settings Hoprig handed the run's coding tool (launch.mjs, a chat's: claude.mjs) go with its record, and so
  // does the mark that said the session was Tia's (hermark.mjs: the hold it fed must not outlive the session).
  for (const f of [file, usageFile(file), watchFile(file), `${file}.lock`, path.join(hookSettingsDir(), path.basename(file)), herMarkFile(file), allMarkFile(file)]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
}

/**
 * Settings files handed to a coding tool whose run record is gone (a dashboard or launcher stopped by a signal before
 * it could remove them): removed. Only files named like a record (<runId>.json); the record is written first and goes
 * last, so a run that starts now always has its record.
 */
export function removeSettingsLeftovers() {
  let names = [];
  try {
    names = fs.readdirSync(hookSettingsDir());
  } catch {
    return;
  }
  for (const n of names) {
    // A handed settings file (<runId>.json) or the Tia mark beside it (<runId>.json.tia, hermark.mjs); both go when
    // their run record is gone.
    const record = n.endsWith('.tia') || n.endsWith('.all') ? n.slice(0, -4) : n;
    if (!/^[A-Za-z0-9-]+\.json$/.test(record) || fs.existsSync(path.join(runsDir(), record))) continue;
    try {
      fs.unlinkSync(path.join(hookSettingsDir(), n));
    } catch {
      /* gone meanwhile */
    }
  }
}

/**
 * Record `run`, as listed a moment ago, is still its process's: read and judged again as listRuns does (one that is not
 * any more goes), with what the system says now, not what it said a while ago. For the moment before something is done
 * to that process.
 */
export async function stillRuns(run, ident = system) {
  const after = (await ident.refresh?.([run.pid])) || 0;
  const file = path.join(runsDir(), `${path.basename(String(run.runId))}.json`);
  const now = readRun(file);
  if (!now || now.pid !== run.pid) return false;
  if (stillOwned([{ run: now, file }], ident, { after })[0]) return true;
  removeRun(file);
  return false;
}

/**
 * Every live run of a launcher. Files whose process is gone are deleted on the way. `chats`: the records of the
 * dashboard's chat processes too (they run a conversation, but in no terminal). `usage`: each run's plan usage is read
 * and kept for its provider (noteUsage); the readers of "who runs this conversation" need none of it, and leave the
 * provider's store to the dashboard instead of writing it from every launcher and chat start. A record counts while
 * the process that wrote it runs (procid.mjs stillOwned), not while its pid does. `ident`: procid.mjs makeIdentity.
 * `only(run)`: the records asked about; the others are neither judged, removed nor listed.
 */
export function listRuns({ chats = false, usage: withUsage = true, ident = system, only = null } = {}) {
  let names;
  try {
    names = fs.readdirSync(runsDir());
  } catch {
    return [];
  }
  const read = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(runsDir(), f);
    const run = readRun(file);
    if (!run || !Number.isInteger(run.pid)) {
      // Leave a file that is being written right now (unparsable for a moment) alone unless it is old.
      const old = (() => { try { return Date.now() - fs.statSync(file).mtimeMs > 60_000; } catch { return false; } })();
      if (run || old) removeRun(file);
      continue;
    }
    // A record's id is its file's name, whatever the file says: a command of the session can write its own record,
    // and the owner's press on its page (server/handsoff.mjs) must not land on another session's switch.
    run.runId = f.slice(0, -'.json'.length);
    if (!only || only(run)) read.push({ run, file });
  }
  const owned = stillOwned(read, ident); // all pids at once: on Windows asking the system takes most of a second
  const runs = [];
  for (const [i, { run, file }] of read.entries()) {
    if (!owned[i]) {
      removeRun(file);
      continue;
    }
    if (run.kind === 'chat') {
      if (chats) runs.push(run);
      continue;
    }
    const usage = withUsage ? noteUsage(file, run.profile) : null;
    if (usage) run.usage = usage;
    runs.push(run);
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt);
}
