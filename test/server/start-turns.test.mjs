// The dashboard's start with fifty open sessions of long conversations, its watcher's first three ticks and a first
// open of Home: the server's one thread must come back between the steps that hold it. Counted, not timed (a busy
// computer cannot make it pass or fail), in passes of the event loop:
//   - no two programs are started in one pass (each start holds the thread while the system copies the server's
//     memory map: a median of 7.6 ms at 200 MB, 58 ms at 840 MB);
//   - in a tick, the cards and each listener of the tick (the automation, the Operator, ...) run in passes of their own;
//   - the Operator starts its checks one per pass.
// The longest stretch in milliseconds is only reported (the true numbers come from a home of real size).
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from './helpers.mjs';
import { sealedPath } from '../seal.mjs';

const WIN = process.platform === 'win32';
const box = sandbox('startturns');
test.after(() => box.cleanup());

// Stand-ins first on PATH (then the runner's traps): tmux knows no server, the coding tool and the others answer
// nothing. The Operator's look at left-over tmux servers asks this tmux, never a real server of another program.
const bin = path.join(box.root, 'bin');
fs.mkdirSync(bin);
const stand = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
stand('tmux', '[ "$1" = -V ] && { echo "tmux 3.4"; exit 0; }\necho "no server running on /tmp/none" >&2\nexit 1');
for (const n of ['claude', 'gh', 'npm', 'opencode', 'trouteai', 'cloudflared']) stand(n, `echo "${n}: a stand-in" >&2\nexit 1`);
process.env.PATH = sealedPath(`${bin}${path.delimiter}${process.env.PATH}`);
process.env.HOPRIG_NODE_NPM = path.join(bin, 'npm');

const { saveConfig } = await import('../../src/config.mjs');
const { hashPassword } = await import('../../src/server/auth.mjs');
const { projectDir } = await import('../../src/sessions.mjs');
const { stateDir } = await import('../../src/paths.mjs');
const { createServer } = await import('../../src/server/server.mjs');

const line = (o) => `${JSON.stringify(o)}\n`;
/** A conversation of about 320 KB (more than one piece of a read), its title written early on. */
function convo(cwd, id) {
  const dir = projectDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  let text = line({ type: 'user', uuid: 'u-first', message: { role: 'user', content: `fix the cart total ${id.slice(0, 4)}` } });
  for (let n = 0; n < 200; n++) {
    text += line({ type: 'assistant', uuid: `a-${n}`, timestamp: new Date(1e12 + n * 1000).toISOString(), message: { id: `msg-${n}`, role: 'assistant', content: [{ type: 'text', text: `answer ${n} ${'x'.repeat(600 + ((n * 7919) % 1400))}` }] } });
    text += line({ type: 'user', uuid: `u-${n}`, timestamp: new Date(1e12 + n * 1000 + 500).toISOString(), message: { role: 'user', content: `message ${n}` } });
    if (n === 20) text += line({ type: 'ai-title', sessionId: id, aiTitle: `Cart total ${id.slice(0, 4)}` });
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), text);
}

test('a start with fifty open sessions, three ticks and a first open of Home give the thread back between their steps', { skip: WIN && 'the stand-ins are shell scripts', timeout: 120_000 }, async (t) => {
  const work = path.join(box.root, 'work');
  const chats = [];
  for (let i = 0; i < 50; i++) {
    const cwd = path.join(work, `shop${i}`);
    fs.mkdirSync(cwd, { recursive: true });
    const id = crypto.randomUUID();
    convo(cwd, id);
    chats.push({ id, engine: 'claude', cwd, profile: 'sub', openedAt: Date.now() });
  }
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(path.join(stateDir(), 'chats.json'), JSON.stringify(chats));
  saveConfig({ usage: false, server: { roots: [work], passwordHash: await hashPassword('right-password'), backend: 'tmux', tmuxSocket: `startturns-${process.pid}` }, addons: { trouteai: { port: 9 } } });

  // Passes of the event loop, and the longest stretch between two of them.
  let pass = 0;
  let going = true;
  let last = performance.now();
  let longest = 0;
  const count = () => {
    if (!going) return;
    const n = performance.now();
    longest = Math.max(longest, n - last);
    last = n;
    pass++;
    setImmediate(count);
  };
  setImmediate(count);

  const starts = []; // [pass, program]
  const spawn = ChildProcess.prototype.spawn;
  t.after(() => { ChildProcess.prototype.spawn = spawn; });
  ChildProcess.prototype.spawn = function (o) {
    starts.push([pass, path.basename(String(o.file))]);
    return spawn.call(this, o);
  };
  let tickNo = 0;
  const checks = []; // [tick, pass]: an Operator check begins its look (its tick reads the clock first)
  const now = () => {
    if (/^\s*at (?:Object\.)?tick \(.*[\\/]operator[\\/]sources\.mjs:/.test(new Error().stack.split('\n')[2] || '')) checks.push([tickNo, pass]);
    return Date.now();
  };
  const app = createServer({ watchTickMs: 200, chat: { command: { command: process.execPath, args: ['-e', ''] }, idleMs: 600_000 }, automation: { updateItems: [] }, operator: { now } });
  const w = app.watcher;
  const parts = []; // [tick, what, pass]
  const cards = w.cards;
  w.cards = async () => {
    const c = await cards();
    parts.push([tickNo, 'cards', pass]);
    return c;
  };
  let third;
  const ticked = new Promise((r) => { third = r; });
  const tick = w.tick.bind(w);
  w.tick = async () => {
    tickNo++;
    try {
      return await tick();
    } finally {
      if (tickNo < 3) setTimeout(() => w.poke(), 50);
      else third();
    }
  };
  const { port } = await app.listen(0, '127.0.0.1');
  // Every listener of a tick is registered once the features have started.
  const listeners = [...w.tickListeners];
  w.tickListeners.clear();
  listeners.forEach((fn, k) => w.tickListeners.add(async (c) => {
    parts.push([tickNo, `listener ${k} begins`, pass]);
    try {
      return await fn(c);
    } finally {
      parts.push([tickNo, `listener ${k} ends`, pass]);
    }
  }));
  t.after(() => app.close());
  await Promise.race([ticked, new Promise((r) => setTimeout(r, 60_000))]);
  assert.equal(tickNo >= 3, true, `three ticks ran (${tickNo})`);

  // Home's first open: the login, then its requests side by side.
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ password: 'right-password' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const home = await Promise.all(['/api/settings', '/api/machines/sessions', '/api/state', '/api/field', '/api/settings/bypass', '/api/onboarding', '/api/workspace/git', '/api/brain'].map(async (p) => {
    const r = await fetch(`${base}${p}`, { headers: { Cookie: cookie } });
    return [p, r.status, await r.json()];
  }));
  // What the ticks now start a pass later is there for the first request that needs it: the Operator's board has the
  // look at this computer (the snapshot) and, on Linux, at left-over processes.
  const board = await (await fetch(`${base}/api/operator/board`, { headers: { Cookie: cookie } })).json();
  going = false;
  const watched = Object.fromEntries(board.watched.map((x) => [x.source, x]));
  assert.equal(watched.machine.ok, true, JSON.stringify(watched.machine));
  assert.ok(board.machine && board.machine.cpus > 0, 'the snapshot of this computer is on the board');
  if (process.platform === 'linux') assert.equal(watched.leftovers.ok, true, JSON.stringify(watched.leftovers));
  for (const [p, status] of home) assert.equal(status, 200, p);
  const sessions = home.find(([p]) => p === '/api/machines/sessions')[2].machines.find((m) => m.machine === null).sessions;
  assert.equal(sessions.filter((s) => s.kind === 'chat').length, 50, 'Home lists the fifty open sessions');
  t.diagnostic(`${pass} passes of the event loop, ${starts.length} programs started, longest stretch ${longest.toFixed(1)} ms (only reported)`);

  // No two program starts in one pass.
  assert.ok(starts.length >= 5, `programs were started: ${starts.length}`);
  const byPass = new Map();
  for (const [p, name] of starts) byPass.set(p, [...(byPass.get(p) || []), name]);
  const crowded = [...byPass].filter(([, names]) => names.length > 1);
  assert.deepEqual(crowded, [], 'two or more programs started in one pass of the event loop');

  // A tick's parts in passes of their own.
  for (let n = 1; n <= 3; n++) {
    const mine = parts.filter((x) => x[0] === n);
    assert.ok(mine.length >= 3, `tick ${n} has its cards and its listeners: ${JSON.stringify(mine)}`);
    for (let i = 1; i < mine.length; i++) {
      if (!mine[i][1].endsWith('begins')) continue;
      assert.ok(mine[i][2] > mine[i - 1][2], `tick ${n}: ${mine[i][1]} ran in the same pass as ${mine[i - 1][1]}: ${JSON.stringify(mine)}`);
    }
  }

  // The Operator's look at the providers' readings and its seven checks, one per pass, in each tick.
  for (let n = 1; n <= 3; n++) {
    const mine = checks.filter((x) => x[0] === n).map((x) => x[1]);
    assert.equal(mine.length, 8, `tick ${n}: the Operator looked at the readings and its seven checks (${mine.length})`);
    assert.equal(new Set(mine).size, 8, `tick ${n}: two of the Operator's looks began in one pass: ${mine.join(' ')}`);
  }
});
