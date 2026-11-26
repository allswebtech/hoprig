// Windows parts of the desktop's system apps (src/desktop): every process with the CPU time it used, memory,
// disks, listening ports and network counters through PowerShell (JSON), and the services, read-only: a service is
// changed with administrator rights, and those cannot be handed to a program with a password the way sudo takes
// one, so the page says to use an administrator terminal. Windows has no journal; Logs reads the log files.
//
// `io` as in linux-system.mjs. Scripts are fixed text sent with -EncodedCommand; nothing from the page goes into
// one. Written to the same shape as the Linux part; checked by the tests with recorded output, not yet run on Windows.
import os from 'node:os';
import path from 'node:path';
import { redact, uniquePorts } from './common.mjs';
import { NO_MODULE_PRELUDE, POWERSHELL, psArgs } from './win32.mjs';

const arr = (x) => (Array.isArray(x) ? x : x === null || x === undefined ? [] : [x]);
const ps = (io, script) => io.run(POWERSHELL, psArgs(script), { timeout: 30_000, env: process.env });
const json = (r) => {
  if (!r.ok) throw new Error(r.stderr || 'PowerShell failed');
  return arr(JSON.parse(r.stdout || '[]'));
};

// Every process as a JSON array; no module is loaded for it (win32.mjs NO_MODULE_PRELUDE: WMI through System.Management
// and .NET's JSON, where Get-CimInstance and ConvertTo-Json cost Windows PowerShell 5.1 about 17 s at its first call).
export const PROCESSES_SCRIPT = `${NO_MODULE_PRELUDE}$now = [DateTime]::Now
$rows = [System.Collections.ArrayList]::new()
foreach ($p in (Rows 'root\\cimv2' 'SELECT ProcessId,ParentProcessId,Name,CommandLine,WorkingSetSize,CreationDate,KernelModeTime,UserModeTime FROM Win32_Process')) {
  $age = 0
  if ($p['CreationDate']) { $age = [int]($now - [System.Management.ManagementDateTimeConverter]::ToDateTime($p['CreationDate'])).TotalSeconds }
  [void]$rows.Add(@{ pid = [int]$p['ProcessId']; ppid = [int]$p['ParentProcessId']; name = [string]$p['Name']; args = $p['CommandLine']; rss = [double]$p['WorkingSetSize']; cpu = ([double]$p['KernelModeTime'] + [double]$p['UserModeTime']) / 1e7; age = $age })
}
Emit $rows.ToArray()
`;

/** PROCESSES_SCRIPT's JSON → processes. The owner is not asked (one slow call per process): user is null. */
export const parseWinProcesses = (text) =>
  arr(JSON.parse(text || '[]')).map((p) => ({ pid: Number(p.pid), ppid: Number(p.ppid), uid: null, user: null, name: p.name || '', args: redact(p.args || p.name || '', 300), rss: Number(p.rss) || 0, age: Number(p.age) || 0, cpuTime: Number.isFinite(Number(p.cpu)) ? Number(p.cpu) : null }));

export async function processes(io) {
  const r = await ps(io, PROCESSES_SCRIPT);
  if (!r.ok) throw new Error(r.stderr || 'PowerShell failed');
  return parseWinProcesses(r.stdout);
}

export const memory = () => ({ total: os.totalmem(), available: os.freemem(), swapTotal: null, swapFree: null });

// The scripts below load no PowerShell module either (win32.mjs NO_MODULE_PRELUDE): each was a module's cmdlet before
// (Get-CimInstance, Get-NetTCPConnection, Get-NetAdapterStatistics, Get-Service, Get-Process), about 17 s at its first
// call in a PowerShell whose module cache is not kept. The same facts come from the WMI classes those cmdlets read, or
// from .NET; the JSON keys are the ones the cmdlets' JSON had, so the readers below did not change.

/** The fixed disks: [{ DeviceID, Size, FreeSpace }] (Win32_LogicalDisk, DriveType 3, as Get-CimInstance gave it). */
export const DISKS_SCRIPT = `${NO_MODULE_PRELUDE}$rows = [System.Collections.ArrayList]::new()
foreach ($d in (Rows 'root\\cimv2' 'SELECT DeviceID,Size,FreeSpace FROM Win32_LogicalDisk WHERE DriveType=3')) { [void]$rows.Add(@{ DeviceID = [string]$d['DeviceID']; Size = [double]$d['Size']; FreeSpace = [double]$d['FreeSpace'] }) }
Emit $rows.ToArray()
`;

/**
 * The listening TCP ports: [{ addr, port, pid, process }]. MSFT_NetTCPConnection (State 2: Listen) is the class
 * Get-NetTCPConnection reads; the program's name from .NET's list of processes, as Get-Process gave it.
 */
export const PORTS_SCRIPT = `${NO_MODULE_PRELUDE}$n = @{}
foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { $n[[string]$p.Id] = $p.ProcessName }
$rows = [System.Collections.ArrayList]::new()
foreach ($c in (Rows 'root\\StandardCimv2' 'SELECT LocalAddress,LocalPort,OwningProcess FROM MSFT_NetTCPConnection WHERE State=2')) { [void]$rows.Add(@{ addr = [string]$c['LocalAddress']; port = [int]$c['LocalPort']; pid = [int]$c['OwningProcess']; process = $n[[string]$c['OwningProcess']] }) }
Emit $rows.ToArray()
`;

/** Each network adapter's counters: [{ Name, ReceivedBytes, SentBytes }] (MSFT_NetAdapterStatisticsSettingData, the class Get-NetAdapterStatistics reads). */
export const NET_SCRIPT = `${NO_MODULE_PRELUDE}$rows = [System.Collections.ArrayList]::new()
foreach ($a in (Rows 'root\\StandardCimv2' 'SELECT Name,ReceivedBytes,SentBytes FROM MSFT_NetAdapterStatisticsSettingData')) { [void]$rows.Add(@{ Name = [string]$a['Name']; ReceivedBytes = [double]$a['ReceivedBytes']; SentBytes = [double]$a['SentBytes'] }) }
Emit $rows.ToArray()
`;

/**
 * The services: [{ Name, DisplayName, Status, StartType }], the enums as numbers as Windows PowerShell 5.1 wrote them
 * (ServiceControllerStatus 1 to 7, ServiceStartMode 0 to 4), from .NET's ServiceController, which Get-Service wraps.
 */
export const SERVICES_SCRIPT = `${NO_MODULE_PRELUDE}[void][System.Reflection.Assembly]::LoadWithPartialName('System.ServiceProcess')
$rows = [System.Collections.ArrayList]::new()
foreach ($s in [System.ServiceProcess.ServiceController]::GetServices()) { $t = $null; try { $t = [int]$s.StartType } catch {}; [void]$rows.Add(@{ Name = [string]$s.ServiceName; DisplayName = [string]$s.DisplayName; Status = [int]$s.Status; StartType = $t }) }
Emit $rows.ToArray()
`;

export async function disks(io) {
  const rows = json(await ps(io, DISKS_SCRIPT));
  return rows.filter((x) => Number(x.Size) > 0).map((x) => ({ fs: x.DeviceID, mount: `${x.DeviceID}\\`, size: Number(x.Size), used: Number(x.Size) - Number(x.FreeSpace), avail: Number(x.FreeSpace) }));
}

export async function ports(io) {
  const rows = json(await ps(io, PORTS_SCRIPT));
  return uniquePorts(rows.map((x) => ({ addr: String(x.addr || ''), port: Number(x.port), process: x.process || '', pid: Number(x.pid) || null })));
}

export const parseAdapterStats = (text) => arr(JSON.parse(text || '[]')).map((x) => ({ name: String(x.Name || ''), rx: Number(x.ReceivedBytes) || 0, tx: Number(x.SentBytes) || 0 }));

export async function net(io) {
  const r = await ps(io, NET_SCRIPT);
  return r.ok ? parseAdapterStats(r.stdout) : [];
}

// ---------- services (read-only) ----------

// Windows PowerShell 5.1 writes these enums as numbers.
const STATUS = { 1: 'inactive', 2: 'activating', 3: 'deactivating', 4: 'active', 5: 'activating', 6: 'deactivating', 7: 'inactive' };
const STATUS_TEXT = { 1: 'stopped', 2: 'starting', 3: 'stopping', 4: 'running', 5: 'resuming', 6: 'pausing', 7: 'paused' };
const START = { 0: 'boot', 1: 'system', 2: 'enabled', 3: 'manual', 4: 'disabled' };

/** SERVICES_SCRIPT's JSON (the shape `Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json` had) → services. */
export function parseWinServices(text) {
  return arr(JSON.parse(text || '[]')).map((s) => {
    const st = typeof s.Status === 'number' ? s.Status : { Stopped: 1, StartPending: 2, StopPending: 3, Running: 4, ContinuePending: 5, PausePending: 6, Paused: 7 }[s.Status] || 1;
    const start = typeof s.StartType === 'number' ? START[s.StartType] : String(s.StartType || '').toLowerCase() || null;
    return { name: String(s.Name || ''), description: String(s.DisplayName || ''), active: STATUS[st], sub: STATUS_TEXT[st], enabled: start === 'automatic' ? 'enabled' : start };
  }).filter((s) => s.name);
}

export const services = {
  scopes: ['system'],
  readOnly: true,
  nameOk: (name) => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.$-]{0,79}$/.test(name),
  isSsh: (name) => name.toLowerCase() === 'sshd',
  own: () => new Set(),
  async list(io) {
    const r = await ps(io, SERVICES_SCRIPT);
    if (!r.ok) return { available: false, note: `The services cannot be read here (${(r.stderr || 'PowerShell failed').split('\n')[0]}).`, services: [] };
    return { available: true, note: null, services: parseWinServices(r.stdout).sort((a, b) => a.name.localeCompare(b.name)) };
  },
  argv: () => null,
  logs: async () => ({ available: true, entries: [], note: 'The services\' events are in the Windows event viewer.' }),
};

export const journal = null;

export const logDirs = (env = process.env) => [path.win32.join(env.SystemRoot || 'C:\\Windows', 'Logs')];
