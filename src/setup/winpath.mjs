// Windows: the Path the system has NOW. A process keeps the copy of Path it got when it started, so a program that
// winget installed a moment ago (it adds its folder to the user's or the machine's Path in the registry) is "missing"
// for the rest of the run, and for a dashboard that runs, until it is started again. Here the two Path values are read
// from the registry (where Windows builds a new process's Path from: the machine's, then the user's), expanded, and
// every folder this process does not have yet is added to its PATH. Nothing is taken away: folders a process got
// otherwise (a terminal's own additions) stay.
import { capture } from './system.mjs';

export const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
export const USER_KEY = 'HKCU\\Environment';

// Every value of both keys, as stored (not expanded), in one PowerShell call printed as JSON. Every letter beyond ASCII
// is written as a \uXXXX escape, so the console's code page (reg.exe and PowerShell write in it; Node reads UTF-8)
// never garbles a folder such as C:\Users\José.
export const ENV_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$out = @{}
foreach ($k in @(@('machine', 'Registry::${MACHINE_KEY}'), @('user', 'Registry::${USER_KEY}'))) {
  $key = Get-Item -LiteralPath $k[1]
  if ($key) {
    $vals = @{}
    foreach ($n in $key.GetValueNames()) {
      if ($n) { $vals[$n] = @{ kind = [string]$key.GetValueKind($n); value = [string]$key.GetValue($n, $null, 'DoNotExpandEnvironmentNames') } }
    }
    $out[$k[0]] = $vals
  }
}
$json = $out | ConvertTo-Json -Depth 4 -Compress
[regex]::Replace($json, '[^\\x00-\\x7F]', { param($m) '\\u{0:x4}' -f [int][char]$m.Value })`;

/** The argv that runs ENV_SCRIPT (the script as -EncodedCommand: nothing of it is read through a code page either). */
export const envQuery = () => ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(ENV_SCRIPT, 'utf16le').toString('base64')];

/** ENV_SCRIPT's output → { machine, user } (each { name: { kind, value } }, or null for a key it could not read), or null. */
export function parseEnvKeys(out) {
  let d;
  try {
    d = JSON.parse(String(out || '').trim());
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object') return null;
  const one = (o) => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, v]) => v && typeof v.value === 'string').map(([k, v]) => [k, { kind: String(v.kind || ''), value: v.value }])) : null);
  const keys = { machine: one(d.machine), user: one(d.user) };
  return keys.machine || keys.user ? keys : null;
}

/** %NAME% replaced by its value in `env` (names without case, as Windows reads them); an unknown name stays as it is. */
export function expandVars(text, env) {
  const lower = new Map(Object.entries(env || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return String(text).replace(/%([^%;]+)%/g, (all, name) => (lower.has(name.toLowerCase()) ? String(lower.get(name.toLowerCase())) : all));
}

/** One Path entry as Windows compares it: no quotes, no trailing backslash, no case. */
const key = (dir) => dir.replace(/"/g, '').replace(/[\\/]+$/, '').toLowerCase();

/** The folders of a Path value: quotes taken off, empty ones (a trailing ";") dropped. */
export const pathEntries = (value) => String(value || '').split(';').map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);

/** `current` (this process's PATH) with every folder of `fresh` it lacks added at the end, in fresh's order. */
export function mergePath(current, fresh) {
  const have = new Set(pathEntries(current).map(key));
  const added = [];
  for (const d of pathEntries(fresh)) {
    if (have.has(key(d))) continue;
    have.add(key(d));
    added.push(d);
  }
  return { path: [String(current || '').replace(/;+$/, ''), ...added].filter(Boolean).join(';'), added };
}

/** Whether a Path folder is a whole path (a drive and a backslash, or \\server\share): anything else is searched from
 * whichever folder a program runs in. */
const absolute = (dir) => /^[A-Za-z]:[\\/]|^\\\\[^\\]/.test(dir);

/**
 * The Path a process started now would get, built as Windows builds a new environment: `env` (what comes from the
 * profile and the system: USERPROFILE, SystemRoot …), then the machine's variables, then the user's, each kind
 * ExpandString expanded with what is defined by then; then the machine's Path and the user's Path joined, expanded with
 * all of it. So a variable an installer just defined (NVM_HOME) is known in the Path that names it. A folder that
 * still holds a %NAME% or is not a whole path is left out. null when the registry could not be read.
 */
export function pathFromKeys(keys, env = {}) {
  if (!keys) return null;
  const vars = { ...env };
  const set = (name, value) => {
    for (const k of Object.keys(vars)) if (k.toLowerCase() === name.toLowerCase()) delete vars[k];
    vars[name] = value;
  };
  for (const scope of [keys.machine, keys.user]) {
    const list = Object.entries(scope || {}).filter(([n]) => n.toLowerCase() !== 'path');
    for (const [n, v] of list) if (v.kind !== 'ExpandString') set(n, v.value);
    for (const [n, v] of list) if (v.kind === 'ExpandString') set(n, expandVars(v.value, vars));
  }
  const pathOf = (scope) => {
    const e = Object.entries(scope || {}).find(([n]) => n.toLowerCase() === 'path');
    return e ? (e[1].kind === 'ExpandString' ? expandVars(e[1].value, vars) : e[1].value) : '';
  };
  return pathEntries(`${pathOf(keys.machine)};${pathOf(keys.user)}`).filter((d) => !d.includes('%') && absolute(d)).join(';');
}

/**
 * The machine's and the user's Path from the registry (pathFromKeys), or null when it could not be read.
 * `run(argv)` → { ok, stdout } (capture(); tests hand in a made-up registry).
 */
export async function systemPath({ env = process.env, run = (argv) => capture(argv, { env, timeout: 15_000 }) } = {}) {
  const r = await run(envQuery());
  return pathFromKeys(r && r.ok ? parseEnvKeys(r.stdout) : null, env);
}

/**
 * Bring `env.PATH` up to what the system has now. Returns the folders added ([] when there were none, or the
 * registry could not be read).
 */
export async function refreshPath(env = process.env, { run } = {}) {
  const fresh = await systemPath({ env, run });
  if (fresh === null) return [];
  const { path, added } = mergePath(env.PATH ?? env.Path ?? '', fresh);
  if (added.length) env.PATH = path;
  return added;
}

/** How often a look of its own reads the registry again (a dashboard looks for tools often): once a minute at most. */
export const PATH_EVERY = 60_000;
const lastRead = new WeakMap();

/**
 * refreshPath, kept cheap for a process that looks often: the registry is read again for the same `env` at most once
 * per `every` ms, and always when `force` is set (after an install this process ran). Returns the folders added.
 */
export async function pathNow(env = process.env, { run, force = false, now = Date.now(), every = PATH_EVERY } = {}) {
  const at = lastRead.get(env);
  if (!force && at !== undefined && now - at < every) return [];
  lastRead.set(env, now);
  return refreshPath(env, { run });
}
