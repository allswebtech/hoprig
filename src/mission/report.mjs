// What the missions' files say, in numbers and a few lines: a mission's report, the Team tab (per role) and the
// morning brief on Today. Made by code from the files alone, with no model call. Pure.
//
// The three numbers of a task: its tokens and minutes (the sums of its runs: the work, its reviews, its fixes) and
// whether its gate and review passed the first time. Cost: the sum of the runs' own cost lines; a run whose provider
// reported none is counted in tokens only and said so ("costUnknown").
import { ROLE_NAMES, loadRoles, runsWords } from './roles.mjs';

// The places a why names, read from its own words, as codes of the page's table of places (web/errorways.js). Worked
// out here when the report is built, never kept in the mission file: a dashboard on an older build reads the same Work
// folder and refuses a key it does not know.
const PLACES = [['Work → Plans', 'work-plans'], ['Work → Team', 'work-team']];
/** The codes of the places `x.why` names, in the table's order; none: null. */
const waysOf = (x) => {
  const why = x && typeof x.why === 'string' ? x.why : '';
  const codes = PLACES.filter(([words]) => why.includes(words)).map(([, code]) => code);
  return codes.length ? codes : null;
};

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
/** A count as a person reads it: 48,200. */
const count = (n) => Math.round(n).toLocaleString('en-US');
/** Dollars as the page writes them (web/chat/words.js money): $0.95, $0.0053, $0. */
export const usd = (n) => (n >= 0.00995 ? `$${n.toFixed(2)}` : n > 0 ? `$${n.toFixed(4)}` : '$0');
const unknownRuns = (n) => `${n} run${n === 1 ? '' : 's'} of unknown cost`;

/** A task's numbers: { tokens, minutes, cost, costUnknown, runs, firstPass }. */
export function taskNumbers(t) {
  let tokens = 0;
  let minutes = 0;
  let cost = 0;
  let costUnknown = 0;
  for (const r of t.runs) {
    tokens += r.tokens || 0;
    minutes += r.minutes || 0;
    if (r.cost === null) costUnknown += 1;
    else cost += r.cost;
  }
  // The cost to a millionth here: the sums are rounded once, at the end, so they are the sums of the runs.
  return { tokens, minutes: round(minutes, 1), cost: round(cost, 6), costUnknown, runs: t.runs.length, firstPass: t.firstPass };
}

/** The sums of tasks' numbers. */
export function sumOf(list) {
  const s = { tasks: list.length, tokens: 0, minutes: 0, cost: 0, costUnknown: 0, runs: 0, passedFirst: 0, judged: 0 };
  for (const n of list) {
    s.tokens += n.tokens;
    s.minutes += n.minutes;
    s.cost += n.cost;
    s.costUnknown += n.costUnknown;
    s.runs += n.runs;
    if (n.firstPass !== null) {
      s.judged += 1;
      if (n.firstPass) s.passedFirst += 1;
    }
  }
  s.minutes = round(s.minutes, 1);
  s.cost = round(s.cost, 4);
  return s;
}

const COUNTED = { review: 'waits', his: 'waits', done: 'done', failed: 'failed', dropped: 'dropped', stopped: 'stopped', queued: 'open', running: 'open' };

/**
 * Where a task's tests ran, as its gate keeps it: 'box' (in the box, by the gate or his press), 'here' (his own run
 * outside the box, as him), 'not-run' (no box ran them, nor he), or null (its check runs no tests).
 */
export function testsWhere(t) {
  const g = t && t.gate;
  if (!g) return null;
  if (g.boxed === true) return 'box';
  if (g.here && g.here.boxed === true) return 'box';
  if (g.here) return 'here';
  if (g.testsNotRun) return 'not-run';
  return null;
}
/**
 * How a task's tests ended, as its gate keeps it (his own later run counts over the gate's): 'box-passed',
 * 'box-failed', 'box-timeout', 'here-passed', 'here-failed', 'not-run', or null (its check runs no tests).
 */
export function testsResult(t) {
  const g = t && t.gate;
  const where = testsWhere(t);
  if (!where || where === 'not-run') return where;
  if (g.here) {
    const k = g.here.boxed === true ? 'box' : 'here';
    return g.here.ok ? `${k}-passed` : k === 'box' && g.here.timedOut ? 'box-timeout' : `${k}-failed`;
  }
  const r = g.tests && g.tests.result;
  if (r === 'timeout') return 'box-timeout';
  if (r === 'passed' || r === 'failed') return `box-${r}`;
  return g.ok ? 'box-passed' : 'box-failed'; // a gate kept before it said its result
}
// One line per result, so a phone shows short lines: "Tests passed in the box: "A", "B"."
const TESTS_LINE = [
  ['box-passed', 'Tests passed in the box'], ['box-failed', 'Tests failed in the box'], ['box-timeout', 'Tests stopped in the box, too slow'],
  ['here-passed', 'Tests you ran outside the box passed'], ['here-failed', 'Tests you ran outside the box failed'], ['not-run', 'Tests not run'],
];

/** A mission's report: its state, its tasks by where they stand, each task's numbers, the sums, and a few lines. */
export function missionReport(m) {
  const tasks = m.tasks.map((t) => ({ id: t.id, title: t.title, role: t.role, state: t.state, why: t.why, ...(waysOf(t) ? { ways: waysOf(t) } : {}), branch: t.branch, tests: testsWhere(t), testsResult: testsResult(t), ...taskNumbers(t) }));
  const total = sumOf(tasks);
  const by = { done: [], waits: [], failed: [], open: [], dropped: [], stopped: [] };
  for (const t of tasks) by[COUNTED[t.state]].push(t);
  const lines = [];
  if (by.done.length) lines.push(`Done: ${by.done.length} of ${tasks.length}.`);
  if (by.waits.length) lines.push(`Waits for you: ${by.waits.map((t) => `"${t.title}"`).join(', ')}.`);
  if (by.failed.length) lines.push(`Failed: ${by.failed.map((t) => `"${t.title}" (${t.why || 'no reason given'})`).join('; ')}.`);
  if (by.open.length) lines.push(`Still going: ${by.open.length}.`);
  // Per task whose check runs tests: where they ran and how they ended, grouped by that.
  for (const [k, words] of TESTS_LINE) {
    const of = tasks.filter((t) => t.testsResult === k);
    if (of.length) lines.push(`${words}: ${of.map((t) => `"${t.title}"`).join(', ')}.`);
  }
  // Its cost, tokens and minutes are the report's numbers (total), shown once, as numbers: not again as a line.
  // ways: the places its why names, as codes of the page's table of places (web/errorways.js).
  return { id: m.id, goal: m.goal, project: m.project, state: m.state, why: m.why, ...(m.auto ? { auto: true } : {}), ...(waysOf(m) ? { ways: waysOf(m) } : {}), createdAt: m.createdAt, endedAt: m.endedAt, tasks, total, counts: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, v.length])), lines };
}

/**
 * What the page calls a mission now (its badge): its state, but "waiting" for a mission that is running while nothing
 * of it runs (the cap, a limit, his hours: its why says which), and "paused" for one of this dashboard's that is going
 * while Tia is OFF (`mine`: this dashboard runs it; another's is not held by this one's switch).
 */
export function faceOf(m, { on, mine }) {
  if (mine && !on && ['planning', 'running', 'waits'].includes(m.state)) return 'paused';
  if (m.state === 'running' && !m.tasks.some((t) => t.state === 'running')) return 'waiting';
  return m.state;
}

/**
 * The Team tab: per role, whether it is on, how many tasks it did, how many passed the first time, its tokens, cost
 * and minutes (of the runs it did: a reviewer's runs count for the reviewer), and what it may run in plain words (its
 * role file's `runs`; `roles`: the role files, read once).
 */
export function teamView(missions, rolesOff = [], roles = loadRoles()) {
  const per = new Map(ROLE_NAMES.map((r) => [r, { role: r, on: !rolesOff.includes(r), tasks: 0, passedFirst: 0, judged: 0, tokens: 0, cost: 0, costUnknown: 0, minutes: 0, runs: 0 }]));
  for (const m of missions) for (const t of m.tasks) {
    const own = per.get(t.role);
    if (!own) continue; // his own task: no session of hers did it
    if (t.runs.some((r) => r.kind === 'review')) per.get('reviewer').tasks += 1; // the tasks it looked at
    if (t.runs.some((r) => r.kind !== 'review')) {
      own.tasks += 1;
      if (t.firstPass !== null) {
        own.judged += 1;
        if (t.firstPass) own.passedFirst += 1;
      }
    }
    for (const r of t.runs) {
      const x = r.kind === 'review' ? per.get('reviewer') : own;
      x.runs += 1;
      x.tokens += r.tokens || 0;
      x.minutes += r.minutes || 0;
      if (r.cost === null) x.costUnknown += 1;
      else x.cost += r.cost;
    }
  }
  return [...per.values()].map((x) => ({ ...x, cost: round(x.cost, 4), minutes: round(x.minutes, 1), may: runsWords((roles.get(x.role) || {}).runs || []) }));
}

/**
 * The morning brief: what was finished since `from` (a day, YYYY-MM-DD: yesterday; a task by the day of its last run),
 * what failed since `from` (a task by the day of its last run, a mission whose planning failed by the day it ended;
 * so an old failure is not listed again every morning), what waits for him now, and what the runs of `from` and later
 * cost. `shown`: whether anything happened since `from` or waits. Every number from the files.
 */
export function morningBrief(missions, { from }) {
  const finished = [];
  const waits = [];
  const failed = [];
  let cost = 0;
  let tokens = 0;
  let unknown = 0;
  const seen = new Set(); // a task in two missions' files is one task: counted once, in the newest
  for (const m of missions) {
    for (const t of m.tasks) {
      for (const r of t.runs) {
        if (r.day < from) continue;
        if (r.cost === null) unknown += 1;
        else cost += r.cost;
        tokens += r.tokens || 0;
      }
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const item = { mission: m.id, goal: m.goal, project: m.project, task: t.id, title: t.title, why: t.why };
      const last = t.runs.length ? t.runs[t.runs.length - 1].day : (m.endedAt || m.createdAt).slice(0, 10);
      if (t.state === 'done' && last >= from) finished.push(item);
      else if (t.state === 'review') waits.push({ ...item, why: 'its work and review passed: Accept or Send back in Work' });
      else if (t.state === 'his') waits.push(item);
      // Failed is counted since `from`, like finished: a task that failed weeks ago is not news every morning, and
      // does not keep the brief shown by itself. A failed task that still needs him stays 'his' (above), under waits.
      else if (t.state === 'failed' && last >= from) failed.push(item);
    }
    // A mission that failed before it had a task (its planning failed): said under Failed, with its why.
    if (m.state === 'failed' && !m.tasks.length && m.endedAt && m.endedAt.slice(0, 10) >= from) {
      failed.push({ mission: m.id, goal: m.goal, project: m.project, task: null, title: m.goal, why: m.why });
    }
  }
  const lines = [];
  lines.push(finished.length ? `Finished: ${finished.length} task${finished.length === 1 ? '' : 's'}.` : 'Nothing was finished.');
  if (waits.length) lines.push(`Waits for you: ${waits.length}.`);
  if (failed.length) lines.push(`Failed: ${failed.length}: ${failed.slice(0, 3).map((x) => `"${x.title}" (${x.why || 'no reason given'})`).join('; ')}${failed.length > 3 ? ` and ${failed.length - 3} more` : ''}.`);
  lines.push(`It cost ${usd(round(cost, 4))}${unknown ? ` and ${unknownRuns(unknown)}` : ''}, ${count(tokens)} tokens.`);
  const running = missions.filter((m) => m.state === 'running' || m.state === 'planning').length;
  const shown = !!(finished.length || waits.length || failed.length || running || tokens || cost || unknown);
  return { finished, waits, failed, cost: round(cost, 4), tokens, costUnknown: unknown, lines, shown, running: missions.filter((m) => m.state === 'running' || m.state === 'planning').length };
}
