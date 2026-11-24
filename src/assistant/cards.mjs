// Confirm cards: how an L2 action waits for the owner.
//
// A tool call at level L2 never acts. It STAGES a card: the tool, its validated input, the lines the owner reads
// (every value), an expiry (10 min) and a hash of the "before" state. The action runs only when the owner taps
// Confirm in the dashboard, and only if the card is still pending, not expired, used for the first time, and the
// before-state hashes the same as when it was staged (otherwise the world changed under the card and the owner
// would confirm something he did not see). The store is the single place that enforces this.
import crypto from 'node:crypto';

export const CARD_TTL_MS = 10 * 60_000;
const KEEP_DONE = 200; // finished cards kept for the activity view

/** A stable hash of any JSON value: object keys sorted, so equal states hash the same. */
export function stateHash(value) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    return v === undefined ? null : v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canon(value))).digest('hex');
}

export class CardError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // "unknown" | "expired" | "used" | "stale" | "rejected"
  }
}

export class CardStore {
  constructor({ now = Date.now, ttlMs = CARD_TTL_MS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.cards = new Map();
  }

  /**
   * Stage an action. o: { tool, input, lines (what the owner reads), before (the state it was decided on),
   * conversation, view? (the values the page says in its own words) }. Returns the public card.
   */
  stage({ tool, input, lines, before, conversation = 'direct', view = null, form = null }) {
    this.#sweep();
    const id = `c_${crypto.randomBytes(6).toString('hex')}`;
    const at = this.now();
    const card = {
      id, tool, input, lines, conversation, ...(view ? { view } : {}), ...(form ? { form } : {}),
      beforeHash: stateHash(before),
      status: 'pending', // pending → running → done | failed;  pending → rejected | expired | stale
      createdAt: at, expiresAt: at + this.ttlMs, decidedAt: null, outcome: null,
    };
    this.cards.set(id, card);
    return publicCard(card);
  }

  get(id) {
    this.#sweep();
    const c = this.cards.get(id);
    return c ? publicCard(c) : null;
  }

  /** Cards waiting for the owner, oldest first. */
  pending() {
    this.#sweep();
    return [...this.cards.values()].filter((c) => c.status === 'pending').map(publicCard);
  }

  /**
   * Take a card for execution: it must be pending and unexpired, and `currentBefore` must hash the same as the
   * staged state. On success the card is marked running (single use: a second take fails). `revised`: the owner changed
   * a value of a form card before his OK ({ input, line }, checked by core.mjs confirm): the card's input becomes it, its
   * form shows the new value and the line says what he changed, in the same step as the take, so the record is the
   * value that runs. Returns the full card.
   */
  take(id, currentBefore, revised = null) {
    this.#sweep();
    const c = this.cards.get(id);
    if (!c) throw new CardError('unknown', 'there is no such card');
    if (c.status === 'expired') throw new CardError('expired', 'the card expired; ask again');
    if (c.status === 'rejected') throw new CardError('rejected', 'the card was declined');
    if (c.status !== 'pending') throw new CardError('used', 'the card was already used');
    if (stateHash(currentBefore) !== c.beforeHash) {
      c.status = 'stale';
      c.decidedAt = this.now();
      throw new CardError('stale', 'things changed since the card was made; nothing was done, ask again');
    }
    if (revised) {
      const { input, line } = revised;
      c.input = input;
      c.lines = [...c.lines, line];
      if (c.form) c.form = { ...c.form, fields: c.form.fields.map((f) => (f.type === 'readonly' || input[f.name] === undefined ? f : { ...f, value: input[f.name] })) };
    }
    c.status = 'running';
    c.decidedAt = this.now();
    return { ...c };
  }

  /** The state a card was made on cannot be read any more (the session is gone): it can never run. */
  markStale(id) {
    const c = this.cards.get(id);
    if (!c || c.status !== 'pending') return null;
    c.status = 'stale';
    c.decidedAt = this.now();
    return publicCard(c);
  }

  finish(id, outcome) {
    const c = this.cards.get(id);
    if (!c || c.status !== 'running') return null;
    c.status = outcome && outcome.ok ? 'done' : 'failed';
    c.outcome = outcome;
    return publicCard(c);
  }

  /**
   * A card whose act did not run but may be tried again as it is (a wrong password): back from running to pending,
   * with its full time again, so the owner can answer it anew without Tia making a fresh card.
   */
  keepPending(id) {
    const c = this.cards.get(id);
    if (!c || c.status !== 'running') return null;
    c.status = 'pending';
    c.decidedAt = null;
    c.expiresAt = this.now() + this.ttlMs;
    return publicCard(c);
  }

  reject(id) {
    this.#sweep();
    const c = this.cards.get(id);
    if (!c) throw new CardError('unknown', 'there is no such card');
    if (c.status !== 'pending') throw new CardError('used', `the card is already ${c.status}`);
    c.status = 'rejected';
    c.decidedAt = this.now();
    return publicCard(c);
  }

  #sweep() {
    const now = this.now();
    for (const c of this.cards.values()) {
      if (c.status === 'pending' && now >= c.expiresAt) {
        c.status = 'expired';
        c.decidedAt = c.expiresAt;
      }
    }
    if (this.cards.size > KEEP_DONE) {
      const old = [...this.cards.values()].filter((c) => c.status !== 'pending' && c.status !== 'running').sort((a, b) => a.createdAt - b.createdAt);
      for (const c of old.slice(0, this.cards.size - KEEP_DONE)) this.cards.delete(c.id);
    }
  }
}

/** What the dashboard and the model may see of a card (the before-state itself is not kept, only its hash). */
function publicCard(c) {
  return {
    id: c.id, tool: c.tool, input: c.input, lines: c.lines, ...(c.view ? { view: c.view } : {}), ...(c.form ? { form: c.form } : {}), conversation: c.conversation, status: c.status,
    createdAt: c.createdAt, expiresAt: c.expiresAt, decidedAt: c.decidedAt, outcome: c.outcome, beforeHash: c.beforeHash.slice(0, 12),
  };
}
