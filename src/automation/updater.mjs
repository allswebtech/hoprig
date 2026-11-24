// The one place an update runs. Settings → Updates ("Check now", "Update now", "Update all"), the command line and
// the automatic rule (./updates.mjs) all go through it: one update at a time, one output log, and every result in
// the activity log.
//
//   view({ fresh, id })   → { mode, notify, running, items: [row] }; the facts of each item are kept 10 minutes
//                           (1 minute when a server could not be reached) unless `fresh` (Check now) or after an
//                           update of that item
//   start(ids | 'all')    → { started, ids, skipped: [{ id, why }] } and the work goes on in the background;
//                           throws (status 409) while another update runs or when the one item asked for must wait
//   auto(id)              → the automatic rule's update of one item: { waited } | { ok, version, error }
//   log(from)             → { running, id, ids, lines, next, results }
//
// A row: { id, title, whenRunning, installed, latest, method, updateAvailable, canUpdate, why, note, error,
//          action: 'update' | 'install' | null, blocked, auto, checkedAt, last, running }
import { tildeText } from '../pcsetup/feature.mjs';
import { cleanUpdateSettings, readUpdateSettings } from './updates.mjs';

export const INFO_TTL_MS = 10 * 60_000;
// A look that could not reach a server (no newest version, or an error) is tried again sooner.
export const MISS_TTL_MS = 60_000;
const LINES_MAX = 3000;
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * ctx: { items (./updateitems.mjs), cards() → the session cards, config(), saveConfig(patch), record(entry),
 *        now() }
 */
export function createUpdater({ items, cards, config, saveConfig, record = () => {}, now = Date.now, restarter = { installed: () => false, run: () => {} } }) {
  const facts = new Map(); // id → { at, info } | { at, error }
  const last = new Map(); // id → { ok, version, at, error }
  let job = null; // { ids, id, running, lines, results }
  // Taken at once, before anything is awaited: two presses (a double click, two pages, the automatic rule) that
  // arrive together must not both start. Installs in other processes are kept apart by the tool's own lock.
  let claimed = false;
  const free = () => !claimed && !(job && job.running);

  const byId = (id) => {
    const it = items.find((i) => i.id === id);
    if (!it) throw fail(404, `nothing called "${String(id).slice(0, 40)}" is updated here`);
    return it;
  };

  const looking = new Map(); // id → the look in progress: two pages asking at once share it

  function look(item, fresh) {
    if (looking.has(item.id)) return looking.get(item.id);
    const p = lookNow(item, fresh).finally(() => looking.delete(item.id));
    looking.set(item.id, p);
    return p;
  }

  async function lookNow(item, fresh) {
    const hit = facts.get(item.id);
    const ttl = hit && (hit.error || (hit.info && !hit.info.latest && hit.info.canUpdate)) ? MISS_TTL_MS : INFO_TTL_MS;
    if (!fresh && hit && now() - hit.at < ttl) return hit;
    let f;
    try {
      if (item.prepare) await item.prepare();
      f = { at: now(), info: await item.info({ fresh }) }; // fresh: Check now asks the servers again, past their caches
    } catch (e) {
      f = { at: now(), error: e.message };
    }
    facts.set(item.id, f);
    return f;
  }

  function rowOf(item, f, list) {
    const i = (f && f.info) || {};
    const known = !!(f && f.info);
    const action = !known ? null : !i.installed ? (item.installable ? 'install' : null) : i.canUpdate && (i.updateAvailable || !i.latest) ? 'update' : null;
    return {
      id: item.id,
      title: item.title,
      whenRunning: item.whenRunning,
      installed: i.installed ?? null,
      latest: i.latest ?? null,
      method: i.method || null,
      updateAvailable: !!i.updateAvailable,
      canUpdate: !!i.canUpdate,
      why: i.why || null,
      note: i.note || null,
      error: (f && f.error) || null,
      action,
      blocked: action ? item.blocked(list) : null,
      notInAll: i.notInAll || null,
      auto: known && !!i.installed && !!item.autoOk(i),
      checkedAt: f ? f.at : null,
      last: last.get(item.id) || null,
      running: !!(job && job.running && job.id === item.id),
    };
  }

  async function view({ fresh = false, id = null } = {}) {
    const list = await cards();
    if (id) byId(id);
    const fs = await Promise.all(items.map((it) => look(it, fresh && (!id || it.id === id))));
    return { ...readUpdateSettings(config()), running: job && job.running ? job.id : null, items: items.map((it, n) => rowOf(it, fs[n], list)) };
  }

  /** Run `ids` one after another; resolves when all are done. */
  function run(ids, by) {
    job = { ids, id: ids[0], running: true, lines: [], results: {} };
    const j = job;
    const line = (l) => {
      j.lines.push(tildeText(String(l)).slice(0, 500)); // the home folder as "~": no user name on the page
      if (j.lines.length > LINES_MAX) j.lines.splice(0, j.lines.length - LINES_MAX);
    };
    return (async () => {
      for (const id of ids) {
        const item = byId(id);
        j.id = id;
        line(`--- ${item.title} ---`);
        let r;
        try {
          r = await item.update({ onLine: line });
        } catch (e) {
          r = { ok: false, version: null, output: e.message };
          line(e.message);
        }
        const res = { ok: !!r.ok, version: r.version || null, at: now(), installed: !!r.installed, restart: !!r.restart, error: r.ok ? null : tildeText(String(r.output || '').split('\n').filter(Boolean).pop() || 'see the output') };
        j.results[id] = res;
        last.set(id, res);
        facts.delete(id); // look again: the version changed
        if (by === 'owner') record({ automation: 'updates', did: `${r.installed ? 'installed' : 'updated'} ${item.title} (${r.installed ? 'Install' : 'Update now'})`, outcome: res.ok ? `ok: now ${res.version || 'installed'}` : `failed: ${res.error}` });
      }
      j.running = false;
      return j.results;
    })();
  }

  async function start(which) {
    if (!free()) throw fail(409, 'an update is already running; wait until it finishes');
    claimed = true;
    try {
      return await startClaimed(which);
    } finally {
      claimed = false;
    }
  }

  async function startClaimed(which) {
    const v = await view();
    let ids;
    const skipped = [];
    if (which === 'all') {
      ids = [];
      for (const r of v.items) {
        if (r.action !== 'update' || !r.updateAvailable) continue;
        if (r.notInAll) skipped.push({ id: r.id, why: r.notInAll });
        else if (r.blocked) skipped.push({ id: r.id, why: r.blocked });
        else ids.push(r.id);
      }
      if (!ids.length) return { started: false, ids, skipped };
    } else {
      const r = v.items.find((x) => x.id === which) || (byId(which), null);
      if (!r.action) throw fail(409, r.why || (r.installed ? `${r.title} is up to date` : `${r.title} cannot be installed from here`));
      if (r.blocked) throw fail(409, r.blocked);
      ids = [which];
    }
    run(ids, 'owner');
    return { started: true, ids, skipped };
  }

  async function auto(id) {
    if (!free()) return { waited: 'another update is running' };
    claimed = true;
    let running;
    try {
      const item = byId(id);
      if (item.prepare) await item.prepare();
      const list = await cards();
      const why = item.blocked(list) || (item.autoBlocked ? item.autoBlocked(list) : null);
      if (why) return { waited: why };
      running = run([id], 'auto');
    } finally {
      claimed = false;
    }
    return (await running)[id];
  }

  return {
    view,
    start,
    auto,
    settings: () => readUpdateSettings(config()),
    changeSettings(patch) {
      const next = cleanUpdateSettings(patch, readUpdateSettings(config()));
      saveConfig({ updates: next });
      return next;
    },
    // A restart the dashboard runs for itself, so an update finished on the page needs no terminal (selfrestart.mjs).
    // Only when it is installed as a service: a plain `serve` is restarted by the person who started it.
    restart() {
      if (!restarter.installed()) {
        return { ok: false, why: 'This dashboard is not running as a background service, so it cannot restart itself. On the computer, stop it and start it again to use the new version.' };
      }
      restarter.run();
      return { ok: true, restarting: true };
    },
    log(from = 0) {
      if (!job) return { running: false, id: null, ids: [], lines: [], next: 0, results: {} };
      const f = Math.max(0, Math.min(Number(from) || 0, job.lines.length));
      return { running: job.running, id: job.id, ids: job.ids, lines: job.lines.slice(f), next: job.lines.length, results: job.results };
    },
  };
}
