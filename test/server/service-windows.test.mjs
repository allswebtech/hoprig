// `service install` on Windows, with made-up Windows programs: nothing here reaches the real whoami, schtasks or
// taskkill. Every program goes through the runner handed to service(), which answers as Windows would and records
// what was asked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import * as winsvc from '../../src/server/service/windows.mjs';
import { stateKey } from '../../src/server/dashboardfile.mjs';
import { sandbox } from './helpers.mjs';

const box = sandbox('svcwin');
// Traps first on PATH: a program that slipped past the runner (a call left on the real system) leaves its name in a
// file and fails, and the last test fails the file by that name.
const traps = path.join(box.root, 'traps');
const sprung = path.join(box.root, 'sprung.txt');
fs.mkdirSync(traps);
for (const name of ['whoami', 'schtasks', 'taskkill', 'reg', 'powershell.exe', 'systemctl', 'loginctl', 'sudo']) {
  fs.writeFileSync(path.join(traps, name), `#!/bin/sh\necho ${name} >> '${sprung}'\nexit 1\n`, { mode: 0o755 });
}
process.env.PATH = `${traps}${path.delimiter}${process.env.PATH}`;
test.after(() => box.cleanup());

// whoami /user /fo csv /nh as a local account prints it (one line, no header, whatever the display language).
const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
const WHOAMI_OUT = `"box2\\alex","${SID}"\r\n`;

/** A made-up Windows: answers per program, records each call, keeps the task XML as schtasks would read it. */
function fakeWindows(answers = {}) {
  const calls = [];
  let xml = null;
  const runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'schtasks' && args[0] === '/Create') xml = fs.readFileSync(args[args.indexOf('/XML') + 1]).subarray(2).toString('utf16le');
    // The task starts the new dashboard: it writes its record and answers its key on its port (deps below).
    if (cmd === 'schtasks' && args[0] === '/Run') fs.writeFileSync(path.join(box.state, 'dashboard.json'), JSON.stringify({ pid: 9100, port: 7433, host: '127.0.0.1', key: NEW_KEY, state: stateKey() }));
    const a = answers[cmd];
    if (typeof a === 'function') return a(args);
    return a || { ok: true, out: '', err: '' };
  };
  let clock = 0;
  const deps = {
    run: runner,
    fetchImpl: async (url, opts) => {
      if (opts?.headers?.['x-hoprig-local-key'] !== NEW_KEY) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ pid: 9100, state: stateKey() }) };
    },
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  };
  return { runner, calls, deps, xml: () => xml };
}
const NEW_KEY = 'n'.repeat(43);

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

test('whoami /user output: name and SID; anything else is no answer', () => {
  assert.deepEqual(winsvc.parseWhoami(WHOAMI_OUT), { name: 'box2\\alex', sid: SID });
  assert.deepEqual(winsvc.parseWhoami('"azuread\\alex lee","S-1-12-1-111-222-333-444"'), { name: 'azuread\\alex lee', sid: 'S-1-12-1-111-222-333-444' }, 'a Microsoft / Entra account, a name with a space');
  assert.deepEqual(winsvc.parseWhoami('"box2\\ålex ""x""","S-1-5-21-1-2-3-1002"'), { name: 'box2\\ålex "x"', sid: 'S-1-5-21-1-2-3-1002' });
  assert.equal(winsvc.parseWhoami('ERROR: Unable to get user name'), null);
  assert.equal(winsvc.parseWhoami(''), null);
  assert.deepEqual(winsvc.WHOAMI, ['whoami', ['/user', '/fo', 'csv', '/nh']]);
});

test('service install: the task runs as the account the system names (its SID), never one built from USERDOMAIN', async () => {
  // An SSH session to a local account: USERDOMAIN says WORKGROUP, and "WORKGROUP\alex" is no account.
  const saved = { USERDOMAIN: process.env.USERDOMAIN, USERNAME: process.env.USERNAME };
  process.env.USERDOMAIN = 'WORKGROUP';
  process.env.USERNAME = 'alex';
  try {
    const w = fakeWindows({ whoami: { ok: true, out: WHOAMI_OUT.trim(), err: '' } });
    const { code, said } = await quiet(() => winsvc.service('install', w.deps));
    assert.equal(code, 0, said);
    assert.match(said, /It answers at http:\/\/127\.0\.0\.1:7433 \(process 9100\)/);
    assert.deepEqual(w.calls[0], ['whoami', '/user', '/fo', 'csv', '/nh'], 'the system is asked first');
    const x = w.xml();
    assert.ok(x, 'schtasks /Create got a task file');
    assert.match(x, new RegExp(`<LogonTrigger><Enabled>true</Enabled><UserId>${SID}</UserId></LogonTrigger>`));
    assert.match(x, new RegExp(`<Principal id="Author"><UserId>${SID}</UserId><LogonType>InteractiveToken</LogonType>`));
    assert.doesNotMatch(x, /WORKGROUP/);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('service install: when the system does not say who this is, nothing is installed', async () => {
  const w = fakeWindows({ whoami: { ok: false, out: '', err: 'not found' } });
  const { code, said } = await quiet(() => winsvc.service('install', { run: w.runner }));
  assert.equal(code, 1);
  assert.match(said, /which Windows account/);
  assert.ok(!w.calls.some(([c]) => c === 'schtasks'), 'no task made or ended');
});

test('no real system program was started', () => {
  assert.equal(fs.existsSync(sprung) ? fs.readFileSync(sprung, 'utf8') : '', '');
});
