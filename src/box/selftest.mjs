// The self-test: the trials in small, run inside the real box (the same plan and arguments a command gets, through the
// same inner runner) before box.mjs says yes. One failing trial is a no with that trial named. It never reads a file
// of the real home: inside the box it lists what is left of the real homes there, and it reads only made-up files it
// wrote in its own temporary folder. Its listeners are its own, on a free port the system gives.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { meansCall } from './call.mjs';
import { runtimeOf, startFailure } from './linux.mjs';

const TRIAL_MS = 20_000;
const TRIAL_OUT = 64 << 10;
/** What a person does when a trial fails: there is no fix to apply, so the step is to look again and report it. */
const TRIAL_STEP = 'run hoprig box check again; if it says the same, report it with this line';

/** The trials, in the order a failure is named. */
export const TRIALS = {
  home: 'a made-up file in a home cannot be read',
  homes: 'the real homes are not there',
  outside: 'a made-up file outside the named folders can be neither read nor written',
  listener: 'a listener this test opened cannot be reached',
  process: 'a process outside cannot be seen',
  write: 'the write folder can be written',
};

// Runs inside the box. Its one argument is the trials' settings as JSON; it prints one line: TRIALS {trial: 'ok' | why}.
// The mark of the process outside comes in two halves, so this process's own command line never holds it whole.
const INSIDE = `
const fs = require('fs'), net = require('net');
const c = JSON.parse(process.argv[1]);
const mark = c.markA + c.markB;
const r = {};
const reads = (p) => { try { fs.readFileSync(p); return true; } catch { return false; } };
r.home = reads(c.homeSecret) ? 'its file was read' : 'ok';
let extra = 0;
const walk = (dir) => {
  let names; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    const p = dir + '/' + n;
    if (c.named.includes(p)) continue;
    if (c.named.some((d) => d.startsWith(p + '/'))) walk(p); else extra++;
  }
};
for (const h of c.homes) walk(h);
r.homes = extra ? extra + ' name(s) of a real home are there' : 'ok';
let wrote = false; try { fs.writeFileSync(c.outsideDir + '/written', 'x'); wrote = true; } catch {}
r.outside = reads(c.outsideSecret) ? 'its file was read' : wrote ? 'its folder was written' : 'ok';
let seen = false; try { process.kill(c.pid, 0); seen = true; } catch {}
let procs = []; try { procs = fs.readdirSync('/proc'); } catch {}
for (const p of procs) { if (!/^\\d+$/.test(p)) continue;
  try { if (fs.readFileSync('/proc/' + p + '/cmdline', 'utf8').includes(mark)) seen = true; } catch {} }
r.process = seen ? 'it was seen' : 'ok';
try { fs.writeFileSync(c.work + '/made', c.token); r.write = 'ok'; } catch (e) { r.write = e.code || 'it failed'; }
const reach = (t) => new Promise((res) => { const s = net.connect(t); let g = '';
  s.setTimeout(3000, () => (s.destroy(), res(false))); s.on('data', (d) => (g += d)); s.on('end', () => res(g === 'reached')); s.on('error', () => res(false)); });
(async () => {
  r.listener = 'ok';
  for (const t of c.listeners) if (await reach(t)) r.listener = 'it was reached on ' + t.host;
  console.log('TRIALS ' + JSON.stringify(r));
})();
`;

/** A listener of the self-test's own that answers "reached", on `host` and a free port. */
async function ownListener(host) {
  const s = net.createServer((c) => c.end('reached'));
  await new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, host, resolve);
  });
  return s;
}

/** Whether `t` answers from here: a trial of a listener means something only when it answers outside. */
function answers(t) {
  return new Promise((resolve) => {
    const c = net.connect(t);
    let got = '';
    c.setTimeout(2000, () => (c.destroy(), resolve(false)));
    c.on('data', (d) => (got += d));
    c.on('end', () => resolve(got === 'reached'));
    c.on('error', () => resolve(false));
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs the trials with `run` (the inner runner), the means `file`, `plan` (box.mjs's planRun) and the real homes.
 * → { ok, why, trials }
 */
export async function selfTest({ kind, file, run, plan, homes }) {
  if (kind !== 'bwrap' && kind !== 'sandbox-exec') return { ok: false, why: `no self-test for ${kind}` };
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hoprig-box-test-')));
  const servers = [];
  let other = null;
  try {
    const work = path.join(base, 'work');
    const home = path.join(base, 'home');
    const outsideDir = path.join(base, 'outside');
    for (const d of [work, home, outsideDir]) fs.mkdirSync(d);
    const homeSecret = path.join(home, '.made-up-secret');
    const outsideSecret = path.join(outsideDir, 'made-up-secret.txt');
    fs.writeFileSync(homeSecret, 'made-up');
    fs.writeFileSync(outsideSecret, 'made-up');

    const listeners = [];
    const own = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    for (const host of ['127.0.0.1', own].filter(Boolean)) {
      const s = await ownListener(host);
      servers.push(s);
      const t = { host, port: s.address().port };
      if (await answers(t)) listeners.push(t);
      else if (host === '127.0.0.1') return { ok: false, why: `trial "${TRIALS.listener}": its listener does not answer even outside` };
    }

    const [markA, markB] = [`hoprig-box-trial-${process.pid}-`, `${Date.now()}`];
    other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', markA + markB], { stdio: 'ignore', env: {} });
    for (let i = 0; i < 40; i++) {
      try {
        if (fs.readFileSync(`/proc/${other.pid}/cmdline`, 'utf8').includes(markA + markB)) break;
      } catch {
        /* not started yet */
      }
      await pause(50);
    }

    const node = fs.realpathSync(process.execPath);
    const token = `made-${Math.random().toString(36).slice(2)}`;
    const settings = { homeSecret, homes, named: [work, runtimeOf(node)], outsideDir, outsideSecret, listeners, pid: other.pid, markA, markB, work, token };
    const p = plan([node, '-e', INSIDE, JSON.stringify(settings)], { cwd: work, write: [work], timeoutMs: TRIAL_MS, maxOut: TRIAL_OUT });
    if (p.why) return { ok: false, why: `the self-test could not be made: ${p.why}` };
    const call = meansCall(kind, p);
    if (call.why) return { ok: false, why: `the self-test could not be made: ${call.why}` };
    let r;
    try {
      r = await run(file, call.args, { timeoutMs: TRIAL_MS, maxOut: TRIAL_OUT, data: call.data, statusFd: call.statusFd, env: call.env, cwd: call.cwd });
    } finally {
      call.cleanup();
    }
    if (!r.started) {
      const f = startFailure(r.failure || r.out);
      return { ok: false, why: `the box does not start: ${f.why}`, step: f.step };
    }
    const line = /^TRIALS (\{.*\})$/m.exec(r.out || '');
    if (r.code !== 0 || !line) return { ok: false, why: `trial "a command runs" failed: the box ended with ${r.code} and no answer`, step: TRIAL_STEP };
    let trials;
    try {
      trials = JSON.parse(line[1]);
    } catch {
      return { ok: false, why: 'trial "a command runs" failed: no answer', step: TRIAL_STEP };
    }
    // What the box says is checked from outside where it can be: the write reached the real folder, nothing outside.
    if (trials.write === 'ok') {
      let got = '';
      try {
        got = fs.readFileSync(path.join(work, 'made'), 'utf8');
      } catch {
        /* not written */
      }
      if (got !== token) trials.write = 'the file did not reach the folder';
    }
    if (fs.existsSync(path.join(outsideDir, 'written'))) trials.outside = 'its folder was written';
    for (const [name, words] of Object.entries(TRIALS)) {
      if (trials[name] !== 'ok') return { ok: false, why: `trial "${words}" failed: ${trials[name] ?? 'no answer'}`, step: TRIAL_STEP, trials };
    }
    return { ok: true, why: '', trials };
  } finally {
    other?.kill('SIGKILL');
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    fs.rmSync(base, { recursive: true, force: true });
  }
}
