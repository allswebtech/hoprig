// The messages the owner writes while a turn runs. Where the coding tool queues by itself (the engine's
// capabilities.queue; Claude Code does, and takes a queued message at its next step or after the turn), each is
// handed to it at once ("sent") and can be taken back until it starts; else the chat holds it ("held") and sends it
// as the next turn. A message is shown in the chat once the coding tool has taken it.
const QUEUE_MAX = 20;
const fail = (status, message) => Object.assign(new Error(message), { status });

export class MessageQueue {
  constructor(onChange) {
    this.items = []; // { id, text, images, attachments, state: held | sent, at, taken (the coding tool refused to give it back), unsure (a take-back's cancel failed) }
    this.onChange = onChange;
  }

  get length() {
    return this.items.length;
  }
  find(id) {
    return this.items.find((q) => q.id === id) || null;
  }
  /** What the page shows: no picture data. */
  list() {
    return this.items.map(({ id, text, attachments, state }) => ({ id, text, attachments, state }));
  }

  /** A message written while a turn runs; `session` (when it runs and queues by itself) gets it at once. */
  add(msg, session) {
    if (this.items.length >= QUEUE_MAX) throw fail(409, `${QUEUE_MAX} messages wait already: wait for them, or take one back`);
    const item = { ...msg, state: 'held', at: Date.now() };
    this.items.push(item);
    if (session) {
      session.send(msg);
      item.state = 'sent';
    }
    this.onChange();
    return item;
  }

  /** What was held while the coding tool started goes to it now. */
  sendHeld(session) {
    for (const q of this.items) {
      if (q.state !== 'held') continue;
      session.send(q);
      q.state = 'sent';
    }
  }

  /** Out of the queue (taken by the coding tool, or taken back). → the message, or null. */
  take(id) {
    const q = this.find(id);
    if (!q) return null;
    this.items = this.items.filter((x) => x !== q);
    this.onChange();
    return q;
  }

  /** The next held message, out of the queue (the chat sends it as the next turn). */
  nextHeld() {
    const q = this.items.find((x) => x.state === 'held');
    return q ? this.take(q.id) : null;
  }

  /** Take a message back; refused once the coding tool has started on it. */
  async remove(id, session, label) {
    const q = this.find(id);
    if (!q) throw fail(409, 'that message is not waiting any more: it was read, or taken back already');
    if (q.state === 'sent' && session) {
      let back;
      try {
        back = await session.cancel(id);
      } catch {
        // The cancel failed (an error, not a no): whether the coding tool has it is not known, so it is not given
        // back when the process goes either (hear.mjs lostWork), and the answer says only what is known.
        q.unsure = true;
        throw fail(409, `${label} could not take that message back (the cancel failed): it may still run`);
      }
      if (!back) {
        q.taken = true; // the coding tool has it: it is not given back when the process goes (hear.mjs lostWork)
        throw fail(409, `${label} has already taken that message`);
      }
    }
    this.take(id);
  }

  /** The process is gone: what it had queued went with it. → how many. */
  lose() {
    const n = this.items.filter((q) => q.state === 'sent').length;
    if (n) {
      this.items = this.items.filter((q) => q.state !== 'sent');
      this.onChange();
    }
    return n;
  }
  clear() {
    this.items = [];
  }
}
