// The board's real sources and acts in a temporary home: run records made to ask and to stop at a limit, a session
// that goes away, a real tmux server left on a private socket, a clone behind its local bare repository and one ahead
// of it, and the acts that end a process (only the very same one), fast-forward and push. Each thing is shown while
// its cause is there and gone when the cause is gone.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sandbox } from '../server/helpers.mjs';

const box = sandbox('operator-sources');
test.after(() => box.cleanup());

const { createRun, updateRun, removeRun } = await import('../../src/runs.mjs');
const { defaultActs, defaultSources, hostOf, leftovers, loginAddress, todoText } = await import('../../src/operator/sources.mjs');
const { buildBoard } = await import('../../src/operator/board.mjs');
const { attention } = await import('../../src/operator/attention.mjs');
const { system: identity } = await import('../../src/procid.mjs');
const { operatorFeature } = await import('../../src/operator/feature.mjs');
const { onlyIdleShells } = await import('../../src/operator/detect/leftover.mjs');

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Alex', GIT_AUTHOR_EMAIL: 'alex@box2', GIT_COMMITTER_NAME: 'Alex', GIT_COMMITTER_EMAIL: 'alex@box2' } }).trim();
const hasTmux = (() => { try { execFileSync('tmux', ['-V']); return true; } catch { return false; } })();
// A server started by "new-session -d" names its pane's program "tmux" until that program runs: wait for it before a
// look reads the panes, or the look sees a server still starting.
async function started(sock, command) {
  let now = '';
  for (let i = 0; i < 100; i++) {
    now = execFileSync('tmux', ['-L', sock, 'list-panes', '-a', '-F', '#{pane_current_command}'], { encoding: 'utf8' }).trim();
    if (now.split('\n').every((c) => c === command)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`tmux server ${sock} still runs ${now}, not ${command}`);
}

const projects = path.join(box.root, 'projects');
fs.mkdirSync(projects);
const cards = [];
const ctx = { state: async () => ({ sessions: cards, profiles: [{ name: 'plan-a', signedIn: true, usage: null }] }), config: () => ({ projectsDir: projects, server: {} }) };

async function look(src) {
  await src.tick();
  const board = await buildBoard(src.sources, { timeoutMs: 20_000 });
  return attention(board);
}

test('sessions: an ask and a limit from the run records, an ended one when its coding tool ends in its terminal', async () => {
  const src = defaultSources(ctx, { port: () => null });
  const { file, run } = createRun({ profile: 'plan-a', cwd: box.home });
  updateRun(file, { status: 'attention', asks: ['main'], askType: 'permission', askAt: Date.now() - 6 * 60_000 });
  cards.push({ name: 'alpha', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'plan-a' }, runId: run.runId, status: 'attention', statusAt: Date.now(), canSwitch: true });
  cards.push({ name: 'beta', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'plan-a' }, status: 'waiting', statusAt: Date.now(), runLimit: { at: Date.now() - 60_000, text: 'Usage limit reached' } });
  let l = await look(src);
  const asks = l.items.find((i) => i.kind === 'asks');
  assert.equal(asks?.subject, 'session alpha');
  assert.ok(asks.facts.includes('the session waits for your OK'), asks.facts.join('|'));
  assert.equal(l.items.find((i) => i.kind === 'limit')?.subject, 'session beta');
  // The answer was given: the record no longer asks. The limit ended. The coding tool of alpha ended: its terminal
  // is a plain shell now.
  updateRun(file, { status: 'working', asks: [] });
  cards.splice(0, cards.length, { name: 'alpha', kind: 'shell', cwd: box.home }, { ...cards[1], runLimit: null, status: 'working' });
  l = await look(src);
  assert.deepEqual(l.items.filter((i) => ['asks', 'limit'].includes(i.kind)), []);
  assert.deepEqual(l.items.filter((i) => i.kind === 'ended').map((i) => i.subject), ['session alpha']);
  // The owner closed both: the terminals went away, so neither is an ended item (nothing is left to open).
  cards.length = 0;
  l = await look(src);
  assert.deepEqual(l.items.filter((i) => i.kind === 'ended'), [], 'a closed session is no item');
  removeRun(file);
  cards.length = 0;
});

test('a session whose workflow runs in the background is not stuck while its agents write; it is when they are quiet too', async () => {
  const cwd = path.join(box.root, 'bg');
  fs.mkdirSync(cwd);
  const sid = '11111111-2222-3333-4444-555555555555';
  const { file, run } = createRun({ profile: 'plan-a', cwd });
  updateRun(file, { status: 'working', background: ['wf-1'], sessionId: sid });
  cards.push({ name: 'alpha', kind: 'claude', tool: 'claude', cwd, profile: { name: 'plan-a' }, runId: run.runId, sessionId: sid, status: 'working', statusAt: Date.now() - 25 * 60_000 });
  const old = (Date.now() - 25 * 60_000) / 1000;
  const { projectDir } = await import('../../src/sessions.mjs');
  const conv = projectDir(cwd);
  const agents = path.join(conv, sid, 'subagents', 'workflows', 'wf-1');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(conv, `${sid}.jsonl`), '{}\n');
  fs.utimesSync(path.join(conv, `${sid}.jsonl`), old, old);
  fs.utimesSync(file, old, old);
  updateRun(file, { statusAt: Date.now() - 25 * 60_000 });
  fs.writeFileSync(path.join(agents, 'agent-1.jsonl'), '{}\n'); // an agent of the workflow wrote just now
  const src = defaultSources(ctx, { port: () => null });
  const stuck = async () => (await look(src)).items.filter((i) => i.kind === 'stuck');
  assert.deepEqual(await stuck(), [], 'its workflow made progress');
  fs.utimesSync(path.join(agents, 'agent-1.jsonl'), old, old);
  const [it] = await stuck();
  assert.equal(it?.subject, 'session alpha');
  assert.ok(it.facts.includes('1 background task runs, quiet too'), it.facts.join('|'));
  removeRun(file);
  cards.length = 0;
});

test('a session that ran several workflows is not stuck while its current one works, also with more than 400 old agent files', async () => {
  const cwd = path.join(box.root, 'bg-many');
  fs.mkdirSync(cwd);
  const sid = '22222222-3333-4444-5555-666666666666';
  const { file, run } = createRun({ profile: 'plan-a', cwd });
  updateRun(file, { status: 'working', background: ['wf-now'], sessionId: sid });
  cards.push({ name: 'alpha', kind: 'claude', tool: 'claude', cwd, profile: { name: 'plan-a' }, runId: run.runId, sessionId: sid, status: 'working', statusAt: Date.now() - 25 * 60_000 });
  const old = (Date.now() - 60 * 60_000) / 1000;
  const { projectDir } = await import('../../src/sessions.mjs');
  const conv = projectDir(cwd);
  const flows = path.join(conv, sid, 'subagents', 'workflows');
  // Three finished workflows of 150 agent files each, an hour old, then the one at work now.
  for (const w of ['wf-a', 'wf-b', 'wf-c']) {
    fs.mkdirSync(path.join(flows, w), { recursive: true });
    for (let i = 0; i < 150; i++) {
      const f = path.join(flows, w, `agent-${i}.jsonl`);
      fs.writeFileSync(f, '{}\n');
      fs.utimesSync(f, old, old);
    }
    fs.utimesSync(path.join(flows, w), old, old);
  }
  fs.mkdirSync(path.join(flows, 'wf-now'));
  fs.writeFileSync(path.join(flows, 'wf-now', 'agent-0.jsonl'), '{}\n');
  fs.writeFileSync(path.join(conv, `${sid}.jsonl`), '{}\n');
  fs.utimesSync(path.join(conv, `${sid}.jsonl`), old, old);
  fs.utimesSync(file, old, old);
  updateRun(file, { statusAt: Date.now() - 25 * 60_000 });
  const src = defaultSources(ctx, { port: () => null });
  try {
    assert.deepEqual((await look(src)).items.filter((i) => i.kind === 'stuck'), [], 'its current workflow made progress');
  } finally {
    removeRun(file);
    cards.length = 0;
  }
});

// A session at work whose workflow agent writes now, in a subagents folder laid out by `fill`: it is not stuck.
async function notStuckWith(name, sid, fill) {
  const cwd = path.join(box.root, name);
  fs.mkdirSync(cwd);
  const { file, run } = createRun({ profile: 'plan-a', cwd });
  updateRun(file, { status: 'working', background: ['wf-now'], sessionId: sid });
  cards.push({ name: 'alpha', kind: 'claude', tool: 'claude', cwd, profile: { name: 'plan-a' }, runId: run.runId, sessionId: sid, status: 'working', statusAt: Date.now() - 25 * 60_000 });
  const at = (min) => (Date.now() - min * 60_000) / 1000;
  const { projectDir } = await import('../../src/sessions.mjs');
  const conv = projectDir(cwd);
  const sub = path.join(conv, sid, 'subagents');
  fs.mkdirSync(path.join(sub, 'workflows'), { recursive: true });
  fill(sub, at);
  fs.writeFileSync(path.join(conv, `${sid}.jsonl`), '{}\n');
  fs.utimesSync(path.join(conv, `${sid}.jsonl`), at(60), at(60));
  fs.utimesSync(file, at(60), at(60));
  updateRun(file, { statusAt: Date.now() - 25 * 60_000 });
  try {
    return (await look(defaultSources(ctx, { port: () => null }))).items.filter((i) => i.kind === 'stuck');
  } finally {
    removeRun(file);
    cards.length = 0;
  }
}

test('the agent that writes is found also behind more than 400 old files beside workflows/', async () => {
  const stuck = await notStuckWith('bg-beside', '33333333-4444-5555-6666-777777777777', (sub, at) => {
    for (let i = 0; i < 450; i++) {
      const f = path.join(sub, `agent-${i}.jsonl`);
      fs.writeFileSync(f, '{}\n');
      fs.utimesSync(f, at(60), at(60));
    }
    fs.mkdirSync(path.join(sub, 'workflows', 'wf-now'));
    fs.writeFileSync(path.join(sub, 'workflows', 'wf-now', 'agent-0.jsonl'), '{}\n');
  });
  assert.deepEqual(stuck, [], 'its current workflow made progress');
});

test('the agent of a long workflow is found also when its folder is older than later, finished ones', async () => {
  const stuck = await notStuckWith('bg-long', '44444444-5555-6666-7777-888888888888', (sub, at) => {
    const flows = path.join(sub, 'workflows');
    fs.mkdirSync(path.join(flows, 'wf-now'));
    const live = path.join(flows, 'wf-now', 'agent-0.jsonl');
    fs.writeFileSync(live, '{}\n');
    for (const w of ['wf-a', 'wf-b', 'wf-c']) {
      fs.mkdirSync(path.join(flows, w));
      for (let i = 0; i < 150; i++) {
        const f = path.join(flows, w, `agent-${i}.jsonl`);
        fs.writeFileSync(f, '{}\n');
        fs.utimesSync(f, at(40), at(40));
      }
      fs.utimesSync(path.join(flows, w), at(40), at(40));
    }
    fs.utimesSync(path.join(flows, 'wf-now'), at(50), at(50));
    fs.appendFileSync(live, '{}\n'); // the long agent writes now; its folder's time does not move
  });
  assert.deepEqual(stuck, [], 'its long workflow made progress');
});

test('a tmux server left on a private socket with only a shell is found with its identity; it is gone once ended', { skip: !hasTmux && 'tmux is not installed' }, async () => {
  const sock = `op1-left-${process.pid}`;
  execFileSync('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', 'sh']);
  try {
    await started(sock, 'sh');
    // tmux starts the command through the person's shell: for a moment the pane still runs that shell, then `sh` itself
    // (on a fast computer the first look came in that moment and saw "bash").
    let found = [];
    for (let i = 0; i < 100; i++) {
      found = (await leftovers({ ownSocket: 'some-other' })).filter((p) => p.socket === sock);
      if (found.length === 1 && found[0].panes.length === 1 && found[0].panes[0].command === 'sh') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(found.length, 1);
    const [p] = found;
    assert.equal(p.what, 'tmux');
    assert.equal(p.clients, 0);
    assert.deepEqual(p.panes, [{ command: 'sh', children: 0 }]);
    assert.ok(onlyIdleShells(p.panes), `only an idle shell: ${JSON.stringify(p.panes)}`);
    assert.ok(p.proc, 'its identity is read');
    assert.ok(Math.abs(Date.parse(p.startedAt) - Date.now()) < 60_000, `started ${p.startedAt}`);
    assert.deepEqual((await leftovers({ ownSocket: sock })).filter((x) => x.socket === sock), [], 'the configured socket is never a leftover');
    // A test's server: the Hoprig that started it keeps its state in the temporary folder (the runner's
    // HOPRIG_STATE_DIR). Seen from another temporary folder it is not a test's, as the owner's own detached server is not.
    assert.equal(p.temp, true, 'a test\'s server is in the temporary folder');
    const other = fs.mkdtempSync(path.join(box.root, 'elsewhere-'));
    assert.equal((await leftovers({ ownSocket: 'some-other', tmp: other })).find((x) => x.socket === sock)?.temp, false);
    // The act ends it by its identity; a wrong identity ends nothing.
    const acts = defaultActs();
    await assert.rejects(acts.end({ pid: p.pid, proc: 'L:another:1', what: 'tmux', socket: sock }), /ended already|nothing was ended/);
    assert.equal((await leftovers({})).filter((x) => x.socket === sock).length, 1, 'still there');
    assert.deepEqual(await acts.end({ pid: p.pid, proc: p.proc, what: 'tmux', socket: sock }), { ended: true });
    for (let i = 0; i < 30 && (await leftovers({})).some((x) => x.socket === sock); i++) await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual((await leftovers({})).filter((x) => x.socket === sock), []);
  } finally {
    try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* ended already */ }
  }
});

// Every way a shell can hold a job, typed into an interactive shell as the owner would. Each is busy: no item, and
// the end act refuses it. 'second' leaves the first pane idle and runs the job in a second pane.
const JOBS = {
  'sleep 600 &': ['sleep 600 &'],
  '(sleep 600; echo done) &': ['(sleep 600; echo done) &'],
  "nohup bash -c '…' &": ["nohup bash -c 'sleep 600; echo done' >/dev/null 2>&1 &"],
  'sh job.sh &': ['sh JOB &'],
  'a job stopped with Ctrl+Z': ['sleep 600', 'C-z'],
  'a pipeline': ['sleep 600 | cat &'],
  'a program started by exec': ['exec sleep 600'],
  'a second pane busy, the first idle': ['second', 'sleep 600 &'],
};

test('a tmux server started in the temporary folder is a test\'s only when its Hoprig keeps its state there', { skip: !hasTmux && 'tmux is not installed' }, async () => {
  // The owner's own detached server, started from a shell in /tmp: its folder and its socket folder are in the
  // temporary folder, but no Hoprig of a test started it (no state folder there).
  const cwd = fs.mkdtempSync(path.join(box.root, 'cwd-'));
  const { HOPRIG_STATE_DIR: _s, ...owners } = process.env;
  const servers = [[`op2-own-${process.pid}`, owners, false], [`op2-test-${process.pid}`, process.env, true]];
  try {
    for (const [sock, env] of servers) execFileSync('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', 'sh'], { cwd, env });
    const found = await leftovers({ ownSocket: 'some-other', runs: () => [] });
    for (const [sock, , temp] of servers) assert.equal(found.find((x) => x.socket === sock)?.temp, temp, `${sock}: ${JSON.stringify(found.find((x) => x.socket === sock))}`);
  } finally {
    for (const [sock] of servers) try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* ended already */ }
  }
});

test('a tmux server is a leftover only when its shells run nothing; every way a shell holds a job is busy and the end act refuses it', { skip: !hasTmux && 'tmux is not installed' }, async () => {
  const job = path.join(box.root, 'job.sh');
  fs.writeFileSync(job, 'sleep 600\necho done\n');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const tmux = (sock, ...a) => execFileSync('tmux', ['-L', sock, ...a], { encoding: 'utf8' });
  const later = Date.now() + 11 * 60_000;
  const open = async (sock) => {
    tmux(sock, '-f', '/dev/null', 'new-session', '-d', '-s', 'job', 'bash', '--norc', '--noprofile', '-i');
    await wait(300);
  };
  const find = async (sock) => (await leftovers({ runs: () => [] })).filter((x) => x.socket === sock)[0];
  // Every process under the panes' shells is ended before the server: a nohup job ignores the hangup kill-server sends.
  const descendants = (pid) => {
    let kids = [];
    try {
      kids = fs.readdirSync(`/proc/${pid}/task`).flatMap((t) => fs.readFileSync(`/proc/${pid}/task/${t}/children`, 'utf8').split(' ').filter(Boolean).map(Number));
    } catch { /* gone */ }
    return kids.flatMap((k) => [k, ...descendants(k)]);
  };
  const end = (sock) => {
    try {
      for (const pid of tmux(sock, 'list-panes', '-a', '-F', '#{pane_pid}').split('\n').filter(Boolean).flatMap((p) => descendants(Number(p)))) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* ended already */ }
      }
    } catch { /* no server */ }
    try { tmux(sock, 'kill-server'); } catch { /* ended already */ }
    // A server the end act ended by its pid leaves its socket file behind: the test's own is removed.
    fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, sock), { force: true });
  };
  let i = 0;
  for (const [name, keys] of Object.entries(JOBS)) {
    const sock = `op1b-job-${process.pid}-${i++}`;
    await open(sock);
    try {
      let target = 'job';
      for (const k of keys) {
        if (k === 'second') {
          tmux(sock, 'split-window', '-d', '-t', 'job', 'bash', '--norc', '--noprofile', '-i');
          await wait(300);
          target = 'job.1';
        } else if (k === 'C-z') tmux(sock, 'send-keys', '-t', target, 'C-z');
        else tmux(sock, 'send-keys', '-t', target, k.replace('JOB', job), 'Enter');
        await wait(300);
      }
      // The job shows once its process is there: until then the server may still read as idle.
      let p;
      for (let n = 0; n < 30; n++) {
        p = await find(sock);
        if (p && !p.panes?.every((x) => x.command !== 'sleep' && x.children === 0)) break;
        await wait(100);
      }
      assert.ok(p, `${name}: the server is found`);
      assert.equal(onlyIdleShells(p.panes), false, `${name}: busy, panes ${JSON.stringify(p.panes)}`);
      assert.deepEqual(attention({ leftovers: [p] }, { now: later }).items.filter((it) => it.kind === 'leftover'), [], `${name}: not offered for ending`);
      await assert.rejects(defaultActs({ runs: () => [] }).end({ pid: p.pid, proc: p.proc, what: 'tmux', socket: sock }), /a program runs in that tmux server now/, name);
      assert.ok(await find(sock), `${name}: still there`);
    } finally {
      end(sock);
    }
  }
  // A server with only idle shells, in two panes: a leftover, said by what was checked, and the end act ends it.
  const sock = `op1b-idle-${process.pid}`;
  await open(sock);
  try {
    tmux(sock, 'split-window', '-d', '-t', 'job', 'bash', '--norc', '--noprofile', '-i');
    await wait(300);
    const p = await find(sock);
    assert.deepEqual(p.panes, [{ command: 'bash', children: 0 }, { command: 'bash', children: 0 }]);
    const [it] = attention({ leftovers: [p] }, { now: later }).items.filter((x) => x.kind === 'leftover');
    assert.equal(it?.subject, `tmux server ${sock}`);
    assert.ok(it.facts.includes('its shells run nothing (2 panes, no child process)'), it.facts.join('|'));
    // A run record that names the socket since the look: the end act asks again and refuses.
    await assert.rejects(defaultActs({ runs: () => [{ tmuxSocket: `/tmp/tmux-1000/${sock}` }] }).end({ pid: p.pid, proc: p.proc, what: 'tmux', socket: sock }), /a program runs in that tmux server now/);
    assert.deepEqual(await defaultActs({ runs: () => [] }).end({ pid: p.pid, proc: p.proc, what: 'tmux', socket: sock }), { ended: true });
  } finally {
    end(sock);
  }
});

test('a tmux server whose pane runs a program is at work: no item, and the end act refuses it; a session\'s socket is never looked at', { skip: !hasTmux && 'tmux is not installed' }, async () => {
  const sock = `op1-busy-${process.pid}`;
  execFileSync('tmux', ['-L', sock, '-f', '/dev/null', 'new-session', '-d', '-s', 'busy', 'sleep', '600']);
  try {
    await started(sock, 'sleep');
    const [p] = (await leftovers({})).filter((x) => x.socket === sock);
    assert.deepEqual(p.panes, [{ command: 'sleep', children: null }]);
    const later = attention({ leftovers: [p] }, { now: Date.now() + 11 * 60_000 });
    assert.deepEqual(later.items.filter((i) => i.kind === 'leftover'), [], 'a server that runs a program is not offered for ending');
    await assert.rejects(defaultActs().end({ pid: p.pid, proc: p.proc, what: 'tmux', socket: sock }), /a program runs in that tmux server now/);
    assert.equal((await leftovers({})).filter((x) => x.socket === sock).length, 1, 'still there');
    assert.deepEqual((await leftovers({ runs: () => [{ tmuxSocket: `/tmp/tmux-1000/${sock}` }] })).filter((x) => x.socket === sock), [], 'a run record names it');
  } finally {
    try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* ended already */ }
  }
});

test('a tmux server that ends while it is looked at is no leftover, and the check goes on (it does not fail as a whole)', { skip: process.platform !== 'linux' && 'Linux only' }, async () => {
  const proc = fs.mkdtempSync(path.join(os.tmpdir(), 'hop-proc-'));
  try {
    fs.writeFileSync(path.join(proc, 'stat'), 'cpu 1 2 3\nbtime 1700000000\n');
    const stat = (pid) => `${pid} (tmux: server) S 1 ${pid} ${pid} 0 -1 4194368 100 0 0 0 1 1 0 0 20 0 1 0 123456 1000000 100 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0\n`;
    for (const [pid, sock] of [[4242, 'gone-soon'], [4243, 'stays']]) {
      fs.mkdirSync(path.join(proc, String(pid)));
      fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), ['tmux', '-L', sock, 'new-session', '-d'].join('\0'));
      fs.writeFileSync(path.join(proc, String(pid), 'stat'), stat(pid));
    }
    const asked = [];
    // The first server ends at the very moment its clients are asked for: its stat file is gone for the next read.
    const run = async (argv) => {
      asked.push(argv.join(' '));
      if (argv.includes('gone-soon') && argv.includes('list-clients')) fs.rmSync(path.join(proc, '4242'), { recursive: true });
      return { ok: false, stdout: '', stderr: 'no server running on /tmp/tmux-1000/x' };
    };
    const found = await leftovers({ proc, run, ports: async () => [], runs: () => [] });
    assert.deepEqual(found.map((x) => x.socket), ['stays'], 'the one that ended is left out; the other is still listed');
    assert.ok(asked.some((a) => a.includes('gone-soon')), 'the one that ended was looked at');
  } finally {
    fs.rmSync(proc, { recursive: true, force: true });
  }
});

test('the end act refuses a process whose number now belongs to another one', async () => {
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 200));
  try {
    const proc = identity.of([child.pid]).get(child.pid);
    assert.ok(proc);
    await assert.rejects(defaultActs().end({ pid: child.pid, proc: `${proc}9` }), (e) => e.status === 409);
    assert.equal(child.exitCode, null, 'not ended');
    await assert.rejects(defaultActs().end({ pid: child.pid, proc: null }), /cannot be named exactly/);
    assert.deepEqual(await defaultActs().end({ pid: child.pid, proc }), { ended: true });
  } finally {
    child.kill('SIGKILL');
  }
});

test('repositories: a clone behind its bare repository shows, is brought up to date by the act, and is gone; ahead is pushed', async () => {
  const bare = path.join(box.root, 'shop.git');
  git(box.root, 'init', '--quiet', '--bare', '-b', 'main', bare);
  const other = path.join(box.root, 'other');
  git(box.root, 'clone', '--quiet', bare, other);
  fs.writeFileSync(path.join(other, 'a.txt'), 'one\n');
  git(other, 'add', 'a.txt');
  git(other, 'commit', '--quiet', '-m', 'one');
  git(other, 'push', '--quiet', 'origin', 'main');
  const shop = path.join(projects, 'shop');
  git(box.root, 'clone', '--quiet', bare, shop);
  fs.writeFileSync(path.join(other, 'a.txt'), 'two\n');
  git(other, 'commit', '--quiet', '-am', 'two');
  git(other, 'push', '--quiet', 'origin', 'main');
  git(shop, 'fetch', '--quiet');

  let l = await look(defaultSources(ctx, { port: () => null }));
  let it = l.items.find((i) => i.kind === 'repo');
  assert.equal(it?.subject, 'repository shop');
  assert.equal(it.recommended, 'sync');
  assert.ok(it.facts.includes('1 newer commit on the git server, not here yet'), it.facts.join('|'));
  assert.ok(it.facts.some((f) => /^as of the last fetch at /.test(f)), it.facts.join('|'));
  const acts = defaultActs({ projects: () => projects });
  await assert.rejects(acts.sync({ path: '../other' }), /not in the workspace/);
  await acts.sync(it.target);
  assert.equal(git(shop, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
  l = await look(defaultSources(ctx, { port: () => null }));
  assert.equal(l.items.find((i) => i.kind === 'repo'), undefined, 'in step: gone');

  fs.writeFileSync(path.join(shop, 'b.txt'), 'mine\n');
  git(shop, 'add', 'b.txt');
  git(shop, 'commit', '--quiet', '-m', 'mine');
  l = await look(defaultSources(ctx, { port: () => null }));
  it = l.items.find((i) => i.kind === 'repo');
  assert.equal(it.recommended, 'push');
  assert.equal(it.class, 'info');
  await acts.push(it.target);
  assert.equal(git(bare, 'rev-parse', 'main'), git(shop, 'rev-parse', 'HEAD'));
  await assert.rejects(acts.push(it.target), /no longer only ahead/);
  l = await look(defaultSources(ctx, { port: () => null }));
  assert.equal(l.items.find((i) => i.kind === 'repo'), undefined);
});

test('restartGateway acts on the gateways list it is given, not the computer\'s own add-ons', async () => {
  // When a look checks a list of its own (the demo's pretend gateway), the act for a stopped-gateway item must use
  // the SAME list, or it would stop and start whatever the computer has under that id. The id here is made up, so
  // without the list it is not a real add-on at all (and a real one is never touched).
  const calls = [];
  const addon = { id: 'made-up-gate', stop: async () => (calls.push('stop'), { ok: true }), start: async () => (calls.push('start'), { ok: true }) };
  const acts = defaultActs({ gateways: () => [addon] });
  assert.deepEqual(await acts.restartGateway({ addon: 'made-up-gate' }), { did: 'restarted made-up-gate' });
  assert.deepEqual(calls, ['stop', 'start'], 'the pretend add-on in the list was stopped then started');
  // An id that is in neither the list nor the computer's add-ons is not found.
  await assert.rejects(acts.restartGateway({ addon: 'made-up-absent' }), (e) => e.status === 404);
});

test('after a tap on Bring up to date the next look no longer shows the repository, without waiting for the next round', async () => {
  const bare = path.join(box.root, 'blog.git');
  git(box.root, 'init', '--quiet', '--bare', '-b', 'main', bare);
  const seed = path.join(box.root, 'blog-seed');
  git(box.root, 'clone', '--quiet', bare, seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '--quiet', '-m', 'one');
  git(seed, 'push', '--quiet', 'origin', 'main');
  const blog = path.join(projects, 'blog');
  git(box.root, 'clone', '--quiet', bare, blog);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'two\n');
  git(seed, 'commit', '--quiet', '-am', 'two');
  git(seed, 'push', '--quiet', 'origin', 'main');
  git(blog, 'fetch', '--quiet');
  let tick = null;
  const fctx = { ...ctx, HttpError: class extends Error { constructor(st, m) { super(m); this.status = st; } }, caller: () => 'page', onTick: (fn) => { tick = fn; return () => {}; }, readJson: async (req) => req.body };
  const f = operatorFeature(fctx, { acts: { sync: defaultActs({ projects: () => projects }).sync }, cacheMs: 60_000, timeoutMs: 20_000 });
  const [, , listRoute] = f.routes.find(([m, re]) => m === 'GET' && re.test('/api/operator/attention'));
  const [, , actRoute] = f.routes.find(([m, re]) => m === 'POST' && re.test('/api/operator/act'));
  const blogItem = async () => (await listRoute({ url: '/api/operator/attention', socket: {} })).items.find((i) => i.subject === 'repository blog');
  await tick();
  const it = await blogItem();
  assert.equal(it?.recommended, 'sync');
  const r = await actRoute({ url: '/api/operator/act', socket: {}, body: { item: it.id, act: 'sync', seen: it.rev } });
  assert.equal(r.ok, true);
  assert.equal(git(blog, 'rev-parse', 'HEAD'), git(seed, 'rev-parse', 'HEAD'));
  assert.equal(await blogItem(), undefined, 'in step now: the next look does not show it');
  f.close();
  fs.rmSync(blog, { recursive: true, force: true });
});

test('a gateway that providers go through and that stopped is an item; started again, it is gone; with no session of them open (a restored chat whose process does not run is none) it is only not started yet', async () => {
  const port = 7932;
  let srv = null;
  const up = () => new Promise((r) => { srv = http.createServer((q, s) => s.end()).listen(port, '127.0.0.1', r); });
  const gate = { id: 'gate', status: async () => ({ installed: true, running: !!srv, url: `http://127.0.0.1:${port}` }) };
  const items = async () => {
    const src = defaultSources(ctx, { port: () => null, gateways: () => [gate], usersOf: () => ['plan-g'] });
    return (await look(src)).items.filter((i) => i.subject === 'gateway gate');
  };
  await up();
  try {
    assert.deepEqual(await items(), [], 'it answers');
    await new Promise((r) => srv.close(r));
    srv = null;
    // No session of plan-g is open: its next session's PRERUN starts the gateway, so nothing waits for it.
    const [idle] = await items();
    assert.equal(idle?.class, 'info');
    assert.match(idle.facts[0], /not started: nothing answers on port 7932/);
    assert.match(idle.facts[1], /the next session of plan-g starts it/);
    // A chat of plan-g restored after a restart: its process does not run, so its next message starts the gateway.
    for (const running of [false, undefined]) {
      cards.splice(0, cards.length, { name: 'chat-1', kind: 'chat', profile: { name: 'plan-g', label: 'plan-g' }, status: 'waiting', running, cwd: box.home });
      const [restored] = await items();
      assert.equal(restored?.class, 'info', `a chat with running ${running} is not a live session`);
    }
    cards.splice(0, cards.length, { name: 'chat-1', kind: 'chat', profile: { name: 'plan-g', label: 'plan-g' }, status: 'working', running: true, cwd: box.home });
    assert.equal((await items())[0]?.class, 'stopped', 'a chat whose process runs is');
    cards.length = 0;
    cards.push({ name: 'gamma', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'plan-g' }, status: 'working', statusAt: Date.now() });
    const [it] = await items();
    assert.equal(it?.class, 'stopped');
    assert.equal(it.recommended, 'restart-gateway');
    assert.match(it.facts[0], /not running: nothing answers on port 7932/);
    assert.equal(it.facts[1], '1 open session goes through it and cannot work');
    await up();
    assert.deepEqual(await items(), []);
  } finally {
    srv?.close();
    cards.length = 0;
  }
});

test('a sync whose remote went away says git\'s reason without its path, not the end of its hint', async () => {
  const bare = path.join(box.root, 'notes.git');
  git(box.root, 'init', '--quiet', '--bare', '-b', 'main', bare);
  const seed = path.join(box.root, 'notes-seed');
  git(box.root, 'clone', '--quiet', bare, seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  git(seed, 'add', 'a.txt');
  git(seed, 'commit', '--quiet', '-m', 'one');
  git(seed, 'push', '--quiet', 'origin', 'main');
  const notes = path.join(projects, 'notes');
  git(box.root, 'clone', '--quiet', bare, notes);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'two\n');
  git(seed, 'commit', '--quiet', '-am', 'two');
  git(seed, 'push', '--quiet', 'origin', 'main');
  git(notes, 'fetch', '--quiet');
  fs.renameSync(bare, `${bare}-moved`);
  try {
    await assert.rejects(defaultActs({ projects: () => projects }).sync({ path: 'notes' }), (e) => {
      assert.match(e.message, /^fetch failed: … does not appear to be a git repository/);
      assert.ok(!e.message.includes(box.root), e.message);
      return e.status === 409;
    });
  } finally {
    fs.rmSync(notes, { recursive: true, force: true });
  }
});

test('a sync or push error hides absolute paths and addresses, not branch names or the repository\'s files', () => {
  const said = (why) => todoText([{ why }]);
  assert.equal(said('feature/login has no upstream'), 'feature/login has no upstream');
  assert.equal(said("fetch failed: couldn't find remote ref refs/heads/release/2026"), "fetch failed: couldn't find remote ref refs/heads/release/2026");
  assert.equal(said('3 to pull, but the incoming commits change src/app.js, which you changed too'), '3 to pull, but the incoming commits change src/app.js, which you changed too');
  assert.equal(said("fetch failed: '/srv/git/notes.git' does not appear to be a git repository"), 'fetch failed: … does not appear to be a git repository');
  assert.equal(said('fetch failed: unable to access https://git.example/shop.git/: 403'), 'fetch failed: unable to access … 403');
  assert.equal(said('fetch failed: alex@box2:example/shop.git not found'), 'fetch failed: … not found');
  // An scp-style address with no user, a path in the home, and the host ssh could not reach.
  assert.equal(said("fetch failed: 'box2:repos/shop.git' does not appear to be a git repository"), 'fetch failed: … does not appear to be a git repository');
  assert.equal(said('fetch failed: box2:/srv/git/shop.git not found'), 'fetch failed: … not found');
  assert.equal(said("fetch failed: '~/repos/shop.git' does not appear to be a git repository"), 'fetch failed: … does not appear to be a git repository');
  assert.equal(said('fetch failed: ssh: Could not resolve hostname box2.lan: Name or service not known'), 'fetch failed: ssh: Could not resolve hostname …: Name or service not known');
  assert.equal(said('fetch failed: ssh: connect to host box2.lan port 22: Connection refused'), 'fetch failed: ssh: connect to host … port 22: Connection refused');
  for (const host of ['box2', 'box2.lan', 'git.example']) {
    for (const why of [`ssh: Could not resolve hostname ${host}: Name or service not known`, `ssh: connect to host ${host} port 22: Connection timed out`, `fatal: '${host}:shop.git/' does not appear to be a git repository`]) {
      assert.ok(!said(why).includes(host), `${why} -> ${said(why)}`);
    }
  }
});

test('a push that the server refuses says what the server said, not the end of git\'s hint', async () => {
  const bare = path.join(box.root, 'guarded.git');
  git(box.root, 'init', '--quiet', '--bare', '-b', 'main', bare);
  const guarded = path.join(projects, 'guarded');
  git(box.root, 'clone', '--quiet', bare, guarded);
  fs.writeFileSync(path.join(guarded, 'a.txt'), 'one\n');
  git(guarded, 'add', 'a.txt');
  git(guarded, 'commit', '--quiet', '-m', 'one');
  git(guarded, 'push', '--quiet', 'origin', 'main');
  fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "branch main is protected"\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(guarded, 'a.txt'), 'two\n');
  git(guarded, 'commit', '--quiet', '-am', 'two');
  try {
    await assert.rejects(defaultActs({ projects: () => projects }).push({ path: 'guarded' }), (e) => {
      assert.equal(e.message, 'push failed: branch main is protected; [remote rejected] main -> main (pre-receive hook declined)');
      return e.status === 409;
    });
  } finally {
    fs.rmSync(guarded, { recursive: true, force: true });
  }
});

test('a source that has not been looked at yet says so, never empty', async () => {
  const src = defaultSources(ctx, { port: () => null });
  const board = await buildBoard(src.sources);
  const repos = board.watched.find((w) => w.source === 'repos');
  assert.equal(repos.ok, false);
  assert.match(repos.error, /could not be read: not looked at yet/);
});

test('the login page is checked at /login, which answers without a login; an unknown port is said, never guessed', async () => {
  assert.equal(loginAddress('https://alpha.example/x?k=1'), 'https://alpha.example/login');
  // A stand-in dashboard: "/" sends a visitor to the login page, "/login" answers 200.
  const srv = http.createServer((req, res) => { res.writeHead(req.url === '/login' ? 200 : 302, req.url === '/login' ? {} : { Location: '/login' }); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const src = defaultSources(ctx, { port: () => srv.address().port });
    await src.tick();
    assert.deepEqual(src.sources.live().local.status, 200);
    const l = attention(await buildBoard(src.sources));
    assert.equal(l.items.find((i) => i.kind === 'live'), undefined, 'a login page that works is not an item');
    assert.deepEqual(['0.0.0.0', '::', '::ffff:192.168.1.5', '::1', '192.168.1.5', null].map(hostOf), ['127.0.0.1', '127.0.0.1', '192.168.1.5', '[::1]', '192.168.1.5', '127.0.0.1']);
    const none = defaultSources(ctx, { port: () => null });
    await none.tick();
    assert.throws(() => none.sources.live(), /port of this dashboard is not known yet/);
  } finally {
    srv.close();
  }
});

test('a dashboard that listens on one other address only (as one started with --host <a LAN address> does): that address is asked', { skip: process.platform !== 'linux' && 'only Linux answers on all of 127/8 (macOS lo0 has 127.0.0.1 alone)' }, async () => {
  const other = http.createServer((req, res) => { res.writeHead(req.url === '/login' ? 200 : 302); res.end(); });
  await new Promise((r) => other.listen(0, '127.0.0.2', r));
  try {
    const on2 = defaultSources(ctx, { port: () => other.address().port, address: () => '127.0.0.2' });
    await on2.tick();
    assert.equal(on2.sources.live().local.status, 200, 'the address it listens on is asked');
  } finally {
    other.close();
  }
});

test("a provider stop in a run record is an item within one look: the session's own, and an agent's in a session that works", async () => {
  const src = defaultSources(ctx, { port: () => null });
  const { file, run } = createRun({ profile: 'plan-a', cwd: box.home });
  // What the hook wrote (src/hook.mjs) for an agent that ended on an ambiguous model name while the session works.
  updateRun(file, { status: 'working', agentStops: [{ id: 'a6e1e6756ce2da8e7', label: 'Check the shop page', at: Date.now() - 60_000, error: 'unknown', text: "API Error: 400 Ambiguous model 'relay-large': it matches more than one model of this gateway" }] });
  cards.push({ name: 'alpha', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'plan-a' }, runId: run.runId, status: 'working', statusAt: Date.now() });
  let l = await look(src);
  let it = l.items.find((i) => i.kind === 'providerstop');
  assert.equal(it?.subject, 'session alpha');
  assert.ok(it.facts.some((f) => f.startsWith('agent "Check the shop page" stopped: the endpoint refuses this model name')), it.facts.join('|'));
  assert.ok(it.facts.includes('the session goes on, but a step of it was lost'));
  // The session's own reply ended in a lost sign-in.
  updateRun(file, { status: 'attention', agentStops: [], failure: { at: Date.now(), error: 'authentication_failed', text: 'Invalid API key · Fix external API key', own: true } });
  l = await look(src);
  it = l.items.find((i) => i.kind === 'providerstop');
  assert.ok(it.facts.some((f) => f.startsWith('the session stopped: the sign-in is gone')), it.facts.join('|'));
  assert.equal(it.acts[0].label, 'Open Providers to sign in');
  // The next prompt clears the failure: the item goes.
  updateRun(file, { status: 'working', failure: null });
  l = await look(src);
  assert.deepEqual(l.items.filter((i) => i.kind === 'providerstop'), []);
  removeRun(file);
  cards.length = 0;
});

test("a chat's provider stop, written by the hook on the chat's run record, is an item within one look, opened as a chat", async () => {
  const { createChatRun } = await import('../../src/runs.mjs');
  const src = defaultSources(ctx, { port: () => null });
  const chatId = '7f3a9c21-0000-4000-8000-000000000001';
  const { file } = createChatRun({ chat: chatId, conversation: '5e551011-0000-4000-8000-000000000001', tool: 'claude', cwd: box.home, profile: 'plan-a' });
  updateRun(file, { agentStops: [{ id: 'a1', label: 'Check the shop page', at: Date.now() - 60_000, error: 'unknown', text: "API Error: 400 Ambiguous model 'relay-large'" }] });
  cards.push({ name: `chat:${chatId}`, kind: 'chat', chatId, display: 'Fix the shop page', tool: 'claude', cwd: box.home, profile: { name: 'plan-a', label: 'Plan A' }, status: 'working', statusAt: Date.now(), running: true });
  let l = await look(src);
  const it = l.items.find((i) => i.kind === 'providerstop');
  assert.equal(it?.subject, 'chat "Fix the shop page" (7f3a9c21)');
  assert.equal(it.acts[0].href, `#/chat/${chatId}`);
  assert.ok(it.facts.includes('the session goes on, but a step of it was lost'), it.facts.join('|'));
  // The chat's own failed reply is an item too; a chat's record never makes a terminal session's item.
  updateRun(file, { agentStops: [], failure: { at: Date.now(), error: 'authentication_failed', text: 'Invalid API key · Fix external API key' } });
  l = await look(src);
  assert.deepEqual(l.items.filter((i) => i.kind === 'providerstop').map((i) => i.subject), ['chat "Fix the shop page" (7f3a9c21)']);
  removeRun(file);
  cards.length = 0;
});

test("a chat's question is on the board from the chat's own card (the hook keeps none in a chat's record)", async () => {
  const { createChatRun } = await import('../../src/runs.mjs');
  const src = defaultSources(ctx, { port: () => null });
  const chatId = '7f3a9c21-0000-4000-8000-000000000002';
  const { file } = createChatRun({ chat: chatId, conversation: '5e551011-0000-4000-8000-000000000002', tool: 'claude', cwd: box.home, profile: 'plan-a' });
  const at = Date.now() - 120_000;
  cards.push({ name: `chat:${chatId}`, kind: 'chat', chatId, display: 'Pick a database', tool: 'claude', cwd: box.home, profile: { name: 'plan-a', label: 'Plan A' }, status: 'attention', statusAt: at, running: true, ask: { request: 'r1', type: 'question', tool: 'AskUserQuestion' } });
  const it = (await look(src)).items.find((i) => i.kind === 'asks');
  assert.ok(it, 'the question is an item');
  assert.equal(it.target.session, `chat:${chatId}`);
  assert.equal(it.acts[0].href, `#/chat/${chatId}`);
  assert.equal(it.acts[0].label, 'Open the chat');
  removeRun(file);
  cards.length = 0;
});

test('a failed reply written by the earlier hook (no `own` mark: it put an agent\'s stop there too) is said as the session or an agent in it', async () => {
  const src = defaultSources(ctx, { port: () => null });
  const { file, run } = createRun({ profile: 'plan-a', cwd: box.home });
  updateRun(file, { status: 'attention', failure: { at: Date.now(), error: 'unknown', text: "API Error: 400 Ambiguous model 'relay-large'" } });
  cards.push({ name: 'alpha', kind: 'claude', tool: 'claude', cwd: box.home, profile: { name: 'plan-a' }, runId: run.runId, status: 'attention', statusAt: Date.now() });
  let it = (await look(src)).items.find((i) => i.kind === 'providerstop');
  assert.ok(it.facts.some((f) => f.startsWith('the session, or an agent in it, stopped: the endpoint refuses this model name')), it.facts.join('|'));
  // The new hook's own failure says the session.
  updateRun(file, { failure: { at: Date.now(), error: 'unknown', text: "API Error: 400 Ambiguous model 'relay-large'", own: true } });
  it = (await look(src)).items.find((i) => i.kind === 'providerstop');
  assert.ok(it.facts.some((f) => f.startsWith('the session stopped: the endpoint refuses this model name')), it.facts.join('|'));
  removeRun(file);
  cards.length = 0;
});

test('a session Hoprig ran is never "not started by Hoprig", also after its run record went and after a restart', async () => {
  const sid = '7a7a7a7a-1111-4222-8333-444444444444';
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-work-ran');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), `${JSON.stringify({ type: 'assistant', timestamp: new Date(Date.now() - 60_000).toISOString(), cwd: '/work/ran', sessionId: sid, error: 'unknown', isApiErrorMessage: true, apiErrorStatus: 400, message: { stop_reason: 'stop_sequence', content: [{ type: 'text', text: "API Error: 400 Ambiguous model 'relay-x'" }] } })}\n`);
  const outsideItems = (l) => l.items.filter((i) => /not started by Hoprig/.test(i.subject || ''));
  const src = defaultSources(ctx, { port: () => null });
  const { file } = createRun({ profile: 'plan-a', cwd: box.home });
  updateRun(file, { status: 'working', sessionId: sid });
  assert.deepEqual(outsideItems(await look(src)), [], 'its run record names it');
  // The process ended (or a chat went idle): its record is removed, its transcript stays.
  removeRun(file);
  assert.deepEqual(outsideItems(await look(src)), [], 'the record is gone, the conversation is still Hoprig\'s');
  // The dashboard started again.
  assert.deepEqual(outsideItems(await look(defaultSources(ctx, { port: () => null }))), [], 'and after a restart');
  // A conversation Hoprig never ran is still told.
  const other = '7b7b7b7b-1111-4222-8333-444444444444';
  fs.writeFileSync(path.join(dir, `${other}.jsonl`), fs.readFileSync(path.join(dir, `${sid}.jsonl`), 'utf8').replaceAll(sid, other));
  assert.deepEqual(outsideItems(await look(src)).map((i) => i.subject), ['session 7b7b7b7b in ran, not started by Hoprig']);
  fs.rmSync(dir, { recursive: true, force: true });
});
