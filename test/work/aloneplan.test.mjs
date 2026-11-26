// How a run that ends by itself starts the coding tool (src/work/alone.mjs toolPlan), with Windows' answers handed in:
// an npm install of the tool is a `claude.cmd` shim there, which Node does not start by its bare name, so a run of a
// schedule or a mission on Windows ended at once with "spawn claude ENOENT". Elsewhere the program is started as it is.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { tempWork } from './helpers.mjs';

const t = tempWork('work-aloneplan');
test.after(() => t.cleanup());
const alone = await import('../../src/work/alone.mjs');
const { toolPlan } = alone;
const SHIM = 'C:\\Users\\alex\\AppData\\Roaming\\npm\\claude.cmd';
const shop = path.join(t.projects, 'shop');
t.repo(shop, { 'README.md': '# shop\n', 'docs/plans/tasks.json': '{\n  "items": []\n}\n' });
const cfg = { work: { place: 'project', project: 'shop', path: 'docs/plans', ownerId: 'alex' } };
const { saveConfig } = await import('../../src/config.mjs');
saveConfig(cfg);
const { resolvePlace, projectNames } = await import('../../src/work/place.mjs');
const { workStore } = await import('../../src/work/store.mjs');
const { aloneRunner } = await import('../../src/work/alone.mjs');
const { listRuns } = await import('../../src/work/runs.mjs');
const { restrictedKnown, forgetRestricted } = await import('../../src/claudecode.mjs');

const WIN_ENV = { PATH: 'C:\\Users\\alex\\AppData\\Roaming\\npm;C:\\Windows\\system32', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }; // seal: a value no program is started with
const ARGS = ['-p', '--output-format', 'stream-json', '--permission-mode', 'default'];

test('Windows: the bare name found as an npm .cmd shim goes to cmd.exe with every argument escaped', () => {
  const shim = 'C:\\Users\\alex\\AppData\\Roaming\\npm\\claude.cmd';
  const plan = toolPlan('claude', ARGS, { platform: 'win32', env: WIN_ENV, exists: (f) => f === shim });
  assert.equal(plan.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(plan.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.ok(plan.args[3].includes(shim), plan.args[3]);
  assert.ok(plan.args[3].includes('stream-json'), plan.args[3]);
  assert.equal(plan.options.windowsVerbatimArguments, true);
});

test('Windows: an .exe found on PATH starts directly; a full path is found with its extension; nothing found stays as named', () => {
  const exe = 'C:\\Windows\\system32\\claude.exe';
  assert.deepEqual(toolPlan('claude', ARGS, { platform: 'win32', env: WIN_ENV, exists: (f) => f === exe }), { command: exe, args: ARGS, options: {} });
  const full = 'D:\\tools\\claude';
  assert.deepEqual(toolPlan(full, ARGS, { platform: 'win32', env: WIN_ENV, exists: (f) => f === `${full}.exe` }), { command: `${full}.exe`, args: ARGS, options: {} });
  assert.deepEqual(toolPlan('claude', ARGS, { platform: 'win32', env: WIN_ENV, exists: () => false }), { command: 'claude', args: ARGS, options: {} });
});

test('Linux and macOS: the program as named, nothing looked up', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(toolPlan('claude', ARGS, { platform, env: WIN_ENV, exists: () => { throw new Error('looked up'); } }), { command: 'claude', args: ARGS, options: {} });
  }
});

// The runner itself with Windows' answers: a spawn seam (no program is started), a made-up child whose pid is the one
// spawn "returned", and Windows' end of a tree handed in. On Windows the npm shim makes cmd.exe the process the run
// started and Claude Code its child, and Windows does not end a child with its parent: every end must ask for the
// tree of that one pid, and nothing else may be ended (no POSIX signal to any pid).
const place = () => resolvePlace(cfg);
let n = 0;
const task = async () => (await workStore(place(), { projects: projectNames() }).add({ title: `On Windows ${++n}`, project: 'shop', note: 'DO:nothing' })).item.id;
const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms).unref())]);

/** A made-up Windows for one runner: what spawn was asked, which trees were ended, and the children by pid. */
function windows({ first = null } = {}) {
  const w = { spawned: [], ended: [], kills: [], onKill: null, children: new Map(), next: 3_990_001 };
  w.spawn = (command, args, options) => {
    w.spawned.push({ command, args, options });
    const c = new EventEmitter();
    c.pid = w.next++;
    c.stdin = new PassThrough();
    c.stdin.resume();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.exitCode = null;
    c.signalCode = null;
    // It exits by itself; its output closes `closeAfter` ms later (`late`: a line it still writes in between). From the
    // exit on, Windows may hand its pid to another program.
    c.exitAlone = (closeAfter, late = null) => {
      c.over = true;
      c.exitCode = 0;
      c.emit('exit', 0, null);
      if (late) c.stdout.write(`${late}\n`);
      setTimeout(() => {
        c.stdout.end();
        c.stderr.end();
        c.emit('close', 0, null);
      }, closeAfter);
    };
    c.finish = () => {
      if (c.over) return;
      c.over = true;
      c.emit('exit', 1, null);
      c.stdout.end();
      c.stderr.end();
      setImmediate(() => c.emit('close', 1, null));
    };
    // Node's child.kill(): on Windows TerminateProcess on the handle Node holds (how a live run's root is ended, never
    // by taskkill). `w.onKill(pid)`: the made-up Windows' answer (true: ended); without one it ends.
    c.kill = (sig) => {
      w.kills.push([c.pid, sig]);
      if (c.over) return false;
      const ok = w.onKill ? w.onKill(c.pid) : true;
      if (ok) c.finish();
      return ok;
    };
    if (first) setImmediate(() => c.stdout.write(`${first}\n`));
    w.children.set(c.pid, c);
    return c;
  };
  w.killTree = (pid) => {
    w.ended.push(pid);
    const c = w.children.get(pid);
    if (c) c.finish();
  };
  return w;
}
const runnerOn = (w, o = {}) => aloneRunner({
  config: () => cfg, platform: 'win32', exists: (f) => f === SHIM, spawn: w.spawn, killTree: w.killTree,
  // the system's start of the run's cmd.exe, as the made-up table below gives it (ROOT, start 5000)
  ident: { of: (pids) => new Map(pids.map((p) => [p, 'T:5000'])), refresh: async () => 0 },
  // the real environment without its own search path: Windows spells it Path, and that is read before the PATH below
  resolveEnv: async () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(path|pathext|comspec)$/i.test(k))), ...WIN_ENV }), settings: () => ({ atOnce: 4 }), record: () => {}, killGraceMs: 50,
  defaultProvider: async () => 'sub', restrictedKnown: async () => true, ...o,
});
/** process.kill held for the test: what would have been signalled (not "is it alive", signal 0) is kept, nothing sent. */
async function noSignals(fn) {
  const real = process.kill;
  const sent = [];
  process.kill = (pid, sig) => {
    if (sig !== 0) sent.push([pid, sig]);
    return true;
  };
  try {
    await fn();
  } finally {
    process.kill = real;
  }
  return sent;
}

test('Windows: the runner hands the start plan to spawn whole: cmd.exe with the shim, its verbatim arguments, hidden', async () => {
  const w = windows();
  const r = runnerOn(w, { minuteMs: 50 });
  try {
    const id = await task();
    const s = await r.startAlone({ item: id, provider: 'sub', minutes: 1 });
    assert.equal(w.spawned.length, 1);
    const [{ command, args, options }] = w.spawned;
    assert.equal(command, WIN_ENV.ComSpec);
    assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c']);
    assert.ok(args[3].includes(SHIM) && args[3].includes('stream-json'), args[3]);
    assert.equal(options.windowsVerbatimArguments, true, 'the plan\'s options reach spawn');
    assert.equal(options.windowsHide, true);
    assert.ok(fs.realpathSync(options.cwd) !== fs.realpathSync(shop), 'it works in a worktree of its own');
    await within(s.done, 5000);
  } finally {
    await r.close();
  }
});

test('Windows: the time limit ends the tree of the pid the run started, and nothing else', async () => {
  const w = windows();
  const r = runnerOn(w, { minuteMs: 50 });
  let fin;
  const sent = await noSignals(async () => {
    const id = await task();
    const s = await r.startAlone({ item: id, provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.deepEqual(w.ended, [3_990_001], 'the tree of that one pid is ended');
  assert.deepEqual(sent, [], 'no signal to any pid');
  assert.ok(fin, 'the run settled once its tree was ended');
  assert.equal(fin.state, 'stopped');
  assert.match(fin.reason, /time limit/);
});

test('Windows: a mission\'s session that did not start restricted ends its tree at once, and nothing else', async () => {
  const w = windows({ first: JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read', 'Glob', 'Grep', 'Bash'], mcp_servers: [], permissionMode: 'default' }) });
  const r = runnerOn(w);
  let fin;
  const sent = await noSignals(async () => {
    const id = await task();
    const s = await r.startAlone({ by: 'mission', item: id, provider: 'sub', restricted: ['Read', 'Glob', 'Grep'], minutes: 30 });
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.deepEqual(w.ended, [3_990_001]);
  assert.deepEqual(sent, []);
  assert.ok(fin, 'the run settled once its tree was ended');
  assert.equal(fin.state, 'failed');
  assert.match(fin.reason, /did not start restricted \(it had Bash\)/);
});

test('Windows: once the process the run started has exited, no stop, time limit, close or late first line ends its pid', async () => {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const wrong = JSON.stringify({ type: 'system', subtype: 'init', tools: ['Read', 'Bash'], mcp_servers: [], permissionMode: 'default' });
  const cases = {
    stop: async (r, s) => assert.equal(r.stop(s.run.id, 'Stopped by the person'), true),
    'time limit': async () => sleep(150),
    close: async (r) => r.close(),
    'late first line': async () => {},
  };
  for (const [name, after] of Object.entries(cases)) {
    const w = windows();
    const r = runnerOn(w, { minuteMs: 100 });
    let fin;
    const sent = await noSignals(async () => {
      const id = await task();
      const mission = name === 'late first line';
      const s = await r.startAlone({ item: id, provider: 'sub', minutes: 1, ...(mission ? { by: 'mission', restricted: ['Read', 'Glob', 'Grep'] } : {}) });
      await sleep(20);
      w.children.get(3_990_001).exitAlone(300, mission ? wrong : null);
      await after(r, s);
      fin = await within(s.done, 5000);
    });
    await r.close();
    assert.deepEqual(w.ended, [], `${name}: no end is asked for the pid of a process that has exited`);
    assert.deepEqual(sent, [], `${name}: no signal to any pid`);
    assert.ok(fin, `${name}: the run settled`);
  }
});

// Windows' end of a run's tree from one made-up PowerShell table (pid, parent, start, owner): taskkill /T follows the
// recorded parent pid and so can end a program that only shares a number handed out again; the tree is walked down
// here and each process of it is ended alone.
const ME = 'S-1-5-21-1000-2000-3000-1001';
const OTHER = 'S-1-5-21-1000-2000-3000-1002';
const ROOT = 3_990_001; // the run's cmd.exe (the pid spawn gave)
const TABLE = {
  me: ME,
  procs: [
    { pid: 600, ppid: 4, start: 100, sid: ME }, // the person's terminal
    { pid: 700, ppid: 600, start: 900, sid: ME }, // the dashboard, above the run
    { pid: ROOT, ppid: 700, start: 5000, sid: ME }, // cmd.exe of the npm shim
    { pid: ROOT + 1, ppid: ROOT, start: 5100, sid: ME }, // Claude Code
    { pid: ROOT + 2, ppid: ROOT + 1, start: 5200, sid: ME }, // a program Claude Code started
    { pid: 4100, ppid: ROOT, start: 4000, sid: ME }, // started BEFORE cmd.exe: its parent's number was handed out again
    { pid: 4101, ppid: 4100, start: 6000, sid: ME }, // below that one: not the run's either
    { pid: 4200, ppid: ROOT + 1, start: 5300, sid: OTHER }, // another account's
  ],
};

test('Windows: the run\'s tree is walked down from its pid: a reused pid, another account and what is above are never in it', () => {
  assert.equal(typeof alone.runTreeOf, 'function', 'the tree is built from one table of the system');
  const snap = alone.parseRunTree(JSON.stringify(TABLE));
  assert.ok(snap);
  const tree = alone.runTreeOf(snap, ROOT, 700);
  assert.deepEqual(tree, [ROOT, ROOT + 1, ROOT + 2], 'cmd.exe, Claude Code and what it started');
  for (const p of [600, 700, 4100, 4101, 4200]) assert.ok(!tree.includes(p), `process ${p} is not the run's`);
  // a root of another account, or one this process runs in, is never ended
  assert.deepEqual(alone.runTreeOf(alone.parseRunTree(JSON.stringify({ ...TABLE, me: OTHER })), ROOT, 700), []);
  assert.deepEqual(alone.runTreeOf(snap, ROOT, ROOT + 2), [], 'this process runs below that pid');
  assert.deepEqual(alone.runTreeOf(snap, 700, 600).includes(600), false, 'nothing above the pid');
  assert.equal(alone.parseRunTree('not json'), null);
  assert.throws(() => alone.runTreeScript(4), /bad pid/);
  assert.match(alone.runTreeScript(ROOT), new RegExp(`\\b${ROOT}\\b`));
});

/** The script a PowerShell call was given (its -EncodedCommand). */
const scriptOf = (args) => Buffer.from(String(args[args.indexOf('-EncodedCommand') + 1]), 'base64').toString('utf16le');
/** The processes an end call (endBelowScript) was given, in its order: [{ pid, start, ppid }]; null for another script. */
const endEntries = (script) => {
  const m = /\$flat = @\(([\d, ]*)\)/.exec(script);
  if (!m) return null;
  const n = m[1].split(',').map(Number);
  const out = [];
  for (let i = 0; i + 2 < n.length; i += 3) out.push({ pid: n[i], start: n[i + 1], ppid: n[i + 2] });
  return out;
};
/**
 * The most (ms) by which the end call lets its start be BELOW the table's: the number after its "$d -lt -". A start
 * above the table's is never the same ("$d -gt 0").
 */
const endMargin = (script) => Number(/\$d -lt -(\d+)\b/.exec(script)[1]);
/**
 * The end call's own test for "other start", read from its script: (now, start) → true when the start read now is
 * another than the table's. Its PowerShell is turned into the same JavaScript (its numbers, -gt, -lt, -or, Abs), so
 * the made-up Windows answers as that script would, whatever its comparison is.
 */
const otherStartOf = (script) => {
  const js = (x) => x.trim().replace(/\[Math\]::Abs\(/g, 'Math.abs(').replace(/\[long\]/g, '').replace(/\$flat\[\$i \+ 1\]/g, 't')
    .replace(/\$s\b/g, 's').replace(/\$d\b/g, 'd').replace(/ -gt /g, ' > ').replace(/ -lt /g, ' < ').replace(/ -or /g, ' || ').replace(/ -and /g, ' && ');
  const cond = js(/if \((.+)\) \{ \$said = 'other start' \}/.exec(script)[1]);
  const d = /\$d = (.+)/.exec(script);
  const body = `const d = ${d ? js(d[1]) : 'null'}; return Boolean(${cond});`;
  assert.match(body, /^[\w\s().<>|&=;+-]+$/, `the comparison is only numbers and operators: ${body}`);
  return new Function('s', 't', body);
};
/**
 * Windows' answer to an end call, as the script answers: each pid looked up now (`startOf(pid)`: its start, null when
 * gone), compared with the start it was given (by the script's own margin), and only then ended (`kill(pid)`, true:
 * ended); one that failed keeps those above it in the list. `tried`: each pid whose end was asked of Windows.
 */
async function endAnswer(entries, { startOf, kill, tried, other }) {
  const up = new Map(entries.map((e) => [e.pid, e.ppid]));
  const keep = new Set();
  const lines = [];
  for (const e of entries) {
    if (keep.has(e.pid)) {
      lines.push(`${e.pid} kept`);
      continue;
    }
    const now = startOf(e.pid);
    let said;
    if (now === null || now === undefined) said = 'gone';
    else if (other(now, e.start)) said = 'other start';
    else {
      tried.push(e.pid);
      said = (await kill(e.pid)) ? 'ended' : 'failed';
    }
    if (said === 'failed') for (let q = up.get(e.pid); up.has(q) && !keep.has(q); q = up.get(q)) keep.add(q);
    lines.push(`${e.pid} ${said}`);
  }
  return lines.join('\r\n');
}

/**
 * A made-up Windows' programs: PowerShell answers with `table` (and ends as asked, `kill(pid)`: true when ended), and
 * so does the run's own child handle (w.onKill). taskkill is refused: nothing of the product may start it.
 */
function winPrograms(w, { table = TABLE, kill = () => true, ps = () => true } = {}) {
  const calls = [];
  const tried = [];
  if (w) {
    w.onKill = (pid) => {
      tried.push(pid);
      return kill(pid);
    };
  }
  const isEnd = ([c, a]) => c === 'powershell.exe' && endEntries(scriptOf(a)) !== null;
  const run = async (cmd, args) => {
    calls.push([cmd, [...args]]);
    if (cmd === 'powershell.exe') {
      if (!ps()) return { ok: false, out: '' };
      const entries = endEntries(scriptOf(args));
      if (!entries) return { ok: true, out: JSON.stringify(table) };
      const startOf = (pid) => table.procs.find((x) => x.pid === pid)?.start ?? null;
      const out = await endAnswer(entries, { startOf, tried, other: otherStartOf(scriptOf(args)), kill: (pid) => {
        const ok = kill(pid);
        if (ok && w) w.children.get(pid)?.finish();
        return ok;
      } });
      return { ok: true, out };
    }
    return { ok: false, out: '' }; // taskkill or any other program: refused (and kept in `calls`)
  };
  return {
    run, calls, tried: () => [...tried],
    killed: () => calls.filter(([c]) => c === 'taskkill').map(([, a]) => a),
    tables: () => calls.filter((x) => x[0] === 'powershell.exe' && !isEnd(x)).length,
  };
}

test('Windows: the time limit ends cmd.exe and Claude Code below it one by one, never with /T, and nothing else', async () => {
  assert.equal(typeof alone.endWinTree, 'function', 'the tree is ended process by process');
  const w = windows();
  // the run's tree without another account's process below it (that one makes the tree "not checked": see below)
  const p = winPrograms(w, { table: { ...TABLE, procs: TABLE.procs.filter((x) => x.pid !== 4200) } });
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: p.run });
  let fin;
  const sent = await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.equal(p.tables(), 1, 'one table of the system');
  assert.deepEqual(p.tried(), [ROOT + 2, ROOT + 1, ROOT], 'each alone, the lowest first');
  assert.deepEqual(p.killed(), [], 'no taskkill at all');
  assert.deepEqual(w.kills, [[ROOT, 'SIGKILL']], 'cmd.exe last, alone, through the run\'s own child handle; what is below it in the end call');
  assert.deepEqual(sent, []);
  assert.ok(fin);
  assert.equal(fin.state, 'stopped');
  assert.match(fin.reason, /time limit/);
});

test('Windows: when the end fails the tree end is tried once more, never cmd.exe alone, and the run says the tool may still run', async () => {
  assert.equal(typeof alone.MAY_STILL_RUN, 'string', 'the words of a tool that may still be running');
  const w = windows();
  const p = winPrograms(w, { kill: () => false });
  const logged = [];
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: p.run, log: (s) => logged.push(s) });
  let fin;
  const sent = await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    await new Promise((res) => setTimeout(res, 250));
    w.children.get(ROOT).exitAlone(10); // it ends by itself later
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.equal(p.tables(), 2, 'the tree end is tried twice');
  assert.ok(p.killed().every((a) => !a.includes('/T')));
  assert.deepEqual(sent, [], 'no signal to the lone pid instead');
  assert.ok(fin);
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
  assert.ok(logged.some((l) => l.includes(alone.MAY_STILL_RUN) && l.includes('could not be ended')), logged.join('\n'));
});

test('Windows: after a crash, a tree that cannot be ended is recorded as one whose tool may still run', async () => {
  const w = windows();
  const crashed = runnerOn(w);
  const id = await task();
  await crashed.startAlone({ item: id, provider: 'sub', minutes: 30 });
  await new Promise((res) => setTimeout(res, 20));
  const p = winPrograms(null, { ps: () => false });
  const again = runnerOn(windows(), { killTree: undefined, winRun: p.run });
  const sent = await noSignals(() => again.begin());
  assert.equal(p.tables(), 2);
  assert.deepEqual(sent, []);
  const rec = listRuns(place(), { item: id })[0];
  assert.equal(rec.state, 'stopped');
  assert.match(rec.reason, new RegExp(alone.MAY_STILL_RUN));
  await crashed.close();
  await again.close();
});

test('Windows: after a crash of the dashboard, its next start ends the tree of the pid the run had started, and nothing else', async () => {
  const w = windows();
  const crashed = runnerOn(w);
  const id = await task();
  await crashed.startAlone({ item: id, provider: 'sub', minutes: 30 });
  const pid = 3_990_001;
  await new Promise((res) => setTimeout(res, 20)); // its process is kept once the system has answered
  const next = windows();
  // the child of the crashed dashboard is not one this runner started: its end is only recorded here
  const again = runnerOn(next);
  const sent = await noSignals(() => again.begin());
  assert.deepEqual(next.ended, [pid], 'the tree of the recorded pid, the same process, is ended');
  assert.deepEqual(sent, []);
  assert.equal(listRuns(place(), { item: id })[0].state, 'stopped');
  await crashed.close();
  await again.close();
});

test('Windows: the dashboard asks who a process is in the background, and a run\'s process is still kept and ended after a crash', async () => {
  // As src/procid.mjs answers in the dashboard (askInBackground): of() knows a pid only after a refresh() of it.
  const known = new Set();
  const ident = {
    of: (pids) => new Map(pids.map((p) => [p, known.has(p) ? 'T:1000' : null])),
    refresh: async (pids) => {
      for (const p of pids) known.add(p);
      return 1;
    },
  };
  const w = windows();
  const crashed = runnerOn(w, { ident });
  const id = await task();
  await crashed.startAlone({ item: id, provider: 'sub', minutes: 30 });
  await new Promise((res) => setTimeout(res, 20));
  known.clear(); // the next start of the dashboard has asked nothing yet
  const next = windows();
  const again = runnerOn(next, { ident });
  const sent = await noSignals(() => again.begin());
  assert.deepEqual(next.ended, [3_990_001], 'the tree of the recorded pid is ended');
  assert.deepEqual(sent, []);
  assert.equal(listRuns(place(), { item: id })[0].state, 'stopped');
  await crashed.close();
  await again.close();
});

test('Windows: whether Claude Code knows the restricted mode is asked through its start plan (an npm shim through cmd.exe)', async () => {
  forgetRestricted();
  const plans = [];
  const runPlan = async (plan) => {
    plans.push(plan);
    return { ok: true, stdout: 'Options:\n  --restricted   no tool that runs a command\n' };
  };
  const known = await restrictedKnown({ bin: 'claude', env: WIN_ENV, platform: 'win32', exists: (f) => f === SHIM, runPlan, run: async () => ({ ok: false, error: 'ENOENT', stdout: '' }) });
  assert.equal(known, true, 'it knows the mode');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].command, WIN_ENV.ComSpec);
  assert.ok(plans[0].args[3].includes(SHIM) && plans[0].args[3].includes('--help'), plans[0].args[3]);
  assert.equal(plans[0].options.windowsVerbatimArguments, true);
  forgetRestricted();
});

// A made-up Windows whose table changes: a process the end call or the child handle ended leaves it; `beforePs(table)`
// runs while the table is asked (a process exits, its pid is handed out again); `slow(pid)`: ms the end of that pid
// takes to answer in the end call. taskkill is refused.
const rowsOf = (t) => t.procs.map((x) => ({ ...x }));
// `seen(pid, start)`: the start the end call reads (Process.StartTime) of a process whose start in the table is `start`
// (CIM CreationDate): the same by default; another for a reading gap between the two.
function winLive(w, { rows = rowsOf(TABLE), kill = () => true, beforePs = null, slow = () => 0, seen = (pid, start) => start } = {}) {
  const table = new Map(rows.map((x) => [x.pid, { ...x }]));
  const calls = [];
  const tried = []; // each pid whose end was asked of Windows (in the end call, or through the child handle), in order
  const scripts = [];
  const endOne = async (pid) => {
    tried.push(pid);
    const ok = await kill(pid);
    if (ok) {
      table.delete(pid);
      w?.children.get(pid)?.finish();
    }
    if (slow(pid)) await new Promise((res) => setTimeout(res, slow(pid)));
    return ok;
  };
  // A live run's root is ended through its own child handle (child.kill), as Windows answers it here.
  if (w) {
    w.onKill = (pid) => {
      tried.push(pid);
      const ok = kill(pid) === true;
      if (ok) table.delete(pid);
      return ok;
    };
  }
  const run = async (cmd, args) => {
    calls.push([cmd, [...args]]);
    if (cmd === 'powershell.exe') {
      const script = scriptOf(args);
      const entries = endEntries(script);
      if (entries) {
        scripts.push(script);
        const startOf = (pid) => (table.has(pid) ? seen(pid, table.get(pid).start) : null);
        return { ok: true, out: await endAnswer(entries, { startOf, kill: endOne, tried: [], other: otherStartOf(script) }) };
      }
      if (beforePs) await beforePs(table);
      return { ok: true, out: JSON.stringify({ me: ME, procs: [...table.values()] }) };
    }
    return { ok: false, out: '' }; // taskkill or any other program: refused (and kept in `calls`)
  };
  return {
    run, calls, table, scripts, killed: () => [...tried],
    taskkilled: () => calls.filter(([c]) => c === 'taskkill').map(([, a]) => Number(a[1])),
    asked: () => calls.filter(([c, a]) => c === 'powershell.exe' && !endEntries(scriptOf(a))).length,
  };
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const THEIRS = [{ pid: ROOT, ppid: 600, start: 9000, sid: ME }, { pid: ROOT + 50, ppid: ROOT, start: 9100, sid: ME }]; // another program of the person's under the run's pid, and its child

test('Windows: the run exits while its table is asked and its pid goes to another program: nothing is ended', async () => {
  const w = windows();
  const p = winLive(w, {
    beforePs: async (table) => {
      w.children.get(ROOT).exitAlone(300); // cmd.exe exits now; Windows hands its pid out again
      for (const x of THEIRS) table.set(x.pid, { ...x });
    },
  });
  const r = runnerOn(w, { killTree: undefined, winRun: p.run });
  let fin;
  const sent = await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 30 });
    await sleep(20);
    r.stop(s.run.id, 'Stopped by the person');
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.deepEqual(p.killed(), [], 'no taskkill once the run has exited');
  assert.deepEqual(sent, []);
  assert.ok(fin, 'the run settled');
});

test('Windows: a root whose start in the table is not the start the run kept is another program: nothing is ended', async () => {
  const rows = [...rowsOf(TABLE).filter((x) => x.pid !== ROOT), ...THEIRS];
  const p = winLive(null, { rows });
  const res = await alone.endWinTree(ROOT, { run: p.run, start: 5000, self: 700 });
  assert.deepEqual(p.killed(), [], `nothing of the program that has the pid now: ${JSON.stringify(p.killed())}`);
  assert.equal(res.ok, false);
  assert.match(res.why, /not the one the run started/);
  // the same start, as the system wrote it: the run's tree is ended
  const q = winLive(null, { rows: rowsOf(TABLE).filter((x) => x.pid !== 4200) });
  const same = await alone.endWinTree(ROOT, { run: q.run, start: 5000, self: 700 });
  assert.deepEqual(q.killed(), [ROOT + 2, ROOT + 1, ROOT]);
  assert.equal(same.ok, true);
});

/** A run of a dashboard that then "crashed" (it is never closed before the next one starts): its id. */
async function crashedRun(o = {}) {
  const w = windows();
  const crashed = runnerOn(w, o);
  const id = await task();
  await crashed.startAlone({ item: id, provider: 'sub', minutes: 30 });
  await sleep(20); // its process is kept, as T:5000
  return { id, crashed };
}

test('Windows: after a crash, a pid that another program holds by the time of the table is not ended', async () => {
  const { id, crashed } = await crashedRun();
  // the identity answer said "same process"; the table, asked after it, shows another program under that pid
  const p = winLive(null, { rows: [...rowsOf(TABLE).filter((x) => x.pid !== ROOT), ...THEIRS] });
  const again = runnerOn(windows(), { killTree: undefined, winRun: p.run });
  const sent = await noSignals(() => again.begin());
  const rec = listRuns(place(), { item: id })[0]; // read before the crashed runner's own close writes its end
  await crashed.close();
  await again.close();
  assert.deepEqual(p.killed(), [], `a process that started at 9000, not the kept 5000, was ended: ${JSON.stringify(p.killed())}`);
  assert.deepEqual(sent, []);
  assert.equal(rec.state, 'stopped');
  assert.match(rec.reason, new RegExp(alone.MAY_STILL_RUN), 'what the run had started may still run below that number');
});

test('Windows: after a crash, a root that the table shows started 500 ms after the kept start is refused before any end call', async () => {
  const { id, crashed } = await crashedRun();
  // the root's number went to another program that started at 5500 (within SAME_WITHIN of the kept 5000), with its own child
  const rows = [...rowsOf(TABLE).filter((x) => x.pid !== ROOT && x.ppid !== ROOT && x.pid !== ROOT + 2), { pid: ROOT, ppid: 600, start: 5500, sid: ME }, { pid: ROOT + 50, ppid: ROOT, start: 5600, sid: ME }];
  const p = winLive(null, { rows });
  const logged = [];
  const again = runnerOn(windows(), { killTree: undefined, winRun: p.run, log: (l) => logged.push(l) });
  const sent = await noSignals(() => again.begin());
  const rec = listRuns(place(), { item: id })[0];
  await crashed.close();
  await again.close();
  assert.equal(p.scripts.length, 0, 'no end call at all');
  assert.deepEqual(p.killed(), [], `a child of a program the run never started was ended: ${JSON.stringify(p.killed())}`);
  assert.ok(p.table.has(ROOT + 50) && p.table.has(ROOT));
  assert.deepEqual(sent, []);
  assert.equal(rec.state, 'stopped');
  assert.match(rec.reason, new RegExp(alone.MAY_STILL_RUN), rec.reason);
  assert.match(rec.reason, /not the one the run started/, rec.reason);
  // the table's start 1 ms above the kept one is still the run's; 1 ms below it is not
  for (const [t, ok] of [[5001, true], [5000, true], [4999, false]]) {
    const q = winLive(null, { rows: RUN_ROWS().map((x) => (x.pid === ROOT ? { ...x, start: t } : x)) });
    const res = await alone.endWinTree(ROOT, { run: q.run, start: 5000, self: 700 });
    assert.equal(q.scripts.length, ok ? 1 : 0, `${t}: ${JSON.stringify(res)}`);
    if (!ok) assert.match(res.why, /not the one the run started/);
  }
});

const RUN_ROWS = () => rowsOf(TABLE).filter((x) => x.pid !== 4200); // the run's tree alone, nothing refused below it

test('Windows: the end fails for Claude Code only: cmd.exe is not ended, and the run says its tool may still run', async () => {
  const w = windows();
  const p = winLive(w, { rows: RUN_ROWS(), kill: (pid) => pid !== ROOT + 1 });
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: p.run });
  let fin;
  const sent = await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.ok(!p.killed().includes(ROOT), `cmd.exe stays, so the tree is still found from its pid: ${JSON.stringify(p.killed())}`);
  assert.ok(p.table.has(ROOT + 1) && p.table.has(ROOT));
  assert.equal(p.asked(), 2, 'tried twice');
  assert.deepEqual(sent, []);
  assert.ok(fin, 'the run settles although its tool still runs');
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
});

test('Windows: a second try that ends nothing because the run has gone keeps the first try\'s failure', async () => {
  const w = windows();
  const p = winLive(w, { rows: RUN_ROWS(), kill: (pid) => {
    if (pid !== ROOT + 1) return true;
    w.children.get(ROOT).exitAlone(200); // cmd.exe exits by itself right after the failure; Claude Code is left
    return false;
  } });
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: p.run });
  let fin;
  await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.ok(fin);
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
  assert.match(fin.reason, new RegExp(`${ROOT + 1}`), 'the first try says which process was left');
});

test('Windows: after a crash, a retry whose table no longer holds cmd.exe does not count as ended', async () => {
  const { id, crashed } = await crashedRun();
  const p = winLive(null, { rows: RUN_ROWS(), kill: (pid) => {
    if (pid !== ROOT + 1) return true;
    p.table.delete(ROOT); // cmd.exe ends by itself after the failure; Claude Code (3990002) is left
    return false;
  } });
  const logged = [];
  const again = runnerOn(windows(), { killTree: undefined, winRun: p.run, log: (l) => logged.push(l) });
  await noSignals(() => again.begin());
  const rec = listRuns(place(), { item: id })[0];
  await crashed.close();
  await again.close();
  assert.ok(p.table.has(ROOT + 1), 'Claude Code still runs in this made-up Windows');
  assert.equal(p.asked(), 2);
  assert.equal(rec.state, 'stopped');
  assert.match(rec.reason, new RegExp(alone.MAY_STILL_RUN), rec.reason);
  assert.ok(logged.some((l) => l.includes(alone.MAY_STILL_RUN) && l.includes(`${ROOT + 1}`)), logged.join('\n'));
  assert.ok(!logged.some((l) => /still working: ended/.test(l)), logged.join('\n'));
});

test('Windows: a child whose owner is not read, or is another account, is said, never ended, and cmd.exe stays', async () => {
  const snap = alone.parseRunTree(JSON.stringify(TABLE));
  const tree = alone.runTreeOf(snap, ROOT, 700);
  assert.deepEqual(tree.refused, [{ pid: 4200, why: 'it runs as another account' }], 'the children it refused are returned');
  assert.ok(!tree.refused.some((x) => x.pid === 4100), 'a reused number is not the run\'s: not refused, just not in it');
  // another account's process below Claude Code: nothing of it is ended, and the root stays
  const q = winLive(null, { rows: rowsOf(TABLE) });
  const res = await alone.endWinTree(ROOT, { run: q.run, start: 5000, self: 700 });
  assert.ok(!q.killed().includes(4200) && !q.killed().includes(ROOT), JSON.stringify(q.killed()));
  assert.equal(res.ok, false);
  assert.match(res.why, /process 4200 below the run could not be checked/);
  // the owner of Claude Code is not read: the run says its tool may still run
  const w = windows();
  const p = winLive(w, { rows: RUN_ROWS().map((x) => (x.pid === ROOT + 1 ? { ...x, sid: null } : x)) });
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: p.run });
  let fin;
  await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.ok(!p.killed().includes(ROOT), `cmd.exe stays: ${JSON.stringify(p.killed())}`);
  assert.ok(fin);
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
  assert.match(fin.reason, new RegExp(`process ${ROOT + 1} below the run could not be checked`), fin.reason);
});

test('Windows: after a crash, a root in the table whose owner is not read is not recorded as ended', async () => {
  const { id, crashed } = await crashedRun();
  const p = winLive(null, { rows: RUN_ROWS().map((x) => (x.pid === ROOT ? { ...x, sid: null } : x)) });
  const logged = [];
  const again = runnerOn(windows(), { killTree: undefined, winRun: p.run, log: (l) => logged.push(l) });
  await noSignals(() => again.begin());
  const rec = listRuns(place(), { item: id })[0];
  await crashed.close();
  await again.close();
  assert.deepEqual(p.killed(), []);
  assert.equal(rec.state, 'stopped');
  assert.match(rec.reason, new RegExp(alone.MAY_STILL_RUN), rec.reason);
  assert.match(rec.reason, /could not be checked/);
  assert.ok(!logged.some((l) => /still working: ended/.test(l)), logged.join('\n'));
  // ok with nothing ended only when the root is gone from the table and nothing was refused before
  const gone = winLive(null, { rows: RUN_ROWS().filter((x) => x.pid !== ROOT) });
  assert.equal((await alone.endWinTree(ROOT, { run: gone.run, start: 5000, self: 700 })).ok, true);
});

test('Windows: a tree end that has not finished when the run closes and the wait is over says the tool may still run', async () => {
  const w = windows();
  const p = winLive(w, { rows: RUN_ROWS(), slow: (pid) => (pid === ROOT + 2 ? 1500 : 0) }); // the end call takes long
  const r = runnerOn(w, { minuteMs: 50, closeWaitMs: 100, killTree: undefined, winRun: p.run });
  let fin;
  await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    await sleep(120); // the time limit has started the end
    w.children.get(ROOT).exitAlone(10); // cmd.exe ends meanwhile, its output closes
    fin = await within(s.done, 5000);
  });
  await sleep(1600); // the slow end finishes before the runner goes
  await r.close();
  assert.ok(fin);
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
  assert.match(fin.reason, /its end did not finish in time/);
});

test('Windows: gone() is asked before the end call and before cmd.exe: once the run has exited, its pid is not ended', async () => {
  let exited = false;
  const p = winLive(null, { rows: RUN_ROWS(), kill: (pid) => {
    if (pid === ROOT + 2) exited = true; // the run's cmd.exe exits meanwhile: from now on its pid may be another's
    return true;
  } });
  // a live run: its root is ended through its own child handle (endRoot), asked only while it has not exited
  let rootEnds = 0;
  const endRoot = () => ++rootEnds > 0;
  const res = await alone.endWinTree(ROOT, { run: p.run, gone: () => exited, start: 5000, self: 700, endRoot });
  // Claude Code is compared by its own start in the end call, so it is still ended; cmd.exe's pid is free now.
  assert.deepEqual(p.killed(), [ROOT + 2, ROOT + 1]);
  assert.equal(rootEnds, 0, 'the root of a run that has exited is not ended');
  assert.deepEqual(p.taskkilled(), [], 'no taskkill of the pid the run had');
  assert.equal(res.ok, true);
  // exited before the end call: nothing below it is asked, and it says what was left
  const q = winLive(null, { rows: RUN_ROWS() });
  let calls = 0;
  const left = await alone.endWinTree(ROOT, { run: q.run, gone: () => ++calls > 2, start: 5000, self: 700, endRoot });
  assert.deepEqual(q.killed(), []);
  assert.equal(rootEnds, 0);
  assert.equal(left.ok, false);
  assert.match(left.why, new RegExp(`${ROOT + 2}, ${ROOT + 1} below the run was not ended`));
});

test('Windows: what is below cmd.exe is ended in one call of plain .NET, each compared by its start, the lowest first', () => {
  const s = alone.endBelowScript([{ pid: ROOT + 2, start: 5200, ppid: ROOT + 1 }, { pid: ROOT + 1, start: 5100, ppid: ROOT }]);
  assert.ok(!/\b(Get|Stop|Set|Invoke|New|Wait|Select|Where|ForEach)-[A-Za-z]/.test(s), `no cmdlet: ${s}`);
  for (const c of ['Get-Process', 'Stop-Process', 'Get-CimInstance', 'taskkill']) assert.ok(!s.includes(c), c);
  assert.match(s, /\[System\.Diagnostics\.Process\]::GetProcessById/);
  assert.match(s, /\$p\.Handle/, 'the process is held before its start is read');
  assert.match(s, /StartTime/);
  assert.match(s, /\$p\.Kill\(\)/, 'ended through that same object');
  // its start is read as the table's is (runTreeScript): through [DateTimeOffset] to whole milliseconds, then compared
  // as equal: its start may be 1 ms BELOW the table's (a CIM provider that rounds its microseconds up), never above
  assert.match(s, /\(\[DateTimeOffset\]\$p\.StartTime\)\.ToUnixTimeMilliseconds\(\)/);
  assert.match(alone.runTreeScript(ROOT), /\(\[DateTimeOffset\]\[System\.Management\.ManagementDateTimeConverter\]::ToDateTime\(\$p\['CreationDate'\]\)\)\.ToUnixTimeMilliseconds\(\)/);
  assert.ok(alone.END_SAME_MS <= 1, `the end call lets a start differ by ${alone.END_SAME_MS} ms`);
  assert.match(s, /\$d = \$s - \[long\]\$flat\[\$i \+ 1\]/, 'the end call start less the table start');
  assert.match(s, /if \(\$d -gt 0 -or \$d -lt -\d+\) \{ \$said = 'other start' \}/, 'one-sided: any start above the table start is another');
  assert.ok(!/Abs\(/.test(s), 'not compared both ways');
  assert.equal(endMargin(s), alone.END_SAME_MS);
  assert.deepEqual(endEntries(s).map((x) => x.pid), [ROOT + 2, ROOT + 1], 'the lowest first');
  assert.throws(() => alone.endBelowScript([{ pid: 4, start: 1, ppid: 0 }]), /bad entries/);
  assert.throws(() => alone.endBelowScript([{ pid: ROOT, start: null, ppid: 1 }]), /bad entries/);
  // the lines it prints: one per pid; one that said nothing has failed
  const said = alone.parseEndLines(`${ROOT + 2} ended\r\n${ROOT + 1} other start\r\n12 gone\r\nnoise`, [ROOT + 2, ROOT + 1, 12, 13]);
  assert.deepEqual([...said], [[ROOT + 2, 'ended'], [ROOT + 1, 'other start'], [12, 'gone'], [13, 'failed']]);
});

/** The words endWinTree gives for a child that answered "other start". */
const otherWords = (pid) => new RegExp(`process ${pid} answered with another start than the table's: it may be another program now; it was not ended`);

test('Windows: a child whose number went to another program before the end call is not ended, and the end says it may still run', async () => {
  // Claude Code exits by itself while the end runs, and Windows gives its number to another program of the account.
  // From its answer alone that cannot be told from a reading gap of Claude Code itself: over-careful, by design.
  const p = winLive(null, { rows: RUN_ROWS(), kill: (pid) => {
    if (pid === ROOT + 2) p.table.set(ROOT + 1, { pid: ROOT + 1, ppid: 600, start: 9000, sid: ME });
    return true;
  } });
  const res = await alone.endWinTree(ROOT, { run: p.run, start: 5000, self: 700 });
  assert.ok(!p.killed().includes(ROOT + 1), `the program that has that number now was ended: ${JSON.stringify(p.killed())}`);
  assert.ok(p.table.has(ROOT + 1), 'it still runs');
  assert.deepEqual(p.killed(), [ROOT + 2, ROOT], 'the rest, the lowest first, cmd.exe last');
  assert.deepEqual(p.taskkilled(), [], 'cmd.exe last in the same end call, no taskkill');
  assert.equal(res.ok, false, `another start is not proven gone: ${JSON.stringify(res)}`);
  assert.match(res.why, otherWords(ROOT + 1));
  assert.deepEqual(res.ended, [ROOT + 2, ROOT], 'not counted as ended');
});

test('Windows: a child that has exited before the end call ("gone") is no failure', async () => {
  const p = winLive(null, { rows: RUN_ROWS(), kill: (pid) => {
    if (pid === ROOT + 2) p.table.delete(ROOT + 1); // Claude Code exits by itself; its number is free
    return true;
  } });
  const res = await alone.endWinTree(ROOT, { run: p.run, start: 5000, self: 700 });
  assert.deepEqual(p.killed(), [ROOT + 2, ROOT]);
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.deepEqual(res.ended, [ROOT + 2, ROOT]);
});

test('Windows: Claude Code whose start the end call reads 2 or 500 ms above the table is never ended, and the run says it may still run', async () => {
  for (const gap of [2, 500]) {
    const w = windows();
    // Claude Code runs on; only the two readings of its one start differ
    const p = winLive(w, { rows: RUN_ROWS(), seen: (pid, start) => (pid === ROOT + 1 ? start + gap : start) });
    const logged = [];
    const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: p.run, log: (l) => logged.push(l) });
    let fin;
    let id;
    const sent = await noSignals(async () => {
      id = await task();
      const s = await r.startAlone({ item: id, provider: 'sub', minutes: 1 });
      fin = await within(s.done, 5000);
    });
    await r.close();
    assert.ok(fin, `${gap} ms: the run settled`);
    assert.ok(!p.killed().includes(ROOT + 1), `${gap} ms: Claude Code was ended: ${JSON.stringify(p.killed())}`);
    assert.ok(p.table.has(ROOT + 1), `${gap} ms: Claude Code still runs`);
    assert.ok(p.killed().includes(ROOT), `${gap} ms: cmd.exe is ended: ${JSON.stringify(p.killed())}`);
    assert.ok(p.killed().includes(ROOT + 2), `${gap} ms: what Claude Code started is ended`);
    assert.deepEqual(sent, []);
    assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), `${gap} ms: ${fin.reason}`);
    assert.match(fin.reason, otherWords(ROOT + 1), `${gap} ms: ${fin.reason}`);
    const rec = listRuns(place(), { item: id })[0];
    assert.match(rec.reason, new RegExp(alone.MAY_STILL_RUN), `${gap} ms: the record: ${rec.reason}`);
    assert.match(rec.reason, new RegExp(`${ROOT + 1}`), `${gap} ms: the record: ${rec.reason}`);
    assert.ok(!/ended \(/.test(rec.reason), `${gap} ms: never a plain ended: ${rec.reason}`);
    const line = logged.filter((l) => l.includes(alone.MAY_STILL_RUN) && l.includes(`${ROOT + 1}`));
    assert.equal(line.length, 1, `${gap} ms: one log line for the one end: ${logged.join('\n')}`);
    // the retry finds cmd.exe gone and keeps the first try's words (endTree)
    assert.match(line[0], otherWords(ROOT + 1));
  }
});

test('Windows: after a crash, a child that answers with another start is never ended and is recorded as one that may still run', async () => {
  const { id, crashed } = await crashedRun();
  const p = winLive(null, { rows: RUN_ROWS(), seen: (pid, start) => (pid === ROOT + 1 ? start + 2 : start) });
  const logged = [];
  const again = runnerOn(windows(), { killTree: undefined, winRun: p.run, log: (l) => logged.push(l) });
  await noSignals(() => again.begin());
  const rec = listRuns(place(), { item: id })[0];
  await crashed.close();
  await again.close();
  assert.ok(!p.killed().includes(ROOT + 1), JSON.stringify(p.killed()));
  assert.ok(p.killed().includes(ROOT), 'cmd.exe is ended');
  assert.match(rec.reason, new RegExp(alone.MAY_STILL_RUN), rec.reason);
  assert.match(rec.reason, otherWords(ROOT + 1), rec.reason);
  assert.ok(!logged.some((l) => /still working: ended/.test(l)), logged.join('\n'));
  assert.ok(logged.some((l) => l.includes(alone.MAY_STILL_RUN) && l.includes(`${ROOT + 1}`)), logged.join('\n'));
});

test('Windows: a child whose number went to a program started 2 ms to 3 s after it is not ended; the same start is', async () => {
  // Claude Code lived less than 3 s and exited between the table and the end call; its number went to another
  // program of the account, started `late` ms after it. Both starts are the system's own: only the same is the run's.
  for (const late of [2, 1000, 2999]) {
    const p = winLive(null, { rows: RUN_ROWS(), kill: (pid) => {
      if (pid === ROOT + 2) p.table.set(ROOT + 1, { pid: ROOT + 1, ppid: ROOT, start: 5100 + late, sid: ME });
      return true;
    } });
    const res = await alone.endWinTree(ROOT, { run: p.run, start: 5000, self: 700 });
    assert.ok(!p.killed().includes(ROOT + 1), `${late} ms later: the program that has that number now was ended: ${JSON.stringify(p.killed())}`);
    assert.ok(p.table.has(ROOT + 1), `${late} ms later: it still runs`);
    assert.deepEqual(res.ended, [ROOT + 2, ROOT], `${late} ms later: not counted as ended`);
  }
  const same = winLive(null, { rows: RUN_ROWS() });
  const res = await alone.endWinTree(ROOT, { run: same.run, start: 5000, self: 700 });
  assert.deepEqual(same.killed(), [ROOT + 2, ROOT + 1, ROOT], 'the same start: ended');
  assert.equal(res.ok, true);
});

test('Windows: the end call ends a child whose start is the table one or 1 ms below it, never one above it', async () => {
  // Claude Code's start as the end call reads it, against the table's 5100: the table's may be 1 ms above (CIM rounds
  // its microseconds up), never below; any start above the table's is another program that has that number now.
  for (const [gap, endsIt] of [[1, false], [2, false], [1000, false], [0, true], [-1, true], [-2, false]]) {
    const p = winLive(null, { rows: RUN_ROWS(), kill: (pid) => {
      if (pid === ROOT + 2) p.table.set(ROOT + 1, { pid: ROOT + 1, ppid: ROOT, start: 5100 + gap, sid: ME });
      return true;
    } });
    const res = await alone.endWinTree(ROOT, { run: p.run, start: 5000, self: 700 });
    assert.equal(p.killed().includes(ROOT + 1), endsIt, `${gap} ms: ${endsIt ? 'the same process was not ended' : 'another program was ended'}: ${JSON.stringify(p.killed())}`);
    assert.equal(res.ended.includes(ROOT + 1), endsIt, `${gap} ms: ${JSON.stringify(res)}`);
    if (!endsIt) assert.ok(p.table.has(ROOT + 1), `${gap} ms: it still runs`);
  }
});

test('Windows: a child the end call says failed keeps cmd.exe, and the run says its tool may still run', async () => {
  const w = windows();
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, [...args]]);
    if (cmd !== 'powershell.exe') return { ok: true, out: '' };
    // Windows' own words: the lowest was ended, Claude Code could not be
    return endEntries(scriptOf(args)) ? { ok: true, out: `${ROOT + 2} ended\r\n${ROOT + 1} failed` } : { ok: true, out: JSON.stringify({ me: ME, procs: RUN_ROWS() }) };
  };
  const res = await alone.endWinTree(ROOT, { run, start: 5000, self: 700 });
  assert.equal(res.ok, false);
  assert.match(res.why, new RegExp(`process ${ROOT + 1} could not be ended`));
  assert.deepEqual(res.ended, [ROOT + 2]);
  assert.ok(!calls.some(([c]) => c === 'taskkill'), 'cmd.exe stays');
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: run });
  let fin;
  await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  w.children.get(ROOT).finish();
  await r.close();
  assert.ok(fin);
  assert.ok(!calls.some(([c]) => c === 'taskkill'), 'cmd.exe stays');
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
  assert.match(fin.reason, new RegExp(`${ROOT + 1}`), fin.reason);
});

// The first try cannot end what Claude Code started (ROOT+2); before the second try Claude Code exits by itself, and
// ROOT+2 keeps naming it, a dead parent, so it is not found from cmd.exe any more. The second try then ends cmd.exe
// alone: that must not count as the whole tree ended while ROOT+2 still runs at the start the first try saw.
test('Windows: a second try that ends a smaller tree is not ok while what the first try could not end still runs', async () => {
  const without = (...pids) => RUN_ROWS().filter((x) => !pids.includes(x.pid));
  const lone = (rows) => async (cmd, args) => (cmd !== 'powershell.exe' ? { ok: false, out: '' } : endEntries(scriptOf(args)) ? { ok: true, out: '' } : { ok: true, out: JSON.stringify({ me: ME, procs: rows }) });
  const left = [{ pid: ROOT + 2, start: 5200 }, { pid: ROOT + 1, start: 5100 }];
  // Still there at the start the first try saw: not ok, and it names that process.
  let res = await alone.endWinTree(ROOT, { run: lone(without(ROOT + 1)), start: 5000, self: 700, endRoot: () => true, first: left });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.match(res.why, new RegExp(`process ${ROOT + 2} that the first try could not end still runs`));
  assert.deepEqual(res.ended, [ROOT]);
  // Gone, or another program under that number now: ok.
  res = await alone.endWinTree(ROOT, { run: lone(without(ROOT + 1, ROOT + 2)), start: 5000, self: 700, endRoot: () => true, first: left });
  assert.equal(res.ok, true, JSON.stringify(res));
  const reused = without(ROOT + 1).map((x) => (x.pid === ROOT + 2 ? { ...x, start: 9000 } : x));
  res = await alone.endWinTree(ROOT, { run: lone(reused), start: 5000, self: 700, endRoot: () => true, first: left });
  assert.equal(res.ok, true, JSON.stringify(res));

  // Through the whole runner, at the time limit: the run says its tool may still run, naming ROOT+2.
  const w = windows();
  let tables = 0;
  const run = async (cmd, args) => {
    if (cmd !== 'powershell.exe') return { ok: false, out: '' };
    if (endEntries(scriptOf(args))) return { ok: true, out: `${ROOT + 2} failed\r\n${ROOT + 1} kept` };
    return { ok: true, out: JSON.stringify({ me: ME, procs: ++tables >= 2 ? without(ROOT + 1) : RUN_ROWS() }) };
  };
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: run });
  let fin;
  await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  if (w.children.get(ROOT)) w.children.get(ROOT).finish();
  await r.close();
  assert.ok(fin);
  assert.ok(tables >= 2, 'the second try read the table');
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
  assert.match(fin.reason, new RegExp(`${ROOT + 2}`), fin.reason);
});

test('Windows: an end call that says "kept" with no "failed" line keeps cmd.exe, and the run says its tool may still run', async () => {
  const w = windows();
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, [...args]]);
    if (cmd !== 'powershell.exe') return { ok: true, out: '' };
    // an answer the script should not give: the lowest ended, Claude Code "kept", and no line that failed
    return endEntries(scriptOf(args)) ? { ok: true, out: `${ROOT + 2} ended\r\n${ROOT + 1} kept` } : { ok: true, out: JSON.stringify({ me: ME, procs: RUN_ROWS() }) };
  };
  const res = await alone.endWinTree(ROOT, { run, start: 5000, self: 700 });
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.deepEqual(res.ended, [ROOT + 2]);
  assert.match(res.why, new RegExp(`process ${ROOT + 1} could not be ended`));
  assert.ok(!calls.some(([c]) => c === 'taskkill'), 'cmd.exe stays');
  // any other word, or no line at all, is the same
  for (const out of [`${ROOT + 2} ended\r\n${ROOT + 1} maybe`, `${ROOT + 2} ended`]) {
    const r2 = await alone.endWinTree(ROOT, { run: async (cmd, args) => (cmd !== 'powershell.exe' ? { ok: true, out: '' } : endEntries(scriptOf(args)) ? { ok: true, out } : { ok: true, out: JSON.stringify({ me: ME, procs: RUN_ROWS() }) }), start: 5000, self: 700 });
    assert.equal(r2.ok, false, `${JSON.stringify(out)}: ${JSON.stringify(r2)}`);
    assert.ok(!r2.ended.includes(ROOT), `${JSON.stringify(out)}: cmd.exe was ended`);
  }
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: run });
  let fin;
  await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  w.children.get(ROOT).finish();
  await r.close();
  assert.ok(fin);
  assert.ok(!calls.some(([c]) => c === 'taskkill'), 'cmd.exe stays');
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
});

test('Windows: both tries of the tree end fail for different reasons and the first try pid is kept in the reason', async () => {
  const w = windows();
  let tables = 0;
  const run = async (cmd, args) => {
    if (cmd !== 'powershell.exe') return { ok: false, out: '' };
    if (endEntries(scriptOf(args))) return { ok: true, out: `${ROOT + 2} ended\r\n${ROOT + 1} failed` };
    // the second try cannot read the table: it fails for a reason of its own that names no pid
    return ++tables >= 2 ? { ok: false, out: '' } : { ok: true, out: JSON.stringify({ me: ME, procs: RUN_ROWS() }) };
  };
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: run });
  let fin;
  await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  w.children.get(ROOT).finish();
  await r.close();
  assert.ok(fin);
  assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
  assert.match(fin.reason, /the system did not say which processes run/, fin.reason);
  assert.match(fin.reason, new RegExp(`${ROOT + 1}`), `the first try pid is kept in the reason: ${fin.reason}`);
});

test('Windows: a run settled while its tool may still run keeps its worktree: the next run of its schedule waits until it closes', async () => {
  const w = windows();
  // Claude Code cannot be ended, on both tries; cmd.exe stays open
  const run = async (cmd, args) => {
    if (cmd !== 'powershell.exe') return { ok: false, out: '' };
    return endEntries(scriptOf(args)) ? { ok: true, out: `${ROOT + 2} ended\r\n${ROOT + 1} failed` } : { ok: true, out: JSON.stringify({ me: ME, procs: RUN_ROWS() }) };
  };
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: run });
  const job = { schedule: { id: 'still0001', label: 'Nightly' }, project: 'shop', prompt: 'DO:nothing', provider: 'sub', minutes: 1 };
  try {
    const first = await r.startAlone(job);
    const fin = await within(first.done, 5000);
    assert.ok(fin, 'the run settles although its child is still open');
    assert.match(fin.reason, new RegExp(alone.MAY_STILL_RUN), fin.reason);
    const next = await r.startAlone({ ...job, minutes: 30 });
    assert.equal(next.waiting, true, `the next slot started in the same worktree: ${JSON.stringify(next.run && next.run.id)}`);
    assert.match(next.why, /may still be running in work\/still0001/);
    assert.equal(w.spawned.length, 1);
    w.children.get(ROOT).finish(); // the earlier run's cmd.exe closes at last
    for (let i = 0; i < 100 && w.spawned.length < 2; i++) await sleep(20);
    assert.equal(w.spawned.length, 2, 'it starts once that child has closed');
    assert.deepEqual(r.waiting().filter((x) => x.key === 'still0001'), []);
  } finally {
    for (const c of w.children.values()) c.finish();
    await r.close();
  }
});

test('Windows: the root end answers false but Node sees cmd.exe exit 30 ms later: ended, no false alarm; no exit at all: the failure', async () => {
  // As a real npm shim: once Claude Code is ended, cmd.exe exits at once at the system; kill() on its handle answers
  // false (ESRCH), and Node's 'exit' for it comes 30 ms later.
  const w = windows();
  const p = winLive(w, { rows: RUN_ROWS(), kill: (pid) => {
    if (pid !== ROOT) return true;
    setTimeout(() => w.children.get(ROOT).exitAlone(10), 30);
    return false;
  } });
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: p.run });
  let fin;
  const sent = await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.deepEqual(sent, []);
  assert.ok(fin);
  assert.equal(fin.state, 'stopped');
  assert.ok(!fin.reason.includes(alone.MAY_STILL_RUN), fin.reason);
  // endWinTree alone: the exit 30 ms after a false answer is the root's end; no exit within the wait is the failure
  let exited = false;
  const q = winLive(null, { rows: RUN_ROWS() });
  const res = await alone.endWinTree(ROOT, { run: q.run, gone: () => exited, start: 5000, self: 700, endRoot: () => {
    setTimeout(() => (exited = true), 30);
    return false;
  } });
  assert.deepEqual(res, { ok: true, ended: [ROOT + 2, ROOT + 1, ROOT] });
  const f = winLive(null, { rows: RUN_ROWS() });
  const t0 = Date.now();
  const no = await alone.endWinTree(ROOT, { run: f.run, gone: () => false, start: 5000, self: 700, endRoot: () => false });
  assert.equal(no.ok, false);
  assert.match(no.why, new RegExp(`process ${ROOT} could not be ended`));
  assert.ok(Date.now() - t0 < alone.ROOT_EXIT_WAIT_MS + 500, 'the wait is bounded');
});

// taskkill is a name the test runner traps, and every product caller of the tree end gets the real programs: the
// root is never ended by taskkill. A live run ends it through its own child handle; a leftover in the one end call.
test('Windows: a live run ends its root through its own child handle, last, and starts no program but PowerShell', async () => {
  const w = windows();
  const p = winLive(w, { rows: RUN_ROWS() });
  const r = runnerOn(w, { minuteMs: 50, killTree: undefined, winRun: p.run });
  let fin;
  const sent = await noSignals(async () => {
    const s = await r.startAlone({ item: await task(), provider: 'sub', minutes: 1 });
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.ok(fin);
  assert.deepEqual(p.calls.filter(([c]) => c !== 'powershell.exe').map(([c]) => c), [], 'no taskkill, nor any other program');
  assert.deepEqual(w.kills, [[ROOT, 'SIGKILL']], 'the root through the child handle');
  assert.deepEqual(p.killed(), [ROOT + 2, ROOT + 1, ROOT], 'the lowest first, the root last');
  assert.ok(p.scripts.every((s) => !endEntries(s).some((e) => e.pid === ROOT)), 'a live run\'s root is not in the end call');
  assert.deepEqual(sent, []);
  assert.equal(fin.state, 'stopped');
  assert.ok(!fin.reason.includes(alone.MAY_STILL_RUN), fin.reason);
  // endWinTree alone: endRoot is asked once, after the end call; false or a throw is a failure that names the root
  for (const endRoot of [() => false, () => {
    throw new Error('no handle');
  }]) {
    const q = winLive(null, { rows: RUN_ROWS() });
    const res = await alone.endWinTree(ROOT, { run: q.run, start: 5000, self: 700, endRoot });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(res.why, new RegExp(`process ${ROOT} could not be ended`));
    assert.deepEqual(res.ended, [ROOT + 2, ROOT + 1]);
  }
  const order = [];
  const q = winLive(null, { rows: RUN_ROWS(), kill: (pid) => (order.push(pid), true) });
  const ok = await alone.endWinTree(ROOT, { run: q.run, start: 5000, self: 700, endRoot: () => (order.push('root'), true) });
  assert.deepEqual(order, [ROOT + 2, ROOT + 1, 'root']);
  assert.deepEqual(ok, { ok: true, ended: [ROOT + 2, ROOT + 1, ROOT] });
  // a child that failed keeps the root: endRoot is never asked
  let asked = 0;
  const f = winLive(null, { rows: RUN_ROWS(), kill: (pid) => pid !== ROOT + 1 });
  const kept = await alone.endWinTree(ROOT, { run: f.run, start: 5000, self: 700, endRoot: () => ++asked > 0 });
  assert.equal(kept.ok, false);
  assert.equal(asked, 0, 'the root stays when what is below it failed');
  // nothing in the source starts taskkill
  const src = fs.readFileSync(new URL('../../src/work/alone.mjs', import.meta.url), 'utf8');
  assert.ok(!/['"`]taskkill['"`]|taskkillArgs/.test(src), 'src/work/alone.mjs names taskkill as a program');
});

test('Windows: after a crash, the root is the last of the one end call, and ended there only at the start the run kept', async () => {
  const { id, crashed } = await crashedRun();
  const p = winLive(null, { rows: RUN_ROWS() });
  const again = runnerOn(windows(), { killTree: undefined, winRun: p.run });
  const sent = await noSignals(() => again.begin());
  const rec = listRuns(place(), { item: id })[0];
  await crashed.close();
  await again.close();
  assert.deepEqual(p.calls.filter(([c]) => c !== 'powershell.exe').map(([c]) => c), [], 'no taskkill, nor any other program');
  assert.equal(p.scripts.length, 1, 'one end call');
  assert.deepEqual(endEntries(p.scripts[0]), [{ pid: ROOT + 2, start: 5200, ppid: ROOT + 1 }, { pid: ROOT + 1, start: 5100, ppid: ROOT }, { pid: ROOT, start: 5000, ppid: 700 }], 'the root last, at its kept start');
  assert.deepEqual(p.killed(), [ROOT + 2, ROOT + 1, ROOT]);
  assert.deepEqual(sent, []);
  assert.equal(rec.state, 'stopped');
  assert.ok(!rec.reason.includes(alone.MAY_STILL_RUN), rec.reason);
  // the start the end call reads now, against the kept 5000: the same or 1 ms below ends it; above, or more below, never
  for (const [now, endsIt] of [[5000, true], [4999, true], [5001, false], [5500, false], [9000, false], [4998, false]]) {
    const q = winLive(null, { rows: RUN_ROWS(), seen: (pid, start) => (pid === ROOT ? now : start) });
    const res = await alone.endWinTree(ROOT, { run: q.run, start: 5000, self: 700 });
    assert.equal(q.killed().includes(ROOT), endsIt, `${now}: ${JSON.stringify(q.killed())}`);
    assert.equal(res.ok, endsIt, `${now}: ${JSON.stringify(res)}`);
    if (!endsIt) assert.match(res.why, otherWords(ROOT));
    assert.deepEqual(q.killed().slice(0, 2), [ROOT + 2, ROOT + 1], `${now}: what is below it is still ended`);
  }
  // the kept start, not the table's: a table that says 5002 (within SAME_WITHIN of the kept 5000) is another
  // program's root, refused before any end call (nothing below it is the run's either)
  const t2 = winLive(null, { rows: RUN_ROWS().map((x) => (x.pid === ROOT ? { ...x, start: 5002 } : x)) });
  const r2 = await alone.endWinTree(ROOT, { run: t2.run, start: 5000, self: 700 });
  assert.equal(t2.scripts.length, 0);
  assert.deepEqual(t2.killed(), [], JSON.stringify(t2.killed()));
  assert.equal(r2.ok, false);
  assert.match(r2.why, /not the one the run started/);
  // after a crash, a root that answers with another start is never ended, and the run is recorded as one that may run
  const left = await crashedRun();
  const o = winLive(null, { rows: RUN_ROWS(), seen: (pid, start) => (pid === ROOT ? start + 500 : start) });
  const logged = [];
  const next = runnerOn(windows(), { killTree: undefined, winRun: o.run, log: (l) => logged.push(l) });
  await noSignals(() => next.begin());
  const rec2 = listRuns(place(), { item: left.id })[0];
  await left.crashed.close();
  await next.close();
  assert.ok(!o.killed().includes(ROOT), JSON.stringify(o.killed()));
  assert.match(rec2.reason, new RegExp(alone.MAY_STILL_RUN), rec2.reason);
  assert.match(rec2.reason, otherWords(ROOT), rec2.reason);
  // a child that failed keeps the root in the end call ("kept"), and the end fails
  const k = winLive(null, { rows: RUN_ROWS(), kill: (pid) => pid !== ROOT + 1 });
  const kr = await alone.endWinTree(ROOT, { run: k.run, start: 5000, self: 700 });
  assert.ok(!k.killed().includes(ROOT), JSON.stringify(k.killed()));
  assert.equal(kr.ok, false);
  assert.match(kr.why, new RegExp(`process ${ROOT + 1} could not be ended`));
});

// A cmdlet that loads a module took about 17 s per call on a Windows runner: the table is read through WMI's
// System.Management searcher, the owner through the WMI method on the row, as the server's NO_MODULE_PRELUDE does.
test('Windows: no script of the tree end holds a cmdlet or taskkill; the table is read through System.Management', () => {
  const scripts = {
    table: alone.runTreeScript(ROOT),
    end: alone.endBelowScript([{ pid: ROOT + 2, start: 5200, ppid: ROOT + 1 }, { pid: ROOT, start: 5000, ppid: 700 }]),
  };
  for (const [name, s] of Object.entries(scripts)) {
    for (const c of ['Get-CimInstance', 'Invoke-CimMethod', 'Get-Process', 'Stop-Process', 'taskkill', 'ConvertTo-Json']) assert.ok(!s.includes(c), `${name}: ${c}`);
    assert.ok(!/\b(Get|Stop|Set|Invoke|New|Wait|Select|Where|ForEach|ConvertTo|Out|Write)-[A-Za-z]/.test(s), `${name}: no cmdlet: ${s}`);
  }
  const s = scripts.table;
  assert.match(s, /\[System\.Management\.ManagementObjectSearcher\]::new\('SELECT Handle,ProcessId,ParentProcessId,CreationDate FROM Win32_Process'\)\.Get\(\)/);
  assert.match(s, /\$p\.InvokeMethod\('GetOwnerSid', \$null, \$null\)/, 'the owner through the WMI method on the row');
  assert.match(s, /\$o\['ReturnValue'\] -eq 0/);
  // the start: the DMTF string turned into the same DateTime the CIM value gave, then whole ms
  assert.match(s, /\(\[DateTimeOffset\]\[System\.Management\.ManagementDateTimeConverter\]::ToDateTime\(\$p\['CreationDate'\]\)\)\.ToUnixTimeMilliseconds\(\)/);
  assert.match(s, /\$json\.Serialize\(@\{ me = \$me; procs = \$procs\.ToArray\(\) \}\)/, 'the JSON written by .NET');
  assert.match(s, new RegExp(`\\$below = @\\{ ${ROOT} = \\$true \\}`), 'the owner asked only below the run\'s pid');
  // what .NET's JavaScriptSerializer writes for that shape (one row, a null start and owner) is read as before
  const out = JSON.stringify({ me: ME, procs: [{ pid: ROOT, ppid: 700, start: 5000, sid: ME }, { pid: 12, ppid: 4, start: null, sid: null }] });
  const snap = alone.parseRunTree(out);
  assert.deepEqual(snap.procs.get(ROOT), { pid: ROOT, ppid: 700, start: 5000, sid: ME });
  assert.deepEqual(snap.procs.get(12), { pid: 12, ppid: 4, start: null, sid: null });
});

// A schedule's run whose coding tool may still be running (Windows) asks once for that schedule to be switched off
// (scheduleOff: src/automation index.mjs switchOff, the owner's own switch) and says so in its reason: at a stop, at
// the time limit, and as the leftover of a dashboard that stopped. Never for a run of no schedule, a run that ended
// cleanly, or on Linux with the same made-up failure (its end does not ask Windows' tree end at all).
const failing = () => ({ ok: false, why: `process ${ROOT + 1} could not be ended` });
const cleanEnd = (pid, w) => {
  w.ended.push(pid);
  w.children.get(pid)?.finish();
};
let nOff = 0;
const ofSchedule = () => ({ schedule: { id: `still${String(++nOff).padStart(4, '0')}`, label: 'Nightly' }, project: 'shop', prompt: 'Tidy the docs' });
const OFF_WORDS = /\. The schedule "Nightly" was switched off: switch it on again in Work → Schedules once that program has ended$/;
const offSpy = (name) => {
  const calls = [];
  return { calls, scheduleOff: (id, why) => (calls.push([id, why]), name) };
};
/** Linux: process.kill held; a signal ends the made-up child of that pid, nothing is sent (the grace's SIGKILL too). */
async function heldSignals(w, fn) {
  const real = process.kill;
  process.kill = (pid, sig) => {
    if (sig !== 0) w.children.get(Math.abs(pid))?.finish();
    return true;
  };
  try {
    await fn();
    await sleep(200);
  } finally {
    process.kill = real;
  }
}
const madeUp = (platform) => {
  const w = windows();
  if (platform !== 'win32') w.next = 99_000_001; // a number no process of a Linux computer has (at most 4194304)
  return w;
};
const held = (platform, w, fn) => (platform === 'win32' ? noSignals(fn) : heldSignals(w, fn));

/** A live run of `job` settled by `way` ('stop' or 'time limit') on `platform`, its tree end answering `end`. */
async function settledBy(way, job, { platform = 'win32', end = failing, name = 'Nightly' } = {}) {
  const w = madeUp(platform);
  const spy = offSpy(name);
  const r = runnerOn(w, { platform, minuteMs: way === 'time limit' ? 50 : 60_000, killTree: (pid) => end(pid, w), scheduleOff: spy.scheduleOff });
  let fin = null;
  await held(platform, w, async () => {
    const s = await r.startAlone({ ...job, provider: 'sub', minutes: 1 });
    if (way === 'stop') {
      await sleep(20);
      assert.equal(r.stop(s.run.id, 'Stopped by the person'), true);
    }
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.ok(fin, `${way}: the run settled`);
  return { reason: fin.reason || '', calls: spy.calls };
}
/** A run of `job` left by a dashboard that crashed, settled by the next start on `platform`, its tree end answering `end`. */
async function leftBy(job, { platform = 'win32', end = failing, name = 'Nightly' } = {}) {
  const crashed = runnerOn(madeUp(platform));
  const { run } = await crashed.startAlone({ ...job, provider: 'sub', minutes: 30 });
  await sleep(20); // its process is kept, as T:5000
  const w = madeUp(platform);
  const spy = offSpy(name);
  const again = runnerOn(w, { platform, killTree: (pid) => end(pid, w), scheduleOff: spy.scheduleOff });
  await held(platform, w, () => again.begin());
  const rec = listRuns(place()).find((x) => x.id === run.id); // read before the crashed runner's own close writes its end
  await crashed.close();
  await again.close();
  assert.equal(rec.state, 'stopped');
  return { reason: rec.reason || '', calls: spy.calls };
}

test('Windows: a schedule\'s run that may have left its tool running asks once for its schedule to be switched off, and says so', async () => {
  for (const way of ['stop', 'time limit', 'leftover']) {
    const job = ofSchedule();
    const { reason, calls } = way === 'leftover' ? await leftBy(job) : await settledBy(way, job);
    assert.match(reason, new RegExp(`${alone.MAY_STILL_RUN} \\(it could not be ended: process ${ROOT + 1} could not be ended\\)`), `${way}: ${reason}`);
    assert.deepEqual(calls.map(([id]) => id), [job.schedule.id], `${way}: once, with the id of its schedule`);
    assert.equal(calls[0][1], `a program of its last run may still be running in shop (it could not be ended: process ${ROOT + 1} could not be ended); switch it on again in Work → Schedules once that program has ended`);
    assert.match(reason, OFF_WORDS, `${way}: ${reason}`);
    // A schedule that was off already (or is gone): asked, nothing switched, and its reason says nothing of it.
    const off = way === 'leftover' ? await leftBy(ofSchedule(), { name: null }) : await settledBy(way, ofSchedule(), { name: null });
    assert.equal(off.calls.length, 1);
    assert.match(off.reason, new RegExp(alone.MAY_STILL_RUN));
    assert.ok(!/switched off/.test(off.reason), `${way}: ${off.reason}`);
  }
});

// A long detail (several pids, as a second try that lost some names them) must not cut the instruction that ends the
// reason (400 characters) or the Activity line (300 after "off: "): the detail is cut instead.
test('Windows: with a long detail the switch sentence still ends the reason and the Activity line whole', async () => {
  const pids = Array.from({ length: 12 }, (_, i) => ROOT + 10 + i).join(', ');
  const long = () => ({ ok: false, why: `process ${pids} could not be ended; process ${ROOT + 2} that the first try could not end still runs and is not found from the run any more` });
  for (const way of ['stop', 'time limit', 'leftover']) {
    const job = ofSchedule();
    const { reason, calls } = way === 'leftover' ? await leftBy(job, { end: long }) : await settledBy(way, job, { end: long });
    assert.ok(reason.length <= 400, `${way}: ${reason.length}`);
    assert.match(reason, new RegExp(alone.MAY_STILL_RUN), `${way}: ${reason}`);
    assert.match(reason, OFF_WORDS, `${way}: the sentence is whole: ${reason}`);
    assert.equal(calls.length, 1);
    assert.ok(`off: ${calls[0][1]}`.length <= 300, `${way}: ${calls[0][1].length}`);
    assert.match(calls[0][1], /; switch it on again in Work → Schedules once that program has ended$/, `${way}: ${calls[0][1]}`);
  }
});

// Names at their own limits (a schedule name of 60, a project of 100), the longest head (240 minutes) and a refused
// step after the detail: the reason is built to fit, so the switch sentence still ends it whole; the detail goes first.
test('Windows: names at their limits and a refused step still leave the switch sentence whole at the end of the reason', async () => {
  const head = `Stopped at the time limit (240 minutes); what it had done so far is kept. ${alone.MAY_STILL_RUN} (it could not be ended: `;
  const detail = `process ${ROOT + 2} could not be ended; process ${ROOT + 3}, ${ROOT + 5} answered with another start than the table's: it may be another program now; it was not ended`;
  const refused = '. A step needed an OK and was refused (Bash, Write, Edit, WebFetch, NotebookEdit): nobody was there to allow it';
  const ENDS = /\. The schedule "[^"]+" was switched off: switch it on again in Work → Schedules once that program has ended$/;
  for (const [name, tail] of [['N'.repeat(60), ''], ['N'.repeat(60), refused], ['Nightly', refused], ['Nightly', '']]) {
    const r = alone.stillReason(head, detail, tail, name);
    assert.ok(r.length <= 388, `${name.length}: ${r.length}`);
    assert.match(r, ENDS, r);
    // What could not be ended is cut first, keeping its beginning (the first pids named).
    assert.ok(r.startsWith(`${head}p`) || r.startsWith(`${head}…`), r);
    // The refused step is kept whole: the detail and the name give way first.
    if (tail) assert.ok(r.includes(refused.slice(2)), r);
  }
  // Without a switched-off schedule the reason is exactly as before.
  assert.equal(alone.stillReason(head, detail, refused, null), `${head}${detail})${refused}`);
  // Through the whole runner, at the time limit, with a schedule name of 60 characters and a long detail.
  const long = () => ({ ok: false, why: detail });
  const { reason } = await settledBy('time limit', ofSchedule(), { end: long, name: 'N'.repeat(60) });
  assert.ok(reason.length <= 400, `${reason.length}`);
  assert.match(reason, ENDS, reason);
});

test('Windows: a run of no schedule or one that ended cleanly, and Linux with the same failure, switch no schedule off', async () => {
  for (const way of ['stop', 'time limit', 'leftover']) {
    const by = (job, o) => (way === 'leftover' ? leftBy(job, o) : settledBy(way, job, o));
    // a task's run (Do it, a task's run time): the same failure, its words as they were
    const task1 = await by({ item: await task() });
    assert.match(task1.reason, new RegExp(alone.MAY_STILL_RUN), `${way}: ${task1.reason}`);
    assert.deepEqual(task1.calls, [], `${way}: a run of no schedule`);
    assert.ok(!/switched off/.test(task1.reason));
    // a schedule's run whose tree was ended
    const clean = await by(ofSchedule(), { end: cleanEnd });
    assert.deepEqual(clean.calls, [], `${way}: ended cleanly`);
    assert.ok(!clean.reason.includes(alone.MAY_STILL_RUN), `${way}: ${clean.reason}`);
    // Linux: the same made-up failure is never asked (the tool's group gets its signals)
    const linux = await by(ofSchedule(), { platform: 'linux' });
    assert.deepEqual(linux.calls, [], `${way}: Linux`);
    assert.ok(!linux.reason.includes(alone.MAY_STILL_RUN), `${way}: ${linux.reason}`);
  }
  // a schedule's run that ended by itself on Windows
  const w = windows();
  const spy = offSpy('Nightly');
  const r = runnerOn(w, { scheduleOff: spy.scheduleOff });
  let fin;
  await noSignals(async () => {
    const s = await r.startAlone({ ...ofSchedule(), provider: 'sub', minutes: 30 });
    await sleep(20);
    w.children.get(w.next - 1).exitAlone(10);
    fin = await within(s.done, 5000);
  });
  await r.close();
  assert.ok(fin);
  assert.deepEqual(spy.calls, []);
  assert.deepEqual(w.ended, [], 'nothing was ended');
});
