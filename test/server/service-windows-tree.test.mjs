// Windows `service install` and `service restart` on a RUNNING dashboard: the old one's whole process tree is ended
// (its PowerShell wrapper, its `serve` and that serve's own processes below it), never a program Hoprig keeps running
// on purpose beside it, another account's process or a pid handed out again; and the command says it worked only once
// the NEW dashboard answers on its port. A made-up Windows only: every program goes through the runner handed in,
// with its own clock and sleep, and traps on PATH catch one that slipped past it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as winsvc from '../../src/server/service/windows.mjs';
import { stateKey } from '../../src/server/dashboardfile.mjs';
import { sandbox } from './helpers.mjs';

const box = sandbox('svctree');
const traps = path.join(box.root, 'traps');
const sprung = path.join(box.root, 'sprung.txt');
fs.mkdirSync(traps);
for (const name of ['whoami', 'schtasks', 'taskkill', 'reg', 'powershell.exe', 'sudo']) {
  fs.writeFileSync(path.join(traps, name), `#!/bin/sh\necho ${name} >> '${sprung}'\nexit 1\n`, { mode: 0o755 });
}
process.env.PATH = `${traps}${path.delimiter}${process.env.PATH}`;
test.after(() => box.cleanup());

const RECORD = path.join(box.state, 'dashboard.json');
const MY_SID = 'S-1-5-21-1-2-3-1001';
const OTHER_SID = 'S-1-5-21-1-2-3-1002';
const S = 1_795_000_000_000;
const NEW_PID = 9100;
const SERVE = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\hoprig\\bin\\hoprig.mjs" serve';
const script = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
const ok = { ok: true, out: '', err: '' };

/** The old dashboard as Task Scheduler left it: the wrapper, its serve, and what that serve started. */
const oldTree = () => [
  { pid: 900, ppid: 4, name: 'explorer.exe', cmd: 'C:\\Windows\\explorer.exe', start: S - 90_000, sid: MY_SID },
  { pid: 5000, ppid: 900, name: 'powershell.exe', cmd: `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ${winsvc.scriptFile()}`, start: S, sid: MY_SID },
  { pid: 5120, ppid: 5000, name: 'node.exe', cmd: SERVE, start: S + 100, sid: MY_SID },
  { pid: 5300, ppid: 5120, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" gateway.mjs', start: S + 200, sid: MY_SID }, // the gateway add-on
  { pid: 5400, ppid: 5120, name: 'claude.exe', cmd: 'claude --resume x', start: S + 300, sid: MY_SID },
  { pid: 5500, ppid: 5120, name: 'other.exe', cmd: 'other.exe', start: S + 400, sid: OTHER_SID },
  { pid: 5600, ppid: 5120, name: 'notepad.exe', cmd: 'notepad.exe', start: S - 5000, sid: MY_SID }, // a pid handed out again
];

/** A made-up Windows: its process table, who holds the dashboard's port, taskkill, schtasks and the new dashboard. */
// This command's own pid and parent, made up like the rest: never this process's real ones, which can be any number
// on a Windows runner (once its real parent was 5120, the made-up dashboard below, and every case was refused).
const SELF = { pid: 9900, ppid: 9800 };

function fakeWin({ procs = oldTree(), holder = 5120, answer = true, self = SELF } = {}) {
  const table = new Map(procs.map((p) => [p.pid, { ...p }]));
  const calls = [];
  let clock = 0;
  const run = async (c, args) => {
    // Windows' own whoami comes by its full path there (setup/winowner.mjs whoamiBin): recorded by its name.
    if (/[\\/]whoami\.exe$/i.test(c)) c = 'whoami';
    calls.push([c, ...args]);
    if (c === 'whoami') return { ok: true, out: `"box2\\alex","${MY_SID}"`, err: '' };
    if (c === 'powershell.exe') {
      const s = script(args);
      if (s.includes('Get-NetTCPConnection')) {
        const rows = [...table.values()].map(({ sid, ...p }) => p);
        return { ok: true, out: JSON.stringify({ held: table.has(holder) ? [holder] : [], procs: rows }), err: '' };
      }
      const m = /ProcessId=(\d+)'/.exec(s);
      if (m && s.includes('GetOwnerSid')) {
        const p = table.get(Number(m[1]));
        return { ok: true, out: p ? JSON.stringify({ cmd: p.cmd, sid: p.sid, start: p.start }) : '', err: '' };
      }
      if (s.includes('ParentProcessId')) return { ok: true, out: [...table.values()].map((p) => `${p.pid} ${p.ppid}`).join('\r\n'), err: '' };
      return { ok: false, out: '', err: 'unknown script' };
    }
    if (c === 'taskkill') {
      table.delete(Number(args[1]));
      return { ok: true, out: 'SUCCESS', err: '' };
    }
    if (c === 'schtasks') {
      // the task's own wrapper only (a PowerShell of a dashboard terminal is not the task's)
      if (args[0] === '/End') for (const p of [...table.values()]) if (/powershell/i.test(p.name) && p.cmd.includes(winsvc.scriptFile())) table.delete(p.pid);
      if (args[0] === '/Run' && answer) {
        fs.writeFileSync(RECORD, JSON.stringify({ pid: NEW_PID, proc: `T:${S + 60_000}`, host: '127.0.0.1', port: 7433, at: S + 60_000, key: 'n'.repeat(43), state: stateKey() }));
      }
      if (args[0] === '/Query') return { ok: true, out: 'Status: Running\r\nLast Run Time: 25/11/2026 03:00:00\r\nLast Result: 0', err: '' };
      return ok;
    }
    return ok;
  };
  const fetchImpl = async (url, opts) => {
    if (!answer || opts?.headers?.['x-hoprig-local-key'] !== 'n'.repeat(43)) throw new Error('ECONNREFUSED');
    return { ok: true, json: async () => ({ pid: NEW_PID, state: stateKey() }) };
  };
  return {
    run, calls, table, self,
    platform: 'win32', alive: (pid) => table.has(pid), waitMs: 200, step: 10,
    askHolder: async () => null, fetchImpl,
    sleep: async (ms) => { clock += ms; }, now: () => clock,
  };
}

const quiet = async (fn) => {
  const { log, error } = console;
  let said = '';
  console.log = console.error = (...m) => (said += m.join(' ') + '\n');
  try {
    return { code: await fn(), said };
  } finally {
    Object.assign(console, { log, error });
  }
};

const ended = (fw) => fw.calls.filter((c) => c[0] === 'taskkill').map((c) => Number(c[2]));
const fresh = () => {
  fs.rmSync(RECORD, { force: true });
  fs.mkdirSync(path.join(box.state, 'addons'), { recursive: true });
  fs.writeFileSync(path.join(box.state, 'addons', 'local.pid'), JSON.stringify({ pid: 5300, proc: `T:${S + 200}` }));
};

for (const sub of ['install', 'restart']) {
  test(`Windows service ${sub}: the old dashboard's tree is ended one by one, the kept gateway, another account and a reused pid are not, and it says so only when the new one answers`, async () => {
    // The record is gone (removed, or another state folder's), and the old serve still holds the port.
    fresh();
    const fw = fakeWin();
    const { code, said } = await quiet(() => winsvc.service(sub, fw));
    assert.equal(code, 0, said);
    assert.deepEqual(ended(fw), [5120], said);
    for (const c of fw.calls.filter((x) => x[0] === 'taskkill')) assert.deepEqual(c.slice(2), [c[2], '/F'], 'one pid, /F, never /T');
    assert.match(said, /Ended process 5120 \(node\.exe\) of the old dashboard/);
    for (const pid of [5300, 5400, 5500, 5600, 900]) assert.ok(fw.table.has(pid), `process ${pid} keeps running`);
    const order = fw.calls.map((c) => c.slice(0, 2).join(' '));
    assert.ok(order.lastIndexOf('taskkill /PID') < order.indexOf('schtasks /Run'), 'ended before the new one starts');
    assert.match(said, new RegExp(`It answers at http://127\\.0\\.0\\.1:7433 \\(process ${NEW_PID}\\)`));
  });

  test(`Windows service ${sub}: a holder of the port that may not be ended is named with why, and nothing starts`, async () => {
    for (const [holder, why] of [
      [5300, /Process 5300 \(node\.exe\) holds port 7433 and was not ended: Hoprig keeps it running on purpose/],
      [5500, /Process 5500 \(other\.exe\) holds port 7433 and was not ended: it runs as another account/],
      [5600, /Process 5600 \(notepad\.exe\) holds port 7433 and was not ended: it started before the old dashboard/],
      [900, /Process 900 \(explorer\.exe\) holds port 7433 and was not ended: it is not part of the old dashboard/],
    ]) {
      fresh();
      const fw = fakeWin({ holder });
      const { code, said } = await quiet(() => winsvc.service(sub, fw));
      assert.equal(code, 1, said);
      assert.match(said, why);
      assert.ok(!ended(fw).includes(holder), `${holder} is never ended`);
      for (const step of ['/Create', '/Run']) assert.ok(!fw.calls.some((c) => c[0] === 'schtasks' && c[1] === step), `${holder}: no schtasks ${step}`);
      assert.match(said, /Nothing was (installed|started)\. Close that dashboard/);
    }
  });

  test(`Windows service ${sub}: a program outside the old dashboard holds the port: nothing of the old tree is ended, the holder is named`, async () => {
    const OTHER_SCRIPT = 'C:\\Users\\alex\\other-state\\service\\dashboard-service.ps1';
    for (const [extra, holder] of [
      // the person's own program, started from the desktop
      [[{ pid: 7000, ppid: 900, name: 'node.exe', cmd: 'node devserver.js', start: S + 5000, sid: MY_SID }], 7000],
      // the dashboard of another state folder, on the port of this one's settings
      [[
        { pid: 6000, ppid: 900, name: 'powershell.exe', cmd: `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ${OTHER_SCRIPT}`, start: S + 1000, sid: MY_SID },
        { pid: 6100, ppid: 6000, name: 'node.exe', cmd: SERVE, start: S + 1100, sid: MY_SID },
      ], 6100],
    ]) {
      fresh();
      const fw = fakeWin({ procs: [...oldTree(), ...extra], holder });
      const { code, said } = await quiet(() => winsvc.service(sub, fw));
      assert.equal(code, 1, said);
      assert.deepEqual(ended(fw), [], `${holder}: nothing is ended\n${said}`);
      assert.doesNotMatch(said, /Ended process/);
      assert.match(said, new RegExp(`Process ${holder} \\(node\\.exe\\) holds port 7433 and was not ended: it is not part of the old dashboard`));
      for (const pid of [5120, 5400, holder]) assert.ok(fw.table.has(pid), `process ${pid} keeps running`);
      for (const step of ['/Create', '/Run']) assert.ok(!fw.calls.some((c) => c[0] === 'schtasks' && c[1] === step), `${holder}: no schtasks ${step}`);
    }
  });

  test(`Windows service ${sub}: only the old serve that holds the port is ended; its terminals, their programs, a coding tool and the go-live helper keep running`, async () => {
    fresh();
    const procs = [
      ...oldTree(),
      { pid: 5450, ppid: 5120, name: 'powershell.exe', cmd: 'powershell.exe -NoLogo', start: S + 500, sid: MY_SID }, // a dashboard terminal
      { pid: 5460, ppid: 5450, name: 'node.exe', cmd: 'node server.js', start: S + 600, sid: MY_SID }, // the person's dev server in it
      { pid: 5470, ppid: 5120, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\hoprig\\src\\ship\\helper.mjs" C:\\shop\\.git', start: S + 700, sid: MY_SID }, // the go-live helper
    ];
    const fw = fakeWin({ procs });
    const { code, said } = await quiet(() => winsvc.service(sub, fw));
    assert.equal(code, 0, said);
    assert.deepEqual(ended(fw), [5120], said);
    for (const pid of [5400, 5450, 5460, 5470]) {
      assert.ok(fw.table.has(pid), `process ${pid} keeps running`);
      assert.doesNotMatch(said, new RegExp(`Ended process ${pid}\\b`));
    }
    assert.match(said, new RegExp(`It answers at http://127\\.0\\.0\\.1:7433 \\(process ${NEW_PID}\\)`));
  });

  test(`Windows service ${sub}: typed in a terminal of the old dashboard (no record): refused before anything is ended`, async () => {
    fresh(); // no dashboard.json: the refusal from the record cannot see it
    const procs = [
      ...oldTree(),
      { pid: 5450, ppid: 5120, name: 'powershell.exe', cmd: 'powershell.exe -NoLogo', start: S + 500, sid: MY_SID }, // a dashboard terminal
      { pid: 5460, ppid: 5450, name: 'node.exe', cmd: 'node server.js', start: S + 600, sid: MY_SID },
      { pid: 5470, ppid: 5120, name: 'node.exe', cmd: '"C:\\Program Files\\nodejs\\node.exe" helper.mjs x', start: S + 700, sid: MY_SID },
      { pid: 5480, ppid: 5450, name: 'node.exe', cmd: SERVE.replace(/serve$/, `service ${sub}`), start: S + 800, sid: MY_SID }, // this command
    ];
    const fw = fakeWin({ procs, self: { pid: 5480, ppid: 5450 } });
    const { code, said } = await quiet(() => winsvc.service(sub, fw));
    assert.equal(code, 1, said);
    assert.deepEqual(ended(fw), [], `nothing is ended\n${said}`);
    assert.match(said, /This runs in a terminal of the dashboard it would end \(process 5120\)[^]*Nothing was changed/);
    for (const step of ['/End', '/Create', '/Run']) assert.ok(!fw.calls.some((c) => c[0] === 'schtasks' && c[1] === step), `no schtasks ${step}`);
    for (const pid of [5000, 5120, 5400, 5450, 5460, 5470]) assert.ok(fw.table.has(pid), `process ${pid} keeps running`);
  });

  test(`Windows service ${sub}: the new dashboard never answers: exit 1, with the last lines of its log and the status`, async () => {
    fresh();
    fs.writeFileSync(winsvc.logFile(), 'listening\r\nError: listen EADDRINUSE: address already in use 127.0.0.1:7433\r\n');
    const fw = fakeWin({ answer: false });
    const { code, said } = await quiet(() => winsvc.service(sub, fw));
    assert.equal(code, 1, said);
    assert.match(said, /did not answer within 30 seconds/);
    assert.match(said, /EADDRINUSE: address already in use 127\.0\.0\.1:7433/);
    assert.match(said, /service status:\nhoprig: Running/);
    assert.doesNotMatch(said, /It answers at/);
    assert.ok(fw.calls.some((c) => c[0] === 'schtasks' && c[1] === '/Run'), 'it was started');
  });
}

test('this command\'s own parent decides only through the pid it is given: a parent that is the made-up dashboard refuses, another does not', async () => {
  fresh();
  const inside = fakeWin({ self: { pid: 9900, ppid: 5120 } });
  const r = await quiet(() => winsvc.service('install', inside));
  assert.equal(r.code, 1, r.said);
  assert.match(r.said, /This runs in a terminal of the dashboard it would end \(process 5120\)/);
  assert.deepEqual(ended(inside), []);
  fresh();
  const outside = fakeWin({ self: { pid: 9900, ppid: 9800 } });
  const o = await quiet(() => winsvc.service('install', outside));
  assert.equal(o.code, 0, o.said);
  assert.deepEqual(ended(outside), [5120]);
});

test('an empty, partial or wrong-typed self is not taken: this process and its parents in the table still guard', async () => {
  // This process sits below the made-up dashboard in the table; only the system's own pid finds it there.
  const procs = [...oldTree(), { pid: process.pid, ppid: 5120, name: 'node.exe', cmd: SERVE.replace(/serve$/, 'service install'), start: S + 800, sid: MY_SID }];
  for (const self of [{}, null, { pid: 9900 }, { ppid: 9800 }, { pid: '9900', ppid: 9800 }]) {
    fresh();
    const fw = fakeWin({ procs, self });
    const { code, said } = await quiet(() => winsvc.service('install', fw));
    assert.equal(code, 1, `${JSON.stringify(self)}: ${said}`);
    assert.match(said, /This runs in a terminal of the dashboard it would end \(process 5120\)/);
    assert.deepEqual(ended(fw), [], `${JSON.stringify(self)}: nothing is ended`);
  }
});

test('no real system program was started', () => {
  assert.equal(fs.existsSync(sprung) ? fs.readFileSync(sprung, 'utf8') : '', '');
});
