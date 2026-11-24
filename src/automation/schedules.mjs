// Schedules: "at this time (once / daily / on these weekdays) start a session in this folder on this account
// with this first message" (in a chat, or in a terminal), or "send this message to that session" (a terminal, or a
// chat: "chat:<id>"). Times are the computer's local time.
//
// A schedule's `when` is { kind: 'once'|'daily'|'weekly'|'monthly', time: 'HH:MM', days?: [0-6], day?: 1-31,
// date?: 'YYYY-MM-DD' } (days: 0 = Sunday; day: the day of the month, in a shorter month its last day). No cron
// syntax: these four kinds are what people ask for. A repeating item of Work (src/work/repeat.mjs) uses the same
// kinds and the same `runsOn`, without a time.
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
// How many days back or ahead a slot is looked for: a weekly schedule has one in any 8 days, a monthly one in any 62.
const spanOf = (when) => (when.kind === 'monthly' ? 62 : 8);

const hm = (time) => time.split(':').map(Number);

/**
 * True when `when` runs on the calendar day of `y`, `m` (0-11), `d` (local; overflowing days are normalised). A
 * monthly day past the month's end (31 in April, 30 in February) is that month's last day.
 */
export function runsOn(when, y, m, d) {
  const day = new Date(y, m, d);
  if (when.kind === 'weekly') return when.days.includes(day.getDay());
  if (when.kind === 'monthly') return day.getDate() === Math.min(when.day, new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate());
  if (when.kind === 'once') {
    const [yy, mm, dd] = when.date.split('-').map(Number);
    return day.getFullYear() === yy && day.getMonth() === mm - 1 && day.getDate() === dd;
  }
  return true;
}

/** The slot on the calendar day of `y`, `m`, `d` (local time), or null when the schedule does not run that day. */
function slotOn(when, y, m, d) {
  if (!runsOn(when, y, m, d)) return null;
  const day = new Date(y, m, d); // normalises overflowing days (d = 0, 32 …) in local time
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
  for (let i = 0; i <= spanOf(when); i++) {
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
  for (let i = 0; i <= spanOf(when); i++) {
    const s = slotOn(when, t.getFullYear(), t.getMonth(), t.getDate() + i);
    if (s !== null && s > now) return s;
  }
  return null;
}

const ymdOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The first calendar day after `ymd` (YYYY-MM-DD) that `when` runs on, as YYYY-MM-DD (null: none within a year). */
export function nextDay(when, ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  for (let i = 1; i <= 400; i++) if (runsOn(when, y, m - 1, d + i)) return ymdOf(new Date(y, m - 1, d + i));
  return null;
}

/** The last calendar day at or before `ymd` that `when` runs on (null: none within a year). */
export function dayAtOrBefore(when, ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  for (let i = 0; i <= 400; i++) if (runsOn(when, y, m - 1, d - i)) return ymdOf(new Date(y, m - 1, d - i));
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
/**
 * A slot's time as the page writes times ("Wed 18 Nov, 17:45"), on this computer's clock. The parts are joined here:
 * the separators of a locale come from the ICU data the Node carries, and they changed ("Wed, 18 Nov" on Node 22.11).
 */
export const slotText = (ms) => {
  const opts = { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', opts).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute}`;
};

export async function apply(actions, ctx) {
  for (const a of actions) {
    const s = a.schedule;
    const label = s.label || describeAction(s.action, ctx.label);
    if (a.type === 'skip') {
      const hours = Math.round(a.late / 360_000) / 10;
      ctx.record({ automation: 'schedules', session: s.action.session || '', did: `skipped "${label}" (due ${slotText(a.slot)})`, outcome: `missed: ${hours} hours late, more than allowed` });
      continue;
    }
    const lateNote = a.late > ON_TIME_MS ? ` (ran ${Math.round(a.late / 60_000)} minutes late)` : '';
    try {
      if (s.action.type === 'alone') {
        // A run that ends by itself, here or on the computer it names (src/work/schedfeature.mjs): never anywhere else.
        if (!ctx.alone) throw new Error('runs that end by themselves are not available here');
        const r = await ctx.alone(s, a);
        const on = r.on ? ` on ${r.on}` : '';
        if (r.waiting) ctx.record({ automation: 'schedules', did: `"${label}" waits to run${on}${lateNote}`, outcome: `waits: ${r.why}` });
        else ctx.record({ automation: 'schedules', did: `started "${label}"${on} on the branch ${r.run && r.run.branch ? r.run.branch : 'of its own'}${lateNote}`, outcome: 'ok' });
      } else if (s.action.type === 'start' && s.action.in === 'chat') {
        if (!ctx.deck.startChat) throw new Error('chats are not available here');
        // A schedule Tia added starts what is hers (settings.mjs cleanSchedule `hers`).
        const id = await ctx.deck.startChat({ dir: s.action.dir, profile: s.action.profile, text: s.action.prompt || null, ...(s.action.tool ? { tool: s.action.tool } : {}), ...(s.hers === true ? { hers: true } : {}) });
        // A schedule without a name says "a chat" in its own words already.
        ctx.record({ automation: 'schedules', session: `chat:${id}`, did: `started "${label}"${s.label ? ' in a chat' : ''}${lateNote}`, outcome: 'ok' });
      } else if (s.action.type === 'start') {
        const name = await ctx.deck.start({ dir: s.action.dir, profile: s.action.profile, mode: 'new', ...(s.hers === true ? { hers: true } : {}) });
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
      // A computer that cannot be reached: the slot is missed, with the reason, and it does not run elsewhere.
      if (e.missed) ctx.record({ automation: 'schedules', did: `missed "${label}" (due ${slotText(a.slot)})`, outcome: `missed: ${e.message}` });
      else ctx.record({ automation: 'schedules', session: s.action.session || '', did: `could not run "${label}"`, outcome: `failed: ${e.message}` });
      ctx.notify({ title: `Schedule "${label}" did not run`, message: e.message, session: s.action.session || '' });
    }
  }
}

const TOOL_WORDS = { opencode: 'OpenCode', codex: 'Codex' };
/**
 * A schedule without a name, in the words the Schedules list uses (web/automation.js whatText), since Activity is read
 * by a person too: the folder by its name, the provider as the owner named it (`shown(profile)`), another coding tool
 * by its name, a chat as "a chat" (the page names it by its title where it can).
 */
export function describeAction(a, shown = null) {
  if (a.type === 'alone') return `run by itself in ${a.project}${a.folder ? `/${a.folder}` : ''} for at most ${a.minutes || 30} minutes on ${(shown && shown(a.provider)) || a.provider}`;
  if (a.type !== 'start') return `send a message to ${String(a.session || '').startsWith('chat:') ? 'a chat' : a.session}`;
  const folder = String(a.dir || '').split(/[\\/]/).filter(Boolean).pop() || a.dir;
  const other = a.in === 'chat' && a.tool && a.tool !== 'claude' ? ` with ${TOOL_WORDS[a.tool] || a.tool}` : '';
  return `start ${a.in === 'chat' ? 'a chat' : 'a session'}${other} in ${folder} on ${(shown && shown(a.profile)) || a.profile}`;
}
