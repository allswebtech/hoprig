// "Allow bypass permissions mode", as the Claude Code desktop app has it under Settings: until the owner turns it on
// (with a confirmation), Bypass permissions is not offered anywhere in the dashboard (the App's mode menu and its
// Shift+Tab, a new session's options, New sessions), a request for it is refused, and the App starts Claude
// Code without --allow-dangerously-skip-permissions. Config key "allowBypass" (true / false).
// Nobody who used bypass before this switch existed loses it by the update: the first time a dashboard starts without
// the key (firstLook), it is set ON where the session defaults name bypass, an open App session runs in it, or a
// running terminal session was started with it (its run record's launch arguments), or the config's own arguments for
// every launch name it (claudeArgs); else it stays OFF, as on a new install, and the owner's config file stays as the
// released version left it. Either way the step is done once: a marker in the state folder says so (a terminal started
// in bypass later, `hoprig claude --dangerously-skip-permissions`, must not turn the switch on at the next start).
// That one step is said once on Home (`bypassKept`, until the owner closes the note).
// A schedule starts its sessions with the session defaults (or writes into an open App session), so the two first
// cases cover it.
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_ROOT_REFUSAL } from './setup/rootfacts.mjs';

export const BYPASS = 'bypassPermissions';

/** Does this process run as root (user id 0 on Linux or macOS)? The default of every rule below; tests hand theirs in. */
export const runsAsRoot = () => process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;

/**
 * Is Bypass permissions allowed on this dashboard? Only an explicit true (the first look sets the key), and never when
 * Hoprig runs as root (`root`): Claude Code refuses that mode for root, and also the flag that only allows it, which the
 * App passes in every mode (seen on 2.1.329), so offering it there would start nothing.
 */
export const bypassAllowed = (cfg, root = runsAsRoot()) => root !== true && !!cfg && cfg.allowBypass === true;

/** The one line said where bypass would be chosen as root: the coding tool's own words, and what to do. */
export const ROOT_BYPASS_LINE = `Claude Code refuses bypass permissions mode as root ("${CLAUDE_ROOT_REFUSAL}"). Start in a mode that asks, or move Hoprig to an ordinary user in Settings → Runs as root (in a terminal: hoprig move-to-user)`;

/** A list of permission modes without Bypass permissions unless it is allowed. */
export const gateModes = (modes, cfg, root = runsAsRoot()) => (bypassAllowed(cfg, root) ? modes : (modes || []).filter((m) => m !== BYPASS));

/** Did a launch's arguments start the coding tool in bypass? (--permission-mode bypassPermissions, the CLI flag, OpenCode's --auto) */
export function bypassInArgs(args) {
  const a = Array.isArray(args) ? args : [];
  return a.includes('--dangerously-skip-permissions') || a.includes('--dangerously-bypass-approvals-and-sandbox') || a.some((x, i) => x === '--permission-mode' && a[i + 1] === BYPASS) || a.includes(`--permission-mode=${BYPASS}`);
}

/** A launch's arguments without what starts the coding tool in bypass (or allows it there). */
export function withoutBypass(args) {
  const a = Array.isArray(args) ? args : [];
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x === '--dangerously-skip-permissions' || x === '--allow-dangerously-skip-permissions' || x === '--dangerously-bypass-approvals-and-sandbox' || x === `--permission-mode=${BYPASS}`) continue;
    if (x === '--permission-mode' && a[i + 1] === BYPASS) {
      i++;
      continue;
    }
    out.push(x);
  }
  return out;
}
/**
 * The arguments a terminal session takes along when it starts again (a move to another provider, a restore after a
 * restart): bypass only while the switch allows it. Turning the switch off thus reaches a terminal started in bypass at
 * its next start (the one running now keeps its process until it ends: Settings counts them).
 */
export const gateCarry = (args, cfg, root = runsAsRoot()) => (bypassAllowed(cfg, root) ? args : withoutBypass(args));

/**
 * The one-time step (see above). o: { cfg (the config now), save(patch) (config.mjs saveConfig), chatsFile (the
 * open App sessions, chat/feature.mjs), runs() (the run records, runs.mjs listRuns), marker (the file that says the
 * step was done), now } → the decision made, or null when the key or the marker was there already. Only a decision to
 * keep bypass on goes into the config; the marker is written either way.
 */
export function firstLook({ cfg, save, chatsFile = null, runs = () => [], marker = null, now = Date.now() }) {
  if (cfg && typeof cfg.allowBypass === 'boolean') return null;
  if (marker && fs.existsSync(marker)) return null;
  const why = [];
  if (cfg && cfg.sessionDefaults && cfg.sessionDefaults.permissionMode === BYPASS) why.push('defaults');
  if (cfg && bypassInArgs(cfg.claudeArgs)) why.push('config');
  if (chatsFile) {
    try {
      const list = JSON.parse(fs.readFileSync(chatsFile, 'utf8'));
      if (Array.isArray(list) && list.some((c) => c && c.permissionMode === BYPASS)) why.push('app');
    } catch {
      /* no open App session */
    }
  }
  try {
    if ((runs() || []).some((r) => r && bypassInArgs(r.carryArgs))) why.push('terminal');
  } catch {
    /* no run records */
  }
  const allow = why.length > 0;
  if (allow) save({ allowBypass: true, bypassKept: now });
  if (marker) {
    try {
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, `${JSON.stringify({ at: now, allow, why })}\n`);
    } catch {
      /* not writable: the next start looks again */
    }
  }
  return { allow, why };
}

/**
 * Why a start as root must not go ahead: ROOT_BYPASS_LINE when `root` and the start would run in bypass, by its own
 * arguments (`args`), by the session defaults or by the config's arguments for every launch; else null. Where nobody
 * chooses at that moment (the API, a schedule, a restore, a hand-off, Tia, Work) nothing starts and this is the answer;
 * the owner's default is left as he set it.
 */
export function rootRefusal({ args = [], cfg = {}, root = runsAsRoot() } = {}) {
  if (root !== true) return null;
  const d = (cfg && cfg.sessionDefaults) || {};
  const every = cfg && Array.isArray(cfg.claudeArgs) ? cfg.claudeArgs : [];
  return bypassInArgs(args) || d.permissionMode === BYPASS || bypassInArgs(every) ? ROOT_BYPASS_LINE : null;
}
