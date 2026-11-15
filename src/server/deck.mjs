// The dashboard's model: sessions of the backend joined with the launcher's run records, plus the actions on
// them (start, send, switch profile). The HTTP layer validates input and calls these.
import path from 'node:path';
import { moveArgs } from '../launch.mjs';
import { binFile, tilde } from '../paths.mjs';
import { publicProfile, readProfile } from '../profiles.mjs';
import { listRuns } from '../runs.mjs';
import { sessionTitle, sessionsIn } from '../sessions.mjs';
import { isOwnFolder } from './folders.mjs';
import { detectLimit } from './limits.mjs';
import { alwaysOption } from './prompts.mjs';
import { descendsFrom, parentLookup, procParent } from './platform.mjs';
import { safeSessionName, uniqueName } from './validate.mjs';

/**
 * The command that starts Claude (the contract with the launcher, src/launch.mjs): the launcher, then
 *   new        [profile]
 *   continue   [profile, -c]                    newest session of the folder
 *   resume     [profile, --resume, id]
 *   move       [profile, ...moveArgs(...)]      the run's own arguments, adjusted for the target profile
 * A first message (`prompt`, new/continue/resume only) goes last, after "--": Claude Code then takes it as the
 * prompt even when it starts with "-" (checked on 2.1.325), and the launcher passes it through unchanged. It is
 * one line: the tmux backend types the command into a shell, where a line break would end it. It is not carried
 * along when the session moves to another account (carryArgs keeps flags only). `flags` (new/continue/resume) are
 * Claude Code options chosen for this one session (New session → Options: permission mode, effort); they come after
 * the defaults the launcher adds, so they win, and they move with the session like any other flag.
 */
export const promptArgs = (prompt) => (prompt ? ['--', String(prompt).replace(/\s*[\r\n]+\s*/g, ' ').trim()] : []);

export function launchArgv(launcher, { profile, mode = 'new', sessionId = null, carryArgs = [], prompt = null, flags = [] }) {
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
      return [...launcher, profile.name, ...moveArgs(profile, carryArgs, sessionId)];
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

// The terminal that stands for a session: the one with a Claude run in it, else the active one.
const pick = (terms, byId) => terms.find((t) => byId.has(t.id)) || terms.find((t) => t.active) || terms[0];

export class Deck {
  /**
   * @param {object} o
   * @param {object} o.backend          session backend (./backends)
   * @param {() => object} o.config     returns the current config (loadConfig)
   * @param {() => object[]} o.profiles returns the full profiles (server side only)
   */
  constructor({ backend, config, profiles }) {
    Object.assign(this, { backend, config, profiles });
  }

  launcher() {
    const l = this.config().launcher;
    return Array.isArray(l) && l.length ? l : [process.execPath, binFile()];
  }

  /** One card per session, most recently changed first. */
  async list() {
    const terms = await this.backend.list();
    const { runs, parentOf } = await runsAndParents();
    const byId = matchRuns(terms, runs, parentOf);
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
        kind: run ? 'claude' : 'shell',
        command: t.command,
      };
      if (isOwnFolder(cwd)) card.own = true; // Tia's working folder: shown on Home, not as a folder of the owner's
      if (run) {
        const p = profiles.get(run.profile);
        Object.assign(card, {
          profile: p ? publicProfile(p) : { name: run.profile, label: run.profile, kind: 'unknown' },
          status: run.status,
          statusAt: run.statusAt,
          note: run.status === 'attention' ? String(run.note || '').slice(0, 300) : '',
          sessionId: run.sessionId || null,
          canSwitch: !!run.sessionId,
          title: titleOf(run.cwd, run.sessionId),
          limit: null,
        });
        try {
          const screen = await this.backend.capture(t.id, 40);
          card.limit = detectLimit(screen);
          // Needs your OK: the "Yes, and don't ask again …" answer when Claude's question has one (prompts.mjs).
          if (run.status === 'attention') card.always = alwaysOption(screen);
        } catch {
          /* the terminal went away between list and capture */
        }
      }
      out.push(card);
    }
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

  /** Start Claude under `profile` (full profile object) in `dir`. Returns the session name. */
  async start({ dir, profile, mode = 'new', sessionId = null, prompt = null, flags = [] }) {
    const argv = launchArgv(this.launcher(), { profile, mode, sessionId, prompt, flags });
    const { name } = await this.backend.create({ name: await this.#newName(path.basename(dir)), dir, argv });
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
    if (!run.sessionId) throw Object.assign(new Error('this session has no id yet; wait until Claude has started'), { status: 409 });
    const target = readProfile(profileName);
    if (!target) throw Object.assign(new Error('unknown provider'), { status: 400 });
    const carry = Array.isArray(run.carryArgs) ? run.carryArgs.filter((a) => typeof a === 'string') : [];
    const argv = launchArgv(this.launcher(), { profile: target, mode: 'move', sessionId: run.sessionId, carryArgs: carry });
    await this.backend.respawn(term.id, run.cwd, argv);
  }
}
