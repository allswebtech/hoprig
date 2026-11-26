// Windows: one PowerShell call per snapshot (CIM classes and Get-NetTCPConnection, printed as JSON), taskkill and
// shutdown. Written for Windows 10/11 with the built-in Windows PowerShell 5.1.
//
// Scripts go to PowerShell with -EncodedCommand (base64 of UTF-16LE), so no quoting rules of cmd.exe or of the
// Windows command line can change them. They are fixed text; the only value ever put into one is a pid that the
// caller has already checked to be an integer.
import os from 'node:os';
import { lookupFrom, redact, run, runSync, top, uniquePorts } from './common.mjs';

export const POWERSHELL = 'powershell.exe';

/** PowerShell argv for a script. */
export const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

const ps = (script, timeout = 15_000) => run(POWERSHELL, psArgs(script), { timeout, env: process.env });

// Windows PowerShell 5.1 loads a module at the first command it has to look up outside its own core (Get-Date,
// Get-CimInstance, Get-NetTCPConnection, ConvertTo-Json, Sort-Object…): "Preparing modules for first use", measured at
// about 17 s in a home whose module cache is not kept, at every call. The scripts here call no such command: WMI through
// System.Management (the classes Get-CimInstance reads, and MSFT_NetTCPConnection, which Get-NetTCPConnection reads),
// and JSON through .NET's JavaScriptSerializer. `Rows` is a function of the script itself (no lookup). `Emit` writes the
// JSON in plain ASCII, every other letter as \uXXXX: the console writes in its OEM code page, where some letters become
// control bytes (in 437, "•" becomes 0x07) that no JSON reader takes, and others become "?".
export const NO_MODULE_PRELUDE = `$ErrorActionPreference = 'SilentlyContinue'
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Web.Extensions')
$json = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
$json.MaxJsonLength = [int]::MaxValue
function Rows($ns, $wql) { $list = [System.Collections.ArrayList]::new(); foreach ($r in [System.Management.ManagementObjectSearcher]::new($ns, $wql).Get()) { [void]$list.Add($r) }; ,$list.ToArray() }
function Emit($v) { [Console]::Out.Write([regex]::Replace($json.Serialize($v), '[^\\x20-\\x7e]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })) }
`;

// CPU is the average since the process started (CPU seconds / age), which is what `ps pcpu` shows on Linux too.
// The owner (GetOwnerSid: the account's SID, one plain ASCII string) is slow per process, so it is asked only for the
// processes that make the two top lists (the 13 first by CPU and by memory). It prints one JSON object of the shape
// parseWinSnapshot reads: mem, pagefiles, disks, procs, owners (pid → SID, '' when not told), ports.
export const SNAPSHOT_SCRIPT = `${NO_MODULE_PRELUDE}$now = [DateTime]::Now
$mem = @{}
foreach ($os in (Rows 'root\\cimv2' 'SELECT TotalVisibleMemorySize,FreePhysicalMemory FROM Win32_OperatingSystem')) { $mem = @{ totalKB = [double]$os['TotalVisibleMemorySize']; freeKB = [double]$os['FreePhysicalMemory'] } }
$procs = [System.Collections.ArrayList]::new()
$byPid = @{}
foreach ($p in (Rows 'root\\cimv2' 'SELECT Handle,ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,CreationDate,KernelModeTime,UserModeTime FROM Win32_Process')) {
  $age = 1
  if ($p['CreationDate']) { $age = [math]::Max(1, [int]($now - [System.Management.ManagementDateTimeConverter]::ToDateTime($p['CreationDate'])).TotalSeconds) }
  $id = [int]$p['ProcessId']
  $byPid[[string]$id] = $p
  [void]$procs.Add(@{ pid = $id; ppid = [int]$p['ParentProcessId']; name = [string]$p['Name']; args = $p['CommandLine']; rss = [double]$p['WorkingSetSize']; age = $age; cpu = [math]::Round((([double]$p['KernelModeTime'] + [double]$p['UserModeTime']) / 1e7) / $age * 100, 1) })
}
function Top($list, $key) { $left = [System.Collections.ArrayList]::new($list); $out = [System.Collections.ArrayList]::new(); while ($out.Count -lt 13 -and $left.Count -gt 0) { $b = 0; for ($j = 1; $j -lt $left.Count; $j++) { if ($left[$j][$key] -gt $left[$b][$key]) { $b = $j } }; [void]$out.Add($left[$b]); $left.RemoveAt($b) }; ,$out.ToArray() }
$owners = @{}
foreach ($p in (Top $procs 'cpu') + (Top $procs 'rss')) {
  $k = [string]$p['pid']
  if ($owners.ContainsKey($k)) { continue }
  $sid = ''
  $inst = $byPid[$k]
  if ($inst) { $o = $inst.InvokeMethod('GetOwnerSid', $null, $null); if ($o -and $o['ReturnValue'] -eq 0) { $sid = [string]$o['Sid'] } }
  $owners[$k] = $sid
}
$pagefiles = [System.Collections.ArrayList]::new()
foreach ($f in (Rows 'root\\cimv2' 'SELECT AllocatedBaseSize,CurrentUsage FROM Win32_PageFileUsage')) { [void]$pagefiles.Add(@{ sizeMB = [double]$f['AllocatedBaseSize']; usedMB = [double]$f['CurrentUsage'] }) }
$disks = [System.Collections.ArrayList]::new()
foreach ($d in (Rows 'root\\cimv2' 'SELECT DeviceID,Size,FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3')) { [void]$disks.Add(@{ id = [string]$d['DeviceID']; size = [double]$d['Size']; free = [double]$d['FreeSpace'] }) }
$ports = [System.Collections.ArrayList]::new()
foreach ($c in (Rows 'root\\StandardCimv2' 'SELECT LocalAddress,LocalPort,OwningProcess FROM MSFT_NetTCPConnection WHERE State=2')) { [void]$ports.Add(@{ addr = [string]$c['LocalAddress']; port = [int]$c['LocalPort']; pid = [int]$c['OwningProcess'] }) }
Emit @{ mem = $mem; pagefiles = $pagefiles.ToArray(); disks = $disks.ToArray(); procs = $procs.ToArray(); owners = $owners; ports = $ports.ToArray() }
`;

const arr = (x) => (Array.isArray(x) ? x : x === null || x === undefined ? [] : [x]);

/** `whoami /user /fo csv /nh` argv: one CSV line, no header, so the display language changes nothing in it. */
export const WHOAMI = ['whoami', ['/user', '/fo', 'csv', '/nh']];

/** That line → { name: "pc\\me", sid: "S-1-5-21-…" }, or null when it is not such a line. */
export function parseWhoami(out) {
  const m = /^\s*"((?:[^"]|"")*)","(S-1-\d+(?:-\d+)+)"\s*$/m.exec(String(out || ''));
  return m ? { name: m[1].replace(/""/g, '"'), sid: m[2] } : null;
}

/**
 * The SID of whoever runs this server, as the system names it (the account of this process's own token, read by .NET
 * in PowerShell), asked once and kept; null when the system did not say. Never built from USERDOMAIN and USERNAME: in
 * an SSH session to a local account USERDOMAIN says WORKGROUP while Windows names the owner of that account's processes
 * "PC\\me", so the person's own processes would look like another user's. Not `whoami` by name either: Git for
 * Windows puts its own whoami (a POSIX one, which knows no /user) on PATH, often before the system's. `runner`
 * (runSync's shape: stdout or null) is handed in by tests.
 */
export const SID_SCRIPT = "[Console]::Out.WriteLine([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)";
const asked = new Map();
export function mySid(runner = runSync) {
  if (asked.has(runner)) return asked.get(runner);
  const m = /^\s*(S-1-\d+(?:-\d+)+)\s*$/m.exec(String(runner(POWERSHELL, psArgs(SID_SCRIPT), { timeout: 15_000 }) || ''));
  if (m) asked.set(runner, m[1]);
  return m ? m[1] : null;
}

/** Owners (SIDs) compare without case, as Windows does. */
export const sameUser = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The JSON printed by SNAPSHOT_SCRIPT → the parts of the common snapshot shape. */
export function parseWinSnapshot(json, me = mySid()) {
  const d = JSON.parse(json);
  const owners = d.owners || {};
  const procs = arr(d.procs).map((p) => ({
    pid: p.pid,
    uid: null, // Windows has no numeric uid; `mine` is decided by the owner's SID
    cpu: Number(p.cpu) || 0,
    rss: Number(p.rss) || 0,
    age: Number(p.age) || 0,
    name: p.name || '',
    // Command lines of other users' processes are hidden from a normal user: the name stands in.
    args: redact(p.args || p.name || ''),
    owner: owners[String(p.pid)] ?? null,
  }));
  const names = new Map(procs.map((p) => [p.pid, p.name]));
  const pages = arr(d.pagefiles);
  const mb = 1024 * 1024;
  const swapTotal = pages.reduce((s, p) => s + (Number(p.sizeMB) || 0), 0) * mb;
  const swapUsed = pages.reduce((s, p) => s + (Number(p.usedMB) || 0), 0) * mb;
  const mine = (p) => sameUser(p.owner, me);
  return {
    mem: {
      total: d.mem && d.mem.totalKB ? d.mem.totalKB * 1024 : os.totalmem(),
      available: d.mem && d.mem.freeKB !== undefined ? d.mem.freeKB * 1024 : os.freemem(),
      swapTotal,
      swapFree: swapTotal - swapUsed,
    },
    disks: arr(d.disks)
      .filter((x) => Number(x.size) > 0)
      .map((x) => ({ fs: x.id, mount: `${x.id}\\`, size: Number(x.size), used: Number(x.size) - Number(x.free), avail: Number(x.free) })),
    topCpu: top(procs, 'cpu', mine).map(({ owner, ...p }) => p),
    topMem: top(procs, 'rss', mine).map(({ owner, ...p }) => p),
    // pid 0 and 4 are the idle and System pseudo processes (kernel listeners such as SMB on 445).
    ports: uniquePorts(arr(d.ports).map((p) => ({ addr: p.addr, port: p.port, process: names.get(p.pid) || '', pid: p.pid > 4 ? p.pid : null }))),
  };
}

export async function snapshot({ run: runner = run, runSync: whoRunner = runSync } = {}) {
  const r = await runner(POWERSHELL, psArgs(SNAPSHOT_SCRIPT), { timeout: 30_000, env: process.env });
  let parts = { mem: { total: os.totalmem(), available: os.freemem(), swapTotal: null, swapFree: null }, disks: [], topCpu: [], topMem: [], ports: [] };
  const errors = [];
  if (r.ok) {
    try {
      parts = parseWinSnapshot(r.stdout, mySid(whoRunner));
    } catch (e) {
      errors.push(`could not read the PowerShell output: ${e.message}`);
    }
  } else errors.push(r.stderr || 'PowerShell failed');
  return {
    host: os.hostname(),
    platform: process.platform,
    uptime: os.uptime(),
    load: null, // Windows has no load average (os.loadavg() is always zeros there)
    cpus: os.cpus().length,
    ...parts,
    errors,
  };
}

/**
 * The owner script for one pid: prints the owner's SID ('?' when Windows does not say) and whether the process has a
 * window ("window" or "nowindow"), or nothing when there is no such process.
 */
export const ownerScript = (pid) => {
  if (!Number.isInteger(pid) || pid < 0) throw new Error('bad pid');
  // No module (see NO_MODULE_PRELUDE): WMI through System.Management, the answer written by .NET.
  return `$ErrorActionPreference = 'SilentlyContinue'; foreach ($p in [System.Management.ManagementObjectSearcher]::new('SELECT Handle FROM Win32_Process WHERE ProcessId=${pid}').Get()) { $o = $p.InvokeMethod('GetOwnerSid', $null, $null); $sid = '?'; if ($o -and $o['ReturnValue'] -eq 0) { $sid = [string]$o['Sid'] }; $w = 'nowindow'; try { if ([System.Diagnostics.Process]::GetProcessById(${pid}).MainWindowHandle -ne [IntPtr]::Zero) { $w = 'window' } } catch {}; [Console]::Out.WriteLine("$sid $w") }`;
};

/** taskkill argv: without /F Windows asks the program to close; /F ends it at once. */
export const taskkillArgs = (pid, signal) => ['/PID', String(pid), ...(signal === 'SIGKILL' ? ['/F'] : [])];

/**
 * A plain end on Windows is taskkill without /F: it asks the program's windows to close. A program with no window (a
 * console program, a server) is never asked, and Windows ends it only at once: so it is not tried, and the answer says
 * so (`noWindow`), where Linux and macOS would send it SIGTERM.
 */
export const NO_WINDOW = 'it has no window to be asked to close (a console program, which Windows can only end at once): use Force to end it';

/** `runner` (runSync's shape) is handed in by tests. */
export function killOwn(pid, signal, { runSync: runner = runSync } = {}) {
  const out = runner(POWERSHELL, psArgs(ownerScript(pid)), { timeout: 15_000 });
  const [owner, win] = out === null ? [] : out.trim().split(/\s+/);
  if (!owner) return { ok: false, error: 'no such process' };
  if (!sameUser(owner, mySid(runner))) return { ok: false, error: 'not your process' };
  if (signal !== 'SIGKILL' && win === 'nowindow') return { ok: false, error: NO_WINDOW, noWindow: true };
  const res = runner('taskkill', taskkillArgs(pid, signal), { timeout: 15_000 });
  return res === null ? { ok: false, error: signal === 'SIGKILL' ? 'taskkill refused' : 'the program did not agree to close; use force kill' } : { ok: true };
}

/** shutdown argv: /r restart, /s power off, /t 0 now. */
export const shutdownArgs = (action) => [action === 'reboot' ? '/r' : '/s', '/t', '0'];

export async function power(action) {
  const r = await run('shutdown', shutdownArgs(action), { env: process.env });
  return r.ok ? { ok: true } : { ok: false, error: r.stderr || 'refused' };
}

export const procParent = () => null;

/** JSON of [{ ProcessId, ParentProcessId }] → Map(pid → parent). */
export function parseParentsJson(json) {
  const map = new Map();
  for (const p of arr(JSON.parse(json))) map.set(Number(p.ProcessId), Number(p.ParentProcessId));
  return map;
}

/** Every process with its parent, as JSON [{ ProcessId, ParentProcessId }]; no module (see NO_MODULE_PRELUDE). */
export const PARENTS_SCRIPT = `${NO_MODULE_PRELUDE}$rows = [System.Collections.ArrayList]::new()
foreach ($p in (Rows 'root\\cimv2' 'SELECT ProcessId,ParentProcessId FROM Win32_Process')) { [void]$rows.Add(@{ ProcessId = [int]$p['ProcessId']; ParentProcessId = [int]$p['ParentProcessId'] }) }
Emit $rows.ToArray()
`;

export async function parentLookup() {
  const r = await ps(PARENTS_SCRIPT);
  try {
    return r.ok ? lookupFrom(parseParentsJson(r.stdout)) : procParent;
  } catch {
    return procParent;
  }
}
