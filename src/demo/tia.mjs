#!/usr/bin/env node
// The demo's stand-in for Tia's engine (`hoprig demo`): no model, no account. It speaks Claude Code's
// stream-json protocol and calls hoprig's real MCP server exactly as Tia does, following a small script, so the
// Tia tab shows a real conversation with tool chips, a confirm card and a job that finishes:
//   "what needs me"          list_sessions → a short summary
//   "move docs-site"         switch_account to the API account → a confirm card (paid account)
//   "start … in <folder>"    start_session with a goal → a job; when the session finishes, read_session → finish_job
//   anything else            list_sessions → one line
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
  try {
    const m = JSON.parse(l);
    waiting.get(m.id)?.(m);
  } catch {
    /* not a reply */
  }
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'demo-tia', version: '1' } });
const tools = (await rpc('tools/list', {})).result.tools.map((t) => `mcp__hoprig__${t.name}`);
out({ type: 'system', subtype: 'init', session_id: sessionId, tools, mcp_servers: [{ name: 'hoprig', status: 'connected' }], model: 'demo' });

async function turn(text) {
  await pause(600);
  const start = /start .* in (~?\/[^\s:,]+)/i.exec(text);
  if (/what needs me/i.test(text)) {
    await call('list_sessions', {});
    say('Three sessions need you: **mobile-app** asks to install one package, **docs-site** reached the 5-hour limit on Claude Max, and **api-server** finished and asks whether to rate-limit the cart too. **shop-frontend** is still working.');
  } else if (/set up what is missing/i.test(text)) {
    say('Two things are missing on **Workstation**: **pnpm** for Node.js projects, and a newer **uv** for Python. Open Computers → Workstation → Setup and press **Set up this computer**, or tell me to start it.');
  } else if (/remember/i.test(text)) {
    say('Claude remembered two things for every project: **how you like to work** (short answers, the most important case first) and **where the test server is**. The project **bookshop** has its own rules. The AI brain page shows each of them.');
  } else if (/move docs-site/i.test(text)) {
    await call('list_sessions', {}); // Tia may only name sessions a tool showed her
    const r = await call('switch_account', { session: 'docs-site', account: 'api' });
    say(/card/i.test(r) ? 'The API provider is paid per use, so I need your OK: tap **Confirm** on the card and docs-site continues there.' : r.split('\n')[0]);
  } else if (start) {
    await call('list_folders', {});
    const r = await call('start_session', { folder: start[1], message: 'Add a dark mode toggle to the header and remember the choice', goal: 'the toggle works and the choice is remembered' });
    say(`${r.split('\n')[0]} I will tell you when it is done.`);
  } else if (/^\[job (j_[0-9a-f]{10})\][^\n]*finished its turn/.test(text)) {
    const job = /^\[job (j_[0-9a-f]{10})\]/.exec(text)[1];
    const session = /Session (\S+) on/.exec(text)[1];
    await call('read_session', { session });
    await call('finish_job', { job, state: 'done', report: `${session} added the dark mode toggle; the choice is kept across visits.` });
    say(`Done: **${session}** added the dark mode toggle and it remembers the choice.`);
  } else {
    say((await call('list_sessions', {})).split('\n')[0]);
  }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId, total_cost_usd: 0, num_turns: 1, usage: { input_tokens: 0, output_tokens: 0 } });
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
  try {
    queue.push(JSON.parse(l).message.content[0].text);
    pump();
  } catch {
    /* not a message */
  }
}).on('close', () => {
  mcp.stdin.end();
  setTimeout(() => process.exit(0), 100);
});
