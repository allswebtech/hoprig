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
import { POWERSHELL, psArgs } from './win32.mjs';

const arr = (x) => (Array.isArray(x) ? x : x === null || x === undefined ? [] : [x]);
const ps = (io, script) => io.run(POWERSHELL, psArgs(script), { timeout: 30_000, env: process.env });
const json = (r) => {
  if (!r.ok) throw new Error(r.stderr || 'PowerShell failed');
  return arr(JSON.parse(r.stdout || '[]'));
};

export const PROCESSES_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$now = Get-Date
@(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{
  pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; args = $_.CommandLine
  rss = [double]$_.WorkingSetSize; cpu = ([double]$_.KernelModeTime + [double]$_.UserModeTime) / 1e7
  age = if ($_.CreationDate) { [int]($now - $_.CreationDate).TotalSeconds } else { 0 } } }) | ConvertTo-Json -Compress`;

/** PROCESSES_SCRIPT's JSON → processes. The owner is not asked (one slow call per process): user is null. */
export const parseWinProcesses = (text) =>
  arr(JSON.parse(text || '[]')).map((p) => ({ pid: Number(p.pid), ppid: Number(p.ppid), uid: null, user: null, name: p.name || '', args: redact(p.args || p.name || '', 300), rss: Number(p.rss) || 0, age: Number(p.age) || 0, cpuTime: Number.isFinite(Number(p.cpu)) ? Number(p.cpu) : null }));

export async function processes(io) {
  const r = await ps(io, PROCESSES_SCRIPT);
  if (!r.ok) throw new Error(r.stderr || 'PowerShell failed');
  return parseWinProcesses(r.stdout);
}

export const memory = () => ({ total: os.totalmem(), available: os.freemem(), swapTotal: null, swapFree: null });

export async function disks(io) {
  const rows = json(await ps(io, "@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,Size,FreeSpace) | ConvertTo-Json -Compress"));
  return rows.filter((x) => Number(x.Size) > 0).map((x) => ({ fs: x.DeviceID, mount: `${x.DeviceID}\\`, size: Number(x.Size), used: Number(x.Size) - Number(x.FreeSpace), avail: Number(x.FreeSpace) }));
}

export async function ports(io) {
  const rows = json(await ps(io, "$n = @{}; Get-Process | ForEach-Object { $n[[string]$_.Id] = $_.ProcessName }; @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ addr = $_.LocalAddress; port = [int]$_.LocalPort; pid = [int]$_.OwningProcess; process = $n[[string]$_.OwningProcess] } }) | ConvertTo-Json -Compress"));
  return uniquePorts(rows.map((x) => ({ addr: String(x.addr || ''), port: Number(x.port), process: x.process || '', pid: Number(x.pid) || null })));
}

export const parseAdapterStats = (text) => arr(JSON.parse(text || '[]')).map((x) => ({ name: String(x.Name || ''), rx: Number(x.ReceivedBytes) || 0, tx: Number(x.SentBytes) || 0 }));

export async function net(io) {
  const r = await ps(io, '@(Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes) | ConvertTo-Json -Compress');
  return r.ok ? parseAdapterStats(r.stdout) : [];
}

// ---------- services (read-only) ----------

// Windows PowerShell 5.1 writes these enums as numbers.
const STATUS = { 1: 'inactive', 2: 'activating', 3: 'deactivating', 4: 'active', 5: 'activating', 6: 'deactivating', 7: 'inactive' };
const STATUS_TEXT = { 1: 'stopped', 2: 'starting', 3: 'stopping', 4: 'running', 5: 'resuming', 6: 'pausing', 7: 'paused' };
const START = { 0: 'boot', 1: 'system', 2: 'enabled', 3: 'manual', 4: 'disabled' };

/** `Get-Service | Select-Object Name,DisplayName,Status,StartType | ConvertTo-Json` → services. */
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
    const r = await ps(io, '@(Get-Service | Select-Object Name,DisplayName,Status,StartType) | ConvertTo-Json -Compress');
    if (!r.ok) return { available: false, note: `The services cannot be read here (${(r.stderr || 'PowerShell failed').split('\n')[0]}).`, services: [] };
    return { available: true, note: null, services: parseWinServices(r.stdout).sort((a, b) => a.name.localeCompare(b.name)) };
  },
  argv: () => null,
  logs: async () => ({ available: true, entries: [], note: 'The services\' events are in the Windows event viewer.' }),
};

export const journal = null;

export const logDirs = (env = process.env) => [path.win32.join(env.SystemRoot || 'C:\\Windows', 'Logs')];
