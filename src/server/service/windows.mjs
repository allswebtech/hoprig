// The dashboard as a per-user Scheduled Task (Windows): it starts when you log on, runs as you, and needs no admin
// rights. Written for Windows 10/11; not yet run on a real Windows machine (see the tests for what is covered).
//
// Three files, all under the state folder so nothing lands in system places:
//   dashboard-service.ps1  sets the carried environment, then runs `node <bin> serve`, appending to the log.
//                          Task Scheduler has no environment settings of its own, hence this small script.
//   task.xml               the task definition, handed to `schtasks /Create /XML` and deleted afterwards. XML,
//                          not `schtasks /SC ONLOGON`: that form asks for admin rights, while a logon trigger
//                          limited to your own account in XML does not.
//   dashboard.log          the dashboard's output.
// The script runs in a hidden PowerShell window (-WindowStyle Hidden), so no console stays open on the desktop.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binFile, stateDir } from '../../paths.mjs';
import { APP_NAME } from '../brand.mjs';
import { carried } from './env.mjs';
import { endOldDashboard, refusedFromInside } from '../takeover.mjs';

export const TASK = APP_NAME;

// The native path module (path.win32 on Windows): on another system a test's state folder is a POSIX path, and
// path.win32 would make a relative name of it in the working folder.
export const serviceDir = () => path.join(stateDir(), 'service');
export const scriptFile = () => path.join(serviceDir(), 'dashboard-service.ps1');
export const logFile = () => path.join(stateDir(), 'dashboard.log');

/** A PowerShell single-quoted string: only the quote itself needs doubling. */
export const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The startup script. Pure, so it can be tested. */
export function scriptText({ node = process.execPath, bin = binFile(), env = process.env, home = os.homedir(), log = logFile() } = {}) {
  return [
    `# Written by \`${APP_NAME} service install\`. Remove with \`${APP_NAME} service uninstall\`.`,
    ...carried(env).map(([k, v]) => `$env:${k} = ${psQuote(v)}`),
    // Redirection writes UTF-16 in Windows PowerShell 5.1 unless told otherwise.
    "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
    `Set-Location -LiteralPath ${psQuote(home)}`,
    `& ${psQuote(node)} ${psQuote(bin)} 'serve' *>> ${psQuote(log)}`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n');
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Windows command-line quoting for one argument that cannot contain a double quote (a path). */
const cmdArg = (s) => (/[\s"]/.test(s) ? `"${s}"` : s);

/** The PowerShell arguments the task runs. */
export const taskArguments = (script = scriptFile()) =>
  ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', cmdArg(script)].join(' ');

/**
 * The task definition. `user` is the installing account's SID (S-1-5-21-…), as `whoami /user` gives it: Task
 * Scheduler takes a SID as a UserId and needs no name lookup for it, so it works the same in an SSH session, where
 * USERDOMAIN says WORKGROUP for a local account and a DOMAIN\\name built from it does not resolve.
 */
export function taskXml({ user, script = scriptFile(), home = os.homedir() }) {
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${xml(`${APP_NAME} dashboard (Claude Code sessions). Written by \`${APP_NAME} service install\`.`)}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    `    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(user)}</UserId></LogonTrigger>`,
    '  </Triggers>',
    '  <Principals>',
    `    <Principal id="Author"><UserId>${xml(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    // No time limit (the default stops a task after 72 hours), normal priority, restart after a crash.
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>powershell.exe</Command>',
    `      <Arguments>${xml(taskArguments(script))}</Arguments>`,
    `      <WorkingDirectory>${xml(home)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

/** schtasks reads XML task files as UTF-16; a BOM says which byte order. */
export const utf16 = (text) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);

/** `whoami /user /fo csv /nh` argv: one CSV line, no header, so the display language changes nothing in it. */
export const WHOAMI = ['whoami', ['/user', '/fo', 'csv', '/nh']];

/** That line → { name: "pc\\me", sid: "S-1-5-21-…" }, or null when it is not such a line. */
export function parseWhoami(out) {
  const m = /^\s*"((?:[^"]|"")*)","(S-1-\d+(?:-\d+)+)"\s*$/m.exec(String(out || ''));
  return m ? { name: m[1].replace(/""/g, '"'), sid: m[2] } : null;
}

/** Who this process really is, asked of the system (never USERDOMAIN): { name, sid } or null. */
export async function whoAmI(runner = run) {
  const r = await runner(...WHOAMI);
  return r.ok ? parseWhoami(r.out) : null;
}

/** schtasks argv for each step. */
export const schtasksArgs = {
  create: (xmlFile) => ['/Create', '/TN', TASK, '/XML', xmlFile, '/F'],
  run: () => ['/Run', '/TN', TASK],
  end: () => ['/End', '/TN', TASK],
  remove: () => ['/Delete', '/TN', TASK, '/F'],
  query: () => ['/Query', '/TN', TASK, '/V', '/FO', 'LIST'],
};

/**
 * `schtasks /Query /V /FO LIST` → { status, lastRun, lastResult, nextRun }. The labels are those of an English
 * Windows; on other display languages they differ and the fields stay null (status prints the raw text then).
 */
export function parseQuery(text) {
  const get = (label) => {
    const m = new RegExp(`^${label}:\\s*(.*)$`, 'mi').exec(text);
    return m ? m[1].trim() : null;
  };
  return { status: get('Status'), lastRun: get('Last Run Time'), lastResult: get('Last Result'), nextRun: get('Next Run Time') };
}

const run = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (stdout || '').trim(), err: (stderr || (err && err.message) || '').trim() }),
    );
  });

/**
 * Ending the task stops only its PowerShell wrapper: the `node … serve` it started keeps the port, and a new start
 * cannot listen. So the old dashboard is ended by its own process id (takeover.mjs checks it is that very program)
 * before the task starts again. Says what happened; false when an old one runs and could not be ended.
 */
const AGAIN = 'Close that dashboard (or restart the computer), then run this again.';

async function endOld(run, deps) {
  const r = await endOldDashboard({ platform: 'win32', run, ...deps });
  if (r.ended) console.log(`The dashboard that was running (process ${r.ended}) was ended.`);
  else if (r.left) console.log(`Not ended: ${r.left}.`);
  else if (r.why) console.error(`The dashboard that was running was not ended: ${r.why}.`);
  return !r.why;
}

/**
 * `deps.run(cmd, args)` → { ok, out, err }: how the programs are started; the rest goes to takeover.mjs (tests hand
 * in a made-up Windows).
 */
export async function service(sub, { run: runner = run, ...deps } = {}) {
  const run = runner;
  // Typed in a terminal of the dashboard itself: ending that dashboard would end this command before the task starts
  // again, and nothing would serve until the next sign-in. So nothing is changed.
  if (['install', 'restart', 'uninstall'].includes(sub)) {
    const inside = await refusedFromInside({ platform: 'win32', run, ...deps });
    if (inside) {
      console.error(inside);
      return 1;
    }
  }
  switch (sub) {
    case 'install': {
      const me = await whoAmI(run);
      if (!me) {
        console.error('Could not find out which Windows account this is (whoami /user gave no answer). Nothing was installed.');
        return 1;
      }
      await run('schtasks', schtasksArgs.end()); // a running previous version, if any
      // A dashboard that runs and could not be ended keeps the port: a new task would only fail beside it.
      if (!(await endOld(run, deps))) {
        console.error(`Nothing was installed. ${AGAIN}`);
        return 1;
      }
      fs.mkdirSync(serviceDir(), { recursive: true });
      // UTF-8 with a BOM: Windows PowerShell 5.1 reads a script without one in the old ANSI code page, which would
      // garble any non-ASCII path in it.
      fs.writeFileSync(scriptFile(), '﻿' + scriptText());
      const xmlFile = path.join(serviceDir(), 'task.xml');
      fs.writeFileSync(xmlFile, utf16(taskXml({ user: me.sid })));
      const r = await run('schtasks', schtasksArgs.create(xmlFile));
      fs.rmSync(xmlFile, { force: true });
      if (!r.ok) {
        console.error(`schtasks /Create failed: ${r.err || r.out}`);
        return 1;
      }
      const started = await run('schtasks', schtasksArgs.run());
      if (!started.ok) console.error(`The task is installed but did not start now: ${started.err || started.out}`);
      console.log(`Scheduled task "${TASK}" installed: the dashboard starts at every logon. Log: ${logFile()}`);
      console.log(`See it with: ${APP_NAME} service status`);
      return 0;
    }
    case 'restart': {
      const q = await run('schtasks', schtasksArgs.query());
      if (!q.ok) {
        console.error(`The service is not installed. Install it with: ${APP_NAME} service install`);
        return 3;
      }
      await run('schtasks', schtasksArgs.end());
      if (!(await endOld(run, deps))) return 1;
      const started = await run('schtasks', schtasksArgs.run());
      if (!started.ok) {
        console.error(`The task did not start: ${started.err || started.out}`);
        return 1;
      }
      console.log(`The dashboard is starting again. See it with: ${APP_NAME} service status`);
      return 0;
    }
    case 'uninstall': {
      await run('schtasks', schtasksArgs.end());
      if (!(await endOld(run, deps))) {
        console.error(`Nothing was removed. ${AGAIN}`);
        return 1;
      }
      const r = await run('schtasks', schtasksArgs.remove());
      fs.rmSync(scriptFile(), { force: true });
      console.log(r.ok ? `Scheduled task "${TASK}" removed.` : 'The service was not installed.');
      return 0;
    }
    case 'status': {
      const r = await run('schtasks', schtasksArgs.query());
      if (!r.ok) {
        console.log('not installed');
        return 3;
      }
      const q = parseQuery(r.out);
      console.log(q.status ? `${TASK}: ${q.status}\nlast run: ${q.lastRun} (result ${q.lastResult})\nlog: ${logFile()}` : r.out);
      return 0;
    }
    default:
      console.error(`usage: ${APP_NAME} service install | uninstall | status | restart`);
      return 2;
  }
}
