#!/usr/bin/env node
// A stand-in for Claude Code as Tia's engine (no model, no quota), speaking the same stream-json protocol: it
// starts the MCP server named in --mcp-config exactly as Claude Code would, and follows a small script per turn:
//   "make hello in <folder>"   list_projects → start_session (first message + goal) → says what it started
//   "[job …] … waiting"        read_session → finish_job done
//   "… It is the run R of the task T on C (Work)"   manage_work run → finish_job done with a two-line report
//   "stage auto"               set_auto_mode (a card)
//   "kitna time"               manage_work progress, then a figure of its own ("0 se 40 minute baaki")
//   "how far"                  manage_work progress, then words with no figure
//   "state of <session>"       list_sessions → read_session (a status card)
//   "what needs me"            read_attention (a needs-you card)
//   "fix the login page"       list_projects → notify_owner with two answers (a choice card)
//   "add the task <title>"     manage_work add (a result card with Undo)
//   "say <text>"               answers with <text> as it is (markup, a long answer, Devanagari)
//   "rename the <word> chat to <name>", "close the <word> chat", "open the <word> chat in a terminal"
//                              list_sessions → send_to_chat name / close / terminal (the chat whose title holds the word)
//   "show the <s> session as a chat", "carry on in the <s> session"   send_to_session to_chat / continue
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
// The chat whose title holds a word: list_sessions, then its name from the data.
async function chatAbout(word) {
  const r = await call('list_sessions', {});
  const data = JSON.parse(/<untrusted_data[^>]*>([\s\S]*?)<\/untrusted_data>/.exec(r)[1]);
  const c = data.sessions.find((x) => x.chat && new RegExp(word, 'i').test(`${x.title} ${x.folder}`));
  return c ? c.session : 'chat:00000000-0000-4000-8000-000000000000';
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
  } else if (/It is the run (\S+) of the task (\S+) on \S+ \(Work\)/.test(text)) {
    // A job that follows a Work run: read the run, then report in two lines (never accept).
    const [, run, task] = /It is the run (\S+) of the task (\S+) on/.exec(text);
    const job = /\[job (j_[0-9a-f]{10})\]/.exec(text)[1];
    let r = await call('manage_work', { action: 'run', run });
    if (/still works/.test(r)) r = await call('manage_work', { action: 'run', run });
    const how = (/ended: (\w+)/.exec(r) || [])[1] || 'still working';
    await call('finish_job', { job, state: 'done', report: `The session worked on ${task}: ${how}.\nIt waits for your review in Work: Accept or Send back.` });
    say(`Reported ${task}.`);
  } else if (/^\[job (j_[0-9a-f]{10})\][^\n]*finished its turn/m.test(text)) {
    // A card's outcome may come first ("[What happened since your last turn]"): the wake is a line of its own.
    const job = /^\[job (j_[0-9a-f]{10})\]/m.exec(text)[1];
    const session = /Session (\S+) on/.exec(text)[1];
    await call('read_session', { session });
    await call('finish_job', { job, state: 'done', report: `${session} finished the task.` });
    say(`Done: ${session} finished.`);
  } else if (/kitna time/.test(text)) {
    await call('manage_work', { action: 'progress' });
    say('Cart fix mein abhi 0 se 40 minute baaki hain.');
  } else if (/how far/.test(text)) {
    await call('manage_work', { action: 'progress' });
    say('Here is where Work stands.');
  } else if (/state of (\S+)/.test(text)) {
    const session = /state of (\S+)/.exec(text)[1].replace(/[?.!]+$/, '');
    await call('list_sessions', {});
    say((await call('read_session', { session })).split('\n')[0]);
  } else if (/what needs me/i.test(text)) {
    await call('read_attention', {});
    say('Here is what needs you.');
  } else if (/fix the login page/i.test(text)) {
    await call('list_projects', {});
    await call('notify_owner', { message: 'Two projects fit. Which one should I fix?', options: ['shop-web', 'shop-app'] });
    say('I asked which project.');
  } else if (/add the task (.+)/.test(text)) {
    await call('manage_work', { action: 'add', title: /add the task (.+)/.exec(text)[1].trim() });
    say('Added it. Undo takes it back.');
  } else if (/^say ([\s\S]+)$/m.test(text)) {
    say(/^say ([\s\S]+)$/m.exec(text)[1]);
  } else if (/stage auto/.test(text)) {
    say((await call('set_auto_mode', { enabled: true })).split('\n')[0]);
  } else if (/rename the (\w+) chat to (.+)/i.test(text)) {
    const [, about, name] = /rename the (\w+) chat to (.+)/i.exec(text);
    say((await call('send_to_chat', { session: await chatAbout(about), name: name.trim() })).split('\n')[0]);
  } else if (/close the (\w+) chat/i.test(text)) {
    say((await call('send_to_chat', { session: await chatAbout(/close the (\w+) chat/i.exec(text)[1]), close: true })).split('\n')[0]);
  } else if (/open the (\w+) chat in a terminal/i.test(text)) {
    say((await call('send_to_chat', { session: await chatAbout(/open the (\w+) chat in a terminal/i.exec(text)[1]), terminal: true })).split('\n')[0]);
  } else if (/show the (\S+) session as a chat/i.test(text)) {
    await call('list_sessions', {});
    say((await call('send_to_session', { session: /show the (\S+) session as a chat/i.exec(text)[1], to_chat: true })).split('\n')[0]);
  } else if (/start a chat in (\S+) on (\S+)/i.test(text)) {
    // A chat on the provider he names (a key billed by use, in the browser try of the daily cap).
    const [, folder, account] = /start a chat in (\S+) on (\S+)/i.exec(text);
    await call('list_projects', {});
    say((await call('start_chat', { folder, account: account.replace(/[.!?]+$/, ''), message: 'hello' })).split('\n')[0]);
  } else if (/carry on in the (\S+) session/i.test(text)) {
    await call('list_sessions', {});
    say((await call('send_to_session', { session: /carry on in the (\S+) session/i.exec(text)[1], continue: true })).split('\n')[0]);
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
