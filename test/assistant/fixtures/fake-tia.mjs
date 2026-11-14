#!/usr/bin/env node
// A stand-in for Claude Code as Tia's engine (no model, no quota), speaking the same stream-json protocol: it
// starts the MCP server named in --mcp-config exactly as Claude Code would, and follows a small script per turn:
//   "make hello in <folder>"   list_projects → start_session (first message + goal) → says what it started
//   "[job …] … waiting"        read_session → finish_job done
//   "stage auto"               set_auto_mode (a card)
//   anything else              list_sessions, then a one-line answer
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

const argv = process.argv.slice(2);
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
const sessionId = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : argv[argv.indexOf('--session-id') + 1];
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
const say = (text) => out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-tia', version: '1' } });
const tools = (await rpc('tools/list', {})).result.tools.map((t) => `mcp__hoprig__${t.name}`);
out({ type: 'system', subtype: 'init', session_id: sessionId, tools, mcp_servers: [{ name: 'hoprig', status: 'connected' }], model: 'fake' });

const queue = [];
let busy = false;
async function turn(text) {
  const hello = /make hello in (\S+)/.exec(text);
  if (hello) {
    await call('list_projects', {});
    const r = await call('start_session', { folder: hello[1], message: 'make a file hello.txt that contains exactly: hi from tia', goal: 'hello.txt exists with the right text' });
    say(r.split('\n')[0]);
  } else if (/^\[job (j_[0-9a-f]{10})\][^\n]*finished its turn/.test(text)) {
    const job = /^\[job (j_[0-9a-f]{10})\]/.exec(text)[1];
    const session = /Session (\S+) on/.exec(text)[1];
    await call('read_session', { session });
    await call('finish_job', { job, state: 'done', report: `${session} finished the task.` });
    say(`Done: ${session} finished.`);
  } else if (/stage auto/.test(text)) {
    say((await call('set_auto_mode', { enabled: true })).split('\n')[0]);
  } else {
    say((await call('list_sessions', {})).split('\n')[0]);
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, total_cost_usd: 0.001, num_turns: 1, usage: { input_tokens: 100, output_tokens: 10 } });
}
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
