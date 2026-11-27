// The dashboard's model: sessions of the backend joined with the launcher's run records, plus the actions on
// them (start, send, switch profile). The HTTP layer validates input and calls these.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { bypassInArgs, gateCarry, ROOT_BYPASS_LINE, runsAsRoot } from '../bypassgate.mjs';
import { dedupeFlags, moveArgs } from '../launch.mjs';
import { binFile, runsDir, stateDir, tilde } from '../paths.mjs';
import { isMarkedAll } from '../allmark.mjs';
import { allAllowed } from '../bypassgate.mjs';
import { isMarkedHers } from '../hermark.mjs';
import { saveConfig as saveConfigFile, sessionArgs } from '../config.mjs';
import { readRun } from '../runfile.mjs';
import { dropMark, newMark, sweepMarks } from './marks.mjs';
import { dropStartFailure, keepReason, noReasonWords, noteOfTerminal, reasonFrom, startFailures, sweepStartFailures } from '../startfail.mjs';
import { RUN_ID_RE, carryOf, dropLaunch } from '../launchfile.mjs';
import { assertFolder, startCommand } from './startline.mjs';
import { atPrompt } from './backends/front.mjs';
import { ENTER_PAUSE_MS, keyToTool, sendToTool } from './typing.mjs';
import { assertServes, publicProfile, readProfile } from '../profiles.mjs';
import { listRuns } from '../runs.mjs';
import { handsOffOffered, hoprigVersion, projectEntry, sessionEntry, switchState } from '../handsoff.mjs';
import { heldCard, noticeOnScreen } from '../askcard.mjs';
import { sessionHasHold } from './handsoff.mjs';
import { noteMove } from '../movelog.mjs';
import { codexScreenQuestion } from '../codetools/codex.mjs';
import { codexHas } from '../codetools/stores.mjs';
import { hasConversation, isSessionId, sessionsIn } from '../sessions.mjs';
import { readTitles, sessionName } from '../titles.mjs';
import { isOwnFolder } from './folders.mjs';
import { detectLimit } from './limits.mjs';
import { alwaysOption } from './prompts.mjs';
import { IDLE_MS, interrupted, screenLook, shownStatus } from './screen.mjs';
import { descendsFrom, parentLookup, procParent } from './platform.mjs';
import { safeSessionName, uniqueName } from './validate.mjs';

/**
 * The command that starts Claude (the contract with the launcher, src/launch.mjs): the launcher, then
 *   new        [profile]
 *   continue   [profile, -c]                    newest session of the folder
 *   resume     [profile, --resume, id]
 *   move       [profile, ...moveArgs(...)]      the run's own arguments, adjusted for the target profile; they end
 *                                               with --resume <id>, or with --session-id <id> for a session nobody
 *                                               typed into yet (`fresh`: it has no conversation to resume)
 * A first message (`prompt`, new/continue/resume only) goes last, after "--": Claude Code then takes it as the
 * prompt even when it starts with "-" (checked on 2.1.325), and the launcher passes it through unchanged. It goes
 * whole, tabs and line breaks too: none of these words is typed into a shell, they travel in a launch file
 * (Deck#command). It is not carried along when the session moves to another account (carryArgs keeps flags only). `flags` (new/continue/resume) are
 * Claude Code options chosen for this one session (New session → Options: permission mode, effort); they come after
 * the defaults the launcher adds, so they win, and they move with the session like any other flag.
 */
export const promptArgs = (prompt) => (prompt ? ['--', String(prompt)] : []);

export function launchArgv(launcher, { tool = 'claude', profile, mode = 'new', sessionId = null, carryArgs = [], prompt = null, flags = [], fresh = false }) {
  if (tool !== 'claude') return toolArgv(launcher, { tool, profile, mode, sessionId, carryArgs, prompt, flags, fresh });
  switch (mode) {
    case 'new':
      return [...launcher, profile.name, ...flags, ...promptArgs(prompt)];
    case 'continue':
      return [...launcher, profile.name, '-c', ...flags, ...promptArgs(prompt)];
    case 'resume':
      if (!sessionId) throw new Error('resume needs a session id');
      return [...launcher, profile.name, '--resume', sessionId, ...flags, ...promptArgs(prompt)];
    case 'move':
      if (!sessionId) throw new Error('moving needs a session id');
      return [...launcher, profile.name, ...moveArgs(profile, carryArgs, sessionId, { fresh })];
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

/**
 * The same for Codex and OpenCode: the launcher, then the tool's word, then the provider, then the launcher's own
 * flags for that tool (src/codetools/terminal.mjs: -c, --resume <id>, --permission-mode, --effort, --model, -- prompt).
 * A move keeps the run's carried flags and resumes the conversation; one nobody typed into yet (`fresh`) has nothing
 * to resume and starts new.
 */
function toolArgv(launcher, { tool, profile, mode, sessionId, carryArgs, prompt, flags, fresh }) {
  const head = [...launcher, tool, profile.name];
  switch (mode) {
    case 'new':
      return [...head, ...flags, ...promptArgs(prompt)];
    case 'continue':
      return [...head, '-c', ...flags, ...promptArgs(prompt)];
    case 'resume':
      if (!sessionId) throw new Error('resume needs a session id');
      return [...head, '--resume', sessionId, ...flags, ...promptArgs(prompt)];
    case 'move':
      if (!sessionId) throw new Error('moving needs a session id');
      return [...head, ...carryArgs, ...(fresh ? [] : ['--resume', sessionId])];
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

/**
 * Which run belongs to which terminal. With several candidates the newest wins. Returns Map(terminal id → run).
 *   pty backend   the run carries the terminal's own id (termId, from $HOPRIG_TERM_ID). Those ids ("pty-…")
 *                 are random per terminal and never reused, so the id alone is proof.
 *   tmux backend  the run names its tmux pane ("%3"), but pane ids are per tmux server and get reused, so the
 *                 run's launcher must also be a process inside that terminal.
 */
const isPtyId = (id) => typeof id === 'string' && id.startsWith('pty-');

const lineKey = (t) => `${t.id}@${Number(t.created) || ''}`;
const lineReadyFile = () => path.join(stateDir(), 'line-ready.json');
function readLineReady() {
  try {
    const ids = JSON.parse(fs.readFileSync(lineReadyFile(), 'utf8'));
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string').slice(-200) : [];
  } catch {
    return []; // none marked yet
  }
}
function writeLineReady(ids, file = lineReadyFile()) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(ids), { mode: 0o600 });
}
// The same kind of list, kept the same way (a tmux session outlives the dashboard): the terminals the Deck made itself
// (made.json), and those "Continue here" left as a plain shell (shell-left.json). Keyed by lineKey, so a later
// terminal that gets a reused tmux pane id is not one of them.
const madeFile = () => path.join(stateDir(), 'made.json');
const shellLeftFile = () => path.join(stateDir(), 'shell-left.json');
function readKeys(file) {
  try {
    const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string').slice(-200) : [];
  } catch {
    return []; // none yet
  }
}

export function matchRuns(terms, runs, parentOf = procParent) {
  const byId = new Map();
  for (const t of terms) {
    const mine = runs
      .filter((r) => r.status !== 'ended')
      .filter((r) => (isPtyId(t.id) && r.termId === t.id) || (r.tmuxPane && r.tmuxPane === t.id && descendsFrom(r.pid, t.pid, parentOf)))
      .sort((a, b) => b.startedAt - a.startedAt);
    if (mine.length) byId.set(t.id, mine[0]);
  }
  return byId;
}

/** Runs with the process lookup their matching needs: only tmux runs check ancestry (one ps call off Linux). */
async function runsAndParents() {
  const runs = listRuns();
  return { runs, parentOf: runs.some((r) => r.tmuxPane) ? await parentLookup() : procParent };
}

/** A queue per key: serial(key, fn) runs `fn` after every earlier step under the same key, one at a time. */
export function queue() {
  const lines = new Map(); // key → the step in flight
  return (key, fn) => {
    const p = (lines.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    lines.set(key, p);
    p.catch(() => {}).finally(() => lines.get(key) === p && lines.delete(key));
    return p;
  };
}

// A terminal session's name is its conversation's (titles.mjs: read by file and mtime, only what was added since).
function titleOf(cwd, id, files = null) {
  if (!id) return '';
  const file = files && files.has(id) ? files.get(id) : (sessionsIn(cwd).find((x) => x.id === id) || {}).file;
  return sessionName(file || null, id).slice(0, 120);
}

// Two looks at a screen further apart than this are not "idle all the time between them" (the watcher looks every
// few seconds while a Claude session runs).
const IDLE_GAP_MS = 20_000;

// "Live status: basic": a screen that changed this recently is a tool at work.
const BASIC_BUSY_MS = 4000;

// One state of a run record, and one question of it: what a note about its screen holds for (#shown, noteRefused).
const runKey = (run) => `${run.runId}|${run.status}|${run.statusAt}`;
const askKey = (run) => `${runKey(run)}|${run.askAt || 0}`;

// What a terminal session's coding tool can be asking (the run record's askType, src/asking.mjs).
const ASK_TYPES = ['permission', 'question', 'plan'];

// A start whose shell waits at its prompt (backends/front.mjs atPrompt) with no record written for this long, look
// after look, was stopped before its launcher ran or wrote its record (a Ctrl+C): see #stopped.
// A shell still in its start files runs a program of theirs or its own commands, and reads the line the moment they
// are done, so a start that goes on is never this long at its prompt with its file unread.
export const STOP_MS = 3000;

// The terminal that stands for a session: the one with a Claude run in it, else the active one.
const pick = (terms, byId) => terms.find((t) => byId.has(t.id)) || terms.find((t) => t.active) || terms[0];

export class Deck {
  /**
   * @param {object} o
   * @param {object} o.backend          session backend (./backends)
   * @param {() => object} o.config     returns the current config (loadConfig)
   * @param {() => object[]} o.profiles returns the full profiles (server side only)
   */
  constructor({ backend, config, profiles, now = Date.now, saveConfig = saveConfigFile, root = runsAsRoot() }) {
    // `root`: Hoprig runs as root here (tests hand it in). Claude Code refuses bypass permissions mode for root, so no
    // start of it in that mode goes ahead (#refuseAsRoot).
    Object.assign(this, { backend, config, profiles, now, saveConfig, root: root === true });
    this.version = hoprigVersion(); // a Hands-off switch turned on under another version reads as off
    this.idle = new Map(); // session name → { key, since, last }: how long its screen has looked idle (see #shown)
    this.shown = new Map(); // session name → { key, status, at }: a card that differs from its run record, and since when
    this.refused = new Map(); // session name → the key of the run state whose question the owner refused from the page
    this.launches = new Map(); // `${tool}:${conversation}` → { name, at, mark, launch }: see noteLaunch
    this.stopped = new Map(); // session name → the launch file of its start that was stopped before its line was read
    // The conversation's own queue (handoff.mjs claim, move): one start, take-over or move at a time.
    this.serial = queue();
    this.movedFrom = new Map(); // terminal id → the run record it was last moved away from: a move of that record is late
    this.handed = new Map(); // run id a move chose for its new record → when (#handOver): its switch entry waits for it
    this.forwards = new Map(); // old run id → { to, at }: a move was made while the old record was still there (#handOver)
    // Terminal ids of Health's line-ready sessions (src/machines/healthline.mjs): a line stands typed there for the
    // owner to press Enter on. Nobody but his own page and keys types into them (./lineready.mjs).
    // Kept in a file too: a tmux session outlives the dashboard, and its mark must outlive it as well.
    this.lineReady = new Set(readLineReady());
    this.made = new Set(readKeys(madeFile())); // see #markMade
    this.shellLeft = new Set(readKeys(shellLeftFile())); // see markShellLeft
    sweepMarks();
    sweepStartFailures();
    this.#clearStaleMoving();
  }

  /**
   * At start, drop every handsOff.moving mark. A mark silences the moving session (handsoff.mjs movingAway) and is
   * cleared by the move's own end; `handed` lives in memory, so no move is in flight across a restart. A mark left by
   * a dashboard that died mid-move (before the respawn) would otherwise silence a session that never moved, for good.
   */
  #clearStaleMoving() {
    try {
      const cfg = this.config();
      const moving = cfg && cfg.handsOff && cfg.handsOff.moving;
      if (!moving || !Object.keys(moving).length) return;
      const next = { ...cfg.handsOff };
      delete next.moving;
      this.saveConfig({ handsOff: next });
    } catch {
      /* best effort at start: the hook reads the switch itself, a stray mark only affects the moving session */
    }
  }

  /**
   * Terminal `name` was just started or restarted (at `at`) on conversation `id`, with the start's `mark` (marks.mjs).
   * Its launcher names the conversation in its run record (runs.mjs: conversation) the moment it starts; this note
   * covers only the moment before, while the terminal holds no record written since and has not come back to its own
   * shell (handoff.mjs terminalOf reads it): a restart in place (a move) ends the old launcher and its record before
   * the new one has written its own.
   */
  noteLaunch(name, id, tool = 'claude', at = Date.now(), mark = null, launch = null) {
    if (!id || !name) return void dropMark(mark);
    const key = `${tool}:${id}`;
    const was = this.launches.get(key);
    if (was && was.mark !== mark) dropMark(was.mark);
    this.launches.delete(key);
    this.launches.set(key, { name, at, mark, launch });
    if (this.stopped.has(name)) dropLaunch(this.stopped.get(name)); // its shell was restarted: that line is gone
    this.stopped.delete(name);
    if (this.launches.size > 200) {
      const [oldest, n] = this.launches.entries().next().value;
      this.launches.delete(oldest);
      dropMark(n.mark);
    }
  }

  /** The terminal of `note` is back at its own shell: its launcher ended (whether it wrote a record or not) or never ran. */
  launchEnded(note) {
    return !!(note && note.mark) && (!!note.stopped || !fs.existsSync(note.mark));
  }

  /**
   * Whether the start of `note` was stopped by a Ctrl+C before its launcher wrote its record. The line ends with the
   * mark's removal (backends/shell.mjs shellLine), and the mark stays in two ways: a Ctrl+C while the shell still reads
   * its own start files throws the whole typed line away (the launch file stays unread), and one that ends the launcher
   * in its first moment makes the shell drop the rest of the line. Seen as: the terminal's shell `t` waits at its prompt
   * (atPrompt: no launcher runs under it) and no record was written since, on every look over at least STOP_MS. An
   * unread launch file stays while its terminal lives (it goes with it, or with the terminal's next start).
   */
  #stopped(note, t, now) {
    if (!note.launch || !t || !atPrompt(t.pid)) return void (note.front = 0);
    note.front ||= now;
    return now - note.front >= STOP_MS;
  }

  /**
   * Every look at the sessions (the watcher's tick, a page) ends the notes whose terminal is gone, holds a record
   * written since or is back at its own shell, as terminalOf does: a launcher that has ended leaves no note behind.
   */
  #settleLaunches(notes, terms, runs, parentOf) {
    for (const [key, note] of notes) {
      if (this.launches.get(key) !== note) continue;
      const ts = terms.filter((t) => t.session === note.name);
      if (!ts.length || this.launchEnded(note) || matchRuns(ts, runs.filter((r) => r.startedAt >= note.at), parentOf).size) {
        this.launches.delete(key);
        dropMark(note.mark);
      } else if (this.#stopped(note, ts[0], Date.now())) {
        note.stopped = true; // a terminalOf holding this note sees it ended too (launchEnded)
        this.launches.delete(key);
        dropMark(note.mark);
        this.stopped.set(note.name, note.launch);
      }
    }
  }

  /** The note of conversation `id` (noteLaunch), or null. `drop`: it ends (its terminal is gone, or holds a newer record). */
  launchOf(id, tool = 'claude', { drop = false } = {}) {
    const key = `${tool}:${id}`;
    if (drop) {
      dropMark(this.launches.get(key)?.mark);
      this.launches.delete(key);
    }
    return this.launches.get(key) || null;
  }

  /**
   * The owner refused the question on session `name`'s screen from the page ("Do not allow": Esc). The turn is over
   * and no event tells (hook.mjs), so the record of `run` goes on saying "needs your OK": the next look that finds
   * the screen at an empty message box is believed at once, without the wait a mere look needs (#shown).
   */
  noteRefused(name, run) {
    if (run) this.refused.set(name, askKey(run));
  }

  /**
   * The run's status as the screen confirms it (screen.mjs: shownStatus), and since when. The run file is not
   * touched: only the hooks write it, and the next event there is the truth again.
   */
  #shown(name, run, screen, now) {
    const look = screenLook(screen);
    const key = runKey(run);
    if (this.refused.has(name) && this.refused.get(name) !== askKey(run)) this.refused.delete(name); // the record moved on
    let idleFor = 0;
    if (look === 'idle') {
      // Idle "for a while" means seen idle look after look: a gap between two looks proves nothing about it.
      const was = this.idle.get(name);
      const since = was && was.key === key && now - was.last <= IDLE_GAP_MS ? was.since : now;
      this.idle.set(name, { key, since, last: now });
      // A question the owner refused from the page, or with Esc in the terminal itself (Claude Code writes "Interrupted ·
      // What should Claude do instead?" right above the message box): the idle screen is the end of that turn, known at once.
      idleFor = this.refused.has(name) || interrupted(screen) ? IDLE_MS : now - since;
    } else this.idle.delete(name);
    const status = shownStatus(run, look, idleFor);
    const was = this.shown.get(name);
    if (status === run.status && !(was && was.key === key)) {
      this.shown.delete(name);
      return { status, statusAt: run.statusAt };
    }
    // The card says, or said, something else than this same run record says: its time is when the card changed.
    if (!was || was.key !== key || was.status !== status) this.shown.set(name, { key, status, at: now });
    return { status, statusAt: this.shown.get(name).at };
  }

  launcher() {
    const l = this.config().launcher;
    return Array.isArray(l) && l.length ? l : [process.execPath, binFile()];
  }

  /** One card per session, most recently changed first. */
  async list() {
    const notes = new Map(this.launches); // the notes written before this look: only these are judged by it
    const terms = await this.backend.list();
    const { runs, parentOf } = await runsAndParents();
    const byId = matchRuns(terms, runs, parentOf);
    this.#settleLaunches(notes, terms, runs, parentOf);
    const failed = this.#startFailures(terms, byId);
    // The terminal sessions' names (titleOf below): their conversations read in pieces first, only the ones listed.
    // Each conversation's file is looked up once per look (a folder of hundreds of conversations is listed once).
    const files = new Map();
    for (const r of byId.values()) {
      if (!r || (r.tool || 'claude') !== 'claude' || !r.sessionId || files.has(r.sessionId)) continue;
      files.set(r.sessionId, (sessionsIn(r.cwd).find((x) => x.id === r.sessionId) || {}).file || null);
    }
    await readTitles([...files.values()]);
    const profiles = new Map(this.profiles().map((p) => [p.name, p]));
    const groups = new Map();
    for (const t of terms) groups.set(t.session, [...(groups.get(t.session) || []), t]);
    const out = [];
    for (const [name, ts] of groups) {
      const t = pick(ts, byId);
      const run = byId.get(t.id) || null;
      const cwd = run ? run.cwd : t.cwd;
      const card = {
        name,
        panes: ts.length,
        cwd,
        short: tilde(cwd),
        attached: t.attached,
        created: t.created,
        // The terminal's own id, which a rename keeps: Tia's status card follows the session by it (web/tiacards.js).
        ...(t.sid ? { termId: String(t.sid).slice(0, 40) } : {}),
        activity: t.activity,
        kind: run ? 'claude' : 'shell', // every coding session; `tool` says which coding tool
        command: t.command,
      };
      if (run) card.tool = run.tool || 'claude';
      // The conversation its launcher named, until the tool reports its own (onecard.mjs keys the card by it).
      if (run && typeof run.conversation === 'string' && run.conversation) card.conversation = run.conversation;
      // Started on a conversation a moment ago, its launcher's record not written yet (noteLaunch): that one.
      if (!run) for (const [k, n] of this.launches) if (n.name === name) card.launching = { tool: k.slice(0, k.indexOf(':')), conversation: k.slice(k.indexOf(':') + 1) };
      // A plain shell "Continue here" left behind (markShellLeft): the page does not list it while it stays one. A
      // coding tool running there again makes it a terminal like any other.
      if (ts.some((x) => this.shellLeft.has(lineKey(x)))) {
        if (run) this.#dropKeys(this.shellLeft, shellLeftFile(), ts.map(lineKey));
        else card.shellLeft = true;
      }
      // Its start was stopped before the coding tool ran (#stopped): the page says so until the terminal starts again.
      if (!run && this.stopped.has(name)) card.startStopped = true;
      // The coding tool ended at its start and the terminal is back at its shell (../startfail.mjs): the card says so,
      // with what the tool printed last, and never reads as a quiet terminal.
      const fail = run ? null : failed.find((n) => noteOfTerminal(n, t));
      if (fail) await this.#failedCard(card, fail, t, profiles);
      // Its extra folders, by map name (launch.mjs: a need, --with, "Also open"), for its card and page.
      if (run && Array.isArray(run.extras) && run.extras.length) card.extras = run.extras.filter((x) => typeof x === 'string').slice(0, 10);
      if (isOwnFolder(cwd)) card.own = true; // Tia's working folder: shown on Home, not as a folder of the owner's
      if (run) {
        const p = profiles.get(run.profile);
        Object.assign(card, {
          profile: p ? publicProfile(p) : { name: run.profile, label: run.profile, kind: 'unknown' },
          status: run.status,
          statusAt: run.statusAt,
          sessionId: run.sessionId || null,
          canSwitch: !!run.sessionId,
          title: card.tool === 'claude' ? titleOf(run.cwd, run.sessionId, files) : String(run.title || '').slice(0, 120),
          limit: null,
        });
        // The session is named as Claude Code names its conversation (the terminal's own name until it has one).
        if (card.title) card.display = card.title;
        if (card.tool !== 'claude') {
          // Codex and OpenCode: the run record is kept from the tool's server (src/codetools/terminal.mjs). Without it
          // ("basic") only the screen's activity is known: busy while it changes, else waiting for a message. Their
          // screens are not read for a limit or a question: the wording that would mean one is not known yet.
          if (run.statusSource !== 'server') {
            card.liveStatus = 'basic';
            card.status = this.now() - (t.activity || 0) < BASIC_BUSY_MS ? 'working' : 'waiting';
            card.statusAt = t.activity || run.statusAt;
          }
          card.note = card.status === 'attention' ? String(run.note || '').slice(0, 300) : '';
          // Before Codex has made its thread its server tells nothing, but its screen may already ask the owner
          // something (whether to trust a new folder): that is "needs your OK", not "starting".
          if (card.tool === 'codex' && (run.status === 'starting' || card.liveStatus === 'basic')) {
            const ask = codexScreenQuestion(await this.backend.capture(t.id, 40).catch(() => ''));
            if (ask) Object.assign(card, { status: 'attention', note: ask });
          }
          out.push(card);
          continue;
        }
        let screen = '';
        try {
          screen = await this.backend.capture(t.id, 40);
          card.limit = detectLimit(screen);
        } catch {
          /* the terminal went away between list and capture */
        }
        // The hooks say what Claude does; the screen corrects the two moments they cannot see (screen.mjs).
        Object.assign(card, this.#shown(name, run, screen, this.now()));
        card.note = card.status === 'attention' ? String(run.note || '').slice(0, 300) : '';
        // Subagents or a workflow go on after the reply ended: Claude continues by itself when they finish.
        const background = Array.isArray(run.background) ? run.background.length : 0;
        if (card.status === 'working' && background) card.background = background;
        // A command the session started still runs in the background while it waits for the owner (hook.mjs
        // bgCommands): the status stays 'waiting' — he must still message it — and the card says so in one line.
        const bgCommands = Number.isInteger(run.bgCommands) ? run.bgCommands : 0;
        if (card.status === 'waiting' && bgCommands) card.bgCommands = bgCommands;
        // What Hoprig allowed by itself in bypass mode (hook.mjs), the newest last: the session page lists it.
        if (Array.isArray(run.allowed) && run.allowed.length) {
          card.allowed = run.allowed.slice(-5).map((a) => ({ at: Number(a.at) || 0, tool: String(a.tool || '').slice(0, 80), what: String(a.what || '').slice(0, 200), ...(typeof a.folder === 'string' && a.folder ? { folder: a.folder.slice(0, 200) } : {}), ...(a.by === 'all' ? { by: 'all' } : {}) }));
        }
        // A notice of Claude Code itself that no hook tells (trust this folder), read from the screen only with every
        // fixed part there (askcard.mjs): named as what it is; it is answered in the terminal, never from the page.
        const notice = card.status !== 'attention' ? noticeOnScreen(screen, { starting: card.status === 'starting' }) : null;
        // Its note is the tool's own question; where to answer is said once, by the card's answer hint.
        if (notice) Object.assign(card, { status: 'attention', askCard: notice, note: notice.notice.text.slice(0, 300) });
        // Hands-off (src/handsoff.mjs): its switch for this session, what it answered, and why it left a card to the
        // owner. Only where it is offered on this computer; otherwise the card carries nothing of it (whatever a stale
        // run record from when it was offered still holds) and the page shows nothing of it.
        const hoOffered = handsOffOffered(this.config());
        if (hoOffered) {
          const own = sessionEntry(this.config(), run.runId);
          const project = projectEntry(this.config(), run.cwd);
          const hands = switchState({ session: own, project, version: this.version, stopped: run.handsOffStop });
          // The wall holds by the switch alone, never the stop (hook.mjs preToolHold): while it holds, what is his
          // still waits for him even after a stop that only ended the answers. The bar says so (web/handsoff.js).
          const holding = switchState({ session: own, project, version: this.version }).on;
          // On, but started before Hands-off could hold its commands (no wall hold in its handed settings): the page
          // tells the owner its questions are answered while a push or a release is not held, and to start it again.
          const uncovered = hands.on && !sessionHasHold(run.runId);
          card.handsOff = { on: hands.on, stale: hands.stale, loop: hands.loop, ...(hands.stopped ? { stopped: hands.stopped } : {}), own: !!own, ...(holding ? { holding: true } : {}), ...(uncovered ? { uncovered: true } : {}) };
          if (Array.isArray(run.handsOffDone) && run.handsOffDone.length) card.handsOffDone = run.handsOffDone.slice(-5);
        }
        if (card.status === 'attention') {
          // The exact card of what waits (hook.mjs cardFor) is always shown; why Hands-off left it is shown only where
          // Hands-off is offered.
          if (run.askCard && typeof run.askCard === 'object') card.askCard = run.askCard;
          if (hoOffered && typeof run.handsWait === 'string') card.handsWait = run.handsWait;
          // An act the wall held (hook.mjs: the record's `held`): what it was, why it is his, what Yes and No do.
          if (hoOffered && run.held && typeof run.held === 'object') card.held = heldCard(run.held);
          // What is asked, in a chat card's words (ask.type): only a permission has "Allow" for an answer; a question
          // or a plan is answered in the terminal. `askAt` tells a second question from the one just answered. For a
          // permission also its command or file (`what`, which the page sends back with its answer) and how many
          // askers wait (`waiting`: with more than one the page offers no answer, the terminal shows its own queue).
          if (ASK_TYPES.includes(run.askType)) card.ask = { type: run.askType };
          // A question or a plan with more askers waiting: the card shows one of them, the terminal its own queue.
          const askers = Array.isArray(run.asks) ? run.asks.length : 0;
          if (card.ask && card.ask.type !== 'permission' && askers > 1) card.ask.waiting = askers;
          if (card.ask && card.ask.type === 'permission') {
            card.ask.what = String(run.askWhat || '').slice(0, 200);
            card.ask.waiting = Array.isArray(run.asks) ? run.asks.length : 0;
          }
          if (Number.isFinite(run.askAt)) card.askAt = run.askAt;
          // A permission: the "Yes, and don't ask again …" answer when Claude's question has one (prompts.mjs).
          // A held act is the owner's own, answered once only (the card says "Allow runs it this once"): never offer
          // "Allow, and don't ask again" beside it, which would write a lasting rule for his own act.
          card.always = (card.ask && card.ask.type !== 'permission') || card.held ? null : alwaysOption(screen);
        }
      }
      out.push(card);
    }
    for (const [k, file] of this.stopped) if (!groups.has(k)) dropLaunch(file); // it holds a first message: it goes with its terminal
    for (const m of [this.idle, this.shown, this.refused, this.stopped]) for (const k of m.keys()) if (!groups.has(k)) m.delete(k);
    for (const k of this.movedFrom.keys()) if (!terms.some((t) => t.id === k)) this.movedFrom.delete(k);
    return out.sort((a, b) => (b.statusAt || b.activity || 0) - (a.statusAt || a.activity || 0));
  }

  /**
   * The start-failure notes that still stand: a note goes once its terminal is gone or runs a record written since
   * (the session was started again there, or moved).
   */
  #startFailures(terms, byId) {
    const out = [];
    for (const n of startFailures()) {
      const t = terms.find((x) => noteOfTerminal(n, x));
      const again = t && byId.get(t.id);
      if (!t || (again && again.startedAt >= n.at)) dropStartFailure(n);
      else out.push(n);
    }
    return out;
  }

  /** Card `card` of terminal `t` as a start that failed (note `n`): status "failed", the reason from the screen. */
  async #failedCard(card, n, t, profiles) {
    // Read once and kept in the note: a browser that attaches later makes the pane taller (the words move up out of
    // a short capture) and the owner may clear the screen. 200 lines: the blank rows under the prompt count too.
    let text = typeof n.reason === 'string' && n.reason ? n.reason : '';
    if (!text) {
      text = reasonFrom(await this.backend.capture(t.id, 200).catch(() => ''));
      if (text) keepReason(n, text);
    }
    text ||= noReasonWords(n.tool, n.code);
    const p = n.profile ? profiles.get(n.profile) : null;
    Object.assign(card, {
      tool: n.tool || 'claude',
      status: 'failed',
      statusAt: n.at,
      note: text,
      failure: { at: n.at, error: 'ended at its start', text },
      startFailed: { code: n.code, tool: n.tool || 'claude' },
      ...(p ? { profile: publicProfile(p) } : {}),
    });
  }

  /** { term, run, taken } for one session, or null. */
  async find(name) {
    const terms = await this.backend.list();
    const ts = terms.filter((t) => t.session === name);
    if (!ts.length) return null;
    const { runs, parentOf } = await runsAndParents();
    const byId = matchRuns(ts, runs, parentOf);
    const term = pick(ts, byId);
    return { term, run: byId.get(term.id) || null, taken: [...new Set(terms.map((t) => t.session))] };
  }

  async #newName(base) {
    const taken = new Set((await this.backend.list()).map((t) => t.session));
    return uniqueName(safeSessionName(base), taken);
  }

  /** Start a coding tool (Claude Code unless `tool` says another) under `profile` (full profile object) in `dir`. Returns the session name. */
  // `hers`: the session is Tia's (her door asked for it, or it carries on one of hers): the launch file says so, and
  // the launcher marks it and gives it her git sign-in (launch.mjs). Only the dashboard decides it, never the request.
  async start({ tool = 'claude', dir, profile, mode = 'new', sessionId = null, prompt = null, flags = [], resetHandsOff = false, hers = false, all = false }) {
    const argv = launchArgv(this.launcher(), { tool, profile, mode, sessionId, prompt, flags });
    // A resumed conversation the dashboard cannot carry Hands-off for (a chat opened in a terminal) starts the new
    // run with its answers stopped (launchfile.mjs reset hand): it is the owner's until he turns it on.
    return this.create({ base: path.basename(dir), dir, argv, conversation: mode === 'resume' ? sessionId : null, tool, hand: resetHandsOff && handsOffOffered(this.config()) ? { reset: true } : null, hers, all });
  }

  /**
   * A new terminal named after `base` that runs the launcher's `argv` in `dir`. `conversation`: the one it starts the
   * coding tool on, noted for the moment before its launcher's record (noteLaunch). Returns the session name.
   */
  async create({ base, dir, argv, conversation = null, tool = 'claude', hand = null, hers = false, all = false }) {
    this.#refuseAsRoot(argv, tool);
    const at = Date.now(); // the clock of the launcher's record (startedAt)
    const mark = conversation ? newMark() : null;
    let name;
    let launch;
    try {
      ({ name, launch } = await this.terminal({ name: await this.#newName(base), dir, argv, mark, hand, hers, all }));
    } catch (e) {
      dropMark(mark);
      throw e;
    }
    if (conversation) this.noteLaunch(name, conversation, tool, at, mark, launch);
    return name;
  }

  /**
   * As root, a start of Claude Code that would run in bypass permissions mode does not go ahead: the tool refuses it
   * and would end at once. Every start meets here (a page, the API and Tia through it, a schedule, a restore, a
   * hand-off, a move), so nobody gets a session that cannot run. The mode is read as the launcher reads it: the session
   * defaults, then the config's arguments for every launch, then this start's own, the last one winning
   * (launch.mjs dedupeFlags); a first message after "--" is not read. The owner's default is left as he set it.
   */
  #refuseAsRoot(argv, tool = 'claude') {
    if (!this.root || tool !== 'claude' || !Array.isArray(argv)) return;
    const own = argv.slice(this.launcher().length + 1); // after the launcher and the provider's name
    const cut = own.indexOf('--');
    const cfg = this.config() || {};
    const every = Array.isArray(cfg.claudeArgs) ? cfg.claudeArgs.filter((a) => typeof a === 'string') : [];
    if (bypassInArgs(dedupeFlags([...sessionArgs(cfg), ...every, ...(cut < 0 ? own : own.slice(0, cut))]))) {
      // `details`: what the page gets beside the sentence (server.mjs errorBody), so it draws the button to Runs as root.
      throw Object.assign(new Error(ROOT_BYPASS_LINE), { status: 409, code: 'root-bypass', details: { code: 'root-bypass' } });
    }
  }

  /** What a terminal runs for `argv` in `dir` (./startline.mjs): a folder of one line, the launcher's words in a launch file. */
  #command(dir, argv, mark = null, hand = null, hers = false, all = false) {
    assertFolder(dir);
    return startCommand({ launcher: this.launcher(), dir, argv, mark, hand, hers, all, platform: this.backend.platform || process.platform });
  }

  /**
   * A new terminal `name` in `dir` running `argv` (null: a plain shell) through #command: every terminal the dashboard
   * starts with a command goes through here. Returns the backend's { name, id }.
   */
  async terminal({ name, dir, argv = null, mark = null, hand = null, hers = false, all = false }) {
    const cmd = this.#command(dir, argv, mark, hand, hers, all);
    let made;
    try {
      made = await this.backend.create({ name, dir, argv: cmd.argv, ...(mark ? { mark } : {}) });
    } catch (e) {
      dropLaunch(cmd.file);
      throw e;
    }
    await this.#markMade(made.name || name);
    return { ...made, launch: cmd.file };
  }

  /**
   * Stop what runs in terminal `id` and start `argv` there (#command), keeping its name and id. The line is built and
   * checked before anything is touched; the backend then ends the old programs (and `hold`, the pid that holds the
   * conversation, given longer) before the terminal starts anew and the line is typed. `hand`: a move's hand-over of
   * Hands-off's stops, into the launch file only (#handOver).
   */
  async respawn(id, dir, argv, { mark = null, hold = null, hand = null, hers = false, all = false } = {}) {
    const cmd = this.#command(dir, argv, mark, hand, hers, all);
    try {
      await this.backend.respawn(id, dir, cmd.argv, { mark, hold });
    } catch (e) {
      dropLaunch(cmd.file);
      throw e;
    }
    return cmd.file;
  }

  /** A terminal that runs the launcher with `words` (e.g. Codex's own sign-in), named after `base`. Returns its name. */
  async runLauncher(base, dir, words) {
    const { name } = await this.terminal({ name: await this.#newName(base), dir, argv: [...this.launcher(), ...words] });
    return name;
  }

  /** A plain shell, no Claude. */
  async shell(dir) {
    assertFolder(dir);
    const { name } = await this.backend.create({ name: await this.#newName('shell'), dir });
    return name;
  }

  /**
   * Type a message and submit it, as the owner does (the session page's message box): into whatever runs in the
   * terminal, as written. The pause before Enter lets the program finish taking the text in, so Enter is read as
   * "send" and not as part of a paste. Text from anyone else goes through sendToTool.
   */
  async send(termId, text, { enter = true } = {}) {
    await this.backend.sendText(termId, text.replace(/\r\n?/g, '\n'));
    if (enter) {
      await new Promise((r) => setTimeout(r, ENTER_PAUSE_MS));
      await this.backend.sendKey(termId, 'Enter');
    }
  }

  /**
   * Type a message for the coding tool of session `name` and submit it, for someone other than the owner's own keys
   * (the queue, the continue prompt, the assistant, another computer): only while the tool is in front, never a control
   * byte (./typing.mjs). 409 "not_in_front" when nothing was typed, "typed_not_sent" when the Enter did not follow.
   */
  async sendToTool(name, text, o) {
    await this.#notLineReady(name);
    return this.#inTurn(name, () => sendToTool(this, name, text, o));
  }

  /** One key for the coding tool of session `name`, for anyone but the owner: the same rule (./typing.mjs). */
  async keyToTool(name, key) {
    await this.#notLineReady(name);
    return this.#inTurn(name, () => keyToTool(this, name, key));
  }

  /**
   * Terminal `id` holds a line typed for the owner to run himself (Health's "Open a terminal with this line"). Kept
   * with the terminal's start time: tmux hands out its pane ids again after a restart, and a later session that gets
   * the same id is not marked. Marks of terminals that are gone are dropped here.
   */
  async markLineReady(id) {
    const terms = await this.backend.list();
    const t = terms.find((x) => String(x.id) === String(id));
    const live = new Set(terms.map(lineKey));
    this.lineReady = new Set([...this.lineReady].filter((k) => live.has(k)));
    this.lineReady.add(t ? lineKey(t) : `${id}@`);
    writeLineReady([...this.lineReady].slice(-200));
  }

  /** `keys` leave list `set` (kept in `file`), and every key of a terminal that is gone with them. */
  async #keep(set, file, add = [], drop = []) {
    const live = new Set((await this.backend.list()).map(lineKey));
    for (const k of [...set]) if (!live.has(k) || drop.includes(k)) set.delete(k);
    for (const k of add) set.add(k);
    writeLineReady([...set].slice(-200), file);
  }

  #dropKeys(set, file, keys) {
    if (!keys.some((k) => set.has(k))) return;
    for (const k of keys) set.delete(k);
    writeLineReady([...set].slice(-200), file);
  }

  /** The keys (lineKey) of session `name`'s terminals, as the backend lists them now. */
  async #keysOf(name) {
    return (await this.backend.list()).filter((t) => t.session === name).map(lineKey);
  }

  /**
   * Terminal session `name` was made by the Deck itself (terminal()): "Continue here" may end it (handoff.mjs take),
   * where one made outside the dashboard (adopted) keeps its shell.
   */
  async #markMade(name) {
    await this.#keep(this.made, madeFile(), await this.#keysOf(name)).catch(() => {});
  }

  /** Whether session `name` was made by the Deck (#markMade) and has one terminal only (one tmux pane). */
  async madeAlone(name) {
    const ts = (await this.backend.list()).filter((t) => t.session === name);
    return ts.length === 1 && this.made.has(lineKey(ts[0]));
  }

  /** Session `name` was left a plain shell by "Continue here": not listed while it stays one (list: shellLeft). */
  async markShellLeft(name) {
    await this.#keep(this.shellLeft, shellLeftFile(), await this.#keysOf(name));
  }

  /**
   * End terminal session `name`, its programs first (`hold`, the pid that holds the conversation, given its longer
   * time to save and end, as in a respawn). Backends without `hold` on kill get the plain kill.
   */
  async end(name, { hold = null } = {}) {
    await this.backend.kill(name, { hold });
  }

  /** Whether session `name` (any of its terminals) is one of those. */
  async isLineReady(name) {
    if (!this.lineReady.size) return false;
    return (await this.backend.list()).some((t) => t.session === name && this.lineReady.has(lineKey(t)));
  }

  // 409, nothing typed: the line there is his to run, so text or a key from anyone else never reaches it.
  async #notLineReady(name) {
    if (await this.isLineReady(name)) throw Object.assign(new Error(`Nothing was typed: session "${name}" holds a line for you to run yourself. Only you type there, in the terminal`), { status: 409, code: 'line_ready', details: { code: 'line_ready' } });
  }

  /**
   * `fn` in the conversation's own queue (serial: its moves, starts and take-overs): text for a session that is being
   * moved or taken over waits until that is done, and then goes to the coding tool in front, if one is (typing.mjs
   * looks again), never to the old one on its way out or the shell between the two.
   */
  async #inTurn(name, fn) {
    const run = (await this.find(name))?.run;
    return run && run.sessionId ? this.serial(`${run.tool || 'claude'}:${run.sessionId}`, fn) : fn();
  }

  /**
   * Continue the run's session under another profile, in the same terminal: stop what runs there and start the
   * launcher with --resume (in a fresh shell, except on Windows, where the pty backend starts it directly). Claude writes its transcript as it goes, so at most the turn in
   * flight is lost.
   */
  async move(term, run, profileName, { profile = null } = {}) {
    const target = profile || readProfile(profileName);
    if (!target) throw Object.assign(new Error('unknown provider'), { status: 400 });
    const tool = run.tool || 'claude';
    // A conversation stays in the coding tool it was started in: only a provider that serves that tool takes it.
    if (!profile) assertServes(target, tool);
    const argv = this.moveArgv(target, run);
    // A session of Tia's stays hers when it moves (a switch of provider, a restart in place, Auto mode's move): read
    // from the mark the dashboard wrote for the run it moves from (hermark.mjs), never from what the record says. The
    // owner's own press on switch or restart does not make it his: it is hers until it ends.
    const hers = isMarkedHers(path.join(runsDir(), `${path.basename(String(run.runId || ''))}.json`));
    // Allow everything goes on in a move only while the switch and the acknowledgement still allow it, and never for hers.
    const all = !hers && isMarkedAll(path.join(runsDir(), `${path.basename(String(run.runId || ''))}.json`)) && allAllowed(this.config() || {}, this.root);
    // One move at a time, in the conversation's own queue (with its starts and take-overs), on every kind of terminal.
    // `run` is the record the caller saw (two pages, a page and the watcher, however late each one asks): once the
    // terminal was moved away from it, a move of it again is late (409), and starts no second launcher. A move of the
    // record the new launcher wrote is a move again.
    return this.serial(`${tool}:${run.sessionId}`, async () => {
      if (run.runId && this.movedFrom.get(term.id) === run.runId) throw Object.assign(new Error('This session has just moved to another provider. Look at it again before moving it.'), { status: 409 });
      this.movedFrom.set(term.id, run.runId || null);
      const mark = newMark();
      this.noteLaunch(term.session, run.sessionId, tool, Date.now(), mark);
      let over = null;
      try {
        over = this.#handOver(run);
        // The old launcher holds the conversation until its coding tool has saved and ended: the new one would refuse it.
        const launch = await this.respawn(term.id, run.cwd, argv, { mark, hold: Number.isInteger(run.pid) ? run.pid : null, hand: over && over.hand, hers, all });
        const note = this.launchOf(run.sessionId, tool);
        if (note && note.mark === mark) note.launch = launch;
        // Every move, whoever asked for it: the Operator's limit rule never moves a session back within the hour.
        noteMove({ session: term.session, from: run.profile || null, to: target.name });
      } catch (e) {
        if (over) over.undo();
        if (this.launchOf(run.sessionId, tool)?.mark === mark) this.launchOf(run.sessionId, tool, { drop: true });
        if (this.movedFrom.get(term.id) === (run.runId || null)) this.movedFrom.delete(term.id); // not moved: it may be asked again
        throw e;
      }
      if (over) over.done();
    });
  }

  /**
   * Was `runId` chosen by a move for a record its launcher has not written yet (within the ten minutes a launch file
   * lives)? Then the owner's switch entry under it is kept, though no record of that id is there yet.
   */
  // A move was started for terminal `id` (movedFrom is set for the length of the move and until the terminal is
  // gone): the session's switch route waits for the new run rather than answer 404 while the old record is gone and
  // the new one is not yet written.
  movingTerm(id) {
    return this.movedFrom.has(id);
  }

  handedOver(runId) {
    const at = this.handed.get(runId);
    if (at === undefined) return false;
    if (Date.now() - at < 10 * 60_000) return true;
    this.handed.delete(runId);
    return false;
  }

  /**
   * The run id a finished move handed `runId`'s session to, while `runId`'s own record is still there (its coding tool
   * outlived the move), else null. The page still finds the old record then, so a press on the session's switch is
   * written under the new id too (server/handsoff.mjs): the move's own carry has already run and would not see it.
   */
  forwardOf(runId) {
    const f = this.forwards.get(runId);
    if (!f) return null;
    if (Date.now() - f.at < 10 * 60_000 && fs.existsSync(path.join(runsDir(), `${path.basename(runId)}.json`))) return f.to;
    this.forwards.delete(runId);
    return null;
  }

  /**
   * What a move carries of Hands-off, where it is offered (src/handsoff.mjs): the session's loop or hour stop, its count
   * and the hour's answers, read from the ONE record of `run` (never a look through every record), and the owner's own
   * switch for the session, kept in the config under the run id. The new launcher writes a new record and cannot read
   * the old one (it starts only once the old launcher has ended and removed it), so the dashboard hands them over: it
   * chooses the new run's id, puts the owner's entry under it exactly as it was (never made, never turned on) and the
   * stops into the launch file (launchfile.mjs HAND). Before the count is read the old run is marked as moving
   * (handsoff.mjs movingAway): its coding tool, which still runs for a few seconds, gets no more answers, while the wall
   * goes on holding its acts (its own switch is not touched). → { hand, undo, done }, or null when there is nothing to
   * carry (the launch file and the config stay exactly as they were).
   *   undo  the move failed: the mark and the new entry go, the old entry is as it was
   *   done  the move was made (the old programs have ended): the old id's entry and the mark go
   */
  #handOver(run) {
    const cfg = this.config();
    if (!handsOffOffered(cfg) || (run.tool || 'claude') !== 'claude') return null;
    const from = typeof run.runId === 'string' && RUN_ID_RE.test(run.runId) ? run.runId : null;
    if (!from || !isSessionId(run.sessionId)) return null;
    const file = path.join(runsDir(), `${from}.json`);
    const own = sessionEntry(cfg, from);
    if (!own && !carryOf(readRun(file))) return null; // a session whose owner never turned its switch: nothing new
    const part = (c, k) => (c && c.handsOff && c.handsOff[k] && typeof c.handsOff[k] === 'object' ? c.handsOff[k] : {});
    const had = own ? part(cfg, 'sessions')[from] : undefined;
    const runId = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const write = (change) => {
      const c = this.config();
      const sessions = { ...part(c, 'sessions') };
      const moving = { ...part(c, 'moving') };
      change(sessions, moving);
      // A key that was not there and is empty again is left out, so a failed move leaves the config as it was.
      const next = { ...(c.handsOff || {}), sessions, moving };
      for (const k of ['sessions', 'moving']) if (!Object.keys(next[k]).length && !(c.handsOff && k in c.handsOff)) delete next[k];
      if (!Object.keys(moving).length) delete next.moving;
      this.saveConfig({ handsOff: next });
    };
    this.handed.set(runId, Date.now());
    write((s, m) => {
      m[from] = Date.now();
      if (own) s[runId] = had;
    });
    const carry = carryOf(readRun(file)) || {}; // read after the mark: no answer of the old tool starts after this
    return {
      hand: { from, runId, conversation: run.sessionId, carry },
      undo: () => {
        this.handed.delete(runId);
        write((s, m) => {
          delete m[from];
          delete s[runId];
        });
      },
      done: () => {
        // The old launcher's record is still there (its coding tool outlives the move): a later press on the page
        // finds that record, so it is forwarded to the new run id (forwardOf).
        if (fs.existsSync(file)) this.forwards.set(from, { to: runId, at: Date.now() });
        write((s, m) => {
          // A press on the session's switch during the move: before the new record it lands on the OLD run id (the page
          // still found the old record); in the window and after, it lands on the NEW run id (the page found the new
          // record through the switch route's wait, server/handsoff.mjs). The new run's entry must be whatever he last
          // pressed, else the one the move carried. The OLD id's entry merely vanishing (its record ended, so the
          // switch route dropped it) is NOT a press — only a value that differs from the carried one is a choice.
          // The owner's choice is his LAST press during the move — the entry written latest, on whichever id it
          // landed (before the new record a press lands on the old id, in the window and after on the new id). Each
          // entry carries `at`, when the switch route wrote it (server/handsoff.mjs); the carried value's `at` is from
          // before the move. A press during the move is an entry whose `at` is newer than the carried one, and between
          // two presses the newer `at` wins. This is the write time the route keeps, read directly — not a guess from
          // whether the value differs from what the move carried.
          const at = (v) => (v && typeof v === 'object' && Number.isFinite(Number(v.at)) ? Number(v.at) : -1);
          const base = at(had);
          const pressed = at(s[runId]) > base || at(s[from]) > base;
          const intent = pressed ? (at(s[runId]) >= at(s[from]) ? s[runId] : s[from]) : had;
          if (intent === undefined) delete s[runId];
          else s[runId] = intent;
          // Clear the old id's entry and the moving mark only once the old launcher's record is gone (its coding tool
          // has ended). While it may still run, keep both: a dying tool with the owner's Off must not start following
          // the project's On, and the mark keeps its questions unanswered. A mark whose record has gone is dropped by the
          // next press on a session's switch (server/handsoff.mjs) and at the Deck's start.
          if (!fs.existsSync(path.join(runsDir(), `${from}.json`))) {
            delete s[from];
            delete m[from];
          }
        });
      },
    };
  }


  /**
   * The command that carries `run`'s session on under `profile` (a full profile object, or "auto" as the server
   * builds it). A session nobody typed into yet has no conversation on disk: it starts there under the same id.
   */
  moveArgv(profile, run) {
    if (!run.sessionId) throw Object.assign(new Error('this session has no id yet; wait until it has started'), { status: 409 });
    const carry = gateCarry(Array.isArray(run.carryArgs) ? run.carryArgs.filter((a) => typeof a === 'string') : [], this.config(), this.root);
    const tool = run.tool || 'claude';
    const fresh = tool === 'claude' ? !hasConversation(run.cwd, run.sessionId) : tool === 'codex' ? !codexHas(run.sessionId) : false;
    const argv = launchArgv(this.launcher(), { tool, profile, mode: 'move', sessionId: run.sessionId, carryArgs: carry, fresh });
    this.#refuseAsRoot(argv, tool);
    return argv;
  }
}
