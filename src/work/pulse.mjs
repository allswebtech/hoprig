// Progress, read and never told by a model: what runs, how far it is, when it will be done by what was measured, and
// what waits for the owner. ONE function gives it (progress); the page, the command, the notifications and Tia read
// that one.
//
// workUnits() is the one door to what there is to follow. Today it knows Work's runs (runs/<id>.json in the Work
// folder: Do it and the runs that end by themselves, a schedule's among them), the coding sessions of this computer
// (their run records in Hoprig's state folder, read only: a record whose process is gone is passed over, never
// removed here), the workflows those sessions run, and the workflows that ended in the workspace's project folders
// (pulsefiles.mjs). Reading costs files only: no program starts.
//
// A unit: { id, type: run | session | workflow, title, project, kind (the estimate's key), state: running | waiting |
//   done | failed | stopped | limit, startedAt, endedAt, reason (the tool's own words, cut to 80), tokens (null: not
//   reported), steps (a workflow's phases and agents), lastAt (its last progress), waitsSince, item, run, schedule }
import fs from 'node:fs';
import path from 'node:path';
import { runsDir as sessionRunsDir } from '../paths.mjs';
import { readSettings } from '../automation/settings.mjs';
import { basisOf, clockText, etaOf, runKind } from './estimate.mjs';
import { projectsIn } from '../workspace/layout.mjs';
import { folderChoices, projectsByName } from './folders.mjs';
import { cutter, endedWorkflows, finishedWorkflows, transcriptTokens, workflowsOf } from './pulsefiles.mjs';
import { RUN_FILE_RE, readRun, runsDir, tokensOf, writerId } from './runs.mjs';
import { partsOf } from '../models/parts.mjs';

export const REASON_MAX = 80;
// One formatter for every count: toLocaleString makes a new one at each call, which over thousands of units held the
// thread for tens of milliseconds.
const NUMBER = new Intl.NumberFormat('en-US');
/** partsOf's answer with only what the card shows (no helper's agent name, no file, no path). */
const cardOf = (got) => ({
  lead: got.lead ? { model: got.lead.model, tokens: got.lead.tokens, use: got.lead.use } : null,
  parts: got.parts.map(({ kind, tier, model, tokens, use, cacheWrite, byModel }) => ({ kind, tier, model, tokens, use, cacheWrite, byModel })),
  tiers: got.tiers.map(({ tier, models, tokens, use, parts }) => ({ tier, models, tokens, use, parts })),
  span: got.span || null, // when its messages were written (runuse.mjs: only within the run are they the run's)
});
/** Who did what of each Work run that had helpers, by run id, from workUnits (the one reader). */
export async function partsByRun(o = {}) {
  const w = await workUnits(o);
  return new Map(w.units.filter((u) => u.type === 'run' && u.parts).map((u) => [u.run, u.parts]));
}
/** Who did what of each task, by item id: the cards of its runs that had helpers (newest first), from workUnits. */
export async function partsByItem(o = {}) {
  const w = await workUnits(o);
  const m = new Map();
  for (const u of w.units) if (u.type === 'run' && u.parts && u.item) (m.get(u.item) || m.set(u.item, []).get(u.item)).push(u.parts);
  return m;
}

const TIER_ORDER = ['fast', 'strong', 'strongest', 'other'];
/**
 * A plan's "Who did what": its tasks' runs summed per tier, and per task the models that worked on it (the lead's
 * first). `tasks`: the plan's tasks in its order ([{ id, title }]); `byItem`: partsByItem's map. → { lead: null,
 * parts: [], tiers, tasks: [{ id, title, models, runs }] } (the chat page's shape, so its card draws it), or null
 * when no run of the plan had a helper.
 */
export function planParts(tasks, byItem) {
  const tiers = [];
  const rows = [];
  for (const t of tasks) {
    const cards = byItem.get(t.id) || [];
    if (!cards.length) continue;
    const models = [];
    for (const c of cards) {
      for (const m of [c.lead && c.lead.model, ...c.parts.map((p) => p.model)]) if (m && !models.includes(m)) models.push(m);
      for (const x of c.tiers) {
        let s = tiers.find((y) => y.tier === x.tier);
        if (!s) tiers.push((s = { tier: x.tier, models: [], tokens: 0, use: { in: 0, out: 0, cached: 0 }, parts: 0 }));
        for (const m of x.models) if (!s.models.includes(m)) s.models.push(m);
        s.tokens += x.tokens;
        s.parts += x.parts;
        for (const k of ['in', 'out', 'cached']) s.use[k] += (x.use && x.use[k]) || 0;
      }
    }
    rows.push({ id: t.id, title: t.title, models, runs: cards.length });
  }
  const rank = (x) => (TIER_ORDER.includes(x.tier) ? TIER_ORDER.indexOf(x.tier) : TIER_ORDER.length);
  return rows.length ? { lead: null, parts: [], tiers: tiers.sort((a, b) => rank(a) - rank(b)), tasks: rows } : null;
}
export const SINCE_MS = 24 * 3_600_000; // "done" and "failed" count from this long ago, unless asked for another time
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const msOf = (s) => (typeof s === 'string' ? Date.parse(s) : NaN);

/** The tool's own words, on one line, cut at REASON_MAX (a whole word kept where it can be). */
export function shortWords(s, max = REASON_MAX) {
  const t = String(s || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const i = cut.lastIndexOf(' ');
  return `${(i > max * 0.6 ? cut.slice(0, i) : cut).replace(/[\s,.;:]+$/, '')}…`;
}

/** A run's reason: the product's own lead-in taken off BEFORE the cut, so REASON_MAX holds the tool's own words. */
const reasonOf = (r) => {
  const w = shortWords(String(r).replace(/^The run ended in an error: /, '').replace(/^The run did not start: /, ''));
  return w.charAt(0).toUpperCase() + w.slice(1);
};

/** The coding sessions' run records of this computer, read only (a record whose process is gone is left out). */
async function sessionRecords({ alive = defaultAlive, cut }) {
  let names = [];
  const dir = sessionRunsDir();
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).slice(0, 500);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    await cut.op();
    try {
      const st = fs.lstatSync(path.join(dir, n));
      if (!st.isFile() || st.size > 256 * 1024) continue;
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (isObj(r) && Number.isInteger(r.pid) && typeof r.cwd === 'string' && alive(r.pid)) out.push(r);
    } catch {
      /* being written, or not a record */
    }
  }
  return out;
}
/** A process is there (a signal 0 only asks; nothing starts). */
function defaultAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const SESSION_STATE = { starting: 'running', working: 'running', attention: 'waiting' };

/** Work's runs, newest first (the newest LIST_MAX), each read with a cut between: as listRuns, a piece at a time. */
async function runsOf(place, cut) {
  let names = [];
  try {
    names = fs.readdirSync(runsDir(place)).filter((n) => RUN_FILE_RE.test(n)).sort().reverse().slice(0, RUNS_MAX);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    await cut.op();
    const r = readRun(place, n.slice(0, -5));
    if (r) out.push(r);
    await cut.parsed();
  }
  return out;
}
const RUNS_MAX = 1000;

/**
 * Everything there is to follow, as units. o: { place (Work's, or null), cfg, alive (a stand-in, tests), since (ms: the
 * earliest time a reader asks for; a workflow record written before it is not read) }. → { units, finished }
 * (finished: [{ kind, ms, endedAt }] of every one that ended well: the basis of the estimates). It gives the server's
 * thread back while it reads (pulsefiles.mjs cutter), so it is awaited.
 */
export async function workUnits({ place = null, cfg = {}, alive, since = -Infinity } = {}) {
  const cut = cutter();
  const units = [];
  const finished = [];
  const labels = new Map();
  try {
    for (const s of readSettings((cfg || {}).automation).schedules.list) if (s.label) labels.set(s.id, s.label);
  } catch {
    /* no schedules */
  }
  if (place) {
    const me = writerId({ make: false });
    let byName = null; // the workspace's projects, read once when a run's helpers are looked for
    for (const r of await runsOf(place, cut)) {
      if (r.by === 'look') continue; // a look of Tia's is no piece of Work (src/operator/look.mjs): its card is on the Operator page
      const kind = runKind(r);
      const startedMs = msOf(r.startedAt);
      const endedMs = msOf(r.endedAt);
      if (r.state === 'done' && Number.isFinite(startedMs) && Number.isFinite(endedMs)) finished.push({ kind, ms: endedMs - startedMs, endedAt: r.endedAt });
      units.push({
        id: `run:${r.id}`, type: 'run', title: r.title, project: r.project, kind, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt,
        reason: r.state === 'done' || !r.reason ? null : reasonOf(r.reason), tokens: tokensOf(r.used), steps: null, lastAt: r.endedAt || r.startedAt,
        waitsSince: null, item: r.item, run: r.id, schedule: r.schedule || null, scheduleLabel: r.schedule ? labels.get(r.schedule) || null : null, by: r.by,
        mine: me !== null && r.writer === me, // only the dashboard that ran it tells of it (tell.mjs)
      });
      Object.defineProperties(units[units.length - 1], { chat: { value: r.session }, conversation: { value: r.conversation } }); // not shown, not in JSON
      // Who did what: the helpers that did parts of this run, read from Claude Code's own records beside its
      // conversation (models/parts.mjs), never from what a model says. Only where there was a helper.
      if (r.tool === 'claude' && typeof r.conversation === 'string' && r.conversation) {
        await cut.op();
        if (!byName) {
          try {
            byName = projectsByName(projectsIn(cfg));
          } catch {
            byName = new Map();
          }
        }
        const pdir = byName.get(r.project);
        const dir = pdir ? (r.folder && r.folder !== '.' ? path.join(pdir, r.folder) : pdir) : null;
        const got = dir ? partsOf(realOr(dir), r.conversation) : null;
        // The chat page's shape (partsOf): the lead, each part, the tiers, each with its tokens new/written/cached.
        if (got && got.parts.length) units[units.length - 1].parts = cardOf(got);
      }
    }
  }
  // A running Work run's own chat or conversation: its session record is that run, not another piece of work.
  const ofRuns = new Map();
  for (const u of units) {
    if (u.state !== 'running') continue;
    for (const x of [u.chat, u.conversation]) if (typeof x === 'string' && x) ofRuns.set(x, u);
  }
  const seen = new Set();
  const folders = new Set();
  const convs = new Set(); // the conversations whose workflows were read through a live record
  for (const r of await sessionRecords({ ...(alive ? { alive } : {}), cut })) {
    const conv = typeof r.sessionId === 'string' ? r.sessionId : typeof r.conversation === 'string' ? r.conversation : null;
    const key = conv || r.runId;
    if (seen.has(key)) continue;
    seen.add(key);
    const project = path.basename(r.cwd) || 'a folder';
    const state = SESSION_STATE[r.status];
    const ofRun = [r.chat, r.sessionId, r.conversation].map((x) => (typeof x === 'string' ? ofRuns.get(x) : null)).find(Boolean);
    const wfs = conv ? await workflowsOf(r.cwd, conv, { cut }) : [];
    if (conv) convs.add(conv);
    // A folder's finished workflows are the basis once, however many sessions work in it.
    if (!folders.has(r.cwd)) for (const f of await finishedWorkflows(r.cwd, { cut })) finished.push({ kind: `workflow:${f.name}`, ms: f.ms, endedAt: f.endedAt });
    folders.add(r.cwd);
    // Every workflow of the conversation: one that runs, and one that finished, failed or was stopped (its end is its
    // start and duration; progress counts it as done or failed from `since`, as it does a run). In a Work run's
    // conversation the one that runs is that run's work: its steps are the run's, not a second piece that runs.
    for (const w of wfs) {
      if (ofRun && w.state === 'running') {
        ofRun.steps = w.steps;
        continue;
      }
      units.push(workflowUnit(w, conv, project));
    }
    if (ofRun) {
      // Not a second running piece of work; but its question is his to answer, so it waits for him (on its run).
      if (state === 'waiting') units.push(await sessionUnit(r, { key, conv, project, state, item: ofRun.item, run: ofRun.run, cut }));
      continue;
    }
    if (!state) continue; // a session that waits for his next message is not work that runs
    // A working session that runs a workflow: the workflow (with its steps) is that session's work, counted once.
    if (state === 'running' && wfs.some((w) => w.state === 'running')) continue;
    units.push(await sessionUnit(r, { key, conv, project, state, cut }));
  }
  // A workflow that ended in a session whose process is gone by now (a terminal closed after the night): read from
  // the folder's own files, in every project folder of the workspace (and the code repositories a run may work in) and
  // every folder a live session works in. A dead session's record is no way to it: it is passed over here, and the
  // launcher's own list removes it.
  const listed = new Set(units.map((u) => u.id));
  for (const dir of workFolders(cfg, folders)) {
    const project = path.basename(dir) || 'a folder';
    await cut.op();
    for (const w of await endedWorkflows(dir, { since, cut })) {
      const u = workflowUnit(w, w.conv, project);
      if (convs.has(w.conv) || listed.has(u.id)) continue;
      listed.add(u.id);
      units.push(u);
    }
  }
  return { units, finished };
}

/** A workflow record of conversation `conv` as a unit (its end is its start and duration). */
function workflowUnit(w, conv, project) {
  return {
    id: `workflow:${conv}:${w.id}`, type: 'workflow', title: w.name, project, kind: `workflow:${w.name}`, state: w.state, startedAt: iso(w.startedMs),
    endedAt: w.state === 'running' ? null : iso(w.endedMs), reason: null, tokens: w.tokens, steps: w.steps, lastAt: iso(w.lastAt), waitsSince: null, item: null,
    run: null, schedule: null, scheduleLabel: null, mine: true,
  };
}

const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
/** The folders a session of this computer works in: `live` (the live sessions'), and each project of the workspace's choices. */
function workFolders(cfg, live) {
  const out = new Set(live);
  let projects = new Map();
  try {
    projects = projectsByName(projectsIn(cfg));
  } catch {
    /* no projects folder */
  }
  // Both the path through a link and the real one: the coding tool names a folder's store by the path it started in.
  for (const dir of projects.values()) {
    for (const c of folderChoices(dir)) {
      const p = c.value === '.' ? dir : path.join(dir, c.value);
      out.add(p);
      out.add(realOr(p));
    }
  }
  return out;
}

/** A session record as a unit (item, run: the Work run it belongs to, else null). */
async function sessionUnit(r, { key, conv, project, state, item = null, run = null, cut }) {
  const tokens = conv ? await transcriptTokens(r.cwd, conv, { cut }) : null;
  return {
    id: `session:${key}`, type: 'session', title: `A session in ${project}`, project, kind: `session:${project}`, state, startedAt: iso(r.startedAt), endedAt: null,
    reason: null, tokens, steps: null, lastAt: iso(r.statusAt),
    waitsSince: state === 'waiting' ? iso(Number.isFinite(r.askAt) ? r.askAt : r.statusAt) : null, item, run, schedule: null, scheduleLabel: null, mine: true,
  };
}

/**
 * The progress of this computer's Work, as every reader gets it: o: { cfg, place (null: no Work list), items, now, since
 * (ms or null) }. The time zone is Work → Tasks → Work settings (at the foot)'s (else this computer's).
 */
export async function readProgress({ cfg = {}, place = null, items = [], now = Date.now(), since = null, item = null, run = null, alive } = {}) {
  const tz = (cfg && cfg.work && typeof cfg.work.timeZone === 'string' && cfg.work.timeZone) || '';
  const w = await workUnits({ place, cfg, since: Number.isFinite(since) ? since : now - SINCE_MS, ...(alive ? { alive } : {}) });
  // One task's or one run's progress: only its units; the estimate's basis stays every finished one of its kind.
  const units = w.units.filter((u) => (!item || u.item === item) && (!run || u.run === run));
  const p = progress({ units, finished: w.finished, items, now, tz, ...(Number.isFinite(since) ? { since } : {}) });
  return { ...p, lines: progressLines(p) };
}

/** A `since` from a route or the command: an ISO time, or a number of hours back ("12h"). → ms, or null; throws on anything else. */
export function sinceOf(v, now = Date.now()) {
  if (v === undefined || v === null || v === '') return null;
  const h = /^(\d{1,3})h$/.exec(String(v));
  if (h) return now - Number(h[1]) * 3_600_000;
  if (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(String(v)) && Number.isFinite(Date.parse(v))) return Date.parse(v);
  throw Object.assign(new Error('since is a time (2026-11-18T22:00Z) or a number of hours back (12h)'), { status: 400 });
}

/** What waits for him to look at: a Work run that ended well whose task is in review (items: Work's list, viewed). */
const reviewOf = (items) => new Set((items || []).filter((x) => x.status === 'review').map((x) => x.id));

/**
 * THE progress: o: { units, finished (workUnits), items (Work's list, for what waits for his review), now (ms), tz,
 * since (ms: done and failed from then; default the last 24 hours; what waits for him does not depend on it) }. → { at, since, running, waiting, done, failed,
 * counts, line }. Every number in it is read from the files or worked out from them here.
 */
export function progress({ units, finished, items = [], now = Date.now(), tz = '', since = now - SINCE_MS }) {
  const review = reviewOf(items);
  const latestRun = new Map(); // a task's newest run: an older one of the same task is history, not news
  for (const u of units) if (u.type === 'run' && (!latestRun.has(u.item) || String(u.startedAt) > String(latestRun.get(u.item).startedAt))) latestRun.set(u.item, u);
  const running = [];
  const waiting = [];
  const done = [];
  const failed = [];
  for (const u of units) {
    const base = { ...u, tokensText: u.tokens === null ? 'not reported' : `${NUMBER.format(u.tokens)} tokens` };
    if (u.state === 'running') {
      const basis = basisOf(u.kind, finished);
      const eta = etaOf(basis, msOf(u.startedAt), now, tz);
      running.push({ ...base, sinceText: u.startedAt ? sinceText(msOf(u.startedAt), now, tz) : null, basis: { count: basis.count, shortestMs: basis.shortestMs, longestMs: basis.longestMs, text: basis.text }, eta });
    } else if (u.state === 'waiting') waiting.push({ ...base, why: 'answer' });
    else {
      // What waits for his look waits however long ago it ended: `since` is for the done and failed lists only.
      if (u.state === 'done' && u.type === 'run' && review.has(u.item) && latestRun.get(u.item) === u) waiting.push({ ...base, why: 'review' });
      const ended = msOf(u.endedAt);
      if (!Number.isFinite(ended) || ended < since || ended > now + 60_000) continue;
      if (u.state === 'done') done.push(base);
      else failed.push(base);
    }
  }
  const byStart = (a, b) => String(a.startedAt).localeCompare(String(b.startedAt));
  const byEnd = (a, b) => String(b.endedAt).localeCompare(String(a.endedAt));
  running.sort(byStart);
  waiting.sort((a, b) => String(a.waitsSince || a.endedAt).localeCompare(String(b.waitsSince || b.endedAt)));
  done.sort(byEnd);
  failed.sort(byEnd);
  const counts = { running: running.length, waiting: waiting.length, done: done.length, failed: failed.length };
  return { at: new Date(now).toISOString(), atText: clockText(now, tz), since: new Date(since).toISOString(), running, waiting, done, failed, counts, line: lineOf(counts) };
}

/** The one line: "2 running · 1 waits for you · 12 done · 1 failed" (what is zero is left out; nothing: "Nothing runs"). */
export function lineOf(c) {
  const parts = [];
  if (c.running) parts.push(`${c.running} running`);
  if (c.waiting) parts.push(`${c.waiting} wait${c.waiting === 1 ? 's' : ''} for you`);
  if (c.done) parts.push(`${c.done} done`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return parts.length ? parts.join(' · ') : 'Nothing runs, nothing waits for you';
}

/** "since 22:10" (today) or "since 18 Nov 22:10". */
export function sinceText(ms, now, tz = '') {
  const opts = (o) => ({ timeZone: tz || undefined, ...o });
  let day;
  let today;
  try {
    day = new Intl.DateTimeFormat('en-CA', opts({ year: 'numeric', month: '2-digit', day: '2-digit' })).format(new Date(ms));
    today = new Intl.DateTimeFormat('en-CA', opts({ year: 'numeric', month: '2-digit', day: '2-digit' })).format(new Date(now));
  } catch {
    return sinceText(ms, now, '');
  }
  const time = new Intl.DateTimeFormat('en-GB', opts({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })).format(new Date(ms));
  if (day === today) return `since ${time}`;
  return `since ${new Intl.DateTimeFormat('en-GB', opts({ day: 'numeric', month: 'short' })).format(new Date(ms))} ${time}`;
}

/** A unit's title with its project, unless the title already names it ("A session in shop"). */
const titleOf = (u) => (u.type === 'session' ? u.title : `${u.title} (${u.project})`);

/** One running unit in words: "Cart fix (shop): since 22:10, about 1 h to 2 h, from 3 like it: done by about 23:40 to 00:10". */
export function runningText(u) {
  const steps = u.steps && u.steps.agents ? `, step ${u.steps.phase || 1} of ${u.steps.phases || 1}, ${u.steps.done} of ${u.steps.agents} agents done` : '';
  const est = u.basis.count < 2 ? u.basis.text : u.eta.past ? u.eta.text : `${u.basis.text}: ${u.eta.text}`;
  return `${titleOf(u)}: ${u.sinceText || 'running'}${steps}; ${est}`;
}

/** The whole progress as lines of text (the command, Tia's tool): what runs, waits, finished and failed. */
export function progressLines(p) {
  // The time it was read, so a reader says "now" with the tool's own clock, never one of its own.
  const out = [`${p.line} (as of ${p.atText})`];
  if (p.running.length) out.push('', 'Running', ...p.running.map((u) => `  ${runningText(u)}`));
  if (p.waiting.length) out.push('', 'Waits for you', ...p.waiting.map((u) => `  ${titleOf(u)}: ${u.why === 'review' ? 'finished, look at it in Work → Tasks' : 'waits for your answer'}`));
  if (p.done.length) out.push('', 'Done', ...p.done.map((u) => `  ${titleOf(u)}: used ${u.tokensText}`));
  if (p.failed.length) out.push('', 'Failed or stopped', ...p.failed.map((u) => `  ${titleOf(u)}: ${u.state}${u.reason ? `: ${u.reason}` : ''}`));
  return out;
}
