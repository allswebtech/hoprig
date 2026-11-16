// `hoprig pc status`: what this computer has, what is missing, what needs attention — in the doctor's style.
// Every check returns { id, label, status, detail, fix, group } (status ok | fail | warn | info), and a check that a
// kit fixes carries `fixKit` (the dashboard's Fix button runs `pc setup --kits <kit>` for it). Nothing here
// changes anything or needs administrator rights, and no answer ever holds a key, a token or a file's content.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeCheck, loginCheck } from '../setup/checks.mjs';
import { osName, showCommand } from '../setup/system.mjs';
import { detectKits, ghAuth, gitIdentity, sshKeys } from './detect.mjs';
import { KITS, buildPlan, kitById } from './kits.mjs';
import { listRepos, repoState } from './projects.mjs';
import { rulesState } from './rules.mjs';
import { discoverChildren } from './workspace.mjs';

const r = (group, id, label, status, detail, fix = '', extra = {}) => ({ group, id, label, status, detail, fix, ...extra });
const GB = 1024 ** 3;
const gb = (n) => `${(n / GB).toFixed(n < 10 * GB ? 1 : 0)} GB`;

// ---------- updates and restart, per OS (all readable without administrator rights) ----------

/** Ubuntu's apt-check prints "<updates>;<security updates>" on stderr. */
export function parseAptCheck(text) {
  const m = /^(\d+);(\d+)$/m.exec(String(text || '').trim());
  return m ? { updates: Number(m[1]), security: Number(m[2]) } : null;
}
/** `apt list --upgradable`: one "name/suite version arch [upgradable from: …]" line per package. */
export const parseAptList = (text) => String(text || '').split('\n').filter((l) => /\[upgradable from:/.test(l)).length;
/** `dnf check-update` / `checkupdates` / `apk version -l '<'`: one package per non-empty, non-header line. */
export const countLines = (text) => String(text || '').split('\n').filter((l) => /^\S+[\s.]+\S/.test(l.trim()) && !/^(Last metadata|Obsoleting|Security:|Installed|Upgrading|WARNING)/i.test(l.trim())).length;
/** `softwareupdate -l`: "* Label: …" lines; "Action: restart" or "[restart]" when one needs a restart. */
export function parseSoftwareUpdate(text) {
  const t = String(text || '');
  return { updates: (t.match(/^\s*\* Label:/gm) || []).length, restart: /Action: restart|\[restart\]/i.test(t) };
}

let macCache = null;

export async function updatesCheck(sys, { offline = false } = {}) {
  const name = osName(sys.platform);
  const label = 'Operating system';
  const say = (updates, restart, how) => {
    const parts = [name];
    if (updates === null) parts.push('updates not checked');
    else parts.push(updates ? `${updates} update${updates > 1 ? 's' : ''} waiting` : 'up to date');
    if (restart) parts.push('a restart is pending');
    return r('system', 'os', label, restart || updates ? 'warn' : 'ok', parts.join(' · '), updates ? how : restart ? 'Restart the computer when it suits you.' : '');
  };
  if (sys.platform === 'linux') {
    const restart = sys.exists('/var/run/reboot-required');
    if (sys.pm === 'apt') {
      if (sys.exists('/usr/lib/update-notifier/apt-check')) {
        const c = parseAptCheck((await sys.run(['/usr/lib/update-notifier/apt-check'])).stderr);
        if (c) return say(c.updates, restart, 'sudo apt update && sudo apt upgrade');
      }
      const l = await sys.run(['apt', 'list', '--upgradable'], { timeout: 20_000 });
      return say(l.ok ? parseAptList(l.stdout) : null, restart, 'sudo apt update && sudo apt upgrade');
    }
    if (sys.pm === 'dnf') {
      const c = await sys.run(['dnf', 'check-update', '-q', '--cacheonly'], { timeout: 30_000 });
      const n = c.code === 100 ? countLines(c.stdout) : c.code === 0 ? 0 : null;
      const nr = sys.has('needs-restarting') ? (await sys.run(['needs-restarting', '-r'])).code === 1 : false;
      return say(n, restart || nr, 'sudo dnf upgrade');
    }
    if (sys.pm === 'pacman' && sys.has('checkupdates')) {
      const c = await sys.run(['checkupdates'], { timeout: 60_000 });
      return say(c.code === 0 ? countLines(c.stdout) : c.code === 2 ? 0 : null, restart, 'sudo pacman -Syu');
    }
    return say(null, restart, '');
  }
  if (sys.platform === 'darwin' && !offline) {
    // softwareupdate asks Apple's servers and takes half a minute: its answer is kept for an hour.
    if (!macCache || Date.now() - macCache.at > 3600_000) macCache = { at: Date.now(), c: await sys.run(['softwareupdate', '-l'], { timeout: 60_000 }) };
    const { c } = macCache;
    if (c.ok || c.stdout || c.stderr) {
      const s = parseSoftwareUpdate(`${c.stdout}\n${c.stderr}`);
      return say(s.updates, s.restart, 'Open System Settings → General → Software Update');
    }
  }
  return say(null, false, '');
}

// ---------- disks, memory, swap ----------

/** Free space of the disks that hold the home folder and the projects folder (one line per disk). */
export function diskChecks(dirs, statfs = (p) => fs.statfsSync(p)) {
  const seen = new Map();
  for (const d of dirs) {
    let p = d;
    while (p && !fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
    try {
      const s = statfs(p);
      const key = `${s.type}:${s.blocks}:${s.bsize}`;
      if (!seen.has(key)) seen.set(key, { dir: d, size: s.blocks * s.bsize, free: s.bavail * s.bsize });
    } catch {
      /* unreadable: left out */
    }
  }
  return [...seen.values()].map(({ dir, size, free }, i) => {
    const frac = size ? free / size : 1;
    const status = free < 2 * GB || frac < 0.03 ? 'fail' : free < 10 * GB || frac < 0.1 ? 'warn' : 'ok';
    return r('system', `disk-${i}`, 'Disk', status, `${gb(free)} free of ${gb(size)} (holds ${dir.replace(os.homedir(), '~')})`, status === 'ok' ? '' : 'Free some space: old downloads, caches (npm cache clean --force), unused Docker images (docker system prune).');
  });
}

/** Linux /proc/meminfo → { total, available, swapTotal, swapFree } in bytes. */
export function parseMeminfo(text) {
  const k = (n) => Number((new RegExp(`^${n}:\\s+(\\d+) kB`, 'm').exec(text) || [])[1]) * 1024;
  return { total: k('MemTotal'), available: k('MemAvailable'), swapTotal: k('SwapTotal'), swapFree: k('SwapFree') };
}
/** macOS `sysctl vm.swapusage`: "total = 2048.00M  used = 1024.00M  free = 1024.00M ..." */
export function parseSwapusage(text) {
  const n = (w) => {
    const m = new RegExp(`${w} = ([\\d.]+)([MG])`).exec(text);
    return m ? Number(m[1]) * (m[2] === 'G' ? GB : 1024 ** 2) : NaN;
  };
  return { swapTotal: n('total'), swapFree: n('free') };
}

export async function memoryChecks(sys) {
  let m = { total: os.totalmem(), available: os.freemem(), swapTotal: NaN, swapFree: NaN };
  if (sys.platform === 'linux' && sys.exists('/proc/meminfo')) m = { ...m, ...parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')) };
  if (sys.platform === 'darwin') {
    // macOS keeps free memory as cache, so os.freemem() is always small; the kernel's own "memory free" level
    // (what memory pressure is judged by) is the honest figure.
    const lvl = Number((await sys.run(['sysctl', '-n', 'kern.memorystatus_level'])).stdout.trim());
    if (lvl > 0 && lvl <= 100) m.available = (m.total * lvl) / 100;
    m = { ...m, ...parseSwapusage((await sys.run(['sysctl', 'vm.swapusage'])).stdout) };
  }
  const frac = m.available / m.total;
  const out = [r('system', 'memory', 'Memory', frac < 0.05 ? 'warn' : 'ok', `${gb(m.available)} available of ${gb(m.total)}`, frac < 0.05 ? 'Close programs you do not need (hoprig pc shows the largest).' : '')];
  if (Number.isFinite(m.swapTotal)) {
    const used = m.swapTotal - m.swapFree;
    const full = m.swapTotal > 0 && used / m.swapTotal > 0.9;
    out.push(r('system', 'swap', 'Swap', full ? 'warn' : 'info', m.swapTotal ? `${gb(used)} used of ${gb(m.swapTotal)}` : 'none', full ? 'Swap is nearly full: the computer slows down. Close large programs.' : ''));
  }
  return out;
}

// ---------- clock ----------

/** Seconds between this clock and a server's Date header. */
export const clockOffset = (dateHeader, now = Date.now()) => (dateHeader ? Math.round((now - Date.parse(dateHeader)) / 1000) : null);

export async function clockCheck(sys, { offline = false, fetchImpl = globalThis.fetch } = {}) {
  if (sys.platform === 'linux' && sys.has('timedatectl')) {
    const t = await sys.run(['timedatectl', 'show', '-p', 'NTPSynchronized', '--value']);
    if (t.ok && /^(yes|no)$/.test(t.stdout.trim())) {
      const ok = t.stdout.trim() === 'yes';
      return r('system', 'clock', 'Clock', ok ? 'ok' : 'warn', ok ? 'in sync (NTP)' : 'not synchronised', ok ? '' : 'sudo timedatectl set-ntp true');
    }
  }
  if (offline) return r('system', 'clock', 'Clock', 'info', 'not checked (offline)');
  try {
    const res = await fetchImpl('https://github.com', { method: 'HEAD', signal: AbortSignal.timeout(8000) });
    const off = clockOffset(res.headers.get('date'));
    if (off === null) return r('system', 'clock', 'Clock', 'info', 'not checked');
    const bad = Math.abs(off) > 60;
    return r('system', 'clock', 'Clock', bad ? 'warn' : 'ok', bad ? `${Math.abs(off)} s ${off > 0 ? 'ahead' : 'behind'}` : 'in sync', bad ? 'Turn on "set time automatically" in the system settings.' : '');
  } catch {
    return r('system', 'clock', 'Clock', 'info', 'not checked (no network)');
  }
}

// ---------- kits, GitHub, Claude Code, projects ----------

const STATE_MARK = { ok: 'ok', missing: 'fail', old: 'warn', na: 'info' };

export function kitChecks(found, sys) {
  const out = [];
  for (const kit of KITS) {
    for (const it of found[kit.id] || []) {
      if (it.state === 'na' || it.id === 'identity' || it.id === 'signin') continue;
      const optional = !kit.defaultOn;
      const status = it.state === 'missing' && optional ? 'info' : STATE_MARK[it.state];
      const plan = it.state === 'missing' ? buildPlan([kit.id], { [kit.id]: [it] }, sys) : null;
      const fix = it.state === 'missing'
        ? plan.steps.length ? plan.steps.map((s) => showCommand(s.argv)).join(' && ') : `hoprig pc setup --kits ${kit.id}`
        : it.state === 'old' ? oldFix(it.id) : '';
      out.push(r(`kit:${kit.id}`, `${kit.id}.${it.id}`, it.name, status, it.state === 'ok' ? it.version || it.detail || 'present' : it.state === 'old' ? `${it.version} ${it.detail}` : optional ? 'not installed (optional)' : it.detail || 'missing', fix, it.state === 'missing' ? { fixKit: kit.id } : {}));
    }
  }
  return out;
}

const oldFix = (id) => (id === 'node' ? 'nvm install --lts   (or: https://nodejs.org/en/download)' : id === 'python' ? 'Install a supported Python: https://www.python.org/downloads/' : '');

export async function githubChecks(sys) {
  const [id, auth] = await Promise.all([gitIdentity(sys), ghAuth(sys)]);
  const keys = sshKeys(sys);
  return [
    r('kit:github', 'identity', 'Commit name and e-mail', id.name && id.email ? 'ok' : 'warn', id.name && id.email ? `${id.name} <${id.email}>` : 'not set', id.name && id.email ? '' : 'git config --global user.name "Your Name" && git config --global user.email you@example.com', id.name && id.email ? {} : { fixKit: 'github' }),
    r('kit:github', 'signin', 'GitHub sign-in', auth.signedIn ? 'ok' : 'warn', auth.signedIn ? `signed in as ${auth.account}` : auth.reason || 'not signed in', auth.signedIn ? '' : sys.has('gh') ? 'gh auth login' : 'hoprig pc setup --kits github', auth.signedIn ? {} : { fixKit: 'github' }),
    r('kit:github', 'sshkey', 'SSH key', keys.length ? 'ok' : 'info', keys.length ? `${keys.join(', ')} (public key present)` : auth.signedIn ? 'none (not needed: gh signs git in over https)' : 'none', keys.length || auth.signedIn ? '' : 'ssh-keygen -t ed25519   then add ~/.ssh/id_ed25519.pub at https://github.com/settings/ssh/new'),
  ];
}

export async function claudeChecks(sys, { offline = false } = {}) {
  try {
    const cc = await import('../claudecode.mjs');
    const info = await cc.claudeInfo({ env: sys.env, fetchImpl: offline ? async () => ({ ok: false }) : undefined });
    const login = await cc.claudeLoginStatus({ env: sys.env });
    let profiles = [];
    try {
      profiles = (await import('../profiles.mjs')).listProfiles();
    } catch {
      /* no profiles folder yet */
    }
    return [claudeCheck(info), loginCheck(login, profiles)].map((c) => ({ ...c, group: 'claude' })).concat(rulesCheck());
  } catch (e) {
    return [r('claude', 'claude', 'Claude Code', 'warn', `could not be checked: ${e.message}`)];
  }
}

/**
 * The offered coding tools Hoprig installs into its own tools folder (OpenCode): fine when there, an optional extra with an
 * Install button when not (POST /api/pcsetup/tool). `tools`: the descriptors (src/codetools; tests pass stand-ins).
 */
export async function codingToolChecks(tools = null) {
  const list = tools || (await import('../codetools/index.mjs')).TOOLS.filter((t) => t.managed);
  return list.map((t) => {
    const v = t.installedVersion();
    return v
      ? r('codetools', `tool.${t.id}`, t.name, 'ok', `${v} (Hoprig's tools folder)`)
      : r('codetools', `tool.${t.id}`, t.name, 'info', 'not installed (optional: another coding tool)', `hoprig tools install ${t.id}`, { action: 'tool-install', tool: t.id });
  });
}

/** The opt-in working rules (rules.mjs): information when not added; a warning while an earlier version's import
 * line is still in CLAUDE.md (it points at a file that moved). */
export function rulesCheck(state = rulesState()) {
  if (state.oldBlock) return r('claude', 'rules', 'Working rules', 'warn', `an old import line in ${state.claudeMd.replace(os.homedir(), '~')} is no longer needed`, state.symlinked ? `remove the Hoprig block from ${state.claudeMd}` : 'hoprig pc setup --rules', state.symlinked ? {} : { action: 'rules' });
  if (state.installed) return r('claude', 'rules', 'Working rules', 'ok', `${state.rules.replace(os.homedir(), '~')}${state.edited ? ' (your edited copy)' : ''}`);
  return r('claude', 'rules', 'Working rules', 'info', 'not added (optional: a good set of rules for Claude, yours to edit)', 'hoprig pc setup --rules', { action: 'rules' });
}

export async function projectChecks(dir, run) {
  if (!fs.existsSync(dir)) return [r('projects', 'projects', 'Projects folder', 'info', `${dir.replace(os.homedir(), '~')} does not exist yet`, 'hoprig pc setup   (it asks where your projects live)')];
  const repos = listRepos(dir);
  const out = [r('projects', 'projects', 'Projects folder', 'ok', `${dir.replace(os.homedir(), '~')} · ${repos.length} repositor${repos.length === 1 ? 'y' : 'ies'}`)];
  const states = await Promise.all(repos.map((d) => repoState(d, run)));
  for (const s of states) {
    out.push(repoLine(s));
    // A project workspace: its code repositories under it (the parent tracks only code/.gitignore).
    for (const c of await discoverChildren(s.dir, run)) out.push(repoLine({ ...(await repoState(path.join(s.dir, c.dir), run)), dir: path.join(s.dir, c.dir) }, 'projects', `${path.basename(s.dir)}/${c.dir}`));
  }
  return out;
}

/** One repository as a status line: branch, changes, ahead/behind (counts only). */
export function repoLine(s, group = 'projects', name = path.basename(s.dir)) {
  if (!s.ok) return r(group, `repo:${name}`, name, 'warn', s.error);
  const parts = [s.branch];
  if (s.changes) parts.push(`${s.changes} uncommitted change${s.changes > 1 ? 's' : ''}`);
  if (s.ahead) parts.push(`${s.ahead} to push`);
  if (s.behind) parts.push(`${s.behind} to pull`);
  if (!s.upstream) parts.push('no upstream');
  return r(group, `repo:${name}`, name, 'info', parts.join(' · '), '', { repo: { branch: s.branch, changes: s.changes, ahead: s.ahead, behind: s.behind, upstream: Boolean(s.upstream) } });
}

/** Every check. Slow ones run in parallel. */
export async function pcStatus({ sys, offline = false, projects, fetchImpl } = {}) {
  const found = await detectKits(sys);
  const [os1, mem, clock, gh, claude, tools, proj] = await Promise.all([
    updatesCheck(sys, { offline }),
    memoryChecks(sys),
    clockCheck(sys, { offline, fetchImpl }),
    githubChecks(sys),
    claudeChecks(sys, { offline }),
    codingToolChecks(),
    projectChecks(projects, sys.run),
  ]);
  const kits = kitChecks(found, sys);
  const ghAt = kits.findLastIndex((c) => c.group === 'kit:github') + 1;
  kits.splice(ghAt, 0, ...gh);
  return [os1, ...diskChecks([sys.home, projects]), ...mem, clock, ...kits, ...claude, ...tools, ...proj];
}

export const GROUPS = { system: 'This computer', ...Object.fromEntries(KITS.map((k) => [`kit:${k.id}`, k.title])), claude: 'Claude Code', codetools: 'Coding tools', projects: 'Projects' };
export const exitCode = (checks) => (checks.some((c) => c.status === 'fail') ? 1 : 0);
export { kitById };
