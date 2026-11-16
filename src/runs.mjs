// Run state: one JSON file per running launcher, <runsDir>/<runId>.json. The launcher creates it, Claude Code's
// hooks keep it current (`hoprig hook`), and the dashboard reads it to know, per tmux pane, which profile and
// which session is running and whether Claude is working or waiting.
//
//   runId      string
//   pid        the launcher's process id (the file is stale once this process is gone)
//   profile    profile name
//   cwd        folder Claude runs in
//   tmuxPane   $TMUX_PANE ("%3") when started inside tmux, else null
//   termId     $HOPRIG_TERM_ID when started in a terminal the dashboard itself holds (no tmux), else null
//   sessionId  Claude session id, set by the SessionStart hook (also after /clear and /resume)
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
//   fallback   true when the session runs here only because a preferred profile reached its limit
//   usage      (added when read) how much of the plan's limits is used, from Claude Code's status data:
//              { fiveHour?: { pct, resetsAt }, week?: { pct, resetsAt }, at }; `at` is when Claude Code wrote it.
//              Absent for API profiles and for plans that report none. Each reading is also kept per provider
//              (routerstate.mjs: rememberUsage), so the figures outlive the run.
//   startedAt, statusAt   epoch milliseconds
import fs from 'node:fs';
import path from 'node:path';
import { runsDir } from './paths.mjs';
import { rememberUsage } from './routerstate.mjs';
import { readRun, watchFile, writeRun as write } from './runfile.mjs';

export { readRun };

export function createRun({ profile, cwd, carryArgs = [] }) {
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const file = path.join(runsDir(), `${runId}.json`);
  const now = Date.now();
  const run = {
    runId,
    pid: process.pid,
    profile,
    cwd,
    tmuxPane: process.env.TMUX_PANE || null,
    termId: process.env.HOPRIG_TERM_ID || null,
    sessionId: null,
    status: 'starting',
    note: '',
    carryArgs,
    startedAt: now,
    statusAt: now,
  };
  fs.mkdirSync(runsDir(), { recursive: true, mode: 0o700 });
  write(file, run);
  return { file, run };
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
    rememberUsage(profile, usage, at);
  } catch {
    /* the store is a convenience: a run is listed without it */
  }
  return { ...usage, at };
}

/** Merge `patch` into the run file. Does nothing when the file is gone (the launcher already cleaned up). */
export function updateRun(file, patch) {
  const run = readRun(file);
  if (!run) return null;
  const next = { ...run, ...patch };
  if (patch.status && patch.status !== run.status) next.statusAt = Date.now();
  write(file, next);
  return next;
}

export function removeRun(file) {
  for (const f of [file, usageFile(file), watchFile(file)]) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** Every live run. Files whose launcher is gone are deleted on the way. */
export function listRuns() {
  let names;
  try {
    names = fs.readdirSync(runsDir());
  } catch {
    return [];
  }
  const runs = [];
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(runsDir(), f);
    const run = readRun(file);
    if (!run || !Number.isInteger(run.pid) || !alive(run.pid)) {
      // Leave a file that is being written right now (unparsable for a moment) alone unless it is old.
      const old = (() => { try { return Date.now() - fs.statSync(file).mtimeMs > 60_000; } catch { return false; } })();
      if (run || old) removeRun(file);
      continue;
    }
    const usage = noteUsage(file, run.profile);
    if (usage) run.usage = usage;
    runs.push(run);
  }
  return runs.sort((a, b) => a.startedAt - b.startedAt);
}
