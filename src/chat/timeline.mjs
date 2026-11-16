// The numbered list of a chat's events (src/chat/events.mjs), as the page reads it: numbered from 0, the newest
// EVENTS_MAX kept, and an `epoch` that changes whenever the numbering starts over (the transcript was read again,
// or the dashboard started again), so a page that saw another numbering starts over instead of mixing two.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const EVENTS_MAX = 5000; // kept in memory; the page asks for the last few hundred at a time
export const WINDOW_MAX = 400; // the most events one answer to the page carries without starting over

export class Timeline extends EventEmitter {
  constructor() {
    super();
    this.events = [];
    this.base = 0; // the number of the first event in `events`
    // Random at the start, so a restart of the dashboard never reuses the numbering a page saw before.
    this.epoch = crypto.randomInt(1, 2 ** 40);
    // Goes up with every change, so a page that waits for news (a long poll) knows when to ask again.
    this.version = 0;
    const bump = () => this.version++;
    this.on('change', bump);
    this.on('status', bump);
    this.on('state', bump);
  }

  /** Start over with `events` (a new epoch). */
  reset(events) {
    const kept = events.slice(-EVENTS_MAX);
    this.base = 0;
    this.events = kept.map(({ full, ...e }, i) => ({ ...e, i }));
    this.epoch++;
  }

  push(ev) {
    const e = { agent: null, ...ev, i: this.base + this.events.length, at: ev.at || Date.now() };
    this.events.push(e);
    if (this.events.length > EVENTS_MAX) {
      const drop = this.events.length - EVENTS_MAX + 500;
      this.events.splice(0, drop);
      this.base += drop;
    }
    this.emit('change');
    return e;
  }

  get next() {
    return this.base + this.events.length;
  }

  /** Events numbered from `from` on, at most `max` of the newest when `from` is older than what is kept. */
  since(from, max = 400) {
    const at = Math.max(0, from - this.base);
    const out = this.events.slice(at);
    return out.length > max ? out.slice(-max) : out;
  }

  /**
   * What a page that has events up to `from` (in numbering `epoch`) gets next: { reset, events }. It starts over
   * (the newest 300) when the numbering changed, when `from` is not in the kept events (before them, or after the
   * newest: a numbering of an earlier process), or when more is new than one answer carries.
   */
  window(from, epoch) {
    const reset = epoch !== this.epoch || from < this.base || from > this.next || this.next - from > WINDOW_MAX;
    return { reset, events: reset ? this.since(0, 300) : this.since(from, WINDOW_MAX) };
  }

  /** Up to `n` events before number `before`. */
  before(before, n = 300) {
    const end = Math.max(0, before - this.base);
    return this.events.slice(Math.max(0, end - n), end);
  }
}
