#!/usr/bin/env node
// Dev-only (not in the published package): the coding-tool stand-in that tools/app-chat-drive.mjs puts in place of
// the demo's (src/demo/chat.mjs, copied as chat-real.mjs into the drive's own copy of the tree). Everything goes to
// the demo's stand-in, except a first message that starts with "drive:", which plays a scene of its own:
//   "drive: running"     a turn that keeps running (a command runs) with two agents, a shell and a workflow in the
//                        background; every message sent after it stays queued (never read).
//   "drive: background"  the same four background tasks, and the turn ends: work goes on in the background only.
//   "drive: one"         a running turn with one background task; "drive: twelve" with twelve (long and short names).
//   "drive: wide"        a running turn with one task whose title is a whole command line (200 characters).
//   "drive: reply"       a finished turn: a session name of 120 characters, an Edit of a file with a 120-character
//                        name, a reply with a code line of 400 characters and a table of twelve columns.
//   "drive: ending"      a turn that ended, one task that ends by itself a few seconds later.
// While a scene lives the stand-in also does what Claude Code does with a message that waits ("cancel_async_message"
// gives it back) and with "stop_task" (the task ends as stopped), so the page's Edit, Remove, Up and Stop can be tried.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const sessionId = val('--resume') || val('--session-id');
const model = val('--model') || 'default';
const mode = val('--permission-mode') || 'default';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

const real = spawn(process.execPath, [path.join(HERE, 'chat-real.mjs'), ...argv], { stdio: ['pipe', 'pipe', 'inherit'] });
readline.createInterface({ input: real.stdout }).on('line', (l) => process.stdout.write(`${l}\n`));
real.on('exit', (c) => process.exit(c ?? 0));

let held = false; // a scene's turn that never ends: what comes after it stays queued
let msgs = 0;
const usage = { input_tokens: 1200, cache_read_input_tokens: 18000, cache_creation_input_tokens: 0, output_tokens: 140 };
function say(content) {
  const id = `msg_drive_${++msgs}`;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id, role: 'assistant', content: [] } }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: 'assistant', message: { id, role: 'assistant', content, usage }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: 'stream_event', event: { type: 'message_stop' }, parent_tool_use_id: null, session_id: sessionId });
}
const sys = (o) => out({ type: 'system', session_id: sessionId, uuid: `s${Math.random()}`, ...o });
const LONGCMD = `cd packages/payments && npm run build --workspaces --if-present && node scripts/migrate.mjs --from 2026-01-01 --to 2026-11-27 --dry-run=false --verbose --log-file=/var/tmp/payments-migrate-2026-11-27.log && echo done`.slice(0, 200);
const BASE = [
  { task_id: 'tk-a1', task_type: 'local_agent', description: 'Check the payment tests', subagent_type: 'general-purpose' },
  { task_id: 'tk-a2', task_type: 'local_agent', description: 'Read the API docs for refunds', subagent_type: 'Explore' },
  { task_id: 'tk-sh', task_type: 'local_bash', description: 'npm run dev' },
  { task_id: 'tk-wf', task_type: 'local_workflow', workflow_name: 'release-check', description: 'release-check' },
];
let TASKS = BASE;
const alive = new Set(); // task ids that still run
const waiting = new Map(); // message uuid -> text, the messages Claude Code has queued
function taskSet(kind) {
  if (kind === 'one') return [BASE[2]];
  if (kind === 'wide') return [{ task_id: 'tk-long', task_type: 'local_bash', description: LONGCMD }];
  if (kind === 'ending') return [{ task_id: 'tk-end', task_type: 'local_bash', description: 'npm run build' }];
  if (kind === 'twelve') {
    return Array.from({ length: 12 }, (_, i) => ({ task_id: `tk-${i}`, task_type: i % 3 === 0 ? 'local_agent' : i % 3 === 1 ? 'local_bash' : 'local_workflow', description: i % 4 === 0 ? `Check the payment tests of part ${i} and report what is left to do before the release` : `npm run job-${i}`, ...(i % 3 === 0 ? { subagent_type: 'general-purpose' } : {}), ...(i % 3 === 2 ? { workflow_name: `flow-${i}` } : {}) }));
  }
  return BASE;
}
function tasks() {
  for (const t of TASKS) alive.add(t.task_id);
  for (const t of TASKS) sys({ subtype: 'task_started', ...t, is_backgrounded: true });
  sys({ subtype: 'background_tasks_changed', tasks: TASKS.map((t) => ({ task_id: t.task_id })) });
  if (TASKS !== BASE) return;
  sys({ subtype: 'task_progress', task_id: 'tk-a1', description: 'Running npm test -- payments', usage: { total_tokens: 18400, tool_uses: 7, duration_ms: 64000 } });
  sys({ subtype: 'task_progress', task_id: 'tk-a2', description: 'Reading docs/refunds.md', usage: { total_tokens: 9100, tool_uses: 3, duration_ms: 41000 } });
  sys({ subtype: 'task_progress', task_id: 'tk-wf', task_type: 'local_workflow', workflow_name: 'release-check', workflow_progress: [
    { type: 'workflow_phase', index: 0, title: 'Check' },
    { type: 'workflow_agent', index: 0, phaseIndex: 0, label: 'lint', state: 'done', model: 'claude-sonnet-4-6', tokens: 4000, toolCalls: 2, durationMs: 30000 },
    { type: 'workflow_agent', index: 1, phaseIndex: 0, label: 'unit tests', state: 'running', model: 'claude-sonnet-4-6' },
  ] });
}
const changed = () => sys({ subtype: 'background_tasks_changed', tasks: [...alive].map((task_id) => ({ task_id })) });
function endTask(id, status) {
  if (!alive.delete(id)) return;
  sys({ subtype: 'task_notification', task_id: id, status, summary: status === 'stopped' ? 'Stopped' : 'Done' });
  changed();
}
const RESULT = () => out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, total_cost_usd: 0.05, duration_ms: 9000, num_turns: 1, usage, modelUsage: { 'sample-model': { inputTokens: 1200, outputTokens: 140, costUSD: 0.05, contextWindow: 200000 } } });
function table() {
  const cols = Array.from({ length: 12 }, (_, i) => `Column ${i + 1}`);
  const row = (n) => `| ${cols.map((_, i) => `value ${n}-${i + 1} of the cell`).join(' | ')} |`;
  return [`| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`, row(1), row(2), row(3)].join('\n');
}
function reply() {
  const code = `const result = await client.payments.refunds.create({ paymentId, amount, currency, reason: 'requested_by_customer', metadata: { order: orderId, source: 'drive' }, idempotencyKey }, { timeout: 30000, retries: 3 }); console.log(result.id, result.status);`.padEnd(400, ' // more').slice(0, 400);
  const file = `${'/src/payments/'}${'refund-email-template-for-a-long-named-customer-'.repeat(3)}`.slice(0, 120);
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: mode, tools: ['Read', 'Edit', 'Bash', 'Agent'], slash_commands: ['compact'], skills: [] });
  out({ type: 'system', subtype: 'session_title_changed', title: 'Refunds: a very long name for a session that goes on and on and on, to see where the name of a session ends, in the list'.slice(0, 120), session_id: sessionId });
  say([{ type: 'text', text: 'I changed the template.' }, { type: 'tool_use', id: 'toolu_drive_e', name: 'Edit', input: { file_path: `${process.cwd()}${file}`.slice(0, 240), old_string: 'a', new_string: 'b' } }]);
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_drive_e', content: 'The file has been updated.' }] }, parent_tool_use_id: null, session_id: sessionId });
  say([{ type: 'text', text: `Here is the call and a table:\n\n\`\`\`js\n${code}\n\`\`\`\n\n${table()}\n\nAnd one `+'`'+`${'x'.repeat(120)}`+'`'+` inline.` }]);
  RESULT();
}
function scene(kind) {
  TASKS = taskSet(kind);
  if (kind === 'reply') return reply();
  out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: mode, tools: ['Read', 'Edit', 'Bash', 'Agent'], slash_commands: ['compact'], skills: [] });
  out({ type: 'system', subtype: 'session_title_changed', title: kind === 'background' ? 'Refunds: tests and docs in the background' : 'Refunds: a long test run', session_id: sessionId });
  say([{ type: 'text', text: 'I start the background work.' }]);
  tasks();
  if (kind === 'ending') setTimeout(() => endTask('tk-end', 'completed'), 4000);
  if (kind === 'background' || kind === 'ending') {
    say([{ type: 'text', text: 'They run in the background. I will tell you what they found when they end.' }]);
    RESULT();
    return;
  }
  say([{ type: 'text', text: 'While they run, the whole test suite.' }]);
  say([{ type: 'tool_use', id: 'toolu_drive_1', name: 'Bash', input: { command: 'npm test', description: 'Run all tests' } }]);
  held = true; // the command never answers: the turn runs on
}
/** What Claude Code does with these two requests while a scene lives; true when this took the line. */
function control(m) {
  const r = m && m.type === 'control_request' ? m.request || {} : null;
  if (!r || !['cancel_async_message', 'stop_task', 'interrupt'].includes(r.subtype)) return false;
  const ok = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
  if (r.subtype === 'interrupt') {
    if (!held) return false;
    held = false; // Stop: the turn ends, background tasks go on
    waiting.clear();
    RESULT();
    return ok({ still_queued: [] }), true;
  }
  if (r.subtype === 'cancel_async_message') {
    const gone = waiting.delete(r.message_uuid);
    if (gone) out({ type: 'command_lifecycle', command_uuid: r.message_uuid, state: 'cancelled', session_id: sessionId });
    ok({ cancelled: gone });
  } else {
    endTask(String(r.task_id), 'stopped');
    ok({});
  }
  return true;
}

let first = true;
let scened = false;
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m = null;
  try {
    m = JSON.parse(l);
  } catch {}
  if (scened && control(m)) return;
  if (m && m.type === 'user') {
    const c = m.message && m.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join(' ') : '';
    const was = first;
    first = false;
    if (held) {
      if (m.uuid) waiting.set(m.uuid, text);
      return; // queued: never read
    }
    const k = was && /^drive: (running|background|one|twelve|wide|reply|ending)\b/.exec(text);
    if (k) {
      scened = true;
      return scene(k[1]);
    }
  }
  real.stdin.write(`${l}\n`);
}).on('close', () => real.stdin.end());
