// "Tia decides" (src/operator/decider.mjs): the owner's switch under "Tia acts by herself", what one decision may do,
// its budgets and what today cost, the hold on new starts with its one button, and a project's standing note (on the
// project's page). Every change is the owner's: POST /api/operator/settings and /hold answer only his own page.
import { add, api, confirmSheet, fill, h, machine, toast } from './lib.js';
import { toggle } from './shell.js';

const A = '/api/operator';
const NOTE_MAX = 500;

/** What "Tia decides" may do, in the words the switch and Settings say. */
export const DECIDE_WORDS = 'When something new needs you (a session at a usage limit, a session with no progress, a question in a Hands-off session, a gateway or the public link that does not answer, an overloaded computer), she asks a small model once to pick one of the steps prepared for it, or to leave it to you. Off until you turn it on.';

/** What one decision costs, as measured on a real model (Claude Code adds its own parts to the short prompt). */
export const COST_WORDS = 'Each decision counts about 3,400 tokens of the provider she uses (measured: 3,434 on average, 3,716 at most), within the limits below (by default 30 decisions and 125,000 tokens a day), and is written under Done by Tia with its reason.';
/** What the switch for missions lets her decide, and what it costs. */
export const MISSION_WORDS = 'When a task of a mission reaches a usage limit, or waits until a time, she picks the next provider of your order or the wait, by the same kind of decision (about 3,500 tokens each: measured 3,514 on average, 3,589 at most, over 30 calls on the cheapest model). A task sent back twice stays yours. Off until you turn it on.';
/** "2 of 10 mission decisions today". */
export const missionWords = (d) => `Today: ${d.today.missions || 0} of ${d.missionsPerDay} mission decisions (they count among the decisions above too).`;

/** Where his standing note is written. */
export const NOTE_PLACE = 'You can tell her how to decide for a project on its page, under Advanced → How Tia decides here (up to 500 characters).';

/** His tick beside the note: the only thing that lets a decision end a stuck session in the project (offeredSteps). */
export const MAY_END = 'Tia may end a stuck session in this project';
export const MAY_END_HINT = 'With it on, she may end a stuck session here when your note says when; off, she never ends one.';

export const confirmDecide = () => confirmSheet({ title: 'Let Tia decide?', text: `${DECIDE_WORDS} ${COST_WORDS} ${NOTE_PLACE}`, ok: 'Let her decide' });

// One clock for the page and the server's lines (src/operator/detect/util.mjs clock): UTC, "14:00 UTC", and with its
// date when it is 20 hours or more away, so a time a day from now never reads as now or as past.
export const clock = (iso, now = Date.now()) => {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const d = new Date(t).toISOString();
  return Math.abs(now - t) < 20 * 3600_000 ? `${d.slice(11, 16)} UTC` : `${d.slice(0, 10)} ${d.slice(11, 16)} UTC`;
};
const hhmm = (iso) => clock(iso);
/** Whose hold it is, in the words of the line on the page. */
export const holdLine = (d) => `New sessions and chats are held until ${hhmm(d.held)}: ${d.heldBy === 'owner' ? 'you held them' : d.heldBy === 'both' ? 'you held them, and Tia did because the computer was overloaded' : 'Tia held them because the computer was overloaded'}.`;

/** A saved model a decision may not use: said, with what she uses instead and where to change it. */
export const refusedWords = (d) => `The model saved for her decisions, "${d.modelRefused}", is not a small model (of the haiku or sonnet family), so she decides with haiku, the cheapest, until it is changed in Settings.`;
/** "3 of 30 decisions today, 2,400 of 30,000 tokens"; while her record of decisions could not be read, that instead. */
export const costWords = (d) => (d.frozen ? `Her record of decisions could not be read: she makes none until ${hhmm(d.frozen)}.` : todayWords(d));
const todayWords = (d) => `Today: ${d.today.calls} of ${d.perDay} decisions (${d.today.hour} of ${d.perHour} this hour), ${d.today.tokens.toLocaleString('en')} of ${d.tokensPerDay.toLocaleString('en')} tokens.`;

function budgetForm(d, after) {
  const box = h('details.op-limits', h('summary', { 'aria-label': 'Change the limits of Tia decides', dataset: { focus: 'decide-limits' } }, 'Change the limits'));
  const input = (key, label, min, max) => h('label.op-limit', h('span', label), h('input.field', { type: 'number', min, max, step: 1, value: d[key], 'data-key': key, inputmode: 'numeric' }));
  const save = h('button.btn.small.secondary', { type: 'button', onclick: async () => {
    const b = {};
    for (const el of box.querySelectorAll('input[data-key]')) b[el.dataset.key] = Number(el.value);
    try {
      await api(`${A}/settings`, { decide: b });
      toast('Limits saved.', { kind: 'ok' });
      after('decide-limits');
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
    }
  } }, 'Save the limits');
  add(box, h('div.op-limit-row', input('perHour', 'Decisions an hour', 1, 60), input('perDay', 'Decisions a day', 1, 500), input('tokensPerDay', 'Tokens a day', 1000, 1000000), input('missionsPerDay', 'Mission decisions a day', 1, 200)), save);
  return box;
}

/** The part of the Tia panel for "Tia decides". `v`: the settings view (with v.decide). */
export function decidePart(v, after, { confirm = confirmDecide } = {}) {
  const d = v.decide;
  if (!d) return null;
  const held = d.held ? h('div.op-hold', { role: 'status' },
    h('span', holdLine(d)),
    machine.current ? null : h('button.btn.small.secondary', { type: 'button', dataset: { focus: 'lift-hold' }, onclick: async () => {
      try {
        await api(`${A}/hold`, {});
        toast('The hold is lifted.', { kind: 'ok' });
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
      }
      after('decide');
    } }, 'Lift the hold')) : null;
  if (machine.current) return h('div.op-decide', h('p.hint', `${d.on ? 'On' : 'Off'}: Tia decides. ${costWords(d)} Change this on that computer's own dashboard.`), held);
  const row = toggle('Tia decides', d.on, async (on) => {
    if (on && !(await confirm())) {
      after('decide');
      return false;
    }
    try {
      await api(`${A}/settings`, { decide: { on } });
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
      after('decide');
      return false;
    }
    after('decide');
  }, `${DECIDE_WORDS} She works only while "Tia acts by herself" is on. ${NOTE_PLACE}`);
  const input = row.querySelector('input');
  input.dataset.focus = 'decide';
  input.setAttribute('aria-label', 'Tia decides');
  const hint = row.querySelector('span.hint');
  if (hint) {
    hint.id = 'op-hint-decide';
    input.setAttribute('aria-describedby', hint.id);
  }
  // A mission's choices: a switch of its own, under "Tia decides" (it works only while that is on).
  const missions = toggle('Also a mission\'s choices', !!d.missions, async (on) => {
    try {
      await api(`${A}/settings`, { decide: { missions: on } });
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
      after('decide-missions');
      return false;
    }
    after('decide-missions');
  }, `${MISSION_WORDS} It works only while "Tia decides" is on.`);
  const mi = missions.querySelector('input');
  mi.dataset.focus = 'decide-missions';
  mi.setAttribute('aria-label', 'Tia decides a mission\'s choices too');
  return h('div.op-decide', row, d.modelRefused ? h('p.hint.op-decide-model', refusedWords(d)) : null, h('p.hint.op-decide-cost', costWords(d)), missions, d.frozen ? null : h('p.hint.op-decide-cost', missionWords(d)), budgetForm(d, after), held);
}

/** A project's page: his standing note for her decisions in this project. */
export async function projectNoteBox(box, ref) {
  let n;
  try {
    n = await api(`${A}/note?project=${encodeURIComponent(ref)}`);
  } catch {
    return fill(box); // an older computer
  }
  const id = `op-note-${Math.random().toString(36).slice(2, 8)}`;
  const count = h('span.hint', { id: `${id}-count`, 'aria-live': 'polite' });
  const said = h('p.hint', { 'aria-live': 'polite' });
  const area = h('textarea.field.op-note', { id, rows: 3, maxlength: NOTE_MAX, value: n.text, 'aria-describedby': `${id}-hint ${id}-count`, readonly: !!machine.current, oninput: () => paint() });
  const paint = () => (count.textContent = `${area.value.length} of ${NOTE_MAX} characters`);
  paint();
  // The tick, as stored (an older computer sends none: then it is not shown, and the note is saved without it). It is
  // saved at once with the note's saved words, so a note being written is not saved by a tap on the tick; "Save the
  // note" always sends it as it stands.
  const hasTick = typeof n.mayEnd === 'boolean';
  let mayEnd = n.mayEnd === true;
  let saved = n.text;
  const endSaid = h('p.hint', { 'aria-live': 'polite' });
  const tick = hasTick ? h('input', { type: 'checkbox', id: `${id}-end`, checked: mayEnd, disabled: !!machine.current, 'aria-describedby': `${id}-end-hint`, dataset: { key: 'may-end' }, onchange: async (e) => {
    const want = e.target.checked === true;
    try {
      const r = await api(`${A}/settings`, { note: { project: ref, text: saved, mayEnd: want } });
      mayEnd = r.note.mayEnd === true;
      saved = r.note.text;
      e.target.checked = mayEnd;
      endSaid.textContent = mayEnd ? 'Saved: she may end a stuck session here.' : 'Saved: she never ends a session here.';
    } catch (err) {
      e.target.checked = mayEnd;
      toast(err.message, { kind: 'error', ms: 6000 });
    }
  } }) : null;
  const save = machine.current ? null : h('button.btn.small.secondary', { type: 'button', onclick: async () => {
    try {
      const r = await api(`${A}/settings`, { note: { project: ref, text: area.value, ...(hasTick ? { mayEnd } : {}) } });
      area.value = r.note.text;
      saved = r.note.text;
      if (hasTick) mayEnd = r.note.mayEnd === true;
      paint();
      said.textContent = r.note.cleaned ? 'Saved. Characters nobody can see were taken out of it.' : 'Saved.';
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
    }
  } }, 'Save the note');
  fill(box,
    h('label.field-label', { for: id }, 'How Tia decides here'),
    h('p.hint', { id: `${id}-hint` }, `Your words to her, for this project: how you want such things decided ("wait for a short reset", "ask me before stopping a session"). She reads them before each decision and can never change them.${machine.current ? ' Change this on that computer\'s own dashboard.' : ''}`),
    area, h('div.op-note-row', count, save), said,
    tick ? h('div.op-may-end', h('label.check', { for: `${id}-end` }, tick, h('span', MAY_END)), h('p.hint', { id: `${id}-end-hint` }, MAY_END_HINT), endSaid) : null);
}
