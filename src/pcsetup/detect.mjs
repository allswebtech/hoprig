// What is already on this computer, per kit item: present (with its version), missing, or old (past the end of
// life its project publishes). Nothing here changes anything, and nothing reads a key or a token: the GitHub
// sign-in is read from `gh auth status` and only the account name is kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capture, detectPackageManager, isRoot, npmArgv, which } from '../setup/system.mjs';
import { KITS, itemHere } from './kits.mjs';

/**
 * The facts plans and checks need. Tests pass their own `has`, `run` (a capture() stand-in) and `exists`.
 * On a Mac the system's /usr/bin/git and python3 are only stubs until the Xcode command line tools are installed
 * (running them opens Apple's install window), so `clt` is read first and those items count as missing without it.
 */
export async function sysFacts(over = {}) {
  const env = over.env || process.env;
  const platform = over.platform || process.platform;
  const has = over.has || ((cmd) => !!which(cmd, env, platform));
  const run = over.run || ((argv, o) => capture(argv, { env, timeout: 15_000, ...o }));
  let pm = over.pm !== undefined ? over.pm : platform === 'win32' ? (has('winget') ? 'winget' : null) : detectPackageManager(platform, has);
  if (pm === 'brew' && platform !== 'darwin') pm = null;
  let dnf5 = over.dnf5;
  if (dnf5 === undefined && pm === 'dnf') dnf5 = /dnf5|^5\./m.test((await run(['dnf', '--version'])).stdout);
  let clt = over.clt;
  if (clt === undefined && platform === 'darwin') clt = (await run(['xcode-select', '-p'])).ok;
  return {
    env, platform, has, run, pm, dnf5: Boolean(dnf5), clt: clt !== false,
    root: over.root ?? isRoot(),
    user: over.user ?? safeUser(),
    arch: over.arch || process.arch,
    home: over.home || os.homedir(),
    tmp: over.tmp || os.tmpdir(),
    exists: over.exists || ((f) => fs.existsSync(f)),
  };
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return null;
  }
}

/** The first version-looking text in a command's answer: "git version 2.43.0" → "2.43.0". */
export function versionOf(text) {
  const m = /(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?)/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** Account name from `gh auth status` (text or --json). Never the token line. */
export function parseGhAuth({ ok, stdout = '', stderr = '' }) {
  const text = `${stdout}\n${stderr}`;
  const m = /Logged in to (\S+) (?:account|as) ([A-Za-z0-9-]+)/.exec(text);
  if (m) return { signedIn: true, host: m[1], account: m[2] };
  return { signedIn: false, host: null, account: null, unknown: ok };
}

/** git's global name and e-mail: { name, email } (empty strings when not set). */
export async function gitIdentity(sys) {
  if (!sys.has('git') || (sys.platform === 'darwin' && !sys.clt)) return { name: '', email: '' };
  const [n, e] = await Promise.all([sys.run(['git', 'config', '--global', 'user.name']), sys.run(['git', 'config', '--global', 'user.email'])]);
  return { name: n.stdout.trim(), email: e.stdout.trim() };
}

export async function ghAuth(sys) {
  if (!sys.has('gh')) return { signedIn: false, account: null, reason: 'gh is not installed' };
  return parseGhAuth(await sys.run(['gh', 'auth', 'status', '--hostname', 'github.com']));
}

/** Public SSH keys in ~/.ssh (names only; a private key is never opened). */
export function sshKeys(sys) {
  return ['id_ed25519', 'id_ecdsa', 'id_rsa'].filter((n) => sys.exists(path.join(sys.home, '.ssh', `${n}.pub`)));
}

/** Detect one item: { id, name, state: ok | missing | old | na, version, detail }. */
export async function detectItem(item, sys) {
  const base = { id: item.id, name: item.name, version: null, detail: '' };
  if (!itemHere(item, sys.platform)) return { ...base, state: 'na', detail: `not needed on ${sys.platform}` };
  if (item.kind === 'identity') {
    const id = await gitIdentity(sys);
    const ok = Boolean(id.name && id.email);
    return { ...base, state: ok ? 'ok' : 'missing', detail: ok ? `${id.name} <${id.email}>` : `${id.name ? '' : 'name'}${!id.name && !id.email ? ' and ' : ''}${id.email ? '' : 'e-mail'} not set` };
  }
  if (item.kind === 'signin') {
    const a = await ghAuth(sys);
    return { ...base, state: a.signedIn ? 'ok' : 'missing', detail: a.signedIn ? `signed in as ${a.account}` : a.reason || 'not signed in' };
  }
  if (sys.platform === 'darwin' && item.needsClt && !sys.clt) return { ...base, state: 'missing', detail: 'comes with the Xcode command line tools' };
  if (item.id === 'build' && sys.platform === 'darwin') return { ...base, state: sys.clt ? 'ok' : 'missing', detail: sys.clt ? 'Xcode command line tools' : '' };
  if (item.id === 'build' && sys.platform === 'win32') {
    const vswhere = path.join(sys.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const r = sys.exists(vswhere) ? await sys.run([vswhere, '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationVersion']) : { stdout: '' };
    const v = versionOf(r.stdout);
    return { ...base, state: v ? 'ok' : 'missing', version: v, detail: v ? 'Visual Studio C++ tools' : '' };
  }
  const bins = (item.bins || []).map((b) => (sys.platform === 'win32' && b === 'python3' ? 'python' : b));
  const lacking = bins.filter((b) => !sys.has(b));
  if (lacking.length) return { ...base, state: 'missing', detail: lacking.length < bins.length ? `${lacking.join(', ')} not found` : '' };
  if (!item.version) return { ...base, state: 'ok' };
  let argv = item.version.map((a) => (sys.platform === 'win32' && a === 'python3' ? 'python' : a));
  if (sys.platform === 'win32' && argv[0] === 'npm') argv = npmArgv(argv.slice(1), 'win32'); // npm is a .cmd script there
  const r = await sys.run(argv);
  if (!r.ok) return { ...base, state: 'missing', detail: (r.stderr || r.stdout).trim().split('\n').pop().slice(0, 120) };
  const version = versionOf(r.stdout || r.stderr);
  if (item.eol && version && item.eol(version)) return { ...base, state: 'old', version, detail: 'past its end of life' };
  return { ...base, state: 'ok', version };
}

/** Every item of the given kits: { kitId: [result] }. Items run in parallel. */
export async function detectKits(sys, kitIds = KITS.map((k) => k.id)) {
  const out = {};
  await Promise.all(kitIds.map(async (id) => {
    const kit = KITS.find((k) => k.id === id);
    if (kit) out[id] = await Promise.all(kit.items.map((i) => detectItem(i, sys)));
  }));
  return out;
}

/** Kits picked when nothing was asked for: the default ones that miss something. */
export function preselect(found) {
  return KITS.filter((k) => k.defaultOn && (found[k.id] || []).some((r) => r.state === 'missing')).map((k) => k.id);
}
