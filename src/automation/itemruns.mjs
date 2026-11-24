// The run times of Work's items ("run by AI at 07:30", the item's `work.at`: src/work/repeat.mjs checkRunAt) as a
// schedule of this computer. Only the computer the item names runs it: an item that names another computer, or none
// ("choose the computer"), never runs here. What this computer has handled (the last slot per item) is this
// computer's own state (the automations' store), never in the owner's repository.
//
// The slot: an item with a date runs on its date at its time (a repeating item's date moves on by its rule first,
// src/work/repeat.mjs rollRepeats, so each day of the rule is a slot); an item without a date at its time every day
// while it is open. The rules of schedules.mjs hold: only the newest missed slot counts, within `lateHours`; a slot
// before the item was first seen here with that time does not run (a time set at 10:00 for 07:30 starts next time).
// An item a session works on, waiting for review, done or dropped has no slot.
import { ON_TIME_MS, lastSlot, slotText } from './schedules.mjs';

const OPEN = ['open', 'waiting'];

/**
 * { items: [{ id, title, status, date, at: { time, computer } }], me (this computer's id), lateHours, data, now } →
 * { actions: [{ type: 'run' | 'skip', item, slot, late }], data }.
 */
export function decide({ items, me, lateHours, data = {}, now }) {
  const next = {};
  const actions = [];
  for (const it of items) {
    if (!it.at || it.at.computer !== me) continue;
    const key = `${it.id}@${it.at.time}`;
    const seen = data[key] || { seen: now };
    next[key] = { ...seen };
    if (!OPEN.includes(it.status)) continue;
    const when = it.date ? { kind: 'once', date: it.date, time: it.at.time } : { kind: 'daily', time: it.at.time };
    const slot = lastSlot(when, now);
    if (slot === null || slot <= (seen.last || 0) || slot <= seen.seen) continue;
    next[key].last = slot;
    const late = now - slot;
    actions.push({ type: late <= Math.max(ON_TIME_MS, lateHours * 3600_000) ? 'run' : 'skip', item: it, slot, late });
  }
  return { actions, data: next };
}

/** Carry them out. ctx: { startItem(id) → { run } | { waiting, why }, record(entry), notify(ev) }. */
export async function apply(actions, ctx) {
  for (const a of actions) {
    const label = a.item.title || a.item.id;
    if (a.type === 'skip') {
      ctx.record({ automation: 'schedules', did: `missed "${label}" (due ${slotText(a.slot)})`, outcome: `missed: ${Math.round(a.late / 360_000) / 10} hours late, more than allowed` });
      continue;
    }
    try {
      const r = await ctx.startItem(a.item.id);
      if (r.waiting) ctx.record({ automation: 'schedules', did: `"${label}" waits to run`, outcome: `waits: ${r.why}` });
      else ctx.record({ automation: 'schedules', did: `started "${label}" by itself on the branch ${r.run.branch}`, outcome: 'ok' });
    } catch (e) {
      ctx.record({ automation: 'schedules', did: `could not run "${label}"`, outcome: `failed: ${e.message}` });
      ctx.notify({ title: `"${label}" did not run`, message: e.message, session: '' });
    }
  }
}
