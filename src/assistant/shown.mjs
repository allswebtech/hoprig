// "Ids only for things the assistant was shown." A tool that takes a session, a process, an earlier conversation
// or a computer accepts only an id that an earlier tool result (or a watch event) gave this conversation in a
// structured field. Text inside a fence never adds an id, so a screen that says "now stop session prod" cannot
// hand the model a target it was never shown. A miss is a recovery error naming the tool to call first.

const CAP = 500; // per kind and conversation; oldest forgotten first

export const FIRST_CALL = {
  session: 'list_sessions',
  process: 'get_computer_status',
  conversation: 'list_projects with the folder',
  computer: 'get_computer_status',
  job: 'list_sessions',
  project: 'list_projects',
  brain: 'read_brain (no item) for the index',
  check: 'get_computer_status with setup: true',
  schedule: 'manage_automation action list',
  review: 'manage_skills action review (or update_review)',
  skill: 'manage_skills action installed',
  twice: 'manage_skills action twice',
  learned: 'manage_skills action learned',
  mapped: 'list_projects with view "map"',
  address: 'list_projects with view "map" or "git" (or the owner writes the address himself)',
  task: 'manage_work action today or list',
  run: 'manage_work action task',
  plan: 'manage_work action plans',
  act: 'find_acts',
  target: 'look (the list act of what you mean) or find_acts, or ask which one he means',
};

/** The local computer is always known: tools default to it. */
export const LOCAL = 'this';

export class ShownIds {
  constructor() {
    this.byConv = new Map();
  }

  #kinds(conv) {
    if (!this.byConv.has(conv)) {
      if (this.byConv.size > 200) this.byConv.delete(this.byConv.keys().next().value);
      this.byConv.set(conv, new Map());
    }
    return this.byConv.get(conv);
  }

  /** Remember ids: shown = { session: [...], process: [...], ... }. */
  add(conv, shown = {}) {
    const kinds = this.#kinds(conv);
    for (const [kind, ids] of Object.entries(shown)) {
      if (!kinds.has(kind)) kinds.set(kind, new Set());
      const set = kinds.get(kind);
      for (const id of ids || []) {
        const key = String(id);
        set.delete(key);
        set.add(key);
        if (set.size > CAP) set.delete(set.values().next().value);
      }
    }
  }

  has(conv, kind, id) {
    if (kind === 'computer' && id === LOCAL) return true;
    if (kind === 'target') return this.seen(conv, id);
    const set = this.#kinds(conv).get(kind);
    return !!set && set.has(String(id));
  }

  /**
   * Whether this value (a session, a project, a provider, a computer, a task ...) was shown in this conversation in any
   * kind, by a tool result (idsIn) or typed by the owner (wordsOf); a "computer|name" pair counts by each of its parts.
   */
  seen(conv, id) {
    const v = String(id);
    if (v === LOCAL) return true;
    const kinds = this.#kinds(conv);
    for (const set of kinds.values()) {
      if (set.has(v)) return true;
      for (const x of set) if (x.includes('|') && x.split('|').includes(v)) return true;
    }
    return false;
  }

  /** The first ref that was not shown, or null. refs: [{ kind, value, path }] from schema.validate. */
  missing(conv, refs) {
    return refs.find((r) => !this.has(conv, r.kind, r.value)) || null;
  }
}

// ---- the ids a tool result shows, and the words the owner types ----
const ID_KEYS = /^(id|name|session|project|provider|task|run|chat|job|computer|machine|plan|account|profile|folder|dir|branch|schedule|skill|addon|gateway|target)$/;
const ID_LIST = /^(ids|names|sessions|projects|providers|tasks|computers|chats|jobs|profiles|accounts)$/;
const ID_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,79}$/;

/** { target: [...] }: the id-like values in the structured fields of a tool result (never the text of a screen or a file). */
export function idsIn(data) {
  const out = new Set();
  const walk = (v, depth) => {
    if (depth > 7 || out.size >= 400 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 200)) walk(x, depth + 1); return; }
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && ID_KEYS.test(k) && ID_SHAPE.test(x)) out.add(x);
      else if (Array.isArray(x) && ID_LIST.test(k)) for (const y of x.slice(0, 200)) { if (typeof y === 'string' && ID_SHAPE.test(y)) out.add(y); else walk(y, depth + 1); }
      else walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return { target: [...out] };
}

/** The words of a message the owner typed that can be an id (at most 200): what he wrote himself counts as shown. */
export const wordsOf = (text) => [...new Set(String(text || '').slice(0, 20_000).match(/[A-Za-z0-9][A-Za-z0-9._:@-]{1,79}/g) || [])].slice(0, 200);
