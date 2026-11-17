// A run record belongs to the process that wrote it, not to its pid (runs.mjs, procid.mjs). The runs folder outlives
// the process that wrote a record (a power cut, a kill -9, a terminal closed at shutdown), and the record's pid is
// taken by another process later (after a reboot, small pids are all taken again). Such a record must not keep a
// conversation from anyone, and nothing may be sent to the process that has its pid now.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('owner');
test.after(() => box.cleanup());
for (const k of ['TMUX', 'TMUX_PANE', 'HOPRIG_TERM_ID', 'HOPRIG_TERM_NAME']) delete process.env[k];

const R = await import('../../src/runs.mjs');
const ID = '6b0e7c1a-2d3f-4a5b-8c6d-7e8f9a0b1c2d';
const clear = () => fs.rmSync(path.join(box.state, 'runs'), { recursive: true, force: true });
// A process of this test's that sleeps: alive, and not the writer of any record.
const sleeper = (t) => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => p.kill('SIGKILL'));
  return p;
};

test('a record whose pid another living process has now does not count, and goes', { skip: process.platform === 'win32' && 'pid 1 is a POSIX idea' }, (t) => {
  const other = sleeper(t);
  for (const pid of [1, other.pid]) {
    clear();
    const left = R.createRun({ profile: 'work', cwd: box.root, conversation: ID });
    // What a launcher that died left behind, once its pid belongs to another process (pid 1 answers EPERM: alive).
    fs.writeFileSync(left.file, JSON.stringify({ ...left.run, pid }));
    const mine = R.createChatRun({ chat: 'c1', conversation: ID, tool: 'claude', cwd: box.root, profile: 'work' });
    assert.equal(R.heldBefore(mine.run, ID), null, `pid ${pid}: the conversation is free`);
    assert.deepEqual(R.listRuns().map((r) => r.runId), [], `pid ${pid}: not listed`);
    assert.equal(fs.existsSync(left.file), false, `pid ${pid}: the record of a dead process goes`);
  }
  clear();
});

const { makeIdentity, system } = await import('../../src/procid.mjs');
// A record of this test's, then changed as given (its pid, its identity) in place.
const record = (patch = {}) => {
  const r = R.createRun({ profile: 'work', cwd: box.root, conversation: ID });
  const run = { ...r.run, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete run[k];
  fs.writeFileSync(r.file, JSON.stringify(run));
  return r.file;
};
const listed = (o) => R.listRuns({ chats: true, usage: false, ...o }).map((r) => r.runId);
const idOf = (file) => path.basename(file, '.json');

test('a record counts while the process that wrote it runs', (t) => {
  clear();
  const own = record();
  assert.equal(JSON.parse(fs.readFileSync(own, 'utf8')).proc, system.self(), 'it carries its writer\'s identity');
  assert.ok(system.self(), 'this system has one');
  const other = sleeper(t);
  const its = record({ pid: other.pid, proc: system.of([other.pid]).get(other.pid) }); // as the other process would write it
  assert.deepEqual(listed().sort(), [idOf(own), idOf(its)].sort());
  clear();
});

test('a record without an identity (an older launcher) counts while its pid lives, unless written before this boot', (t) => {
  clear();
  const other = sleeper(t);
  const old = record({ pid: other.pid, proc: undefined });
  assert.deepEqual(listed(), [idOf(old)], 'fresh: as before identities');
  // This boot began an hour ago (handed in: no reboot needed). Written 5 minutes before it: within the slack of a
  // clock corrected after the start, still counts; 20 minutes before it: a process of an earlier boot, gone.
  const hourAgo = Date.now() - 3_600_000;
  const ident = makeIdentity({ osUptime: () => 3600 });
  for (const [before, counts] of [[5, true], [20, false]]) {
    const at = new Date(hourAgo - before * 60_000);
    fs.utimesSync(old, at, at);
    assert.deepEqual(listed({ ident }), counts ? [idOf(old)] : [], `${before} minutes before the boot`);
  }
  assert.equal(fs.existsSync(old), false, 'and goes');
  // Its pid dead: gone whatever the file's time, as before.
  const dead = record({ pid: 2 ** 22 + 9, proc: undefined });
  assert.deepEqual(listed(), []);
  assert.equal(fs.existsSync(dead), false);
  clear();
});

test('an identity that is not known never removes a record', (t) => {
  clear();
  const other = sleeper(t);
  const file = record({ pid: other.pid, proc: 'L:not-this-boot:1' });
  // A system that cannot be asked, or that said nothing about the pid.
  const blind = { of: (pids) => new Map(pids.map((p) => [p, null])), bootAt: () => Date.now() - 3_600_000 };
  assert.deepEqual(listed({ ident: blind }), [idOf(file)]);
  assert.deepEqual(listed({ ident: { ...blind, of: () => new Map() } }), [idOf(file)]);
  assert.deepEqual(listed({ ident: { ...blind, of: (pids) => new Map(pids.map((p) => [p, 'T:5'])) } }), [idOf(file)], 'identities of two kinds do not compare');
  assert.equal(fs.existsSync(file), true);
  // …which leaves the file's time to decide: written before this boot, it goes.
  const at = new Date(Date.now() - 2 * 3_600_000);
  fs.utimesSync(file, at, at);
  assert.deepEqual(listed({ ident: blind }), []);
  assert.equal(fs.existsSync(file), false);
  // The system knows it: another process.
  const known = record({ pid: other.pid, proc: 'L:not-this-boot:1' });
  assert.deepEqual(listed(), []);
  assert.equal(fs.existsSync(known), false);
  clear();
});

test('who runs a conversation asks the system only about the records on it', (t) => {
  clear();
  const other = sleeper(t);
  const elsewhere = record({ pid: other.pid, conversation: 'another' });
  const on = record({ pid: other.pid, proc: system.of([other.pid]).get(other.pid) });
  const asked = [];
  const ident = { of: (pids) => (asked.push(pids), system.of(pids)), bootAt: system.bootAt };
  assert.deepEqual(listed({ ident, only: (r) => r.conversation === ID }), [idOf(on)]);
  assert.deepEqual(asked, [[other.pid]], 'one call, for the record asked about');
  assert.equal(fs.existsSync(elsewhere), true, 'the others are left as they are');
  const mine = R.createChatRun({ chat: 'c3', conversation: ID, tool: 'claude', cwd: box.root, profile: 'work' });
  assert.equal(R.heldBefore(mine.run, ID).runId, idOf(on), 'the other process\'s own record holds it');
  clear();
});

test('a launcher\'s move keeps its identity; a chat\'s record carries the dashboard\'s', () => {
  clear();
  const first = R.createRun({ profile: 'work', cwd: box.root, conversation: ID });
  const again = R.createRun({ profile: 'backup', cwd: box.root, conversation: ID, file: first.file });
  assert.equal(again.run.proc, first.run.proc);
  assert.equal(JSON.parse(fs.readFileSync(first.file, 'utf8')).proc, first.run.proc);
  const chat = R.createChatRun({ chat: 'c1', conversation: ID, tool: 'claude', cwd: box.root, profile: 'work' });
  assert.equal(chat.run.proc, system.self());
  assert.equal(chat.run.pid, process.pid);
  if (process.platform === 'linux') {
    // What the kernel says about this process: its boot, its start.
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const stat = fs.readFileSync('/proc/self/stat', 'utf8');
    assert.equal(chat.run.proc, `L:${boot}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`);
  }
  clear();
});

test('a chat record an earlier dashboard left behind, whose pid this dashboard has now, is no record of this one', () => {
  clear();
  // The dashboard died hard; after a reboot the new one got the same pid. Its leftover names that pid, not its process.
  const left = R.createChatRun({ chat: 'c9', conversation: ID, tool: 'claude', cwd: box.root, profile: 'work' });
  fs.writeFileSync(left.file, JSON.stringify({ ...left.run, startedAt: left.run.startedAt - 60_000, proc: system.self().replace(/:\d+$/, ':1') }));
  const mine = R.createRun({ profile: 'work', cwd: box.root, conversation: ID });
  assert.equal(R.heldBefore(mine.run, ID), null, 'it holds nothing');
  assert.equal(fs.existsSync(left.file), false, 'and goes');
  clear();
});

/**
 * A macOS or Windows system as the dashboard sees it, on this test's clock: this process started a minute ago, and
 * pid `pid` belongs to the process that started at `holder.start` (two minutes ago, then as the test says). Counts its
 * calls.
 */
const askedSystem = (platform, pid) => {
  const clock = { now: Math.floor(Date.now() / 1000) * 1000 }; // whole seconds: ps says no less
  const own = clock.now - 60_000;
  const holder = { start: clock.now - 120_000 };
  const el = (s) => { const x = Math.round((clock.now - s) / 1000); return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
  const calls = [];
  const run = () => (calls.push(1), platform === 'win32' ? `${process.pid} ${own}\r\n${pid} ${holder.start}\r\n` : `${process.pid} ${el(own)}\n${pid} ${el(holder.start)}\n`);
  return { clock, holder, calls, ident: makeIdentity({ platform, run, now: () => clock.now, ownStart: own, osUptime: () => 3600 }) };
};

test('an answer the system gave before a record\'s process started never makes it another process\'s (macOS, Windows)', (t) => {
  const other = sleeper(t);
  for (const platform of ['win32', 'darwin']) {
    clear();
    const { clock, holder, calls, ident } = askedSystem(platform, other.pid);
    const a = record({ pid: other.pid, proc: `T:${holder.start}` });
    assert.deepEqual(listed({ ident }), [idOf(a)], `${platform}: launcher A, while it runs`);
    // A ends; launcher B gets its pid 10 s later (Windows hands a pid out again at once), while the answer about A is
    // still kept.
    fs.rmSync(a);
    clock.now += 10_000;
    holder.start = clock.now;
    const b = record({ pid: other.pid, proc: `T:${holder.start}`, conversation: 'another' });
    clock.now += 5_000;
    assert.deepEqual(listed({ ident }), [idOf(b)], `${platform}: B's record counts`);
    assert.equal(fs.existsSync(b), true, `${platform}: and stays`);
    assert.equal(calls.length, 2, `${platform}: the system was asked again`);
    listed({ ident });
    assert.equal(calls.length, 2, `${platform}: once`);
    // A record whose process started before that answer and is not the one it names: gone, without asking again.
    const ghost = path.join(path.dirname(b), 'ghost.json'); // its own name: record() names two in one millisecond alike
    fs.writeFileSync(ghost, JSON.stringify({ ...JSON.parse(fs.readFileSync(b, 'utf8')), runId: 'ghost', proc: `T:${holder.start - 600_000}` }));
    assert.deepEqual(listed({ ident }), [idOf(b)], platform);
    assert.equal(fs.existsSync(ghost), false, `${platform}: the dead process's record goes`);
    assert.equal(calls.length, 2, platform);
  }
  clear();
});

test('right before a signal the system is asked now, not what it said a while ago (macOS, Windows)', async (t) => {
  const other = sleeper(t);
  for (const platform of ['win32', 'darwin']) {
    clear();
    const { clock, holder, calls, ident } = askedSystem(platform, other.pid);
    const a = record({ pid: other.pid, proc: `T:${holder.start}` });
    assert.deepEqual(listed({ ident }), [idOf(a)], platform);
    // A is killed hard (its record stays); another process gets its pid within the while.
    clock.now += 10_000;
    holder.start = clock.now - 2_000;
    assert.deepEqual(listed({ ident }), [idOf(a)], `${platform}: a listing may use the kept answer`);
    const run = JSON.parse(fs.readFileSync(a, 'utf8'));
    assert.equal(await R.stillRuns(run, ident), false, `${platform}: not before a signal`);
    assert.equal(calls.length, 2, `${platform}: asked again`);
    assert.equal(fs.existsSync(a), false, `${platform}: and the record goes`);
  }
  clear();
});

test('the dashboard never waits for the system when it lists the records', async () => {
  const { system: s } = await import('../../src/procid.mjs');
  const { createServer } = await import('../../src/server/server.mjs');
  const turnOn = s.askInBackground;
  let on = false;
  s.askInBackground = () => (on = true);
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  try {
    await app.listen(0, '127.0.0.1');
    assert.equal(on, true);
  } finally {
    s.askInBackground = turnOn;
    await app.close();
  }
});

test('Continue here judges the record again right before its signal: nothing is sent to a process that did not write it', { skip: process.platform === 'win32' && 'POSIX signals' }, async (t) => {
  class HttpError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }
  const { handoffRoutes } = await import('../../src/chat/handoff.mjs');
  const take = async (file) => {
    const run = JSON.parse(fs.readFileSync(file, 'utf8'));
    // What a listing said a moment ago; from then on what the records folder says.
    let first = true;
    const terminalOf = async () => {
      const was = first;
      first = false;
      return was || fs.existsSync(file) ? { name: null, run } : null;
    };
    const c = { id: crypto.randomUUID(), engine: { id: 'claude' }, conversationId: ID, refresh() {}, emit() {}, dropMark: () => false };
    const routes = handoffRoutes({ HttpError, readJson: async () => ({}), backend: {} }, {
      chats: new Map([[c.id, c]]), chatOr404: () => c, terminalOf, serial: (id, fn) => fn(), forget: () => {}, save() {}, auto: {},
    });
    const [, re, fn] = routes.find(([, r]) => String(r).includes('take'));
    return fn({}, re.exec(`/api/chats/${c.id}/take`));
  };
  clear();
  const other = sleeper(t);
  const exited = new Promise((r) => other.once('exit', (code, signal) => r(signal)));
  // Written by this test, naming the other process's pid: its writer is gone as far as the record knows.
  const ghost = record({ pid: other.pid });
  assert.deepEqual(await take(ghost), { ok: true });
  assert.equal(fs.existsSync(ghost), false, 'the record goes');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(other.exitCode, null);
  assert.equal(other.signalCode, null, 'and the other process got no signal');
  // The other process's own record: it is told to stop.
  const its = record({ pid: other.pid, proc: system.of([other.pid]).get(other.pid) });
  const done = take(its);
  assert.equal(await exited, 'SIGTERM');
  fs.rmSync(its, { force: true }); // what its launcher would do as it ends
  assert.deepEqual(await done, { ok: true });
  clear();
});

test('end to end on Linux: a launcher\'s record is its own, and after a hard kill its pid on another process does not hold it', { skip: process.platform !== 'linux' && 'the Linux readers' }, async (t) => {
  clear();
  const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'server', 'fixtures', 'fake-launcher.mjs');
  const launcher = spawn(process.execPath, [FAKE, 'work'], { cwd: box.root, stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env } });
  t.after(() => launcher.kill('SIGKILL'));
  const deadline = Date.now() + 10_000;
  let rec;
  while (!(rec = R.listRuns().find((r) => r.pid === launcher.pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(rec, 'the launcher wrote its record');
  assert.equal(rec.proc, system.of([launcher.pid]).get(launcher.pid), 'with its own identity, as the kernel gives it');
  assert.notEqual(rec.proc, system.self());
  const file = path.join(box.state, 'runs', `${rec.runId}.json`);
  launcher.kill('SIGKILL');
  await new Promise((r) => launcher.once('exit', r));
  assert.equal(fs.existsSync(file), true, 'a hard kill leaves the record behind');
  // Its pid is another living process's now (as after a reboot): the record names it, and does not hold anything.
  const other = sleeper(t);
  for (const pid of [other.pid, 1]) {
    fs.writeFileSync(file, JSON.stringify({ ...rec, pid, sessionId: ID }));
    const mine = R.createChatRun({ chat: 'c2', conversation: ID, tool: 'claude', cwd: box.root, profile: 'work' });
    assert.equal(R.heldBefore(mine.run, ID), null, `pid ${pid}`);
    assert.equal(fs.existsSync(file), false, `pid ${pid}: removed`);
    R.removeRun(mine.file);
  }
  clear();
});
