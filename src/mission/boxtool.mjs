// A mission's session may run the project's own tests in the box while it works (docs/WORK.md "Missions"): ONE tool,
// run_tests, through a tool server of the product's own (toolserver.mjs) that the launcher starts for that one session
// and that is only a relay. Everything is decided here, on the dashboard:
//   the token   made for one session and this one act, kept only in this process's memory (never a file, a log, a run
//               record, the Work file or the mission file), so a restart kills every one; removed when the run settles
//   the route   POST /api/mission-tool/run-tests, its token only in the Authorization header; it answers only for that
//               session's own worktree. The token on any other route, and anything but the token on this one, is refused
//   the input   at most PATHS_MAX paths inside the worktree, each a real place there reached through no link, given to
//               the owner's test command as they are; nothing else (no command, no option, no environment)
//   the run     the gate's own construction (boxed.mjs runInBox): the same folders, the same link to the dependencies,
//               one run of a worktree at a time; never counted as the gate's run
//   the limits  below, with their reasons; past one the tool says so in one line and nothing runs
//   the audit   one line per run in the state folder (which task, how it ended, how long), never what was printed
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from '../paths.mjs';
import { keptTree } from '../work/alonegit.mjs';
import { runInBox } from './boxed.mjs';
import { commandOf, readsOf, wallSays } from './boxrun.mjs';
import { GATE_MS, boxReady, commandWords, printedTail } from './gate.mjs';
import { RUNS } from './roles.mjs';

const RUN_LIST = { tests: 'the project\'s tests', build: 'its build', scripts: 'its scripts' };
const runsList = (kinds) => {
  const w = RUNS.filter((k) => kinds.includes(k)).map((k) => RUN_LIST[k]);
  return w.length === 1 ? w[0] : `${w.slice(0, -1).join(', ')} and ${w[w.length - 1]}`;
};

export const TOKEN_PREFIX = 'hbt_';
const TOKEN_RE = /^hbt_[A-Za-z0-9_-]{43}$/;
export const TOOL_ROUTE = '/api/mission-tool/run-tests';
// The session's other runs, one route per kind of the role's list (roles.mjs RUNS), each with its one field.
export const KIND_ROUTES = Object.freeze({
  [TOOL_ROUTE]: { kind: 'tests', field: 'paths' },
  '/api/mission-tool/run-build': { kind: 'build', field: null },
  '/api/mission-tool/run-script': { kind: 'scripts', field: 'name' },
});
export const TOOL_NAME = 'mcp__hoprig__run_tests';

// One run may take as long as the gate's own (GATE_MS): a test run the gate would let finish is not cut short here.
export const RUN_MS = GATE_MS;
// Runs per session: enough to run the tests after each change of a session's work, few enough that a session that
// calls the tool in a loop cannot hold the box (and the computer's processors) for its whole time.
export const RUNS_MAX = 12;
// The sum of one session's runs: a session's time is for its work; more than half an hour of tests is a loop.
export const TOTAL_MS = 30 * 60_000;
// The input: a test file or a folder or a few, never a list of the whole tree, and no path longer than a real one.
export const PATHS_MAX = 20;
export const PATH_CHARS = 400;
const BODY_MAX = 16 * 1024;
// The audit keeps at least this many lines (the file and the one before it): weeks of a busy mission, small files.
export const AUDIT_MAX = 2000;
// A path's characters: plain file names. No separator of a shell, no quote, no pattern, no space: what the test
// command gets is a path and nothing that a script running it could read as more.
const SAFE = /^[A-Za-z0-9._/@+=,-]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const auditFile = () => path.join(stateDir(), 'mission-box-runs.jsonl');
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (d, top) => d === top || d.startsWith(top.endsWith(path.sep) ? top : top + path.sep);

// A guard older than this was left by a dashboard that died while it moved the file: moving it is one rename, so no
// live dashboard holds the guard this long.
const GUARD_STALE_MS = 60_000;

/**
 * One line of the audit: { at, mission, task, end, ms, runs }. The audit is the file and the one before it (`.1`):
 * together they hold at least the last AUDIT_MAX lines.
 */
export function audit(line) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    // One append per line, with O_APPEND: the kernel writes each short line whole at the end of the file, so two
    // dashboards finishing a run at the same moment never overwrite each other's line. (The old read-modify-write-
    // rename dropped one of two concurrent lines: each read N, each wrote N+1, and the second rename won.)
    fs.appendFileSync(auditFile(), `${JSON.stringify(line)}\n`, { mode: 0o600 });
    turnAudit();
  } catch {
    /* the audit could not be written: the run's answer is not held back for it */
  }
}

// When the file holds more than AUDIT_MAX lines it is moved aside whole, as the `.1` file (the older one goes), and a
// new one is begun by the next append. Moved, never copied: a line another dashboard appends while this happens goes
// into the file it already opened, the one moved aside, so it is kept. (A copy of the last lines renamed over the file
// lost such a line.) One dashboard at a time (an O_EXCL guard), and the count is read again under it.
export function turnAudit({ judged } = {}) {
  const f = auditFile();
  const count = () => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length;
  try {
    if (count() <= AUDIT_MAX) return;
  } catch {
    return;
  }
  const guard = `${f}.turn`;
  const held = takeGuard(guard, { judged });
  if (!held) return; // another dashboard moves it now: this line is appended already
  try {
    if (count() > AUDIT_MAX) moveAside(f);
  } catch {
    /* the file is gone: nothing to move */
  } finally {
    releaseGuard(guard, held);
  }
}

// The file goes to `.1` only when what was taken really holds more than AUDIT_MAX lines: it is first taken away to a
// name of this process's own and counted there. A small file (begun after another dashboard moved the full one aside a
// moment before) is put back, so `.1` is never replaced by a nearly empty file, whatever the guard did.
// `renamed` and `copied(mine)` are for tests: called right after the rename, and after each copy into a new file.
export function moveAside(f, { renamed, copied } = {}) {
  const mine = ownName(f);
  fs.renameSync(f, mine);
  renamed?.();
  if (fs.readFileSync(mine, 'utf8').split('\n').filter(Boolean).length > AUDIT_MAX) return fs.renameSync(mine, `${f}.1`);
  try {
    fs.linkSync(mine, f); // back where it was
  } catch {
    // A new file was begun there: its lines and these. A writer that opened the file before the rename may still add
    // its line to `mine` after the copy, so what came after it is copied too, until `mine` stays as it is a moment.
    let done = 0;
    for (let quiet = 0, tries = 0; quiet < 3 && tries < 100; tries += 1) {
      const all = fs.readFileSync(mine);
      if (all.length > done) {
        fs.appendFileSync(f, all.subarray(done), { mode: 0o600 });
        done = all.length;
        quiet = 0;
        copied?.(mine);
      } else {
        quiet += 1;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
  fs.rmSync(mine, { force: true });
}

// A guard is told by its inode and by a token of its maker's own written into it: a file system may give a freed inode
// to the next new file at once (ext4 does), so a fresh guard made where a stale one was removed can have its inode.
const sameFile = (a, b) => a.ino === b.ino && a.dev === b.dev;
const bodyOf = (f) => fs.readFileSync(f, 'utf8');
const ownName = (guard) => `${guard}.${process.pid}.${crypto.randomBytes(6).toString('hex')}`;

/**
 * Takes the guard file away to a name of this process's own, only when it is the file `was` (its inode and its token;
 * for a stale one, also a time still that old). When it turns out to be another one (another dashboard took the guard
 * over meanwhile and holds it now), it is put back where it was. → true when the file taken away was `was` (it is
 * removed then).
 */
function takeAway(guard, was, gone = () => {}) {
  const mine = ownName(guard);
  try {
    fs.renameSync(guard, mine);
  } catch {
    gone();
    return false; // gone meanwhile
  }
  let st = null;
  let body = null;
  try {
    st = fs.statSync(mine);
    body = bodyOf(mine);
  } catch {
    /* cannot be told: put back */
  }
  if (st && sameFile(st, was) && body === was.token && (!was.stale || Date.now() - st.mtimeMs > GUARD_STALE_MS)) {
    fs.rmSync(mine, { force: true });
    return true;
  }
  try {
    fs.linkSync(mine, guard); // back where it was; never over a guard made there since
  } catch {
    /* another guard is there now: its maker holds it */
  }
  fs.rmSync(mine, { force: true });
  return false;
}

/**
 * Makes the guard file; one left by a dead dashboard (older than GUARD_STALE_MS) is taken over by a rename to a name
 * of this process's own, and only when what was renamed is that stale guard (its inode and token), never one another
 * dashboard took over in the meantime. → what is held ({ ino, dev, token }), or null. `judged`: a test's hook, called
 * once a guard was judged stale and before it is taken over.
 */
export function takeGuard(guard, { judged } = {}) {
  for (let i = 0; i < 2; i += 1) {
    try {
      const fd = fs.openSync(guard, 'wx', 0o600);
      try {
        const token = crypto.randomBytes(12).toString('hex');
        fs.writeSync(fd, token);
        const st = fs.fstatSync(fd);
        return { ino: st.ino, dev: st.dev, token };
      } finally {
        fs.closeSync(fd);
      }
    } catch (e) {
      if (e.code !== 'EEXIST') return null;
    }
    let was;
    try {
      const st = fs.statSync(guard);
      was = { ino: st.ino, dev: st.dev, token: bodyOf(guard), stale: true, at: st.mtimeMs };
    } catch {
      continue; // gone meanwhile: try again
    }
    if (Date.now() - was.at <= GUARD_STALE_MS) return null;
    judged?.();
    if (!takeAway(guard, was)) return null; // not the stale one any more: another dashboard holds the guard now
  }
  return null;
}

/** Gives back the guard `held` (takeGuard's answer): only that file, never one another dashboard made there since. */
export function releaseGuard(guard, held) {
  if (!held) return;
  // Another dashboard may have the guard away for a moment, to look whether it is the stale one; it puts it back at
  // once. So while it is not there and a name of another's own is, this one looks again (a few milliseconds at most).
  const dir = path.dirname(guard);
  const aside = () => {
    try {
      return fs.readdirSync(dir).some((n) => n.startsWith(`${path.basename(guard)}.`));
    } catch {
      return false;
    }
  };
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 200; i += 1) {
    let away = false;
    if (takeAway(guard, held, () => (away = true)) || !away || !aside()) return;
    Atomics.wait(pause, 0, 0, 2);
  }
}

/**
 * The paths a session gave, checked against its worktree `tree` (the real path the product made it at). → { paths }
 * or { why } (one line: which input and why). Each is relative, plain, no option, no `..`, there, and reached through
 * no link: as the box checks a folder.
 */
export function checkPaths(tree, given) {
  if (given === undefined || given === null) return { paths: [] };
  if (!Array.isArray(given)) return { why: '"paths" is a list of paths inside this folder' };
  if (given.length > PATHS_MAX) return { why: `at most ${PATHS_MAX} paths at once` };
  const top = real(tree);
  if (!top) return { why: 'the task\'s folder is not there' };
  const out = [];
  for (const [i, p] of given.entries()) {
    const name = typeof p === 'string' ? JSON.stringify(p.slice(0, 60)).replace(CONTROL, '?') : `path ${i + 1}`;
    const no = (why) => ({ why: `${name}: ${why}; nothing ran` });
    if (typeof p !== 'string' || !p) return no('a path is a word of text');
    if (p.length > PATH_CHARS) return no(`longer than ${PATH_CHARS} characters`);
    if (CONTROL.test(p)) return no('it holds a control character');
    if (p.startsWith('-')) return no('it starts with "-", as an option does: the tool takes paths only');
    if (path.isAbsolute(p) || p.startsWith('\\')) return no('give a path inside this folder, from its top');
    const parts = p.split('/');
    if (parts.includes('..')) return no('".." is not taken');
    if (!SAFE.test(p)) return no('only letters, digits and . _ / @ + = , - are taken in a path');
    let at = top;
    for (const part of parts.filter((x) => x && x !== '.')) {
      at = path.join(at, part);
      let st;
      try {
        st = fs.lstatSync(at);
      } catch {
        return no('it is not there');
      }
      if (st.isSymbolicLink()) return no('it is reached through a link');
    }
    const r = real(at);
    if (!r || !inside(r, top)) return no('it is not inside this folder');
    out.push(p);
  }
  return { paths: out };
}

const secs = (ms) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 100) / 10} s`);

/**
 * The tokens of this dashboard's sessions and what a call does. o: { settings() (missionSettings), box() (seam.box()),
 * on(project) (missions on for it), onRun(rec, end) (a run ended: the mission file's count), onLimit(rec, which) (the
 * session reached a limit, 'runs' or 'time': the card's line), now() }.
 */
export function boxTools(o) {
  const live = new Map(); // hash of the token → its record
  const now = o.now || (() => Date.now());

  /** A token for one session of one task; kinds: what its role may run (roles.mjs RUNS; the tests alone if left out). → { token, drop() } */
  function make({ mission, task, project, top, branch, kinds = ['tests'] }) {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const key = hash(token);
    const rec = { mission, task, project, top, branch, kinds: RUNS.filter((k) => kinds.includes(k)), runs: 0, ms: 0, refused: 0, running: false, dead: false };
    live.set(key, rec);
    return { token, rec, drop: () => {
      if (rec.dead) return;
      live.delete(key);
      end(rec);
    } };
  }
  // A token's end, however it comes (its session settled, or the dashboard stops): the record is dead, and a session's
  // refusals are one line. They are not runs (one line per run), so they do not each write a line: a session that
  // called the tool in a loop leaves one line, not thousands pushing the real runs out of the audit.
  function end(rec) {
    rec.dead = true;
    if (rec.refused > 0) audit({ at: new Date(now()).toISOString(), mission: rec.mission, task: rec.task, end: 'refused', ms: 0, runs: rec.runs, refused: rec.refused });
  }
  const find = (token) => (typeof token === 'string' && TOKEN_RE.test(token) ? live.get(hash(token)) || null : null);

  /** A session's call. → { text, isError } (every refusal is one line; nothing ran). */
  async function call(rec, given, kind = 'tests') {
    const t0 = now();
    // One audit line per run (passed, failed, timeout), saying what ran when it was not the tests: a call that ran
    // nothing (refused, held by the wall, busy) is counted on the record instead and summed in one line when the token
    // is dropped.
    const said = (end, text, isError = true, what = null) => {
      if (end === 'passed' || end === 'failed' || end === 'timeout') audit({ at: new Date(t0).toISOString(), mission: rec.mission, task: rec.task, end, ms: Math.max(0, now() - t0), runs: rec.runs, ...(what ? { what } : {}) });
      else rec.refused += 1;
      return { text, isError };
    };
    // A session stopped at a limit is told apart on the card from one that simply ran its last run: the first limit it
    // reaches is noted on the record once (not on every refused call of the loop that follows), for the card's line.
    const hitLimit = (which) => {
      if (rec.limit) return;
      rec.limit = which;
      try {
        o.onLimit?.(rec, which);
      } catch {
        /* the flag on the card is not worth an answer lost */
      }
    };
    // A session of the tests alone (the one tool as before) keeps every word it had; one with more kinds is told that
    // its limits are shared by all of them.
    const solo = rec.kinds.length === 1 && rec.kinds[0] === 'tests';
    const shared = `${RUNS_MAX} runs in the box (tests, build and scripts together)`;
    if (!o.on(rec.project)) return said('refused', 'Missions are off for this project now: the tool runs nothing. Go on without it; the tests run after you end.');
    if (!RUNS.includes(kind) || !rec.kinds.includes(kind)) {
      return said('refused', rec.kinds.length ? `Refused: this session may run only ${runsList(rec.kinds)}; nothing ran.` : 'Refused: this session may run nothing in the box; nothing ran.');
    }
    if (rec.running) return said('refused', solo ? 'A run of these tests is under way: wait for its answer, then call again.' : 'A run of this session is under way: wait for its answer, then call again.');
    if (rec.runs >= RUNS_MAX) return hitLimit('runs'), said('refused', solo ? `This session ran the tests ${RUNS_MAX} times, its limit: go on without the tool; the tests run after you end.` : `This session ran ${shared}, its limit: go on without the tool. Nothing ran.`);
    if (rec.ms >= TOTAL_MS) return hitLimit('time'), said('refused', solo ? `This session's runs took ${secs(TOTAL_MS)} in all, its limit: go on without the tool; the tests run after you end.` : `This session's runs in the box took ${secs(TOTAL_MS)} in all, its limit: go on without the tool. Nothing ran.`);
    const project = o.settings().projects[rec.project] || {};
    const test = project.test;
    if (kind === 'tests' && (!Array.isArray(test) || !test.length)) return said('refused', 'This project has no test command any more: the tests are not run by the tool.');
    const tree = keptTree(rec.top, rec.branch);
    if (!tree) return said('refused', 'The task\'s folder is gone: nothing ran.');
    let argv;
    let what = null;
    let reads;
    if (kind === 'tests') {
      const c = checkPaths(tree, given);
      if (c.why) return said('refused', `Refused: ${c.why}.`);
      argv = [...test, ...c.paths];
      const r = readsOf(argv, tree);
      if (r.why) return said('held', r.why);
      reads = r.reads;
    } else {
      const c = commandOf(kind, given, { top: rec.top, tree, build: project.build });
      if (c.why) return said('refused', c.why);
      ({ argv, what, reads } = c);
    }
    // The wall reads every line first (the command, and what a script runs): a held one is never run.
    const held = wallSays(reads, tree);
    if (held) return said('held', held);
    const name = kind === 'tests' ? 'The tests' : kind === 'build' ? 'The build' : `The script "${given}"`;
    rec.running = true;
    try {
      const box = o.box();
      const ready = await boxReady(box);
      if (!ready.ok) return said('not-run', `Nothing ran: ${ready.why}. Go on without the tool; after you end the tests are run in a box where this computer has one, or by the owner.`);
      const timeoutMs = Math.max(1000, Math.min(RUN_MS, TOTAL_MS - rec.ms));
      const x = await runInBox(box, { top: rec.top, tree, test: argv, timeoutMs });
      if (x.busy) return said('busy', kind === 'tests' ? 'The tests of this task run in the box now (the owner\'s run, or another one): call again once it ends.' : 'Something of this task runs in the box now (the owner\'s run, or another one): call again once it ends.');
      const r = x.r || {};
      if (r.code == null && !r.timedOut) return said('not-run', `Nothing ran: the box could not start ${kind === 'tests' ? 'the tests' : kind === 'build' ? 'the build' : `the script "${given}"`}.`);
      const ms = Math.max(0, now() - t0);
      rec.runs += 1;
      rec.ms += ms;
      const end = r.timedOut ? 'timeout' : r.ok === true && r.code === 0 ? 'passed' : 'failed';
      // The card counts the session's own test runs; a build or a script is in the audit only.
      if (kind === 'tests') {
        try {
          o.onRun?.(rec, end);
        } catch {
          /* the count on the card is not worth an answer lost */
        }
      }
      // The session ended while its run went on: nobody reads the answer, which is dropped.
      if (rec.dead) return said(end, 'The session ended: this answer was dropped.', true, what);
      const cmd = commandWords(argv);
      const good = kind === 'tests' ? 'passed' : 'ended well';
      const head = end === 'timeout' ? `${name} did not end in ${secs(timeoutMs)} and ${kind === 'tests' ? 'were' : 'was'} stopped (${cmd})`
        : end === 'passed' ? `${name} ${good} (${cmd}, ${secs(ms)})` : `${name} failed: exit code ${r.code} (${cmd}, ${secs(ms)})`;
      const tail = printedTail(r.out, { tree, top: rec.top });
      const left = solo ? `Run ${rec.runs} of at most ${RUNS_MAX}. In the box: no network, only this folder. The tests are run again after you end; that run is the one that counts.`
        : `Run ${rec.runs} of at most ${shared}. In the box: no network, only this folder. The check after you end is the one that counts.`;
      const lastWords = kind === 'tests' ? 'Their last lines' : 'Its last lines';
      return said(end, `${head}. ${left}${tail ? `\n${lastWords}:\n${tail}` : ''}`, end !== 'passed', what);
    } finally {
      rec.running = false;
    }
  }

  return { make, find, call, size: () => live.size, dropAll: () => {
    const all = [...live.values()];
    live.clear();
    for (const rec of all) end(rec);
  } };
}

const bearer = (req) => {
  const h = req.headers && req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)\s*$/i.exec(h) : null;
  return m ? m[1] : null;
};
const carries = (req) => String(bearer(req) || '').startsWith(TOKEN_PREFIX) || /hbt_/.test(String(req.url || ''));
const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return reject(Object.assign(new Error('send JSON'), { status: 415 }));
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('send JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * The door of the session's tool, for the server's features list (before any feature that takes a bearer as its own):
 * the route, with the token alone; the token on any other route or a WebSocket, refused. `tools`: boxTools().
 */
export function toolDoor(tools) {
  async function handle(req, res) {
    let p;
    try {
      p = new URL(req.url, 'http://x').pathname;
    } catch {
      return false;
    }
    const ours = p === '/api/mission-tool' || p.startsWith('/api/mission-tool/');
    if (!ours) {
      if (!carries(req)) return false;
      send(res, 403, { error: 'a session\'s tool token reaches only its one tool', code: 'token-scope' });
      return true;
    }
    if (/hbt_/.test(String(req.url || ''))) return send(res, 400, { error: 'the token goes in the Authorization header, never in the address', code: 'token-in-address' }), true;
    const route = KIND_ROUTES[p];
    if (!route) return send(res, 404, { error: 'not found', code: 'not-found' }), true;
    if (req.method !== 'POST') return send(res, 405, { error: 'POST only', code: 'method' }), true;
    // Only a session's own token: never the owner's sign-in, another computer's token or any other bearer.
    const rec = tools.find(bearer(req));
    if (!rec) return send(res, 401, { error: 'this route takes only a live session\'s own tool token', code: 'token' }), true;
    let b;
    try {
      b = await readBody(req);
    } catch (e) {
      return send(res, e.status || 400, { error: e.message, code: 'body' }), true;
    }
    // Each route takes its one field and nothing else: the tests their paths, a script its name, the build nothing.
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== route.field)) return send(res, 400, { error: route.field ? `the body is { "${route.field}": … } and nothing else` : 'the body is {} and nothing else', code: 'body' }), true;
    try {
      send(res, 200, await tools.call(rec, route.field ? b[route.field] : undefined, route.kind));
    } catch {
      send(res, 500, { error: 'the tests could not be run because of an error on this computer', code: 'internal' });
    }
    return true;
  }
  async function upgrade(req, socket) {
    if (!carries(req) && !String(req.url || '').startsWith('/api/mission-tool')) return false;
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return true;
  }
  return { name: 'mission-tool', handle, upgrade, tools };
}
