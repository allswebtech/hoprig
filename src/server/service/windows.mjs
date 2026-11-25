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
import { endOldDashboard, insideWords, portBase, readRecord, refusedFromInside } from '../takeover.mjs';
import { stateKey } from '../dashboardfile.mjs';
import { clearPort, insideTree, readTree, tail, treeOf, waitForNew } from './wintree.mjs';
import { WHOAMI, parseWhoami } from '../platform/win32.mjs';

export const TASK = APP_NAME;

// The native path module (path.win32 on Windows): on another system a test's state folder is a POSIX path, and
// path.win32 would make a relative name of it in the working folder.
export const serviceDir = () => path.join(stateDir(), 'service');
export const scriptFile = () => path.join(serviceDir(), 'dashboard-service.ps1');
export const logFile = () => path.join(stateDir(), 'dashboard.log');

/**
 * A PowerShell single-quoted string: only a quote needs doubling. PowerShell takes the typographic quotes
 * U+2018 to U+201B as single quotes too (about_Quoting_Rules), so a folder named Bob’s would end the string early.
 */
export const psQuote = (s) => `'${String(s).replace(/['‘-‛]/g, '$&$&')}'`;

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

export { WHOAMI, parseWhoami };

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

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Before the task is ended: the old dashboard's port (its record's, else the settings' or the default 7433) and the
 * process table, read while the PowerShell wrapper still links the old `serve` to this task.
 */
async function lookBefore(run, deps) {
  const rec = readRecord(deps.file);
  let port = rec && (typeof rec.state !== 'string' || rec.state === stateKey()) ? rec.port : null;
  if (!Number.isInteger(port)) {
    try {
      port = (await import('../../config.mjs')).loadConfig().server?.port;
    } catch {
      port = null;
    }
  }
  if (!Number.isInteger(port)) port = 7433; // the dashboard's default (server.mjs DEFAULT_PORT)
  const snap = await readTree(port, run);
  const old = new Set([...(rec ? [rec.pid] : []), ...treeOf(snap, scriptFile()).members.map((p) => p.pid)]);
  return { port, snap, old };
}

/**
 * Typed in a terminal of the old dashboard when it has no record (refusedFromInside cannot see it then): the table read
 * before shows it. True after saying so; nothing was ended or changed.
 */
function insideOld(b, deps) {
  const pid = insideTree(b.snap, scriptFile(), deps.kept);
  if (pid) console.error(insideWords(pid));
  return !!pid;
}

/** After the old one was ended: its port is free, or each holder is named and false comes back. */
const portFreed = (b, run, deps, me) => clearPort({ port: b.port, before: b.snap, run, me, script: scriptFile(), kept: deps.kept, sleep: deps.sleep || realSleep });

const WAIT_MS = 30_000;

/** After `schtasks /Run`: the new dashboard answers on its port, or the log and the status are shown and false comes back. */
async function answers(run, deps, b, done) {
  const waitMs = deps.waitNewMs ?? WAIT_MS;
  const rec = await waitForNew({ old: b.old, file: deps.file, fetchImpl: deps.fetchImpl, sleep: deps.sleep || realSleep, now: deps.now, waitMs });
  if (rec) {
    console.log(`${done} It answers at ${portBase(rec)} (process ${rec.pid}).`);
    return true;
  }
  console.error(`The new dashboard did not answer within ${Math.round(waitMs / 1000)} seconds of its start, so this did not work.`);
  const t = tail(logFile());
  console.error(t ? `The last lines of its log (${logFile()}):\n${t}` : `Its log (${logFile()}) has nothing in it.`);
  console.error(`${APP_NAME} service status:\n${statusText(await run('schtasks', schtasksArgs.query()))}`);
  return false;
}

const statusText = (r) => {
  if (!r.ok) return 'not installed';
  const q = parseQuery(r.out);
  return q.status ? `${TASK}: ${q.status}\nlast run: ${q.lastRun} (result ${q.lastResult})\nlog: ${logFile()}` : r.out;
};

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
      const b = await lookBefore(run, deps);
      if (insideOld(b, deps)) return 1;
      await run('schtasks', schtasksArgs.end()); // a running previous version, if any
      // A dashboard that runs and could not be ended keeps the port: a new task would only fail beside it.
      if (!(await endOld(run, deps)) || !(await portFreed(b, run, deps, me))) {
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
      if (!started.ok) {
        console.error(`The task is installed but did not start now: ${started.err || started.out}`);
        return 1;
      }
      if (!(await answers(run, deps, b, `Scheduled task "${TASK}" installed: the dashboard starts at every logon.`))) return 1;
      console.log(`Log: ${logFile()}. See it with: ${APP_NAME} service status`);
      return 0;
    }
    case 'restart': {
      const q = await run('schtasks', schtasksArgs.query());
      if (!q.ok) {
        console.error(`The service is not installed. Install it with: ${APP_NAME} service install`);
        return 3;
      }
      const b = await lookBefore(run, deps);
      if (insideOld(b, deps)) return 1;
      await run('schtasks', schtasksArgs.end());
      if (!(await endOld(run, deps))) return 1;
      if (!(await portFreed(b, run, deps, null))) {
        console.error(`Nothing was started. ${AGAIN}`);
        return 1;
      }
      const started = await run('schtasks', schtasksArgs.run());
      if (!started.ok) {
        console.error(`The task did not start: ${started.err || started.out}`);
        return 1;
      }
      if (!(await answers(run, deps, b, 'The dashboard started again.'))) return 1;
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
      console.log(statusText(r));
      return r.ok ? 0 : 3;
    }
    default:
      console.error(`usage: ${APP_NAME} service install | uninstall | status | restart`);
      return 2;
  }
}
