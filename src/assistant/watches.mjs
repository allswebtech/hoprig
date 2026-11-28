// Watches (design 2.4): "tell me when it needs me". A watch is the owner's own state, one line in a file of Hoprig's own
// state folder: what to watch, when to tell, how, for how many hours. It changes nothing else and costs no model turn: the
// attention loop (src/operator/attention.mjs) reads the facts it already has, calls `evaluate` here, and a watch whose
// condition is met FIRES once: a push through the existing notification way, or a row in Needs you. `wake` also pushes and
// asks to wake her for a decision, which is a model turn, so it is capped at WAKES_PER_DAY a day.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { stateDir } from '../paths.mjs';
import { replaceFile } from '../replacefile.mjs';

export const MAX_WATCHES = 50;
export const HOURS = Object.freeze({ min: 1, max: 72 });
export const WAKES_PER_DAY = 10;
export const ON = Object.freeze(['session', 'chat', 'job', 'gateway', 'provider', 'schedule', 'ship', 'computer', 'update']);
export const WHEN = Object.freeze(['needs-me', 'ends', 'fails', 'limit', 'slow', 'back', 'done', 'answers']);
export const TELL = Object.freeze(['push', 'row', 'wake']);
export const WATCH_ID = /^w_[0-9a-f]{10}$/;

// Which "when" each thing can say (a closed table: a watch outside it is refused with the ones that work).
export const WHEN_OF = Object.freeze({
  session: ['needs-me', 'ends', 'fails', 'limit', 'slow', 'done'],
  chat: ['needs-me', 'ends', 'fails', 'limit', 'done'],
  job: ['needs-me', 'ends', 'fails', 'done'],
  gateway: ['fails', 'back'],
  provider: ['limit', 'back'],
  schedule: ['fails', 'done'],
  ship: ['fails', 'done'],
  computer: ['fails', 'back'],
  update: ['answers'],
});

export const watchesFile = () => path.join(stateDir(), 'assistant', 'watches.json');

const key = (w) => `${w.on}|${w.target || ''}|${w.when}`;
const said = (w) => `${w.on}${w.target ? ` ${w.target}` : ''}`.slice(0, 60);
const WORDS = { 'needs-me': 'needs you', ends: 'ended', fails: 'failed', limit: 'stopped at a usage limit', slow: 'has made no progress', back: 'is back', done: 'is done', answers: 'has an answer' };
/** The sentence a watch tells when it fires. */
export const sentence = (w) => `${said(w)} ${WORDS[w.when]}.`;

/**
 * The facts of one look, in the form the conditions read, from the board and the attention items the loop already has:
 * sessions by name, work runs, providers, computers, gateways. Nothing is fetched here.
 */
export function factsOf(board = {}, items = []) {
  const by = (list, k) => new Map((Array.isArray(list) ? list : []).filter((x) => x && x[k] != null).map((x) => [String(x[k]), x]));
  return {
    sessions: by(board.sessions, 'name'), runs: by(board.work && board.work.runs, 'id'), providers: by(board.providers, 'name'),
    computers: by(board.computers, 'name'), gateways: by(board.gateways, 'name'), schedules: by(board.schedules, 'name'),
    items: Array.isArray(items) ? items : [],
  };
}

const stuckFor = (f, name) => f.items.some((i) => i.kind === 'stuck' && i.target && i.target.session === name);

/** Whether the condition of a watch is true now (plain data; null: what it watches cannot be seen, so it is not told). */
export function met(w, f) {
  const t = w.target;
  if (w.on === 'session' || w.on === 'chat') {
    const s = f.sessions.get(t);
    if (!s) return null;
    switch (w.when) {
      case 'needs-me': return (s.asks || []).length > 0 || s.state === 'asks' || s.state === 'needs_ok';
      case 'ends': return s.state === 'ended';
      case 'done': return s.state === 'ended' || s.state === 'waiting';
      case 'limit': return !!s.limit;
      // Failed: it stopped at a usage limit, or the board says it failed (an end with an error).
      case 'fails': return !!s.limit || s.state === 'failed' || s.failed === true;
      case 'slow': return stuckFor(f, t);
      default: return false;
    }
  }
  if (w.on === 'job') {
    const r = f.runs.get(t);
    if (!r) return null;
    if (w.when === 'fails') return r.state === 'failed' || r.state === 'limit';
    if (w.when === 'needs-me') return r.state === 'stopped';
    return r.state === 'done' || (w.when === 'ends' && ['failed', 'stopped', 'limit'].includes(r.state));
  }
  if (w.on === 'provider') {
    const p = f.providers.get(t);
    if (!p) return null;
    const limited = !!p.limited || ['fiveHour', 'week'].some((k) => p.usage && p.usage[k] && p.usage[k].pct >= 100);
    return w.when === 'limit' ? limited : !limited;
  }
  if (w.on === 'computer' || w.on === 'gateway') {
    const x = (w.on === 'computer' ? f.computers : f.gateways).get(t);
    if (!x) return null;
    const up = w.on === 'computer' ? x.status === 'online' || x.online === true : x.running === true;
    return w.when === 'fails' ? !up : up;
  }
  return null;
}

export class WatchStore {
  /** `file`: where they are kept (null: in memory only). `notify(text, w)`: the push (the existing notification way). */
  constructor({ file = watchesFile(), now = Date.now, notify = null } = {}) {
    this.file = file;
    this.now = now;
    this.notify = notify;
    this.mem = [];
  }

  read() {
    if (!this.file) return this.mem;
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(v.watches) ? v.watches : [];
    } catch { return []; }
  }

  write(list) {
    if (!this.file) { this.mem = list; return; }
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ watches: list })}\n`, { mode: 0o600 });
    replaceFile(tmp, this.file);
  }

  /** Watches that have not run out. A fired one stays listed until its hours are over or it is removed. */
  list() {
    const now = this.now();
    return this.read().filter((w) => w.expiresAt > now);
  }

  add({ on, target = '', when, tell = 'push', hours = 24 }) {
    if (!ON.includes(on)) return { error: `watch one of: ${ON.join(', ')}` };
    if (!WHEN_OF[on].includes(when)) return { error: `a ${on} can be watched for: ${WHEN_OF[on].join(', ')}` };
    if (!Number.isInteger(hours) || hours < HOURS.min || hours > HOURS.max) return { error: `hours is ${HOURS.min} to ${HOURS.max}` };
    if (!TELL.includes(tell)) return { error: `tell is one of: ${TELL.join(', ')}` };
    if (on !== 'update' && !target) return { error: `say which ${on}` };
    const list = this.list();
    const w = { id: `w_${crypto.randomBytes(5).toString('hex')}`, on, target: String(target).slice(0, 64), when, tell, hours, createdAt: this.now(), expiresAt: this.now() + hours * 3600_000, firedAt: null };
    const same = list.find((x) => key(x) === key(w) && !x.firedAt);
    if (same) return { watch: same, already: true };
    if (list.length >= MAX_WATCHES) return { error: `${MAX_WATCHES} watches are kept at most: remove one first` };
    this.write([...list, w]);
    return { watch: w };
  }

  /** A watch that was removed, put back as it was (Undo): refused when it ran out meanwhile or the list is full. */
  put(w) {
    if (!w || typeof w !== 'object' || !WATCH_ID.test(String(w.id))) return { error: 'that watch cannot be put back' };
    const list = this.list();
    if (list.some((x) => x.id === w.id)) return { watch: list.find((x) => x.id === w.id), already: true };
    if (!(w.expiresAt > this.now())) return { error: 'the watch ran out meanwhile: left as it is' };
    if (list.length >= MAX_WATCHES) return { error: `${MAX_WATCHES} watches are kept at most: remove one first` };
    this.write([...list, w]);
    return { watch: w };
  }

  remove(id) {
    const list = this.list();
    if (!list.some((w) => w.id === id)) return false;
    this.write(list.filter((w) => w.id !== id));
    return true;
  }

  /** The wakes that were made in the last day (for the cap). */
  #wakesToday(list) { return list.filter((w) => w.tell === 'wake' && w.firedAt && w.firedAt > this.now() - 24 * 3600_000).length; }

  /**
   * One look: every watch whose condition is met fires once. Costs no model turn. -> the events that fired
   * [{ watch, text, tell, wake }]; `wake` is true only while fewer than WAKES_PER_DAY wakes were made today (past the cap a
   * wake is told as a push and nothing wakes her).
   */
  evaluate(facts) {
    const list = this.list();
    const fired = [];
    let wakes = this.#wakesToday(list);
    for (const w of list) {
      if (w.firedAt) continue;
      if (met(w, facts) !== true) continue;
      w.firedAt = this.now();
      let wake = false;
      if (w.tell === 'wake' && wakes < WAKES_PER_DAY) { wake = true; wakes++; }
      fired.push({ watch: w, text: sentence(w), tell: w.tell, wake });
    }
    if (fired.length) {
      this.write(list);
      for (const e of fired) if (e.tell !== 'row' && this.notify) { try { this.notify(e.text, e.watch); } catch { /* a push that fails does not stop the loop */ } }
    }
    return fired;
  }

  /** The fired watches that are to show as a row in Needs you (tell row), still within their hours. */
  rows() {
    return this.list().filter((w) => w.firedAt && w.tell === 'row');
  }
}
