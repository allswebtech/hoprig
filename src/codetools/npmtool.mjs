// A coding tool that Hoprig installs from npm into a folder of its own: <toolsDir>/<id> is an npm prefix that holds
// that tool and nothing else. Never `npm install -g`: the owner's global packages and PATH stay as they are, and two
// Hoprig installs on one computer cannot fight over one copy.
//
// While npm runs (and while the new program is asked for its version), the tool's own folders point into a throwaway
// folder inside the tools folder: an install script that starts the program would otherwise create its config, data,
// state and cache folders in the home folder (seen with OpenCode 2, whose install script runs `opencode --version`).
// The throwaway folder is removed afterwards. Provider keys are never handed to npm or to an install script.
//
// The version facts come from the installed package.json (no program is started to read them) and from the npm
// registry's dist-tags for the newest one.
import fs from 'node:fs';
import path from 'node:path';
import { toolsDir } from '../paths.mjs';
import { takeLock } from './lock.mjs';
import { withoutSecrets } from '../secretenv.mjs';
import { capture, compareVersions, npmArgv, showCommand, stream } from '../setup/system.mjs';

export const REGISTRY = 'https://registry.npmjs.org';
export const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const LOOKUP_TTL_MS = 5 * 60_000;
const LOOKUP_FAIL_TTL_MS = 60_000;
const lookups = new Map();

/** Forget the cached registry answers (after an install, and in tests). */
export const clearLookups = () => lookups.clear();

/** The newest version of `pkg` on the npm registry (dist-tag "latest"), or null when it cannot be found out. Cached. */
export async function registryLatest(pkg, { fetchImpl = globalThis.fetch, now = Date.now(), fresh = false } = {}) {
  const hit = lookups.get(pkg);
  if (!fresh && hit && now - hit.at < (hit.value ? LOOKUP_TTL_MS : LOOKUP_FAIL_TTL_MS)) return hit.value;
  let value = null;
  try {
    const res = await fetchImpl(`${REGISTRY}/-/package/${pkg}/dist-tags`, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
    if (res.ok) {
      const v = JSON.parse(await res.text()).latest;
      value = typeof v === 'string' && VERSION_RE.test(v) ? v : null;
    }
  } catch {
    value = null; // offline, timeout, not JSON: "unknown", never a guess
  }
  lookups.set(pkg, { at: now, value });
  return value;
}

/** The environment for npm and the version check: the caller's, minus every secret (../secretenv.mjs), plus the tool's own folders. */
export function installEnv(base, own) {
  return { ...withoutSecrets(base), ...own };
}

/** The prefix's own package.json: private, and naming the one install script that may run (or none). */
export function writePrefixPackage(dir, scriptOf) {
  const file = path.join(dir, 'package.json');
  let j = {};
  try {
    j = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    j = {};
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) j = {};
  j.private = true;
  if (scriptOf) j.allowScripts = { [scriptOf]: true };
  else delete j.allowScripts;
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
}

/**
 * The parts every npm-installed tool shares. `spec`:
 *   id, name, pkg (npm package), pin (the version this Hoprig is tested with and installs first), binName,
 *   parseVersion(text) → version | null (what `<bin> --version` prints),
 *   isolate(dir) → env: the tool's own folders inside `dir` (see the header),
 *   npmFlags (optional): more flags for `npm install`,
 *   allowScript (optional): the package's install script must run. npm 11 warns about scripts not named in the
 *     prefix's package.json "allowScripts", and newer npm does not run them: exactly this package at this version
 *     is named there (the same field Hoprig's own package.json uses for its terminal module)
 */
export function npmTool(spec) {
  const { id, name, pkg, pin, binName, parseVersion, isolate, npmFlags = [], allowScript = false } = spec;
  const dir = () => path.join(toolsDir(), id);
  const binPath = (platform = process.platform) => path.join(dir(), 'node_modules', '.bin', platform === 'win32' ? `${binName}.cmd` : binName);
  const pkgFile = () => path.join(dir(), 'node_modules', ...pkg.split('/'), 'package.json');
  const lockDir = () => path.join(toolsDir(), `.${id}.lock`);

  /**
   * The command line that starts the tool with `args`. Started from the file the package names, not npm's shim in
   * .bin: on Windows that shim is a .cmd file, which Node does not start without a shell. A JavaScript entry is
   * started with this Node (Codex), a native program as it is (OpenCode).
   */
  function toolArgv(args = []) {
    let entry = null;
    try {
      const j = JSON.parse(fs.readFileSync(pkgFile(), 'utf8'));
      const rel = typeof j.bin === 'string' ? j.bin : j.bin && j.bin[binName];
      if (typeof rel === 'string') entry = path.resolve(path.dirname(pkgFile()), rel);
    } catch {
      entry = null;
    }
    if (!entry || !entry.startsWith(dir() + path.sep)) return [binPath(), ...args];
    return /\.[cm]?js$/i.test(entry) ? [process.execPath, entry, ...args] : [entry, ...args];
  }

  /** The installed version, from the package itself; null when it is not there (or its program is missing). */
  function installedVersion() {
    try {
      const v = JSON.parse(fs.readFileSync(pkgFile(), 'utf8')).version;
      return typeof v === 'string' && VERSION_RE.test(v) && fs.existsSync(binPath()) ? v : null;
    } catch {
      return null;
    }
  }

  /** { installed, path, latest, method, pinned, updateAvailable } in the shape claudeInfo() has. */
  async function info({ fetchImpl, fresh = false } = {}) {
    const installed = installedVersion();
    const latest = await registryLatest(pkg, { fetchImpl, fresh });
    return {
      installed,
      path: installed ? binPath() : null,
      latest,
      method: 'hoprig',
      pinned: pin,
      updateAvailable: !!(installed && latest && compareVersions(latest, installed) > 0),
    };
  }

  /**
   * Install `version` (default: the pinned one) into the tool's folder, then ask the new program for its version.
   * { ok, version, output }. `run` and `check` are stream() and capture() (tests pass stand-ins).
   */
  async function install({ version = pin, onLine = () => {}, run = stream, check = capture, env = process.env } = {}) {
    const lines = [];
    const say = (l) => {
      lines.push(l);
      onLine(l);
    };
    if (!VERSION_RE.test(String(version))) {
      say(`"${version}" is not a version (like ${pin}).`);
      return { ok: false, version: installedVersion(), output: lines.join('\n') };
    }
    // One npm at a time in a tool's folder, whoever asks: the page, Setup and the command line are separate
    // processes, and two installs into one prefix break each other.
    const release = await takeLock(lockDir(), { staleMs: 30 * 60_000 });
    if (!release) {
      say(`Another install or update of ${name} is running right now. Nothing changed.`);
      return { ok: false, busy: true, version: installedVersion(), output: lines.join('\n') };
    }
    try {
      return await installLocked(version, say, lines, { run, check, env });
    } finally {
      release();
    }
  }

  async function installLocked(version, say, lines, { run, check, env }) {
    fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writePrefixPackage(dir(), allowScript ? `${pkg}@${version}` : null);
    const scratch = fs.mkdtempSync(path.join(dir(), '.install-'));
    try {
      const own = installEnv(env, isolate(scratch));
      for (const k of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) if (own[k]) fs.mkdirSync(own[k], { recursive: true, mode: 0o700 });
      const argv = npmArgv(['install', '--prefix', dir(), '--save-exact', '--no-audit', '--no-fund', '--update-notifier=false', ...npmFlags, `${pkg}@${version}`]);
      say(`$ ${showCommand(argv)}`);
      const r = await run(argv, { env: own, cwd: dir(), onLine: say });
      clearLookups();
      const now = installedVersion();
      if (!r.ok || !now) {
        say(`${name} ${version} was not installed${r.ok ? ' (npm finished, but the program is not there)' : ''}.`);
        return { ok: false, version: now, output: lines.join('\n') };
      }
      // The program must start and say the same version the package says.
      const v = await check(toolArgv(['--version']), { env: own, timeout: 30_000 });
      const ran = v.ok ? parseVersion(`${v.stdout}\n${v.stderr}`) : null;
      if (ran !== now) {
        say(`${name} ${now} is installed, but the program ${ran ? `says it is ${ran}` : 'did not start'}.`);
        return { ok: false, version: now, output: lines.join('\n') };
      }
      say(`${name} ${now} is installed in Hoprig's tools folder.`);
      return { ok: true, version: now, output: lines.join('\n') };
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Install the newest version from the registry. Refused, with a reason, when it cannot be looked up. */
  async function update({ onLine = () => {}, fetchImpl, ...rest } = {}) {
    const latest = await registryLatest(pkg, { fetchImpl, fresh: true }); // an update installs what is newest now
    if (!latest) {
      const output = `Could not look up the newest ${name} (offline?). Nothing changed.`;
      onLine(output);
      return { ok: false, version: installedVersion(), output };
    }
    return install({ ...rest, version: latest, onLine });
  }

  return { id, name, pkg, pin, managed: true, dir, binPath, argv: toolArgv, installedVersion, info, install, update };
}
