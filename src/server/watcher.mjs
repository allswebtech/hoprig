// The server-side watcher: one loop that looks at the sessions every few seconds and
//   1. sends push notifications (notify.mjs) when a session starts waiting, needs an OK, hits a limit or ends;
//   2. is the safety net for auto-switch. The launcher itself moves a session when Claude Code reports a rate
//      limit (its run record then has a `limit` field and a new run appears). When only the screen shows a limit
//      (no `limit` in the run) for more than GRACE_MS and auto-switch is on, the watcher does the same move the
//      Switch button does, sends the continue prompt once the new run waits, and marks the old profile limited.
// It ticks every 5 s while there are Claude sessions or a move in progress, else every 30 s.
import { describe, sendNotification } from './notify.mjs';

export const GRACE_MS = 20_000;
const PENDING_MAX_MS = 3 * 60_000;

/**
 * Add the run fields the cards need but the session list may not carry yet: runId, lastMessage, usage, runLimit.
 * A card is matched to its run by session id, profile and folder; the newest such run wins.
 */
export function enrich(cards, runs) {
  return cards.map((c) => {
    if (c.kind !== 'claude') return c;
    let run = c.runId ? runs.find((r) => r.runId === c.runId) : null;
    if (!run && c.sessionId) {
      run = runs
        .filter((r) => r.sessionId === c.sessionId && c.profile && r.profile === c.profile.name && r.cwd === c.cwd)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
    }
    if (!run) return c;
    return {
      ...c,
      runId: run.runId,
      lastMessage: typeof run.lastMessage === 'string' ? run.lastMessage.slice(0, 300) : c.lastMessage || '',
      usage: run.usage && typeof run.usage === 'object' ? run.usage : c.usage || null,
      runLimit: run.limit && typeof run.limit === 'object' ? run.limit : null,
      fallback: run.fallback === true,
    };
  });
}

/** What a card is, for notifications: limit (wins), shell, or the run status. */
export const stateOf = (c) => (c.limit || c.runLimit ? 'limit' : c.kind === 'shell' ? 'shell' : c.status || 'unknown');

const NOTIFY = new Set(['waiting', 'attention', 'limit']);

/**
 * Compare the last seen states with the cards now. Returns { events, next }. Nothing fires the first time a
 * session is seen (a server start does not replay old states).
 */
export function transitions(prev, cards) {
  const next = new Map();
  const events = [];
  for (const c of cards) {
    const s = stateOf(c);
    next.set(c.name, s);
    const before = prev.get(c.name);
    if (before === undefined || before === s) continue;
    if (NOTIFY.has(s)) events.push({ status: s, card: c });
    else if (s === 'shell' && before !== 'shell') events.push({ status: 'ended', card: c });
  }
  for (const [name, s] of prev) {
    // A chat (src/chat) leaves the list only when the owner closed it or opened it in a terminal: nothing to tell.
    if (!next.has(name) && s !== 'shell' && !name.startsWith('chat:')) events.push({ status: 'ended', card: { name } });
  }
  return { events, next };
}

/**
 * The auto-switch safety net's decision. `seen` (Map runId → first time the screen showed the limit) and `done`
 * (Set of runIds already moved) carry state between ticks and are updated here. Returns the moves to make.
 */
export function planAutoSwitch({ cards, auto, now, seen, done, nextProfile, graceMs = GRACE_MS }) {
  const moves = [];
  const limitedNow = new Set();
  for (const c of cards) {
    // Auto sessions never stop at a limit: the router moves their requests by itself.
    if (c.kind !== 'claude' || !c.limit || c.runLimit || !c.runId || !c.profile || c.profile.name === 'auto') continue;
    limitedNow.add(c.runId);
    if (!seen.has(c.runId)) seen.set(c.runId, now);
    if (!auto || !auto.enabled || done.has(c.runId) || !c.canSwitch) continue;
    if (now - seen.get(c.runId) < graceMs) continue;
    const to = nextProfile(c.profile.name);
    if (!to || to === c.profile.name) continue;
    done.add(c.runId); // never twice for the same limit, even when the move below fails
    moves.push({ name: c.name, from: c.profile.name, to, runId: c.runId, text: c.limit.text || '' });
  }
  for (const id of seen.keys()) if (!limitedNow.has(id)) seen.delete(id);
  return moves;
}

export class Watcher {
  /**
   * @param {object} o
   * @param {() => Promise<object[]>} o.cards   enriched session cards
   * @param {object} o.deck                     find(name), move(term, run, profile), send(termId, text)
   * @param {object} o.auto                     { getAutoSwitch, nextProfile, markLimited }
   * @param {() => object} o.settings           returns { notify, publicUrl }
   */
  constructor({ cards, deck, auto, settings, log = console.log, now = Date.now, send = sendNotification, graceMs = GRACE_MS, tickMs = 5000 }) {
    Object.assign(this, { cards, deck, auto, settings, log, now, send, graceMs, tickMs });
    this.prev = null;
    this.seen = new Map();
    this.done = new Set();
    this.pending = new Map(); // session name → { to, prompt, since }
    this.timer = null;
    this.nextAt = 0;
    this.running = false;
    this.stopped = true;
    this.tickListeners = new Set();
  }

  /** fn(cards) after every look at the sessions (features use it: server.mjs ctx.onTick). Returns an unsubscribe. */
  onTick(fn) {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  start() {
    this.stopped = false;
    this.#schedule(1000);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Look again soon (a session was just started or a page is watching). */
  poke() {
    // Only ever brings the next tick forward: pokes arriving faster than 200 ms must not keep postponing it.
    if (!this.stopped && !this.running && this.nextAt - Date.now() > 200) this.#schedule(200);
  }

  #schedule(ms) {
    clearTimeout(this.timer);
    this.nextAt = Date.now() + ms;
    this.timer = setTimeout(() => this.tick().catch((e) => this.log(`watcher: ${e.message}`)), ms);
    this.timer.unref?.();
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    let busy = false;
    try {
      const cards = await this.cards();
      busy = cards.some((c) => c.kind === 'claude') || this.pending.size > 0;
      await this.#notify(cards);
      await this.#autoSwitch(cards);
      await this.#followUp(cards);
      for (const fn of this.tickListeners) {
        try {
          await fn(cards);
        } catch (e) {
          this.log(`watcher: ${e.message}`);
        }
      }
    } finally {
      this.running = false;
      if (!this.stopped) this.#schedule(busy ? this.tickMs : Math.max(this.tickMs, 30_000));
    }
  }

  #link(name) {
    const base = this.settings().publicUrl;
    // A chat (src/chat) is "chat:<id>" among the sessions; its page is #/chat/<id>.
    const page = name.startsWith('chat:') ? `chat/${name.slice(5)}` : `s/${encodeURIComponent(name)}`;
    return base ? `${base.replace(/\/+$/, '')}/#/${page}` : '';
  }

  emit(status, name, message = '', label = name) {
    const { notify } = this.settings();
    if (!notify || !notify.url) return;
    const d = describe(status, label, message);
    // Not awaited: a slow receiver never holds up the loop.
    this.send(notify, { ...d, status, session: name, url: this.#link(name) }).catch(() => {});
  }

  async #notify(cards) {
    const { events, next } = transitions(this.prev || new Map(), cards);
    const first = this.prev === null;
    this.prev = next;
    if (first) return;
    for (const e of events) {
      const c = e.card;
      const msg = e.status === 'limit' ? (c.limit && c.limit.text) || (c.runLimit && c.runLimit.error) || '' : c.lastMessage || c.note || '';
      this.emit(e.status, c.name, msg, c.display || c.name);
    }
  }

  async #autoSwitch(cards) {
    const auto = this.auto.getAutoSwitch();
    const moves = planAutoSwitch({ cards, auto, now: this.now(), seen: this.seen, done: this.done, nextProfile: this.auto.nextProfile, graceMs: this.graceMs });
    for (const m of moves) {
      try {
        const found = await this.deck.find(m.name);
        if (!found || !found.run) continue;
        await this.deck.move(found.term, found.run, m.to);
        this.auto.markLimited(m.from, { text: m.text, reason: 'screen', until: this.auto.parseResets ? this.auto.parseResets(m.text) : null });
        this.pending.set(m.name, { to: m.to, prompt: auto.prompt, since: this.now() });
        this.log(`auto-switch: moved "${m.name}" from ${m.from} to ${m.to} (limit seen on screen: ${m.text.slice(0, 80)})`);
        this.emit('switched', m.name, `${m.from} → ${m.to}`);
      } catch (e) {
        this.log(`auto-switch: moving "${m.name}" from ${m.from} to ${m.to} failed: ${e.message}`);
      }
    }
  }

  // After a move: once the new run waits for input, type the continue prompt, once.
  async #followUp(cards) {
    for (const [name, p] of this.pending) {
      if (this.now() - p.since > PENDING_MAX_MS) {
        this.pending.delete(name);
        continue;
      }
      const c = cards.find((x) => x.name === name);
      if (!c) {
        this.pending.delete(name);
        continue;
      }
      if (c.kind === 'claude' && c.profile && c.profile.name === p.to && c.status === 'waiting') {
        this.pending.delete(name);
        if (!p.prompt) continue;
        try {
          const found = await this.deck.find(name);
          if (found) await this.deck.send(found.term.id, p.prompt);
        } catch (e) {
          this.log(`auto-switch: sending the continue prompt to "${name}" failed: ${e.message}`);
        }
      }
    }
  }
}
