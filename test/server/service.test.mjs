import assert from 'node:assert/strict';
import test from 'node:test';
import { CARRIED_ENV, unitText } from '../../src/server/service/systemd.mjs';

test('systemd unit: absolute paths, carried PATH, escaping, restart, kill mode', () => {
  const u = unitText({
    node: '/opt/node 26/bin/node',
    bin: '/home/u/app/bin/x.mjs',
    env: { PATH: '/a/bin:/b/100%/bin', HOME: '/home/u', SECRET_TOKEN: 'nope', LANG: 'en_US.UTF-8', HOPRIG_STATE_DIR: '/s' }, // seal: a value no program is started with
  });
  assert.match(u, /^ExecStart="\/opt\/node 26\/bin\/node" "\/home\/u\/app\/bin\/x\.mjs" serve$/m);
  assert.match(u, /^Environment="PATH=\/a\/bin:\/b\/100%%\/bin"$/m);
  assert.match(u, /^Environment="LANG=en_US\.UTF-8"$/m);
  assert.match(u, /^Environment="HOPRIG_STATE_DIR=\/s"$/m);
  assert.doesNotMatch(u, /SECRET_TOKEN|HOME=/, 'only the listed variables are carried');
  assert.match(u, /^Restart=on-failure$/m);
  assert.match(u, /^KillMode=process$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
  assert.ok(CARRIED_ENV.includes('PATH'));
});

// ---- macOS: launchd agent ----
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LABEL, launchctlArgs, plistFile, plistText, summarizePrint } from '../../src/server/service/launchd.mjs';
import * as winsvc from '../../src/server/service/windows.mjs';
import { service } from '../../src/server/service/index.mjs';

const ENV = { PATH: '/opt/node 26/bin:/usr/bin', HOME: '/Users/u', SECRET_TOKEN: 'nope', LANG: 'en_US.UTF-8', HOPRIG_STATE_DIR: '/s & <t>' }; // seal: a value no program is started with

test('launchd plist: absolute paths, carried variables only, escaping, restart on crash, log file', () => {
  const p = plistText({ node: '/opt/node 26/bin/node', bin: '/Users/u/app/bin/x.mjs', env: ENV, home: '/Users/u', log: '/Users/u/.local/state/x/dashboard.log' });
  assert.match(p, new RegExp(`<key>Label</key>\\s*<string>${LABEL.replace(/\./g, '\\.')}</string>`));
  assert.match(p, /<array>\s*<string>\/opt\/node 26\/bin\/node<\/string>\s*<string>\/Users\/u\/app\/bin\/x\.mjs<\/string>\s*<string>serve<\/string>\s*<\/array>/);
  assert.match(p, /<key>PATH<\/key>\s*<string>\/opt\/node 26\/bin:\/usr\/bin<\/string>/);
  assert.match(p, /<key>HOPRIG_STATE_DIR<\/key>\s*<string>\/s &amp; &lt;t&gt;<\/string>/);
  assert.doesNotMatch(p, /SECRET_TOKEN|<key>HOME<\/key>/, 'only the listed variables are carried');
  assert.match(p, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(p, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p, /<key>AbandonProcessGroup<\/key>\s*<true\/>/);
  assert.match(p, /<key>StandardErrorPath<\/key>\s*<string>\/Users\/u\/\.local\/state\/x\/dashboard\.log<\/string>/);
  assert.equal(plistFile('/Users/u'), `/Users/u/Library/LaunchAgents/${LABEL}.plist`);
});

test('launchd plist is valid for macOS itself (plutil), launchctl argv', { skip: process.platform !== 'darwin' && 'not macOS' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-test-'));
  try {
    const file = path.join(dir, 'x.plist');
    fs.writeFileSync(file, plistText({ env: ENV }));
    assert.match(execFileSync('plutil', ['-lint', file]).toString(), /OK/);
    const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file]).toString());
    assert.deepEqual(parsed.ProgramArguments, [process.execPath, parsed.ProgramArguments[1], 'serve']);
    assert.equal(parsed.EnvironmentVariables.HOPRIG_STATE_DIR, '/s & <t>');
    assert.deepEqual(parsed.KeepAlive, { SuccessfulExit: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const uid = process.getuid();
  assert.deepEqual(launchctlArgs.load('/p.plist'), ['bootstrap', `gui/${uid}`, '/p.plist']);
  assert.deepEqual(launchctlArgs.unload(), ['bootout', `gui/${uid}/${LABEL}`]);
  assert.deepEqual(launchctlArgs.status(), ['print', `gui/${uid}/${LABEL}`]);
});

test('launchctl print summary', () => {
  const out = `gui/501/${LABEL} = {\n\tactive count = 1\n\tpath = /Users/u/Library/LaunchAgents/${LABEL}.plist\n\ttype = LaunchAgent\n\tstate = running\n\n\tprogram = /opt/node/bin/node\n\tenvironment = {\n\t\tPATH => /usr/bin\n\t}\n\truns = 1\n\tpid = 651\n\tlast exit code = (never exited)\n}`;
  assert.equal(summarizePrint(out), `path = /Users/u/Library/LaunchAgents/${LABEL}.plist\nstate = running\nprogram = /opt/node/bin/node\nruns = 1\npid = 651\nlast exit code = (never exited)`);
});

// ---- Windows: Scheduled Task ----
test('Windows startup script: carried variables quoted for PowerShell, UTF-8 log, exit code passed on', () => {
  const s = winsvc.scriptText({
    node: 'C:\\Program Files\\nodejs\\node.exe', bin: "C:\\Users\\o'brien\\app\\bin\\x.mjs",
    env: { PATH: 'C:\\Windows;C:\\Users\\me\\.local\\bin', SECRET_TOKEN: 'nope', HOPRIG_STATE_DIR: "C:\\it's $(here)" }, // seal: a value no program is started with
    home: 'C:\\Users\\me', log: 'C:\\Users\\me\\AppData\\Local\\x\\dashboard.log',
  });
  const lines = s.split('\r\n');
  assert.ok(lines.includes("$env:PATH = 'C:\\Windows;C:\\Users\\me\\.local\\bin'"));
  assert.ok(lines.includes("$env:HOPRIG_STATE_DIR = 'C:\\it''s $(here)'"), 'single quotes: no expansion, quote doubled');
  assert.ok(!s.includes('SECRET_TOKEN'));
  assert.ok(lines.includes("Set-Location -LiteralPath 'C:\\Users\\me'"));
  assert.ok(lines.includes("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\Users\\o''brien\\app\\bin\\x.mjs' 'serve' *>> 'C:\\Users\\me\\AppData\\Local\\x\\dashboard.log'"));
  assert.ok(lines.includes("$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'"));
  assert.equal(lines.at(-2), 'exit $LASTEXITCODE');
});

test('Windows task XML: logon trigger for this user only, no admin, no time limit, escaped', () => {
  const x = winsvc.taskXml({ user: 'PC\\me & co', script: 'C:\\Users\\me\\AppData\\Local\\x y\\service\\dashboard-service.ps1', home: 'C:\\Users\\me' });
  assert.match(x, /^<\?xml version="1\.0" encoding="UTF-16"\?>/);
  assert.match(x, /<LogonTrigger><Enabled>true<\/Enabled><UserId>PC\\me &amp; co<\/UserId><\/LogonTrigger>/);
  assert.match(x, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.match(x, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(x, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(x, /<Command>powershell\.exe<\/Command>/);
  assert.match(x, /<Arguments>-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File &quot;C:\\Users\\me\\AppData\\Local\\x y\\service\\dashboard-service\.ps1&quot;<\/Arguments>/);
  assert.equal((x.match(/<[A-Za-z]/g) || []).length, (x.match(/<\/[A-Za-z]/g) || []).length + (x.match(/\/>/g) || []).length, 'every element is closed');
  try {
    // where libxml2's xmllint exists (macOS, most Linux), a real well-formedness check of the UTF-16 file
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-xml-'));
    const file = path.join(dir, 'task.xml');
    fs.writeFileSync(file, winsvc.utf16(x));
    try {
      execFileSync('xmllint', ['--noout', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const b = winsvc.utf16('<a/>');
  assert.deepEqual([...b.subarray(0, 4)], [0xff, 0xfe, 0x3c, 0x00], 'UTF-16LE with a BOM');
  assert.deepEqual(winsvc.schtasksArgs.create('C:\\t.xml'), ['/Create', '/TN', winsvc.TASK, '/XML', 'C:\\t.xml', '/F']);
  assert.deepEqual(winsvc.schtasksArgs.query(), ['/Query', '/TN', winsvc.TASK, '/V', '/FO', 'LIST']);
  assert.deepEqual(winsvc.schtasksArgs.remove(), ['/Delete', '/TN', winsvc.TASK, '/F']);
});

test('schtasks /Query /V /FO LIST parsing', () => {
  const out = [
    '', 'Folder: \\', 'HostName:                             PC', `TaskName:                             \\${winsvc.TASK}`,
    'Next Run Time:                        N/A', 'Status:                               Running', 'Logon Mode:                           Interactive only',
    'Last Run Time:                        11/14/2026 9:02:11 AM', 'Last Result:                          267009', 'Author:                               PC\\me', '',
  ].join('\r\n');
  assert.deepEqual(winsvc.parseQuery(out), { status: 'Running', lastRun: '11/14/2026 9:02:11 AM', lastResult: '267009', nextRun: 'N/A' });
  assert.deepEqual(winsvc.parseQuery('Statut: En cours'), { status: null, lastRun: null, lastResult: null, nextRun: null }, 'another language: raw text is shown');
});

test('service: one manager per OS, a clear refusal elsewhere', async () => {
  const err = console.error;
  let said = '';
  console.error = (m) => (said += m);
  try {
    assert.equal(await service('status', 'aix'), 1);
  } finally {
    console.error = err;
  }
  assert.match(said, /not supported on aix/);
});

// `service restart` on every system, with a stand-in for the service manager: the real one would restart the
// dashboard of whoever runs the tests.
import * as systemdsvc from '../../src/server/service/systemd.mjs';
import * as launchdsvc from '../../src/server/service/launchd.mjs';

const silent = async (fn) => {
  const { log, error } = console;
  let said = '';
  console.log = console.error = (...m) => (said += m.join(' ') + '\n');
  try {
    return { code: await fn(), said };
  } finally {
    Object.assign(console, { log, error });
  }
};

test('service restart exists on Linux and macOS and asks only the service manager', { skip: process.platform === 'win32' && 'systemd and launchd, by the uid Windows does not have' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'svc-restart-'));
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  try {
    const calls = [];
    const run = async (cmd, args) => (calls.push([cmd, ...args]), { ok: true, out: '', err: '' });
    let r = await silent(() => systemdsvc.service('restart', { run }));
    assert.equal(r.code, 3, 'not installed: says so');
    assert.match(r.said, /not installed\. Install it with: hoprig service install/);
    assert.deepEqual(calls, []);
    fs.mkdirSync(systemdsvc.unitDir(), { recursive: true });
    fs.writeFileSync(path.join(systemdsvc.unitDir(), systemdsvc.UNIT), '');
    r = await silent(() => systemdsvc.service('restart', { run }));
    assert.equal(r.code, 0, r.said);
    assert.deepEqual(calls, [['systemctl', '--user', 'restart', systemdsvc.UNIT]]);
    assert.deepEqual(launchdsvc.launchctlArgs.restart().slice(0, 2), ['kickstart', '-k']);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the usage names service restart', async () => {
  const r = await silent(() => systemdsvc.service('nope', { run: async () => ({ ok: true }) }));
  assert.match(r.said, /install \| uninstall \| status \| restart/);
});
