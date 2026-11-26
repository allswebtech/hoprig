// A run that ends by itself: one turn of the coding tool with no person at it, in a project of the workspace, with a
// prompt, the provider, model and effort chosen, and a TIME LIMIT. It is what a schedule (of the settings or of an
// item: "run by AI at 07:30") starts, and the one door Tia's Auto will use later (startAlone, below).
//
//   - It works in a linked worktree of the project's repository on a branch of its own, `work/<item or schedule id>`
//     (alonegit.mjs), never on the default branch, never in the owner's own checkout. A project that is not a git
//     repository is refused. Nothing is pushed, merged or published.
//   - It runs with the permission mode its schedule names, by default the one that asks: with nobody to ask, a step
//     that needs an OK is refused, and the result says which. Bypass only when the owner chose it on that schedule.
//   - At the time limit (default 30 minutes, 1 to 240) it is ended: "stopped at the time limit", keeping what it had.
//   - Its result is captured as Do it captures one (doit.mjs): a run in Work's runs folder (runs.mjs) with the answer,
//     the commits on its branch and the files left changed. For an item, the item goes to review (or back to open
//     with the reason).
//   - Limits, checked inside startAlone: never two runs of one project at once; at most `atOnce` on this computer
//     (Settings: "runs by themselves at once", 1 to 4); a run that has to wait is kept in this dashboard's state folder
//     and starts when a place is free, it is not lost.
//   - "Tell me": every time, or only when there is something to report (the default). Nothing to report: it ended
//     well, made no commit, left no file changed and its answer starts with "Nothing to report.". A failure, the time
//     limit or a refused step is always told.
//   - A mission's run (by: 'mission') is ALWAYS restricted: it is started in the coding tool's own restricted mode
//     with a closed list of file tools (no shell, no git, nothing that reaches the network, no tool server, the
//     file tools kept to its worktree), it is not started at all when the installed coding tool does not know
//     that mode, and it is ended at once when its own first line names any other tool. Such a run cannot commit:
//     when it has ended by itself, the dashboard makes the one commit of what it changed (alonecommit.mjs).
//     The same holds for every session Tia starts by herself (hers(), below: a mission's run and a look).
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EFFORTS, PERMISSION_MODES } from '../config.mjs';
import { heldUntil, holdWords } from '../operator/decide-store.mjs';
import { MODEL_RE } from '../server/endpoint.mjs';
import { stateDir } from '../paths.mjs';
import { SAME_WITHIN, sameProcess, system as procIdent } from '../procid.mjs';
import { capture } from '../setup/system.mjs';
import { restrictedKnown } from '../claudecode.mjs';
import { projectsIn, workspaceDir } from '../workspace/layout.mjs';
import { dirtyOf, folderOf, headsOf, leftIn, projectsByName } from './folders.mjs';
import { withLock } from './lock.mjs';
import { CLOSED, ID_RE, briefOf, checkBrief, findItem, fromOf, setStatus, statusOf, todayIn } from './model.mjs';
import { resolvePlace } from './place.mjs';
import { WAIT_OVER } from './planview.mjs';
import { endsByItself, tokensOf, usedOf, cleanFolder, cleanText, dropStart, keepStart, listRuns, newRunId, pathsOf, readRun, readStart, treePaths, viewRun, writeRun, writerId } from './runs.mjs';
import { changeHeld, readDoc } from './store.mjs';
import { commitWords, currentBranch, dropRunBranch, keptTree, noHooksEnv, refsOf, releaseTree, repoTop, treeFor } from './alonegit.mjs';
import { commitRun, gitEntryOf } from './alonecommit.mjs';
import { endAsHers, startAsHers } from '../assistant/hersignin.mjs';
import { credsDir } from '../workspace/credlinks.mjs';
import { fileURLToPath } from 'node:url';
import { resolveWindowsBin, windowsSpawnPlan } from '../winspawn.mjs';

// A mission's session that may run the project's tests in the box (src/mission/boxtool.mjs): the one tool server of the
// product's own, by its file, started with the Node that runs Hoprig; its one tool by the name the coding tool gives it.
export const TOOL_SERVER = fileURLToPath(new URL('../mission/toolserver.mjs', import.meta.url));
export const TOOL_SERVER_NAME = 'hoprig';
export const BOX_TOOL = 'mcp__hoprig__run_tests';
// What a role may run besides the tests, each one tool of that server (src/mission/toolserver.mjs), by the coding tool's name.
export const BOX_TOOLS = Object.freeze({ tests: BOX_TOOL, build: 'mcp__hoprig__run_build', scripts: 'mcp__hoprig__run_script' });
/** A role's run kinds, checked: the closed set only, in its order (left out: the tests). → the list, or null. */
export const boxKinds = (v) => {
  if (v === undefined || v === null) return ['tests'];
  if (!Array.isArray(v) || !v.length || v.some((k) => !Object.hasOwn(BOX_TOOLS, k))) return null;
  return Object.keys(BOX_TOOLS).filter((k) => v.includes(k));
};
export const boxToolNames = (kinds) => (kinds || ['tests']).map((k) => BOX_TOOLS[k]);
const TOOL_TOKEN_RE = /^hbt_[A-Za-z0-9_-]{43}$/;
const TOOL_URL_RE = /^http:\/\/[A-Za-z0-9.:[\]-]{1,100}$/;

export const MINUTES_DEFAULT = 30;
export const MINUTES_MAX = 240;
export const AT_ONCE_MAX = 4;
export const NOTHING = 'Nothing to report.';
export const ALONE_ASK = `Nobody is watching this run: do the work, then end with a short report (what you did, what you checked, what is left). When there is nothing to report, make the first line of your answer exactly: ${NOTHING}`;
const KILL_GRACE_MS = 5_000;
const EXIT_WAIT_MS = 1_000; // after the tool is gone, how long what it started may still hold its output
const CLOSE_WAIT_MS = 15_000; // how long the dashboard's stop waits for its runs to settle
export const MAY_STILL_RUN = 'The coding tool may still be running'; // Windows: its tree could not be ended
// What a run record's reason keeps (settle: words(…, 400)) and an Activity outcome keeps (src/automation/store.mjs).
// When a schedule is switched off, its sentence ends the reason and must stay whole: the detail before it is cut
// instead (REASON_SPARE leaves room for the masking of paths, which can change the length a little).
const REASON_MAX = 400;
const REASON_SPARE = 12;
const ACTIVITY_MAX = 300;
/** `s` cut to at most `room` characters (never fewer than `min`), ending in "…" when it was cut. */
const fitTo = (s, room, min = 20) => {
  const t = String(s ?? '');
  const r = Math.max(min, room);
  return t.length <= r ? t : r <= 1 ? '…' : `${t.slice(0, r - 1)}…`;
};
const refusedSentence = (tools) => `A step needed an OK and was refused (${tools.join(', ')}): nobody was there to allow it`;
// The sentence before it already says the coding tool may still be running: this one says what was done and what to do.
const offSentence = (name) => `. The schedule "${name}" was switched off: switch it on again in Work → Schedules once that program has ended`;
/**
 * The reason of a run whose tool may still run: `head` (what stopped it, then MAY_STILL_RUN's opening), `detail` (why
 * it could not be ended), `tail` (a sentence after it, such as a refused step) and, when its schedule was switched off
 * (`name`), the switch sentence LAST. With a switch it is made to fit REASON_MAX − REASON_SPARE as a whole, so the
 * record's cut never takes the instruction: the detail is cut first (down to "…"), then the schedule's name inside the
 * sentence (down to 8 characters), then the tail. Without a switch it is as it always was.
 */
export function stillReason(head, detail, tail, name) {
  if (name === null || name === undefined) return `${head}${detail})${tail}`;
  const budget = REASON_MAX - REASON_SPARE;
  let d = String(detail ?? '');
  let t = String(tail ?? '');
  let n = String(name);
  const over = () => head.length + d.length + 1 + t.length + offSentence(n).length - budget;
  if (over() > 0) d = fitTo(d, d.length - over(), 1);
  if (over() > 0) n = fitTo(n, n.length - over(), 8);
  if (over() > 0) t = fitTo(t, t.length - over(), 0);
  return `${head}${d})${t}${offSentence(n)}`;
}
const WAITING_MAX = 50;
const fail = (status, message, code) => Object.assign(new Error(message), { status, ...(code ? { details: { code } } : {}) });
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// THE predicate for a session Tia starts by herself: a mission's run, and a look into what nobody can explain
// (src/operator/look.mjs). Every such session is ALWAYS restricted, through this one door with this one rule: every
// check below of the restricted mode, the tools, the dashboard's folders and the budget reads hers(), never its own
// copy of the list.
export const HERS = Object.freeze(['mission', 'look']);
export const hers = (job) => isObj(job) && HERS.includes(job.by);
// A look only reads: it has no tool that writes (its finding is written by the dashboard from its answer).
export const LOOK_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);

/** The branch of a run of `id` (an item's or a schedule's id). */
export const branchOf = (id) => `work/${String(id).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'run'}`;

/** A time limit in minutes, checked: 1 to MINUTES_MAX (left out: the default). */
export function checkMinutes(v) {
  if (v === undefined || v === null) return MINUTES_DEFAULT;
  if (!Number.isInteger(v) || v < 1 || v > MINUTES_MAX) throw fail(400, `the time limit is a whole number of minutes from 1 to ${MINUTES_MAX}`);
  return v;
}

/** What a run that ends by itself has to report: false only for a clean, empty success that says so. */
export function hasNews(run, refused = []) {
  if (run.state !== 'done' || refused.length) return true;
  if (run.commits.length || run.changed.length || run.more) return true;
  return !String(run.answer || '').trimStart().startsWith(NOTHING);
}

/**
 * How the coding tool `bin` (the settings' claudeBin, or `claude`) is started: { command, args, options } for spawn.
 * On Windows a bare name is found as Windows finds it (an npm install is a `claude.cmd` shim, which Node does not
 * start by itself) and a `.cmd` goes to cmd.exe with every argument escaped, as src/launch.mjs starts it; a name that
 * is found as nothing stays as it is. Elsewhere the program itself.
 */
export function toolPlan(bin, args, { platform = process.platform, env = process.env, exists } = {}) {
  if (platform !== 'win32') return { command: bin, args, options: {} };
  const found = resolveWindowsBin(bin, env || {}, exists);
  return found ? windowsSpawnPlan(found, args, env || {}) : { command: bin, args, options: {} };
}

/**
 * Claude Code's arguments for one turn without a person (the prompt goes on stdin, so a brief that starts with "-" is
 * never read as an option): stream-json out (the answer so far is kept when
 * the time limit ends it), the permission mode ("manual" is Claude Code's default: a step that needs an OK is refused).
 */
export function aloneArgs({ mode = 'manual', model = null, effort = null, allowed = null, denied = null, budget = null, restricted = null, dirs = null, tool = null } = {}) {
  // allowed / denied: the tools a mission's role may use without an OK, and those it may never use (its ROLE.md).
  const tools = (flag, list) => (Array.isArray(list) && list.length ? [flag, list.join(',')] : []);
  const closed = Array.isArray(restricted) && restricted.length ? restricted : null;
  // tool ({ url, token }): the one tool server of the product's own, named here and nowhere else (never a file in the
  // worktree), told this dashboard's address and the token of this one session through its environment.
  // tool.kinds: what the role may run (src/mission/roles.mjs RUNS); left out or the tests alone, the start is as before.
  // A list outside the closed set gives no tool at all.
  const kinds = tool ? boxKinds(tool.kinds) : null;
  const one = closed && tool && kinds ? JSON.stringify({ mcpServers: { [TOOL_SERVER_NAME]: { command: process.execPath, args: [TOOL_SERVER], env: { HOPRIG_TOOL_URL: tool.url, HOPRIG_TOOL_TOKEN: tool.token, ...(kinds.join(',') === 'tests' ? {} : { HOPRIG_TOOL_KINDS: kinds.join(',') }) } } } }) : null;
  return [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', mode === 'manual' || closed ? 'default' : mode,
    // restricted: the tools a mission's session has. Claude Code's own restricted mode takes away every tool that runs
    // a command or reaches the network and keeps the file tools to the working folders; --tools names the tools that
    // exist for the session at all (also inside a helper), and no tool server of anyone's is loaded. Never bypass.
    ...(closed ? ['--restricted', '--strict-mcp-config', '--mcp-config', one || '{"mcpServers":{}}', '--tools', closed.join(',')] : []),
    // dirs: folders of the dashboard's own the session may read besides its worktree (a review's diff).
    ...(closed && Array.isArray(dirs) ? dirs.flatMap((d) => ['--add-dir', d]) : []),
    ...(mode === 'bypassPermissions' && !closed ? ['--allow-dangerously-skip-permissions'] : []),
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...tools('--allowedTools', closed ? (one ? [...closed, ...boxToolNames(kinds)] : closed) : allowed),
    ...tools('--disallowedTools', denied),
    // A mission's run: what is left of the owner's spend cap for it, so one turn cannot spend past the cap.
    ...(budget ? ['--max-budget-usd', String(budget)] : []),
  ];
}

/** Read Claude Code's stream-json lines: { text (the last answer so far), result: { ok, text, error, refused, limit, used } | null, session }. */
export function readStream(lines) {
  let text = '';
  let result = null;
  let session = null;
  for (const l of lines) {
    let m;
    try {
      m = JSON.parse(l);
    } catch {
      continue;
    }
    if (!isObj(m)) continue;
    if (typeof m.session_id === 'string') session = m.session_id;
    if (m.type === 'assistant' && isObj(m.message) && Array.isArray(m.message.content)) {
      const t = m.message.content.filter((b) => isObj(b) && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
      if (t.trim()) text = t;
    }
    if (m.type === 'result') {
      const refused = Array.isArray(m.permission_denials) ? [...new Set(m.permission_denials.map((d) => (isObj(d) && typeof d.tool_name === 'string' ? d.tool_name.slice(0, 40) : 'a tool')))] : [];
      const words = typeof m.result === 'string' ? m.result : '';
      result = { ok: m.is_error !== true && m.subtype === 'success', text: words || text, error: m.is_error === true ? words || String(m.subtype || 'error') : null, refused, limit: m.is_error === true && /usage limit|rate limit|limit reached/i.test(words), used: usedOf(m.usage, m.total_cost_usd) };
    }
  }
  return { text: result && result.text ? result.text : text, result, session };
}

/** The computer's process table as `ps -A -o pid=,ppid=` prints it (the same on macOS, the BSDs and Linux), or null. */
function psTable() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' } });
  return r.error || r.status !== 0 ? null : r.stdout || '';
}

/**
 * The parents in a `ps -A -o pid=,ppid=` table: Map ppid → [pid]. Strict, since what it finds gets a signal: null when
 * any line is not two numbers or a pid is listed twice, so a table that is not what was asked for ends nothing.
 */
function kidsFromPs(out) {
  if (typeof out !== 'string') return null;
  const kids = new Map();
  const seen = new Set();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) return null;
    const [p, pp] = [Number(m[1]), Number(m[2])];
    if (seen.has(p)) return null;
    seen.add(p);
    if (!kids.has(pp)) kids.set(pp, []);
    kids.get(pp).push(p);
  }
  return kids;
}

/**
 * The processes below `pid`, also those in a process group of their own: on Linux from /proc, elsewhere (macOS, the
 * BSDs: no /proc) from one ps table (`ps`: a reader of it, for tests); none on Windows. Never this process or pid 1.
 */
export function descendants(pid, { platform = process.platform, ps = psTable } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || platform === 'win32') return [];
  let kids = new Map();
  if (platform === 'linux') {
    let names = [];
    try {
      names = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x));
    } catch {
      return [];
    }
    for (const n of names) {
      try {
        const stat = fs.readFileSync(`/proc/${n}/stat`, 'utf8');
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
        if (!kids.has(ppid)) kids.set(ppid, []);
        kids.get(ppid).push(Number(n));
      } catch {
        /* gone meanwhile */
      }
    }
  } else {
    let table = null;
    try {
      table = ps();
    } catch {
      /* cannot be asked */
    }
    kids = kidsFromPs(table);
    if (!kids) return [];
  }
  const out = [];
  const walk = (p) => {
    for (const c of kids.get(p) || []) if (c !== pid && c > 1 && c !== process.pid && !out.includes(c)) out.push(c) && walk(c);
  };
  walk(pid);
  return out;
}
const signal = (pid, sig, group) => {
  try {
    if (process.platform === 'win32') process.kill(pid, sig);
    else process.kill(group ? -pid : pid, sig);
  } catch {
    /* gone already */
  }
};
// Windows: a run's tree. taskkill /T follows the parent pid a process recorded, and that pid can be handed out again:
// /T can end a program of the person's that started BEFORE the run's cmd.exe and only shares the number. So, as
// src/server/service/wintree.mjs does, one PowerShell table of every process (pid, parent, start; the owner's SID
// of those below the run's pid, and this account's), walked DOWN from the run's pid here, and each one kept ended
// alone, never by /T: what is below the root in one end call (endBelowScript), the root last (endWinTree).

/** Every process with its parent and start, the owner of each below `pid`, and this account's SID, as JSON. */
export const runTreeScript = (pid) => {
  if (!Number.isInteger(pid) || pid <= 4) throw new Error('bad pid');
  // No cmdlet at all, as src/server/platform/win32.mjs NO_MODULE_PRELUDE (not imported: that is the server's module):
  // Get-CimInstance and Invoke-CimMethod load a module, which took about 17 s per call on a test runner. WMI through
  // the System.Management searcher, the owner through the WMI method GetOwnerSid of each row (it needs Handle, the
  // key), and the JSON written by .NET. CreationDate comes as a DMTF string here (yyyymmddHHMMSS.ffffff+UUU):
  // ManagementDateTimeConverter turns it into the same DateTime that Get-CimInstance gave, microseconds and offset
  // included, so through [DateTimeOffset] and ToUnixTimeMilliseconds it is the same instant, cut to the same whole ms.
  return `$ErrorActionPreference = 'SilentlyContinue'
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions')
$json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$json.MaxJsonLength = [int]::MaxValue
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$all = [System.Collections.ArrayList]::new()
foreach ($r in [System.Management.ManagementObjectSearcher]::new('SELECT Handle,ProcessId,ParentProcessId,CreationDate FROM Win32_Process').Get()) { [void]$all.Add($r) }
$below = @{ ${pid} = $true }
do {
  $more = $false
  foreach ($p in $all) { $id = [int]$p['ProcessId']; if (-not $below.ContainsKey($id) -and $below.ContainsKey([int]$p['ParentProcessId'])) { $below[$id] = $true; $more = $true } }
} while ($more)
$procs = [System.Collections.ArrayList]::new()
foreach ($p in $all) {
  $id = [int]$p['ProcessId']
  $sid = $null
  if ($below.ContainsKey($id)) { $o = $p.InvokeMethod('GetOwnerSid', $null, $null); if ($o -and $o['ReturnValue'] -eq 0) { $sid = [string]$o['Sid'] } }
  $start = $null
  if ($p['CreationDate']) { $start = ([DateTimeOffset][System.Management.ManagementDateTimeConverter]::ToDateTime($p['CreationDate'])).ToUnixTimeMilliseconds() }
  [void]$procs.Add(@{ pid = $id; ppid = [int]$p['ParentProcessId']; start = $start; sid = $sid })
}
[Console]::Out.Write([regex]::Replace($json.Serialize(@{ me = $me; procs = $procs.ToArray() }), '[^\\x20-\\x7e]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value }))`;
};

const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
const listOf = (x) => (Array.isArray(x) ? x : x === null || x === undefined ? [] : [x]);

/** That JSON → { me: SID, procs: Map(pid → { pid, ppid, start, sid }) }, or null when it is not that. */
export function parseRunTree(out) {
  let d;
  try {
    d = JSON.parse(out);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || typeof d.me !== 'string' || !d.me) return null;
  const procs = new Map();
  for (const p of listOf(d.procs)) {
    if (p && Number.isInteger(p.pid)) procs.set(p.pid, { pid: p.pid, ppid: Number(p.ppid), start: Number.isFinite(p.start) ? p.start : null, sid: typeof p.sid === 'string' ? p.sid : null });
  }
  return { me: d.me, procs };
}

/**
 * The processes of the run started as `root`, from that table, `root` first: walked down from it, a child kept only
 * when it started no earlier than its parent (else its number was handed out again) and runs as this account. Never
 * `self` (this process), a process above it or above `root`, nor a system process (pid 4 or less). The list also
 * carries `refused` (not enumerated): the children that started no earlier than their parent, so may be the run's,
 * but whose owner could not be read or is another account (or whose start is not known), as [{ pid, why }]. Those
 * are never ended, and the run may still run through them.
 */
export function runTreeOf(snap, root, self = process.pid) {
  const out = [];
  const refused = [];
  Object.defineProperty(out, 'refused', { value: refused, enumerable: false });
  if (!snap || !snap.procs.has(root)) return out;
  const mine = (p) => typeof p.sid === 'string' && p.sid.toUpperCase() === snap.me.toUpperCase();
  const above = new Set([self]);
  for (const from of [self, root]) {
    for (let p = from, i = 0; i < 64; i++) {
      const q = snap.procs.get(p)?.ppid;
      if (!Number.isInteger(q) || q <= 0 || above.has(q)) break;
      above.add(q);
      p = q;
    }
  }
  const top = snap.procs.get(root);
  if (root <= 4 || above.has(root) || !mine(top) || top.start === null) return out;
  const all = [...snap.procs.values()];
  const seen = new Set([root]);
  const queue = [top];
  while (queue.length) {
    const p = queue.shift();
    out.push(p.pid);
    for (const c of all) {
      if (c.ppid !== p.pid || seen.has(c.pid) || above.has(c.pid) || c.pid <= 4) continue;
      if (c.start !== null && c.start < p.start) continue; // its parent's number was handed out again: not the run's
      seen.add(c.pid);
      if (c.start === null || !mine(c)) {
        // Perhaps the run's, but not checked: neither it nor what is below it is ended, and it is said.
        refused.push({ pid: c.pid, why: c.start === null ? 'its start is not known' : typeof c.sid === 'string' ? 'it runs as another account' : 'its owner could not be read' });
        continue;
      }
      queue.push(c);
    }
  }
  return out;
}

const runWin = (cmd, args) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '').trim() }));
    } catch {
      resolve({ ok: false, out: '' });
    }
  });

// The one end call that holds each process while its start is compared (shared with src/cmdtree.mjs).
export { END_SAME_MS, endBelowScript, parseEndLines } from '../winend.mjs';
import { END_SAME_MS, endBelowScript, parseEndLines } from '../winend.mjs';

/** The start (epoch ms) in an identity "T:<ms>" of src/procid.mjs (macOS, Windows), or null. */
export const startOfIdent = (id) => {
  const m = /^T:(\d+)$/.exec(typeof id === 'string' ? id : '');
  return m ? Number(m[1]) : null;
};

// Node marks its child as exited (exitCode, signalCode, the 'exit' event) only once its own loop has seen the process
// end, a moment after the system did: when Claude Code is ended, cmd.exe of an npm shim exits at once by itself, and
// kill() on its handle then answers false (as Node does for ESRCH) before Node knows. So a root end that answers false
// waits for that exit, at most ROOT_EXIT_WAIT_MS, looked at every 10 ms: an exit within it is the end, not a failure.
// Half a second is many times the lag of that case (about 30 ms), and short against the close wait (CLOSE_WAIT_MS)
// that both tries of an end must fit in.
export const ROOT_EXIT_WAIT_MS = 500;
async function exitedSoon(gone) {
  for (let t = 0; ; t += 10) {
    if (gone()) return true;
    if (t >= ROOT_EXIT_WAIT_MS) return false;
    await new Promise((res) => setTimeout(res, 10));
  }
}

/**
 * End the tree of the run started as `pid` once (Windows), each process alone, the lowest first. → { ok, ended,
 * why }: ok when every process of the tree was ended, or there was none any more (a child that answered "other
 * start" is not ended and is not ok: it may be the run's tool still). `gone()`: the run's own process
 * has exited (its pid is not the run's any more), then nothing more is ended: asked before the table, once it is
 * back, and before the end call and the root's end. `start`: when the run's process started (epoch ms, the system's),
 * when known: a root whose start in the table is more than SAME_WITHIN from it is another program, and nothing is
 * ended. `endRoot()` → true when ended: a live run's end of the root through its own child handle; without it (a
 * leftover after a crash) the root is the last of the end call, at that start.
 */
export async function endWinTree(pid, { run = runWin, gone = () => false, start = null, self = process.pid, endRoot = null, first = [] } = {}) {
  if (gone()) return { ok: true, ended: [], gone: true };
  const r = await run('powershell.exe', psArgs(runTreeScript(pid)));
  if (gone()) return { ok: true, ended: [], gone: true }; // it exited while the table was asked: its pid is free now
  const snap = r && r.ok && r.out ? parseRunTree(r.out) : null;
  if (!snap) return { ok: false, ended: [], why: 'the system did not say which processes run' };
  const top = snap.procs.get(pid);
  // A live run (endRoot) kept Node's own start, compared within SAME_WITHIN. A leftover after a crash (no endRoot) kept
  // the system's own start (startOfIdent: Process.StartTime to whole ms), so its root is the run's only when the table's
  // CreationDate is that start or 1 ms above it (END_SAME_MS, as the end call compares): a program that got the number
  // later, also within SAME_WITHIN, is another, and nothing below it is the run's. Refused before any end call.
  const notSame = (t) => (endRoot ? Math.abs(t - start) > SAME_WITHIN : t - start < 0 || t - start > END_SAME_MS);
  if (Number.isFinite(start) && top && top.start !== null && notSame(top.start)) {
    return { ok: false, ended: [], why: `process ${pid} is not the one the run started (it started at another time): nothing was ended` };
  }
  // Not in the table: it has ended (`missing`). Only a first try counts that as ok; after a try that failed, what
  // that try left below it may still run, and is not found from that pid any more (endTree).
  if (!top) return { ok: true, ended: [], missing: true };
  const tree = runTreeOf(snap, pid, self);
  // In the table but refused (its owner not read or another's, its start not known, this process below it): nothing
  // is ended, and it is never "ended" either.
  if (!tree.includes(pid)) return { ok: false, ended: [], why: `process ${pid} of the run could not be checked: nothing was ended` };
  const ended = [];
  const failed = [];
  // A process that could not be ended keeps every process above it in the tree, the run's own (`pid`) too: from
  // that pid the next try still finds it (a process whose parent has gone is found from nowhere).
  const keep = new Set();
  const keepAbove = (x) => {
    for (let q = snap.procs.get(x)?.ppid, i = 0; i < 64 && tree.includes(q) && !keep.has(q); q = snap.procs.get(q)?.ppid, i++) keep.add(q);
  };
  // A child that could not be checked is not ended, and keeps what is above it as one that failed does.
  const unchecked = (tree.refused || []).map((x) => x.pid);
  for (const x of unchecked) keepAbove(x);
  // The lowest first, in one call: each compared by its start with the table's, while the call holds it, and ended
  // only then (endBelowScript). One that has exited is "gone": nothing ended, no failure. One that answers "other
  // start" is never ended either (it may be another program that has its number now), and what is above it is still
  // ended (a number handed out again must not keep the run's own tree alive); but it is not proven gone: the two
  // readings of one start may differ, and then it is the run's own tool, still running. So the end fails, naming it.
  const other = [];
  const otherWhy = () => `process ${other.slice(0, 3).join(', ')} answered with another start than the table's: it may be another program now; it was not ended`;
  // What this try could not end or prove gone, each with the start the table showed (its root aside: a next try
  // finds the root again). endTree hands it to the second try (`first`).
  const leftOf = () => [...new Set([...failed, ...other, ...unchecked, ...keep])].filter((x) => x !== pid).map((x) => ({ pid: x, start: snap.procs.get(x)?.start ?? null }));
  const fail = (why) => ({ ok: false, ended, why: other.length ? `${why}; ${otherWhy()}` : why, left: leftOf() });
  // A second try: what the first could not end and this one no longer finds below the run (its parent has exited, and
  // a child of a dead parent keeps naming it) but that still runs at the start the first try saw. While one does,
  // this try is not ok, whatever it ended: the run's tool, or a program it started, may still be running.
  const lostRunning = () => (Array.isArray(first) ? first : []).filter((x) => x && !tree.includes(x.pid) && snap.procs.has(x.pid) && (x.start === null || snap.procs.get(x.pid).start === x.start)).map((x) => x.pid);
  const below = [...tree].reverse().filter((x) => x !== pid && !keep.has(x));
  // The root (cmd.exe of the npm shim) is ended last, and never by taskkill. A live run hands `endRoot`: the end
  // through the run's own child handle (Node's child.kill() is TerminateProcess on the handle Node holds, so that
  // number cannot be handed out again meanwhile). A leftover after a crash has no handle: its root goes into the same
  // end call, LAST, with the start the run kept, and is ended there only when the start read now is that one, by the
  // same one-sided compare as a child (END_SAME_MS), not within SAME_WITHIN: the kept start is the system's
  // (src/procid.mjs creationScript: Process.StartTime to whole ms), read the way the end call reads it, so the two are
  // equal; SAME_WITHIN is the margin for Node's own start against the system's, and would end a program that got the
  // number up to 3 s later. Without a kept start, the table's is used, as for a child. A root kept by a child that
  // failed is "kept" in that call (the script keeps what is above a failure), and one kept here is not in it.
  const rootLast = !endRoot && !keep.has(pid);
  const asked = rootLast ? [...below, pid] : below;
  let rootSaid = null;
  if (asked.length) {
    if (gone()) {
      // The run exited first: what is below it was not ended.
      if (!unchecked.length && below.length) return { ok: false, ended, why: `process ${below.slice(0, 3).join(', ')} below the run was not ended: the run exited first` };
    } else {
      const rootStart = Number.isInteger(start) && start >= 0 ? start : top.start;
      const entries = asked.map((x) => ({ pid: x, start: x === pid ? rootStart : snap.procs.get(x).start, ppid: snap.procs.get(x).ppid }));
      const k = await run('powershell.exe', psArgs(endBelowScript(entries)));
      const said = parseEndLines(k && k.ok !== false ? k.out : '', asked);
      // Only "ended", "gone" and "other start" keep nothing above them. Any other answer ("failed", "kept", no line,
      // another word) is not ended: it keeps what is above it, the root too, and the end fails.
      for (const x of below) {
        const s = said.get(x);
        if (s === 'ended') ended.push(x);
        else if (s === 'other start') other.push(x);
        else if (s !== 'gone') {
          failed.push(x);
          keepAbove(x);
        }
      }
      if (rootLast) rootSaid = said.get(pid);
    }
  }
  if (rootSaid === 'ended') ended.push(pid);
  else if (rootSaid === 'other start') other.push(pid);
  if (failed.length) return fail(`process ${failed.slice(0, 3).join(', ')} could not be ended`);
  if (unchecked.length) return fail(`process ${unchecked.slice(0, 3).join(', ')} below the run could not be checked`);
  if (rootLast && rootSaid !== null && rootSaid !== 'ended' && rootSaid !== 'gone' && rootSaid !== 'other start') return fail(`process ${pid} could not be ended`);
  if (endRoot && !gone()) {
    let k = false;
    try {
      k = await endRoot();
    } catch {
      k = false;
    }
    if (k === true) ended.push(pid);
    else if (await exitedSoon(gone)) ended.push(pid); // it exited meanwhile, or Node saw its exit late: ended
    else return fail(`process ${pid} could not be ended`);
  }
  const lost = lostRunning();
  if (lost.length) return fail(`process ${lost.slice(0, 3).join(', ')} that the first try could not end still runs and is not found from the run any more`);
  if (other.length) return { ok: false, ended, why: otherWhy(), left: leftOf() };
  return { ok: true, ended };
}

/**
 * End the coding tool started as `pid` (a group leader) and everything it started: SIGTERM now, SIGKILL after `grace`
 * ms, to its group and to each process below it (one that made a group of its own too; found before the tool goes,
 * since its children then belong to init). On Windows a child does not end with its parent (an npm install starts
 * cmd.exe, and Claude Code is its child): the run's tree is ended at once, each process alone (endWinTree, or
 * `killTree` a test hands in). Windows → a promise of { ok, why } (ok: false, the tool may still be running).
 */
function endTree(pid, grace, { platform = process.platform, killTree = null, run = runWin, gone, start = null, endRoot = null } = {}) {
  if (platform === 'win32') {
    if (!Number.isInteger(pid) || pid <= 4) return Promise.resolve({ ok: true });
    const once = (first = []) => {
      try {
        return Promise.resolve(killTree ? killTree(pid, gone, start) : endWinTree(pid, { run, gone, start, endRoot, first })).then((x) => x || { ok: true }, (e) => ({ ok: false, why: String(e && e.message) }));
      } catch (e) {
        return Promise.resolve({ ok: false, why: String(e && e.message) });
      }
    };
    // Tried once more when it fails; never the lone pid instead (cmd.exe alone: Claude Code below it would go on). A
    // second try that ends nothing because the run is gone, or no longer finds its pid in the table, says nothing of
    // what the first one left: the first one's failure stays. When both tries fail but the second fails for its own
    // reason (it could not read the table, say), it names none of the pids the first try named; those are kept in the
    // reason, so the pid that may still run is never lost.
    const keepPids = (now, first) => {
      const has = new Set(String(now.why || '').match(/\d+/g) || []);
      const lost = [...new Set(String(first.why || '').match(/\d+/g) || [])].filter((n) => !has.has(n));
      return lost.length ? { ...now, why: `${now.why}; the first try left process ${lost.join(', ')} unended` } : now;
    };
    // The second try is handed what the first left (`first`), so a smaller tree it ends is not taken as the whole one.
    return once().then((r) => (r.ok ? r : once(r.left || []).then((r2) => (r2.ok ? (r2.gone || r2.missing ? r : r2) : keepPids(r2, r)))));
  }
  const below = descendants(pid);
  signal(pid, 'SIGTERM', true);
  for (const d of below) signal(d, 'SIGTERM', false);
  setTimeout(() => {
    signal(pid, 'SIGKILL', true);
    for (const d of [...below, ...descendants(pid)]) signal(d, 'SIGKILL', false);
  }, grace).unref?.();
}

/**
 * o: { config(), places() (stand-ins), run (git), now(), log, settings() → { atOnce }, resolveEnv(provider) → env,
 * command: { command, args } (a stand-in coding tool: the arguments go after its own), notify({ title, message }),
 * record({ did, outcome }) (the activity log), killGraceMs, defaultProvider(dir, last, tool) (a run that names none),
 * scheduleOff(id, why) → the schedule's name when it was switched off, else null (src/automation index.mjs switchOff);
 * for tests: platform, exists (toolPlan's), spawn, killTree(pid) (Windows' end of a tree), winRun(cmd, args) →
 * { ok, out } (the program of Windows' end of a tree: PowerShell only), ident (src/procid.mjs) }.
 */
export function aloneRunner(o) {
  const platform = o.platform || process.platform;
  const ident = o.ident || procIdent;
  const endRun = (pid, gone, start = null, endRoot = null) => endTree(pid, o.killGraceMs ?? KILL_GRACE_MS, { platform, killTree: o.killTree, run: o.winRun, gone, start, endRoot });
  const cfg = () => (o.config ? o.config() : {});
  const places = () => (o.places ? o.places() : {});
  const run = o.run || capture;
  const now = o.now || (() => new Date());
  const log = o.log || (() => {});
  const notify = o.notify || (() => {});
  const record = o.record || (() => {});
  const place = () => resolvePlace(cfg(), places());
  const projectsDir = () => places().projects || projectsIn(cfg());
  const me = () => writerId();
  const live = new Map(); // run id → { child, project, timer }
  // Runs being started: checked and claimed in one step with no await between (startAlone), counted with the running
  // ones, so runs started at the same moment cannot all pass the limits before any of them has written its record.
  const claims = new Map(); // claim → { project, branch } (the branch asked for)
  // Worktrees being removed ("Done with it"), for the whole time of the removal: a start on that branch waits for it.
  const releasing = new Map(); // mark → { project, branch }
  const waitFile = () => path.join(stateDir(), 'work-alone', 'waiting.json');
  let closed = false;

  /** Why nothing a schedule asked for starts now (the owner's switches), or null. */
  const switchedOff = () => {
    const st = o.settings ? o.settings() || {} : {};
    if (st.paused === true) return 'the automations of this computer are paused';
    if (st.enabled === false) return 'schedules are off on this computer';
    return null;
  };
  /** Why a waiting entry is no longer wanted (its schedule or its item's run time is gone), or null. */
  const goneWhy = (w) => {
    const job = isObj(w.job) ? w.job : {};
    if (job.by === 'owner') return null;
    if (job.item) {
      if (!job.fromRunAt) return null; // asked for without a run time: nothing of it can go
      try {
        const raw = findItem(readDoc(place().file).doc, job.item);
        return isObj(raw.work) && isObj(raw.work.at) ? null : 'the task has no run time any more';
      } catch {
        return 'the task is not in the list any more';
      }
    }
    const list = (o.settings ? o.settings() || {} : {}).list;
    if (job.remote || !Array.isArray(list) || !isObj(job.schedule)) return null;
    return list.some((x) => isObj(x) && x.id === job.schedule.id) ? null : 'its schedule is gone';
  };

  /**
   * Windows: a schedule's run whose coding tool may still be running in `project` (`why`: what could not be ended)
   * switches that schedule off, as the owner's own switch does it, so its next slot does not start there meanwhile.
   * → the schedule's name when it was switched off (stillReason then ends the reason with it), else null (no
   * schedule, off already, or not Windows).
   */
  async function offWords(id, project, why) {
    if (platform !== 'win32' || !id || !o.scheduleOff) return null;
    try {
      // The Activity line keeps ACTIVITY_MAX characters after "off: ": a long detail is cut, never the instruction.
      const pre = `a program of its last run may still be running in ${project} (it could not be ended: `;
      const post = '); switch it on again in Work → Schedules once that program has ended';
      const name = await o.scheduleOff(id, `${pre}${fitTo(why, ACTIVITY_MAX - 'off: '.length - pre.length - post.length)}${post}`);
      return name || null;
    } catch (e) {
      log(`the schedule of a run by itself could not be switched off: ${e.message}`);
      return null;
    }
  }

  const atOnce = () => {
    const n = Number((o.settings ? o.settings() : {}).atOnce);
    return Number.isInteger(n) && n >= 1 && n <= AT_ONCE_MAX ? n : 1;
  };
  const projectDir = (name) => {
    const dir = projectsByName(projectsDir()).get(name);
    if (!dir) throw fail(400, `"${String(name).slice(0, 100)}" is not a project of the workspace`, 'no-project');
    return dir;
  };

  const readWaiting = () => {
    try {
      const d = JSON.parse(fs.readFileSync(waitFile(), 'utf8'));
      return Array.isArray(d) ? d.filter(isObj) : [];
    } catch {
      return [];
    }
  };
  const writeWaiting = (list) => {
    fs.mkdirSync(path.dirname(waitFile()), { recursive: true, mode: 0o700 });
    const tmp = `${waitFile()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(list.slice(0, WAITING_MAX))}\n`, { mode: 0o600 });
    fs.renameSync(tmp, waitFile());
  };

  /** The job checked and made whole: what the run will be. Throws with a plain sentence. */
  function check(job) {
    if (!isObj(job)) throw fail(400, 'say what the run does');
    // "mission": a task of a mission (src/mission), started by its code within the owner's switches and limits.
    // "look": a look of Tia's that only reads (src/operator/look.mjs), started by her within the owner's switch and caps.
    const by = job.by === 'owner' ? 'owner' : hers(job) ? job.by : 'schedule';
    const mine = hers({ by });
    if (by === 'look' && (job.item || job.review || job.commit)) throw fail(400, 'a look belongs to an item of the Operator, and it changes nothing');
    // A mission's review: another run on the same branch while the task waits in review; it changes no status.
    const review = by === 'mission' && job.review === true;
    const p = place();
    let raw = null;
    let ref = null;
    if (job.item) {
      ref = typeof job.item === 'string' ? job.item : job.item;
      const { doc } = readDoc(p.file);
      raw = findItem(doc, ref);
      const st = statusOf(raw);
      if (CLOSED.has(st)) throw fail(409, `"${raw.id}" is ${st}`, 'closed');
      if (st === 'review' && !review) throw fail(409, `"${raw.id}" waits for your review`, 'review');
      if (st === 'doing') throw fail(409, `a session works on "${raw.id}" already`, 'doing');
      // Another program's words: only the owner starts such a task (Do it, or his yes on Tia's card), never a schedule.
      if (fromOf(raw)) throw fail(409, `"${raw.id}" came from another program (${fromOf(raw).name}): it runs only when you start it`, 'from-program');
      const waits = (Array.isArray(raw.after) ? raw.after : []).filter((a) => !(doc.items || []).some((x) => isObj(x) && x.id === a && WAIT_OVER.includes(statusOf(x))));
      if (waits.length) throw fail(409, `"${raw.id}" waits for ${waits.slice(0, 3).map((a) => `"${a}"`).join(', ')}`, 'waits');
    }
    const id = raw ? raw.id : by === 'look' ? isObj(job.look) && job.look.id : job.schedule && job.schedule.id;
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail(400, 'a run that ends by itself belongs to an item or a schedule');
    const work = raw && isObj(raw.work) ? raw.work : {};
    const at = isObj(work.at) ? work.at : {};
    const project = job.project || (raw && typeof raw.project === 'string' ? raw.project : null);
    if (!project) throw fail(400, 'choose the project it runs in', 'no-project');
    const folder = cleanFolder(job.folder ?? '.');
    if (!folder) throw fail(400, 'choose the project\'s own folder or one of its code repositories');
    const prompt = checkBrief(job.prompt ?? (raw ? briefOf(raw) : ''));
    // The mode comes from this computer's own choice (a schedule of its settings), never from the shared Work file.
    const mode = job.mode ?? 'manual';
    if (!PERMISSION_MODES.includes(mode)) throw fail(400, `the permission mode is one of: ${PERMISSION_MODES.join(', ')}`);
    const model = job.model ?? at.model ?? null;
    if (model !== null && (typeof model !== 'string' || !MODEL_RE.test(model))) throw fail(400, 'the model is a model name such as sonnet or claude-sonnet-5-5');
    const effort = job.effort ?? at.effort ?? null;
    if (effort !== null && !EFFORTS.includes(effort)) throw fail(400, `the effort is one of: ${EFFORTS.join(', ')}`);
    // Left out (a task's run time set on the page): the folder's default provider, as Do it takes it (startAlone).
    const provider = job.provider ?? at.provider ?? null;
    if (provider !== null && (typeof provider !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider))) throw fail(400, 'choose the provider it runs on');
    const minutes = checkMinutes(job.minutes ?? at.minutes);
    const tell = (job.tell ?? at.tell) === 'always' ? 'always' : 'news';
    const title = raw ? String(raw.title || raw.id) : by === 'look' ? String(job.look.label || `A look at ${id}`) : String((job.schedule && job.schedule.label) || `Schedule ${id}`);
    // A role's tools come only from a mission's own code (its role file), never from the shared Work file.
    const toolList = (v) => (mine && Array.isArray(v) && v.length <= 40 && v.every((x) => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_]*(\([^()\r\n,]{1,80}\))?$/.test(x)) ? [...v] : null);
    const allowed = toolList(job.allowed);
    const denied = toolList(job.denied);
    // A mission's run is always restricted: the closed list of its role's tools (plain names, no shell line).
    const restricted = mine && Array.isArray(job.restricted) && job.restricted.length && job.restricted.length <= 10 && job.restricted.every((x) => typeof x === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(x)) ? [...job.restricted] : null;
    if (mine && !restricted) throw fail(400, 'a session Tia starts by herself is always restricted: its tools are missing');
    if (by === 'look' && !restricted.every((x) => LOOK_TOOLS.includes(x))) throw fail(400, `a look only reads: its tools are ${LOOK_TOOLS.join(', ')}`);
    // The dashboard commits what such a run changed (it has no git); a review commits nothing.
    const commit = by === 'mission' && job.commit === true && !review;
    // Folders of the dashboard's own state the session may also read (never one outside it).
    const inState = (d) => typeof d === 'string' && path.isAbsolute(d) && path.resolve(d).startsWith(`${path.resolve(stateDir())}${path.sep}`) && fs.existsSync(d);
    const dirs = mine && Array.isArray(job.dirs) && job.dirs.length <= 2 && job.dirs.every(inState) ? job.dirs.map((d) => path.resolve(d)) : null;
    // A mission's work or fix run whose role's check is its tests may get the one tool of the box (its token made for
    // this session by the mission's own code); onEnd: what the mission does first when the session has ended. A look
    // never gets it: only a mission's run.
    const isTool = (t) => isObj(t) && Object.keys(t).every((k) => ['url', 'token', 'kinds'].includes(k)) && typeof t.url === 'string' && TOOL_URL_RE.test(t.url) && typeof t.token === 'string' && TOOL_TOKEN_RE.test(t.token) && boxKinds(t.kinds) !== null;
    const tool = by === 'mission' && !review && restricted && isTool(job.tool) ? { url: job.tool.url, token: job.tool.token, kinds: boxKinds(job.tool.kinds) } : null;
    const onEnd = by === 'mission' && typeof job.onEnd === 'function' ? job.onEnd : null;
    const budget = mine && typeof job.budget === 'number' && Number.isFinite(job.budget) && job.budget > 0 && job.budget <= 10_000 ? Math.round(job.budget * 100) / 100 : null;
    return { by, review, allowed, denied, restricted, commit, dirs, tool, onEnd, budget, p, ref, raw, id, project, folder, prompt, mode, model, effort, provider, minutes, tell, title, schedule: job.schedule ? job.schedule.id : null };
  }

  const runningHere = () => listRuns(place()).filter((r) => r.state === 'running' && r.writer === me() && endsByItself(r));

  /**
   * THE door (also for Tia's Auto later): start a run that ends by itself, its limits checked here. job: { item? ({ id,
   * at } or an id: its brief, project and `work.at` choices), schedule? ({ id, label }), project?, folder?, prompt?,
   * provider?, model?, effort?, mode?, minutes?, tell?, by? ('owner' | 'schedule') }. → { run } | { waiting: true,
   * why } | { dryRun, would } with `dryRun`.
   */
  async function startAlone(job, { dryRun = false, fromWaiting = false, since = null } = {}) {
    if (closed) throw fail(503, 'the dashboard is stopping');
    const j = check(job);
    const off = j.by === 'schedule' ? switchedOff() : null;
    if (off) throw fail(409, `${off}: nothing a schedule asks for starts`, 'switched-off');
    const pdir = projectDir(j.project);
    const dir = folderOf(pdir, j.folder);
    const top = await repoTop(dir, run);
    if (!top) throw fail(409, `${j.project} is not a git repository: a run that ends by itself works on a branch of its own, so it needs one`, 'not-git');
    if (!j.provider) j.provider = o.defaultProvider ? await o.defaultProvider(dir, null, 'claude') : null;
    if (!j.provider) throw fail(400, 'there is no provider for Claude Code yet: add one under Providers, or choose one for this run', 'no-provider');
    const branch = branchOf(j.id);
    const would = { id: j.id, project: j.project, folder: j.folder, branch, provider: j.provider, model: j.model, effort: j.effort, mode: j.mode, minutes: j.minutes, tell: j.tell };
    if (dryRun) return { dryRun: true, would };
    // stopped while it looked at git: nothing starts now (a drain puts its entry back)
    if (closed) throw fail(503, 'the dashboard is stopping');
    const busy = [...runningHere().map((x) => ({ project: x.project })), ...[...claims.values()].map((c) => ({ project: c.project }))];
    const freeing = [...releasing.values()].some((x) => x.project === j.project && x.branch === branch);
    // "Start nothing new" (a hold of Tia's while the computer was overloaded): the run waits, and starts once it ends.
    const held = heldUntil();
    // The one measure of slots: these runs and every other session that runs by itself here (a Lead chat's parts).
    const taken = busy.length + (o.othersRunning ? Number(o.othersRunning()) || 0 : 0);
    const still = [...claims.values()].find((c) => c.still && c.project === j.project);
    const why = held ? holdWords(held) : still ? `the coding tool of an earlier run of ${j.project} may still be running in ${still.branch}` : busy.some((r) => r.project === j.project) ? `another run of ${j.project} works now` : freeing ? `the worktree of ${branch} is being removed now` : taken >= atOnce() ? `${taken} run${taken === 1 ? '' : 's'} by ${taken === 1 ? 'itself works' : 'themselves work'} now (at most ${atOnce()} at once)` : null;
    // A mission keeps its own place (its file): it is told why, and nothing of it waits in this dashboard's list.
    if (why && hers(j)) return { waiting: true, why };
    if (why) {
      const list = readWaiting();
      if (!list.some((w) => w.key === `${j.id}`)) {
        const fromRunAt = !!(j.raw && isObj(j.raw.work) && isObj(j.raw.work.at));
        // put back by a drain: it keeps the time it began to wait (the automations' tick drains every round)
        list.push({ key: j.id, job: { ...job, item: j.ref ? (typeof j.ref === 'string' ? j.ref : j.ref.id) : undefined, ...(fromRunAt ? { fromRunAt } : {}) }, at: since || now().toISOString(), why });
        writeWaiting(list);
        if (!fromWaiting) record({ did: `"${j.title}" waits to run`, outcome: `waits: ${why}` });
      }
      return { waiting: true, why };
    }
    const claim = Symbol(j.id);
    claims.set(claim, { project: j.project, branch });
    try {
      return await begun(j, top, dir, branch);
    } finally {
      claims.delete(claim);
    }
  }

  /** The run of a checked job whose place is claimed: its worktree, its record, the coding tool. */
  async function begun(j, top, dir, asked) {
    const tree = await treeFor(top, asked, { run });
    const branch = tree.branch; // work/<id>, or a free name when the owner has a branch of that name
    // Every branch and tag at the start: one the run moved besides its own is always told (settle).
    j.refs = { top, at: await refsOf(top, run), own: `refs/heads/${branch}` };
    // The folder inside the repository the run works in (a project's own folder may be the repository itself).
    const inTree = path.join(tree.dir, path.relative(top, fs.realpathSync(dir)));
    const repos = [{ repo: j.folder, dir: inTree }];
    const r = {
      v: 1, id: newRunId(now()), item: j.id, title: words(j.title, 200, inTree).replace(/\s+/g, ' '), writer: me(), by: j.by,
      startedAt: now().toISOString(), endedAt: null, project: j.project, folder: j.folder, tool: 'claude', provider: j.provider, model: j.model, effort: j.effort,
      session: null, conversation: null, message: null, brief: words(j.prompt, 4000, inTree), state: 'running', reason: null, answer: '',
      commits: [], changed: [], more: 0, was: j.raw && statusOf(j.raw) === 'waiting' ? 'waiting' : 'open', statusError: null, branch, schedule: j.schedule,
    };
    keepStart(r.id, { start: await headsOf(repos, run), ...(await dirtyOf(repos, { run })) });
    await withLock(j.p.file, async () => {
      writeRun(j.p, r);
      if (j.raw && !j.review) {
        r.statusError = await itemStatus(j.p, j.raw.id, 'doing', null);
        if (r.statusError) writeRun(j.p, r);
      }
    });
    let env;
    try {
      env = o.resolveEnv ? await o.resolveEnv(j.provider) : (await import('../assistant/engine.mjs')).providerEnv(j.provider);
      env = await env;
    } catch (e) {
      return { run: await settle(r, j, repos, { state: 'failed', reason: `The run did not start: ${e.message}`, answer: '', refused: [] }) };
    }
    // A restricted run is never started unrestricted instead: without the mode in the installed coding tool it does not start.
    if (j.restricted) {
      let known = false;
      try {
        known = o.restrictedKnown ? await o.restrictedKnown(env) : o.command ? true : await restrictedKnown({ ...(cfg().claudeBin ? { bin: cfg().claudeBin } : {}), env, run });
      } catch {
        known = false;
      }
      if (!known) return { run: await settle(r, j, repos, { state: 'failed', reason: 'The run did not start: the Claude Code on this computer does not know the restricted mode such a run must have. Update Claude Code (Updates), then it can start', answer: '', refused: [] }) };
    }
    // The worktree's own git entry as the dashboard made it: compared again before the dashboard commits there.
    const gitEntry = j.commit ? gitEntryOf(tree.dir) : null;
    const args = aloneArgs({ mode: j.mode, model: j.model, effort: j.effort, allowed: j.allowed, denied: j.denied, budget: j.budget, restricted: j.restricted, dirs: j.dirs, tool: j.tool });
    // A look answers with its finding only (src/operator/look.mjs parses it strictly): no report is asked of it.
    const prompt = j.by === 'look' ? j.prompt : `${j.prompt}\n\n${ALONE_ASK}`;
    const plan = o.command ? { command: o.command.command, args: [...o.command.args, ...args], options: {} } : toolPlan(cfg().claudeBin || 'claude', args, { env, platform, exists: o.exists });
    // Work's own door starts a mission's run and a look as Tia's (hers(j), HERS). Each goes through the ONE startAsHers,
    // which both MARKS the run hers and SIGNS the session in to git with the
    // token the owner chose in place of his own; endAsHers removes the mark when the session ends. With no sign-in file
    // chosen the sign-in is his, as today; with a chosen file that cannot be read his git tokens are taken out (the run
    // then reaches no git sign-in, never his full rights). The mark is keyed to this run's record id, in the state
    // folder a session cannot write.
    const herRunFile = hers(j) ? path.join(stateDir(), 'work-runs', `${r.id}.json`) : null;
    if (herRunFile) {
      env = startAsHers(herRunFile, env, { cfg: cfg(), credsDir: credsDir(), onProblem: (why) => log(`Tia's git sign-in could not be used (${why}); this run signs in to git with no token until the file is fixed`) });
    }
    let child;
    try {
      // noHooksEnv: an allowed `git commit` of the session runs no repository hook (a program the owner did not ask it to start).
      child = (o.spawn || spawn)(plan.command, plan.args, { cwd: inTree, env: { ...env, ...noHooksEnv(env), HOPRIG_RUN_FILE: '' }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, ...plan.options });
      child.stdin.on('error', () => {}); // a tool that ends before it reads its prompt: its end says why
      child.stdin.end(prompt);
    } catch (e) {
      if (herRunFile) endAsHers(herRunFile);
      return { run: await settle(r, j, repos, { state: 'failed', reason: `The run did not start: ${e.message}`, answer: '', refused: [] }) };
    }
    // Windows hands a pid out again once its process has exited: from then on that number may be another program's,
    // and its tree is not this run's. So once the child has exited, nothing is ended by its pid there (the time limit,
    // a stop, the dashboard's stop, a first line read late).
    let exited = false;
    const gone = () => exited || typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
    // Windows: an end that failed twice is said plainly in the log and in the run's reason (notEnded: why).
    let notEnded = null;
    let ending = null;
    let keptIdent = null; // the identity keepProc kept: its start is compared with the table's (endWinTree)
    let settleNow = null; // the run's end without its close (set below)
    let childClosed = false;
    const endChild = () => {
      if (platform === 'win32' && gone()) return;
      // Windows: the root (the process the run started) is ended last through this child's own handle: Node's kill()
      // is TerminateProcess on the handle it holds, so its number cannot have gone to another program meanwhile.
      const p = endRun(child.pid, gone, startOfIdent(keptIdent), platform === 'win32' ? () => child.kill('SIGKILL') === true : null);
      if (p && typeof p.then === 'function') {
        ending = p.then((x) => {
          if (x && !x.ok) {
            notEnded = String(x.why || 'the system did not say why').slice(0, 200);
            log(`a run by itself (${r.id}) could not end its coding tool: ${notEnded}. ${MAY_STILL_RUN}`);
            // Windows: what could not be ended may run on for ever, and with it the run's process: the run is
            // settled now, its reason saying its tool may still be running (its close later changes nothing).
            if (!gone() && settleNow) setImmediate(settleNow);
          }
        });
      }
    };
    const lines = [];
    let buf = '';
    let err = '';
    // A restricted run's own first line (the coding tool says which tools, tool servers and mode the session has)
    // is read before anything it does counts: any other tool, a tool server or bypass ends the session at once.
    const firstLine = { seen: false, wrong: null };
    const startedRestricted = (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (!m || m.type !== 'system' || m.subtype !== 'init') return;
      firstLine.seen = true;
      // With the one tool of the box: exactly that one server of the product's, and its one tool besides the role's.
      const own = j.tool ? [...j.restricted, ...boxToolNames(j.tool.kinds)] : j.restricted;
      const other = Array.isArray(m.tools) ? m.tools.filter((t) => !own.includes(t)) : null;
      const list = Array.isArray(m.mcp_servers) ? m.mcp_servers : [];
      const servers = j.tool && list.length === 1 && list[0] && list[0].name === TOOL_SERVER_NAME ? 0 : list.length;
      const said = [
        ...(other === null ? ['it did not say which tools it had'] : other.length ? [`it had ${other.slice(0, 5).join(', ')}`] : []),
        ...(servers ? [`it had ${servers} tool server${servers === 1 ? '' : 's'}`] : []),
        ...(m.permissionMode === 'bypassPermissions' ? ['it ran in bypass mode'] : []),
      ];
      if (!said.length) return;
      firstLine.wrong = said.join('; ').replace(/[^\x20-\x7e]/g, ' ').slice(0, 200);
      endChild();
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (j.restricted && !firstLine.seen) startedRestricted(lines[lines.length - 1]);
        if (lines.length > 20_000) lines.splice(0, 10_000);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => (err = (err + d).slice(-1000)));
    const entry = { child, project: j.project, timedOut: false, timer: null, done: null, end: null };
    // The process and when it started, so a dashboard that crashed ends it at its next start (settleLeftovers).
    const keepProc = (after = 0) => {
      try {
        const id = ident.of([child.pid], { after }).get(child.pid);
        if (id) {
          keptIdent = id;
          keepStart(r.id, { ...readStart(r.id), proc: { pid: child.pid, ident: id } });
        }
      } catch {
        /* not known on this system: settleLeftovers cannot end it, and says nothing of it */
      }
    };
    // Windows asks PowerShell, and the dashboard asks it in the background (src/procid.mjs askInBackground), so an
    // answer read at once is "not known" and the run's process was never kept: asked without waiting (refresh), and
    // kept once that answer is there, while the run still works.
    if (platform === 'win32') {
      Promise.resolve().then(() => ident.refresh([child.pid])).catch(() => 0).then((at) => {
        if (live.get(r.id) === entry) keepProc(at || 0);
      });
    } else keepProc();
    entry.end = endChild;
    entry.timer = setTimeout(() => {
      entry.timedOut = true;
      entry.end();
    }, j.minutes * 60_000 * (o.minuteMs ? o.minuteMs / 60_000 : 1));
    entry.timer.unref?.();
    live.set(r.id, entry);
    entry.done = new Promise((resolve) => {
      child.on('error', (e) => (err = `${err}\n${e.message}`));
      // A process the tool started that keeps its output open (in a group of its own) must not keep the run
      // running: a short while after the tool itself is gone, its output is closed and the run settles.
      child.on('exit', () => {
        exited = true;
        if (platform === 'win32') clearTimeout(entry.timer); // its time limit would end a pid that is free now
        setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, EXIT_WAIT_MS).unref?.();
      });
      let settling = false;
      const finish = async (code) => {
        if (settling) return;
        settling = true;
        clearTimeout(entry.timer);
        if (herRunFile) endAsHers(herRunFile); // the session has ended: its Tia mark goes
        // The mission's own first step at the session's end (its tool's token dies, a run of its tests ends) comes
        // before anything is read or committed from the worktree.
        if (j.onEnd) {
          try {
            await j.onEnd();
          } catch {
            /* the run is settled all the same */
          }
        }
        if (buf.trim()) lines.push(buf);
        const s = readStream(lines);
        let end;
        const used = s.result ? s.result.used : null;
        if (firstLine.wrong) end = { state: 'failed', reason: `It was ended at once: it did not start restricted (${firstLine.wrong}). Nothing it did counts`, answer: '', refused: [] };
        else if (j.restricted && !firstLine.seen && s.result && s.result.ok) end = { state: 'failed', reason: 'The coding tool never said which tools the session had, so its result does not count', answer: '', refused: [] };
        else if (entry.stoppedBy) end = { state: 'stopped', reason: entry.stoppedBy, answer: s.text, refused: s.result ? s.result.refused : [] };
        else if (entry.timedOut) end = { state: 'stopped', reason: `Stopped at the time limit (${j.minutes} minute${j.minutes === 1 ? '' : 's'}); what it had done so far is kept`, answer: s.text, refused: s.result ? s.result.refused : [] };
        else if (s.result && s.result.ok) end = { state: 'done', reason: null, answer: s.text, refused: s.result.refused };
        else if (s.result && s.result.limit) end = { state: 'limit', reason: 'The provider reached its usage limit', answer: s.text, refused: s.result.refused };
        else end = { state: 'failed', reason: `The run ended in an error: ${String((s.result && s.result.error) || err.trim().split('\n').pop() || `exit code ${code}`).replace(/\s+/g, ' ').slice(0, 300)}`, answer: s.text, refused: s.result ? s.result.refused : [] };
        end.used = used;
        if (ending) {
          // Two tries of a tree end can take longer than this wait: one not finished by then may have left the tool.
          const late = await Promise.race([ending.then(() => false), new Promise((res) => setTimeout(() => res(true), o.closeWaitMs ?? CLOSE_WAIT_MS).unref?.())]);
          if (late && !notEnded) notEnded = 'its end did not finish in time';
        }
        // A refused step is said after what could not be ended; a switched-off schedule's sentence comes last of all.
        const refusedWords = end.refused.length ? refusedSentence(end.refused) : '';
        if (notEnded) {
          const name = await offWords(j.schedule, j.project, notEnded);
          const head = `${end.reason ? `${end.reason}. ` : ''}${MAY_STILL_RUN} (it could not be ended: `;
          end.reason = stillReason(head, notEnded, refusedWords ? `. ${refusedWords}` : '', name);
        } else if (refusedWords) end.reason = `${end.reason ? `${end.reason}. ` : ''}${refusedWords}`;
        // A run that has no git: the dashboard itself commits what it changed, once it has ended by itself.
        if (j.commit && end.state === 'done') {
          let c;
          try {
            c = await commitRun(tree.dir, { message: String(r.title || j.id).slice(0, 200), gitEntry, run });
          } catch (e) {
            c = { ok: false, why: String(e.message).slice(0, 200) };
          }
          if (!c.ok) end.reason = `${end.reason ? `${end.reason}. ` : ''}What it changed is not committed: ${c.why}`;
          else if (c.skipped && c.skipped.length) end.reason = `${end.reason ? `${end.reason}. ` : ''}Left out of its commit (no file git can keep): ${c.skipped.slice(0, 3).join(', ')}`;
        }
        // Windows: settled while its tool may still run there (its child has not closed): its project and branch stay
        // claimed until that child closes, so no next run (a schedule's next slot) starts in that worktree meanwhile.
        if (platform === 'win32' && notEnded && !childClosed) {
          const hold = Symbol(r.id);
          claims.set(hold, { project: j.project, branch: asked, still: true });
          child.once('close', () => {
            claims.delete(hold);
            if (!closed) drain().catch((e) => log(`runs that end by themselves: ${e.message}`));
          });
        }
        live.delete(r.id);
        resolve(await settle(r, j, repos, end));
        drain();
      };
      child.once('close', () => (childClosed = true));
      child.once('close', finish);
      settleNow = () => finish(null);
    });
    return { run: viewRun(r, me()), done: entry.done };
  }

  const words = (s, max, tree = null) => cleanText(s, max, [...treePaths(tree), ...pathsOf({ projectsDir: projectsDir(), workspace: places().workspace || workspaceDir(cfg()) })]);
  const ctxOf = (p) => ({ today: todayIn(p.settings.timeZone, now()), ownerId: p.settings.ownerId, projects: [...projectsByName(projectsDir()).keys()] });

  /** The item's status for a run, under the file's lock (held by the caller). → null, or why it could not be written. */
  async function itemStatus(p, id, to, from) {
    try {
      await changeHeld(p.file, (doc) => {
        const item = findItem(doc, id);
        const st = statusOf(item);
        if ((from === null ? !CLOSED.has(st) : st === from) && st !== to) setStatus(doc, id, to, ctxOf(p));
      });
      return null;
    } catch (e) {
      return cleanText(`The task's status could not be changed: ${e.message}`, 400);
    }
  }

  /** The end of a run: what it left on its branch, the item's status, the final record; then "tell me". */
  async function settle(r, j, repos, end) {
    const p = j.p;
    let left = { commits: [], changed: [], more: 0 };
    const from = readStart(r.id);
    try {
      if (from) left = await leftIn(repos, from.start, { run, before: from.before, beforeCut: from.beforeCut, since: Date.parse(r.startedAt) });
    } catch (e) {
      log(`a run that ends by itself could not read its branch: ${e.message}`);
    }
    const tree = repos[0].dir;
    // A branch or tag other than its own that moved while it ran (a run allowed to use git can switch, reset or
    // delete): always news, named in the reason. The owner's own commit in his checkout moves a branch too, and so
    // does a pull of his: who moved it is not known (a run can work in his checkout as well), so each move is named
    // with its commits, for him to recognise his own.
    if (j.refs && j.refs.at) {
      const after = await refsOf(j.refs.top, run);
      if (after) {
        const keys = [...new Set([...j.refs.at.keys(), ...after.keys()])].filter((k) => k !== j.refs.own && j.refs.at.get(k) !== after.get(k));
        if (keys.length) {
          const said = await Promise.all(keys.slice(0, 5).map(async (k) => {
            const name = k.replace(/^refs\/(heads|tags)\//, '');
            const was = j.refs.at.get(k);
            const is = after.get(k);
            if (!is) return `${name} was deleted (it was at ${await commitWords(j.refs.top, was, run)})`;
            if (!was) return `${name} is new, at ${await commitWords(j.refs.top, is, run)}`;
            return `${name} moved from ${String(was).slice(0, 7)} to ${await commitWords(j.refs.top, is, run)}`;
          }));
          const list = said.join('; ') + (keys.length > 5 ? `; and ${keys.length - 5} more` : '');
          end = { ...end, before: end.reason || null, moved: said, movedText: `${keys.length === 1 ? 'A branch other than its own moved' : 'Branches other than its own moved'} while it ran, by the run or by you: ${list}`, reason: `${end.reason ? `${end.reason}. ` : ''}While it ran, ${keys.length === 1 ? 'a branch other than its own moved' : 'branches other than its own moved'} in the repository, by the run or by you: ${list}` };
        }
      }
    }
    let fin = null;
    await withLock(p.file, async () => {
      const cur = readRun(p, r.id) || r;
      fin = { ...cur, state: end.state, reason: end.reason ? words(end.reason, 400, tree) : null, answer: words(end.answer, 4000, tree), endedAt: now().toISOString(), commits: left.commits.map((c) => ({ ...c, subject: words(c.subject, 200, tree) })), changed: left.changed, more: left.more, ...(end.used ? { used: end.used } : {}) };
      if (j.raw && !j.review) fin.statusError = await itemStatus(p, j.raw.id, end.state === 'done' ? 'review' : fin.was, 'doing');
      try {
        fin = writeRun(p, fin);
      } catch (e) {
        log(`a run's final record was refused (${e.message}): written without its lists`);
        fin = writeRun(p, { ...fin, commits: [], changed: [], more: fin.more + fin.changed.length });
      }
    });
    dropStart(r.id);
    const news = hasNews(fin, end.refused) || !!(end.moved && end.moved.length);
    const refused = end.refused.length ? `a step needed an OK and was refused (${end.refused.join(', ')})` : null;
    const outcome = fin.state !== 'done' ? `${fin.state}: ${fin.reason || ''}`
      : refused ? `ok: ${refused}` : end.moved && end.moved.length ? `ok: another branch moved (${end.moved.join('; ')})` : news ? 'ok' : 'ok: nothing to report';
    // A look's answer is the session's own words and only its parsed finding counts (look.mjs): it is a card on the
    // Operator page, never a notification or a line of the automations' history.
    const look = j.by === 'look';
    if (!look) record({ did: `ran "${fin.title}" by itself on ${fin.branch}`, outcome: outcome.slice(0, 300) });
    if (!look && (news || j.tell === 'always')) {
      const head = fin.state === 'done' ? (refused ? `"${fin.title}" needs you` : `"${fin.title}" is done`) : fin.state === 'stopped' ? `"${fin.title}" stopped at its time limit` : `"${fin.title}" did not finish`;
      try {
        // A move first (his own commit is named there for him to recognise); the rest of the reason after it.
        const base = fin.reason || fin.answer.split('\n')[0] || `on the branch ${fin.branch}`;
        const message = end.movedText ? `${words(end.movedText, 400, tree)}${end.before ? `. ${words(end.before, 400, tree)}` : ''}` : base;
        await notify({ title: head, message: message.slice(0, 200) });
      } catch (e) {
        log(`a notification failed: ${e.message}`);
      }
    }
    // usage: what the tool reported for the turn, read from the run's own `used` (one record of it): a mission keeps it in its own file.
    return { ...viewRun(fin, me()), usage: end.used ? { cost: end.used.costUsd, tokens: tokensOf(end.used) } : null };
  }

  // One drain at a time: a run's end and the automations' tick may both ask, and two drains reading one list would
  // start an entry twice. A drain asked for while one works runs once more after it.
  let draining = null;
  let again = false;
  /** Start what waits, as places come free (oldest first); also when the owner switches back on (the tick calls it). */
  function drain() {
    if (draining) {
      again = true;
      return draining;
    }
    draining = (async () => {
      do {
        again = false;
        await drainOnce();
      } while (again && !closed);
    })().finally(() => (draining = null));
    return draining;
  }
  async function drainOnce() {
    if (closed) return;
    const list = readWaiting();
    if (!list.length) return;
    // Paused, or schedules off: what waits keeps its place and starts once he switches them back on.
    if (switchedOff() && list.every((w) => !isObj(w.job) || w.job.by !== 'owner')) return;
    // by the time each began to wait: one put back goes to the end of the file but keeps its time (startAlone since)
    for (const w of [...list].sort((x, y) => String(x.at).localeCompare(String(y.at)))) {
      if (closed) return; // the dashboard is stopping: what is left keeps its place for the next start
      if (isObj(w.job) && w.job.by !== 'owner' && switchedOff()) continue;
      const gone = goneWhy(w);
      const rest = readWaiting().filter((x) => x.key !== w.key);
      writeWaiting(rest);
      if (gone) {
        record({ did: `"${w.key}" no longer waits to run`, outcome: `dropped: ${gone}` });
        continue;
      }
      let r;
      try {
        r = await startAlone({ ...w.job, item: w.job.item ? { id: w.job.item } : undefined }, { fromWaiting: true, since: typeof w.at === 'string' ? w.at : null });
      } catch (e) {
        if (e.status === 503) {
          // the dashboard is stopping: back on the list with the time it began to wait, for the next start
          const back = readWaiting();
          if (!back.some((x) => x.key === w.key)) writeWaiting([...back, w]);
          return;
        }
        record({ did: `"${w.key}" did not run after waiting`, outcome: `failed: ${e.message}` });
        continue;
      }
      if (r.waiting) continue; // put back by startAlone, still waiting
    }
  }

  /** Runs this dashboard left running when it stopped (no process is left to settle them): stopped, with that reason. */
  async function settleLeftovers() {
    let p;
    try {
      p = place();
    } catch {
      return;
    }
    for (const r of listRuns(p)) {
      if (r.state !== 'running' || r.writer !== me() || !endsByItself(r) || live.has(r.id)) continue;
      // The coding tool may outlive a dashboard that crashed: ended first, when it is still that same process.
      const st = readStart(r.id);
      let still = null;
      if (st && st.proc) {
        // Windows: asked without holding the thread (refresh), then read from that answer.
        const after = platform === 'win32' ? await Promise.resolve().then(() => ident.refresh([st.proc.pid])).catch(() => 0) : 0;
        const nowId = ident.of([st.proc.pid], { after: after || 0 }).get(st.proc.pid);
        if (sameProcess(st.proc.ident, nowId) === true) {
          // Windows: the start kept goes with it, so that a pid handed out again since the identity answer is refused.
          const res = await endRun(st.proc.pid, undefined, platform === 'win32' ? startOfIdent(st.proc.ident) : null);
          if (res && !res.ok) {
            still = String(res.why || 'the system did not say why').slice(0, 200);
            log(`a run left by a dashboard that stopped was still working and could not be ended (${r.id}): ${still}. ${MAY_STILL_RUN}`);
          } else log(`a run left by a dashboard that stopped was still working: ended (${r.id})`);
        }
      }
      const offName = still ? await offWords(r.schedule, r.project, still) : null;
      await withLock(p.file, async () => {
        const cur = readRun(p, r.id);
        if (!cur || cur.state !== 'running') return;
        if (cur.item && ID_RE.test(cur.item)) await itemStatus(p, cur.item, cur.was, 'doing');
        const head = `The dashboard stopped while it ran. ${MAY_STILL_RUN} (it could not be ended: `;
        const base = still ? stillReason(head, still, '', offName) : 'The dashboard stopped while it ran';
        const reason = offName ? words(base, 400) : base; // a record's reason holds at most 400 characters
        writeRun(p, { ...cur, state: 'stopped', reason, endedAt: now().toISOString() });
      });
      dropStart(r.id);
    }
  }

  /** Accept a result of a run that ends by itself: its worktree goes when clean (the branch stays). → { removed, why? } | null. */
  async function released(itemId) {
    const r = listRuns(place(), { item: itemId }).find((x) => x.branch && x.writer === me());
    if (!r) return null;
    const top = await repoTop(folderOf(projectDir(r.project), r.folder), run);
    return top ? releaseTree(top, branchOf(r.item), { run }) : null; // its record's key: the name asked for (alonegit.mjs)
  }

  /** Done with a schedule's run (Activity): its worktree goes when clean, the branch stays. → { removed, why? }. */
  async function releaseRun(id) {
    const r = listRuns(place()).find((x) => x.id === id);
    if (!r || !r.branch || !r.schedule || r.writer !== me()) throw fail(404, 'there is no run of a schedule of this computer with that id', 'not-found');
    if (r.state === 'running') throw fail(409, 'the run still works', 'running');
    // The next slot of the schedule works in the same worktree (one per branch): never removed under it, nor under
    // one being started in that project now.
    const later = listRuns(place()).some((x) => x.id !== r.id && x.state === 'running' && x.project === r.project && x.branch === r.branch);
    if (later || [...claims.values()].some((c) => c.project === r.project && c.branch === branchOf(r.item))) throw fail(409, 'a later run of this schedule works in that worktree now: it stays until that run has ended', 'running');
    // From here to the end of the removal a start on that branch waits (startAlone), and starts after it (drain).
    const mark = Symbol(r.id);
    releasing.set(mark, { project: r.project, branch: branchOf(r.item) });
    try {
      const top = await repoTop(folderOf(projectDir(r.project), r.folder), run);
      return top ? await releaseTree(top, branchOf(r.item), { run }) : { removed: false, why: `${r.project} is not a git repository any more` };
    } finally {
      releasing.delete(mark);
      if (!closed) drain().catch((e) => log(`runs that end by themselves: ${e.message}`));
    }
  }

  /** A look's end: its worktree and its branch go (alonegit.mjs dropRunBranch). → { removed, why? }. */
  async function dropLook(id) {
    const r = listRuns(place()).find((x) => x.id === id);
    if (!r || r.by !== 'look' || !r.branch || r.writer !== me()) throw fail(404, 'there is no look of this computer with that id', 'not-found');
    if (r.state === 'running') throw fail(409, 'the look still works', 'running');
    const top = await repoTop(folderOf(projectDir(r.project), r.folder), run);
    return top ? dropRunBranch(top, branchOf(r.item), { run }) : { removed: false, why: `${r.project} is not a git repository any more` };
  }

  return {
    startAlone,
    released,
    dropLook,
    releaseRun,
    drain: () => drain().catch((e) => log(`runs that end by themselves: ${e.message}`)),
    /** End one run of this dashboard now (a mission's "Tia OFF" when the owner chose to stop what runs). → whether it ran. */
    stop(id, why) {
      const e = live.get(id);
      if (!e) return false;
      e.stoppedBy = String(why || 'Stopped').slice(0, 200);
      e.end();
      return true;
    },
    waiting: () => readWaiting().map(({ key, at, why }) => ({ key, at, why })),
    running: () => runningHere().map((r) => viewRun(r, me())),
    begin: () => settleLeftovers().then(drain).catch((e) => log(`runs that end by themselves: ${e.message}`)),
    async close() {
      closed = true;
      const ending = [...live.values()];
      for (const e of ending) {
        clearTimeout(e.timer);
        e.end(); // SIGTERM, then SIGKILL after the grace: a tool that ignores SIGTERM does not hold the stop
      }
      let timer;
      const limit = new Promise((resolve) => (timer = setTimeout(resolve, o.closeWaitMs ?? CLOSE_WAIT_MS)));
      await Promise.race([Promise.all(ending.map((e) => e.done)), limit]);
      clearTimeout(timer);
    },
    // what the tests read
    keptTree, currentBranch,
  };
}
