// The route of Work's one history (history.mjs), beside Work's own (feature.mjs, which adds it):
//
//   GET  /api/work/history?project=&day=&who=&before=   what happened, newest first: { lines, more, before, projects,
//                                        days } (at most 200 lines; `before` from the answer gives the next page).
//                                        who: owner | tia | schedule (absent: everyone, also lines whose who is not known)
//
// It reads only (the session log, the App's chat lists, Work's runs, the projects' git logs through src/gitread.mjs,
// the automations' log, the Operator's timeline) and writes nothing. Every value from the browser is checked here, and
// no full path leaves the server.
import { PROJECT_RE, isYmd, todayIn } from './model.mjs';
import { runUse, useSummary } from './runuse.mjs';
import { listRuns } from './runs.mjs';
import { WHO, pageOf, readHistory } from './history.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Check the query: → { project, day, who, before } (each '' when not given); a 400 for a value that is not one. */
export function historyFilter(q) {
  const get = (k) => (q && q.get(k)) || '';
  const f = { project: get('project'), day: get('day'), who: get('who'), before: get('before') };
  if (f.project && !PROJECT_RE.test(f.project)) throw fail(400, 'that is not a project');
  if (f.day && !isYmd(f.day)) throw fail(400, 'a day is YYYY-MM-DD');
  if (f.who === 'everyone') f.who = '';
  if (f.who && !WHO.includes(f.who)) throw fail(400, `who: one of everyone, ${WHO.join(', ')}`);
  if (f.before && (!ISO_RE.test(f.before) || !Number.isFinite(Date.parse(f.before)))) throw fail(400, 'before is a time as the last answer gave it');
  return f;
}

/**
 * o: { ownerOnly(req), cfg(), places() ({ projects }), place() (Work's place), runs (doit.mjs workRuns, or null: then
 * the run files are read as they are), read (a stand-in of readHistory, for tests) }.
 */
export function historyRoutes({ ownerOnly, cfg = () => ({}), places = () => ({}), place = () => null, runs = null, read = readHistory, now = () => Date.now(), partsByRun = null }) {
  const listed = () => (runs ? runs.list() : listRuns(place()).filter((r) => r.by !== 'look'));
  // Today's and the last 7 days' use of Work's runs (runuse.mjs), at the top of Activity: from the runs' records and their
  // "Who did what" cards only. null when Work has no place to read.
  const usedLately = async () => {
    let p;
    try {
      p = place();
    } catch {
      return null;
    }
    if (!p) return null;
    const today = todayIn(p.settings && p.settings.timeZone, new Date(now()));
    const parts = partsByRun ? await partsByRun().catch(() => new Map()) : new Map();
    const tz = p.settings && p.settings.timeZone;
    return useSummary(listed().map((r) => ({ day: r.day || todayIn(tz, new Date(r.startedAt)), use: runUse(r, parts.get(r.id) || null, r.billing || null) })), { today });
  };
  return [
    ['GET', /^\/api\/work\/history$/, async (req, m, q) => {
      ownerOnly(req);
      const f = historyFilter(q);
      const all = await read({ cfg: cfg(), ...(places().projects ? { projects: places().projects } : {}), runs: listed, place, now: now() });
      return { ...pageOf(all, f), use: await usedLately() };
    }],
  ];
}
