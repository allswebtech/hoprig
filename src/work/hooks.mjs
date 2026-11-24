// Webhook deliveries of Work (docs/WORK.md, "Another program"). A webhook belongs to one Work token and is told about
// that token's tasks only:
//   done       the task was marked done
//   result     a run of it ended well: its result is ready (the task waits for the owner's review)
//   needs-you  the task went to waiting, or a run of it stopped for the owner (failed, a usage limit, stopped)
//
// How it sees them: while there is a webhook, every few seconds (and when a webhook is made) it reads the Work file and
// the runs of those tasks and compares them with what it saw last; the first look at a token's tasks only takes note. So every way a
// task changes (the page, Tia, the command, a save from another computer) is seen alike. What is missing for a look (the
// file empty or unreadable a moment, the runs folder away, Work moved to another project and back) is not a change:
// a task's last status is kept while it is away, and the end of a run is told once, by its id. With no webhook nothing here
// runs: no timer, no read, no connection.
//
// A delivery: a small JSON body { event, task: { id, title, status }, run, time } (and `answer` only for a webhook
// with "send the answer too"), signed: X-Hoprig-Timestamp (seconds) and X-Hoprig-Signature: sha256=<hex of the
// HMAC-SHA256 of "<timestamp>.<body>" with the webhook's secret>. The address is checked again at each try
// (hookaddr.mjs: every address its name resolves to) and the connection goes to the one address checked, with the name
// for its certificate; no redirect is followed, no proxy of the environment is used, ten seconds at most, the answer
// read up to 4 KB and thrown away. Three tries (at once, after 5 s, after 30 s), then given up and said in Activity
// with its status only. Deliveries wait in memory: a restart drops what was not sent yet (the receiver can always
// read with its token). Neither the secret nor a body is ever logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fromOf, statusOf } from './model.mjs';
import { RUN_FILE_RE, readRun, runsDir } from './runs.mjs';
import { readDoc } from './store.mjs';
import { recordWork, webhooksWithSecrets } from './access.mjs';
import { resolveHook } from './hookaddr.mjs';

export const TRIES_WAIT_MS = [0, 5_000, 30_000];
export const DELIVERY_TIMEOUT_MS = 10_000;
const ANSWER_READ_MAX = 4096;
const LOOK_EVERY_MS = 3_000;
const RUNS_READ_MAX = 1000; // the newest run files looked at, as runs.mjs listRuns
const KEPT_MAX = 20_000; // what is kept of tasks that are away, and of runs whose end was told
const STOPPED = new Set(['failed', 'limit', 'stopped']);

/** The signature of a delivery: "sha256=<hex>" over "<timestamp>.<body>". */
export const signature = (secret, ts, body) => `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

/**
 * One POST of `body` to `url` through the checked address only: resolved once (hookaddr.mjs: every address its name
 * resolves to), then connected to that one address with the name for its certificate; no redirect followed (a 3xx is
 * an answer, not ok), no proxy of the environment, `timeoutMs` for the whole try, the answer read up to 4 KB and thrown
 * away. `headers(ts)` gives the request's own headers. → { ok, status, refused? }. Never throws. Shared by the
 * webhooks and the field reports (src/field/send.mjs).
 */
export async function postPinned(url, body, { ownNetwork = false, headers = () => ({}), userAgent = 'Hoprig', lookup, ca, timeoutMs = DELIVERY_TIMEOUT_MS, now = Date.now } = {}) {
  // The time limit covers the whole try, the name lookup too: a resolver that never answers holds nothing longer.
  const deadline = Date.now() + timeoutMs;
  let to;
  let lookTimer;
  try {
    const late = new Promise((resolve) => {
      lookTimer = setTimeout(() => resolve(null), timeoutMs);
    });
    to = await Promise.race([resolveHook(url, { ownNetwork: ownNetwork === true, ...(lookup ? { lookup } : {}) }), late]);
  } catch {
    return { ok: false, status: null, refused: true };
  } finally {
    clearTimeout(lookTimer);
  }
  if (!to) return { ok: false, status: null }; // the name lookup did not answer in time
  const ts = String(Math.floor(now() / 1000));
  const mod = to.url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let done = false;
    let timer = null; // declared first: end() may run before the request exists (a request that cannot be built)
    const end = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    let req;
    try {
      req = mod.request(to.url, {
        method: 'POST',
        // The one address checked, whatever the name answers now; the name stays for the certificate and Host.
        lookup: (h, opts, cb) => (opts && opts.all ? cb(null, [{ address: to.address, family: to.family }]) : cb(null, to.address, to.family)),
        agent: new mod.Agent({ keepAlive: false, ...(ca && mod === https ? { ca } : {}) }), // never the global agent: no proxy of the environment, no pooled socket
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'User-Agent': userAgent, ...headers(ts) },
      }, (res) => {
        let got = 0;
        res.on('data', (c) => {
          got += c.length;
          if (got > ANSWER_READ_MAX) res.destroy(); // read a little and throw it away: only the status counts
        });
        const fin = () => end({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
        res.on('end', fin);
        res.on('close', fin);
        res.on('error', fin);
      });
    } catch {
      end({ ok: false, status: null });
      return;
    }
    timer = setTimeout(() => {
      req.destroy();
      end({ ok: false, status: null });
    }, Math.max(1, deadline - Date.now()));
    req.on('error', () => end({ ok: false, status: null }));
    req.end(body);
  });
}

/**
 * One try of one delivery. → { ok, status } (status: the receiver's HTTP status, or null when there was no answer).
 * `lookup`: a stand-in for the name lookup, `ca`: the certificate authority of a test's receiver (tests only: without
 * it the system's authorities check the certificate, as for every delivery). Never throws.
 */
export function deliverOnce(hook, body, { lookup, ca, timeoutMs = DELIVERY_TIMEOUT_MS, now = Date.now } = {}) {
  return postPinned(hook.url, body, {
    ownNetwork: hook.ownNetwork === true, userAgent: 'Hoprig-Work-Webhook', lookup, ca, timeoutMs, now,
    headers: (ts) => ({ 'X-Hoprig-Timestamp': ts, 'X-Hoprig-Signature': signature(hook.secret, ts, body) }),
  });
}

/**
 * The webhooks of this dashboard. o: { place, log, waits?, lookup?, timeoutMs?, now?, lookEvery? }.
 * → { start, look, poke, close, idle } (`idle`: resolves when nothing is being sent, for tests).
 */
export function workHooks(o) {
  const waits = o.waits || TRIES_WAIT_MS;
  // "<Work file>\n<token>\n<task>" → { token, status }. Kept while the task is missing from the file (until its token
  // has no webhook): when it is back, only what changed since is told. The file is in the key, so Work moved to
  // another project and back finds its tasks as they were.
  const seen = new Map();
  // run id → token, for each run whose end (done, failed, ...) was told or taken note of. A run ends once: its end is
  // never told again, whatever was missing in between.
  const ended = new Map();
  // token → when its tasks were looked at first (ISO). The first look at a token's tasks only takes note: a webhook
  // made for a token while another token's webhook was there must not hear of what happened before it was made. A
  // task of that token seen for the first time later is new (from.at after this) or was there all along: only a new
  // one counts from "open", the other only takes note.
  const primed = new Map();
  let timer = null;
  let closed = false;
  const sending = new Set();
  const later = new Map(); // a try's wait → { hook: its webhook's id, wake }
  // What each run file held when it was read last: name → { stamp, run: { id, item, state, startedAt } or null }. A run
  // file is written while its session works and then stays as it is, so a look reads again only a file that is new or
  // was written since (another inode, size or time): one folder listing and a stat per file, never every file once per
  // task (300 watched tasks and 1000 runs were 20 s of reads on the server's thread every 3 s).
  const runCache = new Map();
  let runsError = null; // why the runs could not be read at the last look that tried (a word, never a path), or null
  let runsSaid = false; // Activity was told of this spell of unreadable runs already
  function runsByItem(pl) {
    const by = new Map();
    let dir;
    let names;
    try {
      dir = runsDir(pl);
      names = fs.readdirSync(dir).filter((n) => RUN_FILE_RE.test(n)).sort().reverse().slice(0, RUNS_READ_MAX);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        runCache.clear();
        return by; // no runs folder: no runs yet
      }
      // The runs cannot be read now (the folder is a link, no permission): nothing of the runs is learned.
      runsError = e && e.details && e.details.code === 'runs-folder' ? 'it is not a plain folder' : e && e.code === 'EACCES' ? 'no permission' : 'it could not be read';
      return null;
    }
    runsError = null;
    const keep = new Set(names);
    for (const k of [...runCache.keys()]) if (!keep.has(k)) runCache.delete(k);
    for (const n of names) {
      let st;
      try {
        st = fs.lstatSync(path.join(dir, n));
      } catch {
        runCache.delete(n);
        continue;
      }
      const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
      let c = runCache.get(n);
      if (!c || c.stamp !== stamp) {
        const r = readRun(pl, n.slice(0, -'.json'.length));
        c = { stamp, run: r ? { id: r.id, item: r.item, state: r.state, startedAt: r.startedAt } : null };
        runCache.set(n, c);
      }
      if (!c.run) continue;
      if (!by.has(c.run.item)) by.set(c.run.item, []);
      by.get(c.run.item).push(c.run);
    }
    return by;
  }

  // Each try reads its webhook again: one removed (or its token revoked) since the delivery was queued gets no more
  // tries, and a try goes to the address and with the secret the webhook has now.
  const current = (id) => webhooksWithSecrets().find((h) => h.id === id) || null;
  async function send(queued, body) {
    for (let i = 0; i < waits.length && !closed; i++) {
      if (waits[i]) {
        await new Promise((r) => {
          const t = setTimeout(() => {
            later.delete(t);
            r();
          }, waits[i]);
          later.set(t, { hook: queued.id, wake: () => (clearTimeout(t), later.delete(t), r()) });
          t.unref?.();
        });
        if (closed) return;
      }
      const hook = current(queued.id);
      if (!hook) return;
      const r = await deliverOnce(hook, body, { ...(o.lookup ? { lookup: o.lookup } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
      if (r.ok) return;
      if (i === waits.length - 1) recordWork(`A webhook delivery was given up after ${waits.length} tries`, `failed: ${r.status ? `status ${r.status}` : r.refused ? 'its address was refused' : 'no answer'}`);
    }
  }
  function queue(hook, msg) {
    const body = JSON.stringify(msg);
    const p = send(hook, body).catch(() => {}).finally(() => sending.delete(p));
    sending.add(p);
  }

  const forget = () => {
    seen.clear();
    ended.clear();
    primed.clear();
  };

  /** Read once, compare, deliver what changed. */
  function look() {
    if (closed) return;
    const hooks = webhooksWithSecrets();
    if (!hooks.length) {
      forget();
      return;
    }
    // Taken before the read: a task added while the file is read counts as new on the next look, never as old.
    const time = new Date((o.now || Date.now)()).toISOString();
    let pl;
    let doc;
    try {
      pl = o.place();
      doc = readDoc(pl.file).doc;
    } catch {
      return; // no Work list to read now: look again later
    }
    const watched = new Set(hooks.map((h) => h.token));
    const events = [];
    const live = new Set();
    let byItem; // read once per look, and only when a watched task is there (null: could not be read)
    for (const raw of Array.isArray(doc.items) ? doc.items : []) {
      const f = raw && typeof raw === 'object' ? fromOf(raw) : null;
      if (!f || !watched.has(f.token)) continue;
      const key = `${pl.file}\n${f.token}\n${raw.id}`;
      live.add(key);
      const status = statusOf(raw);
      if (byItem === undefined) byItem = runsByItem(pl);
      const runs = [];
      for (const r of (byItem && byItem.get(raw.id)) || []) if (!f.at || String(r.startedAt || '') >= f.at) runs.push(r);
      const was = seen.get(key);
      const since = primed.get(f.token);
      const isNew = !!since && !!f.at && f.at > since; // came in after the token's first look: all its runs are new
      // The task's status is known from the Work file alone: a runs folder that cannot be read never holds it back. Its
      // runs are "known" once a look could read them: until then the ends of an old task's runs are not news.
      const runsKnown = byItem === null ? !!(was && was.runsKnown) : true;
      seen.set(key, { token: f.token, status, runsKnown });
      // Told: a task seen before, or one that came in after the token's first look. A task of the token seen for the
      // first time later (it was away then, or the file was another one) was there all along: it only takes note.
      const told = !!since && (!!was || isNew);
      // A run's end is told only for a task whose runs were read before (or a new task, whose runs all started since).
      const toldRuns = told && (isNew || !!(was && was.runsKnown));
      const task = { id: raw.id, title: typeof raw.title === 'string' ? raw.title : raw.id, status };
      if (told && status !== (was ? was.status : 'open')) {
        if (status === 'done') events.push({ token: f.token, event: 'done', task, run: null });
        if (status === 'waiting') events.push({ token: f.token, event: 'needs-you', task, run: null });
      }
      for (const r of runs) {
        if (r.state === 'running' || ended.has(r.id) || (r.state !== 'done' && !STOPPED.has(r.state))) continue;
        ended.set(r.id, f.token);
        if (!toldRuns) continue;
        if (r.state === 'done') events.push({ token: f.token, event: 'result', task, run: r.id, answer: (readRun(pl, r.id) || {}).answer || '' });
        else events.push({ token: f.token, event: 'needs-you', task, run: r.id });
      }
    }
    // A token that has no webhook now is forgotten: a webhook made for it later takes note first again.
    for (const [k, v] of [...seen]) if (!watched.has(v.token)) seen.delete(k);
    for (const [k, v] of [...ended]) if (!watched.has(v)) ended.delete(k);
    for (const k of [...primed.keys()]) if (!watched.has(k)) primed.delete(k);
    // Primed by a look that read the Work file: the runs are taken note of per task (runsKnown), so a runs folder that
    // cannot be read delays only the results, never "done" or "needs you".
    for (const k of watched) if (!primed.has(k)) primed.set(k, time);
    // Said once in Activity while the runs cannot be read (why, in a word; never the folder's path), again after a spell
    // in which they could.
    if (byItem === null && !runsSaid) {
      runsSaid = true;
      recordWork('Webhooks: the runs folder of Work could not be read, so results are not told until it can be', `failed: ${runsError || 'it could not be read'}`);
    } else if (byItem) runsSaid = false;
    // Bounded: the oldest of the tasks that are away go first, and the oldest ends of runs no longer listed.
    for (const k of seen.keys()) {
      if (seen.size <= KEPT_MAX) break;
      if (!live.has(k)) seen.delete(k);
    }
    if (byItem && ended.size > KEPT_MAX) {
      const listed = new Set([...byItem.values()].flat().map((r) => r.id));
      for (const k of ended.keys()) {
        if (ended.size <= KEPT_MAX) break;
        if (!listed.has(k)) ended.delete(k);
      }
    }
    for (const ev of events) {
      for (const h of hooks) {
        if (h.token !== ev.token || !h.events.includes(ev.event)) continue;
        const msg = { event: ev.event, task: ev.task, run: ev.run, time, ...(h.answer && ev.event === 'result' ? { answer: ev.answer } : {}) };
        queue(h, msg);
      }
    }
  }

  const safeLook = () => {
    try {
      look();
    } catch (e) {
      o.log(`webhooks: ${e && e.message}`);
    }
  };
  // The next look is set when one has ended, never on a fixed beat: a slow look is followed by the full wait, so looks
  // never run back to back on the server's thread.
  function arm() {
    timer = setTimeout(() => {
      timer = null;
      safeLook();
      if (!closed && webhooksWithSecrets().length) arm();
    }, o.lookEvery || LOOK_EVERY_MS);
    timer.unref?.();
  }
  /** The timer runs only while there is a webhook (at the start, or once one is made). */
  function poke() {
    if (closed) return;
    const hooks = webhooksWithSecrets();
    const any = hooks.length > 0;
    // The waits of a webhook that is gone end now: its delivery stops without another try.
    const ids = new Set(hooks.map((h) => h.id));
    for (const w of [...later.values()]) if (!ids.has(w.hook)) w.wake();
    if (any) {
      safeLook();
      if (!timer) arm();
    } else if (timer) {
      clearTimeout(timer);
      timer = null;
      forget();
    }
  }

  return {
    start: poke,
    poke,
    look: safeLook,
    idle: () => Promise.all([...sending]),
    running: () => timer !== null, // true only while there is a webhook to look for
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const w of [...later.values()]) w.wake();
    },
  };
}
