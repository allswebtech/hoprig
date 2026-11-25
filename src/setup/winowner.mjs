// Windows only: a set-up run from an elevated window (PowerShell "Run as administrator") makes its folders as the
// Administrators group, not as the person, and the coding tool and Hoprig then run into folders that are not theirs.
// Hoprig never changes an owner itself: set-up says at its start that it runs elevated and at its end the line that
// hands the folders back; doctor (and so Health) looks at the owner of the workspace and of the coding tool's folder.
// Every answer comes from `run(argv, opts)` → { ok, stdout } (capture's shape), so tests give Windows' answers.
import fs from 'node:fs';
import { claudeDir, tilde } from '../paths.mjs';
import { WHOAMI, parseWhoami, psQuote } from '../server/service/windows.mjs';
import { workspaceDir } from '../workspace/layout.mjs';
import { capture } from './system.mjs';

/** The mandatory label of a High integrity token: the process runs elevated. */
export const HIGH_INTEGRITY = 'S-1-16-12288';
/** BUILTIN\Administrators, whatever the display language calls it. */
export const ADMINS_SID = 'S-1-5-32-544';
export const WHOAMI_GROUPS = ['whoami', '/groups', '/fo', 'csv', '/nh'];
const SID = /^S-1-\d+(?:-\d+)+$/;

const defaultRun = (argv, opts) => capture(argv, { timeout: 10_000, ...opts });

/**
 * The runner for Windows' answers: the one a caller (a test) hands in as `sys.run`, else the real one on Windows
 * only. null: a Windows check asked on another system with no stand-in, which is not asked at all.
 */
export const winRun = (sys = {}) => (typeof sys.run === 'function' ? sys.run : process.platform === 'win32' ? defaultRun : null);

/** Does this process run elevated? One `whoami /groups`: true, false, or null when it cannot tell. */
export async function runsElevated(run = defaultRun) {
  const r = await run(WHOAMI_GROUPS);
  if (!r.ok) return null;
  return String(r.stdout || '').includes(`"${HIGH_INTEGRITY}"`);
}

/** This account's SID (whoami /user, as the service's task is made for: windows.mjs whoAmI), or null. */
export async function mySid(run = defaultRun) {
  const r = await run([WHOAMI[0], ...WHOAMI[1]]);
  return r.ok ? parseWhoami(r.stdout)?.sid || null : null;
}

/** The PowerShell call that prints the owner SID of `dir` (the SID: the group's name depends on the language). */
export const ownerArgv = (dir) => ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
  `(Get-Acl -LiteralPath ${psQuote(dir)}).GetOwner([System.Security.Principal.SecurityIdentifier]).Value`];

/**
 * The walk the hand-back line runs: $o is the new owner ("*<SID>"), $ds the folders. Each item gets its own
 * `icacls /setowner` with no /T: on Windows the workspace links projects as junctions (workspace/link.mjs) and
 * ~/.claude may hold links too, and /T could change the owner of what a link points at, outside the folder. An item
 * that is a link (a junction or a symbolic link: the ReparsePoint attribute) is never gone into: only the link itself
 * is handed back (icacls /L acts on the link, not on its target), so nothing outside the folders is touched.
 */
// 1024 is FILE_ATTRIBUTE_REPARSE_POINT. Short words (gci, gi, %) keep the line inside what Health carries (500).
export const HANDBACK_WALK = 'param($o,[string[]]$ds) $w={param($i) if(!$i){return}; if($i.Attributes -band 1024){icacls $i.FullName /setowner $o /L /C /Q; return}; icacls $i.FullName /setowner $o /C /Q; if($i.PSIsContainer){gci -LiteralPath $i.FullName -Force | %{& $w $_}}}; $ds | %{& $w (gi -LiteralPath $_ -Force)}';

/**
 * The line that hands `dirs` back to `sid`, for a PowerShell window opened with "Run as administrator": the walk
 * above, with the SID and the folders as its arguments. Each path in single quotes (PowerShell takes nothing inside
 * them as special: a space, % or $ stay; a quote is doubled), so it stays one argument.
 */
export function handBackAll(dirs, sid) {
  const who = SID.test(String(sid || '')) ? sid : '<your SID: whoami /user>';
  // No backslash at the end (C:\a b\ could reach a program as C:\a b" : the backslash takes the closing quote).
  const ds = dirs.map((d) => psQuote(String(d).replace(/(?<!^[A-Za-z]:)[\\/]+$/, '')));
  return `& { ${HANDBACK_WALK} } ${psQuote(`*${who}`)} ${ds.join(', ')}`;
}

/** The line that hands one folder back. */
export const handBackLine = (dir, sid) => handBackAll([dir], sid);

/** The folders that are looked at: the workspace and the coding tool's own (~/.claude or CLAUDE_CONFIG_DIR). */
export const ownedDirs = () => [['Workspace', workspaceDir()], ["Claude Code's folder", claudeDir()]];

/**
 * doctor's line: the owner of each folder that is there. The Administrators group → a warning naming the folders,
 * with the line that hands them back; the person → ok; no folder there → nothing. Nothing is changed.
 */
export async function ownerCheck(sys, { run = winRun(sys), dirs = ownedDirs(), exists = fs.existsSync } = {}) {
  if (sys.platform !== 'win32' || !run) return null;
  const there = dirs.filter(([, d]) => exists(d));
  if (!there.length) return null;
  const admins = [];
  for (const [label, d] of there) {
    const r = await run(ownerArgv(d));
    if (r.ok && String(r.stdout || '').trim() === ADMINS_SID) admins.push([label, d]);
  }
  const label = 'Owner of your folders';
  if (!admins.length) return { id: 'winowner', label, status: 'ok', detail: there.map(([, d]) => tilde(d)).join(', '), fix: '' };
  const sid = await mySid(run);
  return {
    id: 'winowner', label, status: 'warn',
    detail: `${admins.map(([l, d]) => `${l} ${tilde(d)}`).join(' and ')} belong${admins.length === 1 ? 's' : ''} to the Administrators group (a set-up run as administrator made ${admins.length === 1 ? 'it' : 'them'}), not to you. Hoprig changes nothing: in a PowerShell window opened with "Run as administrator", the line below hands ${admins.length === 1 ? 'it' : 'them'} back. It does not go into links (junctions): what they point at keeps its owner`,
    fix: handBackAll(admins.map(([, d]) => d), sid),
  };
}

export const ELEVATED_START = 'Set-up runs as administrator: the folders it makes will belong to the Administrators group, not to you. Hoprig does not change that; the end of set-up gives the line that hands them back.';

/** set-up's start on Windows: true when it runs elevated (then it said so in one line), else false. */
export async function elevatedStart(ui, sys) {
  const run = winRun(sys);
  if (sys.platform !== 'win32' || !run) return false;
  if ((await runsElevated(run)) !== true) return false;
  ui.line('warn', ELEVATED_START);
  return true;
}

/**
 * set-up's end after an elevated run: the folders that belong to the Administrators group now (doctor's own check)
 * and the line that hands them back, or null when none does.
 */
export async function elevatedEnd(sys, deps = {}) {
  const c = await ownerCheck(sys, deps);
  if (!c || c.status !== 'warn') return null;
  return `Set-up ran as administrator: ${c.detail}: ${c.fix}`;
}
