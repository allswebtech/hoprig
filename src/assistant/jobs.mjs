// Jobs: "do X in project Y" becomes a job with a goal, the session(s) Tia started or watches for it, a state and a
// short log. The dashboard's watcher loop calls tick() with the session cards it already has; no model call
// happens while nothing changes. Only a change that needs Tia wakes her (planWakes), under the turn rules of
// decideMode():
//
//   answer   she may act on the job's sessions (typing counts against the job's step cap; the level setting and
//            policy.mjs still decide what needs a card)
//   notify   the cap is used up: she must tell the owner and wait (the job shows "waiting for you")
//   report   the session ended or the time cap passed: she tells the owner the outcome and finishes the job
//
// States: working → waiting (for you) | done | stuck | stopped (by the owner). One JSON file per job in
// <stateDir>/assistant/jobs/<id>.json, so jobs survive a restart of the dashboard.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { fence, neutralize } from './fence.mjs';
import { LOCAL } from './shown.mjs';
import { ASSISTANT_NAME } from './tia.mjs';
import { statusOf } from './tools.mjs';

export const jobsDir = () => path.join(stateDir(), 'assistant', 'jobs');
export const ARM_MS = 30_000; // a "waiting" seen right after watching starts is the old state, not an answer
export const ACTIVE = new Set(['working', 'waiting']);
export const STATES = ['working', 'waiting', 'done', 'stuck', 'stopped'];
const LOG_MAX = 50;
const KEEP = 200;
const ID_RE = /^j_[0-9a-f]{10}$/;

/**
 * Which jobs need Tia now. Fires once per change of a session's state, never twice for the same state.
 *   waiting   Claude Code finished its turn and waits (done, or asking something)
 *   needs_ok  Claude Code asks for permission
 *   limit     a usage limit (not for Auto sessions: the router moves those by itself)
 *   ended     Claude Code exited or the session is gone
 *   expired   the job's time cap passed
 * Returns { events: [{ job, entry, reason, card }], updates: Map(jobId → [entry patches]) }.
 */
export function planWakes(jobs, cards, now, armMs = ARM_MS) {
  const events = [];
  const updates = new Map();
  for (const job of jobs) {
    if (!ACTIVE.has(job.state)) continue;
    if (now >= job.until) {
      events.push({ job, entry: job.sessions[0] || null, reason: 'expired', card: null });
      continue;
    }
    const patches = [];
    for (const e of job.sessions) {
      if (e.ended) {
        patches.push({});
        continue;
      }
      // The job's own terminal: a later session that got its name (made at another time) is someone else's. A chat's
      // name comes back each time its conversation is opened again, so a chat whose time is not known is never its own.
      const card = cards.find((c) => c.name === e.session && (c.computer || LOCAL) === e.computer && (e.created == null ? !e.session.startsWith('chat:') : c.created === e.created)) || null;
      const st = card ? statusOf(card) : 'gone';
      // A session that was just started shows as a plain shell until the launcher has registered its run: that
      // is not an end. It ends once it was seen running (armed) or the grace time has passed.
      const settling = !e.armed && now - e.since < armMs;
      if ((st === 'shell' || st === 'gone') && settling) {
        patches.push({});
        continue;
      }
      if (!card || st === 'shell' || st === 'ended') {
        events.push({ job, entry: e, reason: 'ended', card });
        patches.push({ ended: true, last: st });
        continue;
      }
      const auto = card.profile && card.profile.name === 'auto';
      const armed = e.armed || st === 'working' || now - e.since >= armMs;
      const p = { armed };
      if (armed && st !== e.last) {
        p.last = st;
        if (st === 'waiting' || st === 'needs_ok' || (st === 'limit' && !auto)) events.push({ job, entry: e, reason: st, card });
      }
      patches.push(p);
    }
    updates.set(job.id, patches);
  }
  return { events, updates };
}

/** The turn rules for a wake-up. */
export function decideMode(event) {
  if (event.reason === 'ended' || event.reason === 'expired') return 'report';
  return event.job.steps >= event.job.maxSteps ? 'notify' : 'answer';
}

/** The job's state after a wake-up event (before Tia acts on it). */
export function stateAfter(job, event, mode) {
  if (event.reason === 'expired') return { state: 'stuck', log: 'time cap reached' };
  if (event.reason === 'ended') {
    const open = job.sessions.filter((e) => !e.ended && e !== event.entry && !(e.computer === event.entry.computer && e.session === event.entry.session));
    return open.length ? { state: job.state, log: `${event.entry.session} ended` } : { state: 'stuck', log: `${event.entry.session} ended before the job was finished` };
  }
  if (mode === 'notify') return { state: 'waiting', log: `${event.entry.session} ${event.reason}; the step cap is used up, waiting for the owner` };
  return { state: 'working', log: `${event.entry.session} ${event.reason}` };
}

const WHY = {
  waiting: 'finished its turn and is waiting',
  needs_ok: 'is asking for permission',
  limit: 'hit a usage limit',
  ended: 'ended',
  expired: 'is past the job\'s time cap',
};
const RULE = {
  answer: 'Carry the job on within its goal: read the session; answer its question, ask it to run the tests or show the diff, or move it to another allowed provider after a limit. When the goal is met (checked, not assumed), call finish_job with state "done" and a two-line report. If you cannot go on, finish_job with state "stuck" and say what is needed.',
  notify: 'The job used all its answers. Do not type into the session. Tell the owner what it needs and your suggested answer (notify_owner).',
  report: 'Read what is left to read, then finish_job with "done" (only if the goal is met) or "stuck", with a short report.',
};

/** The user turn that wakes Tia. Header lines are built from validated values; the screen is fenced. */
export function wakeMessage(event, mode, screen = '') {
  const { job, entry } = event;
  const who = entry ? `Session ${entry.session} on ${entry.computer}` : 'The job';
  const head = [
    `[job ${job.id}] ${who} ${WHY[event.reason]}.`,
    `Goal given by the owner: ${neutralize(job.goal, 500).replace(/\n/g, ' ')}`,
    `Answers used: ${job.steps} of ${job.maxSteps}.`,
    RULE[mode],
  ];
  return screen && entry ? `${head.join('\n')}\n${fence('terminal_output', { session: entry.session }, screen, 12_000)}` : head.join('\n');
}

const startKey = (computer, session, created) => (Number.isSafeInteger(created) && created > 0 ? `${computer}|${session}|${created}` : null);

export class JobStore {
  /** dir: a folder for the job files, or null to keep them in memory (tests). settings() → { maxSteps, maxMinutes }. */
  constructor({ dir = jobsDir(), now = Date.now, settings = () => ({ maxSteps: 20, maxMinutes: 240 }) } = {}) {
    Object.assign(this, { dir, now, settings });
    this.jobs = new Map();
    this.started = new Set(); // "computer|session|created" Tia started outside any job
    if (dir) this.#load();
  }

  /**
   * Remember a session Tia started without a job (so she may stop or move it later). `created` is when that terminal
   * was made (its card's `created`): a session name is used again once the session ends (the owner's next session in
   * that folder gets it), so a mark holds only for that one terminal. Without it, nothing is marked.
   */
  markStarted(computer, session, created) {
    const key = startKey(computer, session, created);
    if (!key) return;
    this.started.delete(key);
    this.started.add(key);
    if (this.started.size > 500) this.started.delete(this.started.values().next().value);
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.dir, 'started.list'), [...this.started].join('\n') + '\n', { mode: 0o600 });
    }
  }

  #load() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return;
    }
    try {
      for (const k of fs.readFileSync(path.join(this.dir, 'started.list'), 'utf8').split('\n')) if (/^[a-z0-9_-]+\|[A-Za-z0-9_.-]+\|\d+$/.test(k)) this.started.add(k);
    } catch {
      /* none yet */
    }
    for (const f of names) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (j && ID_RE.test(j.id) && STATES.includes(j.state) && Array.isArray(j.sessions)) this.jobs.set(j.id, j);
      } catch {
        /* a broken file is skipped, never trusted */
      }
    }
  }

  #save(job) {
    job.updatedAt = this.now();
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, `${job.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(job) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    if (this.jobs.size > KEEP) {
      const old = [...this.jobs.values()].filter((j) => !ACTIVE.has(j.state)).sort((a, b) => a.updatedAt - b.updatedAt);
      for (const j of old.slice(0, this.jobs.size - KEEP)) {
        this.jobs.delete(j.id);
        fs.rmSync(path.join(this.dir, `${j.id}.json`), { force: true });
      }
    }
  }

  create({ conversation, goal, maxMinutes }) {
    const s = this.settings();
    const at = this.now();
    const job = {
      id: `j_${crypto.randomBytes(5).toString('hex')}`, conversation, goal, state: 'working', sessions: [],
      steps: 0, maxSteps: s.maxSteps, createdAt: at, until: at + (maxMinutes || s.maxMinutes) * 60_000, updatedAt: at, log: [],
    };
    this.jobs.set(job.id, job);
    this.#log(job, `started: ${goal.slice(0, 200)}`);
    return { ...job };
  }

  /**
   * Add a session to a job (watching starts). startedByTia: Tia started it, so she may stop or move it; `created`
   * (the terminal's card's) ties that to this one terminal, as in markStarted.
   */
  attach(id, { computer = LOCAL, session, startedByTia = false, created = null }) {
    const job = this.jobs.get(id);
    if (!job || !ACTIVE.has(job.state)) return null;
    const at = startKey(computer, session, created) ? created : null;
    const entry = job.sessions.find((e) => e.computer === computer && e.session === session);
    if (!entry) {
      job.sessions.push({ computer, session, startedByTia, created: at, since: this.now(), last: null, armed: false, ended: false });
      this.#log(job, `${startedByTia ? 'started' : 'watching'} ${session} on ${computer}`);
    } else if (at !== null && entry.created !== at) {
      // The same name, made at another time: the conversation goes on in a new chat (or terminal) within this job, and
      // the job follows that one now.
      Object.assign(entry, { startedByTia, created: at, since: this.now(), last: null, armed: false, ended: false });
      this.#log(job, `${startedByTia ? 'started' : 'watching'} ${session} on ${computer} again`);
    }
    return { ...job };
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? structuredClone(j) : null;
  }

  list({ active = false } = {}) {
    return [...this.jobs.values()].filter((j) => !active || ACTIVE.has(j.state)).sort((a, b) => b.createdAt - a.createdAt).map((j) => structuredClone(j));
  }

  /** The active job that watches this session, or null. */
  forSession(computer, session) {
    for (const j of this.jobs.values()) if (ACTIVE.has(j.state) && j.sessions.some((e) => e.computer === computer && e.session === session && !e.ended)) return structuredClone(j);
    return null;
  }

  /**
   * Tia started this very session (for a job, also a finished one, or without one): its name and its terminal's
   * `created` both match a mark. A later session that got the same name, and one whose `created` is not known, is not
   * hers.
   */
  startedByTia(computer, session, created) {
    const key = startKey(computer, session, created);
    if (!key) return false;
    if (this.started.has(key)) return true;
    for (const j of this.jobs.values()) if (j.sessions.some((e) => e.computer === computer && e.session === session && e.startedByTia && e.created === created)) return true;
    return false;
  }

  /** Count one answer. False when the cap is reached (the job then waits for the owner). */
  step(id) {
    const j = this.jobs.get(id);
    if (!j || j.steps >= j.maxSteps) return false;
    j.steps++;
    this.#save(j);
    return true;
  }

  note(id, text) {
    const j = this.jobs.get(id);
    if (j) this.#log(j, text);
  }

  /** End a job: done, stuck (by Tia) or stopped (by the owner). */
  finish(id, state, report = '') {
    const j = this.jobs.get(id);
    if (!j) return null;
    if (!['done', 'stuck', 'stopped'].includes(state)) throw new Error(`bad job state ${state}`);
    j.state = state;
    this.#log(j, `${state}${report ? `: ${report.slice(0, 300)}` : ''}`);
    return structuredClone(j);
  }

  #log(job, text) {
    job.log.push({ at: this.now(), text: String(text).slice(0, 300) });
    if (job.log.length > LOG_MAX) job.log.splice(0, job.log.length - LOG_MAX);
    this.#save(job);
  }

  /** One watcher tick: apply planWakes and the state changes. Returns [{ job, entry, reason, mode, card }]. */
  tick(cards) {
    const { events, updates } = planWakes(this.list({ active: true }), cards, this.now());
    for (const [id, patches] of updates) {
      const j = this.jobs.get(id);
      if (!j) continue;
      patches.forEach((p, i) => Object.assign(j.sessions[i], p));
      this.#save(j);
    }
    const out = [];
    for (const ev of events) {
      const j = this.jobs.get(ev.job.id);
      if (!j || !ACTIVE.has(j.state)) continue;
      const mode = decideMode({ ...ev, job: j });
      const next = stateAfter(j, ev, mode);
      j.state = next.state;
      this.#log(j, next.log);
      out.push({ ...ev, job: structuredClone(j), mode });
    }
    return out;
  }
}

export const JOB_STATE_WORDS = { working: 'working', waiting: 'waiting for you', done: 'done', stuck: 'stuck', stopped: 'stopped' };
export const describeJobs = (jobs) => jobs.map((j) => `${j.id} ${JOB_STATE_WORDS[j.state]}`).join(', ') || `${ASSISTANT_NAME} has no jobs`;
