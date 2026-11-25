#!/usr/bin/env node
// A stand-in for Claude Code as Tia's engine (no model, no quota), for answers-hers-server.test.mjs. It starts the MCP
// server named in --mcp-config as Claude Code would and follows a small script per turn:
//   "[job …] Session S on C is asking for permission" and "The owner lets you answer"   send_to_chat S answer allow
//   "[job …] Session S on C is asking for permission" (any other rule)                  notify_owner, nothing typed
//   "… It is the run R of the task T on C (Work)"                                       manage_work run → finish_job done
//   anything else                                                                       a one-line answer
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

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-tia-answers', version: '1' } });
out({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [{ name: 'hoprig', status: 'connected' }], model: 'fake' });

async function turn(text) {
  const asking = /^\[job (j_[0-9a-f]{10})\] Session (\S+) on \S+ is asking for permission/m.exec(text);
  if (asking) {
    const [, job, session] = asking;
    if (/The owner lets you answer the OKs of the Work runs you started/.test(text)) {
      say((await call('send_to_chat', { session, answer: 'allow' })).split('\n')[0]);
    } else {
      await call('notify_owner', { message: `The run of job ${job} asks for an OK; it is yours to answer.` });
      say('Told the owner.');
    }
  } else if (/It is the run (\S+) of the task (\S+) on \S+ \(Work\)/.test(text)) {
    const [, run, task] = /It is the run (\S+) of the task (\S+) on/.exec(text);
    const job = /\[job (j_[0-9a-f]{10})\]/.exec(text)[1];
    await call('manage_work', { action: 'run', run });
    await call('finish_job', { job, state: 'done', report: `The session worked on ${task}.\nIt waits for your review in Work: Accept or Send back.` });
    say(`Reported ${task}.`);
  } else {
    say('ok');
  }
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
