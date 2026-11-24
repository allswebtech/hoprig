#!/usr/bin/env node
// Stands in for Claude Code (config "claudeBin") behind the REAL launcher, to show what a session is given: it asks
// the PreToolUse hook the launcher handed it (--settings) about a few shell commands, exactly as Claude Code would
// before running them, and writes what the hook answered and the git sign-in its environment carries to
// <state>/probe-<run id>.json. It runs no command itself. Then it waits, as an idle session does, until it is ended.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const at = args.indexOf('--settings');
const settings = at >= 0 ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8')) : {};
const pre = (settings.hooks && settings.hooks.PreToolUse) || [];
const COMMANDS = ['sudo true', 'git push origin main', 'sudo su -', 'ls'];
const flag = (name) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : null);
const sessionId = flag('--resume') || flag('--session-id') || randomUUID();

// SessionStart, as Claude Code sends it: the launcher's record learns the conversation id (a move needs it).
function sessionStart() {
  const e = settings.hooks && settings.hooks.SessionStart && settings.hooks.SessionStart[0];
  if (!e) return;
  try {
    execFileSync('sh', ['-c', e.hooks[0].command], { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup' }), stdio: ['pipe', 'ignore', 'ignore'], timeout: 15_000 });
  } catch {
    /* a hook never stops the coding tool */
  }
}

function ask(command) {
  const entry = pre.find((e) => e && typeof e.matcher === 'string' && e.matcher.split('|').includes('Bash'));
  const hook = entry && entry.hooks && entry.hooks[0];
  if (!hook) return { hook: false, decision: null };
  let out = '';
  try {
    out = execFileSync('sh', ['-c', hook.command], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: process.cwd(), session_id: sessionId }),
      encoding: 'utf8',
      timeout: 15_000,
    });
  } catch {
    /* a hook never stops the coding tool */
  }
  let decision = null;
  try {
    decision = JSON.parse(out.trim().split('\n').pop()).hookSpecificOutput.permissionDecision || null;
  } catch {
    /* no answer: the call goes on as the mode says */
  }
  return { hook: true, decision };
}

sessionStart();
const runFile = process.env.HOPRIG_RUN_FILE || '';
const result = {
  cwd: process.cwd(),
  runFile,
  ghToken: process.env.GH_TOKEN ?? null,
  githubToken: process.env.GITHUB_TOKEN ?? null,
  answers: Object.fromEntries(COMMANDS.map((c) => [c, ask(c)])),
};
const out = path.join(process.env.HOPRIG_STATE_DIR || '.', `probe-${path.basename(runFile, '.json')}.json`);
fs.writeFileSync(`${out}.part`, JSON.stringify(result));
fs.renameSync(`${out}.part`, out);
process.stdout.write('PROBE-DONE\n> ');
readline.createInterface({ input: process.stdin }).on('line', () => process.stdout.write('> ')).on('close', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
