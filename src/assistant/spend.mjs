// What Tia spends on providers billed by use, against the daily cap the owner set (Settings → Tia → Daily spending
// cap). The contract's one exception to "money waits for his tap": paid usage inside a cap he set himself. Without a
// cap, or once it is reached, a paid act of hers is a card, and her own turn on a paid provider is refused.
//
// The ledger is one JSON line per entry in <stateDir>/assistant/spend.jsonl, so a restart keeps the day's sum:
//   { at, kind: "hold" }            a paid act of hers ran without a card: HOLD_USD counted at once, before it spends
//   { at, kind: "spent", usd, what } what such work cost when its turn ended (her own turn)
//   { at, kind: "hold", id, owner: true }  a paid act ran from his tap on a card: counted, never checked against the cap
//   { at, kind: "hold", id, usd }  a part's budget (partdoor.mjs, chat/feature.mjs): while its process runs it counts the
//                                   larger of usd and what its chat was measured to cost; settled ({ kind: "spent", hold })
//                                   when its process ends, it counts what it cost
//   { at, kind: "spent", usd: 0, hold, cut, why }  that process ended inside a turn whose cost it never reported, or
//                                   (why "unseen") its end was never seen (the dashboard stopped while it ran): the rest
//                                   of its budget, `cut`, is counted for the day as what could not be measured, never
//                                   as spent; each reason is said in its own words (cutWords, unseenWords)
//   { at, kind: "bind", hold, session, base, message? }  that act went into a chat she started ("<computer>|chat:<id>");
//                                   base: the chat's running cost (its costTotal) before it; message: the chat's id of the
//                                   message the act sent (send_to_chat's text; none for a new chat's first message or a part)
//   { at, kind: "measured", session, usd, working }  what that chat has cost since its first bind of the day, as its
//                                   coding tool reported it; working: a turn of it runs now (its cost not reported yet)
//   { at, kind: "ended", hold, message, cost, back? }  how the message of a bind with a message id ended, as its chat
//                                   told (measureChats, once per hold): cost, what the turn that ran it reported (null:
//                                   none, a crash or a stop); back: it never ran (taken back, or lost with the process)
// An act bound with a message id is settled by that message alone: its hold goes once an "ended" entry with a cost is
// written (only after the chat's measured figure holds that turn's cost, so the sum is never lower in between), and is
// given back by one with `back`. Ended without a cost, not ended yet, or not known (a dashboard restart the chat cannot
// tell it across): HOLD_USD for the day. A forked chat's first turn ends without a cost too (the fork starts with no
// running cost, so that turn's own cost cannot be told apart from the total it reports): its hold stays, the safe side.
// The rules below are for acts bound without one.
// A chat's measured cost takes the place of the hold of an act that went into it once a turn that began after that
// act (the chat seen idle, then working) was seen idle again at a figure higher than where that turn began (it ended
// and reported its cost). A turn already running at the act is an earlier message's, so its end settles nothing of it.
// Until then the act counts HOLD_USD on top of what the chat has cost so far: its turn may run now or wait in the
// chat's queue, or it ended without a reported cost (its coding tool crashed), which measured nothing. A chat she just
// started (`fresh`) has no earlier turn, so a rise of its figure while idle is that act's own: its hold goes then too. A turn of
// an older chat too short to be seen working keeps its hold for the day: counted twice, never less than what ran. A terminal session, a chat on
// another computer and a chat on an earlier conversation are not measured: their acts count HOLD_USD each for the day.
// A measured cost takes the place of its own act's hold (by id); a hold nobody settles counts for the rest of the day
// (the safe side: what a session or chat she started costs is not measured, so it counts HOLD_USD per paid act).
// Her own turn is also given what is left of the cap as its budget (--max-budget-usd), so one turn cannot run past it. The check and the
// hold happen in one synchronous step (take), so two calls at the same moment cannot both pass the last free amount;
// across processes (two dashboards on one state folder) that step, and every other write, runs under a lock file
// beside the ledger.
// The day is this computer's own (local midnight), as the usage summary's "today".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';

export const HOLD_USD = 0.5;
export const CAP_MAX_USD = 10_000;
// The smallest budget a part is given (Claude Code's --max-budget-usd takes any amount above 0; the figures here are
// cents, so a cent is the least there is). A part whose share is less does not start.
export const PART_MIN_USD = 0.01;
export const spendFile = () => path.join(stateDir(), 'assistant', 'spend.jsonl');

/** A provider billed by use: an API key, or one the profile says is paid per use (profiles.mjs isPayPerUse). */
export const isPaid = (p) => !!p && p.name !== 'auto' && (p.kind === 'api' || p.paid === true);

/**
 * The provider `name` spends by use, by the accounts as the dashboard lists them ({ profiles, autoSwitch }). Auto mode
 * is paid when the order it really uses holds a provider billed by use: the router moves a session onto it at a limit
 * (and serves the requests with it when it comes first), so a start or a turn under Auto may spend.
 */
export function paidName(name, accounts = {}) {
  const profiles = accounts.profiles || [];
  if (name !== 'auto') return isPaid(profiles.find((p) => p.name === name));
  const order = (accounts.autoSwitch && Array.isArray(accounts.autoSwitch.order) ? accounts.autoSwitch.order : []);
  // "Also use pay-per-use API keys" off: the router leaves out of the order it uses every provider billed by use
  // (autoswitch.mjs usableOrder): a key whose own file says it is paid per use (profiles.mjs isPayPerUse), and a stored
  // sign-in on a Console account's key (routerstate.mjs billedLogin), which the dashboard's list marks `paid` too. So
  // every provider marked `paid` is dropped here, and nothing is spent on it. An API provider through a gateway is not
  // marked `paid`: the router keeps it, so it still counts (the safe side). A provider that does not serve Claude Code
  // (an OpenAI key: its `tools` leave out "claude") never takes part either way; one listed without `tools` counts.
  const routerDrops = (p) => !!p && p.paid === true;
  const serves = (p) => !!p && (!Array.isArray(p.tools) || p.tools.includes('claude'));
  const used = accounts.autoSwitch && accounts.autoSwitch.payPerUse === false ? order.filter((n) => !routerDrops(profiles.find((p) => p.name === n))) : order;
  return used.some((n) => ((p) => serves(p) && isPaid(p))(profiles.find((p) => p.name === n)));
}

const midnight = (now) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
// A short synchronous wait between tries for the lock (take stays one synchronous step in this process). The whole
// wait is short: the lock is held for one read and one line, and the dashboard's one thread waits with it.
const WAIT = new Int32Array(new SharedArrayBuffer(4));
const LOCK_WAIT_MS = 150;
const STALE_MS = 5000;
const WRITE_WAIT_MS = 1000;
/** A lock file's identity (one instance of it: made with 'wx', never written to), or null when there is none. */
const lockSeen = (lock) => {
  try {
    const s = fs.statSync(lock);
    return { ino: s.ino, dev: s.dev, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
};
const sameLock = (a, b) => !!(a && b && a.ino === b.ino && a.dev === b.dev && a.mtimeMs === b.mtimeMs);
/** take()'s answer when another dashboard holds the lock: nothing was held; the cap was not checked. */
export const BUSY = 'another dashboard is writing the spending record just now; try again in a moment';
const money = (v) => `$${(Math.round(v * 100) / 100).toFixed(2)}`;

export class SpendLedger {
  /** file: a path, or null to keep entries in memory only (tests). */
  constructor({ file = spendFile(), now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.memory = [];
  }

  /** A lock that kept a write waiting its whole wait (see #append), or null. */
  #stuck = null;

  #entries() {
    if (!this.file) return this.memory;
    try {
      return fs.readFileSync(this.file, 'utf8').split('\n').flatMap((l) => {
        try {
          const e = l ? JSON.parse(l) : null;
          return e && Number.isFinite(e.at) ? [e] : [];
        } catch {
          return [];
        }
      });
    } catch {
      return [];
    }
  }

  /**
   * Write one entry. Every write of the ledger runs under the lock file that take() uses, so the rewrite below never
   * drops a line another dashboard on the same state folder appended in between. A write waits for the lock longer
   * than take() does: a line appended without the lock while a live holder rewrites the file goes into the file the
   * rewrite replaces, and is lost. A holder keeps it for one read and one line, or one rewrite.
   * When one lock stays the same file for the whole wait, its holder ended inside it (not old enough to take over
   * yet): the line is appended without the lock and without the rewrite, and that lock is remembered, so the writes
   * after it append at once while it is still there and not stale. The dashboard's one thread waits once per such
   * lock, not a second for every line (measureChats writes one per chat).
   */
  #append(entry) {
    if (!this.file) return void this.memory.push(entry);
    const lock = `${this.file}.lock`;
    const before = lockSeen(lock);
    if (sameLock(before, this.#stuck) && Date.now() - before.mtimeMs <= STALE_MS) return void this.#write(entry, { rewrite: false });
    if (this.#locked(() => this.#write(entry), WRITE_WAIT_MS) !== undefined) return;
    // Held all the time by one lock (not one of many a busy peer took in turn): remembered as left behind.
    const after = lockSeen(lock);
    this.#stuck = sameLock(before, after) ? after : null;
    this.#write(entry, { rewrite: false });
  }

  /** The write itself; the caller holds the lock (or, with rewrite false, appends only). */
  #write(entry, { rewrite = true } = {}) {
    if (!this.file) return void this.memory.push(entry);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (rewrite) this.#shrink();
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    return true;
  }

  /**
   * Only today matters: a file past a few hundred KB that holds entries of an earlier day is rewritten with today's
   * (a day whose own entries are that big has nothing to drop, and is left as it is). Written beside it and renamed
   * over it, so a reader sees the old file or the new one, never half of one.
   */
  #shrink() {
    try {
      if (fs.statSync(this.file).size <= 256 * 1024) return;
      const from = midnight(this.now());
      const all = this.#entries();
      if (!all.some((e) => e.at < from)) return;
      const tmp = `${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      try {
        fs.writeFileSync(tmp, all.filter((e) => e.at >= from).map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
        fs.renameSync(tmp, this.file);
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    } catch {
      /* no file yet, or it cannot be rewritten: appending still works */
    }
  }

  #day() {
    const from = midnight(this.now());
    return this.#entries().filter((e) => e.at >= from);
  }

  /**
   * Today's sum, in parts: spent (measured: her own turns and the chats she started), held (HOLD_USD for each act whose
   * cost is not measured, and for each such chat while a turn of it runs), unmeasured (how many acts count HOLD_USD
   * because their cost is not known: a terminal session, a chat that reported nothing yet) and tapped (paid acts that
   * ran from his tap on a card, counted like hers). With parts: parts and partsHeld (the budgets of those that run now,
   * less what they cost so far), and cuts and cutHeld (the parts that ended before they reported a turn's cost, and
   * the rest of their budgets, which is in held: counted for the day as what could not be measured).
   */
  detail(rests = null) {
    const day = this.#day();
    let spent = day.filter((e) => e.kind === 'spent').reduce((n, e) => n + (Number.isFinite(e.usd) && e.usd > 0 ? e.usd : 0), 0);
    const latest = new Map(); // session → its newest measure (its cost so far)
    const looks = new Map(); // session → its measures, with their place in the day's entries
    day.forEach((e, i) => {
      if (e.kind !== 'measured' || typeof e.session !== 'string' || !Number.isFinite(e.usd)) return;
      latest.set(e.session, e);
      if (!looks.has(e.session)) looks.set(e.session, []);
      looks.get(e.session).push({ i, working: !!e.working, usd: e.usd });
    });
    // What chat `session` was measured at before entry `at` (its last figure before it; none: nothing yet).
    const figureBefore = (session, at) => {
      const before = (looks.get(session) || []).filter((m) => m.i < at).at(-1);
      return before ? before.usd : 0;
    };
    // A turn that BEGAN after entry `at` (by its place: two entries may share a millisecond) has ended and reported
    // what it cost: after the act the chat was seen idle (or it was idle at the act), then working, then idle again at a
    // figure higher than where that turn began. A turn already running at the act is an earlier message's: its end
    // is not this act's cost (this act's message waits in the chat's queue behind it). A turn that ended at the
    // figure it began at (its coding tool crashed, nothing was reported) measured nothing: the act's hold stays.
    const ranAfter = (session, at) => {
      const all = looks.get(session) || [];
      const last = all.filter((m) => m.i < at).at(-1);
      let idle = !last || !last.working; // no turn of it runs at the act
      let from = last ? last.usd : 0; // the figure the chat was last seen idle at
      let own = false; // a turn that began after the act runs now
      for (const m of all) {
        if (m.i < at) continue;
        if (m.working) {
          if (idle) own = true;
          idle = false;
        } else {
          if (own && m.usd > from + 1e-9) return true;
          own = false;
          idle = true;
          from = m.usd;
        }
      }
      return false;
    };
    const boundTo = new Map();
    const fresh = new Set();
    const messageOf = new Map(); // hold → the chat's id of the message the act sent
    const endOf = new Map(); // hold → how that message ended (its first "ended" entry)
    for (const e of day) {
      if (e.kind === 'ended' && e.hold && !endOf.has(e.hold)) endOf.set(e.hold, e);
      if (e.kind !== 'bind' || !e.hold) continue;
      boundTo.set(e.hold, e.session);
      if (e.fresh) fresh.add(e.hold);
      if (typeof e.message === 'string' && e.message) messageOf.set(e.hold, e.message);
    }
    // A new chat whose figure rose while idle after the act: its first turn (this act's message) has ended and reported.
    const costAfter = (session, at) => {
      const from = figureBefore(session, at);
      return (looks.get(session) || []).some((m) => m.i > at && !m.working && m.usd > from + 1e-9);
    };
    // What chat `session` was measured to cost since entry `at`: its newest figure less its last one before `at`.
    const costSince = (session, at) => {
      const before = (looks.get(session) || []).filter((m) => m.i < at).at(-1);
      return Math.max(0, (latest.has(session) ? latest.get(session).usd : 0) - (before ? before.usd : 0));
    };
    let held = 0;
    for (const m of latest.values()) spent += Math.max(0, m.usd);
    // A cost settles only its own act's hold (by id); an old entry without one settles the oldest hold without one.
    const ids = new Set(day.filter((e) => e.kind === 'spent' && e.hold).map((e) => e.hold));
    let settled = day.filter((e) => e.kind === 'spent' && !e.hold).length;
    let unmeasured = 0;
    let tapped = 0;
    let parts = 0;
    let partsHeld = 0;
    // The rest of the budgets of parts that ended before they reported a turn's cost: counted, not spent.
    let cuts = 0;
    let cutHeld = 0;
    // …and of parts whose end was not seen (the dashboard stopped while they ran): counted the same, said apart.
    let unseen = 0;
    let unseenHeld = 0;
    for (const e of day) {
      if (e.kind !== 'spent' || !e.hold || !(Number.isFinite(e.cut) && e.cut > 0)) continue;
      if (e.why === 'unseen') {
        unseen++;
        unseenHeld += e.cut;
      } else {
        cuts++;
        cutHeld += e.cut;
      }
      held += e.cut;
    }
    for (const [i, e] of day.entries()) {
      if (e.kind !== 'hold') continue;
      if (e.owner) tapped++;
      // A part's budget (`usd`), while its process runs: the larger of the budget and what its chat was measured to cost
      // since the hold (that cost is in `spent` already, so only the rest of the budget is held here). Its process ended
      // (settleParts: a `spent` entry names it): what it cost, which is in `spent`.
      if (Number.isFinite(e.usd)) {
        if (e.id && ids.has(e.id)) continue;
        const chat = e.id ? boundTo.get(e.id) : null;
        const rest = Math.max(0, e.usd - (chat ? costSince(chat, i) : 0));
        if (rests) rests.set(e.id, rest);
        held += rest;
        partsHeld += rest;
        parts++;
        continue;
      }
      if (e.id && messageOf.has(e.id)) {
        // Settled by its own message: its turn ended and reported (the chat's measured cost holds it), or it never ran.
        const end = endOf.get(e.id);
        if ((end && (end.back === true || Number.isFinite(end.cost))) || ids.has(e.id)) continue;
        held += HOLD_USD;
        unmeasured++;
        continue;
      }
      const chat = e.id ? boundTo.get(e.id) : null;
      if (chat && (ranAfter(chat, i) || (fresh.has(e.id) && costAfter(chat, i)))) continue; // its chat's measured cost stands in its place
      if (e.id ? ids.has(e.id) : settled > 0) {
        if (!e.id) settled--;
        continue;
      }
      held += HOLD_USD;
      unmeasured++;
    }
    const r4 = (v) => Math.round(v * 10_000) / 10_000;
    return { spent: r4(spent), held: r4(held), unmeasured, tapped, ...(parts ? { parts, partsHeld: r4(partsHeld) } : {}), ...(cuts ? { cuts, cutHeld: r4(cutHeld) } : {}), ...(unseen ? { unseen, unseenHeld: r4(unseenHeld) } : {}) };
  }

  /** Today's sum: { spent, held } in US dollars (held: what is counted for work whose cost is not measured yet). */
  today() {
    const { spent, held } = this.detail();
    return { spent, held };
  }

  /** A paid act ran from his tap on a card: counted in today's sum at once, never checked against the cap. */
  tapped(id) {
    this.#append({ at: this.now(), kind: 'hold', id: String(id).slice(0, 40), owner: true });
  }

  /**
   * Paid act `hold` went into chat `session` (one she started); `base`: the chat's running cost before it; `message`:
   * the chat's id of the message the act sent (send_to_chat's text), whose own turn's end settles the act.
   */
  bind(hold, session, base = 0, fresh = false, message = null) {
    this.#append({ at: this.now(), kind: 'bind', hold: String(hold).slice(0, 40), session: String(session).slice(0, 80), base: Number.isFinite(base) && base > 0 ? base : 0, ...(fresh ? { fresh: true } : {}), ...(typeof message === 'string' && message ? { message: message.slice(0, 80) } : {}) });
  }

  /** Today's acts bound with a message id whose end is not written yet: [{ hold, session, message }]. */
  open() {
    const day = this.#day();
    const done = new Set(day.filter((e) => (e.kind === 'ended' || e.kind === 'spent') && e.hold).map((e) => e.hold));
    const holds = new Set(day.filter((e) => e.kind === 'hold' && e.id && !Number.isFinite(e.usd)).map((e) => e.id));
    const out = [];
    for (const e of day) {
      if (e.kind !== 'bind' || !e.hold || typeof e.message !== 'string' || !e.message || done.has(e.hold) || !holds.has(e.hold)) continue;
      done.add(e.hold);
      out.push({ hold: e.hold, session: e.session, message: e.message });
    }
    return out;
  }

  /** How act `hold`'s message ended ({ cost } or { back: true }); written once per hold. */
  ended(hold, message, { cost = null, back = false } = {}) {
    const id = String(hold).slice(0, 40);
    if (this.#day().some((e) => e.kind === 'ended' && e.hold === id)) return;
    this.#append({ at: this.now(), kind: 'ended', hold: id, message: String(message).slice(0, 80), cost: !back && Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1_000_000) / 1_000_000 : null, ...(back ? { back: true } : {}) });
  }

  /** The chats today's paid acts went into: session → the running cost before the first of them (its base). */
  bound() {
    const out = new Map();
    for (const e of this.#day()) if (e.kind === 'bind' && !out.has(e.session)) out.set(e.session, Number.isFinite(e.base) ? e.base : 0);
    return out;
  }

  /** What chat `session` has cost since its base; written only when it changed. */
  measure(session, usd, working = false) {
    if (!Number.isFinite(usd) || usd < 0) return;
    const v = Math.round(usd * 1_000_000) / 1_000_000;
    const last = this.#day().filter((e) => e.kind === 'measured' && e.session === session).at(-1);
    if (last && last.usd === v && !!last.working === !!working) return;
    this.#append({ at: this.now(), kind: 'measured', session: String(session).slice(0, 80), usd: v, working: !!working });
  }

  /**
   * The check where the request is made: with `cap` (dollars a day, or null), may a paid act run now without a card?
   * Yes → a hold is written at once and null is returned; no → why, in one plain sentence.
   * `amount`: a hold of that size in place of HOLD_USD (a part's budget, settled by what it cost), or a function of
   * today's sum (detail()) that works it out under the same lock (partShare). Below PART_MIN_USD it is refused.
   */
  take(cap, { id = null, amount = null } = {}) {
    if (!Number.isFinite(cap) || cap <= 0) return 'no daily limit for paid use is set (Settings → Tia)';
    // Two dashboards on one state folder share this ledger: the check and the hold happen under one lock file, so
    // two takers at the same moment in two processes never pass the last free amount together.
    const why = this.#locked(() => {
      const t = this.detail();
      if (amount !== null) {
        const usd = typeof amount === 'function' ? amount(t) : amount;
        if (!(Number.isFinite(usd) && usd + 1e-9 >= PART_MIN_USD) || t.spent + t.held + usd > cap + 1e-9) return tooLittle(cap, t);
        this.#write({ at: this.now(), kind: 'hold', ...(id ? { id: String(id).slice(0, 40) } : {}), usd: Math.round(usd * 1_000_000) / 1_000_000 });
        return null;
      }
      if (t.spent + t.held + HOLD_USD > cap + 1e-9) {
        const used = t.spent + t.held;
        // The parts' budgets are said as such, never as starts whose cost was not measured.
        const ph = t.partsHeld || 0;
        const ch = t.cutHeld || 0;
        const uh = t.unseenHeld || 0;
        const other = Math.round((t.held - ph - ch - uh) * 100) / 100;
        const parts = `${money(t.spent)} spent${ph > 0 ? `, ${money(ph)} held by ${t.parts === 1 ? 'a part that runs now' : `${t.parts} parts that run now`}` : ''}${ch > 0 ? `, ${money(ch)} counted for ${cutWords(t.cuts)}` : ''}${uh > 0 ? `, ${money(uh)} counted for ${unseenWords(t.unseen)}` : ''}${other > 0 ? `, and ${money(other)} counted for ${unmeasuredWords(t.unmeasured)}` : ''}`;
        // "Reached" only when it is: a cap with less than one hold of room left says how much of it is used.
        return used + 1e-9 >= cap
          ? `today's daily limit for paid use of ${money(cap)} is reached (${parts}); raise the limit, or wait for tomorrow`
          : `today's daily limit for paid use of ${money(cap)} has no room for another ${money(HOLD_USD)} (${money(used)} of ${money(cap)} used: ${parts}); raise the limit, or wait for tomorrow`;
      }
      this.#write({ at: this.now(), kind: 'hold', ...(id ? { id: String(id).slice(0, 40) } : {}) });
      return null;
    });
    // The lock stayed taken: refused, the safe side (nothing was held).
    return why === undefined ? BUSY : why;
  }

  /**
   * fn() while the lock file beside the ledger is held: its value, or undefined when the lock stayed taken for `wait`
   * ms (take's is short, LOCK_WAIT_MS: this runs on the dashboard's only thread, so every page and terminal waits with it).
   * A lock older than STALE_MS is left over from a process that ended in it, and is taken over (#breakStale).
   */
  #locked(fn, wait = LOCK_WAIT_MS) {
    if (!this.file) return fn();
    const lock = `${this.file}.lock`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const until = Date.now() + wait;
    for (;;) {
      let fd;
      try {
        fd = fs.openSync(lock, 'wx', 0o600);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const seen = fs.statSync(lock);
          if (Date.now() - seen.mtimeMs > STALE_MS) this.#breakStale(lock, seen);
        } catch {
          /* gone meanwhile */
        }
        const left = until - Date.now();
        if (left <= 0) return undefined;
        Atomics.wait(WAIT, 0, 0, Math.min(5, left));
        continue;
      }
      const mine = fs.fstatSync(fd);
      fs.closeSync(fd);
      try {
        return fn();
      } finally {
        // Removed only while it is still this one: a lock taken over meanwhile is another's and stays.
        try {
          const now = fs.statSync(lock);
          if (now.ino === mine.ino && now.dev === mine.dev) fs.rmSync(lock, { force: true });
        } catch {
          /* gone already */
        }
      }
    }
  }

  /**
   * Remove the stale lock `seen` (its stat), and only that one. A check and a remove by its path are two steps: two
   * takers that both saw it stale could otherwise each remove it, the second removing the fresh lock the first had
   * made in its place. So one taker at a time breaks a lock (the file "<lock>.break", made with 'wx'), and only after
   * looking again that the lock is still the same file and still stale; a fresh lock that took its place (even on the
   * same inode number) is left alone.
   */
  #breakStale(lock, seen) {
    const brk = `${lock}.break`;
    let fd;
    try {
      fd = fs.openSync(brk, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // Held for a moment only: one this old is from a process that ended inside it.
      try {
        if (Date.now() - fs.statSync(brk).mtimeMs > STALE_MS) fs.rmSync(brk, { force: true });
      } catch {
        /* gone meanwhile */
      }
      return;
    }
    fs.closeSync(fd);
    try {
      const now = fs.statSync(lock);
      if (now.ino === seen.ino && now.dev === seen.dev && now.mtimeMs === seen.mtimeMs && Date.now() - now.mtimeMs > STALE_MS) fs.rmSync(lock, { force: true });
    } catch {
      /* gone meanwhile */
    } finally {
      fs.rmSync(brk, { force: true });
    }
  }

  /** What is left of today's cap, the hold of the act under way (`id`) counted back in: a turn's budget. */
  left(cap, id = null) {
    if (!Number.isFinite(cap) || cap <= 0) return 0;
    const t = this.today();
    return Math.max(0, Math.round((cap - t.spent - t.held + this.heldFor(id)) * 100) / 100);
  }

  /** The size of hold `id` (a part's budget, else HOLD_USD); 0 when there is none. */
  heldFor(id) {
    const e = id ? this.#entries().find((x) => x.kind === 'hold' && x.id === id) : null;
    return !e ? 0 : Number.isFinite(e.usd) ? e.usd : HOLD_USD;
  }

  /**
   * The process of a part ended (or starts again with a new budget): each budget hold of today that nothing settled
   * yet and that is bound to chat `session` (every one, bound or not, when `session` is null) is settled at $0, so it
   * counts what its chat was measured to cost and no more. `cut`: the process ended inside a turn whose cost it never
   * reported; `unseen`: its end was never seen (the dashboard stopped while it ran), a cut with a reason of its own.
   * The rest of each budget is counted for the day then, as what could not be measured, never as spent (the safe side:
   * the budget bounds what that turn cost; detail() cuts and cutHeld, unseen and unseenHeld).
   * → how many were settled (none the second time).
   */
  settleParts(session = null, { cut = false, unseen = false } = {}) {
    if (unseen) cut = true;
    const day = this.#day();
    const named = new Set(day.filter((e) => e.kind === 'spent' && e.hold).map((e) => e.hold));
    const boundTo = new Map(day.filter((e) => e.kind === 'bind' && e.hold).map((e) => [e.hold, e.session]));
    const key = session === null ? null : String(session).slice(0, 80);
    const open = day.filter((e) => e.kind === 'hold' && Number.isFinite(e.usd) && e.id && !named.has(e.id) && (key === null || boundTo.get(e.id) === key));
    const rests = new Map();
    if (cut) this.detail(rests);
    for (const id of new Set(open.map((e) => e.id))) {
      const rest = cut ? Math.round((rests.get(id) || 0) * 1_000_000) / 1_000_000 : 0;
      this.#append({ at: this.now(), kind: 'spent', usd: 0, what: 'part', hold: String(id).slice(0, 40), ...(rest > 0 ? { cut: rest, ...(unseen ? { why: 'unseen' } : {}) } : {}) });
    }
    return new Set(open.map((e) => e.id)).size;
  }

  /** A turn of her paid work ended: what it cost (from the coding tool's own figure); `hold`: the id of its hold. */
  spent(usd, what = 'turn', hold = null) {
    if (!Number.isFinite(usd) || usd < 0) return;
    this.#append({ at: this.now(), kind: 'spent', usd: Math.round(usd * 1_000_000) / 1_000_000, what: String(what).slice(0, 60), ...(hold ? { hold: String(hold).slice(0, 40) } : {}) });
  }
}

/**
 * What the $0.50 each stands for, in plain words: acts on a paid provider whose real cost Hoprig could not measure (a
 * start, a move or a message into a terminal session, her own turn that ended without a figure, a call of the Operator
 * that failed, his own tap on a card), each counted until the day ends. "Act" is not a word he knows, so the words are
 * Settings → Tia's (web/tia.js spentWords); one of them has one figure and no "each".
 */
export const unmeasuredWords = (n) => (n === 1
  ? `one start, move or message of a session on a provider billed by use whose cost Hoprig could not measure, ${money(HOLD_USD)} until the day ends`
  : `${n} starts, moves or messages of sessions on a provider billed by use whose cost Hoprig could not measure, ${money(HOLD_USD)} each until the day ends`);

/** The parts that ended before they reported a turn's cost, in Settings → Tia's words (web/tia.js spentWords). */
export const cutWords = (n) => (n === 1
  ? 'the rest of the budget of a part that stopped before it reported what its last turn cost, which Hoprig could not measure, until the day ends'
  : `the rest of the budgets of ${n} parts that stopped before they reported what their last turn cost, which Hoprig could not measure, until the day ends`);

/** The parts whose end Hoprig did not see (the dashboard stopped while they ran), in Settings → Tia's words. */
export const unseenWords = (n) => (n === 1
  ? 'the rest of the budget of a part whose end Hoprig did not see (the dashboard stopped while it ran), which Hoprig could not measure, until the day ends'
  : `the rest of the budgets of ${n} parts whose end Hoprig did not see (the dashboard stopped while they ran), which Hoprig could not measure, until the day ends`);

/**
 * A part's share of the daily limit `cap`, from today's sum `t` (detail()): what is left and not held, divided by the
 * parts that may still start beside it (`atOnce`, the number the part door obeys, less the parts that hold a budget
 * now); the last one that may start gets all of the rest. No such number: all that is free. Whole cents, rounded down,
 * so the parts that run at one moment never hold more than the limit had left.
 */
export function partShare(cap, t, atOnce) {
  const free = Math.max(0, cap - t.spent - t.held);
  const may = Number.isInteger(atOnce) && atOnce > 0 ? Math.max(1, atOnce - (t.parts || 0)) : 1;
  return Math.floor((free / may) * 100 + 1e-6) / 100;
}

/** take()'s answer when a part's share is too small: what holds the limit, and what he can do. */
function tooLittle(cap, t) {
  const bits = [`${money(t.spent)} spent`];
  if (t.partsHeld > 0) bits.push(`${money(t.partsHeld)} held by ${t.parts === 1 ? 'a part that runs now' : `${t.parts} parts that run now`}`);
  if (t.cutHeld > 0) bits.push(`${money(t.cutHeld)} counted for ${cutWords(t.cuts)}`);
  if (t.unseenHeld > 0) bits.push(`${money(t.unseenHeld)} counted for ${unseenWords(t.unseen)}`);
  const other = Math.round((t.held - (t.partsHeld || 0) - (t.cutHeld || 0) - (t.unseenHeld || 0)) * 100) / 100;
  if (other > 0) bits.push(`${money(other)} counted for ${unmeasuredWords(t.unmeasured)}`);
  const list = bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits.at(-1)}` : bits[0];
  return `today's daily limit for paid use of ${money(cap)} has too little left for another part (${list}); raise the limit in Settings → Tia, or ${t.parts ? 'wait until a part ends' : 'wait for tomorrow'}`;
}

export const capWords = (cap) => (Number.isFinite(cap) && cap > 0 ? `${money(cap)} a day` : 'none');

/**
 * One look at the chats today's paid acts went into (`cards`: this computer's session cards, as a tick has them): what
 * each has cost since its first act of the day, as its coding tool reported it (costTotal). Writes only when a figure
 * changed, and nothing at all when no paid act of hers went into a chat today. A chat whose running cost went below
 * its base (a new conversation in it) is not measured further: its later acts count HOLD_USD.
 * `messageEnd(chatId, messageId)` (the chat feature's; optional): after measuring, each open act bound with a message
 * id asks how its message ended (null | { ended, cost, total } | { back: true }). An end with a cost is written only
 * once this look's card holds it (its costTotal reached the chat's total after that turn), so the act's hold never
 * goes before the measured figure has that turn's cost.
 */
export function measureChats(ledger, cards, messageEnd = null) {
  const bound = ledger.bound();
  if (!bound.size) return;
  const cardOf = (key) => {
    const bar = key.indexOf('|');
    if (key.slice(0, bar) !== 'this') return null; // a chat on another computer: its cost is not seen here
    return (cards || []).find((x) => x.kind === 'chat' && x.name === key.slice(bar + 1)) || null;
  };
  for (const [key, base] of bound) {
    const c = cardOf(key);
    if (!c || !Number.isFinite(c.costTotal) || c.costTotal < base) continue;
    ledger.measure(key, c.costTotal - base, c.status === 'working');
  }
  if (typeof messageEnd !== 'function') return;
  for (const a of ledger.open()) {
    const bar = a.session.indexOf('|');
    const name = a.session.slice(bar + 1);
    if (a.session.slice(0, bar) !== 'this' || !name.startsWith('chat:')) continue;
    let end = null;
    try {
      end = messageEnd(name.slice('chat:'.length), a.message);
    } catch {
      continue; // not known now: asked again at the next look
    }
    if (!end || typeof end !== 'object') continue;
    if (end.back === true) {
      ledger.ended(a.hold, a.message, { back: true });
      continue;
    }
    if (end.ended !== true) continue;
    if (!Number.isFinite(end.cost)) {
      ledger.ended(a.hold, a.message, { cost: null }); // ended without a reported cost: its hold stays for the day
      continue;
    }
    const c = cardOf(a.session);
    const base = bound.get(a.session) || 0;
    if (Number.isFinite(end.total) && end.total - end.cost < base - 1e-9) {
      // That turn began below the chat's base (a new conversation restarted its running cost): the measured figure
      // does not hold its whole cost, so its hold stays for the day.
      ledger.ended(a.hold, a.message, { cost: null });
      continue;
    }
    if (!c ||!Number.isFinite(c.costTotal) || c.costTotal < base || !Number.isFinite(end.total) || c.costTotal < end.total - 1e-9) continue;
    ledger.ended(a.hold, a.message, { cost: end.cost });
  }
}
