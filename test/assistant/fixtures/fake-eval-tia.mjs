#!/usr/bin/env node
// A stand-in for Claude Code as the eval's engine (no model, no provider): it starts the MCP server named in
// --mcp-config as Claude Code would, reads the tool list and the system prompt it was given, and answers each turn
// with what a model would have read: the description of manage_project and the procedures line of get-coding-done.
// When the message says "cart" it also stages the Work start card for the cart task. FAKE_EVAL_LOG: one line per start.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
if (process.env.FAKE_EVAL_LOG) fs.appendFileSync(process.env.FAKE_EVAL_LOG, 'started\n');
const system = argv[argv.indexOf('--system-prompt') + 1] || '';
const cfg = JSON.parse(fs.readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8'));
const srv = cfg.mcpServers.hoprig;
const mcp = spawn(srv.command, srv.args, { env: { ...process.env, ...srv.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
let n = 0;
readline.createInterface({ input: mcp.stdout }).on('line', (l) => {
  const m = JSON.parse(l);
  waiting.get(m.id)?.(m);
});
const rpc = (method, params) => new Promise((resolve) => {
  const id = ++n;
  waiting.set(id, resolve);
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const sessionId = argv[argv.indexOf('--session-id') + 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let k = 0;
async function call(name, args) {
  const id = `toolu_${++k}`;
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__hoprig__${name}`, input: args }] } });
  const r = await rpc('tools/call', { name, arguments: args });
  const text = r.result ? r.result.content[0].text : r.error.message;
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !!(r.error || r.result.isError), content: [{ type: 'text', text }] }] } });
  return text;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-eval-tia', version: '1' } });
const tools = (await rpc('tools/list', {})).result.tools;
out({ type: 'system', subtype: 'init', session_id: sessionId, tools: tools.map((t) => `mcp__hoprig__${t.name}`), mcp_servers: [{ name: 'hoprig', status: 'connected' }], model: 'fake' });

async function turn(text) {
  // FAKE_EVAL_SLIP <file>: the first start of all (the one that makes the file) slips as a model once did: it calls a
  // tool by its bare name, which Claude Code does not have (ours are mcp__hoprig__<tool>). Every later start does not.
  let slip = false;
  if (process.env.FAKE_EVAL_SLIP) {
    try {
      fs.closeSync(fs.openSync(process.env.FAKE_EVAL_SLIP, 'wx'));
      slip = true;
    } catch {}
  }
  if (slip) {
    const id = `toolu_${++k}`;
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'notify_owner', input: { message: 'Should I?' } }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: [{ type: 'text', text: '<tool_use_error>Error: No such tool available: notify_owner</tool_use_error>' }] }] } });
  }
  // A task id must come from a tool result first (the dashboard refuses one that was not shown), as a model does it.
  if (/cart/i.test(text)) await call('manage_work', { action: 'list', project: 'shop' });
  if (/cart/i.test(text)) await call('manage_work', { action: 'start', task: 'fix-the-cart-total', brief: 'Fix the cart total in shop; run its tests; push nothing.', kind: 'code' });
  else await call('list_sessions', {});
  const desc = (tools.find((t) => t.name === 'manage_project') || {}).description || '';
  const proc = (system.split('\n').find((l) => l.startsWith('- get-coding-done:')) || '').slice(0, 300);
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `TOOL: ${desc.slice(0, 300)}\nSKILL: ${proc}` }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, total_cost_usd: 0.001, num_turns: 1, usage: { input_tokens: 100, output_tokens: 10 } });
}
const queue = [];
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await turn(queue.shift());
  busy = false;
}
readline.createInterface({ input: process.stdin }).on('line', (l) => {
  queue.push(JSON.parse(l).message.content[0].text);
  pump();
}).on('close', () => {
  mcp.stdin.end();
  setTimeout(() => process.exit(0), 100);
});
