// The Operator page's part about what Tia does by herself (src/operator/reflex.mjs): the master switch "Tia acts" with
// one press that stops her ("Tia OFF"), the owner's standing rules (each a plain sentence, on or off, with its limits
// and what can be undone), and "Done by Tia" apart from "Done by you", with Undo where the act has one. Every change
// here is the owner's: POST /api/operator/settings, /off and /undo answer only his own page.
import { add, ago, api, confirmSheet, fill, h, machine, toast } from './lib.js';
import { fold, toggle } from './shell.js';
import { lookOthersSwitch } from './operator-rooms.js';
import { decidePart } from './operator-decide.js';
import { lookPart } from './operator-look.js';
import { correctionsPart, decisionCount, tookBack } from './operator-corrections.js';
import { placeLinks } from './operator-ways.js';

const A = '/api/operator';
const when = (iso) => (iso ? ago(Date.parse(iso)) : '');

/**
 * A switch of the owner's: `change(value)` returns false (or throws) when nothing changed on the server (a Cancel, a
 * refusal), and then the switch is put back as it was. `key` names it, so the focus can come back to it after a redraw.
 */
function sw(label, on, change, hint, key) {
  let input = null;
  const row = toggle(label, on, async (v) => {
    let r;
    try {
      r = await change(v);
    } catch {
      r = false;
    }
    if (r === false) input.checked = !v;
    return r;
  }, hint);
  input = row.querySelector('input');
  input.dataset.focus = key;
  // Its name is the sentence alone; the rest is its description (read after the name, not as part of it).
  input.setAttribute('aria-label', label);
  const more = row.querySelector('span.hint');
  if (more) {
    more.id = `op-hint-${key}`;
    input.setAttribute('aria-describedby', more.id);
  }
  return row;
}

// On another computer's page every change is refused there (it is the owner's, from that dashboard's own page): the
// panel is read only, and says where to change it.
const ELSEWHERE = 'Change this on that computer\'s own dashboard.';
const remote = () => !!machine.current;

/** "Let Tia act by herself?": asked before the master switch goes on, on the Operator page and in Settings alike. */
export const confirmActs = () => confirmSheet({ title: 'Let Tia act by herself?', text: 'She then does what the rules you switch on say, within their limits, without asking you. Every act is written under Done by Tia. Tia OFF stops her at once.', ok: 'Let her act' });

/** What a card says when a rule left the item to him; null when no rule did (or the item changed since). */
export function hisWords(it, reflexes) {
  const h0 = reflexes?.his?.[it.id];
  return h0 && (h0.rev === null || h0.rev === it.rev) ? h0.words : null;
}

/** The places his card's words name (codes of errorways.js), or null: the same picture of the item as hisWords. */
export function hisWays(it, reflexes) {
  const h0 = reflexes?.his?.[it.id];
  return h0 && (h0.rev === null || h0.rev === it.rev) && Array.isArray(h0.ways) ? h0.ways : null;
}

/** True when the item is his because a paid move does not fit Tia's daily limit for paid use: its card opens that limit. */
export function hisCap(it, reflexes) {
  const h0 = reflexes?.his?.[it.id];
  return !!h0 && h0.cap === true && (h0.rev === null || h0.rev === it.rev);
}

/** The words of one rule's limits. */
export const limitWords = (r) => `At most ${r.budget.perHour} acts an hour and ${r.budget.perDay} a day, ${r.budget.waitMinutes} min between two tries on the same thing; after two tries that did not help (it came back within the hour), it is yours. Left now: ${r.left.hour} this hour, ${r.left.day} today.`;

function limitsForm(r, after) {
  const box = h('details.op-limits', h('summary', { 'aria-label': `Change the limits of the rule: ${r.sentence}`, dataset: { focus: `limits-${r.id}` } }, 'Change the limits'));
  const input = (key, label, min, max) => h('label.op-limit', h('span', label), h('input.field', { type: 'number', min, max, step: 1, value: r.budget[key], 'data-key': key, inputmode: 'numeric' }));
  const save = h('button.btn.small.secondary', { type: 'button', onclick: async () => {
    const b = {};
    for (const el of box.querySelectorAll('input[data-key]')) b[el.dataset.key] = Number(el.value);
    try {
      await api(`${A}/settings`, { budgets: { [r.id]: b } });
      toast('Limits saved.', { kind: 'ok' });
      after(`limits-${r.id}`);
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
    }
  } }, 'Save the limits');
  add(box, h('div.op-limit-row', input('perHour', 'An hour', 1, 30), input('perDay', 'A day', 1, 200), input('waitMinutes', 'Minutes between tries', 1, 1440)), save);
  return box;
}

function ruleRow(r, after, corrected = null) {
  const undo = r.undo ? `Undo: ${r.undo}` : r.noUndo;
  const back = tookBack(corrected);
  return h(`li.op-rule${r.on ? '.on' : ''}`,
    sw(r.sentence, r.on, async (on) => {
      try {
        await api(`${A}/settings`, { rules: { [r.id]: on } });
        after(`rule-${r.id}`);
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
        after(`rule-${r.id}`);
        return false;
      }
    }, `${r.detail} ${undo}`, `rule-${r.id}`),
    placeLinks(r.ways, r.sentence),
    h('p.hint.op-rule-limits', limitWords(r)),
    back ? h('p.op-his.op-corrected', back) : null,
    limitsForm(r, after));
}

/** A part of the panel as a closed fold of its own (kept open or closed per device): an opened fold then fits a phone. */
const part = (key, title, node) => (node ? fold(`tia-part-${key}`, title, node) : null);

/** The panel: the master switch, Tia OFF, the sentence that says what is off, the rules. */
export function tiaPanel(v, after, { confirm = confirmActs } = {}) {
  if (remote()) {
    return h('section.op-tia', { 'aria-label': 'What Tia does by herself' },
      null,
      h(`p.op-tia-said${v.active ? '.on' : ''}`, { id: 'op-tia-said', role: 'status' }, v.said),
      placeLinks(v.ways),
      h('p.hint', ELSEWHERE),
      h('ul.op-rules', v.rules.map((r) => h('li.op-rule', h('span', `${r.on ? 'On' : 'Off'}: ${r.sentence}`), h('p.hint.op-rule-limits', limitWords(r))))));
  }
  const off = v.acts ? h('button.btn.danger.op-off', { type: 'button', 'aria-describedby': 'op-tia-said', onclick: async (e) => {
    e.currentTarget.disabled = true;
    try {
      const r = await api(`${A}/off`, {});
      toast(r.said, { kind: 'ok' });
    } catch (err) {
      toast(err.message, { kind: 'error', ms: 6000 });
    }
    after('master'); // the button is gone once she is off: the focus goes to the master switch
  } }, 'Tia OFF') : null;
  const master = sw('Tia acts by herself', v.acts, async (on) => {
    if (on && !(await confirm())) {
      after('master');
      return false;
    }
    try {
      await api(`${A}/settings`, { acts: on });
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
      after('master');
      return false;
    }
    after('master');
  }, 'Off after an install and after an update. Only the rules below, only the ones you switch on.', 'master');
  return h('section.op-tia', { 'aria-label': 'What Tia does by herself' },
    off ? h('div.op-tia-head', off) : null,
    h(`p.op-tia-said${v.active ? '.on' : ''}`, { id: 'op-tia-said', role: 'status' }, v.said),
    placeLinks(v.ways),
    master,
    part('decide', 'Decisions', h('div', decidePart(v, after),
      // His corrections of her decisions, shown where he decides about them; nothing changes by itself from them.
      tookBack(decisionCount(v.corrections)) ? h('p.op-his.op-corrected', `Tia decides: ${tookBack(decisionCount(v.corrections))}`) : null)),
    part('look', 'Looks', lookPart(v, after)),
    part('corrections', 'Corrections', correctionsPart(v, after)),
    part('rules', 'Rules she follows', h('ul.op-rules', v.rules.map((r) => ruleRow(r, after, v.corrections?.week?.rule?.[r.id] || 0)))),
    v.projectsOut.length ? h('p.hint', `She never acts in: ${v.projectsOut.join(', ')} (set on each project's page, under Advanced).`) : null);
}

/** Puts the focus on the control `key` names in `root` (a line gets tabindex -1 for it); false when it is not there. */
export function focusKey(root, key) {
  const el = key ? root.querySelector(`[data-focus="${key}"]`) : null;
  if (!el) return false;
  if (!el.matches('button') && !el.matches('input') && !el.matches('summary') && !el.matches('a')) el.tabIndex = -1;
  el.focus();
  return true;
}

/**
 * Draws the panel into `box` when what it says changed, or always after the owner's own change (`force`). It is held
 * back only while an open "Change the limits" form has the focus (he is typing in it). The focus goes back to the same
 * control (by its key), or to `focus`. → the key of what is drawn now.
 */
export function drawTia(box, v, after, { drawn = null, force = false, focus = null } = {}) {
  const key = JSON.stringify([v.acts, v.said, v.rules.map((x) => [x.on, x.left, x.budget]), v.projectsOut, v.decide || null, v.look || null, v.corrections || null]);
  const active = document.activeElement;
  const typing = [...box.querySelectorAll('details.op-limits')].some((d) => d.open && d.contains(active));
  if (!force && (key === drawn || typing)) return drawn;
  const keep = focus || (active && box.contains(active) ? active.dataset?.focus : null);
  fill(box, tiaPanel(v, after));
  if (keep) focusKey(box, keep);
  return key;
}

/** "Done by Tia": every act of a rule, done or refused, newest first, with Undo where it still can be. */
export function byTiaList(lines, v, after) {
  if (!lines.length) return h('p.hint', 'Tia has done nothing by herself.');
  const can = new Set(v.undoable || []);
  const undone = v.undone || {};
  // What a move of Tia's offers: Undo while it can be, else who moved it back and when, else why there is none.
  const undoPart = (l) => {
    if (undone[l.undo]) return h('span.op-t-noundo', `Moved back by you ${when(undone[l.undo])}.`);
    if (!can.has(l.undo)) return h('span.op-t-noundo', 'No Undo now: it is more than a day ago.');
    return null;
  };
  return h('ul.op-timeline', lines.map((l) => h(`li${l.ok ? '' : '.op-failed'}${l.refused ? '.op-refused' : ''}`, l.undo ? { dataset: { focus: `undo-${l.undo}` } } : null,
    h('span.op-t-at', { title: l.at }, when(l.at)),
    h('span.op-t-what',
      h('span', `${l.subject}: ${l.result}`),
      l.decided ? h('span.op-t-why', `Why: ${l.decided}`) : null,
      h('span.op-t-by', l.by === 'record' ? 'about her record' : l.by === 'decide' ? (l.refused ? 'left to you' : l.ok ? 'decided by Tia' : l.cutOff ? 'her decision was cut off by a stop of the dashboard' : 'decided by Tia, and it failed') : l.refused ? `the ${l.by} rule did not act` : l.ok ? `done by the ${l.by} rule` : l.cutOff ? `the ${l.by} rule was cut off by a stop of the dashboard` : `the ${l.by} rule tried, and it failed`),
      (l.ok || l.cutOff) && l.undo && can.has(l.undo) && !remote()
        ? h('button.btn.small.secondary.op-undo', { type: 'button', 'aria-label': `Undo: ${l.subject}`, onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            toast((await api(`${A}/undo`, { id: l.undo })).said, { kind: 'ok' });
          } catch (err) {
            toast(err.message, { kind: 'error', ms: 6000 });
          }
          after(`undo-${l.undo}`); // the focus stays on this line, with or without its button
        } }, 'Undo')
        : (l.ok || l.cutOff) && l.undo ? undoPart(l)
          : l.ok && l.noUndo ? h('span.op-t-noundo', l.noUndo) : null,
      placeLinks(l.ways, l.subject)))));
}

/** Settings → Tia: the same master switch, and Tia OFF while she may act. */
export async function tiaActsSetting(box, { confirm = confirmActs } = {}) {
  const paint = async () => {
    let v;
    try {
      v = await api(`${A}/settings`);
    } catch {
      return fill(box);
    }
    fill(box, sw('Tia acts by herself', v.acts, async (on) => {
      // The same question as on the Operator page before she may act.
      if (on && !(await confirm())) return false;
      try {
        await api(`${A}/settings`, { acts: on });
      } catch (e) {
        toast(e.message, { kind: 'error', ms: 6000 });
        return false;
      } finally {
        await paint();
        focusKey(box, 'master'); // drawn again: the focus back on the switch
      }
    }, `${v.said} Which rules she follows, and whether she decides new items by one short call ("Tia decides", off until you turn it on), is set below, under What she may do alone.`, 'master'));
  };
  return paint();
}

/** A project's page, under Advanced: "Tia never acts in this project" (the owner's switch, by the project's folder name). */
export async function projectOutSwitch(box, name) {
  let v;
  try {
    v = await api(`${A}/settings`);
  } catch {
    return fill(box); // an older computer: no rules there
  }
  if (remote()) return fill(box, h('p.hint', `${v.projectsOut.includes(name) ? 'Tia never acts in this project.' : 'Tia may act in this project by the rules that are on.'} ${ELSEWHERE}`));
  fill(box, sw('Tia never acts in this project', v.projectsOut.includes(name), async (out) => {
    try {
      await api(`${A}/settings`, { project: { name, out } });
    } catch (e) {
      toast(e.message, { kind: 'error', ms: 6000 });
      return false;
    }
  }, 'On: no rule of hers acts for a session, a run or a process of this project. What she may do by herself is set in Settings → Tia.', 'project'));
}

/**
 * The one closed fold of Settings -> Tia: What she may do alone. Her switch and rules, "Tia decides" (missions too),
 * looks, her corrections, looking at the other computers, and what she did, with Undo. Reads itself; returns the fold.
 */
export function tiaAloneFold() {
  const panelBox = h('div.op-tia-box');
  const lookBox = h('div.op-look-others');
  const byTia = h('div.op-side-body');
  const done = fold('tia-part-done', 'Done by Tia', byTia);
  let key = null;
  async function load(focus = null) {
    let r;
    try {
      r = await api(`${A}/attention`);
    } catch (e) {
      return fill(panelBox, h('p.hint', e.status === 404 ? 'This computer runs an older version without this.' : e.message));
    }
    if (!r.reflexes) return;
    const undo = focus?.startsWith('undo-') ? focus : null;
    key = drawTia(panelBox, r.reflexes, load, { drawn: key, force: !!focus, focus: undo ? null : focus });
    fill(byTia, byTiaList(r.byTia || [], r.reflexes, load));
    if (undo && !focusKey(byTia, undo)) {
      const head = done.querySelector('summary');
      head.tabIndex = -1;
      head.focus();
    }
  }
  load();
  lookOthersSwitch(lookBox);
  return fold('tia-alone', 'What she may do alone', panelBox, lookBox, done);
}
