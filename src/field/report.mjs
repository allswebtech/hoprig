// Field reports (docs/FIELD-REPORTS.md): at the end of a piece of Hoprig's own work, one small file that says what
// was asked (by its kind), how each step ended, the error's class, where a person or a session had to step in and how
// long it took. Kept in <state>/field/reports/, under 1 KB each, the newest KEEP_MAX kept. The maker takes only values
// from the closed lists of shape.mjs: whatever else it is given is dropped or becomes "other".
//
// Making a report never changes what a command does or prints: every failure here is swallowed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { FORMAT, KINDS, REPORT_MAX, SECONDS_MAX, classOf, keptSteps, reportText, strictReport, systemOf, versionOf } from './shape.mjs';

export const KEEP_MAX = 50;

// The product's version from its own package.json (not through the doctor's checks: this file stays light to load).
function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return null;
  }
}
const FILE_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]{16})\.json$/;

export const reportsDir = () => path.join(stateDir(), 'field', 'reports');

/** This computer's kind, from closed values only. */
export const thisSystem = () => systemOf({ os: process.platform, arch: process.arch, node: process.versions.node });

/**
 * The report of one piece of work, not written yet. o: { kind, steps: [{ id, end, stepIns }], error, startedAt,
 * endedAt (ms), version?, system?, id?, }. → the report (shape.mjs), or null when `kind` is not one of the list.
 */
export function buildReport(o = {}) {
  if (!o || typeof o !== 'object' || !KINDS.includes(o.kind)) return null;
  const { steps, left } = keptSteps(o.steps);
  const failedStep = steps.some((s) => s.end === 'failed');
  let cls = classOf(o.error);
  if (cls === 'none' && failedStep) cls = 'other';
  const outcome = cls === 'none' && !failedStep ? 'ok' : 'failed';
  const end = Number.isFinite(o.endedAt) ? o.endedAt : Date.now();
  const start = Number.isFinite(o.startedAt) ? o.startedAt : end;
  const at = new Date(end);
  return {
    format: FORMAT,
    id: typeof o.id === 'string' && /^[0-9a-f]{16}$/.test(o.id) ? o.id : crypto.randomBytes(8).toString('hex'),
    time: Number.isNaN(at.getTime()) ? new Date().toISOString().slice(0, 19) + 'Z' : at.toISOString().slice(0, 19) + 'Z',
    kind: o.kind,
    outcome,
    class: cls,
    version: versionOf(o.version === undefined ? appVersion() : o.version),
    system: o.system === undefined ? thisSystem() : systemOf(o.system),
    seconds: Math.min(SECONDS_MAX, Math.max(0, Math.round((end - start) / 1000))),
    steps,
    stepsLeftOut: Math.min(1000, left),
  };
}

const fileName = (r) => `${r.time.replace(/[-:]/g, '')}-${r.id}.json`;

function writeFile(dir, name, text) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${name}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, path.join(dir, name));
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** The newest KEEP_MAX report files stay; older ones go (only files of the report's own name). */
function prune(dir) {
  const names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort();
  for (const n of names.slice(0, Math.max(0, names.length - KEEP_MAX))) fs.rmSync(path.join(dir, n), { force: true });
}

/**
 * Make and keep one report (see buildReport). Also written into the owner's own folder when he set one (copy.mjs).
 * → the report, or null. Never throws.
 */
export function makeReport(o = {}) {
  try {
    const r = buildReport(o);
    if (!r) return null;
    const text = reportText(r);
    if (Buffer.byteLength(text) > REPORT_MAX || !strictReport(text)) return null;
    const dir = reportsDir();
    writeFile(dir, fileName(r), text);
    prune(dir);
    for (const after of afterMake) {
      try {
        after(r, text);
      } catch {
        /* a report's copy or notice never fails the work */
      }
    }
    return r;
  } catch {
    return null;
  }
}

// What else happens to a new report (the owner's copy folder): registered by those parts, so this file stays small.
const afterMake = [];
export const onReportMade = (fn) => {
  if (!afterMake.includes(fn)) afterMake.push(fn);
};

/**
 * This computer's reports, newest first: [{ report, text, name }]. Files that are not exactly a report (edited by
 * hand, too big, a link) are left out and counted: → { reports, notRead }.
 */
export function listReports(dir = reportsDir()) {
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n)).sort().reverse();
  } catch {
    return { reports: [], notRead: 0 };
  }
  const reports = [];
  let notRead = 0;
  for (const name of names) {
    const r = readReportFile(path.join(dir, name));
    if (r) reports.push({ ...r, name });
    else notRead++;
  }
  return { reports, notRead };
}

/** One report file, held to the shape: { report, text } or null. A link, a folder or a big file is not read. */
export function readReportFile(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > REPORT_MAX) return null;
    const text = fs.readFileSync(file, 'utf8');
    const report = strictReport(text);
    return report ? { report, text } : null;
  } catch {
    return null;
  }
}

/** One of this computer's reports by its id: { report, text, name } or null. */
export function findReport(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null;
  return listReports().reports.find((x) => x.report.id === id) || null;
}

/**
 * A recorder for one piece of work: step(id, end, { stepIns }) as it goes, then done(error) makes the report.
 * kind: one of KINDS. Each call is safe to make whatever happens; done() makes at most one report.
 */
export function fieldRun(kind, { now = Date.now } = {}) {
  const startedAt = now();
  const steps = [];
  let made = false;
  return {
    step(id, end, { stepIns = 0 } = {}) {
      steps.push({ id, end, stepIns });
    },
    done(error = null, more = {}) {
      if (made) return null;
      made = true;
      return makeReport({ kind, steps, error, startedAt, endedAt: now(), ...more });
    },
  };
}

export const REPORT_FILE_RE = FILE_RE;
