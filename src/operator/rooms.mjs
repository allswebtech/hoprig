// Each computer's room for new work (room.mjs), kept for the Operator page, the start sheets and Tia's starts.
//
// Another computer is read through the hub's own link (hub.health, with its token: no new login per look), with a
// 5 s limit, and nothing of it is written to a file: only its last answer is kept, in memory (after a restart every
// other computer is "unknown" until it is read again). It is read
//   - when the owner opens the Operator page or presses Refresh (GET /api/operator/rooms?look=1), and
//   - BY ITSELF only with his switch "Look at my other computers too" (config operator.lookOthers, off when absent):
//     then on the dashboard's tick at most once a minute per computer; one that did not answer is asked less often
//     (2, 4, then every 5 minutes) and shown as "not reached since …".
// This computer is read from its own figures (`local`), only for a look of his or a start.
//
//   GET  /api/operator/rooms[?look=1]     { at, lookOthers, computers: [view] }  (look=1: read every computer now)
//   GET  /api/operator/rooms?start=1      Tia's start, only with Settings → Tia's computers: this one and those read
//   POST /api/operator/rooms/settings     { lookOthers }: the owner's own page only
//
// A view: { name, label, here, reached, seenAt, room, why, facts, cpus, load1, memFreePct } — every word in it is this
// dashboard's own (room.mjs); the other computer's own words (its label aside, which the owner gave it) never appear.

import { loadMachines } from '../machines/store.mjs';
import { readSettings } from '../automation/settings.mjs';
import { heldUntil } from './decide-store.mjs';
import { mountHolding, readable, readingOfHealth, readingOfMachine, roomOf } from './room.mjs';
import { workspaceDir } from '../workspace/layout.mjs';
import { endElsewhere, noteCalm, readElsewhere } from './where-hold.mjs';
import { timeline } from './feature.mjs';

export const LOOK_EVERY_MS = 60_000;
export const LOOK_MAX_MS = 5 * 60_000;
export const ASK_TIMEOUT_MS = 5000;
// The states of a computer that answered but would not take this dashboard (src/machines/hub.mjs stateOf).
const REFUSED = new Set(['unauthorised', 'too-old', 'hostkey']);
/** Two looks of his within this time share one read (a double press, the page opened twice). */
const SHARE_MS = 5000;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);

/** Whether the switch "Look at my other computers too" is on (absent, broken: off). */
export const lookOthersOn = (cfg) => isObj(cfg?.operator) && cfg.operator.lookOthers === true;

/**
 * What this dashboard knows about new work here, for its Health answer (health.mjs `own`) and its own room:
 * sessions working now, Work's runs against its limit, how long a "Start nothing new" hold still stands.
 */
export function ownFacts({ sessions = [], running = 0, atOnce = 1, heldUntil = null, now = Date.now(), workspace = null } = {}) {
  return {
    // the path, for health.mjs to find its disk's mount; pickOwn leaves the path out of the answer
    ...(typeof workspace === 'string' && workspace ? { workspace } : {}),
    working: (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.status === 'working').length,
    runs: { running: Number(running) || 0, atOnce: Number(atOnce) || 1 },
    holdLeftMs: Number.isFinite(heldUntil) && heldUntil > now ? heldUntil - now : null,
  };
}

/** The room facts of an `own` (pickHealth's, typed), at receipt time `at`: what roomOf takes. */
const ownOf = (o, at) => (o ? { working: o.working ?? undefined, runs: o.runs || undefined, hold: o.holdLeftMs ? { until: at + o.holdLeftMs } : null } : {});

function viewOf({ name, label, here = false, entry, now }) {
  const reached = !!(entry && entry.health && readable(readingOfHealth(entry.health, entry.workspace || null)));
  const reading = reached ? readingOfHealth(entry.health, entry.workspace || null) : null;
  const r = roomOf({ reading, at: reached ? entry.at : null, now, own: reached ? ownOf(entry.health.own, entry.at) : {} });
  const ok = r.room !== 'unknown' && reading;
  return {
    name, label, here, reached,
    asked: !!entry, // false: not read yet in this process (the page says "Not asked yet", never "did not answer")
    seenAt: iso(entry?.okAt ?? null),
    state: !reached && entry && REFUSED.has(entry.state) ? entry.state : null,
    room: r.room, why: r.why, facts: r.facts,
    cpus: ok ? reading.cpus : null,
    load1: ok ? reading.load1 : null,
    memFreePct: ok ? Math.round((reading.memAvailable / reading.memTotal) * 100) : null,
  };
}

/**
 * The keeper. `ask(name)`: hub.health(name, { timeoutMs, waitMs, keep: false }) → { reached, label, health };
 * `local()`: this computer → { health (localHealth's shape: load, cpus, memory, disks, own), workspace } or null;
 * `on()`: the switch. Tests hand in all three and the clock.
 */
export function roomKeeper({ ask, local = null, machines = loadMachines, now = Date.now, on = () => false, timeoutMs = ASK_TIMEOUT_MS } = {}) {
  const last = new Map(); // name → { at, okAt, health, every, nextAt, failed }
  const going = new Map(); // name → the read in flight
  let asked = 0; // requests sent, for the tests and the report

  const limit = (p) => {
    let timer;
    return Promise.race([p, new Promise((resolve) => { timer = setTimeout(() => resolve({ reached: false }), timeoutMs); timer.unref?.(); })]).finally(() => clearTimeout(timer));
  };

  function read(name) {
    if (going.has(name)) return going.get(name);
    const p = (async () => {
      const t = now();
      const prev = last.get(name);
      asked++;
      let r;
      try {
        r = await limit(Promise.resolve().then(() => ask(name)));
      } catch {
        r = { reached: false };
      }
      const at = now();
      // An answer whose numbers cannot be true counts as not reached (never as room): asked less often, like silence.
      if (r && r.reached === true && isObj(r.health) && readable(readingOfHealth(r.health))) {
        last.set(name, { at, okAt: at, health: r.health, every: LOOK_EVERY_MS, nextAt: t + LOOK_EVERY_MS, failed: false });
      } else {
        // Asked less often while it does not answer: 2, 4, then every 5 minutes. Only when it last answered is kept.
        const every = prev && prev.failed ? Math.min(prev.every * 2, LOOK_MAX_MS) : 2 * LOOK_EVERY_MS;
        // When it last answered: what this process saw, else what the hub's store keeps (its seenAt), so a restart or
        // a computer not read yet in this process still says since when. An answer that came but could not be read
        // is no answer.
        // When the keeper's own limit came first (a link that hangs), the ask brought no seenAt: the store is read here.
        const stored = r && r.reached === false && Number.isFinite(r.seenAt) ? r.seenAt : storedSeenAt(name);
        const okAt = Math.max(prev?.okAt ?? -Infinity, stored ?? -Infinity);
        // Why it was not reached, when it answered but refused (hub.mjs stateOf): only a word of that set, never its text.
        const state = r && REFUSED.has(r.state) ? r.state : null;
        last.set(name, { at, okAt: Number.isFinite(okAt) ? okAt : null, health: null, every, nextAt: t + every, failed: true, state });
      }
    })().finally(() => going.delete(name));
    going.set(name, p);
    return p;
  }

  // When the hub's store says this computer last answered (hub.mjs health writes it), or null.
  const storedSeenAt = (name) => {
    try {
      const m = machines().find((x) => x && x.name === name);
      return m && Number.isFinite(m.seenAt) ? m.seenAt : null;
    } catch {
      return null;
    }
  };
  const names = () => {
    try {
      return machines().map((m) => ({ name: m.name, label: m.label || m.name }));
    } catch {
      return [];
    }
  };
  // A computer removed from the hub: its last answer goes too.
  const forgetGone = (list) => {
    const keep = new Set(list.map((m) => m.name));
    for (const k of last.keys()) if (!keep.has(k)) last.delete(k);
  };

  let here = null; // this computer's last reading: { at, okAt, health, workspace }
  async function readHere() {
    if (!local) return;
    try {
      const l = await local();
      here = l && isObj(l.health) ? { at: now(), okAt: now(), health: l.health, workspace: l.workspace || null } : { at: now(), okAt: here?.okAt ?? null, health: null };
    } catch {
      here = { at: now(), okAt: here?.okAt ?? null, health: null };
    }
  }

  return {
    /** His look (the page opened, Refresh): every computer is read now, except one read within the last 5 s. */
    async look() {
      const list = names();
      forgetGone(list);
      const t = now();
      await Promise.all([
        here && t - here.at >= 0 && t - here.at < SHARE_MS ? null : readHere(),
        ...list.map((m) => {
          const e = last.get(m.name);
          return e && t - e.at >= 0 && t - e.at < SHARE_MS ? null : read(m.name);
        }),
      ]);
      return this.view();
    },
    /** The dashboard's tick: nothing at all unless the switch is on; then each computer that is due. */
    async tick() {
      if (!on()) return;
      const list = names();
      forgetGone(list);
      const t = now();
      // A due time further away than its wait (the clock was set back) is due now.
      await Promise.all(list.map((m) => {
        const e = last.get(m.name);
        return !e || t >= e.nextAt || e.nextAt - t > e.every ? read(m.name) : null;
      }));
    },
    /**
     * Tia's start, only while he chose computers for her (assistant.computers): this computer is read now, and each
     * chosen one that is due (its last read a minute old, or its wait after silence over), each with its 5 s limit.
     */
    async forStart(chosen = []) {
      const list = names().filter((m) => chosen.includes(m.name));
      const t = now();
      await Promise.all([readHere(), ...list.map((m) => {
        const e = last.get(m.name);
        return !e || t >= e.nextAt || e.nextAt - t > e.every ? read(m.name) : null;
      })]);
      return this.view();
    },
    /** This computer's room from a reading the caller already holds (Tia's start, the Operator's look). */
    setHere(health, workspace = null) {
      here = isObj(health) ? { at: now(), okAt: now(), health, workspace } : here;
    },
    /** Every computer as kept now: this one first (when known), then the hub's, in the store's order. */
    view() {
      const t = now();
      const list = names();
      const out = here ? [viewOf({ name: 'this', label: 'This computer', here: true, entry: here, now: t })] : [];
      for (const m of list) out.push(viewOf({ name: m.name, label: m.label, entry: last.get(m.name) || null, now: t }));
      return { at: iso(t), lookOthers: on(), computers: out };
    },
    asked: () => asked,
    forget: () => {
      last.clear();
      here = null;
    },
  };
}

/**
 * The server feature: the routes above and the tick. `hub`: the machines' hub (its health read); `running()`: Work's
 * runs that end by themselves here now. `own()` is what this computer's Health answer carries (health.mjs).
 * Tests pass `ask`, `local` and `now`. `snapshot()`: this computer's load, processors, memory and disks (platform.mjs
 * snapshot's shape); the demo hands in its made-up computer's, so its pages never show the real computer's figures.
 */
export function roomsFeature(ctx, { hub = null, running = () => 0, ask = null, local = null, snapshot = null, now = Date.now, machine = null, changed = () => {}, undone = async () => {}, workspace = () => workspaceDir(ctx.config()) } = {}) {
  const fail = (status, message) => new ctx.HttpError(status, message);
  const own = async () => {
    const st = await ctx.state();
    return ownFacts({ sessions: st.sessions, running: running(), atOnce: readSettings(ctx.config().automation).schedules.atOnce, heldUntil: heldUntil(now()), now: now(), workspace: workspace() });
  };
  const localNow = local || (async () => {
    const s = await (snapshot || (await import('../server/platform.mjs')).snapshot)();
    return { health: { load: s.load, cpus: s.cpus, memory: s.mem ? { total: s.mem.total, available: s.mem.available } : null, disks: s.disks || [], own: await own() }, workspace: workspace() };
  });
  const keeper = roomKeeper({
    ask: ask || ((name) => (hub ? hub.health(name, { timeoutMs: ASK_TIMEOUT_MS, waitMs: ASK_TIMEOUT_MS, keep: false }) : { reached: false })),
    local: localNow, now, on: () => lookOthersOn(ctx.config()),
  });
  const line = timeline();
  // A hold on a computer he took out of Settings → Tia has lost its reason: read with his list, it is ended.
  const chosen = () => ctx.config().assistant?.computers ?? null;
  const heldView = () => {
    const h = readElsewhere(now(), { computers: chosen() });
    return h ? { to: h.to, label: h.label, since: new Date(h.since).toISOString() } : null;
  };
  // While the hold stands (and only then): this computer's room from the Operator's own machine figures, so the hold
  // ends once it has been calm long enough. `machine()`: the board's machine source (server.mjs), read from memory.
  const checkCalm = () => {
    if (!readElsewhere(now(), { computers: chosen() }) || !machine) return;
    let m = null;
    try {
      m = machine();
    } catch {
      return; // not read yet: unchanged
    }
    // The workspace's disk, as for Tia's start: a nearly full backup disk does not keep a hold set for load standing.
    let mount = null;
    try {
      mount = mountHolding(workspace(), (Array.isArray(m?.disks) ? m.disks : []).map((d) => d && d.mount));
    } catch {
      /* not known: the fullest disk */
    }
    const r = roomOf({ reading: readingOfMachine(m, mount), at: now(), now: now() });
    if (r.room === 'unknown') return;
    if (!noteCalm(r.room === 'free', now())) line.add({ at: new Date(now()).toISOString(), item: null, kind: 'machine', subject: 'new work', act: 'elsewhere-end', ok: true, by: 'elsewhere', result: 'this computer has been calm: Tia\'s new work starts here again' });
  };
  // Not awaited: a slow computer never holds the dashboard's tick (each read has its own 5 s limit).
  const unsubscribe = ctx.onTick ? ctx.onTick(() => { keeper.tick().catch(() => {}); try { checkCalm(); } catch { /* the next tick */ } }) : null;
  return {
    name: 'rooms',
    keeper,
    own,
    routes: [
      // Only his own page reads the other computers now: another computer's token or Tia gets what is kept.
      ['GET', /^\/api\/operator\/rooms(?:\?.*)?$/, async (req) => {
        const q = req.url || '';
        // His look: the Operator's board is built again with what was read (its overload item may offer a computer now).
        if (/[?&]look=1(?:&|$)/.test(q) && ctx.caller(req) === 'page') {
          const v = await keeper.look();
          changed();
          return { ...v, elsewhere: heldView() };
        }
        // Tia's start (her own request, in this process), only with the computers he chose for her.
        if (/[?&]start=1(?:&|$)/.test(q) && ctx.caller(req) === 'self') {
          const chosen = ctx.config().assistant?.computers;
          if (Array.isArray(chosen) && chosen.length) return { ...(await keeper.forStart(chosen.filter((n) => typeof n === 'string'))), elsewhere: heldView() };
        }
        return { ...keeper.view(), elsewhere: heldView() };
      }],
      // Undo of "Start new work on <name> until this computer is calm": ends it at once (the owner's page only).
      ['POST', /^\/api\/operator\/rooms\/elsewhere\/end$/, async (req) => {
        if (ctx.caller(req) !== 'page') throw fail(403, 'ending it is yours, from this dashboard\'s page');
        await ctx.readJson(req);
        const h = readElsewhere(now());
        endElsewhere();
        // His Undo is his answer: his rule does not set it again in ten minutes (operator feature elsewhereUndone).
        if (h) await Promise.resolve().then(undone).catch(() => {});
        changed();
        if (h) line.add({ at: new Date(now()).toISOString(), item: null, kind: 'machine', subject: 'new work', act: 'undo', ok: true, result: `Undo: Tia's new work starts here again (it went to ${h.label} since ${new Date(h.since).toISOString().slice(11, 16)} UTC)` });
        return { ...keeper.view(), elsewhere: null };
      }],
      ['POST', /^\/api\/operator\/rooms\/settings$/, async (req) => {
        if (ctx.caller(req) !== 'page') throw fail(403, 'whether the dashboard looks at your other computers by itself is your choice, from this dashboard\'s page');
        const b = await ctx.readJson(req);
        if (!isObj(b) || Object.keys(b).some((k) => k !== 'lookOthers') || typeof b.lookOthers !== 'boolean') throw fail(400, 'send { lookOthers: true | false }');
        const cur = isObj(ctx.config().operator) ? ctx.config().operator : {};
        ctx.saveConfig({ operator: { ...cur, lookOthers: b.lookOthers } });
        return keeper.view();
      }],
    ],
    close: () => unsubscribe?.(),
  };
}
