// Runs that end by themselves in the dashboard (alone.mjs), and the computer a schedule runs on: the part of the Work
// feature (feature.mjs adds these routes) that the automations call at a schedule's slot.
//
//   GET  /api/work/computer                this computer as a schedule names it: { id, label, timeZone } (the id is
//                                          its Work writer id, runs.mjs writerId: random, never a host name)
//   GET  /api/work/computers               this one and every computer linked to this dashboard: [{ id, label,
//                                          timeZone, here, reachable, why? }]
//   GET  /api/work/schedules               the schedules and the repeating items in one list (clisched.mjs
//                                          scheduleRows), each computer by its label
//   GET  /api/work/alone                   what runs by itself now on this computer, and what waits for a place
//   POST /api/work/alone/release { run }   the owner is done with a schedule's run: its worktree goes when clean
//   POST /api/work/alone/run { schedule: { id, label? }, action }   another dashboard (its token) or the owner: start
//                                          the run of a schedule here at its slot (the action as settings.mjs
//                                          cleanAlone checks it, again here with this computer's projects)
//
// A schedule that names another computer runs THERE only: this dashboard asks it over the existing link
// (src/machines: its endpoint and token) at the slot; when it cannot be reached, the slot is recorded as missed with
// the reason (schedules.mjs apply) and it does not run anywhere else. Which machine is which computer is learnt
// from each one's /api/work/computer and kept in this dashboard's state folder (an offline one keeps its name).
import fs from 'node:fs';
import path from 'node:path';
import { cleanAlone, readSettings } from '../automation/settings.mjs';
import { createActivityLog } from '../automation/store.mjs';
import { defaultHubLabel } from '../machines/hub.mjs';
import { callJson } from '../machines/relay.mjs';
import { loadMachines } from '../machines/store.mjs';
import { stateDir } from '../paths.mjs';
import { aloneRunner } from './alone.mjs';
import { finishInterrupted } from './resume.mjs';
import { readDoc } from './store.mjs';
import { checkRunAt } from './repeat.mjs';
import { placedItems, statusOf, viewItem } from './model.mjs';
import { writerId } from './runs.mjs';
import { scheduleRows } from './clisched.mjs';

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID_RE = /^[0-9a-f]{16}$/;
const SCHEDULE_ID_RE = /^[a-z0-9]{4,32}$/;
const knownFile = () => path.join(stateDir(), 'work-alone', 'computers.json');
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function readKnown() {
  try {
    const d = JSON.parse(fs.readFileSync(knownFile(), 'utf8'));
    return isObj(d) ? d : {};
  } catch {
    return {};
  }
}
function writeKnown(d) {
  fs.mkdirSync(path.dirname(knownFile()), { recursive: true, mode: 0o700 });
  const tmp = `${knownFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(d)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, knownFile());
}

/**
 * o: { sctx (the server's feature ctx), cfg(), places(), place(), store(), hub (src/machines hub: endpoint), run,
 * now, log, command (a stand-in coding tool), resolveEnv, minuteMs, timeoutMs }. → { routes, hooks, runner }.
 */
export function schedPart(o) {
  const log = o.log || (() => {});
  const activity = createActivityLog(path.join(stateDir(), 'automation.log'));
  const record = (e) => {
    activity.add({ automation: 'schedules', ...e });
    log(`${e.did} (${e.outcome})`);
  };
  const runner = aloneRunner({
    config: o.cfg, places: o.places, ...(o.run ? { run: o.run } : {}), ...(o.now ? { now: o.now } : {}), log,
    settings: () => {
      const a = readSettings((o.cfg() || {}).automation);
      return { ...a.schedules, paused: a.paused };
    },
    notify: (n) => Promise.resolve(o.sctx.notify ? o.sctx.notify({ ...n, status: 'automation', url: '' }) : null),
    record, defaultProvider: o.sctx.defaultProvider, ...(o.othersRunning ? { othersRunning: o.othersRunning } : {}), ...(o.command ? { command: o.command } : {}), ...(o.resolveEnv ? { resolveEnv: o.resolveEnv } : {}), ...(o.minuteMs ? { minuteMs: o.minuteMs } : {}),
  });
  const timeoutMs = o.timeoutMs || 8000;
  const me = () => ({ id: writerId(), label: defaultHubLabel(), timeZone: zone() });

  /** Ask machine `m` who it is: { id, label, timeZone } (kept for when it is offline). Throws with a plain reason. */
  async function ask(m, p, body) {
    if (!o.hub) throw fail(503, 'this dashboard has no link to other computers');
    const ep = await o.hub.endpoint(m, timeoutMs);
    return callJson(ep, { machine: m.label || m.name, method: body ? 'POST' : 'GET', path: p, token: m.token, timeoutMs, ...(body ? { body } : {}) });
  }
  async function whoIs(m) {
    const r = await ask(m, '/api/work/computer');
    if (r.status !== 200 || !r.json || !ID_RE.test(String(r.json.id))) throw fail(502, `${m.label || m.name} runs a Hoprig that does not run schedules for another computer yet`);
    const known = readKnown();
    known[m.name] = { id: r.json.id, label: m.label || m.name };
    writeKnown(known);
    return { id: r.json.id, timeZone: typeof r.json.timeZone === 'string' ? r.json.timeZone.slice(0, 60) : null };
  }

  /** This computer and the linked ones, each asked once (in parallel). */
  async function computers() {
    const list = [{ ...me(), here: true, reachable: true }];
    const known = readKnown();
    const out = await Promise.all(loadMachines().map(async (m) => {
      try {
        const w = await whoIs(m);
        return { id: w.id, label: m.label || m.name, timeZone: w.timeZone, here: false, reachable: true };
      } catch (e) {
        const k = known[m.name];
        return k ? { id: k.id, label: m.label || m.name, timeZone: null, here: false, reachable: false, why: e.message } : null;
      }
    }));
    return [...list, ...out.filter((x) => x && x.id !== list[0].id)];
  }

  /** The label of computer `id` as this dashboard knows it, or null. */
  const labelOf = (id) => {
    if (id === writerId()) return me().label;
    const k = Object.entries(readKnown()).find(([, v]) => v.id === id);
    // a computer not linked now keeps the label it had when it was met (readKnown), never its internal name
    return k ? (loadMachines().find((m) => m.name === k[0]) || {}).label || (typeof k[1].label === 'string' && k[1].label) || k[0] : null;
  };

  /**
   * A schedule's slot (automation index.mjs ctx.alone): here, or on the computer it names; never elsewhere. → { run,
   * on? } | { waiting, why, on? }; throws { missed: true } when that computer cannot be reached.
   */
  async function alone(s) {
    const job = { ...s.action, schedule: { id: s.id, label: s.label || null }, by: 'schedule' };
    delete job.type;
    if (!s.computer || s.computer === writerId()) return runner.startAlone(job);
    const known = readKnown();
    const label = labelOf(s.computer) || 'the computer it names';
    let m = loadMachines().find((x) => known[x.name] && known[x.name].id === s.computer);
    let r;
    try {
      if (!m) {
        // Not met yet (or its entry changed): ask each linked computer who it is.
        for (const x of loadMachines()) {
          try {
            if ((await whoIs(x)).id === s.computer) m = x;
          } catch {
            /* that one is not reachable: not it as far as anyone can tell */
          }
          if (m) break;
        }
      }
      if (!m) throw new Error('it is not linked to this dashboard, or is not on');
      r = await ask(m, '/api/work/alone/run', { schedule: { id: s.id, ...(s.label ? { label: s.label } : {}) }, action: s.action });
    } catch (e) {
      throw Object.assign(new Error(`${label} cannot be reached, so it did not run (and not anywhere else): ${String(e.message).slice(0, 200)}`), { missed: true });
    }
    // It answered: a refusal is that computer's own word, not a missed slot.
    if (r.status !== 200 || !r.json) throw new Error(`${m.label || m.name} refused it: ${r.json && r.json.error ? String(r.json.error).slice(0, 200) : `it answered HTTP ${r.status}`}`);
    return { ...r.json, on: m.label || m.name };
  }

  /** The items of Work with a run time, for the automations (itemruns.mjs); the repeating items move on first. */
  async function itemRuns() {
    let st;
    try {
      st = o.store();
      // An interrupted save first, as every route of Work does: the tick usually comes before any page after a crash.
      const fin = await finishInterrupted(st.place, o.run ? { run: o.run } : {});
      if (fin.problem) {
        log(`no task runs by itself while a save waits for you: ${fin.problem.slice(0, 200)}`);
        return null;
      }
      if ((await st.roll()).interrupted) return null;
    } catch {
      return null; // no Work list to read (no place yet, a file that needs a tidy): nothing to run
    }
    const { doc } = readDoc(st.place.file);
    const items = [];
    for (const [raw] of placedItems(doc)) {
      if (!isObj(raw.work) || !isObj(raw.work.at)) continue;
      let at;
      try {
        const { mode, ...rest } = raw.work.at; // a mode in the shared file is never taken (repeat.mjs RUN_AT_KEYS)
        at = checkRunAt(rest);
      } catch {
        continue; // a run time this computer does not understand runs nowhere
      }
      const v = viewItem(raw);
      items.push({ id: v.id, title: v.title, status: statusOf(raw), date: v.date, at });
    }
    return { me: writerId(), items };
  }

  const startItem = (id) => runner.startAlone({ item: id, by: 'schedule' });

  const routes = [
    ['GET', /^\/api\/work\/computer$/, async () => me()],
    ['GET', /^\/api\/work\/computers$/, async () => ({ computers: await computers() })],
    ['GET', /^\/api\/work\/schedules$/, async () => {
      let p = null;
      try {
        p = o.place();
      } catch {
        /* no Work list: only the schedules */
      }
      const r = scheduleRows(o.cfg(), p || { file: '' });
      return { ...r, rows: r.rows.map((x) => ({ ...x, computerLabel: x.computer ? labelOf(x.computer) : null })) };
    }],
    ['GET', /^\/api\/work\/alone$/, async () => ({ running: runner.running(), waiting: runner.waiting() })],
    // Done with a schedule's run: its worktree goes when nothing is left uncommitted; the branch stays.
    ['POST', /^\/api\/work\/alone\/release$/, async (req) => {
      const b = await o.sctx.readJson(req);
      if (!isObj(b) || Object.keys(b).some((k) => k !== 'run') || typeof b.run !== 'string' || !/^\d{8}-\d{6}-[0-9a-f]{8}$/.test(b.run)) throw fail(400, 'send { run }');
      return runner.releaseRun(b.run);
    }],
    ['POST', /^\/api\/work\/alone\/run$/, async (req) => {
      const b = await o.sctx.readJson(req);
      if (!isObj(b) || Object.keys(b).some((k) => !['schedule', 'action'].includes(k))) throw fail(400, 'send { schedule, action }');
      const sc = b.schedule;
      if (!isObj(sc) || !SCHEDULE_ID_RE.test(String(sc.id)) || (sc.label !== undefined && (typeof sc.label !== 'string' || sc.label.length > 60 || /[\r\n]/.test(sc.label)))) throw fail(400, 'that is not a schedule');
      const a = readSettings((o.cfg() || {}).automation);
      // Nothing starts here while the owner paused this computer's automations.
      if (a.paused) throw fail(409, 'the automations of this computer are paused');
      // The schedules switch is the master switch of schedules here, also for one another computer names.
      if (!a.schedules.enabled) throw fail(409, 'schedules are off on this computer');
      let action;
      try {
        action = cleanAlone(b.action);
      } catch (e) {
        throw fail(400, e.message);
      }
      const { type, ...job } = action;
      // remote: its schedule is the other computer's, so this one's list does not hold it (alone.mjs drain).
      const r = await runner.startAlone({ ...job, schedule: { id: sc.id, label: sc.label || null }, by: 'schedule', remote: true });
      return r.waiting ? { waiting: true, why: r.why } : { run: { id: r.run.id, branch: r.run.branch } };
    }],
  ];

  return { routes, runner, hooks: { alone, itemRuns, startItem, drain: () => runner.drain(), running: () => {
    // How many of Work's runs that end by themselves run here now (the computer's one measure of slots). Without a
    // Work list (no place set up yet) there are none.
    try {
      return runner.running().length;
    } catch {
      return 0;
    }
  } }, computers, labelOf };
}
