// Start Claude Code under a profile, and when it exits offer to carry the SAME session on under another profile.
//
// Why this works: Claude Code keeps a session as a file in <claudeDir>/projects, keyed by folder and not by
// account, and decides which account or API to use from its environment. So a profile is only a set of
// environment variables, and "continue under another profile" is `claude --resume <id>` with other variables.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getAutoSwitch, limitedProfiles, markLimited, nextProfile, parseResets, preferredAvailable, usableOrder } from './autoswitch.mjs';
import { claudeLoginStatus, claudeVersionQuick } from './claudecode.mjs';
import { loadConfig, sessionArgs } from './config.mjs';
import { rememberFolderProvider } from './defaultprovider.mjs';
import { claudeDir, hookFile, hookSettingsDir } from './paths.mjs';
import { listProfiles, notServedLines, profileEnv, readProfile, servesTools } from './profiles.mjs';
import { loginSeen, rememberLogin } from './routerstate.mjs';
import { createRun, noteUsage, readRun, readUsage, removeRun, updateRun, usageFile } from './runs.mjs';
import { hasConversation } from './sessions.mjs';
import { compareVersions } from './setup/system.mjs';
import { AUTO, autoIdentity, ensureRouter } from './router.mjs';
import { resolveWindowsBin, windowsSpawnPlan } from './winspawn.mjs';

/**
 * The profile behind the name "auto": Claude Code runs as the identity account (see router.mjs) and talks to the
 * router, which spreads its requests over the accounts in the owner's order. null when no order is set.
 */
export async function autoProfile({ loginStatus = claudeLoginStatus } = {}) {
  const profiles = listProfiles();
  const names = usableOrder();
  const limited = limitedProfiles();
  let identity = autoIdentity(names, profiles, limited);
  if (!identity) return null;
  if (identity.kind === 'login') {
    // Claude Code refuses to send anything while its stored login is expired, whatever the router could do. So
    // when nobody is logged in, run as another account of the order: a subscription token, else an API account.
    const status = await loginStatus().catch(() => ({ loggedIn: null }));
    if (status.loggedIn === false) {
      const other = autoIdentity(names, profiles, limited, [identity.name]);
      if (other) {
        console.error(`hoprig: nobody is logged in to Claude Code on this computer (run: claude auth login). Auto mode runs as "${other.name}" meanwhile.`);
        identity = other;
      }
    }
  }
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

const profileNamed = (name) => (name === AUTO ? autoProfile() : readProfile(name));

// Flags that choose the session. They are dropped when a session moves to another profile (the move sets its own).
const SESSION_FLAGS = new Set(['-c', '--continue', '-r', '--resume', '--session-id', '--fork-session', '--from-pr', '--teleport']);
// Flags that are kept on a move: how Claude should run, not what it should do. Anything else (a prompt, a
// one-off flag) belongs to the first launch only.
const CARRY_VALUE = new Set([
  '--model', '--effort', '--permission-mode', '--fallback-model', '--append-system-prompt', '--system-prompt',
  '--settings', '--setting-sources', '--agents', '--plugin-dir',
]);
const CARRY_MANY = new Set(['--add-dir', '--mcp-config', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools']);
const CARRY_BOOL = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--chrome', '--no-chrome',
  '--ide', '--strict-mcp-config',
]);

export const hasSessionFlag = (args) => args.some((a) => SESSION_FLAGS.has(a.split('=')[0]));
export const isPrintMode = (args) => args.some((a) => a === '-p' || a === '--print');

/** The arguments that survive a move to another profile. */
export function carryArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const name = a.startsWith('--') ? a.split('=')[0] : a;
    if (a.includes('=') && a.startsWith('--')) {
      if (CARRY_VALUE.has(name) || CARRY_MANY.has(name)) out.push(a);
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

/**
 * Settings handed to Claude Code for this launch only: hooks that report the session id and state to the run
 * file, and (when `statusScript` is given) a status line command that saves the plan-usage numbers. `version` is
 * the Claude Code that will read them (null when not known).
 */
export function hookSettings({ statusScript = null, padding = 0, version = null } = {}) {
  const command = `${shq(process.execPath)} ${shq(hookFile())}`;
  const entry = (cmd) => [{ hooks: [{ type: 'command', command: cmd, timeout: 5 }] }];
  const hooks = {};
  for (const e of HOOK_EVENTS) hooks[e] = entry(command);
  if (version && compareVersions(version, EXACT_SINCE) >= 0) {
    for (const e of EXACT_EVENTS) hooks[e] = entry(command);
    // After every batch of tool calls, in every subagent too: far too often to start a program each time. The
    // shell Claude Code runs hooks in looks for the run's mark first (runfile.mjs: watchFile) and starts the hook
    // only while its news could change something. Windows has no one shell to write that test for.
    if (process.platform !== 'win32') hooks.PostToolBatch = entry(`if [ -e "$HOPRIG_RUN_FILE.watch" ]; then ${command}; fi`);
  }
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
function runOnce(profile, args, cfg, { interactive = false, fallback = false } = {}) {
  const { file } = createRun({ profile: profile.name, cwd: process.cwd(), carryArgs: carryArgs(args) });
  // `fallback`: this session is here only because a preferred profile reached its limit (see launch()).
  if (fallback) updateRun(file, { fallback: true });
  // A new conversation started here on purpose makes this the folder's provider: the next new session here starts
  // on it (defaultprovider.mjs). A resume, a move (a limit card's "Continue on"), a restore and a limit fallback
  // carry a conversation on (they always name it: --resume, --session-id, -c) and say nothing about where the next
  // one should start.
  if (!hasSessionFlag(args)) rememberFolderProvider(process.cwd(), profile.name);
  const env = profileEnv(profile);
  env.HOPRIG_RUN_FILE = file;

  if (profile.prerun) {
    // Its output goes to stderr: stdout belongs to Claude Code alone (think `-p --output-format json | jq`).
    // `shell: true` is sh on Linux and macOS and cmd on Windows.
    const r = spawnSync(profile.prerun, { shell: true, stdio: ['inherit', 2, 'inherit'], env });
    if (r.status !== 0) {
      removeRun(file);
      console.error(`hoprig: the profile's PRERUN command failed (${r.status ?? r.signal}): ${profile.prerun}`);
      return Promise.resolve({ code: 1, sessionId: null, signalled: true });
    }
  }

  // Our hooks ride on --settings, as a file (a JSON argument would need different quoting on every platform).
  // When the caller passes their own --settings we leave it alone: no live status then.
  // A first message after "--" (the dashboard's start with a prompt, deck.mjs) stays last: flags added below
  // must come before it, or Claude Code would read them as part of the prompt.
  const all = dedupeFlags([...sessionArgs(cfg), ...cfg.claudeArgs, ...args]);
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
    fs.writeFileSync(settingsFile, JSON.stringify(hookSettings({ ...status, version: claudeVersionQuick({ bin: cfg.claudeBin, env }) })) + '\n', { mode: 0o600 });
  }
  const full = [...given, ...modelArgs(profile, given), ...(settingsFile ? ['--settings', settingsFile] : []), ...promptTail];
  const cleanup = () => {
    // What this run learnt stays known after it: its plan usage, per provider (the Providers page shows it with its
    // time), and that the stored sign-in works when a reply came back on it.
    try {
      noteUsage(file, profile.name);
      const run = readRun(file);
      if (profile.kind === 'login' && run && run.stopAt && !run.failure) rememberLogin({ loggedIn: true, plan: loginSeen()?.plan });
    } catch {
      /* never in the way of ending a run */
    }
    removeRun(file);
    fs.rmSync(usageFile(file), { force: true });
    if (settingsFile) fs.rmSync(settingsFile, { force: true });
    if (scriptFile) fs.rmSync(scriptFile, { force: true });
  };

  return new Promise((resolve) => {
    // On Windows a bare "claude" may be claude.exe (the native install) or claude.cmd (npm), which needs cmd.exe.
    let plan = { command: cfg.claudeBin, args: full, options: {} };
    if (process.platform === 'win32') {
      const found = resolveWindowsBin(cfg.claudeBin, env);
      if (found) plan = windowsSpawnPlan(found, full, env);
    }
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
      cleanup();
      if (auto && process.stdout.isTTY) {
        // We stopped Claude ourselves: make sure its full-screen mode, mouse reporting and hidden cursor are off.
        process.stdout.write('\x1b[?1049l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[0m\r\n');
        if (process.platform !== 'win32') spawnSync('stty', ['sane'], { stdio: 'inherit' });
      }
      resolve({ code, sessionId: run?.sessionId || null, signalled, auto });
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
 * Launch `profileName` with `args` for Claude Code. In a terminal, after Claude exits, `askNext` (see menu.mjs)
 * may name another profile; the same session then continues there. Returns the exit code.
 */
export async function launch(profileName, args, { askNext = null } = {}) {
  const cfg = loadConfig();
  let name = profileName;
  let current = args;
  let fallback = false; // true once a limit moved this session off the profile it was started on
  for (;;) {
    const profile = await profileNamed(name);
    if (!profile && name === AUTO) {
      console.error('hoprig: Auto mode needs the order of providers first, for example: hoprig auto order sub api');
      return 2;
    }
    if (!profile) {
      const known = listProfiles().map((p) => p.name).join(', ') || 'none yet';
      console.error(`hoprig: no profile "${name}" (profiles: ${known}). Add one with: hoprig add`);
      return 2;
    }
    if (!servesTools(profile).includes('claude')) {
      // An OpenAI key or another coding tool's sign-in: Claude Code cannot use it (profileEnv refuses it too). Why,
      // and what to do instead.
      for (const line of notServedLines(profile, 'claude')) console.error(line);
      return 2;
    }
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isPrintMode(current);
    if (interactive) console.error(`hoprig: profile ${profile.name} · ${profile.label}`);
    const { code, sessionId, signalled, auto } = await runOnce(profile, current, cfg, { interactive, fallback });
    // A session nobody typed into has nothing on disk to resume: it starts on the next profile under the same id.
    const fresh = Boolean(sessionId) && !hasConversation(process.cwd(), sessionId);
    if (auto && sessionId && !signalled) {
      const target = await profileNamed(auto.to);
      if (target) {
        const from = profile.identity || profile.name;
        const to = target.identity || target.name;
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
    if (!interactive || signalled || !askNext || !sessionId) return code;
    const next = await askNext({ current: profile.name, sessionId, saved: !fresh });
    if (!next) return code;
    const target = await profileNamed(next);
    if (!target) return code;
    name = next;
    current = moveArgs(target, current, sessionId, { fresh });
  }
}
