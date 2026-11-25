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

/**
 * A session in the job's log as the owner reads it: a chat by its folder ("the chat in shop"; its id means nothing to
 * him), a terminal by its name; "on this computer", "on laptop".
 */
const who = (e) => (/^chat:/.test(e.session) ? (e.folder ? `the chat in ${e.folder}` : 'a chat') : e.session);
const named = (e) => `${who(e)} on ${e.computer === LOCAL ? 'this computer' : e.computer}`;
// What woke her, as the log says it.
const REASON = { waiting: 'is waiting', needs_ok: 'asks for an OK', notice: 'asks the owner something before it starts', limit: 'reached a usage limit' };
/** A folder's last part, as a job's entry keeps it (one line, short). */
const lastPart = (dir) => String(dir || '').split(/[\\/]/).filter(Boolean).pop()?.replace(/[\r\n]+/g, ' ').slice(0, 80) || null;
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
 *   notice    the coding tool asks a question of its own before it starts (askcard.mjs): the owner's, never hers
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
      const seen = card ? statusOf(card) : 'gone';
      const st = seen === 'needs_ok' && card.askCard && card.askCard.kind === 'notice' ? 'notice' : seen;
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
        if (st === 'waiting' || st === 'needs_ok' || st === 'notice' || (st === 'limit' && !auto)) events.push({ job, entry: e, reason: st, card });
      }
      patches.push(p);
    }
    updates.set(job.id, patches);
  }
  return { events, updates };
}

/**
 * The turn rules for a wake-up. `answersHers`: the owner's switch (Settings → Tia): an OK in the run of a Work task she
 * started is hers to allow (judged by policy.mjs like any OK of hers; a no stays his); off, it is his, as before.
 */
export function decideMode(event, { answersHers = false } = {}) {
  if (event.reason === 'ended' || event.reason === 'expired') return 'report';
  // A question of the coding tool itself is the owner's in any job: she tells him, she never answers it.
  if (event.reason === 'notice') return 'notify';
  // A job that follows a Work run never answers in it: an OK it asks for is the owner's, any other stop is the run's end.
  if (workOf(event.job.work)) {
    if (event.reason !== 'needs_ok') return 'report';
    // Only in the run's own chat (workRun): another session joined to the job is not her run.
    return answersHers === true && event.entry && event.entry.workRun === true && event.job.steps < event.job.maxSteps ? 'answer' : 'notify';
  }
  return event.job.steps >= event.job.maxSteps ? 'notify' : 'answer';
}

/** The job's state after a wake-up event (before Tia acts on it). */
export function stateAfter(job, event, mode) {
  if (event.reason === 'expired') return { state: 'stuck', log: 'time cap reached' };
  if (event.reason === 'ended') {
    const open = job.sessions.filter((e) => !e.ended && e !== event.entry && !(e.computer === event.entry.computer && e.session === event.entry.session));
    return open.length ? { state: job.state, log: `${who(event.entry)} ended` } : { state: 'stuck', log: `${who(event.entry)} ended before the job was finished` };
  }
  const why = `${who(event.entry)} ${REASON[event.reason] || event.reason}`;
  // A Work run that hit a usage limit has ended (the Work route settles it as "limit"): the job is over too, so no
  // wake comes for it later; her report finishes it in words.
  if (event.reason === 'limit' && workOf(job.work)) return { state: 'stuck', log: `${why}; the run ended there` };
  // A Work run's OK is the owner's whatever its answers count (decideMode): no step cap is behind it.
  if (event.reason === 'needs_ok' && workOf(job.work)) {
    return mode === 'answer' ? { state: 'working', log: `${why}; ${ASSISTANT_NAME} answers it where her rules allow, else it is the owner's` } : { state: 'waiting', log: `${why}; the OK is the owner's, waiting for him` };
  }
  if (event.reason === 'notice') return { state: 'waiting', log: `${why}; the answer is the owner's, waiting for him` };
  if (mode === 'notify') return { state: 'waiting', log: `${why}; the step cap is used up, waiting for the owner` };
  return { state: 'working', log: why };
}

const WHY = {
  waiting: 'finished its turn and is waiting',
  needs_ok: 'is asking for permission',
  notice: 'asks the owner a question of the coding tool itself before it starts',
  limit: 'hit a usage limit',
  ended: 'ended',
  expired: 'is past the job\'s time cap',
};
const RULE = {
  answer: 'Carry the job on within its goal: read the session; answer its question, ask it to run the tests or show the diff, or move it to another allowed provider after a limit. When the goal is met (checked, not assumed), call finish_job with state "done" and a two-line report. If you cannot go on, finish_job with state "stuck" and say what is needed.',
  notify: 'The job used all its answers. Do not type into the session. Tell the owner what it needs and your suggested answer (notify_owner).',
  notice: 'The coding tool asks a question of its own before the session starts (whether to trust the folder, to accept Bypass permissions mode, to allow imports): only the owner answers it. Do not type into the session. Tell him in one line what it asks and that he answers it in the session\'s terminal (notify_owner).',
  report: 'Read what is left to read, then finish_job with "done" (only if the goal is met) or "stuck", with a short report.',
};

// A job that follows a Work run (manage_work start): the session is the owner's (the Work route opens it, not her),
// and its result is his to accept. She reads the run and tells him; she answers nothing in it and starts nothing new.
// The report depends on how the run ended (its state, read when the wake is made): only a run that is done waits for
// his Accept; one that failed, hit a usage limit or was stopped left the task open again.
const RUN_STATES = ['running', 'done', 'failed', 'limit', 'stopped'];
const ENDED_WORDS = { failed: 'it failed', limit: 'it stopped at a usage limit of its provider', stopped: 'it was stopped' };
const TAIL = 'Your reply to him is those same two lines, nothing more. Do not type into the session (it is the owner\'s; what it does after its run is in no record). Never accept, send back or start another session yourself.';
const doneRule = (w) => `finish_job with "done" and a report of two lines: what was done (and checked; when the run shows no test result, say so in the first line), and what waits for the owner (Accept or Send back of the task ${w.task}), and open_screen "work" so the task is one tap away.`;
const endedRule = (w) => `finish_job with "stuck" and a report of two lines: why it stopped (the run's reason, in plain words), and that the task ${w.task} is open again: "Do it" on the Work page starts it anew (on another provider, if he chooses). Nothing waits for his Accept, and nothing is moved or retried by you.`;
const WORK_RULE = {
  report: (w, state) => (state === 'done' ? `The run is done. Read it (manage_work action run, run ${w.run}). Then ${doneRule(w)} ${TAIL}`
    : ENDED_WORDS[state] ? `The run ended without a result: ${ENDED_WORDS[state]}. Read it (manage_work action run, run ${w.run}). Then ${endedRule(w)} ${TAIL}`
      : `Read the run (manage_work action run, run ${w.run}; when it still says it works, read it once more). If it is done: ${doneRule(w)} If it failed, hit a usage limit or was stopped: ${endedRule(w)} ${TAIL}`),
  owner: () => 'This session is not yours: its OKs and questions are the owner\'s. Tell him in one line what it waits for (notify_owner); do not answer it and do not type into it.',
  // The owner's switch is on (Settings → Tia): the run's OK may be hers. The dashboard judges her answer again and makes
  // anything but looking and the project's own checks his card; she never types into the run.
  answer: () => 'The owner lets you answer the OKs of the Work runs you started. Read what it asks (read_session). Only when it is looking inside the project or running the project\'s own checks (its tests, its linter, its build): send_to_chat with answer "allow". Anything else (changing a file, a push or merge, a release, money, a sign-in, anything sent out, a delete, administrator rights): do not answer; tell the owner in one line what it asks (notify_owner). Answer only allow: never deny, never text, never allow_always. When the dashboard makes your answer a card, tell him that too.',
  expired: () => 'The job\'s time cap passed. Read the run (manage_work action run) and finish_job with "stuck", saying how it stands.',
};
const WORK_TASK = /^[a-z0-9][a-z0-9-]{0,79}$/;
const WORK_RUN = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
/** A job's Work part as kept: { task, run, computer } of the forms this code makes, or null. */
export const workOf = (w) => (w && WORK_TASK.test(w.task) && WORK_RUN.test(w.run) && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(w.computer) ? { task: w.task, run: w.run, computer: w.computer } : null);

/**
 * The user turn that wakes Tia. Header lines are built from validated values; the screen is fenced. `event.answersHers`:
 * the owner's switch as jobTick read it; only with it (and the mode "answer") is a Work run's OK hers to answer.
 */
export function wakeMessage(event, mode, screen = '') {
  const { job, entry } = event;
  const who = entry ? `Session ${entry.session} on ${entry.computer}` : 'The job';
  const w = workOf(job.work);
  // The run's state, when the wake could read it (core.mjs jobTick): one of this code's own words, never a value as given.
  const state = w && event.run && RUN_STATES.includes(event.run.state) ? event.run.state : null;
  const rule = event.reason === 'notice' ? RULE.notice : !w ? RULE[mode] : event.reason === 'expired' ? WORK_RULE.expired() : event.reason === 'needs_ok' ? (mode === 'answer' && event.answersHers === true ? WORK_RULE.answer() : WORK_RULE.owner()) : WORK_RULE.report(w, state);
  const head = [
    `[job ${job.id}] ${who} ${WHY[event.reason]}.`,
    `Goal given by the owner: ${neutralize(job.goal, 500).replace(/\n/g, ' ')}`,
    ...(w ? [`It is the run ${w.run} of the task ${w.task} on ${w.computer} (Work)${state ? `; the run says: ${state}` : ''}.`] : [`Answers used: ${job.steps} of ${job.maxSteps}.`]),
    rule,
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

  /** work: { task, run, computer } for a job that follows a Work run (manage_work start; wakeMessage). */
  create({ conversation, goal, maxMinutes, work = null }) {
    const s = this.settings();
    const at = this.now();
    const w = workOf(work);
    const job = {
      id: `j_${crypto.randomBytes(5).toString('hex')}`, conversation, goal, state: 'working', sessions: [],
      steps: 0, maxSteps: s.maxSteps, createdAt: at, until: at + (maxMinutes || s.maxMinutes) * 60_000, updatedAt: at, log: [],
      ...(w ? { work: w } : {}),
    };
    this.jobs.set(job.id, job);
    this.#log(job, `started: ${goal.slice(0, 200)}`);
    return { ...job };
  }

  /**
   * Add a session to a job (watching starts). startedByTia: Tia started it, so she may stop or move it; `created`
   * (the terminal's card's) ties that to this one terminal, as in markStarted.
   */
  attach(id, { computer = LOCAL, session, startedByTia = false, created = null, folder = null, workRun = false }) {
    const job = this.jobs.get(id);
    if (!job || !ACTIVE.has(job.state)) return null;
    const at = startKey(computer, session, created) ? created : null;
    // A chat is named by its folder in the log and on the Jobs page (`folder`: its last part only).
    const where = lastPart(folder);
    // `workRun`: this is the Work run's own chat, as manage_work start attaches it. Only that entry is her run
    // (herWorkRun, decideMode); any other session a call adds to the job (start_chat on his open chat) is not.
    const run = workRun === true && !!workOf(job.work) ? { workRun: true } : {};
    const entry = job.sessions.find((e) => e.computer === computer && e.session === session);
    if (!entry) {
      const e = { computer, session, startedByTia, created: at, since: this.now(), last: null, armed: false, ended: false, ...(where ? { folder: where } : {}), ...run };
      job.sessions.push(e);
      this.#log(job, `${startedByTia ? 'started' : 'watching'} ${named(e)}`);
    } else if (at !== null && entry.created !== at) {
      // The same name, made at another time: the conversation goes on in a new chat (or terminal) within this job, and
      // the job follows that one now.
      delete entry.workRun;
      Object.assign(entry, { startedByTia, created: at, since: this.now(), last: null, armed: false, ended: false, ...(where ? { folder: where } : {}), ...run });
      this.#log(job, `${startedByTia ? 'started' : 'watching'} ${named(entry)} again`);
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
   * This very session is (or was) a Work run's, by any job that followed one, also a finished one: the run's chat stays
   * the owner's after its job ended (done, or at a usage limit), since a turn typed into it then is in no run record.
   * Matched by name and when the chat was made; a run whose chat time was not known when it started is matched by name
   * (an extra card for the owner, never an unguarded act).
   */
  workSession(computer, session, created) {
    for (const j of this.jobs.values()) {
      if (!workOf(j.work)) continue;
      if (j.sessions.some((e) => e.computer === computer && e.session === session && (e.created == null || e.created === created))) return true;
    }
    return false;
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

  /**
   * This very session is the run of a Work task she started (a job of hers follows it with `work`): matched by its name
   * AND when it was made, never by name alone (a run whose chat time was not known is not matched: his card), and only
   * while that job follows it: once the run ended, its chat is the owner's again (workSession). Only the entry marked as
   * the run's own chat (workRun): a chat of his that a call joined to the job stays his.
   */
  herWorkRun(computer, session, created) {
    if (!Number.isSafeInteger(created) || created <= 0) return false;
    for (const j of this.jobs.values()) {
      if (!workOf(j.work) || !ACTIVE.has(j.state)) continue;
      if (j.sessions.some((e) => e.workRun === true && e.computer === computer && e.session === session && e.created === created)) return true;
    }
    return false;
  }

  /**
   * One watcher tick: apply planWakes and the state changes. `answersHers`: the owner's switch (decideMode). Returns
   * [{ job, entry, reason, mode, card }].
   */
  tick(cards, { answersHers = false } = {}) {
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
      const mode = decideMode({ ...ev, job: j }, { answersHers });
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
