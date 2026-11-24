// A project's own words for going live (docs/GO-LIVE.md): the "check" and "live" blocks of its project.json. They
// are someone else's words until the owner confirms them (allow.mjs): this module only reads and checks their shape.
//
//   "check": [{ "run": ["npm", "test"], "minutes": 10 }]
//   "live": { "update": [...], "verify": [...], "back": [...], "keep": ["data", "~/.config/shop"],
//             "restarts": "hoprig", "waitSeconds": 120, "turnSeconds": 300, "github": true }
//
// A command is an ARRAY of words, run without a shell (a string is refused): either the array itself or
// { "run": [...], "minutes": N }. A verify entry may also be { "url": "http://...", "status": 200, "seconds": 30 }. In
// a live command's words {commit}, {branch}, {tree} and {before} are replaced (resolve below). A keep path is inside
// the project ("data") or in the home folder ("~/.config/shop"), never ".." or another absolute path.
import fs from 'node:fs';
import path from 'node:path';

export const MANIFEST = 'project.json';
const FILE_MAX = 256 * 1024;
const WORDS_MAX = 64;
const WORD_MAX = 2000;
const COMMANDS_MAX = 20;
const KEEP_MAX = 20;
export const CHECK_MINUTES = { dflt: 10, max: 240 };
export const LIVE_MINUTES = { dflt: 5, max: 60 };
export const WAIT_SECONDS = { dflt: 120, min: 5, max: 1800 };
export const TURN_SECONDS = { dflt: 300, min: 0, max: 3600 };
export const PLACEHOLDERS = ['{commit}', '{branch}', '{tree}', '{before}'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function words(v, where, errors) {
  if (typeof v === 'string') return errors.push(`${where} is one string: write it as a list of words, ["npm", "test"] (it runs without a shell)`), null;
  if (!Array.isArray(v) || !v.length || v.length > WORDS_MAX) return errors.push(`${where} must be a list of 1 to ${WORDS_MAX} words`), null;
  if (v.some((w) => typeof w !== 'string' || !w.length || w.length > WORD_MAX || /[\0\r\n]/.test(w))) return errors.push(`${where}: every word is text of one line`), null;
  return [...v];
}

function command(v, where, limits, errors) {
  if (isObj(v)) {
    for (const k of Object.keys(v)) if (!['run', 'minutes'].includes(k)) return errors.push(`${where}: "${String(k).slice(0, 30)}" is not something a command takes`), null;
    const run = words(v.run, `${where}.run`, errors);
    if (!run) return null;
    let minutes = limits.dflt;
    if (v.minutes !== undefined) {
      if (!Number.isInteger(v.minutes) || v.minutes < 1 || v.minutes > limits.max) return errors.push(`${where}.minutes is a whole number from 1 to ${limits.max}`), null;
      minutes = v.minutes;
    }
    return { run, minutes };
  }
  const run = words(v, where, errors);
  return run ? { run, minutes: limits.dflt } : null;
}

function commands(v, where, limits, errors, { verify = false } = {}) {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > COMMANDS_MAX) return errors.push(`${where} must be a list of at most ${COMMANDS_MAX} commands`), [];
  const out = [];
  v.forEach((c, i) => {
    if (verify && isObj(c) && 'url' in c) {
      const u = urlCheck(c, `${where}[${i}]`, errors);
      if (u) out.push(u);
      return;
    }
    const x = command(c, `${where}[${i}]`, limits, errors);
    if (x) out.push(x);
  });
  return out;
}

function urlCheck(c, where, errors) {
  for (const k of Object.keys(c)) if (!['url', 'status', 'seconds'].includes(k)) return errors.push(`${where}: "${String(k).slice(0, 30)}" is not something an address check takes`), null;
  let u;
  try {
    u = new URL(String(c.url));
  } catch {
    return errors.push(`${where}.url is not an address`), null;
  }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return errors.push(`${where}.url must be an http or https address without a name or password in it`), null;
  const status = c.status === undefined ? 200 : c.status;
  const seconds = c.seconds === undefined ? 30 : c.seconds;
  if (!Number.isInteger(status) || status < 100 || status > 599) return errors.push(`${where}.status is an HTTP status, 100 to 599`), null;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) return errors.push(`${where}.seconds is a whole number from 1 to 600`), null;
  return { url: u.href, status, seconds };
}

/** A keep path as written, checked: "data", "data/db.json", "~/.config/shop". → the path, or null. */
export function cleanKeep(p) {
  if (typeof p !== 'string' || !p || p.length > 500 || /[\0\r\n\\]/.test(p)) return null;
  const rel = p.startsWith('~/') ? p.slice(2) : p;
  // Never the whole project folder ("." or "~/"): its picture would be the code the update changes.
  if (!rel || rel === '.' || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').some((s) => s === '..' || s === '' || s === '.')) return null;
  return p;
}

const integer = (v, where, lim, errors) => {
  if (v === undefined) return lim.dflt;
  if (!Number.isInteger(v) || v < lim.min || v > lim.max) return errors.push(`${where} is a whole number from ${lim.min} to ${lim.max}`), lim.dflt;
  return v;
};

/** The "check" block → { check: [{ run, minutes }] | null, errors }. */
export function cleanCheck(v) {
  const errors = [];
  if (v === undefined) return { check: null, errors };
  if (!Array.isArray(v) || !v.length) return { check: null, errors: ['"check" must be a list of commands'] };
  const check = commands(v, 'check', CHECK_MINUTES, errors);
  return { check: errors.length ? null : check, errors };
}

/** The "live" block → { live: { update, verify, back, keep, restarts, waitSeconds, turnSeconds } | null, errors }. */
export function cleanLive(v) {
  const errors = [];
  if (v === undefined) return { live: null, errors };
  if (!isObj(v)) return { live: null, errors: ['"live" must be an object with update, verify, back and keep'] };
  for (const k of Object.keys(v)) if (!['update', 'verify', 'back', 'keep', 'restarts', 'waitSeconds', 'turnSeconds', 'github'].includes(k)) errors.push(`live: "${String(k).slice(0, 30)}" is not something it takes`);
  const update = commands(v.update, 'live.update', LIVE_MINUTES, errors);
  if (!update.length && !errors.length) errors.push('live.update needs at least one command');
  const verify = commands(v.verify, 'live.verify', LIVE_MINUTES, errors, { verify: true });
  if (!verify.length && !errors.length) errors.push('live.verify needs at least one command or address: "live" is said only after a verify');
  const back = commands(v.back, 'live.back', LIVE_MINUTES, errors);
  if (!back.length && !errors.length) errors.push('live.back needs at least one command: a go-live that cannot be taken back is not offered');
  const keep = [];
  if (v.keep !== undefined) {
    if (!Array.isArray(v.keep) || v.keep.length > KEEP_MAX) errors.push(`live.keep must be a list of at most ${KEEP_MAX} paths`);
    else for (const p of v.keep) {
      const c = cleanKeep(p);
      if (!c) errors.push(`live.keep: "${String(p).slice(0, 60)}" is not a path inside the project or the home folder`);
      else if (!keep.includes(c)) keep.push(c);
    }
  }
  if (v.restarts !== undefined && v.restarts !== 'hoprig') errors.push('live.restarts can only be "hoprig" (the update restarts the dashboard)');
  const waitSeconds = integer(v.waitSeconds, 'live.waitSeconds', WAIT_SECONDS, errors);
  const turnSeconds = integer(v.turnSeconds, 'live.turnSeconds', TURN_SECONDS, errors);
  // GitHub's token reaches a go-live command only when the block says it needs it (a fetch from a private repository).
  // Kept in the block only when true, so a block confirmed before this field existed keeps its yes.
  if (v.github !== undefined && typeof v.github !== 'boolean') errors.push('live.github can only be true or false (whether the commands get your GitHub token)');
  if (errors.length) return { live: null, errors };
  return { live: { update, verify, back, keep, restarts: v.restarts === 'hoprig', waitSeconds, turnSeconds, ...(v.github === true ? { github: true } : {}) }, errors };
}

/**
 * The project.json at `dir` (a regular file, never through a link) → { json, errors } (json null when there is none
 * or it cannot be used).
 */
export function readManifestFile(dir) {
  const file = path.join(dir, MANIFEST);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { json: null, errors: [] };
  }
  if (!st.isFile()) return { json: null, errors: ['project.json is not a regular file (a link is not read)'] };
  if (st.size > FILE_MAX) return { json: null, errors: ['project.json is too big to read'] };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isObj(j) ? { json: j, errors: [] } : { json: null, errors: ['project.json is not a JSON object'] };
  } catch {
    return { json: null, errors: ['project.json is not valid JSON'] };
  }
}

/**
 * Where a project's blocks are read: the merged tree's own project.json when it has one (so a task branch that changed
 * it asks again), else the project folder's (a project that keeps its code under code/ and its project.json beside).
 */
export function blocksDir(real, treeDir) {
  try {
    if (treeDir && fs.lstatSync(path.join(treeDir, MANIFEST))) return treeDir;
  } catch {
    /* none in the tree */
  }
  return real;
}

/** The check block of the project.json in `dir`. */
export function readCheck(dir) {
  const m = readManifestFile(dir);
  if (!m.json) return { check: null, errors: m.errors };
  return cleanCheck(m.json.check);
}

/** The live block of the project.json in `dir`. */
export function readLive(dir) {
  const m = readManifestFile(dir);
  if (!m.json) return { live: null, errors: m.errors };
  return cleanLive(m.json.live);
}

/** The canonical form of a cleaned block (keys sorted at every level): its hash is the owner's yes (allow.mjs). */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * A live command's words with the placeholders replaced. `values`: { commit, branch, tree, before }. A placeholder
 * whose value is not known is refused (a command never runs with "{before}" left in it).
 */
export function resolveWords(run, values) {
  return run.map((w) => w.replace(/\{(commit|branch|tree|before)\}/g, (m, k) => {
    if (typeof values[k] !== 'string' || !values[k]) throw Object.assign(new Error(`the command uses ${m}, which is not known here`), { status: 409 });
    return values[k];
  }));
}

/** How a command is shown to the owner: its words, each quoted when it holds a space or a quote. */
export function showWords(run) {
  return run.map((w) => (/^[A-Za-z0-9_./:=@%+,{}~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/**
 * Whether a live block would push or publish ("by itself" cannot be turned on then): git push, gh, and
 * npm/pnpm/yarn publish, also behind a wrapper (any word of the command).
 */
export function publishes(live) {
  const all = [...(live.update || []), ...(live.verify || []), ...(live.back || [])].filter((c) => c.run);
  return all.some(({ run }) => {
    // Every word split again at spaces and quotes: `sh -c "git push"` holds a push in one word.
    const base = run.flatMap((w) => w.split(/[\s"';&|()]+/)).filter(Boolean).map((w) => path.basename(w).replace(/\.(exe|cmd)$/i, ''));
    for (let i = 0; i < base.length; i++) {
      if (base[i] === 'gh') return true;
      if (base[i] === 'git' && base.slice(i + 1).includes('push')) return true;
      if (['npm', 'pnpm', 'yarn'].includes(base[i]) && base.slice(i + 1).includes('publish')) return true;
    }
    return false;
  });
}

/**
 * The "back" of a step's record (its confirmed live block and the values of that step), as it will run: the words with
 * the values put in, and the time limits. [] when the record has none that can be shown.
 */
export function backShown(rec) {
  try {
    return rec.live.back.map((c) => `${showWords(resolveWords(c.run, rec.values || {}))}  (up to ${c.minutes} min)`);
  } catch {
    return [];
  }
}
