#!/usr/bin/env node
// Dev-only (not in the published package): the coding-tool stand-in of tools/pr-tasks-drive.mjs. Everything goes to the
// demo's stand-in, except a first message "drive: tasks": the turn ends and two background tasks run on, a shell that
// writes its output to proj/tasks/tk-sh.output of the drive's tree copy and an agent.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const sessionId = val('--resume') || val('--session-id');
const model = val('--model') || 'default';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const real = spawn(process.execPath, [path.join(HERE, 'chat-real.mjs'), ...argv], { stdio: ['pipe', 'pipe', 'inherit'] });
readline.createInterface({ input: real.stdout }).on('line', (l) => process.stdout.write(`${l}\n`));
real.on('exit', (c) => process.exit(c ?? 0));
const sys = (o) => out({ type: 'system', session_id: sessionId, uuid: `s${Math.random()}`, ...o });
const usage = { input_tokens: 1200, cache_read_input_tokens: 18000, cache_creation_input_tokens: 0, output_tokens: 140 };
function scene() {
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: 'default', tools: ['Read', 'Edit', 'Bash', 'Agent'], slash_commands: ['compact'], skills: [] });
  out({ type: 'system', subtype: 'session_title_changed', title: 'Dev server and a check in the background', session_id: sessionId });
  const id = 'msg_drive_1';
  out({ type: 'assistant', message: { id, role: 'assistant', content: [{ type: 'text', text: 'The dev server and a check of the refund tests run in the background.' }], usage }, parent_tool_use_id: null, session_id: sessionId });
  sys({ subtype: 'task_started', task_id: 'tk-sh', task_type: 'local_bash', description: 'npm run dev', is_backgrounded: true });
  sys({ subtype: 'task_progress', task_id: 'tk-sh', description: 'npm run dev', output_file: path.resolve(HERE, '..', '..', 'proj', 'tasks', 'tk-sh.output') });
  sys({ subtype: 'task_started', task_id: 'tk-a1', task_type: 'local_agent', description: 'Check the refund tests', subagent_type: 'general-purpose', is_backgrounded: true });
  sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'tk-sh' }, { task_id: 'tk-a1' }] });
  sys({ subtype: 'task_progress', task_id: 'tk-a1', description: 'Running npm test -- refunds', usage: { total_tokens: 9100, tool_uses: 3, duration_ms: 41000 } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, total_cost_usd: 0.02, duration_ms: 5000, num_turns: 1, usage, modelUsage: { 'sample-model': { inputTokens: 1200, outputTokens: 140, costUSD: 0.02, contextWindow: 200000 } } });
}
let first = true;
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m = null;
  try {
    m = JSON.parse(l);
  } catch {}
  if (m && m.type === 'user') {
    const c = m.message && m.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : '';
    const was = first;
    first = false;
    if (was && /^drive: tasks/.test(text)) return scene();
  }
  real.stdin.write(`${l}\n`);
}).on('close', () => real.stdin.end());
