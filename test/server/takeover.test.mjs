// A newer start ends the older dashboard of the same state folder by its own process id, and only when it is shown to
// be that very program (takeover.mjs); anything else on the port is never ended. With made-up Windows answers (the
// process table, the owner, taskkill), and with two real dashboards on Linux.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import * as T from '../../src/server/takeover.mjs';
import * as winsvc from '../../src/server/service/windows.mjs';
import { stateKey } from '../../src/server/dashboardfile.mjs';
import { sandbox } from './helpers.mjs';

const box = sandbox('takeover');
const traps = path.join(box.root, 'traps');
const sprung = path.join(box.root, 'sprung.txt');
fs.mkdirSync(traps);
for (const name of ['whoami', 'schtasks', 'taskkill', 'reg', 'powershell.exe', 'systemctl', 'loginctl', 'launchctl', 'sudo']) {
  fs.writeFileSync(path.join(traps, name), `#!/bin/sh\necho ${name} >> '${sprung}'\nexit 1\n`, { mode: 0o755 });
}
// The dashboard asks Claude Code whether it is signed in a few seconds after it starts: a stand-in answers "no".
fs.writeFileSync(path.join(traps, 'claude'), '#!/bin/sh\necho \'{"loggedIn":false}\'\nexit 1\n', { mode: 0o755 });
process.env.PATH = `${traps}${path.delimiter}${process.env.PATH}`;
test.after(() => box.cleanup());

const BIN = path.resolve(import.meta.dirname, '../../bin/hoprig.mjs');
const RECORD = path.join(box.state, 'dashboard.json');
const OLD_PID = 5120;
const OLD_START = 1_795_000_000_000;
const WIN_SERVE = '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\hoprig\\bin\\hoprig.mjs" serve';

/** A made-up Windows with one process table entry; records every program asked for. */
const MY_SID = 'S-1-5-21-1-2-3-1001';
const script = (args) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
// `table`: the process table as [pid, parent pid] pairs (null: PowerShell cannot list it).
function fakeWindows({ cmd = WIN_SERVE, sid = MY_SID, start = OLD_START, endable = true, me = '"box2\\alex","S-1-5-21-1-2-3-1001"', table = null } = {}) {
  const calls = [];
  let running = true;
  const run = async (c, args) => {
    calls.push([c, ...args]);
    if (c === 'whoami') return { ok: true, out: me, err: '' };
    if (c === 'powershell.exe' && script(args).includes('ParentProcessId')) return table ? { ok: true, out: table.map(([p, q]) => `${p} ${q}`).join('\r\n'), err: '' } : { ok: false, out: '', err: 'no' };
    if (c === 'powershell.exe') return running ? { ok: true, out: JSON.stringify({ cmd, sid, start }), err: '' } : { ok: true, out: '', err: '' };
    if (c === 'taskkill') {
      if (endable) running = false;
      return { ok: endable, out: '', err: endable ? '' : 'Access is denied.' };
    }
    return { ok: true, out: '', err: '' };
  };
  return { run, calls, alive: (pid) => pid === OLD_PID && running, platform: 'win32', waitMs: 400, step: 20 };
}

const writeRecord = (rec) => fs.writeFileSync(RECORD, JSON.stringify(rec));
// A record as this version writes it: with its key and its state folder (an old-format record has neither).
const recordOf = (o = {}) => ({ pid: OLD_PID, proc: `T:${OLD_START + 800}`, host: '127.0.0.1', port: 8270, at: OLD_START, key: 'k'.repeat(43), state: stateKey(), ...o });

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

test('a Hoprig dashboard by its command line: also a relative bin, and npm\'s link without .mjs (hoprig, hop)', () => {
  for (const cmd of ['"C:\\Program Files\\nodejs\\node.exe" bin\\hoprig.mjs serve', 'node bin/hoprig.mjs serve --port 7433', 'node /usr/local/bin/hoprig serve', 'node /home/alex/.npm-global/bin/hop serve', '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\alex\\AppData\\Roaming\\npm\\node_modules\\hoprig\\bin\\hoprig.mjs" serve']) {
    assert.equal(T.isHoprigServe(cmd), true, cmd);
  }
  for (const cmd of ['node /usr/local/bin/hoprig chat', 'node /usr/local/bin/hoprigx serve', 'node /opt/x/sbin/hoprig serve', 'node mybin/hoprig.mjs serve', 'node /usr/local/bin/hopper serve']) assert.equal(T.isHoprigServe(cmd), false, cmd);
});

test('a Hoprig dashboard by its command line: the bin, then "serve"', () => {
  assert.equal(T.isHoprigServe(WIN_SERVE), true);
  assert.equal(T.isHoprigServe('/usr/bin/node /opt/hoprig/bin/hoprig.mjs serve --port 7433'), true);
  assert.equal(T.isHoprigServe('/usr/bin/node /opt/hoprig/bin/hoprig.mjs chat'), false);
  assert.equal(T.isHoprigServe('node other/bin/server.mjs serve'), false);
  assert.equal(T.isHoprigServe('node /opt/x/bin/hoprig.mjs.bak serve'), false);
  assert.equal(T.isHoprigServe(''), false);
  assert.throws(() => T.facts32Script('1; Stop-Computer'), /bad pid/);
});

test('Windows: the recorded dashboard may be ended only when start, program and owner all say it is', async () => {
  const yes = await T.judgeRecord(recordOf(), fakeWindows());
  assert.deepEqual(yes, { ok: true, pid: OLD_PID, port: 8270 });
  const no = async (fw, rec = recordOf()) => (await T.judgeRecord(rec, fw)).why;
  assert.match(await no(fakeWindows({ start: OLD_START + 3_600_000 })), /another program now/, 'a pid handed out again');
  // The same start with a command line Hoprig does not know: it cannot be told. Never ended, never taken for gone.
  const svchost = '"C:\\Windows\\System32\\svchost.exe" -k netsvcs';
  const told = await T.judgeRecord(recordOf(), fakeWindows({ cmd: svchost }));
  assert.equal(told.ok, false);
  assert.notEqual(told.gone, true, 'the same start: it may be the recorded dashboard');
  assert.match(told.why, /its command line is not one Hoprig knows, so it cannot be told/);
  // Its start cannot be compared, and its command line is plainly not Hoprig's: gone.
  assert.match(await no(fakeWindows({ cmd: svchost }), recordOf({ proc: undefined })), /not a Hoprig dashboard/);
  assert.match(await no(fakeWindows({ sid: 'S-1-5-21-1-2-3-1002' })), /another user/);
  assert.match(await no(fakeWindows({ sid: null })), /another user/, 'an owner the system did not give: never ended');
  // The same account whose name whoami gives in another form (another case, a garbled non-ASCII letter): the SID decides.
  const garbled = fakeWindows({ me: '"BOX2\\Jos\uFFFD","S-1-5-21-1-2-3-1001"' });
  assert.equal((await T.judgeRecord(recordOf(), garbled)).ok, true, 'the SID matches, whatever the name says');
  assert.match(T.facts32Script(5120), /GetOwnerSid/);
  assert.match(await no(fakeWindows(), recordOf({ proc: undefined })), /not shown to be the recorded one/, 'no identity in the record: never ended');
  for (const pid of [0, 4, process.pid]) assert.match(await no(fakeWindows(), recordOf({ pid })), /not one that may be ended/);
  // Its parent (the window this command runs in) with the recorded start: never ended.
  const parent = { ...fakeWindows(), alive: (pid) => pid === process.ppid };
  assert.match(await no(parent, recordOf({ pid: process.ppid })), /not one that may be ended \(this command runs in it\)/);
});

test('Windows service install: the old `node … serve` is ended by its id alone (taskkill /F, never /T) before the task starts again', async () => {
  writeRecord(recordOf());
  const fw = fakeWindows();
  const { code, said } = await quiet(() => winsvc.service('install', fw));
  assert.equal(code, 0, said);
  const names = fw.calls.map((c) => c.slice(0, 2).join(' '));
  const kill = fw.calls.findIndex((c) => c[0] === 'taskkill');
  // That pid alone: /T would also end the gateway and the other helpers it started detached (they keep its pid as
  // their parent's), which outlive the dashboard everywhere else.
  assert.deepEqual(fw.calls[kill], ['taskkill', '/PID', String(OLD_PID), '/F']);
  assert.ok(!fw.calls.some((c) => c[0] === 'taskkill' && c.includes('/T')), 'never the whole tree');
  assert.ok(kill < names.indexOf('schtasks /Run'), 'ended before the new one starts');
  assert.match(said, new RegExp(`process ${OLD_PID}\\) was ended`));
});

test('Windows service restart: ends the old one the same way; a stranger under the recorded id is never ended, and the task starts', async () => {
  writeRecord(recordOf());
  let fw = fakeWindows();
  let r = await quiet(() => winsvc.service('restart', fw));
  assert.equal(r.code, 0, r.said);
  assert.ok(fw.calls.some((c) => c[0] === 'taskkill' && c[2] === String(OLD_PID)));
  assert.ok(fw.calls.findIndex((c) => c[0] === 'taskkill') < fw.calls.findIndex((c) => c[1] === '/Run'));

  // The recorded id is another program now (a record left behind, its pid handed out again): never ended, and the
  // task starts, since the recorded dashboard is gone.
  for (const other of [{ cmd: '"C:\\Program Files\\Other\\other.exe" --serve' }, { cmd: 'C:\\Windows\\notepad.exe', start: 5_000_000 }]) {
    writeRecord(recordOf({ proc: 'T:1000' }));
    fw = fakeWindows(other);
    r = await quiet(() => winsvc.service('restart', fw));
    assert.equal(r.code, 0, r.said);
    assert.ok(!fw.calls.some((c) => c[0] === 'taskkill'), 'nothing ended');
    assert.ok(fw.calls.some((c) => c[0] === 'schtasks' && c[1] === '/Run'), 'the task starts');
    assert.doesNotMatch(r.said, /was ended|not ended/);
  }
  writeRecord(recordOf({ proc: 'T:1000' }));
  fw = fakeWindows({ cmd: 'C:\\Windows\\notepad.exe', start: 5_000_000 });
  r = await quiet(() => winsvc.service('install', fw));
  assert.equal(r.code, 0, r.said);
  assert.ok(!fw.calls.some((c) => c[0] === 'taskkill') && fw.calls.some((c) => c[1] === '/Run'), 'install too');
  const stale = await T.judgeRecord(recordOf({ proc: 'T:1000' }), fakeWindows({ cmd: 'C:\\Windows\\notepad.exe', start: 5_000_000 }));
  assert.equal(stale.gone, true);

  writeRecord(recordOf());
  fw = fakeWindows({ endable: false });
  r = await quiet(() => winsvc.service('restart', fw));
  assert.equal(r.code, 1);
  assert.match(r.said, /did not end/);
});

test('Windows service install and uninstall: an old dashboard that cannot be ended stops them with exit 1, nothing made or started', async () => {
  for (const sub of ['install', 'uninstall']) {
    writeRecord(recordOf());
    const fw = fakeWindows({ endable: false });
    const r = await quiet(() => winsvc.service(sub, fw));
    assert.equal(r.code, 1, `${sub}: ${r.said}`);
    assert.match(r.said, /not ended: process 5120 did not end/);
    assert.match(r.said, /Close that dashboard \(or restart the computer\), then run this again/);
    for (const step of ['/Create', '/Run', '/Delete']) assert.ok(!fw.calls.some((c) => c[0] === 'schtasks' && c[1] === step), `${sub}: no schtasks ${step}`);
    assert.doesNotMatch(r.said, /Scheduled task "hoprig" (installed|removed)/);
  }
});

test('Windows: a recorded dashboard whose command line the system hides (run as administrator) is never taken for gone', async () => {
  // Win32_Process gives no CommandLine for a process of a higher level than the caller; taskkill would be refused too.
  const hidden = { cmd: null, endable: false };
  const j = await T.judgeRecord(recordOf(), fakeWindows(hidden));
  assert.equal(j.ok, false);
  assert.notEqual(j.gone, true, 'the same start: it may be the recorded dashboard');
  assert.match(j.why, /started when the recorded dashboard did, but its command line cannot be read/);
  for (const sub of ['install', 'restart', 'uninstall']) {
    writeRecord(recordOf());
    const fw = fakeWindows(hidden);
    const r = await quiet(() => winsvc.service(sub, fw));
    assert.equal(r.code, 1, `${sub}: ${r.said}`);
    assert.match(r.said, /was not ended: process 5120 started when the recorded dashboard did/);
    for (const step of ['/Create', '/Run', '/Delete']) assert.ok(!fw.calls.some((c) => c[0] === 'schtasks' && c[1] === step), `${sub}: no schtasks ${step}`);
    assert.ok(!fw.calls.some((c) => c[0] === 'taskkill'), `${sub}: nothing ended`);
  }
  // Another start: the pid was handed out again, and the record is left behind as before.
  assert.equal((await T.judgeRecord(recordOf({ proc: 'T:1000' }), fakeWindows(hidden))).gone, true);
});

test('Windows: typed in a terminal of the dashboard itself, install, restart and uninstall change nothing and say where to run them', async () => {
  // dashboard (5120) → powershell.exe (6000) → this command (process.pid): the dashboard is its grandparent.
  const table = [[OLD_PID, 900], [6000, OLD_PID], [process.pid, 6000], [900, 4]];
  for (const sub of ['install', 'restart', 'uninstall']) {
    writeRecord(recordOf());
    const fw = fakeWindows({ table });
    const r = await quiet(() => winsvc.service(sub, fw));
    assert.equal(r.code, 1, `${sub}: ${r.said}`);
    assert.match(r.said, /terminal of the dashboard it would end \(process 5120\).*Nothing was changed.*PowerShell from the Start menu/s);
    assert.ok(!fw.calls.some((c) => c[0] === 'taskkill' || c[0] === 'schtasks'), `${sub}: nothing ended, the task untouched`);
  }
  // From a window of its own (the dashboard is not above it), restart goes on as before.
  writeRecord(recordOf());
  const fw = fakeWindows({ table: [[OLD_PID, 900], [process.pid, 7000], [7000, 900]] });
  const r = await quiet(() => winsvc.service('restart', fw));
  assert.equal(r.code, 0, r.said);
  assert.ok(fw.calls.some((c) => c[0] === 'taskkill') && fw.calls.some((c) => c[1] === '/Run'));
  // When the table cannot be read, a built-in terminal of a dashboard is told by its own variable.
  assert.equal(await T.insideOf(OLD_PID, { ...fakeWindows(), env: { HOPRIG_TERM_ID: 'pty-1' } }), true);
  assert.equal(await T.insideOf(OLD_PID, { ...fakeWindows(), env: {} }), false);
  assert.deepEqual(await T.parentChain(process.pid, fakeWindows({ table })), [6000, OLD_PID, 900, 4]);
});

test('Windows: a record left behind whose pid is now a program above this window (explorer.exe) does not block the service', async () => {
  // The dashboard was ended hard; Windows gave 5120 to explorer.exe, and the PowerShell opened from the Start menu
  // runs under it: explorer (5120) → powershell.exe (6000) → this command.
  const table = [[OLD_PID, 900], [6000, OLD_PID], [process.pid, 6000], [900, 4]];
  const explorer = { cmd: 'C:\\Windows\\explorer.exe', start: 5_000_000, table };
  for (const sub of ['restart', 'install']) {
    writeRecord(recordOf({ proc: 'T:1000' }));
    const fw = fakeWindows(explorer);
    const r = await quiet(() => winsvc.service(sub, fw));
    assert.equal(r.code, 0, `${sub}: ${r.said}`);
    assert.doesNotMatch(r.said, /terminal of the dashboard/);
    assert.ok(fw.calls.some((c) => c[0] === 'schtasks' && c[1] === '/Run'), `${sub}: the task starts`);
    assert.ok(!fw.calls.some((c) => c[0] === 'taskkill'), `${sub}: explorer is never ended`);
  }
  // A record of another state folder names a dashboard a start leaves running: being inside it is no reason to stop.
  writeRecord(recordOf({ state: 'another-state-folder' }));
  const fw = fakeWindows({ table });
  const r = await quiet(() => winsvc.service('restart', fw));
  assert.equal(r.code, 0, r.said);
  assert.doesNotMatch(r.said, /terminal of the dashboard/);
  assert.ok(!fw.calls.some((c) => c[0] === 'taskkill') && fw.calls.some((c) => c[1] === '/Run'));
});

test('Windows: the reused pid is this command\'s own parent now (its PowerShell, or npm\'s cmd.exe): gone, and the service goes on', async () => {
  // A record left behind with another start; the pid is now the window this command runs in.
  const table = [[process.ppid, 900], [process.pid, process.ppid], [900, 4]];
  for (const sub of ['restart', 'install']) {
    writeRecord(recordOf({ pid: process.ppid, proc: 'T:1000' }));
    const fw = { ...fakeWindows({ cmd: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', start: 5_000_000, table }), alive: (pid) => pid === process.ppid };
    const r = await quiet(() => winsvc.service(sub, fw));
    assert.equal(r.code, 0, `${sub}: ${r.said}`);
    assert.doesNotMatch(r.said, /terminal of the dashboard/);
    assert.ok(fw.calls.some((c) => c[0] === 'schtasks' && c[1] === '/Run'), `${sub}: the task starts`);
    assert.ok(!fw.calls.some((c) => c[0] === 'taskkill'), `${sub}: its own window is never ended`);
  }
});

test('Windows: the recorded start with a command line Hoprig does not know, or one that cannot be read: never ended, never a second serve', async () => {
  for (const [cmd, rec, said] of [
    ['"C:\\Program Files\\nodejs\\node.exe" tools\\run.mjs', recordOf(), /not one Hoprig knows, so it cannot be told/],
    [null, recordOf({ proc: undefined }), /cannot be told whether process 5120 is the recorded dashboard: its command line cannot be read/],
  ]) {
    const j = await T.judgeRecord(rec, fakeWindows({ cmd }));
    assert.equal(j.ok, false);
    assert.notEqual(j.gone, true, String(cmd));
    assert.match(j.why, said);
    writeRecord(rec);
    const fw = fakeWindows({ cmd });
    const r = await quiet(() => winsvc.service('install', fw));
    assert.equal(r.code, 1, r.said);
    for (const step of ['/Create', '/Run']) assert.ok(!fw.calls.some((c) => c[0] === 'schtasks' && c[1] === step), `no schtasks ${step}`);
    assert.ok(!fw.calls.some((c) => c[0] === 'taskkill'), 'nothing ended');
  }
  // A source checkout started with a relative bin is recognised: it is ended as the recorded dashboard.
  writeRecord(recordOf());
  const fw = fakeWindows({ cmd: '"C:\\Program Files\\nodejs\\node.exe" bin\\hoprig.mjs serve' });
  const r = await quiet(() => winsvc.service('install', fw));
  assert.equal(r.code, 0, r.said);
  assert.ok(fw.calls.some((c) => c[0] === 'taskkill'));
});

test('the words about a hidden command line name Windows and an administrator on Windows only', async () => {
  const win = await T.judgeRecord(recordOf(), fakeWindows({ cmd: null }));
  assert.match(win.why, /Windows hides it, for example, for a program run as administrator/);
  // Linux: /proc gives an empty command line (a process that is ending); the start is the same.
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const linux = { platform: 'linux', alive: () => true, read: (f) => (f.endsWith('/cmdline') ? '' : `Name:\tnode\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`), ident: { of: (pids) => new Map(pids.map((p) => [p, 'L:boot1:12345'])) } };
  const j = await T.judgeRecord(recordOf({ proc: 'L:boot1:12345' }), linux);
  assert.equal(j.ok, false);
  assert.notEqual(j.gone, true);
  assert.match(j.why, /its command line cannot be read, so it cannot be told/);
  assert.doesNotMatch(j.why, /Windows|administrator/);
});

test('a record of the old format (no key, no state folder) is trusted only where its port answers as that older version', async () => {
  const old = { pid: OLD_PID, proc: `T:${OLD_START + 800}`, host: '127.0.0.1', port: 8270, at: OLD_START };
  assert.equal(T.oldFormat(old), true);
  assert.equal(T.oldFormat(recordOf()), false);
  for (const [confirmed, ended] of [[true, true], [false, false]]) {
    writeRecord(old);
    const fw = { ...fakeWindows(), answersAsOld: async () => confirmed };
    const r = await quiet(() => winsvc.service('restart', fw));
    assert.equal(r.code, 0, r.said);
    assert.equal(fw.calls.some((c) => c[0] === 'taskkill'), ended, r.said);
    if (!confirmed) assert.match(r.said, /is not that older version's dashboard: it was left running/);
  }
  // What answers on the port, for real: the released version (no route: 401 like every /api/ path), a newer one (404
  // without its key), another program, nothing.
  const answering = async (facts) => {
    const srv = http.createServer((q, res) => {
      if (q.url === '/healthz') return res.end('ok');
      if (q.url === '/api/local/facts') return facts(res);
      res.writeHead(404).end();
    }).listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    try {
      return await T.answersAsOld({ ...old, port: srv.address().port });
    } finally {
      await new Promise((r) => srv.close(r));
    }
  };
  assert.equal(await answering((res) => res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"log in first"}')), true, 'the released version');
  assert.equal(await answering((res) => res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}')), false, 'a newer dashboard');
  assert.equal(await answering((res) => res.writeHead(200).end('hello')), false, 'another program');
  assert.equal(await T.answersAsOld({ ...old, port: await freePort() }), false, 'nothing on the port');
});

// ---- Linux: two real dashboards of one state folder ----
async function freePort() {
  const srv = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

const get = (port) =>
  new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path: '/healthz' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', () => resolve(null));
  });

function serve(port, { extra = [], state = box.state } = {}) {
  const child = spawn(process.execPath, [BIN, 'serve', '--port', String(port), '--password-file', path.join(box.root, 'pw.txt'), ...extra], {
    env: { ...process.env, HOME: box.home, USERPROFILE: box.home, APPDATA: path.join(box.home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(box.home, 'AppData', 'Local'), HOPRIG_WORKSPACE_DIR: box.workspace, HOPRIG_STATE_DIR: state },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => (out += c));
  child.stderr.on('data', (c) => (out += c));
  const exited = new Promise((r) => child.once('exit', (code) => r(code)));
  return { child, exited, out: () => out };
}

async function until(fn, ms = 20_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true;
  return false;
}

const skipWin = { skip: process.platform === 'win32' && 'the made-up Windows tests above cover it' };
const stopAll = async (...list) => {
  for (const x of list) if (x && x.child.exitCode === null) {
    x.child.kill('SIGTERM');
    await x.exited;
  }
};
// A start's exit code, or 'still running' after `ms`: a wait that never ends would also skip the cleanup below.
const exitOf = (x, ms = 30_000) => Promise.race([x.exited, new Promise((r) => setTimeout(() => r('still running'), ms))]);
const still = (x, ms = 4000) => Promise.race([x.exited.then(() => 'ended'), new Promise((r) => setTimeout(() => r('running'), ms))]);

test('serve on a port its own OLDER dashboard holds: says so, ends it, and takes over; never two', skipWin, async () => {
  const port = await freePort();
  const first = serve(port);
  let second = null;
  try {
    assert.ok(await until(async () => (await get(port)) === 200), first.out());
    assert.ok(await until(() => T.readRecord(RECORD)?.pid === first.child.pid), 'the first one wrote its record');
    writeRecord({ ...T.readRecord(RECORD), version: '0.0.1' }); // as an older install wrote it
    second = serve(port);
    assert.equal(await Promise.race([first.exited, new Promise((r) => setTimeout(() => r('still running'), 20_000))]), 0, first.out());
    assert.ok(await until(() => T.readRecord(RECORD)?.pid === second.child.pid), second.out());
    assert.equal(await get(port), 200);
    assert.match(second.out(), new RegExp(`An older Hoprig dashboard \\(process ${first.child.pid}\\) is using port ${port}`));
  } finally {
    await stopAll(first, second);
  }
});

test('serve typed by habit beside a dashboard of the same version: named, never ended; --take-over ends it', skipWin, async () => {
  const port = await freePort();
  const first = serve(port);
  let second = null;
  let third = null;
  try {
    assert.ok(await until(async () => (await get(port)) === 200), first.out());
    assert.ok(await until(() => T.readRecord(RECORD)?.pid === first.child.pid));
    second = serve(port);
    assert.equal(await exitOf(second), 1, second.out());
    assert.match(second.out(), /already runs there\. Nothing was ended: use that one, or start this one with --take-over/);
    assert.equal(await still(first), 'running', 'the running dashboard is left alone');
    third = serve(port, { extra: ['--take-over'] });
    assert.equal(await Promise.race([first.exited, new Promise((r) => setTimeout(() => r('still running'), 20_000))]), 0, third.out());
    assert.ok(await until(() => T.readRecord(RECORD)?.pid === third.child.pid), third.out());
  } finally {
    await stopAll(first, second, third);
  }
});

test('a record copied into another state folder never ends the dashboard it names', skipWin, async () => {
  const port = await freePort();
  const otherPort = await freePort();
  const stateB = path.join(box.root, 'state-b');
  const stateC = path.join(box.root, 'state-c');
  fs.mkdirSync(stateB);
  fs.mkdirSync(stateC);
  const a = serve(port);
  const other = spawn(process.execPath, ['-e', `require('node:http').createServer((q, s) => s.end('x')).listen(${otherPort}, '127.0.0.1')`], { stdio: 'ignore' });
  const tries = [];
  try {
    assert.ok(await until(async () => (await get(port)) === 200), a.out());
    assert.ok(await until(() => T.readRecord(RECORD)?.pid === a.child.pid));
    assert.ok(await until(async () => (await get(otherPort)) !== null));
    const rec = T.readRecord(RECORD);
    // (b) the record as it is, in state folder B, and a start there on the same port, even with --take-over.
    fs.writeFileSync(path.join(stateB, 'dashboard.json'), JSON.stringify(rec));
    tries.push(serve(port, { state: stateB, extra: ['--take-over'] }));
    assert.equal(await exitOf(tries[0]), 1, tries[0].out());
    assert.match(tries[0].out(), /not shown to be this state folder's dashboard/);
    // (a) the record in state folder C with the port of another program that holds it.
    fs.writeFileSync(path.join(stateC, 'dashboard.json'), JSON.stringify({ ...rec, port: otherPort }));
    tries.push(serve(otherPort, { state: stateC, extra: ['--take-over'] }));
    assert.equal(await exitOf(tries[1]), 1, tries[1].out());
    assert.doesNotMatch(tries[1].out(), /Ending it first/);
    assert.equal(await still(a, 1500), 'running', 'the dashboard the copies name still runs');
    assert.equal(await get(port), 200);
    // `service install` and the like, from state folder B: the record is not this folder's, nothing is ended.
    const prev = process.env.HOPRIG_STATE_DIR;
    process.env.HOPRIG_STATE_DIR = stateB;
    try {
      assert.deepEqual((await T.endOldDashboard({ file: path.join(stateB, 'dashboard.json') })).ended, null);
    } finally {
      process.env.HOPRIG_STATE_DIR = prev;
    }
    assert.equal(await still(a, 1500), 'running');
  } finally {
    other.kill('SIGTERM');
    await stopAll(a, ...tries);
  }
});

test('serve on a port another program holds: named, never ended, and the start stops', skipWin, async () => {
  const port = await freePort();
  // Another program, and a record (written by someone else) that names it on that port.
  const other = spawn(process.execPath, ['-e', `require('node:http').createServer((q, s) => s.end('x')).listen(${port}, '127.0.0.1')`], { stdio: 'ignore' });
  try {
    assert.ok(await until(async () => (await get(port)) !== null));
    writeRecord({ pid: other.pid, proc: null, host: '127.0.0.1', port, at: Date.now() });
    const s = serve(port);
    assert.equal(await s.exited, 1, s.out());
    assert.match(s.out(), new RegExp(`port ${port} is in use by another program .*Nothing was ended`));
    assert.equal(other.exitCode, null, 'the other program still runs');
    assert.equal(await get(port), 200);
  } finally {
    other.kill('SIGTERM');
  }
});

test('listen on a held port, tried again and again, leaves no handler behind (no MaxListenersExceededWarning)', async () => {
  const { createServer } = await import('../../src/server/server.mjs');
  const holder = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => holder.once('listening', r));
  const { port } = holder.address();
  const app = createServer({ backend: { list: async () => [], capture: async () => '' }, watch: false, dashboardFile: false });
  const base = { listening: app.server.listenerCount('listening'), error: app.server.listenerCount('error') };
  try {
    for (let i = 0; i < 12; i++) await assert.rejects(app.listen(port, '127.0.0.1'), { code: 'EADDRINUSE' });
    assert.equal(app.server.listenerCount('listening'), base.listening);
    assert.equal(app.server.listenerCount('error'), base.error);
  } finally {
    await new Promise((r) => holder.close(r));
  }
  await app.listen(0, '127.0.0.1');
  assert.equal(app.server.listenerCount('error'), base.error, 'a listen that worked takes its error handler off too');
  await app.close();
});

test('no real system program was started', () => {
  assert.equal(fs.existsSync(sprung) ? fs.readFileSync(sprung, 'utf8') : '', '');
});
