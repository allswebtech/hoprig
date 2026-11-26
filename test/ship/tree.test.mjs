// A command and everything it started as one tree (src/cmdtree.mjs, src/ship/runcmd.mjs), with the answers Windows
// gives handed in: the command is started detached on every system, its tree is read from a snapshot of processes by
// parent and start (a pid Windows gave to a later process is not of it), it is ended pid by pid, the command first,
// and the keeper of its output looks at the processes at most every 30 s, by parent and start.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { tempShip } from './helpers.mjs';

const t = tempShip('ship-tree');
test.after(() => t.cleanup());
const { endTree, keeperGone, parseTable, treeOf, TREE_NOT_ENDED } = await import('../../src/cmdtree.mjs');
const { END_SAME_MS } = await import('../../src/winend.mjs');
const { endCommand, endWords, runCommand } = await import('../../src/ship/runcmd.mjs');

// The command 100 started at 10000 and has ended; Windows gave its pid to a later process (started at 50000).
const table = () => new Map([
  [100, { ppid: 4, start: 50_000 }], // the later holder of the command's pid
  [101, { ppid: 100, start: 12_000 }], // the command's server
  [102, { ppid: 101, start: 13_000 }], // what the server started
  [103, { ppid: 100, start: 5000 }], // older than the command: it names an earlier holder of that pid
  [104, { ppid: 100, start: 60_000 }], // started by the later holder
  [105, { ppid: 100, start: 14_000 }], // another one of the command's
  [7, { ppid: 1, start: 10 }],
]);

test('the tree of a command is what descends from it by parent and start, never what a later holder of its pid started', () => {
  assert.deepEqual(treeOf({ pid: 100, start: 10_000 }, table()), [101, 102, 105]);
  assert.deepEqual(treeOf({ pid: 101, start: 12_000 }, table()), [102], 'a living process: everything below it');
  assert.deepEqual(treeOf({ pid: 9, start: 10_000 }, table()), []);
  assert.deepEqual([...parseTable('[{"pid":5,"ppid":4,"start":1700000000000},{"pid":6,"ppid":5,"start":0}]')], [[5, { ppid: 4, start: 1_700_000_000_000 }], [6, { ppid: 5, start: null }]]);
  assert.equal(parseTable('not json'), null);
});

test('a running command whose start was read before it began is no later holder of its own pid; a dead one still is', () => {
  // As on Windows: the start handed in is when its starter asked for it (10000), the system says it began at 12500 (Node
  // took 2.5 s to start), its child at 12600 (same moment or later).
  const now = new Map([[100, { ppid: 4, start: 12_500 }], [101, { ppid: 100, start: 12_600 }], [102, { ppid: 101, start: 12_600 }]]);
  assert.deepEqual(treeOf({ pid: 100, start: 10_000, alive: true }, now), [101, 102], 'the running command: everything below it');
  assert.deepEqual(treeOf({ pid: 100, start: 10_000 }, now), [], 'not known to run: a holder that began later is another process, and so are its children');
  assert.deepEqual(treeOf({ pid: 100, start: 12_500, alive: true }, new Map([[100, { ppid: 4, start: 12_500 }], [101, { ppid: 100, start: 12_500 }]])), [101], 'started in the same millisecond');
});

test('ending a tree: on Windows read first, then the command and each process of its tree by pid; elsewhere its group', async () => {
  const killed = [];
  const kill = (p, s) => killed.push([p, s]);
  // The command has ended, and Windows gave its pid to a later process (100 in the table): that one is never ended.
  const w = endTree({ pid: 100, start: 10_000 }, 'SIGKILL', { platform: 'win32', kill, table: async () => table() });
  assert.equal(w.ok, true);
  assert.deepEqual(await w.rest, [101, 102, 105]);
  assert.deepEqual(killed, [[100, 0], [101, 'SIGKILL'], [102, 'SIGKILL'], [105, 'SIGKILL']], 'never by a name, never a group, never the later holder of its pid');
  killed.length = 0;
  let asked = 0;
  const l = endTree({ pid: 100, start: 10_000 }, 'SIGTERM', { platform: 'linux', kill, table: async () => (asked++, table()) });
  assert.deepEqual([l.ok, await l.rest, killed, asked], [true, [], [[-100, 'SIGTERM']], 0], 'Linux and macOS: the group, as before');
  // The tree is read before anything of it ends: Node ends a child it started without detaching (101) with its parent
  // (100), and what that child started (102) would then name a parent that is gone. What started meanwhile (106,
  // below 102) is found in a second look. The stand-in system below does both.
  const live = new Map([[100, { ppid: 4, start: 10_000 }], [101, { ppid: 100, start: 11_000 }], [102, { ppid: 101, start: 12_000 }]]);
  let looks = 0;
  const sysKill = (p, sig) => {
    if (!live.has(p)) throw new Error('ESRCH');
    if (sig === 0) return;
    live.delete(p);
    if (p === 100) live.delete(101); // Node's job ends the child it started with it
  };
  const look = async () => {
    looks += 1;
    const now = new Map(live);
    if (looks === 1) live.set(106, { ppid: 102, start: 13_000 }); // started just after the first look
    return now;
  };
  const c = endTree({ pid: 100, start: 10_000, alive: true }, 'SIGKILL', { platform: 'win32', kill: sysKill, table: look });
  assert.equal(c.ok, true);
  assert.deepEqual((await c.rest).sort(), [102, 106], 'what the job did not end is ended by pid, also what started meanwhile');
  assert.deepEqual([...live.keys()], [], 'nothing of the tree is left');
  const none = endTree({ pid: 100, start: 10_000 }, 'SIGKILL', { platform: 'win32', kill: () => { throw new Error('gone'); }, table: async () => null });
  assert.deepEqual([none.ok, await none.rest], [false, []], 'a command that ended and a snapshot that failed end nothing');
});

test('the keeper on Windows looks at the processes at most every 30 s, by parent and start: a later holder of the pid keeps nothing', async () => {
  let clock = 0;
  let snaps = 0;
  let procs = table();
  const gone = keeperGone({ pid: 100, start: 10_000 }, { table: async () => (snaps++, procs), now: () => clock });
  assert.equal(await gone(), false, 'its server is left');
  assert.equal(snaps, 1);
  clock += 29_000;
  assert.equal(await gone(), false);
  assert.equal(snaps, 1, 'not again within 30 s');
  procs = new Map([[7, { ppid: 1, start: 10 }]]);
  clock += 1000;
  assert.equal(await gone(), true, 'nothing of it is left');
  procs = null;
  clock += 30_000;
  const g2 = keeperGone({ pid: 100, start: 10_000 }, { table: async () => null, now: () => clock });
  assert.equal(await g2(), false, 'a snapshot that failed keeps the file bounded');
  // The command has ended and Windows gave its pid to another process, which lives on (a service): with nothing of the
  // command left the keeper ends at its first look, whatever that process started.
  // Its pid: one that lives here (this test's own process plays that other process).
  const pid = process.pid;
  const reused = new Map([[pid, { ppid: 4, start: 50_000 }], [104, { ppid: pid, start: 60_000 }], [7, { ppid: 1, start: 10 }]]);
  const g3 = keeperGone({ pid, start: 10_000 }, { table: async () => reused, now: () => clock });
  assert.equal(await g3(), true, 'a later holder of its pid keeps no keeper up');
});

/** A stand-in for spawn: a child that ends when told (`.child.end()`), its options kept. */
function fakeSpawn(seen) {
  return (cmd, args, opts) => {
    const c = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null, kill() {} });
    c.end = () => ((c.exitCode = 0), c.emit('exit', 0, null), c.emit('close', 0, null));
    seen.push({ cmd, args, opts, child: c });
    return c;
  };
}

test('a command is started detached on Windows too, its output a file, and its time limit ends its tree', async () => {
  const seen = [];
  const ends = [];
  const end = (root, sig, o) => (ends.push([root.pid, sig, o.platform]), { ok: true, rest: Promise.resolve([]) });
  const p = runCommand(['node', '-e', '0'], { cwd: t.root, minutes: 0.001, platform: 'win32', endGroup: true, spawnImpl: fakeSpawn(seen), end });
  const child = await new Promise((r) => {
    const iv = setInterval(() => ends.length && (clearInterval(iv), r(seen[0])), 10);
  });
  child.child.end();
  assert.equal((await p).timedOut, true);
  assert.equal(child.opts.detached, true, 'detached: it outlives a restart of the dashboard');
  assert.equal(child.opts.windowsHide, true);
  assert.equal(child.opts.stdio[0], 'ignore');
  assert.ok(Number.isInteger(child.opts.stdio[1]) && child.opts.stdio[1] === child.opts.stdio[2], 'its output is a file, never a pipe to the dashboard');
  assert.deepEqual(ends[0], [4242, 'SIGTERM', 'win32'], 'the time limit ends its tree');
  // The command ends; endGroup: what it left is ended, and the answer waits until that is done.
  let restDone = false;
  ends.length = 0;
  const end2 = (root, sig) => (ends.push([root.pid, sig]), { ok: false, rest: new Promise((r) => setTimeout(() => ((restDone = true), r([4243])), 50)) });
  const r = await runCommand(['node', '-e', '0'], { cwd: t.root, platform: 'win32', endGroup: true, spawnImpl: (...a) => {
    const c = fakeSpawn([])(...a);
    setTimeout(c.end, 20);
    return c;
  }, end: end2 });
  assert.equal(r.ok, true);
  assert.deepEqual(ends, [[4242, 'SIGKILL']]);
  assert.equal(restDone, true, 'the answer came after what it left was ended');
});

test('processes that cannot be read at an end: the command is still ended, the tree tried once more, and it is said', async () => {
  const { TREE_UNSURE } = await import('../../src/cmdtree.mjs');
  const chain = () => new Map([[100, { ppid: 4, start: 10_000 }], [101, { ppid: 100, start: 11_000 }]]);
  // Once not read (PowerShell failed or ran into its time), then read: the command at once, then its tree.
  let killed = [];
  let looks = 0;
  const once = endTree({ pid: 100, start: 10_000, alive: true }, 'SIGKILL', { platform: 'win32', kill: (p, sig) => killed.push([p, sig]), table: async () => (++looks === 1 ? null : chain()), wait: async () => {} });
  assert.deepEqual([await once.rest, await once.whole], [[101], { whole: true }]);
  assert.deepEqual(killed, [[100, 0], [100, 'SIGKILL'], [101, 'SIGKILL']], 'the command first, through its pid; then its tree from the second look');
  // Never read (or the read throws): with no handle the command is never ended by its number before a snapshot showed
  // its pid has its start (it may be another program's by then); nothing throws, and the answer says so.
  for (const table of [async () => null, async () => { throw new Error('powershell'); }]) {
    killed = [];
    const never = endTree({ pid: 100, start: 10_000, alive: true }, 'SIGKILL', { platform: 'win32', kill: (p, sig) => killed.push([p, sig]), table, wait: async () => {} });
    assert.deepEqual([await never.rest, await never.whole], [[], { whole: false, why: TREE_UNSURE }]);
    assert.deepEqual(killed, [[100, 0]], 'nothing is ended by its number without a snapshot');
  }
  // A go-live or check command at its time limit says it in its words.
  const end = (root, sig, o) => endTree(root, sig, { ...o, kill: () => {}, table: async () => null, wait: async () => {} });
  let child;
  const spawnImpl = (...a) => {
    child = fakeSpawn([])(...a);
    return child;
  };
  const p = runCommand(['node', '-e', '0'], { cwd: t.root, minutes: 0.001, platform: 'win32', spawnImpl, end });
  await new Promise((res) => setTimeout(res, 150));
  child.end();
  const r = await p;
  assert.equal(r.treeLeft, TREE_UNSURE);
  assert.equal(endWords(r, 1), `stopped at its time limit of 1 min (${TREE_UNSURE})`);
});

test('a command that ends by itself while its processes are read: nothing is ended by its number, only its own tree', async () => {
  // Windows: the command (100, begun at 10000) ends by itself at 10400 while the processes are read; Windows hands its
  // pid at once to another program (begun at 10450), which has a child of its own (103). The command had a child (102).
  let running = true;
  const byNumber = [];
  const viaHandle = [];
  const members = [];
  const t = endTree({ pid: 100, start: 10_000, alive: () => running, killRoot: (sig) => viaHandle.push(sig), endedAt: () => (running ? null : 10_400) }, 'SIGKILL', {
    platform: 'win32',
    kill: (p, sig) => byNumber.push([p, sig]),
    table: async () => {
      running = false; // it ended meanwhile
      return new Map([[100, { ppid: 4, start: 10_450 }], [102, { ppid: 100, start: 10_100 }], [103, { ppid: 100, start: 10_500 }]]);
    },
    endMembers: async (list, sig) => (members.push([list, sig]), list.map((x) => x.pid)),
    wait: async () => {},
  });
  assert.equal(t.ok, true, 'it was there when the end began');
  assert.deepEqual(await t.rest, [102]);
  assert.deepEqual(viaHandle, [], 'it had ended: not even through its handle');
  assert.deepEqual(byNumber, [], 'nothing is ended by its number, the new holder of pid 100 least of all');
  // The seam gets each member with the start and parent the snapshot showed, so an end can check it by its start.
  assert.deepEqual(members[0], [[{ pid: 102, start: 10_100, ppid: 100 }], 'SIGKILL'], 'its own child, through the members seam; never the new holder\'s child 103');
  // While it runs it is ended through its handle, never by its number.
  running = true;
  const r = endTree({ pid: 100, start: 10_000, alive: () => running, killRoot: (sig) => viaHandle.push(sig), endedAt: () => null }, 'SIGKILL', { platform: 'win32', kill: (p, sig) => byNumber.push([p, sig]), table: async () => new Map([[100, { ppid: 4, start: 10_200 }]]), wait: async () => {} });
  await r.rest;
  assert.deepEqual([viaHandle, byNumber], [['SIGKILL'], []]);
});

test('after a short command ended, what began after its end is never its own, even within a second of its start', () => {
  // A check that failed at once: begun 10000, ended 10300; its pid went to a process begun at 10400 (within SAME_MS),
  // whose child began at 10500. Only the child the command started (10200) is its own.
  const procs = new Map([[100, { ppid: 4, start: 10_400 }], [101, { ppid: 100, start: 10_200 }], [104, { ppid: 100, start: 10_500 }]]);
  assert.deepEqual(treeOf({ pid: 100, start: 10_000, endedAt: 10_300 }, procs), [101]);
  assert.deepEqual(treeOf({ pid: 100, start: 10_000 }, procs), [101, 104], 'without its end time the hole of the finding is there');
});

test('a command that ended after its time limit gets no second end: its pid may be another process by then', async () => {
  const ends = [];
  let child;
  const spawnImpl = (...a) => (child = fakeSpawn([])(...a));
  const end = (root, sig) => {
    ends.push([root.pid, sig, typeof root.alive === 'function' ? root.alive() : root.alive]); // as seen at that moment
    if (sig === 'SIGTERM') setTimeout(() => child.end(), 10); // it ends at once, as Windows ends a process
    return { ok: true, rest: Promise.resolve([]) };
  };
  const r = await runCommand(['node', '-e', '0'], { cwd: t.root, minutes: 0.001, platform: 'win32', endGroup: false, spawnImpl, end });
  assert.equal(r.timedOut, true);
  await new Promise((res) => setTimeout(res, 5300)); // past the grace of 5 s after the time limit
  assert.deepEqual(ends, [[4242, 'SIGTERM', true]], 'ended once, while it ran; never again after its end');
});

test('a command a dashboard that ended had started is ended by its tree, with its start from its identity', () => {
  const ends = [];
  const end = (root, sig, o) => (ends.push([root, sig, o.platform]), { ok: true, rest: Promise.resolve([]) });
  const ident = { of: (pids) => new Map(pids.map((p) => [p, 'T:1700000000000'])) };
  const rec = { pid: process.pid, proc: 'T:1700000000000', at: '2026-01-01T00:00:00.000Z', minutes: 1 };
  assert.equal(endCommand(rec, ident, { platform: 'win32', end }), true);
  // Its start is the system's own (from its identity): on Windows the held end holds it by exactly that start.
  assert.deepEqual(ends, [[{ pid: process.pid, start: 1_700_000_000_000, alive: true, startExact: true }, 'SIGKILL', 'win32']], 'shown to be that command: running');
  assert.equal(endCommand({ ...rec, proc: 'T:1600000000000' }, ident, { platform: 'win32', end }), false, 'not shown to be that command: nothing is ended');
  assert.equal(ends.length, 1);
});

// Note 52 point 1: a command with no handle (found by pid and start) whose pid the snapshot shows with another start
// is another program now: neither it nor what it started is ended.
test('Windows: a command with no handle whose pid shows another start ends nothing, its children least of all', async () => {
  const killed = [];
  const t = endTree({ pid: 100, start: 10_000, alive: true }, 'SIGKILL', {
    platform: 'win32',
    kill: (p, sig) => killed.push([p, sig]),
    table: async () => new Map([[100, { ppid: 4, start: 20_000 }], [101, { ppid: 100, start: 20_500 }]]),
    wait: async () => {},
  });
  assert.deepEqual([await t.rest, await t.whole], [[], { whole: false, why: TREE_NOT_ENDED }]);
  assert.deepEqual(killed, [[100, 0]], 'only "is it there": no end of that program or of its child');
});

// Note 52 point 2: an ended member's pid is handed on, and the new holder starts a process before the second look:
// that process began after the member's end, so it is not of the tree.
test('Windows: what a new holder of an ended member\'s pid starts is never taken in the second look', async () => {
  const T = Date.now();
  const killed = [];
  let looks = 0;
  const first = new Map([[100, { ppid: 4, start: T - 10_000 }], [101, { ppid: 100, start: T - 5000 }]]);
  // 101 ended; its pid now held by another program begun within a second of 101, which started 105 just now.
  const again = new Map([[100, { ppid: 4, start: T - 10_000 }], [101, { ppid: 4, start: T - 4500 }], [105, { ppid: 101, start: T + 60_000 }]]);
  const t = endTree({ pid: 100, start: T - 10_000, alive: () => true, killRoot: () => {} }, 'SIGKILL', {
    platform: 'win32',
    kill: (p, sig) => killed.push([p, sig]),
    table: async () => (++looks === 1 ? first : again),
    wait: async () => {},
  });
  assert.deepEqual(await t.rest, [101]);
  assert.equal(looks, 2, 'the second look was made');
  assert.ok(!killed.some(([p]) => p === 105), `the new holder's child is not ended: ${JSON.stringify(killed)}`);
});

// Note 52 point 4: the command runs at the snapshot (begun late: its system start more than a second after the start
// its caller has) and ends by itself before the tree is taken: its children are still its own, and are ended.
test('Windows: a command that ends between the snapshot and the end keeps its tree', async () => {
  let running = true;
  const killed = [];
  const t = endTree({ pid: 100, start: 10_000, alive: () => running, killRoot: () => {}, endedAt: () => (running ? null : 13_000) }, 'SIGKILL', {
    platform: 'win32',
    kill: (p, sig) => killed.push([p, sig]),
    table: async () => {
      const snap = new Map([[100, { ppid: 4, start: 12_500 }], [101, { ppid: 100, start: 12_600 }]]);
      running = false; // it ended just after the snapshot was taken
      return snap;
    },
    wait: async () => {},
  });
  assert.deepEqual(await t.rest, [101], 'its child is ended');
  assert.deepEqual(killed, [[101, 'SIGKILL']]);
});

// The held end (src/winend.mjs) as Windows answers it: the processes a call was given ($flat: pid, start, parent), and
// one answer line each, made up here by `answer(entry)`.
const entriesOf = (args) => {
  const s = Buffer.from(String(args[args.indexOf('-EncodedCommand') + 1]), 'base64').toString('utf16le');
  const m = /\$flat = @\(([\d, ]*)\)/.exec(s);
  if (!m) return null;
  const n = m[1].split(',').map(Number);
  const out = [];
  for (let i = 0; i + 2 < n.length; i += 3) out.push({ pid: n[i], start: n[i + 1], ppid: n[i + 2] });
  return out;
};
const heldEnd = (answer) => {
  const calls = [];
  return { calls, run: async (cmd, args) => {
    const e = entriesOf(args);
    calls.push([cmd, e]);
    return { ok: true, out: e.map((x) => `${x.pid} ${answer(x)}`).join('\r\n') };
  } };
};

test('Windows: the members of a tree are ended in one held call by the start the snapshot showed; one that is not is said', async () => {
  const snap = (third = 12_000) => async () => new Map([[100, { ppid: 4, start: 10_000 }], [101, { ppid: 100, start: 11_000 }], [102, { ppid: 101, start: third }]]);
  const byNumber = [];
  const kill = (p, sig) => byNumber.push([p, sig]);
  const endWith = (run, table = snap()) => endTree({ pid: 100, start: 10_000, alive: () => true, killRoot: () => {} }, 'SIGKILL', { platform: 'win32', kill, run, table, wait: async () => {} });
  let h = heldEnd(() => 'ended');
  let t = endWith(h.run);
  assert.deepEqual((await t.rest).sort(), [101, 102]);
  assert.deepEqual(await t.whole, { whole: true });
  assert.deepEqual(h.calls, [['powershell.exe', [{ pid: 102, start: 12_000, ppid: 101 }, { pid: 101, start: 11_000, ppid: 100 }]]], 'one call, the lowest first, each by its snapshot start');
  assert.deepEqual(byNumber, [], 'nothing by its number: the command through its handle, the rest held');
  // Its pid went to another program meanwhile: that one answers with another start, is not ended, and it is said.
  h = heldEnd((x) => (x.pid === 102 ? 'other start' : 'ended'));
  t = endWith(h.run);
  assert.deepEqual(await t.rest, [101]);
  assert.deepEqual(await t.whole, { whole: false, why: TREE_NOT_ENDED });
  // One that is gone by then is no loss.
  h = heldEnd((x) => (x.pid === 102 ? 'gone' : 'ended'));
  t = endWith(h.run);
  assert.deepEqual([await t.rest, await t.whole], [[101], { whole: true }]);
  // An answer that cannot be read ends nothing that is counted, and it is said.
  t = endWith(async () => ({ ok: false, out: '' }));
  assert.deepEqual([await t.rest, await t.whole], [[], { whole: false, why: TREE_NOT_ENDED }]);
  // A member the snapshot gives no start for is not asked to end at all (nothing holds it by its start), and it is said.
  h = heldEnd(() => 'ended');
  t = endWith(h.run, async () => new Map([[100, { ppid: 4, start: 10_000 }], [101, { ppid: 100, start: 11_000 }], [102, { ppid: 101, start: null }]]));
  assert.deepEqual([await t.rest, await t.whole], [[101], { whole: false, why: TREE_NOT_ENDED }]);
  assert.deepEqual(h.calls.map(([, e]) => e.map((x) => x.pid)), [[101]]);
  assert.deepEqual(byNumber, []);
});

test('Windows: a command found by its pid and start (no handle) is ended in the held call at that start; another holder is left', async () => {
  const byNumber = [];
  const kill = (p, sig) => byNumber.push([p, sig]); // signal 0: it is there
  const snap = (rootStart) => async () => new Map([[100, { ppid: 4, start: rootStart }], [101, { ppid: 100, start: rootStart + 500 }]]);
  const endAt = (rootStart, run) => endTree({ pid: 100, start: 10_000, alive: true, startExact: true }, 'SIGKILL', { platform: 'win32', kill, run, table: snap(rootStart), wait: async () => {} });
  let h = heldEnd(() => 'ended');
  let t = endAt(10_000, h.run);
  assert.equal(t.ok, true);
  assert.deepEqual([await t.rest, await t.whole], [[101], { whole: true }]);
  assert.deepEqual(h.calls.map(([, e]) => e), [[{ pid: 100, start: 10_000, ppid: 4 }], [{ pid: 101, start: 10_500, ppid: 100 }]], 'the command by its own start first, then its tree');
  // The snapshot's start 1 ms above the kept one (the one rounding END_SAME_MS allows): the same process.
  assert.equal(END_SAME_MS, 1);
  h = heldEnd(() => 'ended');
  t = endAt(10_001, h.run);
  assert.deepEqual(await t.rest, [101]);
  assert.deepEqual(h.calls[0][1], [{ pid: 100, start: 10_000, ppid: 4 }], 'held by the start it was given');
  // Its pid is another program's now (a start other than its own, later or earlier): nothing at all is ended.
  for (const other of [10_500, 9999]) {
    h = heldEnd(() => 'ended');
    t = endAt(other, h.run);
    assert.deepEqual([await t.rest, await t.whole], [[], { whole: false, why: TREE_NOT_ENDED }], `snapshot start ${other}`);
    assert.deepEqual(h.calls, [], 'no end call: neither that program nor what it started');
  }
  assert.ok(byNumber.every(([, sig]) => sig === 0), `never ended by its number: ${JSON.stringify(byNumber)}`);
});
