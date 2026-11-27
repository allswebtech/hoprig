// Start Claude Code under a profile, and when it exits offer to carry the SAME session on under another profile.
//
// Why this works: Claude Code keeps a session as a file in <claudeDir>/projects, keyed by folder and not by
// account, and decides which account or API to use from its environment. So a profile is only a set of
// environment variables, and "continue under another profile" is `claude --resume <id>` with other variables.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAutoSwitch, leftOutOfOrder, limitedProfiles, markLimited, nextProfile, parseResets, preferredAvailable, usableOrder } from './autoswitch.mjs';
import { claudeLoginStatus, claudeVersionQuick } from './claudecode.mjs';
import { WALL_MATCHER, handsOffOffered } from './handsoff.mjs';
import { loadConfig, sessionArgs } from './config.mjs';
import { rememberFolderProvider } from './defaultprovider.mjs';
import { claudeDir, hookFile, hookSettingsDir } from './paths.mjs';
import { listProfiles, notServedLines, ownFolder, profileEnv, readProfile, servesTools } from './profiles.mjs';
import { loginSeen, rememberLogin } from './routerstate.mjs';
import { createRun, noteUsage, readRun, readUsage, updateRun, usageFile } from './runs.mjs';
import { hasConversation, isSessionId } from './sessions.mjs';
import { refuseIfHeld } from './held.mjs';
import { endRun, removeLocked, settleInput } from './typinglock.mjs';
import { compareVersions } from './setup/system.mjs';
import { AUTO, autoIdentity, ensureRouter, nothingUsableLine } from './router.mjs';
import { providerName } from './operator/detect/util.mjs';
import { mapEnv, mapSettings, sessionMap } from './providers/sessionmap.mjs';
import { resolveWindowsBin, windowsSpawnPlan } from './winspawn.mjs';
import { withExtras } from './workspace/needs.mjs';
import { carryOf, takeHand, takeHers } from './launchfile.mjs';
import { startAsHers } from './assistant/hersignin.mjs';
import { credsDir } from './workspace/credlinks.mjs';
import { endedAtStart, endedLine, noteStartFailure } from './startfail.mjs';

/**
 * The account Auto mode runs Claude Code as (see router.mjs), or null when no order is set. The router is not started.
 */
export async function autoIdentityFor({ loginStatus = claudeLoginStatus, names = usableOrder() } = {}) {
  const profiles = listProfiles();
  const limited = limitedProfiles();
  const identity = autoIdentity(names, profiles, limited);
  // Claude Code refuses to send anything while its stored login is expired, whatever the router could do. So
  // when nobody is logged in, run as another account of the order: a subscription token, else an API account.
  // The check reads the default folder's sign-in: a provider with a folder of its own keeps its own, so it is not asked.
  if (!identity || identity.kind !== 'login' || ownFolder(identity)) return identity;
  const status = await loginStatus().catch(() => ({ loggedIn: null }));
  if (status.loggedIn !== false) return identity;
  const other = autoIdentity(names, profiles, limited, [identity.name]);
  if (!other) return identity;
  console.error(`hoprig: nobody is logged in to Claude Code on this computer (run: claude auth login). Auto mode runs as "${providerName(other.name, other.label)}" meanwhile.`);
  return other;
}

/**
 * The profile behind the name "auto": Claude Code runs as the identity account (see router.mjs) and talks to the
 * router, which spreads its requests over the accounts in the owner's order. null when no order is set.
 */
export async function autoProfile({ loginStatus = claudeLoginStatus } = {}) {
  const names = usableOrder();
  const identity = await autoIdentityFor({ loginStatus, names });
  if (!identity) return null;
  const url = await ensureRouter();
  return {
    name: AUTO, label: `Auto: ${names.join(' → ')}`, kind: 'auto', prerun: '', models: '', router: true, identity: identity.name,
    env: { ...identity.env, ANTHROPIC_BASE_URL: `${url}/as/${identity.name}` },
  };
}

/**
 * In an Auto session that runs as `current`: the subscription Claude Code should be restarted as, or null.
 * `why` "limit": the current account cannot serve any more and another subscription comes next in the order.
 * `why` "return": a reply just ended and a more preferred subscription is free again.
 */
export function autoMove(current, why) {
  const profiles = listProfiles();
  const names = usableOrder();
  const limited = limitedProfiles();
  const best = autoIdentity(names, profiles, limited);
  if (!best || best.name === current || best.name in limited) return null;
  if (why === 'limit') return current in limited ? best.name : null;
  const at = (n) => (names.indexOf(n) < 0 ? Infinity : names.indexOf(n));
  return at(best.name) < at(current) ? best.name : null;
}

const profileNamed = async (name) => (name === AUTO ? autoProfile() : readProfile(name));

// Flags that choose the session. They are dropped when a session moves to another profile (the move sets its own).
const SESSION_FLAGS = new Set(['-c', '--continue', '-r', '--resume', '--session-id', '--fork-session', '--from-pr', '--teleport']);
// Flags that are kept on a move: how Claude should run, not what it should do. Anything else (a prompt, a
// one-off flag) belongs to the first launch only.
const CARRY_VALUE = new Set([
  '--model', '--effort', '--permission-mode', '--fallback-model', '--append-system-prompt', '--system-prompt',
  '--settings', '--setting-sources', '--agents', '--plugin-dir',
]);
const CARRY_MANY = new Set(['--add-dir', '--mcp-config', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools']);
// Hoprig's own flag, never handed to Claude Code: `--with <name>` opens one more entry of the workspace map as an extra
// folder for this session (workspace/needs.mjs). One value each time, and it may be given several times.
const CARRY_REPEAT = new Set(['--with']);
const CARRY_BOOL = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--chrome', '--no-chrome',
  '--ide', '--strict-mcp-config',
]);

export const hasSessionFlag = (args) => args.some((a) => SESSION_FLAGS.has(a.split('=')[0]));
export const isPrintMode = (args) => args.some((a) => a === '-p' || a === '--print');

/**
 * The conversation `args` start Claude Code on: the id after --resume (-r) or --session-id, else null. It goes into the
 * run record before Claude Code starts (runs.mjs: conversation), so the dashboard knows at once that this terminal runs
 * it, also after its own restart. A plain "continue the last conversation" (-c) names no id: only Claude Code knows
 * which one it takes, and says so at its start (the dashboard's own continue names the id: server.mjs). A fork
 * (--fork-session) writes a new conversation, not the one it reads.
 */
export function conversationOf(args) {
  const cut = args.indexOf('--');
  const given = cut < 0 ? args : args.slice(0, cut);
  if (given.includes('--fork-session')) return null;
  for (let i = 0; i < given.length; i++) {
    const [name, eq] = given[i].startsWith('--') ? [given[i].split('=')[0], given[i].split('=')[1]] : [given[i], undefined];
    if (!['-r', '--resume', '--session-id'].includes(name)) continue;
    const id = eq !== undefined ? eq : given[i + 1];
    if (isSessionId(id)) return id;
  }
  return null;
}

/**
 * The arguments that survive a move to another profile. Nothing after "--" is read: that is a first message, and a word
 * of it that looks like a flag must never reach a later start.
 */
export function carryArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    const name = a.startsWith('--') ? a.split('=')[0] : a;
    if (a.includes('=') && a.startsWith('--')) {
      if (CARRY_VALUE.has(name) || CARRY_MANY.has(name) || CARRY_REPEAT.has(name)) out.push(a);
    } else if (CARRY_REPEAT.has(name)) {
      if (i + 1 < args.length) out.push(a, args[++i]);
    } else if (CARRY_BOOL.has(name)) {
      out.push(a);
    } else if (CARRY_VALUE.has(name)) {
      if (i + 1 < args.length) out.push(a, args[++i]);
    } else if (CARRY_MANY.has(name)) {
      const vals = [];
      while (i + 1 < args.length && !args[i + 1].startsWith('-')) vals.push(args[++i]);
      if (vals.length) out.push(a, ...vals);
    }
  }
  return out;
}

/**
 * `--with <name>` (and `--with=<name>`) taken out of the arguments before Claude Code gets them; nothing after "--" (a
 * first message) is read. → { withs: [name], rest: [args] }
 */
export function takeWith(args) {
  const withs = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i));
      break;
    }
    if (a === '--with') {
      if (i + 1 < args.length) withs.push(args[++i]);
      else withs.push('');
    } else if (a.startsWith('--with=')) withs.push(a.slice(7));
    else rest.push(a);
  }
  return { withs, rest };
}

const flagName = (a) => (a.startsWith('--') ? a.split('=')[0] : a);
const hasFlag = (args, name) => args.some((a) => flagName(a) === name);

function dropValueFlag(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) i++;
    else if (!args[i].startsWith(`${name}=`)) out.push(args[i]);
  }
  return out;
}

/**
 * Keep only the last of a repeated single-value flag. A wrapper script that adds its own flags to every launch
 * would otherwise pile them up each time a session moves ("--effort high --effort high ...").
 */
export function dedupeFlags(args) {
  const last = new Map();
  for (let i = 0; i < args.length; i++) {
    const name = flagName(args[i]);
    if (CARRY_VALUE.has(name)) last.set(name, i);
  }
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const name = flagName(args[i]);
    const eq = args[i].startsWith('--') && args[i].includes('=');
    if (CARRY_VALUE.has(name) && last.get(name) !== i) {
      if (!eq) i++; // skip its value too
      continue;
    }
    out.push(args[i]);
    if (CARRY_VALUE.has(name) && !eq && i + 1 < args.length) out.push(args[++i]);
  }
  return out;
}

/**
 * The arguments that continue session `sessionId` under the profile `target`, given the arguments of the launch
 * it comes from. A model chosen with --model moves along, except to a profile that names its own model
 * (ANTHROPIC_MODEL): such a profile says what its endpoint can serve.
 *
 * `fresh`: nothing was said in the session yet, so it has no conversation on disk (sessions.mjs hasConversation)
 * and `--resume` would end with "No conversation found with session ID". Such a session starts on the target
 * under the same id instead (`--session-id`), which is all there is to carry over.
 */
export function moveArgs(target, args, sessionId, { fresh = false } = {}) {
  let carry = dedupeFlags(carryArgs(args));
  if (target.env.ANTHROPIC_MODEL) carry = dropValueFlag(carry, '--model');
  return [...carry, fresh ? '--session-id' : '--resume', sessionId];
}

/** The model Claude Code starts with when nothing chooses one: the user's settings, else its own default. */
function defaultModel() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8')).model;
    if (typeof m === 'string' && m) return m;
  } catch {
    /* no settings, or not ours to judge */
  }
  return 'default';
}

/**
 * A resumed session otherwise starts on the model named in its transcript. After a move that can be a name only
 * the other profile's endpoint knows (a proxy's own spelling), and Claude Code then refuses to answer. So a
 * resume always starts on this profile's model: --model if given, else the profile's ANTHROPIC_MODEL, else the
 * default.
 */
export function modelArgs(profile, args) {
  if (!hasSessionFlag(args) || hasFlag(args, '--model') || profile.env.ANTHROPIC_MODEL) return [];
  return ['--model', defaultModel()];
}

// Quote a path for the shell Claude Code runs hooks in: POSIX sh, or on Windows a shell where double quotes are
// the common ground (Git Bash, cmd).
const shq = (s) => (process.platform === 'win32' ? `"${String(s).replace(/"/g, '\\"')}"` : `'${String(s).replace(/'/g, `'\\''`)}'`);

// The events every Claude Code we support has, and the ones that make the status exact (hook.mjs says what each
// tells). An event name Claude Code does not know stops it at a "settings error" question when it starts (seen on
// 2.1.325 with a made-up name), so the second list is only handed to a version that surely has all of them: they
// were found in the programs of 2.1.319, 2.1.323 and 2.1.325. An older or unknown version keeps the first list.
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'Notification', 'SessionEnd'];
const EXACT_EVENTS = ['PermissionRequest', 'PostToolBatch', 'SubagentStop'];
export const EXACT_SINCE = '2.1.319';
const knowsExactEvents = (version) => !!version && compareVersions(version, EXACT_SINCE) >= 0;
const hookCommand = () => `${shq(process.execPath)} ${shq(hookFile())}`;
const hookEntry = (cmd, matcher = null) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];
// The tools the wall reads: the shell, and the file-writing tools (so a write that changes the rules Hoprig runs the
// session under is seen too). A matcher keeps the hook from starting for a read, a search or a question.
const WALL_TOOLS = WALL_MATCHER;

/**
 * The one hook a coding chat's Claude Code gets (src/chat/engines/claude.mjs): PermissionRequest, the same program as a
 * terminal session's, so that one rule with the shell's real folder answers a plain delete in bypass mode for both
 * (hook.mjs hookAnswer). `version`: the Claude Code that will read it; null for one that does not surely know the
 * event (it would stop at a settings error), and then the chat answers as before.
 */
export const permissionHook = (version) => (knowsExactEvents(version) ? { PermissionRequest: hookEntry(hookCommand()) } : null);

/**
 * A coding chat's hooks: PermissionRequest (above), and the events that say how a provider stopped the chat or an agent
 * of it and what clears that again (hook.mjs CHAT_EVENTS: they write only those fields of the chat's record). The same
 * versions only, so a chat on an older Claude Code starts as before.
 */
/**
 * The hook of a "Lead model" session: Claude Code's agent tool (Agent; Task in older versions) goes through the same
 * program, which takes a model or effort the lead named out of the call (hook.mjs leadAnswer).
 */
export const leadHook = () => ({ PreToolUse: [{ matcher: 'Agent|Task', hooks: [{ type: 'command', command: hookCommand(), timeout: 5 }] }] });

export function chatHooks(version, offered = false, hers = false) {
  const p = permissionHook(version);
  // A chat of Tia's holds below Full on every version: PreToolUse is older than the exact events, as a terminal of
  // hers carries it (hookSettings). It gets that hold alone, so nothing answers its OKs by hook.
  if (!p) return hers ? { PreToolUse: hookEntry(hookCommand(), WALL_TOOLS) } : null;
  const e = hookEntry(hookCommand());
  const hooks = { ...p, SessionStart: e, UserPromptSubmit: e, Stop: e, StopFailure: e };
  // The wall of Hands-off for a coding chat: the same PreToolUse hold a terminal gets (hookSettings), gated by the
  // same cheap state-folder marker, so a chat holds a command that is the owner's alone in bypass mode too. The hook
  // program reads the switch itself and judges by the chat's folder (hook.mjs sessionFacts). Installed only while
  // offered; a chat of his on a Claude Code too old for the exact events has no hooks at all (p is null).
  if (offered && process.platform !== 'win32') hooks.PreToolUse = hookEntry(`if [ -e "\${HOPRIG_RUN_FILE%/runs/*}/handsoff-active" ]; then ${hookCommand()}; fi`, WALL_TOOLS);
  // A chat of Tia's holds what is the owner's alone below Full whatever Hands-off says (hook.mjs sessionHold), as her
  // terminal does (hookSettings): its hook runs for every call the wall reads, with no gate a switch decides.
  if (hers) hooks.PreToolUse = hookEntry(hookCommand(), WALL_TOOLS);
  return hooks;
}

/**
 * Settings handed to Claude Code for this launch only: hooks that report the session id and state to the run
 * file, and (when `statusScript` is given) a status line command that saves the plan-usage numbers. `version` is
 * the Claude Code that will read them (null when not known).
 */
export function hookSettings({ statusScript = null, padding = 0, version = null, offered = false, hers = false } = {}) {
  const command = hookCommand();
  const hooks = {};
  for (const e of HOOK_EVENTS) hooks[e] = hookEntry(command);
  if (knowsExactEvents(version)) {
    for (const e of EXACT_EVENTS) hooks[e] = hookEntry(command);
    // After every batch of tool calls, in every subagent too: far too often to start a program each time. The
    // shell Claude Code runs hooks in looks for the run's mark first (runfile.mjs: watchFile) and starts the hook
    // only while its news could change something. Windows has no one shell to write that test for.
    if (process.platform !== 'win32') hooks.PostToolBatch = hookEntry(`if [ -e "$HOPRIG_RUN_FILE.watch" ]; then ${command}; fi`);
  }
  // The wall of Hands-off (hook.mjs preToolHold): PreToolUse sees each tool call before it runs and answers "ask" for
  // a command that is the owner's alone (wall.mjs), so the coding tool draws his card, in every mode. The hook reads
  // the switch from the config itself and is the last word on whether Hands-off is on; it holds nothing while the
  // switch is off. A cheap shell test gates it so an ordinary command starts no node process while nobody has
  // Hands-off on: the node hook runs only while one marker exists (server/handsoff.mjs writes it while any Hands-off
  // switch is on, and clears it otherwise). The marker sits in the state folder, which the wall itself protects, so a
  // session cannot remove it to go unheld. It only decides whether to START the hook — the hook still reads the
  // switch and is the authority, so a marker left behind merely wastes a start, never holds wrongly or lets a held
  // act through, and a project switch being on means the marker is present, so a session started after it was turned
  // on is held too. The state folder is `$HOPRIG_RUN_FILE` without its `/runs/<id>.json` tail. Read, Grep and Glob are
  // excluded by the matcher. Installed only while Hands-off is offered.
  if (offered && process.platform !== 'win32') hooks.PreToolUse = hookEntry(`if [ -e "\${HOPRIG_RUN_FILE%/runs/*}/handsoff-active" ]; then ${command}; fi`, WALL_TOOLS);
  // A session Tia started holds what is the owner's alone below Full whatever Hands-off says, and whether or not it is
  // offered (hook.mjs sessionHold): its hook runs for every call the wall reads, with no gate that a switch decides.
  if (hers) hooks.PreToolUse = hookEntry(command, WALL_TOOLS);
  const settings = { hooks };
  if (statusScript) settings.statusLine = { type: 'command', command: `sh ${shq(statusScript)}`, padding };
  return settings;
}

// The user's own status line, if they have one in Claude Code's settings.
function userStatusLine() {
  try {
    const sl = JSON.parse(fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8')).statusLine;
    if (sl && sl.type === 'command' && typeof sl.command === 'string' && sl.command.trim()) {
      return { command: sl.command, padding: Number.isInteger(sl.padding) ? sl.padding : 0 };
    }
  } catch {
    /* none */
  }
  return null;
}

/**
 * Claude Code hands its status line command a JSON document that includes how much of the plan's limits is used
 * and when they reset. This script, set as the status line for one launch, saves that document next to the run
 * record and then runs the user's own status line (if any) on the same input, so what they see does not change.
 * A shell script and not node: it runs several times a second while Claude writes.
 */
export function statusScript(user) {
  return [
    '#!/bin/sh',
    '# Written by Hoprig for one launch. Saves the status data for the usage display, then runs your own status line.',
    'i=$(cat)',
    'f="$HOPRIG_RUN_FILE.usage"',
    '[ -n "$HOPRIG_RUN_FILE" ] && printf \'%s\' "$i" > "$f.tmp" 2>/dev/null && mv "$f.tmp" "$f" 2>/dev/null',
    ...(user ? ["printf '%s' \"$i\" | {", user.command, '}'] : []),
    '',
  ].join('\n');
}

/**
 * Run one Claude Code process under `profile`. Resolves to { code, sessionId, signalled, auto }, where `auto` is
 * { to, why } when the launcher itself stopped Claude to continue the session on another profile.
 */
function runOnce(profile, args, cfg, { interactive = false, fallback = false, file: again = null, extras = null, hers = false } = {}) {
  const { file } = createRun({ profile: profile.name, cwd: process.cwd(), carryArgs: carryArgs(args), conversation: conversationOf(args), file: again });
  // The session's extra folders (by their map names) for its card and page.
  if (extras && extras.refs.length) updateRun(file, { extras: [...extras.refs] });
  // `fallback`: this session is here only because a preferred profile reached its limit (see launch()).
  if (fallback) updateRun(file, { fallback: true });
  // A new conversation started here on purpose makes this the folder's provider: the next new session here starts
  // on it (defaultprovider.mjs). A resume, a move (a limit card's "Continue on"), a restore and a limit fallback
  // carry a conversation on (they always name it: --resume, --session-id, -c) and say nothing about where the next
  // one should start.
  if (!hasSessionFlag(args)) rememberFolderProvider(process.cwd(), profile.name);
  // The profile's model map, for this session only (providers/sessionmap.mjs): a moved session gets the new profile's.
  const map = sessionMap(profile);
  let env = mapEnv(profileEnv(profile), map);
  env.HOPRIG_RUN_FILE = file;
  // A session the dashboard started for Tia (its launch file said so: launchfile.mjs takeHers) is marked hers before
  // the coding tool starts, and signs in to the git server with the file the owner chose in place of his own, both
  // through the one startAsHers. Every run of this launcher is hers: a move to another provider, a restart on a new
  // record. A session started by a person's own `hoprig` never is (no launch file says so).
  if (hers) {
    env = startAsHers(file, env, { cfg: loadConfig(), credsDir: credsDir(), onProblem: (why) => console.error(`hoprig: Tia's git sign-in could not be used (${why}); this session signs in to git with no token until the file is fixed`) });
  }

  if (profile.prerun) {
    // Its output goes to stderr: stdout belongs to Claude Code alone (think `-p --output-format json | jq`).
    // `shell: true` is sh on Linux and macOS and cmd on Windows.
    const r = spawnSync(profile.prerun, { shell: true, stdio: ['inherit', 2, 'inherit'], env });
    if (r.status !== 0) {
      console.error(`hoprig: the profile's PRERUN command failed (${r.status ?? r.signal}): ${profile.prerun}`);
      return endRun(file).then(() => ({ code: 1, sessionId: null, signalled: true }));
    }
  }

  // Our hooks ride on --settings, as a file (a JSON argument would need different quoting on every platform).
  // When the caller passes their own --settings we leave it alone: no live status then.
  // A first message after "--" (the dashboard's start with a prompt, deck.mjs) stays last: flags added below
  // must come before it, or Claude Code would read them as part of the prompt.
  const taken = takeWith(dedupeFlags([...sessionArgs(cfg), ...cfg.claudeArgs, ...args]));
  const all = taken.rest;
  const cut = all.indexOf('--');
  const given = cut < 0 ? all : all.slice(0, cut);
  const promptTail = cut < 0 ? [] : all.slice(cut);
  let settingsFile = null;
  let scriptFile = null;
  if (!hasFlag(given, '--settings')) {
    settingsFile = path.join(hookSettingsDir(), `${path.basename(file)}`);
    fs.mkdirSync(hookSettingsDir(), { recursive: true, mode: 0o700 });
    let status = {};
    // Usage tracking rides on the status line. Interactive sessions only, POSIX only (it is a sh script), and
    // "usage": false in the config turns it off.
    if (interactive && cfg.usage !== false && process.platform !== 'win32') {
      const user = userStatusLine();
      scriptFile = settingsFile.replace(/\.json$/, '') + '.statusline.sh';
      fs.writeFileSync(scriptFile, statusScript(user), { mode: 0o700 });
      status = { statusScript: scriptFile, padding: user ? user.padding : 0 };
    }
    // One file carries the hooks (with the wall of Hands-off when offered), this provider's model map
    // (providers/sessionmap.mjs) and the project's extra folders.
    const version = claudeVersionQuick({ bin: cfg.claudeBin, env });
    fs.writeFileSync(settingsFile, JSON.stringify(withExtras({ ...hookSettings({ ...status, version, offered: handsOffOffered(cfg), hers }), ...mapSettings(map, version) }, extras && extras.settings)) + '\n', { mode: 0o600 });
  }
  const addDirs = settingsFile && extras ? extras.dirs : [];
  const full = [...given, ...modelArgs(profile, given), ...(addDirs.length ? ['--add-dir', ...addDirs] : []), ...(settingsFile ? ['--settings', settingsFile] : []), ...promptTail];
  // `keep`: this launcher moves the conversation on by itself. Its record stays, naming the conversation, until the
  // next run writes it anew: no moment without one, in which something else could start a process on it.
  // Returns true when the record went and something was typed for Claude during the run (typinglock.mjs).
  const cleanup = (keep = null) => {
    // What this run learnt stays known after it: its plan usage, per provider (the Providers page shows it with its
    // time), and that the stored sign-in works when a reply came back on it (the default folder's: a provider with a
    // folder of its own says nothing about it).
    try {
      noteUsage(file, profile.name);
      const run = readRun(file);
      if (profile.kind === 'login' && !ownFolder(profile) && run && run.stopAt && !run.failure) rememberLogin({ loggedIn: true, plan: loginSeen()?.plan });
    } catch {
      /* never in the way of ending a run */
    }
    let typed = false;
    if (keep) createRun({ profile: profile.name, cwd: process.cwd(), carryArgs: carryArgs(args), conversation: keep, file });
    else typed = removeLocked(file); // after a text being typed for the tool right now (typinglock.mjs)
    fs.rmSync(usageFile(file), { force: true });
    if (settingsFile) fs.rmSync(settingsFile, { force: true });
    if (scriptFile) fs.rmSync(scriptFile, { force: true });
    return typed;
  };

  return new Promise((resolve) => {
    // On Windows a bare "claude" may be claude.exe (the native install) or claude.cmd (npm), which needs cmd.exe.
    let plan = { command: cfg.claudeBin, args: full, options: {} };
    if (process.platform === 'win32') {
      const found = resolveWindowsBin(cfg.claudeBin, env);
      if (found) plan = windowsSpawnPlan(found, full, env);
    }
    const spawnedAt = Date.now(); // an error end within the first seconds is an end at the start (startfail.mjs)
    const child = spawn(plan.command, plan.args, { stdio: 'inherit', env, ...plan.options });
    let signalled = false;
    // Ctrl+C belongs to Claude Code (it shares our terminal and gets the key itself): we only must not die of it.
    const onInt = () => {};
    const forward = (sig) => () => { signalled = true; try { child.kill(sig); } catch { /* gone */ } };
    const onTerm = forward('SIGTERM');
    const onHup = forward('SIGHUP');
    process.on('SIGINT', onInt);
    process.on('SIGTERM', onTerm);
    process.on('SIGHUP', onHup);

    // ---- auto-switch: watch the run record that Claude Code's hooks keep current ----
    let auto = null; // { to, why } once we decided to move the session
    let seenLimit = 0;
    let seenStop = 0;
    let killTimer = null;
    const stopForMove = (to, why) => {
      auto = { to, why };
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 5000);
    };
    let ticks = 0;
    const watch = setInterval(() => {
      if (auto) return;
      if (profile.router) {
        // Auto mode: the router moves to API accounts by itself. What it cannot do is use another subscription
        // (only Claude Code itself may), so for that this launcher restarts Claude Code as that account: at once
        // when the current one is at its limit, and between replies when a more preferred one is free again.
        if (++ticks % 20 === 0) ensureRouter().catch(() => {});
        const run = readRun(file);
        if (!run || !interactive || !run.sessionId) return;
        if (run.limit && run.limit.at !== seenLimit) {
          seenLimit = run.limit.at;
          if (autoMove(profile.identity, 'limit')) stopForMove(AUTO, 'limit');
        } else if (run.stopAt && run.stopAt !== seenStop) {
          seenStop = run.stopAt;
          if (autoMove(profile.identity, 'return')) stopForMove(AUTO, 'return');
        }
        return;
      }
      const run = readRun(file);
      if (!run) return;
      if (run.limit && run.limit.at !== seenLimit) {
        seenLimit = run.limit.at;
        // Remember it whatever the settings say: menus and the dashboard show which profile is at its limit.
        const usage = readUsage(file);
        const fromUsage = usage ? Math.max(0, ...Object.values(usage).filter((w) => w && w.pct >= 99 && w.resetsAt).map((w) => w.resetsAt)) : 0;
        markLimited(profile.name, { until: parseResets(run.limit.text) || fromUsage || null, reason: run.limit.error, text: run.limit.text });
        if (!interactive || !run.sessionId || !getAutoSwitch().enabled) return;
        const to = nextProfile(profile.name);
        if (to) stopForMove(to, 'limit');
      } else if (run.stopAt && run.stopAt !== seenStop) {
        seenStop = run.stopAt;
        // The reply is finished: the one moment a session can move back without cutting anything off. Only a
        // session that was moved here by a limit goes back; one the user started on this profile stays.
        if (!interactive || !fallback || !run.sessionId) return;
        const as = getAutoSwitch();
        if (!as.enabled || !as.returnToPreferred) return;
        const to = preferredAvailable(profile.name);
        if (to) stopForMove(to, 'return');
      }
    }, 500);

    const done = (code) => {
      clearInterval(watch);
      clearTimeout(killTimer);
      process.off('SIGINT', onInt);
      process.off('SIGTERM', onTerm);
      process.off('SIGHUP', onHup);
      const run = readRun(file);
      const keep = auto && !signalled && run?.sessionId ? run.sessionId : null;
      // Claude Code ended at its start (it refuses bypass permissions mode for root, a sign-in or the network is
      // missing): noted for the dashboard's card before the record goes, and said under the tool's own words.
      if (endedAtStart({ code, ms: Date.now() - spawnedAt, signalled, moved: !!auto }) && noteStartFailure(run, { code, tool: 'claude' })) console.error(endedLine('claude', code));
      const typed = cleanup(keep);
      // The record is gone: text typed for Claude that it did not read is thrown away before the menu or the shell
      // reads this terminal (typinglock.mjs). A kept record goes on with the next run, which reads the terminal.
      (typed ? settleInput() : Promise.resolve()).then(() => {
        if (auto && process.stdout.isTTY) {
          // We stopped Claude ourselves: make sure its full-screen mode, mouse reporting and hidden cursor are off.
          process.stdout.write('\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\r\n');
          if (process.platform !== 'win32') spawnSync('stty', ['sane'], { stdio: 'inherit' });
        }
        // Hands-off's stops of the run that just ended (the record is about to go): the launcher's own menu move
        // hands them, with this run id, to the next run (createRun reuses the id). A kept record (an auto move) keeps
        // them itself, so none is read for it.
        resolve({ code, sessionId: run?.sessionId || null, signalled, auto, kept: keep ? file : null, carry: keep ? null : carryOf(run), ended: endedBySelf(run, code) });
      });
    };
    child.on('error', (e) => {
      console.error(e.code === 'ENOENT'
        ? `hoprig: "${cfg.claudeBin}" was not found. Install Claude Code, or set "claudeBin" in the Hoprig config` +
          (process.platform === 'win32' ? ' to the full path of claude.exe.' : '.')
        : `hoprig: could not start ${cfg.claudeBin}: ${e.message}`);
      done(127);
    });
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}

/**
 * Did the person end this session themselves (/exit, Ctrl+D, Ctrl+C twice)? Not when it stopped at a limit or a
 * provider's error that is still on the record, nor when Claude Code ended with an error code. Claude Code's own
 * reason (SessionEnd, hook.mjs) decides; without one (an older Claude Code, a hook that did not run) exit code 0
 * means yes.
 */
export function endedBySelf(run, code) {
  if (code !== 0 || run?.limit || run?.failure) return false;
  return !run?.endReason || run.endReason === 'prompt_input_exit';
}

/**
 * Launch `profileName` with `args` for Claude Code. In a terminal, after Claude stops at a limit, an error or an
 * error code, `askNext` (see menu.mjs) may name another profile; the same session then continues there. A session
 * the person ended themselves just ends, with one line on how to continue it later. Returns the exit code.
 */
/**
 * The extra folders of a session started here (workspace/needs.mjs): its project's needs that are on this computer and
 * each `--with`, decided once at the start; said on the error output before Claude Code starts. A `--with` that cannot
 * be opened refuses the start (→ { refused }); a need that cannot is only said. Read from the settings Hoprig hands the
 * session, so a session started with its own --settings gets no extra folder (and is told so).
 */
export async function startExtras(args, { cwd = process.cwd(), say = (l) => console.error(l) } = {}) {
  const { withs, rest } = takeWith(args);
  const cut = rest.indexOf('--');
  const own = hasFlag(cut < 0 ? rest : rest.slice(0, cut), '--settings'); // the caller's own settings file
  const N = await import('./workspace/needs.mjs');
  const ex = await N.sessionExtras(cwd, { withs });
  if (ex.refused.length) return { refused: ex.refused.map((r) => `hoprig: ${r}`) };
  for (const l of N.startNote(ex)) say(`hoprig: ${l}`);
  if (!ex.dirs.length) return { extras: null };
  if (own) {
    say('hoprig: these extra folders are not opened: this session has settings of your own (--settings), where Hoprig cannot keep them read-only');
    if (withs.length) return { refused: ['hoprig: --with cannot be used together with --settings'] };
    return { extras: null };
  }
  return { extras: { dirs: ex.dirs, refs: ex.refs, settings: await N.extraSettings(ex.dirs, { walked: ex.walked }) } };
}

export async function launch(profileName, args, { askNext = null } = {}) {
  const cfg = loadConfig();
  // Decided once, at the start: a need renamed or taken out of the map meanwhile changes nothing until the next start.
  const ex = await startExtras([...sessionArgs(cfg), ...cfg.claudeArgs, ...args]).catch((e) => ({ refused: [`hoprig: the extra folders could not be read: ${e.message}`] }));
  if (ex.refused) {
    for (const l of ex.refused) console.error(l);
    console.error('hoprig: the session was not started');
    return 2;
  }
  const extras = ex.extras;
  let name = profileName;
  let current = args;
  let fallback = false; // true once a limit moved this session off the profile it was started on
  // This launch's run record: written before anything can refuse the start, and kept by the launcher's own moves.
  let kept = null;
  // A move of the dashboard's hands this launcher the run id and the stops of the run it came from (launchfile.mjs):
  // for its first record only.
  let hand = takeHand();
  // Whether the dashboard started this launcher for Tia (launchfile.mjs): for every run of this launch.
  const hers = takeHers();
  let menu = null; // while a choice of the launcher's own menu starts: { ask (what askNext was given), args, fresh }
  // Whatever ends the launch, no record names a conversation that nothing runs (a record of a launcher that has
  // ended goes by itself too: runs.mjs listRuns).
  const drop = async () => {
    const was = kept;
    kept = null;
    if (was) await endRun(was); // under the typing lock, then the terminal's input settled (typinglock.mjs)
  };
  // The start was refused: the launch ends with `code`, or, from the launcher's own menu, the menu asks again (→ null).
  const refused = async (code) => {
    await drop();
    if (!menu) return code;
    const next = await askNext(menu.ask);
    const target = next ? await profileNamed(next).catch(() => null) : null;
    if (!target) return code;
    name = next;
    current = moveArgs(target, menu.args, menu.ask.sessionId, { fresh: menu.fresh });
    return null;
  };
  for (;;) {
    // The record first, naming the conversation: from here on nothing else starts a process on it. Every check below
    // that refuses the start removes it again, so a terminal that runs nothing holds nothing.
    const conversation = conversationOf(current);
    if (!kept) kept = createRun({ profile: name, cwd: process.cwd(), carryArgs: carryArgs(current), conversation, hand }).file;
    hand = null;
    const mine = readRun(kept);
    // One conversation, one process: a chat or another terminal that runs it already keeps it (held.mjs).
    let why = mine && refuseIfHeld(mine, conversation) ? [] : null;
    let profile = null;
    if (!why) {
      profile = await profileNamed(name).catch((e) => {
        why = [`hoprig: ${e.message}`]; // Auto mode's router did not start
        return null;
      });
    }
    // An order whose every provider is left out (gone, not serving Claude Code, billed by use) is there, it may not be
    // used: say why, each provider with its own reason (the router's 503 says the same).
    if (!why && !profile && name === AUTO) why = [nothingUsableLine(leftOutOfOrder())
      || 'hoprig: Auto mode needs the order of providers first, for example: hoprig auto order sub api'];
    else if (!why && !profile) why = [`hoprig: no profile "${name}" (profiles: ${listProfiles().map((p) => p.name).join(', ') || 'none yet'}). Add one with: hoprig add`];
    // An OpenAI key or another coding tool's sign-in: Claude Code cannot use it (profileEnv refuses it too). Why, and
    // what to do instead.
    else if (!why && !servesTools(profile).includes('claude')) why = notServedLines(profile, 'claude');
    if (why) {
      for (const line of why) console.error(line);
      const code = await refused(2);
      if (code !== null) return code;
      continue;
    }
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isPrintMode(current);
    if (interactive) console.error(`hoprig: profile ${profile.name} · ${profile.label}`);
    const once = await runOnce(profile, current, cfg, { interactive, fallback, file: kept, extras, hers });
    const { code, sessionId, signalled, auto, ended } = once;
    const ranId = kept ? path.basename(kept, '.json') : null; // the run that just ended, for the launcher's own menu move
    const ranCarry = once.carry; // its Hands-off stops, read before runOnce removed its record
    kept = once.kept;
    menu = null;
    // A session nobody typed into has nothing on disk to resume: it starts on the next profile under the same id.
    const fresh = Boolean(sessionId) && !hasConversation(process.cwd(), sessionId);
    if (auto && sessionId && !signalled) {
      const target = await profileNamed(auto.to);
      if (target) {
        // Named as the Providers page names them: the label (an account Auto mode runs as, by its own profile).
        const named = (p) => (p.identity ? providerName(p.identity, readProfile(p.identity)?.label) : providerName(p.name, p.label));
        const from = named(profile);
        const to = named(target);
        if (auto.why === 'limit') {
          console.error(`hoprig: ${from} reached its usage limit. Continuing this session on ${to}.`);
          // The interrupted request is in the transcript; this prompt makes Claude pick it up again.
          current = [...moveArgs(target, current, sessionId, { fresh }), ...(fresh ? [] : [getAutoSwitch().prompt])];
          fallback = true;
        } else {
          console.error(`hoprig: ${to} is available again. Moving this session back to it.`);
          current = moveArgs(target, current, sessionId, { fresh });
        }
        name = target.name;
        continue;
      }
    }
    await drop();
    if (!interactive || signalled || !sessionId) return code;
    if (ended) {
      if (!fresh) {
        const line = `To continue it later: hoprig -c, or on another profile: hoprig <profile> --resume ${sessionId}`;
        process.stderr.write(`${process.stderr.isTTY ? `\x1b[2m${line}\x1b[0m` : line}\n`);
      }
      return code;
    }
    if (!askNext) return code;
    const ask = { current: profile.name, sessionId, saved: !fresh };
    const next = await askNext(ask);
    if (!next) return code;
    const target = await profileNamed(next).catch(() => null);
    if (!target) return code;
    menu = { ask, args: current, fresh };
    name = next;
    current = moveArgs(target, current, sessionId, { fresh });
    // Hand the stops and the old run id to the fresh run (createRun reuses the id, since its record is gone, and the
    // owner's switch sits under that id): without this the menu move would lose both and follow the project's switch.
    // A run with no stops still hands its id while Hands-off is offered: the owner's own Off or On for the session sits
    // under it, and a new id would leave the session on the project's switch. The config is read now, since the owner
    // may have offered it after this launcher started. With it not offered (and no stops) the move is as it always was.
    if (ranId && (ranCarry || handsOffOffered(loadConfig()))) hand = { from: ranId, runId: ranId, conversation: sessionId, carry: ranCarry || {} };
  }
}
