// plan_acts (design 2.1 tool 4): two or more acts of the product as ONE card. Every step is an act of acts.json; a step that
// is the owner's own (the never list) refuses the plan with her words for it. The owner taps once on the card; then the
// runner (plans.mjs) does the steps one by one, each checked again by the server at its route as if tapped alone, and the
// card follows it. A plan of reads only runs at once. A plan never confirms itself and never by voice: run refuses to start
// a plan that has a step to change anything unless the owner's confirmed card for exactly this plan is running it.
import { confirmedCard } from './confirmed.mjs';
import { PlanStore, WAIT_MINUTES, WAIT_UNTIL, MAX_STEPS, actsAdapter, checkPlan, runPlan } from './plans.mjs';
import { anyJson, arr, int, obj, str } from './schema.mjs';
import { actShown, picksShown } from './catalogtools.mjs';
import { tool, toolError } from './toolkit.mjs';
import { STARTS } from './herbody.mjs';
import { LOCAL } from './shown.mjs';

let own = null;
const adapterOf = (ctx) => (ctx && ctx.acts) || (own ||= actsAdapter());
/** " on <computer>" for a wait that reads another computer (the card shows where it looks). */
const waitOn = (w) => (w.args && w.args.computer && w.args.computer !== 'this' ? ` on ${w.args.computer}` : '');
/** What a wait reads, as the door binds it: the fact, its computer, its ids and query values, its condition and its time limit. */
export function waitWords(w) {
  const a = w.args && typeof w.args === 'object' ? w.args : {};
  const bits = [];
  for (const k of ['target', 'target2', 'target3', 'variant']) if (a[k] !== undefined) bits.push(`${k} ${a[k]}`);
  const q = a.query && typeof a.query === 'object' ? a.query : {};
  for (const k of Object.keys(q)) bits.push(`${k} ${typeof q[k] === 'string' ? q[k] : JSON.stringify(q[k])}`);
  return `${w.minutes} min${waitOn(w)} until ${w.fact}${bits.length ? ` (${bits.join(', ')})` : ''} shows ${w.until}`;
}
const readOnly = (steps) => steps.every((s) => s.answer === 'read');

const STEP = obj({
  act: str({ max: 64, pattern: /^[A-Za-z0-9._-]+$/, quiet: true, desc: 'An act id from find_acts.' }),
  args: anyJson({ desc: 'The act\'s own input, as find_acts showed it (strict).' }),
  wait: obj({
    fact: str({ max: 64, pattern: /^[A-Za-z0-9._-]+$/, quiet: true, desc: 'A read act to watch after this step.' }),
    until: str({ enum: WAIT_UNTIL, full: true }),
    minutes: int({ min: WAIT_MINUTES.min, max: WAIT_MINUTES.max, desc: 'The time limit.' }),
    args: anyJson({ desc: 'Input of that read act.' }),
  }, { required: ['fact', 'until', 'minutes'] }),
}, { required: ['act'] });

/** A step that starts work names a provider she may use (her own start_chat picks only among them): checked before the card and at the tap. */
async function onlyHerProviders(a, ctx) {
  if (!ctx || typeof ctx.tia !== 'function') return;
  for (const [i, s] of (Array.isArray(a.steps) ? a.steps : []).entries()) {
    const keys = s && STARTS[s.act];
    if (!keys) continue;
    const there = (s.args && s.args.computer) || LOCAL;
    const allowed = ((await ctx.tia(there)) || {}).allowed || [];
    for (const [j, key] of keys.entries()) {
      const v = s.args && s.args[key];
      if (v === undefined && j > 0) continue;
      for (const name of Array.isArray(v) ? v : [v]) {
        if (typeof name !== 'string' || !allowed.includes(name)) throw toolError(`step ${i + 1}: ${typeof name === 'string' ? `the provider "${name}" is not one the owner allowed for her` : 'a start names the provider it runs on'}`, 'call get_computer_status with providers: true for the allowed ones, and name one of them in the step');
      }
    }
  }
}

/** The steps of a plan as the card and the server both read them (words from the rows; nothing from the model). */
export function described(a, adapter) {
  const r = checkPlan(a, adapter);
  return r.steps || [];
}

/** The values a step sends, one line each, as the run sends them (the card shows them, so the tap is for exactly these). */
const valueLines = (s) => Object.entries(s.args || {}).map(([k, v]) => `  ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

export const plan_acts = tool({
  name: 'plan_acts',
  level: 'L2',
  card: 'maybe',
  description: `Do two or more acts as ONE card he taps once (steps run in order; a step may wait, at most ${WAIT_MINUTES.max} min, for a read act to show done, idle, back or answers; one that fails stops the plan and takes back what was done). Use it when the ask needs two or more acts; find_acts gives the ids. A step that is his own is refused with the words to say. Reads only: runs at once.`,
  input: obj({
    title: str({ max: 80, oneLine: true, desc: 'What the plan does, in a few plain words.' }),
    steps: arr(STEP, { min: 2, max: MAX_STEPS }),
    why: str({ max: 200, desc: 'His ask, shown on the card.' }),
  }, { required: ['title', 'steps'] }),
  levelOf(a) {
    const r = checkPlan(a, adapterOf());
    return r.steps && readOnly(r.steps) ? 'L0' : 'L2';
  },
  check(a, ctx) {
    for (const s of Array.isArray(a.steps) ? a.steps : []) {
      actShown(ctx, s.act);
      picksShown(ctx, s.args, s.args && s.args.computer);
      if (s.wait) {
        actShown(ctx, s.wait.fact);
        picksShown(ctx, s.wait.args, s.wait.args && s.wait.args.computer);
      }
    }
    const r = checkPlan(a, adapterOf(ctx));
    if (r.refused) {
      const x = r.refused[0];
      throw toolError(`step ${x.n} (${x.act}) is the owner's own, so it cannot be in a plan: ${x.say}`, 'tell the owner that line, with its button; plan the other steps again without it if he still wants them');
    }
    if (r.problems) throw toolError(r.problems[0], 'fix that step and call plan_acts again; find_acts gives act ids and what each takes');
  },
  async before(ops, a, ctx) {
    await onlyHerProviders(a, ctx);
    const adapter = adapterOf(ctx);
    const steps = described(a, adapter);
    return { title: a.title, steps: await Promise.all(steps.map(async (s) => ({ n: s.n, act: s.act, args: s.args, answer: s.answer, what: s.what, changes: s.changes, ...(s.wait ? { wait: s.wait } : {}), ...(adapter.before ? { rests: await adapter.before(s) } : {}) }))) };
  },
  cardLines: (a, b) => [`Plan: ${a.title}`, ...b.steps.flatMap((s) => [`Step ${s.n}: ${s.what}. ${s.changes}${s.wait ? ` Then it waits up to ${waitWords(s.wait)}.` : ''}`, ...valueLines(s)]), ...(a.why ? [`Why: ${a.why}`] : [])],
  // The values the card's page draws as one list (web/tiacards.js planSteps): from the rows, never from her words.
  cardView: (a, b) => ({ title: a.title, why: a.why || '', steps: b.steps.map((s) => ({ n: s.n, what: s.what, changes: `${s.changes}${valueLines(s).length ? ` ${valueLines(s).map((l) => l.trim()).join('; ')}` : ''}`, ...(s.wait ? { wait: waitWords(s.wait) } : {}) })) }),
  async run(ops, a, ctx) {
    await onlyHerProviders(a, ctx);
    const adapter = adapterOf(ctx);
    const r = checkPlan(a, adapter);
    if (!r.steps) throw toolError((r.refused ? `step ${r.refused[0].n} is the owner's own: ${r.refused[0].say}` : r.problems[0]), 'fix the plan and call plan_acts again');
    // Only his tap on this plan's own card starts a plan that changes anything.
    if (!readOnly(r.steps)) {
      const c = confirmedCard();
      if (!c || c.tool !== 'plan_acts' || JSON.stringify(c.input.steps) !== JSON.stringify(a.steps)) throw toolError('a plan that changes something starts only on the owner\'s tap on its card', 'call plan_acts so a card is made, and wait for his tap');
    }
    const plans = ctx.plans || (ctx.plans = new PlanStore({ now: ctx.now }));
    const plan = plans.create({ conversation: ctx.conversation, title: a.title, why: a.why || '', steps: r.steps });
    const busy = plans.busy(plan);
    if (busy) {
      plans.plans.delete(plan.id);
      throw toolError(`the plan did not start: ${busy}`, 'tell the owner; try again when it has ended');
    }
    const running = runPlan(plan, adapter, { audit: ctx.audit, now: ctx.now });
    if (readOnly(r.steps)) await running;
    else running.catch(() => {}); // it runs on after his tap: the card follows it
    const snapshot = JSON.parse(JSON.stringify({ id: plan.id, title: plan.title, state: plan.state, steps: plan.steps, startedAt: plan.startedAt, endedAt: plan.endedAt, note: plan.note }));
    return {
      summary: plan.state === 'running' ? `Plan ${plan.id} runs: ${r.steps.length} steps, one at a time; the card shows where it is. You are told when it ends.` : `Plan ${plan.id} ${plan.state}.${plan.note ? ` ${plan.note}` : ''}`,
      data: { plan_id: plan.id, outcome: plan.state, steps: plan.steps.map((s) => ({ n: s.n, act: s.act, answer: s.answer, state: s.state, ...(s.undo ? { undo_id: typeof s.undo === 'string' ? s.undo : 'kept' } : {}) })) },
      cardData: { plan: snapshot },
      audit: { plan: plan.id, steps: r.steps.length },
    };
  },
});
