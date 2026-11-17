// Queue: per session, an ordered list of messages. Each time Claude finishes a reply and waits, the next message
// is sent, exactly once. "Do A, then B, then C" from a phone, and walk away.
//
// Stored per session name: { paused, items: [{ id, text, addedAt }], sentFor, kick, runId, goneAt }
//   sentFor  the stopAt (end of a reply) we already sent a message for; never two messages for one reply. It is
//            written to disk before the message is typed, so a restart in between can lose a message but never
//            send one twice.
//   kick     the owner added or resumed messages: send at the next idle moment, even before any reply ended
//            in this run (a session that sits waiting would otherwise never start its queue). Cleared when the
//            session's run changes, so a session reopened after a restart does not fire an old message.
//   goneAt   when the session was last seen missing; the queue is dropped after a day.
//   held     { why, at }: the next message could not be typed because the coding tool was not the program in front
//            in its terminal (it had ended: src/server/typing.mjs). The message stays first and goes the next time a
//            coding tool waits in that session, even a new run of it (the owner meant it for the session); `why`
//            is what the queue's row says meanwhile. Cleared once a message went, or the queue is empty.
//            { why, at, paused: true }: the last message was typed but its Enter did not follow (the tool ended or
//            changed in between): the queue is paused with the message first, so it is not typed a second time
//            unseen; the owner looks at the session and resumes (which clears it).
//
// Never sends into a session that needs an OK, is at a limit, or whose last reply ended in an error.
import { idle, isCodingCard } from './cards.mjs';
import { QUEUE_MAX, cleanText } from './settings.mjs';

export const GONE_KEEP_MS = 24 * 3600_000;

const empty = () => ({ paused: false, items: [], sentFor: null, kick: false, runId: null, goneAt: null, held: null });
const keyOf = (c) => c.stopAt || 0;

/**
 * state: { cards, data: { [session]: queue }, now }. Returns { actions, data }.
 * Actions: { type: 'send', session, item } | { type: 'drop', session, count } | { type: 'renamed', session, from }.
 */
export function decide({ cards, data, now }) {
  const next = {};
  const actions = [];
  const present = new Map(cards.map((c) => [c.name, c]));
  const all = { ...(data || {}) };
  // A renamed session: its name is gone, but the same run (same launcher) now shows under another name. The
  // queue goes with it, unless the new name has messages of its own.
  for (const [name, q] of Object.entries(all)) {
    if (present.has(name) || !q.runId) continue;
    const c = cards.find((x) => x.runId === q.runId && x.name !== name);
    if (!c || (all[c.name] && all[c.name].items && all[c.name].items.length)) continue;
    all[c.name] = { ...q, goneAt: null };
    delete all[name];
    actions.push({ type: 'renamed', session: c.name, from: name });
  }
  for (const [name, q0] of Object.entries(all)) {
    const q = { ...empty(), ...q0, items: [...(q0.items || [])] };
    const c = present.get(name);
    if (!c) {
      q.goneAt = q.goneAt || now;
      if (!q.items.length) continue; // nothing worth keeping for a session that is gone
      if (now - q.goneAt > GONE_KEEP_MS) {
        if (q.items.length) actions.push({ type: 'drop', session: name, count: q.items.length });
        continue;
      }
      next[name] = q;
      continue;
    }
    q.goneAt = null;
    if (isCodingCard(c) && c.runId) {
      if (q.runId && q.runId !== c.runId) q.kick = false; // another run: an old "send now" does not carry over
      q.runId = c.runId;
    }
    if (!q.paused && q.items.length && idle(c) && (q.held || (keyOf(c) !== q.sentFor && (q.kick || c.stopAt)))) {
      const item = q.items.shift();
      q.sentFor = keyOf(c);
      q.kick = false;
      actions.push({ type: 'send', session: name, item });
    }
    // Kept even when empty while the session lives: `sentFor` must outlive the last message, or a message
    // added right after it could go out for the same reply.
    next[name] = q;
  }
  return { actions, data: next };
}

/**
 * Carry out the actions. ctx: { deck.send(name, text), record(entry), putBack(session, item, { why, pause }), sent(session) }.
 * A message the coding tool was not in front for (error code "not_in_front": nothing was typed) is put back with the
 * reason, and recorded as not delivered once per reason, not at every tick it keeps waiting. One that was typed but not
 * sent ("typed_not_sent") is put back and the queue paused.
 */
export async function apply(actions, ctx) {
  for (const a of actions) {
    if (a.type === 'renamed') {
      ctx.record({ automation: 'queue', session: a.session, did: `the queue moved along with the rename from "${a.from}"`, outcome: 'ok' });
      continue;
    }
    if (a.type === 'drop') {
      ctx.record({ automation: 'queue', session: a.session, did: `dropped ${a.count} queued message(s): the session has been gone for a day`, outcome: 'ok' });
      continue;
    }
    try {
      await ctx.deck.send(a.session, a.item.text);
      ctx.sent?.(a.session);
      ctx.record({ automation: 'queue', session: a.session, did: `sent: ${preview(a.item.text)}`, outcome: 'ok' });
    } catch (e) {
      if (e.code === 'not_in_front') {
        const first = ctx.putBack(a.session, a.item, { why: HELD_WHY });
        if (first) ctx.record({ automation: 'queue', session: a.session, did: `not delivered: ${preview(a.item.text)}`, outcome: `waits in the queue: ${e.message}` });
        continue;
      }
      if (e.code === 'typed_not_sent') {
        ctx.putBack(a.session, a.item, { why: TYPED_WHY, pause: true });
        ctx.record({ automation: 'queue', session: a.session, did: `typed but not sent: ${preview(a.item.text)}`, outcome: `the queue is paused: ${e.message}` });
        continue;
      }
      ctx.putBack(a.session, a.item);
      ctx.record({ automation: 'queue', session: a.session, did: `could not send: ${preview(a.item.text)}`, outcome: `failed: ${e.message}` });
    }
  }
}

/** What the queue's row and sheet say while its next message waits for a coding tool in front (the activity row has the detail). */
export const HELD_WHY = 'its coding tool is not the program in front in this session (it ended, or another program runs there): the next message goes when a coding tool waits there again';
/** The same when the queue paused itself because its last message was typed but not sent. */
export const TYPED_WHY = 'its last message was typed but not sent (its coding tool ended or changed before the Enter): look at the session, then resume';

export const preview = (t) => {
  const one = String(t).replace(/\s+/g, ' ').trim();
  return one.length > 60 ? one.slice(0, 59) + '…' : one;
};

// ---- what the owner does with a queue: pure functions on one queue, so the routes stay thin ----

export function add(q0, text, { now, id, position } = {}) {
  const q = { ...empty(), ...q0, items: [...((q0 && q0.items) || [])] };
  if (q.items.length >= QUEUE_MAX) throw new Error(`a queue holds at most ${QUEUE_MAX} messages`);
  const item = { id, text: cleanText(text), addedAt: now };
  const at = position === undefined ? q.items.length : clampIndex(position, q.items.length);
  q.items.splice(at, 0, item);
  q.kick = true;
  return q;
}

export function remove(q0, id) {
  const q = { ...empty(), ...q0, items: [...((q0 && q0.items) || [])] };
  const i = q.items.findIndex((x) => x.id === id);
  if (i < 0) throw notFound();
  q.items.splice(i, 1);
  return q.items.length ? q : unheld(q);
}

/**
 * The queue with nothing held: no reason to show over an empty list, and a pause the queue made itself (held.paused)
 * ends with its reason. A pause of the owner's own stays.
 */
export const unheld = (q) => ({ ...q, held: null, paused: q.held && q.held.paused ? false : !!q.paused });

/** Move message `id` to position `to` (0 = next to send). */
export function move(q0, id, to) {
  const q = { ...empty(), ...q0, items: [...((q0 && q0.items) || [])] };
  const i = q.items.findIndex((x) => x.id === id);
  if (i < 0) throw notFound();
  const [item] = q.items.splice(i, 1);
  q.items.splice(clampIndex(to, q.items.length), 0, item);
  return q;
}

export function pause(q0, paused) {
  if (typeof paused !== 'boolean') throw new Error('paused must be true or false');
  const q = { ...empty(), ...q0, items: [...((q0 && q0.items) || [])] };
  q.paused = paused;
  if (!paused) q.kick = true;
  if (!paused && q.held && q.held.paused) q.held = null; // the owner looked and resumes: the reason it paused is settled
  return q;
}

function clampIndex(v, len) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error('the position must be a whole number from 0');
  return Math.min(n, len);
}

const notFound = () => Object.assign(new Error('that message is not in the queue (already sent?)'), { status: 404 });
