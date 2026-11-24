// What each command's own result says, as a field report (report.mjs). Only the product's own result words, check ids
// and exit codes are read here: never a message, a path or a project's name (those stay in the command's output).
// A dry run or a check changes nothing and makes no report. Every function is safe to call: it never throws.
import fs from 'node:fs';
import path from 'node:path';
import { listReports, makeReport, reportsDir } from './report.mjs';
import { CLASSES } from './shape.mjs';
import './copy.mjs'; // "also write each report into this folder": for the commands too, not only the dashboard

// A command that ended well right after the same kind of work failed (within the hour) is where a session has just
// got round something: then, and only then, one line at its end names the command that keeps the way round
// (wayround.mjs). On stderr, so a command's --json output stays one JSON object. Never when nothing failed before, and
// once per failure: the line is printed only when the report just before this one, of the same kind, failed.
export const HINT_WITHIN_MS = 60 * 60_000;
export const HINT = 'Hoprig: this worked after the same kind of work failed a moment ago. If you got round something, keep the way round for this computer: hoprig field way-round --failed "<what failed>" --worked "<what worked>"';
let hintWrite = (line) => process.stderr.write(`${line}\n`);
/** Tests: where the line goes. → the one before. */
export const setHintWriter = (fn) => {
  const was = hintWrite;
  hintWrite = fn;
  return was;
};

// This computer's reports with the time each file was written (to a fraction of a millisecond): a report's own time
// is to the second, and a failed command and its next try can fall in the same second.
function written() {
  const dir = reportsDir();
  return listReports(dir).reports.map((x) => {
    let at = 0;
    try {
      at = fs.statSync(path.join(dir, x.name)).mtimeMs;
    } catch {
      at = 0;
    }
    return { report: x.report, at };
  });
}

/**
 * Whether report `r` is a success right after a failure of the same kind: the report of that kind written just
 * before it failed, at most an hour before (by the reports' own times). So the line comes once per failure.
 */
export function followsFailure(r, { reports = written() } = {}) {
  if (!r || r.outcome !== 'ok') return false;
  const own = reports.find((x) => x.report.id === r.id);
  const at = own ? own.at : Infinity;
  const prev = reports.filter((x) => x.report.kind === r.kind && x.report.id !== r.id && x.at <= at).sort((x, y) => y.at - x.at)[0];
  if (!prev || prev.report.outcome !== 'failed') return false;
  const gap = Date.parse(r.time) - Date.parse(prev.report.time);
  return gap >= 0 && gap <= HINT_WITHIN_MS;
}

const afterWork = (r) => {
  try {
    if (followsFailure(r)) hintWrite(HINT);
  } catch {
    /* the line is a help, never a failure of the work */
  }
  return r;
};

const safe = (fn) => {
  try {
    return afterWork(fn());
  } catch {
    return null;
  }
};

// hoprig get: each project's `result` → how its step ended, and the class of the first that did not end well.
const GET_CLASS = { busy: 'refused', taken: 'folder-in-the-way', refused: 'refused', misnamed: 'refused', failed: 'program-failed' };
const GET_END = { cloned: 'ok', here: 'ok', skipped: 'skipped' };

// A result may name its class itself (`fieldClass`, from the product's own failure point: a sign-in that is missing);
// only a class of the list counts.
const getClass = (r) => (typeof r.fieldClass === 'string' && CLASSES.includes(r.fieldClass) && r.fieldClass !== 'none' ? r.fieldClass : GET_CLASS[r.result] || 'other');

/** results: getMain's [{ result, ok, fieldClass? }]. */
export const reportGet = (results, startedAt) => safe(() => {
  const steps = results.map((r) => ({ id: r.ok || r.fieldClass !== 'signin-needed' ? 'clone' : 'signin', end: r.ok ? GET_END[r.result] || 'ok' : 'failed' }));
  const bad = results.find((r) => !r.ok);
  return makeReport({ kind: 'get', steps, error: bad ? getClass(bad) : null, startedAt });
});

// hoprig drop: the owner stopping it at a question is a step-in. A refusal is classed by the result's own fields: a
// project it could not find (no workspace map, a name the map does not have) has no `ref`; commits that exist only
// here left pushes or a question about the default branch (also when there was no terminal to ask in: a session's
// drop always runs without one); files not committed left a question about the work; anything else is "refused".
const DROP_CLASS = { stopped: 'stopped', failed: 'program-failed', busy: 'refused', 'not here': 'not-found', 'left over': 'folder-in-the-way' };
const asked = (r, kind) => Array.isArray(r.asks) && r.asks.some((a) => a && a.ask === kind);
const onlyHere = (r) => (Array.isArray(r.pushes) && r.pushes.length > 0) || r.secondCheck === true || asked(r, 'default branch');
function dropClass(r) {
  if (r.result !== 'refused') return DROP_CLASS[r.result] || 'other';
  if (!r.ref) return 'not-found';
  if (onlyHere(r)) return 'git-not-pushed';
  return r.noTerminal && asked(r, 'work') ? 'git-not-clean' : 'refused';
}

/** results: dropProject's [{ result, ok, ref, pushes, asks, noTerminal, secondCheck }]. */
export const reportDrop = (results, startedAt) => safe(() => {
  const steps = results.map((r) => ({
    id: !r.ok && r.result === 'refused' && r.ref && onlyHere(r) ? 'push' : !r.ok && !r.ref ? 'find' : 'remove',
    end: r.ok ? 'ok' : r.result === 'stopped' ? 'by-hand' : 'failed',
    stepIns: Array.isArray(r.asks) ? r.asks.length : 0,
  }));
  const bad = results.find((r) => !r.ok);
  return makeReport({ kind: 'drop', steps, error: bad ? dropClass(bad) : null, startedAt });
});

// hoprig adopt apply and retire (kind "adopt"): only the product's own line kinds and refusal codes are read, never
// a line's words, a path or a project's name. A dry run makes no report.
const ADOPT_CLASS = {
  ECHANGED: 'refused', EBUSY: 'refused', ERUNNING: 'refused', EPLAN: 'config-broken', ENOIDENTITY: 'not-set-up',
  EEXISTS: 'folder-in-the-way', ESTOPPED: 'folder-in-the-way', ECOMMIT: 'program-failed', ENOTDONE: 'not-found',
};
const PROOF = new Set(['HEAD', 'refs', 'status', 'diff', 'stash', 'remote', 'worktrees', 'files', 'worktree files', 'objects', 'fsck']);
const ADOPT_STEP = { copy: 'copy', commit: 'commit', memory: 'memory', sessions: 'sessions', skill: 'skill' };

/** apply: its { ok, lines } or the refusal it threw ({ code }). */
export const reportAdopt = (result, startedAt) => safe(() => {
  if (result && result.dryRun) return null;
  if (!result || !Array.isArray(result.lines)) {
    const code = result && typeof result.code === 'string' ? result.code : '';
    return makeReport({ kind: 'adopt', steps: [{ id: 'check', end: 'failed' }], error: ADOPT_CLASS[code] || 'other', startedAt });
  }
  const steps = [];
  const add = (id, ok) => {
    const s = steps.find((x) => x.id === id);
    if (!s) steps.push({ id, end: ok ? 'ok' : 'failed' });
    else if (!ok) s.end = 'failed';
  };
  for (const l of result.lines) {
    if (!l || typeof l.what !== 'string' || l.warn) continue;
    if (PROOF.has(l.what)) add('proof', l.ok === true);
    else if (ADOPT_STEP[l.what]) add(ADOPT_STEP[l.what], l.ok === true);
  }
  if (!steps.some((x) => x.id === 'copy')) steps.unshift({ id: 'copy', end: steps.length ? 'ok' : 'failed' });
  return makeReport({ kind: 'adopt', steps, error: result.ok ? null : 'program-failed', startedAt });
});

/** retire: its { ok, refused, counts } (counts: its own check found what the copy lacks), or a refusal it threw. */
export const reportRetire = (result, startedAt) => safe(() => {
  const r = result && typeof result === 'object' ? result : {};
  if (r.ok) return makeReport({ kind: 'adopt', steps: [{ id: 'check', end: 'ok' }, { id: 'remove', end: 'ok' }], error: null, startedAt });
  if (r.counts) return makeReport({ kind: 'adopt', steps: [{ id: 'check', end: 'failed' }], error: 'refused', startedAt });
  const code = typeof r.code === 'string' ? r.code : '';
  const stopped = !r.refused && !code;
  return makeReport({ kind: 'adopt', steps: [{ id: 'remove', end: stopped ? 'by-hand' : 'failed' }], error: r.refused ? 'refused' : ADOPT_CLASS[code] || (stopped ? 'stopped' : 'other'), startedAt });
});

// hoprig doctor: a check that failed → its class. Only a run with a cross (✗) makes a report. Every check that can
// end with a cross has one here (test/field/wire.test.mjs walks the doctor's sources for them).
const CHECK_CLASS = {
  node: 'node-too-old', pty: 'terminal-module', terminal: 'missing-program', claude: 'missing-program', login: 'signin-needed',
  service: 'service-failed', port: 'port-in-use', config: 'config-broken', 'dir-config': 'permission', 'dir-profiles': 'permission',
  'dir-state': 'permission', git: 'missing-program', gh: 'missing-program', github: 'signin-needed', signin: 'signin-needed',
  password: 'not-set-up', disk: 'disk-full', map: 'config-broken', access: 'open-to-network',
};
// A check's id → its step: "kit:node" counts as its kit, "disk-0" (one line per disk) as "disk", and the workspace's
// own checks as the step of the same thing ("workspace-map" → "map", "workspace-brain" → "brain").
const checkId = (id) => String(id || '').split(':')[0].replace(/^disk-\d+$/, 'disk').replace(/^workspace-(map|brain)$/, '$1');

/** results: overview()'s checks [{ id, status }]. */
export const reportDoctor = (results, startedAt) => safe(() => {
  const fails = results.filter((c) => c.status === 'fail');
  if (!fails.length) return null;
  const steps = [...fails, ...results.filter((c) => c.status !== 'fail')].map((c) => ({ id: checkId(c.id), end: c.status === 'fail' ? 'failed' : 'ok' }));
  return makeReport({ kind: 'doctor', steps, error: CHECK_CLASS[checkId(fails[0].id)] || 'other', startedAt });
});

/** hoprig pc setup (kind "pc-setup", or "kit" with --kits): runSteps' [{ step: { kit }, ok, skipped }]. */
export const reportPcSetup = (kind, results, code, startedAt) => safe(() => {
  const steps = results.map((r) => ({ id: (r.step && r.step.kit) || 'install', end: r.skipped ? 'skipped' : r.ok ? 'ok' : 'failed' }));
  const failed = code !== 0 || results.some((r) => !r.ok && !r.skipped);
  return makeReport({ kind, steps, error: failed ? 'install-failed' : null, startedAt });
});

/** A command known only by its exit code (hoprig setup; hoprig update as "go-live"). */
export const reportByCode = (kind, code, startedAt, cls = 'other') => safe(() =>
  makeReport({ kind, steps: [], error: code === 0 ? null : cls, startedAt }));

/**
 * hoprig setup: the summary set-up filled (setup.mjs summarize: { server, steps, error }). A set-up on a server is the
 * kind "server-setup": its troubles (a dashboard open to the internet, a service an ssh session cannot reach) are not
 * a desktop's, and the inbox keeps them apart.
 */
export const reportSetup = (summary, code, startedAt) => safe(() => {
  const s = summary && typeof summary === 'object' ? summary : {};
  return makeReport({ kind: s.server === true ? 'server-setup' : 'setup', steps: Array.isArray(s.steps) ? s.steps : [], error: code === 0 ? null : s.error || 'other', startedAt });
});

/**
 * hoprig service install after an update ("go-live"): only when the dashboard it restarts ran another version (or one
 * too old to say). before/after: what the running dashboard said of itself ({ version, earlier, pid }) before and after
 * the restart; mine: this version. Steps: the restart, and whether the new version answers.
 */
export const reportRestart = ({ before, code, after, mine, startedAt }) => safe(() => {
  if (!before || !(before.earlier || (before.version && before.version !== mine))) return null;
  const healthy = code === 0 && !!after && after.version === mine;
  const steps = [{ id: 'restart', end: code === 0 ? 'ok' : 'failed' }, { id: 'health', end: healthy ? 'ok' : code === 0 ? 'failed' : 'skipped' }];
  const cls = healthy ? null : code !== 0 ? 'service-failed' : after && after.pid && after.pid === before.pid ? 'port-in-use' : 'service-failed';
  return makeReport({ kind: 'go-live', steps, error: cls, startedAt });
});
