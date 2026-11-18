#!/usr/bin/env node
// The demo's coding chat: a stand-in for Claude Code in headless stream-json mode that talks to no model. It plays
// one believable story in its folder, so the chat page has something real to show: thinking, a to-do list, a file
// read, an edit with its diff (the file really changes, so the editor's Source Control shows it too), and a test
// run that waits for your OK. Allow it and the story ends; anything typed after that gets a short demo reply.
// It speaks the same lines as the real program (src/chat/engines/claude*.mjs reads them) and writes its
// transcript where Claude Code would, so the chat comes back after a reload.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const val = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const sessionId = val('--resume') || val('--session-id');
let mode = (val('--permission-mode') === 'manual' ? 'default' : val('--permission-mode')) || 'default';
let model = val('--model') || 'default';
const partial = argv.includes('--include-partial-messages');
const replay = argv.includes('--replay-user-messages');
const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });
const transcript = path.join(dir, `${sessionId}.jsonl`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastUuid = null;
const record = (type, content, extra = {}) => {
  const line = { type, isSidechain: false, uuid: `d${Date.now()}${Math.random().toString(36).slice(2, 8)}`, parentUuid: lastUuid, timestamp: new Date().toISOString(), sessionId, cwd: process.cwd(), ...extra, message: { role: type, content } };
  lastUuid = line.uuid;
  fs.appendFileSync(transcript, `${JSON.stringify(line)}\n`);
};
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let msgs = 0;
let calls = 0;
const usage = { input_tokens: 1200, cache_read_input_tokens: 18000, cache_creation_input_tokens: 0, output_tokens: 140 };
/** An assistant message, streamed block by block as Claude Code does with partial messages. */
async function assistant(content) {
  record('assistant', content);
  const id = `msg_demo_${++msgs}`;
  const line = (c) => out({ type: 'assistant', message: { id, role: 'assistant', content: c, usage }, parent_tool_use_id: null, session_id: sessionId });
  if (!partial) return line(content);
  const se = (event) => out({ type: 'stream_event', event, parent_tool_use_id: null, session_id: sessionId, uuid: `se${Math.random()}` });
  se({ type: 'message_start', message: { id, role: 'assistant', content: [] } });
  for (const [index, b] of content.entries()) {
    se({ type: 'content_block_start', index, content_block: b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: {} } : { type: b.type, [b.type]: '' } });
    const words = (t) => t.match(/\S+\s*/g) || [];
    if (b.type === 'text') for (const w of words(b.text)) { se({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: w } }); await sleep(25); }
    if (b.type === 'thinking') for (const w of words(b.thinking)) { se({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: w } }); await sleep(15); }
    if (b.type === 'tool_use') se({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) } });
    line([b]);
    se({ type: 'content_block_stop', index });
  }
  se({ type: 'message_stop' });
}
const user = (content, r) => {
  record('user', content, r ? { toolUseResult: r } : {});
  out({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId, ...(r ? { tool_use_result: r } : {}) });
};
async function tool(name, input) {
  const id = `toolu_demo_${++calls}`;
  await assistant([{ type: 'tool_use', id, name, input }]);
  return id;
}
let cost = 0;
const result = () => {
  cost += 0.04;
  out({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: sessionId, total_cost_usd: cost, duration_ms: 9000, num_turns: 1, usage, modelUsage: { 'sample-model': { inputTokens: 1200, outputTokens: 140, costUSD: cost, contextWindow: 200000 } } });
};
const init = () => out({ type: 'system', subtype: 'init', session_id: sessionId, model, permissionMode: mode, tools: ['Read', 'Edit', 'Write', 'Bash', 'TodoWrite'], slash_commands: ['compact', 'review'], skills: ['commit-messages'], claude_code_version: '2.1.330' });

const waiting = new Map();
function ask(id, name, input, more = {}) {
  const rid = `req-${id}`;
  out({ type: 'control_request', request_id: rid, request: { subtype: 'can_use_tool', tool_name: name, display_name: name, input, tool_use_id: id, ...more } });
  return new Promise((resolve) => waiting.set(rid, resolve));
}

// The story: a cart total that is rounded in the wrong place.
const FILE = path.join('src', 'cart.js');
const todos = (done) => [
  { content: 'Find where the total is rounded', status: done > 0 ? 'completed' : 'in_progress', activeForm: 'Finding where the total is rounded' },
  { content: 'Round once, after the discount', status: done > 1 ? 'completed' : done === 1 ? 'in_progress' : 'pending', activeForm: 'Rounding once, after the discount' },
  { content: 'Run the tests', status: done > 2 ? 'completed' : done === 2 ? 'in_progress' : 'pending', activeForm: 'Running the tests' },
];
const OLD = '  const sum = items.reduce((s, i) => s + Math.round(i.price * i.qty * 100) / 100, 0);\n  return sum * (1 - discount);';
// The story is told once: to a new conversation (not one resumed after an idle stop, a restart or a model change)
// in the folder whose cart still has the bug. Anywhere else, and after it, the short demo reply.
const storyHere = () => {
  try {
    return !val('--resume') && fs.readFileSync(path.resolve(FILE), 'utf8').includes(OLD);
  } catch {
    return false; // no cart here (another project)
  }
};
let told = 0;
async function story() {
  out({ type: 'system', subtype: 'session_title_changed', title: 'Fix the cart total with a discount', session_id: sessionId });
  await assistant([{ type: 'thinking', thinking: 'The total is off by a cent for some carts. That smells like rounding each line before the discount is taken off. Let me read the cart first.', signature: 'ZGVtbw' }]);
  let id = await tool('TodoWrite', { todos: todos(0) });
  user([{ type: 'tool_result', tool_use_id: id, content: 'Todos have been modified successfully.' }]);
  const file = path.resolve(FILE);
  id = await tool('Read', { file_path: file });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  user([{ type: 'tool_result', tool_use_id: id, content: before }], { type: 'text', file: { filePath: file, content: before } });
  await assistant([{ type: 'text', text: 'Found it: `cartTotal` rounds every line, and only then takes the discount off. With a 15 % discount that loses a cent now and then. I will round once, at the end.' }]);
  id = await tool('TodoWrite', { todos: todos(1) });
  user([{ type: 'tool_result', tool_use_id: id, content: 'Todos have been modified successfully.' }]);
  const old = OLD;
  const now = '  const sum = items.reduce((s, i) => s + i.price * i.qty, 0);\n  return Math.round(sum * (1 - discount) * 100) / 100;';
  id = await tool('Edit', { file_path: file, old_string: old, new_string: now });
  if (before.includes(old)) fs.writeFileSync(file, before.replace(old, now));
  const at = before.split('\n').findIndex((l) => l.startsWith('  const sum')) + 1 || 3;
  user([{ type: 'tool_result', tool_use_id: id, content: `The file ${file} has been updated successfully.` }], {
    filePath: file, oldString: old, newString: now,
    structuredPatch: [{ oldStart: at - 1, oldLines: 4, newStart: at - 1, newLines: 4, lines: [' export function cartTotal(items, discount = 0) {', ...old.split('\n').map((l) => `-${l}`), ...now.split('\n').map((l) => `+${l}`), ' }'] }],
  });
  id = await tool('TodoWrite', { todos: todos(2) });
  user([{ type: 'tool_result', tool_use_id: id, content: 'Todos have been modified successfully.' }]);
  await assistant([{ type: 'text', text: 'Now the tests, to be sure nothing else depended on the old rounding.' }]);
  const input = { command: 'npm test', description: 'Run the project\'s tests' };
  id = await tool('Bash', input);
  const answer = await ask(id, 'Bash', input, {
    description: input.description, decision_reason: 'This command requires approval', decision_reason_type: 'other',
    permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }],
  });
  if (answer.behavior === 'allow') {
    user([{ type: 'tool_result', tool_use_id: id, content: '> shop-frontend@1.0.0 test\n> node --test\n\n✔ cart total with a discount (1.2 ms)\n✔ cart total of an empty cart (0.3 ms)\n✔ 14 tests passed' }]);
    await tool('TodoWrite', { todos: todos(3) }).then((t) => user([{ type: 'tool_result', tool_use_id: t, content: 'Todos have been modified successfully.' }]));
    await assistant([{ type: 'text', text: 'All 14 tests pass. The total is now rounded once, after the discount, so a 15 % discount on three items of 19.99 comes to 50.97 as the shop expects.' }]);
  } else {
    user([{ type: 'tool_result', tool_use_id: id, is_error: true, content: answer.message || 'The user doesn\'t want to proceed with this tool use.' }]);
    await assistant([{ type: 'text', text: 'I did not run the tests. The change is in place; run them when you like.' }]);
  }
}

let busy = false;
const queue = [];
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const m = queue.shift();
    init();
    if (replay) out({ type: 'user', message: { role: 'user', content: m.content }, parent_tool_use_id: null, session_id: sessionId, uuid: m.uuid, isReplay: true });
    record('user', m.content, m.uuid ? { uuid: m.uuid } : {});
    if (told++ === 0 && storyHere()) await story();
    else await assistant([{ type: 'text', text: '(demo) This chat talks to no model. In a real chat, Claude Code answers here.' }]);
    result();
  }
  busy = false;
}
const answerControl = (m, response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response } });
function control(m) {
  const r = m.request;
  switch (r.subtype) {
    case 'initialize':
      return answerControl(m, { commands: [{ name: 'compact', description: 'Clear the history but keep a summary', argumentHint: '', builtin: true }, { name: 'review', description: 'Review the changes', argumentHint: '[what]', builtin: false }], models: [{ value: 'default' }, { value: 'sonnet' }, { value: 'haiku' }], pid: process.pid });
    case 'interrupt':
      for (const [rid, resolve] of waiting) {
        out({ type: 'control_cancel_request', request_id: rid });
        resolve({ behavior: 'deny' });
      }
      waiting.clear();
      return answerControl(m, { still_queued: [] });
    case 'set_permission_mode':
      mode = r.mode;
      out({ type: 'system', subtype: 'status', status: null, permissionMode: mode, session_id: sessionId });
      return answerControl(m, { mode });
    case 'set_model':
      model = r.model || 'default';
      return answerControl(m, { model });
    case 'apply_flag_settings':
      return answerControl(m, {});
    case 'get_context_usage':
      return answerControl(m, { totalTokens: 38000, maxTokens: 200000, percentage: 19, categories: [{ name: 'System prompt', tokens: 3200, color: 'promptBorder' }, { name: 'System tools', tokens: 12400, color: 'inactive' }, { name: 'Memory files', tokens: 1900, color: 'claude' }, { name: 'Messages', tokens: 20500, color: 'purple' }] });
    case 'get_usage':
      return answerControl(m, { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 41, resets_at: new Date(Date.now() + 2.4 * 3600_000).toISOString() }, seven_day: { utilization: 58, resets_at: new Date(Date.now() + 3.2 * 86400_000).toISOString() } } });
    default:
      return out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: `Unsupported control request subtype: ${r.subtype}`, error_code: 'unsupported_request' } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (l) => {
  let m;
  try {
    m = JSON.parse(l);
  } catch {
    return;
  }
  if (m.type === 'user') {
    const content = typeof m.message.content === 'string' ? [{ type: 'text', text: m.message.content }] : m.message.content;
    queue.push({ content, uuid: m.uuid || null });
    pump();
  } else if (m.type === 'control_response') {
    const r = waiting.get(m.response.request_id);
    waiting.delete(m.response.request_id);
    r?.(m.response.response);
  } else if (m.type === 'control_request') control(m);
}).on('close', () => process.exit(0));
