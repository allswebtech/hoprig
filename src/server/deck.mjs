// The dashboard's model: sessions of the backend joined with the launcher's run records, plus the actions on
// them (start, send, switch profile). The HTTP layer validates input and calls these.
import path from 'node:path';
import { moveArgs } from '../launch.mjs';
import { binFile, tilde } from '../paths.mjs';
import { assertServes, publicProfile, readProfile } from '../profiles.mjs';
import { listRuns } from '../runs.mjs';
import { codexScreenQuestion } from '../codetools/codex.mjs';
import { codexHas } from '../codetools/stores.mjs';
import { hasConversation, sessionTitle, sessionsIn } from '../sessions.mjs';
import { isOwnFolder } from './folders.mjs';
import { detectLimit } from './limits.mjs';
import { alwaysOption } from './prompts.mjs';
import { screenLook, shownStatus } from './screen.mjs';
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
 * prompt even when it starts with "-" (checked on 2.1.325), and the launcher passes it through unchanged. It is
 * one line: the tmux backend types the command into a shell, where a line break would end it. It is not carried
 * along when the session moves to another account (carryArgs keeps flags only). `flags` (new/continue/resume) are
 * Claude Code options chosen for this one session (New session → Options: permission mode, effort); they come after
 * the defaults the launcher adds, so they win, and they move with the session like any other flag.
 */
export const promptArgs = (prompt) => (prompt ? ['--', String(prompt).replace(/\s*[\r\n]+\s*/g, ' ').trim()] : []);

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

// sessionTitle reads a file; remember results by file and mtime so polling stays cheap.
const titleCache = new Map();
function titleOf(cwd, id) {
  if (!id) return '';
  const s = sessionsIn(cwd).find((x) => x.id === id);
  if (!s) return '';
  const key = `${s.file}|${s.mtimeMs}`;
  if (!titleCache.has(key)) {
    if (titleCache.size > 500) titleCache.clear();
    titleCache.set(key, sessionTitle(s.file));
  }
  return titleCache.get(key);
}

// Two looks at a screen further apart than this are not "idle all the time between them" (the watcher looks every
// few seconds while a Claude session runs).
const IDLE_GAP_MS = 20_000;

// "Live status: basic": a screen that changed this recently is a tool at work.
const BASIC_BUSY_MS = 4000;

// The terminal that stands for a session: the one with a Claude run in it, else the active one.
const pick = (terms, byId) => terms.find((t) => byId.has(t.id)) || terms.find((t) => t.active) || terms[0];

export class Deck {
  /**
   * @param {object} o
   * @param {object} o.backend          session backend (./backends)
   * @param {() => object} o.config     returns the current config (loadConfig)
   * @param {() => object[]} o.profiles returns the full profiles (server side only)
   */
  constructor({ backend, config, profiles, now = Date.now }) {
    Object.assign(this, { backend, config, profiles, now });
    this.idle = new Map(); // session name → { key, since, last }: how long its screen has looked idle (see #shown)
    this.shown = new Map(); // session name → { key, status, at }: a card that differs from its run record, and since when
    this.launches = new Map(); // `${tool}:${conversation}` → { name, at }: see noteLaunch
  }

  /**
   * Terminal `name` was just started or restarted (at `at`) on conversation `id`. Its launcher names the conversation
   * in its run record (runs.mjs: conversation) the moment it starts; this note covers only the moment before, while the
   * terminal holds no record written since (handoff.mjs terminalOf reads it): a restart in place (a move) ends the
   * old launcher and its record before the new one has written its own.
   */
  noteLaunch(name, id, tool = 'claude', at = Date.now()) {
    if (!id || !name) return;
    this.launches.set(`${tool}:${id}`, { name, at });
    if (this.launches.size > 200) this.launches.delete(this.launches.keys().next().value);
  }

  /**
   * Every look at the sessions (the watcher's tick, a page) ends the notes whose terminal is gone or holds a record
   * written since, as terminalOf does: a launcher that wrote its record and ended leaves no note behind.
   */
  #settleLaunches(notes, terms, runs, parentOf) {
    for (const [key, note] of notes) {
      if (this.launches.get(key) !== note) continue;
      const ts = terms.filter((t) => t.session === note.name);
      if (!ts.length || matchRuns(ts, runs.filter((r) => r.startedAt >= note.at), parentOf).size) this.launches.delete(key);
    }
  }

  /** The note of conversation `id` (noteLaunch), or null. `drop`: it ends (its terminal is gone, or holds a newer record). */
  launchOf(id, tool = 'claude', { drop = false } = {}) {
    if (drop) this.launches.delete(`${tool}:${id}`);
    return this.launches.get(`${tool}:${id}`) || null;
  }

  /**
   * The run's status as the screen confirms it (screen.mjs: shownStatus), and since when. The run file is not
   * touched: only the hooks write it, and the next event there is the truth again.
   */
  #shown(name, run, screen, now) {
    const look = screenLook(screen);
    const key = `${run.runId}|${run.status}|${run.statusAt}`;
    let idleFor = 0;
    if (look === 'idle') {
      // Idle "for a while" means seen idle look after look: a gap between two looks proves nothing about it.
      const was = this.idle.get(name);
      const since = was && was.key === key && now - was.last <= IDLE_GAP_MS ? was.since : now;
      this.idle.set(name, { key, since, last: now });
      idleFor = now - since;
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
        activity: t.activity,
        kind: run ? 'claude' : 'shell', // every coding session; `tool` says which coding tool
        command: t.command,
      };
      if (run) card.tool = run.tool || 'claude';
      if (isOwnFolder(cwd)) card.own = true; // Tia's working folder: shown on Home, not as a folder of the owner's
      if (run) {
        const p = profiles.get(run.profile);
        Object.assign(card, {
          profile: p ? publicProfile(p) : { name: run.profile, label: run.profile, kind: 'unknown' },
          status: run.status,
          statusAt: run.statusAt,
          sessionId: run.sessionId || null,
          canSwitch: !!run.sessionId,
          title: card.tool === 'claude' ? titleOf(run.cwd, run.sessionId) : String(run.title || '').slice(0, 120),
          limit: null,
        });
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
        // Needs your OK: the "Yes, and don't ask again …" answer when Claude's question has one (prompts.mjs).
        if (card.status === 'attention') card.always = alwaysOption(screen);
      }
      out.push(card);
    }
    for (const m of [this.idle, this.shown]) for (const k of m.keys()) if (!groups.has(k)) m.delete(k);
    return out.sort((a, b) => (b.statusAt || b.activity || 0) - (a.statusAt || a.activity || 0));
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
  async start({ tool = 'claude', dir, profile, mode = 'new', sessionId = null, prompt = null, flags = [] }) {
    const argv = launchArgv(this.launcher(), { tool, profile, mode, sessionId, prompt, flags });
    const at = Date.now(); // the clock of the launcher's record (startedAt)
    const { name } = await this.backend.create({ name: await this.#newName(path.basename(dir)), dir, argv });
    if (mode === 'resume') this.noteLaunch(name, sessionId, tool, at);
    return name;
  }

  /** A terminal that runs the launcher with `words` (e.g. Codex's own sign-in), named after `base`. Returns its name. */
  async runLauncher(base, dir, words) {
    const { name } = await this.backend.create({ name: await this.#newName(base), dir, argv: [...this.launcher(), ...words] });
    return name;
  }

  /** A plain shell, no Claude. */
  async shell(dir) {
    const { name } = await this.backend.create({ name: await this.#newName('shell'), dir });
    return name;
  }

  /**
   * Type a message and submit it. The pause before Enter lets the program finish taking the text in, so Enter is
   * read as "send" and not as part of a paste.
   */
  async send(termId, text, { enter = true } = {}) {
    await this.backend.sendText(termId, text.replace(/\r\n?/g, '\n'));
    if (enter) {
      await new Promise((r) => setTimeout(r, 250));
      await this.backend.sendKey(termId, 'Enter');
    }
  }

  /**
   * Continue the run's session under another profile, in the same terminal: stop what runs there and start the
   * launcher with --resume (in a fresh shell, except on Windows, where the pty backend starts it directly). Claude writes its transcript as it goes, so at most the turn in
   * flight is lost.
   */
  async move(term, run, profileName) {
    const target = readProfile(profileName);
    if (!target) throw Object.assign(new Error('unknown provider'), { status: 400 });
    // A conversation stays in the coding tool it was started in: only a provider that serves that tool takes it.
    assertServes(target, run.tool || 'claude');
    const argv = this.moveArgv(target, run);
    this.noteLaunch(term.session, run.sessionId, run.tool || 'claude');
    await this.backend.respawn(term.id, run.cwd, argv);
  }

  /**
   * The command that carries `run`'s session on under `profile` (a full profile object, or "auto" as the server
   * builds it). A session nobody typed into yet has no conversation on disk: it starts there under the same id.
   */
  moveArgv(profile, run) {
    if (!run.sessionId) throw Object.assign(new Error('this session has no id yet; wait until it has started'), { status: 409 });
    const carry = Array.isArray(run.carryArgs) ? run.carryArgs.filter((a) => typeof a === 'string') : [];
    const tool = run.tool || 'claude';
    const fresh = tool === 'claude' ? !hasConversation(run.cwd, run.sessionId) : tool === 'codex' ? !codexHas(run.sessionId) : false;
    return launchArgv(this.launcher(), { tool, profile, mode: 'move', sessionId: run.sessionId, carryArgs: carry, fresh });
  }
}
