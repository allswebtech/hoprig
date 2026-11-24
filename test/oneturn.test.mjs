// Long reads side by side take turns (src/oneturn.mjs): two readers' pieces never run back to back, the thread goes
// back to the server between any two of them. Counted, not timed: a check that runs on every turn of the event loop
// must see each piece end before the next starts.
import assert from 'node:assert/strict';
import test from 'node:test';

const { inTurn } = await import('../src/oneturn.mjs');

test('two readers\' pieces run one at a time, with a turn of the event loop between any two', async () => {
  const log = [];
  let turns = 0;
  let going = true;
  const tick = () => {
    if (!going) return;
    turns++;
    log.push('turn');
    setImmediate(tick);
  };
  setImmediate(tick);
  const reader = async (name) => {
    for (let n = 0; n < 5; n++) await inTurn(async () => log.push(name));
  };
  await Promise.all([reader('a'), reader('b')]);
  going = false;
  const pieces = log.filter((x) => x !== 'turn');
  assert.equal(pieces.length, 10);
  for (let i = 1; i < log.length; i++) assert.ok(!(log[i] !== 'turn' && log[i - 1] !== 'turn'), `two pieces back to back at ${i}: ${log.slice(Math.max(0, i - 3), i + 1).join(' ')}`);
  assert.ok(turns >= 9, `the thread came back between them (${turns})`);
});

// Starting a program holds the thread while the system copies the server's memory map (median 7.6 ms at 200 MB): the
// checks a page or a tick starts side by side held it up to 149 ms when they all started in one pass of the loop.
test('program starts take turns: twenty side by side, never two in one pass of the event loop', async (t) => {
  const { ChildProcess } = await import('node:child_process');
  const { capture } = await import('../src/setup/system.mjs');
  const { run } = await import('../src/server/platform/common.mjs');
  const { TmuxBackend } = await import('../src/server/backends/tmux.mjs');
  let pass = 0;
  let going = true;
  const tick = () => {
    if (!going) return;
    pass++;
    setImmediate(tick);
  };
  setImmediate(tick);
  const at = [];
  const spawn = ChildProcess.prototype.spawn;
  t.after(() => { ChildProcess.prototype.spawn = spawn; });
  ChildProcess.prototype.spawn = function (o) {
    at.push(pass);
    return spawn.call(this, o);
  };
  const node = process.execPath;
  const tmux = new TmuxBackend({ bin: node, socket: 'oneturn-never-started' }); // node refuses tmux's words and ends
  const asked = [];
  for (let i = 0; i < 5; i++) {
    asked.push(capture([node, '-e', '']));
    asked.push(run(node, ['-e', '']));
    asked.push(run(node, ['-e', ''], { noTerminal: true }));
    asked.push(tmux.run(['list-panes']).catch(() => null));
  }
  const answers = await Promise.all(asked);
  going = false;
  assert.equal(at.length, 20, 'every program was started');
  assert.ok(answers.filter((a, i) => i % 4 !== 3).every((a) => a.ok), 'and each answered as before');
  for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `two starts in one pass of the loop: ${at.join(' ')}`);
});

/** A counter of passes of the event loop, for as long as `going()` says. */
function passes() {
  const c = { n: 0, going: true };
  const tick = () => {
    if (!c.going) return;
    c.n++;
    setImmediate(tick);
  };
  setImmediate(tick);
  return c;
}

test('the watcher gives the thread back between the cards and each listener of a tick', async () => {
  const { Watcher } = await import('../src/server/watcher.mjs');
  const c = passes();
  const at = [];
  const w = new Watcher({
    cards: async () => { at.push(['cards', c.n]); return []; },
    deck: {}, auto: { getAutoSwitch: () => ({ enabled: false, order: [] }), nextProfile: () => null, markLimited: () => {} },
    settings: () => ({ notify: null, publicUrl: '' }), log: () => {},
  });
  w.onTick(async () => { at.push(['a', c.n]); });
  w.onTick(async () => { at.push(['b', c.n]); });
  await w.tick();
  w.stop();
  c.going = false;
  assert.deepEqual(at.map((x) => x[0]), ['cards', 'a', 'b'], 'each listener once, in order');
  for (let i = 1; i < at.length; i++) assert.ok(at[i][1] > at[i - 1][1], `${at[i][0]} ran in the same pass as ${at[i - 1][0]}: ${JSON.stringify(at)}`);
});

test('the Operator starts its checks one per pass of the event loop, and its tick waits for all of them', async () => {
  const { defaultSources } = await import('../src/operator/sources.mjs');
  const c = passes();
  const at = [];
  // A clock that says every check looked a moment ago: each check's tick reads it once, then has nothing to do.
  // Before them the tick notes the providers' reported usage: one more look, in a pass of its own.
  const now = () => { at.push(c.n); return 1000; };
  const src = defaultSources({ state: async () => ({ sessions: [] }), config: () => ({ server: {} }) }, { port: () => null, now, gateways: () => [], usersOf: () => [] });
  at.length = 0;
  await src.tick();
  c.going = false;
  assert.equal(at.length, 7, `the providers' readings and the six checks looked at the clock, once each: ${at}`);
  for (let i = 1; i < at.length; i++) assert.ok(at[i] > at[i - 1], `two checks started in one pass: ${at.join(' ')}`);
});

test('tmux: the keys after a check start at once, never behind other starts in the queue', async () => {
  const { startInTurn } = await import('../src/oneturn.mjs');
  const { TmuxBackend } = await import('../src/server/backends/tmux.mjs');
  const tmux = new TmuxBackend({ bin: process.execPath, socket: 'oneturn-never-started' });
  let release;
  const held = startInTurn(() => new Promise((r) => { release = r; })); // the queue is busy for as long as this runs
  let queued = false;
  const later = tmux.run(['list-panes']).catch(() => null).then(() => { queued = true; });
  const deadline = new Promise((r) => setTimeout(() => r('waited in the queue'), 3000));
  const atOnce = await Promise.race([tmux.run(['list-panes'], { now: true }).then(() => 'answered', () => 'answered'), deadline]);
  if (atOnce !== 'answered') release(); // let the queue go on, so the file ends
  assert.equal(atOnce, 'answered', 'a start marked now ran while the queue was busy');
  assert.equal(queued, false, 'a start in the queue waits for its turn');
  release();
  await held;
  await later;
  assert.equal(queued, true);
  // Typing and every check before its keys (copy mode, the program in front, the screen) go at once: the owner waits.
  const calls = [];
  const fake = new TmuxBackend({ bin: process.execPath, socket: 'oneturn-never-started' });
  fake.run = async (args, o = {}) => { calls.push([args[0], o.now === true]); return args[0] === 'capture-pane' ? 'ready' : '0 1'; };
  const front = { group: 1, pid: 1 };
  const when = { lines: 5, test: () => true };
  await fake.sendText('%1', 'one line', { when }).catch(() => {});
  await fake.sendText('%1', 'two\nlines', { front }).catch(() => {});
  await fake.sendKey('%1', 'Enter', { when }).catch(() => {});
  const seen = new Set(calls.map(([a]) => a));
  for (const a of ['copy-mode', 'capture-pane', 'send-keys', 'load-buffer', 'display-message']) assert.ok(seen.has(a), `${a} was called: ${JSON.stringify(calls)}`);
  assert.deepEqual(calls.filter(([, now]) => !now), [], 'a call of typing waited in the queue');
});

test('a turn gives back a whole pass of the loop, also to a piece that ran after a read', async () => {
  // A piece that runs in the poll phase (after a read or a program's answer) is followed by the check phase of the same
  // pass: a turn of one setImmediate would run the next piece there, back to back, with no request answered between.
  const fs = await import('node:fs');
  const order = [];
  await new Promise((done) => fs.readFile(new URL(import.meta.url), () => {
    inTurn(async () => {
      order.push('a');
      setImmediate(() => setImmediate(() => order.push('next pass')));
    });
    inTurn(async () => {
      order.push('b');
      done();
    });
  }));
  assert.deepEqual(order, ['a', 'next pass', 'b']);
});

test('an Operator check that fails while the next one waits for its pass fails the tick, never the server', async (t) => {
  const { defaultSources } = await import('../src/operator/sources.mjs');
  const unhandled = [];
  const seen = (e) => unhandled.push(e);
  process.on('unhandledRejection', seen);
  t.after(() => process.off('unhandledRejection', seen));
  // A clock that fails: each check's tick reads it before anything else, outside its own catch.
  const now = () => { throw new Error('the clock is gone'); };
  const src = defaultSources({ state: async () => ({ sessions: [] }), config: () => ({ server: {} }) }, { port: () => null, now, gateways: () => [], usersOf: () => [] });
  await assert.rejects(src.tick(), /the clock is gone/);
  await new Promise((r) => setImmediate(() => setImmediate(r)));
  assert.deepEqual(unhandled.map(String), [], 'no rejection was left without a handler');
});

test('a watcher stopped by one listener of a tick calls no further listener', async () => {
  const { Watcher } = await import('../src/server/watcher.mjs');
  const ran = [];
  const w = new Watcher({
    cards: async () => [], deck: {}, auto: { getAutoSwitch: () => ({ enabled: false, order: [] }), nextProfile: () => null, markLimited: () => {} },
    settings: () => ({ notify: null, publicUrl: '' }), log: () => {},
  });
  w.start();
  w.onTick(async () => { ran.push('a'); w.stop(); });
  w.onTick(async () => { ran.push('b'); });
  await w.tick();
  assert.deepEqual(ran, ['a']);
});

test('the background question to the system (who runs a pid, where ps or PowerShell answers) takes its turn too', async (t) => {
  const { ChildProcess } = await import('node:child_process');
  const { startInTurn } = await import('../src/oneturn.mjs');
  const { makeIdentity } = await import('../src/procid.mjs');
  const started = [];
  const spawn = ChildProcess.prototype.spawn;
  t.after(() => { ChildProcess.prototype.spawn = spawn; });
  ChildProcess.prototype.spawn = function (o) {
    started.push(String(o.file));
    return spawn.call(this, o);
  };
  // macOS's way (ps -o lstart): ps answers it on Linux as well. Only read, of this process and its parent.
  const id = makeIdentity({ platform: 'darwin' });
  let release;
  const held = startInTurn(() => new Promise((r) => { release = r; }));
  const asked = id.refresh([process.ppid]);
  await new Promise((r) => setTimeout(r, 200));
  const before = started.length;
  release();
  await held;
  await asked;
  assert.equal(before, 0, 'it waited for the start before it');
  assert.deepEqual(started, ['ps'], 'then it was asked');
});
