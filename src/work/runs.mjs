// The runs of Work's tasks: the record of one coding session that worked on one task ("Do it", src/work/doit.mjs).
// A run is NOT kept on the task: a task changed on two computers is one conflict for the whole task, and a run is
// written several times while its session works. Each run is a file of its own in the Work folder,
// `runs/<run id>.json`, and its id holds the date and random characters, so two computers never write one file. It
// has one writer, the dashboard that ran it (`writer`: a random id of that dashboard's state folder), and is written
// atomically, checked strictly on every write. It never holds a full path of the computer, a host name or a
// provider's key: folders are named by the project and a folder inside it, the provider by its name, and the
// session's answer is masked (src/assistant/secrets.mjs) and has the computer's own paths taken out.
//
// A run: { v: 1, id, item, title, writer, by ("owner"; later a schedule or the assistant), startedAt, endedAt,
//   project, folder (inside the project: "." or "code/web"), tool, provider, model, effort, session (the chat's id),
//   conversation, message (the first message's id), brief, state, reason, answer, commits: [{ repo, short, subject }],
//   changed: [{ repo, path, kind }], more (files changed and not listed: past the list's limit, or of a name a run
//   does not hold), was (the task's status when it started: open or waiting), statusError, branch, schedule, used }
// used: what the coding tool's own result line reported it used, { input, output, cacheRead, cacheWrite, costUsd }
// (each a whole number of tokens, costUsd a number or null), for a run that ends by itself; absent or null where the
// tool reported nothing (an older run file, a Do it run): "not reported", never 0.
// branch and schedule belong to a run that ends by itself (alone.mjs): the branch it worked on (`work/<id>`) and the
// schedule that started it (by: "schedule"), else null; a run file of an earlier version has neither (read as null).
// state: running | done | failed | limit | stopped. A run file is at most RUN_FILE_MAX: writeRun shortens the lists to
// fit (and counts what it left out in `more`).
//
// What only the writer needs, each repository's commit when the session started and the files changed and not
// committed then (what the session left is told from them), is kept apart in this dashboard's state folder
// (keepStart): never committed nor sent, and as long as a folder with many changed files makes it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../assistant/secrets.mjs';
import { stateDir } from '../paths.mjs';
import { ID_RE, PROJECT_RE } from './model.mjs';
import { writeText } from './store.mjs';

export const RUNS_FOLDER = 'runs';
export const RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{8}$/;
export const RUN_FILE_RE = /^\d{8}-\d{6}-[0-9a-f]{8}\.json$/;
export const RUN_STATES = ['running', 'done', 'failed', 'limit', 'stopped'];
const WAS = ['open', 'waiting']; // the task's status when the run started: it goes back to it when the run has no result
export const ANSWER_MAX = 4000;
export const BRIEF_MAX = 4000;
const COMMITS_MAX = 50;
const CHANGED_MAX = 200;
const LIST_MAX = 1000; // the newest run files read for a list
export const RUN_FILE_MAX = 64 * 1024; // a run file larger than this is not read (and never written: writeRun)
const KINDS = ['changed', 'added', 'deleted', 'renamed', 'new'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/; // a provider's name
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,119}$/; // a model's name: also "sonnet[1m]", as Settings allows
const SHA_RE = /^[0-9a-f]{40,64}$/;
const CONVERSATION_RE = /^[A-Za-z0-9_-]{1,200}$/;
const EFFORT_RE = /^[a-z]{1,20}$/;
const SHORT_RE = /^[0-9a-f]{4,64}$/;
const DAY_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const KEYS = ['v', 'id', 'item', 'title', 'writer', 'by', 'startedAt', 'endedAt', 'project', 'folder', 'tool', 'provider', 'model', 'effort', 'session', 'conversation', 'message', 'brief', 'state', 'reason', 'answer', 'commits', 'changed', 'more', 'was', 'statusError', 'branch', 'schedule', 'used'];
const LATER_KEYS = ['branch', 'schedule', 'used']; // not in a run file of an earlier version
export const BRANCH_RE = /^work\/[a-z0-9][a-z0-9-]{0,79}$/;
const SCHEDULE_RE = /^[a-z0-9]{4,32}$/;
const TOKENS_MAX = 1e12;
const tokOk = (n) => Number.isInteger(n) && n >= 0 && n <= TOKENS_MAX;
/** What a run used, as a run file holds it (see the top). */
const usedOk = (u) => isObj(u) && Object.keys(u).length === 5 && ['input', 'output', 'cacheRead', 'cacheWrite'].every((k) => tokOk(u[k]))
  && (u.costUsd === null || (Number.isFinite(u.costUsd) && u.costUsd >= 0 && u.costUsd < 1e6));
/** The `used` of a run from a result line's usage and cost, or null when it reported none. */
export function usedOf(usage, cost) {
  if (!isObj(usage)) return null;
  // A usage with none of the four token counts reported nothing: "not reported", never a reported 0.
  if (![usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens].some((v) => Number.isFinite(v) && v >= 0)) return null;
  const n = (v) => (Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), TOKENS_MAX) : 0);
  const u = { input: n(usage.input_tokens), output: n(usage.output_tokens), cacheRead: n(usage.cache_read_input_tokens), cacheWrite: n(usage.cache_creation_input_tokens), costUsd: Number.isFinite(cost) && cost >= 0 && cost < 1e6 ? cost : null };
  return u;
}
/** All tokens of a `used`, or null when not reported. */
export const tokensOf = (u) => (usedOk(u) ? u.input + u.output + u.cacheRead + u.cacheWrite : null);

// (refused: the record's content was refused, not its file: doit.mjs settle writes a leaner one then.)
const bad = (message) => Object.assign(new Error(`a run record ${message}`), { status: 500, refused: true });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A new run's id: the time (UTC) and eight random hex digits, so it sorts by time and two computers never share one. */
export function newRunId(now = new Date()) {
  const s = now.toISOString().replace(/[-:]/g, '');
  return `${s.slice(0, 8)}-${s.slice(9, 15)}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * This dashboard's writer id: random, made once and kept in its state folder (never a host or user name). `make`
 * false: only read it (null when it is not made yet), for what writes nothing (a dry run, a list).
 */
export function writerId({ make = true } = {}) {
  const file = path.join(stateDir(), 'work-writer');
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{16}$/.test(v)) return v;
  } catch {
    /* made below */
  }
  if (!make) return null;
  const id = crypto.randomBytes(8).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
}

/**
 * What the chat says of a session, as a run may hold it: { session, conversation, message, model, effort }, each null
 * where the run's check would refuse it (a coding tool's own model name, say, in words a run does not take). A value
 * from outside never stops a run from being written.
 */
export function chatFacts({ id, messageId, conversationId, model, effort } = {}) {
  const ok = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
  return { session: ok(id, UUID_RE), conversation: ok(conversationId, CONVERSATION_RE), message: ok(messageId, UUID_RE), model: ok(model, MODEL_RE), effort: ok(effort, EFFORT_RE) };
}

/** A folder inside a project, as a run and a route name it: "." or a plain relative path ("code/web"). */
export function cleanFolder(v) {
  if (v === '.' ) return '.';
  if (typeof v !== 'string' || !v || v.length > 200) return null;
  const parts = v.split('/');
  if (parts.length > 4 || parts.some((s) => !/^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(s) || s === '..' || s === '.')) return null;
  return v;
}

// ---------- what may stand in a run ----------

// Characters that are not text (a line break and a tab are text in an answer, a brief or a reason). A control
// character goes without a trace, also one that moves the cursor (a vertical tab, a form feed, a next line): a key a
// NUL, a bell or a form feed splits is whole again before it is masked. The line and paragraph separators, which are
// no control characters, become a space.
const SPACING = /[\u2028\u2029]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const IN_WORD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/; // what CONTROL takes out (a carriage return is a line break)
// A terminal's escape sequences: a CSI (ESC [ or its 8-bit form: colours), a string (ESC ] P X ^ _ or their 8-bit
// forms: a link, a title) up to its end (BEL or ST), and any other ESC sequence (a charset choice "ESC ( B", "ESC 7").
const ESCAPES = /(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|\x1b[ -/]*[0-~]/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `p` where it stands as a path of its own (not the start of a longer name: "/home/al" in "/home/alex"). */
const pathRe = (p) => new RegExp(`${escapeRe(p)}${p.endsWith('/') ? '' : '(?=$|[\\s/\\\\"\'`),.:;!?\\]>\uFDD0])'}`, 'g');
// What stands for a control character or an escape sequence while the paths and the name are taken out: the edge of
// a word there ("/home/alex<BEL>foo" is the home folder, then "foo"). It goes before the secrets are masked, so a key
// that one splits is whole again. (A noncharacter: no text holds it; one that comes in goes first.)
const EDGE = '\uFDD0';

/**
 * Text from a session for a run: escape sequences and control characters out, the computer's own paths taken out
 * (`paths`: [[full path, what stands for it]], longest first) and its name (HOST_WORD stands for it), secrets masked,
 * cut at `max` characters. The order matters: a key split by an escape sequence, or joined when a path between its
 * pieces goes, is whole when it is masked; and the text is cut to a few times `max` first, because masking a very long
 * run of letters overflows.
 *
 * What this is for, and where it stops: a run file goes into the owner's own repository, and this keeps a key, a full
 * path of his computer or its name from getting there BY ACCIDENT, in what a session printed or said. It is a net over
 * free text, not a wall against text written to get through it: a key split by a character nobody sees (a zero-width
 * space, a byte-order mark, a soft hyphen) is stored as two halves, and no more such cases are added here.
 */
export function cleanText(s, max, paths = []) {
  const all = String(s ?? '');
  let t = all.slice(0, max * 4);
  // Where that cut fell inside a word, the whole word goes too: it may be the start of a key, too short to be masked
  // once it is cut, and still within `max` when masking has shortened what stands before it. A control character
  // goes without a trace (below), so it is part of a word here, at the cut and before it.
  if (all.length > max * 4) {
    let j = max * 4;
    while (j < all.length && IN_WORD.test(all[j])) j += 1;
    if (j < all.length && /\S/.test(all[j])) {
      let i = t.length;
      while (i > 0 && (/\S/.test(t[i - 1]) || IN_WORD.test(t[i - 1]))) i -= 1;
      t = t.slice(0, i);
    }
  }
  t = t.replaceAll(EDGE, '').replace(ESCAPES, EDGE).replace(/\r\n?/g, '\n').replace(SPACING, ' ').replace(CONTROL, EDGE);
  const own = (x) => {
    for (const [full, short] of paths) if (full && full.length > 1) x = x.replace(pathRe(full), short);
    return maskHost(x);
  };
  // Once with the edges, then on the joined text: a path or a name that a control character split is whole there.
  t = own(own(t).replaceAll(EDGE, ''));
  t = redact(t);
  if (t.length <= max) return t;
  // The last cut may leave the start of a word that reads as this computer's name or a key once the ellipsis ends it
  // ("box2…", "AKIA…"): then that word goes too, so the words stay as they are when they are masked again (Save takes
  // a run file only then: isRunFile).
  const head = t.slice(0, max - 1);
  if (redact(maskHost(`${head}…`)) === `${head}…`) return `${head}…`;
  let i = head.length;
  while (i > 0 && !/\s/.test(head[i - 1])) i -= 1;
  return `${head.slice(0, i)}…`;
}

/** What stands for this computer's name in a session's words ("alex@box2:~/x" → "alex@this-computer:~/x"). */
export const HOST_WORD = 'this-computer';
/** This computer's name and its short form (before the first dot), longest first; "localhost" and a name of fewer than three letters say nothing. */
function hostNames() {
  const h = String(os.hostname() || '').trim();
  return [...new Set([h, h.split('.')[0]])].filter((x) => x.length >= 3 && x.toLowerCase() !== 'localhost').sort((a, b) => b.length - a.length);
}

// Names many computers have by default, or that are ordinary words in a coding session's text ("npm run dev",
// "Ubuntu 24.04", "the main branch", "@app/core"). ("localhost" and a name of fewer than three letters are never taken
// out: hostNames.)
const ORDINARY = new Set(['ubuntu', 'debian', 'fedora', 'arch', 'manjaro', 'mint', 'kali', 'centos', 'rocky', 'alpine', 'nixos',
  'raspberrypi', 'raspberry', 'linux', 'android', 'dev', 'app', 'api', 'web', 'www', 'server', 'build', 'main', 'master', 'test', 'prod',
  'staging', 'home', 'work', 'office', 'desktop', 'laptop', 'macbook', 'imac', 'mac', 'mini', 'box', 'host', 'node', 'worker', 'runner',
  'docker', 'router']);

/**
 * `t` with this computer's name taken out. A name goes wherever it stands as a word of its own ("box2", "alexsmac",
 * "alexs-laptop", "box2.lan"): the owner's own name for his computer, often one private word. Only a name on the
 * ORDINARY list ("dev", "ubuntu", the default name of many computers) goes only where it is used as a host: after a
 * user's name and "@" where that reads like a prompt or an ssh target ("[alex@dev shop]$", "alex@ubuntu:~/x", "ssh
 * alex@ubuntu.local": at the start or after a space, "[" or "(", a plain user's name, then the name and ":", a space,
 * "]" or the end), and before ":" and a path ("ubuntu:~/x"). "npm run dev", "Ubuntu 24.04", a package's scope
 * ("@app/core"), an action's ref ("actions/checkout@main") and a package's tag before a comma ("hoprig@dev,") stay
 * as they were; a package's tag before a space reads like "ssh alex@dev" and goes.
 */
function maskHost(t) {
  for (const n of hostNames()) {
    const e = escapeRe(n);
    const re = !ORDINARY.has(n.toLowerCase())
      ? `(?<![A-Za-z0-9_.-])${e}(?![A-Za-z0-9_-])`
      : `(?<=(?:^|[\\s[(${EDGE}])[A-Za-z0-9_][A-Za-z0-9_.-]*@)${e}(?=\\.local(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])|[:\\s\\]${EDGE}]|$)|(?<![A-Za-z0-9_.@-])${e}(?=:[~/\\\\])`;
    t = t.replace(new RegExp(re, 'gi'), HOST_WORD);
  }
  return t;
}

/** The paths of this computer that a session's words may carry, with what stands for each (longest first). */
export function pathsOf({ projectsDir, workspace, home = os.homedir() } = {}) {
  const list = [];
  const add = (p, short) => {
    if (typeof p !== 'string' || p.length < 2) return;
    const one = (x) => {
      x = x.replace(/[\\/]+$/, '');
      list.push([`${x}/`, short ? `${short}/` : '']);
      list.push([x, short || '.']);
    };
    one(p);
    try {
      const r = fs.realpathSync(p);
      if (r !== p) one(r);
    } catch {
      /* not there */
    }
  };
  add(projectsDir, '');
  add(workspace, '');
  add(home, '~');
  return list.sort((a, b) => b[0].length - a[0].length);
}

const isAbs = (s) => /^(\/|[A-Za-z]:[\\/]|\\\\|~[\\/])/.test(s);
/** True when `s` holds the computer's home folder as a path (a run never holds it: checkRun). */
const holdsHome = (s) => {
  const home = os.homedir();
  return !!home && home.length > 3 && pathRe(home).test(s);
};
/**
 * A path a run may hold: relative, inside its folder, of plain characters, at most 500 long, without the home folder in
 * it ("backup/home/alex/notes.txt"), and nothing in it that masking or this computer's name would change (a file
 * named like a key). folders.mjs counts a file of any other name and never lists it.
 */
export const relOk = (s) => typeof s === 'string' && s.length > 0 && s.length <= 500 && !isAbs(s) && !s.split(/[\\/]/).includes('..') && !/[\u0000-\u001f\u007f]/.test(s) && !holdsHome(s)
  && redact(s) === s && maskHost(s) === s;

/**
 * Check a run strictly before it is written: every key known, every value of its kind and size, no full path. Throws
 * (500: a run is written by the dashboard, never from a browser) with what is wrong.
 */
export function checkRun(r) {
  if (!isObj(r)) throw bad('is not an object');
  for (const k of Object.keys(r)) if (!KEYS.includes(k)) throw bad(`has an unknown key "${String(k).slice(0, 30)}"`);
  for (const k of KEYS) if (!(k in r) && !LATER_KEYS.includes(k)) throw bad(`has no "${k}"`);
  const str = (k, max, re = null, { nul = false, lines = false } = {}) => {
    const v = r[k];
    if (v === null && nul) return;
    if (typeof v !== 'string' || v.length > max) throw bad(`has a bad "${k}"`);
    if (re && !re.test(v)) throw bad(`has a bad "${k}"`);
    const ctl = lines ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/;
    if (ctl.test(v)) throw bad(`has a control character in "${k}"`);
  };
  if (r.v !== 1) throw bad('is not of version 1');
  str('id', 30, RUN_ID_RE);
  str('item', 80, ID_RE);
  str('title', 200);
  str('writer', 16, /^[0-9a-f]{16}$/);
  if (r.by !== 'owner' && r.by !== 'schedule' && r.by !== 'mission' && r.by !== 'look') throw bad('has a bad "by"');
  if (r.branch !== undefined && r.branch !== null && (typeof r.branch !== 'string' || !BRANCH_RE.test(r.branch))) throw bad('has a bad "branch"');
  if (r.schedule !== undefined && r.schedule !== null && (typeof r.schedule !== 'string' || !SCHEDULE_RE.test(r.schedule))) throw bad('has a bad "schedule"');
  if (r.used !== undefined && r.used !== null && !usedOk(r.used)) throw bad('has a bad "used"');
  str('startedAt', 30, DAY_TIME_RE);
  str('endedAt', 30, DAY_TIME_RE, { nul: true });
  str('project', 100, PROJECT_RE);
  if (cleanFolder(r.folder) !== r.folder) throw bad('has a bad "folder"');
  str('tool', 20, /^[a-z]{1,20}$/);
  str('provider', 120, NAME_RE);
  str('model', 120, MODEL_RE, { nul: true });
  str('effort', 20, EFFORT_RE, { nul: true });
  str('session', 36, UUID_RE, { nul: true });
  str('conversation', 200, CONVERSATION_RE, { nul: true });
  str('message', 36, UUID_RE, { nul: true });
  str('brief', BRIEF_MAX, null, { lines: true });
  if (!RUN_STATES.includes(r.state)) throw bad('has a bad "state"');
  str('reason', 400, null, { nul: true, lines: true });
  str('answer', ANSWER_MAX, null, { lines: true });
  str('statusError', 400, null, { nul: true });
  const list = (k, max, one) => {
    if (!Array.isArray(r[k]) || r[k].length > max) throw bad(`has a bad "${k}"`);
    for (const x of r[k]) if (!isObj(x) || !one(x)) throw bad(`has a bad entry in "${k}"`);
  };
  const repoOk = (x) => x.repo === '.' || cleanFolder(x.repo) === x.repo;
  list('commits', COMMITS_MAX, (x) => Object.keys(x).length === 3 && repoOk(x) && SHORT_RE.test(x.short) && typeof x.subject === 'string' && x.subject.length <= 200 && !/[\u0000-\u001f]/.test(x.subject));
  list('changed', CHANGED_MAX, (x) => Object.keys(x).length === 3 && repoOk(x) && relOk(x.path) && KINDS.includes(x.kind));
  if (!Number.isInteger(r.more) || r.more < 0 || r.more > 1e9) throw bad('has a bad "more"');
  if (!WAS.includes(r.was)) throw bad('has a bad "was"');
  // No full path anywhere, also inside the lists (a commit's subject, a file's path): the computer's home folder is
  // never in a run (cleanText takes it out of the words).
  if (stringsOf(r).some(holdsHome)) throw bad('holds a full path of this computer');
  return r;
}

/** Every string in `v`, also inside its lists and objects. */
const stringsOf = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(stringsOf) : isObj(v) ? Object.values(v).flatMap(stringsOf) : []);

// ---------- the files ----------

/** The runs folder of a Work place (place.mjs resolvePlace), checked: inside the Work folder, no link out. */
export function runsDir(place, { make = false } = {}) {
  const dir = path.join(place.folder, RUNS_FOLDER);
  let st = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    /* none yet */
  }
  if (st && !st.isDirectory()) throw Object.assign(new Error(`${place.label}/${RUNS_FOLDER} is not a plain folder (a link or a file): Work leaves it alone`), { status: 409, details: { code: 'runs-folder' } });
  if (!st && make) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const bytesOf = (r) => Buffer.byteLength(`${JSON.stringify(r, null, 2)}\n`);

/**
 * A run that fits in RUN_FILE_MAX: the files and then the commits are left out from the end of their lists (the files
 * counted in `more`) until it does. Every field has its own limit, but all of them at once can be more than a file.
 */
function fitRun(run) {
  if (bytesOf(run) <= RUN_FILE_MAX) return run;
  const r = { ...run, changed: [...run.changed], commits: [...run.commits] };
  while (r.changed.length && bytesOf(r) > RUN_FILE_MAX) {
    r.changed.pop();
    r.more += 1;
  }
  while (r.commits.length && bytesOf(r) > RUN_FILE_MAX) r.commits.pop();
  return r;
}

/** Write one run (checked strictly, made to fit), atomically. Only the dashboard that runs it writes it. → the run written. */
export function writeRun(place, run0) {
  checkRun(run0);
  const run = fitRun(run0);
  if (bytesOf(run) > RUN_FILE_MAX) throw bad('is too large for a run file');
  const dir = runsDir(place, { make: true });
  const file = path.join(dir, `${run.id}.json`);
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    /* new */
  }
  if (st && !st.isFile()) throw Object.assign(new Error('a run file is not a plain file: Work leaves it alone'), { status: 409, details: { code: 'runs-folder' } });
  writeText(file, `${JSON.stringify(run, null, 2)}\n`);
  return run;
}

/** A run as read from a file (another computer's too): only what checkRun accepts, else null. */
function readOne(file) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > RUN_FILE_MAX) return null;
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    checkRun(r);
    return r;
  } catch {
    return null;
  }
}

/**
 * True when `file` is a run record of its own name: a plain file (not a link), of at most RUN_FILE_MAX, that checkRun
 * accepts, whose id is its name, with nothing in it that masking would change, and its words and paths without this
 * computer's name. Only such a file is Work's to commit and send (save.mjs); anything else in runs/ is not.
 */
export function isRunFile(file) {
  const r = readOne(file);
  if (!r || `${r.id}.json` !== path.basename(file)) return false;
  const rest = { ...r, item: null, project: null, folder: null, commits: r.commits.map(({ repo, ...c }) => c), changed: r.changed.map(({ repo, ...c }) => c) };
  return stringsOf(rest).every((s) => redact(s) === s)
    && [r.project, r.folder, ...r.commits.map((c) => c.repo), ...r.changed.map((c) => c.repo)].every((s) => s.split(/[-/]/).every((p) => redact(p) === p))
    && [...WORDS.map((k) => r[k]), ...r.commits.map((c) => c.subject), ...r.changed.map((c) => c.path)].every((s) => s === null || maskHost(s) === s);
}
// What a run holds from a session, a task or a folder, which cleanText (or relOk) made so: a file that holds a key, a
// password or this computer's name anywhere was not written by Work, even when its shape is a run's. (A provider's
// or a model's name is the owner's own, as Settings has it.)
// The task's id, the project and the folders are the owner's own names, of a strict shape (checkRun): masking would
// change many an ordinary one ("add-sk-translation-for-the-settings-page", a project "sk-learn-notebooks": a key's
// shape starts at any "-"). The id (lower-case letters, digits and "-") holds no key of any other shape, so its
// pattern is its whole check; a project's or a folder's name may hold "_" and capitals, so each of its pieces between
// "-" and "/" is checked: a key without a dash in it (a GitHub token, an AWS key id) still makes it no run of Work's.
const WORDS = ['title', 'brief', 'reason', 'answer', 'statusError'];

/** One run by its id (checked against the id pattern first), or null. */
export function readRun(place, id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return null;
  let dir;
  try {
    dir = runsDir(place);
  } catch {
    return null;
  }
  const r = readOne(path.join(dir, `${id}.json`));
  return r && r.id === id ? r : null;
}

/** The runs, newest first (by their id, which starts with the time): every file of the right name that reads well. */
export function listRuns(place, { item = null, max = LIST_MAX } = {}) {
  let dir;
  let names = [];
  try {
    dir = runsDir(place);
    names = fs.readdirSync(dir).filter((n) => RUN_FILE_RE.test(n)).sort().reverse();
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.slice(0, max)) {
    const r = readOne(path.join(dir, n));
    if (r && `${r.id}.json` === n && (!item || r.item === item)) out.push(r);
  }
  return out;
}

/**
 * A run that ends by itself (alone.mjs): it works on a branch of its own and has no chat. A Do it run on a branch of
 * its own (doit.mjs) has a branch too, and its chat's session once the chat opened: that one is Do it's to settle.
 */
export const endsByItself = (r) => !!r && !!r.branch && !r.session;

/** A run as the page and the command get it: everything but the writer's id. */
export function viewRun(r, me = null) {
  const { writer, ...rest } = r;
  return { branch: null, schedule: null, used: null, ...rest, here: me !== null && writer === me };
}

// ---------- what the writer keeps of a run's start ----------

const startFile = (id) => path.join(stateDir(), 'work-runs', `${id}.json`);

/**
 * Keep what run `id` started from: { start: [{ repo, head }], before: [{ repo, path, sig }], beforeCut, proc? } (folders.mjs
 * headsOf and dirtyOf; proc: { pid, ident } of a run's coding tool, procid.mjs, for a run that ends by itself). In this dashboard's state folder, mode 600: only the writer reads it, when it settles the run.
 */
export function keepStart(id, data) {
  if (!RUN_ID_RE.test(id)) throw bad('has a bad "id"');
  const file = startFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  const proc = isObj(data.proc) && Number.isInteger(data.proc.pid) && data.proc.pid > 0 && typeof data.proc.ident === 'string' ? { pid: data.proc.pid, ident: data.proc.ident.slice(0, 200) } : undefined;
  fs.writeFileSync(tmp, JSON.stringify({ start: data.start, before: data.before, beforeCut: !!data.beforeCut, ...(proc ? { proc } : {}) }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** What run `id` started from (keepStart), or null when it is not kept here (another dashboard's run, or a lost state folder). */
export function readStart(id) {
  if (typeof id !== 'string' || !RUN_ID_RE.test(id)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(startFile(id), 'utf8'));
    const ok = isObj(d) && Array.isArray(d.start) && Array.isArray(d.before)
      && d.start.every((x) => isObj(x) && typeof x.repo === 'string' && (x.head === null || SHA_RE.test(x.head)))
      && d.before.every((x) => isObj(x) && typeof x.repo === 'string' && typeof x.path === 'string' && typeof x.sig === 'string');
    const proc = isObj(d.proc) && Number.isInteger(d.proc.pid) && d.proc.pid > 0 && typeof d.proc.ident === 'string' ? { pid: d.proc.pid, ident: d.proc.ident } : null;
    return ok ? { start: d.start, before: d.before, beforeCut: d.beforeCut === true, ...(proc ? { proc } : {}) } : null;
  } catch {
    return null;
  }
}

/** Forget what run `id` started from (it is settled). */
export function dropStart(id) {
  if (typeof id === 'string' && RUN_ID_RE.test(id)) fs.rmSync(startFile(id), { force: true });
}
