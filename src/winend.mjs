// The one way a process of a tree is ended on Windows: in ONE PowerShell call of plain .NET, no cmdlet (a cmdlet that
// loads a module took many seconds on a test runner), each process opened by its pid and its handle held before its
// start is read, so its number cannot be handed out again while it is compared and ended. A process that is gone, or
// whose start is not the one the caller saw, is another program by now and is not ended. Used by a run by itself
// (src/work/alone.mjs) and by a command's tree (src/cmdtree.mjs: a check, a go-live, a command Tia runs). It loads
// nothing, so it adds no load on Linux and macOS.

// Both starts are the system's own creation time of the process, read the same way: the caller's from WMI
// Win32_Process CreationDate (src/work/alone.mjs runTreeScript, src/cmdtree.mjs TREE_SCRIPT), this one from
// Process.StartTime (as src/procid.mjs creationScript), each through [DateTimeOffset] and ToUnixTimeMilliseconds, which
// cuts off what is below a millisecond. They are compared as equal, not within SAME_WITHIN (that margin is for Node's
// own start against the system's): a process that started a second later is another program. 1 ms is allowed for one
// reason only, and in one direction only: CreationDate carries microseconds, and a CIM provider that rounds the 100 ns
// system time to microseconds, not cuts it, can put the table's start into the next millisecond (the end call's start
// 1 ms BELOW the table's). An end call's start above the table's, by any amount, or more than END_SAME_MS below it, is
// another start.
export const END_SAME_MS = 1;

/**
 * The end call's script. entries: [{ pid, start, ppid }] as the table showed them. One that could not be ended keeps
 * every process above it in the list ("kept"). One line per pid: "<pid> ended", "gone", "other start", "failed" or
 * "kept" (parseEndLines).
 */
export const endBelowScript = (entries) => {
  const int = (n) => Number.isInteger(n) && n >= 0;
  if (!Array.isArray(entries) || !entries.length || entries.some((e) => !e || !Number.isInteger(e.pid) || e.pid <= 4 || !int(e.start) || !int(e.ppid))) throw new Error('bad entries');
  const flat = entries.flatMap((e) => [e.pid, e.start, e.ppid]);
  return `$ErrorActionPreference = 'SilentlyContinue'
$flat = @(${flat.join(', ')})
$up = @{}
for ($i = 0; $i -lt $flat.Length; $i += 3) { $up[[int]$flat[$i]] = [int]$flat[$i + 2] }
$keep = @{}
for ($i = 0; $i -lt $flat.Length; $i += 3) {
  $id = [int]$flat[$i]
  if ($keep.ContainsKey($id)) { [Console]::Out.WriteLine("$id kept"); continue }
  $p = $null
  try { $p = [System.Diagnostics.Process]::GetProcessById($id) } catch { $p = $null }
  if ($p -eq $null) { [Console]::Out.WriteLine("$id gone"); continue }
  $said = 'failed'
  try {
    $h = $p.Handle
    if ($p.HasExited) { $said = 'gone' }
    else {
      $s = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()
      $d = $s - [long]$flat[$i + 1]
      if ($d -gt 0 -or $d -lt -${END_SAME_MS}) { $said = 'other start' }
      else { $p.Kill(); $said = 'ended' }
    }
  } catch {
    try { if ($p.HasExited) { $said = 'gone' } } catch {}
  }
  if ($said -eq 'failed') { $q = $up[$id]; while ($q -ne $null -and $up.ContainsKey($q) -and -not $keep.ContainsKey($q)) { $keep[$q] = $true; $q = $up[$q] } }
  [Console]::Out.WriteLine("$id $said")
  try { $p.Dispose() } catch {}
}`;
};

/** The lines of endBelowScript → Map(pid → its word), for each pid asked: one without a line of its own is "failed". */
export function parseEndLines(out, pids) {
  const said = new Map();
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^(\d+) (ended|gone|other start|failed|kept)$/.exec(line.trim());
    if (m && !said.has(Number(m[1]))) said.set(Number(m[1]), m[2]);
  }
  return new Map(pids.map((x) => [x, said.get(x) || 'failed']));
}

/** A PowerShell call's arguments for `script`, as the product calls it (no profile; no module loads). */
export const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

/**
 * End `entries` ([{ pid, start, ppid }], each with the start the caller's table showed) in one end call through
 * `run(cmd, args)` → { ok, out }. → Map(pid → its word). An answer that cannot be read, or a call that fails, is
 * "failed" for every pid: never taken as ended.
 */
export async function endHeld(entries, run) {
  const pids = entries.map((e) => e.pid);
  let out = '';
  try {
    const k = await run('powershell.exe', psArgs(endBelowScript(entries)));
    out = k && k.ok !== false ? k.out : '';
  } catch {
    out = '';
  }
  return parseEndLines(out, pids);
}
