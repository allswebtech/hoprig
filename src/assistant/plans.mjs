// Plans: several acts of the product as ONE card (design 2.3). The owner taps once; the runner then does the steps in
// order, one at a time, and tells where it is. Nothing here knows a route: every step is an act of acts.json, and the
// runner reaches it through an ADAPTER the dashboard gives it, so each step is checked again by the server at its own
// route as if he had tapped it alone.
//
// The adapter (the seam to the catalog tools):
//   row(id)                     the row of acts.json for an act id, or undefined
//   answer(row, args)           'read' | 'alone' | 'card' | 'open' | 'none', from the row's facts and what the server finds
//                               for this call (raiseFacts): a fact is only ever turned on, never off
//   run(id, args, meta)         does the act at its route. meta: { plan, step, via: 'plan' }. -> { ok, summary, undo? }
//                               where undo is whatever undo(undo) needs to take it back (null: nothing to take back)
//   undo(undo, meta)            takes one step back. -> { ok, summary }
//   fact(id, args)              reads a read row. -> the picked data (an object)
//   backOf?(row)                the row that really takes a step back, or null (the card says so before the tap); without it the
//                               row's own undo is believed
//   before?(step)               what the step's inputs rest on now (hashed with the card, so a changed input is stale)
//
// A plan never confirms itself: it starts only from the owner's tap on its card (plantool.mjs run), and a step whose
// row is open (the never list) is not accepted at all.
import crypto from 'node:crypto';
import { placesOf } from './catalog.mjs';
import { loadActs, raiseFacts, rowAnswer } from './acts.mjs';
import { openAnswer } from './screens.mjs';
import { LOCAL } from './shown.mjs';

export const MAX_STEPS = 12;
export const PLAN_TTL_MS = 24 * 3600_000;
export const PER_COMPUTER = 1;
export const AT_ONCE = 3;
export const WAIT_UNTIL = Object.freeze(['answers', 'done', 'idle', 'back']);
export const WAIT_MINUTES = Object.freeze({ min: 1, max: 30 });
export const POLL_MS = 15_000;
/** The states of a step, and of a plan. */
export const STEP_STATES = Object.freeze(['waiting', 'running', 'holding', 'done', 'failed', 'undone', 'undo-failed', 'skipped']);
export const PLAN_STATES = Object.freeze(['staged', 'running', 'done', 'failed', 'stopped']);

/** Her short words for a step: what it does and what it changes (the card shows these). */
export function stepWords(row, step, adapter) {
  const undoRow = adapter.backOf ? adapter.backOf(row) : row.undo ? adapter.row(row.undo) : null;
  const computer = step.args && step.args.computer && step.args.computer !== LOCAL ? ` on ${step.args.computer}` : '';
  const what = `${String(row.what).replace(/\.$/, '')}${computer}`;
  const changes = row.facts && row.facts.reads === true ? 'Reads only; changes nothing.'
    : row.facts && row.facts.spends ? 'Uses paid usage.'
      : undoRow ? `Can be taken back: ${String(undoRow.what).replace(/\.$/, '')}.`
        : row.facts && row.facts.undo === 'remake' ? 'Only makes again what Hoprig makes.' : 'Cannot be taken back with one press.';
  return { what, changes };
}

const TYPE = { string: (v) => typeof v === 'string', number: (v) => typeof v === 'number' && Number.isFinite(v), integer: Number.isInteger, boolean: (v) => typeof v === 'boolean', array: Array.isArray, object: (v) => v && typeof v === 'object' && !Array.isArray(v) };
/** What is wrong with a step's args against its row's strict input (unknown field, wrong type, too long), or null. */
export function argsProblem(row, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'args is an object';
  const props = (row.input && row.input.properties) || {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'computer') { if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(v)) return 'computer is a computer name'; continue; }
    // The ids in the address and the variant of a route (catalog.mjs pathOf): the plan carries them like do_act does.
    if (['target', 'target2', 'target3'].includes(k) && placesOf(row).ids > ['target', 'target2', 'target3'].indexOf(k)) { if (typeof v !== 'string') return `${k} is the id as text`; continue; }
    if (k === 'variant' && placesOf(row).variants.length) { if (!placesOf(row).variants[0].includes(v)) return `variant is one of: ${placesOf(row).variants[0].join(', ')}`; continue; }
    const p = props[k];
    if (!p) return `"${k}" does not go with this act${Object.keys(props).length ? ` (it takes: ${Object.keys(props).join(', ')})` : ' (it takes nothing but computer)'}`;
    if (p.type && TYPE[p.type] && !TYPE[p.type](v)) return `"${k}" must be ${p.type === 'array' || p.type === 'object' ? 'an' : 'a'} ${p.type}`;
    if (typeof v === 'string' && p.maxLength && v.length > p.maxLength) return `"${k}" is longer than ${p.maxLength}`;
    if (p.enum && !p.enum.includes(v)) return `"${k}" is one of: ${p.enum.join(', ')}`;
  }
  return null;
}

/**
 * Check a plan's steps against the product's acts. -> { steps } when all can be in a plan, else { refused: [{ n, act, say,
 * ... }], problems: [text] }. A step that is the owner's own (the never list) refuses the whole plan with her words for it
 * and the place to open; a made-up act, a wait on a fact that is not a read row and a bad wait refuse with the step to take.
 */
export function checkPlan(input, adapter) {
  const steps = [];
  const refused = [];
  const problems = [];
  if (!Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > MAX_STEPS) problems.push(`a plan has 2 to ${MAX_STEPS} steps`);
  (input.steps || []).forEach((s, i) => {
    const n = i + 1;
    const row = adapter.row(s.act);
    if (!row) {
      problems.push(`step ${n}: there is no act "${String(s.act).slice(0, 64)}"; call find_acts for the act that does it`);
      return;
    }
    const args = s.args && typeof s.args === 'object' ? s.args : {};
    const answer = adapter.answer(row, args);
    if (answer === 'open' || answer === 'none') {
      refused.push({ n, act: row.id, ...(answer === 'open' ? openAnswer(row, { computer: args.computer }) : { say: 'That is not an act a person does.' }) });
      return;
    }
    const bad = argsProblem(row, args);
    if (bad) {
      problems.push(`step ${n} (${row.id}): ${bad}`);
      return;
    }
    if (s.wait) {
      const w = s.wait;
      const fact = adapter.row(w.fact);
      // The row is judged on its own (a read act): its computer is the wait's own, read through the plan's card (door.mjs).
      if (!fact || adapter.answer(fact, {}) !== 'read') problems.push(`step ${n}: a wait watches a read act; "${String(w.fact).slice(0, 64)}" is not one (find_acts shows the read acts)`);
      else {
        const bad = argsProblem(fact, { ...(w.args && w.args.computer ? { computer: w.args.computer } : {}) });
        if (bad) problems.push(`step ${n}: the wait's ${bad}`);
        else if (w.args !== undefined && (typeof w.args !== 'object' || Array.isArray(w.args))) problems.push(`step ${n}: the wait's args is an object`);
      }
      if (!WAIT_UNTIL.includes(w.until)) problems.push(`step ${n}: wait until is one of ${WAIT_UNTIL.join(', ')}`);
      if (!Number.isInteger(w.minutes) || w.minutes < WAIT_MINUTES.min || w.minutes > WAIT_MINUTES.max) problems.push(`step ${n}: a wait is ${WAIT_MINUTES.min} to ${WAIT_MINUTES.max} minutes`);
    }
    steps.push({ n, act: row.id, args, answer, ...(s.wait ? { wait: s.wait } : {}), ...stepWords(row, { args }, adapter) });
  });
  if (refused.length) return { refused, problems };
  if (problems.length) return { problems };
  return { steps };
}

/** Whether what a read answered meets the wait's condition (plain data, no model). */
export function waitMet(until, data) {
  const d = data && typeof data === 'object' ? data : {};
  const state = String(d.state ?? d.status ?? '').toLowerCase();
  switch (until) {
    case 'done': return d.done === true || ['done', 'ended', 'finished', 'complete', 'completed'].includes(state);
    case 'idle': return d.idle === true || ['idle', 'waiting', 'ended', 'done', 'finished'].includes(state);
    case 'back': return d.online === true || d.ok === true || ['online', 'ready', 'working', 'up', 'ok'].includes(state);
    case 'answers': return d.ok === true || d.answers === true || d.answered === true || (Array.isArray(d.items) && d.items.length > 0) || ['ok', 'answers', 'answered', 'ready'].includes(state);
    default: return false;
  }
}

const planId = () => `p_${crypto.randomBytes(6).toString('hex')}`;
export const PLAN_ID = /^p_[0-9a-f]{12}$/;

/** The plans of this dashboard, in memory (like the cards: kept until it restarts). */
export class PlanStore {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.plans = new Map();
  }

  create({ conversation, title, why = '', steps, cardId = null }) {
    const p = {
      id: planId(), conversation, title, why, cardId, state: 'staged', createdAt: this.now(), expiresAt: this.now() + PLAN_TTL_MS,
      startedAt: null, endedAt: null, stop: false, undone: false, note: '',
      steps: steps.map((s) => ({ ...s, state: 'waiting', note: '', undo: null })),
    };
    this.plans.set(p.id, p);
    if (this.plans.size > 200) this.plans.delete(this.plans.keys().next().value);
    return p;
  }

  get(id) { return typeof id === 'string' && PLAN_ID.test(id) ? this.plans.get(id) || null : null; }

  list() { return [...this.plans.values()]; }

  /** The computers the plan acts on ("this" when none is named). */
  static computersOf(plan) { return [...new Set(plan.steps.map((s) => (s.args && s.args.computer) || LOCAL))]; }

  /** Why a plan cannot start now (one plan running per computer, three in all), or null. */
  busy(plan) {
    const running = this.list().filter((p) => p.state === 'running' && p.id !== plan.id);
    if (running.length >= AT_ONCE) return `${AT_ONCE} plans are running already, the most at once`;
    const mine = PlanStore.computersOf(plan);
    for (const c of mine) if (running.filter((p) => PlanStore.computersOf(p).includes(c)).length >= PER_COMPUTER) return `a plan is running on ${c === LOCAL ? 'this computer' : c} already; one at a time`;
    return null;
  }

  /** The owner stops it: the step that runs ends, then the plan stops and takes back what it did. */
  stop(id) {
    const p = this.get(id);
    if (!p || p.state !== 'running') return false;
    p.stop = true;
    return true;
  }
}

const sleepOf = (ms) => new Promise((r) => setTimeout(r, ms));
const note = (e) => String((e && e.message) || e || 'it failed').slice(0, 160);

/**
 * Run a plan after the owner's tap. One step at a time, each checked again by the server (adapter.answer, then adapter.run
 * at its route). A step with a wait then holds, reading the fact every `pollMs` until it is met or its minutes are up. A
 * step that fails, a wait that runs out, a step that became the owner's own and the owner's stop end the plan: what was done
 * is taken back in reverse (only steps with an undo), then the plan says what it did and what it could not take back.
 * `audit`: a line per step with the plan id. Resolves with the plan when it has ended.
 */
export async function runPlan(plan, adapter, { audit = null, now = Date.now, sleep = sleepOf, pollMs = POLL_MS } = {}) {
  plan.state = 'running';
  plan.startedAt = now();
  const log = (s, outcome, extra = {}) => audit && audit.append({ actor: 'owner', conversation: plan.conversation, tool: 'plan_acts', level: 'L2', input: { plan: plan.id, step: s.n, act: s.act }, outcome, card: plan.cardId || undefined, ...extra });
  let failed = null;
  for (const s of plan.steps) {
    if (plan.stop) { failed = { s, why: 'you stopped the plan' }; break; }
    s.state = 'running';
    try {
      // The server again, at this moment: a step that became the owner's own is not done.
      const row = adapter.row(s.act);
      const answer = row ? adapter.answer(row, s.args) : 'none';
      if (answer === 'open' || answer === 'none') throw new Error('this step is now the owner\'s own, so the plan stops');
      const r = await adapter.run(s.act, s.args, { plan: plan.id, step: s.n, via: 'plan' });
      if (!r || r.ok === false) throw new Error((r && r.summary) || 'the act did not run');
      s.undo = r.undo ?? null;
      s.note = String(r.summary || '').slice(0, 160);
      log(s, 'done');
    } catch (e) {
      s.state = 'failed';
      s.note = note(e);
      log(s, 'failed', { error: s.note });
      failed = { s, why: s.note };
      break;
    }
    if (s.wait) {
      s.state = 'holding';
      const until = now() + s.wait.minutes * 60_000;
      let met = false;
      for (;;) {
        if (plan.stop) break;
        try { met = waitMet(s.wait.until, await adapter.fact(s.wait.fact, s.wait.args || {})); } catch { met = false; }
        if (met || now() >= until) break;
        await sleep(Math.min(pollMs, Math.max(0, until - now())));
      }
      if (!met) {
        s.state = 'failed';
        s.note = plan.stop ? 'you stopped the plan' : `it did not happen within ${s.wait.minutes} minutes`;
        log(s, 'failed', { error: s.note });
        failed = { s, why: s.note };
        break;
      }
    }
    s.state = 'done';
  }
  if (failed) {
    // Stopped: the steps not reached are skipped; what was done is taken back in reverse, each once.
    for (const s of plan.steps) if (s.state === 'waiting') s.state = 'skipped';
    const doneSteps = plan.steps.filter((s) => s.state === 'done' || (s !== failed.s && s.state === 'holding')).reverse();
    const toUndo = [...(failed.s.undo ? [failed.s] : []), ...doneSteps.filter((s) => s !== failed.s)];
    let left = 0;
    for (const s of toUndo) {
      if (s.undo === null || s.undo === undefined) { if (s !== failed.s && s.answer !== 'read') left++; continue; }
      try {
        const r = await adapter.undo(s.undo, { plan: plan.id, step: s.n, via: 'plan' });
        if (!r || r.ok === false) throw new Error((r && r.summary) || 'not taken back');
        if (s !== failed.s) s.state = 'undone';
        log(s, 'undone');
      } catch (e) {
        s.state = 'undo-failed';
        s.note = note(e);
        left++;
        log(s, 'undo-failed', { error: s.note });
      }
    }
    // A step that ran and was not taken back stays "done": the plan says how many it could not.
    plan.state = plan.stop ? 'stopped' : 'failed';
    plan.note = `${failed.why}.${left ? ` ${left} step${left === 1 ? '' : 's'} could not be taken back.` : ''}`.slice(0, 200);
    plan.undone = true;
  } else {
    plan.state = 'done';
  }
  plan.endedAt = now();
  return plan;
}

/**
 * The adapter for the product's own acts file: rows and answers come from acts.json (answer from the row's facts, with the
 * fact "other" turned on by a step that names another computer, never off). `run`, `undo` and `fact` are the dashboard's:
 * the same functions the catalog tools use for one act, so a step is checked at its route like an act done alone. Without
 * them a step cannot run, and says so.
 */
export function actsAdapter({ rows = loadActs().rows, run, undo, fact, before, backOf } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = (what) => { throw new Error(`this build cannot ${what} an act by its id yet`); };
  return {
    row: (id) => byId.get(id),
    answer(row, args = {}) {
      if (row.kind === 'not-an-act' || !row.facts) return 'none';
      const other = args.computer && args.computer !== LOCAL;
      return rowAnswer({ ...row, facts: raiseFacts(row.facts, other ? { other: true } : {}) });
    },
    run: run || (() => missing('run')),
    undo: undo || (() => missing('take back')),
    fact: fact || (() => missing('read')),
    ...(before ? { before } : {}),
    ...(backOf ? { backOf } : {}),
  };
}
