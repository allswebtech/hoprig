// The hook: Claude Code calls it with one event as JSON on stdin, and it keeps the run record's status true
// (runs.mjs says what the record holds). The record's part is hookrecord.mjs, the hook's hot path: a status event loads
// only that. This module (the wall, the answers) is loaded only for PreToolUse and PermissionRequest.
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
import { cardOf, heldLine, heldRecord } from './askcard.mjs';
import { adminRefusal } from './assistant/adminrefused.mjs';
import { herRightsLevel } from './assistant/herrights.mjs';
import { createActivityLog } from './automation/store.mjs';
import { BECAUSE, HOUR_MAX, LOOP_MAX, answerText, decide, handsOffOffered, hoprigVersion, hourFull, movingAway, projectEntry, sessionEntry, settingsHoldWall, switchState } from './handsoff.mjs';
import { configDir, defaultWorkspaceDir, hookFile, hoprigOwnDirs, stateDir } from './paths.mjs';
import { applyRecord, askedWhat, readHoprigSettings, recordPatch } from './hookrecord.mjs';
import { readRun } from './runfile.mjs';
import { floorLine, wallHeld, wipesWhole } from './wall.mjs';

// The record's part of the hook (hookrecord.mjs), named here as well, for the files and tests that import it from here.
export { askedWhat, hookMain, wantsToolNews } from './hookrecord.mjs';

// What a PermissionRequest's record needs from the modules the hot path does not load: the card and what is asked.
const CARD_PARTS = Object.freeze({ askType, cardFor, hourMax: HOUR_MAX });

/** What `ev` changes in `run` (hookrecord.mjs recordPatch), with the card a PermissionRequest needs. Pure. */
export const hookPatch = (run, ev, now = Date.now(), o = {}) => recordPatch(run, ev, now, { ...o, cardParts: CARD_PARTS });

/** Apply `ev` to the run file under its lock (hookrecord.mjs applyRecord), with the card a PermissionRequest needs. */
export const applyHook = (file, ev, now = Date.now(), answer = null, hands = null, held = null, continuePrompt = null, by = null) => applyRecord(file, ev, now, answer, hands, held, continuePrompt, CARD_PARTS, by);

/**
 * The exact card of what `ev` asks (askcard.mjs): from the hook's own data, the tool's input as it came. A plan's text
 * and a question's words are masked for secrets there (askcard.mjs), as a command is.
 */
export function cardFor(ev) {
  const input = ev && ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  return cardOf({ tool: ev.tool_name, input, engine: 'claude', source: 'hook', what: askedWhat(ev) });
}

const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

/**
 * What Hands-off does for a PermissionRequest of a terminal session (handsoff.mjs), or null where it is off (then it
 * does nothing at all). `run`: the session's record; `cfg`: Hoprig's settings; `runId` and `project`: whose switches
 * count (handsOffKeys), never read from the record, which the session's own commands can write. → { output (the hook's
 * answer), line (what the owner is shown) } or { wait (why it waits for him), loop }.
 * A question is answered through the hook itself, the way Claude Code takes an answer from it (2.1.327: the input with
 * `answers`, question → label, shows "Answered Claude's questions" and no dialog). A plan is not: Claude Code 2.1.327
 * draws its plan dialog although the hook allowed it (with and without a mode), so a plan in a terminal waits. A
 * coding chat's record is the chat's: the chat answers through its own channel (chat/handsoff.mjs).
 */
export function handsOffFor(ev, run, { cfg = {}, version = hoprigVersion(), now = Date.now(), runId = null, project = null, hasHold = true } = {}) {
  if (!ev || ev.hook_event_name !== 'PermissionRequest' || !run || typeof run !== 'object' || run.kind === 'chat') return null;
  if (!ASKING_TOOLS.has(ev.tool_name)) return null; // a permission: the mode's own rules, as without Hands-off
  if (!handsOffOffered(cfg)) return null; // Hands-off is not offered on this computer: never an answer (the card is still exact)
  // No wall hold in the session's handed settings (started before Hands-off, or on a tool with no such hook): it
  // could answer a question but never hold an act, so Hands-off answers nothing for it and the question is left to
  // the owner. The project's switch names such a session back in `uncovered` (server/handsoff.mjs) so he is told.
  if (!hasHold) return null;
  // The dashboard is moving this session (deck.mjs): its count went to the new run already, so no answer is given now.
  if (movingAway(cfg, runId)) return null;
  const st = switchState({ session: sessionEntry(cfg, runId), project: projectEntry(cfg, project), version, stopped: run.handsOffStop });
  if (!st.on) return null;
  if (ev.tool_name === 'ExitPlanMode') return { wait: 'plan-terminal' };
  if ((Number(run.handsOffRow) || 0) >= LOOP_MAX) return { wait: 'loop', loop: true };
  if (hourFull((Array.isArray(run.handsOffDone) ? run.handsOffDone : []).map((d) => d && d.at), now, st.since)) return { wait: 'hour', loop: 'hour' };
  const card = cardFor(ev);
  const d = decide(card, { note: st.note });
  if (!d.answer) return { wait: d.wait };
  const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
  return {
    output: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow', updatedInput: { ...input, answers: d.answer.answers } } } },
    line: { at: now, kind: card.kind, question: card.questions.map((q) => q.question).join(' · ').slice(0, 300), text: answerText(card, d), because: d.because },
  };
}

/**
 * The wall's hold for a PreToolUse event (wall.mjs): while Hands-off is on for the session, a tool call that is the
 * owner's alone (administrator rights, publishing or releasing, a pull request, and the kinds their slice adds) is
 * answered "ask", so the coding tool draws his card in every permission mode, bypass included. Null where Hands-off
 * is not offered, or is off for the session, or the call is an ordinary one that goes through. Read like handsOffFor:
 * the switch comes from the config, never from the record the session can write. This is a HOLD, not an answer: it
 * never carries the loop or the hour's stop (those count answers Hoprig gave, and a hold is the owner answering).
 * The same wall reads the PermissionRequest side (hookAnswer), so what the hold held is never allowed by the hook.
 */
export function preToolHold(ev, run, { cfg = {}, version = hoprigVersion(), runId = null, project = null, places = null, cfgReadFailed = false, handed = false, byTia = false } = {}) {
  if (!ev || ev.hook_event_name !== 'PreToolUse') return null;
  const ask = () => {
    const held = wallHeld({ tool: ev.tool_name, input: ev.tool_input, cwd: typeof ev.cwd === 'string' ? ev.cwd : null, places });
    // The reason in the tool's dialog says the card in one line: what is held, why it is his, what Yes and No do.
    return held ? { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: heldLine(held) } }, held } : null;
  };
  // Hands-off's hold (the wall, whatever kind it reads), or null where Hands-off is off or not offered for the session.
  const handsOff = () => {
    // The config could not be READ at all (gone or unparseable). Offered now defaults true, so the wall must not take
    // its answer from an empty config: do not lose the wall with the file. A session started with the hold (its handed
    // settings carry the PreToolUse entry, so Hands-off was offered when it started) keeps holding the kinds it reads;
    // a session without the hold has nothing to hold.
    if (cfgReadFailed) return handed ? ask() : null;
    // The config reads cleanly. Offered is the shipped default; only `handsOff.offered: false`, the owner's own choice
    // to hide the feature, reads as not offered and is honoured (nothing held).
    if (!handsOffOffered(cfg)) return null;
    // The switch is read from the config (whose switch counts is handsOffKeys, from Claude Code, not the record): so a
    // missing run record cannot switch the wall off. A session that moves or deletes its own record ($HOPRIG_RUN_FILE)
    // would leave `run` null; the kinds the wall holds stay held all the same (a hold never carries a loop/hour stop,
    // so a null record only means that stop is unknown, which is no reason to let a held act through).
    // A stop Hoprig made itself (a loop, an hour, or the reset of a resumed run) ends the ANSWERS (handsOffFor), never
    // the hold: the owner left with Hands-off on, so what is his keeps waiting for him until HE turns the switch off.
    // The hold reads only his switch — the session's own entry, else the project's — and ignores the stop.
    const st = switchState({ session: sessionEntry(cfg, runId), project: projectEntry(cfg, project), version });
    if (!st.on) return null;
    return ask();
  };
  // A session Tia started is no way round her administrator-rights level: below Full,
  // an act of hers that is the owner's alone is held as the owner's card even with Hands-off off or not offered. One
  // more reason to hold, over the same wall reader; whose session it is is what the dashboard wrote at the start, not the record.
  return handsOff() || sessionHold(ev, { cfg, byTia, places, version });
}

/**
 * A session Tia started is no way round her administrator-rights level (src/assistant/
 * herrights.mjs). Below Full, an act of hers that is the owner's alone is held as the owner's card — the coding
 * tool's own "ask" dialog, the way the wall of Hands-off holds it — whatever Hands-off's switch says and whether or
 * not it is offered. The wall (wall.mjs) is the one reader of what is the owner's; this takes its hold as it is and
 * makes no narrower judgement of its own, so there is no gap to slip through: a line the wall cannot read with
 * certainty (an administrator command hidden in $(…) or a backtick) is held like any uncertain line, and a delete or
 * a touch of Hoprig's own state — the mark that makes this session hers included — is held, so a session cannot
 * quietly unmark itself to lift this hold. At Full her administrator commands run without a card. `byTia` is what the
 * dashboard wrote at the start (sessionByTia), never the run record a command of the session can write.
 */
function sessionHold(ev, { cfg = {}, byTia = false, places = null, version = hoprigVersion() } = {}) {
  if (!byTia) return null;
  const held = wallHeld({ tool: ev.tool_name, input: ev.tool_input, cwd: typeof ev.cwd === 'string' ? ev.cwd : null, places });
  // Full runs her administrator commands without a card — except the floor no level lifts: a command that
  // would change who may be administrator or switch a safety rule off is still held, so a bypass session cannot
  // quietly keep root after the level goes back to Off.
  const shown = herHeld(held, ev, { cfg, places, version });
  if (!shown) return null;
  return { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: heldLine(shown) } }, held: shown };
}

/**
 * What of the wall's hold `held` (wallHeld) is left to hold in a session of hers at her level: below Full all of it;
 * at Full what is not an administrator act, or null when nothing is left. The one place of that rule, so a chat's card
 * (chat/handsoff.mjs chatCard) names the act the hook held, not the wall's first.
 */
export function herHeld(held, ev, { cfg = {}, places = null, version = hoprigVersion() } = {}) {
  if (!held) return null;
  // Full is about administrator rights alone: it lifts the administrator acts of the line and nothing else, so a push
  // to the main branch or a release in her session stays his card at Full as below it.
  // An administrator act the wall marked `unsure` (a word whose value cannot be told from the line, or an administrator
  // command inside another command's text) is not lifted: Hoprig cannot say what it would change, so it stays his card.
  if (herRightsLevel(cfg, version) !== 'full' || everyLevelFloor(ev, places)) return held;
  const acts = (held.acts || [held]).filter((a) => a.kind !== 'admin' || a.unsure);
  return acts.length ? { ...acts[0], acts } : null;
}

/**
 * Is this call one of the administrator forms refused at EVERY level (src/assistant/adminrefused.mjs)?
 * `sudo su` and the other escalators, a sudoers/PAM edit, a login or shell as administrator, a setuid bit — the forms
 * that would change who may be administrator or switch a safety rule off. These stay held even at Full, so a session
 * cannot auto-run one and leave permanent root behind. A line the reader cannot break down (an administrator command
 * hidden in $(…) or a backtick) is this floor too: the floor is fail-closed — "what it cannot read is refused, not
 * run" at EVERY level, Full included — so an unreadable administrator line is held as his card at Full, not run.
 */
function everyLevelFloor(ev, places = null) {
  const command = ev && ev.tool_name === 'Bash' && ev.tool_input && typeof ev.tool_input.command === 'string' ? ev.tool_input.command : null;
  if (!command) return false;
  // A `~` or relative word is read as the shell expands it, from the session's home and the folder the shell is in.
  const p = places ? (typeof places === 'function' ? places() : places) : null;
  const home = p && typeof p.home === 'string' && p.home ? p.home : os.homedir();
  return !!adminRefusal(command, { hoprigDirs: hoprigOwnDirs(), home, cwd: typeof ev.cwd === 'string' ? ev.cwd : null });
}

/**
 * Whose Hands-off switches count for the hook of run file `file`: the run id is the file's own name and the project is
 * the folder Claude Code says it runs for (CLAUDE_PROJECT_DIR, which it sets for every hook), both from what Claude Code
 * hands the hook. Not the record's runId or cwd: a command of the session can write its record ($HOPRIG_RUN_FILE), and
 * would then borrow another session's or another project's switch. Without CLAUDE_PROJECT_DIR only the session's own
 * switch counts.
 */
export function handsOffKeys(file, env = process.env) {
  const dir = env.CLAUDE_PROJECT_DIR;
  // The switch is stored under the folder's real path (server/handsoff.mjs insideRoots → realpathSync). Claude Code may
  // hand the hook a path reached through a symlink, so resolve it the same way; if it cannot be resolved, normalise it.
  let project = null;
  if (typeof dir === 'string' && path.isAbsolute(dir)) {
    try {
      project = fs.realpathSync(dir);
    } catch {
      project = path.normalize(dir);
    }
  }
  return { runId: path.basename(String(file), '.json'), project };
}

// Is Hands-off still on for the session of `file`, read again now: no answer starts after the owner's stop.
function stillOn(file, version, keys) {
  const run = readRun(file);
  const cfg = hoprigSettings();
  return !!run && !movingAway(cfg, keys.runId) && switchState({ session: sessionEntry(cfg, keys.runId), project: projectEntry(cfg, keys.project), version, stopped: run.handsOffStop }).on;
}

const ALLOW = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PermissionRequest', decision: Object.freeze({ behavior: 'allow' }) }) });
// The same answer, given by "Allow everything": its own object, so the record can say who allowed it (answerEvent).
const ALLOW_ALL = Object.freeze({ hookSpecificOutput: Object.freeze({ hookEventName: 'PermissionRequest', decision: Object.freeze({ behavior: 'allow' }) }) });

/**
 * "Allow everything": every permission of a session in bypassPermissions whose process carries the mode (facts.allOn)
 * is allowed at once, also a command line the wall cannot read and what Bypass leaves to the owner, and also what
 * Hands-off's wall holds in every other session: the mode is his own choice for this session, so nothing of the wall is
 * held in it. Never a question or a plan (the coding tool's own, to him), never a session of Tia's (facts.hers: her
 * level holds whatever the mode says; such a session never carries the mode), and never the one removal read for certain
 * as wiping the whole home, workspace, projects folder or disk (wipesWhole). Anything else falls through to the rule of
 * Bypass, which allows less.
 */
function allAnswer(ev, facts) {
  if (askType(ev.tool_name) !== 'permission') return null;
  if (ev.tool_name === 'Bash' && ev.tool_input && typeof ev.tool_input.command === 'string' && wipesWhole({ command: ev.tool_input.command, places: facts.places() })) return null;
  if (facts.hers && facts.hers()) return null;
  return ALLOW_ALL;
}

/**
 * "Allow everything" for a PreToolUse event (facts.floorOn: the process carries the mode, or the dashboard marked this
 * session's chat in it): BEFORE a shell command runs, the one removal read for certain as wiping the whole home,
 * workspace, projects folder or disk is answered "ask" with the floor line, whether or not anything else would ask.
 * Everything else the wall holds for Hands-off (`hold`, from preToolHold) is NOT held: it is noted as allowed by the mode
 * ({ note: true }) and runs. → { output, floor } | { note: true } | null (nothing to say).
 */
export function allPre(ev, facts, hold = null) {
  if (!ev || ev.hook_event_name !== 'PreToolUse' || !facts.floorOn || !facts.floorOn()) return null;
  const command = ev.tool_name === 'Bash' && ev.tool_input && typeof ev.tool_input.command === 'string' ? ev.tool_input.command : null;
  const floor = command ? wipesWhole({ command, places: facts.places() }) : null;
  if (floor) return { output: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: floorLine(floor) } }, floor };
  return hold ? { note: true } : null;
}

/**
 * What the hook needs to know about the session beyond the event, read when asked (only for a PermissionRequest in
 * bypass mode): the "ask" rules of the settings Claude Code reads for it, and for plainDelete the folder the command
 * runs in (the event's cwd: the shell's folder at that moment, so a relative target can be read) and the folders that
 * may not be that folder (the home, the workspace, the folders that hold projects).
 * The settings file Hoprig handed to the session lies next to the run records (launch.mjs: hookSettingsDir).
 */
// The folder a session was started in, from its run record (null when there is none or it names none).
function startedIn(file) {
  try {
    const r = file ? readRun(file) : null;
    return r && typeof r.cwd === 'string' && r.cwd ? r.cwd : null;
  } catch {
    return null;
  }
}

export function sessionFacts(ev, env = process.env) {
  const file = env.HOPRIG_RUN_FILE;
  const allBase = () => {
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0) return false;
    const cfg = hoprigSettings();
    return cfg.allowBypass === true && Number.isFinite(cfg.allowEverythingAt);
  };
  const handed = file ? path.join(path.dirname(path.dirname(file)), 'hook-settings', path.basename(file)) : null;
  return {
    // The session's extra folders (workspace/needs.mjs: a need, --with, "Also open"), from the settings Hoprig handed it.
    extras: () => extraDirs(handed),
    rules: () => askRules({
      project: env.CLAUDE_PROJECT_DIR || (ev && typeof ev.cwd === 'string' ? ev.cwd : null),
      configDir: env.CLAUDE_CONFIG_DIR || null,
      extra: file ? path.join(path.dirname(path.dirname(file)), 'hook-settings', path.basename(file)) : null,
    }),
    // "Allow everything" (bypassgate.mjs ALL), for this event: the launcher put HOPRIG_ALLOW_EVERYTHING=1 into this
    // process's environment from the dashboard's launch file (a command of the session cannot set it on its coding
    // tool), the config now has Bypass allowed and the acknowledgement made, and this is no root (Claude Code refuses
    // bypass there). Inline, so the hook stays small; test/hook-allowall.test.mjs holds it equal to allAllowed.
    allOn: () => env.HOPRIG_ALLOW_EVERYTHING === '1' && allBase(),
    // The floor's pre-check (PreToolUse): the same, or the mark the dashboard wrote beside this session's handed settings
    // while its chat is in the mode (a chat's mode changes while it runs, so no variable can carry it). Never Tia's.
    floorOn: () => {
      if (!allBase() || !file || sessionByTia(file)) return false;
      if (env.HOPRIG_ALLOW_EVERYTHING === '1') return true;
      try {
        return fs.existsSync(path.join(path.dirname(path.dirname(file)), 'hook-settings', `${path.basename(file)}.all`));
      } catch {
        return false;
      }
    },
    // A session Tia started (her mark, written by the dashboard): her level holds in whatever mode.
    hers: () => !file || sessionByTia(file),
    places: () => {
      const cfg = hoprigSettings();
      const workspace = workspaceDir(env, cfg);
      const home = os.homedir();
      // `own`: the folder the session was started in (the coding tool names it for every hook; else the run record's).
      // The event's cwd is where the shell stands NOW, which may be another folder the session was given.
      const own = (typeof env.CLAUDE_PROJECT_DIR === 'string' && env.CLAUDE_PROJECT_DIR) || startedIn(file) || null;
      return { home, workspace, projects: projectFolders({ workspace, home, chosen: cfg.projectsDir }), hoprig: [configDir(), stateDir(), path.dirname(path.dirname(hookFile()))], own, cwd: ev && typeof ev.cwd === 'string' ? ev.cwd : null, relative: true };
    },
  };
}

// Can the hook hold this session's acts? Only when the settings Hoprig handed it at its start carry the wall's
// PreToolUse hold (launch.mjs hookSettings). A session started before the hold existed, or on a coding tool with no
// such hook, cannot: Hands-off must not answer its questions either (handsOffFor hasHold). The handed settings live
// beside the run records. Read here, not imported from server/handsoff.mjs, so the hook stays small.
function sessionCanHold(file) {
  try {
    const handed = path.join(path.dirname(path.dirname(file)), 'hook-settings', path.basename(file));
    return settingsHoldWall(JSON.parse(fs.readFileSync(handed, 'utf8')));
  } catch {
    return false;
  }
}

// Did the dashboard start this session as Tia's? Read from the mark it wrote beside the handed hook settings at the
// start — a sibling of them in the state folder, which the wall protects — never from the run record, which a command
// of the session can write ($HOPRIG_RUN_FILE). Marking a session hers only ADDS the owner's card (sessionAdminHold),
// so it could never lift a hold; the mark is still the dashboard's alone, so a session cannot even pretend to be his.
function sessionByTia(file) {
  try {
    const mark = path.join(path.dirname(path.dirname(file)), 'hook-settings', `${path.basename(file)}.tia`);
    return JSON.parse(fs.readFileSync(mark, 'utf8')).byTia === true;
  } catch {
    return false;
  }
}

/** The additional directories of the settings file Hoprig handed the session; a file that cannot be read: none. */
export function extraDirs(file) {
  if (!file) return [];
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'))?.permissions?.additionalDirectories;
    return Array.isArray(d) ? d.filter((x) => typeof x === 'string' && path.isAbsolute(x)) : [];
  } catch {
    return [];
  }
}

// Is `cwd` an extra folder, inside one, or around one (by text and by real place; one case where the disk folds it)?
function inExtra(cwd, extras) {
  if (!extras.length) return false;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return true; // not known where it runs: never answered
  const fold = process.platform === 'darwin' || process.platform === 'win32' ? (x) => x.toLowerCase() : (x) => x;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const under = (a, b) => a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
  const here = [cwd, real(cwd)].map(fold);
  return extras.flatMap((x) => [x, real(x)]).map(fold).some((x) => here.some((h) => under(h, x) || under(x, h)));
}

// Hoprig's settings file, read without loading the rest of Hoprig ({} when there is none or it cannot be read).
function hoprigSettings() {
  return readHoprigSettings().cfg;
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
/**
 * "Lead model": a helper's model and effort are its kind's (src/models/kinds.json, given at the start with --agents),
 * never the lead's choice. In a Lead session (launch.mjs leadHook) every call of Claude Code's agent tool comes here
 * first; one that names a model or an effort is answered with the same call without them, so the helper's own
 * definition decides. No permission decision is given: what asks still asks. → the answer, or null (nothing to change).
 */
export const LEAD_TOOLS = new Set(['Agent', 'Task']);
export function leadAnswer(ev) {
  if (!ev || typeof ev !== 'object' || ev.hook_event_name !== 'PreToolUse' || !LEAD_TOOLS.has(ev.tool_name)) return null;
  const input = ev.tool_input;
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('model' in input || 'effort' in input)) return null;
  const { model, effort, ...rest } = input;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: rest } };
}

export function hookAnswer(ev, facts = sessionFacts(ev), wall = wallHeld) {
  if (!ev || typeof ev !== 'object' || ev.hook_event_name !== 'PermissionRequest' || ev.permission_mode !== BYPASS) return null;
  if (facts.allOn && facts.allOn()) {
    const all = allAnswer(ev, facts);
    if (all) return all;
  }
  // Never for an act in or around an extra folder: it is read-only for this session, and only its owner answers there.
  if (inExtra(ev.cwd, facts.extras ? facts.extras() : [])) return null;
  const places = facts.places();
  if (!bypassAllows({ mode: ev.permission_mode, tool: ev.tool_name, input: ev.tool_input, rules: facts.rules(), places })) return null;
  // Fail closed: the PreToolUse "ask" and this PermissionRequest "allow" are decided independently, so the one rule
  // that allows here re-checks the wall and never allows what the wall holds — whatever its kind. Without this, a
  // kind that ever overlapped the bypass allow-set (a new kind, or a places mismatch between the two paths) would run
  // with no key pressed, the failure the reviewer saw before. Re-reading the wall needs no record, so it cannot fail open.
  if (wall({ tool: ev.tool_name, input: ev.tool_input, cwd: typeof ev.cwd === 'string' ? ev.cwd : null, places })) return null;
  return ALLOW;
}


/**
 * The answer and the record for an event that can be answered (PreToolUse, PermissionRequest), after hookrecord.mjs
 * hookMain read it from stdin. Prints the hook's answer where it has one (hookAnswer, the wall's hold, the Lead's
 * helper rule, Hands-off), on one line, then updates the run file `file`. Otherwise it stays silent, and it never
 * fails: any other output would land in the conversation.
 */
export function answerEvent(file, ev) {
  let answer = null;
  let hands = null;
  let held = null; // what the wall held, as the run record keeps it (askcard.mjs heldRecord)
  let quiet = false; // "Allow everything" let a call through that the wall would have held: only a line says so
  try {
    // The answer does not wait on the record: a run file that could not be written must not leave a question open.
    answer = hookAnswer(ev);
    if (!answer && ev.hook_event_name === 'PreToolUse') {
      // The wall holds a command that is the owner's alone (preToolHold): "ask", so the tool draws his card. The
      // config is read with its failure flag, and whether this session carries the hold, so the wall holds on even if
      // its settings file has gone (it is not lost with a file the session might take away).
      const { cfg, readFailed } = readHoprigSettings();
      const facts = sessionFacts(ev);
      const hold = preToolHold(ev, readRun(file), { cfg, cfgReadFailed: readFailed, handed: sessionCanHold(file), byTia: sessionByTia(file), places: () => facts.places(), ...handsOffKeys(file) });
      // In "Allow everything" (his own choice for this session) nothing of the wall is held but the removal of the whole
      // home, workspace, projects folder or disk; what it would have held runs, with one quiet line (allPre).
      const all = allPre(ev, facts, hold);
      if (all && all.output) answer = all.output;
      else if (all && all.note) quiet = true;
      else if (!all && hold) {
        answer = hold.output;
        held = heldRecord(hold.held, ev.tool_name);
      }
    }
    // A Lead session's helper call: its model and effort are its kind's (leadAnswer); the wall comes first.
    if (!answer) answer = leadAnswer(ev);
    if (!answer && ev.hook_event_name === 'PermissionRequest') {
      const version = hoprigVersion();
      const keys = handsOffKeys(file);
      hands = handsOffFor(ev, readRun(file), { cfg: hoprigSettings(), version, ...keys, hasHold: sessionCanHold(file) });
      // The owner's stop is read again right before the answer goes: none starts after his press.
      if (hands && hands.output && !stillOn(file, version, keys)) hands = null;
      if (hands && hands.output) answer = hands.output;
    }
    if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`);
  } catch {
    /* an event of a shape we do not know: no answer, Claude Code asks as usual */
  }
  try {
    const run = applyHook(file, ev, Date.now(), quiet ? ALLOW_ALL : answer, hands, held, null, quiet || answer === ALLOW_ALL ? 'all' : null);
    if (hands && hands.output) handsOffActivity(run, hands.line);
  } catch {
    /* never disturb the session */
  }
}

/** One line in Activity for an answer Hands-off gave (Work → Activity, automation "handsoff"). */
export function handsOffActivity(run, line, file = path.join(stateDir(), 'automation.log')) {
  const what = line.kind === 'plan' ? 'approved the plan' : `answered "${line.question}" with "${line.text}"`;
  createActivityLog(file).add({ automation: 'handsoff', session: (run && (run.termName || run.cwd)) || '', did: `${what} for you, ${BECAUSE[line.because] || ''}`.trim() });
}
