// Being told, by code: what Work tells the owner by itself through the push address he set (Settings →
// Notifications), from the one progress function (pulse.mjs). Every item is off until he turns it on (tellsettings.mjs);
// with all of them off a tick reads nothing, writes nothing and sends nothing.
//
// Not noise:
//   - ONE message per event, also across a restart and with two dashboards: a run is told only by the dashboard that
//     ran it (its writer), and what was told is kept in a ledger in this dashboard's state folder (the event's key:
//     the unit and what happened), written atomically under the product's lock BEFORE the send.
//   - At most one message in gapMinutes; what comes meanwhile is held and goes as ONE ("3 done: a, b and 1 more").
//     "Waits for you" is not held by the gap.
//   - Quiet hours hold everything; what was held goes as one at their end.
//   - What happened while the dashboard was down is told once, as one message, when it is back.
//   - An item turned on starts from now: what happened before is not told.
//   - A digest goes every digestHours while work runs, never with nothing new. It keeps the gap too, and names what
//     was held, so nothing is told twice; after a down time the one message says it all.
//   - What is held goes only while it is still true: a task accepted, or a question answered, meanwhile is left out.
//   - A send that fails is tried again after 1, 5 and 30 minutes (a receiver restarting), then given up and logged.
//     A digest is marked sent only when it was.
//   - No message is lost by a crash: the ledger notes a message as about to be sent (pending, with this teller's
//     boot id) in the same write that takes it off what is held, and notes it sent when the send is over. A teller
//     that starts after a crash finds a message noted by another boot and not confirmed, and sends it once more,
//     only once (a second crash during that send drops it). So one message per event means: never a second one
//     without a crash in between.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { withLock } from './lock.mjs';
import { SINCE_MS, progress, workUnits } from './pulse.mjs';
import { digestMessage, digestTemplate, groupMessage, oneMessage } from './tellmsg.mjs';
import { TELL_ITEMS, tellOn, tellSettings } from './tellsettings.mjs';

export const TICK_MS = 30_000;
export const DOWN_MS = 5 * 60_000; // no tick for this long: the dashboard was down
const KEEP_MS = 8 * 86_400_000; // how long a told event is remembered once it is no longer there
const NEWS_MS = 7 * 86_400_000; // an event older than this is not news: shorter than KEEP_MS, so nothing is told twice
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000]; // after the 1st, 2nd and 3rd failed try
const TRIES = RETRY_MS.length + 1;
const CLOSE_WAIT_MS = 5_000;
const HELD_MAX = 500;
const PENDING_MAX = 50;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const ledgerFile = () => path.join(stateDir(), 'work-told.json');

export function readLedger(file = ledgerFile()) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObj(d) && d.v === 1 && isObj(d.seen) && Array.isArray(d.held)) return { ...d, pending: Array.isArray(d.pending) ? d.pending.filter(isObj) : [] };
  } catch {
    /* none yet, cut short or not ours: started anew (what is there now is not told) */
  }
  return null;
}
function writeLedger(d, file = ledgerFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(d)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Minutes after midnight of `ms` in time zone `tz`. */
function minuteOfDay(ms, tz) {
  let p;
  try {
    p = new Intl.DateTimeFormat('en-GB', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  } catch {
    p = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  }
  const g = (t) => Number((p.find((x) => x.type === t) || {}).value);
  return g('hour') * 60 + g('minute');
}
const hm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
/** True inside quiet hours (they may cross midnight: 22:00 to 07:00). */
export function inQuiet(s, ms, tz = '') {
  if (!s.quietFrom || !s.quietTo) return false;
  const m = minuteOfDay(ms, tz);
  const a = hm(s.quietFrom);
  const b = hm(s.quietTo);
  return a < b ? m >= a && m < b : m >= a || m < b;
}

/**
 * The events in a progress (only this dashboard's own work, and only what is on): [{ key, what, title, project, state,
 * reason, minutes, at }]. items: Work's list (a task accepted is "live").
 */
export function eventsOf(p, s, { items = [], now, units = null }) {
  const out = [];
  const add = (u, what, at, extra = {}) => !(Date.parse(at) >= now - NEWS_MS) ? null : out.push({ key: `${u.id}|${what}${extra.keyMore || ''}`, id: u.id, what, title: u.title, project: u.project, state: u.state, reason: u.reason || null, at, ...(extra.minutes ? { minutes: extra.minutes } : {}), ...(extra.schedule ? { schedule: true } : {}) });
  if (s.finished) {
    for (const u of p.waiting) if (u.why === 'review' && u.mine) add(u, 'finished', u.endedAt);
    // A schedule's run that ended well has no task in review: it waits for his look in Activity.
    const listed = new Set(items.map((x) => x.id));
    for (const u of p.done) if (u.type === 'run' && u.schedule && u.mine && !listed.has(u.item)) add(u, 'finished', u.endedAt, { schedule: true });
  }
  if (s.failed) for (const u of p.failed) if (u.mine) add(u, 'failed', u.endedAt);
  if (s.live) {
    const done = new Set(items.filter((x) => x.status === 'done').map((x) => x.id));
    // Every run of the list (units), not only what ended in the last day: a night run is often accepted days later.
    // The task's newest run counts, when it ended well.
    const newest = new Map();
    for (const u of units || p.done) if (u.type === 'run' && (!newest.has(u.item) || String(u.startedAt) > String(newest.get(u.item).startedAt))) newest.set(u.item, u);
    for (const u of newest.values()) if (u.state === 'done' && u.mine && done.has(u.item)) add(u, 'live', new Date(now).toISOString());
  }
  if (s.waits) {
    for (const u of p.waiting) {
      if (u.why !== 'answer' || !u.mine || !u.waitsSince) continue;
      const waited = now - Date.parse(u.waitsSince);
      if (waited >= s.waitsMinutes * 60_000) add(u, 'waits', u.waitsSince, { minutes: Math.floor(waited / 60_000), keyMore: `|${u.waitsSince}` });
    }
  }
  return out;
}

/** What `item` of the settings an event belongs to. */
const itemOf = (what) => what;
const unitOf = (e) => e.id || String(e.key).split('|')[0];
/** Still true now (p: the progress just read): a task still in review, a session still on the same question. */
function stillTrue(e, p) {
  if (e.what === 'finished' && !e.schedule) return p.waiting.some((u) => u.why === 'review' && u.id === unitOf(e));
  if (e.what === 'waits') return p.waiting.some((u) => u.why === 'answer' && u.id === unitOf(e) && u.waitsSince === e.at);
  return true;
}
/** The screen a message's tap opens: Activity for what failed or a schedule's run, else Today. */
const pageOf = (evs) => (evs.length && evs.every((e) => e.what === 'failed' || (e.what === 'finished' && e.schedule)) ? 'work/activity' : 'work');

/**
 * The teller of one dashboard. o: { cfg(), place() (Work's place, or throws), items() (Work's list), send({ title,
 * body }) → { sent }, word (Tia's wording of a digest, tellwords.mjs; only called when tiaWords is on), now(), log,
 * alive, file }. → { tick() → what it did, begin(), close() }.
 */
export function teller(o) {
  const now = () => (o.now ? o.now() : Date.now());
  const log = o.log || (() => {});
  const file = o.file || ledgerFile();
  const boot = crypto.randomBytes(6).toString('hex'); // this teller's run: pending messages of another were cut by a stop
  const newId = () => crypto.randomBytes(6).toString('hex');
  let timer = null;
  let ticking = null;
  let offKept = false; // everything off, and the ledger already says so

  async function tickOnce() {
    const cfg = o.cfg() || {};
    const s = tellSettings(cfg);
    if (!tellOn(s)) {
      // Turned off (or the push address removed) while a ledger exists: it says nothing is on, once, so turning it
      // back on starts from now and is not read as a down time. Without a ledger nothing is read or written.
      if (!offKept && fs.existsSync(file)) {
        await withLock(file, async () => {
          const d = readLedger(file);
          if (d && ((d.on || []).length || d.held.length)) writeLedger({ ...d, on: [], held: [], lastTick: now() }, file);
        });
      }
      offKept = true;
      return { off: true };
    }
    offKept = false;
    const t = now();
    const tz = (cfg.work && typeof cfg.work.timeZone === 'string' && cfg.work.timeZone) || '';
    let place = null;
    let items = [];
    let listed = false; // Work's list was read: what is held can be checked against it
    try {
      place = o.place();
      items = o.items ? o.items() : [];
      listed = true;
    } catch {
      /* no Work list: sessions only */
    }
    // The earliest time this look asks for: what ended since the last tick, seven days back at most (NEWS_MS).
    const w = await workUnits({ place, cfg, since: t - NEWS_MS, ...(o.alive ? { alive: o.alive } : {}) });
    const on = TELL_ITEMS.filter((k) => s[k]);
    const sends = [];
    let digest = null;
    let lastSentBefore = 0;
    const recover = [];
    await withLock(file, async () => {
      let d = readLedger(file);
      const fresh = !d;
      if (!d) d = { v: 1, seen: {}, held: [], on: [], lastSent: 0, lastTick: t, lastDigest: t, digestKey: '', pending: [] };
      // Noted as about to be sent by a teller that stopped before it said sent: once more now, and only once.
      d.pending = d.pending.filter((x) => {
        if (x.boot === boot) return true;
        if (!x.again) recover.push({ ...x, boot, again: true });
        return false;
      });
      for (const x of recover) {
        d.pending.push(x);
        if (x.digest) {
          d.lastDigest = t;
          d.digestKey = String(x.key || '');
        }
      }
      // A clock set back: a time of the ledger later than now is now, so nothing waits for the clock to catch up.
      for (const k of ['lastSent', 'lastTick', 'lastDigest']) if (d[k] > t) d[k] = t;
      const down = !fresh && t - (d.lastTick || 0) > DOWN_MS;
      // What ended since the last tick counts, also after a down time longer than a day (seven days at most).
      const p = progress({ ...w, items, now: t, tz, since: Math.min(t - SINCE_MS, Math.max(d.lastTick || t, t - NEWS_MS)) });
      const evs = eventsOf(p, s, { items, now: t, units: w.units });
      // An item that was off until now starts from now: what is there already is marked told, not told.
      const newly = new Set(fresh ? on : on.filter((k) => !(d.on || []).includes(k)));
      const news = [];
      for (const e of evs) {
        // Every event still there is remembered from now on: the ledger forgets (KEEP_MS) only what is no longer
        // there, so an event that stays (a task accepted, told at the time of the look) is never told again.
        const told = d.seen[e.key];
        d.seen[e.key] = t;
        if (!told && !newly.has(itemOf(e.what))) news.push(e);
      }
      if (newly.has('digest')) d.lastDigest = t;
      d.on = on;
      // A look that could not read Work's list produced no event of a run or a task: forgetting their keys then would
      // tell them again when the list is back. Only a look that read it forgets.
      if (listed) for (const [k, at] of Object.entries(d.seen)) if (t - at > KEEP_MS) delete d.seen[k];
      const quiet = inQuiet(s, t, tz);
      const waits = news.filter((e) => e.what === 'waits');
      d.held = [...d.held.filter((e) => on.includes(itemOf(e.what))), ...news.filter((e) => e.what !== 'waits' || quiet || down)].slice(-HELD_MAX);
      // What was held goes only while it is still true (he may have accepted the task or answered meanwhile).
      if (listed) d.held = d.held.filter((e) => stillTrue(e, p));
      lastSentBefore = d.lastSent || 0;
      if (!quiet) {
        const gapOver = t - (d.lastSent || 0) >= s.gapMinutes * 60_000;
        let grouped = false;
        if (down && d.held.length) {
          sends.push({ evs: d.held, msg: groupMessage(d.held, { off: true }), page: pageOf(d.held), gap: true });
          d.held = [];
          d.lastSent = t;
          grouped = true;
        } else if (waits.length) sends.push({ evs: waits, msg: groupMessage(waits), page: 'work' });
        // The digest: due, while work runs or something ended since the last one, and never the same as the last.
        if (s.digest && t - (d.lastDigest || 0) >= s.digestHours * 3_600_000) {
          const since = progress({ ...w, items, now: t, tz, since: d.lastDigest || t - s.digestHours * 3_600_000 });
          const mine = (l) => l.filter((u) => u.mine);
          const dd = { done: mine(since.done), failed: mine(since.failed), running: mine(since.running), waiting: mine(since.waiting) };
          const key = JSON.stringify([dd.done, dd.failed, dd.running, dd.waiting].map((l) => l.map((u) => u.id).sort()));
          const anything = dd.done.length || dd.failed.length || dd.running.length;
          const same = !dd.done.length && !dd.failed.length && key === d.digestKey;
          if (!anything || same) d.lastDigest = t;
          else if (grouped) {
            // Back after a down time: the one message of the down time is this tick's message.
            d.lastDigest = t;
            d.digestKey = key;
          } else if (gapOver && !(d.digestNext > t)) {
            // It names what ended since the last one: what was held of that goes in it, not again after it.
            const named = new Set([...dd.done, ...dd.failed].map((u) => u.id));
            d.held = d.held.filter((e) => !((e.what === 'finished' || e.what === 'failed') && named.has(unitOf(e))));
            const reported = dd.done.filter((u) => u.tokens !== null);
            digest = { tpl: digestTemplate({ ...dd, tz, tokens: reported.length ? reported.reduce((n, u) => n + u.tokens, 0) : null, unreported: dd.done.length - reported.length }), key };
            d.lastSent = t;
          }
          // Otherwise it waits for the gap, or for its next try: lastDigest and digestKey change only when it is sent.
        }
        if (!grouped && !digest && gapOver && d.held.some((e) => !(e.nextTry > t))) {
          sends.push({ evs: d.held, msg: groupMessage(d.held), page: pageOf(d.held), gap: true });
          d.held = [];
          d.lastSent = t;
        }
      }
      // What goes out now is noted as about to be sent, in the same write that takes it off what is held.
      for (const x of sends) {
        x.pid = newId();
        d.pending.push({ id: x.pid, boot, at: t, msg: x.msg, page: x.page });
      }
      if (digest) {
        digest.pid = newId();
        d.pending.push({ id: digest.pid, boot, at: t, digest: true, tpl: digest.tpl, key: digest.key, page: 'work' });
      }
      d.pending = d.pending.slice(-PENDING_MAX);
      d.lastTick = t;
      writeLedger(d, file);
    });
    const did = [];
    /** The send of pending message `id` is over (sent or not): noted. */
    const settle = (id, also = () => {}) => withLock(file, async () => {
      const d = readLedger(file);
      if (!d) return;
      d.pending = d.pending.filter((x) => x.id !== id);
      also(d);
      writeLedger(d, file);
    });
    const sendOne = async (msg, page) => {
      let r = null;
      try {
        r = await o.send(msg, { page });
      } catch (e) {
        r = { sent: false, error: e.message };
      }
      const ok = !!(r && r.sent);
      if (!ok) log(`a Work notification was not sent: ${String((r && r.error) || 'no answer').slice(0, 200)}`);
      return ok;
    };
    // A message a stop cut off goes first, as it was made (a digest in its plain words).
    for (const x of recover) {
      const msg = x.digest ? digestMessage(x.tpl) : x.msg;
      const ok = isObj(msg) && typeof msg.title === 'string' ? await sendOne(msg, x.page || 'work') : false;
      did.push({ ...(isObj(msg) ? msg : {}), sent: ok, again: true });
      if (!ok) log('a message cut off by a stop could not be sent after the restart');
      await settle(x.id);
    }
    // The messages that are due go first; the digest, which may wait for Tia's wording, after them.
    for (const x of sends) {
      const ok = await sendOne(x.msg, x.page);
      did.push({ ...x.msg, sent: ok });
      if (ok) {
        await settle(x.pid);
        continue;
      }
      const again = [];
      const gaveUp = [];
      for (const e of x.evs) {
        const n = (e.tries || 0) + 1;
        if (n >= TRIES) gaveUp.push(e);
        else again.push({ ...e, tries: n, nextTry: t + RETRY_MS[n - 1] });
      }
      if (gaveUp.length) log(`given up after ${TRIES} tries: ${gaveUp.map((e) => e.title || e.project).join(', ').slice(0, 200)}`);
      await withLock(file, async () => {
        const d = readLedger(file);
        if (!d) return;
        d.pending = d.pending.filter((p) => p.id !== x.pid); // not sent: it is held again, and tried as held
        d.held = [...again, ...d.held].slice(-HELD_MAX);
        if (x.gap) d.lastSent = lastSentBefore; // nothing reached him: the gap is not opened by it
        writeLedger(d, file);
      });
    }
    if (digest) {
      const plain = digestMessage(digest.tpl);
      let msg = plain;
      if (s.tiaWords && o.word) {
        try {
          msg = (await o.word(digest.tpl)) || msg;
        } catch (e) {
          log(`the digest was sent in plain words: ${String(e.message).slice(0, 200)}`);
        }
      }
      // A worded title in another script reaches an ntfy receiver as RFC 2047 encoded words (notify.mjs encodedWords).
      const ok = await sendOne(msg, 'work');
      did.push({ ...msg, sent: ok, digest: true });
      await withLock(file, async () => {
        const d = readLedger(file);
        if (!d) return;
        d.pending = d.pending.filter((p) => p.id !== digest.pid);
        const n = (d.digestTries || 0) + 1;
        if (ok || n >= TRIES) {
          if (!ok) log(`the digest was given up after ${TRIES} tries`);
          d.lastDigest = t;
          d.digestKey = digest.key;
          delete d.digestTries;
          delete d.digestNext;
        } else {
          d.digestTries = n;
          d.digestNext = t + RETRY_MS[n - 1];
          d.lastSent = lastSentBefore;
        }
        writeLedger(d, file);
      });
    }
    return { sent: did };
  }

  /** One look; two at once are one. */
  // The same error (a ledger that cannot be written) is logged once, and again only when it changes or an hour on.
  let lastError = null;
  let lastErrorAt = 0;
  let failedSince = 0; // when the looks started failing (the ledger cannot be read or written), else 0
  function tick() {
    if (!ticking) ticking = tickOnce().then((r) => {
      lastError = null;
      failedSince = 0;
      return r;
    }, (e) => {
      const m = String(e.message).slice(0, 200);
      failedSince = failedSince || now();
      if (m !== lastError || now() - lastErrorAt >= 3_600_000) {
        log(`Work notifications: ${m}`);
        lastError = m;
        lastErrorAt = now();
      }
      return { error: e.message };
    }).finally(() => (ticking = null));
    return ticking;
  }

  let first = null;
  return {
    tick,
    /** For Settings: { ok } or { ok: false, since, error } while the looks fail (nothing can be told then). */
    status: () => (failedSince ? { ok: false, since: new Date(failedSince).toISOString(), error: lastError } : { ok: true }),
    begin() {
      timer = setInterval(() => tick(), o.tickMs || TICK_MS);
      timer.unref?.();
      first = setTimeout(() => tick(), 2000);
      first.unref?.();
    },
    /** Stops the timer and waits for a look in flight (its sends), CLOSE_WAIT_MS at most. */
    async close() {
      clearInterval(timer);
      clearTimeout(first);
      timer = null;
      if (ticking) await Promise.race([ticking, new Promise((r) => setTimeout(r, o.closeWaitMs ?? CLOSE_WAIT_MS).unref?.())]);
    },
  };
}

export { oneMessage };
