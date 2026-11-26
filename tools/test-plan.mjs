// What tools/test.mjs hands `node --test`, and how it checks that what ran is what it meant to run.
//
// The runner once put every test file on the command line, one absolute path each. Windows allows a command line of
// at most 32,767 characters, and about 1,100 paths are three times that: both Windows jobs ended at the start with
// `spawn ENAMETOOLONG`. So a folder goes to `node --test` as ONE glob pattern (`test/**/*.test.mjs`), which Node
// expands itself from 22.11 (the lowest Hoprig supports) on every system; a file named on its own stays a file. The
// runner still lists the files itself, the same way Node's glob finds them (no `node_modules`, no folder whose name
// starts with a dot), so that it can prove every file it meant to run sent all its results, and that no file it did
// not mean to run added to the totals.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** The command line Windows allows is 32,767 characters; this much is left for the files and patterns. */
export const WINDOWS_LINE = 30_000;

// A folder whose own name holds one of these would be read as a pattern: its files are named one by one instead.
const PATTERN_CHARS = /[*?[\]{}()!+@\\]/;

/** Every `*.test.mjs` under the folder `full`, as Node's glob finds them, sorted so a run is the same each time. */
export function findTests(full) {
  if (statSync(full).isFile()) return { isFile: true, files: [full] };
  const files = readdirSync(full, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.test.mjs'))
    .map((e) => path.join(e.parentPath ?? e.path, e.name))
    .filter((f) => !path.relative(full, f).split(/[\\/]/).some((part) => part === 'node_modules' || part.startsWith('.')))
    .sort();
  return { isFile: false, files };
}

/**
 * What to hand `node --test` for `places` (folders or files, relative to `root`; none means `test`).
 * → { files: every test file it means to run (absolute), args: what goes on the command line, line: their length,
 *     tooLong: a sentence when the line is over what this system allows, else null }
 * `platform` and `find` are the system's answers, so a test can give Windows' own.
 */
export function testArgs(places, { root, platform = process.platform, find = findTests }) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const files = new Set();
  const args = [];
  const inside = (rel) => rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
  for (const place of places.length ? places : ['test']) {
    const full = p.resolve(root, place);
    const found = find(full);
    for (const f of found.files) files.add(f);
    const rel = p.relative(root, full);
    const slashed = rel.split(p.sep).join('/');
    if (found.isFile) args.push(inside(rel) && !PATTERN_CHARS.test(slashed) ? slashed : full);
    else if (inside(rel) && !PATTERN_CHARS.test(slashed)) args.push(slashed ? `${slashed}/**/*.test.mjs` : '**/*.test.mjs');
    else args.push(...found.files);
  }
  const line = args.reduce((n, a) => n + a.length + 3, 0); // a space and two quotes each
  const tooLong = platform === 'win32' && line > WINDOWS_LINE
    ? `The test files named one by one make a command line of ${line} characters, more than Windows allows (${WINDOWS_LINE}); name their folder instead (node tools/test.mjs test/server).`
    : null;
  return { files: [...files], args, line, tooLong };
}

/**
 * The part `no` of `of` of a plan (`--part=2/3`: every third file of its list, from the second): a pattern would run
 * every file, so a part names its own files, relative to `root` where they are inside it. A whole run (`of` 1) is the
 * plan as it is. The length is checked again: a part of many files is refused on Windows as the plan would be.
 */
export function partOfPlan(plan, no, of, { root, platform = process.platform } = {}) {
  if (of <= 1) return plan;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const files = plan.files.filter((_, i) => i % of === no - 1);
  const args = files.map((f) => {
    const rel = p.relative(root, f);
    return rel && rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel) ? rel.split(p.sep).join('/') : f;
  });
  const line = args.reduce((n, a) => n + a.length + 3, 0);
  const tooLong = platform === 'win32' && line > WINDOWS_LINE
    ? `Part ${no} of ${of} names its ${files.length} test files one by one, a command line of ${line} characters, more than Windows allows (${WINDOWS_LINE}); run it in more parts.`
    : null;
  return { files, args, line, tooLong };
}

/**
 * Windows: where PowerShell keeps its module cache for this run. Every test file has a home of its own, so PowerShell
 * rebuilt the cache in each (seconds per start: a 15 s look at a process's identity came back empty) and wrote it into
 * the test's home (`AppData\Local\Microsoft\Windows\PowerShell\ModuleAnalysisCache`), where a check that nothing
 * changed then found it. One file in the run's own temporary folder, shared by every test file and every child (the
 * seal carries it: tools/seal-core.cjs SEAL_VARS). → the variable to set, or null on another system.
 */
export function psModuleCache(sandbox, { platform = process.platform } = {}) {
  if (platform !== 'win32') return null;
  return { PSModuleAnalysisCachePath: path.win32.join(sandbox, 'powershell', 'ModuleAnalysisCache') };
}

/**
 * Windows: the module cache this run uses, and whether the runner must write it first. A runner started from inside a
 * test (test/seal.test.mjs) is handed the outer run's cache: when that file is there it is used as it is, and not
 * written again. → { vars, warm } or null on another system. `inherited`, `exists`: the system's answers.
 */
export function psCachePlan(sandbox, { platform = process.platform, nested = false, inherited = null, exists = () => false } = {}) {
  if (platform !== 'win32') return null;
  // Only from an outer run of the suite (`nested`): a cache path of the person's own is never used.
  if (nested && typeof inherited === 'string' && inherited && exists(inherited)) return { vars: { PSModuleAnalysisCachePath: inherited }, warm: false };
  return { vars: psModuleCache(sandbox, { platform }), warm: true };
}

/**
 * Windows: the one PowerShell call that writes the run's module cache before any test starts. Measured on a Windows
 * runner: every call that loads a module (Get-CimInstance, Get-Process) took 17 to 19 s, warm too, "Preparing modules
 * for first use" each time, while `powershell -Command 1` took 225 ms. Windows PowerShell analyses the modules and
 * writes what it found to the cache file only a while later, so a short call has ended before that, and the next one
 * analyses again. This call loads every module there is (Get-Command) and the cmdlets the product uses, then stays
 * until the file is there, at most `waitMs`; it says "written" or "missing". → { command, args, timeout } or null.
 */
export function psWarmCall({ platform = process.platform, waitMs = 30_000 } = {}) {
  if (platform !== 'win32') return null;
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$ProgressPreference = 'SilentlyContinue'",
    'Get-Command -CommandType Cmdlet, Function | Out-Null',
    'Get-Process -Id $PID | Out-Null',
    'Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $PID" | Out-Null',
    '$f = $env:PSModuleAnalysisCachePath',
    `$end = (Get-Date).AddMilliseconds(${waitMs})`,
    'while (-not (Test-Path -LiteralPath $f) -and (Get-Date) -lt $end) { Start-Sleep -Milliseconds 250 }',
    'Start-Sleep -Milliseconds 1000',
    "if (Test-Path -LiteralPath $f) { 'written' } else { 'missing' }",
  ].join('\n');
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  return { command: 'powershell.exe', args, timeout: waitMs + 90_000 };
}

/**
 * Windows: the temporary folder by its long name. A runner of Windows may name it in the old short form
 * (`C:\Users\EXAMPL~1\AppData\Local\Temp`), while git and the system's own real path give the long one
 * (`C:\Users\example.user\…`); a path made from one and compared with the other then lies "outside the repository".
 * → the values to set for TEMP and TMP, or null where nothing changes (another system, or the name is long already).
 * `realpath` is the system's answer (fs.realpathSync.native on Windows), so a test can give Windows' own.
 */
export function longTemp(env, { platform = process.platform, realpath } = {}) {
  if (platform !== 'win32') return null;
  const now = env.TEMP || env.TMP;
  if (!now || !/~\d/.test(now)) return null;
  let long;
  try {
    long = realpath(now);
  } catch {
    return null;
  }
  return long && long !== now ? { TEMP: long, TMP: long } : null;
}

/**
 * The files of `seen` (absolute paths Node reported results for) that the runner did not mean to run: their results
 * are in the totals but no check of the runner's holds them.
 */
export function unlisted(files, seen) {
  const meant = new Set(files);
  return seen.filter((f) => !meant.has(f));
}
