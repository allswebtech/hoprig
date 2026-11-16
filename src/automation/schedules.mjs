// Schedules: "at this time (once / daily / on these weekdays) start a session in this folder on this account
// with this first message" (in a chat, or in a terminal), or "send this message to that session" (a terminal, or a
// chat: "chat:<id>"). Times are the computer's local time.
//
// A schedule's `when` is { kind: 'once'|'daily'|'weekly', time: 'HH:MM', days?: [0-6], date?: 'YYYY-MM-DD' }
// (days: 0 = Sunday). No cron syntax: these three kinds are what people ask for.
//
// Each tick looks at the newest moment ("slot") a schedule should have run at. It runs when that slot is newer
// than the last one handled and newer than the schedule itself (a schedule made at 10:00 for 09:00 daily starts
// tomorrow). A slot missed while the computer was off runs once at start when it is at most `lateHours` late,
// else it is skipped and logged. Only the newest missed slot counts: three missed days run once, not three times.
//
// Clock changes: a time that does not exist on the day summer time starts (02:30 when clocks jump from 02:00 to
// 03:00) runs at the same distance after the jump (03:30); a time that happens twice when it ends runs at the
// first one. Either way a schedule runs once per day.
//
// Stored per schedule id: { last } = the slot handled last.

/** Within this much of its time a run counts as on time, whatever `lateHours` says. */
export const ON_TIME_MS = 15 * 60_000;
const DAY_SPAN = 8; // a weekly schedule has a slot in any 8 days

const hm = (time) => time.split(':').map(Number);

/** The slot on the calendar day of `y`, `m`, `d` (local time), or null when the schedule does not run that day. */
function slotOn(when, y, m, d) {
  const day = new Date(y, m, d); // normalises overflowing days (d = 0, 32 …) in local time
  if (when.kind === 'weekly' && !when.days.includes(day.getDay())) return null;
  if (when.kind === 'once') {
    const [yy, mm, dd] = when.date.split('-').map(Number);
    if (day.getFullYear() !== yy || day.getMonth() !== mm - 1 || day.getDate() !== dd) return null;
  }
  const [h, mi] = hm(when.time);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi).getTime();
}

/** The newest slot at or before `now`, or null. */
export function lastSlot(when, now) {
  if (when.kind === 'once') {
    const [y, m, d] = when.date.split('-').map(Number);
    const s = slotOn(when, y, m - 1, d);
    return s !== null && s <= now ? s : null;
  }
  const t = new Date(now);
  for (let i = 0; i <= DAY_SPAN; i++) {
    const s = slotOn(when, t.getFullYear(), t.getMonth(), t.getDate() - i);
    if (s !== null && s <= now) return s;
  }
  return null;
}

/** The first slot after `now`, or null (a one-time schedule that is past). */
export function nextSlot(when, now) {
  if (when.kind === 'once') {
    const [y, m, d] = when.date.split('-').map(Number);
    const s = slotOn(when, y, m - 1, d);
    return s !== null && s > now ? s : null;
  }
  const t = new Date(now);
  for (let i = 0; i <= DAY_SPAN; i++) {
    const s = slotOn(when, t.getFullYear(), t.getMonth(), t.getDate() + i);
    if (s !== null && s > now) return s;
  }
  return null;
}

/**
 * state: { schedules (the settings list), lateHours, data: { [id]: { last } }, now }. Returns { actions, data }.
 * Actions: { type: 'run', schedule, slot, late } | { type: 'skip', schedule, slot, late }.
 */
export function decide({ schedules, lateHours, data, now }) {
  const next = {};
  const actions = [];
  for (const s of schedules) {
    const seen = (data && data[s.id]) || {};
    next[s.id] = { ...seen };
    if (!s.enabled) continue;
    const slot = lastSlot(s.when, now);
    if (slot === null || slot <= (seen.last || 0) || slot <= (s.since || 0)) continue;
    next[s.id].last = slot;
    const late = now - slot;
    const ok = late <= Math.max(ON_TIME_MS, lateHours * 3600_000);
    actions.push({ type: ok ? 'run' : 'skip', schedule: s, slot, late });
  }
  return { actions, data: next };
}

/**
 * Carry out the actions. ctx: { deck.start({ dir, profile, mode, name? }) → name, deck.has(name) → bool,
 * deck.startChat({ dir, profile, text, tool }) → chat id, deck.sendChat(id, text), enqueue(session, text), label(profile)?, record(entry),
 * notify({ title, message, session }) }.
 * A message to a terminal goes through the session's queue, so it waits until Claude is free instead of typing over
 * its work; a chat queues a message by itself (Claude takes it at its next step).
 */
export async function apply(actions, ctx) {
  for (const a of actions) {
    const s = a.schedule;
    const label = s.label || describeAction(s.action, ctx.label);
    if (a.type === 'skip') {
      const hours = Math.round(a.late / 360_000) / 10;
      ctx.record({ automation: 'schedules', session: s.action.session || '', did: `skipped "${label}" (due ${new Date(a.slot).toLocaleString()})`, outcome: `missed: ${hours} hours late, more than allowed` });
      continue;
    }
    const lateNote = a.late > ON_TIME_MS ? ` (ran ${Math.round(a.late / 60_000)} minutes late)` : '';
    try {
      if (s.action.type === 'start' && s.action.in === 'chat') {
        if (!ctx.deck.startChat) throw new Error('chats are not available here');
        const id = await ctx.deck.startChat({ dir: s.action.dir, profile: s.action.profile, text: s.action.prompt || null, ...(s.action.tool ? { tool: s.action.tool } : {}) });
        ctx.record({ automation: 'schedules', session: `chat:${id}`, did: `started "${label}" in a chat${lateNote}`, outcome: 'ok' });
      } else if (s.action.type === 'start') {
        const name = await ctx.deck.start({ dir: s.action.dir, profile: s.action.profile, mode: 'new' });
        if (s.action.prompt) ctx.enqueue(name, s.action.prompt);
        ctx.record({ automation: 'schedules', session: name, did: `started "${label}"${lateNote}`, outcome: 'ok' });
      } else {
        if (!(await ctx.deck.has(s.action.session))) throw new Error(`there is no session "${s.action.session}"`);
        if (s.action.session.startsWith('chat:')) {
          if (!ctx.deck.sendChat) throw new Error('chats are not available here');
          await ctx.deck.sendChat(s.action.session.slice(5), s.action.text);
        } else ctx.enqueue(s.action.session, s.action.text);
        ctx.record({ automation: 'schedules', session: s.action.session, did: `queued "${label}"${lateNote}`, outcome: 'ok' });
      }
    } catch (e) {
      ctx.record({ automation: 'schedules', session: s.action.session || '', did: `could not run "${label}"`, outcome: `failed: ${e.message}` });
      ctx.notify({ title: `Schedule "${label}" did not run`, message: e.message, session: s.action.session || '' });
    }
  }
}

/** A schedule without a name, in words; `shown(profile)`: the provider as the owner named it (Activity is read). */
export const describeAction = (a, shown = null) => (a.type === 'start' ? `start ${a.in === 'chat' ? 'a chat ' : ''}in ${a.dir} on ${(shown && shown(a.profile)) || a.profile}` : `message to ${a.session}`);
