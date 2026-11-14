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
  mapped: 'list_projects with view "map"',
  address: 'list_projects with view "map" or "git" (or the owner writes the address himself)',
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
    const set = this.#kinds(conv).get(kind);
    return !!set && set.has(String(id));
  }

  /** The first ref that was not shown, or null. refs: [{ kind, value, path }] from schema.validate. */
  missing(conv, refs) {
    return refs.find((r) => !this.has(conv, r.kind, r.value)) || null;
  }
}
