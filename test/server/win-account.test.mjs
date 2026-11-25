// Windows: whose process is "mine" on the PC tab, and which one may be ended, is decided by the account the system
// names (whoami /user and each process's GetOwnerSid), never by USERDOMAIN and USERNAME. In an SSH session to a local
// account USERDOMAIN says WORKGROUP while Windows names the owner "PC\me". Made-up Windows answers only: every
// program goes through the runner handed in, and traps on PATH catch one that slipped past it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as win from '../../src/server/platform/win32.mjs';
import { sandbox } from './helpers.mjs';

const box = sandbox('winacct');
const traps = path.join(box.root, 'traps');
const sprung = path.join(box.root, 'sprung.txt');
fs.mkdirSync(traps);
for (const name of ['whoami', 'taskkill', 'powershell.exe', 'sudo']) {
  fs.writeFileSync(path.join(traps, name), `#!/bin/sh\necho ${name} >> '${sprung}'\nexit 1\n`, { mode: 0o755 });
}
process.env.PATH = `${traps}${path.delimiter}${process.env.PATH}`;
test.after(() => box.cleanup());

const MY_SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const OTHER_SID = 'S-1-5-21-1004336348-1177238915-682003330-1002';
const MINE = 5120;
const THEIRS = 6200;
const script = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

/** An SSH session to the local account "pc\alex": what the environment says, and what Windows answers. */
function sshWindows() {
  const calls = [];
  const owners = { [MINE]: MY_SID, [THEIRS]: OTHER_SID };
  const runSync = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'whoami') return '"pc\\alex","' + MY_SID + '"\r\n';
    if (cmd === 'powershell.exe') {
      const m = /ProcessId=(\d+)'/.exec(script(args));
      return m && owners[m[1]] ? `${owners[m[1]]}\r\n` : '';
    }
    if (cmd === 'taskkill') return 'SUCCESS\r\n';
    return null;
  };
  return { runSync, calls };
}

const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};

const SSH = { USERDOMAIN: 'WORKGROUP', USERNAME: 'alex' };

test('Windows over SSH (USERDOMAIN=WORKGROUP): the person may end their own process, never another account\'s', () =>
  withEnv(SSH, () => {
    const w = sshWindows();
    assert.deepEqual(win.killOwn(MINE, 'SIGKILL', { runSync: w.runSync }), { ok: true });
    assert.ok(w.calls.some((c) => c[0] === 'taskkill' && c[2] === String(MINE)), 'their own process is ended');
    assert.match(script(w.calls.find((c) => c[0] === 'powershell.exe')), /GetOwnerSid/, 'the owner is asked as a SID');

    const v = sshWindows();
    assert.deepEqual(win.killOwn(THEIRS, 'SIGKILL', { runSync: v.runSync }), { ok: false, error: 'not your process' });
    assert.ok(!v.calls.some((c) => c[0] === 'taskkill'), 'another account\'s process is never ended');
    assert.deepEqual(win.killOwn(7777, 'SIGKILL', { runSync: v.runSync }), { ok: false, error: 'no such process' });
  }));

test('Windows over SSH: the PC tab calls the person\'s own processes "mine", by SID', () =>
  withEnv(SSH, async () => {
    const json = JSON.stringify({
      mem: { totalKB: 1000, freeKB: 500 },
      pagefiles: [],
      disks: [],
      procs: [
        { pid: MINE, ppid: 1, name: 'node.exe', args: 'node x', rss: 2000, age: 10, cpu: 5 },
        { pid: THEIRS, ppid: 1, name: 'other.exe', args: 'other', rss: 1000, age: 10, cpu: 3 },
      ],
      owners: { [MINE]: MY_SID, [THEIRS]: OTHER_SID },
      ports: [],
    });
    const w = sshWindows();
    const run = async (cmd, args) => {
      w.calls.push([cmd, ...args]);
      return cmd === 'powershell.exe' ? { ok: true, stdout: json, stderr: '' } : { ok: false, stdout: '', stderr: 'no' };
    };
    const s = await win.snapshot({ run, runSync: w.runSync });
    assert.deepEqual(s.errors, []);
    assert.deepEqual(s.topCpu.map((p) => [p.pid, p.mine]), [[MINE, true], [THEIRS, false]]);
    assert.match(win.SNAPSHOT_SCRIPT, /GetOwnerSid/);
    assert.doesNotMatch(win.SNAPSHOT_SCRIPT, /MethodName GetOwner\s/);
  }));

test('the account is asked of the system once and kept', () => {
  const w = sshWindows();
  assert.equal(win.mySid(w.runSync), MY_SID);
  assert.equal(win.mySid(w.runSync), MY_SID);
  assert.equal(w.calls.filter((c) => c[0] === 'whoami').length, 1);
  assert.deepEqual(w.calls[0], ['whoami', '/user', '/fo', 'csv', '/nh']);
  // No answer: nothing is "mine" and nothing may be ended (and it is asked again next time).
  let n = 0;
  const silent = (cmd) => (cmd === 'whoami' ? (n++, null) : `${MY_SID}\r\n`);
  assert.equal(win.mySid(silent), null);
  assert.deepEqual(win.killOwn(MINE, 'SIGKILL', { runSync: silent }), { ok: false, error: 'not your process' });
  assert.equal(n, 2);
});

test('no real system program was started', () => {
  assert.equal(fs.existsSync(sprung) ? fs.readFileSync(sprung, 'utf8') : '', '');
});
