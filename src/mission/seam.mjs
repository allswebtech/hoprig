// The one seam between missions and Tia's decisions. A mission's choice points (a provider at its usage limit, a task
// that waits until a named time, a task sent back twice) are items of kinds the decision table knows
// (decide-table.mjs MISSION_KINDS), each with its prepared steps; they are asked through the ONE decision door
// (decider.mjs mission(): the same switches, the same budgets, the same line under "Done by Tia" with her reason).
// A rule of his that answers one (the limit rule) acts first. The mission's engine does the step itself, on its own
// task, and says on the mission's line who chose it.
//
// With "Tia decides" off, or its switch for missions off, or no door wired (an older dashboard, a test without one),
// mayDo answers null and the engine does exactly what it did before.
import crypto from 'node:crypto';
import { boxCheck, runBoxed } from '../box/box.mjs';
import { MISSION_KINDS, missionSteps } from '../operator/decide-table.mjs';
import { providerName } from '../operator/detect/util.mjs';

/**
 * Two loops never act on one thing. For an item of the Operator's list that belongs to a mission's session, the loop
 * that owns each kind: the mission's engine for its own sessions' limits, stops, ends and questions (through this
 * seam), the Operator for what no mission owns (the computer, a provider's gateway, the public link) and for what
 * nobody can explain (its look only reads). The Operator's
 * rules and decisions skip an item of a mission's session whose kind the engine owns (rules.mjs ruleFor, decider.mjs).
 */
export const OWNER_OF = Object.freeze({
  limit: 'mission', stuck: 'mission', ended: 'mission', asks: 'mission',
  // What nobody can explain (a failed run, a mission's check that failed the same way after a fix): the engine has
  // made such a task his already; the Operator's look only reads it (look.mjs), and changes nothing of the mission.
  unknown: 'operator',
  machine: 'operator', provider: 'operator', live: 'operator',
});

/** True when the mission's engine owns `item` (an item of the Operator's list): the Operator does nothing about it. */
export const engineOwns = (item) => !!item && !!item.target && item.target.mission === true && OWNER_OF[item.kind] === 'mission';

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

/**
 * The item of a mission's choice point, as the door reads it. c: { kind, mission, task, title, project, provider,
 * providerLabel (its label, named as the Providers page does), to (the next free provider of his order), waitMs (until the named time), why (the engine's own words) }.
 */
export function missionItem(c) {
  if (!MISSION_KINDS.includes(c.kind)) throw new Error(`not a mission's choice: ${c.kind}`);
  const steps = missionSteps(c.kind, { to: c.to, waitMs: c.waitMs });
  const subject = `task ${c.task} of mission ${c.mission}`;
  const facts = [
    `"${String(c.title || c.task).slice(0, 80)}"`,
    c.provider ? `provider ${providerName(c.provider, c.providerLabel)}` : null,
    c.kind === 'mission-limit' ? 'its session stopped at a usage limit' : c.kind === 'mission-waits' ? 'it waits until it can start again' : 'it was sent back twice',
    c.why ? String(c.why).slice(0, 100) : null,
  ].filter(Boolean);
  // The rev: the same picture of the choice is decided once; a new limit, provider or wait is a new picture.
  const rev = hash(JSON.stringify([c.kind, c.task, c.provider || null, c.to || null, c.at || null, steps.map((s) => s.id)]));
  return {
    id: `${c.kind}-${hash(`${c.kind}\n${c.mission}\n${c.task}`)}`, kind: c.kind, subject, facts, rev, project: c.project || null,
    steps: steps.map((s) => s.id), known: steps.filter((s) => s.says).map((s) => `${s.id}: ${s.says}`), to: c.to || null,
  };
}

/**
 * What may be done about a mission's choice `c` now. `door(item)`: the decision door (decider.mjs mission). → null (no
 * door, or the door is off: the engine does what it did before), { act, by, why } (a step of the item's: the engine does
 * it and names `by` on the mission's line: a rule's name, or "Tia decides"), or { ask: true, why } (his: it waits).
 */
export async function mayDo(c, door) {
  if (typeof door !== 'function') return null;
  const item = missionItem(c);
  let r;
  try {
    r = await door(item);
  } catch (e) {
    return { ask: true, why: `Tia could not decide (${String(e.message).slice(0, 120)}): it is yours` };
  }
  if (!r) return null;
  if (r.act && !item.steps.includes(r.act)) return { ask: true, why: `${r.act} is not a step prepared for it: it is yours` };
  return r.act ? { act: r.act, by: r.by, why: r.why || '' } : { ask: true, why: r.why || 'it is yours' };
}

// The box that runs a session's own code with no network and without the owner's real home (src/box, docs/BOX.md):
// its own check and its own run, unchanged. Its check is asynchronous and is only called when a gate or the owner's
// own "Run the tests here" runs: handing the box out starts nothing.
export function box() {
  return BOX;
}
const BOX = Object.freeze({ check: boxCheck, run: runBoxed });
