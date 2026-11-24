// What Tia keeps of the owner's corrections (src/operator/corrections.mjs): the switch under "Tia acts by herself",
// "Forget these" and "Use these as evidence", and the few words each place where he decides shows ("you took this back
// 3 times this week" under a rule, "sent back 4 of 9" under a role, per skill on the Skills page). Nothing changes by
// itself from them. Every press is his: the routes answer his own page only.
import { api, confirmSheet, h, machine, toast } from './lib.js';
import { toggle } from './shell.js';

const A = '/api/operator';

export const CORRECTIONS_WORDS = 'When you decline her card, press Undo on her act, send a mission\'s task back with words, change her plan before you accept it, pick another step than the one she recommended, or lift her hold, she keeps one small record of it (with your own words, at most 500 characters), for 90 days, on this computer only. Nothing changes by itself from them: they are shown where you decide. At most 200 in 24 hours, no cost. Off until you turn it on.';

/** "you took this back 3 times this week", or null when none. */
export const tookBack = (n) => (n ? `You took this back ${n} time${n === 1 ? '' : 's'} this week.` : null);
/** "sent back 4 of 9", or null when none. */
export const sentBackWords = (n, of) => (n ? `You sent back ${n} of ${of} this week.` : null);
/** This week's corrections that take back an act of "Tia decides": an Undo of her decision, a hold of hers lifted. */
export const decisionCount = (c) => ((c && c.decisionKinds) ? (c.decisionKinds.undo || 0) + (c.decisionKinds['hold-lifted'] || 0) : 0);
const times = (n) => `${n} time${n === 1 ? '' : 's'}`;
/** This week's other corrections of hers, each under its own name (none of them is an act of "Tia decides"). */
export function otherCorrections(c) {
  const k = (c && c.decisionKinds) || {};
  return [
    k['other-answer'] ? `Her recommended step: you picked another ${times(k['other-answer'])} this week.` : null,
    k.declined ? `Her confirm cards in a chat: you declined them ${times(k.declined)} this week.` : null,
    k['plan-changed'] ? `Her plans: you changed them before you accepted them ${times(k['plan-changed'])} this week.` : null,
  ].filter(Boolean);
}

/** The part of the Tia panel for the corrections. `v`: the settings view (with v.corrections). */
export function correctionsPart(v, after) {
  const c = v.corrections;
  if (!c) return null;
  const count = `Kept now: ${c.total} (${c.weekTotal} this week).`;
  if (machine.current) return h('div.op-decide', h('p.hint', `${c.on ? 'On' : 'Off'}: Tia keeps your corrections. ${count} Change this on that computer's own dashboard.`));
  const row = toggle('Tia keeps your corrections', c.on, async (on) => {
    try {
      await api(`${A}/settings`, { corrections: { on } });
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
      after('corrections');
      return false;
    }
    after('corrections');
  }, CORRECTIONS_WORDS);
  const input = row.querySelector('input');
  input.dataset.focus = 'corrections';
  input.setAttribute('aria-label', 'Tia keeps your corrections');
  const forget = h('button.btn.small.secondary', { type: 'button', dataset: { focus: 'corrections-forget' }, disabled: !c.total, onclick: async () => {
    if (!(await confirmSheet({ title: 'Forget your corrections?', text: `All ${c.total} records go, and so does the evidence file written from them by "Use these as evidence". This cannot be undone.`, ok: 'Forget these', danger: true }))) return;
    try {
      toast((await api(`${A}/corrections/forget`, {})).said, { kind: 'ok' });
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
    }
    after('corrections-forget');
  } }, 'Forget these');
  const evidence = h('button.btn.small.secondary', { type: 'button', dataset: { focus: 'corrections-evidence' }, disabled: !c.total, onclick: async () => {
    try {
      toast((await api(`${A}/corrections/evidence`, {})).said, { kind: 'ok', ms: 9000 });
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
    }
    after('corrections-evidence');
  } }, 'Use these as evidence');
  return h('div.op-decide', row, h('p.hint.op-decide-cost', count), otherCorrections(c).map((l) => h('p.op-his.op-corrected', l)),
    h('p.hint.op-decide-cost', '"Use these as evidence" writes those about skills into one file for the improvement loop; those about rules, decisions and roles are not its targets. It does not start the loop.'),
    // Where the evidence is, after the toast that said it has gone: home shown as ~.
    c.evidence ? h('p.hint.op-decide-cost', `Evidence written: ${c.evidence.lines} line${c.evidence.lines === 1 ? '' : 's'} in ${c.evidence.file}, for the improvement loop (not started).`) : null,
    h('div.op-note-row', forget, evidence));
}
