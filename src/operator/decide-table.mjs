// What Tia may decide (a decision: decide.mjs, decider.mjs): a closed table of prepared steps per kind of item. A model
// only picks one of the steps this table offers for an item, or ask_owner; it never writes a command, a path or a text
// that reaches a session, a shell or a file. Each step is an act of the Operator's own (item.mjs ACTS), done through the
// same door as a rule's act (reflex.mjs) and offered to the owner on the item's card as well.
//
// A kind that is not here is never sent to a model. Nothing that is the owner's alone in every mode (a repository, a
// push, money, a sign-in, a delete, a release, sending something out) is in any row.
//
// Only node: imports and the detectors' helpers: item.mjs reads PREPARED_ACTS from here.

import { createHash } from 'node:crypto';
import { ms } from './detect/util.mjs';

export const ASK = 'ask_owner';
export const TABLE_KINDS = Object.freeze(['limit', 'stuck', 'asks', 'provider', 'live', 'machine']);
// Not in the table: `providerstop` (a provider refused or stopped a reply). Its acts are opening Providers to sign in
// or to see the provider (no act of hers), and a retry of a refused model name is never one; a gateway that stopped
// is the kind `provider`'s, which the table has.
/** At most four prepared steps for one item: with ask_owner, five. */
export const MAX_STEPS = 4;
export const ANSWERS = Object.freeze(['answer-1', 'answer-2', 'answer-3', 'answer-4']);
/** A limit that ends within this long may be waited for. */
export const WAIT_WITHIN_MS = 60 * 60_000;
export const HOLD_MINUTES = 30;
/** The one sentence a nudge types, held here: a model never writes what reaches a session. */
export const NUDGE = 'Hoprig here: this session has made no progress for a while. If a command or a wait cannot end, stop it and go on with the task; if you need the owner, say so in one line.';

/** The acts this table adds to the Operator's catalog (item.mjs ACTS). */
export const PREPARED_ACTS = Object.freeze({
  wait: { label: 'Wait for the reset', risk: 'none', effect: 'Leaves the session stopped until its limit ends; the item is hidden until it changes.', undo: null },
  nudge: { label: 'Nudge it once', risk: 'low', effect: 'Types one fixed sentence into the session, once while it makes no progress.', undo: null },
  hold: { label: `Hold new starts for ${HOLD_MINUTES} min`, risk: 'low', effect: `No new session or chat starts for ${HOLD_MINUTES} minutes.`, undo: 'Lift the hold on the Operator page.', ways: ['operator-page'] },
  note: { label: 'Answer with your note', risk: 'low', effect: 'Answers the question with your Hands-off note for the project.', undo: null },
  ...Object.fromEntries(ANSWERS.map((id, i) => [id, { label: `Answer with option ${i + 1}`, risk: 'low', effect: 'Answers the question with that option.', undo: null }])),
});

// A mission's choice points (src/mission/seam.mjs builds their items, the mission's engine does the step): asked through
// the same decision door. `next-provider`: the task goes on with the next provider of his order that is free; `wait`: it
// waits until the named time; a task sent back twice has no step but his.
export const MISSION_KINDS = Object.freeze(['mission-limit', 'mission-waits', 'mission-sent-back']);
export const MISSION_STEPS = Object.freeze(['next-provider', 'wait']);

/** The steps of a mission's choice: [{ id, says }]. `to`: the next free provider of his order; `waitMs`: how long until the named time. */
export function missionSteps(kind, { to = null, waitMs = null } = {}) {
  const min = (t) => Math.max(1, Math.round(t / 60_000));
  const wait = Number.isFinite(waitMs) && waitMs > 0 && waitMs <= WAIT_WITHIN_MS ? [{ id: 'wait', says: `it can start again in about ${min(waitMs)} min` }] : [];
  if (kind === 'mission-limit') return [...(typeof to === 'string' && to ? [{ id: 'next-provider', says: 'the usual step: the task goes on now with the next provider of the owner\'s order, which is free' }] : []), ...wait];
  if (kind === 'mission-waits') return wait;
  return [];
}

const has = (item, id) => item.acts.some((a) => a.id === id);
const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * A question's card as the asks adapter gives it (decide-asks.mjs), or null when it is not one a decision may answer.
 * The same waits as Hands-off's own: only one question of the kind "question" (never a permission, a plan or a notice),
 * nothing masked or cut from it, and no sign of what is the owner's alone in its words. `alone(texts)` is that sign
 * check (Hands-off's ownersAlone, through the adapter); without one, nothing is answerable.
 */
export function answerable(card, alone = null) {
  if (!card || typeof card !== 'object' || card.handsOff !== true) return null;
  if (card.kind !== 'question' || card.count !== 1 || card.masked === true || card.cut === true || card.multi === true) return null;
  if (card.marked !== null && card.marked !== undefined) return null; // the tool recommends one: Hands-off answers it, no model
  if (!Array.isArray(card.options) || card.options.length < 2 || card.options.length > MAX_STEPS) return null;
  if (!card.options.every((o) => o && typeof o.label === 'string' && o.label.trim())) return null;
  if (typeof alone !== 'function') return null;
  const words = [card.question, card.header, ...card.options.flatMap((o) => [o.label, o.description])].filter((t) => typeof t === 'string');
  if (alone(words) !== null) return null; // a push, a release, money…: his, whatever the note says
  return card;
}

/**
 * The steps prepared for `item` on `board` (without ask_owner): [{ id, label? }], [] when there is nothing to decide.
 * `nudged(session, since)`: a nudge was given in this stretch without progress. `card(session)`, `alone(texts)`: the
 * asks adapter.
 */
export function prepared(item, board = {}, { now = Date.now(), nudged = () => false, card = () => null, alone = null } = {}) {
  if (!item || !TABLE_KINDS.includes(item.kind) || !Array.isArray(item.acts)) return [];
  const tg = item.target || {};
  const session = (board.sessions || []).find((s) => s.name === tg.session) || null;
  switch (item.kind) {
    case 'limit': {
      const out = [];
      // As the limit rule: only a limit Claude Code itself reported is moved; one only on the screen stays his.
      if (has(item, 'switch') && tg.hook === true && typeof tg.to === 'string' && tg.to) out.push({ id: 'switch' });
      const resets = [session?.limit?.resetsAt, ...(session?.agents || []).map((a) => a?.limit?.resetsAt)].map(ms).filter((t) => t != null);
      const left = resets.length ? Math.min(...resets) - now : null;
      // The time left, said by the code: a model has no clock of its own, so a clock time would mean nothing to it.
      if (left != null && left > 0 && left <= WAIT_WITHIN_MS) out.push({ id: 'wait', says: `the limit ends in about ${Math.max(1, Math.round(left / 60_000))} min` });
      return out;
    }
    case 'stuck': {
      if (typeof tg.session !== 'string') return [];
      const out = [];
      if (!nudged(tg.session, item.since)) out.push({ id: 'nudge' });
      if (has(item, 'stop')) out.push({ id: 'stop' });
      return out;
    }
    case 'asks': {
      // The session itself says it waits for a question: a permission prompt is never a decision, whatever its card.
      const c = typeof tg.session === 'string' && session?.askType === 'question' ? answerable(card(tg.session), alone) : null;
      if (!c) return [];
      const out = c.options.map((o, i) => ({ id: ANSWERS[i], label: clip(`Answer: ${o.label}`, 40) }));
      if (c.freeText === true && typeof c.note === 'string' && c.note.trim() && out.length < MAX_STEPS) out.push({ id: 'note' });
      return out;
    }
    case 'provider':
      // A gateway that open work goes through and that stopped; never one he stopped himself, never a "not started" note.
      return item.class === 'stopped' && has(item, 'restart-gateway') && typeof tg.addon === 'string' && tg.ownerStopped !== true ? [{ id: 'restart-gateway' }] : [];
    case 'live':
      return has(item, 'restart-link') ? [{ id: 'restart-link' }] : [];
    case 'machine':
      return item.subject === 'load' || item.subject === 'memory' ? [{ id: 'hold' }] : [];
    default:
      return [];
  }
}

/**
 * The steps a decision is offered for `item`: its prepared ones, with `stop` only where the owner ticked "Tia may end
 * a stuck session in this project" (`mayEnd` exactly true: decide-store.mjs mayEndFor). His note stays her guidance in
 * words and never offers stop by itself: a check reads the tick, not his words. Without the tick stop is never the
 * model's to pick, and an item left with no step is his with no call.
 */
export function offeredSteps(item, mayEnd) {
  return (item?.steps || []).filter((s) => s !== 'stop' || mayEnd === true);
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

/**
 * The items with their prepared steps: a step the item does not offer yet is added to its acts (so it is the owner's
 * tap too), `steps` (not sent to the page) names them, and the rev changes with them, so a decision made on an item
 * without a step is never taken for one with it. A stuck item's rev also holds its stretch without progress.
 */
export function decorate(items, board, o = {}) {
  return items.map((item) => {
    if (!TABLE_KINDS.includes(item.kind)) return item;
    const steps = prepared(item, board, o).slice(0, MAX_STEPS);
    const added = steps.filter((s) => !has(item, s.id));
    if (!steps.length && item.kind !== 'stuck') return item;
    const out = { ...item, acts: [...item.acts, ...added.map((s) => (s.label ? { id: s.id, label: s.label } : { id: s.id }))] };
    if (added.length || item.kind === 'stuck') out.rev = hash(JSON.stringify([item.rev, added.map((s) => [s.id, s.label || null]), item.kind === 'stuck' ? item.since : null]));
    if (item.target) Object.defineProperty(out, 'target', { value: item.target, enumerable: false });
    Object.defineProperty(out, 'steps', { value: Object.freeze(steps.map((s) => s.id)), enumerable: false });
    // What the code knows about the steps, said to the model outside the fence (never a text of the item's).
    const says = steps.filter((s) => s.says).map((s) => `${s.id}: ${s.says}`);
    if (item.kind === 'stuck' && steps.some((s) => s.id === 'nudge')) says.push('nudge: not given yet while this session makes no progress');
    if (item.kind === 'stuck' && !steps.some((s) => s.id === 'nudge')) says.push('Hoprig already nudged this session once while it made no progress, and it still makes none');
    Object.defineProperty(out, 'known', { value: Object.freeze(says), enumerable: false });
    return out;
  });
}
