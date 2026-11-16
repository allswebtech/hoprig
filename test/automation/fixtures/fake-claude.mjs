#!/usr/bin/env node
// Stands in for Claude Code itself (config "claudeBin"), so the REAL launcher runs: session defaults, carried
// arguments, the hook settings and the run record are all the real ones; only the model is fake.
// It prints the command line it got, then runs the hooks the launcher gave it (--settings) the way Claude Code
// does: SessionStart at start; per line typed, UserPromptSubmit, a short "think", then Stop with the answer.
// A line containing FAIL-OVERLOADED ends in StopFailure (error "overloaded") the first time it is seen; "/exit" ends it.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const sessionId = flag('--resume') || flag('--session-id') || randomUUID();
const settings = flag('--settings');
const hooks = settings ? JSON.parse(fs.readFileSync(settings, 'utf8')).hooks || {} : {};
const THINK_MS = Number(process.env.FAKE_CLAUDE_THINK_MS || 800);

function hook(event, extra = {}) {
  const entry = hooks[event] && hooks[event][0] && hooks[event][0].hooks[0];
  if (!entry) return;
  try {
    execFileSync('sh', ['-c', entry.command], { input: JSON.stringify({ hook_event_name: event, session_id: sessionId, ...extra }), stdio: ['pipe', 'ignore', 'ignore'], timeout: 10_000 });
  } catch {
    /* a hook never stops Claude Code */
  }
}

// The transcript file Claude Code keeps per conversation (what --resume needs to find). As Claude Code 2.1.325
// does, it is written with the first message and not before, and a --resume that finds none ends at once.
const dir = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
const transcript = path.join(dir, `${sessionId}.jsonl`);
const said = (line) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: line } })}\n`);
};

process.stdout.write(`FAKE-CLAUDE args=${JSON.stringify(args.filter((a, i) => a !== '--settings' && args[i - 1] !== '--settings'))}\n`);
if (flag('--resume') && !fs.existsSync(transcript)) {
  hook('SessionEnd'); // the launcher learns the id, as it does from the real one
  process.stdout.write(`No conversation found with session ID: ${sessionId}\n`);
  process.exit(1);
}
hook('SessionStart', { source: flag('--resume') ? 'resume' : 'startup' });
process.stdout.write('> ');

const failed = new Set();
let busy = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  busy = busy.then(async () => {
    if (line.trim() === '/exit') {
      hook('SessionEnd'); // a command, not a message: nothing is added to the conversation
      process.exit(0);
    }
    said(line);
    hook('UserPromptSubmit', { prompt: line });
    process.stdout.write(`GOT: ${line}\n`);
    await new Promise((r) => setTimeout(r, THINK_MS));
    if (line.includes('FAIL-OVERLOADED') && !failed.has(line)) {
      failed.add(line);
      process.stdout.write('API Error: 529 overloaded\n> ');
      hook('StopFailure', { error: 'overloaded', last_assistant_message: 'API Error: 529 {"type":"overloaded_error"}' });
      return;
    }
    process.stdout.write(`DONE: ${line}\n> `);
    hook('Stop', { last_assistant_message: `Done: ${line}` });
  });
}).on('close', () => {
  hook('SessionEnd');
  process.exit(0);
});
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));
