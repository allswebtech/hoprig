// The door of a Work token (docs/WORK.md, "Another program"): the only routes a Work token reaches, and the refusal of
// a Work token everywhere else. It is the second feature of the server (server.mjs), before Tia's door and the machines
// gate, so a request with a Work token is answered here and goes nowhere further:
//
//   POST /api/work/token/tasks { title, note?, project?, date? }   add a task (it carries the token's name: `from`)
//   GET  /api/work/token/tasks                                    the tasks this token added
//   GET  /api/work/token/tasks/<id>                               one of them, with its runs: state, times, answer
//
// These take a Work token only, as `Authorization: Bearer hwt_…`: no cookie, no machine token, no token in the address.
// A Work token on any other route, a WebSocket upgrade or a file of the page is refused. Per token: at most
// `perMinute` requests a minute (one token's requests never count for another) and `perDay` tasks a day, past either a
// 429 with Retry-After and one plain sentence. The token is looked up once per request, fresh from the file, and an
// add looks it up again under the Work file's lock: a revoke refuses what comes after it at once.
import { RateLimiter } from '../server/auth.mjs';
import { fromOf, isYmd, statusOf, todayIn } from './model.mjs';
import { listRuns } from './runs.mjs';
import { readDoc } from './store.mjs';
import { touchWorkToken, verifyWorkToken, workLimits, workTokenLive } from './access.mjs';

const PREFIX = /^\/api\/work\/token(\/|$)/;
const LIST = /^\/api\/work\/token\/tasks$/;
const ONE = /^\/api\/work\/token\/tasks\/([a-z0-9][a-z0-9-]{0,79})$/;
const MINUTE = 60_000;
// "Bearer hwt_…" in any case and spacing: a Work token is never passed on as something else.
const WORK_BEARER = /^\s*bearer\s+hwt_/i;

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (status, message, code) => Object.assign(new Error(message), { status, details: { code } });

/** The token of a request: from one `Authorization: Bearer` header only; null when there is none. */
function bearerOf(req) {
  const h = req.headers && req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(h.trim());
  return m ? m[1] : null;
}
/** True when a request carries a Work token anywhere it could be taken for one. */
const hasWorkToken = (req) => {
  const h = req.headers || {};
  return WORK_BEARER.test(String(h.authorization || '')) || /hwt_[A-Za-z0-9_-]{20,}/.test(String(req.url || ''));
};

/** A task as a token reads it: its own words and state, never the session, folder, commits or files of a run. */
const taskView = (raw) => ({
  id: raw.id, title: typeof raw.title === 'string' ? raw.title : raw.id, status: statusOf(raw), date: isYmd(raw.date) ? raw.date : null,
  project: typeof raw.project === 'string' ? raw.project : null, note: typeof raw.note === 'string' ? raw.note : '',
  created: isYmd(raw.created) ? raw.created : null, from: fromOf(raw).name,
});
const runView = (r) => ({ id: r.id, state: r.state, startedAt: r.startedAt || null, endedAt: r.endedAt || null, reason: r.reason || null, answer: r.state === 'running' ? '' : r.answer || '' });

/**
 * o: { place, store, readJson, resume, log, clientIp, now? }. → { name, handle, upgrade } for the server's features.
 */
export function tokenDoor(o) {
  const now = o.now || (() => Date.now());
  const minute = new Map(); // token id → the times of its requests in the last minute
  const misses = new RateLimiter({ perIp: 30, global: 300, windowMs: MINUTE, now });
  const mineOf = (doc, id) => (Array.isArray(doc.items) ? doc.items : []).filter((x) => x && typeof x === 'object' && fromOf(x) && fromOf(x).token === id);

  /** Counted before anything is done: → milliseconds to wait, or 0. */
  function spend(id, perMinute) {
    const t = now();
    // Only the last minute as the clock reads now: a request stamped after now (the clock was set back) is not in it,
    // else a token stood refused for as long as the clock went back.
    const list = (minute.get(id) || []).filter((x) => x > t - MINUTE && x <= t);
    if (list.length >= perMinute) {
      minute.set(id, list);
      return list[0] + MINUTE - t;
    }
    list.push(t);
    minute.set(id, list);
    if (minute.size > 1000) for (const [k, v] of minute) if (!v.some((x) => x > t - MINUTE && x <= t)) minute.delete(k);
    return 0;
  }

  async function route(req, p, entry) {
    if (LIST.test(p) && req.method === 'POST') {
      const b = await o.readJson(req);
      await o.resume();
      const r = await o.store().addFrom(b, { token: entry.id, name: entry.name }, { live: () => workTokenLive(entry.id), perDay: workLimits().perDay });
      const { doc } = readDoc(o.place().file);
      const raw = mineOf(doc, entry.id).find((x) => x.id === r.item.id);
      return { task: taskView(raw || { ...r.item, from: { token: entry.id, name: entry.name } }) };
    }
    if (LIST.test(p) && req.method === 'GET') {
      const { doc } = readDoc(o.place().file);
      return { tasks: mineOf(doc, entry.id).map(taskView) };
    }
    const m = ONE.exec(p);
    if (m && req.method === 'GET') {
      const pl = o.place();
      const { doc } = readDoc(pl.file);
      const raw = mineOf(doc, entry.id).find((x) => x.id === m[1]);
      // Another token's task, the owner's own and one that is not there are the same answer: nothing to read here.
      if (!raw) throw fail(404, 'this token added no task with that id', 'not-found');
      // Only runs that started after the task came in: a task of the owner's that once had this id is not this one.
      const since = fromOf(raw).at || '';
      const runs = listRuns(pl, { item: raw.id }).filter((r) => !since || String(r.startedAt || '') >= since).map(runView);
      return { task: taskView(raw), runs };
    }
    if (m || LIST.test(p)) throw fail(405, 'that method is not one this route takes', 'method');
    throw fail(404, 'a Work token reaches only /api/work/token/tasks', 'not-found');
  }

  async function handle(req, res) {
    let p;
    try {
      p = new URL(req.url, 'http://x').pathname;
    } catch {
      return false;
    }
    const ours = PREFIX.test(p);
    if (!ours) {
      if (!hasWorkToken(req)) return false;
      send(res, 403, { error: 'a Work token reaches only /api/work/token/tasks', code: 'token-scope' });
      return true;
    }
    try {
      const token = bearerOf(req);
      if (/hwt_/.test(String(req.url || ''))) throw fail(400, 'send the Work token in the Authorization header, never in the address', 'token-in-address');
      if (!token || !token.startsWith('hwt_')) throw fail(401, 'these routes take a Work token: Authorization: Bearer hwt_…', 'token');
      // The token is checked first: the limit of wrong tries refuses only wrong ones. Every visitor of the public link
      // comes from one address, so a stranger's wrong tries must never lock out a program whose token is right (a guess
      // of a 256-bit token gains nothing from the extra tries; each costs one read and one hash).
      const ip = o.clientIp(req);
      const entry = verifyWorkToken(token);
      if (!entry) {
        const wait = misses.retryAfter(ip);
        if (wait > 0) return send(res, 429, { error: `Too many tries with a wrong token: wait ${Math.ceil(wait / 1000)} seconds`, code: 'rate' }, { 'Retry-After': String(Math.ceil(wait / 1000)) }), true;
        misses.fail(ip);
        throw fail(401, 'this dashboard does not accept that Work token (unknown or revoked)', 'token');
      }
      const late = spend(entry.id, workLimits().perMinute);
      if (late > 0) {
        const s = Math.ceil(late / 1000);
        return send(res, 429, { error: `This Work token made ${workLimits().perMinute} requests in the last minute, its limit: try again in ${s} seconds.`, code: 'minute-limit' }, { 'Retry-After': String(s) }), true;
      }
      touchWorkToken(entry.id);
      const out = await route(req, p, entry);
      send(res, 200, out);
    } catch (e) {
      if (!Number.isInteger(e.status)) {
        o.log('token route', e && e.message);
        send(res, 500, { error: 'Work could not do that because of an error on this computer', code: 'internal' });
      } else {
        // The code of the refusal, also one the error carries as its own (the Work file's lock: busy), as the page's routes.
        const own = typeof e.code === 'string' && /^[a-z][a-z-]+$/.test(e.code) ? e.code : null;
        const code = (e.details && e.details.code) || own || (e.status === 429 ? 'day-limit' : 'refused');
        send(res, e.status, { error: e.message, code }, e.status === 429 ? { 'Retry-After': String(secondsToMidnight(now(), zoneOf(o.place))) } : {});
      }
    }
    return true;
  }

  /** A WebSocket upgrade with a Work token: refused, whatever the address. */
  async function upgrade(req, socket) {
    if (!hasWorkToken(req) && !PREFIX.test(String(req.url || '').split('?')[0])) return false;
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return true;
  }

  return { name: 'work-tokens', handle, upgrade };
}

/** Work's time zone ("" = this computer's): the day the store counts a token's tasks in (store.mjs addFrom). */
function zoneOf(place) {
  try {
    return place().settings.timeZone || '';
  } catch {
    return '';
  }
}

/**
 * Seconds until the next midnight of `timeZone` (the day of Work, as the day limit counts it): the first moment whose
 * date there is another one, found by halving the next 48 hours (a zone's day may be 23 or 25 hours long).
 */
export function secondsToMidnight(t, timeZone = '') {
  const today = todayIn(timeZone, new Date(t));
  let lo = t;
  let hi = t + 48 * 3_600_000;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (todayIn(timeZone, new Date(mid)) === today) lo = mid;
    else hi = mid;
  }
  return Math.max(1, Math.ceil((hi - t) / 1000));
}
