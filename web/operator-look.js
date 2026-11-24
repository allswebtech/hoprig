// "Tia looks into it" (src/operator/look.mjs): the owner's switch under "Tia acts by herself", what one look costs
// before he turns it on (an estimate with its basis), its limits and today's count; and on an item of the kind unknown,
// the finding of its look as a card for him, the session's own words shown as such, with "Make it a task" (his tap only:
// POST /api/operator/look/task answers his own page and nothing else).
import { add, api, confirmSheet, h, machine, toast } from './lib.js';
import { toggle } from './shell.js';
import { modelName, money as usd } from './chat/words.js';
import { clock } from './operator-decide.js';

const A = '/api/operator';

/** What a look does, in the words of the switch. */
export const LOOK_WORDS = 'When a run fails for a reason nobody can explain, she starts one look into it: a session on the strongest model your provider serves (Opus or Fable) that can only read the project (Read, Glob, Grep), never change it. What it finds is a card for you; only you can make it a task. At most one look per item. Off until you turn it on.';

/** What one look costs, said as an estimate with its basis; "not measured" when there is no measurement. */
export function lookCostWords(l) {
  const e = l.estimate || {};
  const price = e.prices ? ` ($${e.prices.input} a million input tokens and $${e.prices.output} a million output tokens, the list prices read on ${e.prices.read})` : '';
  const basis = e.tokens ? `${e.tokens.toLocaleString('en')} tokens counted on a real look on ${e.measuredModel} (${e.measuredOn}), priced at the list price of ${e.model}${price}; a look on ${e.model} may read and think more` : null;
  // The cap a look is started with is what is left of the day's dollars (look.mjs startOne): said beside the estimate.
  const left = Math.max(0, (l.dollarsPerDay || 0) - ((l.today && l.today.dollars) || 0));
  const cap = ` One look may spend at most ${usd(left)}: what is left of the ${usd(l.dollarsPerDay || 0)} of the last 24 hours.`;
  // runsOn.label: the provider as the Providers page names it (an older server hands none: its short name).
  // The model as the model picker names it ("Opus"); Auto mode as the Providers page names it.
  const by = l.runsOn && (l.runsOn.label || (l.runsOn.provider === 'auto' ? 'Auto mode' : l.runsOn.provider));
  const on = l.runsOn ? ` A look now runs on ${modelName(l.runsOn.model)} of ${by}.` : '';
  if (e.usd != null && basis) return `One look costs about ${usd(e.usd)} (an estimate: ${basis}).${on}${cap} What each look really cost is shown on its card.`;
  return `What one look costs is not known yet${e.unknown && e.unknown.length ? ` (${e.unknown.join(', ')})` : ''}.${on}${cap} What each look really cost is shown on its card.`;
}
/** "In the last 24 hours: 1 of 2 looks, $0.42 of $3.00." (the count is a rolling day, not the calendar day), with the
 * part of it held back as a budget, not spent; or why none starts. */
export function lookToday(l) {
  if (l.frozen === 'unread') return 'Her record of looks could not be read: she starts no look for a day from her next try.';
  if (l.frozen) return `Her record of looks could not be read: she starts none until ${clock(l.frozen)}.`;
  const held = l.today.reserved ? ` Of it, ${usd(l.today.reserved)} is not spent but held back: the whole budget of a look that is running or whose coding tool reported no cost.` : '';
  return `In the last 24 hours: ${l.today.looks} of ${l.perDay} looks, ${usd(l.today.dollars)} of ${usd(l.dollarsPerDay)}.${held}`;
}

export const confirmLook = (l) => confirmSheet({ title: 'Let Tia look into what nobody can explain?', text: `${LOOK_WORDS} ${lookCostWords(l)}`, ok: 'Let her look' });

function limitsForm(l, after) {
  const box = h('details.op-limits', h('summary', { 'aria-label': 'Change the limits of the looks', dataset: { focus: 'look-limits' } }, 'Change the limits'));
  const input = (key, label, min, max, step) => h('label.op-limit', h('span', label), h('input.field', { type: 'number', min, max, step, value: l[key], 'data-key': key, inputmode: 'decimal' }));
  const save = h('button.btn.small.secondary', { type: 'button', onclick: async () => {
    const b = {};
    for (const el of box.querySelectorAll('input[data-key]')) b[el.dataset.key] = Number(el.value);
    try {
      await api(`${A}/settings`, { look: b });
      toast('Limits saved.', { kind: 'ok' });
      after('look-limits');
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
    }
  } }, 'Save the limits');
  add(box, h('div.op-limit-row', input('perDay', 'Looks a day', 1, 20, 1), input('dollarsPerDay', 'Dollars a day', 0.5, 50, 0.5)), save);
  return box;
}

/** The part of the Tia panel for the looks. `v`: the settings view (with v.look). */
export function lookPart(v, after, { confirm = confirmLook } = {}) {
  const l = v.look;
  if (!l) return null;
  if (machine.current) return h('div.op-decide', h('p.hint', `${l.on ? 'On' : 'Off'}: Tia looks into what nobody can explain. ${lookToday(l)} Change this on that computer's own dashboard.`));
  const row = toggle('Tia looks into what nobody can explain', l.on, async (on) => {
    if (on && !(await confirm(l))) {
      after('look');
      return false;
    }
    try {
      await api(`${A}/settings`, { look: { on } });
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
      after('look');
      return false;
    }
    after('look');
  }, `${LOOK_WORDS} She looks only while "Tia acts by herself" is on.`);
  const input = row.querySelector('input');
  input.dataset.focus = 'look';
  input.setAttribute('aria-label', 'Tia looks into what nobody can explain');
  return h('div.op-decide', row, l.cannot ? h('p.hint.op-look-cannot', `No look can start now: ${l.cannot}.`) : null, h('p.hint.op-decide-cost', lookCostWords(l)), h('p.hint.op-decide-cost', lookToday(l)), limitsForm(l, after));
}

/** Why a finding is not counted, in one sentence for someone who is not a programmer (the reason itself stays below). */
export function notCountedWords(why) {
  const w = String(why || '');
  if (/commit|changed/.test(w)) return 'The look was only allowed to read the project, but its copy of the project was changed, so Hoprig cannot vouch for what it found. That copy is kept for you to look at.';
  return 'Hoprig could not make sure the look left its copy of the project as it was, so it cannot vouch for what it found.';
}

/** What the look found, for the card of its item; null when there was no look. `f`: the server's findings[item]. */
export function findingPart(it, f, done) {
  if (!f) return null;
  if (f.state === 'running') return h('p.op-look', { role: 'status' }, 'Tia is looking into it now (a session that only reads).');
  if (f.state === 'waits') return h('p.op-look', { role: 'status' }, `Tia's look waits while your session on ${f.on} works.`);
  const tokens = f.tokens ? `${f.tokens.toLocaleString('en')} tokens` : null;
  // No reported dollars: the tokens it reported are still said, and that the day's count held back its whole budget.
  const cost = f.cost != null ? `It cost ${usd(f.cost)}${tokens ? ` and ${tokens}` : ''}, as the coding tool reported.`
    : `Its coding tool reported no cost${tokens ? ` (it reported ${tokens})` : ''}, so the day's count holds back this look's whole budget.`;
  const g = f.finding;
  const head = h('p.op-look-head', 'What Tia\'s look found');
  if (!g) return h('div.op-look', head, h('p.hint', `It found nothing that counts: ${f.fault || 'it gave no finding'}.`), h('p.hint', cost));
  const where = g.where.map((w) => (w.line ? `${w.file}:${w.line}` : w.file)).join(', ');
  const canMake = !f.task && f.counted && g.cause !== 'not found' && !machine.current;
  const made = (title) => h('p.hint', 'It is a task in Work now: ', h('a', { href: '#/work/tasks' }, title || 'open your tasks'), '.');
  const make = f.task ? made(f.taskTitle)
    : canMake ? h('button.btn.small.secondary', { type: 'button', 'aria-label': `Make it a task: ${it.subject}`, onclick: async (e) => {
      e.currentTarget.disabled = true;
      try {
        const r = await api(`${A}/look/task`, { item: it.id });
        toast(`It is a task in Work now: ${(r.finding && r.finding.taskTitle) || 'see Work, Tasks'}.`, { kind: 'ok' });
      } catch (err) {
        toast(err.message, { kind: 'error', ms: 6000 });
      }
      done();
    } }, 'Make it a task') : null;
  return h('div.op-look',
    head,
    // The session's own words: shown as what it said, never as Hoprig's.
    // Not counted: the look's copy of the project changed (or could not be looked at), so nothing above is vouched for.
    f.counted ? null : h('p.op-look-head', 'Not checked: Hoprig cannot vouch for what follows'),
    f.counted ? null : h('p.hint.op-look-why', notCountedWords(f.notCounted)),
    h('blockquote.op-look-said',
      h('p', h('strong', 'Cause: '), g.cause),
      where ? h('p', h('strong', 'Where: '), where) : null,
      g.mend ? h('p', h('strong', 'What would mend it: '), g.mend) : null,
      h('p', h('strong', 'How sure: '), g.sure)),
    h('p.hint', `These are the words of a session of Tia's. ${f.counted ? 'It changed nothing.' : `For a programmer: ${f.notCounted}.`} ${cost}`),
    canMake ? h('p.hint', 'Make it a task adds this mend to your Work tasks. Nothing runs until you start it; Tia does not mend it by herself.') : null,
    make);
}
