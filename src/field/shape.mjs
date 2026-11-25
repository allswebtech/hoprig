// The shape of a field report (docs/FIELD-REPORTS.md): every field, and every value a field may hold, is in this file.
// A report is made only of values from the closed lists below, whole numbers, a time and the product's own version,
// so nothing private can be in one by construction: a value that is not in its list becomes "other" (or is dropped),
// whatever it held. The same lists read a report back (`strictReport`): a file that is not exactly what the maker
// writes is refused, so a report edited by hand is never shown, joined or sent.

/** What was asked: the command, by its kind. */
export const KINDS = Object.freeze(['setup', 'server-setup', 'pc-setup', 'kit', 'get', 'adopt', 'drop', 'go-live', 'start', 'doctor']);

/** How a step ended. "by-hand": a person or a session had to do it. */
export const ENDS = Object.freeze(['ok', 'failed', 'skipped', 'by-hand']);

export const OUTCOMES = Object.freeze(['ok', 'failed']);

/**
 * The error's class: a closed list, found from error codes and the product's own failure points, never from the text
 * of a message. "none" for a run that went well, "other" when nothing fits.
 */
export const CLASSES = Object.freeze([
  'none', 'network', 'timeout', 'not-found', 'permission', 'disk-full', 'port-in-use', 'missing-program',
  'program-failed', 'install-failed', 'build-tools', 'node-too-old', 'terminal-module', 'signin-needed',
  'git-auth', 'git-conflict', 'git-not-clean', 'git-not-pushed', 'folder-in-the-way', 'config-broken', 'not-set-up',
  'service-failed', 'usage-limit', 'stopped', 'refused', 'open-to-network', 'other',
]);

/**
 * The product's own step ids: the doctor's checks, the setup's steps, the kits and their tools, the steps of get,
 * drop, an update and a start. An id of the form "<prefix>:<name>" (skill:x, kit:node) counts as its prefix; any id
 * not in the list becomes "other".
 */
export const STEPS = Object.freeze([
  // doctor and setup
  'node', 'app', 'config', 'dir-config', 'dir-profiles', 'dir-state', 'command', 'claude', 'login', 'profile',
  'profiles', 'terminal', 'pty', 'password', 'https', 'access', 'service', 'port', 'rules', 'summary', 'pc', 'git',
  'workspace', 'project', 'skills', 'skills-updates', 'skill', 'skill-update', 'disk',
  // kits and the tools in them
  'kit', 'basics', 'python', 'github', 'extras', 'docker', 'php', 'fvm', 'flutter', 'curl', 'unzip', 'build', 'tmux', 'gh',
  'ripgrep', 'jq', 'npm', 'pip', 'venv', 'composer', 'mariadb', 'identity', 'signin', 'projects', 'tools',
  // get, adopt and drop
  'find', 'clone', 'env', 'hooks', 'memory', 'install', 'setup', 'check', 'commit', 'push', 'remove', 'map', 'brain',
  // adopt's own: the plan, the copy, its proof against the original, the coding tool's sessions
  'plan', 'copy', 'proof', 'sessions',
  // go-live (an update and the service's restart) and a start
  'download', 'restart', 'health', 'tool', 'provider', 'folder', 'launch',
  'other',
]);

export const OSES = Object.freeze(['linux', 'darwin', 'win32', 'other']);
export const ARCHES = Object.freeze(['x64', 'arm64', 'other']);

export const STEPS_MAX = 12; // a report stays under 1 KB (REPORT_MAX)
export const STEP_INS_MAX = 99;
export const SECONDS_MAX = 7 * 24 * 3600;
export const REPORT_MAX = 1024;
export const FORMAT = 1;

const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const ID_RE = /^[0-9a-f]{16}$/;
const TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

const inList = (list, v, fallback = 'other') => (typeof v === 'string' && list.includes(v) ? v : fallback);
const whole = (v, max) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);

/** A step id of the product, or "other". */
export function stepId(raw) {
  if (typeof raw !== 'string') return 'other';
  const id = raw.includes(':') ? raw.slice(0, raw.indexOf(':')) : raw;
  return inList(STEPS, id);
}

/** The product's version as "major.minor.patch", or "other". */
export const versionOf = (v) => (typeof v === 'string' && VERSION_RE.test(v) ? v : 'other');

/** The system's kind from closed values: os, arch, Node major (0 when it is not a plain number). */
export function systemOf(s = {}) {
  // Only a plain version ("22", "22.11.0", "v22.11.0") or a whole number: any other text is no version at all.
  const major = typeof s.node === 'string' ? (/^v?\d{1,3}(\.\d{1,4}){0,2}$/.test(s.node) ? Number(s.node.replace(/^v/, '').split('.')[0]) : 0) : s.node;
  return { os: inList(OSES, s.os), arch: inList(ARCHES, s.arch), node: Number.isInteger(major) && major > 0 && major < 1000 ? major : 0 };
}

// Error codes of Node and of the programs the product runs → a class. Only the code is looked at, never a message.
const CODES = {
  ENOTFOUND: 'network', EAI_AGAIN: 'network', ECONNREFUSED: 'network', ECONNRESET: 'network', ENETUNREACH: 'network',
  EHOSTUNREACH: 'network', EPIPE: 'network', CERT_HAS_EXPIRED: 'network', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'network',
  ETIMEDOUT: 'timeout', ESOCKETTIMEDOUT: 'timeout', ABORT_ERR: 'stopped',
  ENOENT: 'not-found', ENOTDIR: 'not-found', EACCES: 'permission', EPERM: 'permission', EROFS: 'permission',
  ENOSPC: 'disk-full', EDQUOT: 'disk-full', EADDRINUSE: 'port-in-use', EEXIST: 'folder-in-the-way', ENOTEMPTY: 'folder-in-the-way',
};
// The product's own failure points (an error's details.code, as the routes use it) → a class.
const DETAILS = {
  'not-found': 'not-found', unwritable: 'permission', unreadable: 'permission', busy: 'refused', broken: 'config-broken',
  limits: 'usage-limit', 'day-limit': 'usage-limit', offline: 'network', moved: 'folder-in-the-way', untidy: 'git-not-clean',
  hidden: 'refused', doubled: 'refused', address: 'refused', private: 'refused', token: 'signin-needed',
};

/**
 * The class of an error: its `fieldClass` when the product named one from the list, else its code, else its details'
 * code, else (for a program that ran and failed) "program-failed", else "other". A missing error is "none".
 */
export function classOf(error) {
  if (error === null || error === undefined) return 'none';
  if (typeof error === 'string') return inList(CLASSES, error);
  if (typeof error !== 'object') return 'other';
  if (typeof error.fieldClass === 'string' && CLASSES.includes(error.fieldClass)) return error.fieldClass;
  if (typeof error.code === 'string' && Object.hasOwn(CODES, error.code)) return CODES[error.code];
  const d = error.details && typeof error.details === 'object' ? error.details.code : null;
  if (typeof d === 'string' && Object.hasOwn(DETAILS, d)) return DETAILS[d];
  if (typeof error.status === 'number' && typeof error.code !== 'string') return 'program-failed';
  return 'other';
}

/** One step of a report: { id, end, stepIns }. */
const stepOf = (s) => ({ id: stepId(s && s.id), end: inList(ENDS, s && s.end, 'failed'), stepIns: whole(s && s.stepIns, STEP_INS_MAX) });

/**
 * The steps a report keeps: at most STEPS_MAX, the ones that did not end well first, in their own order.
 * → { steps, left } (left: how many were left out).
 */
export function keptSteps(list) {
  const all = (Array.isArray(list) ? list : []).map(stepOf);
  if (all.length <= STEPS_MAX) return { steps: all, left: 0 };
  const order = all.map((s, i) => ({ s, i }));
  const first = order.filter((x) => x.s.end !== 'ok' && x.s.end !== 'skipped');
  const rest = order.filter((x) => x.s.end === 'ok' || x.s.end === 'skipped');
  const keep = [...first, ...rest].slice(0, STEPS_MAX).sort((a, b) => a.i - b.i).map((x) => x.s);
  return { steps: keep, left: all.length - keep.length };
}

/** The fields of a report, in the order they are written. */
export const FIELDS = Object.freeze(['format', 'id', 'time', 'kind', 'outcome', 'class', 'version', 'system', 'seconds', 'steps', 'stepsLeftOut']);
export const SYSTEM_FIELDS = Object.freeze(['os', 'arch', 'node']);
export const STEP_FIELDS = Object.freeze(['id', 'end', 'stepIns']);

/** The text of a report: the one way a report is written, byte for byte (a person reads it; a step is one line). */
export function reportText(r) {
  const line = (f) => {
    if (f === 'steps') return `  "steps": [${r.steps.map((s) => `\n    ${JSON.stringify({ id: s.id, end: s.end, stepIns: s.stepIns })}`).join(',')}${r.steps.length ? '\n  ' : ''}]`;
    const v = f === 'system' ? { os: r.system.os, arch: r.system.arch, node: r.system.node } : r[f];
    return `  ${JSON.stringify(f)}: ${JSON.stringify(v)}`;
  };
  return `{\n${FIELDS.map(line).join(',\n')}\n}\n`;
}

const exactKeys = (o, keys) => o && typeof o === 'object' && !Array.isArray(o) && Object.getPrototypeOf(o) === Object.prototype
  && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));

/**
 * A report read back, held to the same lists: the report, or null for anything that is not exactly what the maker
 * writes (another field, a value off its list, a doubled key, other spaces, more than REPORT_MAX bytes).
 */
export function strictReport(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > REPORT_MAX) return null;
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!exactKeys(r, FIELDS) || !exactKeys(r.system, SYSTEM_FIELDS) || !Array.isArray(r.steps)) return null;
  // Text fields are text: String() of a number or a one-item array would pass a pattern made for text.
  const ok = r.format === FORMAT && typeof r.id === 'string' && ID_RE.test(r.id) && typeof r.time === 'string' && TIME_RE.test(r.time) && !Number.isNaN(Date.parse(r.time))
    && KINDS.includes(r.kind) && OUTCOMES.includes(r.outcome) && CLASSES.includes(r.class) && versionOf(r.version) === r.version
    && OSES.includes(r.system.os) && ARCHES.includes(r.system.arch) && systemOf({ node: r.system.node }).node === r.system.node
    && whole(r.seconds, SECONDS_MAX) === r.seconds && r.steps.length <= STEPS_MAX && whole(r.stepsLeftOut, 1000) === r.stepsLeftOut
    && r.steps.every((s) => exactKeys(s, STEP_FIELDS) && STEPS.includes(s.id) && ENDS.includes(s.end) && whole(s.stepIns, STEP_INS_MAX) === s.stepIns);
  if (!ok) return null;
  // Byte for byte what the maker writes: a doubled key, a "__proto__" or a changed space is refused here.
  return reportText(r) === text ? r : null;
}
