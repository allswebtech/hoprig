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

// CPU is the average since the process started (CPU seconds / age), which is what `ps pcpu` shows on Linux too.
// The owner (GetOwnerSid: the account's SID, one plain ASCII string) is slow per process, so it is asked only for the processes that make the two top lists.
export const SNAPSHOT_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$now = Get-Date
$os = Get-CimInstance Win32_OperatingSystem
$raw = @(Get-CimInstance Win32_Process)
$procs = @($raw | ForEach-Object {
  $age = if ($_.CreationDate) { [math]::Max(1, [int]($now - $_.CreationDate).TotalSeconds) } else { 1 }
  [pscustomobject]@{
    pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; args = $_.CommandLine
    rss = [double]$_.WorkingSetSize; age = $age
    cpu = [math]::Round((([double]$_.KernelModeTime + [double]$_.UserModeTime) / 1e7) / $age * 100, 1)
  }
})
$pick = @($procs | Sort-Object cpu -Descending | Select-Object -First 13) + @($procs | Sort-Object rss -Descending | Select-Object -First 13)
$owners = @{}
foreach ($p in $pick) {
  if ($owners.ContainsKey([string]$p.pid)) { continue }
  $inst = $raw | Where-Object { $_.ProcessId -eq $p.pid } | Select-Object -First 1
  $o = if ($inst) { Invoke-CimMethod -InputObject $inst -MethodName GetOwnerSid } else { $null }
  $owners[[string]$p.pid] = if ($o -and $o.ReturnValue -eq 0) { $o.Sid } else { '' }
}
[pscustomobject]@{
  mem = [pscustomobject]@{ totalKB = [double]$os.TotalVisibleMemorySize; freeKB = [double]$os.FreePhysicalMemory }
  pagefiles = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { [pscustomobject]@{ sizeMB = [double]$_.AllocatedBaseSize; usedMB = [double]$_.CurrentUsage } })
  disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ id = $_.DeviceID; size = [double]$_.Size; free = [double]$_.FreeSpace } })
  procs = $procs
  owners = $owners
  ports = @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ addr = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })
} | ConvertTo-Json -Depth 4 -Compress
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
 * The SID of whoever runs this server, as the system names it (`whoami /user`), asked once and kept; null when the
 * system did not say. Never built from USERDOMAIN and USERNAME: in an SSH session to a local account USERDOMAIN says
 * WORKGROUP while Windows names the owner of that account's processes "PC\\me", so the person's own processes would
 * look like another user's. `runner` (runSync's shape: stdout or null) is handed in by tests.
 */
const asked = new Map();
export function mySid(runner = runSync) {
  if (asked.has(runner)) return asked.get(runner);
  const me = parseWhoami(runner(WHOAMI[0], WHOAMI[1], { timeout: 15_000 }));
  if (me) asked.set(runner, me.sid);
  return me ? me.sid : null;
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

/** The owner script for one pid: prints the owner's SID ('?' when Windows does not say), or nothing when there is no such process. */
export const ownerScript = (pid) => {
  if (!Number.isInteger(pid) || pid < 0) throw new Error('bad pid');
  return `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $o = Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid; if ($o.ReturnValue -eq 0) { $o.Sid } else { '?' } }`;
};

/** taskkill argv: without /F Windows asks the program to close; /F ends it at once. */
export const taskkillArgs = (pid, signal) => ['/PID', String(pid), ...(signal === 'SIGKILL' ? ['/F'] : [])];

/** `runner` (runSync's shape) is handed in by tests. */
export function killOwn(pid, signal, { runSync: runner = runSync } = {}) {
  const out = runner(POWERSHELL, psArgs(ownerScript(pid)), { timeout: 15_000 });
  const owner = out === null ? null : out.trim();
  if (!owner) return { ok: false, error: 'no such process' };
  if (!sameUser(owner, mySid(runner))) return { ok: false, error: 'not your process' };
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

export async function parentLookup() {
  const r = await ps('ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)');
  try {
    return r.ok ? lookupFrom(parseParentsJson(r.stdout)) : procParent;
  } catch {
    return procParent;
  }
}
